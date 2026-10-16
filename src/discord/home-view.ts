import { addArtwork } from './ui/game-artwork.js';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder,
} from 'discord.js';
import type { StatusDashboardResult } from '../application/status-service.js';
import type { StatusV2Options } from './status-view-v2.js';
import { sanitizeGameName } from './notification-messages.js';
import { assertComponentsV2Limit, dealioFooter } from './ui/components-v2.js';
import { dealioBrand } from './ui/brand.js';
import { countryDisplay, dmBlockedFix, dmBlockedStatus, helpButton, hotPrefix, supportButton, noPriceText, panelHeader, priceFetched, priceLine, savingsLine, tabAccent, wishlistHidden, wishlistHiddenNotice } from './ui/design.js';
import { buildTabBar } from './ui/tab-bar.js';
import { localizer } from './i18n.js';
import { staleTargetsNotice } from './assistant-view.js';

type ReadyStatus = Extract<StatusDashboardResult, { status: 'ready' }>;
const display = (value: string) => new TextDisplayBuilder().setContent(value);
const relative = (value: string | null | undefined, fallback: string): string => {
  const seconds = value ? Math.floor(Date.parse(value) / 1000) : NaN;
  return Number.isSafeInteger(seconds) ? '<t:' + seconds + ':R>' : fallback;
};
const clock = (minute: number | null): string => minute === null ? '—'
  : String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');

