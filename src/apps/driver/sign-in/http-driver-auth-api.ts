/**
 * DriverAuthApi adapter: the Driver App talks to the main system only through the HTTP entry point.
 * No sign-in or car rules here: status codes and bodies from the server are mapped to results, refusals or
 * transport errors. The refusal is read from the answer's `error` text, never from the status code alone, because
 * the status codes of the sign-in routes are not settled yet.
 */
import type { HttpMethod, HttpRequest, HttpResponse } from '../../../entrypoint/http';
import { REQUEST_ID_HEADER, type RequestId } from '../../../shared/request-id';
import {
  DriverAuthRefusedError,
  DriverAuthTransportError,
  isSaveCarRefusal,
  isSignInRefusal,
  type DriverAuthApi,
  type SignInSuccess,
} from './driver-auth-api';
import { DRIVER_CARS_PATH, DRIVER_REQUEST_CODE_PATH, DRIVER_SIGN_IN_PATH } from './driver-auth-routes';

export type EntryPointHandle = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpDriverAuthApiOptions {
  readonly handle: EntryPointHandle;
  /**
   * Test hook: after a successful server answer to a write, drop this many answers so the client must retry with
   * the same request id (airplane mode after the server applied the write).
   */
  readonly dropSuccessfulAnswers?: { remaining: number };
}

interface SendOptions {
  readonly requestId?: RequestId;
  readonly signedIn: boolean;
  readonly body?: Record<string, string>;
}

export class HttpDriverAuthApi implements DriverAuthApi {
  private readonly handle: EntryPointHandle;
  private readonly dropSuccessfulAnswers: { remaining: number };
  /** The token from the last sign-in. The server checks it on every call; the app only carries it. */
  private token: string | undefined;

  constructor(options: HttpDriverAuthApiOptions) {
    this.handle = options.handle;
    this.dropSuccessfulAnswers = options.dropSuccessfulAnswers ?? { remaining: 0 };
  }

  async requestCode(phone: string, requestId: RequestId): Promise<void> {
    const response = await this.send('POST', DRIVER_REQUEST_CODE_PATH, {
      requestId,
      signedIn: false,
      body: { phone },
    });
    if (response.status >= 400) {
      throw new Error(errorMessage(response));
    }
  }

  async signIn(phone: string, code: string, requestId: RequestId): Promise<SignInSuccess> {
    const response = await this.send('POST', DRIVER_SIGN_IN_PATH, {
      requestId,
      signedIn: false,
      body: { phone, code },
    });
    if (response.status >= 400) {
      const reason = errorMessage(response);
      throw isSignInRefusal(reason) ? new DriverAuthRefusedError(reason) : new Error(reason);
    }
    const token = requiredString(asRecord(response.body), 'token');
    const session = { driverId: personIdFromToken(token), token };
    this.token = token;
    return session;
  }

  async saveCar(plate: string, requestId: RequestId): Promise<readonly string[]> {
    const response = await this.send('POST', DRIVER_CARS_PATH, {
      requestId,
      signedIn: true,
      body: { plate },
    });
    if (response.status >= 400) {
      throw carRefusal(response);
    }
    requiredString(asRecord(response.body), 'carRef');
    return this.listCars();
  }

  async listCars(): Promise<readonly string[]> {
    const response = await this.send('GET', DRIVER_CARS_PATH, { signedIn: true });
    if (response.status >= 400) {
      throw carRefusal(response);
    }
    const cars = asRecord(response.body)['cars'];
    if (!Array.isArray(cars)) {
      throw new Error('server answer missing cars');
    }
    return cars.map((car) => requiredString(asRecord(car), 'plate'));
  }

  private async send(method: HttpMethod, path: string, options: SendOptions): Promise<HttpResponse> {
    const headers: Record<string, string> = {};
    if (options.signedIn) {
      if (this.token === undefined) {
        throw new DriverAuthRefusedError('not signed in');
      }
      headers['authorization'] = `Bearer ${this.token}`;
    }
    if (options.requestId !== undefined) {
      headers[REQUEST_ID_HEADER] = options.requestId;
    }

    let response: HttpResponse;
    try {
      response = await this.handle({
        method,
        path,
        query: {},
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (error) {
      if (error instanceof DriverAuthTransportError) {
        throw error;
      }
      throw new DriverAuthTransportError(
        error instanceof Error ? error.message : 'connection lost before the answer arrived',
      );
    }

    if (response.status >= 500) {
      throw new DriverAuthTransportError(`server error ${response.status}`);
    }

    if (method !== 'GET' && response.status < 400 && this.dropSuccessfulAnswers.remaining > 0) {
      this.dropSuccessfulAnswers.remaining -= 1;
      throw new DriverAuthTransportError();
    }

    return response;
  }
}

/** The server's "no" for a car request: the token was refused (401) or the plate was. */
function carRefusal(response: HttpResponse): Error {
  if (response.status === 401) {
    return new DriverAuthRefusedError('not signed in');
  }
  const reason = errorMessage(response);
  return isSaveCarRefusal(reason) ? new DriverAuthRefusedError(reason) : new Error(reason);
}

/**
 * The driver's own id, read from the token's claims so the screen can show it. Reading is not trusting: the server
 * verifies the token's signature on every call, and this value is never sent back to the server.
 */
function personIdFromToken(token: string): string {
  const claims = token.split('.')[0] ?? '';
  try {
    const decoded: unknown = JSON.parse(atob(claims.replace(/-/g, '+').replace(/_/g, '/')));
    return requiredString(asRecord(decoded), 'personId');
  } catch {
    throw new Error('server answer carried an unreadable token');
  }
}

function errorMessage(response: HttpResponse): string {
  const error = asRecord(response.body)['error'];
  return typeof error === 'string' ? error : `request refused with status ${response.status}`;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`server answer missing ${field}`);
  }
  return value;
}