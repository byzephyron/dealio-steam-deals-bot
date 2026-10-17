import { html, type VNode } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { dateTime, relative } from '../format.js';
import type { AuditEntry } from '../types.js';
import {
  Badge, DataTable, ErrorBox, Loading, Page, useAsync, type Column, RefreshButton, live,
} from '../ui.js';

export const auditActionNames: Readonly<Record<string, string>> = {
  'user.pause': 'İzleme durduruldu',
  'user.resume': 'İzleme açıldı',
  'user.check': 'Elle kontrol',
  'user.test-alert': 'Test uyarısı',
  'user.region': 'Bölge değişti',
  'user.language': 'Dil değişti',
  'user.block': 'Kullanıcı engellendi',
  'user.unblock': 'Kullanıcı engeli kalktı',
  'user.delete': 'Veriler silindi',
  'user.message': 'DM gönderildi',
  'broadcast.create': 'Duyuru başlatıldı',
  'broadcast.pause': 'Duyuru duraklatıldı',
  'broadcast.resume': 'Duyuru sürdürüldü',
  'broadcast.cancel': 'Duyuru iptal edildi',
  'guild.leave': 'Sunucudan çıkıldı',
  'guild.block': 'Sunucu engellendi',
  'guild.unblock': 'Sunucu engeli kalktı',
  'system.scan-now': 'Tarama başlatıldı',
  'system.retry-now': 'Yeniden deneme çalıştı',
  'system.settings': 'Ayarlar değişti',
  'system.restart': 'Bot yeniden başlatıldı',
  'system.stop': 'Bot durduruldu',
};

function targetLink(entry: AuditEntry): VNode | string {
  if (!entry.target) return '—';
  if (entry.action.startsWith('user.')) return html`<a href=${`#/users/${entry.target}`}>${entry.target}</a>`;
  if (entry.action.startsWith('guild.')) return html`<a href=${`#/guilds/${entry.target}`}>${entry.target}</a>`;
  if (entry.action.startsWith('broadcast.')) return html`<a href=${`#/announcements/${entry.target}`}>${entry.target.slice(0, 8)}</a>`;
  return entry.target;
}

export const auditColumns: Column<AuditEntry>[] = [
  { key: 'time', label: 'Zaman', render: (entry) => html`<span title=${dateTime(entry.occurredAt)}>${relative(entry.occurredAt)}</span>`,
    sort: (entry) => entry.occurredAt, csv: (entry) => entry.occurredAt },
  { key: 'action', label: 'İşlem', render: (entry) => auditActionNames[entry.action] ?? entry.action,
    sort: (entry) => entry.action, csv: (entry) => entry.action },
  { key: 'outcome', label: 'Sonuç', render: (entry) => entry.outcome === 'ok'
    ? Badge({ tone: 'good', label: 'Tamam' }) : Badge({ tone: 'bad', label: 'Başarısız' }),
    sort: (entry) => entry.outcome, csv: (entry) => entry.outcome },
  { key: 'target', label: 'Hedef', render: targetLink, csv: (entry) => entry.target },
  { key: 'detail', label: 'Ayrıntı', render: (entry) => html`<span class="muted small wrap">${entry.detail ?? ''}</span>`,
    csv: (entry) => entry.detail, hideOnMobile: true },
];

export function AuditTable(props: { entries: AuditEntry[]; csvName?: string }): VNode {
  return html`<${DataTable} columns=${auditColumns} rows=${props.entries} rowKey=${(entry: AuditEntry) => String(entry.id)}
    initialSort=${{ key: 'time', direction: 'desc' }} pageSize=${25} empty="Henüz işlem yok."
    ...${props.csvName ? { csvName: props.csvName, search: (entry: AuditEntry) => `${entry.action} ${entry.target ?? ''} ${entry.detail ?? ''}`,
      searchPlaceholder: 'İşlem, hedef veya ayrıntı ara…' } : {}} />`;
}

export function AuditPage(): VNode {
  const state = useAsync(() => api.get<{ entries: AuditEntry[] }>('/api/audit'), [], live);
  return Page({
    title: 'Denetim kaydı',
    subtitle: 'Bu panelden yapılan her işlem (başarılı ya da değil) bir yıl saklanır.',
    actions: html`<${RefreshButton} state=${state} />`,
    children: !state.data
      ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading())
      : html`<div class="card card-flush"><${AuditTable} entries=${state.data.entries} csvName="dealio-denetim" /></div>`,
  });
}
