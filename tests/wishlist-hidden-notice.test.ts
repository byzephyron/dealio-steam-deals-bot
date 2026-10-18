import { describe, expect, it, vi } from 'vitest';
import { CheckService } from '../src/application/check-service.js';
import {
  WishlistHiddenNoticeService,
  type WishlistHiddenSender,
} from '../src/application/wishlist-hidden-notice-service.js';
import type { NotificationPreference } from '../src/domain/notification-preference.js';
import { SteamWishlistError, type SteamWishlistResult } from '../src/domain/steam.js';
import { createDatabase } from '../src/persistence/database.js';
import { migrateWishlistHiddenNotice } from '../src/persistence/wishlist-hidden-schema.js';
import { CheckStateRepository } from '../src/persistence/check-state-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import { buildWishlistHiddenDm } from '../src/discord/wishlist-hidden-notice.js';
import { languages } from '../src/domain/user-config.js';

const user = 'discord-user';
const hidden = () => new SteamWishlistError('STEAM_WISHLIST_INACCESSIBLE', 'private wishlist');
const visible: SteamWishlistResult = {
  items: [{
    appId: 10, name: 'Oyun', priority: null, dateAdded: null, onSale: false,
    price: { currency: 'TRY', initialMinor: 1_000, finalMinor: 1_000, discountPercent: 0, isFree: false },
  }],
  errors: [],
};

function discordError(code: number): Error {
  return Object.assign(new Error('Discord refused'), { code });
}

function setup(options: { preference?: NotificationPreference; sender?: WishlistHiddenSender } = {}) {
  const database = createDatabase(':memory:');
  const userConfigRepository = new UserConfigRepository(database);
  const checkStateRepository = new CheckStateRepository(database);
  const wishlistStateRepository = new WishlistStateRepository(database);
  const steam = { getWishlistWithErrors: vi.fn<() => Promise<SteamWishlistResult>>() };
  const checkService = new CheckService(
    userConfigRepository, checkStateRepository, wishlistStateRepository, steam, undefined, { cooldownMs: 0 },
  );
  userConfigRepository.upsert(user, '76561198000000000', 'tr', 'TR', '2026-10-18T00:00:00.000Z');
  let nowMs = Date.parse('2026-10-18T12:00:00.000Z');
  const sender = options.sender ?? { send: vi.fn<WishlistHiddenSender['send']>().mockResolvedValue(undefined) };
  const notices = new WishlistHiddenNoticeService({
    userConfigRepository,
    checkStateRepository,
    preference: () => options.preference ?? { mode: 'instant', timezone: null, quietStart: null, quietEnd: null, digestMinute: null },
    sender,
    now: () => new Date(nowMs),
  });
  /** One automatic scan: the check, then the notice the scheduler asks for. */
  const scan = async (answer: 'hidden' | 'visible' | 'timeout') => {
    if (answer === 'hidden') steam.getWishlistWithErrors.mockRejectedValueOnce(hidden());
    else if (answer === 'timeout') steam.getWishlistWithErrors.mockRejectedValueOnce(new SteamWishlistError('STEAM_TIMEOUT', 'timed out'));
    else steam.getWishlistWithErrors.mockResolvedValueOnce(visible);
    const result = await checkService.check(user, 'automatic');
    const notice = result.status === 'unavailable' && result.errorCode === 'STEAM_WISHLIST_INACCESSIBLE'
      ? await notices.notify(user) : null;
    nowMs += 30 * 60 * 1000;
    return notice;
  };
  return {
    database, sender, notices, scan, steam, checkService, userConfigRepository, checkStateRepository,
    advance: (ms: number) => { nowMs += ms; },
  };
}

