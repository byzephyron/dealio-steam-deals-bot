import { buildHomePanel } from './home-view.js';
import type { NotificationPreference } from '../domain/notification-preference.js';
import type { WishlistItem } from '../domain/steam.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  escapeMarkdown,
} from 'discord.js';
import type { PreparedUserConfiguration } from '../application/user-configuration-service.js';
import type { UserConfig } from '../domain/user-config.js';
import type { StatusDashboardResult } from '../application/status-service.js';
import type { CheckStatus } from '../domain/check-state.js';
import { languageLocale, needsSharedPlace, type Language } from '../domain/user-config.js';
import { languageNames, localizer, percentText } from './i18n.js';
import { dealioBrand } from './ui/brand.js';
import { assertComponentsV2Limit, dealioFooter } from './ui/components-v2.js';
import { uiCopy } from './ui/copy.js';
import { messagesFor } from './messages.js';
import { countryDisplay, dmBlockedStatus, panelHeader, tabAccent, wishlistHidden, wishlistHiddenNotice } from './ui/design.js';
import { buildTabBar } from './ui/tab-bar.js';

type ReadyStatus = Extract<StatusDashboardResult, { status: 'ready' }>;

export interface StatusV2Options {
  readonly featuredDeal?: WishlistItem;
  readonly heroGame?: WishlistItem;
  readonly trackedGameCount?: number;
  readonly capturedAt?: string;
  readonly notificationPreference?: NotificationPreference;
  readonly eligibleDealCount?: number;
  /** Targets left in an old currency after a region change (Home shows a warning). */
  readonly staleTargetCount?: number;
  readonly mode?: 'home' | 'status';
  readonly bannerUrl?: string;
  readonly avatarUrl?: string;
  readonly disabled?: boolean;
  /** Show the shared tab row (the panel was opened with navigation). */
  readonly tabs?: boolean;
  /** A one-line result of the last action, such as a Test DM. */
  readonly notice?: string;
}

