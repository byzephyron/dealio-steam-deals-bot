import { html, useCallback, useEffect, useMemo, useRef, useState, type Child, type VNode } from './vendor/preact-htm.js';
import { ApiError, getFirst, rememberedResponse, rememberResponse } from './api.js';
import { dateTime, relative } from './format.js';
import { Icon, type IconName } from './icons.js';

export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** When the data last arrived (ms since epoch). */
  readonly updatedAt: number | null;
  /** Whether the page refreshes itself. */
  readonly live: boolean;
  readonly reload: () => void;
  /** Reloads without showing progress (for polling). */
  readonly refresh: () => void;
}

/** Live pages refresh every 30 seconds while their browser tab is visible. */
export const live = { refreshMs: 30_000 } as const;

/**
 * Loads on mount and when `deps` change; keeps the previous data while reloading.
 * With `refreshMs`, reloads quietly on that interval while the tab is visible, and
 * at once when a hidden tab comes back with stale data.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[],
  options: { readonly refreshMs?: number; readonly initial?: { readonly data: T; readonly at: number } } = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(() => options.initial?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(() => options.initial?.at ?? null);
  const [generation, setGeneration] = useState(0);
  const quiet = useRef(false);
  const lastLoad = useRef(0);
  useEffect(() => {
    let active = true;
    // Automatic refreshes keep the page as it is; only explicit loads show progress.
    if (!quiet.current) setLoading(true);
    quiet.current = false;
    lastLoad.current = Date.now();
    loader().then((value) => {
      if (!active) return;
      setData(value);
      setError(null);
      setUpdatedAt(Date.now());
    }, (reason: unknown) => {
      if (!active) return;
      setError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Bilinmeyen hata');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [...deps, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const refresh = useCallback(() => {
    quiet.current = true;
    setGeneration((value) => value + 1);
  }, []);
  const refreshMs = options.refreshMs;
  useEffect(() => {
    if (!refreshMs) return;
    const tick = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - lastLoad.current < refreshMs - 1_000) return;
      refresh();
    };
    const timer = setInterval(tick, refreshMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refreshMs]);
  return { data, error, loading, updatedAt, live: Boolean(refreshMs), reload, refresh };
}

/** `useAsync` for a GET: a page opened again starts from its last answer while it reloads. */
export function useApi<T>(path: string, options: { readonly refreshMs?: number } = {}): AsyncState<T> {
  return useAsync(() => getFirst<T>(path).then((value) => {
    rememberResponse(path, value);
    return value;
  }), [path], { ...options, initial: rememberedResponse<T>(path) });
}

/** "● Canlı · 12 sn önce" and a manual refresh button, for a page's header. */
export function RefreshButton(props: { state: AsyncState<unknown> }): VNode {
  useTicker(5_000);
  const { state } = props;
  const age = state.updatedAt === null ? null : Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000));
  const ageText = age === null ? '' : age < 5 ? 'şimdi' : age < 60 ? `${age} sn önce` : `${Math.floor(age / 60)} dk önce`;
  return html`<span class="refresh">
    ${state.live ? html`<span class=${`live ${state.error ? 'live-lost' : 'live-live'}`}
      title="Bu sayfa 30 saniyede bir kendini yeniler (sekme açıkken).">
      <span class="live-dot" aria-hidden="true"></span>${state.error ? 'Güncellenemedi' : 'Canlı'}${ageText ? ` · ${ageText}` : ''}</span>` : null}
    <button class=${`btn ${state.loading ? 'spin' : ''}`} onClick=${state.reload} disabled=${state.loading}>
      ${Icon({ name: 'refresh' })}${state.loading ? 'Yenileniyor…' : 'Yenile'}</button>
  </span>`;
}

/** The "← Kullanıcılar" button back to a list page. */
export function BackLink(props: { href: string; label: string }): VNode {
  return html`<a class="btn" href=${props.href}>${Icon({ name: 'arrowLeft' })}${props.label}</a>`;
}

export function Page(props: { title: string; subtitle?: Child; actions?: Child; children?: Child }): VNode {
  return html`
    <section class="page">
      <header class="page-head">
        <div>
          <h1>${props.title}</h1>
          ${props.subtitle ? html`<p class="muted">${props.subtitle}</p>` : null}
        </div>
        ${props.actions ? html`<div class="page-actions">${props.actions}</div>` : null}
      </header>
      ${props.children}
    </section>`;
}

