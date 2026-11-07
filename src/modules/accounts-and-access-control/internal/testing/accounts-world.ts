import { signToken } from '../../../../entrypoint/auth/token';
import { TEST_TOKEN_SECRET } from '../../../../entrypoint/test-helpers';
import { FixedClock } from '../../../../shared/clock';
import {
  createAccountsAndAccessControl,
  createInMemoryAccountsStores,
  RecordingSignInCodeSender,
  type AccountsAndAccessControl,
  type AccountsAndAccessControlStores,
  type SiteLocator,
} from '../../public';

export const NO_SITES: SiteLocator = { locateSite: async () => undefined, locateZone: async () => undefined };

/** This module over in-memory stores, a fixed clock, the recording code sender and the entry point's token signer. */
export interface AccountsWorld {
  readonly accounts: AccountsAndAccessControl;
  readonly stores: AccountsAndAccessControlStores;
  readonly codeSender: RecordingSignInCodeSender;
  readonly clock: FixedClock;
}

export function createAccountsWorld(siteLocator: SiteLocator = NO_SITES): AccountsWorld {
  const stores = createInMemoryAccountsStores();
  const codeSender = new RecordingSignInCodeSender();
  const clock = new FixedClock(new Date('2026-11-05T08:00:00Z'));
  const accounts = createAccountsAndAccessControl({
    stores,
    siteLocator,
    signInCodeSender: codeSender,
    tokenIssuer: { issue: (actor) => signToken(actor, TEST_TOKEN_SECRET) },
    clock,
  });
  return { accounts, stores, codeSender, clock };
}
