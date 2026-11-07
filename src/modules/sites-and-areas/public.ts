/**
 * Sites & Areas — owner: Teammate A (Area 2). Must-stay-on set.
 * Districts, zones, sites, capacity with history, hours, special events, signed entry and exit codes. Needs AuditTrail.
 */
import type { Clock } from '../../shared/clock';
import type { DistrictId, PersonId, SiteId, ZoneId } from '../../shared/identifiers';
import type { Result } from '../../shared/result';
import type { Authorization, SiteLocator } from '../accounts-and-access-control/public';
import { InMemoryCapacityStore, InMemoryPlacesStore } from './internal/adapters/in-memory-stores';
import { SiteCodeSigner } from './internal/domain/site-code-signer';
import { PlacesLocator } from './internal/places-locator';
import type { CapacityStore, PlacesStore } from './internal/ports';
import { SiteCodesService } from './internal/site-codes-service';
import { SiteRegistryService } from './internal/site-registry-service';

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export type FreeSpaceBand = 'free' | 'few' | 'full' | 'unknown';

export interface NearbySite {
  readonly siteId: SiteId;
  readonly distanceMeters: number;
  readonly firstHourFee: number;
  readonly band: FreeSpaceBand;
}

export interface CapacityChange {
  readonly capacity: number;
  readonly reason: string;
  readonly changedAt: string;
}

export type SiteCodeKind = 'entry' | 'exit';

/**
 * "forged": not signed by this system, or altered. "wrong site": genuine, but printed at another site.
 * "wrong kind": genuine, but an exit code presented at the entry or the other way round.
 */
export type SiteCodeRefusal = 'forged' | 'wrong site' | 'wrong kind';

/** The signed codes printed at each site (task A7). Ticketing verifies every scan through these two checks. */
export interface SiteCodes {
  issueEntryAndExitCodes(siteId: SiteId): Promise<{ entryCode: string; exitCode: string }>;
  verifyEntryCode(code: string, siteId: SiteId): Promise<Result<SiteId, SiteCodeRefusal>>;
  verifyExitCode(code: string, siteId: SiteId): Promise<Result<SiteId, SiteCodeRefusal>>;
}

export type PlaceRefusal =
  | 'not allowed here'
  | 'unknown district'
  | 'unknown zone'
  | 'unknown site'
  | 'invalid label'
  | 'invalid outline'
  | 'invalid capacity';

/** A site with where it sits and its current capacity (the latest row of its capacity history). */
export interface SiteDetails {
  readonly siteId: SiteId;
  readonly zoneId: ZoneId;
  readonly districtId: DistrictId;
  readonly label: string;
  readonly outline: readonly GeoPoint[];
  readonly capacity: number;
}

/**
 * The registry every ticket is written against. Writes take the acting person and are refused unless that person is
 * the Chair or a member of the district concerned (task A6); the Chair alone creates a district.
 */
export interface SiteRegistry extends SiteCodes, SiteLocator {
  createDistrict(actor: PersonId, label: string): Promise<Result<DistrictId, PlaceRefusal>>;
  relabelDistrict(actor: PersonId, districtId: DistrictId, label: string): Promise<Result<void, PlaceRefusal>>;
  createZone(actor: PersonId, districtId: DistrictId, label: string): Promise<Result<ZoneId, PlaceRefusal>>;
  relabelZone(actor: PersonId, zoneId: ZoneId, label: string): Promise<Result<void, PlaceRefusal>>;
  createSite(actor: PersonId, zoneId: ZoneId, label: string, outline: readonly GeoPoint[], capacity: number): Promise<Result<SiteId, PlaceRefusal>>;
  replaceSiteOutline(actor: PersonId, siteId: SiteId, outline: readonly GeoPoint[]): Promise<Result<void, PlaceRefusal>>;
  siteDetails(siteId: SiteId): Promise<SiteDetails | undefined>;
  /** The current number of spaces; ticketing computes free spaces from this and its open tickets. */
  capacityOf(siteId: SiteId): Promise<number | undefined>;
  locateSite(siteId: SiteId): Promise<{ readonly zoneId: ZoneId; readonly districtId: DistrictId } | undefined>;
}

/** The environment variable holding the secret that signs site codes (a name only; the value never enters the code). */
export const SITE_CODE_SECRET_VARIABLE = 'SITE_CODE_SECRET';

export function createSiteCodes(secret: string): SiteCodes {
  return new SiteCodesService(new SiteCodeSigner(secret));
}

export interface SitesAndAreasStores {
  readonly places: PlacesStore;
  readonly capacity: CapacityStore;
}

export interface SitesAndAreasDependencies {
  readonly stores: SitesAndAreasStores;
  readonly authorization: Authorization;
  readonly siteCodeSecret: string;
  readonly clock: Clock;
}

/** The composition root builds the registry through this one function; nothing else constructs its internals. */
export function createSiteRegistry(dependencies: SitesAndAreasDependencies): SiteRegistry {
  const { stores, authorization, siteCodeSecret, clock } = dependencies;
  return new SiteRegistryService({
    places: stores.places,
    capacity: stores.capacity,
    authorization,
    codes: new SiteCodesService(new SiteCodeSigner(siteCodeSecret)),
    clock,
  });
}

/**
 * The SiteLocator port access control needs, read straight from this module's stores. It exists so access control can
 * be built first, then handed to the registry, without either module importing the other in a circle.
 */
export function createSiteLocator(stores: SitesAndAreasStores): SiteLocator {
  return new PlacesLocator(stores.places);
}

export function createInMemorySitesStores(): SitesAndAreasStores {
  return { places: new InMemoryPlacesStore(), capacity: new InMemoryCapacityStore() };
}

export { createSitesOperations } from './internal/operations';