function buildSettingsPanel(
  result: ReadyStatus,
  sessionId: string,
  options: StatusV2Options = {},
): ContainerBuilder {
  const { config, checkState, notificationQueue, language } = result;
  const text = uiCopy(language);
  const t = localizer(language);
  const disabled = options.disabled ?? false;
  const prefix = 'status-v2';
  const profileUrl = `https://steamcommunity.com/profiles/${config.steamId64}`;
  const incompleteCount = (checkState?.lastSuccessUnknownPriceCount ?? 0)
    + (checkState?.lastSuccessFailedItemCount ?? 0);
  const failed = checkState?.lastStatus === 'failed' || checkState?.lastStatus === 'unavailable';
  const container = new ContainerBuilder().setAccentColor(config.dmDeliveryBlockedAt
    ? dealioBrand.colors.danger
    : failed || incompleteCount > 0 ? dealioBrand.colors.warning : tabAccent.settings);
  const divider = () => container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const button = (action: string, label: string, emoji: string, style = ButtonStyle.Secondary) => new ButtonBuilder()
    .setCustomId(`${prefix}:${sessionId}:${action}`).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);

  const tracking = config.dmDeliveryBlockedAt
    ? dmBlockedStatus(config, language)
    : config.enabled ? '✅ ' + t(trackingOn) : '⏸️ ' + t(trackingPaused);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(panelHeader('settings', language,
    t({ tr: 'Hesabın ve tercihlerin', en: 'Your account & preferences', de: 'Dein Konto & deine Vorlieben', fr: 'Ton compte et tes préférences' }),
    `**${tracking}** · ${t({ tr: 'Discord DM', en: 'Discord DM', de: 'Discord-DM', fr: 'MP Discord' })}`)));
  if (options.notice) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`> ${options.notice}`.slice(0, 400)));
  }
  divider();

  const account = [
    `### 👤 ${text.account}`,
    `[${maskSteamId(config.steamId64)}](${profileUrl})`,
    `**${countryDisplay(config.storeCountryCode, language)}** · 🌐 ${languageNames[language]}`,
    `🏷️ ${minimumDiscountText(config.minimumDiscountPercent, language)} · 🎯 **${result.gameDiscountOverrideCount}** ${t({
      tr: 'oyuna özel kural', en: 'game rules', de: 'Spielregeln', fr: 'règles par jeu',
    })}`,
  ].join('\n');
  container.addSectionComponents(options.avatarUrl
    ? new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(account))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(options.avatarUrl).setDescription('Dealio'))
    : new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(account))
      .setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(profileUrl).setLabel('Steam')));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    `### 🗓️ ${t({ tr: 'Kontroller', en: 'Checks', de: 'Prüfungen', fr: 'Vérifications' })}`,
    `🔜 ${t({ tr: 'Bir sonraki kontrol', en: 'Next check', de: 'Nächste Prüfung', fr: 'Prochaine vérification' })}: ${config.enabled
      ? displayTime(checkState?.nextScheduledAt, text.never) : t(trackingPaused).toLocaleLowerCase(languageLocale[language])}`,
    `${wishlistHidden(checkState) ? '🔒 ' + t({ tr: 'İstek listen gizli görünüyor', en: 'Your wishlist looks private', de: 'Deine Wunschliste wirkt privat', fr: 'Ta liste semble privée' })
      : localizedCheckStatus(checkState?.lastStatus ?? null, language)} · ${displayTime(checkState?.lastCompletedAt, text.never)}`,
    `-# 🎮 ${displayCount(checkState?.lastSuccessCheckedCount, '—')} ${t({ tr: 'oyun', en: 'games', de: 'Spiele', fr: 'jeux' })} · 🏷️ ${displayCount(checkState?.lastSuccessOnSaleCount, '—')} ${t({
      tr: 'indirimde', en: 'on sale', de: 'im Angebot', fr: 'en promo',
    })} · 💱 ${result.latestPriceCurrencies.join(' / ') || text.never}`,
  ].join('\n')));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    `### 📨 ${t({ tr: 'Bildirimler', en: 'Alerts', de: 'Benachrichtigungen', fr: 'Alertes' })}`,
    `✅ **${notificationQueue.sent}** ${t({ tr: 'gönderildi', en: 'sent', de: 'gesendet', fr: 'envoyées' })} · 📬 **${notificationQueue.pending + notificationQueue.retry}** ${t({
      tr: 'sırada', en: 'waiting', de: 'wartend', fr: 'en attente',
    })} · ❌ **${notificationQueue.terminalFailed}** ${t({ tr: 'iletilemedi', en: 'undeliverable', de: 'nicht zustellbar', fr: 'non distribuées' })}`,
    t({
      tr: '-# En az indirim oranı tüm oyunlar için geçerli. Tek bir oyuna kural koymak için 🎮 İstek listem’e geç.',
      en: '-# The minimum discount applies to every game. Set a rule for a single game in 🎮 Wishlist.',
      de: '-# Der Mindestrabatt gilt für alle Spiele. Regeln für einzelne Spiele legst du unter 🎮 Wunschliste fest.',
      fr: '-# La réduction minimale s’applique à tous les jeux. Pour une règle propre à un jeu, va dans 🎮 Ma liste.',
    }),
  ].join('\n')));
  if (incompleteCount > 0) {
    const one = incompleteCount === 1;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t({
      tr: `> ⚠️ Son kontrolde **${incompleteCount} oyunun** fiyatını alamadım; indirim sayısına bunlar dahil değil.`,
      en: `> ⚠️ I couldn’t get the price of **${incompleteCount} ${one ? 'game' : 'games'}** in the last check, so ${one ? 'it isn’t' : 'they aren’t'} in the sale count.`,
      de: `> ⚠️ Bei der letzten Prüfung fehlte mir der Preis von **${incompleteCount} ${one ? 'Spiel' : 'Spielen'}**; ${one ? 'es zählt' : 'sie zählen'} nicht zu den Angeboten.`,
      fr: `> ⚠️ Lors de la dernière vérification, il me manquait le prix de **${incompleteCount} ${one ? 'jeu' : 'jeux'}** ; ${one ? 'il n’est pas compté' : 'ils ne sont pas comptés'} dans les promos.`,
    })));
  }
  if (wishlistHidden(checkState)) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('> ' + wishlistHiddenNotice(language)));
  } else if (failed) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t({
      tr: '> ⚠️ Son kontrol yarım kaldı. Sayılar bir önceki başarılı kontrolden; güncel fiyatları henüz teyit edemedim.',
      en: '> ⚠️ The last check didn’t finish. These numbers are from the last good check; current prices aren’t confirmed yet.',
      de: '> ⚠️ Die letzte Prüfung wurde nicht abgeschlossen. Die Zahlen stammen von der letzten erfolgreichen Prüfung; aktuelle Preise sind noch nicht bestätigt.',
      fr: '> ⚠️ La dernière vérification n’a pas abouti. Ces chiffres viennent de la dernière vérification réussie ; les prix actuels ne sont pas encore confirmés.',
    })));
  }
  if (config.dmDeliveryBlockedAt) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t(needsSharedPlace(config) ? {
      tr: '> 🛑 **Discord sana DM atmama izin vermediği için takibi durdurdum:** ortak bir sunucumuz yok. Dealio’yu uygulamalarına (“Uygulamalarıma Ekle”) ya da bulunduğun bir sunucuya ekle, bir Test DM gönder ve ▶️ Takibi sürdür’e bas.',
      en: '> 🛑 **I paused tracking because Discord won’t let me DM you:** we don’t share a server. Add Dealio to your apps (“Add to My Apps”) or to a server you’re in, send a Test DM, then press ▶️ Resume tracking.',
      de: '> 🛑 **Ich habe die Überwachung pausiert, weil Discord mich dir keine DMs schicken lässt:** Wir haben keinen gemeinsamen Server. Füg Dealio deinen Apps („Zu meinen Apps hinzufügen“) oder einem Server hinzu, auf dem du bist, schick eine Test-DM und tippe auf ▶️ Überwachung fortsetzen.',
      fr: '> 🛑 **J’ai mis le suivi en pause car Discord ne me laisse pas t’envoyer de MP :** nous n’avons aucun serveur en commun. Ajoute Dealio à tes applis (« Ajouter à mes applis ») ou à un serveur où tu es, envoie un MP de test, puis appuie sur ▶️ Reprendre le suivi.',
    } : {
      tr: '> 🛑 **DM’ler engellendiği için takibi durdurdum.** Discord gizlilik ayarını düzelt, bir Test DM gönder ve ▶️ Takibi sürdür’e bas.',
      en: '> 🛑 **I paused tracking because DMs were blocked.** Fix your Discord privacy settings, send a Test DM, then press ▶️ Resume tracking.',
      de: '> 🛑 **Ich habe die Überwachung pausiert, weil DMs blockiert waren.** Pass deine Discord-Privatsphäre-Einstellungen an, schick eine Test-DM und tippe auf ▶️ Überwachung fortsetzen.',
      fr: '> 🛑 **J’ai mis le suivi en pause car les MP étaient bloqués.** Corrige tes paramètres de confidentialité Discord, envoie un MP de test, puis appuie sur ▶️ Reprendre le suivi.',
    })));
  }

  divider();
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      config.enabled
        // Pausing stops the Steam checks too, so the button says "tracking", like the status line.
        ? button('disable', t({ tr: 'Takibi durdur', en: 'Pause tracking', de: 'Überwachung pausieren', fr: 'Mettre le suivi en pause' }), '⏸️')
        : button('enable', t({ tr: 'Takibi sürdür', en: 'Resume tracking', de: 'Überwachung fortsetzen', fr: 'Reprendre le suivi' }), '▶️', ButtonStyle.Success),
      button('minimum-discount', t({ tr: 'İndirim yüzdesini belirle', en: 'Set discount %', de: 'Rabatt-% festlegen', fr: 'Fixer le % de réduction' }), '🏷️'),
      button('test', t({ tr: 'Test DM', en: 'Test DM', de: 'Test-DM', fr: 'MP de test' }), '✉️'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('region', t({ tr: 'Bölge', en: 'Region', de: 'Region', fr: 'Région' }), '🌍'),
      button('language', t({ tr: 'Dil', en: 'Language', de: 'Sprache', fr: 'Langue' }), '🌐'),
      button('account', t(changeAccountLabel), '👤'),
      button('delete', t({ tr: 'Verilerimi sil', en: 'Delete my data', de: 'Meine Daten löschen', fr: 'Supprimer mes données' }), '🗑️', ButtonStyle.Danger),
    ),
  );
  if (options.tabs) {
    divider();
    container.addActionRowComponents(buildTabBar(prefix, sessionId, language, { active: 'settings', disabled }));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(dealioFooter(language)));
  assertComponentsV2Limit([container]);
  return container;
}

