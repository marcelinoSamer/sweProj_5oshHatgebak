import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonId, Role } from '../../../shared/identifiers';
import {
  SCOPE_RULE_DESCRIPTIONS,
  type AccountsAndAccessControl,
  type AccountsAndAccessControlStores,
  type SiteLocator,
} from '../public';
import { createAccountsWorld } from './testing/accounts-world';

/** Two zones in district 1 and one zone in district 2, one site in each. */
const ZONES: Readonly<Record<string, string>> = { 'zone-3': 'district-1', 'zone-4': 'district-1', 'zone-9': 'district-2' };
const SITES: Readonly<Record<string, string>> = { 'site-in-zone-3': 'zone-3', 'site-in-zone-4': 'zone-4', 'site-in-zone-9': 'zone-9' };

const siteLocator: SiteLocator = {
  locateSite: async (siteId) => {
    const zoneId = SITES[siteId];
    const districtId = zoneId === undefined ? undefined : ZONES[zoneId];
    return zoneId === undefined || districtId === undefined ? undefined : { zoneId, districtId };
  },
  locateZone: async (zoneId) => (ZONES[zoneId] === undefined ? undefined : { districtId: ZONES[zoneId] }),
};

interface Cast {
  readonly chair: PersonId;
  readonly member: PersonId;
  readonly inspector: PersonId;
  readonly attendant: PersonId;
  readonly driver: PersonId;
}

let stores: AccountsAndAccessControlStores;
let accounts: AccountsAndAccessControl;
let cast: Cast;

async function created(result: Promise<{ ok: true; value: PersonId } | { ok: false; error: string }>): Promise<PersonId> {
  const outcome = await result;
  if (!outcome.ok) {
    throw new Error(`could not create the test cast: ${outcome.error}`);
  }
  return outcome.value;
}

async function createCast(): Promise<Cast> {
  const chair = await created(accounts.bootstrapChair('01000000001', 'The Chair'));
  const make = (creator: PersonId, role: Role, phone: string) => created(accounts.personalData.createPerson(creator, role, phone, role));
  const member = await make(chair, 'member', '01000000002');
  const inspector = await make(member, 'inspector', '01000000003');
  const attendant = await make(member, 'attendant', '01000000004');
  const driver = await created(accounts.personalData.createPerson('self registration', 'driver', '01000000005', 'driver'));
  await accounts.accessFacts.recordMemberDistrict(member, 'district-1');
  await accounts.accessFacts.recordInspectorZone(inspector, 'zone-3');
  await accounts.accessFacts.recordAttendantSite(attendant, 'site-in-zone-3');
  await accounts.accessFacts.recordLicenceState(attendant, 'valid');
  return { chair, member, inspector, attendant, driver };
}

beforeEach(async () => {
  ({ stores, accounts } = createAccountsWorld(siteLocator));
  cast = await createCast();
});

describe('A3 permission and scope rules, the task sheet cases', () => {
  it('refuses the inspector of zone 3 on a site in zone 4', async () => {
    expect(await accounts.authorization.may(cast.inspector, 'inspections.file', { siteId: 'site-in-zone-4' })).toBe(false);
  });

  it('allows the inspector of zone 3 on a site in zone 3', async () => {
    expect(await accounts.authorization.may(cast.inspector, 'inspections.file', { siteId: 'site-in-zone-3' })).toBe(true);
  });

  it('allows the Chair anywhere, including system-wide', async () => {
    for (const scope of [{ siteId: 'site-in-zone-9' }, { zoneId: 'zone-4' }, { districtId: 'district-2' }, {}]) {
      expect(await accounts.authorization.may(cast.chair, 'any.operation', scope)).toBe(true);
    }
  });

  it('refuses a revoked attendant on the very next call, without a new sign-in', async () => {
    const atOwnSite = { siteId: 'site-in-zone-3' };
    expect(await accounts.authorization.may(cast.attendant, 'payments.tickCash', atOwnSite)).toBe(true);
    await accounts.accessFacts.recordLicenceState(cast.attendant, 'revoked');
    expect(await accounts.authorization.may(cast.attendant, 'payments.tickCash', atOwnSite)).toBe(false);
    expect(await accounts.authorization.liveStatus(cast.attendant)).toBe('revoked');
  });
});

