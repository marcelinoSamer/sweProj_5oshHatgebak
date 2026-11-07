/**
 * Licensing, Assignment & Attendance — owner: Teammate A (Area 2). May-fail set.
 * Attendant licences (state changed only through Approvals), site and shift assignment, inspector to zone,
 * clock in and out, off-site flags. Needs AuditTrail.
 */
import type { Clock } from '../../shared/clock';
import type { DistrictId, LicenceId, PersonId, SiteId, ZoneId } from '../../shared/identifiers';
import type { RequestId } from '../../shared/request-id';
import type { Result } from '../../shared/result';
import type { AccessFacts, Authorization, LicenceLiveState } from '../accounts-and-access-control/public';
import type { SiteRegistry } from '../sites-and-areas/public';
import { InMemoryAssignmentsStore } from './internal/adapters/in-memory-stores';
import { AssignmentsService } from './internal/assignments-service';
import type { AssignmentsStore } from './internal/ports';

export type LicenceState = LicenceLiveState;

export interface LicenceStatus {
  statusOf(attendantId: PersonId): Promise<LicenceState>;
  issueLicence(requestId: RequestId, attendantId: PersonId): Promise<LicenceId>;
  applyApprovedStateChange(licenceId: LicenceId, to: LicenceState, approvalRequestId: string): Promise<void>;
}

export type AssignmentRefusal =
  | 'one site per attendant'
  | 'members are managed by the Chair only'
  | 'not allowed here'
  | 'not an attendant'
  | 'not an inspector'
  | 'not a member'
  | 'not assigned'
  | 'unknown site'
  | 'unknown zone'
  | 'unknown district'
  | 'invalid shift';

/**
 * Who works where (task A12). Every write takes the acting person: a member of the district or the Chair assigns
 * attendants and inspectors; only the Chair appoints members.
 */
export interface Assignments {
  assignAttendantToSite(actor: PersonId, attendantId: PersonId, siteId: SiteId, shiftId: string): Promise<Result<void, AssignmentRefusal>>;
  changeShift(actor: PersonId, attendantId: PersonId, shiftId: string): Promise<Result<void, AssignmentRefusal>>;
  releaseAttendant(actor: PersonId, attendantId: PersonId): Promise<Result<void, AssignmentRefusal>>;
  assignInspectorToZone(actor: PersonId, inspectorId: PersonId, zoneId: ZoneId): Promise<Result<void, AssignmentRefusal>>;
  appointMemberToDistrict(actor: PersonId, memberId: PersonId, districtId: DistrictId): Promise<Result<void, AssignmentRefusal>>;
  siteOf(attendantId: PersonId): Promise<SiteId | undefined>;
  shiftOf(attendantId: PersonId): Promise<string | undefined>;
  zoneOf(inspectorId: PersonId): Promise<ZoneId | undefined>;
}

export type ClockInRefusal = 'wrong site' | 'forged code';

export interface Attendance {
  clockIn(requestId: RequestId, attendantId: PersonId, scannedSiteCode: string): Promise<Result<void, ClockInRefusal>>;
  clockOut(requestId: RequestId, attendantId: PersonId): Promise<void>;
  recordLocationPoint(attendantId: PersonId, latitude: number, longitude: number): Promise<void>;
  offSiteFlags(zoneId: ZoneId): Promise<readonly PersonId[]>;
}

export interface LicensingAssignmentAttendanceStores {
  readonly assignments: AssignmentsStore;
}

export interface LicensingAssignmentAttendanceDependencies {
  readonly stores: LicensingAssignmentAttendanceStores;
  readonly authorization: Authorization;
  readonly accessFacts: AccessFacts;
  readonly registry: SiteRegistry;
  readonly clock: Clock;
}

export interface LicensingAssignmentAttendance {
  readonly assignments: Assignments;
}

/** The composition root builds this module through this one function; nothing else constructs its internals. */
export function createLicensingAssignmentAttendance(dependencies: LicensingAssignmentAttendanceDependencies): LicensingAssignmentAttendance {
  const { stores, authorization, accessFacts, registry, clock } = dependencies;
  return {
    assignments: new AssignmentsService({ assignments: stores.assignments, authorization, accessFacts, registry, clock }),
  };
}

export function createInMemoryLicensingStores(): LicensingAssignmentAttendanceStores {
  return { assignments: new InMemoryAssignmentsStore() };
}

export { createLicensingOperations } from './internal/operations';
