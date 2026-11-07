/**
 * Driver App client for payment and receipt. The app displays the server's decision and keeps the request id for the
 * same payment request while the connection is lost.
 */
import type { RequestId } from '../../../shared/request-id';
import {
  DriverPaymentRefusedError,
  DriverPaymentTransportError,
  type DriverPayResult,
  type DriverPaymentApi,
  type DriverPaymentRefusal,
  type DriverReceipt,
} from './driver-payment-api';

export type DriverPaymentClientSuccess<T> = { readonly ok: true; readonly value: T };
export type DriverPaymentClientFailure =
  | { readonly ok: false; readonly error: 'connection lost'; readonly requestId: RequestId }
  | { readonly ok: false; readonly error: DriverPaymentRefusal };
export type DriverPaymentClientResult<T> = DriverPaymentClientSuccess<T> | DriverPaymentClientFailure;

export interface DriverPaymentClientOptions {
  readonly api: DriverPaymentApi;
  readonly createRequestId: () => RequestId;
}

interface PendingRequest {
  readonly input: string;
  readonly requestId: RequestId;
}

export class DriverPaymentClient {
  private readonly api: DriverPaymentApi;
  private readonly createRequestId: () => RequestId;
  private pendingPayment: PendingRequest | undefined;

  constructor(options: DriverPaymentClientOptions) {
    this.api = options.api;
    this.createRequestId = options.createRequestId;
  }

  pendingPaymentRequestId(): RequestId | undefined {
    return this.pendingPayment?.requestId;
  }

  async pay(ticketId: string, amount: number): Promise<DriverPaymentClientResult<DriverPayResult>> {
    const pending = this.keepOrCreate(this.pendingPayment, `${ticketId}\u0000${String(amount)}`);
    this.pendingPayment = pending;

    try {
      const result = await this.api.pay(ticketId, amount, pending.requestId);
      this.pendingPayment = undefined;
      return { ok: true, value: result };
    } catch (error) {
      if (error instanceof DriverPaymentTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingPayment = undefined;
      return this.refusalOrRethrow(error);
    }
  }

  async receipt(ticketId: string): Promise<DriverPaymentClientResult<DriverReceipt>> {
    try {
      return { ok: true, value: await this.api.receipt(ticketId) };
    } catch (error) {
      if (error instanceof DriverPaymentTransportError) {
        return { ok: false, error: 'connection lost', requestId: this.pendingPayment?.requestId ?? '' };
      }
      return this.refusalOrRethrow(error);
    }
  }

  private keepOrCreate(existing: PendingRequest | undefined, input: string): PendingRequest {
    return existing?.input === input ? existing : { input, requestId: this.createRequestId() };
  }

  private refusalOrRethrow(error: unknown): DriverPaymentClientFailure {
    if (error instanceof DriverPaymentRefusedError) {
      return { ok: false, error: error.refusal };
    }
    throw error;
  }
}
