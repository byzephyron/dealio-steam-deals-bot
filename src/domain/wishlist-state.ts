import type { HistoricalLow } from './price-history.js';
import type { StoreFacts, WishlistItem } from './steam.js';
import type { Language } from './user-config.js';
import type { StoreCountryCode } from './store-country.js';

export type WishlistObservationStatus = 'known' | 'unknown' | 'error' | 'missing';

export interface WishlistItemState {
  readonly discordUserId: string;
  readonly steamId64: string;
  readonly configVersion: number;
  readonly storeCountryCode: StoreCountryCode;
  readonly appId: number;
  readonly onSale: boolean;
  readonly saleEpisodeId: string | null;
  readonly saleStartedAt: string | null;
  readonly saleKey: string | null;
  readonly currency: string | null;
  readonly normalPriceMinor: number | null;
  readonly finalPriceMinor: number | null;
  readonly discountPercent: number | null;
  readonly lastSeenAt: string;
  readonly observationStatus: WishlistObservationStatus;
  /** The discount already alerted (or taken as a baseline) in this sale; null when none. */
  readonly alertedDiscountPercent: number | null;
  /** When the last sale ended; it keeps its alert level if it returns before the next Steam price change. */
  readonly saleEndedAt: string | null;
}

export interface NotificationCandidate {
  readonly headerImageUrl?: string;
  /** Presentation-only; never persisted or part of batch identity. */
  readonly storeFacts?: StoreFacts;
  readonly reason?: string;
  readonly discordUserId: string;
  readonly steamId64: string;
  readonly configVersion: number;
  readonly storeCountryCode: StoreCountryCode;
  readonly appId: number;
  readonly gameName: string;
  readonly saleEpisodeId: string;
  readonly saleKey: string;
  readonly currency: string;
  readonly normalPriceMinor: number;
  readonly finalPriceMinor: number;
  readonly discountPercent: number;
  readonly attemptCount: number;
  readonly createdAt: string;
  /** Presentation-only context added at delivery; never persisted. */
  readonly historicalLow?: HistoricalLow;
}

export interface NotificationBatch<T> {
  /** Stable delivery identity when this batch is backed by the durable queue. */
  readonly batchId?: string;
  readonly notifications: readonly [T, ...T[]];
}

export interface DurableNotificationBatch extends NotificationBatch<NotificationCandidate> {
  readonly batchId: string;
  readonly language: Language;
  readonly attemptCount: number;
}

export interface WishlistObservation {
  readonly item: WishlistItem;
  readonly saleKey: string | null;
  readonly observedAt: string;
}

export interface DeliveryReceipt { readonly messageId: string; readonly channelId: string; readonly deliveredAt: string }
