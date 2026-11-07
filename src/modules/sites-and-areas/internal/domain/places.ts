import type { DistrictId, SiteId, ZoneId } from '../../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../../shared/result';
import type { GeoPoint } from '../../public';

/** A district of the governorate, run by its committee members. */
export interface District {
  readonly districtId: DistrictId;
  readonly label: string;
}

/** A zone inside one district, watched by its inspector. */
export interface Zone {
  readonly zoneId: ZoneId;
  readonly districtId: DistrictId;
  readonly label: string;
}

/** A street-parking site inside one zone. Its capacity lives in the capacity history, never in this row. */
export interface Site {
  readonly siteId: SiteId;
  readonly zoneId: ZoneId;
  readonly label: string;
  readonly outline: readonly GeoPoint[];
}

const MAXIMUM_LABEL_LENGTH = 80;
const MINIMUM_OUTLINE_POINTS = 3;
const MAXIMUM_CAPACITY = 10_000;
const MAXIMUM_REASON_LENGTH = 500;

export function validLabel(label: string): Result<string, 'invalid label'> {
  const trimmed = label.trim().replace(/\s+/g, ' ');
  return trimmed === '' || trimmed.length > MAXIMUM_LABEL_LENGTH ? fail('invalid label') : succeed(trimmed);
}

/** At least three points, each a real latitude and longitude, so the outline encloses an area. */
export function validOutline(outline: readonly GeoPoint[]): Result<readonly GeoPoint[], 'invalid outline'> {
  const everyPointIsReal = outline.every(
    (point) =>
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.latitude) <= 90 &&
      Math.abs(point.longitude) <= 180,
  );
  return outline.length >= MINIMUM_OUTLINE_POINTS && everyPointIsReal ? succeed(outline) : fail('invalid outline');
}

/** A whole number of spaces from 1 to 10,000. */
export function validCapacity(capacity: number): Result<number, 'invalid capacity'> {
  return Number.isInteger(capacity) && capacity >= 1 && capacity <= MAXIMUM_CAPACITY ? succeed(capacity) : fail('invalid capacity');
}

/** A reason is mandatory for a change the committee must be able to explain later (ADR-10). */
export function validReason(reason: string): Result<string, 'reason required'> {
  const trimmed = reason.trim();
  return trimmed === '' || trimmed.length > MAXIMUM_REASON_LENGTH ? fail('reason required') : succeed(trimmed);
}

/** The point used for distances: the average of the outline's corners, close enough for sites a few hundred metres wide. */
export function centreOf(outline: readonly GeoPoint[]): GeoPoint {
  const total = outline.reduce(
    (sum, point) => ({ latitude: sum.latitude + point.latitude, longitude: sum.longitude + point.longitude }),
    { latitude: 0, longitude: 0 },
  );
  return { latitude: total.latitude / outline.length, longitude: total.longitude / outline.length };
}
