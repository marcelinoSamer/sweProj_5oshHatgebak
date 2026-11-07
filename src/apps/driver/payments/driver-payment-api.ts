/**
 * The Driver App's view of paying a closed ticket and showing the receipt.
 * The app shows the server's answer; it never decides whether a payment is valid or a receipt is real.
 */
import type { TicketId, SiteId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';

export interface DriverReceipt {
  readonly ticketId: TicketId;
  readonly siteId: SiteId;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly hours: number;
  readonly fee: number;
  readonly plate: string;
}

export interface DriverPayResult {
  readonly ok: true;
  readonly requestId: RequestId;
  readonly ticketId: TicketId;
  readonly paid: boolean;
}

export type DriverPaymentRefusal = 'declined' | 'pay later or pay cash' | 'ticket not closed';

export const DRIVER_PAYMENT_REFUSALS: readonly DriverPaymentRefusal[] = [
  'declined',
  'pay later or pay cash',
  'ticket not closed',
];

export function isDriverPaymentRefusal(candidate: unknown): candidate is DriverPaymentRefusal {
  return typeof candidate === 'string' && (DRIVER_PAYMENT_REFUSALS as readonly string[]).includes(candidate);
}

/** The connection dropped before the server answered: retry with the same request id. */
export class DriverPaymentTransportError extends Error {
  constructor(message = 'connection lost before the answer arrived') {
    super(message);
    this.name = 'DriverPaymentTransportError';
  }
}

/** The server answered and said no. Nothing changed. */
export class DriverPaymentRefusedError extends Error {
  readonly refusal: DriverPaymentRefusal;

  constructor(refusal: DriverPaymentRefusal) {
    super(refusal);
    this.name = 'DriverPaymentRefusedError';
    this.refusal = refusal;
  }
}

export interface DriverPaymentApi {
  pay(ticketId: TicketId, amount: number, requestId: RequestId): Promise<DriverPayResult>;
  receipt(ticketId: TicketId): Promise<DriverReceipt>;
}
