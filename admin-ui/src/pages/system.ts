import { html, useEffect, useState, type VNode } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useAction } from '../actions.js';
import { bytes, dateTime, duration, num, relative } from '../format.js';
import type { RuntimeSettings, SystemInfo } from '../types.js';
import {
  Badge, Card, ErrorBox, Facts, Loading, Page, When, useAsync, useTicker, RefreshButton, live,
} from '../ui.js';
import { SchedulerFacts } from './overview.js';
import { Icon } from '../icons.js';

const phaseNames: Record<string, string> = {
  starting: 'Başlıyor', ready: 'Hazır', stopping: 'Duruyor', stopped: 'Durdu', failed: 'Hata',
};

function enabled(value: boolean): VNode {
  return value ? Badge({ tone: 'good', label: 'Açık' }) : Badge({ tone: 'neutral', label: 'Kapalı' });
}

function SettingsForm(props: { settings: RuntimeSettings; userCount: number | null; onSaved: () => void }): VNode {
  const { busy, run } = useAction();
  const [maxUsers, setMaxUsers] = useState(String(props.settings.maxUsersOverride ?? ''));
  const [presence, setPresence] = useState(props.settings.presenceText ?? '');
  useEffect(() => {
    setMaxUsers(String(props.settings.maxUsersOverride ?? ''));
    setPresence(props.settings.presenceText ?? '');
  }, [props.settings.maxUsersOverride, props.settings.presenceText]);
  const save = (body: unknown, message: string): void => {
    void run('settings', '/api/settings', body, message).then((result) => { if (result !== null) props.onSaved(); });
  };
  const parsed = maxUsers.trim() === '' ? null : Number(maxUsers);
  const validLimit = parsed === null || (Number.isSafeInteger(parsed) && parsed >= 1);
  return html`
    <div class="settings">
      <div class="setting-row">
        <div><strong>Yeni kayıtlar</strong>
          <p class="muted small">Kapalıyken /setup “Dealio şu an dolu” der; mevcut kullanıcılar etkilenmez.</p></div>
        <button class=${`switch ${props.settings.signupsOpen ? 'on' : ''}`} role="switch" aria-checked=${props.settings.signupsOpen} disabled=${busy !== null}
          onClick=${() => save({ signupsOpen: !props.settings.signupsOpen }, props.settings.signupsOpen ? 'Kayıtlar kapatıldı' : 'Kayıtlar açıldı')}>
          ${props.settings.signupsOpen ? 'Açık' : 'Kapalı'}<span class="switch-track" aria-hidden="true"></span></button>
      </div>
      <div class="setting-row">
        <div><strong>Otomatik tarama</strong>
          <p class="muted small">Kapalıyken zamanlanmış taramalar atlanır; bot, komutlar, “Şimdi tara” ve bekleyen uyarılar çalışır.</p></div>
        <button class=${`switch ${props.settings.scansPaused ? '' : 'on'}`} role="switch" aria-checked=${!props.settings.scansPaused} disabled=${busy !== null}
          onClick=${() => save({ scansPaused: !props.settings.scansPaused }, props.settings.scansPaused ? 'Otomatik tarama sürdürüldü' : 'Otomatik tarama duraklatıldı')}>
          ${props.settings.scansPaused ? 'Kapalı' : 'Açık'}<span class="switch-track" aria-hidden="true"></span></button>
      </div>
      <div class="setting-row">
        <div><strong>Kullanıcı sınırı</strong>
          <p class="muted small">${[
            `${props.settings.maxUsers === null ? 'Şu an sınır yok' : `Şu an ${num(props.settings.maxUsers)}`}${props.userCount !== null ? ` (${num(props.userCount)} kayıtlı)` : ''}.`,
            props.settings.defaultMaxUsers === null ? 'Boş bırakırsan sınır olmaz.' : `Boş bırakırsan ortam değeri (${num(props.settings.defaultMaxUsers)}) geçerli.`,
            'Bir sayı girersen kayıtlar o sayıda durur; bellek dolmaya başlarsa acil fren olarak kullan.',
          ].join(' ')}</p></div>
        <div class="inline-form">
          <input class="input narrow" inputMode="numeric" placeholder=${props.settings.defaultMaxUsers === null ? 'sınırsız' : String(props.settings.defaultMaxUsers)} value=${maxUsers}
            aria-label="Kullanıcı sınırı" onInput=${(event: Event) => setMaxUsers((event.target as HTMLInputElement).value)} />
          <button class="btn" disabled=${busy !== null || !validLimit || parsed === props.settings.maxUsersOverride}
            onClick=${() => save({ maxUsers: parsed }, 'Kullanıcı sınırı kaydedildi')}>Kaydet</button>
        </div>
      </div>
      <div class="setting-row">
        <div><strong>Bot durum metni</strong>
          <p class="muted small">Discord’da botun adının altında görünür (en fazla 128 karakter). Boş = yok.</p></div>
        <div class="inline-form">
          <input class="input" maxLength="128" placeholder="ör. Steam indirimlerini izliyor" value=${presence}
            aria-label="Bot durum metni" onInput=${(event: Event) => setPresence((event.target as HTMLInputElement).value)} />
          <button class="btn" disabled=${busy !== null || presence.trim() === (props.settings.presenceText ?? '')}
            onClick=${() => save({ presenceText: presence.trim() || null }, 'Durum metni güncellendi')}>Kaydet</button>
        </div>
      </div>
    </div>`;
}

