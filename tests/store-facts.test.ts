import { describe, expect, it } from 'vitest';
import { parseStoreFacts, parseStoreItemsResponse } from '../src/steam/wishlist-parser.js';
import { buildSaleNotificationPanel } from '../src/discord/notification-components-v2.js';
import { componentsV2TextLength } from '../src/discord/ui/components-v2.js';
import { platformText, priceLine, reviewLine, saleEndLine, steamAppLink, steamAppUrl } from '../src/discord/ui/design.js';
import type { SaleNotification } from '../src/application/notification-service.js';

const steamItem = {
  id: 620, success: 1, name: 'Portal 2',
  platforms: { windows: true, steamos_linux: true, steam_deck_compat_category: 3 },
  reviews: { summary_filtered: { review_count: 390926, percent_positive: 98, review_score: 9, review_score_label: 'Son Derece Olumlu' } },
  best_purchase_option: { active_discounts: [{ discount_end_date: 1791478800 }] },
};

describe('Steam store facts', () => {
  it('reads reviews, platforms, Steam Deck support and the discount end from GetItems', () => {
    expect(parseStoreFacts(steamItem)).toEqual({
      reviewCount: 390926, reviewPercent: 98, reviewLabel: 'Son Derece Olumlu',
      platforms: { windows: true, mac: false, linux: true }, steamDeck: 'verified',
      saleEndsAt: new Date(1791478800 * 1000).toISOString(),
    });
    const parsed = parseStoreItemsResponse({ response: { store_items: [steamItem] } }, [620]).get(620);
    expect(parsed).toMatchObject({ name: 'Portal 2', storeFacts: { steamDeck: 'verified' } });
  });

  it('never fails an item over malformed or missing optional context', () => {
    expect(parseStoreFacts({ id: 1, success: 1, name: 'x' })).toBeUndefined();
    expect(parseStoreFacts({
      platforms: { steam_deck_compat_category: 0 }, reviews: { summary_filtered: { review_count: 0 } },
      best_purchase_option: { active_discounts: [{ discount_end_date: 'soon' }, null] },
    })).toBeUndefined();
    expect(parseStoreFacts({ reviews: { summary_filtered: { review_count: 10, percent_positive: 140 } } }))
      .toEqual({ reviewCount: 10 });
  });

  it('formats the context lines and hides a sale end that has passed', () => {
    const facts = parseStoreFacts(steamItem);
    expect(reviewLine(facts, 'tr')).toBe('⭐ **Son Derece Olumlu** · %98　🎮 Steam Deck: Doğrulandı');
    expect(reviewLine({ steamDeck: 'playable' }, 'en')).toBe('🎮 Steam Deck: Playable');
    expect(platformText(facts)).toBe('💻 Windows · Linux');
    expect(saleEndLine(facts, 'tr', 0)).toBe('⏳ İndirim <t:1791478800:R> bitiyor');
    expect(saleEndLine(facts, 'en', 1791478800 * 1000 + 1)).toBeNull();
    expect(steamAppUrl(620)).toBe('https://byzephyron.github.io/dealio-public-pages/open.html?app=620');
    // Discord shows a masked link whose label holds an emoji as raw text, so the emoji stays outside.
    expect(steamAppLink(620, 'en')).toBe('🖥️ [Open in the Steam app](https://byzephyron.github.io/dealio-public-pages/open.html?app=620)');
  });
});

const sale: SaleNotification = {
  discordUserId: 'u', appId: 620, saleEpisodeId: 'e', storeCountryCode: 'TR', gameName: 'Portal 2',
  currency: 'USD', normalPriceMinor: 999, finalPriceMinor: 199, discountPercent: 80, createdAt: '2026-10-03T00:00:00.000Z',
};
const text = (notifications: SaleNotification[], language: 'tr' | 'en' = 'tr') =>
  JSON.stringify(buildSaleNotificationPanel(notifications, language).toJSON());

describe('alert presentation', () => {
  it('adds Store context and a Steam app link to each game', () => {
    const shown = text([{ ...sale, storeFacts: parseStoreFacts(steamItem) }]);
    expect(shown).toContain('Son Derece Olumlu');
    expect(shown).toContain('Steam Deck: Doğrulandı');
    expect(shown).toContain('💻 Windows · Linux');
    expect(shown).toContain('open.html?app=620');
  });

  it('presents a 100% discount as a free game to keep', () => {
    const free = { ...sale, finalPriceMinor: 0, discountPercent: 100 };
    expect(priceLine({ finalMinor: 0, initialMinor: 999, discountPercent: 100, currency: 'USD' }, 'en'))
      .toBe('**Free**  ~~$9.99~~  🟢 `−100%`');
    const shown = text([free]);
    expect(shown).toContain('DEALIO · ÜCRETSİZ');
    expect(shown).toContain('# 🎁 İstek listendeki bir oyun ücretsiz!');
    expect(shown).toContain('## 🎁 [Portal 2]');
    expect(shown).toContain('sonsuza dek senin');
  });

  it('leads with 🏆 when every game is at its lowest recorded price', () => {
    const low = { currency: 'USD', amountMinor: 199, discountPercent: 80, recordedAt: '2025-06-26T00:00:00.000Z' };
    expect(text([{ ...sale, historicalLow: low }], 'en')).toContain('🏆 DEALIO · LOWEST PRICE');
    expect(text([{ ...sale, historicalLow: { ...low, amountMinor: 99 } }], 'en')).not.toContain('LOWEST PRICE');
  });

  it('drops optional context before it would exceed Discord’s text budget', () => {
    const facts = { ...parseStoreFacts(steamItem), reviewLabel: 'Overwhelmingly Positive and then some more words' };
    const many = Array.from({ length: 10 }, (_, index) => ({
      ...sale, appId: 1000 + index, saleEpisodeId: `e${index}`, gameName: `A rather long game name number ${index} — Deluxe Edition`, storeFacts: facts,
    }));
    const panel = buildSaleNotificationPanel(many, 'en');
    expect(componentsV2TextLength([panel])).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(panel.toJSON())).toContain('A rather long game name number 9');
  });
});

