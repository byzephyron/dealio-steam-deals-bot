import { safeLogger } from '../application/safe-logger.js';
import { Events, MessageFlags, type ChatInputCommandInteraction, type Client, type Interaction } from 'discord.js';
import type { ApplicationTaskTracker } from '../application/application-task-tracker.js';
import type { CheckService } from '../application/check-service.js';
import type { DiscountThresholdService } from '../application/discount-threshold-service.js';
import type { NotificationRetryScheduler } from '../application/notification-retry-scheduler.js';
import type { NotificationService } from '../application/notification-service.js';
import type { RuntimeHealth } from '../application/runtime-health.js';
import type { WishlistScheduler } from '../application/scheduler.js';
import type { SetupService } from '../application/setup-service.js';
import type { StatusService } from '../application/status-service.js';
import type { TestNotificationService } from '../application/test-notification-service.js';
import type { UserConfigurationService } from '../application/user-configuration-service.js';
import type { WishlistViewService } from '../application/wishlist-view-service.js';
import { handleDeleteData } from './commands/delete-data.js';
import { handleSetup } from './commands/setup.js';
import { createDealioNavigator, handleDealio } from './commands/dealio.js';
import type { SetupPresentationOptions } from './setup-view.js';
import { buildExpiredPanel, buildNoticePanel, dealioEphemeralV2Flags, openPanelCustomId } from './ui/components-v2.js';
import { dealioUiSessions } from './ui/session-manager.js';
import { localizer } from './i18n.js';
import { languageFromDiscordLocale } from './language.js';
import { recordInteraction } from './interaction-telemetry.js';
import { refuseInteraction } from './ui/refused-interactions.js';
import type { TelemetryRepository } from '../persistence/telemetry-repository.js';
import { handleSupportInteraction, isSupportInteraction, type SupportInteractionOptions } from './support/support-interactions.js';

export interface BotCommandServices {
  readonly userConfigurationService: UserConfigurationService;
  readonly setupService: SetupService;
  readonly statusService: StatusService;
  readonly checkService: CheckService;
  readonly notificationService: NotificationService;
  readonly testNotificationService: TestNotificationService;
  readonly wishlistViewService: WishlistViewService;
  readonly discountThresholdService: DiscountThresholdService;
  readonly setupPresentation?: SetupPresentationOptions;
}

export interface BotEventOptions {
  readonly client: Client;
  readonly scheduler: Pick<WishlistScheduler, 'start'>;
  readonly notificationRetryScheduler: Pick<NotificationRetryScheduler, 'start'>;
  readonly taskTracker: Pick<ApplicationTaskTracker, 'run'>;
  readonly services: BotCommandServices;
  readonly lifecycleSignal?: AbortSignal;
  readonly health?: Pick<RuntimeHealth, 'markReady' | 'refreshDiscordReady'>;
  /** Usage telemetry for the owner's admin panel. */
  readonly telemetry?: Pick<TelemetryRepository, 'recordInteraction'>;
  /** Accounts the owner blocked from the admin panel. */
  readonly blocks?: { isUserBlocked(discordUserId: string): boolean };
  /** Support tickets in the Dealio support server. */
  readonly support?: SupportInteractionOptions;
}

/**
 * Deleting one's data stays possible for a blocked account: the command, its
 * buttons and its confirmation form. Setting Dealio up again afterwards does not.
 */
export function allowedWhileBlocked(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) return interaction.commandName === 'delete-data';
  if (interaction.isMessageComponent()) {
    return interaction.customId.startsWith('delete-v2:') && !interaction.customId.endsWith(':setup');
  }
  if (interaction.isModalSubmit()) return interaction.customId.startsWith('delete-confirm:');
  return false;
}

