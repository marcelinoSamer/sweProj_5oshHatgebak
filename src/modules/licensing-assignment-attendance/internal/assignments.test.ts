import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonId } from '../../../shared/identifiers';
import { createLicensingWorld, createPerson, valueOf, type LicensingWorld } from './testing/licensing-world';

/** Task A12: an attendant at one fixed site and a changeable shift; an inspector to a zone; members by the Chair only. */
let world: LicensingWorld;
let attendant: PersonId;

beforeEach(async () => {
  world = await createLicensingWorld();
  attendant = await createPerson(world, 'attendant');
});

describe('A12 the task sheet cases', () => {
  it('refuses a second site for an attendant: "one site per attendant"', async () => {
    valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOne, 'morning'));
    expect(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOneBis, 'morning')).toEqual({
      ok: false,
      error: 'one site per attendant',
    });
    expect(await world.licensing.assignments.siteOf(attendant)).toBe(world.siteOne);
  });

  it('saves a changed shift', async () => {
    valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOne, 'morning'));
    expect(await world.licensing.assignments.changeShift(world.memberOfDistrictOne, attendant, 'evening')).toEqual({ ok: true, value: undefined });
    expect(await world.licensing.assignments.shiftOf(attendant)).toBe('evening');
    expect(await world.licensing.assignments.siteOf(attendant)).toBe(world.siteOne);
  });

  it('refuses a member creating or appointing a member', async () => {
    const anotherMember = await createPerson(world, 'member');
    expect(await world.licensing.assignments.appointMemberToDistrict(world.memberOfDistrictOne, anotherMember, world.districtOne)).toEqual({
      ok: false,
      error: 'members are managed by the Chair only',
    });
    expect(await world.accounts.personalData.createPerson(world.memberOfDistrictOne, 'member', '01555555555', 'Another Member')).toEqual({
      ok: false,
      error: 'not allowed to create this role',
    });
  });
});

describe('A12 the rest of the assignments', () => {
  it('records the site in access control, so the attendant may act there and nowhere else', async () => {
    valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOne, 'morning'));
    await world.accounts.accessFacts.recordLicenceState(attendant, 'valid');
    expect(await world.accounts.authorization.may(attendant, 'payments.tickCash', { siteId: world.siteOne })).toBe(true);
    expect(await world.accounts.authorization.may(attendant, 'payments.tickCash', { siteId: world.siteOneBis })).toBe(false);
  });

  it('lets the attendant move only after being released from the first site', async () => {
    valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOne, 'morning'));
    valueOf(await world.licensing.assignments.releaseAttendant(world.memberOfDistrictOne, attendant));
    expect(await world.licensing.assignments.siteOf(attendant)).toBeUndefined();
    valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOneBis, 'night'));
    expect(await world.licensing.assignments.siteOf(attendant)).toBe(world.siteOneBis);
  });

  it('refuses a member assigning anyone in another district', async () => {
    const inspector = await createPerson(world, 'inspector');
    expect(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteTwo, 'morning')).toEqual({
      ok: false,
      error: 'not allowed here',
    });
    expect(await world.licensing.assignments.assignInspectorToZone(world.memberOfDistrictOne, inspector, world.zoneTwo)).toEqual({
      ok: false,
      error: 'not allowed here',
    });
  });

  it('assigns an inspector to a zone and records it in access control', async () => {
    const inspector = await createPerson(world, 'inspector');
    valueOf(await world.licensing.assignments.assignInspectorToZone(world.memberOfDistrictOne, inspector, world.zoneOne));
    expect(await world.licensing.assignments.zoneOf(inspector)).toBe(world.zoneOne);
    expect(await world.accounts.authorization.may(inspector, 'inspections.file', { siteId: world.siteOne })).toBe(true);
    expect(await world.accounts.authorization.may(inspector, 'inspections.file', { siteId: world.siteTwo })).toBe(false);
  });

  it('refuses the wrong role, unknown places, an empty shift, and a shift change for someone not assigned', async () => {
    const inspector = await createPerson(world, 'inspector');
    const assignments = world.licensing.assignments;
    expect(await assignments.assignAttendantToSite(world.chair, inspector, world.siteOne, 'morning')).toEqual({ ok: false, error: 'not an attendant' });
    expect(await assignments.assignInspectorToZone(world.chair, attendant, world.zoneOne)).toEqual({ ok: false, error: 'not an inspector' });
    expect(await assignments.appointMemberToDistrict(world.chair, attendant, world.districtOne)).toEqual({ ok: false, error: 'not a member' });
    expect(await assignments.assignAttendantToSite(world.chair, attendant, 'no-such-site', 'morning')).toEqual({ ok: false, error: 'unknown site' });
    expect(await assignments.assignInspectorToZone(world.chair, inspector, 'no-such-zone')).toEqual({ ok: false, error: 'unknown zone' });
    expect(await assignments.appointMemberToDistrict(world.chair, world.memberOfDistrictOne, 'no-such-district')).toEqual({ ok: false, error: 'unknown district' });
    expect(await assignments.assignAttendantToSite(world.chair, attendant, world.siteOne, '  ')).toEqual({ ok: false, error: 'invalid shift' });
    expect(await assignments.changeShift(world.chair, attendant, 'evening')).toEqual({ ok: false, error: 'not assigned' });
  });

  it('lets the Chair move a member to another district, which moves the member\'s scope with it', async () => {
    valueOf(await world.licensing.assignments.appointMemberToDistrict(world.chair, world.memberOfDistrictOne, world.districtTwo));
    expect(await world.accounts.authorization.may(world.memberOfDistrictOne, 'sites.createZone', { districtId: world.districtTwo })).toBe(true);
    expect(await world.accounts.authorization.may(world.memberOfDistrictOne, 'sites.createZone', { districtId: world.districtOne })).toBe(false);
  });
});

describe('A12 report', () => {
  it('counts the assignments made in a full set-up', async () => {
    const inspector = await createPerson(world, 'inspector');
    valueOf(await world.licensing.assignments.assignAttendantToSite(world.memberOfDistrictOne, attendant, world.siteOne, 'morning'));
    valueOf(await world.licensing.assignments.assignInspectorToZone(world.memberOfDistrictOne, inspector, world.zoneOne));
    const count = await world.stores.assignments.count();
    expect(count).toBe(3);
    console.log(`A12 report: assignments in test ${count} (one member appointment, one attendant, one inspector)`);
  });
});
