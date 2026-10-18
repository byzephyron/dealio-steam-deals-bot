import { MessageFlags, Routes, type Client, type ContainerBuilder } from 'discord.js';
import type { Language } from '../domain/user-config.js';
import type {
  WishlistHiddenNoticeKind,
  WishlistHiddenSender,
} from '../application/wishlist-hidden-notice-service.js';
import { localizer } from './i18n.js';
import { buildNoticePanel, openPanelNoticeButton } from './ui/components-v2.js';
import { steamPrivacyUrl } from './ui/design.js';

/**
 * Setup stopped because Steam hides the wishlist, or a wishlist Dealio already
 * follows became private. Both name the same two Steam settings.
 */
export function buildWishlistHiddenDm(language: Language, kind: WishlistHiddenNoticeKind): ContainerBuilder {
  const t = localizer(language);
  const fix = t({
    tr: `Çözümü çok kolay: [Steam gizlilik ayarlarında](${steamPrivacyUrl}) **Profilim** ve **Oyun ayrıntıları** seçeneklerini **Herkese Açık** yap.`,
    en: `The fix is quick: in [Steam’s privacy settings](${steamPrivacyUrl}), set **My profile** and **Game details** to **Public**.`,
    de: `Das ist schnell behoben: Stell in den [Steam-Privatsphäre-Einstellungen](${steamPrivacyUrl}) **Mein Profil** und **Spieldetails** auf **Öffentlich**.`,
    fr: `C’est vite réglé : dans les [paramètres de confidentialité Steam](${steamPrivacyUrl}), mets **Mon profil** et **Détails des jeux** en **Public**.`,
  });
  if (kind === 'setup') {
    return buildNoticePanel(language, 'warning',
      t({
        tr: 'Steam wishlist’ini göremiyorum 😞',
        en: 'I can’t see your Steam wishlist 😞',
        de: 'Ich kann deine Steam-Wunschliste nicht sehen 😞',
        fr: 'Je ne vois pas ta liste de souhaits Steam 😞',
      }),
      [
        t({
          tr: 'Selam! Kurulumu bitiremedik çünkü Steam profilin gizli görünüyor, bu yüzden istek listene bakamıyorum.',
          en: 'Hi! We couldn’t finish setup because your Steam profile looks private, so I can’t look at your wishlist.',
          de: 'Hallo! Die Einrichtung ist nicht fertig geworden, weil dein Steam-Profil privat aussieht. Deshalb kann ich deine Wunschliste nicht ansehen.',
          fr: 'Salut ! On n’a pas pu finir la configuration parce que ton profil Steam semble privé, donc je ne peux pas voir ta liste de souhaits.',
        }),
        fix,
        t({
          tr: 'Sonra aşağıdaki butona dokunman yeter, kaldığımız yerden devam ederiz 💙',
          en: 'Then tap the button below and we’ll pick up where we left off 💙',
          de: 'Tipp danach auf den Button unten, dann machen wir dort weiter 💙',
          fr: 'Ensuite, appuie sur le bouton ci-dessous et on reprend là où on s’était arrêtés 💙',
        }),
      ].join('\n\n'),
      { button: openPanelNoticeButton(language, true) });
  }
  return buildNoticePanel(language, 'warning',
    t({
      tr: 'Steam wishlist’ini göremiyorum 😞',
      en: 'I can’t see your Steam wishlist 😞',
      de: 'Ich kann deine Steam-Wunschliste nicht sehen 😞',
      fr: 'Je ne vois pas ta liste de souhaits Steam 😞',
    }),
    [
      t({
        tr: 'Selam! İstek listene bakmaya geldim ama Steam profilin gizli görünüyor, o yüzden indirimleri sana haber veremiyorum.',
        en: 'Hi! I came to check your wishlist, but your Steam profile looks private, so I can’t tell you about deals.',
        de: 'Hallo! Ich wollte deine Wunschliste prüfen, aber dein Steam-Profil sieht privat aus. So kann ich dir keine Angebote melden.',
        fr: 'Salut ! Je suis venu vérifier ta liste de souhaits, mais ton profil Steam semble privé, donc je ne peux pas te prévenir des promos.',
      }),
      fix,
      t({
        tr: 'Gerisini ben hallederim, bir sonraki kontrolde kaldığım yerden devam ederim 💙',
        en: 'I’ll take care of the rest and pick up where I left off at the next check 💙',
        de: 'Den Rest übernehme ich und mache bei der nächsten Prüfung weiter 💙',
        fr: 'Je m’occupe du reste et je reprends à la prochaine vérification 💙',
      }),
      '-# ' + t({
        tr: 'Bu hatırlatmayı yalnızca bir kez gönderiyorum.',
        en: 'I send this reminder only once.',
        de: 'Diese Erinnerung schicke ich nur einmal.',
        fr: 'Je n’envoie ce rappel qu’une seule fois.',
      }),
    ].join('\n\n'),
    { button: openPanelNoticeButton(language) });
}

/** Sends the hidden-wishlist DM. Every request has a deadline. */
export class DiscordWishlistHiddenSender implements WishlistHiddenSender {
  public constructor(private readonly client: Pick<Client, 'rest'>, private readonly timeoutMs = 20_000) {}

  public async send(discordUserId: string, language: Language, kind: WishlistHiddenNoticeKind): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const channel = await this.client.rest.post(Routes.userChannels(), {
      body: { recipient_id: discordUserId }, signal,
    }) as { id?: unknown };
    if (typeof channel.id !== 'string' || !/^\d+$/.test(channel.id)) throw new Error('Discord returned an invalid DM channel');
    const message = await this.client.rest.post(Routes.channelMessages(channel.id), {
      body: {
        flags: MessageFlags.IsComponentsV2,
        components: [buildWishlistHiddenDm(language, kind).toJSON()],
        allowed_mentions: { parse: [] },
      },
      signal,
    }) as { id?: unknown };
    if (typeof message.id !== 'string' || !/^\d+$/.test(message.id)) throw new Error('Discord returned an invalid message');
  }
}
