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
import { countryDisplay, flagEmoji, openPanelButton, steamPrivacyUrl } from './ui/design.js';

export interface SetupPresentationOptions {
  readonly bannerUrl?: string;
  readonly avatarUrl?: string;
  readonly pollIntervalHours?: number;
  readonly regionSelectionSource?: 'discord-locale' | 'user';
  /** Setup stopped because Steam hides the wishlist: also tell the user by DM. Never awaited. */
  readonly onWishlistHidden?: (discordUserId: string, language: Language) => void;
}

export type SetupAction = 'start' | 'how' | 'confirm' | 'language' | 'region' | 'cancel' | 'open' | 'retry';

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

/**
 * Setup stopped because Steam hides the wishlist. Instead of a dead end that makes
 * the user fill in the form again, it lists the two settings to change, links to
 * them and retries with the profile and region already entered ("I've made it
 * public, try again"). stillHidden: a retry found it hidden again; Steam can take a
 * minute or two to show a privacy change.
 */
export function buildSetupWishlistHiddenPanel(
  language: Language,
  sessionId: string,
  stillHidden = false,
  disabled = false,
): ContainerBuilder {
  const t = localizer(language);
  const steps = t({
    tr: `1. [Steam gizlilik ayarlarını](${steamPrivacyUrl}) aç (aşağıdaki butonla da açabilirsin)\n2. **Profilim** → **Herkese Açık**\n3. **Oyun ayrıntıları** → **Herkese Açık** (istek listen bu ayara bağlı)\n4. Sonra buraya dönüp **Açtım, tekrar dene**’ye dokun. Bilgilerini hatırlıyorum, formu baştan doldurman gerekmiyor 💙`,
    en: `1. Open [Steam’s privacy settings](${steamPrivacyUrl}) (or use the button below)\n2. **My profile** → **Public**\n3. **Game details** → **Public** (your wishlist follows this one)\n4. Then come back and tap **I made it public, try again**. I remember what you entered, so no need to fill in the form again 💙`,
    de: `1. Öffne die [Steam-Privatsphäre-Einstellungen](${steamPrivacyUrl}) (oder nimm den Button unten)\n2. **Mein Profil** → **Öffentlich**\n3. **Spieldetails** → **Öffentlich** (deine Wunschliste folgt dieser Einstellung)\n4. Komm dann zurück und tipp auf **Erledigt, noch mal prüfen**. Ich habe mir deine Angaben gemerkt, du musst nichts neu ausfüllen 💙`,
    fr: `1. Ouvre les [paramètres de confidentialité Steam](${steamPrivacyUrl}) (ou utilise le bouton ci-dessous)\n2. **Mon profil** → **Public**\n3. **Détails des jeux** → **Public** (ta liste de souhaits suit ce réglage)\n4. Puis reviens et appuie sur **C’est fait, réessayer**. Je me souviens de ce que tu as saisi, pas besoin de tout remplir à nouveau 💙`,
  });
  const intro = stillHidden
    ? t({
      tr: 'Hmm, hâlâ gizli görünüyor 🤔 Dert etme, Steam’in değişikliği fark etmesi bazen bir iki dakika sürüyor. Ayarları kaydettiysen biraz bekleyip tekrar dokun, ben buradayım.',
      en: 'Hmm, it still looks hidden 🤔 Don’t worry, Steam sometimes takes a minute or two to notice the change. If you saved the settings, give it a moment and tap again; I’m right here.',
      de: 'Hmm, sie wirkt noch verborgen 🤔 Keine Sorge, Steam braucht manchmal ein, zwei Minuten, bis es die Änderung bemerkt. Wenn du gespeichert hast, warte kurz und tipp noch mal; ich bin da.',
      fr: 'Hmm, elle semble encore masquée 🤔 Pas d’inquiétude, Steam met parfois une minute ou deux à voir le changement. Si tu as enregistré, attends un peu et réessaie ; je suis là.',
    })
    : t({
      tr: 'Selam! Profilini buldum ama Steam istek listeni gizli tutuyor, o yüzden içine bakamıyorum. Çözümü çok kolay, iki ayar yeter:',
      en: 'Hi! I found your profile, but Steam keeps your wishlist hidden, so I can’t look inside. The fix is quick, just two settings:',
      de: 'Hallo! Ich habe dein Profil gefunden, aber Steam hält deine Wunschliste verborgen, deshalb kann ich nicht hineinschauen. Das ist schnell behoben, zwei Einstellungen reichen:',
      fr: 'Salut ! J’ai trouvé ton profil, mais Steam garde ta liste de souhaits masquée, donc je ne peux pas la voir. C’est vite réglé, deux réglages suffisent :',
    });
  const reassurance = t({
    tr: '-# Merak etme: yalnızca herkese açık istek listene bakıyorum, Steam şifreni ya da girişini asla istemem.',
    en: '-# No worries: I only look at your public wishlist and never ask for your Steam password or sign-in.',
    de: '-# Keine Sorge: Ich schaue nur auf deine öffentliche Wunschliste und frage nie nach deinem Steam-Passwort oder Login.',
    fr: '-# Pas d’inquiétude : je regarde seulement ta liste de souhaits publique et je ne demande jamais ton mot de passe ni ta connexion Steam.',
  });
  const container = new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.warning)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ✨ DEALIO · ${setupStep(language, 1)}\n# ${t({
        tr: 'Steam wishlist’ini göremiyorum 😞',
        en: 'I can’t see your Steam wishlist 😞',
        de: 'Ich kann deine Steam-Wunschliste nicht sehen 😞',
        fr: 'Je ne vois pas ta liste de souhaits Steam 😞',
      })}\n${intro}`),
      new TextDisplayBuilder().setContent(`${steps}\n${reassurance}`),
    )
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`setup:${sessionId}:retry`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔄')
        .setLabel(t({ tr: 'Açtım, tekrar dene', en: 'I made it public, try again', de: 'Erledigt, noch mal prüfen', fr: 'C’est fait, réessayer' }))
        .setDisabled(disabled),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(steamPrivacyUrl)
        .setEmoji('🔗')
        .setLabel(t({ tr: 'Steam gizlilik ayarları', en: 'Steam privacy settings', de: 'Steam-Privatsphäre', fr: 'Confidentialité Steam' })),
      new ButtonBuilder()
        .setCustomId(`setup:${sessionId}:start`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✏️')
        .setLabel(t({ tr: 'Başka profil gir', en: 'Use another profile', de: 'Anderes Profil', fr: 'Autre profil' }))
        .setDisabled(disabled),
    ));
  finishSetupPanel(container, language);
  return container;
}

export function parseSetupAction(customId: string, sessionId: string): SetupAction | null {
  const prefix = `setup:${sessionId}:`;
  if (!customId.startsWith(prefix)) {
    return null;
  }
  const action = customId.slice(prefix.length);
  return ['start', 'how', 'confirm', 'language', 'region', 'cancel', 'open', 'retry'].includes(action)
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
