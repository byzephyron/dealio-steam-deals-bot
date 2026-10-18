import type { Language } from '../domain/user-config.js';

/** What one manual check found, for the sentence above its numbers. */
export interface CheckSummary {
  readonly checked: number;
  /** New sales or crossed rules found by this check. */
  readonly found: number;
  readonly sent: number;
  readonly deliveryFailed: number;
  /** Games whose price Steam did not confirm this time. */
  readonly unconfirmed: number;
}

interface MessageCatalog {
  readonly setupSuccess: string;
  readonly setupSummarySent: string;
  readonly setupSummaryUnavailable: string;
  readonly setupWizardTitle: string;
  readonly setupWizardDescription: string;
  readonly setupWizardStart: string;
  readonly setupWizardHow: string;
  readonly setupWizardHowDescription: string;
  readonly setupWizardModalTitle: string;
  readonly setupWizardProfileLabel: string;
  readonly setupWizardProfilePlaceholder: string;
  readonly setupWizardCountryLabel: string;
  readonly setupWizardConfirmTitle: string;
  readonly setupWizardConfirmDescription: string;
  readonly setupWizardProfileField: string;
  readonly setupWizardProfileNameField: string;
  readonly setupWizardRegionField: string;
  readonly setupWizardRegionSuggested: string;
  readonly setupWizardRegionSelected: string;
  readonly setupWizardChangeRegion: string;
  readonly setupWizardCountryPickerPlaceholder: string;
  readonly setupWizardLanguageField: string;
  readonly setupWizardFrequencyField: string;
  readonly setupWizardConsentField: string;
  readonly setupWizardConsentValue: string;
  readonly setupWizardEnable: string;
  readonly setupWizardCancel: string;
  readonly setupWizardCancelled: string;
  readonly setupWizardPreparing: string;
  readonly setupWizardDmBlocked: string;
  readonly setupWizardDmNoMutualGuild: string;
  readonly setupWizardDmTransient: string;
  readonly setupWizardAlreadyCompletedTitle: string;
  readonly setupWizardAlreadyCompletedDescription: string;
  readonly setupWizardFrequency: (hours: number) => string;
  readonly initialSummaryTitle: string;
  readonly initialSummaryDescription: (saleCount: number, incompleteCount?: number) => string;
  readonly initialSummaryIncomplete: string;
  readonly initialSummaryNoSales: string;
  readonly invalidSetup: string;
  readonly invalidSteamProfile: string;
  readonly invalidStoreCountry: string;
  readonly vanityProfileNotFound: string;
  readonly vanityResolutionUnavailable: string;
  readonly steamWebApiKeyMissing: string;
  readonly notConfigured: string;
  readonly unavailable: string;
  readonly wishlistInaccessible: string;
  readonly setupValidationUnavailable: string;
  readonly alreadyRunning: string;
  readonly cooldown: (retryAfterSeconds: number) => string;
  readonly failed: string;
  readonly checkCompleted: (summary: CheckSummary) => string;
  readonly checkCompletedNotificationsDisabled: (summary: CheckSummary) => string;
  readonly statusNotConfigured: string;
  readonly statusDashboardUnavailable: string;
  readonly statusMinimumDiscountModalTitle: string;
  readonly statusMinimumDiscountInputLabel: string;
  readonly statusMinimumDiscountPlaceholder: string;
  readonly discountThresholdInvalid: string;
  readonly testNotificationFailed: string;
  readonly testNotificationCooldown: (retryAfterSeconds: number) => string;
  readonly testNotificationDescription: string;
  readonly testNotificationExampleDescription: string;
  readonly openSteamStore: string;
  readonly regionSaved: (country: string) => string;
  readonly regionUnchanged: (country: string) => string;
  readonly wishlistFailedItems: (count: number) => string;
}

