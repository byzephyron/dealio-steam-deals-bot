import type { Language, UserConfig } from '../domain/user-config.js';
import type { InitialWishlistSummaryResult } from './initial-wishlist-summary-service.js';
import { InitialWishlistSummaryService } from './initial-wishlist-summary-service.js';
import {
  InvalidUserConfigurationError,
  UserConfigurationService,
  type PreparedUserConfiguration,
} from './user-configuration-service.js';
import { UserOperationCoordinator } from './user-operation-coordinator.js';
import { assertAccountNotBlocked, type BlockedAccountCheck } from './account-block.js';

export interface SetupResult {
  readonly config: UserConfig;
  readonly summary: InitialWishlistSummaryResult;
}

export class SetupAlreadyCompletedError extends Error {
  public readonly name = 'SetupAlreadyCompletedError';

  public constructor() {
    super('Dealio setup has already been completed for this Discord user');
  }
}

/** New sign-ups are closed: Dealio already has as many users as it can carry. */
export class SetupCapacityReachedError extends Error {
  public readonly name = 'SetupCapacityReachedError';

  public constructor() {
    super('Dealio is not accepting new users right now');
  }
}

export type SetupStep = 'prepare-ok' | 'prepare-failed' | 'confirm-ok' | 'confirm-failed';

export interface SetupServiceOptions {
  /** Most users Dealio accepts; existing users are never affected. Unlimited when omitted or null. */
  readonly maxUsers?: number | null | (() => number | null);
  /** The owner can close new sign-ups from the admin panel. Open when omitted. */
  readonly signupsOpen?: () => boolean;
  /** Setup funnel telemetry; a failing sink never affects setup. */
  readonly onStep?: (discordUserId: string, step: SetupStep, code?: string) => void;
  /** Accounts the owner blocked can neither set up nor change their Steam account. */
  readonly isBlocked?: BlockedAccountCheck;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

export interface AccountChangeResult {
  readonly config: UserConfig;
  /** Whether the new wishlist was read right away; otherwise the next scheduled check reads it. */
  readonly wishlistLoaded: boolean;
}

export class SetupService {
  private readonly maxUsers?: number | null | (() => number | null);
  private readonly signupsOpen: () => boolean;
  private readonly onStep: (discordUserId: string, step: SetupStep, code?: string) => void;
  private readonly isBlocked?: BlockedAccountCheck;

  public constructor(
    private readonly userConfigurationService: UserConfigurationService,
    private readonly initialSummaryService: InitialWishlistSummaryService,
    private readonly coordinator: UserOperationCoordinator,
    options: SetupServiceOptions = {},
  ) {
    this.maxUsers = options.maxUsers;
    this.signupsOpen = options.signupsOpen ?? (() => true);
    this.onStep = options.onStep ?? (() => undefined);
    this.isBlocked = options.isBlocked;
  }

  private step(discordUserId: string, step: SetupStep, error?: unknown): void {
    try {
      this.onStep(discordUserId, step, error === undefined ? undefined : errorCode(error));
    } catch {
      // Telemetry only.
    }
  }

  public configure(
    discordUserId: string,
    profileInput: string,
    language: Language,
    storeCountryInput?: string,
  ): Promise<SetupResult> {
    return this.coordinator.runExclusive(discordUserId, async () => {
      assertAccountNotBlocked(this.isBlocked, discordUserId);
      this.assertNotConfigured(discordUserId);
      this.assertCapacity();
      const config = await this.userConfigurationService.configureWithinUserOperation(
        discordUserId,
        profileInput,
        language,
        storeCountryInput,
        {
          resetPricingContext: true,
          // Other users' setups ran during the Steam reads; check the limit again with the save.
          beforeSave: () => {
            this.assertNotConfigured(discordUserId);
            this.assertCapacity();
          },
        },
      );
      const summary = await this.initialSummaryService.sendWithinUserOperation(discordUserId);
      if (summary.status === 'dm-blocked') {
        const blocked = this.userConfigurationService.markDmDeliveryBlocked(discordUserId, summary.errorCode);
        return { config: blocked ?? config, summary };
      }
      return { config, summary };
    });
  }

