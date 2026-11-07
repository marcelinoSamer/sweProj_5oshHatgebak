import type { LicenceState } from '../../public';

/**
 * The only moves an approved request may order (task A11): a valid licence may be suspended or revoked, a suspended
 * one revoked. Revocation is final. Approvals offers no reinstatement, so suspended → valid is not a move here.
 */
const PERMITTED_MOVES: Readonly<Record<LicenceState, readonly LicenceState[]>> = {
  valid: ['suspended', 'revoked'],
  suspended: ['revoked'],
  revoked: [],
};

export function isPermittedMove(from: LicenceState, to: LicenceState): boolean {
  return PERMITTED_MOVES[from].includes(to);
}