export function registerBotEvents(options: BotEventOptions): void {
  const {
    client,
    scheduler,
    notificationRetryScheduler,
    taskTracker,
    services,
    lifecycleSignal,
    health,
    telemetry,
    blocks,
    support,
  } = options;

  client.once(Events.ClientReady, () => {
    console.log(`${new Date().toISOString()} Discord client is ready; schedulers started.`);
    scheduler.start();
    notificationRetryScheduler.start();
    health?.markReady();
  });
  client.on(Events.ShardReady, () => health?.refreshDiscordReady());
  client.on(Events.ShardDisconnect, () => health?.refreshDiscordReady());
  client.on(Events.Invalidated, () => health?.refreshDiscordReady());

  client.on(Events.InteractionCreate, (interaction) => {
    recordInteraction(telemetry, interaction);
    let blocked = false;
    try {
      blocked = blocks?.isUserBlocked(interaction.user.id) === true;
    } catch (error: unknown) {
      safeLogger.error('Could not read the user block list', error);
    }
    if (blocked && !allowedWhileBlocked(interaction)) {
      // Open panels and forms receive this interaction too; they must ignore it.
      refuseInteraction(interaction);
      if (interaction.isRepliable()) {
        const language = languageFromDiscordLocale(interaction.locale);
        const t = localizer(language);
        taskTracker.run(async () => {
          await interaction.reply({
            flags: dealioEphemeralV2Flags,
            components: [buildNoticePanel(language, 'danger',
              t({ tr: 'Dealio bu hesap için kapalı', en: 'Dealio is turned off for this account',
                de: 'Dealio ist für dieses Konto deaktiviert', fr: 'Dealio est désactivé pour ce compte' }),
              t({
                tr: 'Bu hesabın Dealio erişimi kapatıldı. Verilerini /delete-data ile yine de silebilirsin.',
                en: 'Dealio access has been turned off for this account. You can still delete your data with /delete-data.',
                de: 'Der Dealio-Zugang für dieses Konto wurde deaktiviert. Deine Daten kannst du trotzdem mit /delete-data löschen.',
                fr: 'L’accès à Dealio a été désactivé pour ce compte. Tu peux toujours supprimer tes données avec /delete-data.',
              }))],
          }).catch(() => undefined);
        });
      }
      return;
    }
    if (support && isSupportInteraction(interaction)) {
      taskTracker.run(async () => {
        try {
          await handleSupportInteraction(interaction, support);
        } catch (error: unknown) {
          safeLogger.error('Support interaction failed', error);
          const language = support.languageFor(interaction.user.id, interaction.locale);
          const panel = buildNoticePanel(language, 'danger',
            localizer(language)({ tr: 'Bir şeyler ters gitti', en: 'Something went wrong', de: 'Da ist etwas schiefgelaufen', fr: 'Quelque chose s’est mal passé' }),
            localizer(language)({
              tr: 'Geçici bir sorun çıktı. Biraz sonra yeniden dener misin?',
              en: 'A temporary problem got in the way. Could you try again in a moment?',
              de: 'Ein vorübergehendes Problem ist aufgetreten. Versuchst du es gleich noch mal?',
              fr: 'Un souci passager est survenu. Tu peux réessayer dans un instant ?',
            }));
          const reply = interaction.deferred || interaction.replied
            ? interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [panel] })
            : interaction.reply({ flags: dealioEphemeralV2Flags, components: [panel] });
          await reply.catch(() => undefined);
        }
      });
      return;
    }
    if (typeof interaction.isButton === 'function' && interaction.isButton()
      && interaction.customId === openPanelCustomId) {
      // "🏠 Dealio panel" in DMs and expired panels: a fresh panel, like /dealio.
      taskTracker.run(async () => {
        try {
          await handleDealio(interaction as unknown as ChatInputCommandInteraction,
            { ...services, lifecycleSignal }, { navigate: createDealioNavigator({ ...services, lifecycleSignal }) });
        } catch (error: unknown) {
          safeLogger.error('Dealio open-panel button failed', error);
        }
      });
      return;
    }
    if (typeof interaction.isMessageComponent === 'function'
      && interaction.isMessageComponent()
      && isDealioComponent(interaction.customId)) {
      taskTracker.run(async () => {
        const session = dealioUiSessions.resolve(interaction.customId, interaction.user.id);
        if (session === 'active-owner') {
          return;
        }
        const language = services.userConfigurationService.get(interaction.user.id)?.language
          ?? languageFromDiscordLocale(interaction.locale);
        await interaction.reply({
          flags: dealioEphemeralV2Flags,
          components: [session === 'active-other-user'
            ? buildNoticePanel(
                language,
                'warning',
                localizer(language)({ tr: 'Bu panel başkasına ait', en: 'This panel belongs to someone else', de: 'Dieses Panel gehört jemand anderem', fr: 'Ce panneau appartient à quelqu’un d’autre' }),
                localizer(language)({
                  tr: 'Kendi panelini açmak için komutu sen de çalıştırabilirsin.',
                  en: 'Run the command yourself to open your own panel.',
                  de: 'Führ den Befehl selbst aus, um dein eigenes Panel zu öffnen.',
                  fr: 'Lance la commande toi-même pour ouvrir ton propre panneau.',
                }),
              )
            : buildExpiredPanel(language)],
        }).catch(() => undefined);
      });
      return;
    }
    if (!interaction.isChatInputCommand()) {
      return;
    }

    taskTracker.run(async () => {
      try {
        await handleInteraction(interaction, services, lifecycleSignal);
      } catch (error: unknown) {
        safeLogger.error('Discord interaction failed', error);

        try {
          const language = services.userConfigurationService.get(interaction.user.id)?.language
            ?? languageFromDiscordLocale(interaction.locale);
          const panel = buildNoticePanel(
            language,
            'danger',
            localizer(language)({ tr: 'Bir şeyler ters gitti', en: 'Something went wrong', de: 'Da ist etwas schiefgelaufen', fr: 'Quelque chose s’est mal passé' }),
            localizer(language)({
              tr: 'Geçici bir sorun çıktı. Biraz sonra yeniden dener misin?',
              en: 'A temporary problem got in the way. Could you try again in a moment?',
              de: 'Ein vorübergehendes Problem ist aufgetreten. Versuchst du es gleich noch mal?',
              fr: 'Un souci passager est survenu. Tu peux réessayer dans un instant ?',
            }),
          );
          if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
              flags: MessageFlags.IsComponentsV2,
              components: [panel],
            });
          } else {
            await interaction.reply({
              components: [panel],
              flags: dealioEphemeralV2Flags,
            });
          }
        } catch (replyError: unknown) {
          safeLogger.error('Discord interaction error reply failed', replyError);
        }
      }
    });
  });
}

