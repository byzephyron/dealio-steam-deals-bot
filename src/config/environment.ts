import { readFileSync } from 'node:fs';

export interface EnvironmentConfig {
  readonly discordToken: string;
  readonly discordClientId: string;
  readonly discordGuildId?: string;
  readonly databasePath: string;
  readonly pollIntervalHours: number;
  readonly notificationRetryIntervalSeconds: number;
  /** Sign-up cap; null means no cap. Existing users are never removed. */
  readonly maxUsers: number | null;
  readonly steamWebApiKey?: string;
  readonly isThereAnyDealApiKey?: string;
  /** Posts the server count to the top.gg listing; absent keeps it off. */
  readonly topggToken?: string;
  readonly dealioBannerUrl?: string;
  readonly azureLeaseContainerUrl?: string;
  readonly production?: boolean;
  /** The owner's admin panel; absent unless DEALIO_ADMIN_TOKEN is set. */
  readonly adminPanel?: AdminPanelConfig;
  /** Support tickets in the Dealio support server; absent unless all three IDs are set. */
  readonly support?: SupportConfig;
}

export interface AdminPanelConfig {
  readonly token: string;
  /** Always bound to 127.0.0.1; reached through an SSH tunnel. */
  readonly port: number;
}

export interface SupportConfig {
  /** The support server; ticket buttons work only there. */
  readonly guildId: string;
  /** The team-only channel that lists opened and closed tickets. */
  readonly logChannelId: string;
  /** The role that answers tickets; it is mentioned in the log channel. */
  readonly teamRoleId: string;
}

export const defaultAdminPanelPort = 8787;
export const minAdminTokenLength = 32;

const defaultDatabasePath = './data/wishlist.db';
export const defaultPollIntervalHours = 0.5;
const defaultNotificationRetryIntervalSeconds = 60;
export const minPollIntervalHours = 0.25;
export const maxPollIntervalHours = 24 * 7;

