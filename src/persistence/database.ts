import { migrateAdmin } from './admin-schema.js';
import { migrateAssistant } from './assistant-schema.js';
import { migrateSupport } from './support-schema.js';
import { migrateLegacyDmBlocks } from './dm-block-schema.js';
import { migrateWishlistHiddenNotice } from './wishlist-hidden-schema.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DatabaseInitializationError extends Error {
  public constructor(
    cause: unknown,
    public readonly databaseClosed: boolean,
  ) {
    super(cause instanceof Error ? cause.message : 'Database initialization failed', { cause });
    this.name = 'DatabaseInitializationError';
  }
}

/**
 * How long a write waits for another connection's lock (the backup, health ping and
 * monitor scripts read the same file) instead of failing at once with "database is
 * locked". Kept below Discord's three-second interaction deadline, since the wait
 * blocks the event loop.
 */
export const databaseBusyTimeoutMs = 2000;

const legacySchema = `
  PRAGMA busy_timeout = ${databaseBusyTimeoutMs};
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;

  CREATE TABLE IF NOT EXISTS user_config (
    discord_user_id TEXT PRIMARY KEY NOT NULL,
    steam_id64 TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('tr', 'en')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS check_state (
    discord_user_id TEXT PRIMARY KEY NOT NULL,
    last_started_at TEXT,
    last_completed_at TEXT,
    last_status TEXT CHECK (last_status IN ('pending', 'success', 'unavailable', 'failed')),
    last_error_code TEXT,
    next_scheduled_at TEXT,
    FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wishlist_item_state (
    discord_user_id TEXT NOT NULL,
    app_id INTEGER NOT NULL,
    on_sale INTEGER NOT NULL CHECK (on_sale IN (0, 1)),
    sale_key TEXT,
    currency TEXT,
    normal_price_minor INTEGER,
    final_price_minor INTEGER,
    discount_percent INTEGER,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (discord_user_id, app_id),
    FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    discord_user_id TEXT NOT NULL,
    app_id INTEGER NOT NULL,
    sale_key TEXT NOT NULL,
    game_name TEXT NOT NULL,
    currency TEXT NOT NULL,
    normal_price_minor INTEGER NOT NULL,
    final_price_minor INTEGER NOT NULL,
    discount_percent INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'sending', 'sent', 'failed')),
    created_at TEXT NOT NULL,
    last_attempt_at TEXT,
    last_error TEXT,
    PRIMARY KEY (discord_user_id, app_id, sale_key),
    FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
  );
`;

export function createDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  try {
    database.exec(legacySchema);
    migrateNotificationLog(database);
    migrateSaleEpisodes(database);
    migrateNotificationBackoff(database);
    migrateNotificationBatches(database);
    migrateStatusDashboard(database);
    migrateDiscountThresholds(database);
    migrateConfigurationIdentity(database);
    migratePricingContext(database);
    migrateDmConsentAndDelivery(database);
    migrateAssistant(database);
    migrateLanguages(database);
    migrateAlertLevels(database);
    migrateAdmin(database);
    migrateSupport(database);
    migrateLegacyDmBlocks(database);
    migrateWishlistHiddenNotice(database);
    return database;
  } catch (error: unknown) {
    try {
      database.close();
    } catch (closeError: unknown) {
      throw new DatabaseInitializationError(
        new AggregateError([error, closeError], 'Database initialization and close failed'),
        false,
      );
    }
    throw new DatabaseInitializationError(error, true);
  }
}

/**
 * v12 records how far an alert already went in an ongoing sale: the discount
 * (wishlist_item_state) and the target-rule price (game_rule) that were alerted or
 * taken as a baseline. A clearly deeper drop in the same sale can then alert again.
 * Existing sales are backfilled conservatively, so the upgrade sends nothing by itself.
 */
