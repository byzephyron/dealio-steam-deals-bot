import { html, useEffect, useState, type VNode } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { ConfirmDialog, useAction } from '../actions.js';
import { AnnouncementEditor, editorLanguages, filledLanguages, type Content } from '../announcement-editor.js';
import { dateTime, displayName, languageNames, num, relative } from '../format.js';
import { useRowProfiles } from '../profiles.js';
import type { Broadcast, BroadcastRecipient, RecipientStatus } from '../types.js';
import {
  BackLink, Badge, Card, DataTable, ErrorBox, Facts, Loading, Page, Spinner, When, useApi, type Column, type Tone, RefreshButton, live,
} from '../ui.js';
import { UserCell } from './users.js';
import { Icon } from '../icons.js';

const statusNames: Record<string, { tone: Tone; label: string }> = {
  sending: { tone: 'info', label: 'Gönderiliyor' },
  paused: { tone: 'warn', label: 'Duraklatıldı' },
  completed: { tone: 'good', label: 'Tamamlandı' },
  cancelled: { tone: 'neutral', label: 'İptal edildi' },
  pending: { tone: 'info', label: 'Sırada' },
  sent: { tone: 'good', label: 'Gönderildi' },
  failed: { tone: 'warn', label: 'Tekrar denenecek' },
  skipped: { tone: 'bad', label: 'Gönderilemedi' },
};

export function BroadcastStatusBadge(props: { status: string }): VNode {
  return Badge(statusNames[props.status] ?? { tone: 'neutral', label: props.status });
}

function audienceText(broadcast: Broadcast): string {
  const audience = broadcast.audience;
  if (audience.userIds) return audience.userIds.length === 1 ? 'Tek kullanıcı (DM)' : `${num(audience.userIds.length)} kullanıcı`;
  const parts = [audience.onlyEnabled ? 'İzlemesi açık olanlar' : 'Tüm kullanıcılar'];
  if (audience.languages) parts.push(audience.languages.map((language) => languageNames[language] ?? language).join(', '));
  if (audience.countries) parts.push(audience.countries.join(', '));
  return parts.join(' · ');
}

function titleOf(broadcast: Broadcast): string {
  return (broadcast.content.tr ?? broadcast.content.en ?? Object.values(broadcast.content)[0])?.title ?? '—';
}

function Progress(props: { broadcast: Broadcast }): VNode {
  const { counts, recipientCount } = props.broadcast;
  const done = counts.sent + counts.skipped;
  const ratio = recipientCount === 0 ? 1 : done / recipientCount;
  return html`<span class="progress" title=${`${counts.sent} gönderildi, ${counts.skipped} gönderilemedi, ${counts.pending + counts.failed + counts.sending} bekliyor`}>
    <span class="meter"><span style=${`width:${ratio * 100}%`}></span></span>
    <small>${num(counts.sent)}/${num(recipientCount)}${counts.skipped > 0 ? ` · ${num(counts.skipped)} hata` : ''}</small>
  </span>`;
}