/** The owner's own username and password; only a hash is stored on the server. */
function OwnerAccount(): VNode {
  const account = useAsync(() => api.get<{ username: string | null }>('/api/account'), []);
  const { busy, run } = useAction();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const current = account.data?.username ?? null;
  useEffect(() => { setUsername(current ?? ''); }, [current]);
  const mismatch = repeat.length > 0 && password !== repeat;
  const ready = username.trim().length >= 3 && password.length >= 10 && password === repeat;
  const save = (): void => {
    void run('account', '/api/account/credentials', { username: username.trim(), password },
      'Giriş bilgileri kaydedildi; diğer oturumlar kapatıldı').then((result) => {
      if (result === null) return;
      setPassword('');
      setRepeat('');
      account.reload();
    });
  };
  const clear = (): void => {
    void run('account-clear', '/api/account/credentials/clear', {}, 'Şifre kaldırıldı; giriş yönetici anahtarıyla yapılır')
      .then((result) => { if (result !== null) account.reload(); });
  };
  return html`
    <div class="settings">
      <div class="setting-row">
        <div><strong>Durum</strong>
          <p class="muted small">${current
            ? html`Giriş ekranı kullanıcı adı ve şifre ister. Kullanıcı adı: <code>${current}</code>.`
            : 'Henüz şifre yok; giriş ekranı yönetici anahtarını ister.'}${' '}
            Masaüstü kısayolu her durumda çalışır; şifreyi unutursan onunla girip yenisini belirle.</p></div>
        ${current ? html`<button class="btn" disabled=${busy !== null} onClick=${clear}>Şifreyi kaldır</button>` : null}
      </div>
      <div class="setting-row">
        <div><strong>${current ? 'Kullanıcı adı ve şifreyi değiştir' : 'Kullanıcı adı ve şifre belirle'}</strong>
          <p class="muted small">Şifre en az 10 karakter. Sunucuda yalnız şifrenin özeti (scrypt) saklanır.</p></div>
        <div class="inline-form">
          <input class="input" autocomplete="username" placeholder="Kullanıcı adı" aria-label="Kullanıcı adı" value=${username}
            onInput=${(event: Event) => setUsername((event.target as HTMLInputElement).value)} />
          <input class="input" type="password" autocomplete="new-password" placeholder="Yeni şifre" aria-label="Yeni şifre" value=${password}
            onInput=${(event: Event) => setPassword((event.target as HTMLInputElement).value)} />
          <input class="input" type="password" autocomplete="new-password" placeholder="Şifre tekrar" aria-label="Şifre tekrar" value=${repeat}
            onInput=${(event: Event) => setRepeat((event.target as HTMLInputElement).value)} />
          <button class="btn btn-primary" disabled=${busy !== null || !ready} onClick=${save}>Kaydet</button>
        </div>
      </div>
      ${mismatch ? html`<p class="form-error" role="alert">${Icon({ name: 'alert' })}Şifreler aynı değil.</p>` : null}
    </div>`;
}

