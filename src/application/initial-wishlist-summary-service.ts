import type { StoreFacts, WishlistItemError } from '../domain/steam.js';
import type { StoreCountryCode } from '../domain/store-country.js';
import type { DmUnreachableCode, Language } from '../domain/user-config.js';
import type { CheckService } from './check-service.js';
import { dmUnreachableCode } from './notification-service.js';

export interface InitialWishlistSale {
  readonly headerImageUrl?: string;
  readonly storeFacts?: StoreFacts;
  readonly appId: number;
  readonly gameName: string;
  readonly currency: string;
  readonly normalPriceMinor: number;
  readonly finalPriceMinor: number;
  readonly discountPercent: number;
}

export interface InitialWishlistSummary {
  readonly discordUserId: string;
  readonly steamId64: string;
  readonly language: Language;
  readonly storeCountryCode: StoreCountryCode;
  readonly totalGameCount: number;
  /** Games Steam could not return this time, or released games without a confirmed price. */
  readonly failedItemCount: number;
  /** Unreleased games; they have no price yet by design. */
  readonly upcomingCount?: number;
  /** Games not sold in the Store region or removed from Steam. */
  readonly unavailableItems?: readonly WishlistItemError[];
  readonly minimumDiscountPercent: number;
  readonly capturedAt: string;
  readonly sales: readonly InitialWishlistSale[];
}

export interface InitialWishlistSummarySender {
  sendInitialSummary(summary: InitialWishlistSummary): Promise<void>;
}

export type InitialWishlistSummaryResult =
  | { readonly status: 'sent'; readonly saleCount: number }
  | { readonly status: 'steam-unavailable' }
  | { readonly status: 'persistence-error' }
  | { readonly status: 'dm-transient-failed'; readonly saleCount: number }
  | { readonly status: 'dm-blocked'; readonly saleCount: number; readonly errorCode: DmUnreachableCode };

export class InitialWishlistSummaryService {
  public constructor(
    private readonly checkService: CheckService,
    private readonly sender: InitialWishlistSummarySender,
  ) {}

  public async send(discordUserId: string): Promise<InitialWishlistSummaryResult> {
    return this.sendFromCheck(discordUserId, this.checkService.check(
      discordUserId,
      'manual',
      { baseline: true, bypassCooldown: true },
    ));
  }

  public async sendWithinUserOperation(
    discordUserId: string,
  ): Promise<InitialWishlistSummaryResult> {
    return this.sendFromCheck(discordUserId, this.checkService.checkWithinUserOperation(
      discordUserId,
      'manual',
      { baseline: true, bypassCooldown: true },
    ));
  }

  /** Records the current wishlist as a baseline without sending anything; true when Steam answered. */
  public async baselineWithinUserOperation(discordUserId: string): Promise<boolean> {
    const result = await this.checkService.checkWithinUserOperation(
      discordUserId,
      'manual',
      { baseline: true, bypassCooldown: true },
    );
    return result.status === 'success';
  }

  private async sendFromCheck(
    discordUserId: string,
    check: ReturnType<CheckService['check']>,
  ): Promise<InitialWishlistSummaryResult> {
    const result = await check;
    if (result.status === 'unavailable') {
      return { status: 'steam-unavailable' };
    }
    if (result.status !== 'success') {
      return { status: 'persistence-error' };
    }
    const sales = result.wishlistItems.flatMap((item): InitialWishlistSale[] => {
      const price = item.price;
      if (
        item.onSale !== true
        || price === null
        || price.currency === null
        || price.isFree
        || price.discountPercent <= 0
        || price.finalMinor >= price.initialMinor
      ) {
        return [];
      }
      return [{
        appId: item.appId,
        gameName: item.name,
        ...(item.headerImageUrl ? { headerImageUrl: item.headerImageUrl } : {}),
        ...(item.storeFacts ? { storeFacts: item.storeFacts } : {}),
        currency: price.currency,
        normalPriceMinor: price.initialMinor,
        finalPriceMinor: price.finalMinor,
        discountPercent: price.discountPercent,
      }];
    });

    try {
      await this.sender.sendInitialSummary({
        discordUserId,
        steamId64: result.steamId64,
        language: result.language,
        storeCountryCode: result.storeCountryCode,
        totalGameCount: result.wishlistItems.length + result.failedItems.length + result.unavailableItems.length,
        failedItemCount: result.failedItems.length + result.unknownPriceCount,
        upcomingCount: result.upcomingCount,
        unavailableItems: result.unavailableItems,
        minimumDiscountPercent: result.minimumDiscountPercent,
        capturedAt: result.capturedAt,
        sales,
      });
      return { status: 'sent', saleCount: sales.length };
    } catch (error: unknown) {
      const unreachable = dmUnreachableCode(error);
      return unreachable
        ? { status: 'dm-blocked', saleCount: sales.length, errorCode: unreachable }
        : { status: 'dm-transient-failed', saleCount: sales.length };
    }
}

}
