/**
 * Plain-language names for the codes the bot stores: why a wishlist check did not
 * succeed, and what a user did (interaction_event actions). The raw code stays in
 * tooltips and CSV exports.
 */

/** Who can fix a failed check: the user, nobody (it passes), or the owner. */
export type CheckFix = 'user' | 'temporary' | 'owner';

export interface CheckErrorInfo {
  readonly title: string;
  readonly detail: string;
  readonly fix: CheckFix;
}

const checkErrors: Readonly<Record<string, CheckErrorInfo>> = {
  STEAM_WISHLIST_INACCESSIBLE: {
    title: 'Wishlist gizli',
    detail: 'Steam profili ya da “Oyun detayları” herkese açık değil. Kullanıcı Steam gizlilik ayarlarından açmadıkça Dealio wishlist’i okuyamaz.',
    fix: 'user',
  },
  STEAM_NOT_FOUND: {
    title: 'Steam profili bulunamadı',
    detail: 'Kayıtlı SteamID artık bir profile karşılık gelmiyor. Kullanıcı Ayarlar’dan Steam hesabını yeniden seçmeli.',
    fix: 'user',
  },
  STEAM_INVALID_REQUEST: {
    title: 'Steam isteği reddetti',
    detail: 'Steam bu profil için isteği geçersiz saydı. Genelde profil bilgisi bozulmuştur; kullanıcı Steam hesabını yeniden seçmeli.',
    fix: 'user',
  },
  STEAM_RATE_LIMITED: {
    title: 'Steam hız sınırı',
    detail: 'Steam kısa süreliğine fazla istek dedi. Bir sonraki taramada kendiliğinden düzelir.',
    fix: 'temporary',
  },
  STEAM_TIMEOUT: {
    title: 'Steam yanıt vermedi',
    detail: 'Steam zamanında cevap vermedi. Bir sonraki taramada kendiliğinden düzelir.',
    fix: 'temporary',
  },
  STEAM_UPSTREAM_ERROR: {
    title: 'Steam hata verdi',
    detail: 'Steam sunucusu hata döndürdü (bakım ya da yoğunluk). Bir sonraki taramada kendiliğinden düzelir.',
    fix: 'temporary',
  },
  STEAM_NETWORK_ERROR: {
    title: 'Steam’e bağlanılamadı',
    detail: 'Sunucu Steam’e ulaşamadı. Tek seferlikse geçer; sürerse VM’nin ağ bağlantısına bak.',
    fix: 'temporary',
  },
  STEAM_CANCELLED: {
    title: 'Kontrol yarıda kesildi',
    detail: 'Bot kapanırken ya da kontrol iptal edilirken yarıda kaldı. Bir sonraki taramada tekrarlanır.',
    fix: 'temporary',
  },
  STEAM_INVALID_RESPONSE: {
    title: 'Steam beklenmedik yanıt verdi',
    detail: 'Steam’in cevabı okunamadı. Tek seferlikse geçer; birçok kullanıcıda sürerse Steam API’si değişmiş olabilir, Loglar’a bak.',
    fix: 'owner',
  },
  STEAM_SCHEMA_INVALID: {
    title: 'Steam yanıt biçimi değişti',
    detail: 'Steam’in cevabı beklenen biçimde değil. Sürerse Steam API’si değişmiş olabilir; Loglar’a bak.',
    fix: 'owner',
  },
  INTERNAL_ERROR: {
    title: 'Botta iç hata',
    detail: 'Kontrol sırasında beklenmeyen bir hata oldu. Ayrıntı Loglar’da.',
    fix: 'owner',
  },
  PERSISTENCE_ERROR: {
    title: 'Veritabanı hatası',
    detail: 'Sonuç veritabanına yazılamadı. Disk ve veritabanı durumunu Sistem’den kontrol et.',
    fix: 'owner',
  },
};

export const checkFixNames: Readonly<Record<CheckFix, string>> = {
  user: 'Kullanıcı düzeltmeli',
  temporary: 'Kendiliğinden düzelir',
  owner: 'Senin bakman gerek',
};

export function checkErrorInfo(code: string): CheckErrorInfo {
  return checkErrors[code] ?? { title: 'Bilinmeyen hata', detail: `Bot “${code}” kodunu kaydetti; ayrıntı Loglar’da.`, fix: 'owner' };
}

/* Alert delivery */

/**
 * Why Discord did not deliver an alert DM. Accepts Dealio's stored codes
 * (DISCORD_DM_BLOCKED, DISCORD_NO_MUTUAL_GUILD, legacy "50007") and Discord's own
 * error messages, which older alert rows keep.
 */
