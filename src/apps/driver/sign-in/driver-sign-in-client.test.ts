import { describe, expect, it } from 'vitest';
import type { RequestId } from '../../../shared/request-id';
import {
  DriverAuthRefusedError,
  DriverAuthTransportError,
  type DriverAuthApi,
  type SignInSuccess,
} from './driver-auth-api';
import { DriverSignInClient } from './driver-sign-in-client';
import { InMemoryDriverAuthApi } from './in-memory-driver-auth-api';

const PHONE = '01012345678';
const RIGHT_CODE = `driver-code-${PHONE}`;

function buildClient(api: DriverAuthApi = new InMemoryDriverAuthApi({ tokenSecret: 'test-secret-that-is-long-enough' })) {
  let serial = 1;
  const issued: RequestId[] = [];
  const client = new DriverSignInClient({
    api,
    createRequestId: () => {
      const id = `d1-req-${String(serial++).padStart(4, '0')}`;
      issued.push(id);
      return id;
    },
  });
  return { client, issued };
}

/**
 * Lets the server apply each write, then loses the answer when the plan says so, the way airplane mode does.
 * The plan has one entry per write call, in order: true loses that call's answer, false lets it through.
 */
class AnswerLosingApi implements DriverAuthApi {
  readonly seenRequestIds: RequestId[] = [];
  readonly plan: boolean[];

  constructor(
    private readonly inner: DriverAuthApi,
    plan: boolean[] = [],
  ) {
    this.plan = plan;
  }

  async requestCode(phone: string, requestId: RequestId): Promise<void> {
    this.seenRequestIds.push(requestId);
    await this.inner.requestCode(phone, requestId);
    this.loseAnswer();
  }

  async signIn(phone: string, code: string, requestId: RequestId): Promise<SignInSuccess> {
    this.seenRequestIds.push(requestId);
    const session = await this.inner.signIn(phone, code, requestId);
    this.loseAnswer();
    return session;
  }

  async saveCar(plate: string, requestId: RequestId): Promise<readonly string[]> {
    this.seenRequestIds.push(requestId);
    const cars = await this.inner.saveCar(plate, requestId);
    this.loseAnswer();
    return cars;
  }

  listCars(): Promise<readonly string[]> {
    return this.inner.listCars();
  }

  private loseAnswer(): void {
    if (this.plan.shift() === true) {
      throw new DriverAuthTransportError();
    }
  }
}

