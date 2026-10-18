import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { CheckState, CheckStatus } from '../domain/check-state.js';

const hiddenWishlistCode = 'STEAM_WISHLIST_INACCESSIBLE';

interface CheckStateRow {
  discord_user_id: SQLOutputValue;
  last_started_at: SQLOutputValue;
  last_completed_at: SQLOutputValue;
  last_status: SQLOutputValue;
  last_error_code: SQLOutputValue;
  next_scheduled_at: SQLOutputValue;
  last_success_completed_at: SQLOutputValue;
  last_success_checked_count: SQLOutputValue;
  last_success_on_sale_count: SQLOutputValue;
  last_success_free_count: SQLOutputValue;
  last_success_unknown_price_count: SQLOutputValue;
  last_success_failed_item_count: SQLOutputValue;
}

export interface SuccessfulCheckMetrics {
  readonly checkedCount: number;
  readonly onSaleCount: number;
  readonly freeCount: number;
  readonly unknownPriceCount: number;
  readonly failedItemCount: number;
}

function nullableText(value: SQLOutputValue, column: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid ${column} value in check_state`);
  }

  return value;
}

function nullableStatus(value: SQLOutputValue): CheckStatus | null {
  const status = nullableText(value, 'last_status');

  if (status === null) {
    return null;
  }

  if (!['pending', 'success', 'unavailable', 'failed'].includes(status)) {
    throw new Error('Invalid last_status value in check_state');
  }

  return status as CheckStatus;
}

function nullableCount(value: SQLOutputValue, column: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${column} value in check_state`);
  }
  return value;
}

function toCheckState(row: CheckStateRow): CheckState {
  if (typeof row.discord_user_id !== 'string') {
    throw new Error('Invalid discord_user_id value in check_state');
  }

  return {
    discordUserId: row.discord_user_id,
    lastStartedAt: nullableText(row.last_started_at, 'last_started_at'),
    lastCompletedAt: nullableText(row.last_completed_at, 'last_completed_at'),
    lastStatus: nullableStatus(row.last_status),
    lastErrorCode: nullableText(row.last_error_code, 'last_error_code'),
    nextScheduledAt: nullableText(row.next_scheduled_at, 'next_scheduled_at'),
    lastSuccessCompletedAt: nullableText(
      row.last_success_completed_at,
      'last_success_completed_at',
    ),
    lastSuccessCheckedCount: nullableCount(
      row.last_success_checked_count,
      'last_success_checked_count',
    ),
    lastSuccessOnSaleCount: nullableCount(
      row.last_success_on_sale_count,
      'last_success_on_sale_count',
    ),
    lastSuccessFreeCount: nullableCount(
      row.last_success_free_count,
      'last_success_free_count',
    ),
    lastSuccessUnknownPriceCount: nullableCount(
      row.last_success_unknown_price_count,
      'last_success_unknown_price_count',
    ),
    lastSuccessFailedItemCount: nullableCount(
      row.last_success_failed_item_count,
      'last_success_failed_item_count',
    ),
  };
}

export class CheckStateRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public findByDiscordUserId(discordUserId: string): CheckState | null {
    const row = this.database
      .prepare(
        `SELECT discord_user_id, last_started_at, last_completed_at, last_status,
                last_error_code, next_scheduled_at, last_success_completed_at,
                last_success_checked_count, last_success_on_sale_count,
                last_success_free_count, last_success_unknown_price_count,
                last_success_failed_item_count
         FROM check_state
         WHERE discord_user_id = ?`,
      )
      .get(discordUserId) as CheckStateRow | undefined;

