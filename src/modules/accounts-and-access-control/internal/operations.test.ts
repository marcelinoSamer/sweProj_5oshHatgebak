import { describe, expect, it } from 'vitest';
import { signToken } from '../../../entrypoint/auth/token';
import { composeInMemoryApplication } from '../../../entrypoint/composition';
import { TEST_TOKEN_SECRET } from '../../../entrypoint/test-helpers';
import type { Actor } from '../../../shared/identifiers';
import { createAccountsOperations, type SiteLocator } from '../public';
import { createAccountsWorld } from './testing/accounts-world';

const siteLocator: SiteLocator = {
  locateSite: async (siteId) => (siteId === 'site-a' ? { zoneId: 'zone-a', districtId: 'district-1' } : undefined),
  locateZone: async (zoneId) => (zoneId === 'zone-a' ? { districtId: 'district-1' } : undefined),
};

function get(path: string, actor: Actor, query: Record<string, string> = {}) {
  return { method: 'GET' as const, path, query, headers: { authorization: `Bearer ${signToken(actor, TEST_TOKEN_SECRET)}` } };
}

describe('A4 through the entry point', () => {
  it('shows a driver their own cars, and serves an inspector of the zone a plate with one logged read', async () => {
    const world = createAccountsWorld(siteLocator);
    const application = composeInMemoryApplication({ tokenSecret: TEST_TOKEN_SECRET, operations: createAccountsOperations(world.accounts) });
    const chair = await world.accounts.bootstrapChair('01000000000', 'The Chair');
    const driver = await world.accounts.personalData.createPerson('self registration', 'driver', '01011111111', 'Mona Adel');
    if (!chair.ok || !driver.ok) {
      throw new Error('set-up refused');
    }
    const inspector = await world.accounts.personalData.createPerson(chair.value, 'inspector', '01044444444', 'Inspector A');
    const car = await world.accounts.personalData.addCar(driver.value, 'ABC 123');
    if (!inspector.ok || !car.ok) {
      throw new Error('set-up refused');
    }
    await world.accounts.accessFacts.recordInspectorZone(inspector.value, 'zone-a');

    const cars = await application.handle(get('/cars', { personId: driver.value, role: 'driver' }));
    expect(cars).toEqual({ status: 200, body: { cars: [{ carRef: car.value, plate: 'ABC123' }] } });

    const lookUp = await application.handle(get('/plates', { personId: inspector.value, role: 'inspector' }, { carRef: car.value, siteId: 'site-a' }));
    expect(lookUp).toEqual({ status: 200, body: { plate: 'ABC123' } });
    const elsewhere = await application.handle(get('/plates', { personId: inspector.value, role: 'inspector' }, { carRef: car.value, siteId: 'site-x' }));
    expect(elsewhere.status).toBe(403);
    expect((await world.audit.readByScope({ personId: driver.value, role: 'driver' })).map((entry) => entry.operation)).toEqual(['personalData.readPlate']);
  });
});
