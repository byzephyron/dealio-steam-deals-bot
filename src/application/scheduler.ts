import { safeLogger } from './safe-logger.js';
import type { CheckResult } from './check-service.js';
import type { UserConfig } from '../domain/user-config.js';
import type { UserConfigRepository } from '../persistence/user-config-repository.js';
import { maxPollIntervalHours, minPollIntervalHours } from '../config/environment.js';
import type { PollScheduleRepository } from '../persistence/poll-schedule-repository.js';

export interface SchedulerCheckService {
  check(discordUserId: string, source?: 'manual' | 'automatic'): Promise<CheckResult>;
}

export interface SchedulerNotificationService {
  deliverPending(discordUserId: string): Promise<{
    readonly candidateCount: number;
    readonly sentCount: number;
    readonly failedCount: number;
  }>;
}

/** Tells a user once that Steam hides their wishlist (see WishlistHiddenNoticeService). */
export interface SchedulerWishlistHiddenNotices {
  notify(discordUserId: string): Promise<'sent' | 'skipped' | 'failed' | 'dm-blocked'>;
}

export interface SchedulerClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface SchedulerLogger {
  info(message: string): void;
  error(message: string): void;
}

const systemClock: SchedulerClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

const consoleLogger: SchedulerLogger = {
  info: (message) => console.log(`${new Date().toISOString()} [scheduler] ${message}`),
  error: (message) => safeLogger.error(`${new Date().toISOString()} [scheduler] ${message}`),
};
const schedulePersistenceRetryMs = 60_000;

export interface SchedulerOptions {
  readonly intervalHours: number;
  readonly userConfigRepository: Pick<UserConfigRepository, 'findEnabled'>;
  readonly checkService: SchedulerCheckService;
  readonly notificationService: SchedulerNotificationService;
  readonly wishlistHiddenNotices?: SchedulerWishlistHiddenNotices;
  readonly scheduleRepository: Pick<
    PollScheduleRepository,
    'findNextScheduledAt' | 'setNextScheduledAt'
  >;
  readonly clock?: SchedulerClock;
  readonly now?: () => Date;
  readonly logger?: SchedulerLogger;
  readonly maxUserConcurrency?: number;
  /**
   * When prices change next (Steam: 10:00 Pacific). A scan then runs shortly after
   * it instead of up to a full interval later; the interval resumes from there.
   */
  readonly nextPriceChange?: (now: Date) => Date;
  /**
   * The owner paused automatic scans (admin panel). A due scan is skipped and the
   * next one is still scheduled, so resuming needs no restart; `runNow` still scans.
   */
  readonly isPaused?: () => boolean;
}

/** Steam's API can lag its own price change by a moment. */
const priceChangeScanDelayMs = 2 * 60 * 1000;

export interface SchedulerRunSummary {
  readonly userCount: number;
  readonly completedCount: number;
  readonly errorCount: number;
}

/** The latest completed scan, kept in memory for the admin panel. */
export interface SchedulerRunReport extends SchedulerRunSummary {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly checkedGames: number;
  readonly steamItemErrors: number;
  readonly unknownPrices: number;
  readonly unavailable: number;
  readonly dmSent: number;
  readonly dmFailed: number;
  /** Users told this run that Steam hides their wishlist. */
  readonly hiddenNoticesSent: number;
}

export interface SchedulerStatus {
  readonly intervalMs: number;
  readonly running: boolean;
  readonly runStartedAt: string | null;
  readonly lastRun: SchedulerRunReport | null;
  readonly paused: boolean;
}

export class WishlistScheduler {
  private readonly intervalMs: number;
  private readonly clock: SchedulerClock;
  private readonly logger: SchedulerLogger;
  private readonly now: () => Date;
  private readonly maxUserConcurrency: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopping = false;
  private activeRun: Promise<SchedulerRunSummary> | null = null;
  private stopPromise: Promise<void> | null = null;
  private runStartedAt: string | null = null;
  private lastRun: SchedulerRunReport | null = null;

  public constructor(private readonly options: SchedulerOptions) {
    if (
      !Number.isFinite(options.intervalHours) ||
      options.intervalHours < minPollIntervalHours ||
      options.intervalHours > maxPollIntervalHours
    ) {
      throw new Error(
        `Scheduler interval must be between ${minPollIntervalHours} and ${maxPollIntervalHours} hours`,
      );
    }

    this.intervalMs = options.intervalHours * 60 * 60 * 1000;
    this.clock = options.clock ?? systemClock;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? consoleLogger;
    this.maxUserConcurrency = options.maxUserConcurrency ?? 3;

    if (!Number.isSafeInteger(this.maxUserConcurrency) || this.maxUserConcurrency <= 0) {
      throw new Error('Scheduler user concurrency must be a positive safe integer');
    }
  }

