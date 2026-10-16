import { measureDiscordOperation } from '../interaction-timing.js';
import type { InteractionEditReplyOptions } from 'discord.js';
import { safeLogger } from '../../application/safe-logger.js';
import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  InvalidUserConfigurationError,
  type PreparedUserConfiguration,
} from '../../application/user-configuration-service.js';
import { AccountBlockedError } from '../../application/account-block.js';
import { SetupAlreadyCompletedError, SetupCapacityReachedError } from '../../application/setup-service.js';
import type { SetupService } from '../../application/setup-service.js';
import { SteamWishlistError } from '../../domain/steam.js';
import { SteamIdentityError } from '../../domain/steam-identity.js';
import {
  parseStoreCountryCode,
} from '../../domain/store-country.js';
import { isLanguage, type Language } from '../../domain/user-config.js';
import { localizer } from '../i18n.js';
import {
  languageFromDiscordLocale,
  suggestedStoreCountryFromDiscordLocale,
} from '../language.js';
import { messagesFor } from '../messages.js';
import {
  buildSetupCountrySelectOptions,
  canUseSetupComponent,
  parseSetupAction,
  type SetupPresentationOptions,
} from '../setup-view.js';
import {
  buildSetupAlreadyCompletedPanel,
  buildSetupCompletePanel,
  buildSetupConfirmationPanel,
  buildSetupWelcomePanel,
  setupCompleteDetail,
  setupCompleteStatus,
} from '../setup-view.js';
import {
  buildNoticePanel,
  dealioV2Flags,
} from '../ui/components-v2.js';
import { buildCountryListPanel, buildCountryRangePanel, buildCountrySearchModal, buildCountrySearchPanel } from '../ui/country-picker.js';
import { handOffPanel, type PanelNavigation } from '../ui/tab-bar.js';
import { dealioUiSessions } from '../ui/session-manager.js';
import { isFromUser } from '../ui/refused-interactions.js';

const setupSessionTimeoutMs = 5 * 60 * 1_000;
const lookingUp = {
  tr: 'Steam hesabına bakıyorum',
  en: 'Looking up your Steam account',
  de: 'Ich suche dein Steam-Konto',
  fr: 'Je cherche ton compte Steam',
} as const;

const capacityTitle = {
  tr: 'Dealio şu an dolu',
  en: 'Dealio is full right now',
  de: 'Dealio ist gerade voll',
  fr: 'Dealio est complet pour le moment',
} as const;

export const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Connect your Steam wishlist in about a minute')
  .setDescriptionLocalizations({
    tr: 'Steam istek listeni bir dakikada bağla',
    de: 'Deine Steam-Wunschliste in etwa einer Minute verbinden',
    fr: 'Connecter ta liste de souhaits Steam en une minute environ',
  });

