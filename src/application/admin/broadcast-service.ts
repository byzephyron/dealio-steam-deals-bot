import { randomUUID } from 'node:crypto';
import { isLanguage, languages, type DmUnreachableCode, type Language } from '../../domain/user-config.js';
import type { AdminUserRow } from '../../persistence/admin-repository.js';
import type {
  AnnouncementContent, BroadcastAudience, BroadcastRepository, BroadcastSummary,
} from '../../persistence/broadcast-repository.js';
import { discordRateLimitDelayMs, dmUnreachableCode, isPermanentDiscordError } from '../notification-service.js';
import { redactSecrets, safeLogger } from '../safe-logger.js';

export interface AnnouncementSender {
  send(discordUserId: string, language: Language, content: AnnouncementContent): Promise<{ readonly messageId: string }>;
}

export class InvalidAnnouncementError extends Error {
  public readonly name = 'InvalidAnnouncementError';
}

export const announcementLimits = { title: 100, body: 1800 } as const;

/** Trims the texts, drops empty languages and enforces Discord-safe lengths. */
export function normalizeContent(input: unknown): AnnouncementContent {
  if (typeof input !== 'object' || input === null) throw new InvalidAnnouncementError('Content is required');
  const content: Partial<Record<Language, { title: string; body: string }>> = {};
  for (const [language, value] of Object.entries(input)) {
    if (!isLanguage(language) || typeof value !== 'object' || value === null) continue;
    const title = typeof (value as { title?: unknown }).title === 'string' ? (value as { title: string }).title.trim() : '';
    const body = typeof (value as { body?: unknown }).body === 'string' ? (value as { body: string }).body.trim() : '';
    if (!title && !body) continue;
    if (!title || !body) throw new InvalidAnnouncementError(`${language}: both a title and a message are required`);
    if (title.length > announcementLimits.title) throw new InvalidAnnouncementError(`${language}: the title is too long`);
    if (body.length > announcementLimits.body) throw new InvalidAnnouncementError(`${language}: the message is too long`);
    content[language] = { title, body };
  }
  if (Object.keys(content).length === 0) throw new InvalidAnnouncementError('Write the announcement in at least one language');
  return content;
}

export function normalizeAudience(input: unknown): BroadcastAudience {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const strings = (list: unknown, pattern: RegExp): string[] =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && pattern.test(item)) : [];
  const userIds = strings(value.userIds, /^\d{5,25}$/);
  const countries = strings(value.countries, /^[A-Z]{2}$/);
  const audienceLanguages = strings(value.languages, /^[a-z]{2}$/).filter(isLanguage);
  return {
    ...(userIds.length > 0 ? { userIds } : {}),
    ...(countries.length > 0 ? { countries } : {}),
    ...(audienceLanguages.length > 0 ? { languages: audienceLanguages } : {}),
    ...(value.onlyEnabled === true ? { onlyEnabled: true } : {}),
  };
}

export interface BroadcastServiceOptions {
  readonly repository: BroadcastRepository;
  readonly users: () => readonly AdminUserRow[];
  readonly isBlocked: (discordUserId: string) => boolean;
  readonly sender: AnnouncementSender;
  readonly onDmBlocked: (discordUserId: string, errorCode: DmUnreachableCode) => void;
  readonly now?: () => Date;
  /** One message per interval keeps well under Discord's DM limits. */
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly logger?: Pick<Console, 'log' | 'error'>;
}

/**
 * Owner announcements and direct messages. Only users who completed setup (and so
 * agreed to DMs) are ever recipients; blocked accounts and DM-blocked users are skipped.
 */
export class BroadcastService {
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly logger: Pick<Console, 'log' | 'error'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private stopped = false;

  public constructor(private readonly options: BroadcastServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 1_500;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
    this.logger = options.logger ?? safeLogger;
  }

