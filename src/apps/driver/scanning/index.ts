export { DriverScanClient } from './driver-scan-client';
export type {
  DriverScanClientFailure,
  DriverScanClientRefusal,
  DriverScanClientResult,
} from './driver-scan-client';
export {
  DRIVER_CLOSE_TICKET_PATH,
  DRIVER_OPEN_TICKET_PATH,
} from './driver-ticket-routes';
export { HttpTicketScanApi } from './http-ticket-scan-api';
export { InMemoryTicketScanApi } from './in-memory-ticket-scan-api';
export {
  TicketScanRefusedError,
  TicketScanTransportError,
  type TicketScanApi,
  type TicketScanRefusal,
  type OpenedTicketScan,
  type ClosedTicketScan,
} from './ticket-scan-api';