import { describe, expect, it } from 'vitest';
import { composeInMemoryApplication } from '../../../entrypoint/composition';
import { foundationOperations } from '../../../entrypoint/operations/foundation-operations';
import { TEST_TOKEN_SECRET } from '../../../entrypoint/test-helpers';
import { FixedClock } from '../../../shared/clock';
import { DriverSignInClient } from './driver-sign-in-client';
import { HttpDriverAuthApi } from './http-driver-auth-api';
import {
  createStandInAccountsState,
  createStandInCarOperations,
  createStandInSignInGateway,
  lastCodeSentTo,
} from './stand-in-driver-auth-operations';

const PHONE = '01012345678';
const UNKNOWN_PHONE = '01199999999';
const DRIVER_ID = `driver-${PHONE}`;

function buildStack(dropSuccessfulAnswers = { remaining: 0 }) {
  const accounts = createStandInAccountsState(TEST_TOKEN_SECRET, [PHONE]);
  const app = composeInMemoryApplication({
    tokenSecret: TEST_TOKEN_SECRET,
    clock: new FixedClock(new Date('2026-11-06T12:00:00Z')),
    operations: [...foundationOperations, ...createStandInCarOperations(accounts)],
  });
  const api = new HttpDriverAuthApi({
    handle: createStandInSignInGateway(accounts, app.handle),
    dropSuccessfulAnswers,
  });

  let serial = 1;
  const client = new DriverSignInClient({
    api,
    createRequestId: () => `d1-http-req-${String(serial++).padStart(4, '0')}`,
  });

  async function signIn(): Promise<void> {
    await client.submitPhone(PHONE);
    const code = lastCodeSentTo(accounts, PHONE);
    expect(code).toBeDefined();
    const result = await client.submitCode(code ?? '');
    expect(result.ok).toBe(true);
  }

  return { client, accounts, audit: app.audit, signIn };
}

describe('D1 Driver App sign-in and cars over the HTTP entry point', () => {
  it('signs in with the code the server sent, in two taps, and the token works on the real pipeline', async () => {
    const { client, signIn } = buildStack();

    await signIn();

    expect(client.isSignedIn()).toBe(true);
    expect(client.driverId()).toBe(DRIVER_ID);
    expect(client.tapsToSignIn()).toBe(2);
    expect(await client.listCars()).toEqual({ ok: true, value: [] });

    console.log(`D1 report: taps to sign in = ${client.tapsToSignIn()}`);
  });

  it('refuses a wrong code, and three wrong codes lock the phone even for the right code', async () => {
    const { client, accounts } = buildStack();
    await client.submitPhone(PHONE);
    const rightCode = lastCodeSentTo(accounts, PHONE) ?? '';

    expect(await client.submitCode('999991')).toEqual({ ok: false, error: 'wrong code' });
    expect(await client.submitCode('999992')).toEqual({ ok: false, error: 'wrong code' });
    expect(await client.submitCode('999993')).toEqual({ ok: false, error: 'locked' });
    expect(await client.submitCode(rightCode)).toEqual({ ok: false, error: 'locked' });
    expect(client.isSignedIn()).toBe(false);
    expect(accounts.tokensIssued).toBe(0);
  });

  it('answers an unknown phone like a wrong code and sends no code', async () => {
    const { client, accounts } = buildStack();

    const requested = await client.submitPhone(UNKNOWN_PHONE);
    const attempt = await client.submitCode('123456');

    expect(requested.ok).toBe(true);
    expect(attempt).toEqual({ ok: false, error: 'wrong code' });
    expect(accounts.sentCodes).toHaveLength(0);
  });

  it('saves a plate and it appears in the driver cars, as the server stores it', async () => {
    const { client, signIn, audit } = buildStack();
    await signIn();

    const saved = await client.addCar('abc-123');
    const listed = await client.listCars();

    expect(saved).toEqual({ ok: true, value: ['ABC123'] });
    expect(listed).toEqual({ ok: true, value: ['ABC123'] });

    const entries = await audit.readByScope({ personId: DRIVER_ID, role: 'driver' });
    expect(entries.map((entry) => entry.operation)).toEqual(['personalData.addCar']);
  });

  it('saving the same plate twice keeps one car', async () => {
    const { client, signIn, accounts } = buildStack();
    await signIn();

    await client.addCar('ABC123');
    const again = await client.addCar('abc 123');

    expect(again).toEqual({ ok: true, value: ['ABC123'] });
    expect(accounts.carsSaved).toBe(1);
  });

  it('shows the server refusal for an invalid plate and leaves no car and no audit entry', async () => {
    const { client, signIn, accounts, audit } = buildStack();
    await signIn();

    const result = await client.addCar('this plate is far too long');

    expect(result).toEqual({ ok: false, error: 'invalid plate' });
    expect(accounts.carsSaved).toBe(0);
    expect(await audit.readByScope({ personId: DRIVER_ID, role: 'driver' })).toHaveLength(0);
    expect(client.pendingCarRequestId()).toBeUndefined();
  });

  it('refuses to save a car before signing in, without calling the server', async () => {
    const { client, accounts } = buildStack();

    expect(await client.addCar('ABC123')).toEqual({ ok: false, error: 'not signed in' });
    expect(accounts.carsSaved).toBe(0);
  });

  it('airplane mode after the plate was saved, then retry: one car and one audit entry', async () => {
    const drop = { remaining: 0 };
    const { client, signIn, accounts, audit } = buildStack(drop);
    await signIn();
    drop.remaining = 1;

    const lost = await client.addCar('ABC123');
    expect(lost.ok).toBe(false);
    expect(client.pendingCarRequestId()).toBeDefined();
    expect(accounts.carsSaved).toBe(1);

    const retry = await client.addCar('ABC123');

    expect(retry).toEqual({ ok: true, value: ['ABC123'] });
    expect(accounts.carsSaved).toBe(1);
    expect(client.pendingCarRequestId()).toBeUndefined();
    const entries = await audit.readByScope({ personId: DRIVER_ID, role: 'driver' });
    expect(entries).toHaveLength(1);
  });

  it('airplane mode after the sign-in was answered, then retry: the same token and one sign-in', async () => {
    const drop = { remaining: 0 };
    const { client, accounts } = buildStack(drop);
    await client.submitPhone(PHONE);
    const code = lastCodeSentTo(accounts, PHONE) ?? '';
    drop.remaining = 1;

    const lost = await client.submitCode(code);
    expect(lost.ok).toBe(false);
    expect(client.isSignedIn()).toBe(false);
    expect(accounts.tokensIssued).toBe(1);

    const retry = await client.submitCode(code);

    expect(retry.ok).toBe(true);
    expect(client.isSignedIn()).toBe(true);
    expect(accounts.tokensIssued).toBe(1);
    expect(client.tapsToSignIn()).toBe(3);
  });

  it('airplane mode after the code request, then retry: one code is sent', async () => {
    const drop = { remaining: 1 };
    const { client, accounts } = buildStack(drop);

    const lost = await client.submitPhone(PHONE);
    expect(lost.ok).toBe(false);
    expect(accounts.sentCodes).toHaveLength(1);

    const retry = await client.submitPhone(PHONE);

    expect(retry.ok).toBe(true);
    expect(accounts.sentCodes).toHaveLength(1);
  });
});