describe('D1 Driver App sign-in and cars client', () => {
  it('signs in with the right code and reports two taps', async () => {
    const { client } = buildClient();

    const phone = await client.submitPhone(PHONE);
    const code = await client.submitCode(RIGHT_CODE);

    expect(phone.ok).toBe(true);
    expect(code.ok).toBe(true);
    expect(client.isSignedIn()).toBe(true);
    expect(client.driverId()).toBe(`driver-${PHONE}`);
    expect(client.token()).toBeDefined();
    expect(client.tapsToSignIn()).toBe(2);

    console.log(`D1 report: taps to sign in = ${client.tapsToSignIn()}`);
  });

  it('refuses a wrong code and stays signed out', async () => {
    const { client } = buildClient();
    await client.submitPhone(PHONE);

    const result = await client.submitCode('000000');

    expect(result).toEqual({ ok: false, error: 'wrong code' });
    expect(client.isSignedIn()).toBe(false);
    expect(client.token()).toBeUndefined();
  });

  it('shows the server refusal as it is, whatever its name', async () => {
    const refusing: DriverAuthApi = {
      requestCode: async () => undefined,
      signIn: async () => {
        throw new DriverAuthRefusedError('locked');
      },
      saveCar: async () => [],
      listCars: async () => [],
    };
    const { client } = buildClient(refusing);
    await client.submitPhone(PHONE);

    expect(await client.submitCode('123456')).toEqual({ ok: false, error: 'locked' });
  });

  it('saves a plate and it appears in the driver cars', async () => {
    const { client } = buildClient();
    await client.submitPhone(PHONE);
    await client.submitCode(RIGHT_CODE);

    const saved = await client.addCar('ABC123');
    const listed = await client.listCars();

    expect(saved).toEqual({ ok: true, value: ['ABC123'] });
    expect(listed).toEqual({ ok: true, value: ['ABC123'] });
  });

  it('refuses to add or list cars before signing in', async () => {
    const { client } = buildClient();

    expect(await client.addCar('ABC123')).toEqual({ ok: false, error: 'not signed in' });
    expect(await client.listCars()).toEqual({ ok: false, error: 'not signed in' });
  });

  it('goes back to signed out when the server stops accepting the token', async () => {
    const expiredToken: DriverAuthApi = {
      requestCode: async () => undefined,
      signIn: async () => ({ driverId: 'driver-1', token: 'token' }),
      saveCar: async () => {
        throw new DriverAuthRefusedError('not signed in');
      },
      listCars: async () => [],
    };
    const { client } = buildClient(expiredToken);
    await client.submitPhone(PHONE);
    await client.submitCode('123456');
    expect(client.isSignedIn()).toBe(true);

    expect(await client.addCar('ABC123')).toEqual({ ok: false, error: 'not signed in' });
    expect(client.isSignedIn()).toBe(false);
  });

  it('keeps the same request id for the sign-in retry after a lost answer', async () => {
    const api = new AnswerLosingApi(new InMemoryDriverAuthApi({ tokenSecret: 'test-secret-that-is-long-enough' }), [
      true,
      false,
      true,
      false,
    ]);
    const { client, issued } = buildClient(api);

    const lostCode = await client.submitPhone(PHONE);
    expect(lostCode).toEqual({ ok: false, error: 'connection lost', requestId: 'd1-req-0001' });
    expect(client.pendingCodeRequestId()).toBe('d1-req-0001');
    expect((await client.submitPhone(PHONE)).ok).toBe(true);
    expect(client.pendingCodeRequestId()).toBeUndefined();

    const lostSignIn = await client.submitCode(RIGHT_CODE);
    expect(lostSignIn).toEqual({ ok: false, error: 'connection lost', requestId: 'd1-req-0002' });
    expect((await client.submitCode(RIGHT_CODE)).ok).toBe(true);
    expect(client.pendingSignInRequestId()).toBeUndefined();

    expect(api.seenRequestIds).toEqual(['d1-req-0001', 'd1-req-0001', 'd1-req-0002', 'd1-req-0002']);
    expect(issued).toEqual(['d1-req-0001', 'd1-req-0002']);
  });

  it('keeps the same request id for the plate retry after a lost answer, and saves one car', async () => {
    const api = new AnswerLosingApi(new InMemoryDriverAuthApi({ tokenSecret: 'test-secret-that-is-long-enough' }));
    const { client } = buildClient(api);
    await client.submitPhone(PHONE);
    await client.submitCode(RIGHT_CODE);
    api.seenRequestIds.length = 0;
    api.plan.push(true, false);

    const lost = await client.addCar('ABC123');
    expect(lost).toEqual({ ok: false, error: 'connection lost', requestId: 'd1-req-0003' });
    expect(client.pendingCarRequestId()).toBe('d1-req-0003');

    const retry = await client.addCar('ABC123');

    expect(retry).toEqual({ ok: true, value: ['ABC123'] });
    expect(api.seenRequestIds).toEqual(['d1-req-0003', 'd1-req-0003']);
    expect(client.pendingCarRequestId()).toBeUndefined();
    expect(await client.listCars()).toEqual({ ok: true, value: ['ABC123'] });
  });

  it('uses a new request id when the retry is for a different phone', async () => {
    const api = new AnswerLosingApi(new InMemoryDriverAuthApi({ tokenSecret: 'test-secret-that-is-long-enough' }), [
      true,
    ]);
    const { client } = buildClient(api);

    await client.submitPhone('01011111111');
    await client.submitPhone('01022222222');

    expect(api.seenRequestIds).toEqual(['d1-req-0001', 'd1-req-0002']);
  });
});