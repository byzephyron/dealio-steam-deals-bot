import { ButtonBuilder, ButtonStyle } from 'discord.js';
import { storeCountryName, type StoreCountryCode } from '../../domain/store-country.js';
import { languageLocale, needsSharedPlace, type Language, type UserConfig } from '../../domain/user-config.js';
import type { CheckState } from '../../domain/check-state.js';
import type { StoreFacts, UpcomingRelease, WishlistItem, WishlistItemError } from '../../domain/steam.js';
import { localizer, percentText, type Localized } from '../i18n.js';
import { formatMinorPrice } from '../notification-messages.js';
import { dealioBrand } from './brand.js';
import { openPanelCustomId } from './components-v2.js';
import type { DealioTab } from './tab-bar.js';

/**
 * The shared look of every Dealio screen: one header pattern, one accent per
 * tab, and the same price line and badges, so the four tabs read as one app.
 */
export const tabAccent: Record<DealioTab, number> = {
  home: dealioBrand.colors.primary,
  games: dealioBrand.colors.success,
  alerts: dealioBrand.colors.accent,
  settings: 0xc7d5e0,
};

/** The four tabs' names, shared by the tab row and every panel header. */
export const tabNames: Record<DealioTab, { readonly emoji: string; readonly label: Localized }> = {
  home: { emoji: '🏠', label: { tr: 'Ana sayfa', en: 'Home', de: 'Start', fr: 'Accueil' } },
  games: { emoji: '🎮', label: { tr: 'İstek listem', en: 'Wishlist', de: 'Wunschliste', fr: 'Ma liste' } },
  alerts: { emoji: '🔔', label: { tr: 'Bildirimler', en: 'Alerts', de: 'Preisalarme', fr: 'Alertes' } },
  settings: { emoji: '⚙️', label: { tr: 'Ayarlar', en: 'Settings', de: 'Einstellungen', fr: 'Réglages' } },
};

/** "-# 🎮 DEALIO · İSTEK LİSTEM": the small line naming the tab above every screen. */
export function panelKicker(tab: DealioTab, language: Language): string {
  const section = tabNames[tab];
  return `-# ${section.emoji} DEALIO · ${section.label[language].toLocaleUpperCase(languageLocale[language])}`;
}

/** The tab's kicker, a large title and an optional one-line subtitle. */
export function panelHeader(tab: DealioTab, language: Language, title: string, subtitle?: string): string {
  return `${panelKicker(tab, language)}\n${titleHeading(title)} ${title}${subtitle ? `\n${subtitle}` : ''}`;
}

/** Past this length a large title wraps on a phone; a smaller heading keeps it on one line. */
const oneLineTitleLength = 40;

function titleHeading(title: string): string {
  return title.length > oneLineTitleLength ? '###' : '#';
}

/** "Fiyatı Steam’den 5 dakika önce aldım": when a shown price was read, around a Discord relative time. */
export function priceFetched(at: string, language: Language, plural = false): string {
  return localizer(language)(plural ? {
    tr: `Fiyatları Steam’den ${at} aldım`,
    en: `Prices from Steam, ${at}`,
    de: `Preise von Steam, ${at}`,
    fr: `Prix Steam relevés ${at}`,
  } : {
    tr: `Fiyatı Steam’den ${at} aldım`,
    en: `Price from Steam, ${at}`,
    de: `Preis von Steam, ${at}`,
    fr: `Prix Steam relevé ${at}`,
  });
}

/** "🇹🇷 Türkiye": the one way a Store country is shown. */
export function countryDisplay(countryCode: StoreCountryCode, language: Language): string {
  return `${flagEmoji(countryCode)} ${storeCountryName(countryCode, language)}`;
}