function displayTime(value: string | null | undefined, emptyValue: string): string {
  if (!value) {
    return emptyValue;
  }
  const timestamp = Math.floor(new Date(value).getTime() / 1_000);
  return Number.isSafeInteger(timestamp) ? `<t:${timestamp}:R>` : emptyValue;
}

function displayCount(value: number | null | undefined, emptyValue: string): string {
  return value === null || value === undefined ? emptyValue : String(value);
}

function maskSteamId(steamId64: string): string {
  return `${steamId64.slice(0, 5)}••••••••${steamId64.slice(-4)}`;
}

const changeAccountLabel = {
  tr: 'Steam hesabını değiştir', en: 'Change Steam account', de: 'Steam-Konto wechseln', fr: 'Changer de compte Steam',
} as const;

/**
 * The account switch before it is saved: the new profile as Steam shows it, what
 * stays and what is left behind, then Confirm or Cancel.
 */
export function buildAccountChangePanel(
  prepared: PreparedUserConfiguration,
  current: UserConfig,
  sessionId: string,
  disabled = false,
): ContainerBuilder {
  const language = current.language;
  const t = localizer(language);
  const messages = messagesFor(language);
  const profileUrl = `https://steamcommunity.com/profiles/${prepared.steamId64}`;
  const container = new ContainerBuilder().setAccentColor(dealioBrand.colors.warning);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(panelHeader('settings', language,
    t(changeAccountLabel),
    t({ tr: 'Bu hesabı mı bağlayayım?', en: 'Should I connect this account?', de: 'Soll ich dieses Konto verbinden?', fr: 'Je connecte ce compte ?' }))));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const account = new TextDisplayBuilder().setContent([
    `👤 **${messages.setupWizardProfileField}:** [${prepared.steamId64}](${profileUrl})`,
    ...(prepared.profile ? [`🏷️ **${messages.setupWizardProfileNameField}:** ${escapeMarkdown(prepared.profile.personaName)}`] : []),
    `🌍 **${messages.setupWizardRegionField}:** ${countryDisplay(prepared.storeCountryCode, language)}`,
  ].join('\n'));
  container.addSectionComponents(prepared.profile?.avatarUrl
    ? new SectionBuilder().addTextDisplayComponents(account).setThumbnailAccessory(
      new ThumbnailBuilder().setURL(prepared.profile.avatarUrl).setDescription(prepared.profile.personaName.slice(0, 100)))
    : new SectionBuilder().addTextDisplayComponents(account).setButtonAccessory(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(profileUrl).setLabel('Steam')));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t({
    tr: '> ⚠️ Eski hesabındaki oyunlara koyduğun kurallar, hedef fiyatlar ve bekleyen bildirimler yeni hesaba taşınmaz. Genel indirim oranın, bildirim zamanlaman, dilin ve takip durumun aynı kalır.\n> Yeni listende şu an indirimde olan oyunlar için DM atmam; bundan sonra başlayan indirimleri haber veririm.',
    en: '> ⚠️ Rules, target prices and waiting alerts for your old account’s games don’t carry over. Your default discount, alert timing, language and tracking status stay the same.\n> I won’t DM you about games already on sale in the new list; I’ll tell you about sales that start from now on.',
    de: '> ⚠️ Regeln, Wunschpreise und wartende Benachrichtigungen für die Spiele deines alten Kontos werden nicht übernommen. Dein Standardrabatt, deine Benachrichtigungszeiten, deine Sprache und der Überwachungsstatus bleiben.\n> Für Spiele, die in der neuen Liste schon reduziert sind, schicke ich keine DM; ich melde Angebote, die ab jetzt beginnen.',
    fr: '> ⚠️ Les règles, prix cibles et alertes en attente des jeux de ton ancien compte ne sont pas repris. Ta réduction par défaut, tes horaires d’alerte, ta langue et l’état du suivi restent les mêmes.\n> Je ne t’enverrai pas de MP pour les jeux déjà en promo dans la nouvelle liste ; je te signalerai les promos qui commencent à partir de maintenant.',
  })));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`status-v2:${sessionId}:account-confirm`).setStyle(ButtonStyle.Success).setEmoji('✅')
      .setLabel(t({ tr: 'Bu hesabı bağla', en: 'Connect this account', de: 'Dieses Konto verbinden', fr: 'Connecter ce compte' }))
      .setDisabled(disabled),
    new ButtonBuilder().setCustomId(`status-v2:${sessionId}:account-cancel`).setStyle(ButtonStyle.Secondary).setEmoji('↩️')
      .setLabel(t({ tr: 'Vazgeç', en: 'Cancel', de: 'Abbrechen', fr: 'Annuler' }))
      .setDisabled(disabled),
  ));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(dealioFooter(language)));
  assertComponentsV2Limit([container]);
  return container;
}

