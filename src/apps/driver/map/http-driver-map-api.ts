/**
 * Driver map API adapter: call the main system through the HTTP entry point and translate server answers into
 * app errors or data. The app holds no business rule; it displays what the server tells it.
 */
import type { HttpRequest, HttpResponse } from '../../../entrypoint/http';
import {
  DriverMapRefusedError,
  DriverMapTransportError,
  isDriverMapRefusal,
  type DriverMapApi,
  type GeoPoint,
  type NearbySiteResult,
} from './driver-map-api';
import { DRIVER_MAP_NEARBY_PATH } from './driver-map-routes';

export type EntryPointHandle = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpDriverMapApiOptions {
  readonly handle: EntryPointHandle;
  readonly authorizationHeader: () => string;
}

export class HttpDriverMapApi implements DriverMapApi {
  private readonly handle: EntryPointHandle;
  private readonly authorizationHeader: () => string;

  constructor(options: HttpDriverMapApiOptions) {
    this.handle = options.handle;
    this.authorizationHeader = options.authorizationHeader;
  }

  async nearbySites(from: GeoPoint, radiusMeters: number): Promise<readonly NearbySiteResult[]> {
    const response = await this.send({
      latitude: String(from.latitude),
      longitude: String(from.longitude),
      radiusMeters: String(radiusMeters),
    });
    return readNearbySites(response);
  }

  getRefreshIntervalMs(): number {
    return 15_000;
  }

  private async send(query: Record<string, string>): Promise<HttpResponse> {
    try {
      return await this.handle({
        method: 'GET',
        path: DRIVER_MAP_NEARBY_PATH,
        query,
        headers: {
          authorization: this.authorizationHeader(),
        },
      });
    } catch (error) {
      if (error instanceof DriverMapTransportError || error instanceof DriverMapRefusedError) {
        throw error;
      }
      throw new DriverMapTransportError(error instanceof Error ? error.message : 'connection lost before the answer arrived');
    }
  }
}

function readNearbySites(response: HttpResponse): readonly NearbySiteResult[] {
  if (response.status >= 400) {
    throw refusal(response);
  }

  const body = asArray(response.body);
  return body.map((entry) => {
    const record = asRecord(entry);
    return {
      siteId: requiredString(record, 'siteId'),
      distanceMeters: requiredNumber(record, 'distanceMeters'),
      firstHourFee: requiredNumber(record, 'firstHourFee'),
      band: requiredBand(record, 'band'),
    };
  });
}

function refusal(response: HttpResponse): Error {
  if (response.status === 401) {
    return new DriverMapRefusedError('not signed in');
  }

  const reason = errorMessage(response);
  return isDriverMapRefusal(reason) ? new DriverMapRefusedError(reason) : new Error(reason);
}

function errorMessage(response: HttpResponse): string {
  const body = asRecord(response.body);
  const error = body['error'];
  return typeof error === 'string' ? error : `request refused with status ${response.status}`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`server answer missing ${field}`);
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`server answer missing ${field}`);
  }
  return value;
}

function requiredBand(body: Record<string, unknown>, field: string): NearbySiteResult['band'] {
  const value = body[field];
  if (value === 'free' || value === 'few' || value === 'full' || value === 'unknown') {
    return value;
  }
  throw new Error(`server answer missing ${field}`);
}
