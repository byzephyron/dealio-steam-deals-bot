import { measureDiscordOperation } from '../interaction-timing.js';
import type { InteractionEditReplyOptions } from 'discord.js';
import { matchesRule, staleTarget } from '../assistant-view.js';
import { handleAssistant } from './assistant.js';
import { safeLogger } from '../../application/safe-logger.js';
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { CheckService } from '../../application/check-service.js';
import type { DiscountThresholdService } from '../../application/discount-threshold-service.js';
import type { NotificationService } from '../../application/notification-service.js';
import type { SetupService } from '../../application/setup-service.js';
import type { StatusService } from '../../application/status-service.js';
import type { TestNotificationService } from '../../application/test-notification-service.js';
import type { UserConfigurationService } from '../../application/user-configuration-service.js';
import type { WishlistViewService } from '../../application/wishlist-view-service.js';
import { languageFromDiscordLocale } from '../language.js';
import { localizer } from '../i18n.js';
import { messagesFor } from '../messages.js';
import { uiCopy } from '../ui/copy.js';
import type { SetupPresentationOptions } from '../setup-view.js';
import { buildStatusV2Panel } from '../status-view-v2.js';
import { buildRecommendPanel } from '../home-view.js';
import {
  buildNoticePanel,
  dealioUiSessionTimeoutMs,
  dealioEphemeralV2Flags,
  dealioV2Flags,
} from '../ui/components-v2.js';
import { PanelOperationQueue } from '../ui/operation-queue.js';
import { dealioUiSessions } from '../ui/session-manager.js';
import { isFromUser } from '../ui/refused-interactions.js';
import { handOffPanel, parseTabAction, type Navigate, type PanelNavigation } from '../ui/tab-bar.js';
import { handleCheck } from './check.js';
import { handleSetup } from './setup.js';
import { handleStatus } from './status.js';

export const dealioCommand = new SlashCommandBuilder()
  .setName('dealio')
  .setDescription('Open your Dealio panel: deals, wishlist, alerts and settings')
  .setDescriptionLocalizations({
    tr: 'Dealio panelini aç: fırsatlar, istek listen, bildirimler ve ayarlar',
    de: 'Dein Dealio-Panel öffnen: Angebote, Wunschliste, Preisalarme und Einstellungen',
    fr: 'Ouvrir ton panneau Dealio : bons plans, liste de souhaits, alertes et réglages',
  });

/** An alias of /dealio for people who look for help first; the panel holds the help link. */
export const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Get help: opens your Dealio panel with the help link')
  .setDescriptionLocalizations({
    tr: 'Yardım al: yardım bağlantısıyla birlikte Dealio panelini açar',
    de: 'Hilfe bekommen: öffnet dein Dealio-Panel mit dem Hilfe-Link',
    fr: 'Obtenir de l’aide : ouvre ton panneau Dealio avec le lien d’aide',
  });

export interface DealioCommandServices {
  readonly setupService: SetupService;
  readonly statusService: StatusService;
  readonly userConfigurationService: UserConfigurationService;
  readonly wishlistViewService: WishlistViewService;
  readonly checkService: CheckService;
  readonly notificationService: NotificationService;
  readonly testNotificationService: TestNotificationService;
  readonly discountThresholdService?: DiscountThresholdService;
  readonly setupPresentation?: SetupPresentationOptions;
  readonly lifecycleSignal?: AbortSignal;
}

/**
 * Opens every Dealio screen in the message of an acknowledged component, so the
 * panel changes in place instead of stacking new messages.
 */
export function createDealioNavigator(services: DealioCommandServices): Navigate {
  const navigate: Navigate = async (target, component) => {
    const interaction = component as unknown as ChatInputCommandInteraction;
    const ui = { inPlace: true, navigate };
    if (target === 'home') return handleDealio(interaction, services, ui);
    if (target === 'settings') {
      return handleStatus(interaction, services.statusService, services.userConfigurationService,
        services.lifecycleSignal, services.discountThresholdService, services.testNotificationService, ui,
        services.setupService);
    }
    if (target === 'check') {
      return handleCheck(interaction, services.checkService, services.statusService, services.notificationService,
        { ...ui, lifecycleSignal: services.lifecycleSignal });
    }
    const assistant = services.wishlistViewService.assistantService;
    if (!assistant) throw new Error('The Dealio assistant is not configured');
    return handleAssistant(interaction, assistant, services.wishlistViewService, services.lifecycleSignal,
      target === 'games' || target === 'deals' ? 'wishlist' : 'rhythm', ui, { eligibleOnly: target === 'deals' });
  };
  return navigate;
}

