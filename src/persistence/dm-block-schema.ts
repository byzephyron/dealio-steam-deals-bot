import type { DatabaseSync } from 'node:sqlite';

/**
 * v15: users whose latest alert finally failed because Discord refused the DM
 * (50007 "Cannot send messages to this user", or 50278 "... no mutual guilds";
 * newer rows store DISCORD_DM_BLOCKED / DISCORD_NO_MUTUAL_GUILD) before Dealio
 * recorded such failures as a DM block. They are marked the way
 * NotificationService marks them now: tracking paused, the block time and the
 * reason stored, so Home shows the fix and the panel shows "DM engelli". It runs
 * once; a user who later turns tracking back on is not blocked again.
 */
function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

export function migrateLegacyDmBlocks(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version >= 15) return;
  const notifications = columns(db, 'notification_log');
  const repairable = ['status', 'last_error', 'delivered_at', 'last_attempt_at'].every((name) => notifications.has(name))
    && columns(db, 'user_config').has('dm_delivery_blocked_at') && columns(db, 'check_state').has('next_scheduled_at');
  if (!repairable) {
    // A partial schema (tests, very old files) has no alert history to repair.
    db.exec('PRAGMA user_version = 15');
    return;
  }
  try {
    db.exec(`BEGIN IMMEDIATE;
    CREATE TEMP TABLE legacy_dm_block AS
      WITH latest AS (
        SELECT discord_user_id, status, last_error,
               COALESCE(delivered_at, last_attempt_at, created_at) AS at,
               ROW_NUMBER() OVER (PARTITION BY discord_user_id
                 ORDER BY COALESCE(delivered_at, last_attempt_at, created_at) DESC) AS position
        FROM notification_log
        WHERE status IN ('sent', 'terminal_failed')
      )
      SELECT latest.discord_user_id, latest.at,
             CASE WHEN latest.last_error LIKE '%no mutual guilds%' OR latest.last_error = 'DISCORD_NO_MUTUAL_GUILD'
               THEN 'DISCORD_NO_MUTUAL_GUILD' ELSE 'DISCORD_DM_BLOCKED' END AS error_code
      FROM latest
      JOIN user_config AS config ON config.discord_user_id = latest.discord_user_id
      WHERE latest.position = 1
        AND latest.status = 'terminal_failed'
        AND (latest.last_error LIKE 'Cannot send messages to this user%'
          OR latest.last_error IN ('DISCORD_DM_BLOCKED', 'DISCORD_NO_MUTUAL_GUILD'))
        AND config.dm_delivery_blocked_at IS NULL;
    UPDATE user_config
      SET enabled = 0,
          dm_delivery_blocked_at = (SELECT at FROM legacy_dm_block WHERE legacy_dm_block.discord_user_id = user_config.discord_user_id),
          dm_delivery_error_code = (SELECT error_code FROM legacy_dm_block WHERE legacy_dm_block.discord_user_id = user_config.discord_user_id),
          updated_at = (SELECT at FROM legacy_dm_block WHERE legacy_dm_block.discord_user_id = user_config.discord_user_id)
      WHERE discord_user_id IN (SELECT discord_user_id FROM legacy_dm_block);
    UPDATE check_state SET next_scheduled_at = NULL
      WHERE discord_user_id IN (SELECT discord_user_id FROM legacy_dm_block);
    DROP TABLE legacy_dm_block;
    PRAGMA user_version = 15;
    COMMIT;`);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
