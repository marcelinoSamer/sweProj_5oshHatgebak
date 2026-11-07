/**
 * Driver App map client for task D2.
 * The app holds the refresh timing and renders the server's answer; the server keeps the site facts and the free-space band.
 */
import {
  DriverMapRefusedError,
  DriverMapTransportError,
  type DriverMapApi,
  type DriverMapRefusal,
  type GeoPoint,
  type NearbySiteResult,
} from './driver-map-api';

export type DriverMapClientSuccess<T> = { readonly ok: true; readonly value: T };
export type DriverMapClientFailure =
  | { readonly ok: false; readonly error: 'connection lost' }
  | { readonly ok: false; readonly error: DriverMapRefusal };
export type DriverMapClientResult<T> = DriverMapClientSuccess<T> | DriverMapClientFailure;

export interface DriverMapClientOptions {
  readonly api: DriverMapApi;
  readonly now: () => number;
}

export class DriverMapClient {
  private readonly api: DriverMapApi;
  private readonly now: () => number;
  private lastRefreshedAtMs: number | undefined;

  constructor(options: DriverMapClientOptions) {
    this.api = options.api;
    this.now = options.now;
  }

  lastRefreshAtMs(): number | undefined {
    return this.lastRefreshedAtMs;
  }

  refreshIntervalMs(): number {
    return this.api.getRefreshIntervalMs();
  }

  isRefreshDue(nowMs = this.now()): boolean {
    if (this.lastRefreshedAtMs === undefined) {
      return true;
    }
    return nowMs - this.lastRefreshedAtMs >= this.refreshIntervalMs();
  }

  async nearbySites(from: GeoPoint, radiusMeters: number): Promise<DriverMapClientResult<readonly NearbySiteResult[]>> {
    try {
      const results = await this.api.nearbySites(from, radiusMeters);
      this.lastRefreshedAtMs = this.now();
      return { ok: true, value: results };
    } catch (error) {
      if (error instanceof DriverMapTransportError) {
        return { ok: false, error: 'connection lost' };
      }
      if (error instanceof DriverMapRefusedError) {
        return { ok: false, error: error.refusal };
      }
      throw error;
    }
  }
}
