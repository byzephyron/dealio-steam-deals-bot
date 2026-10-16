import type { DatabaseSync } from 'node:sqlite';
import type { UserConfig } from '../../src/domain/user-config.js';
import { AssistantRepository } from '../../src/persistence/assistant-repository.js';

/** Gives one game its own discount threshold, the way the panel saves it: as the game's rule. */
export function saveGameThreshold(
  database: DatabaseSync,
  scope: Pick<UserConfig, 'discordUserId' | 'configVersion' | 'storeCountryCode'>,
  appId: number,
  percent: number,
  at: string,
): void {
  new AssistantRepository(database).saveRule(scope, appId,
    { mode: 'percent', percent, targetMinor: null, currency: null, muted: false }, at);
}
