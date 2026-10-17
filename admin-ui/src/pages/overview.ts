import { html, useState, type VNode } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { AreaChart, carryForward, DailyColumns, Donut, fillDays, Sparkline } from '../chart.js';
import {
  checkStatusNames, compact, country, day, duration, flag, bytes, languageNames, notificationModeNames, num, relative,
} from '../format.js';
import { Icon } from '../icons.js';
import { BotControls } from '../bot-controls.js';
import { checkErrorInfo, checkFixNames } from '../explain.js';
import type { Overview } from '../types.js';
import {
  Badge, BarList, Card, ErrorBox, Facts, Loading, Meter, Page, Stat, When, useAsync, useTicker, RefreshButton, live, periodTrend,
  type Tone, type Trend,
} from '../ui.js';

export function SchedulerFacts(props: { scheduler: Overview['scheduler'] }): VNode {
  const { scheduler } = props;
  const last = scheduler.lastRun;
  return Facts({ rows: [
    ['Durum', scheduler.running
      ? Badge({ tone: 'info', label: `Tarıyor (${relative(scheduler.runStartedAt)} başladı)` })
      : scheduler.paused ? Badge({ tone: 'warn', label: 'Otomatik tarama duraklatıldı' })
        : Badge({ tone: 'neutral', label: 'Beklemede' })],
    ['Sonraki tarama', scheduler.paused ? html`<span class="muted">Duraklatıldı (sürdürünce ${When({ at: scheduler.nextScheduledAt })})</span>`
      : When({ at: scheduler.nextScheduledAt })],
    ['Aralık', duration(scheduler.intervalMs)],
    ['Son tarama', last ? html`${When({ at: last.completedAt })} · ${duration(last.durationMs)}` : 'Bu açılıştan beri yok'],
    ['Son taramada', last
      ? `${num(last.completedCount)}/${num(last.userCount)} kullanıcı · ${num(last.checkedGames)} oyun · ${num(last.dmSent)} DM`
      : '—'],
    ['Son tarama hataları', last
      ? `${num(last.errorCount)} kullanıcı · ${num(last.steamItemErrors)} oyun hatası · ${num(last.dmFailed)} DM hatası`
      : '—'],
  ] });
}

const checkTones: Readonly<Record<string, Tone>> = {
  success: 'good', unavailable: 'warn', failed: 'bad', pending: 'info', never: 'neutral',
};

type Series = 'alerts' | 'active' | 'signups' | 'guilds';
const seriesTabs: ReadonlyArray<readonly [Series, string]> = [
  ['alerts', 'Uyarılar'], ['active', 'Aktif kullanıcı'], ['signups', 'Kayıtlar'], ['guilds', 'Sunucular'],
];
const seriesNotes: Readonly<Record<Series, string>> = {
  alerts: 'Gün başına gönderilen indirim uyarısı',
  active: 'Gün başına etkileşen farklı kullanıcı',
  signups: 'Gün başına tamamlanan kurulum',
  guilds: 'Her gün sonunda botun ekli olduğu sunucu sayısı',
};

function ActivityCard(props: { charts: Overview['charts'] }): VNode {
  const [series, setSeries] = useState<Series>('alerts');
  const { charts } = props;
  const chart = series === 'alerts' ? html`<${DailyColumns} key="alerts" rows=${charts.alerts} days=${30} unit="uyarı" height=${280} fill />`
    : series === 'active' ? html`<${AreaChart} key="active" rows=${charts.activeUsers} days=${30} unit="kişi-gün" height=${280} fill />`
      : series === 'signups' ? html`<${DailyColumns} key="signups" rows=${charts.signups} days=${90} unit="kayıt" height=${280} fill />`
        : html`<${AreaChart} key="guilds" rows=${carryForward(charts.guilds, 90)} days=${90} unit="sunucu" level total=${false} height=${280} fill />`;
  return Card({
    title: 'Etkinlik',
    class: 'card-fill',
    subtitle: seriesNotes[series],
    actions: html`<div class="segmented" role="tablist" aria-label="Seri">${seriesTabs.map(([key, label]) => html`
      <button role="tab" aria-selected=${series === key} class=${`tab ${series === key ? 'active' : ''}`}
        onClick=${() => setSeries(key)}>${label}</button>`)}</div>`,
    children: chart,
  });
}

/** Users over the signup window, rebuilt backwards from today's total (deletions are not in the series). */
function userGrowth(total: number, signups: Overview['charts']['signups']): number[] {
  const days = fillDays(signups, 60);
  let running = total;
  const values: number[] = [];
  for (let index = days.length - 1; index >= 0; index -= 1) {
    values.unshift(running);
    running -= days[index]!.count;
  }
  return values;
}

