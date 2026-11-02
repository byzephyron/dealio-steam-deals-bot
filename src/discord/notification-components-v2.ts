import { artworkAccessory, addArtwork } from './ui/game-artwork.js';
import { defaultPollIntervalHours } from '../config/environment.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import type {
  InitialWishlistSale,
  InitialWishlistSummary,
} from '../application/initial-wishlist-summary-service.js';
import type { NotificationSendOptions, SaleNotification } from '../application/notification-service.js';
import { historicalLowLine, priceHistoryCredit } from './price-history-text.js';
import {
  countryDisplay, freeToKeepLine, unavailableGamesLine, hotDealPercent, hotPrefix, openPanelButton, platformText, priceLine, reviewLine,
  saleEndLine, savingsLine, smallWishlistHint, steamAppLink,
} from './ui/design.js';
import { historicalLowStanding } from '../domain/price-history.js';
import type { Language } from '../domain/user-config.js';
import { sanitizeGameName } from './notification-messages.js';
import { sortInitialWishlistSales, type InitialSummaryPresentationOptions } from './initial-wishlist-summary-messages.js';
import { languageNames, localizer, percentText } from './i18n.js';
import { messagesFor } from './messages.js';
import { dealioBrand } from './ui/brand.js';
import { assertComponentsV2Limit, componentsV2TextLength, dealioFooter } from './ui/components-v2.js';

/** The closing row of every Dealio DM: open the panel. Support links live in the panel, never in alerts. */
function messageActionRow(language: Language): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(openPanelButton(language));
}

/** One header for every alert: the kicker names the kind, the emoji its strength. */
function saleHeader(notifications: readonly SaleNotification[], language: Language, options: NotificationSendOptions): string {
  const t = localizer(language);
  const target = notifications.some((notification) => notification.reason?.startsWith('target:'));
  const free = notifications.every((notification) => notification.finalPriceMinor === 0);
  const lowest = notifications.every((notification) => {
    const standing = notification.historicalLow
      && historicalLowStanding(notification.finalPriceMinor, notification.currency, notification.historicalLow);
    return standing === 'new-low' || standing === 'matches-low';
  });
  const emoji = options.digest ? '📬' : free ? '🎁' : target ? '🎯' : lowest ? '🏆'
    : notifications.some((notification) => notification.discountPercent >= hotDealPercent) ? '🔥' : '🔔';
  const kind = t(options.digest ? { tr: 'GÜNLÜK ÖZET', en: 'DAILY DIGEST', de: 'TÄGLICHE ZUSAMMENFASSUNG', fr: 'RÉSUMÉ DU JOUR' }
    : free ? { tr: 'ÜCRETSİZ', en: 'FREE TO KEEP', de: 'GRATIS', fr: 'GRATUIT' }
    : lowest ? { tr: 'EN DÜŞÜK FİYAT', en: 'LOWEST PRICE', de: 'TIEFSTPREIS', fr: 'PRIX LE PLUS BAS' }
    : { tr: 'İNDİRİM', en: 'SALE', de: 'ANGEBOT', fr: 'PROMO' });
  const title = options.digest
    ? t({ tr: 'Günlük istek listesi özetin', en: 'Your daily wishlist digest', de: 'Deine tägliche Wunschlisten-Zusammenfassung', fr: 'Ton résumé quotidien' })
    : free ? freeTitle(language, notifications.length)
    : target ? t({ tr: 'Beklediğin fiyat geldi!', en: 'Your target price is here!', de: 'Dein Wunschpreis ist da!', fr: 'Ton prix cible est atteint !' })
    : saleTitle(language, notifications.length);
  // A test is the real alert with a TEST tag, so the user sees exactly what will arrive.
  return `-# ${options.test ? '🧪' : emoji} DEALIO · ${options.test ? `TEST · ${kind}` : kind}\n# ${emoji} ${title}`;
}

