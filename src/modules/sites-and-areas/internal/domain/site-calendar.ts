import { fail, succeed, type Result } from '../../../../shared/result';
import type { LocalDateTime, OpeningPeriod, SiteStatus, SpecialEventKind } from '../../public';

/**
 * Whether a site is open at a moment (task A9): declared closures first, then the weekly opening hours, then declared
 * free periods. Hours and events are in Cairo's local time, the time printed on the street signs; the moment asked
 * about is an instant from the server clock, converted here. Pure: no storage, no clock.
 */
export const SITE_TIME_ZONE = 'Africa/Cairo';
const MINUTES_PER_DAY = 24 * 60;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface SpecialEvent {
  readonly eventId: string;
  readonly kind: SpecialEventKind;
  readonly from: LocalDateTime;
  /** Exclusive: the event is over at this local minute. */
  readonly until: LocalDateTime;
  readonly reason: string;
}

/** No weekly hours declared means the site is open around the clock. */
export function statusAt(moment: Date, weeklyHours: readonly OpeningPeriod[] | undefined, events: readonly SpecialEvent[]): SiteStatus {
  const local = toCairoLocal(moment);
  const covering = (kind: SpecialEventKind) => events.find((event) => event.kind === kind && covers(event, local));
  const closure = covering('closure');
  if (closure !== undefined) {
    return { open: false, free: false, reason: `closed: ${closure.reason}` };
  }
  if (weeklyHours !== undefined && !withinHours(weeklyHours, local)) {
    return { open: false, free: false, reason: 'outside opening hours' };
  }
  const freePeriod = covering('free period');
  return freePeriod === undefined
    ? { open: true, free: false, reason: 'open' }
    : { open: true, free: true, reason: `free: ${freePeriod.reason}` };
}

/** Each period on one weekday, inside that day: opening before closing, closing at midnight (1440) at the latest. */
export function validWeeklyHours(periods: readonly OpeningPeriod[]): Result<readonly OpeningPeriod[], 'invalid hours'> {
  const everyPeriodFits = periods.every(
    (period) =>
      Number.isInteger(period.weekday) &&
      period.weekday >= 0 &&
      period.weekday <= 6 &&
      Number.isInteger(period.opensMinute) &&
      Number.isInteger(period.closesMinute) &&
      period.opensMinute >= 0 &&
      period.opensMinute < period.closesMinute &&
      period.closesMinute <= MINUTES_PER_DAY,
  );
  return everyPeriodFits ? succeed(periods) : fail('invalid hours');
}

export function validEventPeriod(from: LocalDateTime, until: LocalDateTime): Result<void, 'invalid period'> {
  return isRealLocalDateTime(from) && isRealLocalDateTime(until) && sortKey(from) < sortKey(until) ? succeed(undefined) : fail('invalid period');
}

/**
 * Reads "daily 08:00-23:00" or "sun-thu 08:00-22:00; fri 13:00-23:00" into periods. The request-body schema has no list
 * type, and its server-clock rule rejects anything shaped like a date, so the hours travel as this text.
 */
export function parseWeeklyHours(text: string): Result<readonly OpeningPeriod[], 'invalid hours'> {
  const periods: OpeningPeriod[] = [];
  for (const entry of text.split(';').map((part) => part.trim().toLowerCase())) {
    const match = /^(daily|[a-z]{3}(?:-[a-z]{3})?)\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(entry);
    const days = match?.[1] === undefined ? undefined : weekdaysIn(match[1]);
    if (match === null || days === undefined) {
      return fail('invalid hours');
    }
    const [opensHour, opensMinute, closesHour, closesMinute] = match.slice(2, 6).map(Number) as [number, number, number, number];
    days.forEach((weekday) => periods.push({ weekday, opensMinute: opensHour * 60 + opensMinute, closesMinute: closesHour * 60 + closesMinute }));
  }
  return validWeeklyHours(periods);
}

function weekdaysIn(days: string): number[] | undefined {
  if (days === 'daily') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  const [first, last = first] = days.split('-').map((day) => WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number]));
  if (first === undefined || last === undefined || first < 0 || last < 0) {
    return undefined;
  }
  const span = (last - first + 7) % 7;
  return Array.from({ length: span + 1 }, (_unused, offset) => (first + offset) % 7);
}

interface CairoLocal extends LocalDateTime {
  readonly weekday: number;
}

const CAIRO_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: SITE_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'short',
  hourCycle: 'h23',
});

export function toCairoLocal(moment: Date): CairoLocal {
  const parts = Object.fromEntries(CAIRO_PARTS.formatToParts(moment).map((part) => [part.type, part.value]));
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    weekday: WEEKDAYS.indexOf(String(parts['weekday']).toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number]),
  };
}

function withinHours(weeklyHours: readonly OpeningPeriod[], local: CairoLocal): boolean {
  const minuteOfDay = local.hour * 60 + local.minute;
  return weeklyHours.some((period) => period.weekday === local.weekday && period.opensMinute <= minuteOfDay && minuteOfDay < period.closesMinute);
}

function covers(event: SpecialEvent, local: LocalDateTime): boolean {
  const key = sortKey(local);
  return sortKey(event.from) <= key && key < sortKey(event.until);
}

/** One number that orders local date-times: 2026-11-20 18:30 becomes 202611201830. */
function sortKey(local: LocalDateTime): number {
  return (((local.year * 100 + local.month) * 100 + local.day) * 100 + local.hour) * 100 + local.minute;
}

function isRealLocalDateTime(local: LocalDateTime): boolean {
  const asUtc = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute));
  return (
    [local.year, local.month, local.day, local.hour, local.minute].every(Number.isInteger) &&
    asUtc.getUTCFullYear() === local.year &&
    asUtc.getUTCMonth() === local.month - 1 &&
    asUtc.getUTCDate() === local.day &&
    asUtc.getUTCHours() === local.hour &&
    asUtc.getUTCMinutes() === local.minute
  );
}
