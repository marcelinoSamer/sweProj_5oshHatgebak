import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/clock';
import type { DistrictId, PersonId, SiteId, ZoneId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { Authorization, Scope } from '../../accounts-and-access-control/public';
import type {
  CapacityChange,
  GeoPoint,
  LocalDateTime,
  OpeningPeriod,
  PlaceRefusal,
  SiteCodeRefusal,
  SiteDetails,
  SiteRegistry,
  SiteStatus,
  SpecialEventKind,
} from '../public';
import { validCapacity, validLabel, validOutline, validReason } from './domain/places';
import { statusAt, validEventPeriod, validWeeklyHours } from './domain/site-calendar';
import { PlacesLocator } from './places-locator';
import type { CapacityStore, PlacesStore, SiteCalendarStore } from './ports';
import type { SiteCodesService } from './site-codes-service';

export interface SiteRegistryDependencies {
  readonly places: PlacesStore;
  readonly capacity: CapacityStore;
  readonly calendar: SiteCalendarStore;
  readonly authorization: Authorization;
  readonly codes: SiteCodesService;
  readonly clock: Clock;
}

const INITIAL_CAPACITY_REASON = 'capacity when the site was created';

/**
 * Districts, zones and sites (task A6). Only the Chair creates a district; only a member of that district, or the
 * Chair, creates or edits anything inside it. The audit entry for each change is written by the entry point's
 * pipeline when the change arrives as a request.
 */
export class SiteRegistryService implements SiteRegistry {
  private readonly locator: PlacesLocator;

  constructor(private readonly dependencies: SiteRegistryDependencies) {
    this.locator = new PlacesLocator(dependencies.places);
  }

  async createDistrict(actor: PersonId, label: string): Promise<Result<DistrictId, PlaceRefusal>> {
    const checkedLabel = validLabel(label);
    if (!checkedLabel.ok) {
      return checkedLabel;
    }
    if (!(await this.permitted(actor, 'sites.createDistrict', {}))) {
      return fail('not allowed here');
    }
    const districtId = `district-${randomUUID()}`;
    await this.dependencies.places.addDistrict({ districtId, label: checkedLabel.value });
    return succeed(districtId);
  }

  async relabelDistrict(actor: PersonId, districtId: DistrictId, label: string): Promise<Result<void, PlaceRefusal>> {
    const checkedLabel = validLabel(label);
    if (!checkedLabel.ok) {
      return checkedLabel;
    }
    if ((await this.dependencies.places.district(districtId)) === undefined) {
      return fail('unknown district');
    }
    if (!(await this.permitted(actor, 'sites.relabelDistrict', { districtId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.places.relabelDistrict(districtId, checkedLabel.value);
    return succeed(undefined);
  }

  async createZone(actor: PersonId, districtId: DistrictId, label: string): Promise<Result<ZoneId, PlaceRefusal>> {
    const checkedLabel = validLabel(label);
    if (!checkedLabel.ok) {
      return checkedLabel;
    }
    if ((await this.dependencies.places.district(districtId)) === undefined) {
      return fail('unknown district');
    }
    if (!(await this.permitted(actor, 'sites.createZone', { districtId }))) {
      return fail('not allowed here');
    }
    const zoneId = `zone-${randomUUID()}`;
    await this.dependencies.places.addZone({ zoneId, districtId, label: checkedLabel.value });
    return succeed(zoneId);
  }

  async relabelZone(actor: PersonId, zoneId: ZoneId, label: string): Promise<Result<void, PlaceRefusal>> {
    const checkedLabel = validLabel(label);
    if (!checkedLabel.ok) {
      return checkedLabel;
    }
    if ((await this.dependencies.places.zone(zoneId)) === undefined) {
      return fail('unknown zone');
    }
    if (!(await this.permitted(actor, 'sites.relabelZone', { zoneId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.places.relabelZone(zoneId, checkedLabel.value);
    return succeed(undefined);
  }

  async createSite(
    actor: PersonId,
    zoneId: ZoneId,
    label: string,
    outline: readonly GeoPoint[],
    capacity: number,
  ): Promise<Result<SiteId, PlaceRefusal>> {
    const checked = validSiteFields(label, outline, capacity);
    if (!checked.ok) {
      return checked;
    }
    if ((await this.dependencies.places.zone(zoneId)) === undefined) {
      return fail('unknown zone');
    }
    if (!(await this.permitted(actor, 'sites.createSite', { zoneId }))) {
      return fail('not allowed here');
    }
    const siteId = `site-${randomUUID()}`;
    await this.dependencies.places.addSite({ siteId, zoneId, label: checked.value.label, outline: checked.value.outline });
    await this.dependencies.capacity.append({
      siteId,
      capacity: checked.value.capacity,
      reason: INITIAL_CAPACITY_REASON,
      changedBy: actor,
      changedAt: this.dependencies.clock.now().toISOString(),
    });
    return succeed(siteId);
  }

  async replaceSiteOutline(actor: PersonId, siteId: SiteId, outline: readonly GeoPoint[]): Promise<Result<void, PlaceRefusal>> {
    const checkedOutline = validOutline(outline);
    if (!checkedOutline.ok) {
      return checkedOutline;
    }
    if ((await this.dependencies.places.site(siteId)) === undefined) {
      return fail('unknown site');
    }
    if (!(await this.permitted(actor, 'sites.replaceOutline', { siteId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.places.replaceOutline(siteId, checkedOutline.value);
    return succeed(undefined);
  }

  async changeCapacity(actor: PersonId, siteId: SiteId, capacity: number, reason: string): Promise<Result<void, PlaceRefusal>> {
    const checkedReason = validReason(reason);
    if (!checkedReason.ok) {
      return checkedReason;
    }
    const checkedCapacity = validCapacity(capacity);
    if (!checkedCapacity.ok) {
      return checkedCapacity;
    }
    if ((await this.dependencies.places.site(siteId)) === undefined) {
      return fail('unknown site');
    }
    if (!(await this.permitted(actor, 'sites.changeCapacity', { siteId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.capacity.append({
      siteId,
      capacity: checkedCapacity.value,
      reason: checkedReason.value,
      changedBy: actor,
      changedAt: this.dependencies.clock.now().toISOString(),
    });
    return succeed(undefined);
  }

  async capacityHistory(siteId: SiteId): Promise<readonly CapacityChange[]> {
    const history = await this.dependencies.capacity.historyOf(siteId);
    return history.map(({ capacity, reason, changedBy, changedAt }) => ({ capacity, reason, changedBy, changedAt }));
  }

  async setWeeklyHours(actor: PersonId, siteId: SiteId, periods: readonly OpeningPeriod[]): Promise<Result<void, PlaceRefusal>> {
    const checkedHours = validWeeklyHours(periods);
    if (!checkedHours.ok) {
      return checkedHours;
    }
    if ((await this.dependencies.places.site(siteId)) === undefined) {
      return fail('unknown site');
    }
    if (!(await this.permitted(actor, 'sites.setWeeklyHours', { siteId }))) {
      return fail('not allowed here');
    }
    await this.dependencies.calendar.replaceWeeklyHours(siteId, checkedHours.value);
    return succeed(undefined);
  }

  async declareSpecialEvent(
    actor: PersonId,
    siteId: SiteId,
    kind: SpecialEventKind,
    from: LocalDateTime,
    until: LocalDateTime,
    reason: string,
  ): Promise<Result<string, PlaceRefusal>> {
    const checkedReason = validReason(reason);
    if (!checkedReason.ok) {
      return checkedReason;
    }
    const checkedPeriod = validEventPeriod(from, until);
    if (!checkedPeriod.ok) {
      return checkedPeriod;
    }
    if ((await this.dependencies.places.site(siteId)) === undefined) {
      return fail('unknown site');
    }
    if (!(await this.permitted(actor, 'sites.declareSpecialEvent', { siteId }))) {
      return fail('not allowed here');
    }
    const eventId = `event-${randomUUID()}`;
    await this.dependencies.calendar.addEvent({
      eventId,
      siteId,
      kind,
      from,
      until,
      reason: checkedReason.value,
      declaredBy: actor,
      declaredAt: this.dependencies.clock.now().toISOString(),
    });
    return succeed(eventId);
  }

  async isOpenAt(siteId: SiteId, moment: Date): Promise<boolean> {
    return (await this.statusAt(siteId, moment))?.open ?? false;
  }

  async statusAt(siteId: SiteId, moment: Date): Promise<SiteStatus | undefined> {
    if ((await this.dependencies.places.site(siteId)) === undefined) {
      return undefined;
    }
    const [weeklyHours, events] = await Promise.all([this.dependencies.calendar.weeklyHours(siteId), this.dependencies.calendar.eventsOf(siteId)]);
    return statusAt(moment, weeklyHours, events);
  }

  async districtExists(districtId: DistrictId): Promise<boolean> {
    return (await this.dependencies.places.district(districtId)) !== undefined;
  }

  async siteDetails(siteId: SiteId): Promise<SiteDetails | undefined> {
    const site = await this.dependencies.places.site(siteId);
    const zone = site === undefined ? undefined : await this.dependencies.places.zone(site.zoneId);
    const capacity = await this.capacityOf(siteId);
    if (site === undefined || zone === undefined || capacity === undefined) {
      return undefined;
    }
    return { ...site, districtId: zone.districtId, capacity };
  }

  async capacityOf(siteId: SiteId): Promise<number | undefined> {
    const history = await this.dependencies.capacity.historyOf(siteId);
    return history[history.length - 1]?.capacity;
  }

  locateSite(siteId: SiteId): Promise<{ readonly zoneId: ZoneId; readonly districtId: DistrictId } | undefined> {
    return this.locator.locateSite(siteId);
  }

  locateZone(zoneId: ZoneId): Promise<{ readonly districtId: DistrictId } | undefined> {
    return this.locator.locateZone(zoneId);
  }

  async issueEntryAndExitCodes(siteId: SiteId): Promise<{ entryCode: string; exitCode: string }> {
    if ((await this.dependencies.places.site(siteId)) === undefined) {
      throw new Error(`Cannot issue codes for the unknown site ${siteId}`);
    }
    return this.dependencies.codes.issueEntryAndExitCodes(siteId);
  }

  verifyEntryCode(code: string, siteId: SiteId): Promise<Result<SiteId, SiteCodeRefusal>> {
    return this.dependencies.codes.verifyEntryCode(code, siteId);
  }

  verifyExitCode(code: string, siteId: SiteId): Promise<Result<SiteId, SiteCodeRefusal>> {
    return this.dependencies.codes.verifyExitCode(code, siteId);
  }

  private permitted(actor: PersonId, operation: string, scope: Scope): Promise<boolean> {
    return this.dependencies.authorization.may(actor, operation, scope);
  }
}

function validSiteFields(
  label: string,
  outline: readonly GeoPoint[],
  capacity: number,
): Result<{ label: string; outline: readonly GeoPoint[]; capacity: number }, PlaceRefusal> {
  const checkedLabel = validLabel(label);
  if (!checkedLabel.ok) {
    return checkedLabel;
  }
  const checkedOutline = validOutline(outline);
  if (!checkedOutline.ok) {
    return checkedOutline;
  }
  const checkedCapacity = validCapacity(capacity);
  if (!checkedCapacity.ok) {
    return checkedCapacity;
  }
  return succeed({ label: checkedLabel.value, outline: checkedOutline.value, capacity: checkedCapacity.value });
}
