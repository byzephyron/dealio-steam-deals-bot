import { isLanguage, isSteamId64, type DmUnreachableCode, type Language, type UserConfig } from '../domain/user-config.js';
import type { SteamProfileSummary } from '../domain/steam-identity.js';
import {
  resolveStoreCountry,
  type StoreCountryCode,
} from '../domain/store-country.js';
import { UserConfigRepository } from '../persistence/user-config-repository.js';
import { UserOperationCoordinator } from './user-operation-coordinator.js';
import type { DeletionJournal } from '../persistence/deletion-journal.js';
import { safeLogger } from './safe-logger.js';

export class InvalidUserConfigurationError extends Error {
  public constructor(
    message: string,
    public readonly code: 'INVALID_CONFIGURATION' | 'INVALID_STORE_COUNTRY' = 'INVALID_CONFIGURATION',
  ) {
    super(message);
  }
}

export interface WishlistAccessValidator {
  validateWishlistAccess(steamId64: string): Promise<void>;
}

export interface SteamIdentityReader {
  resolve(profileInput: string): Promise<string>;
  /** Optional, presentation only: the persona name and avatar shown before confirming. */
  summary?(steamId64: string): Promise<SteamProfileSummary | null>;
}

export interface ConfigureUserOptions {
  readonly resetPricingContext?: boolean;
  /** Runs synchronously just before saving, after the Steam reads; throwing aborts the save. */
  readonly beforeSave?: () => void;
}

export interface PreparedUserConfiguration {
  readonly discordUserId: string;
  readonly steamId64: string;
  readonly language: Language;
  readonly storeCountryCode: StoreCountryCode;
  /** How the profile looks on Steam, when Steam told us; never stored. */
  readonly profile?: SteamProfileSummary;
}

export class UserConfigurationService {
  public constructor(
    private readonly repository: UserConfigRepository,
    private readonly identityResolver: SteamIdentityReader,
    private readonly wishlistAccessValidator: WishlistAccessValidator,
    private readonly coordinator = new UserOperationCoordinator(),
    private readonly now: () => Date = () => new Date(),
    private readonly deletionJournal?: Pick<DeletionJournal, 'record'>,
  ) {}

  public configure(
    discordUserId: string,
    profileInput: string,
    language: Language,
    storeCountryInput?: string,
    options: ConfigureUserOptions = {},
  ): Promise<UserConfig> {
    if (!isLanguage(language)) {
      throw new InvalidUserConfigurationError('Language must be tr, en, de or fr');
    }
    if (storeCountryInput !== undefined && !resolveStoreCountry(storeCountryInput)) {
      throw new InvalidUserConfigurationError(
        'Store country must be a supported country code',
        'INVALID_STORE_COUNTRY',
      );
    }
    return this.coordinator.runExclusive(discordUserId, () =>
      this.configureWithinUserOperation(
        discordUserId,
        profileInput,
        language,
        storeCountryInput,
        options,
      ),
    );
  }

  public configureWithinUserOperation(
    discordUserId: string,
    profileInput: string,
    language: Language,
    storeCountryInput?: string,
    options: ConfigureUserOptions = {},
  ): Promise<UserConfig> {
    if (!isLanguage(language)) {
      throw new InvalidUserConfigurationError('Language must be tr, en, de or fr');
    }
    const requestedStoreCountry = storeCountryInput === undefined
      ? undefined
      : resolveStoreCountry(storeCountryInput);
    if (storeCountryInput !== undefined && !requestedStoreCountry) {
      throw new InvalidUserConfigurationError(
        'Store country must be a supported country code',
        'INVALID_STORE_COUNTRY',
      );
    }

    return (async () => {
      const existingStoreCountry = this.repository
        .findByDiscordUserId(discordUserId)?.storeCountryCode;
      const storeCountryCode = requestedStoreCountry ?? existingStoreCountry;
      if (!storeCountryCode) {
        throw new InvalidUserConfigurationError(
          'Store country is required for a new configuration',
          'INVALID_STORE_COUNTRY',
        );
      }
      const steamId64 = await this.identityResolver.resolve(profileInput);
      if (!isSteamId64(steamId64)) {
        throw new InvalidUserConfigurationError('Resolved SteamID64 is invalid');
      }
      await this.wishlistAccessValidator.validateWishlistAccess(steamId64);
      options.beforeSave?.();
      return this.repository.upsert(
        discordUserId,
        steamId64,
        language,
        storeCountryCode,
        this.now().toISOString(),
        { forcePricingReset: options.resetPricingContext },
      );
    })();
  }

