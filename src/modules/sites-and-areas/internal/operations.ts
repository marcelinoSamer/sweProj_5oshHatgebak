import { refuse, respond } from '../../../entrypoint/http';
import type { Operation, ReadOperation, WriteOperation, WriteOutcome } from '../../../entrypoint/operations/operation';
import type { DistrictId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { GeoPoint, PlaceRefusal, SiteRegistry } from '../public';

/**
 * The requests this module answers, for the composition root to register. The entry point checks the token, the
 * role, the request id and the body before a handler runs, and writes the one audit entry after it succeeds; the
 * handler adds the district so that members of that district can read the entry (ADR-10).
 *
 * The request-body schema has no list type yet, so an outline travels as text: "latitude,longitude" pairs separated
 * by semicolons, for example "30.0624,31.2195;30.0624,31.2199;30.0628,31.2199".
 */
export function createSitesOperations(registry: SiteRegistry): readonly Operation[] {
  return [
    createDistrict(registry),
    relabelDistrict(registry),
    createZone(registry),
    relabelZone(registry),
    createSite(registry),
    replaceSiteOutline(registry),
    readSiteDetails(registry),
  ];
}

const EXAMPLE_OUTLINE = '30.0624,31.2195;30.0624,31.2199;30.0628,31.2199;30.0628,31.2195';

function createDistrict(registry: SiteRegistry): WriteOperation {
  return {
    kind: 'write',
    name: 'sites.createDistrict',
    method: 'POST',
    path: '/districts',
    allowedRoles: ['chair'],
    bodySchema: { fields: { label: 'string' } },
    examples: { valid: { label: 'Zamalek' }, invalid: { label: 7 } },
    async handle({ actor, body }) {
      const created = await registry.createDistrict(actor.personId, String(body['label']));
      return created.ok ? written(201, { districtId: created.value }, created.value) : refused(created.error);
    },
  };
}

function relabelDistrict(registry: SiteRegistry): WriteOperation {
  return {
    kind: 'write',
    name: 'sites.relabelDistrict',
    method: 'POST',
    path: '/districts/label',
    allowedRoles: ['member', 'chair'],
    bodySchema: { fields: { districtId: 'string', label: 'string' } },
    examples: { valid: { districtId: 'district-1', label: 'Zamalek North' }, invalid: {} },
    async handle({ actor, body }) {
      const districtId = String(body['districtId']);
      const relabelled = await registry.relabelDistrict(actor.personId, districtId, String(body['label']));
      return relabelled.ok ? written(200, { districtId }, districtId) : refused(relabelled.error);
    },
  };
}

function createZone(registry: SiteRegistry): WriteOperation {
  return {
    kind: 'write',
    name: 'sites.createZone',
    method: 'POST',
    path: '/zones',
    allowedRoles: ['member', 'chair'],
    bodySchema: { fields: { districtId: 'string', label: 'string' } },
    examples: { valid: { districtId: 'district-1', label: 'Zamalek zone 1' }, invalid: {} },
    async handle({ actor, body }) {
      const districtId = String(body['districtId']);
      const created = await registry.createZone(actor.personId, districtId, String(body['label']));
      return created.ok ? written(201, { zoneId: created.value }, districtId) : refused(created.error);
    },
  };
}

function relabelZone(registry: SiteRegistry): WriteOperation {
  return {
    kind: 'write',
    name: 'sites.relabelZone',
    method: 'POST',
    path: '/zones/label',
    allowedRoles: ['member', 'chair'],
    bodySchema: { fields: { zoneId: 'string', label: 'string' } },
    examples: { valid: { zoneId: 'zone-1', label: 'Zamalek zone 1 north' }, invalid: {} },
    async handle({ actor, body }) {
      const zoneId = String(body['zoneId']);
      const relabelled = await registry.relabelZone(actor.personId, zoneId, String(body['label']));
      if (!relabelled.ok) {
        return refused(relabelled.error);
      }
      return written(200, { zoneId }, (await registry.locateZone(zoneId))?.districtId);
    },
  };
}

function createSite(registry: SiteRegistry): WriteOperation {
  return {
    kind: 'write',
    name: 'sites.createSite',
    method: 'POST',
    path: '/sites',
    allowedRoles: ['member', 'chair'],
    bodySchema: { fields: { zoneId: 'string', label: 'string', outline: 'string', capacity: 'number' } },
    examples: {
      valid: { zoneId: 'zone-1', label: '26 July Street', outline: EXAMPLE_OUTLINE, capacity: 12 },
      invalid: { zoneId: 'zone-1', label: '26 July Street', outline: EXAMPLE_OUTLINE, capacity: 'twelve' },
    },
    async handle({ actor, body }) {
      const outline = parseOutline(String(body['outline']));
      if (!outline.ok) {
        return refused(outline.error);
      }
      const zoneId = String(body['zoneId']);
      const created = await registry.createSite(actor.personId, zoneId, String(body['label']), outline.value, Number(body['capacity']));
      if (!created.ok) {
        return refused(created.error);
      }
      return written(201, { siteId: created.value }, (await registry.locateZone(zoneId))?.districtId);
    },
  };
}

function replaceSiteOutline(registry: SiteRegistry): WriteOperation {
  return {
    kind: 'write',
    name: 'sites.replaceOutline',
    method: 'POST',
    path: '/sites/outline',
    allowedRoles: ['member', 'chair'],
    bodySchema: { fields: { siteId: 'string', outline: 'string' } },
    examples: { valid: { siteId: 'site-1', outline: EXAMPLE_OUTLINE }, invalid: { siteId: 'site-1' } },
    async handle({ actor, body }) {
      const outline = parseOutline(String(body['outline']));
      if (!outline.ok) {
        return refused(outline.error);
      }
      const siteId = String(body['siteId']);
      const replaced = await registry.replaceSiteOutline(actor.personId, siteId, outline.value);
      return replaced.ok ? written(200, { siteId }, (await registry.locateSite(siteId))?.districtId) : refused(replaced.error);
    },
  };
}

function readSiteDetails(registry: SiteRegistry): ReadOperation {
  return {
    kind: 'read',
    name: 'sites.details',
    method: 'GET',
    path: '/sites/details',
    allowedRoles: ['driver', 'attendant', 'inspector', 'member', 'chair'],
    async handle({ query }) {
      const details = await registry.siteDetails(query['siteId'] ?? '');
      return details === undefined ? refuse(404, 'unknown site') : respond(200, details);
    },
  };
}

/** "latitude,longitude;latitude,longitude;…" into points; anything else is an invalid outline. */
export function parseOutline(text: string): Result<readonly GeoPoint[], 'invalid outline'> {
  const points = text.split(';').map((pair) => pair.split(',').map((part) => Number(part.trim())));
  const wellFormed = points.every((pair) => pair.length === 2 && pair.every((number) => Number.isFinite(number)));
  return wellFormed ? succeed(points.map(([latitude = 0, longitude = 0]) => ({ latitude, longitude }))) : fail('invalid outline');
}

function written(status: number, body: unknown, districtId: DistrictId | undefined): WriteOutcome {
  return { response: respond(status, body), audit: districtId === undefined ? {} : { districtId } };
}

const REFUSAL_STATUS: Readonly<Record<PlaceRefusal, number>> = {
  'not allowed here': 403,
  'unknown district': 404,
  'unknown zone': 404,
  'unknown site': 404,
  'invalid label': 400,
  'invalid outline': 400,
  'invalid capacity': 400,
};

function refused(refusal: PlaceRefusal): WriteOutcome {
  return { response: refuse(REFUSAL_STATUS[refusal], refusal) };
}
