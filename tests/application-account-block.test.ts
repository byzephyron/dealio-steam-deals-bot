import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountBlockedError } from '../src/application/account-block.js';
import { AssistantService } from '../src/application/assistant-service.js';
import { CheckService } from '../src/application/check-service.js';
import { DiscountThresholdService } from '../src/application/discount-threshold-service.js';
import { InitialWishlistSummaryService } from '../src/application/initial-wishlist-summary-service.js';
import { SetupService } from '../src/application/setup-service.js';
import { UserConfigurationService } from '../src/application/user-configuration-service.js';
import { UserOperationCoordinator } from '../src/application/user-operation-coordinator.js';
import { AdminControlRepository } from '../src/persistence/admin-control-repository.js';
import { CheckStateRepository } from '../src/persistence/check-state-repository.js';
import { createDatabase } from '../src/persistence/database.js';
import { DeletionJournal } from '../src/persistence/deletion-journal.js';
import { TelemetryRepository } from '../src/persistence/telemetry-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';

const steamId = '76561198000000000';

function fixture(journalPath?: string) {
  const database = createDatabase(':memory:');
  const users = new UserConfigRepository(database);
  const states = new WishlistStateRepository(database);
  const controls = new AdminControlRepository(database);
  const coordinator = new UserOperationCoordinator();
  const isBlocked = (discordUserId: string): boolean => controls.isUserBlocked(discordUserId);
  const configuration = new UserConfigurationService(users, { resolve: async (value: string) => value },
    { validateWishlistAccess: vi.fn().mockResolvedValue(undefined) }, coordinator, undefined,
    journalPath ? new DeletionJournal(journalPath) : undefined);
  const check = new CheckService(users, new CheckStateRepository(database), states,
    { getWishlistWithErrors: vi.fn().mockResolvedValue({ items: [], errors: [] }) }, coordinator, { cooldownMs: 0 });
  const setup = new SetupService(configuration,
    new InitialWishlistSummaryService(check, { sendInitialSummary: vi.fn().mockResolvedValue(undefined) }),
    coordinator, { isBlocked });
  const sendTest = vi.fn().mockResolvedValue(undefined);
  const assistant = new AssistantService(states.assistant, users, coordinator, sendTest, undefined, undefined, isBlocked);
  const thresholds = new DiscountThresholdService(users, coordinator, undefined, isBlocked);
  const block = (discordUserId: string): void => controls.blockUser(discordUserId, null, new Date().toISOString());
  return { database, users, states, configuration, setup, assistant, thresholds, sendTest, block };
}

describe('owner block enforced by the services', () => {
  it('refuses setup to a blocked account through every setup entry point', async () => {
    const f = fixture();
    try {
      // Prepared before the block, confirmed after it.
      const prepared = await f.setup.prepare('blocked-user', steamId, 'en', 'US');
      f.block('blocked-user');
      await expect(f.setup.confirm(prepared)).rejects.toBeInstanceOf(AccountBlockedError);
      await expect(f.setup.prepare('blocked-user', steamId, 'en', 'US')).rejects.toBeInstanceOf(AccountBlockedError);
      await expect(f.setup.configure('blocked-user', steamId, 'en', 'US')).rejects.toBeInstanceOf(AccountBlockedError);
      expect(f.users.findByDiscordUserId('blocked-user')).toBeNull();

      // Other accounts are unaffected.
      await expect(f.setup.configure('other-user', steamId, 'en', 'US')).resolves.toMatchObject({
        config: { discordUserId: 'other-user' },
      });
    } finally { f.database.close(); }
  });

  it('refuses account changes, rules, alert timing, test alerts and thresholds once blocked', async () => {
    const f = fixture();
    try {
      await f.setup.configure('u', steamId, 'en', 'US');
      const config = f.users.findByDiscordUserId('u')!;
      f.states.assistant.saveSnapshot(config, {
        items: [{ appId: 1, name: 'Game', priority: 1, dateAdded: null, onSale: false, price: null }], errors: [],
      }, new Date().toISOString());
      const prepared = await f.setup.prepareAccountChange('u', '76561198000000001', 'en', 'US');
      f.block('u');

      await expect(f.setup.prepareAccountChange('u', '76561198000000001', 'en', 'US'))
        .rejects.toBeInstanceOf(AccountBlockedError);
      await expect(f.setup.changeAccount(prepared)).rejects.toBeInstanceOf(AccountBlockedError);
      const rule = { mode: 'percent' as const, percent: 50, targetMinor: null, currency: null, muted: false };
      await expect(f.assistant.rule('u', config.configurationId, 1, rule, config.configVersion))
        .rejects.toBeInstanceOf(AccountBlockedError);
      await expect(f.assistant.preference('u', config.configurationId,
        { mode: 'instant', timezone: null, quietStart: null, quietEnd: null, digestMinute: null }, config.configVersion))
        .rejects.toBeInstanceOf(AccountBlockedError);
      await expect(f.assistant.retryDm('u', config.configurationId, config.configVersion))
        .rejects.toBeInstanceOf(AccountBlockedError);
      await expect(f.thresholds.setGlobal('u', 40)).rejects.toBeInstanceOf(AccountBlockedError);

      expect(f.sendTest).not.toHaveBeenCalled();
      expect(f.states.assistant.rule(config, 1)).toBeFalsy();
      expect(f.users.findByDiscordUserId('u')).toMatchObject({ steamId64: steamId });

      // /delete-data keeps working for a blocked account.
      await expect(f.configuration.deleteData('u')).resolves.toBe(true);
      expect(f.users.findByDiscordUserId('u')).toBeNull();
    } finally { f.database.close(); }
  });
});

describe('/delete-data without a setup', () => {
  it('records the deletion so a restored backup cannot bring the usage records back', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dealio-delete-'));
    const journalPath = join(directory, 'deletions.jsonl');
    const f = fixture(journalPath);
    try {
      const telemetry = new TelemetryRepository(f.database);
      const event = {
        discordUserId: 'visitor', guildId: null, context: 'unknown', install: 'unknown', kind: 'command',
        action: 'dealio', locale: null, occurredAt: '2026-10-01T00:00:00.000Z',
      } as Parameters<TelemetryRepository['recordInteraction']>[0];
      telemetry.recordInteraction(event);

      // No setup: the result stays "nothing configured", but the usage records are gone...
      await expect(f.configuration.deleteData('visitor')).resolves.toBe(false);
      const count = () => Number((f.database.prepare(
        "SELECT COUNT(*) AS n FROM interaction_event WHERE discord_user_id = 'visitor'").get() as { n: number }).n);
      expect(count()).toBe(0);
      expect(new DeletionJournal(journalPath).count()).toBe(1);

      // ...and stay gone when an older backup containing them is restored.
      telemetry.recordInteraction(event);
      new DeletionJournal(journalPath).reconcile(f.database);
      expect(count()).toBe(0);
    } finally {
      f.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