async function handleInteraction(
  interaction: Parameters<typeof handleSetup>[0],
  services: BotCommandServices,
  lifecycleSignal?: AbortSignal,
): Promise<void> {
  // Panels opened by any command share one in-place navigator for their tabs.
  const ui = { navigate: createDealioNavigator({ ...services, lifecycleSignal }) };
  switch (interaction.commandName) {
    case 'dealio':
      await handleDealio(interaction, {
        ...services,
        lifecycleSignal,
      }, ui);
      return;
    case 'setup':
      await handleSetup(
        interaction,
        services.setupService,
        lifecycleSignal,
        services.setupPresentation,
        ui,
      );
      return;
    case 'help':
    case 'region':
    case 'status':
    case 'check':
    case 'wishlist':
    case 'test-notification':
      // /help is an alias of the panel. The others are retired shortcuts: a Discord
      // client that still lists them opens the panel instead.
      await handleDealio(interaction, { ...services, lifecycleSignal }, ui);
      return;
    case 'delete-data':
      await handleDeleteData(
        interaction,
        services.userConfigurationService,
        services.setupService,
        lifecycleSignal,
        services.setupPresentation,
      );
      return;
    default:
      {
        const language = services.userConfigurationService.get(interaction.user.id)?.language
          ?? languageFromDiscordLocale(interaction.locale);
      await interaction.reply({
        components: [buildNoticePanel(
          language,
          'warning',
          localizer(language)({ tr: 'Bu komutu tanımıyorum', en: 'I don’t know that command', de: 'Diesen Befehl kenne ich nicht', fr: 'Je ne connais pas cette commande' }),
          localizer(language)({
            tr: 'Tüm Dealio özelliklerine /dealio ile ulaşabilirsin.',
            en: 'Everything Dealio can do is in /dealio.',
            de: 'Alles, was Dealio kann, findest du unter /dealio.',
            fr: 'Tout ce que fait Dealio se trouve dans /dealio.',
          }),
        )],
        flags: dealioEphemeralV2Flags,
      });
      }
  }
}

function isDealioComponent(customId: string): boolean {
  return [
    'assistant:',
    'dealio:',
    'status-v2:',
    'country:',
    'delete-v2:',
    'setup:',
    'dealio-summary:',
    'check-v2:',
  ].some((prefix) => customId.startsWith(prefix));
}
