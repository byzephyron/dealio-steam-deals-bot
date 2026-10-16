import { describe, expect, it, vi } from 'vitest';
import { RateLimitError } from 'discord.js';
import {
  NotificationDeliveryCancelledError,
  discordRateLimitDelayMs,
  isDiscordRateLimit,
  dmUnreachableCode,
  isPermanentDiscordError,
  NotificationService,
  type NotificationSender,
} from '../src/application/notification-service.js';
import { partitionNotificationBatches } from '../src/discord/notification-sender.js';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import type { WishlistItem } from '../src/domain/steam.js';
import type { NotificationCandidate } from '../src/domain/wishlist-state.js';
import { UserConfigurationService } from '../src/application/user-configuration-service.js';
import { UserOperationCoordinator } from '../src/application/user-operation-coordinator.js';

const saleItem: WishlistItem = {
  appId: 10,
  name: 'Test Game',
  priority: null,
  dateAdded: null,
  price: {
    currency: 'TRY',
    initialMinor: 1_000,
    finalMinor: 750,
    discountPercent: 25,
    isFree: false,
  },
  onSale: true,
};

function createSender(send = vi.fn().mockResolvedValue(undefined)) {
  return {
    plan: vi.fn((notifications: readonly NotificationCandidate[]) => {
      const batches = [];
      for (let index = 0; index < notifications.length; index += 10) {
        batches.push({ notifications: notifications.slice(index, index + 10) });
      }
      return batches;
    }),
    send,
  };
}

function createService(
  language: 'tr' | 'en',
  sender: NotificationSender,
) {
  const database = createDatabase(':memory:');
  const userConfigRepository = new UserConfigRepository(database);
  const wishlistStateRepository = new WishlistStateRepository(database);
  const config = userConfigRepository.upsert(
    'discord-user',
    '76561198000000000',
    language,
    'TR',
    '2026-08-21T00:00:00.000Z',
  );
  wishlistStateRepository.recordObservation(config, {
    item: { ...saleItem, onSale: false, price: { ...saleItem.price, finalMinor: 1_000, discountPercent: 0 } },
    saleKey: null,
    observedAt: '2026-08-21T00:01:00.000Z',
  });
  const observation = wishlistStateRepository.recordObservation(config, {
    item: saleItem,
    saleKey: 'TRY:1000:750:25',
    observedAt: '2026-08-21T00:02:00.000Z',
  });

  if (!observation.notificationCandidate) {
    throw new Error('Expected a notification candidate');
  }

  return {
    database,
    config,
    candidate: observation.notificationCandidate,
    userConfigRepository,
    repository: wishlistStateRepository,
    service: new NotificationService(userConfigRepository, wishlistStateRepository, sender),
  };
}

function addCandidate(
  services: ReturnType<typeof createService>,
  appId: number,
  observedAt = '2026-08-21T00:02:00.000Z',
): NotificationCandidate {
  const regularItem: WishlistItem = {
    ...saleItem,
    appId,
    name: `Test Game ${appId}`,
    onSale: false,
    price: { ...saleItem.price, finalMinor: 1_000, discountPercent: 0 },
  };
  services.repository.recordObservation(services.config, {
    item: regularItem,
    saleKey: null,
    observedAt: '2026-08-21T00:01:00.000Z',
  });
  const result = services.repository.recordObservation(services.config, {
    item: { ...regularItem, onSale: true, price: saleItem.price },
    saleKey: 'TRY:1000:750:25',
    observedAt,
  });
  if (!result.notificationCandidate) {
    throw new Error('Expected an additional notification candidate');
  }
  return result.notificationCandidate;
}