  public async prepare(
    discordUserId: string,
    profileInput: string,
    language: Language,
    storeCountryInput: string,
  ): Promise<PreparedUserConfiguration> {
    if (!isLanguage(language)) {
      throw new InvalidUserConfigurationError('Language must be tr, en, de or fr');
    }
    const storeCountryCode = resolveStoreCountry(storeCountryInput);
    if (!storeCountryCode) {
      throw new InvalidUserConfigurationError(
        'Store country must be a supported country code or exact country name',
        'INVALID_STORE_COUNTRY',
      );
    }
    const steamId64 = await this.identityResolver.resolve(profileInput);
    if (!isSteamId64(steamId64)) {
      throw new InvalidUserConfigurationError('Resolved SteamID64 is invalid');
    }
    // The profile summary is read beside the wishlist check, so it adds no wait; its failure is ignored.
    const [, profile] = await Promise.all([
      this.wishlistAccessValidator.validateWishlistAccess(steamId64),
      this.identityResolver.summary?.(steamId64).catch(() => null) ?? Promise.resolve(null),
    ]);
    return { discordUserId, steamId64, language, storeCountryCode, ...(profile ? { profile } : {}) };
  }

  public configurePreparedWithinUserOperation(
    prepared: PreparedUserConfiguration,
    options: ConfigureUserOptions = {},
  ): UserConfig {
    return this.repository.upsert(
      prepared.discordUserId,
      prepared.steamId64,
      prepared.language,
      prepared.storeCountryCode,
      this.now().toISOString(),
      { forcePricingReset: options.resetPricingContext },
    );
  }

  public countUsers(): number {
    return this.repository.countUsers();
  }

  public get(discordUserId: string): UserConfig | null {
    return this.repository.findByDiscordUserId(discordUserId);
  }

  public setEnabled(discordUserId: string, enabled: boolean): Promise<UserConfig | null> {
    return this.coordinator.runExclusive(discordUserId, () =>
      this.repository.setEnabled(discordUserId, enabled, this.now().toISOString()),
    );
  }

  public setStoreCountry(
    discordUserId: string,
    storeCountryInput: string,
  ): Promise<UserConfig | null> {
    const storeCountryCode = resolveStoreCountry(storeCountryInput);
    if (!storeCountryCode) {
      throw new InvalidUserConfigurationError(
        'Store country must be a supported country code',
        'INVALID_STORE_COUNTRY',
      );
    }

    return this.coordinator.runExclusive(discordUserId, () =>
      this.repository.setStoreCountryCode(
        discordUserId,
        storeCountryCode,
        this.now().toISOString(),
      ),
    );
  }

  public setLanguage(discordUserId: string, language: Language): Promise<UserConfig | null> {
    if (!isLanguage(language)) {
      throw new InvalidUserConfigurationError('Language must be tr, en, de or fr');
    }
    return this.coordinator.runExclusive(discordUserId, () =>
      this.repository.setLanguage(discordUserId, language, this.now().toISOString()),
    );
  }

  public markDmDeliveryBlocked(
    discordUserId: string,
    errorCode: DmUnreachableCode = 'DISCORD_DM_BLOCKED',
  ): UserConfig | null {
    return this.repository.markDmDeliveryBlocked(
      discordUserId,
      errorCode,
      this.now().toISOString(),
    );
  }

  public deleteData(discordUserId: string): Promise<boolean> {
    return this.coordinator.runExclusive(discordUserId, () => {
      const deleted = this.repository.deleteByDiscordUserId(discordUserId);
      // Usage records are deleted even without a setup (the /delete-data command
      // itself is one), so the restore protection is recorded for every deletion.
      if (this.deletionJournal) {
        try {
          this.deletionJournal.record(discordUserId, this.now().toISOString());
        } catch (error: unknown) {
          // The deletion itself succeeded; only its protection against an old restore is missing.
          safeLogger.error('Could not record the data deletion in the deletion journal', error);
        }
      }
      return deleted;
    });
  }
}
