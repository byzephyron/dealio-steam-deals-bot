import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  supportDescriptionMaxLength, supportScreenshotLimit, supportTopics, ticketNumber,
  type SupportTicket, type SupportTopic,
} from '../../domain/support-ticket.js';
import { languageLocale, type Language } from '../../domain/user-config.js';
import { localizer, type Localized } from '../i18n.js';
import { dealioBrand } from '../ui/brand.js';
import { assertComponentsV2Limit, buildNoticePanel, dealioFooter } from '../ui/components-v2.js';

export const supportOpenCustomId = 'support:open';
export const supportSubmitCustomId = 'support:submit';
export const supportClosePrefix = 'support:close:';
const topicFieldId = 'topic';
const descriptionFieldId = 'description';
const screenshotsFieldId = 'screenshots';
export const supportModalFields = { topic: topicFieldId, description: descriptionFieldId, screenshots: screenshotsFieldId } as const;

export const supportHelpUrl = 'https://byzephyron.github.io/dealio-public-pages/help.html';

export const supportTopicNames: Record<SupportTopic, { readonly emoji: string; readonly label: Localized }> = {
  setup: { emoji: '⚙️', label: { tr: 'Kurulum ve Steam profili', en: 'Setup & Steam profile', de: 'Einrichtung & Steam-Profil', fr: 'Configuration et profil Steam' } },
  alerts: { emoji: '🔔', label: { tr: 'Bildirimler ve fiyatlar', en: 'Alerts & prices', de: 'Preisalarme & Preise', fr: 'Alertes et prix' } },
  bug: { emoji: '🐞', label: { tr: 'Hata bildirimi', en: 'Bug report', de: 'Fehlermeldung', fr: 'Signaler un bug' } },
  account: { emoji: '🔒', label: { tr: 'Hesap ve veriler', en: 'Account & data', de: 'Konto & Daten', fr: 'Compte et données' } },
  other: { emoji: '💬', label: { tr: 'Başka bir konu', en: 'Something else', de: 'Etwas anderes', fr: 'Autre chose' } },
};

const topicDescriptions: Record<SupportTopic, Localized> = {
  setup: {
    tr: 'Profil bağlama, bölge, dil, gizlilik ayarları',
    en: 'Linking your profile, region, language, privacy settings',
    de: 'Profil verknüpfen, Region, Sprache, Privatsphäre',
    fr: 'Lier ton profil, région, langue, confidentialité',
  },
  alerts: {
    tr: 'Gelmeyen DM, hedef fiyat, indirim kuralları',
    en: 'Missing DMs, target prices, discount rules',
    de: 'Fehlende DMs, Zielpreise, Rabattregeln',
    fr: 'DM manquants, prix cibles, règles de remise',
  },
  bug: {
    tr: 'Beklendiği gibi çalışmayan bir şey',
    en: 'Something that doesn’t work as it should',
    de: 'Etwas funktioniert nicht wie erwartet',
    fr: 'Quelque chose ne marche pas comme prévu',
  },
  account: {
    tr: 'Verilerin, silme, engellenen erişim',
    en: 'Your data, deletion, blocked access',
    de: 'Deine Daten, Löschung, gesperrter Zugang',
    fr: 'Tes données, suppression, accès bloqué',
  },
  other: {
    tr: 'Öneri, soru ya da başka bir şey',
    en: 'Ideas, questions or anything else',
    de: 'Ideen, Fragen oder sonst etwas',
    fr: 'Idées, questions ou autre',
  },
};

/** "🔔 Alerts & prices". */
export function topicDisplay(topic: SupportTopic, language: Language): string {
  return `${supportTopicNames[topic].emoji} ${supportTopicNames[topic].label[language]}`;
}

function kicker(language: Language): string {
  const label = localizer(language)({ tr: 'Destek', en: 'Support', de: 'Support', fr: 'Assistance' });
  return `-# 🎫 DEALIO · ${label.toLocaleUpperCase(languageLocale[language])}`;
}

function footer(container: ContainerBuilder, language: Language): ContainerBuilder {
  return container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(dealioFooter(language)));
}

