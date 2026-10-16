import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  BroadcastService, InvalidAnnouncementError, normalizeAudience, normalizeContent, type AnnouncementSender,
} from '../src/application/admin/broadcast-service.js';
import { announcementText, buildAnnouncementPanel } from '../src/discord/announcement-sender.js';
import { AdminControlRepository } from '../src/persistence/admin-control-repository.js';
import { AdminRepository } from '../src/persistence/admin-repository.js';
import { BroadcastRepository } from '../src/persistence/broadcast-repository.js';
import { createDatabase } from '../src/persistence/database.js';
import { seedUser } from './helpers/admin-seed.js';

const content = { tr: { title: 'Merhaba', body: 'Yeni özellik' }, en: { title: 'Hello', body: 'New feature' } };

describe('announcement content', () => {
  it('requires a title and a message and enforces Discord-safe lengths', () => {
    expect(normalizeContent({ tr: { title: ' A ', body: ' B ' }, de: { title: '', body: '' }, xx: { title: 'x', body: 'y' } }))
      .toEqual({ tr: { title: 'A', body: 'B' } });
    expect(() => normalizeContent({ tr: { title: 'A', body: '' } })).toThrow(InvalidAnnouncementError);
    expect(() => normalizeContent({})).toThrow('at least one language');
    expect(() => normalizeContent({ en: { title: 'A', body: 'x'.repeat(1801) } })).toThrow('too long');
  });

  it('keeps only valid audience filters', () => {
    expect(normalizeAudience({ userIds: ['123456789012345678', 'bad'], countries: ['TR', 'tr'], languages: ['de', 'xx'], onlyEnabled: true }))
      .toEqual({ userIds: ['123456789012345678'], countries: ['TR'], languages: ['de'], onlyEnabled: true });
    expect(normalizeAudience(null)).toEqual({});
  });

  it('falls back to English, then to any written language', () => {
    expect(announcementText(content, 'de')?.text.title).toBe('Hello');
    expect(announcementText({ fr: { title: 'Salut', body: 'x' } }, 'tr')?.language).toBe('fr');
    expect(JSON.stringify(buildAnnouncementPanel('tr', content.tr).toJSON())).toContain('Dealio’dan bir duyuru');
  });
});

