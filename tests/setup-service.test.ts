import { describe, expect, it, vi } from 'vitest';
import { CheckService } from '../src/application/check-service.js';
import { InitialWishlistSummaryService } from '../src/application/initial-wishlist-summary-service.js';
import {
  SetupAlreadyCompletedError,
  SetupCapacityReachedError,
  SetupService,
} from '../src/application/setup-service.js';
import { UserConfigurationService } from '../src/application/user-configuration-service.js';
import { UserOperationCoordinator } from '../src/application/user-operation-coordinator.js';
import type { WishlistItem } from '../src/domain/steam.js';
import { setupCompleteDetail, setupCompleteStatus } from '../src/discord/setup-view.js';
import { CheckStateRepository } from '../src/persistence/check-state-repository.js';
import { createDatabase } from '../src/persistence/database.js';
import { DiscountThresholdRepository } from '../src/persistence/discount-threshold-repository.js';
import { PollScheduleRepository } from '../src/persistence/poll-schedule-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import { saveGameThreshold } from './helpers/game-rules.js';

const saleItem: WishlistItem = {
  appId: 10,
  name: 'Setup Sale',
  priority: null,
  dateAdded: null,
  price: {
    currency: 'USD',
    initialMinor: 2_000,
    finalMinor: 1_000,
    discountPercent: 50,
    isFree: false,
  },
  onSale: true,
};

function services(
  identityResolver = { resolve: vi.fn(async (value: string) => value) },
  setupOptions: ConstructorParameters<typeof SetupService>[3] = {},
) {
  const database = createDatabase(':memory:');
  const userConfigRepository = new UserConfigRepository(database);
  const checkStateRepository = new CheckStateRepository(database);
  const wishlistStateRepository = new WishlistStateRepository(database);
  const discountThresholdRepository = new DiscountThresholdRepository(database);
  const coordinator = new UserOperationCoordinator();
  const steamClient = {
    getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [saleItem], errors: [] }),
  };
  const configurationService = new UserConfigurationService(
    userConfigRepository,
    identityResolver,
    { validateWishlistAccess: vi.fn().mockResolvedValue(undefined) },
    coordinator,
  );
  const checkService = new CheckService(
    userConfigRepository,
    checkStateRepository,
    wishlistStateRepository,
    steamClient,
    coordinator,
    { cooldownMs: 0 },
  );
  const sender = { sendInitialSummary: vi.fn().mockResolvedValue(undefined) };
  const setupService = new SetupService(
    configurationService,
    new InitialWishlistSummaryService(checkService, sender),
    coordinator,
    setupOptions,
  );
  return {
    database,
    userConfigRepository,
    wishlistStateRepository,
    discountThresholdRepository,
    checkService,
    setupService,
    steamClient,
    sender,
  };
}