describe('game detail', () => {
  const item = {
    appId: 620, name: 'Portal 2', priority: null, dateAdded: null, onSale: true, storeFacts: parseStoreFacts(steamItem),
    price: { currency: 'USD', initialMinor: 999, finalMinor: 199, discountPercent: 80, isFree: false },
  };
  const data = (low?: { currency: string; amountMinor: number }) => ({
    config: { language: 'tr', storeCountryCode: 'TR', minimumDiscountPercent: 30 } as never,
    items: [item], capturedAt: '2026-10-03T00:00:00.000Z', rules: new Map(), history: [],
    preference: { mode: 'instant', timezone: null, quietStart: null, quietEnd: null, digestMinute: null } as never,
    priceHistory: { status: 'ready' as const, history: low
      ? { low: { ...low, discountPercent: 90, recordedAt: '2025-06-26T00:00:00.000Z' }, recent: [] } : null },
  });
  const view = { screen: 'detail' as const, page: 0, query: '', eligibleOnly: false, selectedAppId: 620 };

  it('offers a one-tap target at the Steam low and opens the game in the Steam app', async () => {
    const { buildAssistantView } = await import('../src/discord/assistant-view.js');
    const shown = JSON.stringify(buildAssistantView(data({ currency: 'USD', amountMinor: 99 }), view, 's').toJSON());
    expect(shown).toContain('"custom_id":"assistant:s:low"');
    expect(shown).toContain('open.html?app=620');
    expect(shown).toContain('Son Derece Olumlu');
    expect(JSON.stringify(buildAssistantView(data({ currency: 'TRY', amountMinor: 99 }), view, 's').toJSON()))
      .not.toContain('assistant:s:low');
  });
});

describe('unreleased and unavailable games', () => {
  it('reads Steam’s planned release only while a game is not out yet', async () => {
    const { parseUpcomingRelease } = await import('../src/steam/wishlist-parser.js');
    expect(parseUpcomingRelease({ steam_release_date: 1791824400, is_coming_soon: true, coming_soon_display: 'date_full' }))
      .toEqual({ date: new Date(1791824400 * 1000).toISOString(), precision: 'day' });
    expect(parseUpcomingRelease({ is_coming_soon: true, custom_release_date_message: 'Duyurulacak', coming_soon_display: 'text_tba' }))
      .toEqual({ message: 'Duyurulacak' });
    expect(parseUpcomingRelease({ steam_release_date: 1303186800 })).toBeUndefined();
  });

  it('shows the release as precisely as Steam states it', async () => {
    const { releaseDateText, noPriceText, unavailableGamesLine } = await import('../src/discord/ui/design.js');
    const at = '2026-10-12T17:00:00.000Z';
    expect(releaseDateText({ date: at, precision: 'day' }, 'tr')).toBe('12 Ekim 2026');
    expect(releaseDateText({ date: at, precision: 'month' }, 'en')).toBe('October 2026');
    expect(releaseDateText({ date: at, precision: 'quarter' }, 'tr')).toBe('2026 4. çeyrek');
    expect(releaseDateText({ date: '2027-12-31T08:00:00.000Z', precision: 'year' }, 'en')).toBe('2027');
    expect(releaseDateText({}, 'tr')).toBe('tarih henüz belli değil');
    expect(noPriceText({ upcoming: { message: 'Duyurulacak' } }, 'tr')).toBe('🗓️ Yakında · Duyurulacak');
    expect(unavailableGamesLine([{ code: 'STEAM_APP_REGION_UNAVAILABLE' }, { code: 'STEAM_APP_NOT_FOUND' },
      { code: 'STEAM_TIMEOUT' }], 'TR', 'tr')).toBe("🚫 1 oyun Türkiye mağazasında satılmıyor · 🗑️ 1 oyun Steam'den kaldırılmış");
    expect(unavailableGamesLine([{ code: 'STEAM_TIMEOUT' }], 'TR', 'en')).toBeNull();
  });

  it('tells a region-locked app apart from a removed one', () => {
    const parsed = parseStoreItemsResponse({ response: { store_items: [
      { id: 1, success: 15, visible: false, name: 'WolfTeam: Classic', unvailable_for_country_restriction: true },
      { id: 2, success: 15, visible: false, name: '' },
    ] } }, [1, 2]);
    expect((parsed.get(1) as { code?: string }).code).toBe('STEAM_APP_REGION_UNAVAILABLE');
    expect((parsed.get(2) as { code?: string }).code).toBe('STEAM_APP_NOT_FOUND');
  });

  it('never calls a game removed when Steam was only busy or answered without a result', () => {
    const parsed = parseStoreItemsResponse({ response: { store_items: [
      { id: 1, success: 20, name: '' },
      { id: 2, success: 84 },
      { id: 3, success: 16 },
      { id: 4, name: 'Game 4' },
      { id: 5, success: '1', name: 'Game 5' },
    ] } }, [1, 2, 3, 4, 5]);
    const codes = [1, 2, 3, 4, 5].map((appId) => (parsed.get(appId) as { code?: string }).code);
    expect(codes).toEqual([
      'STEAM_UPSTREAM_ERROR', 'STEAM_UPSTREAM_ERROR', 'STEAM_UPSTREAM_ERROR',
      'STEAM_SCHEMA_INVALID', 'STEAM_SCHEMA_INVALID',
    ]);
  });
});
