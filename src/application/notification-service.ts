import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { redactSecrets, safeLogger } from './safe-logger.js';
import { deliveryAllowed } from '../domain/notification-preference.js';
import type { HistoricalLow } from '../domain/price-history.js';
import type { StoreFacts } from '../domain/steam.js';
import type { DmUnreachableCode, Language } from '../domain/user-config.js';
import type { StoreCountryCode } from '../domain/store-country.js';
import type {
  DurableNotificationBatch,
  NotificationBatch,
  NotificationCandidate,
} from '../domain/wishlist-state.js';
import { UserConfigRepository } from '../persistence/user-config-repository.js';
import { WishlistStateRepository } from '../persistence/wishlist-state-repository.js';
import { UserOperationCoordinator } from './user-operation-coordinator.js';
import type { HistoricalLowSource } from '../price-history/itad-client.js';

export type { DeliveryReceipt } from '../domain/wishlist-state.js';
import type { DeliveryReceipt } from '../domain/wishlist-state.js';

export interface NotificationSender {
  plan<T extends SaleNotification>(
    notifications: readonly T[],
    language: Language,
    options?: NotificationSendOptions,
  ): readonly NotificationBatch<T>[];
  send(
    batch: NotificationBatch<SaleNotification>,
    language: Language,
    options?: NotificationSendOptions,
  ): Promise<DeliveryReceipt | void>;
}

export interface SaleNotification {
  readonly headerImageUrl?: string;
  /** Presentation-only Store context (reviews, platforms, sale end) from the latest snapshot. */
  readonly storeFacts?: StoreFacts;
  readonly reason?: string;
  readonly discordUserId: string;
  readonly appId: number;
  readonly saleEpisodeId: string;
  readonly storeCountryCode: StoreCountryCode;
  readonly gameName: string;
  readonly currency: string;
  readonly normalPriceMinor: number;
  readonly finalPriceMinor: number;
  readonly discountPercent: number;
  readonly createdAt: string;
  /** Presentation-only context added at delivery; never persisted or part of batch identity. */
  readonly historicalLow?: HistoricalLow;
}

export interface NotificationSendOptions {
  readonly test?: boolean;
  /** Where a test alert's game came from: the user's wishlist, or a fixed example. */
  readonly testSource?: 'wishlist' | 'example';
  readonly digest?: boolean;
}

export class NotificationDeliveryCancelledError extends Error {
  public readonly name = 'NotificationDeliveryCancelledError';
}

export interface NotificationDeliveryResult {
  readonly candidateCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
}

interface BatchDeliveryOutcome {
  readonly sentCount: number;
  readonly failedCount: number;
  readonly cancelled: boolean;
  /** The user does not accept DMs: the user's further batches would fail the same way. */
  readonly recipientBlocked?: boolean;
}

export interface NotificationServiceOptions {
  readonly sendingTimeoutMs?: number;
  readonly now?: () => Date;
  readonly coordinator?: UserOperationCoordinator;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly lifecycleSignal?: AbortSignal;
  readonly revalidate?: (user: string) => Promise<boolean>;
  /** First wait after a failed revalidation; it doubles per failure up to the maximum. */
  readonly revalidationRetryBaseMs?: number;
  readonly revalidationRetryMaxMs?: number;
  readonly priceHistory?: HistoricalLowSource;
}

const defaultSendingTimeoutMs = 15 * 60 * 1000;
const defaultMaxAttempts = 5;
const defaultRetryBaseDelayMs = 5 * 60 * 1000;
const defaultMaxRetryDelayMs = 24 * 60 * 60 * 1000;
const defaultRevalidationRetryBaseMs = 60 * 1000;
const defaultRevalidationRetryMaxMs = 15 * 60 * 1000;
/** Two DMs' worth of games: enough that only the carried last DM is ever re-planned. */
const planningWindowSize = 20;

export class NotificationService {
  private readonly sendingTimeoutMs: number;
  private readonly now: () => Date;
  private readonly coordinator: UserOperationCoordinator;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly lifecycleSignal?: AbortSignal;
  private readonly revalidate?: (user: string) => Promise<boolean>;
  private readonly priceHistory?: HistoricalLowSource;
  private readonly revalidationRetryBaseMs: number;
  private readonly revalidationRetryMaxMs: number;
  /**
   * Users whose last revalidation failed (Steam outage, a wishlist made private).
   * Without a backoff every retry tick would read their whole wishlist again.
   */
  private readonly revalidationBackoff = new Map<string, { failures: number; retryAtMs: number }>();

