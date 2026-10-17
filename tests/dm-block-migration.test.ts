import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminRepository } from '../src/persistence/admin-repository.js';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { seedNotification, seedUser } from './helpers/admin-seed.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const noMutualGuild = 'Cannot send messages to this user due to having no mutual guilds';
const dmClosed = 'Cannot send messages to this user';

function failed(database: ReturnType<typeof createDatabase>, userId: string, appId: number, at: string, error: string): void {
  seedNotification(database, userId, appId, 'terminal_failed', at);
  database.prepare('UPDATE notification_log SET last_error = ? WHERE discord_user_id = ? AND app_id = ?').run(error, userId, appId);
}

/** A database at v14 holding alerts that failed before DM blocks were recorded. */
function legacyDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dealio-dm-block-'));
  directories.push(directory);
  const path = join(directory, 'wishlist.db');
  const database = createDatabase(path);
  seedUser(database, { id: '100000000000000001' });
  failed(database, '100000000000000001', 1, '2026-10-12T18:02:05.000Z', noMutualGuild);
  seedUser(database, { id: '100000000000000002' });
  failed(database, '100000000000000002', 1, '2026-10-10T10:00:00.000Z', dmClosed);
  seedNotification(database, '100000000000000002', 2, 'sent', '2026-10-11T10:00:00.000Z');
  seedUser(database, { id: '100000000000000003' });
  failed(database, '100000000000000003', 1, '2026-10-10T10:00:00.000Z', 'Internal Server Error');
  seedUser(database, { id: '100000000000000004', blocked: true });
  failed(database, '100000000000000004', 1, '2026-10-10T10:00:00.000Z', dmClosed);
  seedUser(database, { id: '100000000000000005' });
  seedNotification(database, '100000000000000005', 1, 'sent', '2026-10-09T10:00:00.000Z');
  failed(database, '100000000000000005', 2, '2026-10-10T10:00:00.000Z', dmClosed);
  // Newer rows store Dealio's own code instead of Discord's message.
  seedUser(database, { id: '100000000000000006' });
  failed(database, '100000000000000006', 1, '2026-10-16T10:00:00.000Z', 'DISCORD_NO_MUTUAL_GUILD');
  database.exec('PRAGMA user_version = 14');
  database.close();
  return path;
}

describe('v15 legacy DM block migration', () => {
  it('marks only users whose latest alert failed because Discord refused the DM', () => {
    const database = createDatabase(legacyDatabase());
    try {
      expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
      const users = new UserConfigRepository(database);
      expect(users.findByDiscordUserId('100000000000000001')).toMatchObject({
        enabled: false, dmDeliveryBlockedAt: '2026-10-12T18:02:05.000Z', dmDeliveryErrorCode: 'DISCORD_NO_MUTUAL_GUILD',
      });
      expect(users.findByDiscordUserId('100000000000000005')).toMatchObject({
        enabled: false, dmDeliveryErrorCode: 'DISCORD_DM_BLOCKED',
      });
      expect(users.findByDiscordUserId('100000000000000006')?.dmDeliveryErrorCode).toBe('DISCORD_NO_MUTUAL_GUILD');
      // A later alert arrived, the error was not a DM refusal, or the block is already recorded.
      expect(users.findByDiscordUserId('100000000000000002')).toMatchObject({ enabled: true, dmDeliveryBlockedAt: null });
      expect(users.findByDiscordUserId('100000000000000003')).toMatchObject({ enabled: true, dmDeliveryBlockedAt: null });
      expect(users.findByDiscordUserId('100000000000000004')?.dmDeliveryErrorCode).toBe('50007');
    } finally {
      database.close();
    }
  });

  it('runs once, so turning tracking back on is not undone at the next start', () => {
    const path = legacyDatabase();
    const first = createDatabase(path);
    new UserConfigRepository(first).setEnabled('100000000000000001', true, '2026-10-17T12:00:00.000Z');
    first.close();
    const second = createDatabase(path);
    try {
      expect(new UserConfigRepository(second).findByDiscordUserId('100000000000000001'))
        .toMatchObject({ enabled: true, dmDeliveryBlockedAt: null });
    } finally {
      second.close();
    }
  });

  it('shows each user’s latest finished delivery in the admin list', () => {
    const database = createDatabase(legacyDatabase());
    try {
      const rows = new Map(new AdminRepository(database).users().map((row) => [row.discordUserId, row.lastDelivery]));
      expect(rows.get('100000000000000001')).toEqual({ status: 'terminal_failed', at: '2026-10-12T18:02:05.000Z', error: noMutualGuild });
      expect(rows.get('100000000000000002')).toEqual({ status: 'sent', at: '2026-10-11T10:00:00.000Z', error: null });
    } finally {
      database.close();
    }
  });
});
