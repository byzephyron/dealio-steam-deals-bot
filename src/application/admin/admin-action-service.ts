import { isLanguage, type Language } from '../../domain/user-config.js';
import type { AdminControlRepository } from '../../persistence/admin-control-repository.js';
import type { AnnouncementContent, BroadcastSummary } from '../../persistence/broadcast-repository.js';
import type { CheckService } from '../check-service.js';
import type { NotificationRetryScheduler } from '../notification-retry-scheduler.js';
import type { NotificationService } from '../notification-service.js';
import { redactSecrets } from '../safe-logger.js';
import type { WishlistScheduler } from '../scheduler.js';
import type { TestNotificationService } from '../test-notification-service.js';
import type { UserConfigurationService } from '../user-configuration-service.js';
import type { BroadcastService } from './broadcast-service.js';
import type { RuntimeSettings, RuntimeSettingsSnapshot, RuntimeSettingsUpdate } from './runtime-settings.js';

export class AdminActionError extends Error {
  public constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'AdminActionError';
  }
}

export interface AdminGuildControl {
  /** Leaves the server; false when the bot is not in it. */
  leave(guildId: string): Promise<boolean>;
  name(guildId: string): string | null;
}

export interface AdminActionDependencies {
  readonly users: Pick<UserConfigurationService, 'get' | 'setEnabled' | 'setStoreCountry' | 'setLanguage' | 'deleteData'>;
  readonly checks: Pick<CheckService, 'check'>;
  readonly notifications: Pick<NotificationService, 'deliverPending'>;
  readonly testNotifications: Pick<TestNotificationService, 'send'>;
  readonly scheduler: Pick<WishlistScheduler, 'runNow'>;
  readonly retryScheduler: Pick<NotificationRetryScheduler, 'runOnce'>;
  readonly controls: Pick<AdminControlRepository, 'audit' | 'blockUser' | 'unblockUser' | 'blockGuild' | 'unblockGuild'>;
  readonly broadcasts: Pick<BroadcastService, 'create' | 'setStatus' | 'recipients'>;
  readonly settings: Pick<RuntimeSettings, 'update'>;
  readonly guilds: AdminGuildControl;
  readonly applyPresence: (text: string | null) => void;
  readonly telemetry: { deleteUser(discordUserId: string): number };
  /** Ends the bot process (see StartBotOptions.requestExit); absent outside the real process. */
  readonly requestExit?: (mode: 'stop' | 'restart') => void;
  /** Delays the exit so the panel's answer reaches the browser first. */
  readonly defer?: (work: () => void, delayMs: number) => void;
  readonly now?: () => Date;
}

/** Long enough for the HTTP answer to leave before the admin server closes. */
const exitDelayMs = 750;

/**
 * Every owner action from the admin panel. User changes go through the same
 * services (and per-user coordinator) as Discord commands, and every action,
 * successful or not, is written to the audit trail.
 */
export class AdminActionService {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: AdminActionDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public pauseUser(discordUserId: string): Promise<unknown> {
    return this.audited('user.pause', discordUserId, null, async () => this.requireUser(
      await this.dependencies.users.setEnabled(discordUserId, false)));
  }

  /** Turning monitoring back on also clears a recorded DM block, like the user's own toggle. */
  public resumeUser(discordUserId: string): Promise<unknown> {
    return this.audited('user.resume', discordUserId, null, async () => this.requireUser(
      await this.dependencies.users.setEnabled(discordUserId, true)));
  }

  public checkUser(discordUserId: string): Promise<unknown> {
    return this.audited('user.check', discordUserId, null, async () => {
      this.requireUser(this.dependencies.users.get(discordUserId));
      const result = await this.dependencies.checks.check(discordUserId, 'manual', { bypassCooldown: true });
      if (result.status !== 'success') return { status: result.status };
      const delivery = await this.dependencies.notifications.deliverPending(discordUserId);
      return { status: 'success', checked: result.checkedCount, sent: delivery.sentCount, failed: delivery.failedCount };
    });
  }

  public testAlert(discordUserId: string): Promise<unknown> {
    return this.audited('user.test-alert', discordUserId, null, async () => {
      const config = this.requireUser(this.dependencies.users.get(discordUserId));
      await this.dependencies.testNotifications.send(discordUserId, config.language, config.storeCountryCode);
      return { sent: true };
    });
  }

