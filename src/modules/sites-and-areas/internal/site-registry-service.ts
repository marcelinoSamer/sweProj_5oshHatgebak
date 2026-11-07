import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/clock';
import type { DistrictId, PersonId, SiteId, ZoneId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { Authorization, Scope } from '../../accounts-and-access-control/public';
import type { GeoPoint, PlaceRefusal, SiteCodeRefusal, SiteDetails, SiteRegistry } from '../public';
import { validCapacity, validLabel, validOutline } from './domain/places';
import { PlacesLocator } from './places-locator';
import type { CapacityStore, PlacesStore } from './ports';
import type { SiteCodesService } from './site-codes-service';

export interface SiteRegistryDependencies {
  readonly places: PlacesStore;
  readonly capacity: CapacityStore;
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
