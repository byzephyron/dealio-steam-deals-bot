import { html, useEffect, useState, type VNode } from './vendor/preact-htm.js';
import { api } from './api.js';
import { ConfirmDialog, useAction } from './actions.js';
import { Icon, type IconName } from './icons.js';
import type { Overview } from './types.js';

type Pending = 'restart' | 'stop' | null;

/**
 * Shown after a restart or stop: the panel lives inside the bot process, so it
 * goes away too. It polls until the bot answers again and then reloads, which
 * lands on the sign-in screen (sessions do not survive a restart).
 */
function ExitScreen(props: { mode: 'restart' | 'stop' }): VNode {
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setWaited(Math.round((Date.now() - started) / 1000));
      void api.get('/api/login-options').then(() => {
        // Still the old process for the first moment after the request.
        if (Date.now() - started > 4_000) window.location.reload();
      }, () => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, []);
  const restart = props.mode === 'restart';
  const late = restart && waited > 90;
  return html`<div class="dialog-backdrop exit-screen" role="alertdialog" aria-live="assertive">
    <section class="dialog card">
      <header class="card-head"><h2>${restart ? 'Bot yeniden başlatılıyor' : 'Bot durduruldu'}</h2></header>
      ${restart ? html`
        <p class="dialog-message">${late
          ? 'Bot 90 saniyedir geri gelmedi. VM’de sudo journalctl -u dealio -n 50 ile nedenine bak.'
          : 'Bot kapanıp birkaç saniye içinde yeniden açılacak. Hazır olunca bu sayfa kendini yenileyip giriş ekranına döner.'}</p>
        <p class="exit-wait">${late ? null : html`<span class="spinner" aria-hidden="true"></span>`}${waited} sn</p>`
      : html`
        <p class="dialog-message">Bot ve bu panel kapandı. Kullanıcılara uyarı gitmez, komutlar cevap vermez.
          Yeniden açmak için VM’de şunu çalıştır:</p>
        <pre class="exit-command"><code>sudo systemctl start dealio</code></pre>
        <p class="muted small">Bot yeniden açılırsa bu sayfa kendini yeniler.</p>`}
    </section>
  </div>`;
}

function Control(props: { icon: IconName; title: string; detail: string; children: unknown; tone?: 'danger' }): VNode {
  return html`<div class=${`control ${props.tone === 'danger' ? 'control-danger' : ''}`}>
    <span class="control-icon">${Icon({ name: props.icon, size: 18 })}</span>
    <div class="control-text"><strong>${props.title}</strong><span class="muted small">${props.detail}</span></div>
    <div class="control-action">${props.children}</div>
  </div>`;
}