export async function handleSetup(
  interaction: ChatInputCommandInteraction,
  service: Pick<SetupService, 'configure' | 'prepare' | 'confirm'>
    & Partial<Pick<SetupService, 'hasExistingConfiguration' | 'acceptsNewUsers'>>,
  lifecycleSignal?: AbortSignal,
  presentation: SetupPresentationOptions = {},
  ui: PanelNavigation = {},
): Promise<void> {
  const editPanel = (options: InteractionEditReplyOptions) => measureDiscordOperation(
    interaction, 'setup.render', () => interaction.editReply(options),
  );
  if (!ui.inPlace) {
    await measureDiscordOperation(interaction, 'setup.ack',
      () => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
  }
  const initialLanguage = languageFromDiscordLocale(interaction.locale ?? 'en-US');
  const avatarUrl = safeAvatarUrl(interaction);
  const viewOptions = { ...presentation, avatarUrl };
  if (service.hasExistingConfiguration?.(interaction.user.id)) {
    await editPanel({
      components: [buildSetupAlreadyCompletedPanel(initialLanguage, viewOptions)],
      flags: dealioV2Flags,
    });
    return;
  }

  if (service.acceptsNewUsers?.() === false) {
    await editPanel({
      components: [buildNoticePanel(initialLanguage, 'warning',
        localizer(initialLanguage)(capacityTitle), setupErrorMessage(new SetupCapacityReachedError(), initialLanguage))],
      flags: dealioV2Flags,
    });
    return;
  }

  const legacyProfile = safeGetString(interaction, 'steam-profile')
    ?? safeGetString(interaction, 'steamid64');
  if (legacyProfile) {
    await handleLegacySetup(interaction, service, legacyProfile);
    return;
  }

  let language = initialLanguage;
  let showingHow = false;
  const response = await editPanel({
    components: [buildSetupWelcomePanel(language, interaction.id, viewOptions)],
    flags: dealioV2Flags,
  });
  const closeUiSession = dealioUiSessions.open(
    interaction.id,
    interaction.user.id,
    ['setup', 'country'],
    setupSessionTimeoutMs,
  );
  const collector = response.createMessageComponentCollector({
    time: setupSessionTimeoutMs,
    filter: (component) => isFromUser(component, interaction.user.id)
      && (canUseSetupComponent(component.customId, component.user.id, interaction.user.id, interaction.id)
        || component.customId.startsWith(`country:${interaction.id}:`)),
  });
  const localeCountry = suggestedStoreCountryFromDiscordLocale(interaction.locale ?? '') ?? 'US';
  let prepared: PreparedUserConfiguration | null = null;
  let completed = false;
  let sessionActive = true;
  let modalSequence = 0;
  let regionSelectionSource: 'discord-locale' | 'user' = 'discord-locale';
  let pendingProfileInput: string | null = null;
  let countrySelectionPurpose: 'initial' | 'change' | null = null;
  let operations = Promise.resolve();
  const concurrentOperations = new Set<Promise<void>>();
  const sessionClosed = new Promise<void>((resolve) => {
    collector.once('end', () => {
      sessionActive = false;
      resolve();
    });
  });
  const confirmationViewOptions = (): SetupPresentationOptions => ({
    ...viewOptions,
    regionSelectionSource,
  });
  const reportWizardFailure = async (error: unknown): Promise<void> => {
    safeLogger.error('Discord setup wizard failed', error);
    try {
      await editPanel({
        components: [buildSetupErrorPanel(error, language, interaction.id)],
      });
    } catch (_replyError: unknown) {
      safeLogger.error('Discord setup wizard error response failed.');
    }
  };
  let completedPanel: { readonly prepared: PreparedUserConfiguration; readonly status: Parameters<typeof buildSetupCompletePanel>[1] } | null = null;
  let handedOff = false;
  collector.on('collect', (component) => {
    const acknowledge = () => measureDiscordOperation(
      component, 'setup.button-ack', () => component.deferUpdate(),
    );
    if (component.customId === `setup:${interaction.id}:open`) {
      // Setup is done: hand this message to the Dealio panel instead of a dead end.
      if (completedPanel && ui.navigate) {
        handedOff = true;
        handOffPanel({ component, target: 'home', navigate: ui.navigate,
          stop: () => collector.stop('handoff'), settle: () => operations });
      } else {
        void acknowledge().catch(() => undefined);
      }
      return;
    }
    if (component.customId === `country:${interaction.id}:cancel` && component.isButton()) {
      const previousOperations = operations;
      const acknowledgement = acknowledge().then(
        () => ({ status: 'fulfilled' } as const),
        (error: unknown) => ({ status: 'rejected', error } as const),
      );
      operations = (async () => {
        const acknowledgementResult = await acknowledgement;
        await previousOperations;
        if (acknowledgementResult.status === 'rejected') {
          await reportWizardFailure(acknowledgementResult.error);
          return;
        }
        if (!sessionActive) {
          return;
        }
        // Cancelling the picker returns to where it was opened: the summary, or the start.
        countrySelectionPurpose = null;
        pendingProfileInput = null;
        await editPanel({
          components: [prepared
            ? buildSetupConfirmationPanel(prepared, interaction.id, confirmationViewOptions())
            : buildSetupWelcomePanel(language, interaction.id, viewOptions)],
        });
      })().catch(reportWizardFailure);
      return;
    }
    if (component.customId === `country:${interaction.id}:search` && component.isButton()) {
      const searchId = `setup-country-search:${interaction.id}:${++modalSequence}`;
      void (async () => {
        await measureDiscordOperation(component, 'setup.modal', () => component.showModal(buildCountrySearchModal(searchId, language)));
        const modal = await Promise.race([
          component.awaitModalSubmit({
            time: setupSessionTimeoutMs,
            filter: (submission) => submission.customId === searchId && isFromUser(submission, interaction.user.id),
          }).catch(() => null),
          sessionClosed.then(() => null),
        ]);
        if (!modal || !sessionActive) {
          return;
        }
        const query = modal.fields.getTextInputValue('country-query').trim();
        await measureDiscordOperation(modal, 'setup.modal-submit-ack', () => modal.deferUpdate());
        const previousOperations = operations;
        operations = (async () => {
          await previousOperations;
          if (sessionActive) {
            await editPanel({
              components: [buildCountrySearchPanel(language, interaction.id, query, prepared?.storeCountryCode)],
            });
          }
        })().catch(reportWizardFailure);
      })().catch(reportWizardFailure);
      return;
    }
    if (component.customId === `country:${interaction.id}:range` && component.isStringSelectMenu()) {
      const rangeIndex = Number(component.values[0]);
      const previousOperations = operations;
      const acknowledgement = acknowledge().then(
        () => ({ status: 'fulfilled' } as const),
        (error: unknown) => ({ status: 'rejected', error } as const),
      );
      operations = (async () => {
        const acknowledgementResult = await acknowledgement;
        await previousOperations;
        if (acknowledgementResult.status === 'rejected') {
          await reportWizardFailure(acknowledgementResult.error);
          return;
        }
        if (!sessionActive) {
          return;
        }
        await editPanel({
          components: [buildCountryListPanel(
            language,
            interaction.id,
            rangeIndex,
            prepared?.storeCountryCode,
          )],
        });
      })().catch(reportWizardFailure);
      return;
    }
    if (component.customId === `country:${interaction.id}:back` && component.isButton()) {
      const previousOperations = operations;
      const acknowledgement = acknowledge().then(
        () => ({ status: 'fulfilled' } as const),
        (error: unknown) => ({ status: 'rejected', error } as const),
      );
      operations = (async () => {
        const acknowledgementResult = await acknowledgement;
        await previousOperations;
        if (acknowledgementResult.status === 'rejected') {
          await reportWizardFailure(acknowledgementResult.error);
          return;
        }
        if (!sessionActive) {
          return;
        }
        await editPanel({
          components: [buildCountryRangePanel(language, interaction.id, { selected: prepared?.storeCountryCode ?? localeCountry })],
        });
      })().catch(reportWizardFailure);
      return;
    }
    if (component.customId === `country:${interaction.id}:select` && component.isStringSelectMenu()) {
      const selectedCountry = parseStoreCountryCode(component.values[0] ?? '');
      const purpose = countrySelectionPurpose;
      const profileInput = pendingProfileInput;
      const countrySelectionOperation = (async () => {
        await acknowledge();
        if (!sessionActive || !selectedCountry || !purpose) {
          return;
        }
        regionSelectionSource = 'user';
        if (purpose === 'change' && prepared) {
          prepared = { ...prepared, storeCountryCode: selectedCountry };
          countrySelectionPurpose = null;
          await editPanel({
            components: [buildSetupConfirmationPanel(
              prepared,
              interaction.id,
              confirmationViewOptions(),
            )],
          });
          return;
        }
        if (purpose === 'initial' && profileInput) {
          await editPanel({
            components: [buildNoticePanel(
              language,
              'info',
              localizer(language)(lookingUp),
              messagesFor(language).setupWizardPreparing,
            )],
          });
          if (!sessionActive) {
            return;
          }
          try {
            const nextPrepared = await service.prepare(
              interaction.user.id,
              profileInput,
              language,
              selectedCountry,
            );
            if (!sessionActive) {
              return;
            }
            prepared = nextPrepared;
            pendingProfileInput = null;
            countrySelectionPurpose = null;
            await editPanel({
              components: [buildSetupConfirmationPanel(
                prepared,
                interaction.id,
                confirmationViewOptions(),
              )],
            });
          } catch (error: unknown) {
            if (!sessionActive) {
              return;
            }
            pendingProfileInput = null;
            countrySelectionPurpose = null;
            await editPanel({
              components: [buildSetupErrorPanel(error, language, interaction.id)],
            });
          }
        }
      })().catch((error: unknown) => safeLogger.error('Discord setup country selection failed', error));
      concurrentOperations.add(countrySelectionOperation);
      void countrySelectionOperation.then(
        () => concurrentOperations.delete(countrySelectionOperation),
        () => concurrentOperations.delete(countrySelectionOperation),
      );
      return;
    }
    const immediateAction = parseSetupAction(component.customId, interaction.id);
    if (immediateAction === 'start') {
      const sequence = ++modalSequence;
      const modalOperation = (async () => {
        if (completed || !sessionActive) {
          await acknowledge().catch(() => undefined);
          return;
        }
        const modalId = `setup-modal:${interaction.id}:${interaction.user.id}:${sequence}`;
        const suggestedCountry = suggestedStoreCountryFromDiscordLocale(
          interaction.locale ?? '',
        ) ?? 'US';
        await measureDiscordOperation(component, 'setup.modal',
          () => component.showModal(buildSetupModal(modalId, language, suggestedCountry)));
        if (!sessionActive) {
          return;
        }
        const modal = await Promise.race([
          component.awaitModalSubmit({
            time: setupSessionTimeoutMs,
            filter: (submission) => submission.customId === modalId
              && isFromUser(submission, interaction.user.id),
          }).catch(() => null),
          sessionClosed.then(() => null),
        ]);
        if (!modal || !sessionActive) {
          return;
        }
        await measureDiscordOperation(modal, 'setup.modal-submit-ack', () => modal.deferUpdate());
        if (sequence !== modalSequence || completed || !sessionActive) {
          return;
        }
        const messages = messagesFor(language);
        const selectedValue = modal.fields.getStringSelectValues('store-country')[0] ?? '';
        const profileInput = modal.fields.getTextInputValue('steam-profile');
        if (selectedValue === 'OTHER') {
          pendingProfileInput = profileInput;
          countrySelectionPurpose = 'initial';
          regionSelectionSource = 'user';
          await editPanel({
            components: [buildCountryRangePanel(language, interaction.id, { selected: prepared?.storeCountryCode ?? localeCountry })],
          });
          return;
        }
        await editPanel({
          flags: dealioV2Flags,
          components: [buildNoticePanel(
            language,
            'info',
            localizer(language)(lookingUp),
            messages.setupWizardPreparing,
          )],
        });
        try {
          const selectedCountry = parseStoreCountryCode(
            selectedValue,
          ) ?? suggestedCountry;
          const nextPrepared = await service.prepare(
            interaction.user.id,
            profileInput,
            language,
            selectedCountry,
          );
          if (sequence !== modalSequence || completed || !sessionActive) {
            return;
          }
          prepared = nextPrepared;
          regionSelectionSource = selectedCountry === suggestedCountry
            ? 'discord-locale'
            : 'user';
        } catch (error: unknown) {
          if (sequence !== modalSequence || completed || !sessionActive) {
            return;
          }
          await editPanel(error instanceof SetupAlreadyCompletedError
            ? {
                components: [buildSetupAlreadyCompletedPanel(language, viewOptions)],
              }
            : {
                components: [buildSetupErrorPanel(error, language, interaction.id)],
              });
          return;
        }
        await editPanel({
          components: [buildSetupConfirmationPanel(
            prepared,
            interaction.id,
            confirmationViewOptions(),
          )],
        });
      })().catch(async (error: unknown) => {
        safeLogger.error('Discord setup modal failed', error);
        if (!sessionActive) {
          return;
        }
        await editPanel({
          components: [buildSetupErrorPanel(error, language, interaction.id)],
        }).catch(() => undefined);
      });
      concurrentOperations.add(modalOperation);
      void modalOperation.then(
        () => concurrentOperations.delete(modalOperation),
        () => concurrentOperations.delete(modalOperation),
      );
      return;
    }

    if (immediateAction === 'region') {
      const regionOperation = (async () => {
        await acknowledge();
        if (!prepared || completed || !sessionActive) {
          return;
        }
        countrySelectionPurpose = 'change';
        await editPanel({
          components: [buildCountryRangePanel(language, interaction.id, { selected: prepared?.storeCountryCode ?? localeCountry })],
        });
      })().catch(async (error: unknown) => {
        safeLogger.error('Discord setup region picker failed', error);
        if (sessionActive) {
          await editPanel({
            components: [buildSetupErrorPanel(error, language, interaction.id)],
          }).catch(() => undefined);
        }
      });
      concurrentOperations.add(regionOperation);
      void regionOperation.then(
        () => concurrentOperations.delete(regionOperation),
        () => concurrentOperations.delete(regionOperation),
      );
      return;
    }

    // Acknowledge on receipt, not after earlier edits or Steam work finish.
    // Observe rejection immediately even while this action waits for the panel.
    const acknowledgement = acknowledge().then(
      () => ({ status: 'fulfilled' } as const),
      (error: unknown) => ({ status: 'rejected', error } as const),
    );
    operations = operations.then(async () => {
      const outcome = await acknowledgement;
      const action = parseSetupAction(component.customId, interaction.id);
      if (completed) {
        return;
      }
      if (outcome.status === 'rejected') throw outcome.error;
      if (action === 'how') {
        showingHow = true;
        await editPanel({
          components: [buildSetupWelcomePanel(language, interaction.id, viewOptions, true)],
        });
        return;
      }
      if (action === 'language' && !prepared) {
        // Chosen on the welcome screen: everything from here on, the setup form included, is in this language.
        const chosen = component.isStringSelectMenu() ? component.values[0] ?? '' : '';
        language = isLanguage(chosen) ? chosen : language;
        await editPanel({
          components: [buildSetupWelcomePanel(language, interaction.id, viewOptions, showingHow)],
        });
        return;
      }
      if (action === 'cancel') {
        completed = true;
        collector.stop('cancelled');
        await editPanel({
          components: [buildNoticePanel(
            language,
            'info',
            localizer(language)({ tr: 'Kurulum iptal edildi', en: 'Setup cancelled', de: 'Einrichtung abgebrochen', fr: 'Configuration annulée' }),
            messagesFor(language).setupWizardCancelled,
          )],
        });
        return;
      }
      if (action === 'confirm' && prepared) {
        completed = true;
        await editPanel({
          components: [buildSetupConfirmationPanel(
            prepared,
            interaction.id,
            confirmationViewOptions(),
            true,
          )],
        });
        let result;
        try {
          result = await service.confirm(prepared);
        } catch (error: unknown) {
          // The error panel offers to start again; that button must still work.
          completed = false;
          throw error;
        }
        const status = setupCompleteStatus(result.summary);
        completedPanel = { prepared, status };
        await editPanel({
          components: [buildSetupCompletePanel(prepared, status, viewOptions, ui.navigate ? interaction.id : undefined)],
        });
        if (!ui.navigate) collector.stop('completed');
        return;
      }
    }).catch(reportWizardFailure);
  });

  const stopForShutdown = (): void => collector.stop('shutdown');
  lifecycleSignal?.addEventListener('abort', stopForShutdown, { once: true });
  if (lifecycleSignal?.aborted) {
    collector.stop('shutdown');
  }
  await sessionClosed;
  closeUiSession();
  await operations;
  await Promise.all(concurrentOperations);
  lifecycleSignal?.removeEventListener('abort', stopForShutdown);
  const finished = completedPanel as { readonly prepared: PreparedUserConfiguration; readonly status: Parameters<typeof buildSetupCompletePanel>[1] } | null;
  if (finished && ui.navigate && !handedOff) {
    // The session ended without opening the panel: remove the button rather than leave it dead.
    await editPanel({ components: [buildSetupCompletePanel(finished.prepared, finished.status, viewOptions)] }).catch(() => undefined);
  }
  if (!completed) {
    const expiredPrepared = prepared as PreparedUserConfiguration | null;
    try {
      await editPanel({
        components: expiredPrepared
          ? [buildSetupConfirmationPanel(
              expiredPrepared,
              interaction.id,
              confirmationViewOptions(),
              true,
            )]
          : [buildSetupWelcomePanel(language, interaction.id, viewOptions, false, true)],
      });
    } catch (_error: unknown) {
      // Expired Discord interactions cannot be edited.
    }
  }
}

/**
 * The Steam profile form: the profile link and the Store country. Setup and
 * "Change Steam account" in Settings open this same form; Settings only renames
 * it and explains that the current region is preselected.
 */
export function buildSetupModal(
  customId: string,
  language: Language,
  suggestedCountry: Parameters<typeof buildSetupCountrySelectOptions>[1],
  wording: { readonly title?: string; readonly regionDescription?: string } = {},
): ModalBuilder {
  const messages = messagesFor(language);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(wording.title ?? messages.setupWizardModalTitle)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(messages.setupWizardProfileLabel)
        .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId('steam-profile')
          .setPlaceholder(messages.setupWizardProfilePlaceholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
      new LabelBuilder()
        .setLabel(messages.setupWizardCountryLabel)
        .setDescription(wording.regionDescription ?? messages.setupWizardRegionSuggested)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('store-country')
            .setPlaceholder(messages.setupWizardCountryPickerPlaceholder)
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true)
            .addOptions(buildSetupCountrySelectOptions(language, suggestedCountry)),
        ),
    );
}

