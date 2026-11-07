/**
 * Payments — owner: Teammate C (Area 4). Must-stay-on set.
 * Payment records (app and cash), corrections as new rows, one charge per request id. Needs TicketDesk, AuditTrail
 * and the PaymentGateway port.
 */
import type { Operation } from '../../entrypoint/operations/operation';
import type { Clock } from '../../shared/clock';
import type { EventPublisher } from '../../shared/events/event';
import type { PaymentId, PersonId, SiteId, TicketId } from '../../shared/identifiers';
import type { RequestId } from '../../shared/request-id';
import type { Result } from '../../shared/result';
import type { UnitOfWork } from '../../shared/unit-of-work';
import type { TicketDesk, TicketQuery } from '../ticketing/public';
import { payInAppOperation } from './internal/operations/pay-in-app';
import { PaymentLedgerService } from './internal/payment-ledger';
import type { PaymentStores } from './internal/ports';

export type ChargeOutcome = 'paid' | 'declined' | 'pending' | 'timed out';

export interface ChargeResult {
  readonly outcome: ChargeOutcome;
  readonly providerReference?: string;
}

/**
 * Port to the outside payment provider (ADR-11). The request id is the idempotency key (ADR-08).
 * `charge` answers within `timeoutMilliseconds` or returns "timed out" with no reference; it never throws for a slow
 * provider. `status` asks the provider about a charge it issued earlier, for settling pending payments (C5).
 */
export interface PaymentGateway {
  charge(amount: number, idempotencyKey: RequestId, timeoutMilliseconds: number): Promise<ChargeResult>;
  status(providerReference: string): Promise<ChargeOutcome>;
}

/** The fake provider for tests and the in-memory server (C1); the composition root builds it through this function. */
export { createFakePaymentGateway, type FakePaymentGateway } from './internal/adapters/fake-payment-gateway';

export interface PaymentRecord {
  readonly paymentId: PaymentId;
  readonly ticketId: TicketId;
  readonly amount: number;
  readonly method: 'app' | 'cash' | 'correction';
  readonly outcome: ChargeOutcome;
  readonly reason?: string;
  /** The provider's reference for an app payment; absent for cash and corrections. */
  readonly providerReference?: string;
}

/**
 * Why a pay in the app was refused. The first three come from the task sheet; "nothing to pay" (the ticket is
 * already paid or waived) and "not your ticket" keep one ticket from being charged twice or by a stranger.
 */
export type PayRefusal = 'declined' | 'pay later or pay cash' | 'ticket not closed' | 'nothing to pay' | 'not your ticket';

export interface PaymentLedger {
  payInApp(requestId: RequestId, ticketId: TicketId, payer: PersonId): Promise<Result<PaymentRecord, PayRefusal>>;
  tickCash(requestId: RequestId, ticketId: TicketId, attendantId: PersonId): Promise<Result<PaymentRecord, string>>;
  addCorrection(requestId: RequestId, paymentId: PaymentId, amount: number, reason: string): Promise<PaymentRecord>;
  settlePendingPayments(): Promise<number>;
  cashDueForShift(attendantId: PersonId, siteId: SiteId, shiftId: string): Promise<number>;
  paymentsForTicket(ticketId: TicketId): Promise<readonly PaymentRecord[]>;
}

export interface PaymentsDependencies {
  readonly gateway: PaymentGateway;
  readonly ticketDesk: TicketDesk;
  readonly ticketQuery: TicketQuery;
  readonly clock: Clock;
  readonly stores: PaymentStores;
}

export interface Payments {
  /** The ledger joined to one write's unit of work, so its rows and events commit with the audit entry (Rule E). */
  ledgerBoundTo(unitOfWork: UnitOfWork, events: EventPublisher): PaymentLedger;
  /** The operations this module registers with the entry point. */
  readonly operations: readonly Operation[];
}

/** The composition root builds this module through this one function; nothing else constructs its internals. */
export function createPayments(dependencies: PaymentsDependencies): Payments {
  const ledgerBoundTo: Payments['ledgerBoundTo'] = (unitOfWork, events) =>
    new PaymentLedgerService(dependencies, dependencies.stores.boundTo(unitOfWork), events);
  return { ledgerBoundTo, operations: [payInAppOperation({ ledgerBoundTo })] };
}

export type { PaymentStores } from './internal/ports';
export { createInMemoryPaymentStores, PAYMENTS_TABLE } from './internal/adapters/in-memory-payment-store';
export { PROVIDER_TIMEOUT_MILLISECONDS, TICKET_PAID_TOPIC, type TicketPaidPayload } from './internal/payment-ledger';
