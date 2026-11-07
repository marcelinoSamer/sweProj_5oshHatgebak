import { beforeEach, describe, expect, it } from 'vitest';
import type { CarRef, PlateReadRequest, SiteLocator } from '../public';
import type { PersonId } from '../../../shared/identifiers';
import { PLATE_READ_OPERATION } from './personal-data-service';
import { createAccountsWorld, type AccountsWorld } from './testing/accounts-world';

/** Task A4: save a car to a driver; show its plate only through a role-checked, logged join. */
const siteLocator: SiteLocator = {
  locateSite: async (siteId) =>
    ({ 'site-a': { zoneId: 'zone-a', districtId: 'district-1' }, 'site-b': { zoneId: 'zone-b', districtId: 'district-1' } })[siteId],
  locateZone: async (zoneId) => ({ 'zone-a': { districtId: 'district-1' }, 'zone-b': { districtId: 'district-1' } })[zoneId],
};

let world: AccountsWorld;
let driver: PersonId;
let attendantOfSiteA: PersonId;
let attendantOfSiteB: PersonId;
let inspectorOfZoneA: PersonId;
let carRef: CarRef;
let platesServed = 0;

async function created(outcome: Promise<{ ok: true; value: PersonId } | { ok: false; error: string }>): Promise<PersonId> {
  const result = await outcome;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

async function plateReadEntries() {
  return (await world.audit.readByScope({ personId: 'anyone', role: 'chair' })).filter((entry) => entry.operation === PLATE_READ_OPERATION);
}

async function read(request: PlateReadRequest) {
  const outcome = await world.accounts.personalData.readPlate(request);
  if (outcome.ok) {
    platesServed += 1;
  }
  return outcome;
}

beforeEach(async () => {
  world = createAccountsWorld(siteLocator);
  const chair = await created(world.accounts.bootstrapChair('01000000000', 'The Chair'));
  driver = await created(world.accounts.personalData.createPerson('self registration', 'driver', '01011111111', 'Mona Adel'));
  attendantOfSiteA = await created(world.accounts.personalData.createPerson(chair, 'attendant', '01022222222', 'Attendant A'));
  attendantOfSiteB = await created(world.accounts.personalData.createPerson(chair, 'attendant', '01033333333', 'Attendant B'));
  inspectorOfZoneA = await created(world.accounts.personalData.createPerson(chair, 'inspector', '01044444444', 'Inspector A'));
  for (const [attendant, siteId] of [[attendantOfSiteA, 'site-a'], [attendantOfSiteB, 'site-b']] as const) {
    await world.accounts.accessFacts.recordAttendantSite(attendant, siteId);
    await world.accounts.accessFacts.recordLicenceState(attendant, 'valid');
  }
  await world.accounts.accessFacts.recordInspectorZone(inspectorOfZoneA, 'zone-a');
  const added = await world.accounts.personalData.addCar(driver, 'abc 123');
  if (!added.ok) {
    throw new Error(added.error);
  }
  carRef = added.value;
});

describe('A4 the task sheet cases', () => {
  it('shows the plate on the driver\'s receipt and writes one "plate read" audit entry', async () => {
    expect(await read({ carRef, reader: driver, purpose: 'receipt', siteId: 'site-a' })).toEqual({ ok: true, value: 'ABC123' });
    const entries = await plateReadEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      personId: driver,
      role: 'driver',
      input: { carRef, purpose: 'receipt', siteId: 'site-a' },
      subjectPersonIds: [driver],
      districtId: 'district-1',
    });
    expect(JSON.stringify(entries)).not.toContain('ABC123');
  });

  it('refuses an attendant of another site and logs nothing', async () => {
    expect(await read({ carRef, reader: attendantOfSiteB, purpose: 'cash list', siteId: 'site-a' })).toEqual({ ok: false, error: 'refused' });
    expect(await plateReadEntries()).toHaveLength(0);
  });
});

describe('A4 the rest of the logged join', () => {
  it('serves the attendant of the site for the cash list and the inspector of the zone for a look-up, each logged', async () => {
    expect((await read({ carRef, reader: attendantOfSiteA, purpose: 'cash list', siteId: 'site-a' })).ok).toBe(true);
    expect((await read({ carRef, reader: inspectorOfZoneA, purpose: 'inspector look-up', siteId: 'site-a' })).ok).toBe(true);
    const readers = (await plateReadEntries()).map((entry) => [entry.personId, entry.role]);
    expect(readers).toEqual([
      [attendantOfSiteA, 'attendant'],
      [inspectorOfZoneA, 'inspector'],
    ]);
  });

  it('refuses a purpose the reader\'s role does not have, and a reader without scope over the site', async () => {
    expect(await read({ carRef, reader: attendantOfSiteA, purpose: 'inspector look-up', siteId: 'site-a' })).toEqual({ ok: false, error: 'refused' });
    expect(await read({ carRef, reader: inspectorOfZoneA, purpose: 'inspector look-up', siteId: 'site-b' })).toEqual({ ok: false, error: 'refused' });
    await world.accounts.accessFacts.recordLicenceState(attendantOfSiteA, 'suspended');
    expect(await read({ carRef, reader: attendantOfSiteA, purpose: 'cash list', siteId: 'site-a' })).toEqual({ ok: false, error: 'refused' });
    expect(await plateReadEntries()).toHaveLength(0);
  });

  it('answers "not resolvable" for an unknown car', async () => {
    expect(await read({ carRef: 'car-unknown', reader: driver, purpose: 'receipt', siteId: 'site-a' })).toEqual({ ok: false, error: 'not resolvable' });
  });

  it('saves a car once per plate, shows a driver their own cars, and refuses a non-driver or a bad plate', async () => {
    expect(await world.accounts.personalData.addCar(driver, 'ABC-123')).toEqual({ ok: true, value: carRef });
    const second = await world.accounts.personalData.addCar(driver, 'xyz 9');
    expect(second.ok).toBe(true);
    expect((await world.accounts.personalData.ownCars(driver)).map((car) => car.plate)).toEqual(['ABC123', 'XYZ9']);
    expect(await world.accounts.personalData.addCar(attendantOfSiteA, 'ABC 123')).toEqual({ ok: false, error: 'not a driver' });
    expect(await world.accounts.personalData.addCar(driver, 'ب ج د ١٢٣')).toEqual({ ok: false, error: 'invalid plate' });
    expect(await world.accounts.personalData.addCar(driver, '')).toEqual({ ok: false, error: 'invalid plate' });
  });

  it('keeps the plate in the personal-data store only', async () => {
    expect(await world.stores.personalData.car(carRef)).toEqual({ carRef, ownerRef: driver, plate: 'ABC123' });
    expect(JSON.stringify(await world.stores.people.find(driver))).not.toContain('ABC123');
  });
});

describe('A4 report', () => {
  it('logs every plate served', async () => {
    platesServed = 0;
    for (let index = 0; index < 10; index += 1) {
      await read({ carRef, reader: driver, purpose: 'receipt', siteId: 'site-a' });
      await read({ carRef, reader: attendantOfSiteA, purpose: 'cash list', siteId: 'site-a' });
      await read({ carRef, reader: attendantOfSiteB, purpose: 'cash list', siteId: 'site-a' });
    }
    const logged = (await plateReadEntries()).length;
    expect(logged).toBe(platesServed);
    console.log(`A4 report: plate reads logged ${logged} / plate reads served ${platesServed} (100 %); 10 refused reads served nothing and logged nothing`);
  });
});
