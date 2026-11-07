import { beforeEach, describe, expect, it } from 'vitest';
import type { DistrictId, PersonId, SiteId } from '../../../shared/identifiers';
import { parseWeeklyHours } from './domain/site-calendar';
import { createRegistryWorld, createStaff, squareAround, valueOf, type RegistryWorld } from './testing/registry-world';

/**
 * Task A9: whether a site is open at a given moment, including declared closures and free periods. Cairo is two hours
 * ahead of universal time in November and three in July (daylight saving), so 10:00Z on 20 November is 12:00 in Cairo.
 */
let world: RegistryWorld;
let districtOne: DistrictId;
let memberOfDistrictOne: PersonId;
let siteId: SiteId;

const local = (year: number, month: number, day: number, hour: number, minute = 0) => ({ year, month, day, hour, minute });

beforeEach(async () => {
  world = await createRegistryWorld();
  districtOne = valueOf(await world.registry.createDistrict(world.chair, 'Zamalek'));
  memberOfDistrictOne = await createStaff(world, 'member');
  await world.accounts.accessFacts.recordMemberDistrict(memberOfDistrictOne, districtOne);
  const zone = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 1'));
  siteId = valueOf(await world.registry.createSite(world.chair, zone, '26 July Street', squareAround(30.0626, 31.2197), 12));
  valueOf(await world.registry.setWeeklyHours(memberOfDistrictOne, siteId, valueOf(parseWeeklyHours('daily 08:00-23:00'))));
});

describe('A9 the task sheet case', () => {
  it('answers closed during a declared closure and free during a declared free period, as declared', async () => {
    valueOf(await world.registry.declareSpecialEvent(memberOfDistrictOne, siteId, 'closure', local(2026, 11, 20, 18), local(2026, 11, 20, 23), 'Football match at the stadium'));
    valueOf(await world.registry.declareSpecialEvent(memberOfDistrictOne, siteId, 'free period', local(2026, 11, 21, 10), local(2026, 11, 21, 14), 'National day'));

    expect(await world.registry.statusAt(siteId, new Date('2026-11-20T17:00:00Z'))).toEqual({
      open: false,
      free: false,
      reason: 'closed: Football match at the stadium',
    });
    expect(await world.registry.isOpenAt(siteId, new Date('2026-11-20T17:00:00Z'))).toBe(false);
    expect(await world.registry.statusAt(siteId, new Date('2026-11-21T09:00:00Z'))).toEqual({ open: true, free: true, reason: 'free: National day' });
  });
});

describe('A9 the rest of the hours', () => {
  it('follows the weekly hours in Cairo time, before and after a closure', async () => {
    expect(await world.registry.isOpenAt(siteId, new Date('2026-11-20T10:00:00Z'))).toBe(true);
    expect(await world.registry.statusAt(siteId, new Date('2026-11-20T22:30:00Z'))).toEqual({ open: false, free: false, reason: 'outside opening hours' });
    valueOf(await world.registry.declareSpecialEvent(memberOfDistrictOne, siteId, 'closure', local(2026, 11, 20, 18), local(2026, 11, 20, 23), 'match'));
    expect(await world.registry.isOpenAt(siteId, new Date('2026-11-20T15:59:00Z'))).toBe(true);
    expect(await world.registry.isOpenAt(siteId, new Date('2026-11-20T16:00:00Z'))).toBe(false);
  });

  it('follows Cairo daylight saving time in summer', async () => {
    expect(await world.registry.isOpenAt(siteId, new Date('2026-07-01T05:30:00Z'))).toBe(true);
    expect(await world.registry.isOpenAt(siteId, new Date('2026-07-01T04:30:00Z'))).toBe(false);
  });

  it('never makes a site free outside its opening hours', async () => {
    valueOf(await world.registry.declareSpecialEvent(memberOfDistrictOne, siteId, 'free period', local(2026, 11, 21, 0), local(2026, 11, 22, 0), 'National day'));
    expect(await world.registry.statusAt(siteId, new Date('2026-11-21T03:00:00Z'))).toEqual({ open: false, free: false, reason: 'outside opening hours' });
  });

  it('keeps a site with no declared hours open around the clock, and an unknown site closed', async () => {
    const zone = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 2'));
    const allHours = valueOf(await world.registry.createSite(world.chair, zone, 'Brazil Street', squareAround(30.065, 31.221), 8));
    expect(await world.registry.isOpenAt(allHours, new Date('2026-11-20T01:00:00Z'))).toBe(true);
    expect(await world.registry.isOpenAt('no-such-site', new Date('2026-11-20T10:00:00Z'))).toBe(false);
    expect(await world.registry.statusAt('no-such-site', new Date('2026-11-20T10:00:00Z'))).toBeUndefined();
  });

  it('refuses a period that ends before it starts or names a day that does not exist, an empty reason and another district', async () => {
    const declare = world.registry.declareSpecialEvent.bind(world.registry);
    expect(await declare(memberOfDistrictOne, siteId, 'closure', local(2026, 11, 20, 23), local(2026, 11, 20, 18), 'match')).toEqual({ ok: false, error: 'invalid period' });
    expect(await declare(memberOfDistrictOne, siteId, 'closure', local(2026, 11, 31, 18), local(2026, 12, 1, 0), 'match')).toEqual({ ok: false, error: 'invalid period' });
    expect(await declare(memberOfDistrictOne, siteId, 'closure', local(2026, 11, 20, 18), local(2026, 11, 20, 23), ' ')).toEqual({ ok: false, error: 'reason required' });
    const memberElsewhere = await createStaff(world, 'member');
    await world.accounts.accessFacts.recordMemberDistrict(memberElsewhere, 'district-elsewhere');
    expect(await declare(memberElsewhere, siteId, 'closure', local(2026, 11, 20, 18), local(2026, 11, 20, 23), 'match')).toEqual({ ok: false, error: 'not allowed here' });
    expect(await world.registry.setWeeklyHours(memberElsewhere, siteId, [])).toEqual({ ok: false, error: 'not allowed here' });
  });

  it('reads weekly hours written as text, including a span that wraps past Saturday', () => {
    const hours = valueOf(parseWeeklyHours('sun-thu 08:00-22:00; fri 13:00-24:00'));
    expect(hours).toHaveLength(6);
    expect(hours.find((period) => period.weekday === 5)).toEqual({ weekday: 5, opensMinute: 780, closesMinute: 1440 });
    expect(valueOf(parseWeeklyHours('fri-sun 10:00-12:00')).map((period) => period.weekday)).toEqual([5, 6, 0]);
    for (const nonsense of ['', 'daily 23:00-08:00', 'someday 08:00-22:00', 'daily 8-22', 'daily 08:00-25:00']) {
      expect(parseWeeklyHours(nonsense)).toEqual({ ok: false, error: 'invalid hours' });
    }
  });
});

describe('A9 report', () => {
  it('measures checks per second', async () => {
    valueOf(await world.registry.declareSpecialEvent(memberOfDistrictOne, siteId, 'closure', local(2026, 11, 20, 18), local(2026, 11, 20, 23), 'match'));
    const checks = 20_000;
    const started = performance.now();
    for (let index = 0; index < checks; index += 1) {
      await world.registry.isOpenAt(siteId, new Date(Date.UTC(2026, 10, 20, index % 24)));
    }
    const perSecond = Math.round(checks / ((performance.now() - started) / 1000));
    expect(perSecond).toBeGreaterThan(1000);
    console.log(`A9 report: ${perSecond} checks per second (in memory, one site with weekly hours and one closure)`);
  });
});