function migrateAlertLevels(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (versionRow.user_version >= 12) {
    return;
  }

  const hasColumn = (table: string, column: string): boolean => (database.prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>).some((row) => row.name === column);
  const hasTable = (table: string): boolean => database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;

  database.exec('BEGIN IMMEDIATE');
  try {
    // Backfills need the columns of the v2+ sale-episode schema.
    const episodeSchema = hasTable('notification_log') && hasColumn('notification_log', 'sale_episode_id')
      && hasColumn('notification_log', 'config_version') && hasTable('wishlist_item_state')
      && hasColumn('wishlist_item_state', 'config_version') && hasColumn('wishlist_item_state', 'notification_eligible');
    if (hasTable('wishlist_item_state') && !hasColumn('wishlist_item_state', 'alerted_discount_percent')) {
      database.exec(`
        ALTER TABLE wishlist_item_state ADD COLUMN alerted_discount_percent INTEGER
          CHECK (alerted_discount_percent IS NULL OR alerted_discount_percent BETWEEN 0 AND 100);
      `);
    }
    if (episodeSchema) {
      database.exec(`
        UPDATE wishlist_item_state
        SET alerted_discount_percent = COALESCE(
          (SELECT MAX(notification.discount_percent) FROM notification_log AS notification
           WHERE notification.discord_user_id = wishlist_item_state.discord_user_id
             AND notification.config_version = wishlist_item_state.config_version
             AND notification.app_id = wishlist_item_state.app_id
             AND notification.sale_episode_id = wishlist_item_state.sale_episode_id),
          CASE WHEN notification_eligible = 0 THEN discount_percent END)
        WHERE on_sale = 1 AND alerted_discount_percent IS NULL;
      `);
    }
    if (hasTable('game_rule') && !hasColumn('game_rule', 'alerted_minor')) {
      database.exec(`
        ALTER TABLE game_rule ADD COLUMN alerted_minor INTEGER
          CHECK (alerted_minor IS NULL OR alerted_minor >= 0);
      `);
    }
    if (episodeSchema && hasTable('game_rule')) {
      database.exec(`
        UPDATE game_rule
        SET alerted_minor = (
          SELECT state.final_price_minor FROM wishlist_item_state AS state
          WHERE state.discord_user_id = game_rule.discord_user_id
            AND state.config_version = game_rule.config_version
            AND state.app_id = game_rule.app_id)
        WHERE eligible = 1 AND alerted_minor IS NULL;
      `);
    }
    database.exec('PRAGMA user_version = 12');
    database.exec('COMMIT');
  } catch (error: unknown) {
    if (database.isTransaction) {
      database.exec('ROLLBACK');
    }
    throw error;
  }
}

const twoLanguageCheck = "CHECK (language IN ('tr', 'en'))";
const languageCheck = "CHECK (language IN ('tr', 'en', 'de', 'fr'))";

/**
 * v11 adds German and French. SQLite cannot change a CHECK constraint, so the
 * two tables that list languages are rebuilt from their own stored definition.
 */