const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** The message in the support server's ticket channel; its button opens the ticket form. */
export function buildSupportPanel(language: Language, options: { readonly faqChannelId?: string } = {}): ContainerBuilder {
  const t = localizer(language);
  const faq = options.faqChannelId ? `<#${options.faqChannelId}>` : t({ tr: 'SSS', en: 'the FAQ', de: 'den FAQ', fr: 'la FAQ' });
  const topics = supportTopics.map((topic) => `${supportTopicNames[topic].emoji} **${supportTopicNames[topic].label[language]}**`
    + ` · ${topicDescriptions[topic][language]}`).join('\n');
  const container = new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.primary)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${kicker(language)}\n# ${t({
        tr: 'Yardım mı lazım?', en: 'Need a hand?', de: 'Brauchst du Hilfe?', fr: 'Besoin d’un coup de main ?',
      })}\n${t({
        tr: 'Bir ticket aç, Dealio ekibi sana özel bir thread’de cevap versin. O thread’i yalnızca sen ve ekip görür.',
        en: 'Open a ticket and the Dealio team will answer you in a private thread. Only you and the team can see it.',
        de: 'Öffne ein Ticket, und das Dealio-Team antwortet dir in einem privaten Thread. Nur du und das Team sehen ihn.',
        fr: 'Ouvre un ticket et l’équipe Dealio te répondra dans un fil privé. Seuls toi et l’équipe pouvez le voir.',
      })}`),
      new TextDisplayBuilder().setContent(`### ${t({
        tr: 'Ne hakkında yazabilirsin', en: 'What we can help with', de: 'Wobei wir helfen', fr: 'Ce qu’on peut faire pour toi',
      })}\n${topics}`),
      new TextDisplayBuilder().setContent(`### ${t({ tr: 'Bilmekte fayda var', en: 'Good to know', de: 'Gut zu wissen', fr: 'Bon à savoir' })}\n${[
        t({
          tr: `Çoğu sorunun cevabı ${faq} kanalında; önce bir göz atmak isteyebilirsin.`,
          en: `Most answers are already in ${faq}, so it’s worth a quick look first.`,
          de: `Die meisten Antworten stehen schon in ${faq}; ein kurzer Blick lohnt sich.`,
          fr: `La plupart des réponses sont déjà dans ${faq} : jette d’abord un œil.`,
        }),
        t({
          tr: 'Aynı anda bir açık ticket’ın olabilir. Cevap gelince Discord sana bildirim gönderir.',
          en: 'You can have one open ticket at a time. Discord notifies you when we reply.',
          de: 'Du kannst ein offenes Ticket gleichzeitig haben. Discord benachrichtigt dich bei einer Antwort.',
          fr: 'Tu peux avoir un ticket ouvert à la fois. Discord te prévient quand on répond.',
        }),
        t({
          tr: 'Steam şifreni ya da Discord token’ını asla istemeyiz; kimseyle paylaşma.',
          en: 'We never ask for your Steam password or Discord token. Don’t share them with anyone.',
          de: 'Wir fragen nie nach deinem Steam-Passwort oder Discord-Token. Gib sie niemandem weiter.',
          fr: 'On ne demande jamais ton mot de passe Steam ni ton token Discord. Ne les partage avec personne.',
        }),
      ].map((line) => `• ${line}`).join('\n')}`),
    )
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(supportOpenCustomId).setStyle(ButtonStyle.Primary).setEmoji('🎫')
        .setLabel(t({ tr: 'Ticket aç', en: 'Open a ticket', de: 'Ticket öffnen', fr: 'Ouvrir un ticket' })),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(supportHelpUrl).setEmoji('📖')
        .setLabel(t({ tr: 'Yardım sayfası', en: 'Help center', de: 'Hilfeseite', fr: 'Page d’aide' })),
    ));
  footer(container, language);
  assertComponentsV2Limit([container]);
  return container;
}

/** The form behind "Open a ticket": a topic and a description. */
export function buildSupportModal(language: Language): ModalBuilder {
  const t = localizer(language);
  return new ModalBuilder()
    .setCustomId(supportSubmitCustomId)
    .setTitle(t({ tr: 'Destek ticket’ı aç', en: 'Open a support ticket', de: 'Support-Ticket öffnen', fr: 'Ouvrir un ticket' }))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(t({ tr: 'Konu', en: 'Topic', de: 'Thema', fr: 'Sujet' }))
        .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId(topicFieldId).setRequired(true)
          .setMinValues(1).setMaxValues(1)
          .addOptions(supportTopics.map((topic) => ({
            label: supportTopicNames[topic].label[language],
            value: topic,
            emoji: supportTopicNames[topic].emoji,
            description: topicDescriptions[topic][language],
          })))),
      new LabelBuilder()
        .setLabel(t({ tr: 'Ne oldu?', en: 'What’s going on?', de: 'Was ist los?', fr: 'Que se passe-t-il ?' }))
        .setDescription(t({
          tr: 'Ne kadar ayrıntı, o kadar hızlı yardım.',
          en: 'The more detail, the faster we can help.',
          de: 'Je mehr Details, desto schneller können wir helfen.',
          fr: 'Plus il y a de détails, plus on t’aide vite.',
        }))
        .setTextInputComponent(new TextInputBuilder().setCustomId(descriptionFieldId).setStyle(TextInputStyle.Paragraph)
          .setRequired(true).setMinLength(10).setMaxLength(supportDescriptionMaxLength)
          .setPlaceholder(t({
            tr: 'Örn. Hades için hedef fiyat koydum ama indirime girince DM gelmedi.',
            en: 'E.g. I set a target price for Hades but got no DM when it dropped.',
            de: 'Z. B. Ich habe einen Zielpreis für Hades gesetzt, aber keine DM bekommen.',
            fr: 'Ex. : J’ai fixé un prix cible pour Hades mais je n’ai reçu aucun DM.',
          }))),
      new LabelBuilder()
        .setLabel(t({ tr: 'Ekran görüntüleri (isteğe bağlı)', en: 'Screenshots (optional)', de: 'Screenshots (optional)', fr: 'Captures d’écran (facultatif)' }))
        .setDescription(t({
          tr: `En fazla ${supportScreenshotLimit} görsel. Kişisel bilgileri kapatmayı unutma.`,
          en: `Up to ${supportScreenshotLimit} images. Remember to hide personal details.`,
          de: `Bis zu ${supportScreenshotLimit} Bilder. Verdecke persönliche Angaben.`,
          fr: `Jusqu’à ${supportScreenshotLimit} images. Pense à masquer tes infos personnelles.`,
        }))
        .setFileUploadComponent(new FileUploadBuilder().setCustomId(screenshotsFieldId).setRequired(false)
          .setMinValues(0).setMaxValues(supportScreenshotLimit)),
    );
}

/** The thread's name, which the team sees in the channel list. */
export function ticketThreadName(ticket: SupportTicket, userName: string): string {
  return `${ticketNumber(ticket.ticketId)} · ${supportTopicNames[ticket.topic].label.en} · ${userName}`.slice(0, 100);
}

/** The first message in a ticket's thread: who asked what, and the close button. */
export function buildTicketHeader(
  ticket: SupportTicket,
  description: string,
  language: Language,
  screenshotNames: readonly string[] = [],
): ContainerBuilder {
  const t = localizer(language);
  const quoted = description.trim().split('\n').map((line) => `> ${line}`).join('\n');
  const opened = t({
    tr: `<@${ticket.discordUserId}> açtı · <t:${unix(ticket.openedAt)}:R>`,
    en: `opened by <@${ticket.discordUserId}> · <t:${unix(ticket.openedAt)}:R>`,
    de: `geöffnet von <@${ticket.discordUserId}> · <t:${unix(ticket.openedAt)}:R>`,
    fr: `ouvert par <@${ticket.discordUserId}> · <t:${unix(ticket.openedAt)}:R>`,
  });
  const container = new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${kicker(language)}\n# Ticket ${ticketNumber(ticket.ticketId)}\n`
        + `${topicDisplay(ticket.topic, language)} · ${opened}`),
      new TextDisplayBuilder().setContent(quoted),
    );
  if (screenshotNames.length > 0) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      ...screenshotNames.map((name) => new MediaGalleryItemBuilder().setURL(`attachment://${name}`)),
    ));
  }
  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(t({
      tr: 'Teşekkürler! Dealio ekibi buradan cevap verecek, Discord sana bildirim gönderir. Ekran görüntüsü ve sorunu tekrar oluşturma adımları çok işe yarar.\n-# Steam şifreni ya da Discord token’ını asla istemeyiz; burada da paylaşma.',
      en: 'Thanks! The Dealio team will reply right here, and Discord will notify you. Screenshots and steps to reproduce help a lot.\n-# We will never ask for your Steam password or Discord token, so don’t share them here either.',
      de: 'Danke! Das Dealio-Team antwortet direkt hier, und Discord benachrichtigt dich. Screenshots und Schritte zum Nachstellen helfen sehr.\n-# Wir fragen nie nach deinem Steam-Passwort oder Discord-Token; teile sie auch hier nicht.',
      fr: 'Merci ! L’équipe Dealio répondra ici même et Discord te préviendra. Des captures d’écran et les étapes pour reproduire aident beaucoup.\n-# On ne demandera jamais ton mot de passe Steam ni ton token Discord : ne les partage pas ici non plus.',
    })))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${supportClosePrefix}${ticket.ticketId}`).setStyle(ButtonStyle.Secondary).setEmoji('🔒')
        .setLabel(t({ tr: 'Ticket’ı kapat', en: 'Close ticket', de: 'Ticket schließen', fr: 'Fermer le ticket' })),
    ));
  footer(container, language);
  assertComponentsV2Limit([container]);
  return container;
}

/** Posted in the thread just before it is locked. */
export function buildTicketClosedNotice(
  ticket: SupportTicket,
  closedByUserId: string,
  language: Language,
): ContainerBuilder {
  const t = localizer(language);
  const channel = `<#${ticket.channelId}>`;
  return buildNoticePanel(language, 'info',
    t({
      tr: `Ticket ${ticketNumber(ticket.ticketId)} kapandı`,
      en: `Ticket ${ticketNumber(ticket.ticketId)} is closed`,
      de: `Ticket ${ticketNumber(ticket.ticketId)} ist geschlossen`,
      fr: `Le ticket ${ticketNumber(ticket.ticketId)} est fermé`,
    }),
    t({
      tr: `<@${closedByUserId}> kapattı. Yazdığın için teşekkürler! Yine yardım lazım olursa ${channel} kanalında yeni bir ticket açabilirsin.`,
      en: `Closed by <@${closedByUserId}>. Thanks for reaching out! If you need anything else, open a new ticket in ${channel}.`,
      de: `Geschlossen von <@${closedByUserId}>. Danke für deine Nachricht! Brauchst du noch etwas, öffne ein neues Ticket in ${channel}.`,
      fr: `Fermé par <@${closedByUserId}>. Merci de nous avoir écrit ! Besoin d’autre chose ? Ouvre un nouveau ticket dans ${channel}.`,
    }));
}

