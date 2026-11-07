import { beforeEach, describe, expect, it } from 'vitest';
import type { DistrictId, PersonId, SiteId } from '../../../shared/identifiers';
import { createRegistryWorld, createStaff, squareAround, valueOf, type RegistryWorld } from './testing/registry-world';

/** Task A8: change capacity with a reason; keep every past value with its date. */
let world: RegistryWorld;
let districtOne: DistrictId;
let memberOfDistrictOne: PersonId;
let siteId: SiteId;

beforeEach(async () => {
  world = await createRegistryWorld();
  districtOne = valueOf(await world.registry.createDistrict(world.chair, 'Zamalek'));
  memberOfDistrictOne = await createStaff(world, 'member');
  await world.accounts.accessFacts.recordMemberDistrict(memberOfDistrictOne, districtOne);
  const zone = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 1'));
  siteId = valueOf(await world.registry.createSite(world.chair, zone, '26 July Street', squareAround(30.0626, 31.2197), 5));
});

describe('A8 the task sheet cases', () => {
  it('changes 5 to 8 and the history shows both, each with its date', async () => {
    world.clock.advanceByMilliseconds(3 * 24 * 60 * 60 * 1000);
    expect(await world.registry.changeCapacity(memberOfDistrictOne, siteId, 8, 'Two spaces repainted after road works')).toEqual({ ok: true, value: undefined });
    expect(await world.registry.capacityHistory(siteId)).toEqual([
      { capacity: 5, reason: 'capacity when the site was created', changedBy: world.chair, changedAt: '2026-11-05T08:00:00.000Z' },
      { capacity: 8, reason: 'Two spaces repainted after road works', changedBy: memberOfDistrictOne, changedAt: '2026-11-08T08:00:00.000Z' },
    ]);
    expect(await world.registry.capacityOf(siteId)).toBe(8);
  });

  it('refuses a change without a reason', async () => {
    expect(await world.registry.changeCapacity(memberOfDistrictOne, siteId, 8, '')).toEqual({ ok: false, error: 'reason required' });
    expect(await world.registry.changeCapacity(memberOfDistrictOne, siteId, 8, '   ')).toEqual({ ok: false, error: 'reason required' });
    expect(await world.registry.capacityHistory(siteId)).toHaveLength(1);
  });
});

describe('A8 the rest of capacity changes', () => {
  it('refuses a member of another district, an unknown site and an impossible capacity', async () => {
    const memberElsewhere = await createStaff(world, 'member');
    await world.accounts.accessFacts.recordMemberDistrict(memberElsewhere, 'district-elsewhere');
    expect(await world.registry.changeCapacity(memberElsewhere, siteId, 8, 'reason')).toEqual({ ok: false, error: 'not allowed here' });
    expect(await world.registry.changeCapacity(world.chair, 'no-such-site', 8, 'reason')).toEqual({ ok: false, error: 'unknown site' });
    expect(await world.registry.changeCapacity(world.chair, siteId, -1, 'reason')).toEqual({ ok: false, error: 'invalid capacity' });
  });
});

describe('A8 report', () => {
  it('counts the history rows per site after a series of changes', async () => {
    for (const [capacity, reason] of [[8, 'repainted'], [6, 'two spaces lost to a kiosk'], [7, 'kiosk moved']] as const) {
      world.clock.advanceByMilliseconds(60_000);
      valueOf(await world.registry.changeCapacity(world.chair, siteId, capacity, reason));
    }
    const rows = (await world.registry.capacityHistory(siteId)).length;
    expect(rows).toBe(4);
    console.log(`A8 report: history rows per site ${rows} (the first capacity and three changes)`);
  });
});
