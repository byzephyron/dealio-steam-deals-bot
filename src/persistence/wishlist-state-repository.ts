import type { DeliveryReceipt } from '../domain/wishlist-state.js';
import { AssistantRepository } from './assistant-repository.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Language } from '../domain/user-config.js';
import type {
  DurableNotificationBatch,
  NotificationCandidate,
  WishlistItemState,
  WishlistObservation,
  WishlistObservationStatus,
} from '../domain/wishlist-state.js';
import { NotificationBatchRepository } from './notification-batch-repository.js';
import { NotificationQueueRepository } from './notification-queue-repository.js';
import type { WishlistScope } from './wishlist-state-codecs.js';
import {
  WishlistObservationRepository,
  type ObservationResult,
  type RecordObservationOptions,
} from './wishlist-observation-repository.js';

export type { ObservationResult } from './wishlist-observation-repository.js';

export class WishlistStateRepository {
  private readonly batchRepository: NotificationBatchRepository;
  private readonly observationRepository: WishlistObservationRepository;
  private readonly queueRepository: NotificationQueueRepository;

  public readonly assistant: AssistantRepository;

  public constructor(database: DatabaseSync) {
    this.assistant = new AssistantRepository(database);
    this.batchRepository = new NotificationBatchRepository(database);
    this.observationRepository = new WishlistObservationRepository(database);
    this.queueRepository = new NotificationQueueRepository(database);
  }

  public runInImmediateTransaction<T>(operation: () => T): T {
    return this.observationRepository.runInImmediateTransaction(operation);
  }

  public findByDiscordUserAndAppId(
    discordUserId: string,
    appId: number,
    configVersion?: number,
  ): WishlistItemState | null {
    return this.observationRepository.findByDiscordUserAndAppId(
      discordUserId,
      appId,
      configVersion,
    );
  }

  public countNotificationCandidates(discordUserId: string, configVersion?: number): number {
    return this.observationRepository.countNotificationCandidates(discordUserId, configVersion);
  }

  public hasPendingNotifications(discordUserId: string, configVersion: number, dueAt?: string): boolean {
    return this.queueRepository.hasPendingNotifications(discordUserId, configVersion, dueAt);
  }

  public hasDeliveredNotification(discordUserId: string): boolean {
    return this.queueRepository.hasDeliveredNotification(discordUserId);
  }

  public markMissingItemsInactive(
    scope: WishlistScope,
    seenAppIds: readonly number[],
    observedAt: string,
  ): number {
    return this.observationRepository.markMissingItemsInactive(scope, seenAppIds, observedAt);
  }

  public markObservationStatus(
    scope: WishlistScope,
    appIds: readonly number[],
    status: Exclude<WishlistObservationStatus, 'known' | 'missing'>,
    observedAt: string,
  ): number {
    return this.observationRepository.markObservationStatus(scope, appIds, status, observedAt);
  }

  public recoverStaleSending(scope: WishlistScope, staleBefore: string): number {
    return this.queueRepository.recoverStaleSending(scope, staleBefore);
  }

  public expireInactiveNotifications(scope: WishlistScope): number {
    return this.queueRepository.expireInactiveNotifications(scope);
  }

  public findRetryableNotificationCandidates(
    scope: WishlistScope,
    now: string,
  ): NotificationCandidate[] {
    return this.queueRepository.findRetryableNotificationCandidates(scope, now);
  }

  public findRetryableNotificationBatches(
    scope: WishlistScope,
    now: string,
  ): DurableNotificationBatch[] {
    return this.batchRepository.findRetryableNotificationBatches(scope, now);
  }

  public createAndClaimNotificationBatch(
    scope: WishlistScope,
    language: Language,
    notifications: readonly [NotificationCandidate, ...NotificationCandidate[]],
    attemptedAt: string,
  ): DurableNotificationBatch | null {
    return this.batchRepository.createAndClaimNotificationBatch(
      scope,
      language,
      notifications,
      attemptedAt,
    );
  }

  public claimNotificationBatch(batch: DurableNotificationBatch, attemptedAt: string): boolean {
    return this.batchRepository.claimNotificationBatch(batch, attemptedAt);
  }

  public markNotificationBatchSent(batch: DurableNotificationBatch, receipt?: DeliveryReceipt): void {
    this.batchRepository.markNotificationBatchSent(batch, receipt);
  }

  public markNotificationBatchFailed(
    batch: DurableNotificationBatch,
    errorMessage: string,
    nextAttemptAt: string | null,
    terminal: boolean,
  ): void {
    this.batchRepository.markNotificationBatchFailed(
      batch,
      errorMessage,
      nextAttemptAt,
      terminal,
    );
  }

  public deferNotificationBatch(
    batch: DurableNotificationBatch,
    errorMessage: string,
    nextAttemptAt: string,
  ): void {
    this.batchRepository.deferNotificationBatch(batch, errorMessage, nextAttemptAt);
  }

  public markNotificationTerminal(
    candidate: NotificationCandidate,
    errorMessage: string,
  ): void {
    this.queueRepository.markNotificationTerminal(candidate, errorMessage);
  }

  public markNotificationBatchTerminal(
    batch: DurableNotificationBatch,
    errorMessage: string,
  ): void {
    this.batchRepository.markNotificationBatchTerminal(batch, errorMessage);
  }

  public findNotificationStatus(
    candidate: Pick<
      NotificationCandidate,
      'discordUserId' | 'steamId64' | 'configVersion' | 'appId' | 'saleEpisodeId'
    >,
  ): string | null {
    return this.queueRepository.findNotificationStatus(candidate);
  }

  public recordObservation(
    scope: WishlistScope,
    observation: WishlistObservation,
    options: RecordObservationOptions = {},
  ): ObservationResult {
    return this.observationRepository.recordObservation(scope, observation, options);
  }
}
