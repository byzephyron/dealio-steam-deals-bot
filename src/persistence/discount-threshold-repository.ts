import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { UserConfig } from '../domain/user-config.js';

type ThresholdScope = Pick<UserConfig, 'discordUserId' | 'configVersion' | 'minimumDiscountPercent'>;

function percentageValue(value: SQLOutputValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error('Invalid minimum_discount_percent value in game discount threshold');
  }
  return value;
}

/**
 * Reads a game's own discount threshold. It is written only together with the game's
 * rule (AssistantRepository.saveRule), so the panel and the alert rule cannot drift apart.
 */
export class DiscountThresholdRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public findGameOverride(scope: ThresholdScope, appId: number): number | null {
    const row = this.database.prepare(
      `SELECT minimum_discount_percent
       FROM game_discount_threshold
       WHERE discord_user_id = ? AND config_version = ? AND app_id = ?`,
    ).get(scope.discordUserId, scope.configVersion, appId) as
      | { minimum_discount_percent: SQLOutputValue }
      | undefined;
    return row ? percentageValue(row.minimum_discount_percent) : null;
  }

  public findGameOverrides(
    scope: ThresholdScope,
    appIds: readonly number[],
  ): ReadonlyMap<number, number> {
    const uniqueAppIds = [...new Set(appIds)];
    if (uniqueAppIds.length === 0) {
      return new Map();
    }
    const rows = this.database.prepare(
      `SELECT app_id, minimum_discount_percent
       FROM game_discount_threshold
       WHERE discord_user_id = ? AND config_version = ?
         AND app_id IN (${uniqueAppIds.map(() => '?').join(', ')})`,
    ).all(scope.discordUserId, scope.configVersion, ...uniqueAppIds) as unknown as Array<{
      app_id: SQLOutputValue;
      minimum_discount_percent: SQLOutputValue;
    }>;
    return new Map(rows.map((row) => {
      if (typeof row.app_id !== 'number' || !Number.isSafeInteger(row.app_id) || row.app_id <= 0) {
        throw new Error('Invalid app_id value in game discount threshold');
      }
      return [row.app_id, percentageValue(row.minimum_discount_percent)];
    }));
  }

  public countGameOverrides(scope: ThresholdScope): number {
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM (SELECT app_id FROM game_discount_threshold WHERE discord_user_id=? AND config_version=?
         UNION SELECT app_id FROM game_rule WHERE discord_user_id=? AND config_version=? AND (mode!='inherit' OR muted=1))`,
    ).get(scope.discordUserId, scope.configVersion, scope.discordUserId, scope.configVersion) as { count: SQLOutputValue };
    if (typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error('Invalid game discount threshold count');
    }
    return row.count;
  }
}