describe('SetupService', () => {
  it('rejects repeated setup without changing existing data or sending another baseline', async () => {
    const fixture = services();
    const oldConfig = fixture.userConfigRepository.upsert(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
      '2026-08-23T00:00:00.000Z',
    );
    fixture.wishlistStateRepository.recordObservation(oldConfig, {
      item: {
        ...saleItem,
        onSale: false,
        price: { ...saleItem.price!, finalMinor: 2_000, discountPercent: 0 },
      },
      saleKey: null,
      observedAt: '2026-08-23T00:01:00.000Z',
    });
    const oldCandidate = fixture.wishlistStateRepository.recordObservation(oldConfig, {
      item: saleItem,
      saleKey: 'USD:2000:1000:50',
      observedAt: '2026-08-23T00:02:00.000Z',
    }).notificationCandidate;
    if (!oldCandidate) {
      throw new Error('Expected old setup candidate');
    }
    saveGameThreshold(fixture.database, oldConfig, 10, 40, '2026-08-23T00:02:10.000Z');

    await expect(fixture.setupService.configure(
      'discord-user',
      '76561198000000000',
      'en',
      'US',
    )).rejects.toBeInstanceOf(SetupAlreadyCompletedError);

    expect(fixture.userConfigRepository.findByDiscordUserId('discord-user')).toEqual(oldConfig);
    expect(fixture.wishlistStateRepository.findNotificationStatus(oldCandidate)).toBe('candidate');
    expect(fixture.discountThresholdRepository.findGameOverride(oldConfig, 10)).toBe(40);
    expect(fixture.sender.sendInitialSummary).not.toHaveBeenCalled();
    fixture.database.close();
  });

  it('rechecks setup ownership at confirmation so two open sessions cannot overwrite data', async () => {
    const fixture = services();
    const prepared = await fixture.setupService.prepare(
      'discord-user',
      '76561198000000000',
      'tr',
      'Türkiye',
    );
    fixture.userConfigRepository.upsert(
      'discord-user',
      '76561198000000001',
      'en',
      'US',
      '2026-08-23T00:00:00.000Z',
    );

    await expect(fixture.setupService.confirm(prepared))
      .rejects.toBeInstanceOf(SetupAlreadyCompletedError);
    expect(fixture.userConfigRepository.findByDiscordUserId('discord-user')).toMatchObject({
      steamId64: '76561198000000001',
      language: 'en',
      storeCountryCode: 'US',
    });
    expect(fixture.sender.sendInitialSummary).not.toHaveBeenCalled();
    fixture.database.close();
  });

  it('serializes configure and baseline ahead of a queued automatic check', async () => {
    let resolveIdentity: ((steamId64: string) => void) | undefined;
    const identityResolver = {
      resolve: vi.fn(() => new Promise<string>((resolve) => {
        resolveIdentity = resolve;
      })),
    };
    const fixture = services(identityResolver);
    const setup = fixture.setupService.configure(
      'discord-user',
      'profile-name',
      'en',
      'US',
    );
    await vi.waitFor(() => expect(identityResolver.resolve).toHaveBeenCalledOnce());
    const automaticCheck = fixture.checkService.check('discord-user', 'automatic');

    resolveIdentity?.('76561198000000000');
    await expect(setup).resolves.toMatchObject({ summary: { status: 'sent' } });
    await expect(automaticCheck).resolves.toMatchObject({
      status: 'success',
      notificationCandidates: [],
    });
    expect(fixture.sender.sendInitialSummary).toHaveBeenCalledOnce();
    expect(fixture.wishlistStateRepository.countNotificationCandidates('discord-user')).toBe(0);
    expect(fixture.steamClient.getWishlistWithErrors).toHaveBeenCalledTimes(2);
    fixture.database.close();
  });

  it('records explicit consent and pauses notifications when Discord permanently blocks the DM', async () => {
    const fixture = services();
    fixture.sender.sendInitialSummary.mockRejectedValueOnce(Object.assign(
      new Error('Cannot send messages to this user'),
      { code: 50_007, status: 403 },
    ));

    const prepared = await fixture.setupService.prepare(
      'discord-user',
      '76561198000000000',
      'tr',
      'Türkiye',
    );
    const result = await fixture.setupService.confirm(prepared);

    expect(result.summary).toMatchObject({ status: 'dm-blocked', saleCount: 1 });
    expect(result.config).toMatchObject({
      enabled: false,
      storeCountryCode: 'TR',
      dmDeliveryErrorCode: 'DISCORD_DM_BLOCKED',
    });
    expect(result.config.dmOptInAt).toBeTruthy();
    expect(result.config.dmDeliveryBlockedAt).toBeTruthy();
    fixture.database.close();
  });

  it('pauses with its own remedy when Discord refuses the DM for lack of a shared server', async () => {
    const fixture = services();
    fixture.sender.sendInitialSummary.mockRejectedValueOnce(Object.assign(
      new Error('Cannot send messages to this user due to having no mutual guilds'),
      { code: 50_278, status: 403 },
    ));

    const prepared = await fixture.setupService.prepare('discord-user', '76561198000000000', 'en', 'US');
    const result = await fixture.setupService.confirm(prepared);

    // Not "a temporary problem, tracking carries on": every later DM would fail the same way.
    expect(result.summary).toMatchObject({ status: 'dm-blocked', errorCode: 'DISCORD_NO_MUTUAL_GUILD' });
    expect(result.config).toMatchObject({ enabled: false, dmDeliveryErrorCode: 'DISCORD_NO_MUTUAL_GUILD' });
    expect(result.config.dmDeliveryBlockedAt).toBeTruthy();
    fixture.database.close();
  });
});

