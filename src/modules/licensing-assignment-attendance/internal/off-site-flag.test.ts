import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonId } from '../../../shared/identifiers';
import { OFF_SITE_POLICY } from '../public';
import { createLicensingWorld, createPerson, valueOf, type LicensingWorld } from './testing/licensing-world';

/** Task A14: raise a flag for the inspector when repeated location points during a shift are far from the site. */
const SITE_ONE_CENTRE = { latitude: 30.0626, longitude: 31.2197 };
const METRES_PER_DEGREE_OF_LATITUDE = 111_195;

let world: LicensingWorld;
let attendant: PersonId;
let inspectorOfZoneOne: PersonId;
let flagsRaised = 0;
let falseFlags = 0;

function metresNorthOfSite(metres: number) {
  return { latitude: SITE_ONE_CENTRE.latitude + metres / METRES_PER_DEGREE_OF_LATITUDE, longitude: SITE_ONE_CENTRE.longitude };
}

async function report(metres: number, expectedToBeAway: boolean) {
  world.clock.advanceByMilliseconds(5 * 60_000);
  const outcome = valueOf(await world.licensing.attendance.recordLocationPoint(attendant, metresNorthOfSite(metres)));
  if (outcome.flagRaised) {
    flagsRaised += 1;
    if (!expectedToBeAway) {
      falseFlags += 1;
    }
  }
  return outcome.flagRaised;
}

async function flagsInZoneOne() {
  return valueOf(await world.licensing.attendance.offSiteFlags(inspectorOfZoneOne, world.zoneOne));
}

beforeEach(async () => {
  world = await createLicensingWorld();
  attendant = await createPerson(world, 'attendant');
  inspectorOfZoneOne = await createPerson(world, 'inspector');
  valueOf(await world.licensing.assignments.assignAttendantToSite(world.chair, attendant, world.siteOne, 'morning'));
  valueOf(await world.licensing.assignments.assignInspectorToZone(world.chair, inspectorOfZoneOne, world.zoneOne));
  valueOf(await world.licensing.licences.issueLicence(world.chair, attendant));
  valueOf(await world.licensing.attendance.clockIn(attendant, (await world.registry.issueEntryAndExitCodes(world.siteOne)).entryCode));
});

describe('A14 the task sheet cases', () => {
  it('raises one flag for 5 points 600 m away', async () => {
    const raised = [];
    for (let point = 0; point < 5; point += 1) {
      raised.push(await report(600, true));
    }
    expect(raised).toEqual([false, false, true, false, false]);
    expect(await flagsInZoneOne()).toEqual([
      { flagId: expect.any(String), attendantId: attendant, siteId: world.siteOne, raisedAt: '2026-11-05T08:15:00.000Z' },
    ]);
  });

  it('raises no flag for 1 point 600 m away', async () => {
    expect(await report(600, true)).toBe(false);
    expect(await flagsInZoneOne()).toEqual([]);
  });
});

describe('A14 the rest of the off-site rule', () => {
  it('raises no flag for an attendant at the site, or for far readings broken by one at the site', async () => {
    for (let point = 0; point < 10; point += 1) {
      await report(20, false);
    }
    for (const metres of [600, 600, 20, 600, 600, 20]) {
      await report(metres, false);
    }
    expect(await flagsInZoneOne()).toEqual([]);
  });

  it('keeps only the distance of each reading, never the coordinates', async () => {
    await report(600, true);
    const shift = (await world.stores.attendance.all())[0];
    const readings = await world.stores.offSite.readingsOf(shift?.attendanceId ?? '');
    expect(readings).toEqual([{ attendanceId: shift?.attendanceId, distanceMeters: 600, recordedAt: '2026-11-05T08:05:00.000Z' }]);
  });

  it('refuses a reading outside a shift, and the flag list to an inspector of another zone', async () => {
    valueOf(await world.licensing.attendance.clockOut(attendant));
    expect(await world.licensing.attendance.recordLocationPoint(attendant, metresNorthOfSite(600))).toEqual({ ok: false, error: 'not clocked in' });
    const inspectorOfZoneTwo = await createPerson(world, 'inspector');
    valueOf(await world.licensing.assignments.assignInspectorToZone(world.chair, inspectorOfZoneTwo, world.zoneTwo));
    expect(await world.licensing.attendance.offSiteFlags(inspectorOfZoneTwo, world.zoneOne)).toEqual({ ok: false, error: 'not allowed here' });
  });

  it('starts counting afresh in a new shift', async () => {
    await report(600, true);
    await report(600, true);
    valueOf(await world.licensing.attendance.clockOut(attendant));
    valueOf(await world.licensing.attendance.clockIn(attendant, (await world.registry.issueEntryAndExitCodes(world.siteOne)).entryCode));
    expect(await report(600, true)).toBe(false);
    expect(await flagsInZoneOne()).toEqual([]);
  });
});

describe('A14 report', () => {
  it('prints the flags raised and the false flags', () => {
    expect(falseFlags).toBe(0);
    console.log(
      `A14 report: flags raised ${flagsRaised}; false flags in test ${falseFlags} ` +
        `(rule: ${OFF_SITE_POLICY.consecutivePoints} readings in a row more than ${OFF_SITE_POLICY.distanceMeters} m from the site)`,
    );
  });
});
