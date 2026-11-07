/**
 * Driver App sign-in and cars client (task D1).
 * Collects the phone number, then the code (two taps), then can save a plate. Every decision stays on the server
 * (Rule A): the client shows the server's refusal and never judges a code or a plate itself.
 *
 * Every write keeps its request id until the answer arrives (Rule 2), so after a lost connection the retry carries the
 * same id and the server answers once. The id is kept only while the retry is for the same input: a different phone,
 * code or plate is a different request and gets a new id.
 */
import type { PersonId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import {
  DriverAuthRefusedError,
  DriverAuthTransportError,
  type DriverAuthApi,
  type DriverAuthRefusal,
  type SignInSuccess,
} from './driver-auth-api';

export type DriverSignInClientSuccess<T> = { readonly ok: true; readonly value: T };
export type DriverSignInClientFailure =
  /** A write carries the id the retry will reuse; a read has none. */
  | { readonly ok: false; readonly error: 'connection lost'; readonly requestId?: RequestId }
  | { readonly ok: false; readonly error: DriverAuthRefusal };

export type DriverSignInClientResult<T> = DriverSignInClientSuccess<T> | DriverSignInClientFailure;

export interface DriverSignInClientOptions {
  readonly api: DriverAuthApi;
  readonly createRequestId: () => RequestId;
}

/** One write that has been sent and not yet answered, with the input it was sent for. */
interface PendingRequest {
  readonly input: string;
  readonly requestId: RequestId;
}

export class DriverSignInClient {
  private readonly api: DriverAuthApi;
  private readonly createRequestId: () => RequestId;
  private taps = 0;
  private phone: string | undefined;
  private session: SignInSuccess | undefined;
  private pendingCode: PendingRequest | undefined;
  private pendingSignIn: PendingRequest | undefined;
  private pendingCar: PendingRequest | undefined;

  constructor(options: DriverSignInClientOptions) {
    this.api = options.api;
    this.createRequestId = options.createRequestId;
  }

  /** How many taps the driver has made on the sign-in flow so far (D1 report: 2 on the way in with the right code). */
  tapsToSignIn(): number {
    return this.taps;
  }

  driverId(): PersonId | undefined {
    return this.session?.driverId;
  }

  token(): string | undefined {
    return this.session?.token;
  }

  isSignedIn(): boolean {
    return this.session !== undefined;
  }

  /** The request id kept for an unanswered sign-in code request, for tests and for the "try again" screen. */
  pendingCodeRequestId(): RequestId | undefined {
    return this.pendingCode?.requestId;
  }

  pendingSignInRequestId(): RequestId | undefined {
    return this.pendingSignIn?.requestId;
  }

  pendingCarRequestId(): RequestId | undefined {
    return this.pendingCar?.requestId;
  }

  /** First tap: submit the phone number so the server can send a one-time code. */
  async submitPhone(phone: string): Promise<DriverSignInClientResult<void>> {
    this.taps += 1;
    this.phone = phone;
    const pending = this.keepOrCreate(this.pendingCode, phone);
    this.pendingCode = pending;

    try {
      await this.api.requestCode(phone, pending.requestId);
      this.pendingCode = undefined;
      return { ok: true, value: undefined };
    } catch (error) {
      if (error instanceof DriverAuthTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingCode = undefined;
      return this.refusalOrRethrow(error);
    }
  }

  /** Second tap: submit the one-time code. On success the driver is signed in. */
  async submitCode(code: string): Promise<DriverSignInClientResult<SignInSuccess>> {
    const phone = this.phone;
    if (phone === undefined) {
      throw new Error('submit the phone number before the code');
    }

    this.taps += 1;
    const pending = this.keepOrCreate(this.pendingSignIn, `${phone}\u0000${code}`);
    this.pendingSignIn = pending;

    try {
      const session = await this.api.signIn(phone, code, pending.requestId);
      this.session = session;
      this.pendingSignIn = undefined;
      return { ok: true, value: session };
    } catch (error) {
      if (error instanceof DriverAuthTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingSignIn = undefined;
      return this.refusalOrRethrow(error);
    }
  }

  /** Save a plate for the signed-in driver; the server returns the driver's plates as it stores them. */
  async addCar(plate: string): Promise<DriverSignInClientResult<readonly string[]>> {
    if (this.session === undefined) {
      return { ok: false, error: 'not signed in' };
    }

    const pending = this.keepOrCreate(this.pendingCar, plate);
    this.pendingCar = pending;

    try {
      const cars = await this.api.saveCar(plate, pending.requestId);
      this.pendingCar = undefined;
      return { ok: true, value: cars };
    } catch (error) {
      if (error instanceof DriverAuthTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingCar = undefined;
      return this.refusalOrRethrow(error);
    }
  }

  async listCars(): Promise<DriverSignInClientResult<readonly string[]>> {
    if (this.session === undefined) {
      return { ok: false, error: 'not signed in' };
    }

    try {
      return { ok: true, value: await this.api.listCars() };
    } catch (error) {
      if (error instanceof DriverAuthTransportError) {
        return { ok: false, error: 'connection lost' };
      }
      return this.refusalOrRethrow(error);
    }
  }

  /** The id of an unanswered request for the same input, or a new one. */
  private keepOrCreate(existing: PendingRequest | undefined, input: string): PendingRequest {
    return existing?.input === input ? existing : { input, requestId: this.createRequestId() };
  }

  /** A refusal from the server goes to the screen; anything else is a fault and is not hidden. */
  private refusalOrRethrow(error: unknown): DriverSignInClientFailure {
    if (error instanceof DriverAuthRefusedError) {
      if (error.refusal === 'not signed in') {
        this.session = undefined;
      }
      return { ok: false, error: error.refusal };
    }
    throw error;
  }
}