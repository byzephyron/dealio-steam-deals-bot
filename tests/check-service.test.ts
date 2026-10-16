import { describe, expect, it, vi } from 'vitest';
import { CheckService } from '../src/application/check-service.js';
import { SteamWishlistError, type WishlistItem } from '../src/domain/steam.js';
import { createDatabase } from '../src/persistence/database.js';
import { CheckStateRepository } from '../src/persistence/check-state-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import { DiscountThresholdRepository } from '../src/persistence/discount-threshold-repository.js';
import type { SteamClient } from '../src/steam/steam-client.js';
import { saveGameThreshold } from './helpers/game-rules.js';

function createItem(
  appId: number,
  onSale: boolean | null,
  finalMinor = onSale ? 500 : 1_000,
): WishlistItem {
  return {
    appId,
    name: `Oyun ${appId}`,
    priority: null,
    dateAdded: null,
    price:
      onSale === null
        ? null
        : {
            currency: 'TRY',
            initialMinor: 1_000,
            finalMinor,
            discountPercent: finalMinor === 1_000 ? 0 : 50,
            isFree: false,
          },
    onSale,
  };
}

function createServices(
  steamClient: Pick<SteamClient, 'getWishlistWithErrors'>,
  options: ConstructorParameters<typeof CheckService>[5] = { cooldownMs: 0 },
) {
  const database = createDatabase(':memory:');
  const userConfigRepository = new UserConfigRepository(database);
  const checkStateRepository = new CheckStateRepository(database);
  const wishlistStateRepository = new WishlistStateRepository(database);
  const discountThresholdRepository = new DiscountThresholdRepository(database);
  const checkService = new CheckService(
    userConfigRepository,
    checkStateRepository,
    wishlistStateRepository,
    steamClient,
    undefined,
    options,
  );

  userConfigRepository.upsert(
    'discord-user',
    '76561198000000000',
    'tr',
    'TR',
    '2026-08-21T00:00:00.000Z',
  );

  return {
    database,
    checkService,
    checkStateRepository,
    userConfigRepository,
    wishlistStateRepository,
    discountThresholdRepository,
  };
}

function steamSequence(items: WishlistItem[]) {
  return {
    getWishlistWithErrors: vi.fn().mockResolvedValue({ items, errors: [] }),
  };
}