/** The country's flag from its two-letter code (regional indicator symbols). */
export function flagEmoji(countryCode: string): string {
  return /^[A-Z]{2}$/.test(countryCode)
    ? String.fromCodePoint(...[...countryCode].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
    : '🌍';
}

/** From this discount on a deal is "hot": 🔥 and the green dot are reserved for it. */
export const hotDealPercent = 60;

/** How strong a discount is at a glance: 🟢 hot (60%+), 🟡 good (30%+), 🟠 small. */
export function discountTier(percent: number): string {
  return percent >= hotDealPercent ? '🟢' : percent >= 30 ? '🟡' : '🟠';
}

/** "🎁 " for a free-to-keep game, "🔥 " for a hot deal, nothing otherwise, so each keeps its meaning. */
export function hotPrefix(percent: number | null | undefined): string {
  return (percent ?? 0) >= 100 ? '🎁 ' : (percent ?? 0) >= hotDealPercent ? '🔥 ' : '';
}

/** "🟢 `−%90`": the tier dot and an inline-code pill, which Discord draws as a small badge. */
export function discountBadge(percent: number, language: Language): string {
  return `${discountTier(percent)} \`−${percentText(percent, language)}\``;
}

/** "**$1,99**  ~~$19,99~~  🟢 `−%90`", or the price alone when there is no discount. */
export function priceLine(
  price: { readonly finalMinor: number; readonly initialMinor: number; readonly discountPercent: number; readonly currency: string },
  language: Language,
): string {
  const freeToKeep = price.finalMinor === 0 && price.initialMinor > 0;
  const free = localizer(language)({ tr: 'Ücretsiz', en: 'Free', de: 'Kostenlos', fr: 'Gratuit' });
  const final = `**${freeToKeep ? free : formatMinorPrice(price.finalMinor, price.currency, language)}**`;
  return price.discountPercent > 0 && price.initialMinor > price.finalMinor
    ? `${final}  ~~${formatMinorPrice(price.initialMinor, price.currency, language)}~~  ${discountBadge(price.discountPercent, language)}`
    : final;
}

/** "💰 $18,00 cebinde kalır" for a discounted price, else null. */
export function savingsLine(
  price: { readonly finalMinor: number; readonly initialMinor: number; readonly currency: string },
  language: Language,
): string | null {
  const saved = price.initialMinor - price.finalMinor;
  if (saved <= 0) return null;
  const amount = formatMinorPrice(saved, price.currency, language);
  return localizer(language)({
    tr: `💰 ${amount} cebinde kalır`,
    en: `💰 You save ${amount}`,
    de: `💰 Du sparst ${amount}`,
    fr: `💰 Tu économises ${amount}`,
  });
}

/** "🏠 Dealio panel": opens a fresh /dealio panel from any message, DMs included. */

export function openPanelButton(language: Language, style: ButtonStyle = ButtonStyle.Primary): ButtonBuilder {
  return new ButtonBuilder().setCustomId(openPanelCustomId).setStyle(style).setEmoji('🏠')
    .setLabel(localizer(language)({ tr: 'Dealio paneli', en: 'Dealio panel', de: 'Dealio-Panel', fr: 'Panneau Dealio' }));
}

/** The Dealio support server; tickets are opened there. */
export const supportServerUrl = 'https://dsc.gg/dealiosupport';

/** "🛟 Get help": the support server, on the Home panel next to the coffee link, never in alert DMs. */
export function helpButton(language: Language): ButtonBuilder {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(supportServerUrl).setEmoji('🛟')
    .setLabel(localizer(language)({ tr: 'Yardım', en: 'Get help', de: 'Hilfe', fr: 'Aide' }));
}

/** The optional "support Dealio" link; shown on the Home panel only, never in alert DMs. */
export function supportButton(language: Language): ButtonBuilder {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setURL('https://buymeacoffee.com/dealio').setEmoji('☕')
    .setLabel(localizer(language)({ tr: 'Destek ol', en: 'Support Dealio', de: 'Dealio unterstützen', fr: 'Soutenir Dealio' }));
}

/**
 * Steam answered that the wishlist cannot be read: the user's own privacy setting
 * (or a deleted account), not a Steam outage, so the panel names the fix.
 */
export function wishlistHidden(checkState: Pick<CheckState, 'lastStatus' | 'lastErrorCode'> | null | undefined): boolean {
  return checkState?.lastStatus === 'unavailable' && checkState.lastErrorCode === 'STEAM_WISHLIST_INACCESSIBLE';
}

export const steamPrivacyUrl = 'https://steamcommunity.com/my/edit/settings';

/** "🔒 I can't see your wishlist…", with a link to Steam's privacy settings; Home and Settings show the same text. */
export function wishlistHiddenNotice(language: Language): string {
  return '🔒 ' + localizer(language)({
    tr: `İstek listeni göremiyorum, bu yüzden bildirim gönderemiyorum. [Steam gizlilik ayarlarında](${steamPrivacyUrl}) profilini ve “Oyun ayrıntıları”nı **Herkese Açık** yap; sonraki kontrolde kaldığım yerden devam ederim.`,
    en: `I can’t see your wishlist, so I can’t send alerts. In [Steam’s privacy settings](${steamPrivacyUrl}), set your profile and “Game details” to **Public**; I’ll pick up again at the next check.`,
    de: `Ich kann deine Wunschliste nicht sehen und deshalb keine Benachrichtigungen senden. Stell in den [Steam-Privatsphäre-Einstellungen](${steamPrivacyUrl}) dein Profil und „Spieldetails“ auf **Öffentlich**; bei der nächsten Prüfung mache ich weiter.`,
    fr: `Je ne vois pas ta liste de souhaits, donc je ne peux pas t’envoyer d’alertes. Dans les [paramètres de confidentialité Steam](${steamPrivacyUrl}), mets ton profil et « Détails des jeux » en **Public** ; je reprendrai à la prochaine vérification.`,
  });
}

/** "🔴 DM’lerin kapalı" or "🔴 DM’lerine ulaşamıyorum": the status line while Discord refuses Dealio’s DMs. */
export function dmBlockedStatus(config: Pick<UserConfig, 'dmDeliveryErrorCode'>, language: Language): string {
  return '🔴 ' + localizer(language)(needsSharedPlace(config)
    ? { tr: 'DM’lerine ulaşamıyorum', en: 'Can’t reach your DMs', de: 'DMs nicht erreichbar', fr: 'MP injoignables' }
    : { tr: 'DM’lerin kapalı', en: 'DMs blocked', de: 'DMs blockiert', fr: 'MP bloqués' });
}

/**
 * The first step to get DMs back, by why Discord refused them: a privacy setting, or
 * no shared server and no app install (then Discord lets no bot DM the user).
 */
export function dmBlockedFix(config: Pick<UserConfig, 'dmDeliveryErrorCode'>, language: Language): string {
  return localizer(language)(needsSharedPlace(config) ? {
    tr: 'Dealio’yu uygulamalarına ekle (“Uygulamalarıma Ekle”) ya da bulunduğun bir sunucuya ekle',
    en: 'Add Dealio to your apps (“Add to My Apps”) or to a server you’re in',
    de: 'Füg Dealio deinen Apps hinzu („Zu meinen Apps hinzufügen“) oder einem Server, auf dem du bist',
    fr: 'Ajoute Dealio à tes applis (« Ajouter à mes applis ») ou à un serveur où tu es',
  } : {
    tr: 'Discord’da DM’lerini aç',
    en: 'Allow DMs in Discord',
    de: 'Erlaube DMs in Discord',
    fr: 'Autorise les MP dans Discord',
  });
}

/** Steam's own wording for each Steam Deck rating. */
const steamDeckLabels: Record<'verified' | 'playable' | 'unsupported', Localized> = {
  verified: { tr: 'Doğrulandı', en: 'Verified', de: 'Verifiziert', fr: 'Vérifié' },
  playable: { tr: 'Oynanabilir', en: 'Playable', de: 'Spielbar', fr: 'Jouable' },
  unsupported: { tr: 'Desteklenmiyor', en: 'Unsupported', de: 'Nicht unterstützt', fr: 'Non pris en charge' },
};

/** "⭐ Son Derece Olumlu · %98　🎮 Steam Deck: Doğrulandı", or null when Steam gave neither. */
export function reviewLine(facts: StoreFacts | undefined, language: Language): string | null {
  const parts: string[] = [];
  if (facts?.reviewLabel || facts?.reviewPercent !== undefined) {
    const percent = facts.reviewPercent === undefined ? null : percentText(facts.reviewPercent, language);
    parts.push(`⭐ ${[facts.reviewLabel ? `**${facts.reviewLabel}**` : null, percent].filter(Boolean).join(' · ')}`);
  }
  if (facts?.steamDeck) parts.push(`🎮 Steam Deck${language === 'fr' ? ' :' : ':'} ${steamDeckLabels[facts.steamDeck][language]}`);
  return parts.length > 0 ? parts.join('　') : null;
}

/** "💻 Windows · macOS · Linux", or null. */
export function platformText(facts: StoreFacts | undefined): string | null {
  const platforms = facts?.platforms;
  if (!platforms) return null;
  const names = [platforms.windows && 'Windows', platforms.mac && 'macOS', platforms.linux && 'Linux'].filter(Boolean);
  return names.length > 0 ? `💻 ${names.join(' · ')}` : null;
}

/** "⏳ İndirim 3 gün içinde bitiyor" (a Discord relative time), only for a future end. */
export function saleEndLine(facts: StoreFacts | undefined, language: Language, now = Date.now()): string | null {
  const end = facts?.saleEndsAt ? Date.parse(facts.saleEndsAt) : Number.NaN;
  if (!Number.isFinite(end) || end <= now) return null;
  const at = `<t:${Math.floor(end / 1000)}:R>`;
  return localizer(language)({
    tr: `⏳ İndirim ${at} bitiyor`,
    en: `⏳ Sale ends ${at}`,
    de: `⏳ Angebot endet ${at}`,
    fr: `⏳ La promo se termine ${at}`,
  });
}

/** "🎁 Sınırlı süre: şimdi alırsan oyun sonsuza kadar senin." for a 100% discount, else null. */
export function freeToKeepLine(price: { readonly finalMinor: number; readonly initialMinor: number }, language: Language): string | null {
  if (price.finalMinor !== 0 || price.initialMinor <= 0) return null;
  return localizer(language)({
    tr: '🎁 **Sınırlı süre ücretsiz:** şimdi kütüphanene eklersen oyun sonsuza dek senin.',
    en: '🎁 **Free for a limited time:** add it to your library now and it’s yours to keep.',
    de: '🎁 **Für kurze Zeit kostenlos:** Füg es jetzt deiner Bibliothek hinzu, dann gehört es für immer dir.',
    fr: '🎁 **Gratuit pour une durée limitée :** ajoute-le à ta bibliothèque maintenant, il est à toi pour toujours.',
  });
}

/**
 * Opens the game in the Steam app. Discord links accept only http(s), so a tiny
 * page on Dealio's public site forwards to steam://store/<appId>.
 */
export function steamAppUrl(appId: number): string {
  return `https://byzephyron.github.io/dealio-public-pages/open.html?app=${appId}`;
}

export const steamAppLabel: Localized = {
  tr: 'Steam uygulamasında aç',
  en: 'Open in the Steam app',
  de: 'In der Steam-App öffnen',
  fr: 'Ouvrir dans l’app Steam',
};

/**
 * "🖥️ [Steam uygulamasında aç](…)" for inline use in alert text. The emoji stays
 * outside the brackets: Discord shows a masked link with an emoji label as raw text.
 */
export function steamAppLink(appId: number, language: Language): string {
  return `🖥️ [${steamAppLabel[language]}](${steamAppUrl(appId)})`;
}

/** "12 Ekim 2026", "Ekim 2026", "2027 Ç4", "2027", or Steam's own text, as precise as Steam states it. */
export function releaseDateText(upcoming: UpcomingRelease, language: Language): string {
  const locale = languageLocale[language];
  const t = localizer(language);
  const date = upcoming.date ? new Date(upcoming.date) : null;
  if (date && !Number.isNaN(date.getTime())) {
    const year = date.getUTCFullYear();
    if (upcoming.precision === 'day') return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
    if (upcoming.precision === 'month') return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
    if (upcoming.precision === 'quarter') {
      const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
      return t({ tr: `${year} ${quarter}. çeyrek`, en: `Q${quarter} ${year}`, de: `Q${quarter} ${year}`, fr: `T${quarter} ${year}` });
    }
    if (upcoming.precision === 'year') return String(year);
  }
  return upcoming.message ?? t({
    tr: 'tarih henüz belli değil', en: 'date not announced yet', de: 'Termin noch offen', fr: 'date pas encore annoncée',
  });
}

export const comingSoon: Localized = { tr: 'Yakında', en: 'Coming soon', de: 'Demnächst', fr: 'Bientôt disponible' };

/** "🗓️ Yakında · 12 Ekim 2026": an unreleased game has no price yet, and that is not an error. */
export function upcomingLine(upcoming: UpcomingRelease, language: Language): string {
  return `🗓️ ${comingSoon[language]} · ${releaseDateText(upcoming, language)}`;
}

/** What to show instead of a price: the release for an unreleased game, else an honest "unavailable". */
export function noPriceText(item: Pick<WishlistItem, 'upcoming'>, language: Language): string {
  return item.upcoming ? upcomingLine(item.upcoming, language) : localizer(language)({
    tr: '❔ Fiyatını şu an alamadım',
    en: '❔ Couldn’t get the price right now',
    de: '❔ Preis gerade nicht verfügbar',
    fr: '❔ Prix indisponible pour l’instant',
  });
}

/** "🚫 1 oyun Türkiye mağazasında satılmıyor · 🗑️ 1 oyun Steam'den kaldırılmış", or null. */
export function unavailableGamesLine(
  errors: readonly Pick<WishlistItemError, 'code'>[] | undefined,
  countryCode: StoreCountryCode,
  language: Language,
): string | null {
  const regionLocked = errors?.filter((error) => error.code === 'STEAM_APP_REGION_UNAVAILABLE').length ?? 0;
  const delisted = errors?.filter((error) => error.code === 'STEAM_APP_NOT_FOUND').length ?? 0;
  const country = storeCountryName(countryCode, language);
  const one = (count: number) => count === 1;
  const t = localizer(language);
  const parts = [
    regionLocked > 0 ? t({
      tr: `🚫 ${regionLocked} oyun ${country} mağazasında satılmıyor`,
      en: `🚫 ${regionLocked} ${one(regionLocked) ? 'game is' : 'games are'} not sold in ${country}`,
      de: `🚫 ${regionLocked} ${one(regionLocked) ? 'Spiel ist' : 'Spiele sind'} in deiner Region (${country}) nicht erhältlich`,
      fr: `🚫 ${regionLocked} ${one(regionLocked) ? 'jeu non vendu' : 'jeux non vendus'} dans ta région (${country})`,
    }) : null,
    delisted > 0 ? t({
      tr: `🗑️ ${delisted} oyun Steam'den kaldırılmış`,
      en: `🗑️ ${delisted} ${one(delisted) ? 'game was' : 'games were'} removed from Steam`,
      de: `🗑️ ${delisted} ${one(delisted) ? 'Spiel wurde' : 'Spiele wurden'} von Steam entfernt`,
      fr: `🗑️ ${delisted} ${one(delisted) ? 'jeu retiré' : 'jeux retirés'} de Steam`,
    }) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
