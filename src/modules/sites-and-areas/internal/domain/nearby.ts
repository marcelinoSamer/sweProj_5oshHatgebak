import type { FreeSpaceBand, GeoPoint } from '../../public';

const EARTH_RADIUS_METERS = 6_371_000;

/** The free-space bands of task A10, in one place for review: "few" is at most 2 spaces or a fifth of the capacity. */
export const FREE_SPACE_BAND_POLICY = { fewAtMostSpaces: 2, fewAtMostShareOfCapacity: 0.2 } as const;

export const MAXIMUM_RADIUS_METERS = 20_000;

/** Great-circle distance by the haversine formula, in metres. */
export function distanceInMeters(from: GeoPoint, to: GeoPoint): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeChange = radians(to.latitude - from.latitude);
  const longitudeChange = radians(to.longitude - from.longitude);
  const haversine =
    Math.sin(latitudeChange / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeChange / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

/** "unknown" when the count could not be read: the map says so rather than guess (Rule G: the tickets win). */
export function bandFor(freeSpaces: number | undefined, capacity: number): FreeSpaceBand {
  if (freeSpaces === undefined) {
    return 'unknown';
  }
  if (freeSpaces <= 0) {
    return 'full';
  }
  const fewThreshold = Math.max(FREE_SPACE_BAND_POLICY.fewAtMostSpaces, Math.floor(capacity * FREE_SPACE_BAND_POLICY.fewAtMostShareOfCapacity));
  return freeSpaces <= fewThreshold ? 'few' : 'free';
}

export function isRealPoint(point: GeoPoint): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;
}
