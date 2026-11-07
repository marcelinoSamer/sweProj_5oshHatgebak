import { beforeEach, describe, expect, it } from 'vitest';
import { signToken } from '../../../entrypoint/auth/token';
import { composeInMemoryApplication, type InMemoryApplication } from '../../../entrypoint/composition';
import type { HttpRequest } from '../../../entrypoint/http';
import { TEST_TOKEN_SECRET } from '../../../entrypoint/test-helpers';
import type { PersonId, Role } from '../../../shared/identifiers';
import { REQUEST_ID_HEADER } from '../../../shared/request-id';
import { createLicensingOperations } from '../public';
import { createLicensingWorld, createPerson, type LicensingWorld } from './testing/licensing-world';

/** The assignment requests through the real entry point: one audit entry per success, naming the person concerned. */
let world: LicensingWorld;
let application: InMemoryApplication;
let requestCounter = 0;

function post(path: string, personId: PersonId, role: Role, body: unknown): HttpRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: {
      authorization: `Bearer ${signToken({ personId, role }, TEST_TOKEN_SECRET)}`,
      [REQUEST_ID_HEADER]: `request-${String(++requestCounter).padStart(4, '0')}`,
    },
    body,
  };
}

beforeEach(async () => {
  world = await createLicensingWorld();
  application = composeInMemoryApplication({ tokenSecret: TEST_TOKEN_SECRET, operations: createLicensingOperations(world.licensing, world.registry) });
});

describe('A12 through the entry point', () => {
  it('assigns an attendant with one audit entry the attendant and the district member can both read', async () => {
    const attendant = await createPerson(world, 'attendant');
    const response = await application.handle(
      post('/assignments/attendants', world.memberOfDistrictOne, 'member', { attendantId: attendant, siteId: world.siteOne, shiftId: 'morning' }),
    );
    expect(response.status).toBe(200);
    const asAttendant = await application.audit.readByScope({ personId: attendant, role: 'attendant' });
    const asMember = await application.audit.readByScope({ personId: world.memberOfDistrictOne, role: 'member', districtId: world.districtOne });
    expect(asAttendant.map((entry) => entry.operation)).toEqual(['assignments.assignAttendant']);
    expect(asMember).toEqual(asAttendant);
  });

  it('answers a second site with 409 "one site per attendant" and no audit entry', async () => {
    const attendant = await createPerson(world, 'attendant');
    await application.handle(post('/assignments/attendants', world.chair, 'chair', { attendantId: attendant, siteId: world.siteOne, shiftId: 'morning' }));
    const second = await application.handle(post('/assignments/attendants', world.chair, 'chair', { attendantId: attendant, siteId: world.siteTwo, shiftId: 'morning' }));
    expect(second).toEqual({ status: 409, body: { error: 'one site per attendant' } });
    expect(await application.audit.readByScope({ personId: world.chair, role: 'chair' })).toHaveLength(1);
  });

  it('keeps member appointments to the Chair in the permission table itself', async () => {
    const member = await createPerson(world, 'member');
    const response = await application.handle(post('/assignments/members', world.memberOfDistrictOne, 'member', { memberId: member, districtId: world.districtOne }));
    expect(response.status).toBe(403);
  });

  it('issues a licence with one audit entry the attendant can read, and refuses a second one', async () => {
    const attendant = await createPerson(world, 'attendant');
    const first = await application.handle(post('/licences', world.chair, 'chair', { attendantId: attendant }));
    expect(first.status).toBe(201);
    const second = await application.handle(post('/licences', world.chair, 'chair', { attendantId: attendant }));
    expect(second).toEqual({ status: 409, body: { error: 'already licensed' } });
    const asAttendant = await application.audit.readByScope({ personId: attendant, role: 'attendant' });
    expect(asAttendant.map((entry) => entry.operation)).toEqual(['licences.issue']);
  });

  it('clocks an attendant in and out by scanning their site\'s code, each with one audit entry', async () => {
    const attendant = await createPerson(world, 'attendant');
    await world.licensing.assignments.assignAttendantToSite(world.chair, attendant, world.siteOne, 'morning');
    await world.licensing.licences.issueLicence(world.chair, attendant);
    const { entryCode } = await world.registry.issueEntryAndExitCodes(world.siteOne);
    const wrongSite = await application.handle(post('/attendance/clock-in', attendant, 'attendant', { siteCode: (await world.registry.issueEntryAndExitCodes(world.siteTwo)).entryCode }));
    expect(wrongSite).toEqual({ status: 403, body: { error: 'wrong site' } });
    expect((await application.handle(post('/attendance/clock-in', attendant, 'attendant', { siteCode: entryCode }))).status).toBe(200);
    expect((await application.handle(post('/attendance/clock-out', attendant, 'attendant', {}))).status).toBe(200);
    const entries = await application.audit.readByScope({ personId: attendant, role: 'attendant' });
    expect(entries.map((entry) => entry.operation)).toEqual(['attendance.clockIn', 'attendance.clockOut']);
  });
});