async function handleLegacySetup(
  interaction: ChatInputCommandInteraction,
  service: Pick<SetupService, 'configure'>,
  profileInput: string,
): Promise<void> {
  const rawLanguage = safeGetString(interaction, 'language');
  const language: Language = rawLanguage && isLanguage(rawLanguage) ? rawLanguage : 'tr';
  const storeCountry = safeGetString(interaction, 'store-country') ?? undefined;
  try {
    const { config, summary } = await service.configure(
      interaction.user.id,
      profileInput,
      language,
      storeCountry,
    );
    const messages = messagesFor(config.language);
    const summaryMessage = setupCompleteDetail(setupCompleteStatus(summary), config.language);
    await interaction.editReply({
      flags: dealioV2Flags,
      components: [buildNoticePanel(
        config.language,
        summary.status === 'sent' ? 'success' : 'warning',
        localizer(config.language)({ tr: 'Her şey hazır!', en: 'You’re all set!', de: 'Alles eingerichtet!', fr: 'Tout est prêt !' }),
        `${messages.setupSuccess} ${summaryMessage}`,
      )],
    });
  } catch (error: unknown) {
    await interaction.editReply({
      flags: dealioV2Flags,
      components: [buildSetupErrorPanel(error, language, interaction.id)],
    });
  }
}

