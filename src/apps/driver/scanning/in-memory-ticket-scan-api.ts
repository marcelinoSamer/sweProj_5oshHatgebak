/**
 * In-memory stand-in for the ticket scan HTTP API while Teammate B's TicketDesk is not yet plugged into the
 * entry point. It mirrors the server's repeatable-write rule: the same request id returns the same answer and
 * opens or closes at most once. Not a production module — tests and local prototypes only.
 *
 * The codes are `entry-<site>` and `exit-<site>`; the site a code belongs to is read from the code, as the real
 * server reads it from the signed code.
 */
import type { RequestId } from '../../../shared/request-id';
import {
  TicketScanRefusedError,
  TicketScanTransportError,
  type CloseTicketScanInput,
  type ClosedTicketScan,
  type OpenTicketScanInput,
  type OpenedTicketScan,
  type TicketScanApi,
} from './ticket-scan-api';

export class InMemoryTicketScanApi implements TicketScanApi {
  private readonly openResponses = new Map<RequestId, OpenedTicketScan>();
  private readonly closeResponses = new Map<RequestId, ClosedTicketScan>();
  /** The one open ticket of the current driver, with the site it was opened at. */
  private openTicketOfDriver: OpenedTicketScan | undefined;
  private nextTicketNumber = 1;
  private transportDropsRemaining = 0;

  /** How many tickets this stand-in has ever opened (for the D3 duplicate report). */
  ticketsOpenedCount(): number {
    return this.nextTicketNumber - 1;
  }

  /** Drop the next successful answers after the server has applied them (airplane mid-scan). */
  dropNextAnswers(count: number): void {
    this.transportDropsRemaining = count;
  }

  async openTicket(input: OpenTicketScanInput): Promise<OpenedTicketScan> {
    const known = this.openResponses.get(input.requestId);
    if (known !== undefined) {
      this.maybeDropAfterApply();
      return known;
    }

    if (this.openTicketOfDriver !== undefined) {
      throw new TicketScanRefusedError('car already parked');
    }

    if (input.entryCode !== `entry-${input.siteId}`) {
      throw new TicketScanRefusedError(input.entryCode.startsWith('exit-') ? 'wrong site' : 'forged code');
    }

    const response: OpenedTicketScan = {
      ticketId: `ticket-${this.nextTicketNumber}`,
      siteId: input.siteId,
      status: 'opened',
    };
    this.nextTicketNumber += 1;
    this.openResponses.set(input.requestId, response);
    this.openTicketOfDriver = response;
    this.maybeDropAfterApply();
    return response;
  }

  async closeTicket(input: CloseTicketScanInput): Promise<ClosedTicketScan> {
    const known = this.closeResponses.get(input.requestId);
    if (known !== undefined) {
      this.maybeDropAfterApply();
      return known;
    }

    const open = this.openTicketOfDriver;
    if (open === undefined || open.ticketId !== input.ticketId) {
      throw new TicketScanRefusedError('no open ticket');
    }

    if (input.exitCode !== `exit-${open.siteId}`) {
      throw new TicketScanRefusedError(input.exitCode.startsWith('entry-') ? 'wrong site' : 'forged code');
    }

    const response: ClosedTicketScan = { ticketId: open.ticketId, siteId: open.siteId, status: 'closed' };
    this.closeResponses.set(input.requestId, response);
    this.openTicketOfDriver = undefined;
    this.maybeDropAfterApply();
    return response;
  }

  private maybeDropAfterApply(): void {
    if (this.transportDropsRemaining <= 0) {
      return;
    }
    this.transportDropsRemaining -= 1;
    throw new TicketScanTransportError();
  }
}