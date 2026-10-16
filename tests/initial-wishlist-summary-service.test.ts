import { describe, expect, it, vi } from 'vitest';
import { CheckService } from '../src/application/check-service.js';
import { InitialWishlistSummaryService } from '../src/application/initial-wishlist-summary-service.js';
import { SteamWishlistError, type WishlistItem } from '../src/domain/steam.js';
import { CheckStateRepository } from '../src/persistence/check-state-repository.js';
import { createDatabase } from '../src/persistence/database.js';
import { DiscountThresholdRepository } from '../src/persistence/discount-threshold-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import { saveGameThreshold } from './helpers/game-rules.js';

function item(appId: number, discountPercent: number): WishlistItem {
  return {
    appId,
    headerImageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/hash/header.jpg`,
    name: `Game ${appId}`,
    priority: null,
    dateAdded: null,
    price: {
      currency: 'USD',
      initialMinor: 2_000,
      finalMinor: 2_000 - discountPercent * 20,
      discountPercent,
      isFree: false,
    },
    onSale: discountPercent > 0,
  };
}

function fixture(steamClient: ConstructorParameters<typeof CheckService>[3]) {
  const database = createDatabase(':memory:');
  const userConfigRepository = new UserConfigRepository(database);
  const checkStateRepository = new CheckStateRepository(database);
  const wishlistStateRepository = new WishlistStateRepository(database);
  const discountThresholdRepository = new DiscountThresholdRepository(database);
  const config = userConfigRepository.upsert(
    'discord-user',
    '76561198000000000',
    'en',
    'US',
    '2026-08-23T00:00:00.000Z',
  );
  const sender = { sendInitialSummary: vi.fn().mockResolvedValue(undefined) };
  const checkService = new CheckService(
    userConfigRepository,
    checkStateRepository,
    wishlistStateRepository,
    steamClient,
    undefined,
    { cooldownMs: 0, now: () => new Date('2026-08-23T00:01:00.000Z') },
  );
  return {
    database,
    config,
    userConfigRepository,
    wishlistStateRepository,
    discountThresholdRepository,
    checkService,
    sender,
    service: new InitialWishlistSummaryService(checkService, sender),
  };
}

describe('InitialWishlistSummaryService', () => {
  it('includes every current sale regardless of global and game thresholds', async () => {
    const steamClient = {
      getWishlistWithErrors: vi.fn().mockResolvedValue({
        items: [item(10, 50), item(20, 10), item(30, 0)],
        errors: [],
      }),
    };
    const services = fixture(steamClient);
    services.userConfigRepository.setMinimumDiscountPercent(
      'discord-user',
      90,
      '2026-08-23T00:00:10.000Z',
    );
    saveGameThreshold(services.database, services.config, 20, 100, '2026-08-23T00:00:20.000Z');

    await expect(services.service.send('discord-user')).resolves.toEqual({
      status: 'sent',
      saleCount: 2,
    });

    expect(steamClient.getWishlistWithErrors)
      .toHaveBeenCalledWith('76561198000000000', 'US', 'en');
    expect(services.sender.sendInitialSummary).toHaveBeenCalledWith(expect.objectContaining({
      discordUserId: 'discord-user',
      storeCountryCode: 'US',
      sales: [
        expect.objectContaining({ appId: 10, currency: 'USD', discountPercent: 50, headerImageUrl: item(10, 50).headerImageUrl }),
        expect.objectContaining({ appId: 20, currency: 'USD', discountPercent: 10 }),
      ],
    }));
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: true, observationStatus: 'known' });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 20))
      .toMatchObject({ onSale: true, observationStatus: 'known' });
    services.database.close();
  });

  it('keeps setup sales as a baseline until they leave and enter sale again', async () => {
    const sale = item(10, 50);
    const regular = item(10, 0);
    const steamClient = {
      getWishlistWithErrors: vi.fn()
        .mockResolvedValueOnce({ items: [sale], errors: [] })
        .mockResolvedValueOnce({ items: [sale], errors: [] })
        .mockResolvedValueOnce({ items: [regular], errors: [] })
        .mockResolvedValueOnce({ items: [sale], errors: [] }),
    };
    const services = fixture(steamClient);

    await services.service.send('discord-user');
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      status: 'success',
      notificationCandidates: [],
    });
    await services.checkService.check('discord-user');
    await expect(services.checkService.check('discord-user')).resolves.toMatchObject({
      status: 'success',
      notificationCandidates: [{ appId: 10 }],
    });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(1);
    services.database.close();
  });

  it('sends the successful empty-sale summary for a wishlist without discounts', async () => {
    const services = fixture({
      getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [item(10, 0)], errors: [] }),
    });

    await expect(services.service.send('discord-user')).resolves.toEqual({
      status: 'sent',
      saleCount: 0,
    });
    expect(services.sender.sendInitialSummary).toHaveBeenCalledWith(expect.objectContaining({
      sales: [],
    }));
    services.database.close();
  });

  it('sends confirmed sales while omitting unknown and failed wishlist items', async () => {
    const unknownItem: WishlistItem = {
      ...item(20, 0),
      price: null,
      onSale: null,
    };
    const services = fixture({
      getWishlistWithErrors: vi.fn().mockResolvedValue({
        items: [item(10, 50), unknownItem, item(30, 0)],
        errors: [{ appId: 40, code: 'STEAM_RATE_LIMITED' }],
      }),
    });

    await expect(services.service.send('discord-user')).resolves.toEqual({
      status: 'sent',
      saleCount: 1,
    });
    expect(services.sender.sendInitialSummary).toHaveBeenCalledWith(expect.objectContaining({
      sales: [expect.objectContaining({ appId: 10, discountPercent: 50 })],
      totalGameCount: 4,
      failedItemCount: 2,
    }));
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: true, observationStatus: 'known' });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 20))
      .toBeNull();
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 40))
      .toBeNull();
    services.database.close();
  });

  it('does not send a sale summary when Steam is unavailable', async () => {
    const services = fixture({
      getWishlistWithErrors: vi.fn().mockRejectedValue(
        new SteamWishlistError('STEAM_TIMEOUT', 'temporary timeout'),
      ),
    });

    await expect(services.service.send('discord-user')).resolves.toEqual({
      status: 'steam-unavailable',
    });
    expect(services.sender.sendInitialSummary).not.toHaveBeenCalled();
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    services.database.close();
  });

  it('keeps the baseline and reports a non-fatal DM failure', async () => {
    const services = fixture({
      getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [item(10, 50)], errors: [] }),
    });
    services.sender.sendInitialSummary.mockRejectedValueOnce(new Error('Discord DM blocked'));

    await expect(services.service.send('discord-user')).resolves.toEqual({
      status: 'dm-transient-failed',
      saleCount: 1,
    });
    expect(services.wishlistStateRepository.findByDiscordUserAndAppId('discord-user', 10))
      .toMatchObject({ onSale: true, observationStatus: 'known' });
    expect(services.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    services.database.close();
  });
});

describe('initial summary delivery error classification', () => {
  it('does not classify malformed notification content as a user DM block', async () => {
    const services = fixture({ getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [item(10, 50)], errors: [] }) } as never);
    try {
      services.sender.sendInitialSummary.mockRejectedValueOnce(Object.assign(
        new Error('Invalid Form Body'), { code: 50035, status: 400 },
      ));
      await expect(services.service.send('discord-user'))
        .resolves.toMatchObject({ status: 'dm-transient-failed' });
    } finally { services.database.close(); }
  });
});
