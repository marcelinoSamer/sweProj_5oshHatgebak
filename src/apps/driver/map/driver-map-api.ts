export type FreeSpaceBand = 'free' | 'few' | 'full' | 'unknown';

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface SiteMapEntry {
  readonly siteId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly firstHourFee: number;
  readonly capacity: number;
  readonly openTicketCount: number;
}

export interface NearbySiteResult {
  readonly siteId: string;
  readonly distanceMeters: number;
  readonly firstHourFee: number;
  readonly band: FreeSpaceBand;
}

export type DriverMapRefusal = 'not signed in';

export const DRIVER_MAP_REFUSALS: readonly DriverMapRefusal[] = ['not signed in'];

export function isDriverMapRefusal(candidate: unknown): candidate is DriverMapRefusal {
  return typeof candidate === 'string' && (DRIVER_MAP_REFUSALS as readonly string[]).includes(candidate);
}

/** The connection dropped before the server answered. */
export class DriverMapTransportError extends Error {
  constructor(message = 'connection lost before the answer arrived') {
    super(message);
    this.name = 'DriverMapTransportError';
  }
}

/** The server answered and said no. Nothing changed. */
export class DriverMapRefusedError extends Error {
  readonly refusal: DriverMapRefusal;

  constructor(refusal: DriverMapRefusal) {
    super(refusal);
    this.name = 'DriverMapRefusedError';
    this.refusal = refusal;
  }
}

export interface DriverMapApi {
  nearbySites(from: GeoPoint, radiusMeters: number): Promise<readonly NearbySiteResult[]>;
  getRefreshIntervalMs(): number;
}
