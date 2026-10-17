import { html, type VNode } from '../vendor/preact-htm.js';
import {
  country, dateTime, day, displayName, flag, languageNames, minuteOfDay, money, notificationModeNames,
  notificationStatusNames, num, relative, trackingNote,
} from '../format.js';
import { Icon } from '../icons.js';
import { rememberProfile } from '../profiles.js';
import type { NotificationRow, SnapshotItem, UserDetail } from '../types.js';
import {
  Avatar, BackLink, Badge, Card, CopyText, DataTable, ErrorBox, Facts, Loading, Page, When, useApi, type Column, type Tone, RefreshButton, live,
} from '../ui.js';
import { actionLabel } from '../explain.js';
import { CheckReason, DeliveryReason, checkBadge, userStatus } from './users.js';
import { UserActions } from './user-actions.js';
import { AuditTable } from './audit.js';
import { BroadcastStatusBadge } from './announcements.js';
import type { Broadcast } from '../types.js';

export function storeUrl(appId: number): string {
  return `https://store.steampowered.com/app/${appId}/`;
}

/** The small capsule at its classic path; newer games only have art under a hashed folder (see headerImageUrl). */
export function capsuleUrl(appId: number): string {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_184x69.jpg`;
}

/**
 * Steam's stored artwork first, then the classic capsule path; art Steam does not
 * serve at either becomes the empty tile instead of a broken-image icon.
 */
const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
function nextImage(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  const fallback = image.dataset.fallback;
  if (fallback && image.src !== fallback) {
    image.src = fallback;
    delete image.dataset.fallback;
  } else if (image.src !== emptyImage) {
    image.src = emptyImage;
  }
}

export function GameCell(props: { appId: number; name: string; imageUrl?: string | null }): VNode {
  const capsule = capsuleUrl(props.appId);
  return html`<a class="game-cell" href=${storeUrl(props.appId)} target="_blank" rel="noreferrer noopener"
    onClick=${(event: Event) => event.stopPropagation()}>
    <img src=${props.imageUrl ?? capsule} data-fallback=${props.imageUrl ? capsule : undefined} alt="" loading="lazy"
      width="92" height="35" onError=${nextImage} />
    <span>${props.name}</span></a>`;
}

function priceCell(item: SnapshotItem): VNode | string {
  if (item.upcoming) return Badge({ tone: 'info', label: 'Çıkmadı' });
  if (!item.price) return html`<span class="muted">Fiyat yok</span>`;
  if (item.price.isFree) return Badge({ tone: 'good', label: 'Ücretsiz' });
  return item.price.discountPercent > 0
    ? html`<span class="price"><s class="muted">${money(item.price.initialMinor, item.price.currency)}</s>
        <strong>${money(item.price.finalMinor, item.price.currency)}</strong></span>`
    : money(item.price.finalMinor, item.price.currency);
}

export const contextNames: Readonly<Record<string, string>> = {
  guild: 'Sunucu', bot_dm: 'Bot DM', private_channel: 'Özel kanal / grup', unknown: '—',
};
export const installNames: Readonly<Record<string, string>> = {
  guild: 'Sunucu kurulumu', user: 'Kişisel kurulum (Uygulamalarım)', both: 'Her ikisi', unknown: 'Bilinmiyor',
};

const notificationTone: Record<string, Tone> = {
  sent: 'good', candidate: 'info', sending: 'info', failed: 'warn', terminal_failed: 'bad', expired: 'neutral',
};

export function UserDetailPage(props: { id: string }): VNode {
  const state = useApi<UserDetail>(`/api/users/${props.id}`, live);
  const data = state.data;
  if (!data) {
    return Page({ title: 'Kullanıcı', actions: BackLink({ href: '#/users', label: 'Kullanıcılar' }),
      children: state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading() });
  }
  rememberProfile(data.profile, data.config.discordUserId);
  const { config, profile, checkState, preference } = data;
  const name = displayName(profile, 'Bilinmeyen kullanıcı');
  const rules = new Map(data.rules.map((rule) => [rule.appId, rule]));
  const ruleText = (appId: number): string => {
    const rule = rules.get(appId);
    if (!rule) return '';
    const base = rule.mode === 'percent' ? `≥ %${rule.percent}` : rule.mode === 'target' ? `≤ ${money(rule.targetMinor, rule.currency)}` : '';
    return [base, rule.muted ? 'sessiz' : ''].filter(Boolean).join(' · ');
  };

  const wishlistColumns: Column<SnapshotItem>[] = [
    { key: 'game', label: 'Oyun', render: (item) => GameCell({ appId: item.appId, name: item.name, imageUrl: item.headerImageUrl }),
      sort: (item) => item.name.toLocaleLowerCase('tr-TR'), csv: (item) => item.name },
    { key: 'appId', label: 'App ID', render: (item) => html`<code>${item.appId}</code>`, sort: (item) => item.appId,
      csv: (item) => item.appId, hideOnMobile: true },
    { key: 'price', label: 'Fiyat', align: 'end', render: priceCell, sort: (item) => item.price?.finalMinor ?? null,
      csv: (item) => item.price ? item.price.finalMinor / 100 : null },
    { key: 'discount', label: 'İndirim', align: 'end', render: (item) => item.price && item.price.discountPercent > 0
      ? html`<span class="discount">−%${item.price.discountPercent}</span>` : '', sort: (item) => item.price?.discountPercent ?? 0,
      csv: (item) => item.price?.discountPercent ?? 0 },
    { key: 'rule', label: 'Kural', render: (item) => ruleText(item.appId), sort: (item) => ruleText(item.appId) || null,
      csv: (item) => ruleText(item.appId), hideOnMobile: true },
    { key: 'added', label: 'Eklendi', render: (item) => item.dateAdded ? day(item.dateAdded * 1000) : '—',
      sort: (item) => item.dateAdded, csv: (item) => item.dateAdded ? new Date(item.dateAdded * 1000).toISOString() : '',
      hideOnMobile: true },
  ];

  const notificationColumns: Column<NotificationRow>[] = [
    { key: 'game', label: 'Oyun', render: (row) => GameCell({ appId: row.appId, name: row.gameName, imageUrl: row.headerImageUrl ?? null }),
      sort: (row) => row.gameName, csv: (row) => row.gameName },
    { key: 'status', label: 'Durum', render: (row) => Badge({ tone: notificationTone[row.status] ?? 'neutral',
      label: notificationStatusNames[row.status] ?? row.status, ...(row.lastError ? { title: row.lastError } : {}) }),
      sort: (row) => row.status, csv: (row) => row.status },
    { key: 'price', label: 'Fiyat', align: 'end', render: (row) => html`${money(row.finalPriceMinor, row.currency)}
      <small class="muted block">−%${row.discountPercent}</small>`, sort: (row) => row.discountPercent,
      csv: (row) => row.finalPriceMinor / 100 },
    { key: 'reason', label: 'Sebep', render: (row) => row.reason === 'target' ? 'Hedef fiyat' : 'İndirim',
      csv: (row) => row.reason, hideOnMobile: true },
    { key: 'attempts', label: 'Deneme', align: 'end', render: (row) => num(row.attemptCount), csv: (row) => row.attemptCount,
      hideOnMobile: true },
    { key: 'created', label: 'Oluştu', render: (row) => html`<span title=${dateTime(row.createdAt)}>${relative(row.createdAt)}</span>`,
      sort: (row) => row.createdAt, csv: (row) => row.createdAt },
    { key: 'delivered', label: 'Teslim', render: (row) => row.deliveredAt
      ? html`<span title=${dateTime(row.deliveredAt)}>${relative(row.deliveredAt)}</span>` : '—',
      sort: (row) => row.deliveredAt, csv: (row) => row.deliveredAt },
  ];

  const status = userStatus(config);
  const items = data.snapshot?.items ?? [];
  return Page({
    title: name,
    subtitle: html`${profile ? `@${profile.username} · ` : ''}Katıldı ${day(config.createdAt)}`,
    actions: html`${BackLink({ href: '#/users', label: 'Kullanıcılar' })}<${RefreshButton} state=${state} />`,
    children: html`
      <div class="profile-head card">
        ${Avatar({ src: profile?.avatarUrl ?? null, name, size: 72 })}
        <div class="profile-main">
          <div class="badges">${Badge(status)} ${checkBadge(checkState?.lastStatus ?? null, checkState?.lastErrorCode ?? null)}
            ${data.blocked ? Badge({ tone: 'bad', label: 'Engellendi' }) : null}
            ${profile?.bot ? Badge({ tone: 'neutral', label: 'Bot hesabı' }) : null}</div>
          <div class="links">
            <a class="link-chip" href=${`https://steamcommunity.com/profiles/${config.steamId64}`} target="_blank" rel="noreferrer noopener">Steam profili ${Icon({ name: 'external', size: 13 })}</a>
            <a class="link-chip" href=${`https://store.steampowered.com/wishlist/profiles/${config.steamId64}/`} target="_blank" rel="noreferrer noopener">Steam wishlist ${Icon({ name: 'external', size: 13 })}</a>
            <a class="link-chip" href=${`https://discord.com/users/${config.discordUserId}`} target="_blank" rel="noreferrer noopener">Discord profili ${Icon({ name: 'external', size: 13 })}</a>
          </div>
        </div>
        <div class="profile-numbers">
          <div><strong>${num(items.length)}</strong><span>oyun</span></div>
          <div><strong>${num(data.summary?.onSaleCount ?? 0)}</strong><span>indirimde</span></div>
          <div><strong>${num(data.summary?.alertsSent ?? 0)}</strong><span>uyarı</span></div>
        </div>
      </div>

      <div class="card"><${UserActions} detail=${data} onChanged=${state.reload} /></div>

      <div class="grid-3">
        ${Card({ title: 'Hesap', children: Facts({ rows: [
          ['Discord ID', html`<${CopyText} value=${config.discordUserId} />`],
          ['SteamID64', html`<${CopyText} value=${config.steamId64} />`],
          ['Discord hesabı açıldı', profile ? day(profile.createdAt) : '—'],
          ['Mağaza bölgesi', html`${flag(config.storeCountryCode)} ${country(config.storeCountryCode)}`],
          ['Dil', languageNames[config.language] ?? config.language],
          ['Varsayılan eşik', config.minimumDiscountPercent > 0 ? `%${config.minimumDiscountPercent}+` : 'Her indirim'],
          ['DM onayı', dateTime(config.dmOptInAt)],
          ['DM engeli', config.dmDeliveryBlockedAt
            ? html`${DeliveryReason({ error: config.dmDeliveryErrorCode })}<small class="muted block">${dateTime(config.dmDeliveryBlockedAt)} tarihinden beri</small>`
            : 'Yok'],
          ['Yapılandırma', html`v${config.configVersion} · <code class="small">${config.configurationId.slice(0, 8)}</code>`],
          ['Güncellendi', When({ at: config.updatedAt })],
        ] }) })}
        ${Card({ title: 'Kontrol', subtitle: 'Son wishlist okuması', children: checkState ? Facts({ rows: [
          ['Son durum', checkBadge(checkState.lastStatus, checkState.lastErrorCode)],
          ['Neden', checkState.lastErrorCode && checkState.lastStatus !== 'success'
            ? CheckReason({ code: checkState.lastErrorCode }) : '—'],
          ['Son kontrol', When({ at: checkState.lastCompletedAt })],
          ['Son başarılı', When({ at: checkState.lastSuccessCompletedAt })],
          ['Kontrol edilen', num(checkState.lastSuccessCheckedCount)],
          ['İndirimde', num(checkState.lastSuccessOnSaleCount)],
          ['Ücretsiz', num(checkState.lastSuccessFreeCount)],
          ['Fiyatı bilinmeyen', num(checkState.lastSuccessUnknownPriceCount)],
          ['Hatalı oyun', num(checkState.lastSuccessFailedItemCount)],
        ] }) : html`<p class="empty">Henüz kontrol yok.</p>` })}
        ${Card({ title: 'Bildirim zamanlaması', children: Facts({ rows: [
          ['Mod', notificationModeNames[preference.mode] ?? preference.mode],
          ['Saat dilimi', preference.timezone ?? '—'],
          ['Sessiz saatler', preference.mode === 'quiet' ? `${minuteOfDay(preference.quietStart)} – ${minuteOfDay(preference.quietEnd)}` : '—'],
          ['Özet saati', preference.mode === 'digest' ? minuteOfDay(preference.digestMinute) : '—'],
          ['Özel kural', num(data.rules.filter((rule) => rule.mode !== 'inherit').length)],
          ['Sessize alınan', num(data.rules.filter((rule) => rule.muted).length)],
          ['Bekleyen uyarı', num(data.summary?.pendingAlerts ?? 0)],
        ] }) })}
      </div>

      ${Card({ title: 'Wishlist', subtitle: data.snapshot ? `${num(items.length)} oyun · ${relative(data.snapshot.capturedAt)} okundu` : undefined,
        class: 'card-flush', children: data.snapshot
          ? html`<${DataTable} columns=${wishlistColumns} rows=${items} rowKey=${(item: SnapshotItem) => String(item.appId)}
              search=${(item: SnapshotItem) => `${item.name} ${item.appId}`} searchPlaceholder="Oyun ara…"
              csvName=${`dealio-wishlist-${config.discordUserId}`} initialSort=${{ key: 'discount', direction: 'desc' }} pageSize=${25} />`
          : html`<p class="empty">Kayıtlı wishlist görüntüsü yok.</p>` })}

      ${Card({ title: 'Bildirim geçmişi', class: 'card-flush', children: html`<${DataTable} columns=${notificationColumns}
          rows=${data.notifications} rowKey=${(row: NotificationRow) => `${row.appId}-${row.createdAt}`}
          search=${(row: NotificationRow) => row.gameName} searchPlaceholder="Oyun ara…"
          csvName=${`dealio-bildirimler-${config.discordUserId}`} pageSize=${25} empty="Henüz bildirim yok." />` })}

      <div class="grid-2">
        ${Card({ title: 'Kullanım', subtitle: trackingNote(data.telemetrySince), children: html`
          ${Facts({ rows: [
            ['İlk kayıtlı etkileşim', data.usage.firstSeenAt ? dateTime(data.usage.firstSeenAt) : 'Kayıt yok'],
            ['Son görüldü', When({ at: data.usage.lastSeenAt, empty: 'Kayıt yok' })],
            ['Etkileşim (90 gün)', num(data.usage.interactions)],
            ['Kurulum türü', data.usage.installs.length > 0
              ? data.usage.installs.map((install) => installNames[install] ?? install).join(', ') : '—'],
            ['Kullandığı sunucular', data.usage.interactions === 0 ? 'Kayıt yok'
              : data.usage.guilds.length === 0 ? 'Yalnız DM / kişisel kurulum' : html`${data.usage.guilds.map((guild) => html`
              <a class="chip" href=${`#/guilds/${guild.guildId}`}>${guild.guildName ?? guild.guildId} <small>${num(guild.count)}</small></a>`)}`],
          ] })}
          <h3 class="sub-head">Son etkileşimler</h3>
          ${data.usage.recent.length === 0 ? html`<p class="empty">Kayıt yok.</p>` : html`<ol class="timeline">
            ${data.usage.recent.slice(0, 25).map((event) => {
              const what = actionLabel(event.action, event.kind);
              return html`<li>
                <time title=${dateTime(event.occurredAt)}>${relative(event.occurredAt)}</time>
                <span title=${event.action}>${what.label}</span>
                <small class="muted">${event.context === 'unknown' ? what.area
                  : `${what.area} · ${contextNames[event.context] ?? event.context}`}</small></li>`;
            })}
          </ol>`}` })}
        <div class="stack">
          ${Card({ title: 'Gönderdiğin mesajlar', children: data.messages.length === 0
            ? html`<p class="empty">Bu kullanıcıya mesaj gönderilmedi.</p>`
            : html`<ul class="list">${data.messages.map((message: Broadcast) => {
                const text = message.content[config.language as 'tr'] ?? Object.values(message.content)[0];
                return html`<li><a href=${`#/announcements/${message.broadcastId}`}>${text?.title ?? '—'}</a>
                  <span class="muted small">${When({ at: message.createdAt })}</span>
                  ${BroadcastStatusBadge({ status: message.recipientStatus ?? message.status })}</li>`;
              })}</ul>` })}
          ${Card({ title: 'Denetim', class: 'card-flush', children: html`<${AuditTable} entries=${data.audit} />` })}
        </div>
      </div>`,
  });
}
