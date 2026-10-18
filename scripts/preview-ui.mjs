import { buildAssistantView } from '../dist/discord/assistant-view.js';
// Local design review from the production component builders. All values are demo fixtures.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildStatusV2Panel } from '../dist/discord/status-view-v2.js';
import { buildSaleNotificationPanel, buildInitialWishlistV2Page } from '../dist/discord/notification-components-v2.js';
import { buildCountryRangePanel } from '../dist/discord/ui/country-picker.js';
import { buildWishlistHiddenDm } from '../dist/discord/wishlist-hidden-notice.js';
import { buildSetupConfirmationPanel, buildSetupWelcomePanel } from '../dist/discord/setup-view.js';
import { buildSupportPanel, buildTicketClosedNotice, buildTicketHeader } from '../dist/discord/support/support-view.js';
const date = '2026-09-12T14:00:00.000Z';
const games = [[620, 'Portal 2', 1999, 199, 90], [1091500, 'Cyberpunk 2077', 5999, 2099, 65], [1086940, 'Baldur’s Gate 3', 5999, 4499, 25]];
const items = games.map(([appId, name, initialMinor, finalMinor, discountPercent]) => ({
  appId, name, priority: null, dateAdded: null, onSale: true, priceObservedAt: date,
  headerImageUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
  price: { currency: 'USD', initialMinor, finalMinor, discountPercent, isFree: false },
  storeFacts: { reviewLabel: 'Very Positive', reviewPercent: 94, reviewCount: 120000, steamDeck: 'verified',
    platforms: { windows: true, mac: appId === 620, linux: appId === 620 }, saleEndsAt: '2030-01-01T00:00:00.000Z' },
}));
const panels = {};
const ticket = { ticketId: 42, discordUserId: 'preview-user', guildId: 'g', channelId: 'tickets', topic: 'alerts', status: 'open',
  threadId: 't', openedAt: date, closedAt: null, closedBy: null };
