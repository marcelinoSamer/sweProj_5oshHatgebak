import { refuse, respond } from '../../../entrypoint/http';
import type { Operation, ReadOperation, WriteOperation } from '../../../entrypoint/operations/operation';
import type { AccountsAndAccessControl, ErasureRefusal } from '../public';

/**
 * The requests this module answers, for the composition root to register.
 *
 * Not registered yet, each for a reason outside this module (see the questions for the foundation owner):
 * - requesting a sign-in code and signing in: the entry point refuses every request without a token (question 1);
 * - creating a person and adding a car: the entry point copies the whole body into the permanent audit entry, which
 *   would keep a name, a phone or a plate in the audit log for ever and defeat erasure (question 3).
 */
export function createAccountsOperations(accounts: AccountsAndAccessControl): readonly Operation[] {
  return [readOwnCars(accounts), lookUpPlate(accounts), erasePerson(accounts)];
}

/**
 * The body holds only the person reference, so the audit entry keeps no personal data. The entry names the erased
 * person as its subject, so the record of the erasure itself survives under the pseudonym.
 */
function erasePerson(accounts: AccountsAndAccessControl): WriteOperation {
  return {
    kind: 'write',
    name: 'personalData.erase',
    method: 'POST',
    path: '/people/erasure',
    allowedRoles: ['driver', 'chair'],
    bodySchema: { fields: { personId: 'string' } },
    examples: { valid: { personId: 'person-1' }, invalid: {} },
    async handle({ actor, body }) {
      const personId = String(body['personId']);
      const erased = await accounts.personalData.erase(actor.personId, personId);
      if (!erased.ok) {
        return { response: refuse(ERASURE_REFUSAL_STATUS[erased.error], erased.error) };
      }
      return { response: respond(200, erased.value), audit: { subjectPersonIds: [personId] } };
    },
  };
}

const ERASURE_REFUSAL_STATUS: Readonly<Record<ErasureRefusal, number>> = {
  'not allowed': 403,
  'unknown person': 404,
  'already erased': 409,
};

/** A driver's own cars, for the driver's own screen. */
function readOwnCars(accounts: AccountsAndAccessControl): ReadOperation {
  return {
    kind: 'read',
    name: 'personalData.ownCars',
    method: 'GET',
    path: '/cars',
    allowedRoles: ['driver'],
    async handle({ actor }) {
      return respond(200, { cars: await accounts.personalData.ownCars(actor.personId) });
    },
  };
}

/** An inspector's (or committee member's) plate look-up at a site in their scope; each plate served is logged. */
function lookUpPlate(accounts: AccountsAndAccessControl): ReadOperation {
  return {
    kind: 'read',
    name: 'personalData.lookUpPlate',
    method: 'GET',
    path: '/plates',
    allowedRoles: ['inspector', 'member', 'chair'],
    async handle({ actor, query }) {
      const plate = await accounts.personalData.readPlate({
        carRef: query['carRef'] ?? '',
        siteId: query['siteId'] ?? '',
        reader: actor.personId,
        purpose: 'inspector look-up',
      });
      if (!plate.ok) {
        return refuse(plate.error === 'refused' ? 403 : 404, plate.error);
      }
      return respond(200, { plate: plate.value });
    },
  };
}
