import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/clock';
import type { PersonId, SiteId, ZoneId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { Authorization } from '../../accounts-and-access-control/public';
import type { GeoPoint, SiteCodeRefusal, SiteRegistry } from '../../sites-and-areas/public';
import type { ClockInRefusal, ClockOutRefusal, LocationRefusal, OffSiteFlag } from '../public';
import { isOffSite } from './domain/off-site-rule';
import type { AssignmentsStore, AttendanceStore, OffSiteStore } from './ports';

export interface AttendanceDependencies {
  readonly attendance: AttendanceStore;
  readonly offSite: OffSiteStore;
  readonly assignments: AssignmentsStore;
  readonly authorization: Authorization;
  readonly registry: SiteRegistry;
  readonly clock: Clock;
}

/**
 * Clock in and out (task A13). The attendant scans the code printed at their own site; a genuine code proves they
 * stand there, and the session is then bound to that site in access control, so a ticket request already carries its
 * proven site (ADR-02 amendment Q12a). Either of the site's two codes will do.
 */
export class AttendanceService {
  constructor(private readonly dependencies: AttendanceDependencies) {}

  async clockIn(attendantId: PersonId, scannedSiteCode: string): Promise<Result<SiteId, ClockInRefusal>> {
    const assignment = await this.dependencies.assignments.attendant(attendantId);
    if (assignment === undefined) {
      return fail('not assigned');
    }
    const scanned = await this.verifyEitherCode(scannedSiteCode, assignment.siteId);
    if (!scanned.ok) {
      return scanned;
    }
    const open = await this.dependencies.attendance.open(attendantId);
    if (open !== undefined && open.siteId === assignment.siteId) {
      return succeed(open.siteId);
    }
    const bound = await this.dependencies.authorization.bindSessionToSite(attendantId, assignment.siteId);
    if (!bound.ok) {
      return fail('licence not live');
    }
    await this.dependencies.attendance.add({
      attendanceId: `attendance-${randomUUID()}`,
      attendantId,
      siteId: assignment.siteId,
      shiftId: assignment.shiftId,
      clockedInAt: this.dependencies.clock.now().toISOString(),
    });
    return succeed(assignment.siteId);
  }

  async clockOut(attendantId: PersonId): Promise<Result<SiteId, ClockOutRefusal>> {
    const open = await this.dependencies.attendance.open(attendantId);
    if (open === undefined) {
      return fail('not clocked in');
    }
    await this.dependencies.attendance.close(open.attendanceId, this.dependencies.clock.now().toISOString());
    await this.dependencies.authorization.unbindSession(attendantId);
    return succeed(open.siteId);
  }

  async isClockedIn(attendantId: PersonId): Promise<boolean> {
    return (await this.dependencies.attendance.open(attendantId)) !== undefined;
  }

  /**
   * A location reading from the attendant's phone during a shift (task A14). The reading's time is the server's; only
   * its distance from the site is kept. Returns whether this reading raised the shift's off-site flag.
   */
  async recordLocationPoint(attendantId: PersonId, point: GeoPoint): Promise<Result<{ flagRaised: boolean }, LocationRefusal>> {
    const open = await this.dependencies.attendance.open(attendantId);
    if (open === undefined) {
      return fail('not clocked in');
    }
    const distanceMeters = await this.dependencies.registry.distanceFromSite(open.siteId, point);
    if (distanceMeters === undefined) {
      return fail('invalid point');
    }
    const now = this.dependencies.clock.now().toISOString();
    await this.dependencies.offSite.addReading({ attendanceId: open.attendanceId, distanceMeters: Math.round(distanceMeters), recordedAt: now });
    if ((await this.dependencies.offSite.flagOf(open.attendanceId)) !== undefined) {
      return succeed({ flagRaised: false });
    }
    const readings = await this.dependencies.offSite.readingsOf(open.attendanceId);
    const zoneId = (await this.dependencies.registry.locateSite(open.siteId))?.zoneId;
    if (zoneId === undefined || !isOffSite(readings.map((reading) => reading.distanceMeters))) {
      return succeed({ flagRaised: false });
    }
    await this.dependencies.offSite.addFlag({
      flagId: `off-site-${randomUUID()}`,
      attendanceId: open.attendanceId,
      attendantId,
      siteId: open.siteId,
      zoneId,
      raisedAt: now,
    });
    return succeed({ flagRaised: true });
  }

  /** The inspector's list: off-site flags raised in a zone, for someone with scope over that zone. */
  async offSiteFlags(actor: PersonId, zoneId: ZoneId): Promise<Result<readonly OffSiteFlag[], 'not allowed here'>> {
    if (!(await this.dependencies.authorization.may(actor, 'attendance.offSiteFlags', { zoneId }))) {
      return fail('not allowed here');
    }
    const flags = await this.dependencies.offSite.flagsIn(zoneId);
    return succeed(flags.map(({ flagId, attendantId, siteId, raisedAt }) => ({ flagId, attendantId, siteId, raisedAt })));
  }

  private async verifyEitherCode(code: string, siteId: SiteId): Promise<Result<SiteId, ClockInRefusal>> {
    const asEntry = await this.dependencies.registry.verifyEntryCode(code, siteId);
    const asExit = asEntry.ok ? asEntry : await this.dependencies.registry.verifyExitCode(code, siteId);
    if (asExit.ok) {
      return asExit;
    }
    const refusals: SiteCodeRefusal[] = asEntry.ok ? [] : [asEntry.error, asExit.error];
    return fail(refusals.includes('wrong site') ? 'wrong site' : 'forged code');
  }
}