export function SystemPage(): VNode {
  const state = useAsync(() => api.get<SystemInfo>('/api/system'), [], live);
  const { busy, run } = useAction();
  useTicker(15_000);
  const data = state.data;
  return Page({
    title: 'Sistem',
    actions: html`
      <button class="btn" disabled=${busy !== null || data?.scheduler.running === true}
        onClick=${() => run('scan', '/api/system/scan-now', {}, 'Tam tarama başladı').then(() => setTimeout(state.reload, 800))}>${Icon({ name: 'refresh' })}Şimdi tara</button>
      <button class="btn" disabled=${busy !== null}
        onClick=${() => run('retry', '/api/system/retry-now', {}, 'Bekleyen bildirimler denendi').then(state.reload)}>${Icon({ name: 'send' })}Bildirimleri şimdi dene</button>
      <${RefreshButton} state=${state} />`,
    children: !data
      ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading())
      : html`
        ${Card({ title: 'Çalışma zamanı ayarları', subtitle: 'Botu yeniden başlatmadan uygulanır', children: html`<${SettingsForm} settings=${data.runtimeSettings} userCount=${null} onSaved=${state.reload} />` })}
        ${Card({ title: 'Panel girişi', subtitle: 'Sana ait kullanıcı adı ve şifre', children: html`<${OwnerAccount} />` })}
        <div class="grid-3">
          ${Card({ title: 'Çalışma durumu', children: Facts({ rows: [
            ['Aşama', data.health
              ? Badge({ tone: data.health.phase === 'ready' ? 'good' : data.health.phase === 'failed' ? 'bad' : 'warn',
                label: phaseNames[data.health.phase] ?? data.health.phase })
              : Badge({ tone: 'neutral', label: 'Sağlık dosyası yok (geliştirme)' })],
            ['Discord', data.discord.ready ? Badge({ tone: 'good', label: 'Bağlı' }) : Badge({ tone: 'bad', label: 'Bağlı değil' })],
            ['Gecikme', data.discord.pingMs === null ? '—' : `${num(data.discord.pingMs)} ms`],
            ['Başladı', data.health ? dateTime(data.health.startedAt) : '—'],
            ['Hazır oldu', When({ at: data.health?.readyAt ?? null })],
            ['Son nabız', When({ at: data.health?.heartbeatAt ?? null })],
          ] }) })}
          ${Card({ title: 'Süreç', children: Facts({ rows: [
            ['PID', String(data.process.pid)],
            ['Node.js', data.process.node],
            ['Platform', data.process.platform],
            ['Çalışma süresi', duration(data.process.uptimeSeconds * 1000)],
            ['Bellek (RSS)', bytes(data.process.rssBytes)],
            ['Heap', `${bytes(data.process.heapUsedBytes)} / ${bytes(data.process.heapTotalBytes)}`],
            ['Harici', bytes(data.process.externalBytes)],
          ] }) })}
          ${Card({ title: 'Veritabanı', children: Facts({ rows: [
            ['Dosya', html`<code class="small">${data.database.path}</code>`],
            ['Boyut', bytes(data.database.sizeBytes)],
            ['WAL', bytes(data.database.walBytes)],
            ['Şema sürümü', `v${data.database.schemaVersion}`],
            ['Silme günlüğü', `${num(data.deletionsKept)} kayıt (35 gün)`],
          ] }) })}
        </div>
        <div class="grid-2">
          ${Card({ title: 'Tarayıcı', children: SchedulerFacts({ scheduler: data.scheduler }) })}
          ${Card({ title: 'Yapılandırma', children: Facts({ rows: [
            ['Tarama aralığı', duration(data.settings.pollIntervalHours * 3_600_000)],
            ['Yeniden deneme', `${num(data.settings.notificationRetryIntervalSeconds)} sn`],
            ['Fiyat geçmişi (ITAD)', enabled(data.settings.priceHistoryEnabled)],
            ['Steam vanity çözümleme', enabled(data.settings.steamVanityEnabled)],
            ['Üretim modu', enabled(data.settings.production)],
          ] }) })}
        </div>
        ${Card({ title: 'Engellenen kullanıcılar', children: data.blockedUsers.length === 0
          ? html`<p class="empty">Engellenen kullanıcı yok.</p>`
          : html`<ul class="list">${data.blockedUsers.map((block) => html`<li>
              <a href=${`#/users/${block.discordUserId}`}><code>${block.discordUserId}</code></a>
              <span class="muted small">${block.reason ?? 'sebep yok'} · ${When({ at: block.blockedAt })}</span>
              <button class="btn btn-small" disabled=${busy !== null}
                onClick=${() => run('unblock', `/api/users/${block.discordUserId}/unblock`, {}, 'Engel kaldırıldı').then(state.reload)}>Engeli kaldır</button></li>`)}</ul>` })}`,
  });
}
