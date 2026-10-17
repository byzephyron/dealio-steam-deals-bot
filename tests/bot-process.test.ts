import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ownerRestartExitCode, runBotProcess } from '../src/application/bot-process.js';
import { BotStartupCancelledError } from '../src/application/start-bot.js';

interface ProcessHarnessOptions {
  readonly startFailure?: boolean;
  readonly deferStart?: boolean;
  readonly deferStop?: boolean;
  readonly stopFailure?: Error;
}

function processHarness(options: ProcessHarnessOptions = {}) {
  const runtimeDirectory = resolve('process-test-runtime');
  const shutdownRequestPath = resolve(runtimeDirectory, 'shutdown.request');
  const nodePidPath = resolve(runtimeDirectory, 'bot.node.pid');
  const healthPath = resolve(runtimeDirectory, 'bot.health.json');
  const files = new Map<string, string>();
  const events: string[] = [];
  const handlers = new Map<string, () => void>();
  const timer = { clear: vi.fn(), unref: vi.fn() };
  let poll = (): void => undefined;
  const mkdir = vi.fn();
  const setPolling = vi.fn((callback: () => void, _delayMs: number) => {
    poll = callback;
    return timer;
  });
  let resolveStop = (): void => undefined;
  const pendingStop = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const runtime = { stop: vi.fn(() => {
    events.push('stop');
    if (options.stopFailure) return Promise.reject(options.stopFailure);
    return options.deferStop ? pendingStop : Promise.resolve();
  }) };
  const environment = {
    discordToken: 'test-token',
    discordClientId: '123456789012345678',
    databasePath: ':memory:',
    pollIntervalHours: 6,
    notificationRetryIntervalSeconds: 60,
    maxUsers: 200,
  };
  let startupSignal: AbortSignal | undefined;
  let requestExit: ((mode: 'stop' | 'restart') => void) | undefined;
  let resolveStart = (): void => undefined;
  const pendingStart = new Promise<typeof runtime>((resolve) => {
    resolveStart = () => resolve(runtime);
  });
  const start = vi.fn(async (_environment: typeof environment, startupOptions: {
    readonly signal?: AbortSignal;
    readonly requestExit?: (mode: 'stop' | 'restart') => void;
  }) => {
    startupSignal = startupOptions.signal;
    requestExit = startupOptions.requestExit;
    if (options.startFailure) {
      if (startupOptions.signal?.aborted) throw new BotStartupCancelledError();
      throw new Error('startup failed');
    }
    if (options.deferStart) return pendingStart;
    return runtime;
  });
  const host: {
    pid: number;
    exitCode: string | number | null | undefined;
    on: (signal: string, listener: () => void) => void;
  } = {
    pid: 42,
    exitCode: undefined,
    on: (signal, listener) => { handlers.set(signal, listener); },
  };
  const logger = { log: vi.fn(), error: vi.fn() };
  const control = runBotProcess({
    runtimeDirectory,
    dependencies: {
      process: host,
      fileSystem: {
        existsSync: (path) => files.has(path),
        mkdirSync: mkdir,
        readFileSync: (path) => {
          const value = files.get(path);
          if (value === undefined) throw new Error('missing file');
          return value;
        },
        rmSync: (path) => { events.push(`remove:${path}`); files.delete(path); },
      },
      clock: {
        setInterval: setPolling,
      },
      logger,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      loadEnvironment: vi.fn().mockReturnValue(environment),
      startBot: start,
    },
  });
  return {
    control, events, files, handlers, healthPath, host, mkdir, nodePidPath,
    logger, poll: () => poll(), resolveStart, resolveStop, runtime, setPolling, shutdownRequestPath, start,
    startupSignal: () => startupSignal, requestExit: () => requestExit, timer,
  };
}