describe('BroadcastService', () => {
  let database: DatabaseSync;
  let repository: BroadcastRepository;
  let controls: AdminControlRepository;
  let now: number;
  let sends: Array<{ user: string; status: string | undefined }>;
  let failWith: unknown;
  const dmBlocked: string[] = [];

  function service(): BroadcastService {
    const adminRepository = new AdminRepository(database);
    const sender: AnnouncementSender = {
      send: async (discordUserId) => {
        // The recipient is already persisted and claimed when Discord is called.
        const row = database.prepare('SELECT status FROM broadcast_recipient WHERE discord_user_id = ?')
          .get(discordUserId) as { status: string } | undefined;
        sends.push({ user: discordUserId, status: row?.status });
        if (failWith) throw failWith;
        return { messageId: '555' };
      },
    };
    return new BroadcastService({
      repository,
      users: () => adminRepository.users(),
      isBlocked: (id) => controls.isUserBlocked(id),
      sender,
      onDmBlocked: (id, code) => dmBlocked.push(`${id}:${code}`),
      now: () => new Date(now),
      logger: { log: () => undefined, error: () => undefined },
    });
  }

  beforeEach(() => {
    database = createDatabase(':memory:');
    repository = new BroadcastRepository(database);
    controls = new AdminControlRepository(database);
    now = Date.parse('2026-10-06T10:00:00.000Z');
    sends = [];
    failWith = undefined;
    dmBlocked.length = 0;
    seedUser(database, { id: '100000000000000001', language: 'tr', country: 'TR' });
    seedUser(database, { id: '100000000000000002', language: 'de', country: 'DE', enabled: false });
    seedUser(database, { id: '100000000000000003', blocked: true });
    seedUser(database, { id: '100000000000000004', language: 'en', country: 'US' });
    controls.blockUser('100000000000000004', 'spam', new Date(now).toISOString());
  });
  afterEach(() => database.close());

  it('only reaches users who can receive DMs, filtered by the audience', () => {
    const broadcasts = service();
    expect(broadcasts.recipients({}).map((user) => user.discordUserId)).toEqual(['100000000000000001', '100000000000000002']);
    expect(broadcasts.recipients({ onlyEnabled: true }).map((user) => user.discordUserId)).toEqual(['100000000000000001']);
    expect(broadcasts.recipients({ languages: ['de'] }).map((user) => user.discordUserId)).toEqual(['100000000000000002']);
    expect(broadcasts.recipients({ countries: ['DE'] })).toHaveLength(1);
    expect(broadcasts.recipients({ userIds: ['100000000000000003'] })).toHaveLength(0);
    expect(broadcasts.preview({}).byLanguage).toMatchObject({ tr: 1, de: 1, en: 0 });
  });

  it('persists every recipient before Discord is called and completes after the last one', async () => {
    const broadcasts = service();
    const created = broadcasts.create(content, {});
    await broadcasts.stop();
    expect(created.recipientCount).toBe(2);
    while (await broadcasts.sendNext()) { /* drain */ }
    expect(sends).toEqual([
      { user: '100000000000000001', status: 'sending' }, { user: '100000000000000002', status: 'sending' },
    ]);
    expect(repository.get(created.broadcastId)).toMatchObject({ status: 'completed', counts: { sent: 2 } });
  });

  it('waits out a Discord rate limit without using an attempt', async () => {
    const broadcasts = service();
    const created = broadcasts.create(content, { userIds: ['100000000000000001'] });
    await broadcasts.stop();
    sends.length = 0;
    failWith = Object.assign(new Error('rate limited'), { name: 'RateLimitError', retryAfter: 30_000 });
    await broadcasts.sendNext();
    const [recipient] = repository.recipients(created.broadcastId);
    expect(recipient).toMatchObject({ status: 'failed', attemptCount: 0, lastError: 'DISCORD_RATE_LIMITED' });
    expect(await broadcasts.sendNext()).toBe(false);
    now += 31_000;
    failWith = undefined;
    expect(await broadcasts.sendNext()).toBe(true);
    expect(repository.get(created.broadcastId)?.status).toBe('completed');
  });

  it('stops for a user whose DMs are closed and records the block', async () => {
    const broadcasts = service();
    const created = broadcasts.create(content, { userIds: ['100000000000000001'] });
    await broadcasts.stop();
    sends.length = 0;
    failWith = Object.assign(new Error('Cannot send messages to this user'), { code: 50007, status: 403 });
    await broadcasts.sendNext();
    expect(repository.recipients(created.broadcastId)[0]).toMatchObject({ status: 'skipped', lastError: 'DISCORD_DM_BLOCKED' });
    expect(dmBlocked).toEqual(['100000000000000001:DISCORD_DM_BLOCKED']);
    expect(repository.get(created.broadcastId)?.status).toBe('completed');
  });

  it('stops for a user who shares no server with Dealio and records why', async () => {
    const broadcasts = service();
    const created = broadcasts.create(content, { userIds: ['100000000000000001'] });
    await broadcasts.stop();
    failWith = Object.assign(new Error('Cannot send messages to this user due to having no mutual guilds'), { code: 50278, status: 403 });
    await broadcasts.sendNext();
    expect(repository.recipients(created.broadcastId)[0]).toMatchObject({ status: 'skipped', lastError: 'DISCORD_NO_MUTUAL_GUILD' });
    expect(dmBlocked).toEqual(['100000000000000001:DISCORD_NO_MUTUAL_GUILD']);
  });

  it('sends an interrupted delivery again after a restart (at-least-once)', async () => {
    const broadcasts = service();
    const created = broadcasts.create(content, { userIds: ['100000000000000001'] });
    await broadcasts.stop();
    repository.claimNext(new Date(now).toISOString());
    expect(repository.recipients(created.broadcastId)[0]?.status).toBe('sending');
    expect(repository.recoverInterrupted(new Date(now).toISOString())).toBe(1);
    sends.length = 0;
    await broadcasts.sendNext();
    expect(sends).toHaveLength(1);
  });

  it('pauses, resumes and cancels', async () => {
    const broadcasts = service();
    const created = broadcasts.create(content, {});
    await broadcasts.stop();
    expect(broadcasts.setStatus(created.broadcastId, 'paused')).toBe(true);
    expect(await broadcasts.sendNext()).toBe(false);
    expect(repository.setStatus(created.broadcastId, 'sending', new Date(now).toISOString())).toBe(true);
    expect(repository.setStatus(created.broadcastId, 'cancelled', new Date(now).toISOString())).toBe(true);
    expect(repository.get(created.broadcastId)).toMatchObject({ status: 'cancelled', counts: { skipped: 2 } });
    expect(repository.setStatus(created.broadcastId, 'sending', new Date(now).toISOString())).toBe(false);
  });
});
