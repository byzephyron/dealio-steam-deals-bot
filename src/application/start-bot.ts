import { dirname, join } from 'node:path';
import { SteamWishlistError } from '../domain/steam.js';
import { nextSteamPriceChange } from '../domain/steam-price-schedule.js';
import { AzureApplicationLease } from './azure-lease.js';
import { AssistantService } from './assistant-service.js';
import { safeLogger } from './safe-logger.js';
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { loadEnvironment, type EnvironmentConfig } from '../config/environment.js';
import { registerBotEvents } from '../discord/bot-events.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordNotificationSender } from '../discord/notification-sender.js';
import { IsThereAnyDealClient } from '../price-history/itad-client.js';
import { registerCommands } from '../discord/register-commands.js';
import { CheckStateRepository } from '../persistence/check-state-repository.js';
import { DiscountThresholdRepository } from '../persistence/discount-threshold-repository.js';
import {
  createDatabase,
  DatabaseInitializationError,
} from '../persistence/database.js';
import { PollScheduleRepository } from '../persistence/poll-schedule-repository.js';
import { StatusDashboardRepository } from '../persistence/status-dashboard-repository.js';
import { DeletionJournal } from '../persistence/deletion-journal.js';
import { UserConfigRepository } from '../persistence/user-config-repository.js';
import { WishlistStateRepository } from '../persistence/wishlist-state-repository.js';
import { SteamClient } from '../steam/steam-client.js';
import { SteamIdentityResolver } from '../steam/steam-identity-resolver.js';
import { ApplicationTaskTracker } from './application-task-tracker.js';
import { BotRuntime } from './bot-runtime.js';
import { CheckService } from './check-service.js';
import { DiscountThresholdService } from './discount-threshold-service.js';
import { InitialWishlistSummaryService } from './initial-wishlist-summary-service.js';
import { NotificationRetryScheduler } from './notification-retry-scheduler.js';
import { NotificationService } from './notification-service.js';
import { ProcessLock } from './process-lock.js';
import { RuntimeHealth } from './runtime-health.js';
import { WishlistScheduler } from './scheduler.js';
import { SetupService } from './setup-service.js';
import { StatusService } from './status-service.js';
import { TestNotificationService, wishlistTestSale } from './test-notification-service.js';
import { UserConfigurationService } from './user-configuration-service.js';
import { UserOperationCoordinator } from './user-operation-coordinator.js';
import { WishlistViewService } from './wishlist-view-service.js';
import { AdminPanel } from '../admin/admin-panel.js';
import { settingOwnerCredentialStore } from '../admin/owner-credentials.js';
import { readRoutes } from '../admin/admin-routes.js';
import { DiscordClientDirectory } from '../admin/discord-directory.js';
import { LogBuffer } from '../admin/log-buffer.js';
import { AdminRepository } from '../persistence/admin-repository.js';
import { AdminQueryService } from './admin/admin-query-service.js';
import { actionRoutes } from '../admin/admin-action-routes.js';
import { AdminActionService } from './admin/admin-action-service.js';
import { BroadcastService } from './admin/broadcast-service.js';
import { RuntimeSettings } from './admin/runtime-settings.js';
import { DiscordAnnouncementSender } from '../discord/announcement-sender.js';
import { DiscordWishlistHiddenSender } from '../discord/wishlist-hidden-notice.js';
import { WishlistHiddenNoticeService } from './wishlist-hidden-notice-service.js';
import { applyPresence, registerGuildTracking } from '../discord/guild-tracking.js';
import { TopggStatsPoster } from '../operations/topgg-stats.js';
import { AdminControlRepository } from '../persistence/admin-control-repository.js';
import { BroadcastRepository } from '../persistence/broadcast-repository.js';
import { TelemetryRepository } from '../persistence/telemetry-repository.js';
import { SupportTicketRepository } from '../persistence/support-ticket-repository.js';
import { SupportTicketService } from './support-ticket-service.js';
import { RestSupportDesk } from '../discord/support/support-desk.js';
import { languageFromDiscordLocale } from '../discord/language.js';