/** The team's log line for a new ticket; it mentions the team role. */
export function buildTicketOpenedLog(ticket: SupportTicket, userName: string, threadId: string, teamRoleId: string): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.primary)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `🎫 **Ticket ${ticketNumber(ticket.ticketId)}** · ${topicDisplay(ticket.topic, 'en')}\n`
      + `<@${ticket.discordUserId}> (\`${userName.replace(/`/g, '')}\`) · <#${threadId}> · <t:${unix(ticket.openedAt)}:R>\n`
      + `-# <@&${teamRoleId}>`,
    ));
  assertComponentsV2Limit([container]);
  return container;
}

/** The team's log line for a closed ticket. */
export function buildTicketClosedLog(ticket: SupportTicket, closedByUserId: string): ContainerBuilder {
  const by = ticket.closedBy === 'user' ? 'the user' : ticket.closedBy === 'staff' ? 'the team' : 'Discord';
  const container = new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.muted)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `🔒 **Ticket ${ticketNumber(ticket.ticketId)}** closed by <@${closedByUserId}> (${by})`
      + `${ticket.threadId ? ` · <#${ticket.threadId}>` : ''} · opened <t:${unix(ticket.openedAt)}:R>`,
    ));
  assertComponentsV2Limit([container]);
  return container;
}
