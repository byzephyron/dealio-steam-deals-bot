import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { steamArtworkUrl } from '../domain/steam-artwork.js';
import { preparedStatement } from './prepared-statement.js';

/**
 * Read-only aggregates for the owner's admin panel. Every query is scoped to each
 * user's current configuration generation, like the user-facing panels.
 */

export interface AdminUserRow {
  readonly discordUserId: string;
  readonly steamId64: string;
  readonly language: string;
  readonly storeCountryCode: string;
  readonly enabled: boolean;
  readonly minimumDiscountPercent: number;
  readonly dmDeliveryBlockedAt: string | null;
  readonly dmDeliveryErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastCheckStatus: string | null;
  readonly lastCheckErrorCode: string | null;
  readonly lastCheckCompletedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly wishlistCount: number | null;
  readonly onSaleCount: number;
  readonly ruleCount: number;
  readonly mutedCount: number;
  readonly notificationMode: string;
  readonly alertsSent: number;
  readonly lastAlertAt: string | null;
  readonly pendingAlerts: number;
  /** The latest finished delivery: an alert that reached the user, or one that finally failed. */
  readonly lastDelivery: {
    readonly status: 'sent' | 'terminal_failed';
    readonly at: string;
    readonly error: string | null;
  } | null;
}

export interface CountRow { readonly key: string; readonly count: number }
export interface DayCount { readonly day: string; readonly count: number }

export interface AdminOverviewCounts {
  readonly users: number;
  readonly enabled: number;
  readonly paused: number;
  readonly dmBlocked: number;
  readonly newUsers24h: number;
  readonly newUsers7d: number;
  readonly alertsSent24h: number;
  readonly alertsSent7d: number;
  readonly alertsSentTotal: number;
  readonly queuePending: number;
  readonly queueRetry: number;
  readonly queueSending: number;
  readonly terminalFailed7d: number;
  readonly rules: number;
}

export interface AdminWishlistGameCounts {
  readonly trackedGames: number;
  readonly gamesOnSale: number;
}

export interface AdminGameRow {
  readonly appId: number;
  readonly name: string;
  readonly count: number;
  readonly maxDiscountPercent?: number | null;
}

export interface AdminNotificationRow {
  readonly appId: number;
  readonly gameName: string;
  readonly status: string;
  readonly reason: string;
  readonly currency: string;
  readonly normalPriceMinor: number;
  readonly finalPriceMinor: number;
  readonly discountPercent: number;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly lastError: string | null;
  readonly storeCountryCode: string;
}

export interface AdminCheckState {
  readonly lastStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly lastStatus: string | null;
  readonly lastErrorCode: string | null;
  readonly nextScheduledAt: string | null;
  readonly lastSuccessCompletedAt: string | null;
  readonly lastSuccessCheckedCount: number | null;
  readonly lastSuccessOnSaleCount: number | null;
  readonly lastSuccessFreeCount: number | null;
  readonly lastSuccessUnknownPriceCount: number | null;
  readonly lastSuccessFailedItemCount: number | null;
}

type Row = Record<string, SQLOutputValue>;

function text(value: SQLOutputValue): string {
  return typeof value === 'string' ? value : String(value ?? '');
}
function textOrNull(value: SQLOutputValue): string | null {
  return value === null || value === undefined ? null : text(value);
}
function int(value: SQLOutputValue): number {
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0;
}
function intOrNull(value: SQLOutputValue): number | null {
  return value === null || value === undefined ? null : int(value);
}
/** `[status, at, error]` from json_array in users(). */
function lastDelivery(value: SQLOutputValue): AdminUserRow['lastDelivery'] {
  if (typeof value !== 'string') return null;
  const [status, at, error] = JSON.parse(value) as [unknown, unknown, unknown];
  if ((status !== 'sent' && status !== 'terminal_failed') || typeof at !== 'string') return null;
  return { status, at, error: typeof error === 'string' ? error : null };
}

