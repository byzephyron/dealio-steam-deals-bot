import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { preparedStatement } from './prepared-statement.js';

export type InteractionContext = 'guild' | 'bot_dm' | 'private_channel' | 'unknown';
export type InstallType = 'guild' | 'user' | 'both' | 'unknown';
export type InteractionKind = 'command' | 'component' | 'modal' | 'setup';

export interface InteractionRecord {
  readonly discordUserId: string;
  readonly guildId: string | null;
  readonly context: InteractionContext;
  readonly install: InstallType;
  readonly kind: InteractionKind;
  readonly action: string;
  readonly locale: string | null;
  readonly occurredAt: string;
}

export interface GuildEventRecord {
  readonly guildId: string;
  readonly guildName: string;
  readonly memberCount: number | null;
  readonly event: 'join' | 'leave';
  readonly occurredAt: string;
}

export interface UsageCount { readonly key: string; readonly count: number; readonly users: number }
export interface DailyActive { readonly day: string; readonly count: number }
export interface GuildSource {
  readonly guildId: string;
  readonly users: number;
  readonly registeredUsers: number;
  readonly lastSeenAt: string;
}

/** Telemetry rows are kept 90 days, like price observations. */
export const telemetryRetentionMs = 90 * 24 * 3600_000;

type Row = Record<string, SQLOutputValue>;
const text = (value: SQLOutputValue): string => (typeof value === 'string' ? value : String(value ?? ''));
const int = (value: SQLOutputValue): number => (typeof value === 'number' ? value : Number(value ?? 0));

