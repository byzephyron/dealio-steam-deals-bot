import { html, useMemo, useState, type VNode } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import {
  checkStatusNames, country, dateTime, day, displayName, flag, languageNames, notificationModeNames, num, trackingNote,
} from '../format.js';
import { checkErrorInfo, checkFixNames, deliveryErrorInfo, type CheckErrorInfo } from '../explain.js';
import { useProfiles } from '../profiles.js';
import { navigate } from '../router.js';
import type { Profile, UserRow } from '../types.js';
import {
  Avatar, Badge, DataTable, ErrorBox, Loading, Page, When, useAsync, type Column, type Tone, RefreshButton, live,
} from '../ui.js';

export function userStatus(row: { enabled: boolean; dmDeliveryBlockedAt: string | null; blocked?: boolean }): { tone: Tone; label: string } {
  if (row.blocked) return { tone: 'bad', label: 'Engellendi' };
  if (row.dmDeliveryBlockedAt) return { tone: 'bad', label: 'DM engelli' };
  if (!row.enabled) return { tone: 'warn', label: 'Duraklatıldı' };
  return { tone: 'good', label: 'Aktif' };
}

export function checkBadge(status: string | null, errorCode: string | null): VNode {
  if (!status) return Badge({ tone: 'neutral', label: 'Hiç' });
  const tone: Tone = status === 'success' ? 'good' : status === 'pending' ? 'info' : status === 'unavailable' ? 'warn' : 'bad';
  const reason = errorCode && status !== 'success' ? checkErrorInfo(errorCode) : null;
  return Badge({ tone, label: checkStatusNames[status] ?? status, ...(reason ? { title: `${reason.title}: ${reason.detail}` } : {}) });
}

function Reason(props: { info: CheckErrorInfo; code: string }): VNode {
  const { info } = props;
  return html`<span class="reason">
    <strong title=${props.code}>${info.title}</strong>
    <span class="muted small">${info.detail}</span>
    <span class="reason-meta">${Badge({ tone: info.fix === 'owner' ? 'bad' : info.fix === 'user' ? 'warn' : 'neutral',
      label: checkFixNames[info.fix] })}</span>
  </span>`;
}

/** Why the last check failed and who can fix it; the stored code is in the tooltip. */
export function CheckReason(props: { code: string }): VNode {
  return Reason({ info: checkErrorInfo(props.code), code: props.code });
}

/** Why Discord refuses this user's alert DMs. */
export function DeliveryReason(props: { error: string | null }): VNode {
  return Reason({ info: deliveryErrorInfo(props.error), code: props.error ?? '' });
}

/**
 * Whether alerts reach the user: a recorded DM block first, then the latest
 * finished alert. A successful wishlist check says nothing about delivery.
 */
function deliveryCell(row: UserRow): VNode {
  if (row.dmDeliveryBlockedAt) {
    const info = deliveryErrorInfo(row.dmDeliveryErrorCode);
    return html`${Badge({ tone: 'bad', label: 'Ulaşılamıyor', title: `${info.title}: ${info.detail}` })}
      <small class="muted block">${info.title}</small>`;
  }
  const last = row.lastDelivery;
  if (!last) return html`<span class="muted">Henüz yok</span>`;
  if (last.status === 'terminal_failed') {
    const info = deliveryErrorInfo(last.error);
    return html`${Badge({ tone: 'bad', label: 'Teslim edilemedi', title: `${info.title}: ${info.detail}` })}
      <small class="muted block">${info.title} · ${When({ at: last.at })}</small>`;
  }
  return html`${Badge({ tone: 'good', label: 'Teslim edildi' })}<small class="muted block">${When({ at: last.at })}</small>`;
}

function deliveryText(row: UserRow): string {
  if (row.dmDeliveryBlockedAt) return `Ulaşılamıyor: ${deliveryErrorInfo(row.dmDeliveryErrorCode).title}`;
  if (!row.lastDelivery) return '';
  return row.lastDelivery.status === 'sent' ? 'Teslim edildi' : `Teslim edilemedi: ${deliveryErrorInfo(row.lastDelivery.error).title}`;
}

export function UserCell(props: { id: string; profile: Profile | null | undefined }): VNode {
  const name = displayName(props.profile, props.profile === undefined ? 'Yükleniyor…' : 'Bilinmeyen kullanıcı');
  return html`<span class="person">
    ${Avatar({ src: props.profile?.avatarUrl ?? null, name })}
    <span><strong>${name}</strong>
      <small class="muted">${props.profile ? `@${props.profile.username}` : props.id}</small></span>
  </span>`;
}

type StatusFilter = 'all' | 'active' | 'paused' | 'blocked' | 'banned' | 'undelivered';
type CheckFilter = 'all' | 'problem' | 'success' | 'unavailable' | 'failed';
const checkFilters: readonly CheckFilter[] = ['all', 'problem', 'success', 'unavailable', 'failed'];

/** `#/users?check=problem` opens the list filtered, e.g. from the overview's check card. */
function initialCheckFilter(search: string): CheckFilter {
  const value = new URLSearchParams(search).get('check');
  return checkFilters.includes(value as CheckFilter) ? value as CheckFilter : 'all';
}