export function deliveryErrorInfo(error: string | null): CheckErrorInfo {
  const text = error ?? '';
  if (text === 'DISCORD_NO_MUTUAL_GUILD' || text === '50278' || /no mutual guilds/i.test(text)) {
    return {
      title: 'Ortak sunucu yok',
      detail: 'Kullanıcı Dealio’nun olduğu hiçbir sunucuda değil ve Dealio’yu hesabına (Uygulamalarım) kurmamış; Discord bu yüzden DM’ye izin vermiyor. Dealio’yu bir sunucuya eklemesi ya da hesabına kurması gerekir.',
      fix: 'user',
    };
  }
  if (text === 'DISCORD_DM_BLOCKED' || text === '50007' || /^Cannot send messages to this user/i.test(text)) {
    return {
      title: 'DM’leri kapalı',
      detail: 'Kullanıcı Discord gizlilik ayarlarında bu sunucudan ya da uygulamalardan DM almayı kapatmış. Açınca /dealio’dan takibi sürdürmesi yeterli.',
      fix: 'user',
    };
  }
  return {
    title: 'Discord teslim etmedi',
    detail: error ? `Discord’un cevabı: “${error}”. Ayrıntı Loglar’da.` : 'Discord uyarıyı kabul etmedi; ayrıntı Loglar’da.',
    fix: 'owner',
  };
}

/* Interactions */

/** Where in Dealio an action happened, from its component prefix. */
const areas: Readonly<Record<string, string>> = {
  assistant: 'Panel', dealio: 'Panel', 'check-v2': 'Panel', 'status-v2': 'Panel',
  'assistant-modal': 'Panel', 'status-threshold-v2': 'Panel',
  setup: 'Kurulum', 'setup-modal': 'Kurulum', 'setup-country-search': 'Kurulum',
  'delete-v2': 'Veri silme', 'dealio-summary': 'Fırsat özeti DM’i', 'dealio-open': 'DM', support: 'Destek',
};

const verbs: Readonly<Record<string, string>> = {
  'tab-home': 'Ana sayfaya geçti',
  'tab-games': 'Wishlist sekmesine geçti',
  'tab-alerts': 'Uyarılar sekmesine geçti',
  'tab-settings': 'Ayarlar sekmesine geçti',
  game: 'Bir oyunun detayını açtı',
  deals: '“Eşleşen fırsatlar”ı açtı',
  check: '“Şimdi kontrol et”e bastı',
  refresh: 'Listeyi yeniledi',
  search: 'Arama yaptı',
  filter: 'Listeyi filtreledi',
  prev: 'Önceki sayfaya geçti',
  previous: 'Önceki sayfaya geçti',
  next: 'Sonraki sayfaya geçti',
  page: 'Sayfa seçti',
  wishlist: 'Wishlist’e döndü',
  target: 'Hedef fiyat koymayı açtı',
  percent: 'Oyuna özel indirim oranını açtı',
  inherit: 'Oyunu varsayılan kurala döndürdü',
  low: 'Hedefi tarihi en düşük fiyata ayarladı',
  mute: 'Bir oyunun bildirimini kapattı/açtı',
  history: 'Bildirim geçmişini açtı',
  rhythm: 'Bildirim zamanlamasını açtı',
  retry: 'Tekrar denedi',
  instant: 'Anında bildirime geçti',
  quiet: 'Sessiz saatleri ayarladı',
  'quiet-night': 'Gece sessizliğini seçti',
  digest: 'Günlük özeti ayarladı',
  'digest-evening': 'Akşam özetini seçti',
  timezone: 'Saat dilimi seçti',
  disable: 'Takibi duraklattı',
  enable: 'Takibi yeniden açtı',
  'minimum-discount': 'Varsayılan indirim eşiğini açtı',
  test: 'Test uyarısı istedi',
  region: 'Mağaza bölgesini değiştirmeyi açtı',
  language: 'Dil seçti',
  account: 'Steam hesabını değiştirmeyi açtı',
  'account-confirm': 'Steam hesabı değişikliğini onayladı',
  'account-cancel': 'Steam hesabı değişikliğinden vazgeçti',
  delete: 'Veri silmeyi açtı',
  setup: 'Kurulumu başlattı',
  start: 'Kuruluma başladı',
  how: '“Nasıl çalışır?”a bastı',
  confirm: 'Onayladı',
  cancel: 'Vazgeçti',
  open: 'Paneli açtı',
  home: 'Paneli açtı',
  back: 'Geri döndü',
  select: 'Seçim yaptı',
  range: 'Ülke listesinde gezindi',
};

