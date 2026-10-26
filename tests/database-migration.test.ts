import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';

describe('database migration', () => {
  it('preserves version 1 state and retryable notifications', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wishlist-bot-migration-'));
    const databasePath = join(directory, 'wishlist.db');

    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE user_config (
          discord_user_id TEXT PRIMARY KEY NOT NULL,
          steam_id64 TEXT NOT NULL,
          language TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE wishlist_item_state (
          discord_user_id TEXT NOT NULL,
          app_id INTEGER NOT NULL,
          on_sale INTEGER NOT NULL,
          sale_key TEXT,
          currency TEXT,
          normal_price_minor INTEGER,
          final_price_minor INTEGER,
          discount_percent INTEGER,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (discord_user_id, app_id)
        );
        CREATE TABLE notification_log (
          discord_user_id TEXT NOT NULL,
          app_id INTEGER NOT NULL,
          sale_key TEXT NOT NULL,
          game_name TEXT NOT NULL,
          currency TEXT NOT NULL,
          normal_price_minor INTEGER NOT NULL,
          final_price_minor INTEGER NOT NULL,
          discount_percent INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_attempt_at TEXT,
          last_error TEXT,
          PRIMARY KEY (discord_user_id, app_id, sale_key)
        );
        PRAGMA user_version = 1;
      `);
      legacy.prepare(
        `INSERT INTO user_config
          (discord_user_id, steam_id64, language, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'discord-user',
        '76561198000000000',
        'tr',
        1,
        '2026-08-20T00:00:00.000Z',
        '2026-08-20T00:00:00.000Z',
      );
      legacy.prepare(
        `INSERT INTO wishlist_item_state
          (discord_user_id, app_id, on_sale, sale_key, currency,
           normal_price_minor, final_price_minor, discount_percent, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'discord-user', 10, 1, 'TRY:1000:750:25', 'TRY', 1_000, 750, 25,
        '2026-08-21T00:02:00.000Z',
      );
      legacy.prepare(
        `INSERT INTO notification_log
          (discord_user_id, app_id, sale_key, game_name, currency,
           normal_price_minor, final_price_minor, discount_percent,
           status, created_at, last_attempt_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'discord-user', 10, 'TRY:1000:750:25', 'Legacy Game', 'TRY',
        1_000, 750, 25, 'failed', '2026-08-21T00:02:00.000Z',
        '2026-08-21T00:03:00.000Z', 'DM blocked',
      );
      legacy.close();

      const database = createDatabase(databasePath);
      const userRepository = new UserConfigRepository(database);
      const stateRepository = new WishlistStateRepository(database);
      const config = userRepository.findByDiscordUserId('discord-user');

      expect(config).toMatchObject({
        steamId64: '76561198000000000',
        configVersion: 1,
        minimumDiscountPercent: 0,
        storeCountryCode: 'TR',
        dmOptInAt: '2026-08-20T00:00:00.000Z',
        dmDeliveryBlockedAt: null,
        dmDeliveryErrorCode: null,
      });
      if (!config) {
        throw new Error('Expected migrated user configuration');
      }

      const state = stateRepository.findByDiscordUserAndAppId('discord-user', 10, 1);
      const candidates = stateRepository.findRetryableNotificationCandidates(
        config,
        '2026-08-21T00:04:00.000Z',
      );
      expect(state).toMatchObject({
        steamId64: '76561198000000000',
        configVersion: 1,
        onSale: true,
        observationStatus: 'known',
        storeCountryCode: 'TR',
      });
      expect(database.prepare(
        `SELECT notification_eligible FROM wishlist_item_state
         WHERE discord_user_id = 'discord-user' AND app_id = 10`,
      ).get()).toEqual({ notification_eligible: 0 });
      expect(state?.saleEpisodeId).toBeTruthy();
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        gameName: 'Legacy Game',
        saleEpisodeId: state?.saleEpisodeId,
      });
      expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(17);
      expect(database.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('notification_batch', 'notification_batch_item')
         ORDER BY name`,
      ).all()).toEqual([
        { name: 'notification_batch' },
        { name: 'notification_batch_item' },
      ]);
      expect(database.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'game_discount_threshold'`,
      ).get()).toEqual({ name: 'game_discount_threshold' });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves version 2 episodes and makes legacy failed delivery retryable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wishlist-bot-v2-migration-'));
    const databasePath = join(directory, 'wishlist.db');

    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        CREATE TABLE user_config (
          discord_user_id TEXT PRIMARY KEY NOT NULL,
          steam_id64 TEXT NOT NULL,
          language TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          config_version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE wishlist_item_state (
          discord_user_id TEXT NOT NULL,
          steam_id64 TEXT NOT NULL,
          config_version INTEGER NOT NULL,
          app_id INTEGER NOT NULL,
          on_sale INTEGER NOT NULL,
          sale_episode_id TEXT,
          sale_started_at TEXT,
          sale_key TEXT,
          currency TEXT,
          normal_price_minor INTEGER,
          final_price_minor INTEGER,
          discount_percent INTEGER,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (discord_user_id, config_version, app_id)
        );
        CREATE TABLE notification_log (
          discord_user_id TEXT NOT NULL,
          steam_id64 TEXT NOT NULL,
          config_version INTEGER NOT NULL,
          app_id INTEGER NOT NULL,
          sale_episode_id TEXT NOT NULL,
          sale_key TEXT NOT NULL,
          game_name TEXT NOT NULL,
          currency TEXT NOT NULL,
          normal_price_minor INTEGER NOT NULL,
          final_price_minor INTEGER NOT NULL,
          discount_percent INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_attempt_at TEXT,
          last_error TEXT,
          PRIMARY KEY (discord_user_id, config_version, app_id, sale_episode_id)
        );
        PRAGMA user_version = 2;
        INSERT INTO user_config VALUES (
          'discord-user', '76561198000000000', 'en', 1,
          '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 1
        );
        INSERT INTO wishlist_item_state VALUES (
          'discord-user', '76561198000000000', 1, 10, 1,
          'episode-v2', '2026-08-21T00:00:00.000Z', 'TRY:1000:750:25',
          'TRY', 1000, 750, 25, '2026-08-21T00:00:00.000Z'
        );
        INSERT INTO notification_log VALUES (
          'discord-user', '76561198000000000', 1, 10, 'episode-v2',
          'TRY:1000:750:25', 'V2 Game', 'TRY', 1000, 750, 25,
          'failed', '2026-08-21T00:01:00.000Z',
          '2026-08-21T00:01:30.000Z', 'legacy failure'
        );
        INSERT INTO notification_log VALUES (
          'discord-user', '76561198000000000', 1, 20, 'sending-v2',
          'TRY:2000:1000:50', 'Interrupted V2 Game', 'TRY', 2000, 1000, 50,
          'sending', '2026-08-21T00:01:00.000Z',
          '2026-08-21T00:01:30.000Z', NULL
        );
      `);
      legacy.close();

      const database = createDatabase(databasePath);
      try {
        const config = new UserConfigRepository(database).findByDiscordUserId('discord-user');
        if (!config) {
          throw new Error('Expected migrated user configuration');
        }
        const candidates = new WishlistStateRepository(database)
          .findRetryableNotificationCandidates(config, '2026-08-21T00:02:00.000Z');

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
          saleEpisodeId: 'episode-v2',
          attemptCount: 1,
          gameName: 'V2 Game',
        });
        expect(
          database.prepare(
            `SELECT attempt_count
             FROM notification_log
             WHERE discord_user_id = ? AND app_id = ?`,
          ).get('discord-user', 20),
        ).toEqual({ attempt_count: 0 });
        expect(
          (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
          ).toBe(17);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('migrates version 4 check state to nullable v5 success metrics safely', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wishlist-bot-v4-migration-'));
    const databasePath = join(directory, 'wishlist.db');

    try {
      const current = createDatabase(databasePath);
      current.exec('PRAGMA foreign_keys = OFF');
      current.exec(`
        DROP TABLE game_rule; DROP TABLE notification_preference; DROP TABLE wishlist_snapshot; DROP TABLE price_observation;
        ALTER TABLE wishlist_item_state DROP COLUMN rule_event_id;
        ALTER TABLE notification_log DROP COLUMN rule_revision;
        ALTER TABLE notification_log DROP COLUMN reason;
        ALTER TABLE notification_log DROP COLUMN discord_message_id;
        ALTER TABLE notification_log DROP COLUMN delivered_at;
        DROP INDEX user_config_configuration_id_idx;
        ALTER TABLE user_config DROP COLUMN configuration_id;
        ALTER TABLE user_config DROP COLUMN store_country_code;
        ALTER TABLE wishlist_item_state DROP COLUMN observation_status;
        ALTER TABLE wishlist_item_state DROP COLUMN store_country_code;
        ALTER TABLE notification_log DROP COLUMN store_country_code;
        DROP TABLE game_discount_threshold;
        ALTER TABLE user_config DROP COLUMN minimum_discount_percent;
        ALTER TABLE wishlist_item_state DROP COLUMN notification_eligible;
        DROP TABLE wishlist_poll_schedule;
        ALTER TABLE check_state RENAME TO check_state_v5;
        CREATE TABLE check_state (
          discord_user_id TEXT PRIMARY KEY NOT NULL,
          last_started_at TEXT,
          last_completed_at TEXT,
          last_status TEXT,
          last_error_code TEXT,
          next_scheduled_at TEXT,
          FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
        );
        DROP TABLE check_state_v5;
        INSERT INTO user_config
          (discord_user_id, steam_id64, config_version, language, enabled, created_at, updated_at)
        VALUES
          ('success-user', '76561198000000000', 1, 'tr', 1,
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'),
          ('failed-user', '76561198000000001', 1, 'en', 1,
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
        INSERT INTO check_state VALUES
          ('success-user', '2026-08-21T00:00:00.000Z', '2026-08-21T00:01:00.000Z',
           'success', NULL, '2026-08-21T06:00:00.000Z'),
          ('failed-user', '2026-08-21T00:00:00.000Z', '2026-08-21T00:01:00.000Z',
           'failed', 'INTERNAL_ERROR', '2026-08-21T06:00:00.000Z');
        PRAGMA user_version = 4;
      `);
      current.close();

      const migrated = createDatabase(databasePath);
      try {
        expect(
          (migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        ).toBe(17);
        expect(migrated.prepare(
          `SELECT last_success_completed_at, last_success_checked_count,
                  last_success_on_sale_count, last_success_free_count,
                  last_success_unknown_price_count, last_success_failed_item_count
           FROM check_state WHERE discord_user_id = 'success-user'`,
        ).get()).toEqual({
          last_success_completed_at: '2026-08-21T00:01:00.000Z',
          last_success_checked_count: null,
          last_success_on_sale_count: null,
          last_success_free_count: null,
          last_success_unknown_price_count: null,
          last_success_failed_item_count: null,
        });
        expect(migrated.prepare(
          `SELECT last_success_completed_at
           FROM check_state WHERE discord_user_id = 'failed-user'`,
        ).get()).toEqual({ last_success_completed_at: null });
        expect(migrated.prepare(
          `SELECT next_scheduled_at FROM wishlist_poll_schedule
           WHERE schedule_name = 'wishlist'`,
        ).get()).toEqual({ next_scheduled_at: null });
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('widens the language list to German and French without losing linked rows', () => {
    const database = createDatabase(':memory:');
    try {
      const schema = (table: string) => (database.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(table) as { sql: string }).sql;
      expect(schema('user_config')).toContain("CHECK (language IN ('tr', 'en', 'de', 'fr'))");
      expect(schema('notification_batch')).toContain("CHECK (language IN ('tr', 'en', 'de', 'fr'))");
      expect(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'user_config_configuration_id_idx'",
      ).get()).toBeTruthy();
      expect((database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    } finally {
      database.close();
    }

    const directory = mkdtempSync(join(tmpdir(), 'wishlist-bot-languages-'));
    const databasePath = join(directory, 'wishlist.db');
    try {
      const version10 = new DatabaseSync(databasePath);
      version10.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE user_config (
          discord_user_id TEXT PRIMARY KEY NOT NULL,
          steam_id64 TEXT NOT NULL,
          language TEXT NOT NULL CHECK (language IN ('tr', 'en')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , configuration_id TEXT);
        CREATE UNIQUE INDEX user_config_configuration_id_idx ON user_config(configuration_id);
        CREATE TABLE notification_batch (
          batch_id TEXT PRIMARY KEY NOT NULL,
          discord_user_id TEXT NOT NULL,
          language TEXT NOT NULL CHECK (language IN ('tr', 'en')),
          FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
        );
        CREATE TABLE notification_preference (
          discord_user_id TEXT PRIMARY KEY REFERENCES user_config(discord_user_id) ON DELETE CASCADE,
          mode TEXT NOT NULL
        );
        INSERT INTO user_config VALUES ('user', '76561198000000000', 'tr', 1, '2026-10-01', '2026-10-01', 'config');
        INSERT INTO notification_batch VALUES ('batch', 'user', 'en');
        INSERT INTO notification_preference VALUES ('user', 'instant');
        PRAGMA user_version = 10;
      `);
      version10.close();

      const migrated = createDatabase(databasePath);
      try {
        expect(migrated.prepare('SELECT mode FROM notification_preference').all()).toEqual([{ mode: 'instant' }]);
        expect(migrated.prepare('SELECT language FROM notification_batch').all()).toEqual([{ language: 'en' }]);
        expect(migrated.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'user_config_configuration_id_idx'",
        ).get()).toBeTruthy();
        migrated.exec("UPDATE user_config SET language = 'de'");
        expect(() => migrated.exec("UPDATE user_config SET language = 'xx'")).toThrow();
        migrated.exec("DELETE FROM user_config WHERE discord_user_id = 'user'");
        expect(migrated.prepare('SELECT COUNT(*) AS count FROM notification_preference').get()).toEqual({ count: 0 });
        expect(migrated.prepare('SELECT COUNT(*) AS count FROM notification_batch').get()).toEqual({ count: 0 });
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