describe('CheckService sale state', () => {
  it('records the first observation without creating a notification candidate', async () => {
    const services = createServices(steamSequence([createItem(10, true)]));

    const result = await services.checkService.check('discord-user');
    const state = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );

    expect(result).toMatchObject({
      status: 'success',
      checkedCount: 1,
      notificationCandidates: [],
    });
    expect(state).toMatchObject({
      onSale: true,
      saleKey: 'TRY:1000:500:50',
    });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    services.database.close();
  });

  it('passes the configured store country and notification language to Steam', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [], errors: [] }),
    };
    const services = createServices(steamClient);
    services.userConfigRepository.upsert(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
      '2026-08-21T00:01:00.000Z',
    );

    await services.checkService.check('discord-user');

    expect(steamClient.getWishlistWithErrors)
      .toHaveBeenCalledWith('76561198000000000', 'US', 'en');
    services.database.close();
  });

  it('creates a candidate on a false to true transition', async () => {
    const steamClient = {
      getWishlistWithErrors: vi
        .fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] }),
    };
    const services = createServices(steamClient);

    await services.checkService.check('discord-user');
    const result = await services.checkService.check('discord-user');

    expect(result).toMatchObject({
      status: 'success',
      notificationCandidates: [
        {
          appId: 10,
          saleKey: 'TRY:1000:500:50',
          discountPercent: 50,
        },
      ],
    });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(1);
    services.database.close();
  });

  it('creates one candidate when an active eligible sale reaches the global threshold', async () => {
    const itemAt = (discountPercent: number): WishlistItem => ({
      ...createItem(10, true),
      price: {
        currency: 'TRY',
        initialMinor: 1_000,
        finalMinor: 1_000 - discountPercent * 10,
        discountPercent,
        isFree: false,
      },
    });
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [itemAt(50)], errors: [] })
        .mockResolvedValueOnce({ items: [itemAt(70)], errors: [] })
        .mockResolvedValueOnce({ items: [itemAt(80)], errors: [] }),
    };
    const services = createServices(steamClient);
    services.userConfigRepository.setMinimumDiscountPercent(
      'discord-user',
      60,
      '2026-08-21T00:01:00.000Z',
    );

    await services.checkService.check('discord-user');
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      notificationCandidates: [],
    });
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      notificationCandidates: [{ appId: 10, discountPercent: 70 }],
    });
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      notificationCandidates: [],
    });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(1);
    services.database.close();
  });

  it('uses a game override instead of the global threshold', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] }),
    };
    const services = createServices(steamClient);
    const config = services.userConfigRepository.setMinimumDiscountPercent(
      'discord-user',
      20,
      '2026-08-21T00:01:00.000Z',
    )!;
    saveGameThreshold(services.database, config, 10, 80, '2026-08-21T00:02:00.000Z');

    await services.checkService.check('discord-user');
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      notificationCandidates: [],
    });
    services.database.close();
  });

  it('keeps an initially active sale as baseline on repeated checks', async () => {
    const services = createServices({
      getWishlistWithErrors: vi.fn().mockResolvedValue({
        items: [createItem(10, true)],
        errors: [],
      }),
    });

    await services.checkService.check('discord-user');
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      notificationCandidates: [],
    });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    services.database.close();
  });

  it('creates a new episode when the same sale price returns later', async () => {
    const steamClient = {
      getWishlistWithErrors: vi
        .fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] }),
    };
    const services = createServices(steamClient);

    await services.checkService.check('discord-user');
    const firstSale = await services.checkService.check('discord-user');
    await services.checkService.check('discord-user');
    const result = await services.checkService.check('discord-user');

    expect(firstSale).toMatchObject({ status: 'success' });
    expect(result).toMatchObject({
      status: 'success',
      notificationCandidates: [{ saleKey: 'TRY:1000:500:50' }],
    });
    if (firstSale.status !== 'success' || result.status !== 'success') {
      throw new Error('Expected successful sale checks');
    }
    expect(result.notificationCandidates[0]?.saleEpisodeId).not.toBe(
      firstSale.notificationCandidates[0]?.saleEpisodeId,
    );
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(2);
    services.database.close();
  });

  it('updates the sale state without notifying when the price changes during an active sale', async () => {
    const steamClient = {
      getWishlistWithErrors: vi
        .fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true, 500)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true, 250)], errors: [] }),
    };
    const services = createServices(steamClient);

    await services.checkService.check('discord-user');
    await services.checkService.check('discord-user');
    const activeSale = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );
    const result = await services.checkService.check('discord-user');
    const state = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );

    expect(result).toMatchObject({ status: 'success', notificationCandidates: [] });
    expect(state).toMatchObject({
      onSale: true,
      saleKey: 'TRY:1000:250:50',
      finalPriceMinor: 250,
      saleEpisodeId: activeSale?.saleEpisodeId,
    });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(1);
    services.database.close();
  });

  it('preserves existing state when the wishlist request fails', async () => {
    const steamClient = {
      getWishlistWithErrors: vi
        .fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockRejectedValueOnce(new SteamWishlistError('STEAM_TIMEOUT', 'timed out')),
    };
    const services = createServices(steamClient);

    await services.checkService.check('discord-user');
    const before = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );
    const result = await services.checkService.check('discord-user');
    const after = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );

    expect(result).toEqual({ status: 'unavailable', errorCode: 'STEAM_TIMEOUT' });
    expect(after).toEqual(before);
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'unavailable',
      lastErrorCode: 'STEAM_TIMEOUT',
    });
    services.database.close();
  });

  it('treats unreleased, region-locked and removed games as facts, not as an incomplete check', async () => {
    const upcoming: WishlistItem = { ...createItem(60, null), upcoming: { message: 'To be announced' } };
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({
        items: [createItem(10, false), upcoming, createItem(40, null)],
        errors: [
          { appId: 70, code: 'STEAM_APP_REGION_UNAVAILABLE' as const },
          { appId: 80, code: 'STEAM_APP_NOT_FOUND' as const },
          { appId: 90, code: 'STEAM_SCHEMA_INVALID' as const },
        ],
      }),
    };
    const services = createServices(steamClient);

    const result = await services.checkService.check('discord-user');
    expect(result).toMatchObject({
      status: 'success', upcomingCount: 1, unknownPriceCount: 1,
      failedItems: [{ appId: 90 }], unavailableItems: [{ appId: 70 }, { appId: 80 }],
    });
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'success', lastSuccessUnknownPriceCount: 1, lastSuccessFailedItemCount: 1,
    });
  });

  it('completes a check whose only items are unavailable in the region', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({
        items: [], errors: [{ appId: 70, code: 'STEAM_APP_REGION_UNAVAILABLE' as const }],
      }),
    };
    const services = createServices(steamClient);
    expect(await services.checkService.check('discord-user')).toMatchObject({ status: 'success', unavailableItems: [{ appId: 70 }] });
  });

  it('persists successful wishlist metrics and preserves them after an unavailable check', async () => {
    const freeItem: WishlistItem = {
      ...createItem(30, false),
      price: {
        currency: null,
        initialMinor: 0,
        finalMinor: 0,
        discountPercent: 0,
        isFree: true,
      },
    };
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({
          items: [
            createItem(10, false),
            createItem(20, true),
            freeItem,
            createItem(40, null),
          ],
          errors: [{ appId: 50, code: 'STEAM_SCHEMA_INVALID' as const }],
        })
        .mockRejectedValueOnce(new SteamWishlistError('STEAM_TIMEOUT', 'timed out'))
        .mockRejectedValueOnce(new TypeError('unexpected Steam defect')),
    };
    const services = createServices(steamClient);

    await services.checkService.check('discord-user');
    const successfulState = services.checkStateRepository.findByDiscordUserId('discord-user');
    expect(successfulState).toMatchObject({
      lastStatus: 'success',
      lastSuccessCheckedCount: 4,
      lastSuccessOnSaleCount: 1,
      lastSuccessFreeCount: 1,
      lastSuccessUnknownPriceCount: 1,
      lastSuccessFailedItemCount: 1,
    });
    expect(successfulState?.lastSuccessCompletedAt).not.toBeNull();

    await services.checkService.check('discord-user');
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'unavailable',
      lastErrorCode: 'STEAM_TIMEOUT',
      lastSuccessCompletedAt: successfulState?.lastSuccessCompletedAt,
      lastSuccessCheckedCount: 4,
      lastSuccessOnSaleCount: 1,
      lastSuccessFreeCount: 1,
      lastSuccessUnknownPriceCount: 1,
      lastSuccessFailedItemCount: 1,
    });

    await services.checkService.check('discord-user');
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'failed',
      lastErrorCode: 'INTERNAL_ERROR',
      lastSuccessCompletedAt: successfulState?.lastSuccessCompletedAt,
      lastSuccessCheckedCount: 4,
      lastSuccessOnSaleCount: 1,
      lastSuccessFreeCount: 1,
      lastSuccessUnknownPriceCount: 1,
      lastSuccessFailedItemCount: 1,
    });
    services.database.close();
  });

  it('does not change check or wishlist state when shutdown cancels Steam work', async () => {
    const steamClient = {
      getWishlistWithErrors: vi
        .fn()
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockRejectedValueOnce(new SteamWishlistError('STEAM_CANCELLED', 'shutdown')),
    };
    const services = createServices(steamClient);
    await services.checkService.check('discord-user');
    const stateBefore = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );
    const checkBefore = services.checkStateRepository.findByDiscordUserId('discord-user');

    await expect(services.checkService.check('discord-user')).resolves.toEqual({
      status: 'unavailable',
      errorCode: 'STEAM_CANCELLED',
    });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toEqual(stateBefore);
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toEqual(checkBefore);
    services.database.close();
  });

  it('preserves an active sale episode while the wishlist is inaccessible', async () => {
    const steamClient = {
      getWishlistWithErrors: vi
        .fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockRejectedValueOnce(
          new SteamWishlistError('STEAM_WISHLIST_INACCESSIBLE', 'private wishlist'),
        )
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] }),
    };
    const services = createServices(steamClient);

    await services.checkService.check('discord-user');
    await services.checkService.check('discord-user');
    const activeSale = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );
    const inaccessible = await services.checkService.check('discord-user');
    const preservedSale = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );
    const restored = await services.checkService.check('discord-user');

    expect(inaccessible).toEqual({
      status: 'unavailable',
      errorCode: 'STEAM_WISHLIST_INACCESSIBLE',
    });
    expect(preservedSale).toEqual(activeSale);
    expect(restored).toMatchObject({ status: 'success', notificationCandidates: [] });
    expect(
      services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10),
    ).toMatchObject({ saleEpisodeId: activeSale?.saleEpisodeId });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(1);
    services.database.close();
  });

  it('processes successful items when another item has an appdetails error', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({
        items: [createItem(10, false), createItem(20, true)],
        errors: [{ appId: 30, code: 'STEAM_RATE_LIMITED' as const }],
      }),
    };
    const services = createServices(steamClient);

    const result = await services.checkService.check('discord-user');

    expect(result).toMatchObject({
      status: 'success',
      checkedCount: 2,
      failedItems: [{ appId: 30, code: 'STEAM_RATE_LIMITED' }],
      notificationCandidates: [],
    });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10)).not.toBeNull();
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 20)).not.toBeNull();
    services.database.close();
  });

  it('does not treat unknown prices as not-on-sale or create state', async () => {
    const services = createServices(steamSequence([createItem(10, null)]));

    const result = await services.checkService.check('discord-user');

    expect(result).toMatchObject({ status: 'success', unknownPriceCount: 1 });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10)).toBeNull();
    services.database.close();
  });

  it('marks an existing sale unknown without changing its episode or price', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, null)], errors: [] }),
    };
    const services = createServices(steamClient);
    await services.checkService.check('discord-user');
    await services.checkService.check('discord-user');
    const active = services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10);

    await services.checkService.check('discord-user');

    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({
        observationStatus: 'unknown',
        onSale: true,
        saleEpisodeId: active?.saleEpisodeId,
        finalPriceMinor: 500,
      });
    services.database.close();
  });

  it('marks only a partially failed app detail as error instead of missing', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockResolvedValueOnce({
          items: [createItem(20, false)],
          errors: [{ appId: 10, code: 'STEAM_RATE_LIMITED' as const }],
        }),
    };
    const services = createServices(steamClient);
    await services.checkService.check('discord-user');
    const active = services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10);

    await services.checkService.check('discord-user');

    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({
        observationStatus: 'error',
        onSale: true,
        saleEpisodeId: active?.saleEpisodeId,
      });
    services.database.close();
  });

  it('suspends pending notifications when every app detail request fails', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockResolvedValueOnce({
          items: [],
          errors: [{ appId: 10, code: 'STEAM_UPSTREAM_ERROR' as const }],
        }),
    };
    const services = createServices(steamClient);
    await services.checkService.check('discord-user');
    const sale = await services.checkService.check('discord-user');
    expect(sale).toMatchObject({ status: 'success', notificationCandidates: [{ appId: 10 }] });

    await expect(services.checkService.check('discord-user')).resolves.toEqual({
      status: 'unavailable',
      errorCode: 'STEAM_UPSTREAM_ERROR',
    });

    const config = services.userConfigRepository.findByDiscordUserId('discord-user')!;
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ observationStatus: 'error', onSale: true });
    expect(services.wishlistStateRepository.findRetryableNotificationCandidates(
      config,
      '2026-08-21T01:00:00.000Z',
    )).toEqual([]);
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'unavailable',
      lastErrorCode: 'STEAM_UPSTREAM_ERROR',
    });
    services.database.close();
  });

  it('keeps concurrent checks for one user from running twice', async () => {
    let resolveCheck: ((value: { items: WishlistItem[]; errors: [] }) => void) | undefined;
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockImplementation(
        () =>
          new Promise<{ items: WishlistItem[]; errors: [] }>((resolve) => {
            resolveCheck = resolve;
          }),
      ),
    };
    const services = createServices(steamClient);

    const firstCheck = services.checkService.check('discord-user');
    const secondResult = await services.checkService.check('discord-user');
    resolveCheck?.({ items: [], errors: [] });
    const firstResult = await firstCheck;

    expect(secondResult).toEqual({ status: 'already-running' });
    expect(firstResult).toMatchObject({ status: 'success', checkedCount: 0 });
    services.database.close();
  });

  it('skips automatic checks while allowing a disabled user to check manually', async () => {
    const steamClient = steamSequence([createItem(10, true)]);
    const services = createServices(steamClient);
    services.userConfigRepository.setEnabled(
      'discord-user',
      false,
      '2026-08-21T01:00:00.000Z',
    );

    await expect(services.checkService.check('discord-user', 'automatic')).resolves.toEqual({
      status: 'disabled',
    });
    expect(steamClient.getWishlistWithErrors).not.toHaveBeenCalled();

    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      status: 'success',
      checkedCount: 1,
    });
    expect(steamClient.getWishlistWithErrors).toHaveBeenCalledOnce();
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')?.lastStatus)
      .toBe('success');
    services.database.close();
  });

  it('isolates wishlist state when the configured Steam account changes', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockImplementation(async (steamId64: string) => ({
        items: [createItem(10, steamId64.endsWith('1'))],
        errors: [],
      })),
    };
    const services = createServices(steamClient);

    await services.checkService.check('discord-user');
    const oldConfig = services.userConfigRepository.findByDiscordUserId('discord-user');
    services.userConfigRepository.upsert(
      'discord-user',
      '76561198000000001',
      'tr',
      'TR',
      '2026-08-21T01:00:00.000Z',
    );
    const result = await services.checkService.check('discord-user');
    const newConfig = services.userConfigRepository.findByDiscordUserId('discord-user');

    expect(oldConfig?.configVersion).toBe(1);
    expect(newConfig?.configVersion).toBe(2);
    expect(result).toMatchObject({ status: 'success', notificationCandidates: [] });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10, 1))
      .toMatchObject({ steamId64: '76561198000000000', onSale: false });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10, 2))
      .toMatchObject({ steamId64: '76561198000000001', onSale: true });
    services.database.close();
  });

  it('ends an episode when a game leaves the wishlist and starts a new one when re-added', async () => {
    const steamClient = {
      getWishlistWithErrors: vi
        .fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockResolvedValueOnce({ items: [], errors: [] })
        .mockResolvedValueOnce({ items: [], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] }),
    };
    let clock = Date.parse('2026-08-21T01:00:00.000Z');
    const services = createServices(steamClient, { cooldownMs: 0, now: () => new Date(clock) });

    await services.checkService.check('discord-user');
    const firstSale = await services.checkService.check('discord-user');
    await services.checkService.check('discord-user');
    // Still absent after the grace period: now it has really left the wishlist.
    clock += 30 * 60 * 1000;
    await services.checkService.check('discord-user');
    const removedState = services.wishlistStateRepository.findByDiscordUserAndAppId(
      'discord-user',
      10,
    );
    const secondSale = await services.checkService.check('discord-user');

    expect(removedState).toMatchObject({
      onSale: false,
      saleEpisodeId: null,
      saleStartedAt: null,
    });
    if (firstSale.status !== 'success' || secondSale.status !== 'success') {
      throw new Error('Expected successful sale checks');
    }
    expect(secondSale.notificationCandidates).toHaveLength(1);
    expect(secondSale.notificationCandidates[0]?.saleEpisodeId).not.toBe(
      firstSale.notificationCandidates[0]?.saleEpisodeId,
    );
    services.database.close();
  });

  it('enforces a per-user cooldown between completed checks', async () => {
    let now = new Date('2026-08-21T00:00:00.000Z');
    const services = createServices(steamSequence([]), {
      cooldownMs: 60_000,
      now: () => now,
    });

    await services.checkService.check('discord-user');
    now = new Date('2026-08-21T00:00:30.000Z');
    await expect(services.checkService.check('discord-user')).resolves.toEqual({
      status: 'cooldown',
      retryAfterSeconds: 30,
    });
    now = new Date('2026-08-21T00:01:00.000Z');
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      status: 'success',
    });
    services.database.close();
  });

  it('reports persistence failures separately from Steam availability', async () => {
    const services = createServices(steamSequence([createItem(10, false)]));
    vi.spyOn(services.wishlistStateRepository, 'recordObservation').mockImplementation(() => {
      throw new Error('database write failed');
    });

    const result = await services.checkService.check('discord-user');

    expect(result).toEqual({ status: 'failed', errorCode: 'PERSISTENCE_ERROR' });
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'failed',
      lastErrorCode: 'PERSISTENCE_ERROR',
    });
    services.database.close();
  });

  it('commits every item, candidate, missing transition, and metric as one snapshot', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({
          items: [createItem(10, false), createItem(20, false), createItem(30, true)],
          errors: [],
        })
        .mockResolvedValueOnce({
          items: [createItem(10, true), createItem(20, true)],
          errors: [],
        }),
    };
    const services = createServices(steamClient);
    await services.checkService.check('discord-user');

    const result = await services.checkService.check('discord-user');

    expect(result).toMatchObject({
      status: 'success',
      checkedCount: 2,
      notificationCandidates: [{ appId: 10 }, { appId: 20 }],
    });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: true, observationStatus: 'known' });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 20))
      .toMatchObject({ onSale: true, observationStatus: 'known' });
    // One absence is only suspected: the sale state survives the grace period.
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 30))
      .toMatchObject({ onSale: true, observationStatus: 'missing' });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(2);
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'success',
      lastSuccessCheckedCount: 2,
      lastSuccessOnSaleCount: 2,
    });
    services.database.close();
  });

  it('does not re-alert an ongoing sale when Steam briefly leaves the game out', async () => {
    let clock = Date.parse('2026-08-21T01:00:00.000Z');
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [createItem(10, false)], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockResolvedValueOnce({ items: [], errors: [] })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] }),
    };
    const services = createServices(steamClient, { cooldownMs: 0, now: () => new Date(clock) });
    await services.checkService.check('discord-user');
    const sale = await services.checkService.check('discord-user');
    expect(sale).toMatchObject({ notificationCandidates: [{ appId: 10 }] });
    const episode = services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10)?.saleEpisodeId;

    clock += 30 * 60 * 1000;
    await services.checkService.check('discord-user');
    clock += 30 * 60 * 1000;
    const back = await services.checkService.check('discord-user');

    expect(back).toMatchObject({ status: 'success', notificationCandidates: [] });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: true, observationStatus: 'known', saleEpisodeId: episode });
    services.database.close();
  });

  it('drops the sale state once a game stays absent through the grace period', async () => {
    let clock = Date.parse('2026-08-21T01:00:00.000Z');
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] })
        .mockResolvedValue({ items: [createItem(20, false)], errors: [] }),
    };
    const services = createServices(steamClient, { cooldownMs: 0, now: () => new Date(clock) });
    await services.checkService.check('discord-user');
    clock += 5 * 60 * 1000;
    await services.checkService.check('discord-user');
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: true, observationStatus: 'missing' });

    clock += 5 * 60 * 1000;
    await services.checkService.check('discord-user');
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: true, observationStatus: 'missing' });

    clock += 20 * 60 * 1000;
    await services.checkService.check('discord-user');
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: false, observationStatus: 'missing', saleEpisodeId: null });
    services.database.close();
  });

  it('rolls back earlier items and candidates when a middle item write fails', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({
          items: [createItem(10, false), createItem(20, false)],
          errors: [],
        })
        .mockResolvedValueOnce({
          items: [createItem(10, true), createItem(20, true)],
          errors: [],
        }),
    };
    const services = createServices(steamClient);
    await services.checkService.check('discord-user');
    services.database.exec(`
      CREATE TRIGGER fail_middle_item
      BEFORE UPDATE ON wishlist_item_state
      WHEN NEW.app_id = 20 AND NEW.on_sale = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected middle item failure');
      END;
    `);

    const result = await services.checkService.check('discord-user');

    expect(result).toEqual({ status: 'failed', errorCode: 'PERSISTENCE_ERROR' });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: false, saleEpisodeId: null, observationStatus: 'known' });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 20))
      .toMatchObject({ onSale: false, saleEpisodeId: null, observationStatus: 'known' });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'failed',
      lastErrorCode: 'PERSISTENCE_ERROR',
      lastSuccessCheckedCount: 2,
      lastSuccessOnSaleCount: 0,
    });
    services.database.close();
  });

  it('rolls back the complete wishlist snapshot when the success marker fails', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({
          items: [createItem(10, false), createItem(30, true)],
          errors: [],
        })
        .mockResolvedValueOnce({ items: [createItem(10, true)], errors: [] }),
    };
    const services = createServices(steamClient);
    await services.checkService.check('discord-user');
    services.database.exec(`
      CREATE TRIGGER fail_check_success
      BEFORE UPDATE OF last_status ON check_state
      WHEN NEW.last_status = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'injected success failure');
      END;
    `);

    const result = await services.checkService.check('discord-user');

    expect(result).toEqual({ status: 'failed', errorCode: 'PERSISTENCE_ERROR' });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: false, saleEpisodeId: null, observationStatus: 'known' });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 30))
      .toMatchObject({ onSale: true, observationStatus: 'known' });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    expect(services.checkStateRepository.findByDiscordUserId('discord-user'))
      .toMatchObject({
        lastStatus: 'failed',
        lastSuccessCheckedCount: 2,
        lastSuccessOnSaleCount: 1,
      });
    services.database.close();
  });

  it('reports unexpected Steam client defects as internal failures', async () => {
    const services = createServices({
      getWishlistWithErrors: vi.fn().mockRejectedValue(new TypeError('unexpected defect')),
    });

    const result = await services.checkService.check('discord-user');

    expect(result).toEqual({ status: 'failed', errorCode: 'INTERNAL_ERROR' });
    expect(services.checkStateRepository.findByDiscordUserId('discord-user')).toMatchObject({
      lastStatus: 'failed',
      lastErrorCode: 'INTERNAL_ERROR',
    });
    services.database.close();
  });

  it('starts cooldown after a long-running check completes', async () => {
    let now = new Date('2026-08-21T00:00:00.000Z');
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockImplementation(async () => {
        now = new Date('2026-08-21T00:10:00.000Z');
        return { items: [], errors: [] };
      }),
    };
    const services = createServices(steamClient, {
      cooldownMs: 60_000,
      now: () => now,
    });

    await services.checkService.check('discord-user');
    await expect(services.checkService.check('discord-user')).resolves.toEqual({
      status: 'cooldown',
      retryAfterSeconds: 60,
    });
    services.database.close();
  });
});
