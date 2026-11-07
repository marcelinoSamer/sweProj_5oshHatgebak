/**
 * In-memory stand-in for the payment API while the real payment module is not attached.
 * It keeps the same request id for a repeated write and refuses invalid or incomplete payments.
 */
import type { RequestId } from '../../../shared/request-id';
import {
  DriverPaymentRefusedError,
  DriverPaymentTransportError,
  type DriverPayResult,
  type DriverPaymentApi,
  type DriverReceipt,
} from './driver-payment-api';

interface SavedTicket extends DriverReceipt {
  readonly paid: boolean;
}

export class InMemoryDriverPaymentApi implements DriverPaymentApi {
  private readonly tickets = new Map<string, SavedTicket>();
  private readonly seenResults = new Map<RequestId, DriverPayResult>();
  private transportDropsRemaining = 0;

  constructor(initialTickets: readonly SavedTicket[] = []) {
    for (const ticket of initialTickets) {
      this.tickets.set(ticket.ticketId, ticket);
    }
  }

  /** Drop the next successful answer after the server has applied it. */
  dropNextAnswers(count: number): void {
    this.transportDropsRemaining = count;
  }

  async pay(ticketId: string, amount: number, requestId: RequestId): Promise<DriverPayResult> {
    const known = this.seenResults.get(requestId);
    if (known !== undefined) {
      this.maybeDropAfterApply();
      return known;
    }

    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined || ticket.closedAt.length === 0) {
      throw new DriverPaymentRefusedError('ticket not closed');
    }
    if (amount !== ticket.fee) {
      throw new DriverPaymentRefusedError('declined');
    }

    const result: DriverPayResult = {
      ok: true,
      requestId,
      ticketId,
      paid: true,
    };
    this.seenResults.set(requestId, result);
    this.tickets.set(ticketId, { ...ticket, paid: true });
    this.maybeDropAfterApply();
    return result;
  }

  async receipt(ticketId: string): Promise<DriverReceipt> {
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      throw new DriverPaymentRefusedError('ticket not closed');
    }
    const { paid: _paid, ...receipt } = ticket;
    return receipt;
  }

  private maybeDropAfterApply(): void {
    if (this.transportDropsRemaining <= 0) {
      return;
    }
    this.transportDropsRemaining -= 1;
    throw new DriverPaymentTransportError();
  }
}