function migrateLanguages(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (versionRow.user_version >= 11) {
    return;
  }

  // Dropping the old table with foreign keys on would cascade-delete every child row.
  // The pragma has no effect inside a transaction, so it is switched around it.
  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['user_config', 'notification_batch']) {
        const definition = database.prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
        ).get(table) as { sql: string } | undefined;
        if (!definition) {
          throw new Error(`Missing ${table} table before the language migration`);
        }
        if (!definition.sql.includes(twoLanguageCheck)) {
          continue;
        }
        const indexes = database.prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
        ).all(table) as Array<{ sql: string }>;
        const rebuilt = definition.sql
          .replace(twoLanguageCheck, languageCheck)
          .replace(/^CREATE TABLE\s+"?\w+"?/i, `CREATE TABLE ${table}_v11`);
        database.exec(rebuilt);
        database.exec(`INSERT INTO ${table}_v11 SELECT * FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${table}_v11 RENAME TO ${table}`);
        for (const index of indexes) {
          database.exec(index.sql);
        }
      }
      if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('Foreign key check failed after the language migration');
      }
      database.exec('PRAGMA user_version = 11');
      database.exec('COMMIT');
    } catch (error: unknown) {
      if (database.isTransaction) {
        database.exec('ROLLBACK');
      }
      throw error;
    }
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateDmConsentAndDelivery(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (versionRow.user_version >= 9) {
    return;
  }

  database.exec('BEGIN');
  try {
    const columns = new Set(
      (database.prepare('PRAGMA table_info(user_config)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('dm_opt_in_at')) {
      database.exec('ALTER TABLE user_config ADD COLUMN dm_opt_in_at TEXT');
    }
    if (!columns.has('dm_delivery_blocked_at')) {
      database.exec('ALTER TABLE user_config ADD COLUMN dm_delivery_blocked_at TEXT');
    }
    if (!columns.has('dm_delivery_error_code')) {
      database.exec('ALTER TABLE user_config ADD COLUMN dm_delivery_error_code TEXT');
    }
    database.exec(`
      UPDATE user_config
      SET dm_opt_in_at = created_at
      WHERE dm_opt_in_at IS NULL;
      PRAGMA user_version = 9;
    `);
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migratePricingContext(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (versionRow.user_version >= 8) {
    return;
  }

  database.exec('BEGIN');
  try {
    database.exec(`
      ALTER TABLE user_config ADD COLUMN store_country_code TEXT NOT NULL DEFAULT 'TR'
        CHECK (length(store_country_code) = 2 AND store_country_code = upper(store_country_code));
      ALTER TABLE wishlist_item_state ADD COLUMN store_country_code TEXT NOT NULL DEFAULT 'TR'
        CHECK (length(store_country_code) = 2 AND store_country_code = upper(store_country_code));
      ALTER TABLE wishlist_item_state ADD COLUMN observation_status TEXT NOT NULL DEFAULT 'known'
        CHECK (observation_status IN ('known', 'unknown', 'error', 'missing'));
      ALTER TABLE notification_log ADD COLUMN store_country_code TEXT NOT NULL DEFAULT 'TR'
        CHECK (length(store_country_code) = 2 AND store_country_code = upper(store_country_code));
      PRAGMA user_version = 8;
    `);
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateConfigurationIdentity(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (versionRow.user_version >= 7) {
    return;
  }

  database.exec('BEGIN');
  try {
    database.exec(`
      ALTER TABLE user_config ADD COLUMN configuration_id TEXT;
      UPDATE user_config
      SET configuration_id = lower(hex(randomblob(16)))
      WHERE configuration_id IS NULL;
      CREATE UNIQUE INDEX user_config_configuration_id_idx
        ON user_config(configuration_id);
      PRAGMA user_version = 7;
    `);
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateDiscountThresholds(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (versionRow.user_version >= 6) {
    return;
  }

  database.exec('BEGIN');
  try {
    database.exec(`
      ALTER TABLE user_config ADD COLUMN minimum_discount_percent INTEGER NOT NULL DEFAULT 0
        CHECK (minimum_discount_percent BETWEEN 0 AND 100);
      ALTER TABLE wishlist_item_state ADD COLUMN notification_eligible INTEGER NOT NULL DEFAULT 0
        CHECK (notification_eligible IN (0, 1));

      CREATE TABLE game_discount_threshold (
        discord_user_id TEXT NOT NULL,
        config_version INTEGER NOT NULL CHECK (config_version > 0),
        app_id INTEGER NOT NULL CHECK (app_id > 0),
        minimum_discount_percent INTEGER NOT NULL
          CHECK (minimum_discount_percent BETWEEN 0 AND 100),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (discord_user_id, config_version, app_id),
        FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
      );

      PRAGMA user_version = 6;
    `);
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateNotificationLog(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  if (versionRow.user_version >= 1) {
    return;
  }

  database.exec('BEGIN');

  try {
    database.exec('ALTER TABLE notification_log RENAME TO notification_log_legacy');
    database.exec(`
      CREATE TABLE notification_log (
        discord_user_id TEXT NOT NULL,
        app_id INTEGER NOT NULL,
        sale_key TEXT NOT NULL,
        game_name TEXT NOT NULL,
        currency TEXT NOT NULL,
        normal_price_minor INTEGER NOT NULL,
        final_price_minor INTEGER NOT NULL,
        discount_percent INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'sending', 'sent', 'failed')),
        created_at TEXT NOT NULL,
        last_attempt_at TEXT,
        last_error TEXT,
        PRIMARY KEY (discord_user_id, app_id, sale_key),
        FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
      );
    `);
    database.exec(`
      INSERT INTO notification_log
        (discord_user_id, app_id, sale_key, game_name, currency,
         normal_price_minor, final_price_minor, discount_percent,
         status, created_at)
      SELECT discord_user_id, app_id, sale_key, game_name, currency,
             normal_price_minor, final_price_minor, discount_percent,
             status, created_at
      FROM notification_log_legacy;
    `);
    database.exec('DROP TABLE notification_log_legacy');
    database.exec('PRAGMA user_version = 1');
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateSaleEpisodes(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  if (versionRow.user_version >= 2) {
    return;
  }

  database.exec('BEGIN');

  try {
    database.exec('ALTER TABLE user_config ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1');
    database.exec('ALTER TABLE wishlist_item_state RENAME TO wishlist_item_state_legacy');
    database.exec('ALTER TABLE notification_log RENAME TO notification_log_legacy');
    database.exec(`
      CREATE TABLE wishlist_item_state (
        discord_user_id TEXT NOT NULL,
        steam_id64 TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        app_id INTEGER NOT NULL,
        on_sale INTEGER NOT NULL CHECK (on_sale IN (0, 1)),
        sale_episode_id TEXT,
        sale_started_at TEXT,
        sale_key TEXT,
        currency TEXT,
        normal_price_minor INTEGER,
        final_price_minor INTEGER,
        discount_percent INTEGER,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (discord_user_id, config_version, app_id),
        FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
      );
    `);
    database.exec(`
      INSERT INTO wishlist_item_state
        (discord_user_id, steam_id64, config_version, app_id, on_sale,
         sale_episode_id, sale_started_at, sale_key, currency,
         normal_price_minor, final_price_minor, discount_percent, last_seen_at)
      SELECT s.discord_user_id, u.steam_id64, u.config_version, s.app_id, s.on_sale,
             CASE WHEN s.on_sale = 1
               THEN 'legacy-current:' || s.discord_user_id || ':' || s.app_id
               ELSE NULL
             END,
             CASE WHEN s.on_sale = 1 THEN s.last_seen_at ELSE NULL END,
             s.sale_key, s.currency, s.normal_price_minor, s.final_price_minor,
             s.discount_percent, s.last_seen_at
      FROM wishlist_item_state_legacy s
      JOIN user_config u ON u.discord_user_id = s.discord_user_id;
    `);
    database.exec(`
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
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'sending', 'sent', 'failed', 'expired')),
        created_at TEXT NOT NULL,
        last_attempt_at TEXT,
        last_error TEXT,
        PRIMARY KEY (discord_user_id, config_version, app_id, sale_episode_id),
        FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
      );
    `);
    database.exec(`
      INSERT INTO notification_log
        (discord_user_id, steam_id64, config_version, app_id, sale_episode_id,
         sale_key, game_name, currency, normal_price_minor, final_price_minor,
         discount_percent, status, created_at, last_attempt_at, last_error)
      SELECT n.discord_user_id, u.steam_id64, u.config_version, n.app_id,
             CASE
               WHEN n.status IN ('candidate', 'failed', 'sending')
                AND s.on_sale = 1
                AND n.sale_key = (
                  SELECT n2.sale_key
                  FROM notification_log_legacy n2
                  WHERE n2.discord_user_id = n.discord_user_id
                    AND n2.app_id = n.app_id
                    AND n2.status IN ('candidate', 'failed', 'sending')
                  ORDER BY n2.created_at DESC, n2.sale_key DESC
                  LIMIT 1
                )
               THEN s.sale_episode_id
               ELSE 'legacy:' || n.sale_key
             END,
             n.sale_key, n.game_name, n.currency, n.normal_price_minor,
             n.final_price_minor, n.discount_percent, n.status, n.created_at,
             n.last_attempt_at, n.last_error
      FROM notification_log_legacy n
      JOIN user_config u ON u.discord_user_id = n.discord_user_id
      LEFT JOIN wishlist_item_state s
        ON s.discord_user_id = n.discord_user_id
       AND s.config_version = u.config_version
       AND s.app_id = n.app_id;
    `);
    database.exec('DROP TABLE notification_log_legacy');
    database.exec('DROP TABLE wishlist_item_state_legacy');
    database.exec('PRAGMA user_version = 2');
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateNotificationBackoff(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  if (versionRow.user_version >= 3) {
    return;
  }

  database.exec('BEGIN');

  try {
    database.exec('ALTER TABLE notification_log RENAME TO notification_log_v2');
    database.exec(`
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
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN (
            'candidate', 'sending', 'sent', 'failed', 'terminal_failed', 'expired'
          )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        last_attempt_at TEXT,
        last_error TEXT,
        PRIMARY KEY (discord_user_id, config_version, app_id, sale_episode_id),
        FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
      );
    `);
    database.exec(`
      INSERT INTO notification_log
        (discord_user_id, steam_id64, config_version, app_id, sale_episode_id,
         sale_key, game_name, currency, normal_price_minor, final_price_minor,
         discount_percent, status, attempt_count, next_attempt_at, created_at,
         last_attempt_at, last_error)
      SELECT discord_user_id, steam_id64, config_version, app_id, sale_episode_id,
             sale_key, game_name, currency, normal_price_minor, final_price_minor,
             discount_percent, status,
             CASE
               WHEN status = 'failed' AND last_attempt_at IS NOT NULL THEN 1
               ELSE 0
             END,
             CASE WHEN status = 'failed' THEN COALESCE(last_attempt_at, created_at) ELSE NULL END,
             created_at, last_attempt_at, last_error
      FROM notification_log_v2;
    `);
    database.exec('DROP TABLE notification_log_v2');
    database.exec(`
      CREATE INDEX notification_retry_due_idx
      ON notification_log(discord_user_id, config_version, status, next_attempt_at);
    `);
    database.exec('PRAGMA user_version = 3');
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateNotificationBatches(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  if (versionRow.user_version >= 4) {
    return;
  }

  database.exec('BEGIN');

  try {
    database.exec(`
      CREATE TABLE notification_batch (
        batch_id TEXT PRIMARY KEY NOT NULL,
        discord_user_id TEXT NOT NULL,
        steam_id64 TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        language TEXT NOT NULL CHECK (language IN ('tr', 'en')),
        status TEXT NOT NULL CHECK (status IN (
          'sending', 'failed', 'sent', 'terminal_failed', 'expired'
        )),
        member_count INTEGER NOT NULL CHECK (member_count BETWEEN 1 AND 10),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        first_created_at TEXT NOT NULL,
        first_app_id INTEGER NOT NULL,
        first_sale_episode_id TEXT NOT NULL,
        last_attempt_at TEXT,
        last_error TEXT,
        FOREIGN KEY (discord_user_id) REFERENCES user_config(discord_user_id) ON DELETE CASCADE
      );

      CREATE TABLE notification_batch_item (
        batch_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
        discord_user_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        app_id INTEGER NOT NULL,
        sale_episode_id TEXT NOT NULL,
        PRIMARY KEY (batch_id, position),
        UNIQUE (batch_id, discord_user_id, config_version, app_id, sale_episode_id),
        FOREIGN KEY (batch_id) REFERENCES notification_batch(batch_id) ON DELETE CASCADE,
        FOREIGN KEY (discord_user_id, config_version, app_id, sale_episode_id)
          REFERENCES notification_log(discord_user_id, config_version, app_id, sale_episode_id)
          ON DELETE CASCADE
      );

      CREATE INDEX notification_batch_retry_due_idx
      ON notification_batch(
        discord_user_id, config_version, status, next_attempt_at,
        first_created_at, first_app_id, first_sale_episode_id
      );

      CREATE INDEX notification_batch_item_notification_idx
      ON notification_batch_item(discord_user_id, config_version, app_id, sale_episode_id);

      PRAGMA user_version = 4;
    `);
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateStatusDashboard(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  if (versionRow.user_version >= 5) {
    return;
  }

  database.exec('BEGIN');
  try {
    database.exec(`
      ALTER TABLE check_state ADD COLUMN last_success_completed_at TEXT;
      ALTER TABLE check_state ADD COLUMN last_success_checked_count INTEGER
        CHECK (last_success_checked_count IS NULL OR last_success_checked_count >= 0);
      ALTER TABLE check_state ADD COLUMN last_success_on_sale_count INTEGER
        CHECK (last_success_on_sale_count IS NULL OR last_success_on_sale_count >= 0);
      ALTER TABLE check_state ADD COLUMN last_success_free_count INTEGER
        CHECK (last_success_free_count IS NULL OR last_success_free_count >= 0);
      ALTER TABLE check_state ADD COLUMN last_success_unknown_price_count INTEGER
        CHECK (last_success_unknown_price_count IS NULL OR last_success_unknown_price_count >= 0);
      ALTER TABLE check_state ADD COLUMN last_success_failed_item_count INTEGER
        CHECK (last_success_failed_item_count IS NULL OR last_success_failed_item_count >= 0);

      UPDATE check_state
      SET last_success_completed_at = last_completed_at
      WHERE last_status = 'success';

      CREATE TABLE wishlist_poll_schedule (
        schedule_name TEXT PRIMARY KEY NOT NULL CHECK (schedule_name = 'wishlist'),
        next_scheduled_at TEXT
      );

      INSERT INTO wishlist_poll_schedule (schedule_name, next_scheduled_at)
      VALUES ('wishlist', NULL);

      PRAGMA user_version = 5;
    `);
    database.exec('COMMIT');
  } catch (error: unknown) {
    database.exec('ROLLBACK');
    throw error;
  }
}