  public get intervalMilliseconds(): number {
    return this.intervalMs;
  }

  public status(): SchedulerStatus {
    return {
      intervalMs: this.intervalMs,
      running: this.activeRun !== null,
      runStartedAt: this.activeRun !== null ? this.runStartedAt : null,
      lastRun: this.lastRun,
      paused: this.isPaused(),
    };
  }

  public start(): void {
    if (this.started || this.stopping) {
      return;
    }

    this.started = true;
    this.logger.info(`Started with interval ${this.options.intervalHours} hours.`);
    let persistedTarget: string | null;
    try {
      persistedTarget = this.options.scheduleRepository.findNextScheduledAt();
    } catch (_error: unknown) {
      this.logger.error('Could not load the persisted wishlist schedule.');
      this.retryStart();
      return;
    }

    const nowMs = this.now().getTime();
    const persistedMs = persistedTarget === null
      ? Number.NaN
      : new Date(persistedTarget).getTime();
    if (Number.isFinite(persistedMs) && persistedMs > nowMs) {
      const targetMs = Math.min(persistedMs, this.nextTarget(nowMs));
      if (!this.persistNextRun(targetMs)) {
        this.retryPersistNextRun(targetMs);
        return;
      }
      this.armTimer(targetMs);
      return;
    }

    void this.runAutomaticCycle();
  }