function buildSetupErrorPanel(
  error: unknown,
  language: Language,
  sessionId: string,
) {
  return buildNoticePanel(
    language,
    'danger',
    localizer(language)({ tr: 'Kurulumu bitiremedik', en: 'Setup didn’t finish', de: 'Einrichtung nicht abgeschlossen', fr: 'Configuration inachevée' }),
    setupErrorMessage(error, language),
    {
      button: {
        customId: `setup:${sessionId}:start`,
        label: messagesFor(language).setupWizardStart,
        emoji: '🔄',
      },
    },
  );
}

export function setupErrorMessage(error: unknown, language: Language): string {
  const messages = messagesFor(language);
  if (error instanceof SetupAlreadyCompletedError) {
    return messages.setupWizardAlreadyCompletedDescription;
  }
  if (error instanceof AccountBlockedError) {
    return localizer(language)({
      tr: 'Bu hesabın Dealio erişimi kapatıldı. Verilerini /delete-data ile yine de silebilirsin.',
      en: 'Dealio access has been turned off for this account. You can still delete your data with /delete-data.',
      de: 'Der Dealio-Zugang für dieses Konto wurde deaktiviert. Deine Daten kannst du trotzdem mit /delete-data löschen.',
      fr: 'L’accès à Dealio a été désactivé pour ce compte. Tu peux toujours supprimer tes données avec /delete-data.',
    });
  }
  if (error instanceof SetupCapacityReachedError) {
    return localizer(language)({
      tr: 'Dealio şimdilik sınırlı sayıda kullanıcıyla çalışıyor ve bu sınır doldu. Yer açıldığında yeniden deneyebilirsin; hiçbir bilgini kaydetmedim.',
      en: 'Dealio is running with a limited number of users for now, and that limit is reached. You can try again when a spot opens up; I haven’t saved anything about you.',
      de: 'Dealio läuft vorerst mit einer begrenzten Zahl von Nutzern, und die Grenze ist erreicht. Versuch es wieder, sobald ein Platz frei wird; ich habe nichts von dir gespeichert.',
      fr: 'Dealio fonctionne pour l’instant avec un nombre limité d’utilisateurs, et la limite est atteinte. Tu pourras réessayer quand une place se libère ; je n’ai rien enregistré sur toi.',
    });
  }
  if (error instanceof InvalidUserConfigurationError) {
    return error.code === 'INVALID_STORE_COUNTRY'
      ? messages.invalidStoreCountry
      : messages.invalidSetup;
  }
  if (error instanceof SteamIdentityError) {
    return error.code === 'STEAM_PROFILE_INVALID'
      ? messages.invalidSteamProfile
      : error.code === 'STEAM_VANITY_NOT_FOUND'
        ? messages.vanityProfileNotFound
        : error.code === 'STEAM_WEB_API_KEY_MISSING'
          ? messages.steamWebApiKeyMissing
          : messages.vanityResolutionUnavailable;
  }
  if (error instanceof SteamWishlistError) {
    return error.code === 'STEAM_WISHLIST_INACCESSIBLE'
      ? messages.wishlistInaccessible
      : messages.setupValidationUnavailable;
  }
  return localizer(language)({
    tr: 'Kurulumu şu an bitiremedim. Biraz sonra yeniden dener misin?',
    en: 'I couldn’t finish setup right now. Could you try again in a bit?',
    de: 'Ich konnte die Einrichtung gerade nicht abschließen. Versuchst du es gleich noch mal?',
    fr: 'Je n’ai pas pu terminer la configuration. Tu peux réessayer dans un moment ?',
  });
}

function safeGetString(
  interaction: ChatInputCommandInteraction,
  name: string,
): string | null {
  try {
    return interaction.options.getString(name);
  } catch (_error: unknown) {
    return null;
  }
}

function safeAvatarUrl(interaction: ChatInputCommandInteraction): string | undefined {
  try {
    return interaction.client.user?.displayAvatarURL({ extension: 'png', size: 128 });
  } catch (_error: unknown) {
    return undefined;
  }
}
