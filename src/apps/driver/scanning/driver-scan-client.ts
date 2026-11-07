/**
 * Driver App scanning client (task D3).
 * Collects the scanned code, keeps one request id until the server answers, and retries with that same id
 * when the connection drops mid-scan. Ticket decisions stay on the server (Rule A): the client shows the server's
 * refusal and never judges a code, a site or a ticket itself.
 *
 * A request id is kept only while the retry is for the same scan. A different code or site is a different request
 * and gets a new id, so a retry can never silently send an older scan in place of the one the driver just made.
 */
import type { SiteId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import {
  TicketScanRefusedError,
  TicketScanTransportError,
  type ClosedTicketScan,
  type OpenedTicketScan,
  type TicketScanApi,
  type TicketScanRefusal,
} from './ticket-scan-api';

export type DriverScanClientSuccess<T> = { readonly ok: true; readonly value: T };
export type DriverScanClientRefusal = { readonly ok: false; readonly error: TicketScanRefusal };
export type DriverScanClientFailure =
  | { readonly ok: false; readonly error: 'connection lost'; readonly requestId: RequestId }
  | DriverScanClientRefusal;
export type DriverScanClientResult<T> = DriverScanClientSuccess<T> | DriverScanClientFailure;

export interface DriverScanClientOptions {
  readonly api: TicketScanApi;
  /** Creates a new client request id when a scan starts and none is pending for the same scan. */
  readonly createRequestId: () => RequestId;
}

/** One write that has been sent and not yet answered, with the scan it was sent for. */
interface PendingRequest {
  readonly input: string;
  readonly requestId: RequestId;
}

/** A scan that is running now, so a second tap on the same scan joins it instead of sending again. */
interface InFlight<T> {
  readonly input: string;
  readonly result: Promise<DriverScanClientResult<T>>;
}

export class DriverScanClient {
  private readonly api: TicketScanApi;
  private readonly createRequestId: () => RequestId;
  private pendingOpen: PendingRequest | undefined;
  private pendingClose: PendingRequest | undefined;
  private activeTicketId: TicketId | undefined;
  private inFlightEntry: InFlight<OpenedTicketScan> | undefined;
  private inFlightExit: InFlight<ClosedTicketScan> | undefined;

  constructor(options: DriverScanClientOptions) {
    this.api = options.api;
    this.createRequestId = options.createRequestId;
  }

  /** The open ticket from the last successful entry scan, if any. */
  activeTicket(): TicketId | undefined {
    return this.activeTicketId;
  }

  /** Request id held until the entry answer arrives; undefined when idle. */
  pendingEntryRequestId(): RequestId | undefined {
    return this.pendingOpen?.requestId;
  }

  /** Request id held until the exit answer arrives; undefined when idle. */
  pendingExitRequestId(): RequestId | undefined {
    return this.pendingClose?.requestId;
  }

  /**
   * Open a ticket from an entry code. A second tap on the same scan before the answer arrives joins the same
   * in-flight call and the same request id. A transport failure keeps that request id so a retry cannot create a
   * second ticket. A scan of a different code waits for the running one, then is sent on its own.
   */
  scanEntry(siteId: SiteId, entryCode: string): Promise<DriverScanClientResult<OpenedTicketScan>> {
    const input = `${siteId}\u0000${entryCode}`;
    const running = this.inFlightEntry;
    if (running?.input === input) {
      return running.result;
    }

    const start = () => this.runEntryScan(siteId, entryCode, input);
    const result: Promise<DriverScanClientResult<OpenedTicketScan>> = (
      running === undefined ? start() : running.result.then(start, start)
    ).finally(() => {
      if (this.inFlightEntry?.result === result) {
        this.inFlightEntry = undefined;
      }
    });
    this.inFlightEntry = { input, result };
    return result;
  }

  /**
   * Close the active ticket from an exit code. Keeps one request id across connection-loss retries.
   * With no open ticket there is nothing to send, so the answer is the same refusal the server would give.
   */
  scanExit(exitCode: string): Promise<DriverScanClientResult<ClosedTicketScan>> {
    const ticketId = this.activeTicketId;
    if (ticketId === undefined) {
      return Promise.resolve({ ok: false, error: 'no open ticket' });
    }

    const input = `${ticketId}\u0000${exitCode}`;
    const running = this.inFlightExit;
    if (running?.input === input) {
      return running.result;
    }

    const start = () => this.runExitScan(ticketId, exitCode, input);
    const result: Promise<DriverScanClientResult<ClosedTicketScan>> = (
      running === undefined ? start() : running.result.then(start, start)
    ).finally(() => {
      if (this.inFlightExit?.result === result) {
        this.inFlightExit = undefined;
      }
    });
    this.inFlightExit = { input, result };
    return result;
  }

  private async runEntryScan(
    siteId: SiteId,
    entryCode: string,
    input: string,
  ): Promise<DriverScanClientResult<OpenedTicketScan>> {
    const pending = this.keepOrCreate(this.pendingOpen, input);
    this.pendingOpen = pending;

    try {
      const opened = await this.api.openTicket({ requestId: pending.requestId, siteId, entryCode });
      this.activeTicketId = opened.ticketId;
      this.pendingOpen = undefined;
      return { ok: true, value: opened };
    } catch (error) {
      if (error instanceof TicketScanTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingOpen = undefined;
      return refusalOrRethrow(error);
    }
  }

  private async runExitScan(
    ticketId: TicketId,
    exitCode: string,
    input: string,
  ): Promise<DriverScanClientResult<ClosedTicketScan>> {
    const pending = this.keepOrCreate(this.pendingClose, input);
    this.pendingClose = pending;

    try {
      const closed = await this.api.closeTicket({ requestId: pending.requestId, ticketId, exitCode });
      this.activeTicketId = undefined;
      this.pendingClose = undefined;
      return { ok: true, value: closed };
    } catch (error) {
      if (error instanceof TicketScanTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingClose = undefined;
      const refusal = refusalOrRethrow(error);
      if (refusal.error === 'no open ticket') {
        this.activeTicketId = undefined;
      }
      return refusal;
    }
  }

  /** The id of an unanswered request for the same scan, or a new one. */
  private keepOrCreate(existing: PendingRequest | undefined, input: string): PendingRequest {
    return existing?.input === input ? existing : { input, requestId: this.createRequestId() };
  }
}

/** A refusal from the server goes to the screen; anything else is a fault and is not hidden. */
function refusalOrRethrow(error: unknown): DriverScanClientRefusal {
  if (error instanceof TicketScanRefusedError) {
    return { ok: false, error: error.refusal };
  }
  throw error;
}