export function buildSaleNotificationPanel(
  notifications: readonly SaleNotification[],
  language: Language,
  options: NotificationSendOptions = {},
): ContainerBuilder {
  if (notifications.length === 0 || notifications.length > 10) {
    throw new Error('A Dealio notification panel must contain between 1 and 10 games');
  }
  const messages = messagesFor(language);
  const container = new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.success)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(saleHeader(notifications, language, options)),
      new TextDisplayBuilder().setContent(options.test
        ? `> 🧪 ${options.testSource === 'example' ? messages.testNotificationExampleDescription : messages.testNotificationDescription}`
        : saleDescription(language, notifications.length) + (options.firstAlert ? '\n-# 🎉 ' + firstAlertTip(language) : '')),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const gameTexts: Array<{
    display: TextDisplayBuilder; name: string; heading: (title: string) => string; details: string; compact: string;
  }> = [];
  for (const notification of notifications) {
    const storeUrl = `https://store.steampowered.com/app/${notification.appId}/`;
    const name = sanitizeGameName(notification.gameName);
    const price = {
      finalMinor: notification.finalPriceMinor,
      initialMinor: notification.normalPriceMinor,
      discountPercent: notification.discountPercent,
      currency: notification.currency,
    };
    const lines = (compact: boolean) => [
      priceLine(price, language),
      freeToKeepLine(price, language),
      notification.reason?.startsWith('target:') ? '🎯 ' + localizer(language)({
        tr: 'Koyduğun hedef fiyata ulaştı.', en: 'It hit your target price.', de: 'Dein Wunschpreis ist erreicht.', fr: 'Ton prix cible est atteint.',
      }) : null,
      ...historicalLowLines(notification, language),
      savingsLine(price, language),
      saleEndLine(notification.storeFacts, language),
      compact ? null : reviewLine(notification.storeFacts, language),
      '-# ' + [
        countryDisplay(notification.storeCountryCode, language),
        compact ? null : platformText(notification.storeFacts),
        compact ? null : steamAppLink(notification.appId, language),
      ].filter(Boolean).join(' · '),
    ].filter(Boolean).join('\n');
    const heading = (title: string) => `## ${hotPrefix(notification.discountPercent)}[${title}](${storeUrl})`;
    const details = lines(false);
    const display = new TextDisplayBuilder().setContent(`${heading(name)}\n${details}`);
    gameTexts.push({ display, name, heading, details, compact: lines(true) });
    container.addSectionComponents(
      artworkAccessory(new SectionBuilder().addTextDisplayComponents(display), notification),
    );
  }
  if (notifications.some((notification) => historicalLowLines(notification, language).length > 0)) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(priceHistoryCredit(language)));
  }
  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(dealioFooter(language)))
    .addActionRowComponents(messageActionRow(language));
  // Legacy durable batches retain all their games and their delivery identity.
  // Over Discord's combined text budget, drop the optional Store context first,
  // then shorten titles.
  if (componentsV2TextLength([container]) > 4000) {
    for (const game of gameTexts) {
      game.details = game.compact;
      game.display.setContent(`${game.heading(game.name)}\n${game.details}`);
    }
  }
  let excess = componentsV2TextLength([container]) - 4000;
  for (const game of [...gameTexts].sort((a, b) => b.name.length - a.name.length)) {
    if (excess <= 0) break;
    const limit = Math.max(16, game.name.length - excess);
    if (limit >= game.name.length) continue;
    const shortName = game.name.slice(0, limit - 3).replace(/\\$/, '') + '...';
    game.display.setContent(`${game.heading(shortName)}\n${game.details}`);
    excess -= game.name.length - shortName.length;
  }
  assertComponentsV2Limit([container]);
  return container;
}

function historicalLowLines(notification: SaleNotification, language: Language): string[] {
  const line = notification.historicalLow
    && historicalLowLine(notification.finalPriceMinor, notification.currency, notification.historicalLow, language);
  return line ? [line] : [];
}

export interface InitialWishlistV2Page {
  readonly components: readonly ContainerBuilder[];
  readonly pageIndex: number;
  readonly totalPages: number;
}

