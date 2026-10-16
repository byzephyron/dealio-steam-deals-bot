import { defaultPollIntervalHours } from '../config/environment.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  StringSelectMenuBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  escapeMarkdown,
} from 'discord.js';
import type { InitialWishlistSummaryResult } from '../application/initial-wishlist-summary-service.js';
import type { PreparedUserConfiguration } from '../application/user-configuration-service.js';
import {
  storeCountryName,
  type StoreCountryCode,
} from '../domain/store-country.js';
import { languageLocale, languages, type Language } from '../domain/user-config.js';
import { languageChoice, languageFlags, languageNames, localizer } from './i18n.js';
import { messagesFor } from './messages.js';
import { dealioBrand } from './ui/brand.js';
import { assertComponentsV2Limit, dealioFooter } from './ui/components-v2.js';
import { uiCopy } from './ui/copy.js';
import { commonStoreCountries } from './ui/country-picker.js';
import { countryDisplay, flagEmoji, openPanelButton } from './ui/design.js';

export interface SetupPresentationOptions {
  readonly bannerUrl?: string;
  readonly avatarUrl?: string;
  readonly pollIntervalHours?: number;
  readonly regionSelectionSource?: 'discord-locale' | 'user';
}

export type SetupAction = 'start' | 'how' | 'confirm' | 'language' | 'region' | 'cancel' | 'open';

export function buildSetupWelcomePanel(
  language: Language,
  sessionId: string,
  options: SetupPresentationOptions = {},
  showHow = false,
  disabled = false,
): ContainerBuilder {
  const messages = messagesFor(language);
  const container = new ContainerBuilder().setAccentColor(dealioBrand.colors.primary);
  addSetupVisual(container, options);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('-# ' + localizer(language)({
      tr: '01 PROFİLİN → 02 BÖLGE VE DİL → 03 DM İZNİ',
      en: '01 YOUR PROFILE → 02 REGION & LANGUAGE → 03 DM PERMISSION',
      de: '01 DEIN PROFIL → 02 REGION & SPRACHE → 03 DM-ERLAUBNIS',
      fr: '01 TON PROFIL → 02 RÉGION ET LANGUE → 03 AUTORISATION DES MP',
    })),
    new TextDisplayBuilder().setContent(`# ✨ ${messages.setupWizardTitle}`),
  );
  // The language comes right under the greeting: someone greeted in a language
  // they do not read can switch before reading anything else.
  container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    buildLanguageSelect(`setup:${sessionId}:language`, language, disabled),
  ));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(showHow
      ? `${messages.setupWizardDescription}\n\n> 🛡️ ${messages.setupWizardHowDescription}`
      : messages.setupWizardDescription),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`setup:${sessionId}:start`).setLabel(messages.setupWizardStart).setEmoji('✨').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`setup:${sessionId}:how`).setLabel(messages.setupWizardHow).setEmoji('🛡️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
  );
  finishSetupPanel(container, language);
  return container;
}

export function buildSetupAlreadyCompletedPanel(
  language: Language,
  options: SetupPresentationOptions = {},
): ContainerBuilder {
  const messages = messagesFor(language);
  const container = new ContainerBuilder().setAccentColor(dealioBrand.colors.warning);
  addSetupVisual(container, options);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# 🔒 ${messages.setupWizardAlreadyCompletedTitle}`),
    new TextDisplayBuilder().setContent(messages.setupWizardAlreadyCompletedDescription),
  );
  container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(openPanelButton(language)));
  finishSetupPanel(container, language);
  return container;
}

export function buildSetupConfirmationPanel(
  prepared: PreparedUserConfiguration,
  sessionId: string,
  options: SetupPresentationOptions = {},
  disabled = false,
): ContainerBuilder {
  const messages = messagesFor(prepared.language);
  const profileUrl = `https://steamcommunity.com/profiles/${prepared.steamId64}`;
  const regionSource = options.regionSelectionSource === 'discord-locale'
    ? messages.setupWizardRegionSuggested
    : messages.setupWizardRegionSelected;
  const container = new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ✨ DEALIO · ${setupStep(prepared.language, 2)}\n# 🧭 ${messages.setupWizardConfirmTitle}\n${messages.setupWizardConfirmDescription}`),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  // The account as the user knows it on Steam: the full ID, their name and their avatar on the right.
  const account = new TextDisplayBuilder().setContent([
    `👤 **${messages.setupWizardProfileField}:** [${prepared.steamId64}](${profileUrl})`,
    ...(prepared.profile
      ? [`🏷️ **${messages.setupWizardProfileNameField}:** ${escapeMarkdown(prepared.profile.personaName)}`]
      : []),
  ].join('\n'));
  if (prepared.profile?.avatarUrl) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(account)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(prepared.profile.avatarUrl)
        .setDescription(prepared.profile.personaName.slice(0, 100))));
  } else {
    container.addTextDisplayComponents(account);
  }
  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        `🌍 **${messages.setupWizardRegionField}:** ${countryDisplay(prepared.storeCountryCode, prepared.language)}`,
        `-# ${regionSource}`,
        `🌐 **${messages.setupWizardLanguageField}:** ${languageChoice(prepared.language)}`,
        `🔄 **${messages.setupWizardFrequencyField}:** ${messages.setupWizardFrequency(options.pollIntervalHours ?? defaultPollIntervalHours)}`,
      ].join('\n')),
      new TextDisplayBuilder().setContent(`### 🔔 ${messages.setupWizardConsentField}\n> ${messages.setupWizardConsentValue}`),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`setup:${sessionId}:confirm`).setLabel(messages.setupWizardEnable).setEmoji('🔔').setStyle(ButtonStyle.Success).setDisabled(disabled),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`setup:${sessionId}:region`).setLabel(messages.setupWizardChangeRegion).setEmoji('🌍').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`setup:${sessionId}:cancel`).setLabel(messages.setupWizardCancel).setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      ),
    );
  finishSetupPanel(container, prepared.language);
  return container;
}

