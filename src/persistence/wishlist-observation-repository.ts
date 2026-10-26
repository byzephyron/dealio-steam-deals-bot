import { preparedStatement } from './prepared-statement.js';
import { AssistantRepository } from './assistant-repository.js';
import { discountAlertDue, retireWaitingDiscountAlert } from './alert-levels.js';
import { nextSteamPriceChange } from '../domain/steam-price-schedule.js';
// allow: SIZE_OK — Observation transitions, notification eligibility, and candidate creation form one atomic SQLite state machine.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
  NotificationCandidate,
  WishlistItemState,
  WishlistObservation,
  WishlistObservationStatus,
} from '../domain/wishlist-state.js';
import {
  integerValue,
  stateColumns,
  toState,
  type WishlistItemStateRow,
  type WishlistScope,
} from './wishlist-state-codecs.js';

/** How long a game must stay absent from the wishlist before its sale state is dropped. */
export const missingItemGraceMs = 20 * 60 * 1000;

export interface RecordObservationOptions {
  readonly baseline?: boolean;
}

export interface ObservationResult {
  readonly firstObservation: boolean;
  readonly notificationCandidate: NotificationCandidate | null;
}

export class WishlistObservationRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public runInImmediateTransaction<T>(operation: () => T): T {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }
    try {
      const result = operation();
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
      return result;
    } catch (error: unknown) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  public findByDiscordUserAndAppId(
    discordUserId: string,
    appId: number,
    configVersion?: number,
  ): WishlistItemState | null {
    const row = configVersion === undefined
      ? preparedStatement(this.database,
            `SELECT ${stateColumns}
             FROM wishlist_item_state
             WHERE discord_user_id = ? AND app_id = ?
             ORDER BY config_version DESC
             LIMIT 1`,
          )
          .get(discordUserId, appId)
      : preparedStatement(this.database,
            `SELECT ${stateColumns}
             FROM wishlist_item_state
             WHERE discord_user_id = ? AND config_version = ? AND app_id = ?`,
          )
          .get(discordUserId, configVersion, appId);

    return row ? toState(row as unknown as WishlistItemStateRow) : null;
  }

  public countNotificationCandidates(discordUserId: string, configVersion?: number): number {
    const row = configVersion === undefined
      ? preparedStatement(this.database,
            `SELECT COUNT(*) AS count
             FROM notification_log
             WHERE discord_user_id = ? AND status = 'candidate'`,
          )
          .get(discordUserId)
      : preparedStatement(this.database,
            `SELECT COUNT(*) AS count
             FROM notification_log
             WHERE discord_user_id = ? AND config_version = ? AND status = 'candidate'`,
          )
          .get(discordUserId, configVersion);

    return integerValue((row as { count: SQLOutputValue }).count, 'count');
  }

  public markMissingItemsInactive(
    scope: WishlistScope,
    seenAppIds: readonly number[],
    observedAt: string,
  ): number {
    const uniqueAppIds = [...new Set(seenAppIds)];
    const exclusion = uniqueAppIds.length > 0
      ? `AND app_id NOT IN (${uniqueAppIds.map(() => '?').join(', ')})`
      : '';
    const scopeValues = [scope.discordUserId, scope.steamId64, scope.configVersion] as const;
    // A game counts as gone only after it stayed absent through the grace period.
    // Steam sometimes leaves items out of one response (or returns an empty list);
    // ending the sale episode on that blip would re-send every ongoing sale later.
    const confirmedBefore = new Date(Date.parse(observedAt) - missingItemGraceMs).toISOString();
    const confirmed = preparedStatement(this.database,
        `UPDATE wishlist_item_state
         SET on_sale = 0,
             sale_episode_id = NULL,
             sale_started_at = NULL,
             sale_key = NULL,
             rule_event_id = NULL,
             -- A sale whose alert already went out ends when the game was last seen, so a
             -- game that comes back before the next price change does not alert again.
             sale_ended_at = CASE WHEN on_sale = 0 THEN sale_ended_at
               WHEN NOT EXISTS (SELECT 1 FROM notification_log AS notification
                 WHERE notification.discord_user_id = wishlist_item_state.discord_user_id
                   AND notification.config_version = wishlist_item_state.config_version
                   AND notification.app_id = wishlist_item_state.app_id
                   AND notification.sale_episode_id = wishlist_item_state.sale_episode_id
                   AND notification.status IN ('candidate', 'failed'))
               THEN last_seen_at END
         WHERE discord_user_id = ? AND steam_id64 = ? AND config_version = ?
           AND observation_status = 'missing' AND last_seen_at <= ?
           ${exclusion}`,
      )
      .run(...scopeValues, confirmedBefore, ...uniqueAppIds);
    // First absence: remember when it started (last_seen_at) and keep the sale state.
    const suspected = preparedStatement(this.database,
        `UPDATE wishlist_item_state
         SET observation_status = 'missing', last_seen_at = ?
         WHERE discord_user_id = ? AND steam_id64 = ? AND config_version = ?
           AND observation_status <> 'missing'
           ${exclusion}`,
      )
      .run(observedAt, ...scopeValues, ...uniqueAppIds);

    // Target rules restart only for games that are confirmed gone (or were never observed).
    preparedStatement(this.database,`UPDATE game_rule SET initialized=0,eligible=0,event_id=NULL
      WHERE discord_user_id=? AND config_version=? ${exclusion}
        AND NOT EXISTS (SELECT 1 FROM wishlist_item_state AS state
          WHERE state.discord_user_id=game_rule.discord_user_id AND state.config_version=game_rule.config_version
            AND state.app_id=game_rule.app_id AND state.observation_status='missing' AND state.last_seen_at>?)`)
      .run(scope.discordUserId,scope.configVersion,...uniqueAppIds,confirmedBefore);
    return Number(confirmed.changes) + Number(suspected.changes);
  }

  public markObservationStatus(
    scope: WishlistScope,
    appIds: readonly number[],
    status: Exclude<WishlistObservationStatus, 'known' | 'missing'>,
    observedAt: string,
  ): number {
    const uniqueAppIds = [...new Set(appIds)];
    if (uniqueAppIds.length === 0) {
      return 0;
    }
    const placeholders = uniqueAppIds.map(() => '?').join(', ');
    const result = preparedStatement(this.database,
      `UPDATE wishlist_item_state
       SET observation_status = ?, last_seen_at = ?
       WHERE discord_user_id = ? AND steam_id64 = ? AND config_version = ?
         AND app_id IN (${placeholders})`,
    ).run(
      status,
      observedAt,
      scope.discordUserId,
      scope.steamId64,
      scope.configVersion,
      ...uniqueAppIds,
    );
    return Number(result.changes);
  }

  public recordObservation(
    scope: WishlistScope,
    observation: WishlistObservation,
    options: RecordObservationOptions = {},
  ): ObservationResult {
    const { item, saleKey, observedAt } = observation;
    const assistant = new AssistantRepository(this.database);
    const rule = assistant.rule(scope, item.appId);
    const price = item.price;
    let notificationCandidate: NotificationCandidate | null = null;

    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }

    try {
      const existing = this.findByDiscordUserAndAppId(
        scope.discordUserId,
        item.appId,
        scope.configVersion,
      );
      const isFirstObservation = existing === null;
      const continuingSale = existing?.onSale === true && item.onSale === true;
      // Steam's store can answer one read with the price from before the daily change,
      // so a sale can seem to end and start again within minutes. Discounts change at
      // that hour, so a sale that comes back before the next change is the same sale:
      // it keeps its alert level and sends nothing unless it is clearly deeper.
      const endedSale = existing?.onSale === false && existing.saleEndedAt !== null
        && Date.parse(observedAt) < nextSteamPriceChange(new Date(existing.saleEndedAt)).getTime()
        ? existing : null;
      // Setup, a newly seen game and an explicit baseline check never alert for
      // what is already true; they only record where the sale stands.
      // A target that stops applying (its currency is gone) hands the game to the
      // discount rule; like any rule change, that starts from a baseline.
      const targetWasActive = rule?.mode === 'target' && rule.currency !== null && existing?.currency === rule.currency;
      const targetActiveNow = rule?.mode === 'target' && rule.currency !== null && rule.currency === price?.currency;
      const baseline = options.baseline === true || isFirstObservation || (targetWasActive && !targetActiveNow);
      let saleEpisodeId = item.onSale
        ? continuingSale
          ? existing.saleEpisodeId ?? randomUUID()
          : randomUUID()
        : null;
      const saleStartedAt = item.onSale
        ? continuingSale
          ? existing.saleStartedAt ?? observedAt
          : observedAt
        : null;
      // A target in the current currency replaces discount alerts; a target left in an
      // old currency (after a region change) falls back to the discount rule.
      const targetActive = targetActiveNow;
      const sale = item.onSale === true && saleKey !== null && price !== null && price.currency !== null
        && price.discountPercent > 0 && price.finalMinor < price.initialMinor ? price : null;
      const meetsRule = sale !== null && !rule?.muted && !targetActive
        && sale.discountPercent >= this.findEffectiveMinimumDiscount(scope, item.appId);
      let alertedDiscount = continuingSale
        ? existing.alertedDiscountPercent
        : item.onSale ? endedSale?.alertedDiscountPercent ?? null : null;
      const episodeStatus = (episodeId: string | null) => episodeId === null ? undefined : (preparedStatement(this.database,
          `SELECT status FROM notification_log
           WHERE discord_user_id = ? AND config_version = ? AND app_id = ? AND sale_episode_id = ?`,
        )
        .get(scope.discordUserId, scope.configVersion, item.appId, episodeId) as { status: string } | undefined)?.status;
      const isWaiting = (status: string | undefined) => status === 'candidate' || status === 'failed';
      const episodeAlert = episodeStatus(saleEpisodeId);
      const waitingAlert = isWaiting(episodeAlert);
      let saleEndedAt: string | null = null;
      if (!item.onSale && existing?.onSale === true) {
        // An alert still waiting never reached the user: a returning sale gets a new one.
        if (!isWaiting(episodeStatus(existing.saleEpisodeId))) {
          saleEndedAt = observedAt;
          alertedDiscount = existing.alertedDiscountPercent;
        }
      } else if (!item.onSale && endedSale) {
        saleEndedAt = endedSale.saleEndedAt;
        alertedDiscount = endedSale.alertedDiscountPercent;
      }
      let createAlert = false;
      if (sale && meetsRule) {
        if (baseline) {
          alertedDiscount = Math.max(alertedDiscount ?? sale.discountPercent, sale.discountPercent);
        } else if (waitingAlert) {
          // Not sent yet: the waiting alert simply carries the newer price.
          alertedDiscount = sale.discountPercent;
        } else if (discountAlertDue(sale.discountPercent, alertedDiscount)) {
          if (episodeAlert) {
            // This sale was already alerted and went clearly deeper: a new alert of its own.
            saleEpisodeId = randomUUID();
          }
          alertedDiscount = sale.discountPercent;
          createAlert = true;
        }
      } else if (waitingAlert && saleEpisodeId !== null) {
        retireWaitingDiscountAlert(this.database, scope, item.appId, saleEpisodeId, 'Rule no longer met');
      }

      preparedStatement(this.database,
           `INSERT INTO wishlist_item_state
             (discord_user_id, steam_id64, config_version, store_country_code, app_id, on_sale,
               sale_episode_id, sale_started_at, sale_key, currency,
               normal_price_minor, final_price_minor, discount_percent, last_seen_at,
                notification_eligible, observation_status, alerted_discount_percent, sale_ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', ?, ?)
           ON CONFLICT(discord_user_id, config_version, app_id) DO UPDATE SET
              steam_id64 = excluded.steam_id64,
              store_country_code = excluded.store_country_code,
              on_sale = excluded.on_sale,
             sale_episode_id = excluded.sale_episode_id,
             sale_started_at = excluded.sale_started_at,
             sale_key = excluded.sale_key,
             currency = excluded.currency,
             normal_price_minor = excluded.normal_price_minor,
             final_price_minor = excluded.final_price_minor,
             discount_percent = excluded.discount_percent,
              last_seen_at = excluded.last_seen_at,
               notification_eligible = excluded.notification_eligible,
               observation_status = 'known',
               alerted_discount_percent = excluded.alerted_discount_percent,
               sale_ended_at = excluded.sale_ended_at`,
        )
        .run(
          scope.discordUserId,
          scope.steamId64,
          scope.configVersion,
          scope.storeCountryCode,
          item.appId,
          item.onSale ? 1 : 0,
          saleEpisodeId,
          saleStartedAt,
          saleKey,
          price?.currency ?? null,
          price?.initialMinor ?? null,
          price?.finalMinor ?? null,
          price?.discountPercent ?? null,
          observedAt,
          !item.onSale || alertedDiscount === null ? 1 : 0,
          alertedDiscount,
          saleEndedAt,
        );

      if (sale && saleEpisodeId !== null && saleKey !== null && sale.currency !== null && (createAlert || (waitingAlert && meetsRule && !baseline))) {
        preparedStatement(this.database,
           `INSERT INTO notification_log
                (discord_user_id, steam_id64, config_version, store_country_code,
                 app_id, sale_episode_id,
                  sale_key, game_name, currency, normal_price_minor,
                  final_price_minor, discount_percent, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(discord_user_id, config_version, app_id, sale_episode_id)
               DO UPDATE SET
                 steam_id64 = excluded.steam_id64,
                 store_country_code = excluded.store_country_code,
                 sale_key = excluded.sale_key,
                 game_name = excluded.game_name,
                 currency = excluded.currency,
                 normal_price_minor = excluded.normal_price_minor,
                 final_price_minor = excluded.final_price_minor,
                 discount_percent = excluded.discount_percent
               WHERE notification_log.status IN ('candidate', 'failed')`,
          )
          .run(
            scope.discordUserId,
            scope.steamId64,
            scope.configVersion,
            scope.storeCountryCode,
            item.appId,
            saleEpisodeId,
            saleKey,
            item.name,
            sale.currency,
            sale.initialMinor,
            sale.finalMinor,
            sale.discountPercent,
            observedAt,
          );

        if (createAlert) {
          notificationCandidate = {
            discordUserId: scope.discordUserId,
            steamId64: scope.steamId64,
            configVersion: scope.configVersion,
            storeCountryCode: scope.storeCountryCode,
            appId: item.appId,
            saleEpisodeId,
            gameName: item.name,
            saleKey,
            currency: sale.currency,
            normalPriceMinor: sale.initialMinor,
            finalPriceMinor: sale.finalMinor,
            discountPercent: sale.discountPercent,
            attemptCount: 0,
            createdAt: observedAt,
          };
        }
      }

      notificationCandidate = assistant.observe(scope, item, observedAt, options.baseline) ?? notificationCandidate;
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
      return { firstObservation: isFirstObservation, notificationCandidate };
    } catch (error: unknown) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private findEffectiveMinimumDiscount(scope: WishlistScope, appId: number): number {
    const row = preparedStatement(this.database,
      `SELECT COALESCE(threshold.minimum_discount_percent, config.minimum_discount_percent)
         AS minimum_discount_percent
       FROM user_config AS config
       LEFT JOIN game_discount_threshold AS threshold
         ON threshold.discord_user_id = config.discord_user_id
        AND threshold.config_version = config.config_version
        AND threshold.app_id = ?
       WHERE config.discord_user_id = ? AND config.config_version = ?`,
    ).get(appId, scope.discordUserId, scope.configVersion) as
      | { minimum_discount_percent: SQLOutputValue }
      | undefined;
    const value = row?.minimum_discount_percent;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw new Error('Invalid effective minimum discount threshold');
    }
    return value;
  }
}
