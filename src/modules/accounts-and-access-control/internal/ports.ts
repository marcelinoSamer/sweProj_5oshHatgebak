import type { DistrictId, PersonId, SiteId, ZoneId } from '../../../shared/identifiers';
import type { AccountStatus, CarRef, LicenceLiveState } from '../public';
import type { PasswordHash } from './domain/password';
import type { Person } from './domain/person';

/**
 * Storage ports owned by this module. The in-memory adapters in `adapters/` implement them for every test; the
 * PostgreSQL adapters will implement the same ports over the tables in `db/migrations/0002_identity_and_registry.sql`.
 */

/** The `accounts_and_access_control.people` table: references, roles and statuses only. */
export interface PeopleStore {
  add(person: Person): Promise<void>;
  find(personId: PersonId): Promise<Person | undefined>;
  setStatus(personId: PersonId, status: AccountStatus): Promise<void>;
  markErased(personId: PersonId): Promise<void>;
}

/** A person's name and phone, held only in the `personal_data` schema. */
export interface PersonDetails {
  readonly personRef: PersonId;
  readonly displayName: string;
  readonly phone: string;
}

/** A car and its plate, held only in the `personal_data` schema. */
export interface CarRecord {
  readonly carRef: CarRef;
  readonly ownerRef: PersonId;
  readonly plate: string;
}

/** Rows removed from each personal-data table by one erasure (task A5). */
export interface ErasedRows {
  readonly personDetails: number;
  readonly cars: number;
}

/** The `personal_data` schema. Nothing outside this port stores a name, a phone or a plate (Rule F, F10). */
export interface PersonalDataStore {
  addDetails(details: PersonDetails): Promise<void>;
  detailsOf(personRef: PersonId): Promise<PersonDetails | undefined>;
  personWithPhone(phone: string): Promise<PersonId | undefined>;
  addCar(car: CarRecord): Promise<void>;
  car(carRef: CarRef): Promise<CarRecord | undefined>;
  carsOf(ownerRef: PersonId): Promise<readonly CarRecord[]>;
  eraseEverythingAbout(personRef: PersonId): Promise<ErasedRows>;
}

/**
 * What this module knows about a person's licence and posts, recorded by the licensing module inside its own
 * transaction (Rule D: this must-stay-on module never calls the may-fail licensing module). Plus the site the
 * attendant's session is bound to at clock-in.
 */
export interface AccessFactsRow {
  readonly personId: PersonId;
  readonly licenceState?: LicenceLiveState;
  readonly attendantSiteId?: SiteId;
  readonly inspectorZoneId?: ZoneId;
  readonly memberDistrictId?: DistrictId;
  readonly boundSiteId?: SiteId;
}

/** The `accounts_and_access_control.access_facts` table: one row per person, replaced field by field. */
export interface AccessFactsStore {
  factsOf(personId: PersonId): Promise<AccessFactsRow>;
  update(personId: PersonId, change: (current: AccessFactsRow) => AccessFactsRow): Promise<void>;
  remove(personId: PersonId): Promise<number>;
}

/**
 * One outstanding one-time code for one person (task A1). Only the code's hash is kept. Times come from the server
 * clock. A lock-out survives a new code request until it ends.
 */
export interface SignInChallenge {
  readonly personId: PersonId;
  readonly codeHash: string;
  readonly expiresAt: string;
  readonly failedAttempts: number;
  readonly lockedUntil?: string;
}

/** The `accounts_and_access_control.sign_in_challenges` table: at most one row per person. */
export interface SignInChallengeStore {
  find(personId: PersonId): Promise<SignInChallenge | undefined>;
  save(challenge: SignInChallenge): Promise<void>;
  remove(personId: PersonId): Promise<number>;
}

/** The `accounts_and_access_control.committee_passwords` table: a salted scrypt hash per member or Chair. */
export interface CommitteePasswordStore {
  find(personId: PersonId): Promise<PasswordHash | undefined>;
  save(personId: PersonId, password: PasswordHash): Promise<void>;
  remove(personId: PersonId): Promise<number>;
}
