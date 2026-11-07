/**
 * TicketScanApi adapter: the Driver App talks to the main system only through the HTTP entry point.
 * No ticket rules here — status codes and bodies from the server are mapped to results or transport errors.
 */
import type { HttpRequest, HttpResponse } from '../../../entrypoint/http';
import { REQUEST_ID_HEADER } from '../../../shared/request-id';
import { DRIVER_CLOSE_TICKET_PATH, DRIVER_OPEN_TICKET_PATH } from './driver-ticket-routes';
import {
  isTicketScanRefusal,
  TicketScanRefusedError,
  TicketScanTransportError,
  type CloseTicketScanInput,
  type ClosedTicketScan,
  type OpenTicketScanInput,
  type OpenedTicketScan,
  type TicketScanApi,
} from './ticket-scan-api';

export type EntryPointHandle = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpTicketScanApiOptions {
  readonly handle: EntryPointHandle;
  readonly authorizationHeader: () => string;
  /**
   * Test hook: after a successful server answer, drop this many responses so the client must retry
   * with the same request id (airplane mode after the server applied the write).
   */
  readonly dropSuccessfulAnswers?: { remaining: number };
}

export class HttpTicketScanApi implements TicketScanApi {
  private readonly handle: EntryPointHandle;
  private readonly authorizationHeader: () => string;
  private readonly dropSuccessfulAnswers: { remaining: number };

  constructor(options: HttpTicketScanApiOptions) {
    this.handle = options.handle;
    this.authorizationHeader = options.authorizationHeader;
    this.dropSuccessfulAnswers = options.dropSuccessfulAnswers ?? { remaining: 0 };
  }

  async openTicket(input: OpenTicketScanInput): Promise<OpenedTicketScan> {
    const response = await this.send(DRIVER_OPEN_TICKET_PATH, input.requestId, {
      siteId: input.siteId,
      entryCode: input.entryCode,
    });
    return readOpened(response);
  }

  async closeTicket(input: CloseTicketScanInput): Promise<ClosedTicketScan> {
    const response = await this.send(DRIVER_CLOSE_TICKET_PATH, input.requestId, {
      ticketId: input.ticketId,
      exitCode: input.exitCode,
    });
    return readClosed(response);
  }

  private async send(
    path: string,
    requestId: string,
    body: Record<string, string>,
  ): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.handle({
        method: 'POST',
        path,
        query: {},
        headers: {
          authorization: this.authorizationHeader(),
          [REQUEST_ID_HEADER]: requestId,
        },
        body,
      });
    } catch (error) {
      if (error instanceof TicketScanTransportError) {
        throw error;
      }
      throw new TicketScanTransportError(
        error instanceof Error ? error.message : 'connection lost before the answer arrived',
      );
    }

    if (response.status >= 500) {
      throw new TicketScanTransportError(`server error ${response.status}`);
    }

    if (response.status < 400 && this.dropSuccessfulAnswers.remaining > 0) {
      this.dropSuccessfulAnswers.remaining -= 1;
      throw new TicketScanTransportError();
    }

    return response;
  }
}

function readOpened(response: HttpResponse): OpenedTicketScan {
  if (response.status >= 400) {
    throw refusal(response);
  }
  const body = asRecord(response.body);
  const ticketId = requiredString(body, 'ticketId');
  const siteId = requiredString(body, 'siteId');
  return { ticketId, siteId, status: 'opened' };
}

function readClosed(response: HttpResponse): ClosedTicketScan {
  if (response.status >= 400) {
    throw refusal(response);
  }
  const body = asRecord(response.body);
  const ticketId = requiredString(body, 'ticketId');
  const siteId = requiredString(body, 'siteId');
  return { ticketId, siteId, status: 'closed' };
}


/**
 * The server's "no": a token it did not accept (401), or a refusal named in the answer's `error` text. The name is
 * read from the text, not from the status code, because the status codes of the ticket routes are not settled yet.
 * An answer with any other text is a fault, not a refusal, and is not turned into one.
 */
function refusal(response: HttpResponse): Error {
  if (response.status === 401) {
    return new TicketScanRefusedError('not signed in');
  }
  const reason = errorMessage(response);
  return isTicketScanRefusal(reason) ? new TicketScanRefusedError(reason) : new Error(reason);
}


function errorMessage(response: HttpResponse): string {
  const body = asRecord(response.body);
  const error = body['error'];
  return typeof error === 'string' ? error : `request refused with status ${response.status}`;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`server answer missing ${field}`);
  }
  return value;
}
