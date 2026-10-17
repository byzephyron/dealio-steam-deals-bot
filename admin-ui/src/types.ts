/** Shapes of the admin API responses (src/application/admin/admin-query-service.ts). */

export interface Profile {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly avatarUrl: string;
  readonly createdAt: string;
  readonly bot: boolean;
}

export interface CountRow { readonly key: string; readonly count: number }
export interface DayCount { readonly day: string; readonly count: number }

export interface SchedulerRunReport {
  readonly userCount: number;
  readonly completedCount: number;
  readonly errorCount: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly checkedGames: number;
  readonly steamItemErrors: number;
  readonly unknownPrices: number;
  readonly unavailable: number;
  readonly dmSent: number;
  readonly dmFailed: number;
}

export interface SchedulerInfo {
  readonly intervalMs: number;
  readonly running: boolean;
  readonly runStartedAt: string | null;
  readonly lastRun: SchedulerRunReport | null;
  readonly nextScheduledAt: string | null;
  /** Automatic scans are paused by the owner. */
  readonly paused?: boolean;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly node: string;
  readonly platform: string;
  readonly uptimeSeconds: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
  /** The whole VM, not just the bot: with no user cap this is the capacity signal. */
  readonly hostMemory: { readonly totalBytes: number; readonly availableBytes: number };
}

export interface DiscordStatus {
  readonly ready: boolean;
  readonly pingMs: number | null;
  readonly botUser: Profile | null;
}

/** When usage tracking (interaction_event) began; usage figures cover only the time since. */
export interface TelemetryCoverage {
  readonly telemetrySince?: string | null;
}

export interface Overview extends TelemetryCoverage {
  readonly generatedAt: string;
  readonly discord: DiscordStatus;
  readonly application: {
    readonly approximateGuildCount: number | null;
    readonly approximateUserInstallCount: number | null;
  } | null;
  readonly guilds: { readonly count: number; readonly members: number };
  readonly counts: {
    readonly users: number;
    readonly enabled: number;
    readonly paused: number;
    readonly dmBlocked: number;
    readonly newUsers24h: number;
    readonly newUsers7d: number;
    readonly alertsSent24h: number;
    readonly alertsSent7d: number;
    readonly alertsSentTotal: number;
    readonly queuePending: number;
    readonly queueRetry: number;
    readonly queueSending: number;
    readonly terminalFailed7d: number;
    readonly trackedGames: number;
    readonly gamesOnSale: number;
    readonly rules: number;
    readonly priceObservations: number;
  };
  /** Null means sign-ups have no cap. */
  readonly maxUsers: number | null;
  readonly activity: { readonly active24h: number; readonly active7d: number; readonly active30d: number };
  readonly settings: RuntimeSettings;
  readonly scheduler: SchedulerInfo;
  readonly process: ProcessInfo;
  readonly charts: {
    readonly signups: DayCount[];
    readonly alerts: DayCount[];
    readonly activeUsers: DayCount[];
    readonly guilds: DayCount[];
  };
  readonly distributions: {
    readonly countries: CountRow[];
    readonly languages: CountRow[];
    readonly notificationModes: CountRow[];
    readonly checkStatuses: CountRow[];
    readonly checkErrors: CountRow[];
    readonly currencies: CountRow[];
  };
}

export interface UserRow {
  readonly discordUserId: string;
  readonly steamId64: string;
  readonly language: string;
  readonly storeCountryCode: string;
  readonly enabled: boolean;
  readonly minimumDiscountPercent: number;
  readonly dmDeliveryBlockedAt: string | null;
  readonly dmDeliveryErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastCheckStatus: string | null;
  readonly lastCheckErrorCode: string | null;
  readonly lastCheckCompletedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly wishlistCount: number | null;
  readonly onSaleCount: number;
  readonly ruleCount: number;
  readonly mutedCount: number;
  readonly notificationMode: string;
  readonly alertsSent: number;
  readonly lastAlertAt: string | null;
  readonly pendingAlerts: number;
  /** The latest alert that reached the user or finally failed. */
  readonly lastDelivery?: { readonly status: 'sent' | 'terminal_failed'; readonly at: string; readonly error: string | null } | null;
  readonly sourceGuildId?: string | null;
  readonly sourceGuildName?: string | null;
  readonly lastSeenAt?: string | null;
  readonly blocked?: boolean;
}

