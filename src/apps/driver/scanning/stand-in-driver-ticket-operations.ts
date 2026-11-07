/**
 * Stand-in write operations for D3 integration tests until Teammate B registers real TicketDesk routes.
 * This is not the ticketing module: it only exists so the Driver App can exercise the entry point's
 * request-id and audit pipeline. Replace by composing B's operations when they land.
 */
import type { SiteId, TicketId } from '../../../shared/identifiers';
import { respond, refuse } from '../../../entrypoint/http';
import type { WriteOperation } from '../../../entrypoint/operations/operation';
import {
  DRIVER_CLOSE_TICKET_OPERATION,
  DRIVER_CLOSE_TICKET_PATH,
  DRIVER_OPEN_TICKET_OPERATION,
  DRIVER_OPEN_TICKET_PATH,
} from './driver-ticket-routes';

export interface StandInTicketDeskState {
  readonly openByDriver: Map<string, { readonly ticketId: TicketId; readonly siteId: SiteId }>;
  ticketsOpened: number;
  nextTicketNumber: number;
}

export function createStandInTicketDeskState(): StandInTicketDeskState {
  return {
    openByDriver: new Map(),
    ticketsOpened: 0,
    nextTicketNumber: 1,
  };
}

export function createStandInDriverTicketOperations(state: StandInTicketDeskState): readonly WriteOperation[] {
  const openTicket: WriteOperation = {
    kind: 'write',
    name: DRIVER_OPEN_TICKET_OPERATION,
    method: 'POST',
    path: DRIVER_OPEN_TICKET_PATH,
    allowedRoles: ['driver'],
    bodySchema: { fields: { siteId: 'string', entryCode: 'string' } },
    examples: {
      valid: { siteId: 'site-1', entryCode: 'entry-site-1' },
      invalid: { siteId: 1 },
    },
    async handle(context) {
      const siteId = String(context.body['siteId']);
      const entryCode = String(context.body['entryCode']);
      const driverId = context.actor.personId;

      if (state.openByDriver.has(driverId)) {
        return { response: refuse(409, 'car already parked') };
      }

      const expected = `entry-${siteId}`;
      if (entryCode !== expected) {
        const message = entryCode.startsWith('exit-') ? 'wrong site' : 'forged code';
        return { response: refuse(400, message) };
      }

      const ticketId = `ticket-${state.nextTicketNumber}`;
      state.nextTicketNumber += 1;
      state.ticketsOpened += 1;
      state.openByDriver.set(driverId, { ticketId, siteId });

      context.events.publish({
        topic: 'TicketOpened',
        payload: { ticketId, siteId, driverId },
      });

      return {
        response: respond(201, { ticketId, siteId, status: 'opened' }),
      };
    },
  };

  const closeTicket: WriteOperation = {
    kind: 'write',
    name: DRIVER_CLOSE_TICKET_OPERATION,
    method: 'POST',
    path: DRIVER_CLOSE_TICKET_PATH,
    allowedRoles: ['driver'],
    bodySchema: { fields: { ticketId: 'string', exitCode: 'string' } },
    examples: {
      valid: { ticketId: 'ticket-1', exitCode: 'exit-site-1' },
      invalid: { ticketId: 1 },
    },
    async handle(context) {
      const ticketId = String(context.body['ticketId']);
      const exitCode = String(context.body['exitCode']);
      const driverId = context.actor.personId;
      const open = state.openByDriver.get(driverId);

      if (open === undefined || open.ticketId !== ticketId) {
        return { response: refuse(409, 'no open ticket') };
      }

      const siteId = open.siteId;
      const expected = `exit-${siteId}`;
      if (exitCode !== expected) {
        const message = exitCode.startsWith('entry-') ? 'wrong site' : 'forged code';
        return { response: refuse(400, message) };
      }

      state.openByDriver.delete(driverId);
      context.events.publish({
        topic: 'TicketClosed',
        payload: { ticketId, siteId, driverId },
      });

      return {
        response: respond(200, { ticketId, siteId, status: 'closed' }),
      };
    },
  };

  return [openTicket, closeTicket];
}