describe('setup completion message', () => {
  it('names the fix for the reason Discord refused the welcome DM', () => {
    const noMutualGuild = setupCompleteStatus({ status: 'dm-blocked', saleCount: 0, errorCode: 'DISCORD_NO_MUTUAL_GUILD' });
    const privacy = setupCompleteStatus({ status: 'dm-blocked', saleCount: 0, errorCode: 'DISCORD_DM_BLOCKED' });

    expect(noMutualGuild).toBe('dm-no-mutual-guild');
    expect(privacy).toBe('dm-blocked');
    expect(setupCompleteDetail(noMutualGuild, 'en')).toContain('Add to My Apps');
    expect(setupCompleteDetail(privacy, 'en')).toContain('privacy settings');
    expect(setupCompleteStatus({ status: 'dm-transient-failed', saleCount: 0 })).toBe('dm-transient-failed');
  });
});

describe('setup profile summary', () => {
  const steamId = '76561198000000000';
  const prepare = (identityResolver: object) => new UserConfigurationService(
    new UserConfigRepository(createDatabase(':memory:')),
    identityResolver as never,
    { validateWishlistAccess: vi.fn().mockResolvedValue(undefined) },
  ).prepare('discord-user', steamId, 'tr', 'TR');

  it('carries the Steam name and avatar to the confirmation screen without storing them', async () => {
    const profile = { personaName: 'Gabe', avatarUrl: 'https://avatars.steamstatic.com/a_full.jpg' };
    await expect(prepare({ resolve: async () => steamId, summary: async () => profile }))
      .resolves.toMatchObject({ steamId64: steamId, profile });
  });

  it('never lets a failing profile read block setup', async () => {
    const prepared = await prepare({ resolve: async () => steamId, summary: async () => { throw new Error('Steam down'); } });
    expect(prepared).toEqual({ discordUserId: 'discord-user', steamId64: steamId, language: 'tr', storeCountryCode: 'TR' });
  });
});

