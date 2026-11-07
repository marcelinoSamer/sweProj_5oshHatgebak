/**
 * HTTP adapter for the Driver App payment flow: call the main system with the driver's token and map its answers to
 * app-level refusal and transport errors.
 */
import type { HttpRequest, HttpResponse } from '../../../entrypoint/http';
import { REQUEST_ID_HEADER } from '../../../shared/request-id';
import {
  DriverPaymentRefusedError,
  DriverPaymentTransportError,
  isDriverPaymentRefusal,
  type DriverPaymentApi,
  type DriverPayResult,
  type DriverReceipt,
} from './driver-payment-api';
import { DRIVER_PAY_PATH, DRIVER_RECEIPT_PATH } from './driver-payment-routes';

export type EntryPointHandle = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpDriverPaymentApiOptions {
  readonly handle: EntryPointHandle;
  readonly authorizationHeader: () => string;
}

export class HttpDriverPaymentApi implements DriverPaymentApi {
  private readonly handle: EntryPointHandle;
  private readonly authorizationHeader: () => string;

  constructor(options: HttpDriverPaymentApiOptions) {
    this.handle = options.handle;
    this.authorizationHeader = options.authorizationHeader;
  }

  async pay(ticketId: string, amount: number, requestId: string): Promise<DriverPayResult> {
    const response = await this.send(DRIVER_PAY_PATH, requestId, {
      ticketId,
      amount: String(amount),
    });
    return readPay(response);
  }

  async receipt(ticketId: string): Promise<DriverReceipt> {
    const response = await this.send(DRIVER_RECEIPT_PATH, undefined, { ticketId });
    return readReceipt(response);
  }

  private async send(path: string, requestId: string | undefined, body: Record<string, string>): Promise<HttpResponse> {
    try {
      return await this.handle({
        method: 'POST',
        path,
        query: {},
        headers: {
          authorization: this.authorizationHeader(),
          ...(requestId === undefined ? {} : { [REQUEST_ID_HEADER]: requestId }),
        },
        body,
      });
    } catch (error) {
      if (error instanceof DriverPaymentTransportError || error instanceof DriverPaymentRefusedError) {
        throw error;
      }
      throw new DriverPaymentTransportError(
        error instanceof Error ? error.message : 'connection lost before the answer arrived',
      );
    }
  }
}

function readPay(response: HttpResponse): DriverPayResult {
  if (response.status >= 400) {
    throw refusal(response);
  }

  const body = asRecord(response.body);
  const ticketId = requiredString(body, 'ticketId');
  const paid = requiredBoolean(body, 'paid');
  const requestId = requiredString(body, 'requestId');
  return { ok: true, requestId, ticketId, paid };
}

function readReceipt(response: HttpResponse): DriverReceipt {
  if (response.status >= 400) {
    throw refusal(response);
  }

  const body = asRecord(response.body);
  return {
    ticketId: requiredString(body, 'ticketId'),
    siteId: requiredString(body, 'siteId'),
    openedAt: requiredString(body, 'openedAt'),
    closedAt: requiredString(body, 'closedAt'),
    hours: requiredNumber(body, 'hours'),
    fee: requiredNumber(body, 'fee'),
    plate: requiredString(body, 'plate'),
  };
}

function refusal(response: HttpResponse): Error {
  if (response.status === 401) {
    return new DriverPaymentRefusedError('ticket not closed');
  }

  const reason = errorMessage(response);
  return isDriverPaymentRefusal(reason) ? new DriverPaymentRefusedError(reason) : new Error(reason);
}

function errorMessage(response: HttpResponse): string {
  const body = asRecord(response.body);
  const error = body['error'];
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

function requiredNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`server answer missing ${field}`);
  }
  return value;
}

function requiredBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') {
    throw new Error(`server answer missing ${field}`);
  }
  return value;
}
