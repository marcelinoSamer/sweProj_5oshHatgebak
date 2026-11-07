import { randomUUID } from 'node:crypto';
import type { TicketDesk, TicketQuery } from '../../ticketing/public';
import type { Clock } from '../../../shared/clock';
import type { EventPublisher } from '../../../shared/events/event';
import type { PaymentId, PersonId, SiteId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import { fail, succeed, type Result } from '../../../shared/result';
import type { PaymentGateway, PaymentLedger, PaymentRecord, PayRefusal } from '../public';
import type { PaymentStore, StoredPayment } from './ports';

/** The provider gets this long to answer before the driver is told "pay later or pay cash" (ADR-08). */
export const PROVIDER_TIMEOUT_MILLISECONDS = 8_000;

/** Published after a payment lands, for Notifications, the dashboard and the money check (ADR-07). */
export const TICKET_PAID_TOPIC = 'TicketPaid';

export interface TicketPaidPayload {
  readonly ticketId: TicketId;
  readonly paymentId: PaymentId;
  readonly amount: number;
  readonly providerReference?: string;
}

export interface PaymentLedgerDependencies {
  readonly gateway: PaymentGateway;
  readonly ticketDesk: TicketDesk;
  readonly ticketQuery: TicketQuery;
  readonly clock: Clock;
}

/**
 * The payments ledger for one unit of work (task C2). Paying in the app: ask Ticketing for the ticket, charge the
 * provider with the request id as the idempotency key, record the answer as a new row, mark the ticket paid and
 * publish "ticket paid". The row, the ticket status, the audit entry and the event commit together (Rule E).
 *
 * One charge per request id (task C3) holds at two levels: the entry point answers a repeat from its stored
 * response without calling the ledger, and the ledger itself answers from the row the id already created, so even
 * a caller that bypasses the entry point cannot charge the provider twice for one id.
 */
export class PaymentLedgerService implements PaymentLedger {
  constructor(
    private readonly dependencies: PaymentLedgerDependencies,
    private readonly store: PaymentStore,
    private readonly events: EventPublisher,
  ) {}

  async payInApp(requestId: RequestId, ticketId: TicketId, payer: PersonId): Promise<Result<PaymentRecord, PayRefusal>> {
    const alreadyRecorded = await this.store.byRequestId(requestId);
    if (alreadyRecorded !== undefined) {
      return succeed(toRecord(alreadyRecorded));
    }
    const ticket = await this.dependencies.ticketQuery.ticketStatus(ticketId);
    if (ticket.driverRef !== payer) {
      return fail('not your ticket');
    }
    if (ticket.state !== 'closed' || ticket.fee === undefined) {
      return fail('ticket not closed');
    }
    if (ticket.paymentStatus !== 'unpaid') {
      return fail('nothing to pay');
    }

    const charge = await this.dependencies.gateway.charge(ticket.fee, requestId, PROVIDER_TIMEOUT_MILLISECONDS);
    if (charge.outcome === 'declined') {
      return fail('declined');
    }
    if (charge.outcome === 'timed out') {
      return fail('pay later or pay cash');
    }

    const payment: StoredPayment = {
      paymentId: `payment-${randomUUID()}`,
      ticketId,
      amount: ticket.fee,
      method: 'app',
      outcome: charge.outcome,
      ...(charge.providerReference === undefined ? {} : { providerReference: charge.providerReference }),
      requestId,
      payerId: payer,
      recordedAt: this.dependencies.clock.now().toISOString(),
    };
    await this.store.add(payment);

    if (charge.outcome === 'paid') {
      await this.markTicketPaid(requestId, ticketId);
      const payload: TicketPaidPayload = {
        ticketId,
        paymentId: payment.paymentId,
        amount: payment.amount,
        ...(payment.providerReference === undefined ? {} : { providerReference: payment.providerReference }),
      };
      this.events.publish({ topic: TICKET_PAID_TOPIC, payload });
    }
    return succeed(toRecord(payment));
  }

  async tickCash(_requestId: RequestId, _ticketId: TicketId, _attendantId: PersonId): Promise<Result<PaymentRecord, string>> {
    throw new Error('Cash ticks are built in task C6');
  }

  async addCorrection(_requestId: RequestId, _paymentId: PaymentId, _amount: number, _reason: string): Promise<PaymentRecord> {
    throw new Error('Corrections are built in task C7');
  }

  async settlePendingPayments(): Promise<number> {
    throw new Error('Settling pending payments is built in task C5');
  }

  async cashDueForShift(_attendantId: PersonId, _siteId: SiteId, _shiftId: string): Promise<number> {
    throw new Error('Cash due per shift is built in task C8');
  }

  async paymentsForTicket(ticketId: TicketId): Promise<readonly PaymentRecord[]> {
    return (await this.store.forTicket(ticketId)).map(toRecord);
  }

  /**
   * The provider has taken the money, so a ticket that cannot be marked paid is an error, not a refusal: the whole
   * write rolls back, and the driver's retry with the same request id reaches the provider's stored answer, never
   * a second charge (ADR-08).
   */
  private async markTicketPaid(requestId: RequestId, ticketId: TicketId): Promise<void> {
    const marked = await this.dependencies.ticketDesk.changePaymentStatus(requestId, ticketId, 'paid');
    if (!marked.ok) {
      throw new Error(`Ticket ${ticketId} was charged but could not be marked paid: ${marked.error}`);
    }
  }
}

/** The public record: the stored row without the module's own bookkeeping columns. */
export function toRecord(payment: StoredPayment): PaymentRecord {
  const { requestId: _requestId, payerId: _payerId, recordedAt: _recordedAt, ...record } = payment;
  return record;
}
