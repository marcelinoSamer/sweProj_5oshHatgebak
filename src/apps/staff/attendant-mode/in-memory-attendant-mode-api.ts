import type { PersonId, SiteId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import {
  AttendantModeRefusedError,
  type AssistedTicketInput,
  type AssistedTicketResult,
  type AttendantClockInResult,
  type AttendantModeApi,
  type MarkPaidResult,
  type TicketSummary,
} from './attendant-mode-api';

/** In-memory stand-in for the Staff App attendant-mode calls until the server routes are registered. */
export class InMemoryAttendantModeApi implements AttendantModeApi {
  private readonly sessions = new Map<PersonId, SiteId>();
  private readonly tickets = new Map<TicketId, TicketSummary>();
  private readonly clockResponses = new Map<RequestId, AttendantClockInResult>();
  private readonly assistedResponses = new Map<RequestId, AssistedTicketResult>();
  private readonly paidResponses = new Map<RequestId, MarkPaidResult>();
  private nextTicketNumber = 1;

  async clockIn(attendantId: PersonId, siteId: SiteId, code: string, requestId: RequestId): Promise<AttendantClockInResult> {
    const known = this.clockResponses.get(requestId);
    if (known) {
      return known;
    }

    const expectedCode = `attendant-${siteId}`;
    if (code !== expectedCode) {
      throw new AttendantModeRefusedError('wrong site');
    }

    this.sessions.set(attendantId, siteId);
    const success = { ok: true as const, requestId, attendantId, siteId };
    this.clockResponses.set(requestId, success);
    return success;
  }

  async listOpenTickets(siteId: SiteId): Promise<readonly TicketSummary[]> {
    return [...this.tickets.values()].filter((ticket) => ticket.siteId === siteId && !ticket.paid);
  }

  async listCarsWaitingForCash(siteId: SiteId): Promise<readonly string[]> {
    return (await this.listOpenTickets(siteId)).map((ticket) => ticket.plate);
  }

  async openAssistedTicket(input: AssistedTicketInput): Promise<AssistedTicketResult> {
    const known = this.assistedResponses.get(input.requestId);
    if (known) {
      return known;
    }

    const siteId = this.sessions.get(input.attendantId);
    if (siteId === undefined) {
      throw new AttendantModeRefusedError('not clocked in');
    }

    if (siteId !== input.siteId) {
      throw new AttendantModeRefusedError('wrong site');
    }

    const ticketId: TicketId = `ticket-${this.nextTicketNumber}`;
    this.nextTicketNumber += 1;

    const summary: TicketSummary = {
      ticketId,
      driverId: input.driverId,
      siteId: input.siteId,
      plate: input.plate,
      paid: false,
      assisted: true,
    };
    this.tickets.set(ticketId, summary);

    const success = {
      ok: true as const,
      requestId: input.requestId,
      ticketId,
      driverId: input.driverId,
      siteId: input.siteId,
      plate: input.plate,
      paid: false,
      assisted: true,
    };
    this.assistedResponses.set(input.requestId, success);
    return success;
  }

  async markTicketPaid(ticketId: TicketId, requestId: RequestId): Promise<MarkPaidResult> {
    const known = this.paidResponses.get(requestId);
    if (known) {
      return known;
    }

    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      throw new AttendantModeRefusedError('ticket not found');
    }

    const attendantId = [...this.sessions.entries()].find(([, siteId]) => siteId === ticket.siteId)?.[0];
    if (attendantId === undefined) {
      throw new AttendantModeRefusedError('not clocked in');
    }

    if (ticket.paid) {
      const success = { ok: true as const, requestId, ticketId, paid: true };
      this.paidResponses.set(requestId, success);
      return success;
    }

    const updated: TicketSummary = { ...ticket, paid: true };
    this.tickets.set(ticketId, updated);
    const success = { ok: true as const, requestId, ticketId, paid: true };
    this.paidResponses.set(requestId, success);
    return success;
  }

  /** Use this in tests to simulate a server that accepts the action but then drops the answer. */
  async tickCash(ticketId: TicketId, requestId: RequestId): Promise<MarkPaidResult> {
    return this.markTicketPaid(ticketId, requestId);
  }

  /** For tests that want to assert the server state without the client. */
  getState(): ReadonlyMap<TicketId, TicketSummary> {
    return this.tickets;
  }

  /** The same site a logged-in attendant is bound to. */
  siteFor(attendantId: PersonId): SiteId | undefined {
    return this.sessions.get(attendantId);
  }
}

export function throwRefused(refusal: 'wrong site' | 'not clocked in' | 'ticket not found'): never {
  throw new AttendantModeRefusedError(refusal);
}
