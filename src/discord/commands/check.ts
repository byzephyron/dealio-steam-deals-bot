import { measureDiscordOperation } from '../interaction-timing.js';
import { safeLogger } from '../../application/safe-logger.js';
import {
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import type { CheckService } from '../../application/check-service.js';
import type { NotificationService } from '../../application/notification-service.js';
import type { StatusService } from '../../application/status-service.js';
import { buildCheckPanel, type CheckResultPresentation } from '../check-view-v2.js';
import type { Language } from '../../domain/user-config.js';
import { localizer } from '../i18n.js';
import { languageFromDiscordLocale } from '../language.js';
import { messagesFor } from '../messages.js';
import { dealioUiSessionTimeoutMs, dealioV2Flags } from '../ui/components-v2.js';
import { uiCopy } from '../ui/copy.js';
import { dealioUiSessions } from '../ui/session-manager.js';
import { isFromUser } from '../ui/refused-interactions.js';
import { handOffPanel, parseTabAction, type PanelNavigation } from '../ui/tab-bar.js';

export interface CheckPanelOptions extends PanelNavigation {
  readonly lifecycleSignal?: AbortSignal;
}

export async function handleCheck(
  interaction: ChatInputCommandInteraction,
  checkService: CheckService,
  statusService: StatusService,
  notificationService: NotificationService,
  ui: CheckPanelOptions = {},
): Promise<void> {
  if (!ui.inPlace) {
    await measureDiscordOperation(interaction, 'check.ack', () => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
  }
  const navigate = ui.navigate;
  const config = statusService.get(interaction.user.id).config;
  const language = config?.language ?? languageFromDiscordLocale(interaction.locale ?? '');
  const messages = messagesFor(language);
  if (!config) {
    await measureDiscordOperation(interaction, 'check.render', () => interaction.editReply({
      flags: dealioV2Flags,
      components: [buildCheckPanel(language, {
        kind: 'warning',
        title: localizer(language)({ tr: 'Dealio henüz kurulmadı', en: 'Dealio isn’t set up yet', de: 'Dealio ist noch nicht eingerichtet', fr: 'Dealio n’est pas encore configuré' }),
        description: messages.notConfigured,
      })],
    }));
    return;
  }

  const text = uiCopy(language);
  await measureDiscordOperation(interaction, 'check.render', () => interaction.editReply({
    flags: dealioV2Flags,
    components: [buildCheckPanel(language, {
      kind: 'info',
      title: text.checkingTitle,
      description: text.checkingDescription,
    })],
  }));
  const result = await checkService.check(interaction.user.id);
  const currentConfig = result.status === 'success'
    ? statusService.get(interaction.user.id).config
    : config;
  const currentLanguage = currentConfig?.language ?? language;
  const notificationsEnabled = currentConfig?.enabled === true;
  const delivery = result.status === 'success' && notificationsEnabled
    ? await notificationService.deliverPending(interaction.user.id)
    : { sentCount: 0, failedCount: 0, candidateCount: 0 };
  const presentation = checkPresentation(
    result,
    currentLanguage,
    notificationsEnabled,
    delivery,
  );
  const finalPanel = buildCheckPanel(
    currentLanguage,
    presentation,
    navigate ? interaction.id : undefined,
  );
  const message = await measureDiscordOperation(interaction, 'check.render', () => interaction.editReply({ components: [finalPanel] }));
  if (!navigate) {
    return;
  }
  const collector = message.createMessageComponentCollector({
    time: dealioUiSessionTimeoutMs,
    filter: (component) => isFromUser(component, interaction.user.id)
      && component.customId.startsWith(`check-v2:${interaction.id}:`),
  });
  const closeUiSession = dealioUiSessions.open(
    interaction.id,
    interaction.user.id,
    ['check-v2'],
    dealioUiSessionTimeoutMs,
  );
  let handedOff = false;
  collector.on('collect', (component) => {
    const tab = parseTabAction(component.customId.slice(`check-v2:${interaction.id}:`.length));
    if (tab) {
      handedOff = true;
      handOffPanel({ component, target: tab, navigate, stop: () => collector.stop('handoff'), settle: async () => undefined });
      return;
    }
    void measureDiscordOperation(component, 'check.button-ack', () => component.deferUpdate())
      .catch((error: unknown) => safeLogger.error('Discord check acknowledgement failed', error));
  });
  const stopForShutdown = (): void => collector.stop('shutdown');
  ui.lifecycleSignal?.addEventListener('abort', stopForShutdown, { once: true });
  try {
    await new Promise<void>((resolve) => collector.once('end', () => resolve()));
    if (handedOff) return;
    await measureDiscordOperation(interaction, 'check.render', () => interaction.editReply({
      components: [buildCheckPanel(currentLanguage, presentation, interaction.id, true)],
    })).catch((error: unknown) => safeLogger.error('Dealio check panel cleanup failed', error));
  } finally {
    closeUiSession();
    ui.lifecycleSignal?.removeEventListener('abort', stopForShutdown);
  }
}

function checkPresentation(
  result: Awaited<ReturnType<CheckService['check']>>,
  language: Language,
  notificationsEnabled: boolean,
  delivery: { readonly sentCount: number; readonly failedCount: number; readonly candidateCount: number },
): CheckResultPresentation {
  const text = uiCopy(language);
  const messages = messagesFor(language);
  const t = localizer(language);
  if (result.status === 'already-running') {
    return { kind: 'info', title: text.checkAlreadyTitle, description: messages.alreadyRunning };
  }
  if (result.status === 'cooldown') {
    return { kind: 'warning', title: text.checkCooldownTitle, description: messages.cooldown(result.retryAfterSeconds) };
  }
  if (result.status === 'unavailable') {
    // A private wishlist is the user's own setting, not a Steam outage.
    return result.errorCode === 'STEAM_WISHLIST_INACCESSIBLE'
      ? {
          kind: 'warning',
          title: t({ tr: 'Profilin gizli görünüyor', en: 'Your profile looks private', de: 'Dein Profil sieht privat aus', fr: 'Ton profil semble privé' }),
          description: messages.wishlistInaccessible,
        }
      : { kind: 'warning', title: text.checkUnavailableTitle, description: messages.unavailable };
  }
  if (result.status === 'failed') {
    return { kind: 'danger', title: text.checkFailedTitle, description: messages.failed };
  }
  if (result.status === 'not-configured') {
    return { kind: 'warning', title: text.checkFailedTitle, description: messages.notConfigured };
  }
  if (result.status === 'disabled') {
    return {
      kind: 'warning',
      title: t({ tr: 'Takip duraklatıldı', en: 'Tracking is paused', de: 'Überwachung pausiert', fr: 'Suivi en pause' }),
      description: t({
        tr: 'Bildirimlerin kapalı olduğu için kontrol etmedim. ⚙️ Ayarlar sekmesinden yeniden açabilirsin.',
        en: 'Your alerts are off, so I didn’t check. Turn them back on in the ⚙️ Settings tab.',
        de: 'Deine Benachrichtigungen sind aus, deshalb habe ich nicht geprüft. Schalte sie im Tab ⚙️ Einstellungen wieder ein.',
        fr: 'Tes alertes sont coupées, donc je n’ai rien vérifié. Réactive-les dans l’onglet ⚙️ Réglages.',
      }),
    };
  }
  const summary = {
    checked: result.checkedCount,
    found: result.notificationCandidates.length,
    sent: delivery.sentCount,
    deliveryFailed: delivery.failedCount,
    unconfirmed: result.failedItems.length + result.unknownPriceCount,
  };
  const description = notificationsEnabled
    ? messages.checkCompleted(summary)
    : messages.checkCompletedNotificationsDisabled(summary);
  return {
    kind: delivery.failedCount > 0 || result.failedItems.length > 0 ? 'warning' : 'success',
    title: text.checkSuccessTitle,
    description,
    metrics: [
      { emoji: '🎮', label: t({ tr: 'oyuna baktım', en: 'games checked', de: 'Spiele geprüft', fr: 'jeux vérifiés' }), value: result.checkedCount },
      { emoji: '🎯', label: t({ tr: 'yeni fırsat', en: 'new deals', de: 'neue Angebote', fr: 'nouveaux bons plans' }), value: result.notificationCandidates.length },
      { emoji: '📨', label: t({ tr: 'DM gönderdim', en: 'DMs sent', de: 'DMs verschickt', fr: 'MP envoyés' }), value: delivery.sentCount },
      // Problems only when they happened; unreleased and unavailable games are facts, not errors.
      ...[
        { emoji: '🗓️', label: t({ tr: 'henüz çıkmadı', en: 'not released yet', de: 'noch nicht erschienen', fr: 'pas encore sortis' }), value: result.upcomingCount },
        { emoji: '🚫', label: t({ tr: 'satılmıyor / kaldırılmış', en: 'not sold / removed', de: 'nicht erhältlich / entfernt', fr: 'non vendus / retirés' }), value: result.unavailableItems.length },
        { emoji: '❔', label: t({ tr: 'fiyatını alamadım', en: 'prices not confirmed', de: 'Preise nicht bestätigt', fr: 'prix non confirmés' }), value: result.unknownPriceCount },
        { emoji: '⚠️', label: t({ tr: 'Steam hatası', en: 'Steam errors', de: 'Steam-Fehler', fr: 'erreurs Steam' }), value: result.failedItems.length },
      ].filter((metric) => metric.value > 0),
    ],
  };
}
