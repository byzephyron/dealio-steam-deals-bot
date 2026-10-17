import { html, useState, type VNode } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { ConfirmDialog, useAction } from '../actions.js';
import { compact, dateTime, day, displayName, num, relative, trackingNote } from '../format.js';
import { Icon } from '../icons.js';
import { navigate } from '../router.js';
import type { Guild, GuildBlock, GuildDetail, GuildEvent, GuildsResponse } from '../types.js';
import {
  Avatar, BackLink, Badge, Card, DataTable, ErrorBox, Facts, Loading, Page, Stat, When, useAsync, type Column, RefreshButton, live,
} from '../ui.js';
import { AuditTable } from './audit.js';
import { UserCell } from './users.js';

function GuildName(props: { guild: Pick<Guild, 'id' | 'name' | 'iconUrl'> }): VNode {
  return html`<span class="person">
    ${Avatar({ src: props.guild.iconUrl, name: props.guild.name, square: true })}
    <span><strong>${props.guild.name}</strong><small class="muted">${props.guild.id}</small></span></span>`;
}

function OwnerCell(props: { guild: Guild }): VNode {
  const { owner, ownerId } = props.guild;
  return html`<span class="person">
    ${Avatar({ src: owner?.avatarUrl ?? null, name: displayName(owner, '?'), size: 24 })}
    <span>${displayName(owner, 'Bilinmiyor')}<small class="muted">${owner ? `@${owner.username}` : ownerId}</small></span></span>`;
}

const eventColumns: Column<GuildEvent>[] = [
  { key: 'event', label: 'Olay', render: (event) => event.event === 'join'
    ? Badge({ tone: 'good', label: 'Eklendi' }) : Badge({ tone: 'warn', label: 'Çıkarıldı' }),
    sort: (event) => event.event, csv: (event) => event.event },
  { key: 'guild', label: 'Sunucu', render: (event) => html`<a href=${`#/guilds/${event.guildId}`}>${event.guildName}</a>`,
    sort: (event) => event.guildName, csv: (event) => event.guildName },
  { key: 'members', label: 'Üye', align: 'end', render: (event) => num(event.memberCount), csv: (event) => event.memberCount },
  { key: 'time', label: 'Zaman', render: (event) => html`<span title=${dateTime(event.occurredAt)}>${relative(event.occurredAt)}</span>`,
    sort: (event) => event.occurredAt, csv: (event) => event.occurredAt },
];

type Tab = 'active' | 'events' | 'departed' | 'blocked';

