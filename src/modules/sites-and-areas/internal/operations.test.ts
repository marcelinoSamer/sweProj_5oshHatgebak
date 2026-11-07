import { beforeEach, describe, expect, it } from 'vitest';
import { signToken } from '../../../entrypoint/auth/token';
import { composeInMemoryApplication, type InMemoryApplication } from '../../../entrypoint/composition';
import type { HttpRequest } from '../../../entrypoint/http';
import { TEST_TOKEN_SECRET } from '../../../entrypoint/test-helpers';
import type { DistrictId, PersonId, Role } from '../../../shared/identifiers';
import { REQUEST_ID_HEADER } from '../../../shared/request-id';
import { looksLikeTimestampKey } from '../../../shared/timestamp-fields';
import { createSitesOperations } from '../public';
import { parseOutline } from './operations';
import { createRegistryWorld, createStaff, squareAround, valueOf, type RegistryWorld } from './testing/registry-world';

/** The registry's requests through the real entry point: token, role, request id, body, one audit entry per write. */
let world: RegistryWorld;
let application: InMemoryApplication;
let districtOne: DistrictId;
let memberOfDistrictOne: PersonId;

let requestCounter = 0;

function post(path: string, personId: PersonId, role: Role, body: unknown, requestId = `request-${String(++requestCounter).padStart(4, '0')}`): HttpRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: { authorization: `Bearer ${signToken({ personId, role }, TEST_TOKEN_SECRET)}`, [REQUEST_ID_HEADER]: requestId },
    body,
  };
}

beforeEach(async () => {
  world = await createRegistryWorld();
  application = composeInMemoryApplication({ tokenSecret: TEST_TOKEN_SECRET, operations: createSitesOperations(world.registry, world.clock) });
  districtOne = valueOf(await world.registry.createDistrict(world.chair, 'Zamalek'));
  memberOfDistrictOne = await createStaff(world, 'member');
  await world.accounts.accessFacts.recordMemberDistrict(memberOfDistrictOne, districtOne);
});

describe('A6 through the entry point', () => {
  it('creates a zone and a site, each with one audit entry the district member can read', async () => {
    const zone = await application.handle(post('/zones', memberOfDistrictOne, 'member', { districtId: districtOne, label: 'Zamalek zone 1' }));
    expect(zone.status).toBe(201);
    const zoneId = (zone.body as { zoneId: string }).zoneId;
    const site = await application.handle(
      post('/sites', memberOfDistrictOne, 'member', { zoneId, label: '26 July Street', outline: '30.0624,31.2195;30.0624,31.2199;30.0628,31.2199', capacity: 12 }),
    );
    expect(site.status).toBe(201);
    const entries = await application.audit.readByScope({ personId: memberOfDistrictOne, role: 'member', districtId: districtOne });
    expect(entries.map((entry) => entry.operation)).toEqual(['sites.createZone', 'sites.createSite']);
  });

  it('refuses a member writing in another district with 403 and leaves no audit entry', async () => {
    const districtTwo = valueOf(await world.registry.createDistrict(world.chair, 'Dokki'));
    const response = await application.handle(post('/districts/label', memberOfDistrictOne, 'member', { districtId: districtTwo, label: 'Dokki West' }));
    expect(response).toEqual({ status: 403, body: { error: 'not allowed here' } });
    expect(await application.audit.readByScope({ personId: world.chair, role: 'chair' })).toHaveLength(0);
  });

  it('refuses a member creating a district through the permission table, before the module runs', async () => {
    const response = await application.handle(post('/districts', memberOfDistrictOne, 'member', { label: 'Garden City' }));
    expect(response.status).toBe(403);
  });

  it('gives the same answer to the same request id and creates the district once', async () => {
    const first = await application.handle(post('/districts', world.chair, 'chair', { label: 'Garden City' }, 'request-same-0001'));
    const second = await application.handle(post('/districts', world.chair, 'chair', { label: 'Garden City' }, 'request-same-0001'));
    expect(second).toEqual(first);
    expect(await application.audit.readByScope({ personId: world.chair, role: 'chair' })).toHaveLength(1);
  });

  it('reads the outline text format and refuses anything else', () => {
    expect(parseOutline('30.1,31.2;30.2,31.3;30.3,31.4')).toEqual({
      ok: true,
      value: [
        { latitude: 30.1, longitude: 31.2 },
        { latitude: 30.2, longitude: 31.3 },
        { latitude: 30.3, longitude: 31.4 },
      ],
    });
    expect(parseOutline('30.1;31.2')).toEqual({ ok: false, error: 'invalid outline' });
    expect(parseOutline('north,south')).toEqual({ ok: false, error: 'invalid outline' });
  });

  it('declares no timestamp field in any write body (fitness function F11 for this module)', () => {
    const fields = application.registry.writes().flatMap((operation) => Object.keys(operation.bodySchema.fields));
    expect(fields.filter(looksLikeTimestampKey)).toEqual([]);
  });

  it('changes capacity with the reason in the audit entry, and refuses a change without one', async () => {
    const zoneId = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 1'));
    const siteId = valueOf(await world.registry.createSite(world.chair, zoneId, '26 July Street', squareAround(30.0626, 31.2197), 5));
    const withoutReason = await application.handle(post('/sites/capacity', memberOfDistrictOne, 'member', { siteId, capacity: 8, reason: ' ' }));
    expect(withoutReason).toEqual({ status: 400, body: { error: 'reason required' } });
    const changed = await application.handle(post('/sites/capacity', memberOfDistrictOne, 'member', { siteId, capacity: 8, reason: 'Two spaces repainted' }));
    expect(changed).toEqual({ status: 200, body: { siteId, capacity: 8 } });
    const entries = await application.audit.readByScope({ personId: memberOfDistrictOne, role: 'member', districtId: districtOne });
    expect(entries.map((entry) => [entry.operation, entry.reason])).toEqual([['sites.changeCapacity', 'Two spaces repainted']]);
  });

  it('answers the driver\'s map request, and refuses a missing point', async () => {
    const zoneId = valueOf(await world.registry.createZone(world.chair, districtOne, 'Zamalek zone 1'));
    const siteId = valueOf(await world.registry.createSite(world.chair, zoneId, '26 July Street', squareAround(30.0626, 31.2197), 5));
    world.freeSpaceCounts.set(siteId, 4);
    world.firstHourFees.set(siteId, 10);
    const token = signToken({ personId: 'any-driver', role: 'driver' }, TEST_TOKEN_SECRET);
    const map = await application.handle({
      method: 'GET',
      path: '/sites/nearby',
      query: { latitude: '30.0626', longitude: '31.2197', radius: '500' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(map.status).toBe(200);
    expect((map.body as { sites: { siteId: string; band: string }[] }).sites).toMatchObject([{ siteId, band: 'free', firstHourFee: 10 }]);
    const missingPoint = await application.handle({ method: 'GET', path: '/sites/nearby', query: { radius: '500' }, headers: { authorization: `Bearer ${token}` } });
    expect(missingPoint).toEqual({ status: 400, body: { error: 'invalid point' } });
  });
});
