import { describe, expect, it } from 'vitest';
import type { RequestId } from '../../../shared/request-id';
import { DriverPaymentClient } from './driver-payment-client';
import { DriverPaymentRefusedError, DriverPaymentTransportError, type DriverPaymentApi } from './driver-payment-api';
import { InMemoryDriverPaymentApi } from './in-memory-driver-payment-api';

const TICKET_ID = 'ticket-7';

function buildClient(api: DriverPaymentApi = new InMemoryDriverPaymentApi()) {
  let serial = 1;
  const issued: RequestId[] = [];
  const client = new DriverPaymentClient({
    api,
    createRequestId: () => {
      const id = `d4-req-${String(serial++).padStart(4, '0')}`;
      issued.push(id);
      return id;
    },
  });
  return { client, issued };
}

class AnswerLosingApi implements DriverPaymentApi {
  readonly seenRequestIds: RequestId[] = [];
  readonly plan: boolean[];

  constructor(
    private readonly inner: DriverPaymentApi,
    plan: boolean[] = [],
  ) {
    this.plan = plan;
  }

  async pay(ticketId: string, amount: number, requestId: RequestId) {
    this.seenRequestIds.push(requestId);
    const result = await this.inner.pay(ticketId, amount, requestId);
    this.loseAnswer();
    return result;
  }

  async receipt(ticketId: string) {
    return this.inner.receipt(ticketId);
  }

  private loseAnswer(): void {
    if (this.plan.shift() === true) {
      throw new DriverPaymentTransportError();
    }
  }
}

describe('D4 Driver App payment and receipt client', () => {
  it('pays a closed ticket and shows the receipt with the plate', async () => {
    const api = new InMemoryDriverPaymentApi([
      {
        ticketId: TICKET_ID,
        siteId: 'site-12',
        openedAt: '2026-11-06T10:00:00Z',
        closedAt: '2026-11-06T10:30:00Z',
        hours: 0.5,
        fee: 20,
        plate: 'ABC-123',
        paid: false,
      },
    ]);

    const { client } = buildClient(api);
    const payment = await client.pay(TICKET_ID, 20);

    expect(payment).toEqual({ ok: true, value: { ok: true, requestId: 'd4-req-0001', ticketId: TICKET_ID, paid: true } });

    const receipt = await client.receipt(TICKET_ID);
    expect(receipt).toEqual({
      ok: true,
      value: {
        ticketId: TICKET_ID,
        siteId: 'site-12',
        openedAt: '2026-11-06T10:00:00Z',
        closedAt: '2026-11-06T10:30:00Z',
        hours: 0.5,
        fee: 20,
        plate: 'ABC-123',
      },
    });
  });

  it('keeps the same request id while a connection loss is retried', async () => {
    const api = new AnswerLosingApi(new InMemoryDriverPaymentApi([
      {
        ticketId: 'ticket-9',
        siteId: 'site-4',
        openedAt: '2026-11-06T09:00:00Z',
        closedAt: '2026-11-06T09:40:00Z',
        hours: 0.67,
        fee: 18,
        plate: 'XYZ-999',
        paid: false,
      },
    ]), [true, false]);

    const { client } = buildClient(api);

    const lost = await client.pay('ticket-9', 18);
    expect(lost).toEqual({ ok: false, error: 'connection lost', requestId: 'd4-req-0001' });
    expect(client.pendingPaymentRequestId()).toBe('d4-req-0001');

    const retry = await client.pay('ticket-9', 18);
    expect(retry).toEqual({ ok: true, value: { ok: true, requestId: 'd4-req-0001', ticketId: 'ticket-9', paid: true } });
    expect(client.pendingPaymentRequestId()).toBeUndefined();
    expect(api.seenRequestIds).toEqual(['d4-req-0001', 'd4-req-0001']);
  });

  it('shows pay later or pay cash when the provider times out', async () => {
    const api: DriverPaymentApi = {
      pay: async (ticketId: string, amount: number) => {
        throw new DriverPaymentRefusedError('pay later or pay cash');
      },
      receipt: async () => ({
        ticketId: 'ticket-3',
        siteId: 'site-2',
        openedAt: '2026-11-06T12:00:00Z',
        closedAt: '2026-11-06T12:45:00Z',
        hours: 0.75,
        fee: 15,
        plate: 'AAA-111',
      }),
    };

    const { client } = buildClient(api);
    const result = await client.pay('ticket-3', 15);
    expect(result).toEqual({ ok: false, error: 'pay later or pay cash' });
  });
});