const trackingOn = { tr: 'Takip açık', en: 'Tracking on', de: 'Überwachung aktiv', fr: 'Suivi actif' } as const;
const trackingPaused = { tr: 'Takip duraklatıldı', en: 'Tracking paused', de: 'Überwachung pausiert', fr: 'Suivi en pause' } as const;

/** "En az **%20** indirim", "At least **20%** off". */
function minimumDiscountText(percent: number, language: Language): string {
  const value = `**${percentText(percent, language)}**`;
  return localizer(language)({
    tr: `En az ${value} indirim`,
    en: `At least ${value} off`,
    de: `Mindestens ${value} Rabatt`,
    fr: `Au moins ${value} de réduction`,
  });
}

function localizedCheckStatus(status: CheckStatus | null, language: Language): string {
  const t = localizer(language);
  if (status === 'success') return '✅ ' + t({ tr: 'Son kontrol sorunsuz', en: 'Last check went fine', de: 'Letzte Prüfung erfolgreich', fr: 'Dernière vérification réussie' });
  if (status === 'unavailable') return '⚠️ ' + t({ tr: 'Steam’e ulaşılamadı', en: 'Couldn’t reach Steam', de: 'Steam nicht erreichbar', fr: 'Steam injoignable' });
  if (status === 'failed') return '🛑 ' + t({ tr: 'Son kontrol yarım kaldı', en: 'Last check didn’t finish', de: 'Letzte Prüfung abgebrochen', fr: 'Dernière vérification interrompue' });
  return '⏳ ' + t({ tr: 'Henüz kontrol yapılmadı', en: 'No check yet', de: 'Noch keine Prüfung', fr: 'Aucune vérification pour l’instant' });
}

export function buildStatusV2Panel(
  result: ReadyStatus,
  sessionId: string,
  options: StatusV2Options = {},
): ContainerBuilder {
  return options.mode === 'home'
    ? buildHomePanel(result, sessionId, options)
    : buildSettingsPanel(result, sessionId, options);
}