function levelTrend(values: readonly number[]): Trend {
  const change = (values[values.length - 1] ?? 0) - (values[0] ?? 0);
  return { text: `${change > 0 ? '+' : ''}${num(change)}`, direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
}

export function OverviewPage(): VNode {
  const state = useAsync(() => api.get<Overview>('/api/overview'), [], live);
  useTicker(30_000);
  const data = state.data;
  const actions = html`<${RefreshButton} state=${state} />`;
  const subtitle = 'Dealio’nun bugünkü durumu: kullanıcılar, uyarılar, tarayıcı ve bot.';
  if (!data) {
    return Page({ title: 'Genel bakış', subtitle, actions,
      children: state.error ? ErrorBox({ message: state.error, retry: state.reload }) : Loading() });
  }
  const { counts, charts } = data;
  const app = data.application;
  const host = data.process.hostMemory;
  const guildLevels = carryForward(charts.guilds, 30).map((row) => row.count);
  const growth = userGrowth(counts.users, charts.signups);
  const active = fillDays(charts.activeUsers, 30).map((row) => row.count);
  const alerts = fillDays(charts.alerts, 30).map((row) => row.count);
  const queued = counts.queuePending + counts.queueRetry + counts.queueSending;
  const checkTotal = data.distributions.checkStatuses.reduce((sum, row) => sum + row.count, 0);
  // Days of usage tracking available (interaction_event), counting today.
  const trackedDays = data.telemetrySince ? Math.floor((Date.now() - new Date(data.telemetrySince).getTime()) / 86_400_000) + 1 : 0;

  return Page({
    title: 'Genel bakış',
    subtitle,
    actions,
    children: html`
      ${state.error ? ErrorBox({ message: state.error, retry: state.reload }) : null}
      <div class="stats">
        ${Stat({ label: 'Sunucular', icon: 'server', value: num(data.guilds.count),
          trend: levelTrend(guildLevels), sub: `30 günde · ${compact(data.guilds.members)} üye`,
          spark: Sparkline({ values: guildLevels, label: 'Son 30 günde sunucu sayısı' }) })}
        ${Stat({ label: 'Kayıtlı kullanıcı', icon: 'users', value: data.maxUsers === null ? num(counts.users) : html`${num(counts.users)}<small> / ${num(data.maxUsers)}</small>`,
          tone: data.settings.signupsOpen ? undefined : 'warn',
          trend: { text: `+${num(counts.newUsers7d)}`, direction: counts.newUsers7d > 0 ? 'up' : 'flat' },
          sub: data.settings.signupsOpen ? `bu hafta · bugün +${num(counts.newUsers24h)}` : 'bu hafta · kayıtlar kapalı',
          spark: Sparkline({ values: growth, label: 'Son 60 günde kayıtlı kullanıcı' }) })}
        ${Stat({ label: 'Aktif kullanıcı (24 sa)', icon: 'activity', value: num(data.activity.active24h),
          trend: trackedDays >= 14 ? periodTrend(active) : null,
          sub: trackedDays >= 30 ? `7 günde ${num(data.activity.active7d)} · 30 günde ${num(data.activity.active30d)}`
            : data.telemetrySince ? `kayıt ${day(data.telemetrySince)} tarihinden beri · 7 günde ${num(data.activity.active7d)}` : 'henüz kayıt yok',
          spark: Sparkline({ values: active, label: 'Son 30 günde günlük aktif kullanıcı' }) })}
        ${Stat({ label: 'Gönderilen uyarı (24 sa)', icon: 'bell', value: num(counts.alertsSent24h),
          trend: periodTrend(alerts), sub: `7 günde ${num(counts.alertsSent7d)} · toplam ${compact(counts.alertsSentTotal)}`,
          spark: Sparkline({ values: alerts, label: 'Son 30 günde günlük uyarı' }) })}
      </div>

      <${BotControls} data=${data} onChanged=${state.reload} />

      <div class="grid-main">
        <${ActivityCard} charts=${charts} />
        ${Card({ title: 'Kontrol durumu', subtitle: 'Kullanıcıların son wishlist kontrolü', children: html`
          ${Donut({ unit: 'kullanıcı', slices: data.distributions.checkStatuses.map((row) => ({
            key: row.key, label: checkStatusNames[row.key] ?? row.key, value: row.count, tone: checkTones[row.key] ?? 'neutral' })) })}
          ${data.distributions.checkErrors.length > 0 ? html`<h3 class="sub-head">Neden başarısız?</h3>
            <ul class="reasons">${data.distributions.checkErrors.map((row) => {
              const info = checkErrorInfo(row.key);
              return html`<li key=${row.key}>
                <div class="reasons-head"><strong title=${row.key}>${info.title}</strong>
                  <span class="reasons-count">${num(row.count)} kullanıcı</span></div>
                <p class="muted small">${info.detail}</p>
                <div class="reason-meta">${Badge({ tone: info.fix === 'owner' ? 'bad' : info.fix === 'user' ? 'warn' : 'neutral',
                  label: checkFixNames[info.fix] })}<a class="small" href="#/users?check=problem">Kullanıcıları gör</a></div>
              </li>`;
            })}</ul>` : null}
          ${checkTotal === 0 ? html`<p class="empty">Henüz kontrol yok.</p>` : null}` })}
      </div>

      <div class="grid-3">
        ${Card({ title: 'Durum', subtitle: 'Kapasite, izleme ve bildirim kuyruğu', children: html`
          <div class="goals">
            ${data.maxUsers === null
              ? Meter({ label: 'Sunucu belleği', value: host.totalBytes - host.availableBytes, max: host.totalBytes,
                left: `bot ${bytes(data.process.rssBytes)} · ${bytes(host.availableBytes)} boş`, right: 'kayıt sınırı yok' })
              : Meter({ label: 'Kullanıcı kapasitesi', value: counts.users, max: data.maxUsers,
                left: `${num(counts.users)} kayıtlı`, right: `sınır ${num(data.maxUsers)}` })}
            ${Meter({ label: 'İzleme açık', value: counts.enabled, max: Math.max(1, counts.users), tone: 'good',
              left: `${num(counts.enabled)} kullanıcı`, right: `${num(counts.paused)} duraklatıldı · ${num(counts.dmBlocked)} DM engelli` })}
            ${Meter({ label: 'Şu an indirimde', value: counts.gamesOnSale, max: Math.max(1, counts.trackedGames), tone: 'info',
              left: `${num(counts.gamesOnSale)} / ${compact(counts.trackedGames)} oyun`, right: `${num(counts.rules)} özel kural` })}
          </div>
          <div class="mini-stats">
            <div title=${`${num(counts.queuePending)} bekliyor · ${num(counts.queueRetry)} tekrar · ${num(counts.queueSending)} gönderiliyor`}>
              <span>Kuyrukta</span><strong>${num(queued)}</strong></div>
            <div><span>Başarısız · 7 g</span><strong class=${counts.terminalFailed7d > 0 ? 'trend-down' : ''}>${num(counts.terminalFailed7d)}</strong></div>
            <div><span>Tekrar denenecek</span><strong>${num(counts.queueRetry)}</strong></div>
          </div>` })}
        ${Card({ title: 'Bot', actions: data.discord.ready ? Badge({ tone: 'good', label: 'Bağlı' }) : Badge({ tone: 'bad', label: 'Bağlı değil' }),
          children: Facts({ rows: [
            ['Gecikme', data.discord.pingMs === null ? '—' : `${num(data.discord.pingMs)} ms`],
            ['Bot hesabı', data.discord.botUser ? `${data.discord.botUser.username}` : '—'],
            ['Yaklaşık sunucu', num(app?.approximateGuildCount ?? null)],
            ['Kişisel kurulum', num(app?.approximateUserInstallCount ?? null)],
            ['Çalışma süresi', duration(data.process.uptimeSeconds * 1000)],
            ['Bellek (RSS)', bytes(data.process.rssBytes)],
          ] }) })}
        ${Card({ title: 'Tarayıcı', actions: html`<a class="btn btn-small btn-ghost" href="#/system">Sistem ${Icon({ name: 'chevronRight', size: 14 })}</a>`,
          children: SchedulerFacts({ scheduler: data.scheduler }) })}
      </div>

      <div class="grid-3">
        ${Card({ title: 'Mağaza ülkeleri', children: BarList({ rows: data.distributions.countries.map((row) => ({
          key: row.key, label: html`<span class="flag">${flag(row.key)}</span> ${country(row.key)}`, value: row.count })) }) })}
        ${Card({ title: 'Diller', children: BarList({ rows: data.distributions.languages.map((row) => ({
          key: row.key, label: languageNames[row.key] ?? row.key, value: row.count })) }) })}
        ${Card({ title: 'Bildirim zamanlaması', children: html`
          ${BarList({ rows: data.distributions.notificationModes.map((row) => ({
            key: row.key, label: notificationModeNames[row.key] ?? row.key, value: row.count })) })}
          <h3 class="sub-head">Para birimleri (kullanıcı)</h3>
          ${BarList({ rows: data.distributions.currencies.map((row) => ({ key: row.key, label: row.key, value: row.count })) })}` })}
      </div>`,
  });
}