describe('NotificationService', () => {
  it('enriches durable deliveries from snapshots without changing batch identity or prices', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    const headerImageUrl = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/hash/header.jpg';
    try {
      services.repository.assistant.saveSnapshot(services.config, {
        items: [{ ...saleItem, price: null, onSale: null, headerImageUrl }], errors: [],
      }, '2026-08-21T00:02:00.000Z');
      await expect(services.service.deliverPending('discord-user')).resolves.toMatchObject({ sentCount: 1 });
      const delivered = sender.send.mock.calls[0]![0];
      expect(delivered.batchId).toEqual(expect.any(String));
      expect(delivered.notifications[0]).toMatchObject({ ...services.candidate, headerImageUrl });
      await expect(services.service.deliverPending('discord-user')).resolves.toMatchObject({ sentCount: 0 });
      expect(sender.send).toHaveBeenCalledOnce();
    } finally { services.database.close(); }
  });

  it('plans a long queue in small windows yet sends the same DMs as one full partition', async () => {
    // Uneven game sizes, so DMs close before ten games and windows split mid-DM.
    const weight = (appId: number) => appId % 4 + 1;
    const fits = (batch: readonly NotificationCandidate[]) =>
      batch.reduce((total, item) => total + weight(item.appId), 0) <= 13;
    const send = vi.fn().mockResolvedValue(undefined);
    const sender = {
      plan: vi.fn((notifications: readonly NotificationCandidate[]) => partitionNotificationBatches(notifications, fits)),
      send,
    };
    const services = createService('en', sender);
    try {
      const candidates = [services.candidate];
      for (let appId = 11; appId <= 57; appId += 1) candidates.push(addCandidate(services, appId));

      await expect(services.service.deliverPending('discord-user')).resolves.toMatchObject({ sentCount: 48, failedCount: 0 });

      const sent = send.mock.calls.map(([batch]) => batch.notifications.map((item: NotificationCandidate) => item.appId));
      expect(sent).toEqual(partitionNotificationBatches(candidates, fits)
        .map((batch) => batch.notifications.map((item) => item.appId)));
      expect(Math.max(...sender.plan.mock.calls.map(([notifications]) => notifications.length))).toBeLessThanOrEqual(30);
    } finally { services.database.close(); }
  });

  it('does not lose a queued sale when optional artwork metadata cannot be read', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    vi.spyOn(services.repository.assistant, 'snapshot').mockImplementation(() => { throw new Error('bad snapshot'); });
    try {
      await expect(services.service.deliverPending('discord-user')).resolves.toMatchObject({ sentCount: 1 });
      expect(sender.send.mock.calls[0]![0].notifications[0]).toMatchObject(services.candidate);
    } finally { services.database.close(); }
  });

  it('records accepted candidate-to-DM latency without user or game identifiers', async () => {
    const sender = createSender(vi.fn());
    const services = createService('en', sender);
    const deliveredAt = new Date(Date.parse(services.candidate.createdAt) + 60_000).toISOString();
    (sender.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      messageId: 'private-message-id', channelId: 'private-channel-id', deliveredAt,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(services.service.deliverPending('discord-user'))
        .resolves.toMatchObject({ sentCount: 1 });
      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain('candidateToDeliveryMs=60000');
      expect(output).not.toContain('discord-user');
      expect(output).not.toContain('Test Game');
      expect(output).not.toContain('private-message-id');
    } finally {
      log.mockRestore();
      services.database.close();
    }
  });

  it('labels a delivery after quiet hours separately from immediate delivery', async () => {
    const sender = createSender(vi.fn());
    const services = createService('en', sender);
    services.repository.assistant.savePreference('discord-user', {
      mode: 'quiet', timezone: 'UTC', quietStart: 0, quietEnd: 60, digestMinute: null,
    });
    (sender.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      messageId: 'private-message-id', channelId: 'private-channel-id',
      deliveredAt: '2026-08-21T12:00:00.000Z',
    });
    const service = new NotificationService(
      services.userConfigRepository, services.repository, sender,
      { now: () => new Date('2026-08-21T12:00:00.000Z') },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(service.deliverPending('discord-user'))
        .resolves.toMatchObject({ sentCount: 1 });
      expect(JSON.stringify(log.mock.calls)).toContain('mode=quiet');
    } finally {
      log.mockRestore();
      services.database.close();
    }
  });

  it('does not disable tracking or blame DM privacy for an invalid message payload', async () => {
    const sender = createSender(vi.fn().mockRejectedValue(Object.assign(
      new Error('Invalid Form Body'), { code: 50035, status: 400 },
    )));
    const services = createService('en', sender);
    try {
      await expect(services.service.deliverPending('discord-user'))
        .resolves.toMatchObject({ sentCount: 0, failedCount: 1 });
      expect(services.userConfigRepository.findByDiscordUserId('discord-user'))
        .toMatchObject({ enabled: true, dmDeliveryBlockedAt: null });
      await services.service.deliverPending('discord-user');
      expect(sender.send).toHaveBeenCalledOnce();
    } finally {
      services.database.close();
    }
  });

  it('sends a candidate and marks it sent', async () => {
    const sender = createSender();
    const services = createService('tr', sender);

    const result = await services.service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 1, sentCount: 1, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledWith({
      notifications: [expect.objectContaining({ appId: 10 })],
      batchId: expect.any(String),
      language: 'tr',
      attemptCount: 0,
    }, 'tr');
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sent');
    services.database.close();
  });

  it('does not send the same sale key twice', async () => {
    const sender = createSender();
    const services = createService('en', sender);

    await services.service.deliverPending('discord-user');
    const secondResult = await services.service.deliverPending('discord-user');

    expect(secondResult).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledTimes(1);
    services.database.close();
  });

  it.each(['unknown', 'error'] as const)(
    'suspends a pending sale while its latest observation is %s and resumes when known',
    async (observationStatus) => {
      const sender = createSender();
      const services = createService('en', sender);
      services.repository.markObservationStatus(
        services.config,
        [services.candidate.appId],
        observationStatus,
        '2026-08-21T00:06:00.000Z',
      );

      await expect(services.service.deliverPending('discord-user')).resolves.toEqual({
        candidateCount: 0,
        sentCount: 0,
        failedCount: 0,
      });
      expect(sender.send).not.toHaveBeenCalled();
      expect(services.repository.findNotificationStatus(services.candidate)).toBe('candidate');

      const repeated = services.repository.recordObservation(services.config, {
        item: {
          ...saleItem,
          price: {
            ...saleItem.price!,
            currency: 'EUR',
            initialMinor: 2_000,
            finalMinor: 800,
            discountPercent: 60,
          },
        },
        saleKey: 'EUR:2000:800:60',
        observedAt: '2026-08-21T00:07:00.000Z',
      });
      expect(repeated.notificationCandidate).toBeNull();
      await expect(services.service.deliverPending('discord-user')).resolves.toMatchObject({
        candidateCount: 1,
        sentCount: 1,
      });
      expect(sender.send).toHaveBeenCalledOnce();
      expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({
        notifications: [expect.objectContaining({
          currency: 'EUR',
          normalPriceMinor: 2_000,
          finalPriceMinor: 800,
          discountPercent: 60,
        })],
      }), 'en');
      services.database.close();
    },
  );

  it('retires a waiting alert whose sale no longer meets the rule', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    services.database.prepare(
      'UPDATE user_config SET minimum_discount_percent = 70 WHERE discord_user_id = ?',
    ).run('discord-user');
    const repeated = services.repository.recordObservation(services.config, {
      item: {
        ...saleItem,
        price: { ...saleItem.price!, currency: 'EUR', initialMinor: 2_000, finalMinor: 800, discountPercent: 60 },
      },
      saleKey: 'EUR:2000:800:60',
      observedAt: '2026-08-21T00:07:00.000Z',
    });

    expect(repeated.notificationCandidate).toBeNull();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    await expect(services.service.deliverPending('discord-user')).resolves.toMatchObject({ sentCount: 0 });
    expect(sender.send).not.toHaveBeenCalled();
    services.database.close();
  });

  it('expires a pending sale when a successful snapshot confirms it is missing', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    services.repository.markMissingItemsInactive(
      services.config,
      [],
      '2026-08-21T00:06:00.000Z',
    );
    services.repository.markMissingItemsInactive(
      services.config,
      [],
      '2026-08-21T00:36:00.000Z',
    );

    await expect(services.service.deliverPending('discord-user')).resolves.toEqual({
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
    });
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    expect(sender.send).not.toHaveBeenCalled();
    services.database.close();
  });

  it('expires a suspended notification after a confirmed not-on-sale observation', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    services.repository.markObservationStatus(
      services.config,
      [services.candidate.appId],
      'unknown',
      '2026-08-21T00:06:00.000Z',
    );
    services.repository.recordObservation(services.config, {
      item: {
        ...saleItem,
        onSale: false,
        price: { ...saleItem.price!, finalMinor: 1_000, discountPercent: 0 },
      },
      saleKey: null,
      observedAt: '2026-08-21T00:07:00.000Z',
    });

    await expect(services.service.deliverPending('discord-user')).resolves.toEqual({
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    services.database.close();
  });

  it('retires a candidate whose sale ended and restarted as a different episode', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    services.database.prepare(
      'UPDATE user_config SET minimum_discount_percent = 100 WHERE discord_user_id = ?',
    ).run('discord-user');
    services.repository.recordObservation(services.config, {
      item: {
        ...saleItem,
        onSale: false,
        price: { ...saleItem.price!, finalMinor: 1_000, discountPercent: 0 },
      },
      saleKey: null,
      observedAt: '2026-08-21T00:06:00.000Z',
    });
    const nextEpisode = services.repository.recordObservation(services.config, {
      item: saleItem,
      saleKey: 'TRY:1000:750:25',
      observedAt: '2026-08-21T00:07:00.000Z',
    });
    expect(nextEpisode.notificationCandidate).toBeNull();
    expect(services.repository.findByDiscordUserAndAppId('discord-user', saleItem.appId))
      .toMatchObject({ onSale: true, observationStatus: 'known' });

    await expect(services.service.deliverPending('discord-user')).resolves.toEqual({
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    services.database.close();
  });

  it('retires a failed batch whose sale ended and restarted as a different episode', async () => {
    const sender = createSender(
      vi.fn()
        .mockRejectedValueOnce(new Error('temporary Discord failure'))
        .mockResolvedValueOnce(undefined),
    );
    const services = createService('en', sender);
    let now = new Date('2026-08-21T00:10:00.000Z');
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      { now: () => now, retryBaseDelayMs: 60_000 },
    );
    await expect(service.deliverPending('discord-user')).resolves.toMatchObject({
      candidateCount: 1,
      failedCount: 1,
    });
    services.database.prepare(
      'UPDATE user_config SET minimum_discount_percent = 100 WHERE discord_user_id = ?',
    ).run('discord-user');
    services.repository.recordObservation(services.config, {
      item: {
        ...saleItem,
        onSale: false,
        price: { ...saleItem.price!, finalMinor: 1_000, discountPercent: 0 },
      },
      saleKey: null,
      observedAt: '2026-08-21T00:10:30.000Z',
    });
    services.repository.recordObservation(services.config, {
      item: saleItem,
      saleKey: 'TRY:1000:750:25',
      observedAt: '2026-08-21T00:10:40.000Z',
    });
    now = new Date('2026-08-21T00:11:00.000Z');

    await expect(service.deliverPending('discord-user')).resolves.toEqual({
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
    });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    expect(services.database.prepare('SELECT status FROM notification_batch').get())
      .toEqual({ status: 'expired' });
    services.database.close();
  });

  it('sends multiple games in one durable batch and atomically marks every item sent', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    const secondCandidate = addCandidate(services, 20);

    const result = await services.service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 2, sentCount: 2, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send.mock.calls[0]?.[0].notifications.map(
      (notification: NotificationCandidate) => notification.appId,
    )).toEqual([10, 20]);
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sent');
    expect(services.repository.findNotificationStatus(secondCandidate)).toBe('sent');
    expect(services.database.prepare(
      'SELECT status, member_count FROM notification_batch',
    ).all()).toEqual([{ status: 'sent', member_count: 2 }]);
    expect(services.database.prepare(
      'SELECT status, attempt_count FROM notification_log ORDER BY app_id',
    ).all()).toEqual([
      { status: 'sent', attempt_count: 0 },
      { status: 'sent', attempt_count: 0 },
    ]);
    services.database.close();
  });

  it('rolls back the entire claim when one batch member cannot be persisted', () => {
    const sender = createSender();
    const services = createService('en', sender);
    const secondCandidate = addCandidate(services, 20);
    services.database.exec(`
      CREATE TRIGGER fail_second_batch_item
      BEFORE INSERT ON notification_batch_item
      WHEN NEW.position = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected batch item failure');
      END;
    `);

    expect(() => services.repository.createAndClaimNotificationBatch(
      services.config,
      'en',
      [services.candidate, secondCandidate],
      '2026-08-21T00:05:00.000Z',
    )).toThrow('injected batch item failure');
    expect(services.database.prepare('SELECT COUNT(*) AS count FROM notification_batch').get())
      .toEqual({ count: 0 });
    expect(services.database.prepare(
      'SELECT COUNT(*) AS count FROM notification_batch_item',
    ).get()).toEqual({ count: 0 });
    expect(services.database.prepare(
      'SELECT status FROM notification_log ORDER BY app_id',
    ).all()).toEqual([{ status: 'candidate' }, { status: 'candidate' }]);
    services.database.close();
  });

  it('rolls back all sent updates when the batch parent cannot be updated', () => {
    const sender = createSender();
    const services = createService('en', sender);
    const secondCandidate = addCandidate(services, 20);
    const batch = services.repository.createAndClaimNotificationBatch(
      services.config,
      'en',
      [services.candidate, secondCandidate],
      '2026-08-21T00:05:00.000Z',
    );
    if (!batch) {
      throw new Error('Expected a claimed notification batch');
    }
    services.database.exec(`
      CREATE TRIGGER fail_batch_sent_update
      BEFORE UPDATE OF status ON notification_batch
      WHEN NEW.status = 'sent'
      BEGIN
        SELECT RAISE(ABORT, 'injected sent outcome failure');
      END;
    `);

    expect(() => services.repository.markNotificationBatchSent(batch))
      .toThrow('injected sent outcome failure');
    expect(services.database.prepare(
      'SELECT status FROM notification_log ORDER BY app_id',
    ).all()).toEqual([{ status: 'sending' }, { status: 'sending' }]);
    expect(services.database.prepare('SELECT status FROM notification_batch').get())
      .toEqual({ status: 'sending' });
    services.database.exec('DROP TRIGGER fail_batch_sent_update');

    expect(services.repository.recoverStaleSending(
      services.config,
      '2026-08-21T00:10:00.000Z',
    )).toBe(2);
    expect(services.database.prepare(
      'SELECT status FROM notification_log ORDER BY app_id',
    ).all()).toEqual([{ status: 'failed' }, { status: 'failed' }]);
    expect(services.database.prepare('SELECT status FROM notification_batch').get())
      .toEqual({ status: 'failed' });
    services.database.close();
  });

  it('creates deterministic 10+1 durable batches for eleven games', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    for (let appId = 11; appId <= 20; appId += 1) {
      addCandidate(services, appId);
    }

    const result = await services.service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 11, sentCount: 11, failedCount: 0 });
    expect(sender.send.mock.calls.map((call) => call[0].notifications.length)).toEqual([10, 1]);
    expect(sender.send.mock.calls.flatMap((call) => call[0].notifications).map(
      (notification: NotificationCandidate) => notification.appId,
    )).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(services.database.prepare(
      `SELECT status, member_count FROM notification_batch
       ORDER BY first_created_at, first_app_id, first_sale_episode_id`,
    ).all()).toEqual([
      { status: 'sent', member_count: 10 },
      { status: 'sent', member_count: 1 },
    ]);
    services.database.close();
  });

  it('marks failed DMs failed and retries them later', async () => {
    const sender = createSender(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('DM disabled'))
        .mockResolvedValueOnce(undefined),
    );
    const services = createService('en', sender);
    const secondCandidate = addCandidate(services, 20);
    let now = new Date('2026-08-21T00:10:00.000Z');
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      {
        now: () => now,
        retryBaseDelayMs: 60_000,
      },
    );

    const firstResult = await service.deliverPending('discord-user');
    const earlyResult = await service.deliverPending('discord-user');
    now = new Date('2026-08-21T00:11:00.000Z');
    const secondResult = await service.deliverPending('discord-user');

    expect(firstResult).toMatchObject({ candidateCount: 2, sentCount: 0, failedCount: 2 });
    expect(earlyResult).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(secondResult).toMatchObject({ candidateCount: 2, sentCount: 2, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send.mock.calls[1]?.[0].batchId).toBe(sender.send.mock.calls[0]?.[0].batchId);
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sent');
    expect(services.repository.findNotificationStatus(secondCandidate)).toBe('sent');
    expect(services.database.prepare(
      'SELECT attempt_count FROM notification_log ORDER BY app_id',
    ).all()).toEqual([{ attempt_count: 1 }, { attempt_count: 1 }]);
    services.database.close();
  });

  it('marks permanent Discord DM failures terminal without retrying', async () => {
    const permanentError = Object.assign(new Error('Cannot send messages to this user'), {
      code: 50_007,
      status: 403,
    });
    const sender = createSender(vi.fn().mockRejectedValue(permanentError));
    const services = createService('en', sender);

    await services.service.deliverPending('discord-user');
    const secondResult = await services.service.deliverPending('discord-user');

    expect(services.repository.findNotificationStatus(services.candidate)).toBe('terminal_failed');
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')).toMatchObject({
      enabled: false,
      dmDeliveryErrorCode: 'DISCORD_DM_BLOCKED',
    });
    expect(secondResult).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledOnce();
    services.database.close();
  });

  it('treats "no mutual guilds" (50278) as unreachable DMs, with its own remedy code', async () => {
    const noMutualGuild = Object.assign(
      new Error('Cannot send messages to this user due to having no mutual guilds'),
      { code: 50_278, status: 403 },
    );
    const sender = createSender(vi.fn().mockRejectedValue(noMutualGuild));
    const services = createService('en', sender);
    // Twelve alerts make two DMs; the second must not be tried once Discord refused the first.
    for (let appId = 11; appId <= 21; appId += 1) addCandidate(services, appId);

    const firstResult = await services.service.deliverPending('discord-user');
    const secondResult = await services.service.deliverPending('discord-user');

    expect(firstResult).toMatchObject({ sentCount: 0, failedCount: 10 });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('terminal_failed');
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')).toMatchObject({
      enabled: false,
      dmDeliveryBlockedAt: expect.any(String),
      dmDeliveryErrorCode: 'DISCORD_NO_MUTUAL_GUILD',
    });
    expect(services.database.prepare(
      "SELECT COUNT(*) AS count FROM notification_log WHERE last_error = 'DISCORD_NO_MUTUAL_GUILD'",
    ).get()).toEqual({ count: 10 });
    expect(secondResult).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    services.database.close();
  });

  it('names the reason Discord refused a DM, and nothing else', () => {
    expect(dmUnreachableCode({ code: 50_007, status: 403 })).toBe('DISCORD_DM_BLOCKED');
    expect(dmUnreachableCode({ code: 50_278, status: 403 })).toBe('DISCORD_NO_MUTUAL_GUILD');
    expect(dmUnreachableCode({ code: 50_035, status: 400 })).toBeNull();
    expect(dmUnreachableCode(new Error('network'))).toBeNull();
    expect(isPermanentDiscordError({ code: 50_278 })).toBe(true);
  });

  it('stops transient DM retries after the maximum attempt count', async () => {
    const sender = createSender(vi.fn().mockRejectedValue(new Error('temporary network failure')));
    const services = createService('en', sender);
    let now = new Date('2026-08-21T00:10:00.000Z');
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      {
        now: () => now,
        maxAttempts: 2,
        retryBaseDelayMs: 1_000,
      },
    );

    await service.deliverPending('discord-user');
    now = new Date('2026-08-21T00:10:01.000Z');
    await service.deliverPending('discord-user');
    const finalResult = await service.deliverPending('discord-user');

    expect(services.repository.findNotificationStatus(services.candidate)).toBe('terminal_failed');
    expect(finalResult).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledTimes(2);
    services.database.close();
  });

  it('waits out Discord rate limits without using up delivery attempts', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), { name: 'RateLimitError', retryAfter: 30_000 });
    const send = vi.fn()
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValue(undefined);
    const sender = createSender(send);
    const services = createService('en', sender);
    let now = new Date('2026-08-21T00:10:00.000Z');
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      { now: () => now, maxAttempts: 2, retryBaseDelayMs: 1_000 },
    );
    const attempts = () => services.database.prepare(
      'SELECT attempt_count, next_attempt_at, last_error FROM notification_log',
    ).get();

    for (let round = 0; round < 3; round += 1) {
      await service.deliverPending('discord-user');
      expect(attempts()).toEqual({
        attempt_count: 0,
        next_attempt_at: new Date(now.getTime() + 30_000).toISOString(),
        last_error: 'DISCORD_RATE_LIMITED',
      });
      // Not due yet: nothing is sent before Discord's wait is over.
      await service.deliverPending('discord-user');
      expect(send).toHaveBeenCalledTimes(round + 1);
      now = new Date(now.getTime() + 30_000);
    }

    await expect(service.deliverPending('discord-user')).resolves.toMatchObject({ sentCount: 1 });
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sent');
    services.database.close();
  });

  it('reads the wait Discord asks for and keeps it within sensible bounds', () => {
    expect(discordRateLimitDelayMs({ name: 'RateLimitError', retryAfter: 12_000 })).toBe(12_000);
    expect(discordRateLimitDelayMs({ name: 'RateLimitError', timeToReset: 100 })).toBe(5_000);
    expect(discordRateLimitDelayMs({ status: 429 })).toBe(5_000);
    expect(discordRateLimitDelayMs({ name: 'RateLimitError', retryAfter: 3_600_000 })).toBe(900_000);
    expect(discordRateLimitDelayMs(new Error('network'))).toBeNull();
    expect(discordRateLimitDelayMs({ status: 403, code: 50_007 })).toBeNull();
  });

  it('recognizes the RateLimitError discord.js really throws, named after its route', () => {
    const error = new RateLimitError({
      timeToReset: 32_000, limit: 5, method: 'POST', hash: 'Global(POST:/channels/:id/messages)',
      url: 'https://discord.com/api/v10/channels/1/messages', route: '/channels/:id/messages',
      majorParameter: '1', global: false, retryAfter: 33_000, sublimitTimeout: 0, scope: 'user',
    });
    expect(error.name).toBe('RateLimitError[/channels/:id/messages]');
    expect(isDiscordRateLimit(error)).toBe(true);
    expect(discordRateLimitDelayMs(error)).toBe(33_000);
    expect(isDiscordRateLimit(Object.assign(new Error('x'), { name: 'DiscordAPIError[50007]' }))).toBe(false);
  });

  it('claims a candidate so concurrent delivery cannot send two DMs', async () => {
    let resolveSend: (() => void) | undefined;
    const sender = createSender(
      vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
      ),
    );
    const services = createService('tr', sender);

    const firstDelivery = services.service.deliverPending('discord-user');
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce());
    const secondDelivery = services.service.deliverPending('discord-user');
    await Promise.resolve();
    expect(sender.send).toHaveBeenCalledTimes(1);
    resolveSend?.();
    const firstResult = await firstDelivery;
    const secondResult = await secondDelivery;

    expect(secondResult).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(firstResult).toEqual({ candidateCount: 1, sentCount: 1, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledTimes(1);
    services.database.close();
  });

  it('does not claim candidates after application shutdown starts', async () => {
    const lifecycle = new AbortController();
    const sender = createSender();
    const services = createService('en', sender);
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      { lifecycleSignal: lifecycle.signal },
    );
    lifecycle.abort();

    await expect(service.deliverPending('discord-user')).resolves.toEqual({
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('candidate');
    services.database.close();
  });

  it('leaves an uncertain in-flight delivery sending when shutdown cancels it', async () => {
    const lifecycle = new AbortController();
    let rejectSend: ((error: Error) => void) | undefined;
    const sender = createSender(
      vi.fn()
        .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }))
        .mockResolvedValueOnce(undefined),
    );
    const services = createService('en', sender);
    const secondCandidate = addCandidate(services, 20);
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      {
        lifecycleSignal: lifecycle.signal,
        now: () => new Date('2026-08-21T00:05:00.000Z'),
      },
    );
    const delivery = service.deliverPending('discord-user');
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce());
    lifecycle.abort();
    rejectSend?.(new NotificationDeliveryCancelledError('shutdown'));

    await expect(delivery).resolves.toMatchObject({ sentCount: 0, failedCount: 0 });
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sending');
    expect(services.repository.findNotificationStatus(secondCandidate)).toBe('sending');
    expect(services.database.prepare('SELECT status FROM notification_batch').get())
      .toEqual({ status: 'sending' });

    const retryService = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      {
        sendingTimeoutMs: 10 * 60 * 1000,
        now: () => new Date('2026-08-21T00:20:00.000Z'),
      },
    );
    await expect(retryService.deliverPending('discord-user')).resolves.toEqual({
      candidateCount: 2,
      sentCount: 2,
      failedCount: 0,
    });
    expect(sender.send.mock.calls[1]?.[0].batchId).toBe(sender.send.mock.calls[0]?.[0].batchId);
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sent');
    expect(services.repository.findNotificationStatus(secondCandidate)).toBe('sent');
    services.database.close();
  });

  it('does not add newly discovered sales to an existing retry batch', async () => {
    const sender = createSender(
      vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(undefined),
    );
    const services = createService('en', sender);
    addCandidate(services, 20);
    let now = new Date('2026-08-21T00:10:00.000Z');
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      { now: () => now, retryBaseDelayMs: 60_000 },
    );

    await service.deliverPending('discord-user');
    const originalBatchId = sender.send.mock.calls[0]?.[0].batchId;
    addCandidate(services, 30, '2026-08-21T00:10:30.000Z');
    now = new Date('2026-08-21T00:11:00.000Z');

    const result = await service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 3, sentCount: 3, failedCount: 0 });
    expect(sender.send.mock.calls[1]?.[0]).toMatchObject({
      batchId: originalBatchId,
      notifications: [expect.objectContaining({ appId: 10 }), expect.objectContaining({ appId: 20 })],
    });
    expect(sender.send.mock.calls[2]?.[0]).toMatchObject({
      batchId: expect.not.stringMatching(originalBatchId),
      notifications: [expect.objectContaining({ appId: 30 })],
    });
    services.database.close();
  });

  it('retires an invalid retry batch and preserves active members for a new batch', async () => {
    const sender = createSender(
      vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(undefined),
    );
    const services = createService('en', sender);
    const secondCandidate = addCandidate(services, 20);
    let now = new Date('2026-08-21T00:10:00.000Z');
    const service = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      { now: () => now, retryBaseDelayMs: 60_000 },
    );
    await service.deliverPending('discord-user');
    const originalBatchId = sender.send.mock.calls[0]?.[0].batchId;
    services.repository.recordObservation(services.config, {
      item: {
        ...saleItem,
        onSale: false,
        price: { ...saleItem.price, finalMinor: 1_000, discountPercent: 0 },
      },
      saleKey: null,
      observedAt: '2026-08-21T00:10:30.000Z',
    });
    now = new Date('2026-08-21T00:11:00.000Z');

    const result = await service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 1, sentCount: 1, failedCount: 0 });
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    expect(services.repository.findNotificationStatus(secondCandidate)).toBe('sent');
    expect(sender.send.mock.calls[1]?.[0].batchId).not.toBe(originalBatchId);
    expect(sender.send.mock.calls[1]?.[0].notifications).toEqual([
      expect.objectContaining({ appId: 20 }),
    ]);
    expect(services.database.prepare(
      'SELECT status FROM notification_batch ORDER BY created_at, batch_id',
    ).all()).toEqual([{ status: 'expired' }, { status: 'sent' }]);
    services.database.close();
  });

  it('recovers and retries a stale sending candidate after a process interruption', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    const claimedBatch = services.repository.createAndClaimNotificationBatch(
      services.config,
      'en',
      [services.candidate],
      '2026-08-21T00:05:00.000Z',
    );
    expect(claimedBatch).not.toBeNull();
    const service = new NotificationService(
      new UserConfigRepository(services.database),
      services.repository,
      sender,
      {
        sendingTimeoutMs: 10 * 60 * 1000,
        maxAttempts: 1,
        now: () => new Date('2026-08-21T00:20:00.000Z'),
      },
    );

    const result = await service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 1, sentCount: 1, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sent');
    services.database.close();
  });

  it('does not alter a fresh sending candidate when its observation becomes unknown', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    const claimedBatch = services.repository.createAndClaimNotificationBatch(
      services.config,
      'en',
      [services.candidate],
      '2026-08-21T00:15:00.000Z',
    );
    expect(claimedBatch).not.toBeNull();
    services.repository.markObservationStatus(
      services.config,
      [services.candidate.appId],
      'unknown',
      '2026-08-21T00:16:00.000Z',
    );
    const service = new NotificationService(
      new UserConfigRepository(services.database),
      services.repository,
      sender,
      {
        sendingTimeoutMs: 10 * 60 * 1000,
        now: () => new Date('2026-08-21T00:20:00.000Z'),
      },
    );

    const result = await service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(sender.send).not.toHaveBeenCalled();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sending');
    services.database.close();
  });

  it('expires a pending notification when its sale episode has ended', async () => {
    const sender = createSender();
    const services = createService('tr', sender);
    services.repository.recordObservation(services.config, {
      item: {
        ...saleItem,
        onSale: false,
        price: { ...saleItem.price, finalMinor: 1_000, discountPercent: 0 },
      },
      saleKey: null,
      observedAt: '2026-08-21T00:03:00.000Z',
    });

    const result = await services.service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(sender.send).not.toHaveBeenCalled();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    services.database.close();
  });

  it('does not retry a failed notification after its sale episode ends', async () => {
    const sender = createSender(vi.fn().mockRejectedValue(new Error('DM blocked')));
    const services = createService('tr', sender);
    await services.service.deliverPending('discord-user');
    services.repository.recordObservation(services.config, {
      item: {
        ...saleItem,
        onSale: false,
        price: { ...saleItem.price, finalMinor: 1_000, discountPercent: 0 },
      },
      saleKey: null,
      observedAt: '2026-08-21T00:03:00.000Z',
    });

    const result = await services.service.deliverPending('discord-user');

    expect(result).toEqual({ candidateCount: 0, sentCount: 0, failedCount: 0 });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    services.database.close();
  });

  it('does not switch Steam accounts while an old-account DM is being delivered', async () => {
    let resolveSend: (() => void) | undefined;
    const sender = createSender(
      vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
      ),
    );
    const services = createService('en', sender);
    const coordinator = new UserOperationCoordinator();
    const notificationService = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      { coordinator },
    );
    const configurationService = new UserConfigurationService(
      services.userConfigRepository,
      { resolve: vi.fn(async (value: string) => value) },
      { validateWishlistAccess: vi.fn().mockResolvedValue(undefined) },
      coordinator,
    );
    const delivery = notificationService.deliverPending('discord-user');
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce());
    let accountChanged = false;
    const configuration = configurationService
      .configure('discord-user', '76561198000000001', 'en')
      .then((config) => {
        accountChanged = true;
        return config;
      });
    await Promise.resolve();

    expect(accountChanged).toBe(false);
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')?.configVersion).toBe(1);

    resolveSend?.();
    await delivery;
    const changedConfig = await configuration;
    expect(changedConfig).toMatchObject({
      steamId64: '76561198000000001',
      configVersion: 2,
    });
    services.database.close();
  });

  it('preserves pending notifications while disabled and sends them after re-enable', async () => {
    const sender = createSender();
    const services = createService('en', sender);
    services.userConfigRepository.setEnabled(
      'discord-user',
      false,
      '2026-08-21T01:00:00.000Z',
    );

    await expect(services.service.deliverPending('discord-user')).resolves.toEqual({
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('candidate');
    expect(services.database.prepare(
      'SELECT COUNT(*) AS count FROM notification_batch',
    ).get()).toEqual({ count: 0 });

    services.userConfigRepository.setEnabled(
      'discord-user',
      true,
      '2026-08-21T02:00:00.000Z',
    );
    await expect(services.service.deliverPending('discord-user')).resolves.toMatchObject({
      candidateCount: 1,
      sentCount: 1,
    });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(services.repository.findNotificationStatus(services.candidate)).toBe('sent');
    services.database.close();
  });

  it('serializes disabling with an already active DM delivery', async () => {
    let resolveSend: (() => void) | undefined;
    const sender = createSender(vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    ));
    const services = createService('en', sender);
    const coordinator = new UserOperationCoordinator();
    const notificationService = new NotificationService(
      services.userConfigRepository,
      services.repository,
      sender,
      { coordinator },
    );
    const configurationService = new UserConfigurationService(
      services.userConfigRepository,
      { resolve: vi.fn(async (value: string) => value) },
      { validateWishlistAccess: vi.fn().mockResolvedValue(undefined) },
      coordinator,
    );
    const delivery = notificationService.deliverPending('discord-user');
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce());
    let disabled = false;
    const disabling = configurationService.setEnabled('discord-user', false).then((config) => {
      disabled = true;
      return config;
    });
    await Promise.resolve();

    expect(disabled).toBe(false);
    expect(services.userConfigRepository.findByDiscordUserId('discord-user')?.enabled).toBe(true);
    resolveSend?.();
    await delivery;
    await expect(disabling).resolves.toMatchObject({ enabled: false });
    services.database.close();
  });

  it('expires retryable batches and notifications from an earlier account generation', async () => {
    const sender = createSender(vi.fn().mockRejectedValue(new Error('temporary failure')));
    const services = createService('en', sender);
    await services.service.deliverPending('discord-user');

    services.userConfigRepository.upsert(
      'discord-user',
      '76561198000000001',
      'en',
      'TR',
      '2026-08-21T01:00:00.000Z',
    );

    expect(services.repository.findNotificationStatus(services.candidate)).toBe('expired');
    expect(services.database.prepare('SELECT status FROM notification_batch').get())
      .toEqual({ status: 'expired' });
    services.database.close();
  });
});
