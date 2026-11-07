import type { PersonId, SiteId, TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import {
  AttendantModeRefusedError,
  AttendantModeTransportError,
  type AssistedTicketInput,
  type AssistedTicketSuccess,
  type AttendantClockInSuccess,
  type AttendantModeApi,
  type AttendantModeRefusal,
  type MarkPaidSuccess,
  type TicketSummary,
} from './attendant-mode-api';

// export type AttendantModeClientSuccess<T> = { readonly ok: true; readonly value: T };
// export type AttendantModeClientFailure =
//   | { readonly ok: false; readonly error: 'connection lost'; readonly requestId: RequestId }
//   | { readonly ok: false; readonly error: AttendantModeRefusal };
// export type AttendantModeClientResult<T> = AttendantModeClientSuccess<T> | AttendantModeClientFailure;

export type AttendantModeClientSuccess<T> = { readonly ok: true; readonly value: T };
export type AttendantModeClientRefusal = { readonly ok: false; readonly error: AttendantModeRefusal };
export type AttendantModeClientConnectionLostOnRead = { readonly ok: false; readonly error: 'connection lost' };
export type AttendantModeClientConnectionLostOnWrite = {
  readonly ok: false;
  readonly error: 'connection lost';
  readonly requestId: RequestId;
};

export type AttendantModeClientFailure = AttendantModeClientConnectionLostOnWrite | AttendantModeClientRefusal;
export type AttendantModeClientResult<T> = AttendantModeClientSuccess<T> | AttendantModeClientFailure;
export type AttendantModeClientReadResult<T> =
  | AttendantModeClientSuccess<T>
  | AttendantModeClientConnectionLostOnRead
  | AttendantModeClientRefusal;


export interface AttendantModeClientOptions {
  readonly api: AttendantModeApi;
  readonly createRequestId: () => RequestId;
}

interface PendingRequest {
  readonly input: string;
  readonly requestId: RequestId;
}

export class AttendantModeClient {
  private readonly api: AttendantModeApi;
  private readonly createRequestId: () => RequestId;
  private attendantId: PersonId | undefined;
  private siteId: SiteId | undefined;
  private pendingClockIn: PendingRequest | undefined;
  private pendingAssisted: PendingRequest | undefined;
  private pendingMarkPaid: PendingRequest | undefined;

  constructor(options: AttendantModeClientOptions) {
    this.api = options.api;
    this.createRequestId = options.createRequestId;
  }

  attendant(): PersonId | undefined {
    return this.attendantId;
  }

  sessionSiteId(): SiteId | undefined {
    return this.siteId;
  }

  pendingClockInRequestId(): RequestId | undefined {
    return this.pendingClockIn?.requestId;
  }

  pendingAssistedRequestId(): RequestId | undefined {
    return this.pendingAssisted?.requestId;
  }

  pendingMarkPaidRequestId(): RequestId | undefined {
    return this.pendingMarkPaid?.requestId;
  }

  async clockIn(attendantId: PersonId, siteId: SiteId, code: string): Promise<AttendantModeClientResult<AttendantClockInSuccess>> {
    const pending = this.keepOrCreate(this.pendingClockIn, `${attendantId}\u0000${siteId}\u0000${code}`);
    this.pendingClockIn = pending;

    try {
      const result = await this.api.clockIn(attendantId, siteId, code, pending.requestId);
      this.pendingClockIn = undefined;
      if (result.ok) {
        this.attendantId = attendantId;
        this.siteId = result.siteId;
        return { ok: true, value: result };
      }

      this.attendantId = undefined;
      this.siteId = undefined;
      return { ok: false, error: result.error };
    } catch (error) {
      if (error instanceof AttendantModeTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingClockIn = undefined;
      return this.refusalOrRethrow(error);
    }
  }

  async listOpenTickets(): Promise<AttendantModeClientReadResult<readonly TicketSummary[]>> {
    if (this.siteId === undefined) {
      return { ok: false, error: 'not clocked in' };
    }

    try {
      return { ok: true, value: await this.api.listOpenTickets(this.siteId) };
    } catch (error) {
      if (error instanceof AttendantModeTransportError) {
        return { ok: false, error: 'connection lost' };
      }
      return this.refusalOrRethrow(error);
    }
  }

  async listCarsWaitingForCash(): Promise<AttendantModeClientReadResult<readonly string[]>> {
    if (this.siteId === undefined) {
      return { ok: false, error: 'not clocked in' };
    }

    try {
      return { ok: true, value: await this.api.listCarsWaitingForCash(this.siteId) };
    } catch (error) {
      if (error instanceof AttendantModeTransportError) {
        return { ok: false, error: 'connection lost' };
      }
      return this.refusalOrRethrow(error);
    }
  }

  async openAssistedTicket(driverId: PersonId, plate: string): Promise<AttendantModeClientResult<AssistedTicketSuccess>> {
    if (this.attendantId === undefined || this.siteId === undefined) {
      return { ok: false, error: 'not clocked in' };
    }

    const pending = this.keepOrCreate(this.pendingAssisted, `${this.attendantId}\u0000${this.siteId}\u0000${driverId}\u0000${plate}`);
    this.pendingAssisted = pending;

    const input: AssistedTicketInput = {
      requestId: pending.requestId,
      attendantId: this.attendantId,
      siteId: this.siteId,
      driverId,
      plate,
    };

    try {
      const result = await this.api.openAssistedTicket(input);
      this.pendingAssisted = undefined;
      if (result.ok) {
        return { ok: true, value: result };
      }
      return { ok: false, error: result.error };
    } catch (error) {
      if (error instanceof AttendantModeTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingAssisted = undefined;
      return this.refusalOrRethrow(error);
    }
  }

  async markTicketPaid(ticketId: TicketId): Promise<AttendantModeClientResult<MarkPaidSuccess>> {
    if (this.attendantId === undefined || this.siteId === undefined) {
      return { ok: false, error: 'not clocked in' };
    }

    const pending = this.keepOrCreate(this.pendingMarkPaid, ticketId);
    this.pendingMarkPaid = pending;

    try {
      const result = await this.api.markTicketPaid(ticketId, pending.requestId);
      this.pendingMarkPaid = undefined;
      if (result.ok) {
        return { ok: true, value: result };
      }
      return { ok: false, error: result.error };
    } catch (error) {
      if (error instanceof AttendantModeTransportError) {
        return { ok: false, error: 'connection lost', requestId: pending.requestId };
      }
      this.pendingMarkPaid = undefined;
      return this.refusalOrRethrow(error);
    }
  }

  private keepOrCreate(existing: PendingRequest | undefined, input: string): PendingRequest {
    return existing?.input === input ? existing : { input, requestId: this.createRequestId() };
  }

  /** A refusal from the server goes to the screen; anything else is a fault and is not hidden. */
  private refusalOrRethrow(error: unknown): AttendantModeClientRefusal {
    if (error instanceof AttendantModeRefusedError) {
      if (error.refusal === 'not clocked in') {
        this.attendantId = undefined;
        this.siteId = undefined;
      }
      return { ok: false, error: error.refusal };
    }
    throw error;
  }
}
