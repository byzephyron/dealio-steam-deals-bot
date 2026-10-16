import { describe, expect, it, vi } from 'vitest';
import { CheckService } from '../src/application/check-service.js';
import { StatusService } from '../src/application/status-service.js';
import {
  InvalidUserConfigurationError,
  UserConfigurationService,
} from '../src/application/user-configuration-service.js';
import { createDatabase } from '../src/persistence/database.js';
import { CheckStateRepository } from '../src/persistence/check-state-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import { StatusDashboardRepository } from '../src/persistence/status-dashboard-repository.js';
import { PollScheduleRepository } from '../src/persistence/poll-schedule-repository.js';
import { DiscountThresholdRepository } from '../src/persistence/discount-threshold-repository.js';
import {
  DiscountThresholdService,
  InvalidDiscountThresholdError,
} from '../src/application/discount-threshold-service.js';
import { UserOperationCoordinator } from '../src/application/user-operation-coordinator.js';
import type { SteamClient } from '../src/steam/steam-client.js';
import { SteamWishlistError } from '../src/domain/steam.js';
import { SteamIdentityError } from '../src/domain/steam-identity.js';
import { saveGameThreshold } from './helpers/game-rules.js';

function createServices(
  steamClient: Pick<SteamClient, 'getWishlistWithErrors'> = {
    getWishlistWithErrors: async () => ({ items: [], errors: [] }),
  },
  wishlistAccessValidator = {
    validateWishlistAccess: vi.fn().mockResolvedValue(undefined),
  },
  identityResolver = { resolve: vi.fn(async (value: string) => value) },
) {
  const database = createDatabase(':memory:');
  const userConfigRepository = new UserConfigRepository(database);
  const checkStateRepository = new CheckStateRepository(database);
  const wishlistStateRepository = new WishlistStateRepository(database);
  const discountThresholdRepository = new DiscountThresholdRepository(database);
  const coordinator = new UserOperationCoordinator();

  return {
    database,
    userConfigurationService: new UserConfigurationService(
      userConfigRepository,
      identityResolver,
      wishlistAccessValidator,
      coordinator,
    ),
    statusService: new StatusService(
      userConfigRepository,
      checkStateRepository,
      new StatusDashboardRepository(database),
      discountThresholdRepository,
    ),
    checkService: new CheckService(
      userConfigRepository,
      checkStateRepository,
      wishlistStateRepository,
      steamClient,
    ),
    checkStateRepository,
    userConfigRepository,
    wishlistStateRepository,
    discountThresholdRepository,
    discountThresholdService: new DiscountThresholdService(
      userConfigRepository,
      coordinator,
    ),
    identityResolver,
    wishlistAccessValidator,
  };
}

