import type { PersonId } from '../../../../shared/identifiers';
import type { AssignmentsStore, AttendantAssignment, InspectorAssignment, MemberAppointment } from '../ports';

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
