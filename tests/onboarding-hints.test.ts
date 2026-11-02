import { describe, expect, it } from 'vitest';
import type { StatusDashboardResult } from '../src/application/status-service.js';
import { buildHomePanel } from '../src/discord/home-view.js';
import { buildInitialWishlistV2Page, buildSaleNotificationPanel } from '../src/discord/notification-components-v2.js';
import { smallWishlistHint } from '../src/discord/ui/design.js';

const wishlistUrl = 'https://store.steampowered.com/wishlist/';

function ready(checkState: Extract<StatusDashboardResult, { status: 'ready' }>['checkState'] = null) {
  const result: Extract<StatusDashboardResult, { status: 'ready' }> = {
    status: 'ready', language: 'en',
    config: {
      discordUserId: '1', configurationId: 'config', steamId64: '76561198000000000',
      configVersion: 1, language: 'en', storeCountryCode: 'US', enabled: true,
      minimumDiscountPercent: 0, dmOptInAt: '2026-09-12T00:00:00Z',
      dmDeliveryBlockedAt: null, dmDeliveryErrorCode: null,
      createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    },
    checkState, notificationQueue: { pending: 0, retry: 0, sending: 0, sent: 0, terminalFailed: 0, expired: 0 },
    latestPriceCurrencies: ['USD'], gameDiscountOverrideCount: 0,
  };
  return result;
}

function sale(appId: number) {
  return {
    discordUserId: 'discord-user', appId, saleEpisodeId: `episode-${appId}`, gameName: `Game ${appId}`,
    currency: 'TRY', normalPriceMinor: 1_000, finalPriceMinor: 500, discountPercent: 50,
    storeCountryCode: 'TR' as const, createdAt: '2026-08-29T00:00:00.000Z',
  };
}

describe('onboarding hints', () => {
  it.each(['tr', 'en', 'de', 'fr'] as const)('suggests growing a small %s wishlist, with a link to it', (language) => {
    expect(smallWishlistHint(9, language)).toContain(wishlistUrl);
    expect(smallWishlistHint(0, language)).toContain(wishlistUrl);
    expect(smallWishlistHint(10, language)).toBeNull();
    expect(smallWishlistHint(undefined, language)).toBeNull();
  });

  it('shows the hint on Home for a small list, but not for a big one or a hidden one', () => {
    expect(JSON.stringify(buildHomePanel(ready(), 's', { trackedGameCount: 3 }).toJSON())).toContain(wishlistUrl);
    expect(JSON.stringify(buildHomePanel(ready(), 's', { trackedGameCount: 24 }).toJSON())).not.toContain(wishlistUrl);
    // A hidden wishlist reads as 0 games; the privacy fix comes first.
    const hidden = ready({ lastStatus: 'unavailable', lastErrorCode: 'STEAM_WISHLIST_INACCESSIBLE' } as never);
    const text = JSON.stringify(buildHomePanel(hidden, 's', { trackedGameCount: 0 }).toJSON());
    expect(text).toContain('I can’t see your wishlist');
    expect(text).not.toContain(wishlistUrl);
  });

  it('adds the hint to the setup summary only for a small list', () => {
    const summary = (totalGameCount: number) => JSON.stringify(buildInitialWishlistV2Page({
      discordUserId: 'u', steamId64: '76561198000000000', language: 'en', storeCountryCode: 'TR',
      minimumDiscountPercent: 0, totalGameCount, failedItemCount: 0, capturedAt: '2026-09-19T00:00:00Z', sales: [],
    }, {}, 'session', 0).components[0]!.toJSON());
    expect(summary(4)).toContain(wishlistUrl);
    expect(summary(40)).not.toContain(wishlistUrl);
  });

  it('adds the one-time tip to a first sale alert, never to a test or a later alert', () => {
    const text = (options: Parameters<typeof buildSaleNotificationPanel>[2]) =>
      JSON.stringify(buildSaleNotificationPanel([sale(1), sale(2)], 'en', options).toJSON());
    expect(text({ firstAlert: true })).toContain('This is your first Dealio alert');
    expect(text({ firstAlert: true, digest: true })).toContain('This is your first Dealio alert');
    expect(text({})).not.toContain('first Dealio alert');
    expect(text({ test: true, firstAlert: true })).not.toContain('first Dealio alert');
  });
});
