import type { SQLOutputValue } from 'node:sqlite';
import { isLanguage, type Language, type UserConfig } from '../domain/user-config.js';
import {
  parseStoreCountryCode,
  type StoreCountryCode,
} from '../domain/store-country.js';
import type {
  NotificationCandidate,
  WishlistItemState,
  WishlistObservationStatus,
} from '../domain/wishlist-state.js';

export type WishlistScope = Pick<
  UserConfig,
  'discordUserId' | 'steamId64' | 'configVersion' | 'storeCountryCode'
>;

export interface WishlistItemStateRow {
  discord_user_id: SQLOutputValue;
  steam_id64: SQLOutputValue;
  config_version: SQLOutputValue;
  store_country_code: SQLOutputValue;
  app_id: SQLOutputValue;
  on_sale: SQLOutputValue;
  sale_episode_id: SQLOutputValue;
  sale_started_at: SQLOutputValue;
  sale_key: SQLOutputValue;
  currency: SQLOutputValue;
  normal_price_minor: SQLOutputValue;
  final_price_minor: SQLOutputValue;
  discount_percent: SQLOutputValue;
  last_seen_at: SQLOutputValue;
  observation_status: SQLOutputValue;
  alerted_discount_percent: SQLOutputValue;
  sale_ended_at: SQLOutputValue;
}

export interface NotificationLogRow {
  reason: SQLOutputValue;
  discord_user_id: SQLOutputValue;
  steam_id64: SQLOutputValue;
  config_version: SQLOutputValue;
  store_country_code: SQLOutputValue;
  app_id: SQLOutputValue;
  sale_episode_id: SQLOutputValue;
  sale_key: SQLOutputValue;
  game_name: SQLOutputValue;
  currency: SQLOutputValue;
  normal_price_minor: SQLOutputValue;
  final_price_minor: SQLOutputValue;
  discount_percent: SQLOutputValue;
  attempt_count: SQLOutputValue;
  created_at: SQLOutputValue;
}

export interface NotificationBatchRow {
  batch_id: SQLOutputValue;
  language: SQLOutputValue;
  attempt_count: SQLOutputValue;
  member_count: SQLOutputValue;
}

export function textValue(value: SQLOutputValue, column: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${column} value in wishlist state`);
  }

  return value;
}

export function nullableText(value: SQLOutputValue, column: string): string | null {
  return value === null ? null : textValue(value, column);
}

export function integerValue(value: SQLOutputValue, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${column} value in wishlist state`);
  }

  return value;
}

export function languageValue(value: SQLOutputValue): Language {
  const language = textValue(value, 'language');
  if (!isLanguage(language)) {
    throw new Error('Invalid language value in notification batch');
  }

  return language;
}

export function nullableInteger(value: SQLOutputValue, column: string): number | null {
  return value === null ? null : integerValue(value, column);
}

export function storeCountryCodeValue(value: SQLOutputValue): StoreCountryCode {
  const code = parseStoreCountryCode(textValue(value, 'store_country_code'));
  if (!code) {
    throw new Error('Invalid store_country_code value in wishlist state');
  }
  return code;
}

export function observationStatusValue(value: SQLOutputValue): WishlistObservationStatus {
  const status = textValue(value, 'observation_status');
  if (!['known', 'unknown', 'error', 'missing'].includes(status)) {
    throw new Error('Invalid observation_status value in wishlist state');
  }
  return status as WishlistObservationStatus;
}

export function toState(row: WishlistItemStateRow): WishlistItemState {
  const onSale = integerValue(row.on_sale, 'on_sale');
  if (onSale !== 0 && onSale !== 1) {
    throw new Error('Invalid on_sale value in wishlist state');
  }

  return {
    discordUserId: textValue(row.discord_user_id, 'discord_user_id'),
    steamId64: textValue(row.steam_id64, 'steam_id64'),
    configVersion: integerValue(row.config_version, 'config_version'),
    storeCountryCode: storeCountryCodeValue(row.store_country_code),
    appId: integerValue(row.app_id, 'app_id'),
    onSale: onSale === 1,
    saleEpisodeId: nullableText(row.sale_episode_id, 'sale_episode_id'),
    saleStartedAt: nullableText(row.sale_started_at, 'sale_started_at'),
    saleKey: nullableText(row.sale_key, 'sale_key'),
    currency: nullableText(row.currency, 'currency'),
    normalPriceMinor: nullableInteger(row.normal_price_minor, 'normal_price_minor'),
    finalPriceMinor: nullableInteger(row.final_price_minor, 'final_price_minor'),
    discountPercent: nullableInteger(row.discount_percent, 'discount_percent'),
    lastSeenAt: textValue(row.last_seen_at, 'last_seen_at'),
    observationStatus: observationStatusValue(row.observation_status),
    alertedDiscountPercent: nullableInteger(row.alerted_discount_percent, 'alerted_discount_percent'),
    saleEndedAt: nullableText(row.sale_ended_at, 'sale_ended_at'),
  };
}

export function toNotificationCandidate(row: NotificationLogRow): NotificationCandidate {
  return {
    ...(row.reason && row.reason !== 'discount' ? {reason:textValue(row.reason,'reason')}:{}),
    discordUserId: textValue(row.discord_user_id, 'discord_user_id'),
    steamId64: textValue(row.steam_id64, 'steam_id64'),
    configVersion: integerValue(row.config_version, 'config_version'),
    storeCountryCode: storeCountryCodeValue(row.store_country_code),
    appId: integerValue(row.app_id, 'app_id'),
    saleEpisodeId: textValue(row.sale_episode_id, 'sale_episode_id'),
    gameName: textValue(row.game_name, 'game_name'),
    saleKey: textValue(row.sale_key, 'sale_key'),
    currency: textValue(row.currency, 'currency'),
    normalPriceMinor: integerValue(row.normal_price_minor, 'normal_price_minor'),
    finalPriceMinor: integerValue(row.final_price_minor, 'final_price_minor'),
    discountPercent: integerValue(row.discount_percent, 'discount_percent'),
    attemptCount: integerValue(row.attempt_count, 'attempt_count'),
    createdAt: textValue(row.created_at, 'created_at'),
  };
}

export const stateColumns = `discord_user_id, steam_id64, config_version, store_country_code, app_id, on_sale,
  sale_episode_id, sale_started_at, sale_key, currency, normal_price_minor,
  final_price_minor, discount_percent, last_seen_at, observation_status, alerted_discount_percent, sale_ended_at`;

export const notificationColumns = `
  notification.discord_user_id AS discord_user_id,
  notification.steam_id64 AS steam_id64,
  notification.config_version AS config_version,
  notification.store_country_code AS store_country_code,
  notification.app_id AS app_id,
  notification.sale_episode_id AS sale_episode_id,
  notification.sale_key AS sale_key,
  notification.game_name AS game_name,
  notification.currency AS currency,
  notification.normal_price_minor AS normal_price_minor,
  notification.final_price_minor AS final_price_minor,
  notification.discount_percent AS discount_percent,
  notification.attempt_count AS attempt_count,
  notification.created_at AS created_at,
  notification.reason AS reason`;