export interface StartBotOptions {
  readonly signal?: AbortSignal;
  readonly nodePidPath?: string;
  readonly healthPath?: string;
  readonly health?: RuntimeHealth;
  /**
   * Ends the process gracefully on the owner's request from the admin panel:
   * `restart` exits with a failure code so systemd (Restart=on-failure) starts it
   * again; `stop` exits cleanly and the bot stays down.
   */
  readonly requestExit?: (mode: 'stop' | 'restart') => void;
}

export class BotStartupCancelledError extends Error {
  public readonly name = 'BotStartupCancelledError';

  public constructor() { super('Bot startup was cancelled'); }
}

export async function startBot(
  environment: EnvironmentConfig = loadEnvironment(),
  options: StartBotOptions = {},
): Promise<BotRuntime> {
  if (options.signal?.aborted) {
    throw new BotStartupCancelledError();
  }

  const processLock = environment.production
    ? ProcessLock.acquireForApplication(environment.databasePath, environment.discordClientId)
    : ProcessLock.acquire(environment.databasePath);
  let health: RuntimeHealth | undefined;
  try {
    health = options.health ?? (options.healthPath ? new RuntimeHealth(options.healthPath) : undefined);
  } catch (error: unknown) {
    processLock.release();
    throw error;
  }
  let database;
  try {
    database = createDatabase(environment.databasePath);
  } catch (error: unknown) {
    if (!(error instanceof DatabaseInitializationError) || error.databaseClosed) {
      processLock.release();
    }
    health?.markFailed();
    throw error;
  }

  let runtime: BotRuntime | null = null;
  let cloudLease: AzureApplicationLease | null = null;
  let handleStartupAbort: (() => void) | null = null;
  try {
    const userConfigRepository = new UserConfigRepository(database);
    const checkStateRepository = new CheckStateRepository(database);
    const wishlistStateRepository = new WishlistStateRepository(database);
    const pollScheduleRepository = new PollScheduleRepository(database);
    const statusDashboardRepository = new StatusDashboardRepository(database);
    const discountThresholdRepository = new DiscountThresholdRepository(database);
    const taskTracker = new ApplicationTaskTracker();
    const userOperationCoordinator = new UserOperationCoordinator();
    const applicationAbortController = new AbortController();
    const steamClient = new SteamClient({
      lifecycleSignal: applicationAbortController.signal,
    });
    const steamIdentityResolver = new SteamIdentityResolver({
      apiKey: environment.steamWebApiKey,
      lifecycleSignal: applicationAbortController.signal,
    });
    // Kept outside the database file, so restoring an older backup cannot undo /delete-data.
    const deletionJournal = environment.databasePath === ':memory:'
      ? undefined
      : new DeletionJournal(join(dirname(environment.databasePath), 'deletions.jsonl'));
    const restoredDeletions = deletionJournal?.reconcile(database) ?? 0;
    if (restoredDeletions > 0) {
      console.log(`${new Date().toISOString()} Re-applied ${restoredDeletions} data deletion(s) after a restore.`);
    }
    const userConfigurationService = new UserConfigurationService(
      userConfigRepository,
      steamIdentityResolver,
      steamClient,
      userOperationCoordinator,
      undefined,
      deletionJournal,
    );
    const statusService = new StatusService(
      userConfigRepository,
      checkStateRepository,
      statusDashboardRepository,
      discountThresholdRepository,
    );
    const checkService = new CheckService(
      userConfigRepository,
      checkStateRepository,
      wishlistStateRepository,
      steamClient,
      userOperationCoordinator,
    );
    // Owner controls exist whether or not the admin panel is enabled: the sign-up
    // limit, blocks and usage telemetry also apply to a bot without the panel.
    const telemetryRepository = new TelemetryRepository(database);
    const supportTicketRepository = new SupportTicketRepository(database);
    const adminControlRepository = new AdminControlRepository(database);
    const broadcastRepository = new BroadcastRepository(database);
    const runtimeSettings = new RuntimeSettings(adminControlRepository, environment.maxUsers);
    const isBlocked = (discordUserId: string): boolean => adminControlRepository.isUserBlocked(discordUserId);
    const discountThresholdService = new DiscountThresholdService(
      userConfigRepository,
      userOperationCoordinator,
      undefined,
      isBlocked,
    );
    const client = createDiscordClient();
    health?.setDiscordReadyProbe(() => client.isReady());
    health?.setDiscordGuildCountProbe(() => client.guilds.cache.size);
    const notificationSender = new DiscordNotificationSender(client, {
      lifecycleSignal: applicationAbortController.signal,
      bannerUrl: environment.dealioBannerUrl,
      pollIntervalHours: environment.pollIntervalHours,
    });
    const initialWishlistSummaryService = new InitialWishlistSummaryService(
      checkService,
      notificationSender,
    );
    const setupService = new SetupService(
      userConfigurationService,
      initialWishlistSummaryService,
      userOperationCoordinator,
      {
        maxUsers: () => runtimeSettings.maxUsers(),
        signupsOpen: () => runtimeSettings.signupsOpen(),
        isBlocked,
        onStep: (discordUserId, step, code) => telemetryRepository.recordInteraction({
          discordUserId, guildId: null, context: 'unknown', install: 'unknown', kind: 'setup',
          action: code ? `${step}:${code}` : step, locale: null, occurredAt: new Date().toISOString(),
        }),
      },
    );
    const priceHistory = environment.isThereAnyDealApiKey
      ? new IsThereAnyDealClient({
        apiKey: environment.isThereAnyDealApiKey,
        lifecycleSignal: applicationAbortController.signal,
      })
      : undefined;
    const notificationService = new NotificationService(
      userConfigRepository,
      wishlistStateRepository,
      notificationSender,
      {
        coordinator: userOperationCoordinator,
        revalidate: async (user) => {
          const result = await checkService.checkWithinUserOperation(user, 'automatic', {bypassCooldown:true});
          return result.status === 'success';
        },
        lifecycleSignal: applicationAbortController.signal,
        ...(priceHistory ? { priceHistory } : {}),
      },
    );
    const testNotificationService = new TestNotificationService(notificationSender, {
      sample: async (discordUserId) => {
        const config = userConfigRepository.findByDiscordUserId(discordUserId);
        const snapshot = config && wishlistStateRepository.assistant.snapshot(config);
        if (!config || !snapshot) return null;
        const muted = new Set([...wishlistStateRepository.assistant.rules(config)]
          .filter(([, rule]) => rule.muted).map(([appId]) => appId));
        return wishlistTestSale(config, snapshot.items, muted, priceHistory);
      },
    });
    const assistantService = new AssistantService(wishlistStateRepository.assistant,userConfigRepository,userOperationCoordinator,
      config=>testNotificationService.send(config.discordUserId,config.language,config.storeCountryCode),priceHistory,
      environment.pollIntervalHours,isBlocked);
    const wishlistViewService = new WishlistViewService(
      userConfigRepository,
      steamClient,
      undefined,
      discountThresholdRepository,
      userOperationCoordinator,
      wishlistStateRepository.assistant,
      assistantService,
      async user=>{
        const result=await checkService.checkWithinUserOperation(user,'manual',{bypassCooldown:true});
        if(result.status!=='success') throw new SteamWishlistError('STEAM_UPSTREAM_ERROR','Wishlist refresh failed');
        return {items:[...result.wishlistItems],errors:[...result.failedItems,...result.unavailableItems]};
      },
    );
    const runRetention=()=>{try{wishlistStateRepository.assistant.cleanup();telemetryRepository.cleanup();adminControlRepository.cleanup();broadcastRepository.cleanup();supportTicketRepository.cleanup();deletionJournal?.cleanup();}catch(error){safeLogger.error('Retention cleanup failed',error);}};
    // Also once at startup: frequent restarts must not keep postponing the hourly cleanup.
    runRetention();
    const retentionTimer=setInterval(runRetention,3600000);
    retentionTimer.unref();
    const wishlistHiddenNoticeService = new WishlistHiddenNoticeService({
      userConfigRepository,
      checkStateRepository,
      preference: (discordUserId) => wishlistStateRepository.assistant.preference(discordUserId),
      sender: new DiscordWishlistHiddenSender(client),
      coordinator: userOperationCoordinator,
      isBlocked,
      lifecycleSignal: applicationAbortController.signal,
    });
    const scheduler = new WishlistScheduler({
      intervalHours: environment.pollIntervalHours,
      userConfigRepository,
      checkService,
      notificationService,
      wishlistHiddenNotices: wishlistHiddenNoticeService,
      scheduleRepository: pollScheduleRepository,
      nextPriceChange: nextSteamPriceChange,
      isPaused: () => runtimeSettings.scansPaused(),
    });
    const notificationRetryScheduler = new NotificationRetryScheduler({
      intervalSeconds: environment.notificationRetryIntervalSeconds,
      userConfigRepository,
      notificationService,
    });
    const adminRepository = new AdminRepository(database);
    const broadcastService = environment.adminPanel ? new BroadcastService({
      repository: broadcastRepository,
      users: () => adminRepository.users(),
      isBlocked: (discordUserId) => adminControlRepository.isUserBlocked(discordUserId),
      sender: new DiscordAnnouncementSender(client),
      onDmBlocked: (discordUserId, errorCode) => { userConfigurationService.markDmDeliveryBlocked(discordUserId, errorCode); },
    }) : null;
    const adminPanel = environment.adminPanel && broadcastService ? (() => {
      const logs = new LogBuffer();
      logs.install();
      const query = new AdminQueryService({
        adminRepository,
        userConfigRepository,
        assistant: wishlistStateRepository.assistant,
        pollSchedule: pollScheduleRepository,
        directory: new DiscordClientDirectory(client),
        schedulerStatus: () => scheduler.status(),
        ...(health ? { health: () => health!.current() } : {}),
        ...(deletionJournal ? { deletionJournal } : {}),
        telemetry: telemetryRepository,
        controls: adminControlRepository,
        broadcasts: broadcastRepository,
        runtimeSettings: () => runtimeSettings.snapshot(),
        databasePath: environment.databasePath,
        settings: {
          pollIntervalHours: environment.pollIntervalHours,
          notificationRetryIntervalSeconds: environment.notificationRetryIntervalSeconds,
          priceHistoryEnabled: priceHistory !== undefined,
          steamVanityEnabled: environment.steamWebApiKey !== undefined,
          production: environment.production === true,
        },
      });
      const actions = new AdminActionService({
        users: userConfigurationService,
        checks: checkService,
        notifications: notificationService,
        testNotifications: testNotificationService,
        scheduler,
        retryScheduler: notificationRetryScheduler,
        controls: adminControlRepository,
        broadcasts: broadcastService,
        settings: runtimeSettings,
        telemetry: telemetryRepository,
        applyPresence: (text) => applyPresence(client, text),
        ...(options.requestExit ? { requestExit: options.requestExit } : {}),
        guilds: {
          name: (guildId) => client.guilds.cache.get(guildId)?.name ?? null,
          leave: async (guildId) => {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return false;
            await guild.leave();
            return true;
          },
        },
      });
      return new AdminPanel(environment.adminPanel!, () => [
        ...readRoutes({ query, logs }),
        ...actionRoutes({ actions, query, broadcasts: broadcastService }),
      ], logs, safeLogger, settingOwnerCredentialStore(adminControlRepository),
      (action, detail, outcome) => adminControlRepository.audit(action, null, detail, outcome, new Date().toISOString()));
    })() : null;
    registerGuildTracking({
      client,
      telemetry: telemetryRepository,
      controls: adminControlRepository,
      presenceText: () => runtimeSettings.presenceText(),
    });
    // The server count on the top.gg listing; off unless TOPGG_TOKEN is set.
    const topggStats = environment.topggToken ? new TopggStatsPoster({
      token: environment.topggToken,
      botId: environment.discordClientId,
      serverCount: () => (client.isReady() ? client.guilds.cache.size : null),
      logger: safeLogger,
    }) : null;
    if (topggStats) client.once('clientReady', () => topggStats.start());
    runtime = new BotRuntime(scheduler, client, database, {
      taskTracker,
      afterDisconnect: async()=>{await cloudLease?.stop();},
      processLock,
      additionalSchedulers: [notificationRetryScheduler,{
        stop: async () => { clearInterval(retentionTimer); },
      }, ...(broadcastService ? [broadcastService] : []), ...(adminPanel ? [adminPanel] : []),
      ...(topggStats ? [topggStats] : [])],
      cancelActiveWork: () => applicationAbortController.abort(),
      health,
    });
    const startedRuntime = runtime;
    if (options.nodePidPath) {
      writeFileSync(options.nodePidPath, String(process.pid), 'utf8');
    }
    handleStartupAbort = () => {
      void startedRuntime.stop().catch((error: unknown) => {
        safeLogger.error('Bot shutdown during startup failed', error);
      });
    };
    options.signal?.addEventListener('abort', handleStartupAbort, { once: true });

    registerBotEvents({
      client,
      scheduler,
      notificationRetryScheduler,
      taskTracker,
      services: {
        userConfigurationService,
        setupService,
        statusService,
        checkService,
        notificationService,
        testNotificationService,
        wishlistViewService,
        discountThresholdService,
        setupPresentation: {
          bannerUrl: environment.dealioBannerUrl,
          pollIntervalHours: environment.pollIntervalHours,
          onWishlistHidden: (discordUserId, language) => wishlistHiddenNoticeService.hintSetup(discordUserId, language),
        },
      },
      lifecycleSignal: applicationAbortController.signal,
      health,
      telemetry: telemetryRepository,
      blocks: adminControlRepository,
      support: {
        ...(environment.support ? {
          config: environment.support,
          service: new SupportTicketService(supportTicketRepository, new RestSupportDesk(client.rest, environment.support)),
        } : {}),
        languageFor: (discordUserId, locale) => userConfigurationService.get(discordUserId)?.language
          ?? languageFromDiscordLocale(locale),
      },
    });

    if(environment.azureLeaseContainerUrl) cloudLease = await AzureApplicationLease.forApplication(
      environment.azureLeaseContainerUrl,environment.discordClientId,()=>{
        applicationAbortController.abort();
        void client.destroy();
        health?.markFailed();
        // Finish cooperative cleanup, then let systemd's on-failure policy recover.
        process.exitCode=1;
        if(options.nodePidPath) writeFileSync(join(dirname(options.nodePidPath),'shutdown.request'),String(process.pid));
        else void startedRuntime.stop().catch(error=>safeLogger.error('Shutdown after lease loss failed',error));
      });
    await adminPanel?.start();
    // Announcements need the REST token that login sets.
    if (broadcastService) client.once('clientReady', () => broadcastService.start());
    await registerCommands(environment, options.signal);
    if (options.signal?.aborted) {
      throw new BotStartupCancelledError();
    }
    if(applicationAbortController.signal.aborted)throw new BotStartupCancelledError();
    const loginPromise = client.login(environment.discordToken);
    if (options.signal) {
      const startupSignal = options.signal;
      let rejectForAbort = (_error: BotStartupCancelledError): void => undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectForAbort = reject;
      });
      const handleLoginAbort = (): void => rejectForAbort(new BotStartupCancelledError());
      startupSignal.addEventListener('abort', handleLoginAbort, { once: true });
      if (startupSignal.aborted) {
        handleLoginAbort();
      }
      try {
        await Promise.race([loginPromise, abortPromise]);
      } finally {
        startupSignal.removeEventListener('abort', handleLoginAbort);
      }
    } else {
      await loginPromise;
    }
    if (options.signal?.aborted) {
      throw new BotStartupCancelledError();
    }
    return startedRuntime;
  } catch (error: unknown) {
    if (handleStartupAbort) {
      options.signal?.removeEventListener('abort', handleStartupAbort);
    }
    if (runtime) {
      await runtime.stop();
    } else {
      await cloudLease?.stop();
      database.close();
      try {
        processLock.release();
      } catch (releaseError: unknown) {
        safeLogger.error('Could not release process lock after startup failure', releaseError);
      }
    }
    if (options.signal?.aborted) {
      health?.markStopped();
      throw new BotStartupCancelledError();
    } else {
      health?.markFailed();
    }
    throw error;
  }
}
