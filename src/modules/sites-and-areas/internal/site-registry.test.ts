import { beforeEach, describe, expect, it } from 'vitest';
import type { DistrictId, PersonId } from '../../../shared/identifiers';
import { createRegistryWorld, createStaff, squareAround, valueOf, type RegistryWorld } from './testing/registry-world';

/** Task A6: districts, zones and sites; only a member of that district, or the Chair, creates and edits them. */
let world: RegistryWorld;
let districtOne: DistrictId;
let districtTwo: DistrictId;
let memberOfDistrictOne: PersonId;
let sitesCreated = 0;
let refusals = 0;

function countRefusal<Outcome extends { ok: boolean }>(outcome: Outcome): Outcome {
  if (!outcome.ok) {
    refusals += 1;
  }
  return outcome;
}

beforeEach(async () => {
  world = await createRegistryWorld();
  districtOne = valueOf(await world.registry.createDistrict(world.chair, 'Zamalek'));
  districtTwo = valueOf(await world.registry.createDistrict(world.chair, 'Dokki'));
  memberOfDistrictOne = await createStaff(world, 'member');
  await world.accounts.accessFacts.recordMemberDistrict(memberOfDistrictOne, districtOne);
});

describe('A6 the task sheet case', () => {
  it('refuses a member of district 1 editing district 2, and saves the edit in their own district', async () => {
    expect(countRefusal(await world.registry.relabelDistrict(memberOfDistrictOne, districtTwo, 'Dokki West'))).toEqual({
      ok: false,
      error: 'not allowed here',
    });
    expect(await world.registry.relabelDistrict(memberOfDistrictOne, districtOne, 'Zamalek North')).toEqual({ ok: true, value: undefined });
    expect((await world.sitesStores.places.district(districtOne))?.label).toBe('Zamalek North');
    expect((await world.sitesStores.places.district(districtTwo))?.label).toBe('Dokki');
  });
});

describe('A6 districts, zones and sites', () => {
  it('lets only the Chair create a district', async () => {
    expect(countRefusal(await world.registry.createDistrict(memberOfDistrictOne, 'Garden City'))).toEqual({ ok: false, error: 'not allowed here' });
    expect((await world.registry.createDistrict(world.chair, 'Garden City')).ok).toBe(true);
  });

  it('lets a member create zones and sites in their own district only', async () => {
    const zoneOne = valueOf(await world.registry.createZone(memberOfDistrictOne, districtOne, 'Zamalek zone 1'));
    expect(countRefusal(await world.registry.createZone(memberOfDistrictOne, districtTwo, 'Dokki zone 1'))).toEqual({ ok: false, error: 'not allowed here' });
    const zoneTwo = valueOf(await world.registry.createZone(world.chair, districtTwo, 'Dokki zone 1'));

    const site = await world.registry.createSite(memberOfDistrictOne, zoneOne, '26 July Street', squareAround(30.0626, 31.2197), 12);
    expect(site.ok).toBe(true);
    sitesCreated += 1;
    expect(countRefusal(await world.registry.createSite(memberOfDistrictOne, zoneTwo, 'Tahrir Street', squareAround(30.0385, 31.2118), 8))).toEqual({
      ok: false,
      error: 'not allowed here',
    });
  });

  it('records where a site sits, its outline and its first capacity at the server time', async () => {
    const zone = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 1'));
    const outline = squareAround(30.0626, 31.2197);
    const siteId = valueOf(await world.registry.createSite(world.chair, zone, '26 July Street', outline, 12));
    sitesCreated += 1;
    expect(await world.registry.siteDetails(siteId)).toEqual({ siteId, zoneId: zone, districtId: districtOne, label: '26 July Street', outline, capacity: 12 });
    expect(await world.registry.locateSite(siteId)).toEqual({ zoneId: zone, districtId: districtOne });
    expect(await world.sitesStores.capacity.historyOf(siteId)).toEqual([
      { siteId, capacity: 12, reason: 'capacity when the site was created', changedBy: world.chair, changedAt: '2026-11-05T08:00:00.000Z' },
    ]);
  });

  it('lets a member of the district replace a site outline, and refuses a member of another district', async () => {
    const zone = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 1'));
    const siteId = valueOf(await world.registry.createSite(world.chair, zone, '26 July Street', squareAround(30.0626, 31.2197), 12));
    sitesCreated += 1;
    const memberOfDistrictTwo = await createStaff(world, 'member');
    await world.accounts.accessFacts.recordMemberDistrict(memberOfDistrictTwo, districtTwo);
    const newOutline = squareAround(30.063, 31.22);
    expect(countRefusal(await world.registry.replaceSiteOutline(memberOfDistrictTwo, siteId, newOutline))).toEqual({ ok: false, error: 'not allowed here' });
    expect((await world.registry.replaceSiteOutline(memberOfDistrictOne, siteId, newOutline)).ok).toBe(true);
    expect((await world.registry.siteDetails(siteId))?.outline).toEqual(newOutline);
  });

  it('refuses unknown places, an empty label, an outline of fewer than three real points and a capacity that is not a positive whole number', async () => {
    const zone = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 1'));
    const outline = squareAround(30.0626, 31.2197);
    const cases = [
      [await world.registry.createZone(world.chair, 'no-such-district', 'Zone'), 'unknown district'],
      [await world.registry.createSite(world.chair, 'no-such-zone', 'Site', outline, 5), 'unknown zone'],
      [await world.registry.replaceSiteOutline(world.chair, 'no-such-site', outline), 'unknown site'],
      [await world.registry.createDistrict(world.chair, '   '), 'invalid label'],
      [await world.registry.createSite(world.chair, zone, 'Site', outline.slice(0, 2), 5), 'invalid outline'],
      [await world.registry.createSite(world.chair, zone, 'Site', [{ latitude: 91, longitude: 0 }, ...outline], 5), 'invalid outline'],
      [await world.registry.createSite(world.chair, zone, 'Site', outline, 0), 'invalid capacity'],
      [await world.registry.createSite(world.chair, zone, 'Site', outline, 2.5), 'invalid capacity'],
    ] as const;
    for (const [outcome, expectedError] of cases) {
      expect(countRefusal(outcome)).toEqual({ ok: false, error: expectedError });
    }
  });

  it('refuses issuing codes for a site that does not exist', async () => {
    await expect(world.registry.issueEntryAndExitCodes('no-such-site')).rejects.toThrow(/unknown site/);
  });
});

describe('A6 report', () => {
  it('prints the numbers for the pull request', () => {
    expect(sitesCreated).toBeGreaterThan(0);
    console.log(`A6 report: sites created in test ${sitesCreated}; refusal count ${refusals}`);
  });
});