describe('A3 the rest of the hierarchy', () => {
  it('lets a member act in their own district only', async () => {
    expect(await accounts.authorization.may(cast.member, 'sites.changeCapacity', { siteId: 'site-in-zone-4' })).toBe(true);
    expect(await accounts.authorization.may(cast.member, 'sites.changeCapacity', { districtId: 'district-1' })).toBe(true);
    expect(await accounts.authorization.may(cast.member, 'sites.changeCapacity', { siteId: 'site-in-zone-9' })).toBe(false);
  });

  it('lets an attendant act at their one site only', async () => {
    expect(await accounts.authorization.may(cast.attendant, 'payments.tickCash', { siteId: 'site-in-zone-4' })).toBe(false);
    expect(await accounts.authorization.may(cast.attendant, 'payments.tickCash', { zoneId: 'zone-3' })).toBe(false);
  });

  it('refuses an attendant whose licence is suspended or was never issued', async () => {
    await accounts.accessFacts.recordLicenceState(cast.attendant, 'suspended');
    expect(await accounts.authorization.liveStatus(cast.attendant)).toBe('suspended');
    expect(await accounts.authorization.may(cast.attendant, 'payments.tickCash', { siteId: 'site-in-zone-3' })).toBe(false);
  });

  it('refuses everyone but the Chair system-wide, and refuses a driver any place', async () => {
    for (const person of [cast.member, cast.inspector, cast.attendant, cast.driver]) {
      expect(await accounts.authorization.may(person, 'any.operation', {})).toBe(false);
    }
    expect(await accounts.authorization.may(cast.driver, 'any.operation', { siteId: 'site-in-zone-3' })).toBe(false);
  });

  it('refuses a suspended account and an unknown person', async () => {
    await stores.people.setStatus(cast.member, 'suspended');
    expect(await accounts.authorization.may(cast.member, 'sites.changeCapacity', { districtId: 'district-1' })).toBe(false);
    expect(await accounts.authorization.may('nobody', 'sites.changeCapacity', { districtId: 'district-1' })).toBe(false);
    expect(await accounts.authorization.liveStatus('nobody')).toBe('revoked');
  });

  it('refuses an unknown site and ids that do not belong together, even for the Chair', async () => {
    const unknown = await accounts.authorization.explain(cast.chair, 'any.operation', { siteId: 'no-such-site' });
    expect(unknown).toEqual({ operation: 'any.operation', allowed: false, reason: 'unknown or inconsistent place' });
    expect(await accounts.authorization.may(cast.member, 'x', { siteId: 'site-in-zone-3', zoneId: 'zone-4' })).toBe(false);
    expect(await accounts.authorization.may(cast.member, 'x', { zoneId: 'zone-9', districtId: 'district-1' })).toBe(false);
  });

  it('explains each refusal', async () => {
    const decision = await accounts.authorization.explain(cast.inspector, 'inspections.file', { siteId: 'site-in-zone-4' });
    expect(decision).toEqual({ operation: 'inspections.file', allowed: false, reason: 'outside own zone' });
  });
});

describe('A3 binding an attendant session to a site at clock-in', () => {
  it('binds the session to the assigned site, so a ticket request carries its proven site', async () => {
    expect(await accounts.authorization.bindSessionToSite(cast.attendant, 'site-in-zone-3')).toEqual({ ok: true, value: undefined });
    expect(await accounts.authorization.boundSite(cast.attendant)).toBe('site-in-zone-3');
    await accounts.authorization.unbindSession(cast.attendant);
    expect(await accounts.authorization.boundSite(cast.attendant)).toBeUndefined();
  });

  it('refuses to bind to another site, a non-attendant, or an attendant whose licence is not live', async () => {
    expect(await accounts.authorization.bindSessionToSite(cast.attendant, 'site-in-zone-4')).toEqual({ ok: false, error: 'not assigned to this site' });
    expect(await accounts.authorization.bindSessionToSite(cast.inspector, 'site-in-zone-3')).toEqual({ ok: false, error: 'only an attendant clocks in' });
    await accounts.accessFacts.recordLicenceState(cast.attendant, 'suspended');
    expect(await accounts.authorization.bindSessionToSite(cast.attendant, 'site-in-zone-3')).toEqual({ ok: false, error: 'account or licence not live' });
  });

  it('drops the binding the moment the licence stops being valid or the attendant moves site', async () => {
    await accounts.authorization.bindSessionToSite(cast.attendant, 'site-in-zone-3');
    await accounts.accessFacts.recordLicenceState(cast.attendant, 'suspended');
    expect(await accounts.authorization.boundSite(cast.attendant)).toBeUndefined();
    await accounts.accessFacts.recordLicenceState(cast.attendant, 'valid');
    await accounts.authorization.bindSessionToSite(cast.attendant, 'site-in-zone-3');
    await accounts.accessFacts.recordAttendantSite(cast.attendant, 'site-in-zone-4');
    expect(await accounts.authorization.boundSite(cast.attendant)).toBeUndefined();
  });
});

describe('A3 report', () => {
  it('measures the decision latency over 10,000 decisions', async () => {
    const decisions = 10_000;
    const people = [cast.chair, cast.member, cast.inspector, cast.attendant, cast.driver];
    const started = performance.now();
    for (let index = 0; index < decisions; index += 1) {
      await accounts.authorization.may(people[index % people.length] ?? cast.chair, 'any.operation', { siteId: 'site-in-zone-3' });
    }
    const microsecondsEach = ((performance.now() - started) * 1000) / decisions;
    expect(microsecondsEach).toBeLessThan(1000);
    console.log(`A3 report: decision latency ${microsecondsEach.toFixed(1)} microseconds on average over ${decisions} decisions (in memory); number of rules ${SCOPE_RULE_DESCRIPTIONS.length}`);
  });
});
