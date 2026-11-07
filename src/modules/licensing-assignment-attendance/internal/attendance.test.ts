import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonId } from '../../../shared/identifiers';
import { createLicensingWorld, createPerson, valueOf, type LicensingWorld } from './testing/licensing-world';

/** Task A13: clock in and out by scanning the own site's code; refuse another site's code. */
let world: LicensingWorld;
let attendant: PersonId;
let clockIns = 0;
let refusals = 0;

async function clockIn(code: string) {
  const outcome = await world.licensing.attendance.clockIn(attendant, code);
  if (outcome.ok) {
    clockIns += 1;
  } else {
    refusals += 1;
  }
  return outcome;
}

beforeEach(async () => {
  world = await createLicensingWorld();
  attendant = await createPerson(world, 'attendant');
  valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOne, 'morning'));
  valueOf(await world.licensing.licences.issueLicence(world.memberOfDistrictOne, attendant));
});

describe('A13 the task sheet cases', () => {
  it('clocks in on scanning the own site\'s code, and binds the session to that site', async () => {
    const { entryCode } = await world.registry.issueEntryAndExitCodes(world.siteOne);
    expect(await clockIn(entryCode)).toEqual({ ok: true, value: world.siteOne });
    expect(await world.licensing.attendance.isClockedIn(attendant)).toBe(true);
    expect(await world.accounts.authorization.boundSite(attendant)).toBe(world.siteOne);
  });

  it('refuses another site\'s code', async () => {
    const { entryCode } = await world.registry.issueEntryAndExitCodes(world.siteTwo);
    expect(await clockIn(entryCode)).toEqual({ ok: false, error: 'wrong site' });
    expect(await world.licensing.attendance.isClockedIn(attendant)).toBe(false);
    expect(await world.accounts.authorization.boundSite(attendant)).toBeUndefined();
  });
});

describe('A13 the rest of attendance', () => {
  it('accepts the exit code too, refuses an altered code, and is not fooled twice', async () => {
    const { exitCode } = await world.registry.issueEntryAndExitCodes(world.siteOne);
    expect(await clockIn(`${exitCode.slice(0, -1)}${exitCode.endsWith('A') ? 'B' : 'A'}`)).toEqual({ ok: false, error: 'forged code' });
    expect(await clockIn(exitCode)).toEqual({ ok: true, value: world.siteOne });
    expect(await clockIn(exitCode)).toEqual({ ok: true, value: world.siteOne });
  });

  it('clocks out, releasing the session', async () => {
    const { entryCode } = await world.registry.issueEntryAndExitCodes(world.siteOne);
    await clockIn(entryCode);
    world.clock.advanceByMilliseconds(8 * 60 * 60 * 1000);
    expect(await world.licensing.attendance.clockOut(attendant)).toEqual({ ok: true, value: world.siteOne });
    expect(await world.accounts.authorization.boundSite(attendant)).toBeUndefined();
    expect(await world.licensing.attendance.clockOut(attendant)).toEqual({ ok: false, error: 'not clocked in' });
    const [row] = await world.stores.attendance.all();
    expect(row).toMatchObject({ siteId: world.siteOne, shiftId: 'morning', clockedInAt: '2026-11-05T08:00:00.000Z', clockedOutAt: '2026-11-05T16:00:00.000Z' });
  });

  it('refuses an attendant with no site, and one whose licence was suspended', async () => {
    const unassigned = await createPerson(world, 'attendant');
    const { entryCode } = await world.registry.issueEntryAndExitCodes(world.siteOne);
    expect(await world.licensing.attendance.clockIn(unassigned, entryCode)).toEqual({ ok: false, error: 'not assigned' });
    const licenceId = (await world.licensing.licences.licenceOf(attendant)) ?? '';
    world.approvals.approve('approval-1', licenceId, 'suspended');
    valueOf(await world.licensing.licences.applyApprovedStateChange(licenceId, 'suspended', 'approval-1'));
    expect(await clockIn(entryCode)).toEqual({ ok: false, error: 'licence not live' });
  });
});

describe('A13 report', () => {
  it('prints the clock-ins and refusals of this file', () => {
    console.log(`A13 report: clock-ins ${clockIns}; refusals ${refusals}`);
    expect(clockIns).toBeGreaterThan(0);
  });
});
