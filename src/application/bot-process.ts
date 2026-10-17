import { safeLogger } from './safe-logger.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvironment, type EnvironmentConfig } from '../config/environment.js';
import {
  BotStartupCancelledError,
  startBot,
  type StartBotOptions,
} from './start-bot.js';

interface BotProcessRuntime {
  stop(): Promise<void>;
}

interface BotProcessTimer {
  clear(): void;
  unref(): void;
}

interface BotProcessClock {
  setInterval(callback: () => void, delayMs: number): BotProcessTimer;
}

interface BotProcessFileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { readonly recursive: true }): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  rmSync(path: string, options: { readonly force: true }): void;
}

interface BotProcessHost {
  readonly pid: number;
  exitCode: string | number | null | undefined;
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
}

interface BotProcessDependencies {
  readonly process: BotProcessHost;
  readonly fileSystem: BotProcessFileSystem;
  readonly clock: BotProcessClock;
  readonly logger: Pick<Console, 'log' | 'error'>;
  readonly now: () => Date;
  readonly loadEnvironment: () => EnvironmentConfig;
  readonly startBot: (
    environment: EnvironmentConfig,
    options: StartBotOptions,
  ) => Promise<BotProcessRuntime>;
}

interface RunBotProcessOptions {
  readonly runtimeDirectory?: string;
  readonly dependencies?: BotProcessDependencies;
}

export interface BotProcessControl {
  readonly completion: Promise<void>;
}

/**
 * Exit status after an owner restart from the admin panel (EX_TEMPFAIL). systemd
 * runs Dealio with Restart=on-failure, so a non-zero exit starts it again while a
 * clean exit (owner stop, SIGTERM) leaves it down.
 */
export const ownerRestartExitCode = 75;

const systemClock: BotProcessClock = {
  setInterval: (callback, delayMs) => {
    const timer = setInterval(callback, delayMs);
    return {
      clear: () => clearInterval(timer),
      unref: () => timer.unref(),
    };
  },
};

const systemFileSystem: BotProcessFileSystem = {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
};

const systemProcess: BotProcessHost = {
  get pid() {
    return process.pid;
  },
  get exitCode() {
    return process.exitCode;
  },
  set exitCode(value) {
    process.exitCode = value;
  },
  on: (signal, listener) => {
    process.on(signal, listener);
  },
};

const defaultDependencies: BotProcessDependencies = {
  process: systemProcess,
  fileSystem: systemFileSystem,
  clock: systemClock,
  logger: safeLogger,
  now: () => new Date(),
  loadEnvironment,
  startBot,
};

export function runBotProcess(options: RunBotProcessOptions = {}): BotProcessControl {
  const dependencies = options.dependencies ?? defaultDependencies;
  const runtimeDirectory = options.runtimeDirectory ?? resolve('.runtime');
  const shutdownRequestPath = resolve(runtimeDirectory, 'shutdown.request');
  const nodePidPath = resolve(runtimeDirectory, 'bot.node.pid');
  const healthPath = resolve(runtimeDirectory, 'bot.health.json');
  const startupAbortController = new AbortController();
  let shutdownRequested = false;
  let ownerExit: 'stop' | 'restart' | null = null;
  let resolveShutdownRequest = (): void => undefined;
  const shutdownRequest = new Promise<void>((resolve) => {
    resolveShutdownRequest = resolve;
  });

  dependencies.fileSystem.mkdirSync(runtimeDirectory, { recursive: true });
  const shutdownRequestTimer = dependencies.clock.setInterval(() => {
    try {
      if (!dependencies.fileSystem.existsSync(shutdownRequestPath)) {
        return;
      }

      const requestedProcess = dependencies.fileSystem
        .readFileSync(shutdownRequestPath, 'utf8')
        .trim();
      if (requestedProcess !== 'all' && requestedProcess !== String(dependencies.process.pid)) {
        return;
      }

      dependencies.fileSystem.rmSync(shutdownRequestPath, { force: true });
      requestShutdown('control request');
    } catch (error: unknown) {
      dependencies.logger.error(
        `${dependencies.now().toISOString()} Could not process cooperative shutdown request`,
        error,
      );
    }
  }, 500);
  shutdownRequestTimer.unref();

  const removeNodePid = (): void => {
    try {
      if (
        dependencies.fileSystem.readFileSync(nodePidPath, 'utf8').trim() ===
        String(dependencies.process.pid)
      ) {
        dependencies.fileSystem.rmSync(nodePidPath, { force: true });
      }
    } catch (_error: unknown) {
      return;
    }
  };

  const requestShutdown = (signal: string): void => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    shutdownRequestTimer.clear();
    dependencies.logger.log(
      `${dependencies.now().toISOString()} Received ${signal}; shutting down.`,
    );
    startupAbortController.abort();
    resolveShutdownRequest();
  };

  dependencies.process.on('SIGINT', () => requestShutdown('SIGINT'));
  dependencies.process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  const completion = Promise.resolve().then(async () => {
    try {
      const runtime = await dependencies.startBot(dependencies.loadEnvironment(), {
        signal: startupAbortController.signal,
        nodePidPath,
        healthPath,
        requestExit: (mode) => {
          if (shutdownRequested) return;
          ownerExit = mode;
          requestShutdown(`owner ${mode} request`);
        },
      });
      if (!shutdownRequested) {
        await shutdownRequest;
      }
      await runtime.stop();
      if (ownerExit === 'restart') {
        dependencies.process.exitCode = ownerRestartExitCode;
      }
    } catch (error: unknown) {
      if (!(shutdownRequested && error instanceof BotStartupCancelledError)) {
        const failure = shutdownRequested ? 'Bot shutdown failed' : 'Bot failed to start';
        dependencies.logger.error(`${dependencies.now().toISOString()} ${failure}`, error);
        dependencies.process.exitCode = 1;
      }
    } finally {
      shutdownRequestTimer.clear();
      removeNodePid();
    }
  });

  return { completion };
}