    return row ? toCheckState(row) : null;
  }

  public markUnavailable(
    discordUserId: string,
    startedAt: string,
    completedAt: string,
    errorCode: string,
    configVersion: number,
  ): void {
    this.database
      .prepare(
        `UPDATE check_state
         SET last_started_at = ?,
             last_completed_at = ?,
             last_status = 'unavailable',
             last_error_code = ?,
             wishlist_hidden_checks = wishlist_hidden_checks
               + CASE WHEN ? = '${hiddenWishlistCode}' THEN 1 ELSE 0 END
          WHERE discord_user_id = ?
            AND EXISTS (
              SELECT 1 FROM user_config
              WHERE user_config.discord_user_id = check_state.discord_user_id
                AND user_config.config_version = ?
            )`,
      )
      .run(startedAt, completedAt, errorCode, errorCode, discordUserId, configVersion);
  }

  /**
   * Takes the hidden-wishlist DM for one attempt, recorded before Discord is called.
   * Only after `minimumChecks` consecutive "private" answers, never once it was
   * delivered in this hidden period, and a stale attempt (a crash or a failed send)
   * is retried after `retryAfterMs`, at most `maxAttempts` times.
   */
  public claimWishlistHiddenNotice(
    discordUserId: string,
    now: Date,
    limits: { readonly minimumChecks: number; readonly maxAttempts: number; readonly retryAfterMs: number },
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE check_state
         SET wishlist_hidden_notice_attempt_at = ?,
             wishlist_hidden_notice_attempts = wishlist_hidden_notice_attempts + 1
         WHERE discord_user_id = ?
           AND last_status = 'unavailable'
           AND last_error_code = '${hiddenWishlistCode}'
           AND wishlist_hidden_checks >= ?
           AND wishlist_hidden_notice_sent_at IS NULL
           AND wishlist_hidden_notice_attempts < ?
           AND (wishlist_hidden_notice_attempt_at IS NULL OR wishlist_hidden_notice_attempt_at <= ?)`,
      )
      .run(
        now.toISOString(),
        discordUserId,
        limits.minimumChecks,
        limits.maxAttempts,
        new Date(now.getTime() - limits.retryAfterMs).toISOString(),
      );
    return Number(result.changes) === 1;
  }

  public markWishlistHiddenNoticeSent(discordUserId: string, sentAt: string): void {
    this.database
      .prepare('UPDATE check_state SET wishlist_hidden_notice_sent_at = ? WHERE discord_user_id = ?')
      .run(sentAt, discordUserId);
  }

  /** Gives back an attempt that Discord only postponed (a rate limit). */
  public releaseWishlistHiddenNotice(discordUserId: string): void {
    this.database
      .prepare(
        `UPDATE check_state
         SET wishlist_hidden_notice_attempt_at = NULL,
             wishlist_hidden_notice_attempts = MAX(0, wishlist_hidden_notice_attempts - 1)
         WHERE discord_user_id = ? AND wishlist_hidden_notice_sent_at IS NULL`,
      )
      .run(discordUserId);
  }

  public markSuccess(
    discordUserId: string,
    startedAt: string,
    completedAt: string,
    configVersion: number,
    metrics: SuccessfulCheckMetrics,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE check_state
         SET last_started_at = ?,
              last_completed_at = ?,
              last_status = 'success',
              last_error_code = NULL,
              last_success_completed_at = ?,
              last_success_checked_count = ?,
              last_success_on_sale_count = ?,
              last_success_free_count = ?,
              last_success_unknown_price_count = ?,
              last_success_failed_item_count = ?,
              wishlist_hidden_checks = 0,
              wishlist_hidden_notice_attempt_at = NULL,
              wishlist_hidden_notice_attempts = 0,
              wishlist_hidden_notice_sent_at = NULL
          WHERE discord_user_id = ?
            AND EXISTS (
              SELECT 1 FROM user_config
              WHERE user_config.discord_user_id = check_state.discord_user_id
                AND user_config.config_version = ?
            )`,
      )
      .run(
        startedAt,
        completedAt,
        completedAt,
        metrics.checkedCount,
        metrics.onSaleCount,
        metrics.freeCount,
        metrics.unknownPriceCount,
        metrics.failedItemCount,
        discordUserId,
        configVersion,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('Successful check belongs to a stale user configuration');
    }
  }

  public markFailed(
    discordUserId: string,
    startedAt: string,
    completedAt: string,
    errorCode: string,
    configVersion: number,
  ): void {
    this.database
      .prepare(
        `UPDATE check_state
         SET last_started_at = ?,
             last_completed_at = ?,
             last_status = 'failed',
             last_error_code = ?
         WHERE discord_user_id = ?
           AND EXISTS (
             SELECT 1 FROM user_config
             WHERE user_config.discord_user_id = check_state.discord_user_id
               AND user_config.config_version = ?
           )`,
      )
      .run(startedAt, completedAt, errorCode, discordUserId, configVersion);
  }
}
