import type { DistrictId, PersonId, SiteId, ZoneId } from '../../../shared/identifiers';
import type { GeoPoint, OpeningPeriod } from '../public';
import type { District, Site, Zone } from './domain/places';
import type { SpecialEvent } from './domain/site-calendar';

/**
 * Storage ports owned by this module. The in-memory adapters in `adapters/` implement them for every test; the
 * PostgreSQL adapters will implement the same ports over the tables in `db/migrations/0002_identity_and_registry.sql`.
 */

/** The `sites_and_areas.districts`, `zones` and `sites` tables. */
export interface PlacesStore {
  addDistrict(district: District): Promise<void>;
  district(districtId: DistrictId): Promise<District | undefined>;
  relabelDistrict(districtId: DistrictId, label: string): Promise<void>;
  addZone(zone: Zone): Promise<void>;
  zone(zoneId: ZoneId): Promise<Zone | undefined>;
  relabelZone(zoneId: ZoneId, label: string): Promise<void>;
  addSite(site: Site): Promise<void>;
  site(siteId: SiteId): Promise<Site | undefined>;
  replaceOutline(siteId: SiteId, outline: readonly GeoPoint[]): Promise<void>;
  allSites(): Promise<readonly Site[]>;
}

/** One row of the `sites_and_areas.capacity_changes` table: insert-only, the latest row is the current capacity. */
export interface CapacityChangeRow {
  readonly siteId: SiteId;
  readonly capacity: number;
  readonly reason: string;
  readonly changedBy: PersonId;
  /** Set from the server clock (Rule I). */
  readonly changedAt: string;
}

export interface CapacityStore {
  append(change: CapacityChangeRow): Promise<void>;
  historyOf(siteId: SiteId): Promise<readonly CapacityChangeRow[]>;
}

/** A declared closure or free period, with who declared it and when by the server clock. */
export interface SpecialEventRow extends SpecialEvent {
  readonly siteId: SiteId;
  readonly declaredBy: PersonId;
  readonly declaredAt: string;
}

/** The `sites_and_areas.opening_hours` and `special_events` tables. */
export interface SiteCalendarStore {
  weeklyHours(siteId: SiteId): Promise<readonly OpeningPeriod[] | undefined>;
  replaceWeeklyHours(siteId: SiteId, periods: readonly OpeningPeriod[]): Promise<void>;
  addEvent(event: SpecialEventRow): Promise<void>;
  eventsOf(siteId: SiteId): Promise<readonly SpecialEventRow[]>;
}
