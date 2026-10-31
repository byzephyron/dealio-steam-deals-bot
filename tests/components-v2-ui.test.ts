import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { storeCountryCodes } from '../src/domain/store-country.js';
import type { WishlistItem } from '../src/domain/steam.js';
import { buildAssistantView } from '../src/discord/assistant-view.js';
import { buildStatusV2Panel } from '../src/discord/status-view-v2.js';
import { buildSetupCountrySelectOptions } from '../src/discord/setup-view.js';
import {
  buildCountryListPanel,
  buildCountryRangePanel,
  buildStoreCountryRanges,
} from '../src/discord/ui/country-picker.js';
import {
  assertComponentsV2Limit,
  countComponentsV2,
  dealioEphemeralV2Flags,
} from '../src/discord/ui/components-v2.js';
import { buildInitialWishlistV2Page, buildSaleNotificationPanel } from '../src/discord/notification-components-v2.js';
import { DiscordNotificationSender } from '../src/discord/notification-sender.js';
import { dealioUiSessions } from '../src/discord/ui/session-manager.js';

function wishlistItems(count: number): WishlistItem[] {
  return Array.from({ length: count }, (_, index) => ({
    appId: index + 1,
    name: `A very presentable Dealio game ${index + 1}`,
    priority: index + 1,
    dateAdded: 1_700_000_000 + index,
    price: {
      currency: 'TRY',
      initialMinor: 1_000 + index,
      finalMinor: 500 + index,
      discountPercent: 50,
      isFree: false,
    },
    onSale: true,
  }));
}

