/**
 * In-memory stand-in for the map API while the main system is not yet plugged in.
 * The app only receives the current distance-sorted results and free-space bands from the server.
 */
import {
  DriverMapTransportError,
  type DriverMapApi,
  type GeoPoint,
  type NearbySiteResult,
  type SiteMapEntry,
} from './driver-map-api';

export class InMemoryDriverMapApi implements DriverMapApi {
  private readonly sites: Map<string, SiteMapEntry>;
  private transportDropsRemaining = 0;

  constructor(entries: readonly SiteMapEntry[] = []) {
    this.sites = new Map(entries.map((entry) => [entry.siteId, entry]));
  }

  /** Drop the next successful answer after the server has applied its result. */
  dropNextAnswers(count: number): void {
    this.transportDropsRemaining = count;
  }

  addSite(entry: SiteMapEntry): void {
    this.sites.set(entry.siteId, entry);
  }

  updateSiteTicketCount(siteId: string, openTicketCount: number): void {
    const existing = this.sites.get(siteId);
    if (existing === undefined) {
      return;
    }

    this.sites.set(siteId, {
      ...existing,
      openTicketCount,
    });
  }

  async nearbySites(from: GeoPoint, radiusMeters: number): Promise<readonly NearbySiteResult[]> {
    const nearby = [...this.sites.values()]
      .filter((site) => distanceMeters(from, { latitude: site.latitude, longitude: site.longitude }) <= radiusMeters)
      .map((site) => ({
        siteId: site.siteId,
        distanceMeters: distanceMeters(from, { latitude: site.latitude, longitude: site.longitude }),
        firstHourFee: site.firstHourFee,
        band: computeFreeSpaceBand(site.capacity, site.openTicketCount),
      }))
      .sort((left, right) => {
        if (left.distanceMeters !== right.distanceMeters) {
          return left.distanceMeters - right.distanceMeters;
        }
        return bandOrder(left.band) - bandOrder(right.band);
      });

    if (this.transportDropsRemaining > 0) {
      this.transportDropsRemaining -= 1;
      throw new DriverMapTransportError();
    }

    return nearby;
  }

  getRefreshIntervalMs(): number {
    return 15_000;
  }
}

function computeFreeSpaceBand(capacity: number, openTicketCount: number): NearbySiteResult['band'] {
  if (capacity <= 0 || openTicketCount >= capacity) {
    return 'full';
  }
  if (openTicketCount >= Math.ceil(capacity * 0.75)) {
    return 'few';
  }
  return 'free';
}

function distanceMeters(from: GeoPoint, to: GeoPoint): number {
  const latitudeDelta = to.latitude - from.latitude;
  const longitudeDelta = to.longitude - from.longitude;
  return Math.sqrt(latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta) * 111_000;
}

function bandOrder(band: NearbySiteResult['band']): number {
  switch (band) {
    case 'free':
      return 0;
    case 'few':
      return 1;
    case 'full':
      return 2;
    default:
      return 3;
  }
}
