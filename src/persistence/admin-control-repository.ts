import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { hashDiscordUserId } from './deletion-journal.js';
import { preparedStatement } from './prepared-statement.js';

/** Owner controls: blocks, runtime settings and the admin audit trail. */

export interface UserBlock { readonly discordUserId: string; readonly reason: string | null; readonly blockedAt: string }
export interface GuildBlock {
  readonly guildId: string;
  readonly guildName: string | null;
  readonly reason: string | null;
  readonly blockedAt: string;
}
export interface AuditEntry {
  readonly id: number;
  readonly action: string;
  readonly target: string | null;
  readonly detail: string | null;
  readonly outcome: 'ok' | 'failed';
  readonly occurredAt: string;
}

type Row = Record<string, SQLOutputValue>;
const text = (value: SQLOutputValue): string => (typeof value === 'string' ? value : String(value ?? ''));
const textOrNull = (value: SQLOutputValue): string | null => (value === null || value === undefined ? null : text(value));

export const auditRetentionMs = 365 * 24 * 3600_000;

export class AdminControlRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public isUserBlocked(discordUserId: string): boolean {
    return preparedStatement(this.database, 'SELECT 1 FROM user_block WHERE discord_user_id = ?').get(discordUserId) !== undefined;
  }

  public blockUser(discordUserId: string, reason: string | null, at: string): void {
    preparedStatement(this.database, `INSERT INTO user_block (discord_user_id, reason, blocked_at) VALUES (?, ?, ?)
      ON CONFLICT(discord_user_id) DO UPDATE SET reason = excluded.reason`).run(discordUserId, reason, at);
  }

  public unblockUser(discordUserId: string): boolean {
    return Number(preparedStatement(this.database, 'DELETE FROM user_block WHERE discord_user_id = ?').run(discordUserId).changes) > 0;
  }

  public userBlocks(): UserBlock[] {
    return (this.database.prepare('SELECT * FROM user_block ORDER BY blocked_at DESC').all() as Row[]).map((row) => ({
      discordUserId: text(row.discord_user_id), reason: textOrNull(row.reason), blockedAt: text(row.blocked_at),
    }));
  }

  public isGuildBlocked(guildId: string): boolean {
    return preparedStatement(this.database, 'SELECT 1 FROM guild_block WHERE guild_id = ?').get(guildId) !== undefined;
  }

  public blockGuild(guildId: string, guildName: string | null, reason: string | null, at: string): void {
    preparedStatement(this.database, `INSERT INTO guild_block (guild_id, guild_name, reason, blocked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET reason = excluded.reason, guild_name = COALESCE(excluded.guild_name, guild_name)`)
      .run(guildId, guildName, reason, at);
  }

  public unblockGuild(guildId: string): boolean {
    return Number(preparedStatement(this.database, 'DELETE FROM guild_block WHERE guild_id = ?').run(guildId).changes) > 0;
  }

  public guildBlocks(): GuildBlock[] {
    return (this.database.prepare('SELECT * FROM guild_block ORDER BY blocked_at DESC').all() as Row[]).map((row) => ({
      guildId: text(row.guild_id), guildName: textOrNull(row.guild_name), reason: textOrNull(row.reason),
      blockedAt: text(row.blocked_at),
    }));
  }

  public setting(key: string): string | null {
    const row = preparedStatement(this.database, 'SELECT value FROM runtime_setting WHERE key = ?').get(key) as Row | undefined;
    return row ? text(row.value) : null;
  }

  public setSetting(key: string, value: string | null, at: string): void {
    if (value === null) {
      preparedStatement(this.database, 'DELETE FROM runtime_setting WHERE key = ?').run(key);
      return;
    }
    preparedStatement(this.database, `INSERT INTO runtime_setting (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, at);
  }

  public audit(action: string, target: string | null, detail: string | null, outcome: 'ok' | 'failed', at: string): void {
    // The record of a completed deletion names the user only by the deletion journal's hash.
    const storedTarget = action === 'user.delete' && outcome === 'ok' && target !== null ? hashDiscordUserId(target) : target;
    preparedStatement(this.database, `INSERT INTO admin_audit (action, target, detail, outcome, occurred_at)
      VALUES (?, ?, ?, ?, ?)`).run(action, storedTarget, detail?.slice(0, 500) ?? null, outcome, at);
  }

  public auditEntries(limit: number, target?: string): AuditEntry[] {
    return this.auditRows(target
      ? this.database.prepare('SELECT * FROM admin_audit WHERE target = ? ORDER BY id DESC LIMIT ?').all(target, limit)
      : this.database.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').all(limit));
  }

  /** Newest first, from `since` (ISO time) on. */
  public auditEntriesSince(since: string, limit: number): AuditEntry[] {
    return this.auditRows(this.database
      .prepare('SELECT * FROM admin_audit WHERE occurred_at >= ? ORDER BY id DESC LIMIT ?').all(since, limit));
  }

  private auditRows(rows: unknown[]): AuditEntry[] {
    return (rows as Row[]).map((row) => ({
      id: Number(row.id), action: text(row.action), target: textOrNull(row.target), detail: textOrNull(row.detail),
      outcome: text(row.outcome) as 'ok' | 'failed', occurredAt: text(row.occurred_at),
    }));
  }

  public cleanup(now: Date = new Date()): void {
    const cutoff = new Date(now.getTime() - auditRetentionMs).toISOString();
    preparedStatement(this.database, 'DELETE FROM admin_audit WHERE occurred_at < ?').run(cutoff);
  }
}