describe('hidden-wishlist DM after setup', () => {
  it('writes once, only after Steam said "private" twice in a row', async () => {
    const { scan, sender, database } = setup();
    expect(await scan('hidden')).toBe('skipped');
    expect(sender.send).not.toHaveBeenCalled();
    expect(await scan('hidden')).toBe('sent');
    expect(await scan('hidden')).toBe('skipped');
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(user, 'tr', 'tracking');
    database.close();
  });

  it('starts a new hidden period after a successful read', async () => {
    const { scan, sender, database } = setup();
    await scan('hidden');
    await scan('hidden');
    await scan('visible');
    expect(await scan('hidden')).toBe('skipped');
    expect(await scan('hidden')).toBe('sent');
    expect(sender.send).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('keeps counting through a Steam timeout in between', async () => {
    const { scan, database } = setup();
    await scan('hidden');
    await scan('timeout');
    expect(await scan('hidden')).toBe('sent');
    database.close();
  });

  it('waits out quiet hours and sends at a later scan', async () => {
    const preference: NotificationPreference = {
      mode: 'quiet', timezone: 'UTC', quietStart: 11 * 60, quietEnd: 14 * 60, digestMinute: null,
    };
    const { scan, sender, database } = setup({ preference });
    await scan('hidden'); // 12:00
    expect(await scan('hidden')).toBe('skipped'); // 12:30, quiet
    expect(await scan('hidden')).toBe('skipped'); // 13:00
    expect(await scan('hidden')).toBe('skipped'); // 13:30
    expect(await scan('hidden')).toBe('sent'); // 14:00
    expect(sender.send).toHaveBeenCalledTimes(1);
    database.close();
  });

  it('marks closed DMs as a DM block and writes no more', async () => {
    const send = vi.fn<WishlistHiddenSender['send']>().mockRejectedValue(discordError(50_278));
    const { scan, userConfigRepository, database } = setup({ sender: { send } });
    await scan('hidden');
    expect(await scan('hidden')).toBe('dm-blocked');
    const config = userConfigRepository.findByDiscordUserId(user);
    expect(config).toMatchObject({ enabled: false, dmDeliveryErrorCode: 'DISCORD_NO_MUTUAL_GUILD' });
    expect(await new WishlistHiddenNoticeService({
      userConfigRepository, checkStateRepository: new CheckStateRepository(database),
      preference: () => ({ mode: 'instant', timezone: null, quietStart: null, quietEnd: null, digestMinute: null }),
      sender: { send },
    }).notify(user)).toBe('skipped');
    expect(send).toHaveBeenCalledTimes(1);
    database.close();
  });

  it('retries a failed send after ten minutes, at most three times', async () => {
    const send = vi.fn<WishlistHiddenSender['send']>().mockRejectedValue(new Error('Discord unavailable'));
    const { scan, notices, advance, database } = setup({ sender: { send } });
    await scan('hidden');
    expect(await scan('hidden')).toBe('failed'); // the scan leaves the clock 30 minutes later
    expect(await notices.notify(user)).toBe('failed');
    expect(await notices.notify(user)).toBe('skipped'); // within ten minutes of that attempt
    advance(10 * 60 * 1000);
    expect(await notices.notify(user)).toBe('failed');
    advance(10 * 60 * 1000);
    expect(await notices.notify(user)).toBe('skipped'); // three attempts used
    expect(send).toHaveBeenCalledTimes(3);
    database.close();
  });

  it('records the attempt before Discord is called', async () => {
    let attemptSeen: unknown;
    const holder: { database?: ReturnType<typeof createDatabase> } = {};
    const send = vi.fn<WishlistHiddenSender['send']>(async () => {
      attemptSeen = holder.database!.prepare(
        'SELECT wishlist_hidden_notice_attempt_at AS at, wishlist_hidden_notice_sent_at AS sent FROM check_state WHERE discord_user_id = ?',
      ).get(user);
    });
    const services = setup({ sender: { send } });
    holder.database = services.database;
    await services.scan('hidden');
    await services.scan('hidden');
    expect(attemptSeen).toMatchObject({ at: expect.any(String), sent: null });
    services.database.close();
  });

  it('does not write to a paused user', async () => {
    const { checkService, steam, notices, sender, database } = setup();
    database.prepare('UPDATE user_config SET enabled = 0 WHERE discord_user_id = ?').run(user);
    steam.getWishlistWithErrors.mockRejectedValueOnce(hidden()).mockRejectedValueOnce(hidden());
    await checkService.check(user, 'manual');
    await checkService.check(user, 'manual');
    expect(await notices.notify(user)).toBe('skipped');
    expect(sender.send).not.toHaveBeenCalled();
    database.close();
  });
});

describe('schema v16', () => {
  it('counts a wishlist already hidden at upgrade as one hidden check', async () => {
    const { scan, database } = setup();
    await scan('hidden');
    database.exec(`ALTER TABLE check_state DROP COLUMN wishlist_hidden_checks;
      ALTER TABLE check_state DROP COLUMN wishlist_hidden_notice_attempt_at;
      ALTER TABLE check_state DROP COLUMN wishlist_hidden_notice_attempts;
      ALTER TABLE check_state DROP COLUMN wishlist_hidden_notice_sent_at;
      PRAGMA user_version = 15;`);
    migrateWishlistHiddenNotice(database);
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 });
    expect(database.prepare('SELECT wishlist_hidden_checks AS checks, wishlist_hidden_notice_attempts AS attempts FROM check_state').get())
      .toEqual({ checks: 1, attempts: 0 });
    database.close();
  });
});

describe('hidden-wishlist DM when setup stops', () => {
  it('sends at most one setup DM a day per user and ignores closed DMs', async () => {
    const send = vi.fn<WishlistHiddenSender['send']>().mockRejectedValue(discordError(50_007));
    const { notices, advance, database } = setup({ sender: { send } });
    notices.hintSetup('newcomer', 'en');
    notices.hintSetup('newcomer', 'en');
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('newcomer', 'en', 'setup');
    advance(24 * 60 * 60 * 1000);
    notices.hintSetup('newcomer', 'en');
    expect(send).toHaveBeenCalledTimes(2);
    database.close();
  });
});

describe('hidden-wishlist DM panel', () => {
  it('builds in every language with the Steam privacy link and a panel button', () => {
    for (const language of languages) {
      for (const kind of ['setup', 'tracking'] as const) {
        const json = JSON.stringify(buildWishlistHiddenDm(language, kind).toJSON());
        expect(json).toContain('https://steamcommunity.com/my/edit/settings');
        expect(json).toContain('dealio-open:home');
        expect(json).toContain('😞');
      }
    }
    expect(JSON.stringify(buildWishlistHiddenDm('tr', 'tracking').toJSON())).toContain('Steam wishlist’ini göremiyorum');
  });
});
