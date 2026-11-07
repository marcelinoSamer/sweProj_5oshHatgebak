import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { composeInMemoryApplication } from '../../../entrypoint/composition';
import { foundationOperations } from '../../../entrypoint/operations/foundation-operations';
import { TEST_TOKEN_SECRET, tokenFor, writeRequest } from '../../../entrypoint/test-helpers';
import { FixedClock } from '../../../shared/clock';
import type { PersonId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import { fail, succeed, type Result } from '../../../shared/result';
import type { PaymentStatus, Ticket, TicketDesk, TicketQuery } from '../../ticketing/public';
import {
  createFakePaymentGateway,
  createInMemoryPaymentStores,
  createPayments,
  PAYMENTS_TABLE,
  TICKET_PAID_TOPIC,
  type PaymentRecord,
} from '../public';
import type { StoredPayment } from './ports';

/**
 * Task C2: paying in the app. Charge through the port with the request id as the idempotency key, record the
 * result, mark the ticket paid, publish "ticket paid". Every test goes through the entry point, so the token, the
 * role, the request id, the audit entry and the outbox are all exercised.
 */
const PAY_PATH = '/payments/app';
const DRIVER: PersonId = 'driver-1';

/** A stand-in for Teammate B's Ticketing, holding tickets in a map; only the two calls payments makes are real. */
class FakeTickets implements TicketDesk, TicketQuery {
  private readonly tickets = new Map<TicketId, Ticket>();

  seed(ticket: Ticket): void {
    this.tickets.set(ticket.ticketId, ticket);
  }

  async ticketStatus(ticketId: TicketId): Promise<Ticket> {
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      throw new Error(`No ticket ${ticketId}`);
    }
    return ticket;
  }

  async changePaymentStatus(_requestId: RequestId, ticketId: TicketId, to: PaymentStatus): Promise<Result<Ticket, string>> {
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      return fail('no such ticket');
    }
    const changed = { ...ticket, paymentStatus: to };
    this.tickets.set(ticketId, changed);
    return succeed(changed);
  }

  openTicket(): never {
    throw new Error('not needed by payments');
  }

  openAssistedTicket(): never {
    throw new Error('not needed by payments');
  }

  closeTicket(): never {
    throw new Error('not needed by payments');
  }

  closeStaleTickets(): never {
    throw new Error('not needed by payments');
  }

  ticketHistory(): never {
    throw new Error('not needed by payments');
  }

  freeSpaces(): never {
    throw new Error('not needed by payments');
  }

  assistedTicketCount(): never {
    throw new Error('not needed by payments');
  }

  receipt(): never {
    throw new Error('not needed by payments');
  }

  frequentSites(): never {
    throw new Error('not needed by payments');
  }
}

function closedTicket(ticketId: TicketId, fee: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    ticketId,
    siteId: 'site-1',
    driverRef: DRIVER,
    state: 'closed',
    paymentStatus: 'unpaid',
    openedAt: '2026-11-06T08:00:00.000Z',
    closedAt: '2026-11-06T10:00:00.000Z',
    fee,
    assisted: false,
    ...overrides,
  };
}

function setUp() {
  const clock = new FixedClock(new Date('2026-11-06T10:05:00Z'));
  const tickets = new FakeTickets();
  const gateway = createFakePaymentGateway();
  const payments = createPayments({
    gateway,
    ticketDesk: tickets,
    ticketQuery: tickets,
    clock,
    stores: createInMemoryPaymentStores(),
  });
  const application = composeInMemoryApplication({
    tokenSecret: TEST_TOKEN_SECRET,
    clock,
    operations: [...foundationOperations, ...payments.operations],
  });
  const pay = (requestId: string, ticketId: string) =>
    application.handle(writeRequest(PAY_PATH, 'driver', requestId, { ticketId }));
  const paymentRows = () => application.database.rows<StoredPayment>(PAYMENTS_TABLE);
  const auditRows = () => application.audit.readByScope({ personId: 'chair-1', role: 'chair' });
  return { tickets, gateway, application, pay, paymentRows, auditRows };
}

function paymentIn(response: { body: unknown }): PaymentRecord {
  return (response.body as { payment: PaymentRecord }).payment;
}

function errorIn(response: { body: unknown }): string {
  return (response.body as { error: string }).error;
}

let payLatencyMilliseconds = Number.NaN;

