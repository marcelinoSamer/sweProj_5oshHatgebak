import { describe, expect, it } from 'vitest';
import { DriverMapClient } from './driver-map-client';
import { InMemoryDriverMapApi } from './in-memory-driver-map-api';

describe('D2 driver map client', () => {
  it('shows nearby sites in distance order with a free-space band', async () => {
    const api = new InMemoryDriverMapApi([
      {
        siteId: 'site-a',
        latitude: 30.01,
        longitude: 31.01,
        firstHourFee: 10,
        capacity: 20,
        openTicketCount: 2,
      },
      {
        siteId: 'site-b',
        latitude: 30.02,
        longitude: 31.02,
        firstHourFee: 15,
        capacity: 20,
        openTicketCount: 16,
      },
    ]);

    const client = new DriverMapClient({ api, now: () => 0 });
    const result = await client.nearbySites({ latitude: 30.0, longitude: 31.0 }, 10_000);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected nearby sites to load');
    }

    expect(result.value[0]?.siteId).toBe('site-a');
    expect(result.value[0]?.band).toBe('free');
    expect(result.value[1]?.siteId).toBe('site-b');
    expect(result.value[1]?.band).toBe('few');
  });

  it('updates the free-space band when the server changes the ticket count', async () => {
    const api = new InMemoryDriverMapApi([
      {
        siteId: 'site-c',
        latitude: 30.2,
        longitude: 31.2,
        firstHourFee: 12,
        capacity: 10,
        openTicketCount: 1,
      },
    ]);

    const client = new DriverMapClient({ api, now: () => 0 });
    let result = await client.nearbySites({ latitude: 30.2, longitude: 31.2 }, 500);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected nearby sites to load');
    }
    expect(result.value[0]?.band).toBe('free');

    api.updateSiteTicketCount('site-c', 9);
    result = await client.nearbySites({ latitude: 30.2, longitude: 31.2 }, 500);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected nearby sites to reload');
    }
    expect(result.value[0]?.band).toBe('few');
  });

  it('refreshes every 15 seconds according to the requirement', async () => {
    const api = new InMemoryDriverMapApi();
    const client = new DriverMapClient({ api, now: () => 10_000 });

    const result = await client.nearbySites({ latitude: 30.0, longitude: 31.0 }, 1_000);
    expect(result.ok).toBe(true);

    expect(client.refreshIntervalMs()).toBe(15_000);
    expect(client.isRefreshDue(25_000)).toBe(true);
    expect(client.isRefreshDue(23_000)).toBe(false);
  });
});