function Composer(props: { onSent: () => void }): VNode {
  const [content, setContent] = useState<Content>({});
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [languages, setLanguages] = useState<string[]>([]);
  const [countries, setCountries] = useState('');
  const [preview, setPreview] = useState<{ count: number; byLanguage: Record<string, number> } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useAction();
  const audience = {
    onlyEnabled,
    ...(languages.length > 0 ? { languages } : {}),
    ...(countries.trim() ? { countries: countries.toUpperCase().split(/[\s,]+/).filter((code) => /^[A-Z]{2}$/.test(code)) } : {}),
  };
  const audienceKey = JSON.stringify(audience);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api.post<{ count: number; byLanguage: Record<string, number> }>('/api/broadcasts/preview', { audience })
        .then((result) => { if (active) setPreview(result); }, () => undefined);
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [audienceKey]);
  const filled = filledLanguages(content);
  const missing = preview ? Object.entries(preview.byLanguage)
    .filter(([language, count]) => count > 0 && !filled.includes(language as 'tr')).map(([language]) => language) : [];

  return Card({
    title: 'Yeni duyuru',
    children: html`
      <${AnnouncementEditor} value=${content} onChange=${setContent} />
      <h3 class="sub-head">Kime</h3>
      <div class="audience">
        <label class="check"><input type="checkbox" checked=${onlyEnabled}
          onChange=${(event: Event) => setOnlyEnabled((event.target as HTMLInputElement).checked)} /> Yalnız izlemesi açık olanlar</label>
        <div class="chips">${editorLanguages.map((language) => html`<label class="chip-check">
          <input type="checkbox" checked=${languages.includes(language)} onChange=${(event: Event) => {
            const checked = (event.target as HTMLInputElement).checked;
            setLanguages(checked ? [...languages, language] : languages.filter((item) => item !== language));
          }} /> ${languageNames[language]}</label>`)}</div>
        <label class="field">Bölgeler (boş = hepsi) <input class="input" placeholder="TR, DE, US" value=${countries}
          onInput=${(event: Event) => setCountries((event.target as HTMLInputElement).value)} /></label>
      </div>
      <p class="note">${Icon({ name: 'info' })}<span>Yalnız kurulumu tamamlamış (DM almayı kabul etmiş), engellenmemiş ve DM’i kapalı olmayan kullanıcılar alır.</span></p>
      <div class="composer-foot">
        <span class="reach"><span class="reach-icon">${Icon({ name: 'users', size: 17 })}</span><span>${preview ? html`<strong>${num(preview.count)}</strong> kişiye gidecek${' '}
          <small class="muted">(${Object.entries(preview.byLanguage).filter(([, count]) => count > 0)
            .map(([language, count]) => `${languageNames[language] ?? language} ${count}`).join(' · ') || '—'})</small>` : 'Hesaplanıyor…'}</span></span>
        ${missing.length > 0 && filled.length > 0 ? html`<span class="muted small">${missing.map((language) => languageNames[language]).join(', ')}
          okurları ${filled.includes('en') ? 'İngilizce' : languageNames[filled[0]!]} metni görecek.</span>` : null}
        <span class="toolbar-spacer"></span>
        <button class="btn btn-primary" disabled=${filled.length === 0 || !preview || preview.count === 0 || busy !== null}
          onClick=${() => setConfirming(true)}>${Icon({ name: 'send' })}Gönder…</button>
      </div>
      ${confirming ? html`<${ConfirmDialog} title="Duyuruyu gönder" confirmLabel="Gönderimi başlat" typeToConfirm="GÖNDER"
        busy=${busy === 'send'}
        message=${html`<p><strong>${num(preview?.count ?? 0)}</strong> kişiye DM olarak gidecek (yaklaşık ${Math.ceil((preview?.count ?? 0) * 1.5 / 60)} dakika). Gönderim sürerken duraklatabilir veya iptal edebilirsin.</p>
          <p class="muted small">Discord, istenmeyen toplu DM’leri spam sayabilir; duyuruları servisle ilgili ve seyrek tut.</p>`}
        onClose=${() => setConfirming(false)}
        onConfirm=${(input: { confirm: string }) => run('send', '/api/broadcasts', { content, audience, confirm: input.confirm },
          'Duyuru gönderimi başladı').then((result) => {
            if (result !== null) {
              setConfirming(false);
              setContent({});
              props.onSent();
            }
          })} />` : null}`,
  });
}

export function BroadcastControls(props: { broadcast: Broadcast; onChanged: () => void }): VNode {
  const { busy, run } = useAction();
  const set = (status: string, success: string): void => {
    void run(status, `/api/broadcasts/${props.broadcast.broadcastId}/status`, { status }, success).then((result) => {
      if (result !== null) props.onChanged();
    });
  };
  const { status } = props.broadcast;
  if (status === 'completed' || status === 'cancelled') return html`<span></span>`;
  return html`<span class="row-actions" onClick=${(event: Event) => event.stopPropagation()}>
    ${status === 'sending'
      ? html`<button class="btn btn-small" disabled=${busy !== null} onClick=${() => set('paused', 'Duraklatıldı')}>${Icon({ name: 'pause', size: 14 })}Duraklat</button>`
      : html`<button class="btn btn-small" disabled=${busy !== null} onClick=${() => set('sending', 'Sürdürülüyor')}>${Icon({ name: 'play', size: 14 })}Sürdür</button>`}
    <button class="btn btn-small btn-danger" disabled=${busy !== null} onClick=${() => set('cancelled', 'İptal edildi')}>${Icon({ name: 'x', size: 14 })}İptal</button>
  </span>`;
}

