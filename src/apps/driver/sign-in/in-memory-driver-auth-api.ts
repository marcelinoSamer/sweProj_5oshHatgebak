/**
 * In-memory stand-in for driver sign-in and cars while Teammate A's A1/A4 entry-point routes are not ready.
 * Tests and local prototypes only — not the accounts module.
 */
import { signToken } from '../../../entrypoint/auth/token';
import type { PersonId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import { DriverAuthRefusedError, type DriverAuthApi, type SignInSuccess } from './driver-auth-api';


export interface InMemoryDriverAuthApiOptions {
  readonly tokenSecret: string;
  /** Expected one-time codes keyed by phone. Missing phones get `driver-code-<phone>`. */
  readonly codes?: ReadonlyMap<string, string>;
}

export class InMemoryDriverAuthApi implements DriverAuthApi {
  private readonly tokenSecret: string;
  private readonly codes: Map<string, string>;
  private readonly requestCodeResponses = new Map<RequestId, true>();
  private readonly signInResponses = new Map<RequestId, SignInSuccess>();
  private readonly saveCarResponses = new Map<RequestId, readonly string[]>();
  private readonly carsByDriver = new Map<PersonId, string[]>();
  private readonly driverByPhone = new Map<string, PersonId>();
  private currentDriverId: PersonId | undefined;

  constructor(options: InMemoryDriverAuthApiOptions) {
    this.tokenSecret = options.tokenSecret;
    this.codes = new Map(options.codes ?? []);
  }

  async requestCode(phone: string, requestId: RequestId): Promise<void> {
    if (this.requestCodeResponses.has(requestId)) {
      return;
    }
    this.requestCodeResponses.set(requestId, true);
    if (!this.codes.has(phone)) {
      this.codes.set(phone, `driver-code-${phone}`);
    }
  }

  async signIn(phone: string, code: string, requestId: RequestId): Promise<SignInSuccess> {
    const known = this.signInResponses.get(requestId);
    if (known !== undefined) {
      this.currentDriverId = known.driverId;
      return known;
    }

    const expected = this.codes.get(phone) ?? `driver-code-${phone}`;
    if (code !== expected) {
      throw new DriverAuthRefusedError('wrong code');
    }

    let driverId = this.driverByPhone.get(phone);
    if (driverId === undefined) {
      driverId = `driver-${phone}`;
      this.driverByPhone.set(phone, driverId);
    }

    const token = signToken({ personId: driverId, role: 'driver' }, this.tokenSecret);
    const success: SignInSuccess = { driverId, token };
    this.signInResponses.set(requestId, success);
    this.currentDriverId = driverId;
    return success;
  }

  async saveCar(plate: string, requestId: RequestId): Promise<readonly string[]> {
    const known = this.saveCarResponses.get(requestId);
    if (known !== undefined) {
      return known;
    }

    const driverId = this.currentDriverId;
    if (driverId === undefined) {
      throw new DriverAuthRefusedError('not signed in');
    }

    const existing = this.carsByDriver.get(driverId) ?? [];
    if (existing.includes(plate)) {
      const cars = [...existing];
      this.saveCarResponses.set(requestId, cars);
      return cars;
    }

    const cars = [...existing, plate];
    this.carsByDriver.set(driverId, cars);
    this.saveCarResponses.set(requestId, cars);
    return cars;
  }

  async listCars(): Promise<readonly string[]> {
    const driverId = this.currentDriverId;
    if (driverId === undefined) {
      throw new DriverAuthRefusedError('not signed in');
    }
    return [...(this.carsByDriver.get(driverId) ?? [])];
  }
}
