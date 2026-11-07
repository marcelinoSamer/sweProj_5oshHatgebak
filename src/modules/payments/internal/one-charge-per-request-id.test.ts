import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryDatabase } from '../../../adapters/in-memory/in-memory-database';
import { InMemoryOutboxStore } from '../../../adapters/in-memory/in-memory-outbox-store';
import { composeInMemoryApplication } from '../../../entrypoint/composition';
import { foundationOperations } from '../../../entrypoint/operations/foundation-operations';
import { TEST_TOKEN_SECRET, writeRequest } from '../../../entrypoint/test-helpers';
import { FixedClock } from '../../../shared/clock';
import type { PersonId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import { fail, succeed, type Result } from '../../../shared/result';
import type { PaymentStatus, Ticket, TicketDesk, TicketQuery } from '../../ticketing/public';
import { createFakePaymentGateway, createInMemoryPaymentStores, createPayments, PAYMENTS_TABLE } from '../public';
import type { StoredPayment } from './ports';

/**
 * Task C3: one charge per request id. Two pays with one id give one payment row and one call to the provider.
 * Checked at both levels: through the entry point (its stored response answers the repeat) and straight at the
 * ledger (the row the id already created answers the repeat).
 */
const PAY_PATH = '/payments/app';
const DRIVER: PersonId = 'driver-1';
const ONE_ID: RequestId = 'request-repeat-0001';

/** A stand-in for Teammate B's Ticketing: tickets in a map, only the two calls payments makes are real. */
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

function closedUnpaidTicket(ticketId: TicketId, fee: number): Ticket {
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
  };
}

function setUp() {
  const clock = new FixedClock(new Date('2026-11-06T10:05:00Z'));
  const tickets = new FakeTickets();
  const gateway = createFakePaymentGateway();
  const payments = createPayments({ gateway, ticketDesk: tickets, ticketQuery: tickets, clock, stores: createInMemoryPaymentStores() });
  return { clock, tickets, gateway, payments };
}

const results: Record<'entry point' | 'ledger', 'PASS' | 'FAIL'> = { 'entry point': 'FAIL', ledger: 'FAIL' };

describe('C3 one charge per request id', () => {
  it('through the entry point: two pays with one id give identical answers, one row and one charge', async () => {
    const { clock, tickets, gateway, payments } = setUp();
    tickets.seed(closedUnpaidTicket('ticket-1', 11));
    const application = composeInMemoryApplication({
      tokenSecret: TEST_TOKEN_SECRET,
      clock,
      operations: [...foundationOperations, ...payments.operations],
    });

    const first = await application.handle(writeRequest(PAY_PATH, 'driver', ONE_ID, { ticketId: 'ticket-1' }));
    const second = await application.handle(writeRequest(PAY_PATH, 'driver', ONE_ID, { ticketId: 'ticket-1' }));

    expect(first.status).toBe(201);
    expect(second).toEqual(first);
    expect(application.database.rows<StoredPayment>(PAYMENTS_TABLE)).toHaveLength(1);
    expect(gateway.chargeCallCount(ONE_ID)).toBe(1);
    expect(gateway.chargeCallCount()).toBe(1);
    expect(await application.audit.readByScope({ personId: 'chair-1', role: 'chair' })).toHaveLength(1);
    expect(application.outbox.allEvents()).toHaveLength(1);
    results['entry point'] = 'PASS';
  });

  it('at the ledger itself: a repeat of a committed pay returns the recorded payment without a second charge', async () => {
    const { clock, tickets, gateway, payments } = setUp();
    tickets.seed(closedUnpaidTicket('ticket-1', 11));
    const database = new InMemoryDatabase();
    const outbox = new InMemoryOutboxStore(database, clock);

    const firstTransaction = database.begin();
    const first = await payments.ledgerBoundTo(firstTransaction, outbox.publisherBoundTo(firstTransaction)).payInApp(ONE_ID, 'ticket-1', DRIVER);
    await firstTransaction.commit();

    const secondTransaction = database.begin();
    const second = await payments.ledgerBoundTo(secondTransaction, outbox.publisherBoundTo(secondTransaction)).payInApp(ONE_ID, 'ticket-1', DRIVER);
    await secondTransaction.commit();

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(database.rows<StoredPayment>(PAYMENTS_TABLE)).toHaveLength(1);
    expect(gateway.chargeCallCount(ONE_ID)).toBe(1);
    expect(outbox.allEvents()).toHaveLength(1);
    results.ledger = 'PASS';
  });

  it('a pay that was rolled back leaves no row, so the same id on retry charges once and lands once', async () => {
    const { clock, tickets, gateway, payments } = setUp();
    tickets.seed(closedUnpaidTicket('ticket-1', 11));
    const database = new InMemoryDatabase();
    const outbox = new InMemoryOutboxStore(database, clock);

    const abandoned = database.begin();
    await payments.ledgerBoundTo(abandoned, outbox.publisherBoundTo(abandoned)).payInApp(ONE_ID, 'ticket-1', DRIVER);
    await abandoned.rollback();
    tickets.seed(closedUnpaidTicket('ticket-1', 11));

    const retry = database.begin();
    const retried = await payments.ledgerBoundTo(retry, outbox.publisherBoundTo(retry)).payInApp(ONE_ID, 'ticket-1', DRIVER);
    await retry.commit();

    expect(retried.ok).toBe(true);
    expect(database.rows<StoredPayment>(PAYMENTS_TABLE)).toHaveLength(1);
    expect(gateway.chargeCallCount(ONE_ID)).toBe(2);
    expect(retried.ok && retried.value.providerReference).toBeTruthy();
  });

  afterAll(() => {
    console.log(`C3 report: entry point ${results['entry point']}; ledger ${results.ledger}`);
  });
});
