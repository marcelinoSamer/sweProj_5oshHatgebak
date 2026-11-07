import { signToken } from '../../../../entrypoint/auth/token';
import { TEST_TOKEN_SECRET } from '../../../../entrypoint/test-helpers';
import {
  createAccountsAndAccessControl,
  createInMemoryAccountsStores,
  RecordingSignInCodeSender,
  type AccountsAndAccessControl,
} from '../../../accounts-and-access-control/public';
import { FixedClock } from '../../../../shared/clock';
import type { PersonId, Role } from '../../../../shared/identifiers';
import type { Result } from '../../../../shared/result';
import {
  createInMemorySitesStores,
  createSiteLocator,
  createSiteRegistry,
  type SiteRegistry,
  type SitesAndAreasStores,
} from '../../public';

export const TEST_SITE_CODE_SECRET = 'site-code-secret-for-tests';
export const TEST_START = new Date('2026-11-05T08:00:00Z');

/** Access control and the site registry wired together over in-memory stores, the way the composition root wires them. */
export interface RegistryWorld {
  readonly clock: FixedClock;
  readonly accounts: AccountsAndAccessControl;
  readonly sitesStores: SitesAndAreasStores;
  readonly registry: SiteRegistry;
  readonly chair: PersonId;
}

export async function createRegistryWorld(): Promise<RegistryWorld> {
  const clock = new FixedClock(TEST_START);
  const sitesStores = createInMemorySitesStores();
  const accounts = createAccountsAndAccessControl({
    stores: createInMemoryAccountsStores(),
    siteLocator: createSiteLocator(sitesStores),
    signInCodeSender: new RecordingSignInCodeSender(),
    tokenIssuer: { issue: (actor) => signToken(actor, TEST_TOKEN_SECRET) },
    clock,
  });
  const registry = createSiteRegistry({ stores: sitesStores, authorization: accounts.authorization, siteCodeSecret: TEST_SITE_CODE_SECRET, clock });
  const chair = valueOf(await accounts.bootstrapChair('01000000000', 'The Chair'));
  return { clock, accounts, sitesStores, registry, chair };
}

let nextPhoneSuffix = 1;

/** Creates a staff member through the Chair, as the hierarchy allows, with a fresh phone number. */
export async function createStaff(world: RegistryWorld, role: Exclude<Role, 'chair' | 'driver'>): Promise<PersonId> {
  const phone = `0110${String(nextPhoneSuffix++).padStart(7, '0')}`;
  return valueOf(await world.accounts.personalData.createPerson(world.chair, role, phone, `${role} ${phone}`));
}

/** A small square around a point, about 40 metres on each side. */
export function squareAround(latitude: number, longitude: number) {
  const half = 0.0002;
  return [
    { latitude: latitude - half, longitude: longitude - half },
    { latitude: latitude - half, longitude: longitude + half },
    { latitude: latitude + half, longitude: longitude + half },
    { latitude: latitude + half, longitude: longitude - half },
  ];
}

export function valueOf<Value>(result: Result<Value, string>): Value {
  if (!result.ok) {
    throw new Error(`test set-up was refused: ${result.error}`);
  }
  return result.value;
}