export function Card(props: { title?: Child; subtitle?: Child; actions?: Child; class?: string; children?: Child }): VNode {
  return html`
    <article class=${`card ${props.class ?? ''}`}>
      ${props.title || props.actions ? html`
        <header class="card-head">
          ${props.title
            ? html`<h2>${props.title}${props.subtitle ? html`<span class="card-sub">${props.subtitle}</span>` : null}</h2>`
            : html`<span></span>`}
          ${props.actions ?? null}
        </header>` : null}
      ${props.children}
    </article>`;
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export interface Trend {
  /** e.g. "+12%" or "+3"; the sign is part of the text. */
  readonly text: string;
  readonly direction: 'up' | 'down' | 'flat';
  /** What the change compares, shown on hover. */
  readonly title?: string;
}

/** Change of the last `window` days against the `window` days before, in percent. */
export function periodTrend(values: readonly number[], window = 7): Trend | null {
  if (values.length < window * 2) return null;
  const sum = (list: readonly number[]): number => list.reduce((total, value) => total + value, 0);
  const current = sum(values.slice(-window));
  const previous = sum(values.slice(-window * 2, -window));
  const title = `Son ${window} gün ${current}, önceki ${window} gün ${previous}`;
  if (previous === 0) {
    return current === 0 ? { text: '0%', direction: 'flat', title } : { text: `+${current}`, direction: 'up', title };
  }
  const change = Math.round(((current - previous) / previous) * 100);
  return { text: `${change > 0 ? '+' : ''}${change}%`, direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat', title };
}

/** Rising counts are good news on this panel; the arrow and the sign carry the direction, not colour alone. */
export function TrendBadge(props: { trend: Trend }): VNode {
  const { trend } = props;
  return html`<span class=${`trend trend-${trend.direction}`} title=${trend.title ?? ''}>
    ${trend.direction === 'flat' ? null : Icon({ name: trend.direction === 'up' ? 'trendUp' : 'trendDown', size: 14 })}${trend.text}</span>`;
}

export function Stat(props: {
  label: string; value: Child; sub?: Child; tone?: Tone; meter?: number; icon?: IconName; trend?: Trend | null; spark?: Child;
}): VNode {
  const meter = props.meter === undefined ? null : Math.max(0, Math.min(1, props.meter));
  const meterTone = meter === null ? '' : meter >= 0.9 ? 'bad' : meter >= 0.75 ? 'warn' : 'info';
  const iconTone = props.tone === 'warn' || props.tone === 'bad' ? `stat-icon-${props.tone}` : '';
  return html`
    <div class=${`stat ${props.tone ? `stat-${props.tone}` : ''}`}>
      <div class="stat-top">
        <span class="stat-label">${props.label}</span>
        ${props.icon ? html`<span class=${`stat-icon ${iconTone}`}>${Icon({ name: props.icon, size: 17 })}</span>` : null}
      </div>
      <strong class="stat-value">${props.value}</strong>
      ${props.sub || props.trend
        ? html`<span class="stat-sub">${props.trend ? html`<${TrendBadge} trend=${props.trend} />` : null}${props.sub ?? null}</span>`
        : null}
      ${meter === null ? null : html`
        <span class=${`meter meter-${meterTone}`} role="meter" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow=${Math.round(meter * 100)}><span style=${`width:${meter * 100}%`}></span></span>`}
      ${props.spark ?? null}
    </div>`;
}

/** A labelled ratio against a limit, e.g. users against the sign-up cap. */
export function Meter(props: {
  label: Child; value: number; max: number; valueText?: Child; left?: Child; right?: Child; tone?: 'good' | 'info' | 'warn' | 'bad';
}): VNode {
  const ratio = props.max > 0 ? Math.max(0, Math.min(1, props.value / props.max)) : 0;
  const tone = props.tone ?? (ratio >= 0.9 ? 'bad' : ratio >= 0.75 ? 'warn' : 'info');
  return html`<div>
    <div class="goal-row"><span>${props.label}</span><strong>${props.valueText ?? `%${Math.round(ratio * 100)}`}</strong></div>
    <span class=${`meter meter-${tone}`} role="meter" aria-valuemin="0" aria-valuemax=${props.max} aria-valuenow=${props.value}>
      <span style=${`width:${ratio * 100}%`}></span></span>
    ${props.left || props.right ? html`<div class="goal-foot"><span>${props.left ?? ''}</span><span>${props.right ?? ''}</span></div>` : null}
  </div>`;
}

/** State is never colour alone: every badge has a label. */
export function Badge(props: { tone: Tone; label: string; title?: string }): VNode {
  return html`<span class=${`badge badge-${props.tone}`} title=${props.title ?? ''}>
    <span class="badge-dot" aria-hidden="true"></span>${props.label}</span>`;
}

/** A stable colour for an initials avatar, so the same name always looks the same. */
function hue(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 6;
}

export function Avatar(props: { src?: string | null; name: string; size?: number; square?: boolean }): VNode {
  const size = props.size ?? 32;
  const style = `width:${size}px;height:${size}px${size >= 48 ? `;font-size:${Math.round(size * 0.4)}px` : ''}`;
  return props.src
    ? html`<img class=${`avatar ${props.square ? 'avatar-square' : ''}`} src=${props.src} alt="" style=${style} loading="lazy" />`
    : html`<span class=${`avatar avatar-empty avatar-hue-${hue(props.name)} ${props.square ? 'avatar-square' : ''}`} style=${style}
        aria-hidden="true">${props.name.trim().charAt(0).toUpperCase() || '?'}</span>`;
}

/** "3 gün önce" with the exact date and time on hover; `empty` when there is no time. */
export function When(props: { at: string | null | undefined; empty?: string }): VNode {
  if (!props.at) return html`<span class="muted">${props.empty ?? '—'}</span>`;
  return html`<time datetime=${props.at} title=${dateTime(props.at)}>${relative(props.at)}</time>`;
}

/** Page-level placeholder in the shape of the content that is coming. */
export function Loading(): VNode {
  return html`<div class="skeleton" aria-busy="true" aria-label="Yükleniyor">
    <div class="skeleton-row">${[0, 1, 2, 3].map((index) => html`<span key=${index} class="skeleton-block"></span>`)}</div>
    <span class="skeleton-block tall"></span>
  </div>`;
}

/** Progress inside a card. */
export function Spinner(): VNode {
  return html`<div class="state"><span class="spinner" aria-hidden="true"></span> Yükleniyor…</div>`;
}

export function ErrorBox(props: { message: string; retry?: () => void }): VNode {
  return html`<div class="state state-error" role="alert">
    ${Icon({ name: 'alert', size: 18 })}<strong>Yüklenemedi.</strong> ${props.message}
    ${props.retry ? html` <button class="btn btn-small" onClick=${props.retry}>${Icon({ name: 'refresh', size: 14 })}Tekrar dene</button>` : null}
  </div>`;
}

export function Empty(props: { children: Child }): VNode {
  return html`<p class="empty">${props.children}</p>`;
}

export function Facts(props: { rows: ReadonlyArray<readonly [string, Child]> }): VNode {
  return html`<dl class="facts">${props.rows.map(([label, value]) => html`
    <div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
}

export function CopyText(props: { value: string }): VNode {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(props.value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return html`<button class=${`copy ${copied ? 'copied' : ''}`} title=${copied ? 'Kopyalandı' : 'Kopyala'} onClick=${copy}>
    <code>${props.value}</code>${Icon({ name: copied ? 'check' : 'copy', size: 14 })}</button>`;
}

/** Proportional bars for a small distribution; the number is always printed. */
export function BarList(props: { rows: ReadonlyArray<{ label: Child; value: number; key: string; title?: string }>; empty?: string }): VNode {
  const max = Math.max(1, ...props.rows.map((row) => row.value));
  const total = props.rows.reduce((sum, row) => sum + row.value, 0);
  if (props.rows.length === 0) return Empty({ children: props.empty ?? 'Veri yok.' });
  return html`<ul class="barlist">${props.rows.map((row) => html`
    <li key=${row.key}>
      <span class="barlist-label" title=${row.title ?? (typeof row.label === 'string' ? row.label : '')}>${row.label}</span>
      <span class="barlist-track"><span class="barlist-fill" style=${`width:${(row.value / max) * 100}%`}></span></span>
      <span class="barlist-value">${row.value.toLocaleString('tr-TR')}
        <small>${total > 0 ? `%${Math.round((row.value / total) * 100)}` : ''}</small></span>
    </li>`)}</ul>`;
}

export interface Column<T> {
  readonly key: string;
  readonly label: string;
  readonly render: (row: T) => Child;
  readonly sort?: (row: T) => string | number | null;
  readonly csv?: (row: T) => string | number | null;
  readonly align?: 'end';
  readonly hideOnMobile?: boolean;
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadCsv<T>(name: string, columns: readonly Column<T>[], rows: readonly T[]): void {
  const exportable = columns.filter((column) => column.csv);
  const lines = [
    exportable.map((column) => csvCell(column.label)).join(','),
    ...rows.map((row) => exportable.map((column) => csvCell(column.csv!(row))).join(',')),
  ];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A search field with its icon; used in table toolbars and the logs page. */
export function SearchInput(props: { value: string; placeholder: string; onInput: (value: string) => void }): VNode {
  return html`<label class="search-box">${Icon({ name: 'search' })}
    <input class="input" type="search" placeholder=${props.placeholder} aria-label=${props.placeholder}
      value=${props.value} onInput=${(event: Event) => props.onInput((event.target as HTMLInputElement).value)} /></label>`;
}

export function DataTable<T>(props: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  onRow?: (row: T) => void;
  search?: (row: T) => string;
  searchPlaceholder?: string;
  csvName?: string;
  /** Columns for the CSV export; defaults to the visible columns. */
  csvColumns?: readonly Column<T>[];
  initialSort?: { key: string; direction: 'asc' | 'desc' };
  toolbar?: Child;
  pageSize?: number;
  empty?: string;
}): VNode {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(props.initialSort ?? null);
  const [limit, setLimit] = useState(props.pageSize ?? 50);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('tr-TR');
    let rows = needle && props.search
      ? props.rows.filter((row) => props.search!(row).toLocaleLowerCase('tr-TR').includes(needle))
      : [...props.rows];
    const column = sort ? props.columns.find((candidate) => candidate.key === sort.key) : undefined;
    if (sort && column?.sort) {
      const direction = sort.direction === 'asc' ? 1 : -1;
      rows = rows.sort((left, right) => {
        const a = column.sort!(left);
        const b = column.sort!(right);
        if (a === b) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return (a < b ? -1 : 1) * direction;
      });
    }
    return rows;
  }, [props.rows, query, sort, props.columns]);
  const toggleSort = (key: string): void => setSort((current) =>
    current?.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'desc' });

  return html`
    <div class="table-wrap">
      ${props.search || props.csvName || props.toolbar ? html`
        <div class="toolbar">
          ${props.search ? SearchInput({ value: query, placeholder: props.searchPlaceholder ?? 'Ara…', onInput: setQuery }) : null}
          ${props.toolbar ?? null}
          <span class="toolbar-spacer"></span>
          <span class="count-pill">${filtered.length.toLocaleString('tr-TR')} kayıt</span>
          ${props.csvName ? html`<button class="btn btn-small" onClick=${() => downloadCsv(props.csvName!, props.csvColumns ?? props.columns, filtered)}>
            ${Icon({ name: 'download', size: 14 })}CSV</button>` : null}
        </div>` : null}
      <div class="table-scroll">
        <table>
          <thead><tr>${props.columns.map((column) => html`
            <th class=${`${column.align === 'end' ? 'end' : ''} ${column.hideOnMobile ? 'hide-mobile' : ''}`}
              aria-sort=${sort?.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
              ${column.sort ? html`<button class="th-sort" onClick=${() => toggleSort(column.key)}>${column.label}
                <span class="sort-mark" aria-hidden="true">${sort?.key === column.key ? (sort.direction === 'asc' ? '▲' : '▼') : ''}</span></button>`
                : column.label}
            </th>`)}</tr></thead>
          <tbody>
            ${filtered.slice(0, limit).map((row) => html`
              <tr key=${props.rowKey(row)} class=${props.onRow ? 'clickable' : ''}
                onClick=${props.onRow ? () => props.onRow!(row) : undefined}>
                ${props.columns.map((column) => html`<td class=${`${column.align === 'end' ? 'end' : ''} ${column.hideOnMobile ? 'hide-mobile' : ''}`}>
                  ${column.render(row)}</td>`)}
              </tr>`)}
          </tbody>
        </table>
        ${filtered.length === 0 ? Empty({ children: props.empty ?? 'Kayıt yok.' }) : null}
      </div>
      ${filtered.length > limit ? html`<button class="btn more" onClick=${() => setLimit(limit + (props.pageSize ?? 50))}>
        Daha fazla göster (${(filtered.length - limit).toLocaleString('tr-TR')} kaldı)</button>` : null}
    </div>`;
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useTicker(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function useElementSize(): [{ current: HTMLElement | null }, number, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      setSize({ width: box?.width ?? 0, height: box?.height ?? 0 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size.width, size.height];
}
