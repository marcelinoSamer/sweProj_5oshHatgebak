import type { TicketId } from '../../../shared/identifiers';
import type { RequestId } from '../../../shared/request-id';
import type { UnitOfWork } from '../../../shared/unit-of-work';
import type { PaymentRecord } from '../public';

/**
 * Storage ports owned by this module. The in-memory adapter in `adapters/` implements them for every test; the
 * PostgreSQL adapter will implement the same ports over the `payments` schema.
 */

/** One row of the payments table: the public record plus what the module keeps for itself. */
export interface StoredPayment extends PaymentRecord {
  /** The request id of the write that created the row; the provider's idempotency key (ADR-08). */
  readonly requestId: RequestId;
  readonly payerId: string;
  /** Server time, from the clock (Rule I). */
  readonly recordedAt: string;
}

/** The payments table. Rows are only ever added: a correction is a new row, never an edit (task C7). */
export interface PaymentStore {
  add(payment: StoredPayment): Promise<void>;
  forTicket(ticketId: TicketId): Promise<readonly StoredPayment[]>;
}

/**
 * Hands out a store that joins the write's unit of work, so the payment row commits together with the ticket
 * status, the audit entry and the event, or not at all (Rule E).
 */
export interface PaymentStores {
  boundTo(unitOfWork: UnitOfWork): PaymentStore;
}
