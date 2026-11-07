import { randomUUID } from 'node:crypto';
import type { AuditTrail } from '../../audit-log/public';
import type { PersonId, Role } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type {
  Authorization,
  CarRef,
  CarRefusal,
  CreatePersonRefusal,
  ErasureRefusal,
  ErasureReport,
  OwnCar,
  PersonalData,
  PersonCreator,
  PlateReadRefusal,
  PlateReadRequest,
  SiteLocator,
} from '../public';
import { mayCreate, normaliseDisplayName, normalisePhone, normalisePlate } from './domain/person';
import { roleMayReadPlateFor } from './domain/plate-access';
import type { AccessFactsStore, CommitteePasswordStore, PeopleStore, PersonalDataStore, SignInChallengeStore } from './ports';

export interface PersonalDataDependencies {
  readonly people: PeopleStore;
  readonly personalData: PersonalDataStore;
  readonly signInChallenges: SignInChallengeStore;
  readonly committeePasswords: CommitteePasswordStore;
  readonly accessFacts: AccessFactsStore;
  readonly authorization: Authorization;
  readonly siteLocator: SiteLocator;
  /** The audit trail outside any request's transaction: a plate read is a read, yet it must leave an entry. */
  readonly audit: AuditTrail;
}

export const PLATE_READ_OPERATION = 'personalData.readPlate';

/**
 * Creates people and their cars and keeps their personal data apart: roles and statuses go to the people table, names,
 * phones and plates go to the personal-data store, joined only by references (ADR-06, Rule F). A plate leaves this
 * module only through readPlate, which checks the reader and writes a "plate read" audit entry first.
 */
export class PersonalDataService implements PersonalData {
  constructor(private readonly dependencies: PersonalDataDependencies) {}

  async createPerson(
    creator: PersonCreator,
    role: Role,
    phone: string,
    displayName: string,
  ): Promise<Result<PersonId, CreatePersonRefusal>> {
    const creatorRole = creator === 'self registration' ? undefined : (await this.dependencies.people.find(creator))?.role;
    const permitted = mayCreate(creator, creatorRole, role);
    if (!permitted.ok) {
      return permitted;
    }
    return this.register(role, phone, displayName);
  }

  /** The one-time set-up of the first Chair, run by the system operator, never reachable through a request. */
  async bootstrapChair(phone: string, displayName: string): Promise<Result<PersonId, CreatePersonRefusal>> {
    return this.register('chair', phone, displayName);
  }

  /** Saving the same plate twice for one driver returns the car already saved. */
  async addCar(driverId: PersonId, plate: string): Promise<Result<CarRef, CarRefusal>> {
    const driver = await this.dependencies.people.find(driverId);
    if (driver?.role !== 'driver' || driver.erased) {
      return fail('not a driver');
    }
    const normalisedPlate = normalisePlate(plate);
    if (!normalisedPlate.ok) {
      return normalisedPlate;
    }
    const existing = (await this.dependencies.personalData.carsOf(driverId)).find((car) => car.plate === normalisedPlate.value);
    if (existing !== undefined) {
      return succeed(existing.carRef);
    }
    const carRef = `car-${randomUUID()}`;
    await this.dependencies.personalData.addCar({ carRef, ownerRef: driverId, plate: normalisedPlate.value });
    return succeed(carRef);
  }

  /** The driver's own cars, for the driver's own screen: the person the data is about reading it. */
  async ownCars(driverId: PersonId): Promise<readonly OwnCar[]> {
    const cars = await this.dependencies.personalData.carsOf(driverId);
    return cars.map(({ carRef, plate }) => ({ carRef, plate }));
  }

  async readPlate(request: PlateReadRequest): Promise<Result<string, PlateReadRefusal>> {
    const car = await this.dependencies.personalData.car(request.carRef);
    if (car === undefined) {
      return fail('not resolvable');
    }
    const readerRole = await this.dependencies.authorization.roleOf(request.reader);
    if (readerRole === undefined || !(await this.mayRead(request, readerRole, car.ownerRef))) {
      return fail('refused');
    }
    const districtId = (await this.dependencies.siteLocator.locateSite(request.siteId))?.districtId;
    await this.dependencies.audit.append({
      personId: request.reader,
      role: readerRole,
      operation: PLATE_READ_OPERATION,
      input: { carRef: request.carRef, purpose: request.purpose, siteId: request.siteId },
      requestId: `plate-read-${randomUUID()}`,
      subjectPersonIds: [car.ownerRef],
      ...(districtId === undefined ? {} : { districtId }),
    });
    return succeed(car.plate);
  }

  /**
   * Erasure (task A5, Law 151 of 2020): the person's name, phone, cars and plates are deleted, with their sign-in code
   * and access facts. The person reference stays, marked erased, so their tickets and audit entries remain whole while
   * nothing resolves to a human being any more. A driver erases themself; the Chair erases anyone but a Chair.
   */
  async erase(actor: PersonId, personId: PersonId): Promise<Result<ErasureReport, ErasureRefusal>> {
    const person = await this.dependencies.people.find(personId);
    if (person === undefined) {
      return fail('unknown person');
    }
    if (person.erased) {
      return fail('already erased');
    }
    const actorRole = await this.dependencies.authorization.roleOf(actor);
    const erasingThemself = actor === personId && person.role === 'driver';
    if (!erasingThemself && (actorRole !== 'chair' || person.role === 'chair')) {
      return fail('not allowed');
    }
    const personalRows = await this.dependencies.personalData.eraseEverythingAbout(personId);
    const challengeRows = await this.dependencies.signInChallenges.remove(personId);
    const accessFactRows = await this.dependencies.accessFacts.remove(personId);
    const passwordRows = await this.dependencies.committeePasswords.remove(personId);
    await this.dependencies.people.markErased(personId);
    return succeed({
      rowsRemoved: {
        'personal_data.person_details': personalRows.personDetails,
        'personal_data.cars': personalRows.cars,
        'accounts_and_access_control.sign_in_challenges': challengeRows,
        'accounts_and_access_control.access_facts': accessFactRows,
        'accounts_and_access_control.committee_passwords': passwordRows,
      },
      rowsMarked: { 'accounts_and_access_control.people': 1 },
    });
  }

  private async mayRead(request: PlateReadRequest, readerRole: Role, ownerRef: PersonId): Promise<boolean> {
    if (request.reader === ownerRef) {
      return (await this.dependencies.authorization.liveStatus(request.reader)) === 'active';
    }
    if (!roleMayReadPlateFor(readerRole, request.purpose)) {
      return false;
    }
    return this.dependencies.authorization.may(request.reader, PLATE_READ_OPERATION, { siteId: request.siteId });
  }

  private async register(role: Role, phone: string, displayName: string): Promise<Result<PersonId, CreatePersonRefusal>> {
    const normalisedPhone = normalisePhone(phone);
    if (!normalisedPhone.ok) {
      return normalisedPhone;
    }
    const normalisedName = normaliseDisplayName(displayName);
    if (!normalisedName.ok) {
      return normalisedName;
    }
    if ((await this.dependencies.personalData.personWithPhone(normalisedPhone.value)) !== undefined) {
      return fail('phone already registered');
    }
    const personId = `person-${randomUUID()}`;
    await this.dependencies.people.add({ personId, role, status: 'active', erased: false });
    await this.dependencies.personalData.addDetails({
      personRef: personId,
      displayName: normalisedName.value,
      phone: normalisedPhone.value,
    });
    return succeed(personId);
  }
}