export function GuildsPage(): VNode {
  const state = useAsync(() => api.get<GuildsResponse>('/api/guilds'), [], live);
  const [tab, setTab] = useState<Tab>('active');
  const { busy, run } = useAction();
  const data = state.data;
  const guilds = data?.guilds ?? [];
  const members = guilds.reduce((sum, guild) => sum + guild.memberCount, 0);
  const newest = [...guilds].sort((a, b) => (b.joinedAt ?? '').localeCompare(a.joinedAt ?? ''))[0];
  const withUsers = guilds.filter((guild) => (guild.dealioUsers ?? 0) > 0).length;

  const columns: Column<Guild>[] = [
    { key: 'name', label: 'Sunucu', render: (guild) => GuildName({ guild }), sort: (guild) => guild.name.toLocaleLowerCase('tr-TR'),
      csv: (guild) => guild.name },
    { key: 'id', label: 'Sunucu ID', render: () => null, csv: (guild) => guild.id },
    { key: 'members', label: 'Üye', align: 'end', render: (guild) => num(guild.memberCount), sort: (guild) => guild.memberCount,
      csv: (guild) => guild.memberCount },
    { key: 'dealio', label: 'Dealio kullanan', align: 'end', render: (guild) => html`${num(guild.dealioUsers ?? 0)}
      ${(guild.registeredUsers ?? 0) > 0 ? html`<small class="muted block">${num(guild.registeredUsers)} kayıtlı</small>` : null}`,
      sort: (guild) => guild.dealioUsers ?? 0, csv: (guild) => guild.dealioUsers ?? 0 },
    { key: 'owner', label: 'Sahip', render: (guild) => OwnerCell({ guild }), sort: (guild) => displayName(guild.owner, guild.ownerId),
      csv: (guild) => guild.owner?.username ?? guild.ownerId },
    { key: 'ownerId', label: 'Sahip ID', render: () => null, csv: (guild) => guild.ownerId },
    { key: 'joined', label: 'Bot katıldı', render: (guild) => html`<span title=${dateTime(guild.joinedAt)}>${relative(guild.joinedAt)}</span>`,
      sort: (guild) => guild.joinedAt, csv: (guild) => guild.joinedAt },
    { key: 'activity', label: 'Son kullanım', render: (guild) => When({ at: guild.lastActivityAt ?? null, empty: 'Kayıt yok' }),
      sort: (guild) => guild.lastActivityAt ?? null, csv: (guild) => guild.lastActivityAt ?? '', hideOnMobile: true },
    { key: 'locale', label: 'Dil', render: (guild) => guild.preferredLocale, sort: (guild) => guild.preferredLocale,
      csv: (guild) => guild.preferredLocale, hideOnMobile: true },
    { key: 'created', label: 'Sunucu açıldı', render: () => null, csv: (guild) => guild.createdAt },
  ];
  const hidden = ['id', 'ownerId', 'created'];

  const blockedColumns: Column<GuildBlock>[] = [
    { key: 'guild', label: 'Sunucu', render: (block) => html`${block.guildName ?? '—'} <small class="muted block">${block.guildId}</small>`,
      csv: (block) => block.guildName ?? block.guildId },
    { key: 'reason', label: 'Sebep', render: (block) => block.reason ?? '—', csv: (block) => block.reason },
    { key: 'at', label: 'Engellendi', render: (block) => When({ at: block.blockedAt }), sort: (block) => block.blockedAt, csv: (block) => block.blockedAt },
    { key: 'actions', label: '', render: (block) => html`<button class="btn btn-small" disabled=${busy !== null}
      onClick=${() => run('unblock', `/api/guilds/${block.guildId}/unblock`, {}, 'Engel kaldırıldı').then((result) => {
        if (result !== null) state.reload();
      })}>${Icon({ name: 'check', size: 14 })}Engeli kaldır</button>` },
  ];

  const tabs: Array<[Tab, string, number]> = [
    ['active', 'Aktif', guilds.length], ['events', 'Olaylar', data?.events.length ?? 0],
    ['departed', 'Ayrılanlar', data?.departed.length ?? 0], ['blocked', 'Engellenenler', data?.blocked.length ?? 0],
  ];

  return Page({
    title: 'Sunucular',
    subtitle: data ? `Botun ekli olduğu sunucular ve katılma tarihleri Discord’dan canlı gelir. “Dealio kullanan” ve “Son kullanım” kullanım kaydından gelir. ${trackingNote(data.telemetrySince)}`
      : 'Botun ekli olduğu sunucular (Discord’dan canlı).',
    actions: html`<${RefreshButton} state=${state} />`,
    children: !data
      ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading())
      : html`
        <div class="stats">
          ${Stat({ label: 'Sunucu', icon: 'server', value: num(guilds.length), sub: `${num(withUsers)} sunucuda Dealio kullanan var` })}
          ${Stat({ label: 'Toplam üye', icon: 'users', value: compact(members), sub: 'Sunucular arasında tekrar edenler dahil' })}
          ${Stat({ label: 'Ayrılan sunucu', icon: 'logout', value: num(data.departed.length), sub: 'Botu çıkaran sunucular' })}
          ${Stat({ label: 'En yeni', icon: 'zap', value: newest ? html`<span class="stat-text" title=${newest.name}>${newest.name}</span>` : '—', sub: newest ? relative(newest.joinedAt) : undefined })}
        </div>
        <div><div class="tabs" role="tablist">${tabs.map(([key, label, count]) => html`
          <button role="tab" aria-selected=${tab === key} class=${`tab ${tab === key ? 'active' : ''}`} onClick=${() => setTab(key)}>
            ${label} <small>${num(count)}</small></button>`)}</div></div>
        <div class="card card-flush">
          ${tab === 'active' ? html`<${DataTable} columns=${columns.filter((column) => !hidden.includes(column.key))}
            csvColumns=${columns} rows=${guilds} rowKey=${(guild: Guild) => guild.id} onRow=${(guild: Guild) => navigate(`/guilds/${guild.id}`)}
            search=${(guild: Guild) => `${guild.name} ${guild.id} ${guild.owner?.username ?? ''}`}
            searchPlaceholder="Sunucu, ID veya sahip ara…" csvName="dealio-sunucular"
            initialSort=${{ key: 'members', direction: 'desc' }} empty="Bot henüz hiçbir sunucuda değil." />` : null}
          ${tab === 'events' ? html`<${DataTable} columns=${eventColumns} rows=${data.events}
            rowKey=${(event: GuildEvent) => `${event.guildId}-${event.occurredAt}-${event.event}`} csvName="dealio-sunucu-olaylari"
            initialSort=${{ key: 'time', direction: 'desc' }} empty="Henüz olay yok." />` : null}
          ${tab === 'departed' ? html`<${DataTable} columns=${eventColumns.filter((column) => column.key !== 'event')} rows=${data.departed}
            rowKey=${(event: GuildEvent) => event.guildId} csvName="dealio-ayrilan-sunucular"
            initialSort=${{ key: 'time', direction: 'desc' }} empty="Botu çıkaran sunucu yok." />` : null}
          ${tab === 'blocked' ? html`<${DataTable} columns=${blockedColumns} rows=${data.blocked}
            rowKey=${(block: GuildBlock) => block.guildId} empty="Engellenen sunucu yok." />` : null}
        </div>`,
  });
}

