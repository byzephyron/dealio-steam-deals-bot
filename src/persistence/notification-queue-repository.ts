// SIZE_OK: Queue recovery, expiry, retry gating, and terminal updates form one SQL state machine.
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { NotificationCandidate } from '../domain/wishlist-state.js';
import {
  integerValue,
  notificationColumns,
  textValue,
  toNotificationCandidate,
  type NotificationLogRow,
  type WishlistScope,
} from './wishlist-state-codecs.js';

export class NotificationQueueRepository {
  public constructor(private readonly database: DatabaseSync) {}

  /**
   * Any unresolved notification, or with `dueAt` only those deliverable now: a
   * retry scheduled for later, or an offer whose sale episode is no longer the
   * active one, is pending but not due.
   */
  /** Whether any sale alert reached this user; sent rows are kept 30 days. */
  public hasDeliveredNotification(discordUserId: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM notification_log WHERE discord_user_id = ? AND status = 'sent' LIMIT 1
    `).get(discordUserId) !== undefined;
  }

  public hasPendingNotifications(discordUserId: string, configVersion: number, dueAt?: string): boolean {
    return dueAt === undefined
      ? this.database.prepare(`
          SELECT 1 FROM notification_log
          WHERE discord_user_id = ? AND config_version = ?
            AND status IN ('candidate', 'failed', 'sending')
          LIMIT 1
        `).get(discordUserId, configVersion) !== undefined
      : this.database.prepare(`
          SELECT 1 FROM notification_log
          WHERE discord_user_id = ? AND config_version = ?
            AND (status = 'candidate' OR (status = 'failed' AND next_attempt_at <= ?))
            AND EXISTS (
              SELECT 1 FROM wishlist_item_state AS state
              WHERE state.discord_user_id = notification_log.discord_user_id
                AND state.steam_id64 = notification_log.steam_id64
                AND state.config_version = notification_log.config_version
                AND state.app_id = notification_log.app_id
                AND (state.on_sale = 1 OR state.rule_event_id IS NOT NULL)
                AND (state.rule_event_id = notification_log.sale_episode_id
                  OR (notification_log.reason = 'discount' AND state.sale_episode_id = notification_log.sale_episode_id))
            )
          LIMIT 1
        `).get(discordUserId, configVersion, dueAt) !== undefined;
  }

  public recoverStaleSending(scope: WishlistScope, staleBefore: string): number {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const batches = this.database
        .prepare(
          `SELECT batch_id, member_count
           FROM notification_batch
           WHERE discord_user_id = ? AND steam_id64 = ? AND config_version = ?
             AND status = 'sending'
             AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`,
        )
        .all(
          scope.discordUserId,
          scope.steamId64,
          scope.configVersion,
          staleBefore,
        ) as Array<{ batch_id: SQLOutputValue; member_count: SQLOutputValue }>;
      let recoveredCount = 0;

      for (const row of batches) {
        const batchId = textValue(row.batch_id, 'batch_id');
        const memberCount = integerValue(row.member_count, 'member_count');
        const items = this.database
          .prepare(
            `UPDATE notification_log AS notification
             SET status = 'failed',
                 next_attempt_at = COALESCE(last_attempt_at, ?),
                 last_error = 'Delivery outcome unknown after process interruption; retrying at least once'
             WHERE status = 'sending'
               AND (notification.discord_user_id, notification.config_version,
                    notification.app_id, notification.sale_episode_id) IN (
                 SELECT item.discord_user_id, item.config_version, item.app_id, item.sale_episode_id
                 FROM notification_batch_item AS item
                 WHERE item.batch_id = ?
               )`,
          )
          .run(staleBefore, batchId);
        if (Number(items.changes) !== memberCount) {
          throw new Error('Could not recover every notification in a stale batch');
        }

        const parent = this.database
          .prepare(
            `UPDATE notification_batch
             SET status = 'failed',
                 next_attempt_at = COALESCE(last_attempt_at, ?),
                 last_error = 'Delivery outcome unknown after process interruption; retrying at least once'
             WHERE batch_id = ? AND status = 'sending'`,
          )
          .run(staleBefore, batchId);
        if (Number(parent.changes) !== 1) {
          throw new Error('Could not recover a stale notification batch');
        }
        recoveredCount += memberCount;
      }

      const legacy = this.database
        .prepare(
          `UPDATE notification_log AS notification
           SET status = 'failed',
               next_attempt_at = COALESCE(last_attempt_at, ?),
               last_error = 'Delivery outcome unknown after process interruption; retrying at least once'
           WHERE discord_user_id = ? AND steam_id64 = ? AND config_version = ?
             AND status = 'sending'
             AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM notification_batch_item AS item
               JOIN notification_batch AS batch ON batch.batch_id = item.batch_id
               WHERE item.discord_user_id = notification.discord_user_id
                 AND item.config_version = notification.config_version
                 AND item.app_id = notification.app_id
                 AND item.sale_episode_id = notification.sale_episode_id
                 AND batch.status IN ('sending', 'failed')
             )`,
        )
        .run(staleBefore, scope.discordUserId, scope.steamId64, scope.configVersion, staleBefore);
      recoveredCount += Number(legacy.changes);

      this.database.exec('COMMIT');
      return recoveredCount;
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public expireInactiveNotifications(scope: WishlistScope): number {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const invalidBatches = this.database
        .prepare(
          `SELECT batch.batch_id
           FROM notification_batch AS batch
           WHERE batch.discord_user_id = ?
             AND batch.steam_id64 = ?
             AND batch.config_version = ?
             AND batch.status = 'failed'
             AND EXISTS (
               SELECT 1
               FROM notification_batch_item AS item
               JOIN notification_log AS notification
                 ON notification.discord_user_id = item.discord_user_id
                AND notification.config_version = item.config_version
                AND notification.app_id = item.app_id
                AND notification.sale_episode_id = item.sale_episode_id
               WHERE item.batch_id = batch.batch_id
                 AND NOT EXISTS (
                   SELECT 1 FROM wishlist_item_state AS state
                   WHERE state.discord_user_id = notification.discord_user_id
                     AND state.steam_id64 = notification.steam_id64
                     AND state.config_version = notification.config_version
                      AND state.app_id = notification.app_id
                      AND (state.on_sale = 1 OR state.rule_event_id IS NOT NULL)
                      AND (state.rule_event_id = notification.sale_episode_id OR (notification.reason = 'discount' AND state.sale_episode_id = notification.sale_episode_id))
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM wishlist_item_state AS deferred_state
                    WHERE deferred_state.discord_user_id = notification.discord_user_id
                      AND deferred_state.steam_id64 = notification.steam_id64
                      AND deferred_state.config_version = notification.config_version
                      AND deferred_state.app_id = notification.app_id
                      AND deferred_state.observation_status IN ('unknown', 'error')
                  )
              )`,
        )
        .all(
          scope.discordUserId,
          scope.steamId64,
          scope.configVersion,
        ) as Array<{ batch_id: SQLOutputValue }>;
      let expiredCount = 0;

      for (const row of invalidBatches) {
        const batchId = textValue(row.batch_id, 'batch_id');
        const items = this.database
          .prepare(
            `UPDATE notification_log AS notification
             SET status = 'expired',
                 next_attempt_at = NULL,
                 last_error = 'Sale episode is no longer active'
             WHERE status = 'failed'
               AND (notification.discord_user_id, notification.config_version,
                    notification.app_id, notification.sale_episode_id) IN (
                 SELECT item.discord_user_id, item.config_version, item.app_id, item.sale_episode_id
                 FROM notification_batch_item AS item
                 WHERE item.batch_id = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM wishlist_item_state AS state
                 WHERE state.discord_user_id = notification.discord_user_id
                   AND state.steam_id64 = notification.steam_id64
                   AND state.config_version = notification.config_version
                    AND state.app_id = notification.app_id
                    AND (state.on_sale = 1 OR state.rule_event_id IS NOT NULL)
                    AND (state.rule_event_id = notification.sale_episode_id OR (notification.reason = 'discount' AND state.sale_episode_id = notification.sale_episode_id))
                )
                AND NOT EXISTS (
                  SELECT 1 FROM wishlist_item_state AS deferred_state
                  WHERE deferred_state.discord_user_id = notification.discord_user_id
                    AND deferred_state.steam_id64 = notification.steam_id64
                    AND deferred_state.config_version = notification.config_version
                    AND deferred_state.app_id = notification.app_id
                    AND deferred_state.observation_status IN ('unknown', 'error')
                )`,
          )
          .run(batchId);
        expiredCount += Number(items.changes);
        this.database
          .prepare(
            `UPDATE notification_batch
             SET status = 'expired', next_attempt_at = NULL,
                 last_error = 'Batch retired because a sale episode is no longer active'
             WHERE batch_id = ? AND status = 'failed'`,
          )
          .run(batchId);
      }

      const unbatched = this.database
        .prepare(
          `UPDATE notification_log AS notification
           SET status = 'expired', next_attempt_at = NULL,
               last_error = 'Sale episode is no longer active'
           WHERE notification.discord_user_id = ?
             AND notification.steam_id64 = ?
             AND notification.config_version = ?
             AND notification.status IN ('candidate', 'failed')
             AND NOT EXISTS (
               SELECT 1 FROM notification_batch_item AS item
               JOIN notification_batch AS batch ON batch.batch_id = item.batch_id
               WHERE item.discord_user_id = notification.discord_user_id
                 AND item.config_version = notification.config_version
                 AND item.app_id = notification.app_id
                 AND item.sale_episode_id = notification.sale_episode_id
                 AND batch.status IN ('sending', 'failed')
             )
             AND NOT EXISTS (
               SELECT 1 FROM wishlist_item_state AS state
               WHERE state.discord_user_id = notification.discord_user_id
                 AND state.steam_id64 = notification.steam_id64
                 AND state.config_version = notification.config_version
                AND state.app_id = notification.app_id
                AND (state.on_sale = 1 OR state.rule_event_id IS NOT NULL)
                AND (state.rule_event_id = notification.sale_episode_id OR (notification.reason = 'discount' AND state.sale_episode_id = notification.sale_episode_id))
              )
              AND NOT EXISTS (
                SELECT 1 FROM wishlist_item_state AS deferred_state
                WHERE deferred_state.discord_user_id = notification.discord_user_id
                  AND deferred_state.steam_id64 = notification.steam_id64
                  AND deferred_state.config_version = notification.config_version
                  AND deferred_state.app_id = notification.app_id
                  AND deferred_state.observation_status IN ('unknown', 'error')
              )`,
        )
        .run(scope.discordUserId, scope.steamId64, scope.configVersion);
      expiredCount += Number(unbatched.changes);

      this.database.exec('COMMIT');
      return expiredCount;
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public findRetryableNotificationCandidates(
    scope: WishlistScope,
    now: string,
  ): NotificationCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT ${notificationColumns}
         FROM notification_log AS notification
         JOIN wishlist_item_state AS state
           ON state.discord_user_id = notification.discord_user_id
          AND state.steam_id64 = notification.steam_id64
          AND state.config_version = notification.config_version
          AND state.app_id = notification.app_id
          AND (state.rule_event_id = notification.sale_episode_id OR (notification.reason = 'discount' AND state.sale_episode_id = notification.sale_episode_id))
         WHERE notification.discord_user_id = ?
           AND notification.steam_id64 = ?
           AND notification.config_version = ?
            AND (
              notification.status = 'candidate'
              OR (notification.status = 'failed' AND notification.next_attempt_at <= ?)
            )
             AND (state.on_sale = 1 OR state.rule_event_id IS NOT NULL)
             AND state.observation_status = 'known'
            AND NOT EXISTS (
              SELECT 1 FROM notification_batch_item AS item
              JOIN notification_batch AS batch ON batch.batch_id = item.batch_id
              WHERE item.discord_user_id = notification.discord_user_id
                AND item.config_version = notification.config_version
                AND item.app_id = notification.app_id
                AND item.sale_episode_id = notification.sale_episode_id
                AND batch.status IN ('sending', 'failed')
            )
          ORDER BY notification.created_at ASC,
                   notification.app_id ASC,
                   notification.sale_episode_id COLLATE BINARY ASC`,
      )
      .all(
        scope.discordUserId,
        scope.steamId64,
        scope.configVersion,
        now,
      ) as unknown as NotificationLogRow[];

    return rows.map(toNotificationCandidate);
  }

  public markNotificationTerminal(
    candidate: NotificationCandidate,
    errorMessage: string,
  ): void {
    this.database
      .prepare(
        `UPDATE notification_log
         SET status = 'terminal_failed', next_attempt_at = NULL, last_error = ?
         WHERE discord_user_id = ? AND steam_id64 = ? AND config_version = ?
           AND app_id = ? AND sale_episode_id = ?
           AND status IN ('candidate', 'failed')`,
      )
      .run(
        errorMessage,
        candidate.discordUserId,
        candidate.steamId64,
        candidate.configVersion,
        candidate.appId,
        candidate.saleEpisodeId,
      );
  }

  public findNotificationStatus(
    candidate: Pick<
      NotificationCandidate,
      'discordUserId' | 'steamId64' | 'configVersion' | 'appId' | 'saleEpisodeId'
    >,
  ): string | null {
    const row = this.database
      .prepare(
        `SELECT status
         FROM notification_log
         WHERE discord_user_id = ? AND steam_id64 = ? AND config_version = ?
           AND app_id = ? AND sale_episode_id = ?`,
      )
      .get(
        candidate.discordUserId,
        candidate.steamId64,
        candidate.configVersion,
        candidate.appId,
        candidate.saleEpisodeId,
      ) as { status: SQLOutputValue } | undefined;

    return row ? textValue(row.status, 'status') : null;
  }
}
