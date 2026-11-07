import type { Clock } from '../../../shared/clock';
import type { DistrictId, PersonId, Role, SiteId, ZoneId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { AccessFacts, Authorization } from '../../accounts-and-access-control/public';
import type { SiteRegistry } from '../../sites-and-areas/public';
import type { AssignmentRefusal, Assignments } from '../public';
import type { AssignmentsStore } from './ports';

export interface AssignmentsDependencies {
  readonly assignments: AssignmentsStore;
  readonly authorization: Authorization;
  readonly accessFacts: AccessFacts;
  readonly registry: SiteRegistry;
  readonly clock: Clock;
}

const MAXIMUM_SHIFT_LENGTH = 40;

/**
 * Who works where (task A12): an attendant at one fixed site with a changeable shift, an inspector over one zone, a
 * member over one district. Every change is also recorded in access control's facts, in the same unit of work, so
 * permission answers follow at once without access control ever calling this may-fail module (Rule D).
 */
export class AssignmentsService implements Assignments {
  constructor(private readonly dependencies: AssignmentsDependencies) {}

  async assignAttendantToSite(actor: PersonId, attendantId: PersonId, siteId: SiteId, shiftId: string): Promise<Result<void, AssignmentRefusal>> {
    const shift = validShift(shiftId);
    if (!shift.ok) {
      return shift;
    }
    const checked = await this.checkTarget(attendantId, 'attendant', 'not an attendant');
    if (!checked.ok) {
      return checked;
    }
    if ((await this.dependencies.registry.locateSite(siteId)) === undefined) {
      return fail('unknown site');
    }
    if (!(await this.dependencies.authorization.may(actor, 'assignments.assignAttendant', { siteId }))) {
      return fail('not allowed here');
    }
    const current = await this.dependencies.assignments.attendant(attendantId);
    if (current !== undefined && current.siteId !== siteId) {
      return fail('one site per attendant');
    }
    await this.dependencies.assignments.saveAttendant({ attendantId, siteId, shiftId: shift.value, assignedBy: actor, assignedAt: this.now() });
    await this.dependencies.accessFacts.recordAttendantSite(attendantId, siteId);
    return succeed(undefined);
  }

  async changeShift(actor: PersonId, attendantId: PersonId, shiftId: string): Promise<Result<void, AssignmentRefusal>> {
    const shift = validShift(shiftId);
    if (!shift.ok) {
      return shift;
    }
    const current = await this.dependencies.assignments.attendant(attendantId);
    if (current === undefined) {
      return fail('not assigned');
    }
    if (!(await this.dependencies.authorization.may(actor, 'assignments.changeShift', { siteId: current.siteId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.assignments.saveAttendant({ ...current, shiftId: shift.value, assignedBy: actor, assignedAt: this.now() });
    return succeed(undefined);
  }

  /** Frees an attendant from their site, so a later assignment may name another one. */
  async releaseAttendant(actor: PersonId, attendantId: PersonId): Promise<Result<void, AssignmentRefusal>> {
    const current = await this.dependencies.assignments.attendant(attendantId);
    if (current === undefined) {
      return fail('not assigned');
    }
    if (!(await this.dependencies.authorization.may(actor, 'assignments.releaseAttendant', { siteId: current.siteId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.assignments.removeAttendant(attendantId);
    await this.dependencies.accessFacts.clearAttendantSite(attendantId);
    return succeed(undefined);
  }

  async assignInspectorToZone(actor: PersonId, inspectorId: PersonId, zoneId: ZoneId): Promise<Result<void, AssignmentRefusal>> {
    const checked = await this.checkTarget(inspectorId, 'inspector', 'not an inspector');
    if (!checked.ok) {
      return checked;
    }
    if ((await this.dependencies.registry.locateZone(zoneId)) === undefined) {
      return fail('unknown zone');
    }
    if (!(await this.dependencies.authorization.may(actor, 'assignments.assignInspector', { zoneId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.assignments.saveInspector({ inspectorId, zoneId, assignedBy: actor, assignedAt: this.now() });
    await this.dependencies.accessFacts.recordInspectorZone(inspectorId, zoneId);
    return succeed(undefined);
  }

  async appointMemberToDistrict(actor: PersonId, memberId: PersonId, districtId: DistrictId): Promise<Result<void, AssignmentRefusal>> {
    if ((await this.dependencies.authorization.roleOf(actor)) !== 'chair' || (await this.dependencies.authorization.liveStatus(actor)) !== 'active') {
      return fail('members are managed by the Chair only');
    }
    const checked = await this.checkTarget(memberId, 'member', 'not a member');
    if (!checked.ok) {
      return checked;
    }
    if (!(await this.dependencies.registry.districtExists(districtId))) {
      return fail('unknown district');
    }
    await this.dependencies.assignments.saveMember({ memberId, districtId, appointedBy: actor, appointedAt: this.now() });
    await this.dependencies.accessFacts.recordMemberDistrict(memberId, districtId);
    return succeed(undefined);
  }

  async siteOf(attendantId: PersonId): Promise<SiteId | undefined> {
    return (await this.dependencies.assignments.attendant(attendantId))?.siteId;
  }

  async shiftOf(attendantId: PersonId): Promise<string | undefined> {
    return (await this.dependencies.assignments.attendant(attendantId))?.shiftId;
  }

  async zoneOf(inspectorId: PersonId): Promise<ZoneId | undefined> {
    return (await this.dependencies.assignments.inspector(inspectorId))?.zoneId;
  }

  private async checkTarget(personId: PersonId, role: Role, refusal: AssignmentRefusal): Promise<Result<void, AssignmentRefusal>> {
    return (await this.dependencies.authorization.roleOf(personId)) === role ? succeed(undefined) : fail(refusal);
  }

  private now(): string {
    return this.dependencies.clock.now().toISOString();
  }
}

function validShift(shiftId: string): Result<string, AssignmentRefusal> {
  const trimmed = shiftId.trim();
  return trimmed === '' || trimmed.length > MAXIMUM_SHIFT_LENGTH ? fail('invalid shift') : succeed(trimmed);
}
