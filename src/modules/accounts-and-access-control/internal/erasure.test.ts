import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonId } from '../../../shared/identifiers';
import type { CarRef, SiteLocator } from '../public';
import { createAccountsWorld, type AccountsWorld } from './testing/accounts-world';

/**
 * Task A5: remove a person's name, phone, plates and cars; keep their tickets with an unresolvable reference. Tickets
 * belong to Teammate B's module, so a ticket here is a stand-in holding the two references a real ticket holds.
 */
const siteLocator: SiteLocator = {
  locateSite: async (siteId) => (siteId === 'site-a' ? { zoneId: 'zone-a', districtId: 'district-1' } : undefined),
  locateZone: async (zoneId) => (zoneId === 'zone-a' ? { districtId: 'district-1' } : undefined),
};

let world: AccountsWorld;
let chair: PersonId;
let driver: PersonId;
let carRef: CarRef;

function valueOf<Value>(outcome: { ok: true; value: Value } | { ok: false; error: string }): Value {
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.value;
}

beforeEach(async () => {
  world = createAccountsWorld(siteLocator);
  chair = valueOf(await world.accounts.bootstrapChair('01000000000', 'The Chair'));
  driver = valueOf(await world.accounts.personalData.createPerson('self registration', 'driver', '01011111111', 'Mona Adel'));
  carRef = valueOf(await world.accounts.personalData.addCar(driver, 'ABC 123'));
  valueOf(await world.accounts.personalData.addCar(driver, 'XYZ 9'));
});

describe('A5 the task sheet case', () => {
  it('erases, then the person\'s old ticket still exists but its plate is no longer resolvable', async () => {
    const oldTicket = { ticketId: 'ticket-1', siteId: 'site-a', driverRef: driver, carRef };
    expect((await world.accounts.personalData.readPlate({ carRef: oldTicket.carRef, reader: driver, purpose: 'receipt', siteId: 'site-a' })).ok).toBe(true);

    valueOf(await world.accounts.personalData.erase(driver, driver));

    expect(oldTicket).toEqual({ ticketId: 'ticket-1', siteId: 'site-a', driverRef: driver, carRef });
    expect(await world.stores.people.find(oldTicket.driverRef)).toEqual({ personId: driver, role: 'driver', status: 'active', erased: true });
    expect(await world.accounts.personalData.readPlate({ carRef: oldTicket.carRef, reader: chair, purpose: 'receipt', siteId: 'site-a' })).toEqual({
      ok: false,
      error: 'not resolvable',
    });
  });
});

describe('A5 the rest of erasure', () => {
  it('leaves no name, phone or plate behind, and the person can no longer sign in or act', async () => {
    await world.accounts.signIn.requestSignInCode('01011111111');
    valueOf(await world.accounts.personalData.erase(chair, driver));
    expect(await world.stores.personalData.detailsOf(driver)).toBeUndefined();
    expect(await world.stores.personalData.carsOf(driver)).toEqual([]);
    expect(await world.stores.signInChallenges.find(driver)).toBeUndefined();
    expect(await world.accounts.personalData.ownCars(driver)).toEqual([]);
    expect(await world.accounts.authorization.liveStatus(driver)).toBe('revoked');
    await world.accounts.signIn.requestSignInCode('01011111111');
    expect(await world.accounts.signIn.signIn('01011111111', world.codeSender.lastCodeSentTo('+201011111111') ?? '')).toEqual({ ok: false, error: 'wrong code' });
  });

  it('lets the phone number be registered again by someone new', async () => {
    valueOf(await world.accounts.personalData.erase(driver, driver));
    expect((await world.accounts.personalData.createPerson('self registration', 'driver', '01011111111', 'New Owner')).ok).toBe(true);
  });

  it('lets a driver erase only themself, the Chair erase anyone but a Chair, and nobody erase twice', async () => {
    const otherDriver = valueOf(await world.accounts.personalData.createPerson('self registration', 'driver', '01022222222', 'Other'));
    const member = valueOf(await world.accounts.personalData.createPerson(chair, 'member', '01033333333', 'A Member'));
    expect(await world.accounts.personalData.erase(otherDriver, driver)).toEqual({ ok: false, error: 'not allowed' });
    expect(await world.accounts.personalData.erase(member, driver)).toEqual({ ok: false, error: 'not allowed' });
    expect(await world.accounts.personalData.erase(member, member)).toEqual({ ok: false, error: 'not allowed' });
    expect(await world.accounts.personalData.erase(chair, chair)).toEqual({ ok: false, error: 'not allowed' });
    expect((await world.accounts.personalData.erase(chair, member)).ok).toBe(true);
    expect(await world.accounts.personalData.erase(chair, member)).toEqual({ ok: false, error: 'already erased' });
    expect(await world.accounts.personalData.erase(chair, 'nobody')).toEqual({ ok: false, error: 'unknown person' });
  });
});

describe('A5 report', () => {
  it('measures the time to erase and lists the tables touched', async () => {
    const started = performance.now();
    const report = valueOf(await world.accounts.personalData.erase(driver, driver));
    const milliseconds = performance.now() - started;
    expect(report.rowsRemoved).toEqual({
      'personal_data.person_details': 1,
      'personal_data.cars': 2,
      'accounts_and_access_control.sign_in_challenges': 0,
      'accounts_and_access_control.access_facts': 0,
    });
    const tables = [...Object.keys(report.rowsRemoved), ...Object.keys(report.rowsMarked)];
    console.log(
      `A5 report: time to erase ${milliseconds.toFixed(2)} ms (in memory); tables touched ${tables.length}: ` +
        `${Object.keys(report.rowsRemoved).join(', ')} (rows deleted) and ${Object.keys(report.rowsMarked).join(', ')} (row kept, marked erased)`,
    );
  });
});