describe('process lifecycle', () => {
  it('creates runtime controls with an unrefed 500ms poll and both shutdown signals', async () => {
    const harness = processHarness();

    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());

    expect(harness.timer.unref).toHaveBeenCalledOnce();
    expect(harness.setPolling).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(harness.mkdir).toHaveBeenCalledWith(resolve('process-test-runtime'), { recursive: true });
    expect([...harness.handlers.keys()]).toEqual(['SIGINT', 'SIGTERM']);
    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({ discordToken: 'test-token' }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        nodePidPath: harness.nodePidPath,
        healthPath: harness.healthPath,
      }),
    );
  });

  it('retains a shutdown request addressed to another process', async () => {
    const harness = processHarness();
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
    harness.files.set(harness.shutdownRequestPath, '99');

    harness.poll();

    expect(harness.files.has(harness.shutdownRequestPath)).toBe(true);
    expect(harness.runtime.stop).not.toHaveBeenCalled();
  });

  it.each(['all', '42'])('removes a %s shutdown request before stopping the runtime', async (request) => {
    const harness = processHarness();
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
    harness.files.set(harness.shutdownRequestPath, request);

    harness.poll();
    await harness.control.completion;

    expect(harness.events).toEqual([`remove:${harness.shutdownRequestPath}`, 'stop']);
    expect(harness.startupSignal()?.aborted).toBe(true);
  });

  it('handles duplicate shutdown signals idempotently', async () => {
    const harness = processHarness();
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
    const shutdown = harness.handlers.get('SIGINT');
    if (shutdown === undefined) throw new Error('SIGINT handler was not registered');

    shutdown();
    shutdown();
    await harness.control.completion;

    expect(harness.runtime.stop).toHaveBeenCalledOnce();
  });

  it('keeps completion pending until requested runtime shutdown settles', async () => {
    const harness = processHarness({ deferStop: true });
    const completionSettled = vi.fn();
    void harness.control.completion.then(completionSettled);
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
    const shutdown = harness.handlers.get('SIGTERM');
    if (shutdown === undefined) throw new Error('SIGTERM handler was not registered');

    shutdown();
    await vi.waitFor(() => expect(harness.runtime.stop).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(completionSettled).not.toHaveBeenCalled();
    harness.resolveStop();
    await harness.control.completion;
    expect(completionSettled).toHaveBeenCalledOnce();
  });

  it('exits with the restart code after an owner restart, so systemd starts the bot again', async () => {
    const harness = processHarness();
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());

    harness.requestExit()?.('restart');
    harness.requestExit()?.('stop');
    await harness.control.completion;

    expect(harness.runtime.stop).toHaveBeenCalledOnce();
    expect(harness.host.exitCode).toBe(ownerRestartExitCode);
  });

  it('exits cleanly after an owner stop, so the bot stays down', async () => {
    const harness = processHarness();
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());

    harness.requestExit()?.('stop');
    await harness.control.completion;

    expect(harness.runtime.stop).toHaveBeenCalledOnce();
    expect(harness.host.exitCode).toBeUndefined();
  });

  it('reports requested runtime shutdown failure and sets a nonzero exit code', async () => {
    const stopFailure = new Error('shutdown failed');
    const harness = processHarness({ stopFailure });
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
    const shutdown = harness.handlers.get('SIGINT');
    if (shutdown === undefined) throw new Error('SIGINT handler was not registered');

    shutdown();
    await harness.control.completion;

    expect(harness.logger.error).toHaveBeenCalledWith(expect.any(String), stopFailure);
    expect(harness.host.exitCode).toBe(1);
  });

  it('stops a runtime that resolves after shutdown and removes its owned PID file', async () => {
    const harness = processHarness({ deferStart: true });
    harness.files.set(harness.nodePidPath, '42');
    await Promise.resolve();
    const shutdown = harness.handlers.get('SIGTERM');
    if (shutdown === undefined) throw new Error('SIGTERM handler was not registered');

    shutdown();
    expect(harness.runtime.stop).not.toHaveBeenCalled();
    harness.resolveStart();
    await harness.control.completion;

    expect(harness.runtime.stop).toHaveBeenCalledOnce();
    expect(harness.files.has(harness.nodePidPath)).toBe(false);
  });

  it.each([
    ['42', false],
    ['7', true],
  ])('removes the PID file only when owned (content=%s)', async (pidFile, retained) => {
    const harness = processHarness();
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
    harness.files.set(harness.nodePidPath, pidFile);
    const shutdown = harness.handlers.get('SIGTERM');
    if (shutdown === undefined) throw new Error('SIGTERM handler was not registered');

    shutdown();
    await harness.control.completion;
    expect(harness.files.has(harness.nodePidPath)).toBe(retained);
  });

  it.each([
    ['ordinary startup failure', false, 1],
    ['requested startup cancellation', true, undefined],
  ])('sets exit code only for %s', async (_case, requested, expectedExitCode) => {
    const harness = processHarness({ startFailure: true });
    if (requested) {
      const shutdown = harness.handlers.get('SIGTERM');
      if (shutdown === undefined) throw new Error('SIGTERM handler was not registered');
      shutdown();
    }

    await harness.control.completion;

    expect(harness.host.exitCode).toBe(expectedExitCode);
  });
});
