/**
 * Sites & Areas — owner: Teammate A (Area 2). Must-stay-on set.
 * Districts, zones, sites, capacity with history, hours, special events, signed entry and exit codes. Needs AuditTrail.
 */
import type { Clock } from '../../shared/clock';
import type { DistrictId, PersonId, SiteId, ZoneId } from '../../shared/identifiers';
import type { Result } from '../../shared/result';
import type { Authorization, SiteLocator } from '../accounts-and-access-control/public';
import { InMemoryCapacityStore, InMemoryPlacesStore, InMemorySiteCalendarStore } from './internal/adapters/in-memory-stores';
import { SiteCodeSigner } from './internal/domain/site-code-signer';
import { PlacesLocator } from './internal/places-locator';
import type { CapacityStore, PlacesStore, SiteCalendarStore } from './internal/ports';
import { SiteCodesService } from './internal/site-codes-service';
import { SiteRegistryService } from './internal/site-registry-service';

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export type FreeSpaceBand = 'free' | 'few' | 'full' | 'unknown';

/** One site on the driver's map (task A10). The fee is null and the band "unknown" when their source did not answer. */
export interface NearbySite {
  readonly siteId: SiteId;
  readonly label: string;
  readonly centre: GeoPoint;
  readonly distanceMeters: number;
  readonly open: boolean;
  readonly firstHourFee: number | null;
  readonly band: FreeSpaceBand;
}

export type NearbyRefusal = 'invalid point' | 'invalid radius';

/**
 * Port: free spaces at a site, which ticketing computes from its open tickets (Rule G). The composition root fills it
 * from TicketQuery, so this module never imports ticketing, which itself imports this one.
 */
export interface FreeSpaceSource {
  freeSpaces(siteId: SiteId): Promise<number>;
}

/** Port: the committee's first-hour fee at a site at a moment. The composition root fills it from PriceList. */
export interface PriceSource {
  firstHourFee(siteId: SiteId, moment: Date): Promise<number>;
}

/** One value a site's capacity has had, from the moment set by the server clock, with who set it and why. */
export interface CapacityChange {
  readonly capacity: number;
  readonly reason: string;
  readonly changedBy: PersonId;
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
  | 'invalid capacity'
  | 'reason required'
  | 'invalid hours'
  | 'invalid period';

/** One opening period on one weekday (0 Sunday … 6 Saturday), in minutes after local midnight in Cairo. */
export interface OpeningPeriod {
  readonly weekday: number;
  readonly opensMinute: number;
  /** Exclusive; at most 1440, midnight at the end of the day. */
  readonly closesMinute: number;
}

/** A wall-clock date and time in Cairo, as the committee declares it; never a phone's clock reading. */
export interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export type SpecialEventKind = 'closure' | 'free period';

/** Open or closed at one moment, free of charge or not, and why. */
export interface SiteStatus {
  readonly open: boolean;
  readonly free: boolean;
  readonly reason: string;
}

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
  /** A new capacity with a mandatory reason (task A8); the old value stays in the history. */
  changeCapacity(actor: PersonId, siteId: SiteId, capacity: number, reason: string): Promise<Result<void, PlaceRefusal>>;
  /** Every capacity the site has had, oldest first. */
  capacityHistory(siteId: SiteId): Promise<readonly CapacityChange[]>;
  /** Replaces the weekly opening hours; a site with none declared is open around the clock (task A9). */
  setWeeklyHours(actor: PersonId, siteId: SiteId, periods: readonly OpeningPeriod[]): Promise<Result<void, PlaceRefusal>>;
  /** Declares a closure or a free period, from one local minute until another, with a mandatory reason. */
  declareSpecialEvent(
    actor: PersonId,
    siteId: SiteId,
    kind: SpecialEventKind,
    from: LocalDateTime,
    until: LocalDateTime,
    reason: string,
  ): Promise<Result<string, PlaceRefusal>>;
  /** Ticketing asks with the server clock's moment; an unknown site is closed. */
  isOpenAt(siteId: SiteId, moment: Date): Promise<boolean>;
  /** undefined for an unknown site. */
  statusAt(siteId: SiteId, moment: Date): Promise<SiteStatus | undefined>;
  /** Metres from the site's centre to a point; undefined for an unknown site. */
  distanceFromSite(siteId: SiteId, point: GeoPoint): Promise<number | undefined>;
  /** Sites whose centre lies within the radius (up to 20 km), nearest first, with fee and band as of the server clock. */
  nearbySites(from: GeoPoint, radiusMeters: number): Promise<Result<readonly NearbySite[], NearbyRefusal>>;
  districtExists(districtId: DistrictId): Promise<boolean>;
  siteDetails(siteId: SiteId): Promise<SiteDetails | undefined>;
  /** The current number of spaces; ticketing computes free spaces from this and its open tickets. */
  capacityOf(siteId: SiteId): Promise<number | undefined>;
  locateSite(siteId: SiteId): Promise<{ readonly zoneId: ZoneId; readonly districtId: DistrictId } | undefined>;
}

/** The environment variable holding the secret that signs site codes (a name only; the value never enters the code). */
export const SITE_CODE_SECRET_VARIABLE = 'SITE_CODE_SECRET';

/** The free-space bands: "full" at none, "few" at most 2 spaces or a fifth of the capacity, "free" above. */
export { FREE_SPACE_BAND_POLICY } from './internal/domain/nearby';

export function createSiteCodes(secret: string): SiteCodes {
  return new SiteCodesService(new SiteCodeSigner(secret));
}

export interface SitesAndAreasStores {
  readonly places: PlacesStore;
  readonly capacity: CapacityStore;
  readonly calendar: SiteCalendarStore;
}

export interface SitesAndAreasDependencies {
  readonly stores: SitesAndAreasStores;
  readonly authorization: Authorization;
  readonly siteCodeSecret: string;
  readonly freeSpaces: FreeSpaceSource;
  readonly prices: PriceSource;
  readonly clock: Clock;
}

/** The composition root builds the registry through this one function; nothing else constructs its internals. */
export function createSiteRegistry(dependencies: SitesAndAreasDependencies): SiteRegistry {
  const { stores, authorization, siteCodeSecret, freeSpaces, prices, clock } = dependencies;
  return new SiteRegistryService({
    places: stores.places,
    capacity: stores.capacity,
    calendar: stores.calendar,
    authorization,
    codes: new SiteCodesService(new SiteCodeSigner(siteCodeSecret)),
    freeSpaces,
    prices,
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
  return { places: new InMemoryPlacesStore(), capacity: new InMemoryCapacityStore(), calendar: new InMemorySiteCalendarStore() };
}

export { createSitesOperations } from './internal/operations';