export function AnnouncementsPage(): VNode {
  const state = useApi<{ broadcasts: Broadcast[] }>('/api/broadcasts', live);
  const sending = state.data?.broadcasts.some((broadcast) => broadcast.status === 'sending') ?? false;
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(state.refresh, 3000);
    return () => clearInterval(timer);
  }, [sending]);
  const columns: Column<Broadcast>[] = [
    { key: 'title', label: 'Duyuru', render: (broadcast) => html`<strong>${titleOf(broadcast)}</strong>
      <small class="muted block">${Object.keys(broadcast.content).map((language) => language.toUpperCase()).join(' · ')}</small>`,
      csv: (broadcast) => titleOf(broadcast) },
    { key: 'audience', label: 'Kime', render: audienceText, csv: audienceText, hideOnMobile: true },
    { key: 'status', label: 'Durum', render: (broadcast) => BroadcastStatusBadge({ status: broadcast.status }),
      csv: (broadcast) => broadcast.status },
    { key: 'progress', label: 'İlerleme', render: (broadcast) => Progress({ broadcast }), csv: (broadcast) => broadcast.counts.sent },
    { key: 'created', label: 'Başladı', render: (broadcast) => html`<span title=${dateTime(broadcast.createdAt)}>${relative(broadcast.createdAt)}</span>`,
      sort: (broadcast) => broadcast.createdAt, csv: (broadcast) => broadcast.createdAt },
    { key: 'controls', label: '', render: (broadcast) => html`<${BroadcastControls} broadcast=${broadcast} onChanged=${state.reload} />` },
  ];
  return Page({
    title: 'Duyurular',
    actions: html`<${RefreshButton} state=${state} />`,
    subtitle: 'Kullanıcılara DM ile duyuru. Alıcılar Discord’a gönderilmeden önce kaydedilir; gönderim 1,5 saniyede bir mesaj hızındadır.',
    children: html`
      <${Composer} onSent=${state.reload} />
      ${Card({ title: 'Geçmiş', class: 'card-flush', children: !state.data
        ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Spinner())
        : html`<${DataTable} columns=${columns} rows=${state.data.broadcasts} rowKey=${(broadcast: Broadcast) => broadcast.broadcastId}
            onRow=${(broadcast: Broadcast) => { window.location.hash = `/announcements/${broadcast.broadcastId}`; }}
            initialSort=${{ key: 'created', direction: 'desc' }} empty="Henüz duyuru yok." />` })}`,
  });
}

export function AnnouncementDetailPage(props: { id: string }): VNode {
  const state = useApi<{ broadcast: Broadcast; recipients: BroadcastRecipient[] }>(`/api/broadcasts/${props.id}`, live);
  const data = state.data;
  const profiles = useRowProfiles((data?.recipients ?? []).map((row) => ({ id: row.discordUserId, profile: row.profile })));
  useEffect(() => {
    if (data?.broadcast.status !== 'sending') return;
    const timer = setInterval(state.refresh, 3000);
    return () => clearInterval(timer);
  }, [data?.broadcast.status]);
  const columns: Column<BroadcastRecipient>[] = [
    { key: 'user', label: 'Kullanıcı', render: (row) => html`<a href=${`#/users/${row.discordUserId}`}>${UserCell({ id: row.discordUserId, profile: profiles.get(row.discordUserId) })}</a>`,
      sort: (row) => displayName(profiles.get(row.discordUserId), row.discordUserId), csv: (row) => row.discordUserId },
    { key: 'language', label: 'Dil', render: (row) => row.language.toUpperCase(), csv: (row) => row.language },
    { key: 'status', label: 'Durum', render: (row) => BroadcastStatusBadge({ status: row.status }), sort: (row) => row.status,
      csv: (row) => row.status },
    { key: 'attempts', label: 'Deneme', align: 'end', render: (row) => num(row.attemptCount), csv: (row) => row.attemptCount },
    { key: 'error', label: 'Hata', render: (row) => row.lastError ? html`<code class="small">${row.lastError}</code>` : '',
      csv: (row) => row.lastError, hideOnMobile: true },
    { key: 'updated', label: 'Güncellendi', render: (row) => When({ at: row.updatedAt }), sort: (row) => row.updatedAt, csv: (row) => row.updatedAt },
  ];
  return Page({
    title: data ? titleOf(data.broadcast) : 'Duyuru',
    actions: html`${BackLink({ href: '#/announcements', label: 'Duyurular' })}<${RefreshButton} state=${state} />`,
    children: !data
      ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading())
      : html`
        <div class="grid-2">
          ${Card({ title: 'Durum', actions: html`<${BroadcastControls} broadcast=${data.broadcast} onChanged=${state.reload} />`,
            children: Facts({ rows: [
              ['Durum', BroadcastStatusBadge({ status: data.broadcast.status })],
              ['Kime', audienceText(data.broadcast)],
              ['İlerleme', Progress({ broadcast: data.broadcast })],
              ...((['sent', 'pending', 'failed', 'skipped'] as RecipientStatus[]).map((status): [string, string] =>
                [statusNames[status]!.label, num(data.broadcast.counts[status])])),
              ['Başladı', dateTime(data.broadcast.createdAt)],
              ['Bitti', dateTime(data.broadcast.completedAt)],
            ] }) })}
          ${Card({ title: 'İçerik', children: html`${Object.entries(data.broadcast.content).map(([language, text]) => html`
            <div class="content-block"><span class="badge badge-neutral">${language.toUpperCase()}</span>
              <strong>${text?.title}</strong><p class="pre">${text?.body}</p></div>`)}` })}
        </div>
        ${Card({ title: 'Alıcılar', class: 'card-flush', children: html`<${DataTable} columns=${columns} rows=${data.recipients}
          rowKey=${(row: BroadcastRecipient) => row.discordUserId} csvName=${`dealio-duyuru-${props.id.slice(0, 8)}`}
          search=${(row: BroadcastRecipient) => `${row.discordUserId} ${profiles.get(row.discordUserId)?.username ?? ''}`} />` })}`,
  });
}