export function buildInitialWishlistV2Page(
  summary: InitialWishlistSummary,
  options: InitialSummaryPresentationOptions,
  sessionId: string,
  requestedPageIndex: number,
  disabled = false,
): InitialWishlistV2Page {
  const messages = messagesFor(summary.language);
  const sales = sortInitialWishlistSales(summary.sales);
  const totalPages = Math.max(1, sales.length);
  const pageIndex = Math.min(Math.max(0, requestedPageIndex), totalPages - 1);
  const sale = sales[pageIndex];
  const profileUrl = `https://steamcommunity.com/profiles/${summary.steamId64}`;
  const container = new ContainerBuilder().setAccentColor(dealioBrand.colors.success);
  if (options.bannerUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(options.bannerUrl).setDescription('Dealio'),
      ),
    );
  }
  if (options.avatarUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**Dealio**'))
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(options.avatarUrl).setDescription('Dealio'),
        ),
    );
  }
  const language = summary.language;
  const t = localizer(language);
  const one = (count: number) => count === 1;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ✨ DEALIO · ${t({
      tr: 'KURULUM TAMAM', en: 'SETUP COMPLETE', de: 'EINRICHTUNG FERTIG', fr: 'CONFIGURATION TERMINÉE',
    })}\n# 👋 ${messages.initialSummaryTitle}\n` +
      messages.initialSummaryDescription(summary.sales.length, summary.failedItemCount)),
    new TextDisplayBuilder().setContent([
      `👤 [${maskSteamId(summary.steamId64)}](${profileUrl})　${countryDisplay(summary.storeCountryCode, language)}　🌐 ${languageNames[language]}`,
      `🎮 **${summary.totalGameCount}** ${t({ tr: 'oyun', en: 'games', de: 'Spiele', fr: 'jeux' })}${summary.failedItemCount > 0 ? ` · ${messages.wishlistFailedItems(summary.failedItemCount)}` : ''}` +
        `　🔔 ${minimumDiscountLine(summary.minimumDiscountPercent, language)}`,
      ...[[
        summary.upcomingCount ? `🗓️ ${t({
          tr: `${summary.upcomingCount} oyun henüz çıkmadı; çıkınca fiyatını takip edeceğim`,
          en: `${summary.upcomingCount} ${one(summary.upcomingCount) ? 'game isn’t' : 'games aren’t'} out yet; I’ll track the price once released`,
          de: `${summary.upcomingCount} ${one(summary.upcomingCount) ? 'Spiel ist' : 'Spiele sind'} noch nicht erschienen; den Preis verfolge ich ab Release`,
          fr: `${summary.upcomingCount} ${one(summary.upcomingCount) ? 'jeu n’est pas encore sorti' : 'jeux ne sont pas encore sortis'} ; je suivrai le prix à la sortie`,
        })}` : null,
        unavailableGamesLine(summary.unavailableItems, summary.storeCountryCode, summary.language),
      ].filter(Boolean).join(' · '), smallWishlistHint(summary.totalGameCount, language)].filter(Boolean).map((line) => `-# ${line}`),
      `-# 🔄 ${messages.setupWizardFrequency(options.pollIntervalHours ?? defaultPollIntervalHours)} · ${t({
        tr: 'Oyun kuralları, bildirim saatleri ve ayarlar Dealio panelinde seni bekliyor.',
        en: 'Game rules, alert timing and settings are in the Dealio panel.',
        de: 'Spielregeln, Benachrichtigungszeiten und Einstellungen findest du im Dealio-Panel.',
        fr: 'Règles par jeu, horaires des alertes et réglages sont dans le panneau Dealio.',
      })}`,
    ].join('\n')),
  );

  if (sale) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    addArtwork(container, sale)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(initialSaleText(sale, summary)));
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(summary.failedItemCount > 0
        ? `> ⚠️ ${messages.initialSummaryIncomplete}` : `> ✅ ${messages.initialSummaryNoSales}`),
    );
  }

  if (totalPages > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`dealio-summary:${sessionId}:previous`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || pageIndex === 0),
        new ButtonBuilder().setCustomId(`dealio-summary:${sessionId}:page`).setLabel(`${pageIndex + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`dealio-summary:${sessionId}:next`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || pageIndex >= totalPages - 1),
      ),
    );
  }
  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(dealioFooter(summary.language)))
    .addActionRowComponents(messageActionRow(summary.language));
  assertComponentsV2Limit([container]);
  return { components: [container], pageIndex, totalPages };
}

function initialSaleText(sale: InitialWishlistSale, summary: InitialWishlistSummary): string {
  const messages = messagesFor(summary.language);
  const storeUrl = `https://store.steampowered.com/app/${sale.appId}/`;
  const price = {
    finalMinor: sale.finalPriceMinor,
    initialMinor: sale.normalPriceMinor,
    discountPercent: sale.discountPercent,
    currency: sale.currency,
  };
  const language = summary.language;
  return [
    `## ${hotPrefix(sale.discountPercent)}[${sanitizeGameName(sale.gameName)}](${storeUrl})`,
    priceLine(price, language),
    freeToKeepLine(price, language),
    savingsLine(price, language),
    saleEndLine(sale.storeFacts, language),
    reviewLine(sale.storeFacts, language),
    '-# ' + [
      countryDisplay(summary.storeCountryCode, language),
      platformText(sale.storeFacts),
      `[🛒 ${messages.openSteamStore}](${storeUrl})`,
      steamAppLink(sale.appId, language),
    ].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');
}

function maskSteamId(steamId64: string): string {
  return `${steamId64.slice(0, 5)}••••••••${steamId64.slice(-4)}`;
}

/** "🔔 %30 ve üzeri indirimlerde DM atarım": the global rule in one line. */
function minimumDiscountLine(percent: number, language: Language): string {
  const value = percentText(percent, language);
  return localizer(language)({
    tr: `${value} ve üzeri indirimlerde DM atarım`,
    en: `I DM you at ${value} off or more`,
    de: `DM ab ${value} Rabatt`,
    fr: `MP dès ${value} de réduction`,
  });
}

function freeTitle(language: Language, count: number): string {
  return localizer(language)(count === 1 ? {
    tr: 'İstek listendeki bir oyun ücretsiz!',
    en: 'A game on your wishlist is free to keep!',
    de: 'Ein Spiel von deiner Wunschliste ist gratis!',
    fr: 'Un jeu de ta liste est gratuit !',
  } : {
    tr: `İstek listende ${count} oyun ücretsiz!`,
    en: `${count} games on your wishlist are free to keep!`,
    de: `${count} Spiele von deiner Wunschliste sind gratis!`,
    fr: `${count} jeux de ta liste sont gratuits !`,
  });
}

function saleTitle(language: Language, count: number): string {
  return localizer(language)(count === 1 ? {
    tr: 'İstek listendeki bir oyun indirimde!',
    en: 'A game on your wishlist is on sale!',
    de: 'Ein Spiel von deiner Wunschliste ist im Angebot!',
    fr: 'Un jeu de ta liste est en promo !',
  } : {
    tr: `İstek listendeki ${count} oyun indirimde!`,
    en: `${count} games on your wishlist are on sale!`,
    de: `${count} Spiele von deiner Wunschliste sind im Angebot!`,
    fr: `${count} jeux de ta liste sont en promo !`,
  });
}

function saleDescription(language: Language, count: number): string {
  const one = count === 1;
  return localizer(language)({
    tr: `Kuralına uyan ${count} fırsat buldum. Fiyatlar senin Steam mağaza bölgenden.`,
    en: `I found ${count} ${one ? 'deal' : 'deals'} matching your rules. Prices are from your Steam Store region.`,
    de: `Ich habe ${count} ${one ? 'Angebot' : 'Angebote'} nach deinen Regeln gefunden. Die Preise stammen aus deiner Steam-Shop-Region.`,
    fr: `J’ai trouvé ${count} ${one ? 'bon plan qui correspond' : 'bons plans qui correspondent'} à tes règles. Les prix viennent de ta région Steam.`,
  });
}

/** Once, on a newcomer's first sale alert: how to wait for a game at a price of their own. */
function firstAlertTip(language: Language): string {
  return localizer(language)({
    tr: 'Bu sana attığım ilk indirim mesajı. Bir oyunu belli bir fiyata mı bekliyorsun? Panelde oyunu seç ve hedef fiyatını yaz.',
    en: 'This is your first Dealio alert. Waiting for a game to hit a certain price? Pick it in the panel and set a target price.',
    de: 'Das ist deine erste Dealio-Nachricht. Wartest du bei einem Spiel auf einen bestimmten Preis? Wähl es im Panel aus und leg einen Wunschpreis fest.',
    fr: 'C’est ta première alerte Dealio. Tu attends un prix précis pour un jeu ? Choisis-le dans le panneau et fixe un prix cible.',
  });
}
