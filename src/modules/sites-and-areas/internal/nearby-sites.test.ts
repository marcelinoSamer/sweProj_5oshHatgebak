import { beforeEach, describe, expect, it } from 'vitest';
import type { SiteId, ZoneId } from '../../../shared/identifiers';
import { distanceInMeters } from './domain/nearby';
import { createRegistryWorld, squareAround, valueOf, type RegistryWorld } from './testing/registry-world';

/** Task A10: sites within a radius, with price and free-space band (free, few, full, unknown), nearest first. */
const DRIVER = { latitude: 30.0600, longitude: 31.2200 };
const METRES_PER_DEGREE_OF_LATITUDE = 111_195;

let world: RegistryWorld;
let zone: ZoneId;

/** A site whose centre lies the given number of metres due north of the driver. */
async function siteNorthOfDriver(label: string, metres: number, capacity: number): Promise<SiteId> {
  const latitude = DRIVER.latitude + metres / METRES_PER_DEGREE_OF_LATITUDE;
  return valueOf(await world.registry.createSite(world.chair, zone, label, squareAround(latitude, DRIVER.longitude), capacity));
}

beforeEach(async () => {
  world = await createRegistryWorld();
  const district = valueOf(await world.registry.createDistrict(world.chair, 'Zamalek'));
  zone = valueOf(await world.registry.createZone(world.chair, district, 'Zamalek zone 1'));
});

describe('A10 the task sheet case', () => {
  it('seeds 3 sites and answers from a point in the right order with the right bands', async () => {
    const far = await siteNorthOfDriver('Far: full', 2_500, 5);
    const near = await siteNorthOfDriver('Near: plenty of space', 150, 12);
    const middle = await siteNorthOfDriver('Middle: a few spaces', 600, 20);
    world.freeSpaceCounts.set(near, 10).set(middle, 3).set(far, 0);
    world.firstHourFees.set(near, 10).set(middle, 5).set(far, 8);

    const answer = valueOf(await world.registry.nearbySites(DRIVER, 3_000));
    expect(answer.map((site) => [site.label, site.distanceMeters, site.band, site.firstHourFee])).toEqual([
      ['Near: plenty of space', 150, 'free', 10],
      ['Middle: a few spaces', 600, 'few', 5],
      ['Far: full', 2_500, 'full', 8],
    ]);
  });
});

describe('A10 the rest of nearby sites', () => {
  it('leaves out sites beyond the radius', async () => {
    const inside = await siteNorthOfDriver('Inside', 900, 10);
    await siteNorthOfDriver('Outside', 1_100, 10);
    world.freeSpaceCounts.set(inside, 5);
    world.firstHourFees.set(inside, 10);
    expect(valueOf(await world.registry.nearbySites(DRIVER, 1_000)).map((site) => site.siteId)).toEqual([inside]);
  });

  it('shows "unknown" and no fee for a site whose count or price did not answer, instead of failing the map', async () => {
    const unanswered = await siteNorthOfDriver('No answers', 100, 10);
    const [site] = valueOf(await world.registry.nearbySites(DRIVER, 1_000));
    expect(site).toMatchObject({ siteId: unanswered, band: 'unknown', firstHourFee: null });
  });

  it('marks a site closed outside its hours, by the server clock', async () => {
    const siteId = await siteNorthOfDriver('Closed at night', 100, 10);
    world.freeSpaceCounts.set(siteId, 5);
    world.firstHourFees.set(siteId, 10);
    valueOf(await world.registry.setWeeklyHours(world.chair, siteId, [{ weekday: 4, opensMinute: 0, closesMinute: 60 }]));
    expect(valueOf(await world.registry.nearbySites(DRIVER, 1_000))[0]?.open).toBe(false);
  });

  it('puts the band edges where the policy says: "few" at most 2 spaces or a fifth of the capacity', async () => {
    const small = await siteNorthOfDriver('Small', 100, 5);
    const large = await siteNorthOfDriver('Large', 200, 50);
    world.firstHourFees.set(small, 1).set(large, 1);
    const bandsWith = async (smallFree: number, largeFree: number) => {
      world.freeSpaceCounts.set(small, smallFree).set(large, largeFree);
      return valueOf(await world.registry.nearbySites(DRIVER, 1_000)).map((site) => site.band);
    };
    expect(await bandsWith(2, 10)).toEqual(['few', 'few']);
    expect(await bandsWith(3, 11)).toEqual(['free', 'free']);
  });

  it('refuses an impossible point and a radius that is not between 0 and 20 km', async () => {
    expect(await world.registry.nearbySites({ latitude: 91, longitude: 0 }, 1_000)).toEqual({ ok: false, error: 'invalid point' });
    expect(await world.registry.nearbySites(DRIVER, 0)).toEqual({ ok: false, error: 'invalid radius' });
    expect(await world.registry.nearbySites(DRIVER, 20_001)).toEqual({ ok: false, error: 'invalid radius' });
  });

  it('measures distances by the haversine formula', () => {
    const tahrirSquare = { latitude: 30.0444, longitude: 31.2357 };
    const gizaPyramids = { latitude: 29.9792, longitude: 31.1342 };
    expect(Math.round(distanceInMeters(tahrirSquare, gizaPyramids) / 100) / 10).toBeCloseTo(12.6, 0);
  });
});

describe('A10 report', () => {
  it('measures the query time for 1,000 sites', async () => {
    for (let index = 0; index < 1_000; index += 1) {
      const siteId = await siteNorthOfDriver(`Site ${index}`, (index % 100) * 30, 10);
      world.freeSpaceCounts.set(siteId, index % 11);
      world.firstHourFees.set(siteId, 10);
    }
    const started = performance.now();
    const answer = valueOf(await world.registry.nearbySites(DRIVER, 3_000));
    const milliseconds = performance.now() - started;
    expect(answer).toHaveLength(1_000);
    console.log(`A10 report: query time for 1,000 sites ${milliseconds.toFixed(1)} ms (in memory, every site inside the radius)`);
  });
});