function requiredValue(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function boundedNumber(
  value: string,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Environment variable ${key} must be between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

function boundedInteger(
  value: string,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = boundedNumber(value, key, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Environment variable ${key} must be a whole number`);
  }
  return parsed;
}

export function loadEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  readMachineId: () => string = () => readFileSync('/etc/machine-id', 'utf8').trim(),
): EnvironmentConfig {
  const discordClientId = requiredValue(environment, 'DISCORD_CLIENT_ID');
  const discordGuildId = environment.DISCORD_GUILD_ID?.trim() || undefined;
  const steamWebApiKey = environment.STEAM_WEB_API_KEY?.trim() || undefined;
  const isThereAnyDealApiKey = environment.ITAD_API_KEY?.trim() || undefined;
  const topggToken = environment.TOPGG_TOKEN?.trim() || undefined;
  const dealioBannerUrl = environment.DEALIO_BANNER_URL?.trim() || undefined;

  if (dealioBannerUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(dealioBannerUrl);
    } catch (_error: unknown) {
      throw new Error('Environment variable DEALIO_BANNER_URL must be a valid HTTPS URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Environment variable DEALIO_BANNER_URL must use HTTPS');
    }
  }

  if (!/^\d+$/.test(discordClientId)) {
    throw new Error('Environment variable DISCORD_CLIENT_ID must be numeric');
  }

  if (discordGuildId !== undefined && !/^\d+$/.test(discordGuildId)) {
    throw new Error('Environment variable DISCORD_GUILD_ID must be numeric');
  }

  const databasePath = environment.DATABASE_PATH?.trim() || defaultDatabasePath;
  const pollIntervalHours = environment.POLL_INTERVAL_HOURS
    ? boundedNumber(
        environment.POLL_INTERVAL_HOURS,
        'POLL_INTERVAL_HOURS',
        minPollIntervalHours,
        maxPollIntervalHours,
      )
    : defaultPollIntervalHours;
  const notificationRetryIntervalSeconds = environment.NOTIFICATION_RETRY_INTERVAL_SECONDS
    ? boundedInteger(
        environment.NOTIFICATION_RETRY_INTERVAL_SECONDS,
        'NOTIFICATION_RETRY_INTERVAL_SECONDS',
        1,
        3_600,
      )
    : defaultNotificationRetryIntervalSeconds;

  // Unset means no cap: the 9 October 2026 capacity check covers well past real use.
  const maxUsers = environment.DEALIO_MAX_USERS?.trim()
    ? boundedInteger(environment.DEALIO_MAX_USERS.trim(), 'DEALIO_MAX_USERS', 1, 1_000_000)
    : null;

  const adminToken = environment.DEALIO_ADMIN_TOKEN?.trim() || undefined;
  if (adminToken !== undefined && adminToken.length < minAdminTokenLength) {
    throw new Error(`Environment variable DEALIO_ADMIN_TOKEN must be at least ${minAdminTokenLength} characters`);
  }
  const adminPanel: AdminPanelConfig | undefined = adminToken === undefined ? undefined : {
    token: adminToken,
    port: environment.DEALIO_ADMIN_PORT?.trim()
      ? boundedInteger(environment.DEALIO_ADMIN_PORT.trim(), 'DEALIO_ADMIN_PORT', 1_024, 65_535)
      : defaultAdminPanelPort,
  };

  const support = supportConfig(environment);

  if (environment.DEALIO_PRODUCTION === 'true' && !environment.AZURE_LEASE_CONTAINER_URL) {
    // Explicit single-host rollout while cloud resources await credit verification.
    // Copying this configuration to a different machine must not start a gateway.
    const expectedMachineId = environment.DEALIO_SINGLE_HOST_MACHINE_ID?.trim();
    if (!expectedMachineId || !/^[a-f0-9]{32}$/.test(expectedMachineId)) {
      throw new Error('Production requires AZURE_LEASE_CONTAINER_URL or an explicit DEALIO_SINGLE_HOST_MACHINE_ID');
    }
    if (readMachineId() !== expectedMachineId) {
      throw new Error('Single-host production is restricted to its pinned machine');
    }
  }
  // An empty PRODUCTION_DISCORD_CLIENT_ID (as in .env.example) still guards the real app.
  if (environment.DEALIO_PRODUCTION !== 'true'
    && environment.DISCORD_CLIENT_ID === (environment.PRODUCTION_DISCORD_CLIENT_ID?.trim() || '1540325119690412172'))
    throw new Error('Development must use a separate Discord application');
  return {
    ...(environment.AZURE_LEASE_CONTAINER_URL ? {azureLeaseContainerUrl:environment.AZURE_LEASE_CONTAINER_URL}:{}),
    ...(environment.DEALIO_PRODUCTION === 'true' ? {production:true}:{}),
    discordToken: requiredValue(environment, 'DISCORD_TOKEN'),
    discordClientId,
    ...(discordGuildId ? { discordGuildId } : {}),
    databasePath,
    pollIntervalHours,
    notificationRetryIntervalSeconds,
    maxUsers,
    ...(steamWebApiKey ? { steamWebApiKey } : {}),
    ...(isThereAnyDealApiKey ? { isThereAnyDealApiKey } : {}),
    ...(topggToken ? { topggToken } : {}),
    ...(dealioBannerUrl ? { dealioBannerUrl } : {}),
    ...(adminPanel ? { adminPanel } : {}),
    ...(support ? { support } : {}),
  };
}

const supportKeys = {
  guildId: 'DEALIO_SUPPORT_GUILD_ID',
  logChannelId: 'DEALIO_SUPPORT_LOG_CHANNEL_ID',
  teamRoleId: 'DEALIO_SUPPORT_TEAM_ROLE_ID',
} as const;

/** All three support IDs or none: a half-configured ticket desk would fail on the first ticket. */
function supportConfig(environment: NodeJS.ProcessEnv): SupportConfig | undefined {
  const values = Object.fromEntries(Object.entries(supportKeys)
    .map(([field, key]) => [field, environment[key]?.trim() || undefined])) as Record<keyof SupportConfig, string | undefined>;
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  for (const [field, key] of Object.entries(supportKeys) as Array<[keyof SupportConfig, string]>) {
    const value = values[field];
    if (value === undefined) {
      throw new Error(`Environment variable ${key} is required when the other DEALIO_SUPPORT_* variables are set`);
    }
    if (!/^\d{17,20}$/.test(value)) {
      throw new Error(`Environment variable ${key} must be a Discord ID`);
    }
  }
  return values as unknown as SupportConfig;
}
