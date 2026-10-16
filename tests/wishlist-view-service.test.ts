import { describe, expect, it, vi } from 'vitest';
import { WishlistViewService } from '../src/application/wishlist-view-service.js';
import { SteamWishlistError, type WishlistItem } from '../src/domain/steam.js';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import { DiscountThresholdRepository } from '../src/persistence/discount-threshold-repository.js';
import { UserOperationCoordinator } from '../src/application/user-operation-coordinator.js';
import { saveGameThreshold } from './helpers/game-rules.js';

const item: WishlistItem = {
  appId: 10,
  name: 'Test Game',
  priority: 1,
  dateAdded: 1_700_000_000,
  price: {
    currency: 'USD',
    initialMinor: 2_000,
    finalMinor: 1_000,
    discountPercent: 50,
    isFree: false,
  },
  onSale: true,
};

describe('WishlistViewService', () => {
  it.each([2, 50])('opens a cached %i-game wishlist while background work holds the user queue', async (count) => {
    const database = createDatabase(':memory:');
    const users = new UserConfigRepository(database);
    const state = new WishlistStateRepository(database);
    const coordinator = new UserOperationCoordinator();
    const config = users.upsert('invoking-user', '76561198000000000', 'en', 'US', '2026-09-19T12:00:00Z');
    const items = Array.from({ length: count }, (_, index) => ({ ...item, appId: index + 1 }));
    state.assistant.saveSnapshot(config, { items, errors: [] }, '2026-09-19T12:01:00Z');
    const reader = { getWishlistWithErrors: vi.fn() };
    const service = new WishlistViewService(users, reader, undefined, undefined, coordinator, state.assistant);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const background = coordinator.runExclusive(config.discordUserId, async () => {
      entered.resolve();
      await gate.promise;
    });
    let resolvedWhileBusy = false;
    try {
      await entered.promise;
      const loading = service.load(config.discordUserId, 'tr').then(result => {
        resolvedWhileBusy = true;
        return result;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      const openedBeforeBackgroundFinished = resolvedWhileBusy;
      gate.resolve();
      const result = await loading;
      expect(openedBeforeBackgroundFinished).toBe(true);
      expect(result).toMatchObject({ status: 'success', items, capturedAt: '2026-09-19T12:01:00Z' });
      expect(reader.getWishlistWithErrors).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await background;
      database.close();
    }
  });

  it('still queues an explicit refresh and fetches fresh prices instead of returning the snapshot', async () => {
    const database = createDatabase(':memory:');
    const users = new UserConfigRepository(database);
    const state = new WishlistStateRepository(database);
    const coordinator = new UserOperationCoordinator();
    const config = users.upsert('invoking-user', '76561198000000000', 'en', 'US', '2026-09-19T12:00:00Z');
    state.assistant.saveSnapshot(config, { items: [item], errors: [] }, '2026-09-19T12:01:00Z');
    const fresh = { ...item, name: 'Fresh observation' };
    const reader = { getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [fresh], errors: [] }) };
    const service = new WishlistViewService(users, reader, undefined, undefined, coordinator, state.assistant);
    const gate = Promise.withResolvers<void>();
    const background = coordinator.runExclusive(config.discordUserId, () => gate.promise);
    try {
      const loading = service.load(config.discordUserId, 'tr', true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reader.getWishlistWithErrors).not.toHaveBeenCalled();
      gate.resolve();
      await expect(loading).resolves.toMatchObject({ status: 'success', items: [fresh] });
      expect(reader.getWishlistWithErrors).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await background;
      database.close();
    }
  });

  it.each([
    ['76561198000000000', 'en', 'DE'],
    ['76561198000000000', 'tr', 'US'],
    ['76561198000000001', 'en', 'US'],
  ] as const)('does not reuse a snapshot after changing to %s/%s/%s', async (steamId, language, country) => {
    const database = createDatabase(':memory:');
    try {
      const users = new UserConfigRepository(database);
      const state = new WishlistStateRepository(database);
      const config = users.upsert('invoking-user', '76561198000000000', 'en', 'US', '2026-09-19T12:00:00Z');
      state.assistant.saveSnapshot(config, { items: [item], errors: [] }, '2026-09-19T12:01:00Z');
      users.upsert(config.discordUserId, steamId, language, country, '2026-09-19T12:02:00Z');
      const fresh = { ...item, name: 'Current account and region' };
      const reader = { getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [fresh], errors: [] }) };
      const service = new WishlistViewService(users, reader, undefined, undefined, undefined, state.assistant);
      await expect(service.load(config.discordUserId, 'en')).resolves.toMatchObject({
        status: 'success', items: [fresh], language, storeCountryCode: country,
      });
      expect(reader.getWishlistWithErrors).toHaveBeenCalledWith(steamId, country, language);
    } finally { database.close(); }
  });

  it('returns the locale fallback without calling Steam for an unconfigured user', async () => {
    const wishlistReader = { getWishlistWithErrors: vi.fn() };
    const service = new WishlistViewService(
      { findByDiscordUserId: vi.fn().mockReturnValue(null) },
      wishlistReader,
    );

    await expect(service.load('invoking-user', 'tr')).resolves.toEqual({
      status: 'not-configured',
      language: 'tr',
    });
    expect(wishlistReader.getWishlistWithErrors).not.toHaveBeenCalled();
  });

  it('uses only the invoking user configuration and preserves partial app errors', async () => {
    const configReader = {
      findByDiscordUserId: vi.fn().mockReturnValue({
        discordUserId: 'invoking-user',
        steamId64: '76561198000000000',
        configVersion: 1,
        configurationId: 'configuration-id',
        language: 'en',
        storeCountryCode: 'US',
        minimumDiscountPercent: 0,
      }),
    };
    const wishlistReader = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({
        items: [item],
        errors: [{ appId: 20, code: 'STEAM_APP_NOT_FOUND' }],
      }),
    };
    const service = new WishlistViewService(
      configReader as never,
      wishlistReader,
      () => new Date('2026-08-22T12:00:00.000Z'),
    );

    await expect(service.load('invoking-user', 'tr')).resolves.toEqual({
      status: 'success',
      language: 'en',
      items: [item],
      errors: [{ appId: 20, code: 'STEAM_APP_NOT_FOUND' }],
      capturedAt: '2026-08-22T12:00:00.000Z',
      configVersion: 1,
      configurationId: 'configuration-id',
      storeCountryCode: 'US',
      globalMinimumDiscountPercent: 0,
      gameMinimumDiscountOverrides: new Map(),
    });
    expect(configReader.findByDiscordUserId).toHaveBeenCalledWith('invoking-user');
    expect(wishlistReader.getWishlistWithErrors)
      .toHaveBeenCalledWith('76561198000000000', 'US', 'en');
  });

  it('does not turn a complete Steam failure into an empty successful wishlist', async () => {
    const service = new WishlistViewService(
      { findByDiscordUserId: vi.fn().mockReturnValue({
        steamId64: '76561198000000000', language: 'tr', storeCountryCode: 'TR',
      }) } as never,
      {
        getWishlistWithErrors: vi.fn().mockRejectedValue(
          new SteamWishlistError(
            'STEAM_SCHEMA_INVALID',
            'Steam app details were unavailable for the entire wishlist',
          ),
        ),
      },
    );

    await expect(service.load('invoking-user', 'en')).resolves.toEqual({
      status: 'unavailable',
      language: 'tr',
      errorCode: 'STEAM_SCHEMA_INVALID',
    });
  });

  it('treats a reader result containing only app errors as unavailable', async () => {
    const service = new WishlistViewService(
      { findByDiscordUserId: vi.fn().mockReturnValue({
        steamId64: '76561198000000000', language: 'en', storeCountryCode: 'US',
      }) } as never,
      {
        getWishlistWithErrors: vi.fn().mockResolvedValue({
          items: [],
          errors: [{ appId: 10, code: 'STEAM_UPSTREAM_ERROR' }],
        }),
      },
    );

    await expect(service.load('invoking-user', 'tr')).resolves.toEqual({
      status: 'unavailable',
      language: 'en',
      errorCode: 'STEAM_UPSTREAM_ERROR',
    });
  });

  it('waits for a concurrent region change before requesting live prices', async () => {
    const coordinator = new UserOperationCoordinator();
    let storeCountryCode: 'US' | 'DE' = 'US';
    let releaseRegion: (() => void) | undefined;
    const regionChange = coordinator.runExclusive('invoking-user', async () => {
      storeCountryCode = 'DE';
      await new Promise<void>((resolve) => {
        releaseRegion = resolve;
      });
    });
    const wishlistReader = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [item], errors: [] }),
    };
    const service = new WishlistViewService(
      {
        findByDiscordUserId: vi.fn(() => ({
          discordUserId: 'invoking-user',
          steamId64: '76561198000000000',
          configVersion: 2,
          configurationId: 'configuration-id',
          language: 'en',
          storeCountryCode,
          minimumDiscountPercent: 0,
        })),
      } as never,
      wishlistReader,
      undefined,
      undefined,
      coordinator,
    );

    const loading = service.load('invoking-user', 'tr');
    await Promise.resolve();
    expect(wishlistReader.getWishlistWithErrors).not.toHaveBeenCalled();

    releaseRegion?.();
    await regionChange;
    await expect(loading).resolves.toMatchObject({
      status: 'success',
      storeCountryCode: 'DE',
      configVersion: 2,
    });
    expect(wishlistReader.getWishlistWithErrors)
      .toHaveBeenCalledWith('76561198000000000', 'DE', 'en');
  });

  it('reads live data without changing check, sale, or notification persistence', async () => {
    const database = createDatabase(':memory:');
    const configRepository = new UserConfigRepository(database);
    const stateRepository = new WishlistStateRepository(database);
    const thresholdRepository = new DiscountThresholdRepository(database);
    const config = configRepository.upsert(
      'invoking-user',
      '76561198000000000',
      'en',
      'US',
      '2026-08-22T00:00:00.000Z',
    );
    stateRepository.recordObservation(config, {
      item: { ...item, onSale: false },
      saleKey: null,
      observedAt: '2026-08-22T00:01:00.000Z',
    });
    saveGameThreshold(database, config, item.appId, 40, '2026-08-22T00:02:00.000Z');
    const tables = [
      'user_config',
      'check_state',
      'wishlist_item_state',
      'notification_log',
      'notification_batch',
      'notification_batch_item',
      'game_discount_threshold',
      'game_rule',
    ] as const;
    const before = new Map(tables.map((table) => [
      table,
      database.prepare(`SELECT * FROM ${table}`).all(),
    ]));
    const service = new WishlistViewService(
      configRepository,
      { getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [item], errors: [] }) },
      () => new Date('2026-08-22T12:00:00.000Z'),
      thresholdRepository,
    );

    try {
      await expect(service.load('invoking-user', 'tr')).resolves.toMatchObject({
        globalMinimumDiscountPercent: 0,
        gameMinimumDiscountOverrides: new Map([[10, 40]]),
      });
      for (const table of tables) {
        expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual(before.get(table));
      }
    } finally {
      database.close();
    }
  });
});
