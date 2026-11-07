import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/clock';
import type { ApprovalRequestId, LicenceId, PersonId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { AccessFacts, Authorization } from '../../accounts-and-access-control/public';
import type { ApprovalVerifier, LicenceRefusal, LicenceState, LicenceStatus } from '../public';
import { isPermittedMove } from './domain/licence-transitions';
import type { AssignmentsStore, LicencesStore, LicenceStateChangeRow } from './ports';

export interface LicencesDependencies {
  readonly licences: LicencesStore;
  readonly assignments: AssignmentsStore;
  readonly authorization: Authorization;
  readonly accessFacts: AccessFacts;
  readonly approvals: ApprovalVerifier;
  readonly clock: Clock;
}

/**
 * Attendant licences (task A11). The committee issues a licence; it moves valid → suspended → revoked only when an
 * approved request says so, checked through the ApprovalVerifier port. Every move is kept with its approval, and
 * mirrored into access control so the attendant is refused on the very next request.
 */
export class LicencesService implements LicenceStatus {
  constructor(private readonly dependencies: LicencesDependencies) {}

  async statusOf(attendantId: PersonId): Promise<LicenceState | undefined> {
    const licence = await this.dependencies.licences.ofAttendant(attendantId);
    return licence === undefined ? undefined : this.currentState(licence.licenceId);
  }

  async licenceOf(attendantId: PersonId): Promise<LicenceId | undefined> {
    return (await this.dependencies.licences.ofAttendant(attendantId))?.licenceId;
  }

  async issueLicence(actor: PersonId, attendantId: PersonId): Promise<Result<LicenceId, LicenceRefusal>> {
    if ((await this.dependencies.authorization.roleOf(attendantId)) !== 'attendant') {
      return fail('not an attendant');
    }
    const siteId = (await this.dependencies.assignments.attendant(attendantId))?.siteId;
    const scope = siteId === undefined ? {} : { siteId };
    if (!(await this.dependencies.authorization.may(actor, 'licences.issue', scope))) {
      return fail('not allowed here');
    }
    if ((await this.dependencies.licences.ofAttendant(attendantId)) !== undefined) {
      return fail('already licensed');
    }
    const licenceId = `licence-${randomUUID()}`;
    const now = this.now();
    await this.dependencies.licences.add({ licenceId, attendantId, issuedBy: actor, issuedAt: now });
    await this.dependencies.licences.appendChange({ licenceId, from: null, to: 'valid', approvalRequestId: null, changedAt: now });
    await this.dependencies.accessFacts.recordLicenceState(attendantId, 'valid');
    return succeed(licenceId);
  }

  async applyApprovedStateChange(
    licenceId: LicenceId,
    to: LicenceState,
    approvalRequestId: ApprovalRequestId,
  ): Promise<Result<void, LicenceRefusal>> {
    const licence = await this.dependencies.licences.find(licenceId);
    if (licence === undefined) {
      return fail('unknown licence');
    }
    const from = await this.currentState(licenceId);
    if (!isPermittedMove(from, to)) {
      return fail('not a permitted change');
    }
    if (!(await this.dependencies.approvals.isApproved(approvalRequestId, { licenceId, to }))) {
      return fail('needs an approved request');
    }
    await this.dependencies.licences.appendChange({ licenceId, from, to, approvalRequestId, changedAt: this.now() });
    await this.dependencies.accessFacts.recordLicenceState(licence.attendantId, to);
    return succeed(undefined);
  }

  history(licenceId: LicenceId): Promise<readonly LicenceStateChangeRow[]> {
    return this.dependencies.licences.changesOf(licenceId);
  }

  private async currentState(licenceId: LicenceId): Promise<LicenceState> {
    const changes = await this.dependencies.licences.changesOf(licenceId);
    return changes[changes.length - 1]?.to ?? 'valid';
  }

  private now(): string {
    return this.dependencies.clock.now().toISOString();
  }
}