/** The owner's levers on the overview: scan, retry, pause scans, restart, stop. */
export function BotControls(props: { data: Overview; onChanged: () => void }): VNode {
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState<Pending>(null);
  const [exited, setExited] = useState<Pending>(null);
  const { scheduler, counts } = props.data;
  const paused = props.data.settings.scansPaused === true;
  const queued = counts.queuePending + counts.queueRetry + counts.queueSending;

  const exit = (mode: 'restart' | 'stop', confirmValue: string): void => {
    void run(mode, `/api/system/${mode}`, { confirm: confirmValue },
      mode === 'restart' ? 'Yeniden başlatma isteği alındı' : 'Durdurma isteği alındı').then((result) => {
      setConfirm(null);
      if (result !== null) setExited(mode);
    });
  };

  return html`
    <section class="card controls-card" aria-label="Bot kontrolü">
      <header class="card-head"><h2>Bot kontrolü<span class="card-sub">Her işlem Denetim’e yazılır</span></h2>
        ${paused ? html`<span class="badge badge-warn"><span class="badge-dot" aria-hidden="true"></span>Otomatik tarama duraklatıldı</span>` : null}</header>
      <div class="controls">
        ${Control({ icon: 'refresh', title: 'Şimdi tara', detail: scheduler.running
          ? 'Bir tarama zaten sürüyor.' : 'Tüm aktif kullanıcıların wishlist’ini hemen kontrol eder ve uyarıları gönderir.',
          children: html`<button class="btn" disabled=${busy !== null || scheduler.running}
            onClick=${() => run('scan', '/api/system/scan-now', {}, 'Tarama başladı').then(() => setTimeout(props.onChanged, 800))}>Tara</button>` })}
        ${Control({ icon: 'send', title: 'Bekleyen uyarıları gönder', detail: queued > 0
          ? `Kuyrukta ${queued} uyarı var; sıradaki denemeyi beklemeden gönderir.` : 'Kuyruk boş; gönderilmeyi bekleyen uyarı yok.',
          children: html`<button class="btn" disabled=${busy !== null}
            onClick=${() => run('retry', '/api/system/retry-now', {}, 'Bekleyen uyarılar denendi').then(props.onChanged)}>Gönder</button>` })}
        ${Control({ icon: 'pause', title: paused ? 'Otomatik taramayı sürdür' : 'Otomatik taramayı duraklat',
          detail: paused
            ? 'Zamanlanmış taramalar atlanıyor. Bot, komutlar ve bekleyen uyarılar çalışmaya devam ediyor.'
            : 'Steam sorun çıkarırken ya da bakımda taramaları durdurur; bot açık kalır, “Şimdi tara” yine çalışır.',
          children: html`<button class=${`switch ${paused ? '' : 'on'}`} role="switch" aria-checked=${!paused}
            aria-label="Otomatik tarama" disabled=${busy !== null}
            onClick=${() => run('pause', '/api/settings', { scansPaused: !paused },
              paused ? 'Otomatik tarama sürdürüldü' : 'Otomatik tarama duraklatıldı').then(props.onChanged)}>
            ${paused ? 'Kapalı' : 'Açık'}<span class="switch-track" aria-hidden="true"></span></button>` })}
        ${Control({ icon: 'power', title: 'Yeniden başlat', detail: 'Botu düzgünce kapatıp birkaç saniyede yeniden açar. Panel oturumun kapanır.',
          children: html`<button class="btn" disabled=${busy !== null} onClick=${() => setConfirm('restart')}>Yeniden başlat</button>` })}
        ${Control({ icon: 'stop', title: 'Durdur', tone: 'danger',
          detail: 'Botu tamamen kapatır; panel de kapanır. Yeniden açmak için VM’ye SSH ile bağlanman gerekir.',
          children: html`<button class="btn btn-danger" disabled=${busy !== null} onClick=${() => setConfirm('stop')}>Durdur</button>` })}
      </div>
    </section>
    ${confirm === 'restart' ? html`<${ConfirmDialog} title="Bot yeniden başlatılsın mı?" confirmLabel="Yeniden başlat"
      busy=${busy !== null} onClose=${() => setConfirm(null)} onConfirm=${() => exit('restart', 'restart')}
      message=${html`<p>Sürmekte olan kontroller bitirilir, bot kapanır ve systemd onu birkaç saniye içinde yeniden açar.
        Bu sırada komutlar kısa süre cevap vermez.</p><p>Panel oturumun kapanır; sonra yeniden giriş yaparsın.</p>`} />` : null}
    ${confirm === 'stop' ? html`<${ConfirmDialog} title="Bot durdurulsun mu?" confirmLabel="Botu durdur" danger typeToConfirm="DURDUR"
      busy=${busy !== null} onClose=${() => setConfirm(null)} onConfirm=${() => exit('stop', 'DURDUR')}
      message=${html`<p>Bot tamamen kapanır: tarama yapılmaz, uyarı gitmez, komutlar cevap vermez. Healthchecks de sana “bot kapalı” uyarısı gönderir.</p>
        <p>Bu panel de botun içinde çalıştığı için kapanır. Yeniden açmak için VM’de <code>sudo systemctl start dealio</code> çalıştırman gerekir.</p>
        <p>Kısa bir ara için “Otomatik taramayı duraklat” ya da “Yeniden başlat” genelde yeterlidir.</p>`} />` : null}
    ${exited ? html`<${ExitScreen} mode=${exited} />` : null}`;
}
