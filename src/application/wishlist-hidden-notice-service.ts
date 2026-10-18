import { deliveryAllowed, type NotificationPreference } from '../domain/notification-preference.js';
import type { Language } from '../domain/user-config.js';
import type { CheckStateRepository } from '../persistence/check-state-repository.js';
import type { UserConfigRepository } from '../persistence/user-config-repository.js';
import { discordRateLimitDelayMs, dmUnreachableCode } from './notification-service.js';
import { safeLogger } from './safe-logger.js';
import { UserOperationCoordinator } from './user-operation-coordinator.js';

/** Setup stopped on a hidden wishlist, or a followed wishlist became hidden. */
export type WishlistHiddenNoticeKind = 'setup' | 'tracking';

export interface WishlistHiddenSender {
  send(discordUserId: string, language: Language, kind: WishlistHiddenNoticeKind): Promise<void>;
}

export type WishlistHiddenNoticeOutcome = 'sent' | 'skipped' | 'failed' | 'dm-blocked';

export interface WishlistHiddenNoticeServiceOptions {
  readonly userConfigRepository: Pick<UserConfigRepository, 'findByDiscordUserId' | 'markDmDeliveryBlocked'>;
  readonly checkStateRepository: Pick<
    CheckStateRepository,
    'claimWishlistHiddenNotice' | 'markWishlistHiddenNoticeSent' | 'releaseWishlistHiddenNotice'
  >;
  readonly preference: (discordUserId: string) => NotificationPreference;
  readonly sender: WishlistHiddenSender;
  readonly coordinator?: UserOperationCoordinator;
  readonly isBlocked?: (discordUserId: string) => boolean;
  readonly now?: () => Date;
  readonly lifecycleSignal?: AbortSignal;
}

/** Consecutive "private" answers before Dealio writes: one can be a Steam hiccup. */
export const wishlistHiddenMinimumChecks = 2;
const maxAttempts = 3;
const retryAfterMs = 10 * 60 * 1000;
/** A user retrying a hidden-wishlist setup gets the setup DM once a day. */
const setupHintCooldownMs = 24 * 60 * 60 * 1000;

/**
 * Tells a user, once, that Steam hides their wishlist and how to fix it: once per
 * hidden period for a followed wishlist (the attempt is stored before Discord is
 * called), and once a day when setup stops on it (kept in memory only, since such
 * a user has no stored data).
 */
export class WishlistHiddenNoticeService {
  private readonly coordinator: UserOperationCoordinator;
  private readonly now: () => Date;
  private readonly setupHints = new Map<string, number>();

  public constructor(private readonly options: WishlistHiddenNoticeServiceOptions) {
    this.coordinator = options.coordinator ?? new UserOperationCoordinator();
    this.now = options.now ?? (() => new Date());
  }

  public notify(discordUserId: string): Promise<WishlistHiddenNoticeOutcome> {
    return this.coordinator.runExclusive(discordUserId, () => this.notifyExclusive(discordUserId));
  }

  private async notifyExclusive(discordUserId: string): Promise<WishlistHiddenNoticeOutcome> {
    if (this.options.lifecycleSignal?.aborted || this.options.isBlocked?.(discordUserId)) return 'skipped';
    const config = this.options.userConfigRepository.findByDiscordUserId(discordUserId);
    if (!config?.enabled || config.dmDeliveryBlockedAt !== null) return 'skipped';
    if (!this.outsideQuietHours(discordUserId)) return 'skipped';
    const claimed = this.options.checkStateRepository.claimWishlistHiddenNotice(discordUserId, this.now(), {
      minimumChecks: wishlistHiddenMinimumChecks, maxAttempts, retryAfterMs,
    });
    if (!claimed) return 'skipped';

    try {
      await this.options.sender.send(discordUserId, config.language, 'tracking');
    } catch (error: unknown) {
      const unreachable = dmUnreachableCode(error);
      if (unreachable) {
        this.options.userConfigRepository.markDmDeliveryBlocked(discordUserId, unreachable, this.now().toISOString());
        return 'dm-blocked';
      }
      if (discordRateLimitDelayMs(error) !== null) {
        this.options.checkStateRepository.releaseWishlistHiddenNotice(discordUserId);
      }
      safeLogger.error('Hidden-wishlist DM failed', error);
      return 'failed';
    }
    this.options.checkStateRepository.markWishlistHiddenNoticeSent(discordUserId, this.now().toISOString());
    return 'sent';
  }

  /** Quiet hours hold this DM back until the next scan; digest and instant send now. */
  private outsideQuietHours(discordUserId: string): boolean {
    try {
      const preference = this.options.preference(discordUserId);
      return preference.mode !== 'quiet' || deliveryAllowed(preference, this.now());
    } catch (_error: unknown) {
      return true;
    }
  }

  /**
   * Setup stopped because Steam hides the wishlist. Never awaited by setup: the
   * panel already shows the fix, and this DM only keeps it after the panel closes.
   */
  public hintSetup(discordUserId: string, language: Language): void {
    if (this.options.lifecycleSignal?.aborted) return;
    const nowMs = this.now().getTime();
    for (const [userId, until] of this.setupHints) {
      if (until <= nowMs) this.setupHints.delete(userId);
    }
    if (this.setupHints.has(discordUserId)) return;
    this.setupHints.set(discordUserId, nowMs + setupHintCooldownMs);
    void this.options.sender.send(discordUserId, language, 'setup').catch((error: unknown) => {
      // Closed DMs are expected here: this user has not set up Dealio.
      if (dmUnreachableCode(error) === null) safeLogger.error('Hidden-wishlist setup DM failed', error);
    });
  }
}
