/**
 * HTTP routes the Driver App uses for entry and exit scans.
 * Teammate B's TicketDesk operations should register these paths (or we update the adapter when the real paths land).
 */
export const DRIVER_OPEN_TICKET_PATH = '/driver/tickets/open';
export const DRIVER_CLOSE_TICKET_PATH = '/driver/tickets/close';

export const DRIVER_OPEN_TICKET_OPERATION = 'driver.openTicket';
export const DRIVER_CLOSE_TICKET_OPERATION = 'driver.closeTicket';