  public recipients(audience: BroadcastAudience): Array<{ discordUserId: string; language: Language }> {
    const ids = audience.userIds ? new Set(audience.userIds) : null;
    return this.options.users().filter((user) => {
      if (ids && !ids.has(user.discordUserId)) return false;
      if (user.dmDeliveryBlockedAt) return false;
      if (audience.onlyEnabled && !user.enabled) return false;
      if (audience.countries && !audience.countries.includes(user.storeCountryCode)) return false;
      if (audience.languages && !audience.languages.includes(user.language as Language)) return false;
      return !this.options.isBlocked(user.discordUserId);
    }).map((user) => ({ discordUserId: user.discordUserId, language: (isLanguage(user.language) ? user.language : 'en') }));
  }

  public preview(audience: BroadcastAudience): { count: number; byLanguage: Record<string, number> } {
    const recipients = this.recipients(audience);
    const byLanguage: Record<string, number> = Object.fromEntries(languages.map((language) => [language, 0]));
    for (const recipient of recipients) byLanguage[recipient.language] = (byLanguage[recipient.language] ?? 0) + 1;
    return { count: recipients.length, byLanguage };
  }

  public create(content: AnnouncementContent, audience: BroadcastAudience): BroadcastSummary {
    const recipients = this.recipients(audience);
    const broadcastId = randomUUID();
    this.options.repository.create(broadcastId, content, audience, recipients, this.now().toISOString());
    this.kick();
    return this.options.repository.get(broadcastId)!;
  }

  public setStatus(broadcastId: string, status: 'sending' | 'paused' | 'cancelled'): boolean {
    const changed = this.options.repository.setStatus(broadcastId, status, this.now().toISOString());
    if (changed && status === 'sending') this.kick();
    return changed;
  }

  public start(): void {
    if (this.timer || this.stopped) return;
    const recovered = this.options.repository.recoverInterrupted(this.now().toISOString());
    if (recovered > 0) this.logger.log(`${this.now().toISOString()} [admin] Resuming ${recovered} interrupted announcement delivery(ies).`);
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref?.();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy;
  }

  /** Sends at most one message; returns whether there was one to send. */
  public async sendNext(): Promise<boolean> {
    const at = this.now().toISOString();
    const recipient = this.options.repository.claimNext(at);
    if (!recipient) return false;
    try {
      const { messageId } = await this.options.sender.send(recipient.discordUserId, recipient.language, recipient.content);
      this.options.repository.markSent(recipient.broadcastId, recipient.discordUserId, messageId, this.now().toISOString());
    } catch (error: unknown) {
      const now = this.now();
      const rateLimitMs = discordRateLimitDelayMs(error);
      if (rateLimitMs !== null) {
        this.options.repository.defer(recipient.broadcastId, recipient.discordUserId,
          new Date(now.getTime() + rateLimitMs).toISOString(), now.toISOString());
        return true;
      }
      const blocked = dmUnreachableCode(error);
      const terminal = blocked !== null || isPermanentDiscordError(error) || recipient.attemptCount >= this.maxAttempts;
      const message = blocked ?? redactSecrets(error instanceof Error ? error.message : 'Unknown error');
      this.options.repository.markFailed(recipient.broadcastId, recipient.discordUserId, message,
        terminal ? null : new Date(now.getTime() + this.retryDelayMs * recipient.attemptCount).toISOString(), now.toISOString());
      if (blocked) {
        try {
          this.options.onDmBlocked(recipient.discordUserId, blocked);
        } catch (markError: unknown) {
          this.logger.error('Could not record a DM block after an announcement', markError);
        }
      }
    }
    return true;
  }

  private kick(): void {
    // Only a started service sends; tests and a stopped bot drive sendNext() themselves.
    if (this.busy || this.stopped || !this.timer) return;
    this.busy = this.sendNext().then(() => undefined, (error: unknown) => {
      this.logger.error('Announcement delivery failed', error);
    }).finally(() => {
      this.busy = null;
    });
  }
}
