import { refuse, respond } from '../../../entrypoint/http';
import type { Operation, WriteContext, WriteOperation, WriteOutcome } from '../../../entrypoint/operations/operation';
import type { BodySchema, ValidBody } from '../../../entrypoint/operations/body-schema';
import type { DistrictId, PersonId, Role } from '../../../shared/identifiers';
import type { Result } from '../../../shared/result';
import type { SiteRegistry } from '../../sites-and-areas/public';
import type { AssignmentRefusal, LicenceRefusal, LicensingAssignmentAttendance } from '../public';

/**
 * The requests this module answers, for the composition root to register. The entry point writes the one audit entry
 * after a handler succeeds; the handler names the person the change is about, so that person can read the entry, and
 * the district, so its members can (ADR-10).
 */
export function createLicensingOperations(module: LicensingAssignmentAttendance, registry: SiteRegistry): readonly Operation[] {
  const { assignments } = module;
  const districtOfSite = async (siteId: unknown) => (await registry.locateSite(String(siteId)))?.districtId;
  const districtOfZone = async (zoneId: unknown) => (await registry.locateZone(String(zoneId)))?.districtId;
  return [
    assignmentWrite({
      name: 'assignments.assignAttendant',
      path: '/assignments/attendants',
      allowedRoles: ['member', 'chair'],
      fields: { attendantId: 'string', siteId: 'string', shiftId: 'string' },
      example: { attendantId: 'person-1', siteId: 'site-1', shiftId: 'morning' },
      subject: 'attendantId',
      change: ({ actor, body }) => assignments.assignAttendantToSite(actor.personId, String(body['attendantId']), String(body['siteId']), String(body['shiftId'])),
      district: ({ body }) => districtOfSite(body['siteId']),
    }),
    assignmentWrite({
      name: 'assignments.changeShift',
      path: '/assignments/attendants/shift',
      allowedRoles: ['member', 'chair'],
      fields: { attendantId: 'string', shiftId: 'string' },
      example: { attendantId: 'person-1', shiftId: 'evening' },
      subject: 'attendantId',
      change: ({ actor, body }) => assignments.changeShift(actor.personId, String(body['attendantId']), String(body['shiftId'])),
      district: async ({ body }) => districtOfSite(await assignments.siteOf(String(body['attendantId']))),
    }),
    assignmentWrite({
      name: 'assignments.releaseAttendant',
      path: '/assignments/attendants/release',
      allowedRoles: ['member', 'chair'],
      fields: { attendantId: 'string' },
      example: { attendantId: 'person-1' },
      subject: 'attendantId',
      change: ({ actor, body }) => assignments.releaseAttendant(actor.personId, String(body['attendantId'])),
      district: async ({ body }) => districtOfSite(await assignments.siteOf(String(body['attendantId']))),
    }),
    assignmentWrite({
      name: 'assignments.assignInspector',
      path: '/assignments/inspectors',
      allowedRoles: ['member', 'chair'],
      fields: { inspectorId: 'string', zoneId: 'string' },
      example: { inspectorId: 'person-2', zoneId: 'zone-1' },
      subject: 'inspectorId',
      change: ({ actor, body }) => assignments.assignInspectorToZone(actor.personId, String(body['inspectorId']), String(body['zoneId'])),
      district: ({ body }) => districtOfZone(body['zoneId']),
    }),
    issueLicence(module, districtOfSite),
    assignmentWrite({
      name: 'assignments.appointMember',
      path: '/assignments/members',
      allowedRoles: ['chair'],
      fields: { memberId: 'string', districtId: 'string' },
      example: { memberId: 'person-3', districtId: 'district-1' },
      subject: 'memberId',
      change: ({ actor, body }) => assignments.appointMemberToDistrict(actor.personId, String(body['memberId']), String(body['districtId'])),
      district: async ({ body }) => String(body['districtId']),
    }),
  ];
}

/**
 * Issuing is the only licence change reachable by request. Suspension and revocation have no route of their own: they
 * arrive through the Chair's approval, whose request writes the audit entry naming requester and approver.
 */
function issueLicence(module: LicensingAssignmentAttendance, districtOfSite: (siteId: unknown) => Promise<DistrictId | undefined>): WriteOperation {
  return {
    kind: 'write',
    name: 'licences.issue',
    method: 'POST',
    path: '/licences',
    allowedRoles: ['member', 'chair'],
    bodySchema: { fields: { attendantId: 'string' } },
    examples: { valid: { attendantId: 'person-1' }, invalid: { attendantId: 1 } },
    async handle({ actor, body }) {
      const attendantId = String(body['attendantId']);
      const issued = await module.licences.issueLicence(actor.personId, attendantId);
      if (!issued.ok) {
        return { response: refuse(LICENCE_REFUSAL_STATUS[issued.error], issued.error) };
      }
      const districtId = await districtOfSite(await module.assignments.siteOf(attendantId));
      return {
        response: respond(201, { licenceId: issued.value }),
        audit: districtId === undefined ? { subjectPersonIds: [attendantId] } : { subjectPersonIds: [attendantId], districtId },
      };
    },
  };
}

const LICENCE_REFUSAL_STATUS: Readonly<Record<LicenceRefusal, number>> = {
  'needs an approved request': 403,
  'not a permitted change': 409,
  'unknown licence': 404,
  'already licensed': 409,
  'not an attendant': 400,
  'not allowed here': 403,
};

interface AssignmentWriteSpec {
  readonly name: string;
  readonly path: string;
  readonly allowedRoles: readonly Role[];
  readonly fields: BodySchema['fields'];
  readonly example: ValidBody;
  /** The body field naming the person the change is about. */
  readonly subject: string;
  change(context: WriteContext): Promise<Result<void, AssignmentRefusal>>;
  /** The district the change belongs to, read before the change, while a release still names the site. */
  district(context: WriteContext): Promise<DistrictId | undefined>;
}

function assignmentWrite(spec: AssignmentWriteSpec): WriteOperation {
  return {
    kind: 'write',
    name: spec.name,
    method: 'POST',
    path: spec.path,
    allowedRoles: spec.allowedRoles,
    bodySchema: { fields: spec.fields },
    examples: { valid: spec.example, invalid: {} },
    async handle(context) {
      const districtId = await spec.district(context);
      const changed = await spec.change(context);
      if (!changed.ok) {
        return refused(changed.error);
      }
      const subject: PersonId = String(context.body[spec.subject]);
      return {
        response: respond(200, { done: spec.name }),
        audit: districtId === undefined ? { subjectPersonIds: [subject] } : { subjectPersonIds: [subject], districtId },
      };
    },
  };
}

const REFUSAL_STATUS: Readonly<Record<AssignmentRefusal, number>> = {
  'one site per attendant': 409,
  'members are managed by the Chair only': 403,
  'not allowed here': 403,
  'not an attendant': 400,
  'not an inspector': 400,
  'not a member': 400,
  'not assigned': 404,
  'unknown site': 404,
  'unknown zone': 404,
  'unknown district': 404,
  'invalid shift': 400,
};

function refused(refusal: AssignmentRefusal): WriteOutcome {
  return { response: refuse(REFUSAL_STATUS[refusal], refusal) };
}
