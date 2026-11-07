import { describe, expect, it } from 'vitest';
import type { RequestId } from '../../../shared/request-id';
import { AttendantModeClient } from './attendant-mode-client';
import { AttendantModeRefusedError, AttendantModeTransportError, type AttendantModeApi } from './attendant-mode-api';
import { InMemoryAttendantModeApi } from './in-memory-attendant-mode-api';

const SITE_ID = 'site-12';
const RIGHT_CODE = `attendant-${SITE_ID}`;

function buildClient(api: AttendantModeApi = new InMemoryAttendantModeApi()) {
  let serial = 1;
  const issued: RequestId[] = [];
  const client = new AttendantModeClient({
    api,
    createRequestId: () => {
      const id = `d5-req-${String(serial++).padStart(4, '0')}`;
      issued.push(id);
      return id;
    },
  });
  return { client, issued };
}

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) {
    throw new Error(`Expected a successful result but received ${JSON.stringify(result)}`);
  }
  return result.value;
}

class AnswerLosingApi implements AttendantModeApi {
  readonly seenRequestIds: RequestId[] = [];
  readonly plan: boolean[];

  constructor(
    private readonly inner: AttendantModeApi,
    plan: boolean[] = [],
  ) {
    this.plan = plan;
  }

  async clockIn(attendantId: string, siteId: string, code: string, requestId: RequestId) {
    this.seenRequestIds.push(requestId);
    const result = await this.inner.clockIn(attendantId, siteId, code, requestId);
    this.loseAnswer();
    return result;
  }

  async listOpenTickets(siteId: string) {
    return this.inner.listOpenTickets(siteId);
  }

  async listCarsWaitingForCash(siteId: string) {
    return this.inner.listCarsWaitingForCash(siteId);
  }

  async openAssistedTicket(input: { requestId: RequestId; attendantId: string; siteId: string; driverId: string; plate: string }) {
    this.seenRequestIds.push(input.requestId);
    const result = await this.inner.openAssistedTicket(input);
    this.loseAnswer();
    return result;
  }

  async markTicketPaid(ticketId: string, requestId: RequestId) {
    this.seenRequestIds.push(requestId);
    const result = await this.inner.markTicketPaid(ticketId, requestId);
    this.loseAnswer();
    return result;
  }

  private loseAnswer(): void {
    if (this.plan.shift() === true) {
      throw new AttendantModeTransportError();
    }
  }
}
describe('D5 Staff App attendant mode client', () => {
    it('clocks in on the correct site and lists unpaid cars', async () => {
    const { client } = buildClient();

    const signIn = await client.clockIn('attendant-7', SITE_ID, RIGHT_CODE);

    expect(valueOf(signIn).siteId).toBe(SITE_ID);
    expect((await client.listOpenTickets()).ok).toBe(true);
    expect((await client.listCarsWaitingForCash()).ok).toBe(true);

    const added = await client.openAssistedTicket('driver-a', 'ABC-111');

    expect(valueOf(added).assisted).toBe(true);
    expect(valueOf(await client.listOpenTickets())).toHaveLength(1);
    expect(valueOf(await client.listCarsWaitingForCash())).toEqual(['ABC-111']);
  });

    it('marks a ticket as paid in one tap and keeps the same request id for retry', async () => {
    const api = new AnswerLosingApi(new InMemoryAttendantModeApi(), [false, false, true, false]);
    const { client } = buildClient(api);

    await client.clockIn('attendant-8', 'site-4', 'attendant-site-4');
    const ticketId = valueOf(await client.openAssistedTicket('driver-b', 'XYZ-222')).ticketId;

    const lost = await client.markTicketPaid(ticketId);
    expect(lost).toEqual({ ok: false, error: 'connection lost', requestId: 'd5-req-0003' });
    expect(client.pendingMarkPaidRequestId()).toBe('d5-req-0003');

    const retry = await client.markTicketPaid(ticketId);
    expect(retry).toEqual({ ok: true, value: { ok: true, requestId: 'd5-req-0003', ticketId, paid: true } });
    expect(client.pendingMarkPaidRequestId()).toBeUndefined();
    expect(valueOf(await client.listOpenTickets())).toEqual([]);
    expect(api.seenRequestIds).toEqual(['d5-req-0001', 'd5-req-0002', 'd5-req-0003', 'd5-req-0003']);
  });

  it('refuses a wrong site and keeps the same request id for the same action', async () => {
    const { client } = buildClient(new InMemoryAttendantModeApi());

    const first = await client.clockIn('attendant-9', 'site-9', 'wrong-code');
    const second = await client.clockIn('attendant-9', 'site-9', 'wrong-code');

    expect(first).toEqual({ ok: false, error: 'wrong site' });
    expect(second).toEqual(first);
    expect(client.sessionSiteId()).toBeUndefined();
  });

  it('shows the server refusal as it is, whatever its name', async () => {
    const refusing: AttendantModeApi = {
      clockIn: async () => { throw new AttendantModeRefusedError('wrong site'); },
      listOpenTickets: async () => [],
      listCarsWaitingForCash: async () => [],
      openAssistedTicket: async () => { throw new AttendantModeRefusedError('not clocked in'); },
      markTicketPaid: async () => { throw new AttendantModeRefusedError('ticket not found'); },
    };

    const { client } = buildClient(refusing);
    const result = await client.clockIn('attendant-1', 'site-1', 'attendant-site-1');
    expect(result).toEqual({ ok: false, error: 'wrong site' });
  });

  it('refuses a write when offline and never saves a local clock-in state', async () => {
    const api = new AnswerLosingApi(new InMemoryAttendantModeApi(), [true]);
    const { client } = buildClient(api);

    const result = await client.clockIn('attendant-99', 'site-99', 'attendant-site-99');

    expect(result).toEqual({ ok: false, error: 'connection lost', requestId: 'd5-req-0001' });
    expect(client.attendant()).toBeUndefined();
    expect(client.sessionSiteId()).toBeUndefined();
    expect(client.pendingClockInRequestId()).toBe('d5-req-0001');
  });
});
