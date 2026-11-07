import type { TableAccess } from '../../../../adapters/in-memory/in-memory-database';
import type { TicketId } from '../../../../shared/identifiers';
import type { RequestId } from '../../../../shared/request-id';
import type { UnitOfWork } from '../../../../shared/unit-of-work';
import type { PaymentStore, PaymentStores, StoredPayment } from '../ports';

/** The table name inside the foundation's in-memory database, mirroring the `payments` schema. */
export const PAYMENTS_TABLE = 'payments.payments';

/**
 * The payments table over the foundation's in-memory database. Given a transaction, every row it adds is staged and
 * lands only when that transaction commits; given the database itself, a row lands at once (for reading in tests).
 */
export class InMemoryPaymentStore implements PaymentStore {
  constructor(private readonly access: TableAccess) {}

  async add(payment: StoredPayment): Promise<void> {
    this.access.insert(PAYMENTS_TABLE, payment);
  }

  async forTicket(ticketId: TicketId): Promise<readonly StoredPayment[]> {
    return this.access.rows<StoredPayment>(PAYMENTS_TABLE).filter((payment) => payment.ticketId === ticketId);
  }

  async byRequestId(requestId: RequestId): Promise<StoredPayment | undefined> {
    return this.access.rows<StoredPayment>(PAYMENTS_TABLE).find((payment) => payment.requestId === requestId);
  }
}

/** True when the unit of work is the in-memory database's transaction, which also reads and stages rows. */
function offersTableAccess(unitOfWork: UnitOfWork): unitOfWork is UnitOfWork & TableAccess {
  const candidate = unitOfWork as Partial<TableAccess>;
  return typeof candidate.insert === 'function' && typeof candidate.rows === 'function';
}

export function createInMemoryPaymentStores(): PaymentStores {
  return {
    boundTo(unitOfWork) {
      if (!offersTableAccess(unitOfWork)) {
        throw new Error('The in-memory payment store can only join a transaction of the in-memory database');
      }
      return new InMemoryPaymentStore(unitOfWork);
    },
  };
}
