/**
 * Stand-in server side of D1 for integration tests, until Teammate A's sign-in and add-car requests are registered.
 * This is not the accounts module: it copies just enough of A's published behaviour (see the accounts module's
 * public interface) for the Driver App to be exercised through the real entry point pipeline.
 *
 * Two parts:
 * - `createStandInSignInGateway`: answers the two sign-in requests WITHOUT a token, then hands every other request to
 *   the real pipeline. The real entry point cannot do this yet (it answers 401 to a request with no token), which is
 *   Teammate A's question 1 for the foundation owner. Delete this part when that is settled.
 * - `createStandInCarOperations`: `GET /cars` and `POST /cars` registered on the real pipeline, so request ids, the
 *   one audit entry per write and the rollback of a refusal are the real ones.
 *
 * Copied from A on purpose, so the tests refuse what the server will refuse: three wrong codes lock the phone, an
 * unknown phone is answered "wrong code", and a plate is upper-cased with spaces and dashes removed, then must be one
 * to ten English letters or digits. Saving the same plate twice returns the car already saved.
 */
import { signToken } from '../../../entrypoint/auth/token';
import { refuse, respond, type HttpResponse } from '../../../entrypoint/http';
import { validateBody, type BodySchema } from '../../../entrypoint/operations/body-schema';
import type { Operation, ReadOperation, WriteOperation } from '../../../entrypoint/operations/operation';
import type { PersonId } from '../../../shared/identifiers';
import { isWellFormedRequestId, REQUEST_ID_HEADER } from '../../../shared/request-id';
import type { EntryPointHandle } from './http-driver-auth-api';
import {
  DRIVER_ADD_CAR_OPERATION,
  DRIVER_CARS_PATH,
  DRIVER_OWN_CARS_OPERATION,
  DRIVER_REQUEST_CODE_PATH,
  DRIVER_SIGN_IN_PATH,
} from './driver-auth-routes';

const WRONG_CODES_BEFORE_LOCK_OUT = 3;
const PLATE = /^[A-Z0-9]{1,10}$/;

interface Challenge {
  readonly code: string;
  failedAttempts: number;
  locked: boolean;
}

interface StoredCar {
  readonly carRef: string;
  readonly plate: string;
}

export interface StandInAccountsState {
  readonly tokenSecret: string;
  readonly driverByPhone: Map<string, PersonId>;
  readonly challenges: Map<string, Challenge>;
  readonly sentCodes: { readonly phone: string; readonly code: string }[];
  readonly carsByDriver: Map<PersonId, StoredCar[]>;
  readonly repeatedAnswers: Map<string, HttpResponse>;
  carsSaved: number;
  tokensIssued: number;
  nextCode: number;
}

/** The phones given are registered drivers; any other phone is unknown to the server. */
export function createStandInAccountsState(
  tokenSecret: string,
  registeredPhones: readonly string[],
): StandInAccountsState {
  return {
    tokenSecret,
    driverByPhone: new Map(registeredPhones.map((phone) => [phone, `driver-${phone}`])),
    challenges: new Map(),
    sentCodes: [],
    carsByDriver: new Map(),
    repeatedAnswers: new Map(),
    carsSaved: 0,
    tokensIssued: 0,
    nextCode: 1,
  };
}

/** What the fake code sender recorded: the screen cannot see it, so a test reads it here. */
export function lastCodeSentTo(state: StandInAccountsState, phone: string): string | undefined {
  return state.sentCodes.filter((sent) => sent.phone === phone).at(-1)?.code;
}

export function createStandInSignInGateway(state: StandInAccountsState, next: EntryPointHandle): EntryPointHandle {
  return async (request) => {
    if (request.method === 'POST' && request.path === DRIVER_REQUEST_CODE_PATH) {
      return answerOnce(state, request.headers, request.body, { phone: 'string' }, (body) =>
        requestCode(state, String(body['phone'])),
      );
    }
    if (request.method === 'POST' && request.path === DRIVER_SIGN_IN_PATH) {
      return answerOnce(state, request.headers, request.body, { phone: 'string', code: 'string' }, (body) =>
        signIn(state, String(body['phone']), String(body['code'])),
      );
    }
    return next(request);
  };
}

