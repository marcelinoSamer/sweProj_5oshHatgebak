import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/clock';
import type { PersonId, SiteId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { Authorization } from '../../accounts-and-access-control/public';
import type { SiteCodeRefusal, SiteRegistry } from '../../sites-and-areas/public';
import type { ClockInRefusal, ClockOutRefusal } from '../public';
import type { AssignmentsStore, AttendanceStore } from './ports';

export interface AttendanceDependencies {
  readonly attendance: AttendanceStore;
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