  public constructor(
    private readonly userConfigRepository: UserConfigRepository,
    private readonly wishlistStateRepository: WishlistStateRepository,
    private readonly sender: NotificationSender,
    options: NotificationServiceOptions = {},
  ) {
    this.sendingTimeoutMs = options.sendingTimeoutMs ?? defaultSendingTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.coordinator = options.coordinator ?? new UserOperationCoordinator();
    this.maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? defaultRetryBaseDelayMs;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? defaultMaxRetryDelayMs;
    this.lifecycleSignal = options.lifecycleSignal;
    this.revalidate = options.revalidate;
    this.priceHistory = options.priceHistory;
    this.revalidationRetryBaseMs = options.revalidationRetryBaseMs ?? defaultRevalidationRetryBaseMs;
    this.revalidationRetryMaxMs = options.revalidationRetryMaxMs ?? defaultRevalidationRetryMaxMs;

    if (!Number.isSafeInteger(this.sendingTimeoutMs) || this.sendingTimeoutMs <= 0) {
      throw new Error('Notification sending timeout must be a positive safe integer');
    }

    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts <= 0) {
      throw new Error('Notification max attempts must be a positive safe integer');
    }

    for (const [name, value] of [
      ['retry base delay', this.retryBaseDelayMs],
      ['maximum retry delay', this.maxRetryDelayMs],
      ['revalidation retry delay', this.revalidationRetryBaseMs],
      ['maximum revalidation retry delay', this.revalidationRetryMaxMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Notification ${name} must be a positive safe integer`);
      }
    }
  }

  public async deliverPending(discordUserId: string): Promise<NotificationDeliveryResult> {
    return this.coordinator.runExclusive(discordUserId, () =>
      this.deliverPendingExclusive(discordUserId),
    );
  }

  private async deliverPendingExclusive(
    discordUserId: string,
  ): Promise<NotificationDeliveryResult> {
    if (this.lifecycleSignal?.aborted) {
      return { candidateCount: 0, sentCount: 0, failedCount: 0 };
    }

    const config = this.userConfigRepository.findByDiscordUserId(discordUserId);

    if (!config?.enabled) {
      return { candidateCount: 0, sentCount: 0, failedCount: 0 };
    }

    const assistant = this.wishlistStateRepository.assistant;
    const preference = assistant.preference(discordUserId);
    let allowed: boolean;
    try {
      allowed = deliveryAllowed(preference, this.now());
    } catch (error: unknown) {
      // An unreadable stored preference must not hold this user's alerts back forever.
      safeLogger.error('Invalid notification preference; delivering without a schedule', error);
      allowed = true;
    }
    if (!allowed) return {candidateCount:0,sentCount:0,failedCount:0};
    // Interrupted sends become due retries before deciding whether anything is due.
    const staleBefore = new Date(this.now().getTime() - this.sendingTimeoutMs).toISOString();
    this.wishlistStateRepository.recoverStaleSending(config, staleBefore);
    // Only a deliverable notification is worth a fresh Steam check; a retry
    // scheduled for later must not rescan the wishlist on every retry tick.
    const due = this.wishlistStateRepository.hasPendingNotifications(
      discordUserId, config.configVersion, this.now().toISOString());
    if (due && this.revalidate && !await this.revalidateWithBackoff(discordUserId, this.revalidate))
      return {candidateCount:0,sentCount:0,failedCount:0};
    // A removed/replaced account must never receive an old queued message.
    const fresh = this.userConfigRepository.findByDiscordUserId(discordUserId);
    if (!fresh?.enabled || fresh.configurationId !== config.configurationId || this.lifecycleSignal?.aborted)
      return {candidateCount:0,sentCount:0,failedCount:0};
    this.wishlistStateRepository.expireInactiveNotifications(config);
    const now = this.now().toISOString();
    const retryableBatches = this.wishlistStateRepository.findRetryableNotificationBatches(
      config,
      now,
    );
    const candidates = this.wishlistStateRepository.findRetryableNotificationCandidates(
      config,
      now,
    );
    const candidateCount = candidates.length + retryableBatches.reduce(
      (total, batch) => total + batch.notifications.length,
      0,
    );
    let sentCount = 0;
    let failedCount = 0;
    let cancelled = false;
    let recipientBlocked = false;

    for (const batch of retryableBatches) {
      if (this.lifecycleSignal?.aborted) {
        break;
      }

      if (batch.attemptCount >= this.maxAttempts) {
        this.wishlistStateRepository.markNotificationBatchTerminal(
          batch,
          'Maximum delivery attempt count reached',
        );
        failedCount += batch.notifications.length;
        continue;
      }

      const claimed = this.wishlistStateRepository.claimNotificationBatch(
        batch,
        this.now().toISOString(),
      );
      if (!claimed) {
        continue;
      }

      const outcome = await this.deliverClaimedBatch(batch);
      sentCount += outcome.sentCount;
      failedCount += outcome.failedCount;
      cancelled = outcome.cancelled;
      if (cancelled || outcome.recipientBlocked) {
        recipientBlocked = outcome.recipientBlocked === true;
        break;
      }
    }

    const candidateGroups: NotificationCandidate[][] = [];
    if (!cancelled && !recipientBlocked && !this.lifecycleSignal?.aborted) {
      let currentAttemptCount: number | undefined;
      let currentCandidates: NotificationCandidate[] = [];

      const flushCandidates = (): void => {
        if (currentCandidates.length > 0) {
          candidateGroups.push(currentCandidates);
          currentCandidates = [];
        }
      };

      for (const candidate of candidates) {
        if (candidate.attemptCount >= this.maxAttempts) {
          flushCandidates();
          currentAttemptCount = undefined;
          this.wishlistStateRepository.markNotificationTerminal(
            candidate,
            'Maximum delivery attempt count reached',
          );
          failedCount += 1;
          continue;
        }

        if (currentAttemptCount !== undefined && candidate.attemptCount !== currentAttemptCount) {
          flushCandidates();
        }
        currentAttemptCount = candidate.attemptCount;
        currentCandidates.push(candidate);
      }
      flushCandidates();
    }

    delivery: for (const group of candidateGroups) {
      for (const plannedBatch of this.planInWindows(group, config.language)) {
        if (this.lifecycleSignal?.aborted) {
          break delivery;
        }

        const batch = this.wishlistStateRepository.createAndClaimNotificationBatch(
          config,
          config.language,
          plannedBatch.notifications,
          this.now().toISOString(),
        );
        if (!batch) {
          continue;
        }

        const outcome = await this.deliverClaimedBatch(batch);
        sentCount += outcome.sentCount;
        failedCount += outcome.failedCount;
        cancelled = outcome.cancelled;
        // Every further DM to a user who blocks them is another rejected Discord request.
        if (cancelled || outcome.recipientBlocked) {
          break delivery;
        }
        // Commands and other users' work get a turn between DMs of a long queue.
        await nextEventLoopTurn();
      }
    }

    // The day's digest is done once it was delivered, or when its time came with
    // nothing queued; a sale found later that day waits for tomorrow's digest.
    if (failedCount === 0 && !cancelled && !this.lifecycleSignal?.aborted && (sentCount > 0
      || !this.wishlistStateRepository.hasPendingNotifications(discordUserId, config.configVersion))) {
      assistant.markDigest(discordUserId, this.now());
    }
    return {
      candidateCount,
      sentCount,
      failedCount,
    };
  }

  /** False while a recent failed revalidation is backing off, without asking Steam. */
  private async revalidateWithBackoff(
    discordUserId: string,
    revalidate: (user: string) => Promise<boolean>,
  ): Promise<boolean> {
    const backoff = this.revalidationBackoff.get(discordUserId);
    if (backoff && this.now().getTime() < backoff.retryAtMs) {
      return false;
    }
    let valid = false;
    try {
      valid = await revalidate(discordUserId);
    } finally {
      if (valid) {
        this.revalidationBackoff.delete(discordUserId);
      } else {
        const failures = (backoff?.failures ?? 0) + 1;
        const delayMs = Math.min(
          this.revalidationRetryBaseMs * (2 ** Math.min(failures - 1, 30)),
          this.revalidationRetryMaxMs,
        );
        this.revalidationBackoff.set(discordUserId, { failures, retryAtMs: this.now().getTime() + delayMs });
      }
    }
    return valid;
  }

  /**
   * Plans DMs a few candidates at a time, so a long queue (a big Steam sale)
   * never blocks the event loop for one large partition. Only a window's last
   * DM can still take more games, so it is carried into the next window; the
   * DMs are the same as planning every candidate at once.
   */
  private *planInWindows(
    candidates: readonly NotificationCandidate[],
    language: Language,
  ): Generator<NotificationBatch<NotificationCandidate>> {
    let carried: readonly NotificationCandidate[] = [];
    for (let start = 0; start < candidates.length; start += planningWindowSize) {
      const end = start + planningWindowSize;
      const batches = this.sender.plan([...carried, ...candidates.slice(start, end)], language);
      if (end >= candidates.length) {
        yield* batches;
        return;
      }
      carried = batches.at(-1)?.notifications ?? [];
      yield* batches.slice(0, -1);
    }
  }

  private withArtwork(batch: DurableNotificationBatch): DurableNotificationBatch {
    // Presentation metadata is optional; it must never prevent delivery or change its identity.
    try {
      const config = this.userConfigRepository.findByDiscordUserId(batch.notifications[0].discordUserId);
      if (!config) return batch;
      const snapshot = this.wishlistStateRepository.assistant.snapshot(config);
      const metadata = new Map(snapshot?.items.map(item => [item.appId, item]));
      const enrich = (item: NotificationCandidate): NotificationCandidate => {
        const { headerImageUrl, storeFacts } = metadata.get(item.appId) ?? {};
        return {
          ...item,
          ...(headerImageUrl ? { headerImageUrl } : {}),
          ...(storeFacts ? { storeFacts } : {}),
        };
      };
      const [first, ...rest] = batch.notifications;
      return { ...batch, notifications: [enrich(first), ...rest.map(enrich)] };
    } catch { return batch; }
  }

  private async withPriceHistory(batch: DurableNotificationBatch): Promise<DurableNotificationBatch> {
    // Like artwork, price history is optional context and must never block delivery.
    if (!this.priceHistory) return batch;
    try {
      const lows = new Map<string, HistoricalLow>();
      for (const country of new Set(batch.notifications.map(item => item.storeCountryCode))) {
        const apps = batch.notifications.filter(item => item.storeCountryCode === country)
          .map(item => ({ appId: item.appId, currency: item.currency }));
        for (const [appId, low] of await this.priceHistory.historicalLows(apps, country)) {
          lows.set(`${country}:${appId}`, low);
        }
      }
      const enrich = (item: NotificationCandidate): NotificationCandidate => {
        const historicalLow = lows.get(`${item.storeCountryCode}:${item.appId}`);
        return historicalLow ? { ...item, historicalLow } : item;
      };
      const [first, ...rest] = batch.notifications;
      return { ...batch, notifications: [enrich(first), ...rest.map(enrich)] };
    } catch { return batch; }
  }

  private async deliverClaimedBatch(
    batch: DurableNotificationBatch,
  ): Promise<BatchDeliveryOutcome> {
    let receipt: DeliveryReceipt | void;
    let deliveryMode: 'digest' | 'quiet' | 'immediate' = 'immediate';
    try {
      const user=batch.notifications[0].discordUserId;
      const preferenceMode = this.wishlistStateRepository.assistant.preference(user).mode;
      const digest = preferenceMode === 'digest';
      deliveryMode = preferenceMode === 'instant' ? 'immediate' : preferenceMode;
      const renderedBatch = await this.withPriceHistory(this.withArtwork(batch));
      receipt = digest ? await this.sender.send(renderedBatch,batch.language,{digest:true}) : await this.sender.send(renderedBatch,batch.language);
    } catch (error: unknown) {
      if (error instanceof NotificationDeliveryCancelledError) {
        return { sentCount: 0, failedCount: 0, cancelled: true };
      }

      // Discord's rate limit means "not now", not a failed delivery: wait as long as
      // Discord asks and keep every attempt, or a busy sale day could drop alerts.
      const rateLimitDelayMs = discordRateLimitDelayMs(error);
      if (rateLimitDelayMs !== null) {
        this.wishlistStateRepository.deferNotificationBatch(
          batch,
          'DISCORD_RATE_LIMITED',
          new Date(this.now().getTime() + rateLimitDelayMs).toISOString(),
        );
        return { sentCount: 0, failedCount: batch.notifications.length, cancelled: false };
      }

      const unreachable = dmUnreachableCode(error);
      const message = unreachable ?? redactSecrets(error instanceof Error ? error.message : 'Unknown Discord error');
      const attemptCount = batch.attemptCount + 1;
      const permanentlyBlocked = unreachable !== null;
      const terminal = isPermanentDiscordError(error) || attemptCount >= this.maxAttempts;
      const retryDelayMs = Math.min(
        this.retryBaseDelayMs * (2 ** Math.max(0, attemptCount - 1)),
        this.maxRetryDelayMs,
      );
      const nextAttemptAt = terminal
        ? null
        : new Date(this.now().getTime() + retryDelayMs).toISOString();
      this.wishlistStateRepository.markNotificationBatchFailed(
        batch,
        message,
        nextAttemptAt,
        terminal,
      );
      if (unreachable) {
        this.userConfigRepository.markDmDeliveryBlocked(
          batch.notifications[0].discordUserId,
          unreachable,
          this.now().toISOString(),
        );
      }
      return {
        sentCount: 0,
        failedCount: batch.notifications.length,
        cancelled: false,
        recipientBlocked: permanentlyBlocked,
      };
    }

    try {
      this.wishlistStateRepository.markNotificationBatchSent(batch, receipt || undefined);
      if (receipt) {
        const deliveredMs = Date.parse(receipt.deliveredAt);
        for (const notification of batch.notifications) {
          const candidateMs = Date.parse(notification.createdAt);
          if (Number.isFinite(deliveredMs) && Number.isFinite(candidateMs)) {
            safeLogger.log(
              `[notification-timing] candidateToDeliveryMs=${Math.max(0, deliveredMs - candidateMs)} mode=${deliveryMode}`,
            );
          }
        }
      }
      return {
        sentCount: batch.notifications.length,
        failedCount: 0,
        cancelled: false,
      };
    } catch (_error: unknown) {
      // The transaction rolls back to sending; stale recovery preserves at-least-once delivery.
      return {
        sentCount: 0,
        failedCount: batch.notifications.length,
        cancelled: false,
      };
    }
  }
}

export function isPermanentDiscordError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = 'code' in error ? Number(error.code) : Number.NaN;
  if (code === 50_007 || code === 50_278) {
    return true;
  }

  const status = 'status' in error ? Number(error.status) : Number.NaN;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const minimumRateLimitDelayMs = 5_000;
const maximumRateLimitDelayMs = 15 * 60 * 1000;

/**
 * How long Discord asked us to wait, when the error is a rate limit; null otherwise.
 * discord.js raises RateLimitError (retryAfter / timeToReset in ms) because the REST
 * client rejects on rate limits; a plain HTTP 429 is handled the same way.
 */
export function discordRateLimitDelayMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  const isRateLimit = record.name === 'RateLimitError' || Number(record.status) === 429;
  if (!isRateLimit) {
    return null;
  }
  const requested = [record.retryAfter, record.timeToReset]
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return Math.min(Math.max(requested ?? minimumRateLimitDelayMs, minimumRateLimitDelayMs), maximumRateLimitDelayMs);
}

/**
 * Only an explicit recipient delivery error establishes that the user cannot get
 * DMs: a privacy block (50007), or no shared server and no app install (50278).
 */
export function dmUnreachableCode(error: unknown): DmUnreachableCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = Number(error.code);
  return code === 50_007 ? 'DISCORD_DM_BLOCKED' : code === 50_278 ? 'DISCORD_NO_MUTUAL_GUILD' : null;
}

export function isDiscordDmBlocked(error: unknown): boolean {
  return dmUnreachableCode(error) !== null;
}