  public async prepare(
    discordUserId: string,
    profileInput: string,
    language: Language,
    storeCountryInput: string,
  ): Promise<PreparedUserConfiguration> {
    try {
      assertAccountNotBlocked(this.isBlocked, discordUserId);
      this.assertNotConfigured(discordUserId);
      this.assertCapacity();
      const prepared = await this.userConfigurationService.prepare(
        discordUserId,
        profileInput,
        language,
        storeCountryInput,
      );
      this.step(discordUserId, 'prepare-ok');
      return prepared;
    } catch (error: unknown) {
      this.step(discordUserId, 'prepare-failed', error);
      throw error;
    }
  }

  public confirm(prepared: PreparedUserConfiguration): Promise<SetupResult> {
    return this.confirmExclusive(prepared).then((result) => {
      this.step(prepared.discordUserId, 'confirm-ok');
      return result;
    }, (error: unknown) => {
      this.step(prepared.discordUserId, 'confirm-failed', error);
      throw error;
    });
  }

  private confirmExclusive(prepared: PreparedUserConfiguration): Promise<SetupResult> {
    return this.coordinator.runExclusive(prepared.discordUserId, async () => {
      assertAccountNotBlocked(this.isBlocked, prepared.discordUserId);
      this.assertNotConfigured(prepared.discordUserId);
      this.assertCapacity();
      const config = this.userConfigurationService.configurePreparedWithinUserOperation(
        prepared,
        { resetPricingContext: true },
      );
      const summary = await this.initialSummaryService.sendWithinUserOperation(
        prepared.discordUserId,
      );
      if (summary.status === 'dm-blocked') {
        const blocked = this.userConfigurationService.markDmDeliveryBlocked(
          prepared.discordUserId,
          summary.errorCode,
        );
        return { config: blocked ?? config, summary };
      }
      return { config, summary };
    });
  }

  /** Reads a replacement Steam account for a configured user; nothing is saved yet. */
  public prepareAccountChange(
    discordUserId: string,
    profileInput: string,
    language: Language,
    storeCountryInput: string,
  ): Promise<PreparedUserConfiguration> {
    try {
      assertAccountNotBlocked(this.isBlocked, discordUserId);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (!this.hasExistingConfiguration(discordUserId)) {
      return Promise.reject(new InvalidUserConfigurationError('Dealio is not set up for this user'));
    }
    return this.userConfigurationService.prepare(discordUserId, profileInput, language, storeCountryInput);
  }

  /**
   * Switches a configured user to another Steam account. The old account's rules and
   * queued alerts are retired; the new wishlist starts from a baseline, so games that
   * are already discounted do not trigger alerts.
   */
  public changeAccount(prepared: PreparedUserConfiguration): Promise<AccountChangeResult> {
    return this.coordinator.runExclusive(prepared.discordUserId, async () => {
      assertAccountNotBlocked(this.isBlocked, prepared.discordUserId);
      if (!this.hasExistingConfiguration(prepared.discordUserId)) {
        throw new InvalidUserConfigurationError('Dealio is not set up for this user');
      }
      const config = this.userConfigurationService.configurePreparedWithinUserOperation(prepared);
      const baseline = await this.initialSummaryService.baselineWithinUserOperation(prepared.discordUserId);
      return { config: this.userConfigurationService.get(prepared.discordUserId) ?? config, wishlistLoaded: baseline };
    });
  }

  public hasExistingConfiguration(discordUserId: string): boolean {
    return this.userConfigurationService.get(discordUserId) !== null;
  }

  /** False while the user limit is reached, so setup can say so before asking anything. */
  public acceptsNewUsers(): boolean {
    if (!this.signupsOpen()) return false;
    const maxUsers = typeof this.maxUsers === 'function' ? this.maxUsers() : this.maxUsers;
    return maxUsers === undefined || maxUsers === null || this.userConfigurationService.countUsers() < maxUsers;
  }

  private assertCapacity(): void {
    if (!this.acceptsNewUsers()) {
      throw new SetupCapacityReachedError();
    }
  }

  private assertNotConfigured(discordUserId: string): void {
    if (this.hasExistingConfiguration(discordUserId)) {
      throw new SetupAlreadyCompletedError();
    }
  }
}
