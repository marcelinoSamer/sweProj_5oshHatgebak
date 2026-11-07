import type { Role } from '../../../../shared/identifiers';
import type { PlateReadPurpose } from '../../public';

/**
 * Who may see a plate, and why (task A4, ADR-06 Rule F). The car's owner always may. Anyone else needs a role that the
 * purpose allows and scope over the site concerned: the attendant of that site for the cash list, the inspector of
 * its zone for a look-up, a member of its district or the Chair for a receipt or a look-up.
 */
const ROLES_ALLOWED_FOR_PURPOSE: Readonly<Record<PlateReadPurpose, readonly Role[]>> = {
  receipt: ['member', 'chair'],
  'cash list': ['attendant'],
  'inspector look-up': ['inspector', 'member', 'chair'],
};

export const PLATE_READ_PURPOSES = Object.keys(ROLES_ALLOWED_FOR_PURPOSE) as readonly PlateReadPurpose[];

export function roleMayReadPlateFor(role: Role, purpose: PlateReadPurpose): boolean {
  return ROLES_ALLOWED_FOR_PURPOSE[purpose].includes(role);
}
