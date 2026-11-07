/**
 * The Staff App's view of attendant mode: clock in, list unpaid tickets, tick cash paid, and open an assisted ticket.
 * The app holds no business rules: it shows what the server says and keeps the request id for retrying the same
 * write after a lost answer. The server stays the authority for clock-in site checks and ticket ownership.
 */
import type { PersonId, SiteId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';

export interface AttendantClockInSuccess {
  readonly ok: true;
  readonly requestId: RequestId;
  readonly attendantId: PersonId;
  readonly siteId: SiteId;
}

export type AttendantClockInFailure = {
  readonly ok: false;
  readonly requestId: RequestId;
  readonly error: 'wrong site';
};

export type AttendantClockInResult = AttendantClockInSuccess | AttendantClockInFailure;

export interface TicketSummary {
  readonly ticketId: TicketId;
  readonly driverId: PersonId;
  readonly siteId: SiteId;
  readonly plate: string;
  readonly paid: boolean;
  readonly assisted: boolean;
}

export interface AssistedTicketInput {
  readonly requestId: RequestId;
  readonly attendantId: PersonId;
  readonly siteId: SiteId;
  readonly driverId: PersonId;
  readonly plate: string;
}

export interface AssistedTicketSuccess {
  readonly ok: true;
  readonly requestId: RequestId;
  readonly ticketId: TicketId;
  readonly driverId: PersonId;
  readonly siteId: SiteId;
  readonly plate: string;
  readonly paid: boolean;
  readonly assisted: boolean;
}

export type AssistedTicketFailure = {
  readonly ok: false;
  readonly requestId: RequestId;
  readonly error: 'not clocked in' | 'wrong site';
};

export type AssistedTicketResult = AssistedTicketSuccess | AssistedTicketFailure;

export interface MarkPaidSuccess {
  readonly ok: true;
  readonly requestId: RequestId;
  readonly ticketId: TicketId;
  readonly paid: boolean;
}

export type MarkPaidFailure = {
  readonly ok: false;
  readonly requestId: RequestId;
  readonly error: 'not clocked in' | 'ticket not found';
};

export type MarkPaidResult = MarkPaidSuccess | MarkPaidFailure;

export type AttendantModeRefusal = 'wrong site' | 'not clocked in' | 'ticket not found';

export const ATTENDANT_MODE_REFUSALS: readonly AttendantModeRefusal[] = [
  'wrong site',
  'not clocked in',
  'ticket not found',
];

export function isAttendantModeRefusal(candidate: unknown): candidate is AttendantModeRefusal {
  return typeof candidate === 'string' && (ATTENDANT_MODE_REFUSALS as readonly string[]).includes(candidate);
}

/** The connection dropped before the server answered; the same request id must be reused for the retry. */
export class AttendantModeTransportError extends Error {
  constructor(message = 'connection lost before the answer arrived') {
    super(message);
    this.name = 'AttendantModeTransportError';
  }
}

/** The server answered and said no. Nothing changed. */
export class AttendantModeRefusedError extends Error {
  readonly refusal: AttendantModeRefusal;

  constructor(refusal: AttendantModeRefusal) {
    super(refusal);
    this.name = 'AttendantModeRefusedError';
    this.refusal = refusal;
  }
}

export interface AttendantModeApi {
  clockIn(attendantId: PersonId, siteId: SiteId, code: string, requestId: RequestId): Promise<AttendantClockInResult>;
  listOpenTickets(siteId: SiteId): Promise<readonly TicketSummary[]>;
  listCarsWaitingForCash(siteId: SiteId): Promise<readonly string[]>;
  openAssistedTicket(input: AssistedTicketInput): Promise<AssistedTicketResult>;
  markTicketPaid(ticketId: TicketId, requestId: RequestId): Promise<MarkPaidResult>;
}
