/**
 * AttendantModeApi adapter: the Staff App talks to the main system only through the HTTP entry point.
 * The server's refusal is read from the `error` text; the app never decides whether a site or ticket is valid.
 */
import type { HttpRequest, HttpResponse } from '../../../entrypoint/http';
import { REQUEST_ID_HEADER, type RequestId } from '../../../shared/request-id';
import {
  ATTENDANT_ASSISTED_TICKET_PATH,
  ATTENDANT_CLOCK_IN_PATH,
  ATTENDANT_CARS_WAITING_FOR_CASH_PATH,
  ATTENDANT_OPEN_TICKETS_PATH,
  ATTENDANT_TICK_CASH_PATH,
} from './attendant-mode-routes';
import {
  AttendantModeRefusedError,
  AttendantModeTransportError,
  isAttendantModeRefusal,
  type AssistedTicketInput,
  type AssistedTicketResult,
  type AttendantClockInResult,
  type AttendantModeApi,
  type MarkPaidResult,
  type TicketSummary,
} from './attendant-mode-api';

export type EntryPointHandle = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpAttendantModeApiOptions {
  readonly handle: EntryPointHandle;
  readonly authorizationHeader: () => string;
  readonly dropSuccessfulAnswers?: { remaining: number };
}

export class HttpAttendantModeApi implements AttendantModeApi {
  private readonly handle: EntryPointHandle;
  private readonly authorizationHeader: () => string;
  private readonly dropSuccessfulAnswers: { remaining: number };

  constructor(options: HttpAttendantModeApiOptions) {
    this.handle = options.handle;
    this.authorizationHeader = options.authorizationHeader;
    this.dropSuccessfulAnswers = options.dropSuccessfulAnswers ?? { remaining: 0 };
  }

  async clockIn(attendantId: string, siteId: string, code: string, requestId: RequestId): Promise<AttendantClockInResult> {
    const response = await this.send('POST', ATTENDANT_CLOCK_IN_PATH, requestId, { attendantId, siteId, code });
    return readClockIn(response);
  }

  async listOpenTickets(siteId: string): Promise<readonly TicketSummary[]> {
    const response = await this.send('GET', ATTENDANT_OPEN_TICKETS_PATH, undefined, { siteId });
    return readTicketList(response);
  }

  async listCarsWaitingForCash(siteId: string): Promise<readonly string[]> {
    const response = await this.send('GET', ATTENDANT_CARS_WAITING_FOR_CASH_PATH, undefined, { siteId });
    return readStringList(response, 'cars');
  }

  async openAssistedTicket(input: AssistedTicketInput): Promise<AssistedTicketResult> {
    const response = await this.send('POST', ATTENDANT_ASSISTED_TICKET_PATH, input.requestId, {
      attendantId: input.attendantId,
      siteId: input.siteId,
      driverId: input.driverId,
      plate: input.plate,
    });
    return readAssistedTicket(response);
  }

  async markTicketPaid(ticketId: string, requestId: RequestId): Promise<MarkPaidResult> {
    const response = await this.send('POST', ATTENDANT_TICK_CASH_PATH, requestId, { ticketId });
    return readPaid(response);
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    requestId: RequestId | undefined,
    body: Record<string, string>,
  ): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.handle({
        method,
        path,
        query: method === 'GET' ? body : {},
        headers: {
          authorization: this.authorizationHeader(),
          ...(requestId === undefined ? {} : { [REQUEST_ID_HEADER]: requestId }),
        },
        ...(method === 'GET' ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof AttendantModeTransportError) {
        throw error;
      }
      throw new AttendantModeTransportError(
        error instanceof Error ? error.message : 'connection lost before the answer arrived',
      );
    }

    if (response.status >= 500) {
      throw new AttendantModeTransportError(`server error ${response.status}`);
    }

    if (response.status < 400 && this.dropSuccessfulAnswers.remaining > 0) {
      this.dropSuccessfulAnswers.remaining -= 1;
      throw new AttendantModeTransportError();
    }

    return response;
  }
}

function readClockIn(response: HttpResponse): AttendantClockInResult {
  if (response.status >= 400) {
    throw refusal(response);
  }
  const body = asRecord(response.body);
  const requestId = requiredString(body, 'requestId');
  return {
    ok: true,
    requestId,
    attendantId: requiredString(body, 'attendantId'),
    siteId: requiredString(body, 'siteId'),
  };
}

function readTicketList(response: HttpResponse): TicketSummary[] {
  if (response.status >= 400) {
    throw refusal(response);
  }
  const body = asRecord(response.body);
  const tickets = body['tickets'];
  if (!Array.isArray(tickets)) {
    throw new Error('server answer missing tickets');
  }
  return tickets.map((ticket) => {
    const record = asRecord(ticket);
    return {
      ticketId: requiredString(record, 'ticketId'),
      driverId: requiredString(record, 'driverId'),
      siteId: requiredString(record, 'siteId'),
      plate: requiredString(record, 'plate'),
      paid: requiredBoolean(record, 'paid'),
      assisted: requiredBoolean(record, 'assisted'),
    };
  });
}

function readStringList(response: HttpResponse, field: string): string[] {
  if (response.status >= 400) {
    throw refusal(response);
  }
  const body = asRecord(response.body);
  const values = body[field];
  if (!Array.isArray(values)) {
    throw new Error(`server answer missing ${field}`);
  }
  return values.map((value) => {
    if (typeof value !== 'string') {
      throw new Error(`server answer field ${field} contains a non-string`);
    }
    return value;
  });
}

function readAssistedTicket(response: HttpResponse): AssistedTicketResult {
  if (response.status >= 400) {
    throw refusal(response);
  }
  const body = asRecord(response.body);
  const requestId = requiredString(body, 'requestId');
  return {
    ok: true,
    requestId,
    ticketId: requiredString(body, 'ticketId'),
    driverId: requiredString(body, 'driverId'),
    siteId: requiredString(body, 'siteId'),
    plate: requiredString(body, 'plate'),
    paid: requiredBoolean(body, 'paid'),
    assisted: requiredBoolean(body, 'assisted'),
  };
}

function readPaid(response: HttpResponse): MarkPaidResult {
  if (response.status >= 400) {
    throw refusal(response);
  }
  const body = asRecord(response.body);
  return {
    ok: true,
    requestId: requiredString(body, 'requestId'),
    ticketId: requiredString(body, 'ticketId'),
    paid: requiredBoolean(body, 'paid'),
  };
}

function refusal(response: HttpResponse): Error {
  if (response.status === 401) {
    return new AttendantModeRefusedError('not clocked in');
  }
  const reason = errorMessage(response);
  return isAttendantModeRefusal(reason) ? new AttendantModeRefusedError(reason) : new Error(reason);
}

function errorMessage(response: HttpResponse): string {
  const body = asRecord(response.body);
  const error = body['error'];
  return typeof error === 'string' ? error : `request refused with status ${response.status}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
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

function requiredBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') {
    throw new Error(`server answer missing ${field}`);
  }
  return value;
}
