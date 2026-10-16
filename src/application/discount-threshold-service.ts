import {
  isMinimumDiscountPercent,
  type UserConfig,
} from '../domain/user-config.js';
import { UserConfigRepository } from '../persistence/user-config-repository.js';
import { UserOperationCoordinator } from './user-operation-coordinator.js';
import { assertAccountNotBlocked, type BlockedAccountCheck } from './account-block.js';

export class InvalidDiscountThresholdError extends Error {}

/** The default discount threshold; a game's own threshold is part of its rule (AssistantService). */
export class DiscountThresholdService {
  public constructor(
    private readonly userConfigRepository: UserConfigRepository,
    private readonly coordinator = new UserOperationCoordinator(),
    private readonly now: () => Date = () => new Date(),
    /** Accounts the owner blocked cannot change their discount rules. */
    private readonly isBlocked?: BlockedAccountCheck,
  ) {}

  public setGlobal(
    discordUserId: string,
    percent: number,
    expectedConfigurationId?: string,
  ): Promise<UserConfig | null> {
    this.validatePercent(percent);
    return this.coordinator.runExclusive(discordUserId, () => {
      assertAccountNotBlocked(this.isBlocked, discordUserId);
      return this.userConfigRepository.setMinimumDiscountPercent(
        discordUserId,
        percent,
        this.now().toISOString(),
        expectedConfigurationId,
      );
    });
  }

  private validatePercent(percent: number): void {
    if (!isMinimumDiscountPercent(percent)) {
      throw new InvalidDiscountThresholdError(
        'Minimum discount percent must be an integer between 0 and 100',
      );
    }
  }
}