describe('C2 paying in the app', () => {
  it('pays a closed ticket: paid with a provider reference, ticket shows paid, one row, one audit entry, one event', async () => {
    const { tickets, gateway, application, pay, paymentRows, auditRows } = setUp();
    tickets.seed(closedTicket('ticket-1', 11));

    const started = performance.now();
    const response = await pay('request-pay-0001', 'ticket-1');
    payLatencyMilliseconds = performance.now() - started;

    expect(response.status).toBe(201);
    const payment = paymentIn(response);
    expect(payment).toMatchObject({ ticketId: 'ticket-1', amount: 11, method: 'app', outcome: 'paid' });
    expect(payment.providerReference).toMatch(/^fake-/);
    expect((await tickets.ticketStatus('ticket-1')).paymentStatus).toBe('paid');

    expect(paymentRows()).toHaveLength(1);
    expect(paymentRows()[0]).toMatchObject({
      paymentId: payment.paymentId,
      requestId: 'request-pay-0001',
      payerId: DRIVER,
      recordedAt: '2026-11-06T10:05:00.000Z',
    });
    expect(gateway.chargeCallCount('request-pay-0001')).toBe(1);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'payments.payInApp', personId: DRIVER, requestId: 'request-pay-0001' });

    const events = application.outbox.allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      topic: TICKET_PAID_TOPIC,
      payload: { ticketId: 'ticket-1', paymentId: payment.paymentId, amount: 11, providerReference: payment.providerReference },
    });
  });

  it('records a pending answer as a row, leaves the ticket unpaid and publishes nothing yet', async () => {
    const { tickets, application, pay, paymentRows } = setUp();
    tickets.seed(closedTicket('ticket-1', 13));

    const response = await pay('request-pay-0002', 'ticket-1');

    expect(response.status).toBe(202);
    expect(paymentIn(response).outcome).toBe('pending');
    expect((await tickets.ticketStatus('ticket-1')).paymentStatus).toBe('unpaid');
    expect(paymentRows()).toHaveLength(1);
    expect(paymentRows()[0]?.outcome).toBe('pending');
    expect(application.outbox.allEvents()).toHaveLength(0);
  });

  it('refuses a declined charge and keeps no row, no audit entry and no event', async () => {
    const { tickets, application, pay, paymentRows, auditRows } = setUp();
    tickets.seed(closedTicket('ticket-1', 12));

    const response = await pay('request-pay-0003', 'ticket-1');

    expect(response.status).toBe(402);
    expect(errorIn(response)).toBe('declined');
    expect((await tickets.ticketStatus('ticket-1')).paymentStatus).toBe('unpaid');
    expect(paymentRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
    expect(application.outbox.allEvents()).toHaveLength(0);
  });

  it('refuses to pay a ticket that is still open', async () => {
    const { tickets, pay, paymentRows } = setUp();
    tickets.seed({
      ticketId: 'ticket-1',
      siteId: 'site-1',
      driverRef: DRIVER,
      state: 'open',
      paymentStatus: 'unpaid',
      openedAt: '2026-11-06T08:00:00.000Z',
      assisted: false,
    });

    const response = await pay('request-pay-0004', 'ticket-1');

    expect(response.status).toBe(409);
    expect(errorIn(response)).toBe('ticket not closed');
    expect(paymentRows()).toHaveLength(0);
  });

  it('refuses to pay a ticket that is already paid, so a second request id cannot charge it again', async () => {
    const { tickets, gateway, pay, paymentRows } = setUp();
    tickets.seed(closedTicket('ticket-1', 11));

    expect((await pay('request-pay-0005', 'ticket-1')).status).toBe(201);
    const again = await pay('request-pay-0006', 'ticket-1');

    expect(again.status).toBe(409);
    expect(errorIn(again)).toBe('nothing to pay');
    expect(paymentRows()).toHaveLength(1);
    expect(gateway.chargeCallCount()).toBe(1);
  });

  it("refuses to let a driver pay another driver's ticket", async () => {
    const { tickets, pay, paymentRows } = setUp();
    tickets.seed(closedTicket('ticket-1', 11, { driverRef: 'driver-2' }));

    const response = await pay('request-pay-0007', 'ticket-1');

    expect(response.status).toBe(403);
    expect(errorIn(response)).toBe('not your ticket');
    expect(paymentRows()).toHaveLength(0);
  });

  it('is open to drivers only: the permission table refuses an attendant before the ledger runs', async () => {
    const { tickets, application, paymentRows } = setUp();
    tickets.seed(closedTicket('ticket-1', 11));

    const response = await application.handle({
      method: 'POST',
      path: PAY_PATH,
      query: {},
      headers: { authorization: `Bearer ${tokenFor('attendant')}`, 'x-request-id': 'request-pay-0008' },
      body: { ticketId: 'ticket-1' },
    });

    expect(response.status).toBe(403);
    expect(paymentRows()).toHaveLength(0);
  });

  it('leaves zero audit rows for a body that fails validation (fitness function F5)', async () => {
    const { application, auditRows } = setUp();
    const response = await application.handle(writeRequest(PAY_PATH, 'driver', 'request-pay-0009', {}));
    expect(response.status).toBe(400);
    expect(await auditRows()).toHaveLength(0);
  });

  afterAll(() => {
    console.log(`C2 report: pay latency ${payLatencyMilliseconds.toFixed(1)} ms (one pay through the entry point on the in-memory stack)`);
  });
});