export async function handleDealio(
  interaction: ChatInputCommandInteraction,
  services: DealioCommandServices,
  ui: PanelNavigation = {},
): Promise<void> {
  const navigate = ui.navigate ?? createDealioNavigator(services);
  const editPanel = (options: InteractionEditReplyOptions) => measureDiscordOperation(
    interaction, 'dealio.render', () => interaction.editReply(options),
  );
  if (!ui.inPlace) {
    await measureDiscordOperation(interaction, 'dealio.ack',
      () => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
  }
  let handedOff = false;
  const fallbackLanguage = languageFromDiscordLocale(interaction.locale);
  let current = services.statusService.getDashboard(interaction.user.id, fallbackLanguage);
  // A newcomer's /dealio is the setup welcome itself, not a notice pointing to it.
  if (current.status === 'not-configured' && services.setupService) {
    return handleSetup(interaction, services.setupService, services.lifecycleSignal, services.setupPresentation,
      { navigate, inPlace: true });
  }
  let avatarUrl: string | undefined;
  try {
    avatarUrl = interaction.client.user?.displayAvatarURL({ extension: 'png', size: 128 });
  } catch (_error: unknown) {
    avatarUrl = undefined;
  }
  const bannerUrl = services.setupPresentation?.bannerUrl;
  const featured = () => {
    const assistant=services.wishlistViewService?.assistantService, config=assistant?.config(interaction.user.id);
    if(!assistant||!config)return {};
    const snapshot=assistant.repository.snapshot(config);
    const items=snapshot?.items??[];
    const rules=assistant.repository.rules(config);
    // The deepest discount leads, so Home always shows the best deal first.
    const matching=items.filter(item=>matchesRule(item,rules.get(item.appId),config.minimumDiscountPercent))
      .sort((a,b)=>(b.price?.discountPercent??0)-(a.price?.discountPercent??0));
    return {featuredDeal:matching[0],heroGame:matching[0]??items.find(item=>item.price?.currency),
      eligibleDealCount:snapshot?matching.length:undefined,trackedGameCount:snapshot?items.length:undefined,
      staleTargetCount:items.filter(item=>staleTarget(item,rules.get(item.appId))).length,
      capturedAt:snapshot?.capturedAt,notificationPreference:assistant.repository.preference(config.discordUserId)};
  };
  const firstPanel = current.status === 'ready'
    ? buildStatusV2Panel(current, interaction.id, { mode: 'home', bannerUrl, avatarUrl, ...featured() })
    : buildNoticePanel(
        current.language,
        current.status === 'not-configured' ? 'warning' : 'danger',
        current.status === 'not-configured'
          ? messagesFor(current.language).setupWizardTitle
          : localizer(current.language)({ tr: 'Paneli açamadım', en: 'Couldn’t open the panel', de: 'Panel konnte nicht geöffnet werden', fr: 'Impossible d’ouvrir le panneau' }),
        current.status === 'not-configured'
          ? messagesFor(current.language).statusNotConfigured
          : messagesFor(current.language).statusDashboardUnavailable,
        current.status === 'not-configured'
          ? { button: {
              customId: `dealio:${interaction.id}:setup`,
              label: messagesFor(current.language).setupWizardStart,
              emoji: '✨',
            } }
          : {},
      );
  const message = await editPanel({
    flags: dealioV2Flags,
    components: [firstPanel],
  });
  const closeUiSession = dealioUiSessions.open(
    interaction.id,
    interaction.user.id,
    ['dealio'],
    dealioUiSessionTimeoutMs,
  );
  const collector = message.createMessageComponentCollector({
    time: dealioUiSessionTimeoutMs,
    filter: (component) => isFromUser(component, interaction.user.id)
      && component.customId.startsWith(`dealio:${interaction.id}:`),
  });
  const operations = new PanelOperationQueue(async (error) => {
    safeLogger.error('Discord panel update failed', error);
    await interaction.followUp({
      flags: dealioEphemeralV2Flags,
      components: [buildNoticePanel(
        current.language, 'warning',
        uiCopy(current.language).actionFailedTitle,
        uiCopy(current.language).actionFailedDescription,
      )],
    });
  });

  collector.on('collect', (component) => {
    const acknowledge = () => measureDiscordOperation(
      component, 'dealio.button-ack', () => component.deferUpdate(),
    );
    const action = component.customId.slice(`dealio:${interaction.id}:`.length);
    const target = action === 'check' || action === 'deals' ? action : parseTabAction(action);
    if (target && target !== 'home') {
      handedOff = true;
      handOffPanel({ component, target, navigate, stop: () => collector.stop('handoff'), settle: () => operations.drain() });
      return;
    }
    if (action === 'recommend') {
      // A separate private message, so the panel stays as it is.
      void measureDiscordOperation(component, 'recommend.open', () => component.reply({
        flags: dealioEphemeralV2Flags, components: [buildRecommendPanel(current.language)],
      })).catch((error: unknown) => safeLogger.error('Dealio recommend message failed', error));
      return;
    }
    if (action === 'setup') {
      void handleSetup(
        component as unknown as ChatInputCommandInteraction,
        services.setupService,
        services.lifecycleSignal,
        services.setupPresentation,
        { navigate },
      ).catch((error: unknown) => safeLogger.error('Dealio home setup navigation failed', error));
      return;
    }
    void operations.enqueue(acknowledge(), async () => undefined);
  });

  const ended = new Promise<void>((resolve) => collector.once('end', () => resolve()));
  const stopForShutdown = (): void => collector.stop('shutdown');
  services.lifecycleSignal?.addEventListener('abort', stopForShutdown, { once: true });
  if (services.lifecycleSignal?.aborted) collector.stop('shutdown');
  try {
    await ended;
    await operations.drain();
    if (handedOff) {
      return;
    }
    if (current.status === 'ready') {
      await editPanel({
        components: [buildStatusV2Panel(current, interaction.id, {
          mode: 'home', bannerUrl, avatarUrl, ...featured(), disabled: true,
        })],
      }).catch((error: unknown) => safeLogger.error('Dealio home cleanup failed', error));
    } else {
      await editPanel({
        components: [buildNoticePanel(
          current.language, 'info',
          uiCopy(current.language).panelClosedTitle,
          localizer(current.language)({
            tr: 'Kaldığın yerden devam etmek için /dealio yazman yeterli.',
            en: 'Type /dealio to pick up where you left off.',
            de: 'Tipp /dealio, um weiterzumachen.',
            fr: 'Tape /dealio pour reprendre où tu en étais.',
          }),
        )],
      }).catch((error: unknown) => safeLogger.error('Dealio welcome cleanup failed', error));
    }
  } finally {
    closeUiSession();
    services.lifecycleSignal?.removeEventListener('abort', stopForShutdown);
  }
}