const catalog: Record<Language, MessageCatalog> = {
  tr: {
    setupSuccess: 'Steam profilini buldum, istek listeni artık ben takip ediyorum. 🎉',
    setupSummarySent: 'İstek listenin ilk özetini sana DM olarak gönderdim.',
    setupSummaryUnavailable: 'Her şey hazır, ama Steam fiyatlarına şu an ulaşamadığım için ilk özeti gönderemedim. Takibe normal şekilde devam ediyorum.',
    setupWizardTitle: 'Dealio\'ya hoş geldin',
    setupWizardDescription: 'Steam istek listeni senin yerine takip eden kişisel indirim asistanınım.\n\n'
      + '🔔 **İndirim başlayınca DM atarım** · kendi Steam bölgenin fiyatıyla\n'
      + '🎯 **Kuralları sen koyarsın** · her oyun için indirim oranı ya da hedef fiyat\n'
      + '📈 **Gerçekten iyi bir fiyat mı, görürsün** · Steam\'deki en düşük fiyatla karşılaştırırım\n'
      + '🌙 **Rahatsız etmem** · sessiz saatler ya da günlük özet\n\n'
      + '-# Kurulum yaklaşık bir dakika sürer. Şifreni ya da Steam girişini asla istemem.',
    setupWizardStart: 'Hadi başlayalım',
    setupWizardHow: 'Nasıl çalışıyor?',
    setupWizardHowDescription: 'Yalnızca herkese açık Steam istek listeni okurum. İlk taramada güncel fiyatları not alırım; şu an süren indirimler için DM atmam. Sonrasında yeni bir indirim başladığında sana haber veririm. Şifre ya da Steam oturumu gerekmez.',
    setupWizardModalTitle: 'Dealio kurulumu',
    setupWizardProfileLabel: 'Steam profilin',
    setupWizardProfilePlaceholder: 'Profil bağlantın, SteamID64 ya da özel URL adın',
    setupWizardCountryLabel: 'Steam mağazanın ülkesi',
    setupWizardConfirmTitle: 'Her şey doğru mu?',
    setupWizardConfirmDescription: 'Bir göz at; onayladığında indirim DM\'lerin açılır.',
    setupWizardProfileField: 'Steam hesabı',
    setupWizardProfileNameField: 'Steam adın',
    setupWizardRegionField: 'Mağaza bölgesi',
    setupWizardRegionSuggested: 'Discord dilinden tahmin ettim; yanlışsa aşağıdan değiştirebilirsin.',
    setupWizardRegionSelected: 'Senin seçtiğin bölge.',
    setupWizardChangeRegion: 'Bölgeyi değiştir',
    setupWizardCountryPickerPlaceholder: 'Steam mağazanın ülkesini seç',
    setupWizardLanguageField: 'Dil',
    setupWizardFrequencyField: 'Kontrol sıklığı',
    setupWizardConsentField: 'DM izni',
    setupWizardConsentValue: 'Onaylarsan, istek listendeki bir oyun indirime girdiğinde sana DM atabilirim.',
    setupWizardEnable: 'Her şey doğru, bildirimleri aç',
    setupWizardCancel: 'Vazgeç',
    setupWizardCancelled: 'Kurulumu iptal ettim, hiçbir şeyi değiştirmedim. Fikrin değişirse /dealio ile yeniden başlayabilirsin.',
    setupWizardPreparing: 'Steam profiline ve istek listene bakıyorum…',
    setupWizardDmBlocked: 'Kurulumu kaydettim ama Discord sana DM atmama izin vermiyor. Bildirimleri şimdilik durdurdum; gizlilik ayarını düzelttikten sonra /dealio → ⚙️ Ayarlar\'dan yeniden açabilirsin.',
    setupWizardDmNoMutualGuild: 'Kurulumu kaydettim ama ortak bir sunucumuz olmadığı için Discord sana DM atmama izin vermiyor. Bildirimleri şimdilik durdurdum; Dealio\'yu uygulamalarına (“Uygulamalarıma Ekle”) ya da bulunduğun bir sunucuya ekledikten sonra /dealio → ⚙️ Ayarlar\'dan yeniden açabilirsin.',
    setupWizardDmTransient: 'Kurulumu kaydettim ama Discord\'daki geçici bir sorun yüzünden karşılama mesajını gönderemedim. Takip normal şekilde devam ediyor.',
    setupWizardAlreadyCompletedTitle: 'Dealio zaten kurulu',
    setupWizardAlreadyCompletedDescription: 'Bu Discord hesabıyla kurulumu zaten yapmışsın. İstek listeni, bildirimlerini ve ayarlarını Dealio panelinden yönetebilirsin. Başka bir Steam hesabına geçmek için ⚙️ Ayarlar’daki “Steam hesabını değiştir”i kullan; her şeyi silip baştan başlamak istersen `/delete-data` var.',
    setupWizardFrequency: (hours) => hours < 1
      ? `${Math.round(hours * 60)} dakikada bir`
      : hours === 1 ? 'Saatte bir' : `${hours} saatte bir`,
    initialSummaryTitle: 'Hoş geldin! Dealio hazır',
    initialSummaryDescription: (saleCount, incompleteCount = 0) => saleCount > 0
      ? `İstek listende şu an **${saleCount}** oyun indirimde; aşağıdan tek tek bakabilirsin. Bunlar için ayrıca DM atmayacağım. Bundan sonra yeni bir indirim başladığında ilk sen öğreneceksin.`
      : incompleteCount > 0 ? 'Fiyatına bakabildiğim oyunlarda şu an indirim yok. Bazı fiyatları Steam\'den alamadım; bir sonraki kontrolde yeniden bakacağım.'
      : 'İstek listende şu an indirimde oyun yok. Bir oyun indirime girdiği an haber vereceğim.',
    initialSummaryIncomplete: 'Bazı fiyatları alamadım, o yüzden listenin tamamında indirim olmadığından henüz emin değilim.',
    initialSummaryNoSales: 'İlk tarama bitti. Şu an indirimde oyun yok.',
    invalidSetup: 'Bu dil seçeneği geçersiz. Türkçe, English, Deutsch ya da Français seçebilirsin.',
    invalidSteamProfile: 'Bu bir Steam profiline benzemiyor. Profil bağlantını, SteamID64\'ünü ya da özel URL adını yazabilirsin.',
    invalidStoreCountry: 'Listeden geçerli bir Steam mağaza ülkesi seç.',
    vanityProfileNotFound: 'Bu adla bir Steam profili bulamadım. Bağlantıyı ya da adı bir kontrol eder misin?',
    vanityResolutionUnavailable: 'Steam profil adlarına şu an bakamıyorum. Ayarlarına dokunmadım; biraz sonra yeniden dene.',
    steamWebApiKeyMissing: 'Profil adıyla arama şu an kapalı. Onun yerine SteamID64\'ünü ya da /profiles/ ile başlayan bağlantını kullanabilirsin.',
    notConfigured: 'Önce Steam hesabını bağlaman gerekiyor. /setup ile bir dakikada hallederiz.',
    unavailable: 'Steam\'e şu an ulaşamıyorum. Biraz sonra yeniden deneyelim.',
    wishlistInaccessible: 'Steam wishlist’ini göremiyorum 😞 Profilin gizli görünüyor. [Steam gizlilik ayarlarında](https://steamcommunity.com/my/edit/settings) **Profilim** ve **Oyun ayrıntıları**nı **Herkese Açık** yapman yeterli, sonra yeniden dene.',
    setupValidationUnavailable: 'İstek listene şu an ulaşamadım. Ayarlarına dokunmadım; biraz sonra yeniden dene.',
    alreadyRunning: 'Zaten istek listene bakıyorum, birazdan biter.',
    cooldown: (retryAfterSeconds) =>
      `Az önce baktım. Yeniden kontrol için ${retryAfterSeconds} saniye bekle.`,
    failed: 'Bir şeyler ters gitti, kontrolü bitiremedim. Biraz sonra yeniden dene.',
    checkCompleted: ({ checked, found, sent, deliveryFailed, unconfirmed }) => [
      `İstek listendeki ${checked} oyuna baktım.`,
      sent > 0 ? `${sent} fırsatı sana DM olarak gönderdim.`
        : found > 0 && deliveryFailed === 0 ? `${found} yeni fırsat buldum; bildirim saatin gelince DM olarak gelecek.`
        : found === 0 ? 'Şimdilik kuralına uyan yeni bir indirim yok.' : null,
      deliveryFailed > 0 ? `${deliveryFailed} DM şu an gönderilemedi; birazdan yeniden deneyeceğim.` : null,
      unconfirmed > 0 ? `${unconfirmed} oyunun fiyatını Steam'den alamadım; bir sonraki kontrolde yeniden bakacağım.` : null,
    ].filter(Boolean).join(' '),
    checkCompletedNotificationsDisabled: ({ checked, found, unconfirmed }) => [
      `İstek listendeki ${checked} oyuna baktım. Bildirimlerin kapalı olduğu için DM atmadım.`,
      found > 0 ? `${found} yeni fırsat, bildirimleri açtığında seni bekliyor olacak.` : null,
      unconfirmed > 0 ? `${unconfirmed} oyunun fiyatını Steam'den alamadım.` : null,
    ].filter(Boolean).join(' '),
    statusNotConfigured: 'Henüz bir Steam hesabı bağlamadın. /setup ile başlayabilirsin.',
    statusDashboardUnavailable: 'Bilgilerini şu an yükleyemedim. Biraz sonra yeniden dene.',
    statusMinimumDiscountModalTitle: 'En az ne kadar indirim olsun?',
    statusMinimumDiscountInputLabel: 'İndirim yüzdesi (0–100)',
    statusMinimumDiscountPlaceholder: 'Örneğin 30',
    discountThresholdInvalid: '0 ile 100 arasında bir tam sayı yaz.',
    testNotificationFailed: 'Deneme mesajını gönderemedim. Discord\'da geçici bir sorun olabilir ya da DM\'lerin kapalı olabilir. Gizlilik ayarlarına bir göz atıp yeniden dene.',
    testNotificationCooldown: (retryAfterSeconds) =>
      `Yeni bir deneme mesajı için ${retryAfterSeconds} saniye bekle.`,
    testNotificationDescription: 'Bu bir deneme: gerçek bildirimlerin tam olarak böyle görünecek. Oyun ve fiyat senin istek listenden.',
    testNotificationExampleDescription: 'Bu bir deneme: gerçek bildirimlerin böyle görünecek. İstek listende şu an indirim olmadığı için örnek bir oyun gösteriyorum.',
    openSteamStore: 'Steam\'de aç',
    regionSaved: (country) => `Mağaza bölgen artık ${country}. Bu bölgedeki ilk kontrolde yalnızca fiyatları not alacağım, DM atmayacağım. Para birimi değiştiyse hedef fiyatlarını yeniden kaydet; o zamana kadar o oyunlarda genel indirim kuralın geçerli.`,
    regionUnchanged: (country) => `Mağaza bölgen zaten ${country}.`,
    wishlistFailedItems: (count) => `${count} oyunun bilgilerini Steam'den alamadım.`,
  },
  en: {
    setupSuccess: 'I found your Steam profile and I’m now keeping an eye on your wishlist. 🎉',
    setupSummarySent: 'I sent you a first look at your wishlist by DM.',
    setupSummaryUnavailable: 'You’re all set, but I couldn’t reach Steam prices just now, so the first summary didn’t go out. I’ll keep checking as usual.',
    setupWizardTitle: 'Welcome to Dealio',
    setupWizardDescription: 'I’m your personal deal assistant. I watch your Steam wishlist so you don’t have to.\n\n'
      + '🔔 **A DM when a sale starts** · at your own Steam region’s price\n'
      + '🎯 **Your rules** · a discount % or a target price for each game\n'
      + '📈 **Know if it’s really a deal** · compared with Steam’s lowest price\n'
      + '🌙 **Never a nuisance** · quiet hours or a daily digest\n\n'
      + '-# Setup takes about a minute. I never ask for your password or Steam login.',
    setupWizardStart: 'Get started',
    setupWizardHow: 'How it works',
    setupWizardHowDescription: 'I only read your public Steam wishlist. The first scan just notes today’s prices, so sales that are already running won’t ping you. After that, I DM you when a new sale starts. No password or Steam session needed.',
    setupWizardModalTitle: 'Set up Dealio',
    setupWizardProfileLabel: 'Your Steam profile',
    setupWizardProfilePlaceholder: 'Profile link, SteamID64 or custom URL name',
    setupWizardCountryLabel: 'Your Steam Store country',
    setupWizardConfirmTitle: 'Does this look right?',
    setupWizardConfirmDescription: 'Take a quick look. Once you confirm, your sale DMs are on.',
    setupWizardProfileField: 'Steam account',
    setupWizardProfileNameField: 'Steam name',
    setupWizardRegionField: 'Store region',
    setupWizardRegionSuggested: 'Guessed from your Discord language. Change it below if it’s wrong.',
    setupWizardRegionSelected: 'The region you picked.',
    setupWizardChangeRegion: 'Change region',
    setupWizardCountryPickerPlaceholder: 'Pick your Steam Store country',
    setupWizardLanguageField: 'Language',
    setupWizardFrequencyField: 'Checks',
    setupWizardConsentField: 'DM permission',
    setupWizardConsentValue: 'If you confirm, I can DM you when a game on your wishlist goes on sale.',
    setupWizardEnable: 'Looks good, turn on alerts',
    setupWizardCancel: 'Cancel',
    setupWizardCancelled: 'Setup cancelled, nothing was changed. You can start again any time with /dealio.',
    setupWizardPreparing: 'Looking up your Steam profile and wishlist…',
    setupWizardDmBlocked: 'Your setup is saved, but Discord won’t let me DM you. I’ve paused alerts for now; once you fix your privacy settings, turn them back on in /dealio → ⚙️ Settings.',
    setupWizardDmNoMutualGuild: 'Your setup is saved, but Discord won’t let me DM you because we don’t share a server. I’ve paused alerts for now; add Dealio to your apps (“Add to My Apps”) or to a server you’re in, then turn them back on in /dealio → ⚙️ Settings.',
    setupWizardDmTransient: 'Your setup is saved, but a temporary Discord problem stopped the welcome message. Tracking carries on as normal.',
    setupWizardAlreadyCompletedTitle: 'Dealio is already set up',
    setupWizardAlreadyCompletedDescription: 'You’ve already set up Dealio on this Discord account. Manage your wishlist, alerts and settings from the Dealio panel. To switch to another Steam account, use “Change Steam account” in ⚙️ Settings; to erase everything and start over, use `/delete-data`.',
    setupWizardFrequency: (hours) => hours < 1
      ? `Every ${Math.round(hours * 60)} minutes`
      : hours === 1 ? 'Every hour' : `Every ${hours} hours`,
    initialSummaryTitle: 'Welcome! Dealio is ready',
    initialSummaryDescription: (saleCount, incompleteCount = 0) => saleCount > 0
      ? `${saleCount === 1 ? '**1** game on your wishlist is' : `**${saleCount}** games on your wishlist are`} on sale right now; browse them below. I won’t DM you about these. From now on, you’ll hear from me the moment a new sale starts.`
      : incompleteCount > 0 ? 'Nothing is on sale among the prices I could check. Steam didn’t give me a few prices; I’ll try them again on the next check.'
      : 'Nothing on your wishlist is on sale right now. I’ll let you know as soon as something is.',
    initialSummaryIncomplete: 'I couldn’t get a few prices, so I can’t say for sure yet that nothing is on sale.',
    initialSummaryNoSales: 'First scan done. Nothing is on sale right now.',
    invalidSetup: 'That language isn’t available. Choose Türkçe, English, Deutsch or Français.',
    invalidSteamProfile: 'That doesn’t look like a Steam profile. Paste your profile link, SteamID64 or custom URL name.',
    invalidStoreCountry: 'Pick a Steam Store country from the list.',
    vanityProfileNotFound: 'I couldn’t find a Steam profile with that name. Could you check the link or name?',
    vanityResolutionUnavailable: 'I can’t look up Steam profile names right now. Your settings are unchanged; try again in a bit.',
    steamWebApiKeyMissing: 'Looking up profiles by name is off right now. Use your SteamID64 or a /profiles/ link instead.',
    notConfigured: 'Connect your Steam account first. /setup takes about a minute.',
    unavailable: 'I can’t reach Steam right now. Let’s try again in a bit.',
    wishlistInaccessible: 'I can’t see your Steam wishlist 😞 Your profile looks private. In [Steam’s privacy settings](https://steamcommunity.com/my/edit/settings), set **My profile** and **Game details** to **Public**, then try again.',
    setupValidationUnavailable: 'I couldn’t reach your wishlist just now. Your settings are unchanged; try again in a bit.',
    alreadyRunning: 'I’m already checking your wishlist. It’ll be done in a moment.',
    cooldown: (retryAfterSeconds) =>
      `I just checked. Give it ${retryAfterSeconds} seconds before the next one.`,
    failed: 'Something went wrong and I couldn’t finish the check. Please try again in a bit.',
    checkCompleted: ({ checked, found, sent, deliveryFailed, unconfirmed }) => [
      `I checked ${checked} ${checked === 1 ? 'game' : 'games'} on your wishlist.`,
      sent > 0 ? `I sent you ${sent} ${sent === 1 ? 'deal' : 'deals'} by DM.`
        : found > 0 && deliveryFailed === 0 ? `I found ${found} new ${found === 1 ? 'deal' : 'deals'}; ${found === 1 ? 'it arrives' : 'they arrive'} by DM at your alert time.`
        : found === 0 ? 'No new sales match your rules for now.' : null,
      deliveryFailed > 0 ? `${deliveryFailed} ${deliveryFailed === 1 ? 'DM' : 'DMs'} couldn’t be sent yet; I’ll retry shortly.` : null,
      unconfirmed > 0 ? `Steam didn’t confirm ${unconfirmed} ${unconfirmed === 1 ? 'price' : 'prices'}; I’ll look again on the next check.` : null,
    ].filter(Boolean).join(' '),
    checkCompletedNotificationsDisabled: ({ checked, found, unconfirmed }) => [
      `I checked ${checked} ${checked === 1 ? 'game' : 'games'} on your wishlist. Your alerts are off, so I didn’t send any DMs.`,
      found > 0 ? `${found} new ${found === 1 ? 'deal is' : 'deals are'} waiting for when you turn them back on.` : null,
      unconfirmed > 0 ? `Steam didn’t confirm ${unconfirmed} ${unconfirmed === 1 ? 'price' : 'prices'}.` : null,
    ].filter(Boolean).join(' '),
    statusNotConfigured: 'You haven’t connected a Steam account yet. Start with /setup.',
    statusDashboardUnavailable: 'I couldn’t load your details right now. Please try again in a bit.',
    statusMinimumDiscountModalTitle: 'Minimum discount',
    statusMinimumDiscountInputLabel: 'Discount percent (0–100)',
    statusMinimumDiscountPlaceholder: 'For example 30',
    discountThresholdInvalid: 'Enter a whole number from 0 to 100.',
    testNotificationFailed: 'I couldn’t send the test message. Discord may be having a moment, or your DMs may be closed. Check your privacy settings and try again.',
    testNotificationCooldown: (retryAfterSeconds) =>
      `Wait ${retryAfterSeconds} seconds before sending another test.`,
    testNotificationDescription: 'This is a test: your real alerts will look exactly like this. The game and price come from your wishlist.',
    testNotificationExampleDescription: 'This is a test: your real alerts will look like this. Nothing on your wishlist is on sale right now, so here’s an example game.',
    openSteamStore: 'Open on Steam',
    regionSaved: (country) => `Your Store region is now ${country}. On the first check there I’ll just note prices, without DMs. If the currency changed, save your target prices again; until then your default discount rule applies to those games.`,
    regionUnchanged: (country) => `Your Store region is already ${country}.`,
    wishlistFailedItems: (count) => `Steam didn’t send details for ${count} ${count === 1 ? 'game' : 'games'}.`,
  },
  de: {
    setupSuccess: 'Ich habe dein Steam-Profil gefunden und behalte deine Wunschliste ab jetzt im Blick. 🎉',
    setupSummarySent: 'Ich habe dir per DM einen ersten Überblick über deine Wunschliste geschickt.',
    setupSummaryUnavailable: 'Alles ist eingerichtet, aber ich komme gerade nicht an die Steam-Preise, deshalb kam der erste Überblick nicht an. Ich prüfe ganz normal weiter.',
    setupWizardTitle: 'Willkommen bei Dealio',
    setupWizardDescription: 'Ich bin dein persönlicher Schnäppchen-Assistent und behalte deine Steam-Wunschliste für dich im Blick.\n\n'
      + '🔔 **Eine DM, sobald ein Angebot startet** · zum Preis deiner Steam-Region\n'
      + '🎯 **Deine Regeln** · Rabatt in % oder Wunschpreis für jedes Spiel\n'
      + '📈 **Wirklich ein guter Preis?** · im Vergleich zum Steam-Tiefstpreis\n'
      + '🌙 **Kein Spam** · Ruhezeiten oder eine tägliche Zusammenfassung\n\n'
      + '-# Die Einrichtung dauert etwa eine Minute. Ich frage nie nach deinem Passwort oder Steam-Login.',
    setupWizardStart: 'Los geht’s',
    setupWizardHow: 'So funktioniert’s',
    setupWizardHowDescription: 'Ich lese nur deine öffentliche Steam-Wunschliste. Beim ersten Scan merke ich mir die aktuellen Preise, für bereits laufende Angebote bekommst du also keine DM. Danach melde ich mich, sobald ein neues Angebot startet. Kein Passwort, keine Steam-Anmeldung.',
    setupWizardModalTitle: 'Dealio einrichten',
    setupWizardProfileLabel: 'Dein Steam-Profil',
    setupWizardProfilePlaceholder: 'Profil-Link, SteamID64 oder eigener URL-Name',
    setupWizardCountryLabel: 'Land deines Steam-Shops',
    setupWizardConfirmTitle: 'Passt alles?',
    setupWizardConfirmDescription: 'Wirf kurz einen Blick drauf. Sobald du bestätigst, sind deine Angebots-DMs aktiv.',
    setupWizardProfileField: 'Steam-Konto',
    setupWizardProfileNameField: 'Steam-Name',
    setupWizardRegionField: 'Shop-Region',
    setupWizardRegionSuggested: 'Aus deiner Discord-Sprache abgeleitet. Falls das nicht stimmt, ändere es unten.',
    setupWizardRegionSelected: 'Die Region, die du gewählt hast.',
    setupWizardChangeRegion: 'Region ändern',
    setupWizardCountryPickerPlaceholder: 'Wähle das Land deines Steam-Shops',
    setupWizardLanguageField: 'Sprache',
    setupWizardFrequencyField: 'Prüfung',
    setupWizardConsentField: 'DM-Erlaubnis',
    setupWizardConsentValue: 'Wenn du bestätigst, darf ich dir eine DM schicken, sobald ein Spiel von deiner Wunschliste im Angebot ist.',
    setupWizardEnable: 'Passt, Benachrichtigungen an',
    setupWizardCancel: 'Abbrechen',
    setupWizardCancelled: 'Einrichtung abgebrochen, es wurde nichts geändert. Mit /dealio kannst du jederzeit neu starten.',
    setupWizardPreparing: 'Ich schaue mir dein Steam-Profil und deine Wunschliste an …',
    setupWizardDmBlocked: 'Deine Einrichtung ist gespeichert, aber Discord lässt mich dir keine DMs schicken. Ich habe die Benachrichtigungen vorerst pausiert. Sobald du deine Privatsphäre-Einstellungen angepasst hast, schalte sie unter /dealio → ⚙️ Einstellungen wieder ein.',
    setupWizardDmNoMutualGuild: 'Deine Einrichtung ist gespeichert, aber Discord lässt mich dir keine DMs schicken, weil wir keinen gemeinsamen Server haben. Ich habe die Benachrichtigungen vorerst pausiert. Füg Dealio deinen Apps („Zu meinen Apps hinzufügen“) oder einem Server hinzu, auf dem du bist, und schalte sie dann unter /dealio → ⚙️ Einstellungen wieder ein.',
    setupWizardDmTransient: 'Deine Einrichtung ist gespeichert, aber wegen eines kurzen Discord-Problems kam die Willkommensnachricht nicht an. Alles läuft ganz normal weiter.',
    setupWizardAlreadyCompletedTitle: 'Dealio ist schon eingerichtet',
    setupWizardAlreadyCompletedDescription: 'Du hast Dealio mit diesem Discord-Konto bereits eingerichtet. Wunschliste, Benachrichtigungen und Einstellungen findest du im Dealio-Panel. Für ein anderes Steam-Konto nutzt du „Steam-Konto wechseln“ unter ⚙️ Einstellungen; um alles zu löschen und neu anzufangen, gibt es `/delete-data`.',
    setupWizardFrequency: (hours) => hours < 1
      ? `Alle ${Math.round(hours * 60)} Minuten`
      : hours === 1 ? 'Jede Stunde' : `Alle ${hours} Stunden`,
    initialSummaryTitle: 'Willkommen! Dealio ist bereit',
    initialSummaryDescription: (saleCount, incompleteCount = 0) => saleCount > 0
      ? `Auf deiner Wunschliste ${saleCount === 1 ? 'ist gerade **1** Spiel' : `sind gerade **${saleCount}** Spiele`} im Angebot; unten kannst du sie durchblättern. Dafür schicke ich dir keine extra DM. Ab jetzt melde ich mich, sobald ein neues Angebot startet.`
      : incompleteCount > 0 ? 'Bei den Preisen, die ich prüfen konnte, ist gerade nichts im Angebot. Ein paar Preise hat Steam mir nicht geliefert; die schaue ich mir bei der nächsten Prüfung noch einmal an.'
      : 'Gerade ist nichts auf deiner Wunschliste im Angebot. Sobald sich das ändert, sage ich dir Bescheid.',
    initialSummaryIncomplete: 'Ein paar Preise fehlen mir noch, deshalb kann ich noch nicht sicher sagen, dass nichts im Angebot ist.',
    initialSummaryNoSales: 'Erster Scan fertig. Gerade ist nichts im Angebot.',
    invalidSetup: 'Diese Sprache gibt es nicht. Wähle Türkçe, English, Deutsch oder Français.',
    invalidSteamProfile: 'Das sieht nicht nach einem Steam-Profil aus. Füge deinen Profil-Link, deine SteamID64 oder deinen eigenen URL-Namen ein.',
    invalidStoreCountry: 'Wähle ein Steam-Shop-Land aus der Liste.',
    vanityProfileNotFound: 'Unter diesem Namen habe ich kein Steam-Profil gefunden. Prüfst du den Link oder Namen noch einmal?',
    vanityResolutionUnavailable: 'Ich kann Steam-Profilnamen gerade nicht nachschlagen. Deine Einstellungen bleiben unverändert; versuch es gleich noch mal.',
    steamWebApiKeyMissing: 'Die Suche nach Profilnamen ist gerade nicht verfügbar. Nutze stattdessen deine SteamID64 oder einen /profiles/-Link.',
    notConfigured: 'Verbinde zuerst dein Steam-Konto. Mit /setup dauert das etwa eine Minute.',
    unavailable: 'Ich erreiche Steam gerade nicht. Versuchen wir es gleich noch mal.',
    wishlistInaccessible: 'Ich kann deine Steam-Wunschliste nicht sehen 😞 Dein Profil sieht privat aus. Stell in den [Steam-Privatsphäre-Einstellungen](https://steamcommunity.com/my/edit/settings) **Mein Profil** und **Spieldetails** auf **Öffentlich** und versuch es dann noch mal.',
    setupValidationUnavailable: 'Ich komme gerade nicht an deine Wunschliste. Deine Einstellungen bleiben unverändert; versuch es gleich noch mal.',
    alreadyRunning: 'Ich prüfe deine Wunschliste schon. Gleich fertig.',
    cooldown: (retryAfterSeconds) =>
      `Ich habe gerade erst nachgesehen. Warte ${retryAfterSeconds} Sekunden bis zur nächsten Prüfung.`,
    failed: 'Da ist etwas schiefgelaufen, ich konnte die Prüfung nicht abschließen. Versuch es gleich noch mal.',
    checkCompleted: ({ checked, found, sent, deliveryFailed, unconfirmed }) => [
      `Ich habe ${checked} ${checked === 1 ? 'Spiel' : 'Spiele'} auf deiner Wunschliste geprüft.`,
      sent > 0 ? `${sent} ${sent === 1 ? 'Angebot habe ich dir' : 'Angebote habe ich dir'} per DM geschickt.`
        : found > 0 && deliveryFailed === 0 ? `Ich habe ${found} ${found === 1 ? 'neues Angebot' : 'neue Angebote'} gefunden; ${found === 1 ? 'es kommt' : 'sie kommen'} zu deiner Benachrichtigungszeit per DM.`
        : found === 0 ? 'Gerade passt kein neues Angebot zu deinen Regeln.' : null,
      deliveryFailed > 0 ? `${deliveryFailed} ${deliveryFailed === 1 ? 'DM ging' : 'DMs gingen'} noch nicht raus; ich versuche es gleich noch mal.` : null,
      unconfirmed > 0 ? `Für ${unconfirmed} ${unconfirmed === 1 ? 'Spiel' : 'Spiele'} hat Steam keinen Preis bestätigt; ich schaue bei der nächsten Prüfung noch einmal.` : null,
    ].filter(Boolean).join(' '),
    checkCompletedNotificationsDisabled: ({ checked, found, unconfirmed }) => [
      `Ich habe ${checked} ${checked === 1 ? 'Spiel' : 'Spiele'} auf deiner Wunschliste geprüft. Deine Benachrichtigungen sind aus, deshalb habe ich keine DM geschickt.`,
      found > 0 ? `${found} ${found === 1 ? 'neues Angebot wartet' : 'neue Angebote warten'} auf dich, sobald du sie wieder einschaltest.` : null,
      unconfirmed > 0 ? `Für ${unconfirmed} ${unconfirmed === 1 ? 'Spiel' : 'Spiele'} hat Steam keinen Preis bestätigt.` : null,
    ].filter(Boolean).join(' '),
    statusNotConfigured: 'Du hast noch kein Steam-Konto verbunden. Starte mit /setup.',
    statusDashboardUnavailable: 'Ich konnte deine Daten gerade nicht laden. Versuch es gleich noch mal.',
    statusMinimumDiscountModalTitle: 'Mindestrabatt',
    statusMinimumDiscountInputLabel: 'Rabatt in Prozent (0–100)',
    statusMinimumDiscountPlaceholder: 'Zum Beispiel 30',
    discountThresholdInvalid: 'Gib eine ganze Zahl von 0 bis 100 ein.',
    testNotificationFailed: 'Die Testnachricht konnte ich nicht senden. Vielleicht hakt Discord gerade, oder deine DMs sind geschlossen. Prüf deine Privatsphäre-Einstellungen und versuch es noch mal.',
    testNotificationCooldown: (retryAfterSeconds) =>
      `Warte ${retryAfterSeconds} Sekunden bis zum nächsten Test.`,
    testNotificationDescription: 'Das ist ein Test: Deine echten Benachrichtigungen sehen genau so aus. Spiel und Preis stammen von deiner Wunschliste.',
    testNotificationExampleDescription: 'Das ist ein Test: So sehen deine echten Benachrichtigungen aus. Gerade ist nichts auf deiner Wunschliste im Angebot, deshalb siehst du ein Beispielspiel.',
    openSteamStore: 'Auf Steam öffnen',
    regionSaved: (country) => `Deine Shop-Region ist jetzt ${country}. Bei der ersten Prüfung dort merke ich mir nur die Preise, ohne DMs. Falls sich die Währung geändert hat, speichere deine Wunschpreise neu; bis dahin gilt für diese Spiele deine Standardregel.`,
    regionUnchanged: (country) => `Deine Shop-Region ist bereits ${country}.`,
    wishlistFailedItems: (count) => `Für ${count} ${count === 1 ? 'Spiel' : 'Spiele'} hat Steam keine Details geliefert.`,
  },
  fr: {
    setupSuccess: 'J’ai trouvé ton profil Steam, je surveille maintenant ta liste de souhaits. 🎉',
    setupSummarySent: 'Je t’ai envoyé en MP un premier aperçu de ta liste de souhaits.',
    setupSummaryUnavailable: 'Tout est prêt, mais je n’arrive pas à récupérer les prix Steam pour l’instant, donc le premier aperçu n’est pas parti. Je continue mes vérifications comme d’habitude.',
    setupWizardTitle: 'Bienvenue sur Dealio',
    setupWizardDescription: 'Je suis ton assistant bons plans perso : je garde un œil sur ta liste de souhaits Steam à ta place.\n\n'
      + '🔔 **Un MP dès qu’une promo commence** · au prix de ta région Steam\n'
      + '🎯 **Tes règles** · un % de réduction ou un prix cible pour chaque jeu\n'
      + '📈 **Une vraie bonne affaire ?** · comparée au prix le plus bas sur Steam\n'
      + '🌙 **Jamais envahissant** · heures calmes ou résumé quotidien\n\n'
      + '-# La configuration prend environ une minute. Je ne te demande jamais ton mot de passe ni tes identifiants Steam.',
    setupWizardStart: 'C’est parti',
    setupWizardHow: 'Comment ça marche ?',
    setupWizardHowDescription: 'Je lis uniquement ta liste de souhaits Steam publique. Au premier passage, je note les prix actuels : pas de MP pour les promos déjà en cours. Ensuite, je te préviens dès qu’une nouvelle promo commence. Ni mot de passe, ni session Steam.',
    setupWizardModalTitle: 'Configurer Dealio',
    setupWizardProfileLabel: 'Ton profil Steam',
    setupWizardProfilePlaceholder: 'Lien du profil, SteamID64 ou URL personnalisée',
    setupWizardCountryLabel: 'Pays de ta boutique Steam',
    setupWizardConfirmTitle: 'Tout est bon ?',
    setupWizardConfirmDescription: 'Jette un œil rapide. Dès que tu confirmes, tes MP de promos sont activés.',
    setupWizardProfileField: 'Compte Steam',
    setupWizardProfileNameField: 'Nom Steam',
    setupWizardRegionField: 'Région de la boutique',
    setupWizardRegionSuggested: 'Déduite de ta langue Discord. Change-la ci-dessous si elle n’est pas bonne.',
    setupWizardRegionSelected: 'La région que tu as choisie.',
    setupWizardChangeRegion: 'Changer de région',
    setupWizardCountryPickerPlaceholder: 'Choisis le pays de ta boutique Steam',
    setupWizardLanguageField: 'Langue',
    setupWizardFrequencyField: 'Vérifications',
    setupWizardConsentField: 'Autorisation des MP',
    setupWizardConsentValue: 'Si tu confirmes, je peux t’envoyer un MP quand un jeu de ta liste de souhaits passe en promo.',
    setupWizardEnable: 'C’est bon, activer les alertes',
    setupWizardCancel: 'Annuler',
    setupWizardCancelled: 'Configuration annulée, rien n’a été modifié. Tu peux recommencer quand tu veux avec /dealio.',
    setupWizardPreparing: 'Je regarde ton profil Steam et ta liste de souhaits…',
    setupWizardDmBlocked: 'C’est enregistré, mais Discord ne me laisse pas t’envoyer de MP. J’ai mis les alertes en pause ; une fois tes paramètres de confidentialité corrigés, réactive-les dans /dealio → ⚙️ Réglages.',
    setupWizardDmNoMutualGuild: 'C’est enregistré, mais Discord ne me laisse pas t’envoyer de MP car nous n’avons aucun serveur en commun. J’ai mis les alertes en pause ; ajoute Dealio à tes applis (« Ajouter à mes applis ») ou à un serveur où tu es, puis réactive-les dans /dealio → ⚙️ Réglages.',
    setupWizardDmTransient: 'C’est enregistré, mais un souci passager côté Discord a bloqué le message de bienvenue. Le suivi continue normalement.',
    setupWizardAlreadyCompletedTitle: 'Dealio est déjà configuré',
    setupWizardAlreadyCompletedDescription: 'Tu as déjà configuré Dealio sur ce compte Discord. Gère ta liste de souhaits, tes alertes et tes réglages depuis le panneau Dealio. Pour passer à un autre compte Steam, utilise « Changer de compte Steam » dans ⚙️ Réglages ; pour tout effacer et repartir de zéro, utilise `/delete-data`.',
    setupWizardFrequency: (hours) => hours < 1
      ? `Toutes les ${Math.round(hours * 60)} minutes`
      : hours === 1 ? 'Toutes les heures' : `Toutes les ${hours} heures`,
    initialSummaryTitle: 'Bienvenue ! Dealio est prêt',
    initialSummaryDescription: (saleCount, incompleteCount = 0) => saleCount > 0
      ? `${saleCount === 1 ? '**1** jeu de ta liste de souhaits est' : `**${saleCount}** jeux de ta liste de souhaits sont`} en promo en ce moment ; parcours-les ci-dessous. Pas de MP pour ceux-là. À partir de maintenant, je te préviens dès qu’une nouvelle promo commence.`
      : incompleteCount > 0 ? 'Aucune promo parmi les prix que j’ai pu vérifier. Steam ne m’a pas donné quelques prix ; je réessaierai à la prochaine vérification.'
      : 'Rien n’est en promo sur ta liste de souhaits pour l’instant. Je te préviens dès que ça change.',
    initialSummaryIncomplete: 'Il me manque quelques prix, donc je ne peux pas encore affirmer que rien n’est en promo.',
    initialSummaryNoSales: 'Premier passage terminé. Rien n’est en promo pour l’instant.',
    invalidSetup: 'Cette langue n’est pas disponible. Choisis Türkçe, English, Deutsch ou Français.',
    invalidSteamProfile: 'Ça ne ressemble pas à un profil Steam. Colle le lien de ton profil, ton SteamID64 ou ton URL personnalisée.',
    invalidStoreCountry: 'Choisis un pays de boutique Steam dans la liste.',
    vanityProfileNotFound: 'Je n’ai trouvé aucun profil Steam à ce nom. Tu peux vérifier le lien ou le nom ?',
    vanityResolutionUnavailable: 'Je ne peux pas rechercher les noms de profil Steam pour l’instant. Tes réglages n’ont pas changé ; réessaie dans un moment.',
    steamWebApiKeyMissing: 'La recherche par nom de profil est indisponible pour l’instant. Utilise plutôt ton SteamID64 ou un lien /profiles/.',
    notConfigured: 'Connecte d’abord ton compte Steam. Avec /setup, ça prend environ une minute.',
    unavailable: 'Je n’arrive pas à joindre Steam pour l’instant. On réessaie dans un moment.',
    wishlistInaccessible: 'Je ne vois pas ta liste de souhaits Steam 😞 Ton profil semble privé. Dans les [paramètres de confidentialité Steam](https://steamcommunity.com/my/edit/settings), mets **Mon profil** et **Détails des jeux** en **Public**, puis réessaie.',
    setupValidationUnavailable: 'Je n’arrive pas à accéder à ta liste de souhaits pour l’instant. Tes réglages n’ont pas changé ; réessaie dans un moment.',
    alreadyRunning: 'Je vérifie déjà ta liste de souhaits, ça arrive.',
    cooldown: (retryAfterSeconds) =>
      `Je viens de vérifier. Attends ${retryAfterSeconds} secondes avant la prochaine fois.`,
    failed: 'Quelque chose s’est mal passé, je n’ai pas pu terminer la vérification. Réessaie dans un moment.',
    checkCompleted: ({ checked, found, sent, deliveryFailed, unconfirmed }) => [
      `J’ai vérifié ${checked} ${checked === 1 ? 'jeu' : 'jeux'} de ta liste de souhaits.`,
      sent > 0 ? `Je t’ai envoyé ${sent} ${sent === 1 ? 'bon plan' : 'bons plans'} en MP.`
        : found > 0 && deliveryFailed === 0 ? `J’ai trouvé ${found} ${found === 1 ? 'nouveau bon plan' : 'nouveaux bons plans'} ; tu ${found === 1 ? 'le recevras' : 'les recevras'} en MP à l’heure de tes alertes.`
        : found === 0 ? 'Aucune nouvelle promo ne correspond à tes règles pour l’instant.' : null,
      deliveryFailed > 0 ? `${deliveryFailed} MP ${deliveryFailed === 1 ? 'n’a' : 'n’ont'} pas encore pu partir ; je réessaie très vite.` : null,
      unconfirmed > 0 ? `Steam n’a pas confirmé le prix de ${unconfirmed} ${unconfirmed === 1 ? 'jeu' : 'jeux'} ; je regarderai à nouveau à la prochaine vérification.` : null,
    ].filter(Boolean).join(' '),
    checkCompletedNotificationsDisabled: ({ checked, found, unconfirmed }) => [
      `J’ai vérifié ${checked} ${checked === 1 ? 'jeu' : 'jeux'} de ta liste de souhaits. Tes alertes sont coupées, donc je n’ai envoyé aucun MP.`,
      found > 0 ? `${found} ${found === 1 ? 'nouveau bon plan t’attend' : 'nouveaux bons plans t’attendent'} quand tu les réactiveras.` : null,
      unconfirmed > 0 ? `Steam n’a pas confirmé le prix de ${unconfirmed} ${unconfirmed === 1 ? 'jeu' : 'jeux'}.` : null,
    ].filter(Boolean).join(' '),
    statusNotConfigured: 'Tu n’as pas encore connecté de compte Steam. Commence avec /setup.',
    statusDashboardUnavailable: 'Je n’ai pas pu charger tes infos pour l’instant. Réessaie dans un moment.',
    statusMinimumDiscountModalTitle: 'Réduction minimale',
    statusMinimumDiscountInputLabel: 'Pourcentage de réduction (0–100)',
    statusMinimumDiscountPlaceholder: 'Par exemple 30',
    discountThresholdInvalid: 'Saisis un nombre entier entre 0 et 100.',
    testNotificationFailed: 'Je n’ai pas pu envoyer le message de test. Discord a peut-être un souci passager, ou tes MP sont fermés. Vérifie tes paramètres de confidentialité et réessaie.',
    testNotificationCooldown: (retryAfterSeconds) =>
      `Attends ${retryAfterSeconds} secondes avant un nouveau test.`,
    testNotificationDescription: 'Ceci est un test : tes vraies alertes ressembleront exactement à ça. Le jeu et le prix viennent de ta liste de souhaits.',
    testNotificationExampleDescription: 'Ceci est un test : tes vraies alertes ressembleront à ça. Rien n’est en promo sur ta liste en ce moment, alors voici un jeu d’exemple.',
    openSteamStore: 'Ouvrir sur Steam',
    regionSaved: (country) => `Ta région de boutique est maintenant ${country}. Au premier passage là-bas, je note juste les prix, sans MP. Si la devise a changé, enregistre de nouveau tes prix cibles ; d’ici là, ta règle par défaut s’applique à ces jeux.`,
    regionUnchanged: (country) => `Ta région de boutique est déjà ${country}.`,
    wishlistFailedItems: (count) => `Steam n’a pas envoyé les détails de ${count} ${count === 1 ? 'jeu' : 'jeux'}.`,
  },
};

export function messagesFor(language: Language): MessageCatalog {
  return catalog[language];
}
