import { InMemoryAuditLogStore } from '../../../../adapters/in-memory/in-memory-audit-log-store';
import { InMemoryDatabase } from '../../../../adapters/in-memory/in-memory-database';
import { signToken } from '../../../../entrypoint/auth/token';
import { TEST_TOKEN_SECRET } from '../../../../entrypoint/test-helpers';
import { createHashChainedAuditTrail, type AuditTrail } from '../../../audit-log/public';
import { FixedClock } from '../../../../shared/clock';
import type { DistrictId, PersonId, Role, SiteId, ZoneId } from '../../../../shared/identifiers';
import type { Result } from '../../../../shared/result';
import {
  createAccountsAndAccessControl,
  createInMemoryAccountsStores,
  RecordingSignInCodeSender,
  type AccountsAndAccessControl,
} from '../../../accounts-and-access-control/public';
import { createInMemorySitesStores, createSiteLocator, createSiteRegistry, type SiteRegistry } from '../../../sites-and-areas/public';
import {
  createInMemoryLicensingStores,
  createLicensingAssignmentAttendance,
  type ApprovalVerifier,
  type LicenceState,
  type LicensingAssignmentAttendance,
  type LicensingAssignmentAttendanceStores,
} from '../../public';
import type { ApprovalRequestId, LicenceId } from '../../../../shared/identifiers';

/** A stand-in for Approvals: it confirms exactly the requests a test has marked approved, for exactly that move. */
export class FakeApprovals implements ApprovalVerifier {
  private readonly approved = new Map<ApprovalRequestId, { readonly licenceId: LicenceId; readonly to: LicenceState }>();

  approve(approvalRequestId: ApprovalRequestId, licenceId: LicenceId, to: LicenceState): void {
    this.approved.set(approvalRequestId, { licenceId, to });
  }

  async isApproved(approvalRequestId: ApprovalRequestId, change: { readonly licenceId: LicenceId; readonly to: LicenceState }): Promise<boolean> {
    const approvedChange = this.approved.get(approvalRequestId);
    return approvedChange?.licenceId === change.licenceId && approvedChange.to === change.to;
  }
}

export const TEST_SITE_CODE_SECRET = 'site-code-secret-for-tests';

/**
 * Access control, the site registry and this module wired over in-memory stores the way the composition root wires
 * them, with two districts, each holding one zone and one site, and a member appointed to district one.
 */
export interface LicensingWorld {
  readonly clock: FixedClock;
  readonly audit: AuditTrail;
  readonly accounts: AccountsAndAccessControl;
  readonly registry: SiteRegistry;
  readonly licensing: LicensingAssignmentAttendance;
  readonly stores: LicensingAssignmentAttendanceStores;
  readonly approvals: FakeApprovals;
  readonly chair: PersonId;
  readonly memberOfDistrictOne: PersonId;
  readonly districtOne: DistrictId;
  readonly districtTwo: DistrictId;
  readonly zoneOne: ZoneId;
  readonly zoneTwo: ZoneId;
  readonly siteOne: SiteId;
  readonly siteOneBis: SiteId;
  readonly siteTwo: SiteId;
}

export async function createLicensingWorld(): Promise<LicensingWorld> {
  const clock = new FixedClock(new Date('2026-11-05T08:00:00Z'));
  const audit = createHashChainedAuditTrail(new InMemoryAuditLogStore(new InMemoryDatabase()), clock);
  const sitesStores = createInMemorySitesStores();
  const accounts = createAccountsAndAccessControl({
    stores: createInMemoryAccountsStores(),
    siteLocator: createSiteLocator(sitesStores),
    signInCodeSender: new RecordingSignInCodeSender(),
    tokenIssuer: { issue: (actor) => signToken(actor, TEST_TOKEN_SECRET) },
    audit,
    clock,
  });
  const registry = createSiteRegistry({
    stores: sitesStores,
    authorization: accounts.authorization,
    siteCodeSecret: TEST_SITE_CODE_SECRET,
    freeSpaces: { freeSpaces: async () => 0 },
    prices: { firstHourFee: async () => 0 },
    clock,
  });
  const stores = createInMemoryLicensingStores();
  const approvals = new FakeApprovals();
  const licensing = createLicensingAssignmentAttendance({
    stores,
    authorization: accounts.authorization,
    accessFacts: accounts.accessFacts,
    registry,
    approvals,
    clock,
  });
  const chair = valueOf(await accounts.bootstrapChair('01000000000', 'The Chair'));
  const districtOne = valueOf(await registry.createDistrict(chair, 'Zamalek'));
  const districtTwo = valueOf(await registry.createDistrict(chair, 'Dokki'));
  const zoneOne = valueOf(await registry.createZone(chair, districtOne, 'Zamalek zone 1'));
  const zoneTwo = valueOf(await registry.createZone(chair, districtTwo, 'Dokki zone 1'));
  const siteOne = valueOf(await registry.createSite(chair, zoneOne, '26 July Street', squareAround(30.0626, 31.2197), 12));
  const siteOneBis = valueOf(await registry.createSite(chair, zoneOne, 'Brazil Street', squareAround(30.0650, 31.2210), 8));
  const siteTwo = valueOf(await registry.createSite(chair, zoneTwo, 'Tahrir Street', squareAround(30.0385, 31.2118), 20));
  const world = { clock, audit, accounts, registry, licensing, stores, approvals, chair, districtOne, districtTwo, zoneOne, zoneTwo, siteOne, siteOneBis, siteTwo };
  const memberOfDistrictOne = await createPerson({ ...world, memberOfDistrictOne: chair }, 'member');
  valueOf(await licensing.assignments.appointMemberToDistrict(chair, memberOfDistrictOne, districtOne));
  return { ...world, memberOfDistrictOne };
}

let nextPhoneSuffix = 1;

/** Creates a staff member through the Chair, with a fresh phone number. */
export async function createPerson(world: LicensingWorld, role: Exclude<Role, 'chair' | 'driver'>): Promise<PersonId> {
  const phone = `0120${String(nextPhoneSuffix++).padStart(7, '0')}`;
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
