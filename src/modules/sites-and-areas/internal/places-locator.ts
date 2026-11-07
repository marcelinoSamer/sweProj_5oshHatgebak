import type { DistrictId, SiteId, ZoneId } from '../../../shared/identifiers';
import type { SiteLocator } from '../../accounts-and-access-control/public';
import type { PlacesStore } from './ports';

/**
 * Where a site or zone sits in the hierarchy, read straight from the places table. Access control receives this as its
 * SiteLocator port, so it can be built before the registry that itself needs access control.
 */
export class PlacesLocator implements SiteLocator {
  constructor(private readonly places: PlacesStore) {}

  async locateSite(siteId: SiteId): Promise<{ readonly zoneId: ZoneId; readonly districtId: DistrictId } | undefined> {
    const site = await this.places.site(siteId);
    const zone = site === undefined ? undefined : await this.places.zone(site.zoneId);
    return zone === undefined ? undefined : { zoneId: zone.zoneId, districtId: zone.districtId };
  }

  async locateZone(zoneId: ZoneId): Promise<{ readonly districtId: DistrictId } | undefined> {
    const zone = await this.places.zone(zoneId);
    return zone === undefined ? undefined : { districtId: zone.districtId };
  }
}
