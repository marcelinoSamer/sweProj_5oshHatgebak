/**
 * The Driver App's view of ticket open and close by scan.
 * The real adapter calls the main system's HTTP entry point (`http-ticket-scan-api.ts`); tests that need no server
 * use an in-memory stand-in.
 * The app holds no ticket rules: it only sends what the driver scanned and shows what the server returned.
 *
 * The shapes follow Teammate B's `TicketDesk` in the ticketing module's public interface: opening takes the site and
 * the entry code, closing takes the ticket and the exit code. Who the driver is comes from the token, never from here.
 */
import type { SiteId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';

export interface OpenTicketScanInput {
  readonly requestId: RequestId;
  readonly siteId: SiteId;
  readonly entryCode: string;
}

export interface CloseTicketScanInput {
  readonly requestId: RequestId;
  readonly ticketId: TicketId;
  readonly exitCode: string;
}

export interface OpenedTicketScan {
  readonly ticketId: TicketId;
  readonly siteId: SiteId;
  readonly status: 'opened';
}

export interface ClosedTicketScan {
  readonly ticketId: TicketId;
  readonly siteId: SiteId;
  readonly status: 'closed';
}

/** Teammate B's `OpenRefusal` and `CloseRefusal`, plus "not signed in" when the server does not accept the token. */
export type TicketScanRefusal =
  | 'car already parked'
  | 'no open ticket'
  | 'forged code'
  | 'wrong site'
  | 'site closed'
  | 'site full'
  | 'not signed in';

export const TICKET_SCAN_REFUSALS: readonly TicketScanRefusal[] = [
  'car already parked',
  'no open ticket',
  'forged code',
  'wrong site',
  'site closed',
  'site full',
  'not signed in',
];

export function isTicketScanRefusal(candidate: unknown): candidate is TicketScanRefusal {
  return typeof candidate === 'string' && (TICKET_SCAN_REFUSALS as readonly string[]).includes(candidate);
}

/** The connection dropped before an answer arrived: the write may or may not have happened. Retry with the same id. */
export class TicketScanTransportError extends Error {
  constructor(message = 'connection lost before the answer arrived') {
    super(message);
    this.name = 'TicketScanTransportError';
  }
}

/** The server answered and said no. Nothing was changed. */
export class TicketScanRefusedError extends Error {
  readonly refusal: TicketScanRefusal;

  constructor(refusal: TicketScanRefusal) {
    super(refusal);
    this.name = 'TicketScanRefusedError';
    this.refusal = refusal;
  }
}

export interface TicketScanApi {
  openTicket(input: OpenTicketScanInput): Promise<OpenedTicketScan>;
  closeTicket(input: CloseTicketScanInput): Promise<ClosedTicketScan>;
}