for (const language of ['tr', 'en', 'de', 'fr']) {
  const config = {
    discordUserId: 'preview-user', configurationId: 'preview-config', configVersion: 1,
    steamId64: '76561198000000000', language, storeCountryCode: 'TR', enabled: true, minimumDiscountPercent: 30,
    dmOptInAt: date, dmDeliveryBlockedAt: null, dmDeliveryErrorCode: null, createdAt: date, updatedAt: date,
  };
  const dashboard = {
    status: 'ready', language, config,
    checkState: {
      discordUserId: 'preview-user', lastStartedAt: date, lastCompletedAt: date,
      lastStatus: 'success', lastErrorCode: null, nextScheduledAt: '2026-09-12T14:30:00.000Z',
      lastSuccessCompletedAt: date, lastSuccessCheckedCount: 24, lastSuccessOnSaleCount: 3,
      lastSuccessFreeCount: 0, lastSuccessUnknownPriceCount: 0, lastSuccessFailedItemCount: 0,
    },
    notificationQueue: { pending: 2, retry: 0, sending: 0, sent: 18, terminalFailed: 0, expired: 0 },
    latestPriceCurrencies: ['USD'], gameDiscountOverrideCount: 2,
  };
  const snapshot = {
    items, failedItemCount: 0, capturedAt: date, storeCountryCode: 'TR',
    globalMinimumDiscountPercent: 30, gameMinimumDiscountOverrides: new Map([[620, 75]]),
  };
  const notifications = items.map((item) => ({
    discordUserId: 'preview-user', appId: item.appId, saleEpisodeId: 'preview', gameName: item.name,
    currency: 'USD', normalPriceMinor: item.price.initialMinor, finalPriceMinor: item.price.finalMinor,
    discountPercent: item.price.discountPercent, createdAt: date, storeCountryCode: 'TR', storeFacts: item.storeFacts,
  }));
  const assistantData={config,items,capturedAt:date,rules:new Map([[620,{mode:'target',targetMinor:299,currency:'USD',percent:null,muted:false,revision:1}]]),
    preference:{mode:'quiet',timezone:'Europe/Istanbul',quietStart:1380,quietEnd:480,digestMinute:null},
    priceHistory:{status:'ready',history:{low:{currency:'USD',amountMinor:99,discountPercent:90,recordedAt:'2025-06-26T17:00:00Z',since:'2024-02-11T00:59:31Z'},
      recent:[{currency:'USD',amountMinor:199,discountPercent:80,recordedAt:date},{currency:'USD',amountMinor:999,discountPercent:0,recordedAt:'2026-08-15T12:00:00Z'}]}},
    history:[{game_name:'Portal 2',app_id:620,status:'sent',reason:'target:299:USD',created_at:date,delivered_at:date,discord_message_id:'123'},
      {game_name:'Cyberpunk 2077',app_id:1091500,status:'candidate',reason:'discount',created_at:date,delivered_at:null,discord_message_id:null}]};
  const personal=(screen,data=assistantData)=>[buildAssistantView(data,{screen,page:0,query:'',eligibleOnly:false,selectedAppId:620},'preview').toJSON()];
  panels[language] = {
    detail:personal('detail'), history:personal('history'), rhythm:personal('rhythm'),
    home: [buildStatusV2Panel(dashboard, 'preview', { mode: 'home',featuredDeal:items[0],eligibleDealCount:2,trackedGameCount:24,
      notificationPreference:assistantData.preference }).toJSON()],
    wishlist: personal('wishlist'),
    settings: [buildStatusV2Panel(dashboard, 'preview', { tabs: true }).toJSON()],
    notification: [buildSaleNotificationPanel(notifications, language).toJSON()],
    test: [buildSaleNotificationPanel([{ ...notifications[0], headerImageUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${notifications[0].appId}/header.jpg` }],
      language, { test: true, testSource: 'wishlist' }).toJSON()],
    welcome: [buildSetupWelcomePanel(language, 'preview').toJSON()],
    upcoming: personal('wishlist', { ...assistantData,
      items: [{ appId: 2719590, name: 'Light No Fire', priority: null, dateAdded: null, onSale: null, price: null,
        headerImageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/2719590/header.jpg', upcoming: { message: { tr: 'Duyurulacak', en: 'To be announced', de: 'Wird angekündigt', fr: 'À annoncer' }[language] } },
        { appId: 4080520, name: 'Horns of Deliverance', priority: null, dateAdded: null, onSale: null, price: null,
        headerImageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/4080520/header.jpg', upcoming: { date: '2026-10-12T17:00:00.000Z', precision: 'day' } },
        items[0]],
      errors: [{ appId: 1287290, code: 'STEAM_APP_REGION_UNAVAILABLE' }, { appId: 3510750, code: 'STEAM_APP_NOT_FOUND' }] }),
    free: [buildSaleNotificationPanel([{ ...notifications[1], finalPriceMinor: 0, discountPercent: 100 }], language).toJSON()],
    blocked: [buildStatusV2Panel({ ...dashboard, config: { ...config, enabled: false, dmDeliveryBlockedAt: date } }, 'preview', { mode: 'home' }).toJSON()],
    partial: [buildStatusV2Panel({ ...dashboard, checkState: { ...dashboard.checkState, lastStatus: 'unavailable', lastSuccessUnknownPriceCount: 4 } }, 'preview', { mode: 'home' }).toJSON()],
    hidden: [buildStatusV2Panel({ ...dashboard, checkState: { ...dashboard.checkState, lastStatus: 'unavailable', lastErrorCode: 'STEAM_WISHLIST_INACCESSIBLE' } }, 'preview', { mode: 'home' }).toJSON(),
      buildStatusV2Panel({ ...dashboard, checkState: { ...dashboard.checkState, lastStatus: 'unavailable', lastErrorCode: 'STEAM_WISHLIST_INACCESSIBLE' } }, 'preview', { mode: 'status' }).toJSON()],
    hiddenDm: [buildWishlistHiddenDm(language, 'tracking').toJSON(), buildWishlistHiddenDm(language, 'setup').toJSON()],
    empty: personal('wishlist', { ...assistantData, items: [] }),
    expired: [buildStatusV2Panel(dashboard, 'preview', { mode: 'home', disabled: true }).toJSON()],
    region: [buildCountryRangePanel(language, 'preview', { selected: 'TR' }).toJSON()],
    supportPanel: [buildSupportPanel(language, { faqChannelId: 'faq' }).toJSON()],
    ticket: [buildTicketHeader(ticket, 'I set a target price for Hades but got no DM when it dropped to $9.99. My DMs are open.', language).toJSON(),
      buildTicketClosedNotice({ ...ticket, status: 'closed' }, 'preview-user', language).toJSON()],
    setup: [buildSetupConfirmationPanel({ discordUserId: 'preview-user', steamId64: '76561198000000000', language, storeCountryCode: 'TR', profile: { personaName: 'Bilgehan', avatarUrl: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg' } }, 'preview', { regionSelectionSource: 'discord-locale' }).toJSON()],
    summary: buildInitialWishlistV2Page({ discordUserId: 'preview-user', steamId64: '76561198000000000', language, storeCountryCode: 'TR',
      minimumDiscountPercent: 30, totalGameCount: 24, failedItemCount: 0, capturedAt: date, upcomingCount: 8,
      unavailableItems: [{ appId: 1287290, code: 'STEAM_APP_REGION_UNAVAILABLE' }],
      sales: notifications.map((n) => ({ ...n, normalPriceMinor: n.normalPriceMinor, headerImageUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${n.appId}/header.jpg` })) }, {}, 'preview', 0).components.map((c) => c.toJSON()),
  };
}
const data = JSON.stringify(panels).replaceAll('<', '\\u003c');
const html = await readFile(new URL('./ui-preview-shell.html', import.meta.url), 'utf8');
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/ui-preview.html', html.replace('DATA_PLACEHOLDER', data));
console.log('Design preview: .runtime/ui-preview.html');