  public stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }

    this.stopping = true;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }

    this.started = false;
    const activeRun = this.activeRun;
    this.stopPromise = activeRun
      ? activeRun.then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();

    return this.stopPromise;
  }

  /**
   * Starts a full scan now (owner request) unless one is running; the next automatic
   * scan then follows one interval after it, exactly as after a timed scan.
   */
  public runNow(): boolean {
    if (!this.started || this.stopping || this.activeRun !== null) return false;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    void this.runAutomaticCycle(true);
    return true;
  }

  public runOnce(): Promise<SchedulerRunSummary> {
    if (this.stopping || this.activeRun !== null) {
      return Promise.resolve({ userCount: 0, completedCount: 0, errorCount: 0 });
    }

    const run = this.executeRun();
    this.activeRun = run;
    const clearActiveRun = (): void => {
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    };
    void run.then(clearActiveRun, clearActiveRun);

    return run;
  }

  private async executeRun(): Promise<SchedulerRunSummary> {
    const runStartedMs = this.now().getTime();
    this.runStartedAt = new Date(runStartedMs).toISOString();
    let users: UserConfig[];
    try {
      users = this.options.userConfigRepository.findEnabled();
    } catch (_error: unknown) {
      this.logger.error('Could not load enabled users.');
      return { userCount: 0, completedCount: 0, errorCount: 1 };
    }

    this.logger.info(`Run started for ${users.length} enabled user(s).`);
    let completedCount = 0;
    let errorCount = 0;
    let checkedGames = 0;
    let steamItemErrors = 0;
    let unknownPrices = 0;
    let unavailableCount = 0;
    let dmSent = 0;
    let dmFailed = 0;
    let hiddenNoticesSent = 0;

    let nextUserIndex = 0;
    const processNextUser = async (): Promise<void> => {
      // Shutdown waits for this run: finish the users in progress, start no more.
      while (nextUserIndex < users.length && !this.stopping) {
        const index = nextUserIndex;
        nextUserIndex += 1;
        const user = users[index];
        this.logger.info(`Check started (${index + 1}/${users.length}).`);

        try {
          const result = await this.options.checkService.check(user.discordUserId, 'automatic');
          if (result.status === 'success') {
            checkedGames += result.checkedCount;
            steamItemErrors += result.failedItems.length;
            unknownPrices += result.unknownPriceCount;
            const delivery = await this.options.notificationService.deliverPending(
              user.discordUserId,
            );
            dmSent += delivery.sentCount;
            dmFailed += delivery.failedCount;
            this.logger.info(
              `Check completed (${index + 1}/${users.length}): status=success checked=${result.checkedCount} candidates=${delivery.candidateCount} dmSent=${delivery.sentCount} dmFailed=${delivery.failedCount}.`,
            );
          } else if (result.status === 'unavailable') {
            unavailableCount += 1;
            errorCount += 1;
            this.logger.error(
              `Check completed (${index + 1}/${users.length}): status=unavailable code=${result.errorCode}.`,
            );
            if (result.errorCode === 'STEAM_WISHLIST_INACCESSIBLE' && this.options.wishlistHiddenNotices) {
              const notice = await this.options.wishlistHiddenNotices.notify(user.discordUserId)
                .catch(() => 'failed' as const);
              if (notice === 'sent') hiddenNoticesSent += 1;
              if (notice !== 'skipped') {
                this.logger.info(`Hidden-wishlist notice (${index + 1}/${users.length}): ${notice}.`);
              }
            }
          } else if (result.status === 'failed') {
            errorCount += 1;
            this.logger.error(
              `Check completed (${index + 1}/${users.length}): status=failed code=${result.errorCode}.`,
            );
          } else {
            this.logger.info(
              `Check completed (${index + 1}/${users.length}): status=${result.status}.`,
            );
          }

          completedCount += 1;
        } catch (_error: unknown) {
          errorCount += 1;
          completedCount += 1;
          this.logger.error(
            `Check completed (${index + 1}/${users.length}): status=error.`,
          );
        }
      }
    };
    const workerCount = Math.min(users.length, this.maxUserConcurrency);
    await Promise.all(
      Array.from({ length: workerCount }, () => processNextUser()),
    );

    this.logger.info(
      `Run completed: users=${users.length} completed=${completedCount} errors=${errorCount} `
      + `durationMs=${Math.max(0, this.now().getTime() - runStartedMs)} checkedGames=${checkedGames} `
      + `steamItemErrors=${steamItemErrors} unknownPrices=${unknownPrices} `
      + `unavailable=${unavailableCount} dmSent=${dmSent} dmFailed=${dmFailed} hiddenNotices=${hiddenNoticesSent}.`,
    );
    const completedMs = this.now().getTime();
    this.lastRun = {
      userCount: users.length,
      completedCount,
      errorCount,
      startedAt: new Date(runStartedMs).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
      durationMs: Math.max(0, completedMs - runStartedMs),
      checkedGames,
      steamItemErrors,
      unknownPrices,
      unavailable: unavailableCount,
      dmSent,
      dmFailed,
      hiddenNoticesSent,
    };
    return { userCount: users.length, completedCount, errorCount };
  }

  private isPaused(): boolean {
    try {
      return this.options.isPaused?.() === true;
    } catch (_error: unknown) {
      // An unreadable setting must not stop scanning.
      return false;
    }
  }

  /** `requested`: the owner asked for this scan, so a pause does not skip it. */
  private async runAutomaticCycle(requested = false): Promise<void> {
    const existingRun = this.activeRun;
    if (existingRun !== null) {
      await existingRun;
    }
    if (this.stopping) {
      return;
    }

    try {
      this.options.scheduleRepository.setNextScheduledAt(null);
    } catch (_error: unknown) {
      this.logger.error('Could not clear the due wishlist schedule.');
      this.retryStart();
      return;
    }

    if (!requested && this.isPaused()) {
      this.logger.info('Automatic scan skipped: paused by the owner.');
    } else {
      await this.runOnce();
    }
    if (this.stopping) {
      return;
    }

    const targetMs = this.nextTarget(this.now().getTime());
    if (this.persistNextRun(targetMs)) {
      this.armTimer(targetMs);
    } else {
      this.retryPersistNextRun(targetMs);
    }
  }

  /** One interval from now, or just after the next price change when that comes first. */
  private nextTarget(nowMs: number): number {
    const intervalTargetMs = nowMs + this.intervalMs;
    if (!this.options.nextPriceChange) {
      return intervalTargetMs;
    }
    let priceChangeMs: number;
    try {
      // A scan ending between the change and its delayed scan must still leave that scan due.
      priceChangeMs = this.options.nextPriceChange(new Date(nowMs - priceChangeScanDelayMs)).getTime()
        + priceChangeScanDelayMs;
    } catch (_error: unknown) {
      this.logger.error('Could not compute the next Steam price change.');
      return intervalTargetMs;
    }
    if (!Number.isFinite(priceChangeMs) || priceChangeMs <= nowMs || priceChangeMs >= intervalTargetMs) {
      return intervalTargetMs;
    }
    this.logger.info(`Next scan follows Steam's price change at ${new Date(priceChangeMs).toISOString()}.`);
    return priceChangeMs;
  }

  private persistNextRun(targetMs: number): boolean {
    try {
      this.options.scheduleRepository.setNextScheduledAt(new Date(targetMs).toISOString());
      return true;
    } catch (_error: unknown) {
      this.logger.error('Could not persist the next wishlist schedule.');
      return false;
    }
  }

  private armTimer(targetMs: number): void {
    const delayMs = Math.max(0, targetMs - this.now().getTime());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.runAutomaticCycle();
    }, delayMs);
  }

  private retryStart(): void {
    if (this.stopping) {
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.stopping) {
        return;
      }
      this.started = false;
      this.start();
    }, schedulePersistenceRetryMs);
  }

  private retryPersistNextRun(targetMs: number): void {
    if (this.stopping) {
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.stopping) {
        return;
      }
      if (this.persistNextRun(targetMs)) {
        this.armTimer(targetMs);
      } else {
        this.retryPersistNextRun(targetMs);
      }
    }, schedulePersistenceRetryMs);
  }
}