export function GuildDetailPage(props: { id: string }): VNode {
  const state = useAsync(() => api.get<GuildDetail>(`/api/guilds/${props.id}`), [props.id], live);
  const [open, setOpen] = useState<null | 'leave' | 'block'>(null);
  const { busy, run } = useAction();
  const data = state.data;
  const guild = data?.guild ?? null;
  const done = (result: unknown): void => {
    if (result !== null) {
      setOpen(null);
      state.reload();
    }
  };
  return Page({
    title: data?.name ?? 'Sunucu',
    subtitle: guild ? `${num(guild.memberCount)} üye · bot ${relative(guild.joinedAt)} eklendi` : data ? 'Bot artık bu sunucuda değil' : undefined,
    actions: html`${BackLink({ href: '#/guilds', label: 'Sunucular' })}<${RefreshButton} state=${state} />`,
    children: !data
      ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading())
      : html`
        <div class="card">
          <div class="action-bar">
            ${guild ? GuildName({ guild }) : html`<code>${props.id}</code>`}
            ${data.blocked ? Badge({ tone: 'bad', label: 'Engelli' }) : null}
            <span class="toolbar-spacer"></span>
            ${guild ? html`<button class="btn btn-danger" disabled=${busy !== null} onClick=${() => setOpen('leave')}>${Icon({ name: 'logout' })}Sunucudan çık</button>` : null}
            ${data.blocked
              ? html`<button class="btn" disabled=${busy !== null}
                  onClick=${() => run('unblock', `/api/guilds/${props.id}/unblock`, {}, 'Engel kaldırıldı').then(done)}>${Icon({ name: 'check' })}Engeli kaldır</button>`
              : html`<button class="btn btn-danger" disabled=${busy !== null} onClick=${() => setOpen('block')}>${Icon({ name: 'ban' })}Engelle</button>`}
          </div>
        </div>
        ${open === 'leave' ? html`<${ConfirmDialog} title="Sunucudan çık" confirmLabel="Çık" danger typeToConfirm=${props.id}
          busy=${busy === 'leave'} message="Bot bu sunucudan çıkar. Sunucu yöneticisi botu yeniden ekleyebilir; kalıcı olarak engellemek için Engelle’yi kullan. Kullanıcıların kişisel verileri etkilenmez."
          onClose=${() => setOpen(null)}
          onConfirm=${(input: { confirm: string }) => run('leave', `/api/guilds/${props.id}/leave`, input, 'Sunucudan çıkıldı').then(done)} />` : null}
        ${open === 'block' ? html`<${ConfirmDialog} title="Sunucuyu engelle" confirmLabel="Engelle ve çık" danger typeToConfirm=${props.id} withReason
          busy=${busy === 'block'} message="Bot sunucudan çıkar ve sunucu onu yeniden eklerse hemen tekrar çıkar."
          onClose=${() => setOpen(null)}
          onConfirm=${(input: { confirm: string; reason: string }) => run('block', `/api/guilds/${props.id}/block`, input, 'Sunucu engellendi').then(done)} />` : null}
        <div class="grid-2">
          ${Card({ title: 'Bilgiler', children: guild ? Facts({ rows: [
            ['Sunucu ID', html`<code>${guild.id}</code>`],
            ['Sahip', OwnerCell({ guild })],
            ['Üye', num(guild.memberCount)],
            ['Sunucu açıldı', day(guild.createdAt)],
            ['Bot katıldı', dateTime(guild.joinedAt)],
            ['Dil', guild.preferredLocale],
            ['Açıklama', guild.description ?? '—'],
            ['Özellikler', guild.features.length > 0 ? html`<span class="muted small">${guild.features.join(', ')}</span>` : '—'],
          ] }) : html`<p class="empty">Canlı bilgi yok; aşağıda kayıtlı geçmiş var.</p>` })}
          ${Card({ title: 'Geçmiş', class: 'card-flush', children: html`<${DataTable} columns=${eventColumns.filter((column) => column.key !== 'guild')}
            rows=${data.events} rowKey=${(event: GuildEvent) => `${event.occurredAt}-${event.event}`}
            initialSort=${{ key: 'time', direction: 'desc' }} empty="Olay yok." />` })}
        </div>
        ${Card({ title: 'Bu sunucudan Dealio kullananlar', subtitle: trackingNote(data.telemetrySince), class: 'card-flush', children: html`<${DataTable}
          columns=${[
            { key: 'user', label: 'Kullanıcı', render: (row: GuildDetail['users'][number]) => UserCell({ id: row.discordUserId, profile: row.profile }),
              csv: (row: GuildDetail['users'][number]) => row.discordUserId },
            { key: 'registered', label: 'Kayıt', render: (row: GuildDetail['users'][number]) => row.registered
              ? Badge({ tone: 'good', label: 'Kayıtlı' }) : Badge({ tone: 'neutral', label: 'Kayıtsız' }),
              sort: (row: GuildDetail['users'][number]) => (row.registered ? 1 : 0), csv: (row: GuildDetail['users'][number]) => String(row.registered) },
            { key: 'interactions', label: 'Etkileşim', align: 'end', render: (row: GuildDetail['users'][number]) => num(row.interactions),
              sort: (row: GuildDetail['users'][number]) => row.interactions, csv: (row: GuildDetail['users'][number]) => row.interactions },
            { key: 'last', label: 'Son', render: (row: GuildDetail['users'][number]) => When({ at: row.lastSeenAt }),
              sort: (row: GuildDetail['users'][number]) => row.lastSeenAt, csv: (row: GuildDetail['users'][number]) => row.lastSeenAt },
          ]}
          rows=${data.users} rowKey=${(row: GuildDetail['users'][number]) => row.discordUserId}
          onRow=${(row: GuildDetail['users'][number]) => { if (row.registered) navigate(`/users/${row.discordUserId}`); }}
          csvName=${`dealio-sunucu-${props.id}`} empty="Bu sunucudan henüz Dealio kullanılmadı." />` })}
        ${data.audit.length > 0 ? Card({ title: 'Denetim', class: 'card-flush', children: html`<${AuditTable} entries=${data.audit} />` }) : null}`,
  });
}
