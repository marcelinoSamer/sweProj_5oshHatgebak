/**
 * Licensing, Assignment & Attendance — owner: Teammate A (Area 2). May-fail set.
 * Attendant licences (state changed only through Approvals), site and shift assignment, inspector to zone,
 * clock in and out, off-site flags. Needs AuditTrail.
 */
import type { Clock } from '../../shared/clock';
import type { ApprovalRequestId, DistrictId, LicenceId, PersonId, SiteId, ZoneId } from '../../shared/identifiers';
import type { Result } from '../../shared/result';
import type { AccessFacts, Authorization, LicenceLiveState } from '../accounts-and-access-control/public';
import type { SiteRegistry } from '../sites-and-areas/public';
import { InMemoryAssignmentsStore, InMemoryAttendanceStore, InMemoryLicencesStore } from './internal/adapters/in-memory-stores';
import { AssignmentsService } from './internal/assignments-service';
import { AttendanceService } from './internal/attendance-service';
import { LicencesService } from './internal/licences-service';
import type { AssignmentsStore, AttendanceStore, LicencesStore } from './internal/ports';

export type LicenceState = LicenceLiveState;

export type LicenceRefusal =
  | 'needs an approved request'
  | 'not a permitted change'
  | 'unknown licence'
  | 'already licensed'
  | 'not an attendant'
  | 'not allowed here';

/** One move of a licence, kept forever with the approved request that ordered it (null only for the issue). */
export interface LicenceStateChange {
  readonly licenceId: LicenceId;
  readonly from: LicenceState | null;
  readonly to: LicenceState;
  readonly approvalRequestId: ApprovalRequestId | null;
  readonly changedAt: string;
}

/**
 * Attendant licences (task A11). The committee issues one licence per attendant. Suspension and revocation happen
 * only through applyApprovedStateChange, which Approvals calls inside the transaction that approves the request; any
 * other attempt is refused "needs an approved request".
 */
export interface LicenceStatus {
  /** undefined when the attendant has never been licensed. */
  statusOf(attendantId: PersonId): Promise<LicenceState | undefined>;
  licenceOf(attendantId: PersonId): Promise<LicenceId | undefined>;
  issueLicence(actor: PersonId, attendantId: PersonId): Promise<Result<LicenceId, LicenceRefusal>>;
  applyApprovedStateChange(licenceId: LicenceId, to: LicenceState, approvalRequestId: ApprovalRequestId): Promise<Result<void, LicenceRefusal>>;
  history(licenceId: LicenceId): Promise<readonly LicenceStateChange[]>;
}

/**
 * Port: confirms that an approval request exists, was approved by the Chair, and orders exactly this licence move. The
 * composition root fills it from Approvals (Teammate C), which this module may not import because Approvals imports it.
 */
export interface ApprovalVerifier {
  isApproved(approvalRequestId: ApprovalRequestId, change: { readonly licenceId: LicenceId; readonly to: LicenceState }): Promise<boolean>;
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

export type ClockInRefusal = 'wrong site' | 'forged code' | 'not assigned' | 'licence not live';
export type ClockOutRefusal = 'not clocked in';

/**
 * Clock in and out by scanning the own site's code (task A13). Clock-in binds the attendant's session to the site in
 * access control; clock-out releases it. Times come from the server clock.
 */
export interface Attendance {
  clockIn(attendantId: PersonId, scannedSiteCode: string): Promise<Result<SiteId, ClockInRefusal>>;
  clockOut(attendantId: PersonId): Promise<Result<SiteId, ClockOutRefusal>>;
  isClockedIn(attendantId: PersonId): Promise<boolean>;
}

export interface LicensingAssignmentAttendanceStores {
  readonly assignments: AssignmentsStore;
  readonly licences: LicencesStore;
  readonly attendance: AttendanceStore;
}

export interface LicensingAssignmentAttendanceDependencies {
  readonly stores: LicensingAssignmentAttendanceStores;
  readonly authorization: Authorization;
  readonly accessFacts: AccessFacts;
  readonly registry: SiteRegistry;
  readonly approvals: ApprovalVerifier;
  readonly clock: Clock;
}

export interface LicensingAssignmentAttendance {
  readonly assignments: Assignments;
  readonly licences: LicenceStatus;
  readonly attendance: Attendance;
}

/** The composition root builds this module through this one function; nothing else constructs its internals. */
export function createLicensingAssignmentAttendance(dependencies: LicensingAssignmentAttendanceDependencies): LicensingAssignmentAttendance {
  const { stores, authorization, accessFacts, registry, approvals, clock } = dependencies;
  return {
    assignments: new AssignmentsService({ assignments: stores.assignments, authorization, accessFacts, registry, clock }),
    licences: new LicencesService({ licences: stores.licences, assignments: stores.assignments, authorization, accessFacts, approvals, clock }),
    attendance: new AttendanceService({ attendance: stores.attendance, assignments: stores.assignments, authorization, registry, clock }),
  };
}

export function createInMemoryLicensingStores(): LicensingAssignmentAttendanceStores {
  return { assignments: new InMemoryAssignmentsStore(), licences: new InMemoryLicencesStore(), attendance: new InMemoryAttendanceStore() };
}

export { createLicensingOperations } from './internal/operations';
