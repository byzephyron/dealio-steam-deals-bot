import { html, type VNode } from '../vendor/preact-htm.js';
import { num } from '../format.js';
import type { GameRow, Games } from '../types.js';
import {
  BarList, Card, DataTable, ErrorBox, Loading, Page, useApi, type Column, RefreshButton, live,
} from '../ui.js';
import { GameCell } from './user-detail.js';

function gameColumns(countLabel: string, extra: Column<GameRow>[] = []): Column<GameRow>[] {
  return [
    { key: 'game', label: 'Oyun', render: (row) => GameCell({ appId: row.appId, name: row.name, imageUrl: row.headerImageUrl ?? null }),
      sort: (row) => row.name.toLocaleLowerCase('tr-TR'), csv: (row) => row.name },
    { key: 'appId', label: 'App ID', render: (row) => html`<code>${row.appId}</code>`, csv: (row) => row.appId, hideOnMobile: true },
    { key: 'count', label: countLabel, align: 'end', render: (row) => num(row.count), sort: (row) => row.count, csv: (row) => row.count },
    ...extra,
  ];
}

const discountColumn: Column<GameRow> = {
  key: 'discount', label: 'En derin', align: 'end',
  render: (row) => row.maxDiscountPercent ? html`<span class="discount">−%${row.maxDiscountPercent}</span>` : '—',
  sort: (row) => row.maxDiscountPercent ?? 0, csv: (row) => row.maxDiscountPercent ?? '',
};

export function GamesPage(): VNode {
  const state = useApi<Games>('/api/games', live);
  const data = state.data;
  const table = (rows: GameRow[], columns: Column<GameRow>[], csv: string, empty: string): VNode =>
    html`<${DataTable} columns=${columns.filter((column) => column.key !== 'appId')} csvColumns=${columns} rows=${rows} rowKey=${(row: GameRow) => String(row.appId)}
      csvName=${csv} initialSort=${{ key: 'count', direction: 'desc' }} pageSize=${10} empty=${empty} />`;
  return Page({
    title: 'Oyunlar',
    subtitle: 'Kullanıcıların güncel wishlist’lerinden toplanır; her liste ilk 50 oyunu gösterir.',
    actions: html`<${RefreshButton} state=${state} />`,
    children: !data
      ? (state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading())
      : html`
        <div class="grid-2">
          ${Card({ title: 'En çok istenenler', class: 'card-flush',
            children: table(data.wishlisted, gameColumns('Kullanıcı'), 'dealio-en-cok-istenen', 'Wishlist verisi yok.') })}
          ${Card({ title: 'Şu an indirimde', class: 'card-flush',
            children: table(data.onSale, gameColumns('Kullanıcı', [discountColumn]), 'dealio-indirimde', 'İndirimde oyun yok.') })}
          ${Card({ title: 'En çok uyarı (30 gün)', class: 'card-flush',
            children: table(data.alerted, gameColumns('Uyarı', [discountColumn]), 'dealio-uyarilar', 'Son 30 günde uyarı yok.') })}
          ${Card({ title: 'En çok kural konan', class: 'card-flush',
            children: table(data.ruled, gameColumns('Kural', [
              { key: 'targets', label: 'Hedef fiyat', align: 'end', render: (row) => num(row.targets ?? 0), csv: (row) => row.targets ?? 0 },
              { key: 'muted', label: 'Sessiz', align: 'end', render: (row) => num(row.muted ?? 0), csv: (row) => row.muted ?? 0 },
            ]), 'dealio-kurallar', 'Özel kural yok.') })}
        </div>
        ${Card({ title: 'Para birimleri', children: BarList({ rows: data.currencies.map((row) => ({
          key: row.key, label: row.key, value: row.count })), empty: 'Fiyat verisi yok.' }) })}`,
  });
}
