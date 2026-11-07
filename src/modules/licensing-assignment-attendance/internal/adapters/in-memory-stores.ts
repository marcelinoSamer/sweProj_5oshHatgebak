import type { LicenceId, PersonId } from '../../../../shared/identifiers';
import type {
  AssignmentsStore,
  AttendantAssignment,
  InspectorAssignment,
  LicenceRow,
  LicencesStore,
  LicenceStateChangeRow,
  MemberAppointment,
} from '../ports';

/** In-memory stand-ins for this module's tables, used by every test. */
export class InMemoryAssignmentsStore implements AssignmentsStore {
  private readonly attendants = new Map<PersonId, AttendantAssignment>();
  private readonly inspectors = new Map<PersonId, InspectorAssignment>();
  private readonly members = new Map<PersonId, MemberAppointment>();

  async attendant(attendantId: PersonId): Promise<AttendantAssignment | undefined> {
    return this.attendants.get(attendantId);
  }

  async saveAttendant(assignment: AttendantAssignment): Promise<void> {
    this.attendants.set(assignment.attendantId, assignment);
  }

  async removeAttendant(attendantId: PersonId): Promise<void> {
    this.attendants.delete(attendantId);
  }

  async inspector(inspectorId: PersonId): Promise<InspectorAssignment | undefined> {
    return this.inspectors.get(inspectorId);
  }

  async saveInspector(assignment: InspectorAssignment): Promise<void> {
    this.inspectors.set(assignment.inspectorId, assignment);
  }

  async member(memberId: PersonId): Promise<MemberAppointment | undefined> {
    return this.members.get(memberId);
  }

  async saveMember(appointment: MemberAppointment): Promise<void> {
    this.members.set(appointment.memberId, appointment);
  }

  async count(): Promise<number> {
    return this.attendants.size + this.inspectors.size + this.members.size;
  }
}

export class InMemoryLicencesStore implements LicencesStore {
  private readonly licences = new Map<LicenceId, LicenceRow>();
  private readonly changes: LicenceStateChangeRow[] = [];

  async add(licence: LicenceRow): Promise<void> {
    this.licences.set(licence.licenceId, licence);
  }

  async find(licenceId: LicenceId): Promise<LicenceRow | undefined> {
    return this.licences.get(licenceId);
  }

  async ofAttendant(attendantId: PersonId): Promise<LicenceRow | undefined> {
    return [...this.licences.values()].find((licence) => licence.attendantId === attendantId);
  }

  async appendChange(change: LicenceStateChangeRow): Promise<void> {
    this.changes.push(change);
  }

  async changesOf(licenceId: LicenceId): Promise<readonly LicenceStateChangeRow[]> {
    return this.changes.filter((change) => change.licenceId === licenceId);
  }
}