export interface SalePrice {
  readonly currency: string | null;
  readonly initialMinor: number;
  readonly finalMinor: number;
  readonly discountPercent: number;
  readonly isFree: boolean;
}

export interface SnapshotItem {
  readonly appId: number;
  readonly name: string;
  readonly price: SalePrice | null;
  readonly onSale: boolean | null;
  readonly priority: number | null;
  readonly dateAdded: number | null;
  readonly upcoming: { readonly date?: string; readonly text?: string } | null;
  readonly headerImageUrl: string | null;
}

export interface NotificationRow {
  readonly appId: number;
  readonly headerImageUrl?: string | null;
  readonly gameName: string;
  readonly status: string;
  readonly reason: string;
  readonly currency: string;
  readonly normalPriceMinor: number;
  readonly finalPriceMinor: number;
  readonly discountPercent: number;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly lastError: string | null;
  readonly storeCountryCode: string;
}

export interface UserDetail extends TelemetryCoverage {
  readonly config: {
    readonly discordUserId: string;
    readonly configurationId: string;
    readonly steamId64: string;
    readonly configVersion: number;
    readonly language: string;
    readonly storeCountryCode: string;
    readonly enabled: boolean;
    readonly minimumDiscountPercent: number;
    readonly dmOptInAt: string;
    readonly dmDeliveryBlockedAt: string | null;
    readonly dmDeliveryErrorCode: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly summary: UserRow | null;
  readonly profile: Profile | null;
  readonly checkState: {
    readonly lastStartedAt: string | null;
    readonly lastCompletedAt: string | null;
    readonly lastStatus: string | null;
    readonly lastErrorCode: string | null;
    readonly nextScheduledAt: string | null;
    readonly lastSuccessCompletedAt: string | null;
    readonly lastSuccessCheckedCount: number | null;
    readonly lastSuccessOnSaleCount: number | null;
    readonly lastSuccessFreeCount: number | null;
    readonly lastSuccessUnknownPriceCount: number | null;
    readonly lastSuccessFailedItemCount: number | null;
  } | null;
  readonly preference: {
    readonly mode: string;
    readonly timezone: string | null;
    readonly quietStart: number | null;
    readonly quietEnd: number | null;
    readonly digestMinute: number | null;
  };
  readonly rules: Array<{
    readonly appId: number;
    readonly name: string | null;
    readonly mode: string;
    readonly percent: number | null;
    readonly targetMinor: number | null;
    readonly currency: string | null;
    readonly muted: boolean;
    readonly revision: number;
  }>;
  readonly snapshot: {
    readonly capturedAt: string;
    readonly language: string;
    readonly errorCount: number;
    readonly items: SnapshotItem[];
  } | null;
  readonly notifications: NotificationRow[];
  readonly usage: UserUsage;
  readonly blocked: boolean;
  readonly messages: Broadcast[];
  readonly audit: AuditEntry[];
}

export interface Guild {
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
  readonly owner: Profile | null;
  readonly dealioUsers?: number;
  readonly registeredUsers?: number;
  readonly lastActivityAt?: string | null;
}

export interface GameRow {
  readonly appId: number;
  readonly name: string;
  readonly count: number;
  readonly maxDiscountPercent?: number | null;
  readonly muted?: number;
  readonly targets?: number;
  /** Steam's stored artwork URL, when a wishlist read has seen the game. */
  readonly headerImageUrl?: string | null;
}

export interface Games {
  readonly wishlisted: GameRow[];
  readonly onSale: GameRow[];
  readonly alerted: GameRow[];
  readonly ruled: GameRow[];
  readonly currencies: CountRow[];
}

export interface SystemInfo {
  readonly health: {
    readonly phase: string;
    readonly pid: number;
    readonly startedAt: string;
    readonly readyAt: string | null;
    readonly heartbeatAt: string;
    readonly discordReady: boolean;
    readonly guildCount: number | null;
  } | null;
  readonly discord: DiscordStatus;
  readonly scheduler: SchedulerInfo;
  readonly process: ProcessInfo;
  readonly database: {
    readonly path: string;
    readonly sizeBytes: number;
    readonly walBytes: number;
    readonly schemaVersion: number;
  };
  readonly deletionsKept: number;
  readonly runtimeSettings: RuntimeSettings;
  readonly blockedUsers: Array<{ discordUserId: string; reason: string | null; blockedAt: string }>;
  readonly settings: {
    readonly maxUsers: number | null;
    readonly pollIntervalHours: number;
    readonly notificationRetryIntervalSeconds: number;
    readonly priceHistoryEnabled: boolean;
    readonly steamVanityEnabled: boolean;
    readonly production: boolean;
  };
}

export interface LogEntry {
  readonly id: number;
  readonly at: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
}

export interface RuntimeSettings {
  readonly maxUsers: number | null;
  readonly maxUsersOverride: number | null;
  readonly defaultMaxUsers: number | null;
  readonly signupsOpen: boolean;
  readonly presenceText: string | null;
  readonly scansPaused?: boolean;
}

export interface AuditEntry {
  readonly id: number;
  readonly action: string;
  readonly target: string | null;
  readonly detail: string | null;
  readonly outcome: 'ok' | 'failed';
  readonly occurredAt: string;
}

export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface Broadcast {
  readonly broadcastId: string;
  readonly content: Partial<Record<'tr' | 'en' | 'de' | 'fr', { title: string; body: string }>>;
  readonly audience: {
    readonly userIds?: string[];
    readonly countries?: string[];
    readonly languages?: string[];
    readonly onlyEnabled?: boolean;
  };
  readonly status: 'sending' | 'paused' | 'completed' | 'cancelled';
  readonly recipientCount: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly counts: Readonly<Record<RecipientStatus, number>>;
  readonly recipientStatus?: RecipientStatus;
}

export interface BroadcastRecipient {
  readonly discordUserId: string;
  readonly language: string;
  readonly status: RecipientStatus;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly discordMessageId: string | null;
  readonly updatedAt: string;
  readonly profile: Profile | null;
}

export interface UsageCount { readonly key: string; readonly count: number; readonly users: number }

export interface Usage extends TelemetryCoverage {
  readonly days: number;
  readonly dailyActive: DayCount[];
  readonly actions: UsageCount[];
  readonly contexts: UsageCount[];
  readonly installs: UsageCount[];
  readonly locales: UsageCount[];
  readonly setup: UsageCount[];
  readonly sources: Array<{ guildId: string; guildName: string | null; users: number; registeredUsers: number; lastSeenAt: string }>;
}

export interface UserUsage {
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly interactions: number;
  readonly installs: string[];
  readonly guilds: Array<{ guildId: string; guildName: string | null; count: number; lastSeenAt: string }>;
  readonly recent: Array<{ kind: string; action: string; context: string; guildId: string | null; occurredAt: string }>;
}

export interface GuildEvent {
  readonly guildId: string;
  readonly guildName: string;
  readonly memberCount: number | null;
  readonly event: 'join' | 'leave';
  readonly occurredAt: string;
}

export interface GuildBlock {
  readonly guildId: string;
  readonly guildName: string | null;
  readonly reason: string | null;
  readonly blockedAt: string;
}

export interface GuildsResponse extends TelemetryCoverage {
  readonly guilds: Guild[];
  readonly departed: GuildEvent[];
  readonly blocked: GuildBlock[];
  readonly events: GuildEvent[];
}

export interface GuildDetail extends TelemetryCoverage {
  readonly guild: Guild | null;
  readonly name: string;
  readonly blocked: boolean;
  readonly events: GuildEvent[];
  readonly users: Array<{ discordUserId: string; interactions: number; lastSeenAt: string; registered: boolean; profile: Profile | null }>;
  readonly audit: AuditEntry[];
}