  public setRegion(discordUserId: string, countryCode: unknown): Promise<unknown> {
    if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode)) {
      return Promise.reject(new AdminActionError(400, 'A two-letter country code is required'));
    }
    return this.audited('user.region', discordUserId, countryCode, async () => this.requireUser(
      await this.dependencies.users.setStoreCountry(discordUserId, countryCode)));
  }

  public setLanguage(discordUserId: string, language: unknown): Promise<unknown> {
    if (typeof language !== 'string' || !isLanguage(language)) {
      return Promise.reject(new AdminActionError(400, 'Language must be tr, en, de or fr'));
    }
    return this.audited('user.language', discordUserId, language, async () => this.requireUser(
      await this.dependencies.users.setLanguage(discordUserId, language as Language)));
  }

  /** Blocks every Dealio interaction except /delete-data and pauses monitoring. */
  public blockUser(discordUserId: string, reason: unknown): Promise<unknown> {
    const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null;
    return this.audited('user.block', discordUserId, text, async () => {
      this.dependencies.controls.blockUser(discordUserId, text, this.now().toISOString());
      if (this.dependencies.users.get(discordUserId)) await this.dependencies.users.setEnabled(discordUserId, false);
      return { blocked: true };
    });
  }

  public unblockUser(discordUserId: string): Promise<unknown> {
    return this.audited('user.unblock', discordUserId, null, async () => ({
      unblocked: this.dependencies.controls.unblockUser(discordUserId),
    }));
  }

  /** The same deletion as /delete-data, including the restore-proof journal entry. */
  public deleteUser(discordUserId: string): Promise<unknown> {
    return this.audited('user.delete', discordUserId, null, async () => {
      const deleted = await this.dependencies.users.deleteData(discordUserId);
      const events = this.dependencies.telemetry.deleteUser(discordUserId);
      if (!deleted && events === 0) throw new AdminActionError(404, 'No data stored for this user');
      return { deleted, telemetryRows: events };
    });
  }

  public messageUser(discordUserId: string, content: AnnouncementContent): Promise<BroadcastSummary> {
    return this.audited('user.message', discordUserId, Object.keys(content).join(','), async () => {
      this.requireUser(this.dependencies.users.get(discordUserId));
      if (this.dependencies.broadcasts.recipients({ userIds: [discordUserId] }).length === 0) {
        throw new AdminActionError(409, 'This user cannot receive DMs right now (blocked or DM-blocked)');
      }
      return this.dependencies.broadcasts.create(content, { userIds: [discordUserId] });
    });
  }

  public announce(content: AnnouncementContent, audience: Parameters<BroadcastService['create']>[1]): Promise<BroadcastSummary> {
    return this.audited('broadcast.create', null, JSON.stringify(audience), async () =>
      this.dependencies.broadcasts.create(content, audience));
  }

  public setBroadcastStatus(broadcastId: string, status: 'sending' | 'paused' | 'cancelled'): Promise<unknown> {
    return this.audited(`broadcast.${status === 'sending' ? 'resume' : status === 'paused' ? 'pause' : 'cancel'}`,
      broadcastId, null, async () => {
        if (!this.dependencies.broadcasts.setStatus(broadcastId, status)) {
          throw new AdminActionError(409, 'The announcement cannot change to that state');
        }
        return { status };
      });
  }

  public leaveGuild(guildId: string): Promise<unknown> {
    return this.audited('guild.leave', guildId, this.dependencies.guilds.name(guildId), async () => {
      if (!await this.dependencies.guilds.leave(guildId)) throw new AdminActionError(404, 'The bot is not in this server');
      return { left: true };
    });
  }

  /** Leaves now and again on every future invite. */
  public blockGuild(guildId: string, reason: unknown): Promise<unknown> {
    const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null;
    const name = this.dependencies.guilds.name(guildId);
    return this.audited('guild.block', guildId, text, async () => {
      this.dependencies.controls.blockGuild(guildId, name, text, this.now().toISOString());
      const left = await this.dependencies.guilds.leave(guildId);
      return { blocked: true, left };
    });
  }

  public unblockGuild(guildId: string): Promise<unknown> {
    return this.audited('guild.unblock', guildId, null, async () => ({
      unblocked: this.dependencies.controls.unblockGuild(guildId),
    }));
  }

  public scanNow(): Promise<unknown> {
    return this.audited('system.scan-now', null, null, async () => {
      if (!this.dependencies.scheduler.runNow()) throw new AdminActionError(409, 'A scan is already running');
      return { started: true };
    });
  }

  public retryNow(): Promise<unknown> {
    return this.audited('system.retry-now', null, null, async () => this.dependencies.retryScheduler.runOnce());
  }

  /** Shuts down gracefully and lets systemd start the bot again (about 5 seconds later). */
  public restartBot(): Promise<unknown> {
    return this.audited('system.restart', null, null, async () => this.exit('restart'));
  }

  /** Shuts down gracefully and stays down: the panel goes with it, so starting again needs SSH. */
  public stopBot(): Promise<unknown> {
    return this.audited('system.stop', null, null, async () => this.exit('stop'));
  }

  public updateSettings(update: RuntimeSettingsUpdate): Promise<RuntimeSettingsSnapshot> {
    return this.audited('system.settings', null, JSON.stringify(update), async () => {
      const snapshot = this.dependencies.settings.update(update);
      if (update.presenceText !== undefined) this.dependencies.applyPresence(snapshot.presenceText);
      return snapshot;
    });
  }

  private exit(mode: 'stop' | 'restart'): { readonly accepted: true; readonly mode: 'stop' | 'restart' } {
    const requestExit = this.dependencies.requestExit;
    if (!requestExit) throw new AdminActionError(409, 'This process cannot be stopped from the panel');
    const defer = this.dependencies.defer ?? ((work, delayMs) => { setTimeout(work, delayMs); });
    defer(() => requestExit(mode), exitDelayMs);
    return { accepted: true, mode };
  }

  private requireUser<T>(config: T | null): T {
    if (config === null) throw new AdminActionError(404, 'User not found');
    return config;
  }

  private async audited<T>(action: string, target: string | null, detail: string | null, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      this.record(action, target, detail, 'ok');
      return result;
    } catch (error: unknown) {
      const message = redactSecrets(error instanceof Error ? error.message : 'Unknown error');
      this.record(action, target, [detail, message].filter(Boolean).join(' · '), 'failed');
      throw error;
    }
  }

  private record(action: string, target: string | null, detail: string | null, outcome: 'ok' | 'failed'): void {
    try {
      this.dependencies.controls.audit(action, target, detail, outcome, this.now().toISOString());
    } catch {
      // The action already happened; a missing audit row must not report it as failed.
    }
  }
}