export function UsersPage(props: { search?: string }): VNode {
  const state = useAsync(() => api.get<{ users: UserRow[]; telemetrySince?: string | null }>('/api/users'), [], live);
  const users = state.data?.users ?? [];
  const telemetrySince = state.data?.telemetrySince ?? null;
  const profiles = useProfiles(users.map((user) => user.discordUserId));
  const [status, setStatus] = useState<StatusFilter>('all');
  const [check, setCheck] = useState<CheckFilter>(() => initialCheckFilter(props.search ?? ''));
  const [countryFilter, setCountry] = useState('');
  const [language, setLanguage] = useState('');

  const countries = useMemo(() => [...new Set(users.map((user) => user.storeCountryCode))].sort(), [users]);
  const rows = useMemo(() => users.filter((user) => {
    const label = userStatus(user).label;
    if (status === 'active' && label !== 'Aktif') return false;
    if (status === 'paused' && label !== 'Duraklatıldı') return false;
    if (status === 'blocked' && label !== 'DM engelli') return false;
    if (status === 'banned' && label !== 'Engellendi') return false;
    if (status === 'undelivered' && !user.dmDeliveryBlockedAt && user.lastDelivery?.status !== 'terminal_failed') return false;
    if (check === 'problem' && user.lastCheckStatus !== 'unavailable' && user.lastCheckStatus !== 'failed') return false;
    if (check !== 'all' && check !== 'problem' && user.lastCheckStatus !== check) return false;
    if (countryFilter && user.storeCountryCode !== countryFilter) return false;
    if (language && user.language !== language) return false;
    return true;
  }), [users, status, check, countryFilter, language]);

  const nameOf = (row: UserRow): string => {
    const profile = profiles.get(row.discordUserId);
    return profile ? `${profile.globalName ?? ''} ${profile.username}` : '';
  };
  const columns: Column<UserRow>[] = [
    { key: 'user', label: 'Kullanıcı', render: (row) => UserCell({ id: row.discordUserId, profile: profiles.get(row.discordUserId) }),
      sort: (row) => displayName(profiles.get(row.discordUserId), row.discordUserId).toLocaleLowerCase('tr-TR'),
      csv: (row) => displayName(profiles.get(row.discordUserId), '') },
    { key: 'id', label: 'Discord ID', render: () => null, csv: (row) => row.discordUserId },
    { key: 'username', label: 'Kullanıcı adı', render: () => null, csv: (row) => profiles.get(row.discordUserId)?.username ?? '' },
    { key: 'steam', label: 'SteamID64', render: () => null, csv: (row) => row.steamId64 },
    { key: 'status', label: 'Durum', render: (row) => Badge(userStatus(row)), sort: (row) => userStatus(row).label,
      csv: (row) => userStatus(row).label },
    { key: 'country', label: 'Bölge', render: (row) => html`<span title=${country(row.storeCountryCode)}>${row.storeCountryCode}</span>`,
      sort: (row) => row.storeCountryCode, csv: (row) => row.storeCountryCode },
    { key: 'language', label: 'Dil', render: (row) => row.language.toUpperCase(), sort: (row) => row.language,
      csv: (row) => languageNames[row.language] ?? row.language, hideOnMobile: true },
    { key: 'wishlist', label: 'Wishlist', align: 'end', render: (row) => num(row.wishlistCount),
      sort: (row) => row.wishlistCount, csv: (row) => row.wishlistCount },
    { key: 'sale', label: 'İndirimde', align: 'end', render: (row) => num(row.onSaleCount), sort: (row) => row.onSaleCount,
      csv: (row) => row.onSaleCount, hideOnMobile: true },
    { key: 'rules', label: 'Kural', align: 'end', render: (row) => row.mutedCount > 0
      ? html`${num(row.ruleCount)} <small class="muted">+${num(row.mutedCount)} sessiz</small>` : num(row.ruleCount),
      sort: (row) => row.ruleCount + row.mutedCount, csv: (row) => row.ruleCount, hideOnMobile: true },
    { key: 'mode', label: 'Zamanlama', render: (row) => notificationModeNames[row.notificationMode] ?? row.notificationMode,
      sort: (row) => row.notificationMode, csv: (row) => row.notificationMode, hideOnMobile: true },
    { key: 'check', label: 'Son kontrol', render: (row) => html`${checkBadge(row.lastCheckStatus, row.lastCheckErrorCode)}
      <small class="muted block">${row.lastCheckErrorCode && row.lastCheckStatus !== 'success'
        ? checkErrorInfo(row.lastCheckErrorCode).title : When({ at: row.lastCheckCompletedAt })}</small>`,
      sort: (row) => row.lastCheckCompletedAt, csv: (row) => row.lastCheckStatus },
    { key: 'checkReason', label: 'Kontrol hatası', render: () => null,
      csv: (row) => row.lastCheckErrorCode && row.lastCheckStatus !== 'success' ? checkErrorInfo(row.lastCheckErrorCode).title : '' },
    // Next to the check on purpose: a successful wishlist read says nothing about whether alerts arrive.
    { key: 'delivery', label: 'Son bildirim', render: deliveryCell,
      sort: (row) => (row.dmDeliveryBlockedAt ? 0 : row.lastDelivery?.status === 'terminal_failed' ? 1 : row.lastDelivery ? 2 : 3),
      csv: deliveryText },
    { key: 'alerts', label: 'Uyarı', align: 'end', render: (row) => html`${num(row.alertsSent)}
      ${row.pendingAlerts > 0 ? html`<small class="muted block">${num(row.pendingAlerts)} bekliyor</small>` : null}`,
      sort: (row) => row.alertsSent, csv: (row) => row.alertsSent },
    { key: 'lastAlert', label: 'Son uyarı', render: () => null, csv: (row) => row.lastAlertAt },
    // Usage tracking is newer than some users: without a record the source is unknown, not "DM".
    { key: 'source', label: 'İlk kullandığı sunucu', render: (row) => row.sourceGuildId
      ? html`<a href=${`#/guilds/${row.sourceGuildId}`} onClick=${(event: Event) => event.stopPropagation()}>${row.sourceGuildName ?? 'Ayrılmış sunucu'}</a>`
      : row.lastSeenAt ? html`<span class="muted">Yalnız DM / kişisel</span>`
        : html`<span class="muted" title=${trackingNote(telemetrySince)}>Kayıt yok</span>`, sort: (row) => row.sourceGuildName ?? null,
      csv: (row) => row.sourceGuildName ?? row.sourceGuildId ?? '', hideOnMobile: true },
    { key: 'seen', label: 'Son görüldü', render: (row) => row.lastSeenAt ? When({ at: row.lastSeenAt })
      : html`<span class="muted" title=${trackingNote(telemetrySince)}>Kayıt yok</span>`, sort: (row) => row.lastSeenAt ?? null,
      csv: (row) => row.lastSeenAt ?? '', hideOnMobile: true },
    { key: 'created', label: 'Katıldı', render: (row) => html`<span title=${dateTime(row.createdAt)}>${day(row.createdAt)}</span>`,
      sort: (row) => row.createdAt, csv: (row) => row.createdAt },
  ];
  const visibleColumns = columns.filter((column) => !['id', 'username', 'steam', 'checkReason', 'lastAlert'].includes(column.key));
  const exportColumns = columns;

  const toolbar = html`
    <select class="input" value=${status} onChange=${(event: Event) => setStatus((event.target as HTMLSelectElement).value as StatusFilter)}
      aria-label="Durum">
      <option value="all">Tüm durumlar</option><option value="active">Aktif</option>
      <option value="paused">Duraklatıldı</option><option value="blocked">DM engelli</option>
      <option value="banned">Engellendi</option><option value="undelivered">Bildirimi gitmeyenler</option>
    </select>
    <select class="input" value=${check} onChange=${(event: Event) => setCheck((event.target as HTMLSelectElement).value as CheckFilter)}
      aria-label="Son kontrol">
      <option value="all">Tüm kontroller</option><option value="problem">Sorunlu kontroller</option>
      <option value="success">Başarılı</option><option value="unavailable">Erişilemedi</option><option value="failed">Hatalı</option>
    </select>
    <select class="input" value=${countryFilter} onChange=${(event: Event) => setCountry((event.target as HTMLSelectElement).value)}
      aria-label="Bölge">
      <option value="">Tüm bölgeler</option>
      ${countries.map((code) => html`<option value=${code}>${flag(code)} ${country(code)}</option>`)}
    </select>
    <select class="input" value=${language} onChange=${(event: Event) => setLanguage((event.target as HTMLSelectElement).value)}
      aria-label="Dil">
      <option value="">Tüm diller</option>
      ${Object.entries(languageNames).map(([code, name]) => html`<option value=${code}>${name}</option>`)}
    </select>`;

  return Page({
    title: 'Kullanıcılar',
    subtitle: state.data ? `${num(users.length)} kayıtlı kullanıcı. Son görülme ve sunucu bilgisi kullanım kaydından gelir. ${trackingNote(telemetrySince)}` : undefined,
    actions: html`<${RefreshButton} state=${state} />`,
    children: !state.data
      ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading())
      : html`<div class="card card-flush"><${DataTable}
          columns=${visibleColumns}
          rows=${rows}
          rowKey=${(row: UserRow) => row.discordUserId}
          onRow=${(row: UserRow) => navigate(`/users/${row.discordUserId}`)}
          search=${(row: UserRow) => `${row.discordUserId} ${row.steamId64} ${nameOf(row)}`}
          searchPlaceholder="Ad, Discord ID veya SteamID ara…"
          toolbar=${toolbar}
          csvName="dealio-kullanicilar"
          csvColumns=${exportColumns}
          initialSort=${{ key: 'created', direction: 'desc' }}
          empty="Bu filtrelere uyan kullanıcı yok."
        /></div>`,
  });
}