/** What the admin panel reads from the stored wishlist snapshots. */
interface SnapshotCatalog {
  /** Changes whenever a snapshot or a user's configuration generation does. */
  readonly fingerprint: string;
  /** Steam's localized title per game, from the current generation's snapshots. */
  readonly names: ReadonlyMap<number, string>;
  /** Steam's stored artwork per game, from any snapshot. */
  readonly artwork: ReadonlyMap<number, string>;
  /** Games on each user's latest current-generation snapshot. */
  readonly wishlistCounts: ReadonlyMap<string, number>;
  /** Users with each game on a current-generation snapshot. */
  readonly wishlistedBy: ReadonlyMap<number, number>;
}

interface SnapshotItem { readonly appId?: unknown; readonly name?: unknown; readonly headerImageUrl?: unknown }

/** Larger of two names in SQLite's BINARY order, as MAX(name) picked them before. */
function laterName(current: string | undefined, candidate: string): string {
  return current === undefined || candidate > current ? candidate : current;
}

/** `ORDER BY count DESC, name`. */
function byCountThenName<T extends { readonly count: number; readonly name: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => right.count - left.count || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export class AdminRepository {
  private catalog: SnapshotCatalog | null = null;

  public constructor(private readonly database: DatabaseSync) {}

  public schemaVersion(): number {
    return int((this.database.prepare('PRAGMA user_version').get() as Row).user_version);
  }

  public overviewCounts(now: Date = new Date()): AdminOverviewCounts {
    const day = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const week = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
    const users = this.database.prepare(`
      SELECT COUNT(*) AS users,
             COUNT(CASE WHEN enabled = 1 THEN 1 END) AS enabled,
             COUNT(CASE WHEN enabled = 0 AND dm_delivery_blocked_at IS NULL THEN 1 END) AS paused,
             COUNT(CASE WHEN dm_delivery_blocked_at IS NOT NULL THEN 1 END) AS dm_blocked,
             COUNT(CASE WHEN created_at >= ? THEN 1 END) AS new_24h,
             COUNT(CASE WHEN created_at >= ? THEN 1 END) AS new_7d
      FROM user_config`).get(day, week) as Row;
    const alerts = this.database.prepare(`
      SELECT COUNT(CASE WHEN n.status = 'sent' AND COALESCE(n.delivered_at, n.last_attempt_at) >= ? THEN 1 END) AS sent_24h,
             COUNT(CASE WHEN n.status = 'sent' AND COALESCE(n.delivered_at, n.last_attempt_at) >= ? THEN 1 END) AS sent_7d,
             COUNT(CASE WHEN n.status = 'sent' THEN 1 END) AS sent_total,
             COUNT(CASE WHEN n.status = 'candidate' THEN 1 END) AS pending,
             COUNT(CASE WHEN n.status = 'failed' THEN 1 END) AS retry,
             COUNT(CASE WHEN n.status = 'sending' THEN 1 END) AS sending,
             COUNT(CASE WHEN n.status = 'terminal_failed' AND COALESCE(n.last_attempt_at, n.created_at) >= ? THEN 1 END)
               AS terminal_7d
      FROM notification_log AS n
      JOIN user_config AS config
        ON config.discord_user_id = n.discord_user_id
       AND config.config_version = n.config_version`).get(day, week, week) as Row;
    const rules = this.database.prepare(`
      SELECT COUNT(*) AS rules FROM game_rule AS rule
      JOIN user_config AS config
        ON config.discord_user_id = rule.discord_user_id AND config.config_version = rule.config_version
      WHERE rule.mode != 'inherit' OR rule.muted = 1`).get() as Row;
    return {
      users: int(users.users),
      enabled: int(users.enabled),
      paused: int(users.paused),
      dmBlocked: int(users.dm_blocked),
      newUsers24h: int(users.new_24h),
      newUsers7d: int(users.new_7d),
      alertsSent24h: int(alerts.sent_24h),
      alertsSent7d: int(alerts.sent_7d),
      alertsSentTotal: int(alerts.sent_total),
      queuePending: int(alerts.pending),
      queueRetry: int(alerts.retry),
      queueSending: int(alerts.sending),
      terminalFailed7d: int(alerts.terminal_7d),
      rules: int(rules.rules),
    };
  }

  /** Distinct games on current wishlists, and those on sale. Reads every wishlist item. */
  public wishlistGameCounts(): AdminWishlistGameCounts {
    const games = this.database.prepare(`
      SELECT COUNT(DISTINCT state.app_id) AS tracked,
             COUNT(DISTINCT CASE WHEN state.on_sale = 1 THEN state.app_id END) AS on_sale
      FROM wishlist_item_state AS state
      JOIN user_config AS config
        ON config.discord_user_id = state.discord_user_id
       AND config.config_version = state.config_version
      WHERE state.observation_status != 'missing'`).get() as Row;
    return { trackedGames: int(games.tracked), gamesOnSale: int(games.on_sale) };
  }

  /** New configurations per UTC day; deleted users are no longer counted. */
  public signupsByDay(days: number, now: Date = new Date()): DayCount[] {
    const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString();
    return this.dayCounts(`
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
      FROM user_config WHERE created_at >= ? GROUP BY day ORDER BY day`, since);
  }

  public alertsByDay(days: number, now: Date = new Date()): DayCount[] {
    const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString();
    return this.dayCounts(`
      SELECT substr(COALESCE(delivered_at, last_attempt_at), 1, 10) AS day, COUNT(*) AS count
      FROM notification_log
      WHERE status = 'sent' AND COALESCE(delivered_at, last_attempt_at) >= ?
      GROUP BY day ORDER BY day`, since);
  }

  public distribution(column: 'store_country_code' | 'language'): CountRow[] {
    return (this.database.prepare(`
      SELECT ${column} AS key, COUNT(*) AS count FROM user_config GROUP BY key ORDER BY count DESC, key`)
      .all() as Row[]).map((row) => ({ key: text(row.key), count: int(row.count) }));
  }

  public notificationModes(): CountRow[] {
    return (this.database.prepare(`
      SELECT COALESCE(preference.mode, 'instant') AS key, COUNT(*) AS count
      FROM user_config AS config
      LEFT JOIN notification_preference AS preference ON preference.discord_user_id = config.discord_user_id
      GROUP BY key ORDER BY count DESC`).all() as Row[])
      .map((row) => ({ key: text(row.key), count: int(row.count) }));
  }

  public checkStatuses(): CountRow[] {
    return (this.database.prepare(`
      SELECT COALESCE(state.last_status, 'never') AS key, COUNT(*) AS count
      FROM user_config AS config
      LEFT JOIN check_state AS state ON state.discord_user_id = config.discord_user_id
      GROUP BY key ORDER BY count DESC`).all() as Row[])
      .map((row) => ({ key: text(row.key), count: int(row.count) }));
  }

  public checkErrorCodes(): CountRow[] {
    return (this.database.prepare(`
      SELECT last_error_code AS key, COUNT(*) AS count FROM check_state
      WHERE last_error_code IS NOT NULL AND last_status IN ('unavailable', 'failed')
      GROUP BY key ORDER BY count DESC`).all() as Row[])
      .map((row) => ({ key: text(row.key), count: int(row.count) }));
  }

  /** Every user, newest first; with an ID, only that user. */
  public users(discordUserId?: string): AdminUserRow[] {
    const wishlistCounts = this.snapshotCatalog().wishlistCounts;
    return (preparedStatement(this.database, `
      SELECT config.discord_user_id, config.steam_id64, config.language, config.store_country_code,
             config.enabled, config.minimum_discount_percent, config.dm_delivery_blocked_at,
             config.dm_delivery_error_code, config.created_at, config.updated_at,
             state.last_status, state.last_error_code, state.last_completed_at,
             state.last_success_completed_at, state.last_success_checked_count,
             (SELECT COUNT(*) FROM wishlist_item_state AS item
               WHERE item.discord_user_id = config.discord_user_id
                 AND item.config_version = config.config_version AND item.on_sale = 1) AS on_sale_count,
             (SELECT COUNT(*) FROM game_rule AS rule
               WHERE rule.discord_user_id = config.discord_user_id
                 AND rule.config_version = config.config_version AND rule.mode != 'inherit') AS rule_count,
             (SELECT COUNT(*) FROM game_rule AS rule
               WHERE rule.discord_user_id = config.discord_user_id
                 AND rule.config_version = config.config_version AND rule.muted = 1) AS muted_count,
             COALESCE((SELECT mode FROM notification_preference AS preference
               WHERE preference.discord_user_id = config.discord_user_id), 'instant') AS notification_mode,
             (SELECT COUNT(*) FROM notification_log AS notification
               WHERE notification.discord_user_id = config.discord_user_id AND notification.status = 'sent') AS alerts_sent,
             (SELECT MAX(COALESCE(notification.delivered_at, notification.last_attempt_at)) FROM notification_log AS notification
               WHERE notification.discord_user_id = config.discord_user_id AND notification.status = 'sent') AS last_alert_at,
             (SELECT COUNT(*) FROM notification_log AS notification
               WHERE notification.discord_user_id = config.discord_user_id
                 AND notification.config_version = config.config_version
                 AND notification.status IN ('candidate', 'failed', 'sending')) AS pending_alerts,
             (SELECT json_array(notification.status,
                       COALESCE(notification.delivered_at, notification.last_attempt_at, notification.created_at),
                       notification.last_error)
               FROM notification_log AS notification
               WHERE notification.discord_user_id = config.discord_user_id
                 AND notification.status IN ('sent', 'terminal_failed')
               ORDER BY COALESCE(notification.delivered_at, notification.last_attempt_at, notification.created_at) DESC
               LIMIT 1) AS last_delivery
      FROM user_config AS config
      LEFT JOIN check_state AS state ON state.discord_user_id = config.discord_user_id
      WHERE ?1 IS NULL OR config.discord_user_id = ?1
      ORDER BY config.created_at DESC`).all(discordUserId ?? null) as Row[]).map((row) => ({
      discordUserId: text(row.discord_user_id),
      steamId64: text(row.steam_id64),
      language: text(row.language),
      storeCountryCode: text(row.store_country_code),
      enabled: int(row.enabled) === 1,
      minimumDiscountPercent: int(row.minimum_discount_percent),
      dmDeliveryBlockedAt: textOrNull(row.dm_delivery_blocked_at),
      dmDeliveryErrorCode: textOrNull(row.dm_delivery_error_code),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      lastCheckStatus: textOrNull(row.last_status),
      lastCheckErrorCode: textOrNull(row.last_error_code),
      lastCheckCompletedAt: textOrNull(row.last_completed_at),
      lastSuccessAt: textOrNull(row.last_success_completed_at),
      wishlistCount: wishlistCounts.get(text(row.discord_user_id)) ?? intOrNull(row.last_success_checked_count),
      onSaleCount: int(row.on_sale_count),
      ruleCount: int(row.rule_count),
      mutedCount: int(row.muted_count),
      notificationMode: text(row.notification_mode),
      alertsSent: int(row.alerts_sent),
      lastAlertAt: textOrNull(row.last_alert_at),
      pendingAlerts: int(row.pending_alerts),
      lastDelivery: lastDelivery(row.last_delivery),
    }));
  }

  public checkState(discordUserId: string): AdminCheckState | null {
    const row = preparedStatement(this.database, 'SELECT * FROM check_state WHERE discord_user_id = ?')
      .get(discordUserId) as Row | undefined;
    if (!row) return null;
    return {
      lastStartedAt: textOrNull(row.last_started_at),
      lastCompletedAt: textOrNull(row.last_completed_at),
      lastStatus: textOrNull(row.last_status),
      lastErrorCode: textOrNull(row.last_error_code),
      nextScheduledAt: textOrNull(row.next_scheduled_at),
      lastSuccessCompletedAt: textOrNull(row.last_success_completed_at),
      lastSuccessCheckedCount: intOrNull(row.last_success_checked_count),
      lastSuccessOnSaleCount: intOrNull(row.last_success_on_sale_count),
      lastSuccessFreeCount: intOrNull(row.last_success_free_count),
      lastSuccessUnknownPriceCount: intOrNull(row.last_success_unknown_price_count),
      lastSuccessFailedItemCount: intOrNull(row.last_success_failed_item_count),
    };
  }

  public notifications(discordUserId: string, limit: number): AdminNotificationRow[] {
    return (preparedStatement(this.database, `
      SELECT app_id, game_name, status, reason, currency, normal_price_minor, final_price_minor,
             discount_percent, attempt_count, created_at, last_attempt_at, delivered_at, last_error,
             store_country_code
      FROM notification_log WHERE discord_user_id = ?
      ORDER BY created_at DESC LIMIT ?`).all(discordUserId, limit) as Row[]).map((row) => ({
      appId: int(row.app_id),
      gameName: text(row.game_name),
      status: text(row.status),
      reason: text(row.reason),
      currency: text(row.currency),
      normalPriceMinor: int(row.normal_price_minor),
      finalPriceMinor: int(row.final_price_minor),
      discountPercent: int(row.discount_percent),
      attemptCount: int(row.attempt_count),
      createdAt: text(row.created_at),
      lastAttemptAt: textOrNull(row.last_attempt_at),
      deliveredAt: textOrNull(row.delivered_at),
      lastError: textOrNull(row.last_error),
      storeCountryCode: text(row.store_country_code),
    }));
  }

  /**
   * Steam's own artwork URL per game, as the wishlist reads stored it. Newer games keep
   * their art under a hashed folder that a URL built from the app ID cannot reach.
   */
  public gameArtwork(): ReadonlyMap<number, string> {
    return this.snapshotCatalog().artwork;
  }

  /** Games on the most current wishlists. */
  public topWishlistedGames(limit: number): AdminGameRow[] {
    const { names, wishlistedBy } = this.snapshotCatalog();
    return byCountThenName([...wishlistedBy].map(([appId, count]) => ({ appId, name: names.get(appId) ?? `#${appId}`, count })))
      .slice(0, limit);
  }

  /** Games on sale right now for the most users, with the deepest discount seen. */
  public topGamesOnSale(limit: number): AdminGameRow[] {
    const { names } = this.snapshotCatalog();
    return (this.database.prepare(`
      SELECT state.app_id, COUNT(DISTINCT state.discord_user_id) AS count, MAX(state.discount_percent) AS max_discount
      FROM wishlist_item_state AS state
      JOIN user_config AS config
        ON config.discord_user_id = state.discord_user_id AND config.config_version = state.config_version
      WHERE state.on_sale = 1
      GROUP BY state.app_id ORDER BY count DESC, max_discount DESC LIMIT ?`).all(limit) as Row[])
      .map((row) => ({
        appId: int(row.app_id), name: names.get(int(row.app_id)) ?? `#${int(row.app_id)}`, count: int(row.count),
        maxDiscountPercent: intOrNull(row.max_discount),
      }));
  }

  public topAlertedGames(days: number, limit: number, now: Date = new Date()): AdminGameRow[] {
    const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString();
    return (this.database.prepare(`
      SELECT app_id, MAX(game_name) AS name, COUNT(*) AS count, MAX(discount_percent) AS max_discount
      FROM notification_log WHERE status = 'sent' AND COALESCE(delivered_at, last_attempt_at) >= ?
      GROUP BY app_id ORDER BY count DESC, name LIMIT ?`).all(since, limit) as Row[])
      .map((row) => ({
        appId: int(row.app_id), name: text(row.name), count: int(row.count),
        maxDiscountPercent: intOrNull(row.max_discount),
      }));
  }

  public topRuledGames(limit: number): Array<AdminGameRow & { readonly muted: number; readonly targets: number }> {
    const { names } = this.snapshotCatalog();
    // Ties are ordered by name, which only the catalog knows: rank every ruled game here.
    return byCountThenName((this.database.prepare(`
      SELECT rule.app_id, COUNT(*) AS count,
             COUNT(CASE WHEN rule.muted = 1 THEN 1 END) AS muted,
             COUNT(CASE WHEN rule.mode = 'target' THEN 1 END) AS targets
      FROM game_rule AS rule
      JOIN user_config AS config
        ON config.discord_user_id = rule.discord_user_id AND config.config_version = rule.config_version
      WHERE rule.mode != 'inherit' OR rule.muted = 1
      GROUP BY rule.app_id`).all() as Row[])
      .map((row) => ({
        appId: int(row.app_id), name: names.get(int(row.app_id)) ?? `#${int(row.app_id)}`, count: int(row.count),
        muted: int(row.muted), targets: int(row.targets),
      }))).slice(0, limit);
  }

  public currencies(): CountRow[] {
    return (this.database.prepare(`
      SELECT state.currency AS key, COUNT(DISTINCT state.discord_user_id) AS count
      FROM wishlist_item_state AS state
      JOIN user_config AS config
        ON config.discord_user_id = state.discord_user_id AND config.config_version = state.config_version
      WHERE state.currency IS NOT NULL AND state.observation_status = 'known'
      GROUP BY key ORDER BY count DESC`).all() as Row[])
      .map((row) => ({ key: text(row.key), count: int(row.count) }));
  }

  /**
   * Reads every snapshot payload in one pass, and again only after a snapshot or a
   * configuration generation changed. Parsing the JSON in SQL for each request took
   * seconds with a few thousand wishlists, and held the bot's event loop meanwhile.
   */
  private snapshotCatalog(): SnapshotCatalog {
    const fingerprint = text((preparedStatement(this.database, `
      SELECT (SELECT COUNT(*) || '/' || COALESCE(MAX(captured_at), '') FROM wishlist_snapshot)
          || '/' || (SELECT COUNT(*) || '/' || COALESCE(SUM(config_version), 0) FROM user_config) AS fingerprint`)
      .get() as Row).fingerprint);
    if (this.catalog?.fingerprint === fingerprint) return this.catalog;

    const generations = new Map((preparedStatement(this.database, 'SELECT discord_user_id, config_version FROM user_config')
      .all() as Row[]).map((row) => [text(row.discord_user_id), int(row.config_version)]));
    const names = new Map<number, string>();
    const urls = new Map<number, string>();
    const wishlistCounts = new Map<string, number>();
    const latest = new Map<string, string>();
    const wishlistedBy = new Map<number, number>();
    let user: string | null = null;
    let userGames = new Set<number>();
    const countUserGames = (): void => {
      for (const appId of userGames) wishlistedBy.set(appId, (wishlistedBy.get(appId) ?? 0) + 1);
      userGames = new Set();
    };
    // Ordered by user so each user's games (one snapshot per language) count once.
    for (const row of this.database.prepare(`
      SELECT discord_user_id, config_version, captured_at, payload FROM wishlist_snapshot ORDER BY discord_user_id`)
      .iterate() as Iterable<Row>) {
      const id = text(row.discord_user_id);
      if (id !== user) {
        countUserGames();
        user = id;
      }
      let items: unknown;
      try {
        items = (JSON.parse(text(row.payload)) as { items?: unknown }).items;
      } catch {
        continue;
      }
      if (!Array.isArray(items)) continue;
      const current = generations.get(id) === int(row.config_version);
      const capturedAt = text(row.captured_at);
      if (current && capturedAt >= (latest.get(id) ?? '')) {
        latest.set(id, capturedAt);
        wishlistCounts.set(id, items.length);
      }
      for (const item of items as SnapshotItem[]) {
        if (typeof item !== 'object' || item === null || !Number.isInteger(item.appId)) continue;
        const appId = item.appId as number;
        if (typeof item.headerImageUrl === 'string') urls.set(appId, laterName(urls.get(appId), item.headerImageUrl));
        if (!current) continue;
        userGames.add(appId);
        if (typeof item.name === 'string') names.set(appId, laterName(names.get(appId), item.name));
      }
    }
    countUserGames();

    const artwork = new Map<number, string>();
    for (const [appId, url] of urls) {
      const checked = steamArtworkUrl(url, appId);
      if (checked) artwork.set(appId, checked);
    }
    this.catalog = { fingerprint, names, artwork, wishlistCounts, wishlistedBy };
    return this.catalog;
  }

  private dayCounts(sql: string, since: string): DayCount[] {
    return (this.database.prepare(sql).all(since) as Row[])
      .map((row) => ({ day: text(row.day), count: int(row.count) }));
  }
}