export type SetupCompleteStatus = Exclude<InitialWishlistSummaryResult['status'], 'dm-blocked'>
  | 'dm-blocked' | 'dm-no-mutual-guild';

/** How setup ended for the welcome DM; a refused DM keeps its reason, which decides the fix shown. */
export function setupCompleteStatus(summary: InitialWishlistSummaryResult): SetupCompleteStatus {
  return summary.status === 'dm-blocked' && summary.errorCode === 'DISCORD_NO_MUTUAL_GUILD'
    ? 'dm-no-mutual-guild' : summary.status;
}

/** The sentence under "You’re all set!" for each way setup can end. */
export function setupCompleteDetail(status: SetupCompleteStatus, language: Language): string {
  const messages = messagesFor(language);
  return status === 'sent'
    ? messages.setupSummarySent
    : status === 'dm-blocked'
      ? messages.setupWizardDmBlocked
      : status === 'dm-no-mutual-guild'
        ? messages.setupWizardDmNoMutualGuild
        : status === 'dm-transient-failed'
          ? messages.setupWizardDmTransient
          : messages.setupSummaryUnavailable;
}

export function buildSetupCompletePanel(
  prepared: PreparedUserConfiguration,
  status: SetupCompleteStatus,
  options: SetupPresentationOptions = {},
  /** Offers "Open the Dealio panel" in this message while the session lasts. */
  openPanelSessionId?: string,
): ContainerBuilder {
  const messages = messagesFor(prepared.language);
  const detail = setupCompleteDetail(status, prepared.language);
  const container = new ContainerBuilder().setAccentColor(
    status === 'sent' ? dealioBrand.colors.success
      : status === 'dm-blocked' || status === 'dm-no-mutual-guild' ? dealioBrand.colors.danger : dealioBrand.colors.warning,
  );
  addSetupVisual(container, options);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ✨ DEALIO · ${setupStep(prepared.language, 3)}\n# ${status === 'sent' ? '✅' : '⚠️'} ${messages.initialSummaryTitle}`),
    new TextDisplayBuilder().setContent(`${messages.setupSuccess}\n\n${detail}`),
    new TextDisplayBuilder().setContent(
      `${countryDisplay(prepared.storeCountryCode, prepared.language)}　🌐 ${languageNames[prepared.language]}`,
    ),
  );
  if (openPanelSessionId) {
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`setup:${openPanelSessionId}:open`)
        .setLabel(localizer(prepared.language)({
          tr: 'Dealio panelini aç', en: 'Open the Dealio panel', de: 'Dealio-Panel öffnen', fr: 'Ouvrir le panneau Dealio',
        }))
        .setEmoji('🏠').setStyle(ButtonStyle.Primary),
    ));
  }
  finishSetupPanel(container, prepared.language);
  return container;
}

/** "KURULUM · ADIM 2/3": where the user is in the three setup steps. */
function setupStep(language: Language, step: number): string {
  return localizer(language)({
    tr: `KURULUM · ADIM ${step}/3`,
    en: `SETUP · STEP ${step}/3`,
    de: `EINRICHTUNG · SCHRITT ${step}/3`,
    fr: `CONFIGURATION · ÉTAPE ${step}/3`,
  });
}

/** Every language by its own name, so anyone can find theirs; setup and Settings share it. */
export function buildLanguageSelect(customId: string, selected: Language, disabled = false): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setDisabled(disabled)
    .setPlaceholder(languageChoice(selected))
    .addOptions(languages.map((language) => ({
      label: languageNames[language],
      value: language,
      emoji: { name: languageFlags[language] },
      default: language === selected,
    })));
}

function addSetupVisual(container: ContainerBuilder, options: SetupPresentationOptions): void {
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
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(options.avatarUrl).setDescription('Dealio')),
    );
  }
}

function finishSetupPanel(container: ContainerBuilder, language: Language): void {
  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(dealioFooter(language)));
  assertComponentsV2Limit([container]);
}

export function parseSetupAction(customId: string, sessionId: string): SetupAction | null {
  const prefix = `setup:${sessionId}:`;
  if (!customId.startsWith(prefix)) {
    return null;
  }
  const action = customId.slice(prefix.length);
  return ['start', 'how', 'confirm', 'language', 'region', 'cancel', 'open'].includes(action)
    ? action as SetupAction
    : null;
}

export function canUseSetupComponent(
  customId: string,
  componentUserId: string,
  ownerUserId: string,
  sessionId: string,
): boolean {
  return componentUserId === ownerUserId && parseSetupAction(customId, sessionId) !== null;
}

export function buildSetupCountrySelectOptions(
  language: Language,
  selectedCountry: StoreCountryCode,
): Array<{ readonly label: string; readonly value: string; readonly default: boolean; readonly emoji: { readonly name: string } }> {
  const commonCountries = commonStoreCountries;
  const collator = new Intl.Collator(languageLocale[language], {
    sensitivity: 'base',
  });
  const countries = [...new Set([selectedCountry, ...commonCountries])]
    .slice(0, 24)
    .map((code) => ({ code, name: storeCountryName(code, language) }))
    .sort((left, right) => collator.compare(left.name, right.name) || left.code.localeCompare(right.code))
    .map(({ code, name }) => ({
      label: `${name} (${code})`.slice(0, 100),
      value: code,
      default: code === selectedCountry,
      emoji: { name: flagEmoji(code) },
    }));
  return [...countries, {
    label: uiCopy(language).regionOther,
    value: 'OTHER',
    default: false,
    emoji: { name: '🔎' },
  }];
}