/** Same repeat rule as the entry point: only a successful answer is stored, so a refusal is judged again. */
function answerOnce(
  state: StandInAccountsState,
  headers: Readonly<Record<string, string>>,
  rawBody: unknown,
  fields: BodySchema['fields'],
  decide: (body: Readonly<Record<string, unknown>>) => HttpResponse,
): HttpResponse {
  const requestId = headers[REQUEST_ID_HEADER];
  if (!isWellFormedRequestId(requestId)) {
    return refuse(400, `every write needs a well-formed ${REQUEST_ID_HEADER} header`);
  }
  const body = validateBody({ fields }, rawBody);
  if (!body.ok) {
    return refuse(400, 'body does not match the operation schema', { problems: body.error });
  }
  const earlier = state.repeatedAnswers.get(requestId);
  if (earlier !== undefined) {
    return earlier;
  }
  const answer = decide(body.value);
  if (answer.status < 400) {
    state.repeatedAnswers.set(requestId, answer);
  }
  return answer;
}

/** The same answer for every phone, so the screen never reveals who is registered. */
function requestCode(state: StandInAccountsState, phone: string): HttpResponse {
  if (state.driverByPhone.has(phone)) {
    const code = String(state.nextCode++).padStart(6, '0');
    state.challenges.set(phone, { code, failedAttempts: 0, locked: false });
    state.sentCodes.push({ phone, code });
  }
  return respond(202, {});
}

function signIn(state: StandInAccountsState, phone: string, code: string): HttpResponse {
  const driverId = state.driverByPhone.get(phone);
  const challenge = state.challenges.get(phone);
  if (driverId === undefined || challenge === undefined) {
    return refuse(401, 'wrong code');
  }
  if (challenge.locked) {
    return refuse(423, 'locked');
  }
  if (code !== challenge.code) {
    challenge.failedAttempts += 1;
    if (challenge.failedAttempts >= WRONG_CODES_BEFORE_LOCK_OUT) {
      challenge.locked = true;
      return refuse(423, 'locked');
    }
    return refuse(401, 'wrong code');
  }
  state.challenges.delete(phone);
  state.tokensIssued += 1;
  return respond(200, { token: signToken({ personId: driverId, role: 'driver' }, state.tokenSecret) });
}

export function createStandInCarOperations(state: StandInAccountsState): readonly Operation[] {
  return [ownCars(state), addCar(state)];
}

function ownCars(state: StandInAccountsState): ReadOperation {
  return {
    kind: 'read',
    name: DRIVER_OWN_CARS_OPERATION,
    method: 'GET',
    path: DRIVER_CARS_PATH,
    allowedRoles: ['driver'],
    async handle({ actor }) {
      return respond(200, { cars: state.carsByDriver.get(actor.personId) ?? [] });
    },
  };
}

function addCar(state: StandInAccountsState): WriteOperation {
  return {
    kind: 'write',
    name: DRIVER_ADD_CAR_OPERATION,
    method: 'POST',
    path: DRIVER_CARS_PATH,
    allowedRoles: ['driver'],
    bodySchema: { fields: { plate: 'string' } },
    examples: { valid: { plate: 'ABC123' }, invalid: { plate: 1 } },
    async handle(context) {
      const plate = String(context.body['plate']).toUpperCase().replace(/[\s-]/g, '');
      if (!PLATE.test(plate)) {
        return { response: refuse(400, 'invalid plate') };
      }
      const cars = state.carsByDriver.get(context.actor.personId) ?? [];
      const existing = cars.find((car) => car.plate === plate);
      if (existing !== undefined) {
        return { response: respond(200, { carRef: existing.carRef }) };
      }
      state.carsSaved += 1;
      const car = { carRef: `car-${state.carsSaved}`, plate };
      state.carsByDriver.set(context.actor.personId, [...cars, car]);
      return { response: respond(201, { carRef: car.carRef }) };
    },
  };
}