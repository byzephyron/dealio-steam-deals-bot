import type { Client, Guild, User } from 'discord.js';
import { isDiscordRateLimit } from '../application/notification-service.js';

/** Live Discord facts for the admin panel. Nothing here is written to the database. */

export interface DirectoryUser {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly avatarUrl: string;
  readonly createdAt: string;
  readonly bot: boolean;
}

export interface DirectoryGuild {
  readonly id: string;
  readonly name: string;
  readonly iconUrl: string | null;
  readonly memberCount: number;
  readonly ownerId: string;
  readonly joinedAt: string | null;
  readonly createdAt: string;
  readonly preferredLocale: string;
  readonly large: boolean;
  readonly description: string | null;
  readonly features: readonly string[];
}

export interface ApplicationCounts {
  readonly approximateGuildCount: number | null;
  readonly approximateUserInstallCount: number | null;
}

export interface DiscordDirectoryStatus {
  readonly ready: boolean;
  readonly pingMs: number | null;
  readonly botUser: DirectoryUser | null;
}

export interface DiscordDirectory {
  status(): DiscordDirectoryStatus;
  guilds(): DirectoryGuild[];
  applicationCounts(): Promise<ApplicationCounts | null>;
  users(ids: readonly string[]): Promise<Map<string, DirectoryUser | null>>;
}

const profileTtlMs = 6 * 3600_000;
const failedProfileTtlMs = 10 * 60_000;
const applicationTtlMs = 10 * 60_000;
const requestTimeoutMs = 5_000;
const profileConcurrency = 3;

function directoryUser(user: User): DirectoryUser {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName ?? null,
    avatarUrl: user.displayAvatarURL({ size: 64, extension: 'png' }),
    createdAt: user.createdAt.toISOString(),
    bot: user.bot,
  };
}

function directoryGuild(guild: Guild): DirectoryGuild {
  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 64, extension: 'png' }),
    memberCount: guild.memberCount,
    ownerId: guild.ownerId,
    joinedAt: Number.isFinite(guild.joinedTimestamp) ? new Date(guild.joinedTimestamp).toISOString() : null,
    createdAt: guild.createdAt.toISOString(),
    preferredLocale: guild.preferredLocale,
    large: guild.large,
    description: guild.description ?? null,
    features: [...guild.features],
  };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Discord request timed out')), requestTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class DiscordClientDirectory implements DiscordDirectory {
  private readonly profiles = new Map<string, { readonly user: DirectoryUser | null; readonly expiresAt: number }>();
  private application: { readonly counts: ApplicationCounts; readonly expiresAt: number } | null = null;

  public constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  public status(): DiscordDirectoryStatus {
    const ready = this.client.isReady();
    return {
      ready,
      pingMs: ready && this.client.ws.ping >= 0 ? this.client.ws.ping : null,
      botUser: this.client.user ? directoryUser(this.client.user) : null,
    };
  }

  public guilds(): DirectoryGuild[] {
    return [...this.client.guilds.cache.values()].map(directoryGuild)
      .sort((left, right) => right.memberCount - left.memberCount || left.name.localeCompare(right.name));
  }

  public async applicationCounts(): Promise<ApplicationCounts | null> {
    if (this.application && this.application.expiresAt > this.now()) return this.application.counts;
    const application = this.client.application;
    if (!application) return null;
    try {
      const fetched = await withTimeout(application.fetch());
      const counts = {
        approximateGuildCount: fetched.approximateGuildCount ?? null,
        approximateUserInstallCount: fetched.approximateUserInstallCount ?? null,
      };
      this.application = { counts, expiresAt: this.now() + applicationTtlMs };
      return counts;
    } catch {
      return this.application?.counts ?? null;
    }
  }

  /**
   * Profiles from the cache, then from Discord a few at a time. A rate limit stops
   * the remaining lookups for this call instead of waiting; they show as unknown.
   */
  public async users(ids: readonly string[]): Promise<Map<string, DirectoryUser | null>> {
    const result = new Map<string, DirectoryUser | null>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      if (!/^\d{5,25}$/.test(id)) continue;
      const cached = this.profiles.get(id);
      if (cached && cached.expiresAt > this.now()) {
        result.set(id, cached.user);
        continue;
      }
      const known = this.client.users.cache.get(id);
      if (known) {
        const user = directoryUser(known);
        this.profiles.set(id, { user, expiresAt: this.now() + profileTtlMs });
        result.set(id, user);
        continue;
      }
      missing.push(id);
    }

    let stopped = false;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopped && next < missing.length) {
        const id = missing[next]!;
        next += 1;
        try {
          const user = directoryUser(await withTimeout(this.client.users.fetch(id)));
          this.profiles.set(id, { user, expiresAt: this.now() + profileTtlMs });
          result.set(id, user);
        } catch (error: unknown) {
          if (isDiscordRateLimit(error)) stopped = true;
          else this.profiles.set(id, { user: null, expiresAt: this.now() + failedProfileTtlMs });
          result.set(id, null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(profileConcurrency, missing.length) }, worker));
    return result;
  }
}