/** Exact actions whose meaning depends on where they happened. */
const exact: Readonly<Record<string, string>> = {
  '/dealio': '/dealio ile paneli açtı',
  '/setup': '/setup ile kurulumu açtı',
  '/delete-data': '/delete-data ile veri silmeyi açtı',
  'dealio-open:home': 'Bir uyarı DM’indeki “Dealio paneli” düğmesine bastı',
  'dealio:setup': 'Panelden kurulumu başlattı',
  'setup:open': 'Kurulum bitince paneli açtı',
  'setup:confirm': 'Kurulumu onayladı',
  'setup:cancel': 'Kurulumdan vazgeçti',
  'setup:language': 'Kurulumda dil seçti',
  'setup:region': 'Kurulumda bölge değiştirmeyi açtı',
  'setup:search': 'Kurulumda ülke aradı',
  'setup:select': 'Kurulumda ülke seçti',
  'delete-v2:confirm': 'Verilerini silmeyi onayladı',
  'delete-v2:cancel': 'Veri silmekten vazgeçti',
  'delete-v2:setup': 'Silme ekranından kuruluma geçti',
  'dealio-summary:next': 'Fırsat özetinde sonraki sayfaya geçti',
  'dealio-summary:previous': 'Fırsat özetinde önceki sayfaya geçti',
  'dealio-summary:page': 'Fırsat özetinde sayfa seçti',
};

/** Setup funnel steps (kind "setup"): `prepare-ok`, `confirm-failed:<code>` and so on. */
const setupSteps: Readonly<Record<string, string>> = {
  'prepare-ok': 'Steam profili doğrulandı',
  'confirm-ok': 'Kurulumu tamamladı',
};

const setupFailures: Readonly<Record<string, string>> = {
  STEAM_WISHLIST_INACCESSIBLE: 'wishlist gizli',
  STEAM_NOT_FOUND: 'Steam profili bulunamadı',
  INVALID_CONFIGURATION: 'geçersiz profil girişi',
  INVALID_STORE_COUNTRY: 'geçersiz bölge',
  STEAM_TIMEOUT: 'Steam yanıt vermedi',
  STEAM_UPSTREAM_ERROR: 'Steam hata verdi',
  STEAM_RATE_LIMITED: 'Steam hız sınırı',
  STEAM_NETWORK_ERROR: 'Steam’e bağlanılamadı',
  SetupCapacityReachedError: 'kayıtlar kapalı / dolu',
  SetupAlreadyCompletedError: 'zaten kayıtlı',
};

/** Just the reason of a failed setup step, for lists already titled as failures. */
export function setupFailureReason(key: string): string {
  const [step = '', code = '?'] = key.split(':');
  const reason = setupFailures[code] ?? code;
  const capitalized = reason.charAt(0).toLocaleUpperCase('tr-TR') + reason.slice(1);
  return step === 'confirm-failed' ? `${capitalized} (onayda)` : capitalized;
}

export function setupStepLabel(key: string): string {
  if (setupSteps[key]) return setupSteps[key]!;
  const [step = '', code = '?'] = key.split(':');
  const reason = setupFailures[code] ?? code;
  return step === 'confirm-failed' ? `Kurulum onayda başarısız: ${reason}` : `Profil doğrulanamadı: ${reason}`;
}

export interface ActionLabel {
  /** What the user did, in a sentence. */
  readonly label: string;
  /** Where it happened: Panel, Kurulum, DM… */
  readonly area: string;
}

/**
 * "assistant:tab-games" → "Wishlist sekmesine geçti" (Panel). Unknown actions keep
 * their code so nothing is hidden; the code is always available as a tooltip.
 */
export function actionLabel(action: string, kind?: string): ActionLabel {
  if (kind === 'setup') return { label: setupStepLabel(action), area: 'Kurulum' };
  if (action.startsWith('/')) {
    return { label: exact[action] ?? `${action} komutunu kullandı`, area: 'Komut' };
  }
  const [prefix = '', ...rest] = action.split(':');
  const area = areas[prefix] ?? prefix;
  const verb = rest.find((part) => part !== '#') ?? '';
  const key = `${prefix}:${verb}`;
  if (exact[key]) return { label: exact[key]!, area };
  // Modals are numbered per session (`setup-modal:2`): the number is not meaningful.
  if (/-modal$|threshold/.test(prefix) || /^\d+$/.test(verb)) {
    return { label: prefix.startsWith('setup') ? 'Steam profil formunu gönderdi' : 'Panelde bir formu gönderdi', area };
  }
  if (prefix === 'support') {
    const support: Readonly<Record<string, string>> = {
      open: 'Destek talebi formunu açtı', submit: 'Destek talebi gönderdi', close: 'Destek talebini kapattı',
    };
    return { label: support[verb] ?? 'Destek düğmesine bastı', area };
  }
  return { label: verbs[verb] ?? (verb ? `${verb} düğmesine bastı` : action), area };
}