describe('user configuration', () => {
  it('creates and updates a user configuration', async () => {
    const services = createServices();

    const created = await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'tr',
      'TR',
    );
    expect(created.steamId64).toBe('76561198000000000');
    expect(created.language).toBe('tr');

    const updated = await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000001',
      'en',
    );
    expect(updated.steamId64).toBe('76561198000000001');
    expect(updated.configVersion).toBe(2);
    expect(updated.language).toBe('en');

    const status = services.statusService.get('discord-user');
    expect(status.config?.steamId64).toBe('76561198000000001');
    expect(status.checkState?.lastStatus).toBeNull();
    services.database.close();
  });

  it('rejects an invalid resolved SteamID64', async () => {
    const services = createServices();

    await expect(services.userConfigurationService.configure('discord-user', '123', 'tr', 'TR'))
      .rejects.toBeInstanceOf(InvalidUserConfigurationError);
    services.database.close();
  });

  it('rejects an unsupported store country before resolving the Steam profile', async () => {
    const services = createServices();

    expect(() => services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'en',
      'XX',
    )).toThrow(expect.objectContaining({ code: 'INVALID_STORE_COUNTRY' }));
    expect(services.identityResolver.resolve).not.toHaveBeenCalled();
    services.database.close();
  });

  it('requires an explicit store country for a new configuration', async () => {
    const services = createServices();

    await expect(services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'en',
    )).rejects.toMatchObject({ code: 'INVALID_STORE_COUNTRY' });
    expect(services.identityResolver.resolve).not.toHaveBeenCalled();
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')).toBeNull();
    services.database.close();
  });

  it('resolves profile input before validating and persists only canonical SteamID64', async () => {
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue('76561198000000000'),
    };
    const wishlistAccessValidator = {
      validateWishlistAccess: vi.fn().mockResolvedValue(undefined),
    };
    const services = createServices(undefined, wishlistAccessValidator, identityResolver);

    const config = await services.userConfigurationService.configure(
      'discord-user',
      'https://steamcommunity.com/id/RawVanity?tracking=1',
      'en',
      'US',
    );

    expect(identityResolver.resolve).toHaveBeenCalledWith(
      'https://steamcommunity.com/id/RawVanity?tracking=1',
    );
    expect(wishlistAccessValidator.validateWishlistAccess)
      .toHaveBeenCalledWith('76561198000000000');
    expect(config.steamId64).toBe('76561198000000000');
    expect(JSON.stringify(services.database.prepare('SELECT * FROM user_config').all()))
      .not.toContain('RawVanity');
    services.database.close();
  });

  it('leaves the user unconfigured when wishlist validation times out', async () => {
    const wishlistAccessValidator = {
      validateWishlistAccess: vi.fn().mockRejectedValue(
        new SteamWishlistError('STEAM_TIMEOUT', 'temporary timeout'),
      ),
    };
    const services = createServices(undefined, wishlistAccessValidator);

    await expect(services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
    )).rejects.toMatchObject({ code: 'STEAM_TIMEOUT' });
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')).toBeNull();
    services.database.close();
  });

  it('preserves existing configuration when identity resolution fails', async () => {
    const identityResolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce('76561198000000000')
        .mockRejectedValueOnce(new SteamIdentityError(
          'STEAM_VANITY_UNAVAILABLE',
          'safe unavailable error',
        )),
    };
    const services = createServices(undefined, undefined, identityResolver);
    const existing = await services.userConfigurationService.configure(
      'discord-user',
      'first-name',
      'tr',
      'TR',
    );

    await expect(services.userConfigurationService.configure(
      'discord-user',
      'second-name',
      'en',
    )).rejects.toMatchObject({ code: 'STEAM_VANITY_UNAVAILABLE' });
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')).toEqual(existing);
    services.database.close();
  });

  it('clears the previous account check status when the Steam account changes', async () => {
    const services = createServices();
    await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'tr',
      'TR',
    );
    await services.checkService.check('discord-user');
    expect(services.statusService.get('discord-user').checkState?.lastStatus).toBe('success');

    await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000001',
      'tr',
    );

    expect(services.statusService.get('discord-user').checkState).toMatchObject({
      lastStartedAt: null,
      lastCompletedAt: null,
      lastStatus: null,
      lastErrorCode: null,
      lastSuccessCompletedAt: null,
      lastSuccessCheckedCount: null,
      lastSuccessOnSaleCount: null,
      lastSuccessFreeCount: null,
      lastSuccessUnknownPriceCount: null,
      lastSuccessFailedItemCount: null,
    });
    services.database.close();
  });

  it('preserves successful metrics when only the configured language changes', async () => {
    const services = createServices();
    await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'tr',
      'TR',
    );
    await services.checkService.check('discord-user');

    const updated = await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'en',
    );

    expect(updated).toMatchObject({ configVersion: 1, language: 'en' });
    expect(services.statusService.get('discord-user').checkState).toMatchObject({
      lastStatus: 'success',
      lastSuccessCheckedCount: 0,
      lastSuccessOnSaleCount: 0,
      lastSuccessFreeCount: 0,
      lastSuccessUnknownPriceCount: 0,
      lastSuccessFailedItemCount: 0,
    });
    services.database.close();
  });

  it('isolates regional prices, expires old alerts, and baselines the new country', async () => {
    const regionalSale = {
      appId: 10,
      name: 'Regional Game',
      priority: null,
      dateAdded: null,
      price: {
        currency: 'EUR',
        initialMinor: 2_000,
        finalMinor: 1_000,
        discountPercent: 50,
        isFree: false,
      },
      onSale: true,
    } as const;
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [regionalSale], errors: [] }),
    };
    const services = createServices(steamClient);
    const original = await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
    );
    saveGameThreshold(services.database, original, 10, 40, '2026-08-21T00:01:00.000Z');
    const regular = { ...regionalSale, onSale: false, price: {
      ...regionalSale.price,
      currency: 'USD',
      finalMinor: 2_000,
      discountPercent: 0,
    } } as const;
    services.wishlistStateRepository.recordObservation(original, {
      item: regular,
      saleKey: null,
      observedAt: '2026-08-21T00:02:00.000Z',
    });
    const oldSale = services.wishlistStateRepository.recordObservation(original, {
      item: { ...regionalSale, price: { ...regionalSale.price, currency: 'USD' } },
      saleKey: 'USD:2000:1000:50',
      observedAt: '2026-08-21T00:03:00.000Z',
    }).notificationCandidate;
    if (!oldSale) {
      throw new Error('Expected old-region notification candidate');
    }

    const updated = await services.userConfigurationService.setStoreCountry('discord-user', 'DE');
    expect(updated).toMatchObject({
      storeCountryCode: 'DE',
      configVersion: 2,
      language: 'en',
      minimumDiscountPercent: 0,
    });
    if (!updated) {
      throw new Error('Expected updated regional configuration');
    }
    expect(services.discountThresholdRepository.findGameOverride(updated, 10)).toBe(40);
    expect(services.wishlistStateRepository.findNotificationStatus(oldSale)).toBe('expired');
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')?.lastStatus).toBeNull();

    const firstRegionalCheck = await services.checkService.check('discord-user');
    expect(firstRegionalCheck).toMatchObject({ status: 'success', notificationCandidates: [] });
    expect(steamClient.getWishlistWithErrors)
      .toHaveBeenCalledWith('76561198000000000', 'DE', 'en');
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10, 2))
      .toMatchObject({
        storeCountryCode: 'DE',
        currency: 'EUR',
        onSale: true,
        observationStatus: 'known',
      });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user', 2)).toBe(0);
    services.database.close();
  });

  it('atomically toggles enabled state without changing account generation or history', async () => {
    const services = createServices();
    let now = new Date('2026-08-21T00:00:00.000Z');
    const toggleService = new UserConfigurationService(
      services.userConfigRepository,
      { resolve: vi.fn(async (value: string) => value) },
      { validateWishlistAccess: vi.fn().mockResolvedValue(undefined) },
      new UserOperationCoordinator(),
      () => now,
    );
    const created = await toggleService.configure(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
    );
    await services.checkService.check('discord-user');
    new PollScheduleRepository(services.database)
      .setNextScheduledAt('2026-08-21T06:00:00.000Z');

    now = new Date('2026-08-21T01:00:00.000Z');
    const disabled = await toggleService.setEnabled('discord-user', false);
    expect(disabled).toMatchObject({
      enabled: false,
      updatedAt: '2026-08-21T01:00:00.000Z',
      configVersion: created.configVersion,
      steamId64: created.steamId64,
    });
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      nextScheduledAt: null,
      lastStatus: 'success',
      lastSuccessCheckedCount: 0,
    });

    now = new Date('2026-08-21T02:00:00.000Z');
    const enabled = await toggleService.setEnabled('discord-user', true);
    expect(enabled).toMatchObject({
      enabled: true,
      updatedAt: '2026-08-21T02:00:00.000Z',
      configVersion: created.configVersion,
    });
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')?.nextScheduledAt)
      .toBe('2026-08-21T06:00:00.000Z');
    await expect(toggleService.setEnabled('missing-user', false)).resolves.toBeNull();
    services.database.close();
  });

  it('stores validated global and generation-scoped game discount thresholds', async () => {
    const services = createServices();
    const created = await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
    );

    await expect(services.discountThresholdService.setGlobal('discord-user', 35))
      .resolves.toMatchObject({ minimumDiscountPercent: 35, configVersion: 1 });
    saveGameThreshold(services.database, created, 10, 60, '2026-08-21T00:01:00.000Z');
    expect(services.discountThresholdRepository.findGameOverride(created, 10)).toBe(60);
    expect(services.statusService.getDashboard('discord-user', 'en')).toMatchObject({
      status: 'ready',
      gameDiscountOverrideCount: 1,
    });

    await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000001',
      'tr',
    );
    const changed = services.userConfigRepository.findByDiscordUserId('discord-user')!;
    expect(changed).toMatchObject({ configVersion: 2, minimumDiscountPercent: 35 });
    expect(services.discountThresholdRepository.findGameOverride(changed, 10)).toBeNull();
    expect(services.statusService.getDashboard('discord-user', 'en')).toMatchObject({
      status: 'ready',
      gameDiscountOverrideCount: 0,
    });
    expect(services.discountThresholdRepository.findGameOverride(created, 10)).toBe(60);

    expect(() => services.discountThresholdService.setGlobal('discord-user', 101))
      .toThrow(InvalidDiscountThresholdError);
    const previousConfigurationId = changed.configurationId;
    await services.userConfigurationService.deleteData('discord-user');
    const recreated = await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000001',
      'en',
      'US',
    );
    expect(recreated.configurationId).not.toBe(previousConfigurationId);
    await expect(services.discountThresholdService.setGlobal(
      'discord-user',
      70,
      previousConfigurationId,
    )).resolves.toBeNull();
    expect(services.userConfigRepository.findByDiscordUserId('discord-user'))
      .toMatchObject({ minimumDiscountPercent: 0 });
    services.database.close();
  });

  it('does not replace an existing account when the new wishlist is inaccessible', async () => {
    const wishlistAccessValidator = {
      validateWishlistAccess: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new SteamWishlistError('STEAM_WISHLIST_INACCESSIBLE', 'private wishlist'),
        ),
    };
    const services = createServices(undefined, wishlistAccessValidator);
    await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'tr',
      'TR',
    );

    await expect(
      services.userConfigurationService.configure(
        'discord-user',
        '76561198000000001',
        'en',
      ),
    ).rejects.toMatchObject({ code: 'STEAM_WISHLIST_INACCESSIBLE' });
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')).toMatchObject({
      steamId64: '76561198000000000',
      configVersion: 1,
      language: 'tr',
    });
    services.database.close();
  });

  it('deletes configuration and all cascaded user data', async () => {
    const services = createServices();
    const config = await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'tr',
      'TR',
    );
    const baseItem = {
      appId: 10,
      name: 'Deletion Test Game',
      priority: null,
      dateAdded: null,
      price: {
        currency: 'TRY',
        initialMinor: 1_000,
        finalMinor: 1_000,
        discountPercent: 0,
        isFree: false,
      },
      onSale: false,
    } as const;
    services.wishlistStateRepository.recordObservation(config, {
      item: baseItem,
      saleKey: null,
      observedAt: '2026-08-21T00:00:00.000Z',
    });
    const saleObservation = services.wishlistStateRepository.recordObservation(config, {
      item: {
        ...baseItem,
        onSale: true,
        price: { ...baseItem.price, finalMinor: 500, discountPercent: 50 },
      },
      saleKey: 'TRY:1000:500:50',
      observedAt: '2026-08-21T01:00:00.000Z',
    });
    if (!saleObservation.notificationCandidate) {
      throw new Error('Expected deletion test notification candidate');
    }
    services.wishlistStateRepository.createAndClaimNotificationBatch(
      config,
      'tr',
      [saleObservation.notificationCandidate],
      '2026-08-21T01:01:00.000Z',
    );
    saveGameThreshold(services.database, config, 10, 40, '2026-08-21T01:02:00.000Z');

    await expect(services.userConfigurationService.deleteData('discord-user')).resolves.toBe(true);

    expect(
      (services.database.prepare('PRAGMA secure_delete').get() as { secure_delete: number })
        .secure_delete,
    ).toBe(1);

    for (const table of [
      'user_config',
      'check_state',
      'wishlist_item_state',
      'notification_log',
      'notification_batch',
      'notification_batch_item',
      'game_discount_threshold',
    ]) {
      const row = services.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      expect(row.count).toBe(0);
    }
    services.database.close();
  });
});

describe('check service', () => {
  it('reports a successful empty check', async () => {
    const services = createServices();
    await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
    );

    const result = await services.checkService.check('discord-user');

    expect(result).toMatchObject({
      status: 'success',
      checkedCount: 0,
      notificationCandidates: [],
    });
    expect(services.statusService.get('discord-user').checkState).toMatchObject({
      lastStatus: 'success',
      lastErrorCode: null,
    });
    services.database.close();
  });

  it('rejects a concurrent check for the same user', async () => {
    const services = createServices();
    await services.userConfigurationService.configure(
      'discord-user',
      '76561198000000000',
      'tr',
      'TR',
    );

    const firstCheck = services.checkService.check('discord-user');
    const secondCheck = await services.checkService.check('discord-user');

    expect(secondCheck).toEqual({ status: 'already-running' });
    expect(await firstCheck).toMatchObject({ status: 'success', checkedCount: 0 });
    services.database.close();
  });
});