export function buildHomePanel(result: ReadyStatus, sessionId: string, options: StatusV2Options): ContainerBuilder {
  const { config, language, checkState, notificationQueue: queue } = result;
  const t = localizer(language);
  const disabled = options.disabled ?? false;
  const pending = queue.pending + queue.retry + queue.sending;
  const blocked = Boolean(config.dmDeliveryBlockedAt);
  const partial = (checkState?.lastSuccessUnknownPriceCount ?? 0) + (checkState?.lastSuccessFailedItemCount ?? 0);
  const failed = checkState?.lastStatus === 'failed' || checkState?.lastStatus === 'unavailable';
  const root = new ContainerBuilder().setAccentColor(blocked ? dealioBrand.colors.danger
    : failed || partial ? dealioBrand.colors.warning : tabAccent.home);
  const button = (action: string, label: string, emoji: string) => new ButtonBuilder()
    .setCustomId('dealio:' + sessionId + ':' + action).setLabel(label).setEmoji(emoji)
    .setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const divider = (large = false) => root.addSeparatorComponents(new SeparatorBuilder()
    .setDivider(true).setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small));

  const pref = options.notificationPreference;
  const timing = pref?.mode === 'quiet'
    ? '🌙 ' + clock(pref.quietStart) + '–' + clock(pref.quietEnd)
    : pref?.mode === 'digest' ? '📬 ' + t({ tr: 'Günlük özet ', en: 'Daily digest ', de: 'Tägliche Zusammenfassung ', fr: 'Résumé quotidien ' }) + clock(pref.digestMinute)
    : '⚡ ' + t({ tr: 'Anında bildirim', en: 'Instant alerts', de: 'Sofort benachrichtigen', fr: 'Alertes immédiates' });
  const tracking = blocked ? dmBlockedStatus(config, language)
    : config.enabled ? '✅ ' + t({ tr: 'Takip açık', en: 'Tracking on', de: 'Überwachung aktiv', fr: 'Suivi actif' })
    : '⏸️ ' + t({ tr: 'Takip duraklatıldı', en: 'Tracking paused', de: 'Überwachung pausiert', fr: 'Suivi en pause' });
  root.addTextDisplayComponents(display(
    panelHeader('home', language,
      t({ tr: 'Senin istek listen, senin kuralların!', en: 'Your wishlist. Your rules.', de: 'Deine Wunschliste. Deine Regeln.', fr: 'Ta liste. Tes règles.' }),
      t({
        tr: 'İstediğin oyunu, istediğin fiyata yakala.',
        en: 'Get the games you want at the price you choose.',
        de: 'Hol dir deine Spiele zu deinem Wunschpreis.',
        fr: 'Les jeux que tu veux, au prix que tu choisis.',
      })) +
    '\n-# ' + tracking + '　' + countryDisplay(config.storeCountryCode, language) +
    '　' + timing,
  ));
  divider(true);

  const hero = options.featuredDeal ?? options.heroGame;
  if (hero) {
    root.addTextDisplayComponents(display('-# ' + (options.featuredDeal
      ? '🎯 ' + t({ tr: 'KURALINA UYAN FIRSAT', en: 'A DEAL THAT MATCHES YOUR RULE', de: 'EIN ANGEBOT NACH DEINER REGEL', fr: 'UN BON PLAN SELON TES RÈGLES' })
      : '✨ ' + t({ tr: 'İSTEK LİSTENDEN', en: 'FROM YOUR WISHLIST', de: 'AUS DEINER WUNSCHLISTE', fr: 'DE TA LISTE DE SOUHAITS' }))));
    addArtwork(root, hero);
    const price = hero.price?.currency ? { ...hero.price, currency: hero.price.currency } : null;
    const savings = price && savingsLine(price, language);
    const fetchedAt = relative(hero.priceObservedAt ?? options.capturedAt, '');
    root.addTextDisplayComponents(display('## ' + hotPrefix(price?.discountPercent) + '[' + sanitizeGameName(hero.name.slice(0, 100)) +
      '](https://store.steampowered.com/app/' + hero.appId + ')\n' +
      (price ? priceLine(price, language) : noPriceText(hero, language)) +
      (savings ? '\n' + savings : '') +
      (price && fetchedAt ? '\n-# 🕒 ' + priceFetched(fetchedAt, language) : '')));
  } else {
    root.addTextDisplayComponents(display('## ' + (checkState?.lastSuccessOnSaleCount == null
      ? '⏳ ' + t({ tr: 'İlk kontrol birazdan', en: 'Your first check is on its way', de: 'Die erste Prüfung kommt gleich', fr: 'La première vérification arrive' })
      : '🎯 ' + t({ tr: 'Sıradaki oyunun seni bekliyor.', en: 'Your next game starts here.', de: 'Hier beginnt dein nächstes Spiel.', fr: 'Ton prochain jeu commence ici.' })) +
      '\n' + t({
        tr: '🎮 İstek listem’den bir oyun seç ve hedef fiyatını belirle.',
        en: 'Pick a game in 🎮 Wishlist and set your target price.',
        de: 'Wähle unter 🎮 Wunschliste ein Spiel und leg deinen Wunschpreis fest.',
        fr: 'Choisis un jeu dans 🎮 Ma liste et fixe ton prix cible.',
      })));
  }
  divider();

  const tracked = options.trackedGameCount ?? checkState?.lastSuccessCheckedCount ?? '—';
  const matching = options.eligibleDealCount ?? '—';
  root.addTextDisplayComponents(display(
    '🎮 **' + tracked + '** ' + t({ tr: 'oyun', en: 'games', de: 'Spiele', fr: 'jeux' }) +
    '　✅ **' + matching + '** ' + t({ tr: 'oyun kuralına uyuyor', en: 'matching deals', de: 'passende Angebote', fr: 'bons plans pour toi' }) +
    '　📬 **' + pending + '** ' + t({ tr: 'bildirim sırada', en: 'alerts queued', de: 'DMs in Warteschlange', fr: 'alertes en attente' }) +
    '\n-# 🕒 ' + t({ tr: 'Son kontrol ', en: 'Last check ', de: 'Letzte Prüfung ', fr: 'Dernière vérification ' }) +
    relative(checkState?.lastSuccessCompletedAt, t({ tr: 'henüz yok', en: 'not yet', de: 'noch keine', fr: 'pas encore' })) +
    ' · ' + t({ tr: 'sonraki ', en: 'next ', de: 'nächste ', fr: 'prochaine ' }) + (config.enabled
      ? relative(checkState?.nextScheduledAt, t({ tr: 'planlanıyor', en: 'being scheduled', de: 'wird geplant', fr: 'en préparation' }))
      : t({ tr: 'takip duraklatıldı', en: 'tracking paused', de: 'Überwachung pausiert', fr: 'suivi en pause' }))));
  if (wishlistHidden(checkState)) root.addTextDisplayComponents(display('> ' + wishlistHiddenNotice(language)));
  else if (failed || partial) root.addTextDisplayComponents(display('> ⚠️ ' + (failed
    ? t({
        tr: 'Son kontrol yarım kaldı; gördüğün fiyatlar bir önceki kontrolden.',
        en: 'The last check didn’t finish; the prices shown are from the one before.',
        de: 'Die letzte Prüfung wurde nicht abgeschlossen; die Preise stammen von der davor.',
        fr: 'La dernière vérification n’a pas abouti ; les prix affichés viennent de la précédente.',
      })
    : t({
        tr: partial + ' oyunun fiyatını alamadım.',
        en: 'I couldn’t get the price of ' + partial + (partial === 1 ? ' game.' : ' games.'),
        de: 'Mir fehlt der Preis von ' + partial + (partial === 1 ? ' Spiel.' : ' Spielen.'),
        fr: 'Il me manque le prix de ' + partial + (partial === 1 ? ' jeu.' : ' jeux.'),
      }))));
  if (options.staleTargetCount) root.addTextDisplayComponents(display('> ' + staleTargetsNotice(options.staleTargetCount, language)));
  if (blocked) {
    const fix = dmBlockedFix(config, language);
    root.addTextDisplayComponents(display('> 🔴 ' + t({
      tr: `${fix}, sonra ⚙️ Ayarlar’dan bir Test DM gönder.`,
      en: `${fix}, then send a Test DM from ⚙️ Settings.`,
      de: `${fix} und schick dann unter ⚙️ Einstellungen eine Test-DM.`,
      fr: `${fix}, puis envoie un MP de test depuis ⚙️ Réglages.`,
    })));
  }
  // The matching deals from the last check, one tap away; a fresh Steam check is the other action.
  const dealCount = options.eligibleDealCount;
  const deals = dealCount === undefined ? null : dealCount > 0
    ? button('deals', t({ tr: 'Kuralıma uyanlar', en: 'Matching deals', de: 'Passende Angebote', fr: 'Bons plans pour moi' })
      + ' (' + dealCount + ')', '✅').setStyle(ButtonStyle.Primary)
    : button('deals', t({ tr: 'Şu an kuralına uyan indirim yok', en: 'No matching deals right now',
      de: 'Gerade keine passenden Angebote', fr: 'Aucun bon plan pour l’instant' }), '✅').setDisabled(true);
  root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(deals ? [deals] : []),
    // A fresh Steam check, whose result screen leads back to an up-to-date Home.
    button('check', t({ tr: 'Steam’de şimdi kontrol et', en: 'Check Steam now', de: 'Jetzt bei Steam prüfen', fr: 'Vérifier Steam maintenant' }), '🔄'),
    helpButton(language),
    supportButton(language),
  ));
  divider();
  root.addActionRowComponents(buildTabBar('dealio', sessionId, language, { active: 'home', disabled }));
  root.addTextDisplayComponents(display(dealioFooter(language)));
  assertComponentsV2Limit([root]);
  return root;
}
