import type { DistrictId, SiteId, ZoneId } from '../../../../shared/identifiers';
import type { GeoPoint, OpeningPeriod } from '../../public';
import type { District, Site, Zone } from '../domain/places';
import type { CapacityChangeRow, CapacityStore, PlacesStore, SiteCalendarStore, SpecialEventRow } from '../ports';

/** In-memory stand-ins for this module's tables, used by every test. */
export class InMemoryPlacesStore implements PlacesStore {
  private readonly districts = new Map<DistrictId, District>();
  private readonly zones = new Map<ZoneId, Zone>();
  private readonly sites = new Map<SiteId, Site>();

  async addDistrict(district: District): Promise<void> {
    this.districts.set(district.districtId, district);
  }

  async district(districtId: DistrictId): Promise<District | undefined> {
    return this.districts.get(districtId);
  }

  async relabelDistrict(districtId: DistrictId, label: string): Promise<void> {
    this.districts.set(districtId, { ...existing(this.districts, districtId, 'district'), label });
  }

  async addZone(zone: Zone): Promise<void> {
    this.zones.set(zone.zoneId, zone);
  }

  async zone(zoneId: ZoneId): Promise<Zone | undefined> {
    return this.zones.get(zoneId);
  }

  async relabelZone(zoneId: ZoneId, label: string): Promise<void> {
    this.zones.set(zoneId, { ...existing(this.zones, zoneId, 'zone'), label });
  }

  async addSite(site: Site): Promise<void> {
    this.sites.set(site.siteId, site);
  }

  async site(siteId: SiteId): Promise<Site | undefined> {
    return this.sites.get(siteId);
  }

  async replaceOutline(siteId: SiteId, outline: readonly GeoPoint[]): Promise<void> {
    this.sites.set(siteId, { ...existing(this.sites, siteId, 'site'), outline });
  }

  async allSites(): Promise<readonly Site[]> {
    return [...this.sites.values()];
  }
}

export class InMemoryCapacityStore implements CapacityStore {
  private readonly changes: CapacityChangeRow[] = [];

  async append(change: CapacityChangeRow): Promise<void> {
    this.changes.push(change);
  }

  async historyOf(siteId: SiteId): Promise<readonly CapacityChangeRow[]> {
    return this.changes.filter((change) => change.siteId === siteId);
  }
}

export class InMemorySiteCalendarStore implements SiteCalendarStore {
  private readonly hours = new Map<SiteId, readonly OpeningPeriod[]>();
  private readonly events: SpecialEventRow[] = [];

  async weeklyHours(siteId: SiteId): Promise<readonly OpeningPeriod[] | undefined> {
    return this.hours.get(siteId);
  }

  async replaceWeeklyHours(siteId: SiteId, periods: readonly OpeningPeriod[]): Promise<void> {
    this.hours.set(siteId, periods);
  }

  async addEvent(event: SpecialEventRow): Promise<void> {
    this.events.push(event);
  }

  async eventsOf(siteId: SiteId): Promise<readonly SpecialEventRow[]> {
    return this.events.filter((event) => event.siteId === siteId);
  }
}

function existing<Row>(rows: ReadonlyMap<string, Row>, id: string, kind: string): Row {
  const row = rows.get(id);
  if (row === undefined) {
    throw new Error(`No ${kind} with the id ${id}`);
  }
  return row;
}
