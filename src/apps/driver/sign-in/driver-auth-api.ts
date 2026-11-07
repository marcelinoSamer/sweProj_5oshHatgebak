/**
 * The Driver App's view of sign-in and cars. The real adapter calls the main system over HTTP
 * (`http-driver-auth-api.ts`); tests that need no server use the in-memory stand-in.
 *
 * The refusal names are Teammate A's, copied from `SignInRefusal` and `CarRefusal` in the accounts module's
 * public interface. The app only carries them to the screen; it never decides them (Rule A).
 */
import type { PersonId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';

export interface SignInSuccess {
  readonly driverId: PersonId;
  readonly token: string;
}

/** "wrong code" also answers an unknown phone, so the screen never reveals who is registered. */
export type SignInRefusal = 'wrong code' | 'locked' | 'code expired' | 'account not live';
export type SaveCarRefusal = 'invalid plate' | 'not a driver';
/** "not signed in": the server did not accept the token, so the app must show the sign-in screen again. */
export type DriverAuthRefusal = SignInRefusal | SaveCarRefusal | 'not signed in';

export const SIGN_IN_REFUSALS: readonly SignInRefusal[] = ['wrong code', 'locked', 'code expired', 'account not live'];
export const SAVE_CAR_REFUSALS: readonly SaveCarRefusal[] = ['invalid plate', 'not a driver'];

export function isSignInRefusal(candidate: unknown): candidate is SignInRefusal {
  return typeof candidate === 'string' && (SIGN_IN_REFUSALS as readonly string[]).includes(candidate);
}

export function isSaveCarRefusal(candidate: unknown): candidate is SaveCarRefusal {
  return typeof candidate === 'string' && (SAVE_CAR_REFUSALS as readonly string[]).includes(candidate);
}

/** The connection dropped before an answer arrived: the write may or may not have happened. Retry with the same id. */
export class DriverAuthTransportError extends Error {
  constructor(message = 'connection lost before the answer arrived') {
    super(message);
    this.name = 'DriverAuthTransportError';
  }
}

/** The server answered and said no. Nothing was changed. */
export class DriverAuthRefusedError extends Error {
  readonly refusal: DriverAuthRefusal;

  constructor(refusal: DriverAuthRefusal) {
    super(refusal);
    this.name = 'DriverAuthRefusedError';
    this.refusal = refusal;
  }
}

export interface DriverAuthApi {
  requestCode(phone: string, requestId: RequestId): Promise<void>;
  signIn(phone: string, code: string, requestId: RequestId): Promise<SignInSuccess>;
  /** Saves the plate, then returns the driver's plates exactly as the server stores them. */
  saveCar(plate: string, requestId: RequestId): Promise<readonly string[]>;
  listCars(): Promise<readonly string[]>;
}