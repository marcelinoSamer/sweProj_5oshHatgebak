import { beforeEach, describe, expect, it } from 'vitest';
import type { LicenceId, PersonId } from '../../../shared/identifiers';
import { createLicensingWorld, createPerson, valueOf, type LicensingWorld } from './testing/licensing-world';

/** Task A11: issue a licence; move it valid → suspended → revoked only when an approved request says so. */
let world: LicensingWorld;
let attendant: PersonId;
let licenceId: LicenceId;

beforeEach(async () => {
  world = await createLicensingWorld();
  attendant = await createPerson(world, 'attendant');
  valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOne, 'morning'));
  licenceId = valueOf(await world.licensing.licences.issueLicence(world.memberOfDistrictOne, attendant));
});

describe('A11 the task sheet cases', () => {
  it('refuses a direct suspension: "needs an approved request"', async () => {
    expect(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'request-never-approved')).toEqual({
      ok: false,
      error: 'needs an approved request',
    });
    expect(await world.licensing.licences.statusOf(attendant)).toBe('valid');
  });

  it('suspends through an approved request', async () => {
    world.approvals.approve('approval-1', licenceId, 'suspended');
    expect(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-1')).toEqual({ ok: true, value: undefined });
    expect(await world.licensing.licences.statusOf(attendant)).toBe('suspended');
  });
});

describe('A11 the rest of the licence rules', () => {
  it('refuses an approval that orders another move or another licence', async () => {
    world.approvals.approve('approval-for-revocation', licenceId, 'revoked');
    expect(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-for-revocation')).toEqual({
      ok: false,
      error: 'needs an approved request',
    });
    world.approvals.approve('approval-for-another-licence', 'licence-of-someone-else', 'suspended');
    expect(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-for-another-licence')).toEqual({
      ok: false,
      error: 'needs an approved request',
    });
  });

  it('moves valid → suspended → revoked, and refuses every move out of revoked and back to valid', async () => {
    world.approvals.approve('approval-1', licenceId, 'suspended');
    world.approvals.approve('approval-2', licenceId, 'revoked');
    world.approvals.approve('approval-3', licenceId, 'valid');
    valueOf(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-1'));
    expect(await world.licensing.licences.applyApprovedStateChange(licenceId, 'valid', 'approval-3')).toEqual({ ok: false, error: 'not a permitted change' });
    valueOf(await world.licensing.licences.applyApprovedStateChange(licenceId, 'revoked', 'approval-2'));
    expect(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-1')).toEqual({ ok: false, error: 'not a permitted change' });
    expect(await world.licensing.licences.statusOf(attendant)).toBe('revoked');
  });

  it('blocks the attendant in access control on the very next call after the approved suspension', async () => {
    expect(await world.accounts.authorization.may(attendant, 'payments.tickCash', { siteId: world.siteOne })).toBe(true);
    world.approvals.approve('approval-1', licenceId, 'suspended');
    valueOf(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-1'));
    expect(await world.accounts.authorization.may(attendant, 'payments.tickCash', { siteId: world.siteOne })).toBe(false);
    expect(await world.accounts.authorization.liveStatus(attendant)).toBe('suspended');
  });

  it('issues one licence per attendant, to attendants only, by the district\'s member or the Chair', async () => {
    expect(await world.licensing.licences.issueLicence(world.chair, attendant)).toEqual({ ok: false, error: 'already licensed' });
    const inspector = await createPerson(world, 'inspector');
    expect(await world.licensing.licences.issueLicence(world.chair, inspector)).toEqual({ ok: false, error: 'not an attendant' });

    const unassigned = await createPerson(world, 'attendant');
    expect(await world.licensing.licences.issueLicence(world.memberOfDistrictOne, unassigned)).toEqual({ ok: false, error: 'not allowed here' });
    expect((await world.licensing.licences.issueLicence(world.chair, unassigned)).ok).toBe(true);

    const elsewhere = await createPerson(world, 'attendant');
    valueOf(await world.licensing.assignments.assignAttendantToSite(world.chair, elsewhere, world.siteTwo, 'morning'));
    expect(await world.licensing.licences.issueLicence(world.memberOfDistrictOne, elsewhere)).toEqual({ ok: false, error: 'not allowed here' });
  });

  it('refuses a change to an unknown licence', async () => {
    expect(await world.licensing.licences.applyApprovedStateChange('no-such-licence', 'suspended', 'approval-1')).toEqual({ ok: false, error: 'unknown licence' });
  });
});

describe('A11 report', () => {
  it('keeps every state change with the approval that ordered it', async () => {
    world.approvals.approve('approval-1', licenceId, 'suspended');
    world.approvals.approve('approval-2', licenceId, 'revoked');
    valueOf(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-1'));
    valueOf(await world.licensing.licences.applyApprovedStateChange(licenceId, 'revoked', 'approval-2'));
    await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'not-approved');

    const history = await world.licensing.licences.history(licenceId);
    expect(history.map((change) => [change.from, change.to, change.approvalRequestId])).toEqual([
      [null, 'valid', null],
      ['valid', 'suspended', 'approval-1'],
      ['suspended', 'revoked', 'approval-2'],
    ]);
    const stateChanges = history.filter((change) => change.from !== null);
    const logged = stateChanges.filter((change) => change.approvalRequestId !== null);
    expect(logged).toHaveLength(stateChanges.length);
    console.log(
      `A11 report: licence state changes logged with their approval ${logged.length} / made ${stateChanges.length} (100 %); ` +
        'the audit entry for each is the approving request\'s own entry',
    );
  });
});
