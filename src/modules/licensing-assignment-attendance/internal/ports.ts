import type { DistrictId, LicenceId, PersonId, SiteId, ZoneId } from '../../../shared/identifiers';
import type { LicenceStateChange } from '../public';

/**
 * Storage ports owned by this module. The in-memory adapters in `adapters/` implement them for every test; the
 * PostgreSQL adapters will implement the same ports over the tables in `db/migrations/0002_identity_and_registry.sql`.
 */

/** One row of `licensing_assignment_attendance.attendant_assignments`: an attendant's one fixed site and shift. */
export interface AttendantAssignment {
  readonly attendantId: PersonId;
  readonly siteId: SiteId;
  readonly shiftId: string;
  readonly assignedBy: PersonId;
  /** Set from the server clock (Rule I). */
  readonly assignedAt: string;
}

export interface InspectorAssignment {
  readonly inspectorId: PersonId;
  readonly zoneId: ZoneId;
  readonly assignedBy: PersonId;
  readonly assignedAt: string;
}

export interface MemberAppointment {
  readonly memberId: PersonId;
  readonly districtId: DistrictId;
  readonly appointedBy: PersonId;
  readonly appointedAt: string;
}

export interface AssignmentsStore {
  attendant(attendantId: PersonId): Promise<AttendantAssignment | undefined>;
  saveAttendant(assignment: AttendantAssignment): Promise<void>;
  removeAttendant(attendantId: PersonId): Promise<void>;
  inspector(inspectorId: PersonId): Promise<InspectorAssignment | undefined>;
  saveInspector(assignment: InspectorAssignment): Promise<void>;
  member(memberId: PersonId): Promise<MemberAppointment | undefined>;
  saveMember(appointment: MemberAppointment): Promise<void>;
  count(): Promise<number>;
}

/** One row of `licensing_assignment_attendance.licences`. The current state is the last change's target state. */
export interface LicenceRow {
  readonly licenceId: LicenceId;
  readonly attendantId: PersonId;
  readonly issuedBy: PersonId;
  readonly issuedAt: string;
}

/** One row of `licensing_assignment_attendance.licence_state_changes`: insert-only, every move with its approval. */
export type LicenceStateChangeRow = LicenceStateChange;

export interface LicencesStore {
  add(licence: LicenceRow): Promise<void>;
  find(licenceId: LicenceId): Promise<LicenceRow | undefined>;
  ofAttendant(attendantId: PersonId): Promise<LicenceRow | undefined>;
  appendChange(change: LicenceStateChangeRow): Promise<void>;
  changesOf(licenceId: LicenceId): Promise<readonly LicenceStateChangeRow[]>;
}

/** One row of `licensing_assignment_attendance.attendance`: one clock-in, closed by its clock-out. */
export interface AttendanceRow {
  readonly attendanceId: string;
  readonly attendantId: PersonId;
  readonly siteId: SiteId;
  readonly shiftId: string;
  /** Both set from the server clock (Rule I). */
  readonly clockedInAt: string;
  readonly clockedOutAt?: string;
}

export interface AttendanceStore {
  open(attendantId: PersonId): Promise<AttendanceRow | undefined>;
  add(row: AttendanceRow): Promise<void>;
  close(attendanceId: string, clockedOutAt: string): Promise<void>;
  all(): Promise<readonly AttendanceRow[]>;
}

/**
 * One location reading during a shift. Only its distance from the site is kept, never the coordinates: the rule needs
 * nothing more, and personal data is collected minimally (Law 151 of 2020).
 */
export interface LocationReading {
  readonly attendanceId: string;
  readonly distanceMeters: number;
  readonly recordedAt: string;
}

export interface OffSiteFlagRow {
  readonly flagId: string;
  readonly attendanceId: string;
  readonly attendantId: PersonId;
  readonly siteId: SiteId;
  readonly zoneId: ZoneId;
  readonly raisedAt: string;
}

export interface OffSiteStore {
  addReading(reading: LocationReading): Promise<void>;
  readingsOf(attendanceId: string): Promise<readonly LocationReading[]>;
  flagOf(attendanceId: string): Promise<OffSiteFlagRow | undefined>;
  addFlag(flag: OffSiteFlagRow): Promise<void>;
  flagsIn(zoneId: ZoneId): Promise<readonly OffSiteFlagRow[]>;
}
