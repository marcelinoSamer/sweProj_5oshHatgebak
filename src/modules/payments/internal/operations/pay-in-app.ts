import { refuse, respond } from '../../../../entrypoint/http';
import type { WriteContext, WriteOperation, WriteOutcome } from '../../../../entrypoint/operations/operation';
import type { EventPublisher } from '../../../../shared/events/event';
import type { UnitOfWork } from '../../../../shared/unit-of-work';
import type { PaymentLedger, PayRefusal } from '../../public';

/** What the operation needs from the module: a ledger joined to the write's unit of work. */
export interface LedgerFactory {
  ledgerBoundTo(unitOfWork: UnitOfWork, events: EventPublisher): PaymentLedger;
}

export const PAY_IN_APP_OPERATION = 'payments.payInApp';

/** The HTTP status for each refusal. 409 is "the ticket is not in a state to be paid", 503 is "try again later". */
const STATUS_BY_REFUSAL: Readonly<Record<PayRefusal, number>> = {
  declined: 402,
  'pay later or pay cash': 503,
  'ticket not closed': 409,
  'nothing to pay': 409,
  'not your ticket': 403,
};

/**
 * POST /payments/app: a driver pays a closed ticket in the app (task C2). The pipeline has already checked the
 * token, the role, the request id and the body; the handler only runs the ledger and shapes the answer. A refusal
 * carries a status of 400 or above, so the pipeline rolls the unit of work back and keeps no row and no entry.
 */
export function payInAppOperation(payments: LedgerFactory): WriteOperation {
  return {
    kind: 'write',
    name: PAY_IN_APP_OPERATION,
    method: 'POST',
    path: '/payments/app',
    allowedRoles: ['driver'],
    bodySchema: { fields: { ticketId: 'string' } },
    examples: { valid: { ticketId: 'ticket-1' }, invalid: {} },
    async handle(context: WriteContext): Promise<WriteOutcome> {
      const ticketId = context.body['ticketId'];
      if (typeof ticketId !== 'string') {
        throw new Error('The body passed validation without a ticketId string');
      }
      const ledger = payments.ledgerBoundTo(context.transaction, context.events);
      const paid = await ledger.payInApp(context.requestId, ticketId, context.actor.personId);
      if (!paid.ok) {
        return { response: refuse(STATUS_BY_REFUSAL[paid.error], paid.error) };
      }
      const status = paid.value.outcome === 'pending' ? 202 : 201;
      return { response: respond(status, { payment: paid.value }), audit: {} };
    },
  };
}
