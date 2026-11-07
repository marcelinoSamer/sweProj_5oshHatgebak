/**
 * HTTP routes the Driver App uses for sign-in and cars.
 *
 * Real today: reading the driver's own cars, `GET /cars`, registered by Teammate A's `createAccountsOperations`
 * under the name `personalData.ownCars`.
 *
 * Provisional (not registered by anyone yet; the paths and names below are this app's proposal):
 * - requesting a sign-in code and signing in: the entry point answers 401 to every request that has no token, and a
 *   person who is signing in has none (Teammate A's question 1 for the foundation owner);
 * - adding a car: the entry point copies the whole request body into the permanent audit entry, so the plate would be
 *   kept in the audit log for ever and defeat erasure (Teammate A's question 3 for the foundation owner).
 */
export const DRIVER_REQUEST_CODE_PATH = '/driver/sign-in/request-code';
export const DRIVER_SIGN_IN_PATH = '/driver/sign-in';
export const DRIVER_CARS_PATH = '/cars';

export const DRIVER_REQUEST_CODE_OPERATION = 'driver.requestSignInCode';
export const DRIVER_SIGN_IN_OPERATION = 'driver.signIn';
export const DRIVER_OWN_CARS_OPERATION = 'personalData.ownCars';
export const DRIVER_ADD_CAR_OPERATION = 'personalData.addCar';