function notification(index: number) {
  return {
    discordUserId: 'discord-user',
    appId: index + 1,
    saleEpisodeId: `episode-${index}`,
    gameName: `Game ${index + 1}`,
    currency: 'TRY',
    normalPriceMinor: 1_000,
    finalPriceMinor: 500,
    discountPercent: 50,
    storeCountryCode: 'TR' as const,
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}

describe('Dealio Components V2 UI', () => {
  it.each(['tr','en'] as const)('does not claim no sales when the initial scan is incomplete in %s', language => {
    const page=buildInitialWishlistV2Page({discordUserId:'u',steamId64:'76561198000000000',language,
      storeCountryCode:'TR',minimumDiscountPercent:0,totalGameCount:2,failedItemCount:1,
      capturedAt:'2026-09-19T00:00:00Z',sales:[]},{},'session',0);
    const text=JSON.stringify(page.components[0].toJSON());
    expect(text).toContain(language==='tr'?'Bazı fiyatları alamadım':'I couldn’t get a few prices');
    expect(text).not.toContain(language==='tr'?'şu anda indirimde oyun yok':'no discounted games');
    expect(text).not.toContain(language==='tr'?'Şu anda indirimde oyun bulunmuyor':'No games are currently discounted');
  });
  it.each(['tr','en'] as const)('keeps donation links out of sale and initial wishlist DMs in %s', language => {
    const sale=buildSaleNotificationPanel([notification(1),notification(2)],language).toJSON();
    const summary={discordUserId:'u',steamId64:'76561198000000000',language,storeCountryCode:'TR' as const,
      minimumDiscountPercent:0,totalGameCount:0,failedItemCount:0,capturedAt:'2026-09-19T00:00:00Z',sales:[]};
    const initial=buildInitialWishlistV2Page(summary,{},'session',0,true).components[0].toJSON();
    for(const panel of [sale,initial]) {
      const buttons=panel.components.filter(c=>c.type===1).flatMap(row=>row.components);
      expect(buttons.filter(b=>'url' in b&&String(b.url).includes('buymeacoffee'))).toHaveLength(0);
      expect(JSON.stringify(panel)).not.toContain('top.gg');
      expect(JSON.stringify(panel)).not.toContain(language==='tr'?'Destek ol':'Support Dealio');
      expect(countComponentsV2([panel])).toBeLessThanOrEqual(40);
    }
  });
  it('distinguishes active, foreign, and genuinely expired panels without timing guesses', () => {
    const close = dealioUiSessions.open('session-test', 'owner', ['dealio', 'country'], 60_000);
    expect(dealioUiSessions.resolve('dealio:session-test:wishlist', 'owner')).toBe('active-owner');
    expect(dealioUiSessions.resolve('country:session-test:range', 'other')).toBe('active-other-user');
    close();
    expect(dealioUiSessions.resolve('dealio:session-test:wishlist', 'owner')).toBe('expired');
  });

  it('rejects combined text over the Discord message limit', () => {
    expect(() => assertComponentsV2Limit([
      { type: 17, components: [
        { type: 10, content: 'a'.repeat(2000) },
        { type: 9, components: [{ type: 10, content: 'b'.repeat(2001) }] },
      ] },
    ] as never)).toThrow('4000');
  });

  it.each(['tr', 'en'] as const)('fits legacy ten-game alerts with long names in %s', (language) => {
    const panel = buildSaleNotificationPanel(Array.from({ length: 10 }, (_, index) => ({
      ...notification(index), appId: 2147483647 - index,
      gameName: 'A'.repeat(256),
      normalPriceMinor: 99999999, finalPriceMinor: 49999999,
    })), language);
    const json = JSON.stringify(panel.toJSON());
    let length = 0;
    JSON.stringify(panel.toJSON(), (key, value: unknown) => {
      if (key === 'content' && typeof value === 'string') length += value.length;
      return value;
    });
    expect(length).toBeGreaterThan(0);
    expect(length).toBeLessThanOrEqual(4000);
    for (let index = 0; index < 10; index += 1) {
      expect(json).toContain('/app/' + (2147483647 - index) + '/');
    }
  });

  it('uses the combined ephemeral and Components V2 message flags', () => {
    expect(dealioEphemeralV2Flags)
      .toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it('makes every supported Store country reachable without exceeding 25 options', () => {
    for (const language of ['tr', 'en'] as const) {
      const ranges = buildStoreCountryRanges(language);
      expect(ranges.every((range) => range.countries.length <= 25)).toBe(true);
      expect(ranges.flatMap((range) => range.countries).sort())
        .toEqual([...storeCountryCodes].sort());
      expect(countComponentsV2([buildCountryRangePanel(language, 'session')])).toBeLessThanOrEqual(40);
      for (const range of ranges) {
        expect(countComponentsV2([
          buildCountryListPanel(language, 'session', range.index),
        ])).toBeLessThanOrEqual(40);
      }
    }
  });

  it('keeps the setup modal quick list at 24 countries plus Other', () => {
    const options = buildSetupCountrySelectOptions('tr', 'TR');
    expect(options).toHaveLength(25);
    expect(options).toContainEqual(expect.objectContaining({ value: 'TR', default: true }));
    expect(options).toContainEqual(expect.objectContaining({ value: 'OTHER' }));
  });

  it.each([0, 1, 3, 4, 10, 11])(
    'renders a three-game wishlist panel safely for %i games',
    (count) => {
      const panel = buildAssistantView({
        config: { discordUserId: 'u', configurationId: 'c', steamId64: '76561198000000000', configVersion: 1, language: 'tr',
          storeCountryCode: 'TR', enabled: true, minimumDiscountPercent: 20, createdAt: '', updatedAt: '' } as never,
        items: wishlistItems(count), capturedAt: '2026-08-29T00:00:00.000Z', rules: new Map(), history: [],
        preference: { mode: 'instant', timezone: null, quietStart: null, quietEnd: null, digestMinute: null },
      }, { screen: 'wishlist', page: 0, query: '', eligibleOnly: false }, 'session');
      const json = JSON.stringify(panel.toJSON());
      expect(json.match(/"type":9/g) ?? []).toHaveLength(Math.min(3, count));
      const pages = Math.max(1, Math.ceil(count / 3));
      if (pages > 1) expect(json).toContain(`1 / ${pages}`);
      expect(countComponentsV2([panel])).toBeLessThanOrEqual(40);
    },
  );

  it.each(['home', 'status'] as const)('renders the %s dashboard with valid action rows', (mode) => {
    const panel = buildStatusV2Panel({
      status: 'ready',
      language: 'tr',
      config: {
        discordUserId: 'discord-user',
        configurationId: 'configuration-id',
        steamId64: '76561198000000000',
        configVersion: 1,
        language: 'tr',
        storeCountryCode: 'TR',
        enabled: true,
        minimumDiscountPercent: 20,
        dmOptInAt: '2026-08-29T00:00:00.000Z',
        dmDeliveryBlockedAt: null,
        dmDeliveryErrorCode: null,
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      },
      checkState: null,
      notificationQueue: {
        pending: 0, retry: 0, sending: 0, sent: 0, terminalFailed: 0, expired: 0,
      },
      latestPriceCurrencies: ['TRY'],
      gameDiscountOverrideCount: 0,
    }, 'session', {
      mode,
      bannerUrl: 'https://i.imgur.com/JsawzhP.png',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(countComponentsV2([panel])).toBeLessThanOrEqual(40);
    const serialized = JSON.stringify(panel.toJSON());
    expect(serialized).toContain(mode === 'home' ? 'Senin istek listen, senin kuralların!' : 'Hesabın ve tercihlerin');
    expect(serialized).toContain(mode === 'home' ? 'İlk kontrol birazdan' : 'Henüz kontrol yapılmadı');
    const rows = panel.toJSON().components.filter((component) => component.type === 1);
    // Home: check, help, support and vote links, then the four tabs. Settings: tracking, discount, test DM;
    // region, language, account, delete.
    expect(rows.map((row) => row.components.length)).toEqual(mode === 'home' ? [4, 4] : [3, 4]);
    expect(serialized).not.toContain('↻');
  });

  it.each([1, 5, 10])('renders a safe grouped notification panel for %i games', (count) => {
    const panel = buildSaleNotificationPanel(
      Array.from({ length: count }, (_, index) => notification(index)),
      'tr',
    );
    expect(countComponentsV2([panel])).toBeLessThanOrEqual(40);
  });

  it.each([
    [1, [1]],
    [5, [5]],
    [10, [10]],
    [11, [10, 1]],
    [20, [10, 10]],
    [25, [10, 10, 5]],
  ] as const)('puts %i new sale alerts into as few DMs as possible', (count, expected) => {
    const sender = new DiscordNotificationSender({ rest: { post: vi.fn() } } as never);
    expect(sender.plan(
      Array.from({ length: count }, (_, index) => notification(index)),
      'tr',
    ).map((batch) => batch.notifications.length)).toEqual(expected);
  });
});
