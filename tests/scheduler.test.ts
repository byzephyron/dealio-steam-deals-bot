import { describe, expect, it, vi } from 'vitest';
import { BotRuntime } from '../src/application/bot-runtime.js';
import { ApplicationTaskTracker } from '../src/application/application-task-tracker.js';
import {
  type SchedulerCheckService,
  type SchedulerClock,
  type SchedulerLogger,
  type SchedulerNotificationService,
  WishlistScheduler,
} from '../src/application/scheduler.js';
import { nextSteamPriceChange } from '../src/domain/steam-price-schedule.js';
import type { UserConfig } from '../src/domain/user-config.js';
import { createDatabase } from '../src/persistence/database.js';
import { CheckStateRepository } from '../src/persistence/check-state-repository.js';
import { PollScheduleRepository } from '../src/persistence/poll-schedule-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';

function user(discordUserId: string): UserConfig {
  return {
    discordUserId,
    steamId64: '76561198000000000',
    configVersion: 1,
    language: 'en',
    enabled: true,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

function successResult() {
  return {
    status: 'success' as const,
    checkedCount: 0,
    notificationCandidates: [],
    failedItems: [],
    unknownPriceCount: 0,
  };
}

function createClock() {
  let callback: (() => void) | null = null;
  let handle: object | null = null;

  const clock: SchedulerClock = {
    setTimeout: vi.fn((nextCallback) => {
      callback = nextCallback;
      handle = {};
      return handle as ReturnType<typeof setTimeout>;
    }),
    clearTimeout: vi.fn((receivedHandle) => {
      if (receivedHandle === handle) {
        callback = null;
      }
    }),
  };

  return {
    clock,
    trigger: () => callback?.(),
  };
}

function createScheduleRepository(initialValue: string | null = null) {
  let value = initialValue;
  return {
    findNextScheduledAt: vi.fn(() => value),
    setNextScheduledAt: vi.fn((nextValue: string | null) => {
      value = nextValue;
    }),
  };
}

function createLogger(): SchedulerLogger {
  return { info: vi.fn(), error: vi.fn() };
}

function createNotificationService(): SchedulerNotificationService {
  return {
    deliverPending: vi.fn().mockResolvedValue({
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
    }),
  };
}

function createScheduler(
  users: UserConfig[],
  checkService: SchedulerCheckService,
  notificationService = createNotificationService(),
  clock = createClock(),
  maxUserConcurrency = 3,
  scheduleRepository = createScheduleRepository(),
  now = () => new Date('2026-08-22T00:00:00.000Z'),
) {
  const logger = createLogger();
  const scheduler = new WishlistScheduler({
    intervalHours: 6,
    userConfigRepository: { findEnabled: () => users },
    checkService,
    notificationService,
    scheduleRepository,
    clock: clock.clock,
    now,
    logger,
    maxUserConcurrency,
  });

  return { scheduler, clock, logger, notificationService, scheduleRepository };
}

describe('WishlistScheduler', () => {
  it('reports aggregate scan duration and Steam item errors without account identifiers', async () => {
    let nowMs = Date.parse('2026-08-22T00:00:00.000Z');
    const checkService = {
      check: vi.fn().mockImplementation(async () => {
        nowMs += 1_250;
        return {
          ...successResult(), checkedCount: 3,
          failedItems: [{ appId: 10, code: 'STEAM_UPSTREAM_ERROR' }],
        };
      }),
    };
    const { scheduler, logger } = createScheduler(
      [user('sensitive-user-id')], checkService,
      createNotificationService(), createClock(), 3,
      createScheduleRepository(), () => new Date(nowMs),
    );
    await scheduler.runOnce();
    const messages = (logger.info as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(messages).toContain('durationMs=1250');
    expect(messages).toContain('checkedGames=3');
    expect(messages).toContain('steamItemErrors=1');
    expect(messages).not.toContain('sensitive-user-id');
  });

  it('checks every enabled configured user', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const { scheduler } = createScheduler(
      [user('user-a'), user('user-b')],
      checkService,
    );

    const summary = await scheduler.runOnce();

    expect(checkService.check).toHaveBeenCalledTimes(2);
    expect(checkService.check).toHaveBeenCalledWith('user-a', 'automatic');
    expect(checkService.check).toHaveBeenCalledWith('user-b', 'automatic');
    expect(summary).toEqual({ userCount: 2, completedCount: 2, errorCount: 0 });
  });

  it('does not select disabled users for automatic wishlist checks', async () => {
    const database = createDatabase(':memory:');
    const userRepository = new UserConfigRepository(database);
    userRepository.upsert('enabled-user', '76561198000000000', 'en', 'TR', '2026-08-21T00:00:00Z');
    userRepository.upsert('disabled-user', '76561198000000001', 'en', 'TR', '2026-08-21T00:00:00Z');
    userRepository.setEnabled('disabled-user', false, '2026-08-21T01:00:00Z');
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduler = new WishlistScheduler({
      intervalHours: 6,
      userConfigRepository: userRepository,
      checkService,
      notificationService: createNotificationService(),
      scheduleRepository: new PollScheduleRepository(database),
      logger: createLogger(),
    });

    try {
      await expect(scheduler.runOnce()).resolves.toMatchObject({ userCount: 1 });
      expect(checkService.check).toHaveBeenCalledOnce();
      expect(checkService.check).toHaveBeenCalledWith('enabled-user', 'automatic');
    } finally {
      database.close();
    }
  });

  it('continues with other users when one check fails', async () => {
    const checkService = {
      check: vi.fn().mockImplementation(async (discordUserId: string) => {
        if (discordUserId === 'user-a') {
          throw new Error('test failure');
        }

        return successResult();
      }),
    };
    const { scheduler } = createScheduler(
      [user('user-a'), user('user-b')],
      checkService,
    );

    const summary = await scheduler.runOnce();

    expect(checkService.check).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ userCount: 2, completedCount: 2, errorCount: 1 });
  });

  it('uses the configured interval and clears it on stop', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduleRepository = createScheduleRepository('2026-08-22T06:00:00.000Z');
    const { scheduler, clock } = createScheduler(
      [user('user-a')],
      checkService,
      createNotificationService(),
      createClock(),
      3,
      scheduleRepository,
    );

    scheduler.start();
    scheduler.start();
    await scheduler.stop();

    expect(scheduler.intervalMilliseconds).toBe(6 * 60 * 60 * 1000);
    expect(clock.clock.setTimeout).toHaveBeenCalledTimes(1);
    expect(clock.clock.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      6 * 60 * 60 * 1000,
    );
    expect(clock.clock.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not start a parallel scheduler run for the same users', async () => {
    let resolveCheck: (() => void) | undefined;
    const checkService = {
      check: vi.fn().mockImplementation(
        () => new Promise((resolve) => {
          resolveCheck = () => resolve(successResult());
        }),
      ),
    };
    const { scheduler } = createScheduler([user('user-a')], checkService);

    const firstRun = scheduler.runOnce();
    const secondRun = await scheduler.runOnce();
    resolveCheck?.();
    await firstRun;

    expect(secondRun).toEqual({ userCount: 0, completedCount: 0, errorCount: 0 });
    expect(checkService.check).toHaveBeenCalledTimes(1);
  });

  it('triggers an initial run and later interval runs', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const { scheduler, clock } = createScheduler([user('user-a')], checkService);

    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.trigger();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(checkService.check).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('skips automatic scans while the owner paused them, keeps scheduling, and still scans on request', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const clock = createClock();
    const scheduleRepository = createScheduleRepository();
    let paused = true;
    const logger = createLogger();
    const scheduler = new WishlistScheduler({
      intervalHours: 6,
      userConfigRepository: { findEnabled: () => [user('user-a')] },
      checkService,
      notificationService: createNotificationService(),
      scheduleRepository,
      clock: clock.clock,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      logger,
      isPaused: () => paused,
    });
    const settle = async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    scheduler.start();
    await settle();
    expect(checkService.check).not.toHaveBeenCalled();
    expect(scheduler.status().paused).toBe(true);
    expect(scheduleRepository.setNextScheduledAt).toHaveBeenLastCalledWith('2026-08-22T06:00:00.000Z');
    expect(logger.info).toHaveBeenCalledWith('Automatic scan skipped: paused by the owner.');

    expect(scheduler.runNow()).toBe(true);
    await settle();
    expect(checkService.check).toHaveBeenCalledTimes(1);

    paused = false;
    clock.trigger();
    await settle();
    expect(checkService.check).toHaveBeenCalledTimes(2);
    expect(scheduler.status().paused).toBe(false);
    await scheduler.stop();
  });

  it('keeps scanning when the pause setting cannot be read', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduler = new WishlistScheduler({
      intervalHours: 6,
      userConfigRepository: { findEnabled: () => [user('user-a')] },
      checkService,
      notificationService: createNotificationService(),
      scheduleRepository: createScheduleRepository(),
      clock: createClock().clock,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      logger: createLogger(),
      isPaused: () => { throw new Error('settings table missing'); },
    });
    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checkService.check).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('waits for the active run and blocks new runs during shutdown', async () => {
    let resolveCheck: (() => void) | undefined;
    const checkService = {
      check: vi.fn().mockImplementation(
        () => new Promise((resolve) => {
          resolveCheck = () => resolve(successResult());
        }),
      ),
    };
    const { scheduler } = createScheduler([user('user-a')], checkService);
    const activeRun = scheduler.runOnce();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });

    expect(stopped).toBe(false);
    await expect(scheduler.runOnce()).resolves.toEqual({
      userCount: 0,
      completedCount: 0,
      errorCount: 0,
    });
    resolveCheck?.();
    await activeRun;
    await stopping;

    expect(stopped).toBe(true);
    expect(checkService.check).toHaveBeenCalledTimes(1);
  });

  it('limits the number of users processed concurrently', async () => {
    let activeCount = 0;
    let maximumActiveCount = 0;
    const checkService = {
      check: vi.fn().mockImplementation(async () => {
        activeCount += 1;
        maximumActiveCount = Math.max(maximumActiveCount, activeCount);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeCount -= 1;
        return successResult();
      }),
    };
    const users = Array.from({ length: 6 }, (_, index) => user(`user-${index}`));
    const { scheduler } = createScheduler(
      users,
      checkService,
      createNotificationService(),
      createClock(),
      2,
    );

    await scheduler.runOnce();

    expect(maximumActiveCount).toBe(2);
  });

  it('rejects timer intervals outside the safe operational range', () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };

    expect(() => new WishlistScheduler({
      intervalHours: 1_000,
      userConfigRepository: { findEnabled: () => [] },
      checkService,
      notificationService: createNotificationService(),
      scheduleRepository: createScheduleRepository(),
    })).toThrow('Scheduler interval must be between 0.25 and 168 hours');
  });

  it('resumes a persisted future run without an immediate check', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduleRepository = createScheduleRepository('2026-08-22T03:00:00.000Z');
    const { scheduler, clock } = createScheduler(
      [user('user-a')],
      checkService,
      createNotificationService(),
      createClock(),
      3,
      scheduleRepository,
    );

    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(checkService.check).not.toHaveBeenCalled();
    expect(clock.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 3 * 60 * 60 * 1000);
    expect(scheduleRepository.setNextScheduledAt)
      .toHaveBeenCalledWith('2026-08-22T03:00:00.000Z');
    await scheduler.stop();
  });

  it.each([
    ['2026-08-22T06:00:00.000Z', '2026-08-22T00:30:00.000Z', 30],
    ['2026-08-22T00:10:00.000Z', '2026-08-22T00:10:00.000Z', 10],
  ])('resumes %s with a half-hour interval without delaying an earlier target', async (saved, expected, minutes) => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduleRepository = createScheduleRepository(saved);
    const clock = createClock();
    const scheduler = new WishlistScheduler({
      intervalHours: 0.5,
      userConfigRepository: { findEnabled: () => [user('user-a')] },
      checkService,
      notificationService: createNotificationService(),
      scheduleRepository,
      clock: clock.clock,
      logger: createLogger(),
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });

    try {
      scheduler.start();
      expect(checkService.check).not.toHaveBeenCalled();
      expect(clock.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), minutes * 60_000);
      expect(scheduleRepository.setNextScheduledAt).toHaveBeenCalledWith(expected);
      clock.trigger();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(checkService.check).toHaveBeenCalledWith('user-a', 'automatic');
      expect(clock.clock.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 30 * 60_000);
    } finally {
      await scheduler.stop();
    }
  });

  it.each([
    // Steam changes prices at 17:00 UTC; the half-hour interval would only reach 17:22.
    ['2026-10-07T16:52:00.000Z', '2026-10-07T17:02:00.000Z', 10],
    // The change is further away than the interval, which stays in charge.
    ['2026-10-07T15:00:00.000Z', '2026-10-07T15:30:00.000Z', 30],
    // Ending after the change but before its delayed scan still runs that scan.
    ['2026-10-07T17:01:00.000Z', '2026-10-07T17:02:00.000Z', 1],
    // Just past the aligned scan, the next one is the regular interval.
    ['2026-10-07T17:02:30.000Z', '2026-10-07T17:32:30.000Z', 30],
  ])('after a scan ending %s schedules the next one at %s', async (completedAt, expected, minutes) => {
    const scheduleRepository = createScheduleRepository();
    const clock = createClock();
    const scheduler = new WishlistScheduler({
      intervalHours: 0.5,
      userConfigRepository: { findEnabled: () => [user('user-a')] },
      checkService: { check: vi.fn().mockResolvedValue(successResult()) },
      notificationService: createNotificationService(),
      scheduleRepository,
      clock: clock.clock,
      logger: createLogger(),
      now: () => new Date(completedAt),
      nextPriceChange: nextSteamPriceChange,
    });

    try {
      scheduler.start();
      await vi.waitFor(() => expect(scheduleRepository.setNextScheduledAt).toHaveBeenLastCalledWith(expected));
      expect(clock.clock.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), minutes * 60_000);
    } finally {
      await scheduler.stop();
    }
  });

  it('pulls a saved later target forward to the price change after a restart', async () => {
    const scheduleRepository = createScheduleRepository('2026-10-07T17:20:00.000Z');
    const clock = createClock();
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduler = new WishlistScheduler({
      intervalHours: 0.5,
      userConfigRepository: { findEnabled: () => [user('user-a')] },
      checkService,
      notificationService: createNotificationService(),
      scheduleRepository,
      clock: clock.clock,
      logger: createLogger(),
      now: () => new Date('2026-10-07T16:55:00.000Z'),
      nextPriceChange: nextSteamPriceChange,
    });

    try {
      scheduler.start();
      expect(checkService.check).not.toHaveBeenCalled();
      expect(scheduleRepository.setNextScheduledAt).toHaveBeenCalledWith('2026-10-07T17:02:00.000Z');
      expect(clock.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 7 * 60_000);
    } finally {
      await scheduler.stop();
    }
  });

  it('keeps the regular interval when the price change cannot be computed', async () => {
    const scheduleRepository = createScheduleRepository();
    const logger = createLogger();
    const scheduler = new WishlistScheduler({
      intervalHours: 0.5,
      userConfigRepository: { findEnabled: () => [user('user-a')] },
      checkService: { check: vi.fn().mockResolvedValue(successResult()) },
      notificationService: createNotificationService(),
      scheduleRepository,
      clock: createClock().clock,
      logger,
      now: () => new Date('2026-10-07T16:52:00.000Z'),
      nextPriceChange: () => { throw new Error('no time zone data'); },
    });

    try {
      scheduler.start();
      await vi.waitFor(() => expect(scheduleRepository.setNextScheduledAt)
        .toHaveBeenLastCalledWith('2026-10-07T17:22:00.000Z'));
      expect(logger.error).toHaveBeenCalledWith('Could not compute the next Steam price change.');
    } finally {
      await scheduler.stop();
    }
  });

  it('persists completion plus interval after an automatic run', async () => {
    let now = new Date('2026-08-22T00:00:00.000Z');
    const checkService = {
      check: vi.fn().mockImplementation(async () => {
        now = new Date('2026-08-22T00:05:00.000Z');
        return successResult();
      }),
    };
    const scheduleRepository = createScheduleRepository();
    const { scheduler } = createScheduler(
      [user('user-a')],
      checkService,
      createNotificationService(),
      createClock(),
      3,
      scheduleRepository,
      () => now,
    );

    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(scheduleRepository.setNextScheduledAt).toHaveBeenNthCalledWith(1, null);
    expect(scheduleRepository.setNextScheduledAt).toHaveBeenNthCalledWith(
      2,
      '2026-08-22T06:05:00.000Z',
    );
    await scheduler.stop();
  });

  it('persists next_scheduled_at for users and resumes it after restart', async () => {
    const database = createDatabase(':memory:');
    const userRepository = new UserConfigRepository(database);
    const checkStateRepository = new CheckStateRepository(database);
    const scheduleRepository = new PollScheduleRepository(database);
    userRepository.upsert(
      'user-a',
      '76561198000000000',
      'en',
      'TR',
      '2026-08-22T00:00:00.000Z',
    );
    const firstCheck = { check: vi.fn().mockResolvedValue(successResult()) };
    const firstClock = createClock();
    const firstScheduler = new WishlistScheduler({
      intervalHours: 6,
      userConfigRepository: userRepository,
      checkService: firstCheck,
      notificationService: createNotificationService(),
      scheduleRepository,
      clock: firstClock.clock,
      logger: createLogger(),
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });

    firstScheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checkStateRepository.findByDiscordUserId('user-a')?.nextScheduledAt)
      .toBe('2026-08-22T06:00:00.000Z');
    await firstScheduler.stop();

    userRepository.upsert(
      'user-b',
      '76561198000000001',
      'tr',
      'TR',
      '2026-08-22T00:30:00.000Z',
    );
    expect(checkStateRepository.findByDiscordUserId('user-b')?.nextScheduledAt)
      .toBe('2026-08-22T06:00:00.000Z');

    const secondCheck = { check: vi.fn().mockResolvedValue(successResult()) };
    const secondClock = createClock();
    const secondScheduler = new WishlistScheduler({
      intervalHours: 6,
      userConfigRepository: userRepository,
      checkService: secondCheck,
      notificationService: createNotificationService(),
      scheduleRepository,
      clock: secondClock.clock,
      logger: createLogger(),
      now: () => new Date('2026-08-22T01:00:00.000Z'),
    });
    secondScheduler.start();

    expect(secondCheck.check).not.toHaveBeenCalled();
    expect(secondClock.clock.setTimeout)
      .toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 60 * 1000);
    expect(checkStateRepository.findByDiscordUserId('user-a')?.nextScheduledAt)
      .toBe('2026-08-22T06:00:00.000Z');
    await secondScheduler.stop();
    database.close();
  });

  it('retries a transient schedule persistence failure instead of stopping polling', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduleRepository = createScheduleRepository('2026-08-22T03:00:00.000Z');
    scheduleRepository.setNextScheduledAt
      .mockImplementationOnce(() => { throw new Error('temporary database failure'); });
    const clock = createClock();
    const { scheduler } = createScheduler(
      [user('user-a')],
      checkService,
      createNotificationService(),
      clock,
      3,
      scheduleRepository,
    );

    scheduler.start();
    expect(clock.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    clock.trigger();

    expect(scheduleRepository.setNextScheduledAt).toHaveBeenCalledTimes(2);
    expect(clock.clock.setTimeout).toHaveBeenLastCalledWith(
      expect.any(Function),
      3 * 60 * 60 * 1000,
    );
    expect(checkService.check).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('retries when clearing a due schedule temporarily fails', async () => {
    const checkService = { check: vi.fn().mockResolvedValue(successResult()) };
    const scheduleRepository = createScheduleRepository();
    scheduleRepository.setNextScheduledAt
      .mockImplementationOnce(() => { throw new Error('temporary database failure'); });
    const clock = createClock();
    const { scheduler } = createScheduler(
      [user('user-a')],
      checkService,
      createNotificationService(),
      clock,
      3,
      scheduleRepository,
    );

    scheduler.start();
    expect(clock.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(checkService.check).not.toHaveBeenCalled();

    clock.trigger();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(scheduleRepository.setNextScheduledAt).toHaveBeenNthCalledWith(2, null);
    expect(checkService.check).toHaveBeenCalledOnce();
    expect(clock.clock.setTimeout).toHaveBeenLastCalledWith(
      expect.any(Function),
      6 * 60 * 60 * 1000,
    );
    await scheduler.stop();
  });
});

describe('BotRuntime', () => {
  it('stops scheduler, Discord client, and database once', async () => {
    const calls: string[] = [];
    const scheduler = { stop: vi.fn(async () => { calls.push('scheduler'); }) };
    const client = { destroy: vi.fn(async () => { calls.push('client'); }) };
    const database = { close: vi.fn(() => calls.push('database')) };
    const runtime = new BotRuntime(scheduler, client, database);

    await Promise.all([runtime.stop(), runtime.stop()]);

    expect(calls).toEqual(['scheduler', 'client', 'database']);
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
  });

  it('cancels active delivery and stops additional schedulers before closing resources', async () => {
    const calls: string[] = [];
    const scheduler = { stop: vi.fn(async () => { calls.push('scheduler'); }) };
    const retryScheduler = { stop: vi.fn(async () => { calls.push('retry'); }) };
    const client = { destroy: vi.fn(async () => { calls.push('client'); }) };
    const database = { close: vi.fn(() => calls.push('database')) };
    const health = {
      markStopping: vi.fn(() => calls.push('stopping')),
      markStopped: vi.fn(() => calls.push('stopped')),
      markFailed: vi.fn(),
    };
    const runtime = new BotRuntime(scheduler, client, database, {
      additionalSchedulers: [retryScheduler],
      cancelActiveWork: () => calls.push('cancel'),
      health,
    });

    await runtime.stop();

    expect(calls).toEqual([
      'stopping',
      'cancel',
      'scheduler',
      'retry',
      'client',
      'database',
      'stopped',
    ]);
    expect(retryScheduler.stop).toHaveBeenCalledOnce();
  });

  it('keeps resources open after the timeout until scheduler work finishes', async () => {
    let resolveStop: (() => void) | undefined;
    const scheduler = {
      stop: vi.fn(() => new Promise<void>((resolve) => {
        resolveStop = resolve;
      })),
    };
    const client = { destroy: vi.fn().mockResolvedValue(undefined) };
    const database = { close: vi.fn() };
    const logger = { error: vi.fn() };
    const runtime = new BotRuntime(scheduler, client, database, {
      shutdownTimeoutMs: 1,
      logger,
    });
    const stopping = runtime.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(logger.error).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(database.close).not.toHaveBeenCalled();

    resolveStop?.();
    await stopping;
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('waits for interaction work and rejects new work during shutdown', async () => {
    const taskTracker = new ApplicationTaskTracker();
    let resolveTask: (() => void) | undefined;
    taskTracker.run(
      () => new Promise<void>((resolve) => {
        resolveTask = resolve;
      }),
    );
    const scheduler = { stop: vi.fn().mockResolvedValue(undefined) };
    const client = { destroy: vi.fn().mockResolvedValue(undefined) };
    const database = { close: vi.fn() };
    const runtime = new BotRuntime(scheduler, client, database, { taskTracker });
    const stopping = runtime.stop();
    await Promise.resolve();

    expect(taskTracker.run(async () => undefined)).toBe(false);
    expect(client.destroy).not.toHaveBeenCalled();
    expect(database.close).not.toHaveBeenCalled();

    resolveTask?.();
    await stopping;
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('waits for all stop operations and retains the lock when database close fails', async () => {
    let resolveTasks: (() => void) | undefined;
    const scheduler = { stop: vi.fn(() => { throw new Error('scheduler stop failed'); }) };
    const taskTracker = {
      stop: vi.fn(() => new Promise<void>((resolve) => {
        resolveTasks = resolve;
      })),
    };
    const client = { destroy: vi.fn().mockRejectedValue(new Error('client destroy failed')) };
    const database = { close: vi.fn(() => { throw new Error('database close failed'); }) };
    const processLock = { release: vi.fn() };
    const runtime = new BotRuntime(scheduler, client, database, {
      taskTracker,
      processLock,
      shutdownTimeoutMs: 1,
      logger: { error: vi.fn() },
    });
    const stopping = runtime.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(client.destroy).not.toHaveBeenCalled();

    resolveTasks?.();
    await expect(stopping).rejects.toThrow('Bot shutdown completed with errors');
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
    expect(processLock.release).not.toHaveBeenCalled();
  });
});