describe('SetupService capacity and account change', () => {
  it('turns away new users at the limit but never existing ones', async () => {
    const fixture = services(undefined, { maxUsers: 1 });
    await fixture.setupService.configure('first-user', '76561198000000000', 'en', 'US');

    expect(fixture.setupService.acceptsNewUsers()).toBe(false);
    await expect(fixture.setupService.prepare('second-user', '76561198000000001', 'en', 'US'))
      .rejects.toBeInstanceOf(SetupCapacityReachedError);
    await expect(fixture.setupService.configure('second-user', '76561198000000001', 'en', 'US'))
      .rejects.toBeInstanceOf(SetupCapacityReachedError);
    expect(fixture.userConfigRepository.findByDiscordUserId('second-user')).toBeNull();

    const prepared = await fixture.setupService.prepareAccountChange('first-user', '76561198000000002', 'en', 'US');
    await expect(fixture.setupService.changeAccount(prepared)).resolves.toMatchObject({
      config: { steamId64: '76561198000000002' },
    });
    fixture.database.close();
  });

  it('switches the Steam account from a baseline, without alerts or the old rules', async () => {
    const fixture = services();
    await fixture.setupService.configure('discord-user', '76561198000000000', 'en', 'US');
    const before = fixture.userConfigRepository.findByDiscordUserId('discord-user')!;
    saveGameThreshold(fixture.database, before, 10, 70, '2026-08-23T00:00:00.000Z');
    fixture.sender.sendInitialSummary.mockClear();

    const prepared = await fixture.setupService.prepareAccountChange('discord-user', '76561198000000009', 'en', 'US');
    const result = await fixture.setupService.changeAccount(prepared);

    expect(result.wishlistLoaded).toBe(true);
    expect(result.config).toMatchObject({ steamId64: '76561198000000009', enabled: true });
    expect(result.config.configVersion).toBeGreaterThan(before.configVersion);
    expect(result.config.configurationId).toBe(before.configurationId);
    expect(fixture.discountThresholdRepository.findGameOverride(result.config, 10)).toBeNull();
    // The game already on sale in the new list is a baseline, not an alert.
    expect(fixture.wishlistStateRepository.countNotificationCandidates('discord-user', result.config.configVersion)).toBe(0);
    expect(fixture.sender.sendInitialSummary).not.toHaveBeenCalled();
    fixture.database.close();
  });

  it('keeps a paused account paused after a Steam account change', async () => {
    const fixture = services();
    new PollScheduleRepository(fixture.database).setNextScheduledAt('2026-08-23T01:00:00.000Z');
    await fixture.setupService.configure('discord-user', '76561198000000000', 'en', 'US');
    const paused = fixture.userConfigRepository.setEnabled('discord-user', false, '2026-08-23T00:10:00.000Z')!;

    const prepared = await fixture.setupService.prepareAccountChange('discord-user', '76561198000000009', 'en', 'US');
    const result = await fixture.setupService.changeAccount(prepared);

    expect(result.config).toMatchObject({ steamId64: '76561198000000009', enabled: false, dmOptInAt: paused.dmOptInAt });
    expect(new CheckStateRepository(fixture.database).findByDiscordUserId('discord-user')?.nextScheduledAt ?? null).toBeNull();
    fixture.database.close();
  });

  it('keeps a DM block and its reason after a Steam account change', async () => {
    const fixture = services();
    new PollScheduleRepository(fixture.database).setNextScheduledAt('2026-08-23T01:00:00.000Z');
    await fixture.setupService.configure('discord-user', '76561198000000000', 'en', 'US');
    const blocked = fixture.userConfigRepository.markDmDeliveryBlocked(
      'discord-user', 'DISCORD_NO_MUTUAL_GUILD', '2026-08-23T00:10:00.000Z')!;

    const prepared = await fixture.setupService.prepareAccountChange('discord-user', '76561198000000009', 'en', 'US');
    const result = await fixture.setupService.changeAccount(prepared);

    expect(result.config).toMatchObject({
      enabled: false,
      dmOptInAt: blocked.dmOptInAt,
      dmDeliveryBlockedAt: blocked.dmDeliveryBlockedAt,
      dmDeliveryErrorCode: 'DISCORD_NO_MUTUAL_GUILD',
    });
    fixture.database.close();
  });

  it('keeps an active account scheduled after a Steam account change', async () => {
    const fixture = services();
    new PollScheduleRepository(fixture.database).setNextScheduledAt('2026-08-23T01:00:00.000Z');
    await fixture.setupService.configure('discord-user', '76561198000000000', 'en', 'US');

    const prepared = await fixture.setupService.prepareAccountChange('discord-user', '76561198000000009', 'en', 'US');
    const result = await fixture.setupService.changeAccount(prepared);

    expect(result.config.enabled).toBe(true);
    expect(new CheckStateRepository(fixture.database).findByDiscordUserId('discord-user')?.nextScheduledAt)
      .toBe('2026-08-23T01:00:00.000Z');
    fixture.database.close();
  });

  it('refuses an account change for someone who has not set Dealio up', async () => {
    const fixture = services();
    await expect(fixture.setupService.prepareAccountChange('nobody', '76561198000000000', 'en', 'US')).rejects.toThrow();
    fixture.database.close();
  });
});