export class TelemetryRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public recordInteraction(record: InteractionRecord): void {
    preparedStatement(this.database, `INSERT INTO interaction_event
      (discord_user_id, guild_id, context, install, kind, action, locale, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.discordUserId, record.guildId, record.context, record.install,
      record.kind, record.action.slice(0, 80), record.locale, record.occurredAt);
  }

  public recordGuildEvent(record: GuildEventRecord): void {
    preparedStatement(this.database, `INSERT INTO guild_event (guild_id, guild_name, member_count, event, occurred_at)
      VALUES (?, ?, ?, ?, ?)`).run(record.guildId, record.guildName.slice(0, 100), record.memberCount, record.event,
      record.occurredAt);
  }

  /** The latest recorded event per server, to tell joins we have not seen yet. */
  public latestGuildEvents(): Map<string, { readonly event: 'join' | 'leave'; readonly guildName: string }> {
    const rows = this.database.prepare(`
      SELECT guild_id, guild_name, event FROM guild_event AS outer_event
      WHERE id = (SELECT MAX(id) FROM guild_event WHERE guild_id = outer_event.guild_id)`).all() as Row[];
    return new Map(rows.map((row) => [text(row.guild_id),
      { event: text(row.event) as 'join' | 'leave', guildName: text(row.guild_name) }]));
  }

  public guildEvents(limit: number, guildId?: string): GuildEventRecord[] {
    const rows = (guildId
      ? this.database.prepare(`SELECT * FROM guild_event WHERE guild_id = ? ORDER BY id DESC LIMIT ?`).all(guildId, limit)
      : this.database.prepare(`SELECT * FROM guild_event ORDER BY id DESC LIMIT ?`).all(limit)) as Row[];
    return rows.map((row) => ({
      guildId: text(row.guild_id),
      guildName: text(row.guild_name),
      memberCount: row.member_count === null ? null : int(row.member_count),
      event: text(row.event) as 'join' | 'leave',
      occurredAt: text(row.occurred_at),
    }));
  }

  /** Servers the bot has left, with their last known name. */
  public departedGuilds(): GuildEventRecord[] {
    return (this.database.prepare(`
      SELECT * FROM guild_event AS outer_event
      WHERE event = 'leave' AND id = (SELECT MAX(id) FROM guild_event WHERE guild_id = outer_event.guild_id)
      ORDER BY occurred_at DESC`).all() as Row[]).map((row) => ({
      guildId: text(row.guild_id),
      guildName: text(row.guild_name),
      memberCount: row.member_count === null ? null : int(row.member_count),
      event: 'leave' as const,
      occurredAt: text(row.occurred_at),
    }));
  }

  /** Per UTC day, the number of servers the bot was in at the end of the day. */
  public guildCountByDay(): DailyActive[] {
    const rows = this.database.prepare(`SELECT substr(occurred_at, 1, 10) AS day,
        SUM(CASE WHEN event = 'join' THEN 1 ELSE -1 END) AS delta
      FROM guild_event GROUP BY day ORDER BY day`).all() as Row[];
    let running = 0;
    return rows.map((row) => {
      running += int(row.delta);
      return { day: text(row.day), count: Math.max(0, running) };
    });
  }

  public dailyActiveUsers(since: string): DailyActive[] {
    return (this.database.prepare(`SELECT substr(occurred_at, 1, 10) AS day, COUNT(DISTINCT discord_user_id) AS count
      FROM interaction_event WHERE occurred_at >= ? AND kind != 'setup' GROUP BY day ORDER BY day`).all(since) as Row[])
      .map((row) => ({ day: text(row.day), count: int(row.count) }));
  }

  /** The oldest kept interaction: usage figures cover only the time from here on. */
  public firstEventAt(): string | null {
    const row = this.database.prepare('SELECT MIN(occurred_at) AS first FROM interaction_event').get() as Row;
    return row.first === null || row.first === undefined ? null : text(row.first);
  }

  public activeUsersSince(since: string): number {
    return int((this.database.prepare(`SELECT COUNT(DISTINCT discord_user_id) AS n FROM interaction_event
      WHERE occurred_at >= ? AND kind != 'setup'`).get(since) as Row).n);
  }

  public usageBy(column: 'action' | 'context' | 'install' | 'locale', since: string, kinds: readonly string[] = ['command', 'component', 'modal']): UsageCount[] {
    const placeholders = kinds.map(() => '?').join(', ');
    return (this.database.prepare(`SELECT COALESCE(${column}, 'unknown') AS key, COUNT(*) AS count,
        COUNT(DISTINCT discord_user_id) AS users
      FROM interaction_event WHERE occurred_at >= ? AND kind IN (${placeholders})
      GROUP BY key ORDER BY count DESC LIMIT 60`).all(since, ...kinds) as Row[])
      .map((row) => ({ key: text(row.key), count: int(row.count), users: int(row.users) }));
  }

  /** How each user first reached Dealio and how setup went: distinct users per step. */
  public setupFunnel(since: string): UsageCount[] {
    return (this.database.prepare(`SELECT action AS key, COUNT(*) AS count, COUNT(DISTINCT discord_user_id) AS users
      FROM interaction_event WHERE occurred_at >= ? AND kind = 'setup'
      GROUP BY action ORDER BY users DESC`).all(since) as Row[])
      .map((row) => ({ key: text(row.key), count: int(row.count), users: int(row.users) }));
  }

  /** Servers users interacted from, with how many of those users are registered now. */
  public guildSources(): GuildSource[] {
    return (this.database.prepare(`SELECT event.guild_id, COUNT(DISTINCT event.discord_user_id) AS users,
        COUNT(DISTINCT config.discord_user_id) AS registered, MAX(event.occurred_at) AS last_seen
      FROM interaction_event AS event
      LEFT JOIN user_config AS config ON config.discord_user_id = event.discord_user_id
      WHERE event.guild_id IS NOT NULL GROUP BY event.guild_id`).all() as Row[])
      .map((row) => ({
        guildId: text(row.guild_id), users: int(row.users), registeredUsers: int(row.registered), lastSeenAt: text(row.last_seen),
      }));
  }

  /** Registered users who used Dealio from a server. */
  public guildUsers(guildId: string): Array<{ discordUserId: string; interactions: number; lastSeenAt: string; registered: boolean }> {
    return (this.database.prepare(`SELECT event.discord_user_id, COUNT(*) AS interactions, MAX(event.occurred_at) AS last_seen,
        MAX(config.discord_user_id IS NOT NULL) AS registered
      FROM interaction_event AS event
      LEFT JOIN user_config AS config ON config.discord_user_id = event.discord_user_id
      WHERE event.guild_id = ? GROUP BY event.discord_user_id ORDER BY last_seen DESC LIMIT 500`).all(guildId) as Row[])
      .map((row) => ({
        discordUserId: text(row.discord_user_id), interactions: int(row.interactions), lastSeenAt: text(row.last_seen),
        registered: int(row.registered) === 1,
      }));
  }

  /** Per user: first/last activity, install types and the servers they used Dealio in. */
  public userUsage(discordUserId: string): {
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    interactions: number;
    installs: string[];
    guilds: Array<{ guildId: string; count: number; lastSeenAt: string }>;
    recent: Array<{ kind: string; action: string; context: string; guildId: string | null; occurredAt: string }>;
  } {
    const totals = this.database.prepare(`SELECT MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen, COUNT(*) AS n
      FROM interaction_event WHERE discord_user_id = ?`).get(discordUserId) as Row;
    const installs = (this.database.prepare(`SELECT DISTINCT install FROM interaction_event
      WHERE discord_user_id = ? AND install != 'unknown'`).all(discordUserId) as Row[]).map((row) => text(row.install));
    const guilds = (this.database.prepare(`SELECT guild_id, COUNT(*) AS n, MAX(occurred_at) AS last_seen FROM interaction_event
      WHERE discord_user_id = ? AND guild_id IS NOT NULL GROUP BY guild_id ORDER BY last_seen DESC`).all(discordUserId) as Row[])
      .map((row) => ({ guildId: text(row.guild_id), count: int(row.n), lastSeenAt: text(row.last_seen) }));
    const recent = (this.database.prepare(`SELECT kind, action, context, guild_id, occurred_at FROM interaction_event
      WHERE discord_user_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 100`).all(discordUserId) as Row[])
      .map((row) => ({
        kind: text(row.kind), action: text(row.action), context: text(row.context),
        guildId: row.guild_id === null ? null : text(row.guild_id), occurredAt: text(row.occurred_at),
      }));
    return {
      firstSeenAt: totals.first_seen === null ? null : text(totals.first_seen),
      lastSeenAt: totals.last_seen === null ? null : text(totals.last_seen),
      interactions: int(totals.n),
      installs,
      guilds,
      recent,
    };
  }

  /** First server each user was seen in, for the user list's "source" column. */
  public firstGuildByUser(): Map<string, string> {
    const rows = this.database.prepare(`SELECT discord_user_id, guild_id FROM interaction_event AS outer_event
      WHERE guild_id IS NOT NULL AND id = (SELECT MIN(id) FROM interaction_event
        WHERE discord_user_id = outer_event.discord_user_id AND guild_id IS NOT NULL)`).all() as Row[];
    return new Map(rows.map((row) => [text(row.discord_user_id), text(row.guild_id)]));
  }

  public lastSeenByUser(): Map<string, string> {
    const rows = this.database.prepare(`SELECT discord_user_id, MAX(occurred_at) AS last_seen FROM interaction_event
      GROUP BY discord_user_id`).all() as Row[];
    return new Map(rows.map((row) => [text(row.discord_user_id), text(row.last_seen)]));
  }

  public deleteUser(discordUserId: string): number {
    return Number(preparedStatement(this.database, 'DELETE FROM interaction_event WHERE discord_user_id = ?')
      .run(discordUserId).changes);
  }

  public cleanup(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - telemetryRetentionMs).toISOString();
    return Number(preparedStatement(this.database, 'DELETE FROM interaction_event WHERE occurred_at < ?').run(cutoff).changes);
  }
}
