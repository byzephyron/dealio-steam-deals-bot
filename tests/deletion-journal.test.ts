import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UserConfigurationService } from '../src/application/user-configuration-service.js';
import { createDatabase } from '../src/persistence/database.js';
import { DeletionJournal, hashDiscordUserId } from '../src/persistence/deletion-journal.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';

const directories: string[] = [];
function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dealio-deletions-'));
  directories.push(directory);
  return join(directory, 'deletions.jsonl');
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('re-applies /delete-data to a restored database, but keeps a later new setup', async () => {
  const path = journalPath();
  const database = createDatabase(':memory:');
  const repository = new UserConfigRepository(database);
  repository.upsert('deleted-user', '76561198000000000', 'en', 'US', '2026-09-01T00:00:00.000Z');
  repository.upsert('returning-user', '76561198000000001', 'en', 'US', '2026-09-01T00:00:00.000Z');
  repository.upsert('kept-user', '76561198000000002', 'en', 'US', '2026-09-01T00:00:00.000Z');
  // Both delete their data; the backup taken before still holds them.
  const backup = database.prepare('SELECT * FROM user_config').all();
  const service = new UserConfigurationService(repository, { resolve: vi.fn() }, { validateWishlistAccess: vi.fn() },
    undefined, () => new Date('2026-09-10T00:00:00.000Z'), new DeletionJournal(path));
  await service.deleteData('deleted-user');
  await service.deleteData('returning-user');
  expect(readFileSync(path, 'utf8')).not.toContain('deleted-user');
  expect(readFileSync(path, 'utf8')).toContain(hashDiscordUserId('deleted-user'));

  // "Restore" the old rows, and let one user set Dealio up again after deleting.
  const insert = database.prepare(`INSERT INTO user_config (discord_user_id, configuration_id, steam_id64, language,
    store_country_code, enabled, dm_opt_in_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  for (const row of backup as Array<Record<string, string>>) {
    if (row.discord_user_id === 'kept-user') continue;
    const createdAt = row.discord_user_id === 'returning-user' ? '2026-09-11T00:00:00.000Z' : row.created_at;
    insert.run(row.discord_user_id, row.configuration_id, row.steam_id64, row.language, row.store_country_code,
      createdAt, createdAt, createdAt);
  }

  const journal = new DeletionJournal(path, () => new Date('2026-09-12T00:00:00.000Z'));
  expect(journal.reconcile(database)).toBe(1);
  expect(repository.findByDiscordUserId('deleted-user')).toBeNull();
  expect(repository.findByDiscordUserId('returning-user')).not.toBeNull();
  expect(repository.findByDiscordUserId('kept-user')).not.toBeNull();
  database.close();
});

it('forgets deletions older than the backup retention and skips damaged lines', () => {
  const path = journalPath();
  writeFileSync(path, [
    JSON.stringify({ user: hashDiscordUserId('old'), deletedAt: '2026-01-01T00:00:00.000Z' }),
    'not json',
    JSON.stringify({ user: hashDiscordUserId('recent'), deletedAt: '2026-09-10T00:00:00.000Z' }),
  ].join('\n') + '\n');
  const database = createDatabase(':memory:');
  new DeletionJournal(path, () => new Date('2026-09-12T00:00:00.000Z')).reconcile(database);
  const kept = readFileSync(path, 'utf8').trim().split('\n');
  expect(kept).toHaveLength(1);
  expect(kept[0]).toContain(hashDiscordUserId('recent'));
  database.close();
});

it('keeps the 35-day promise while the bot runs: counts and cleans up without a restart', () => {
  const path = journalPath();
  let now = new Date('2026-09-12T00:00:00.000Z');
  const journal = new DeletionJournal(path, () => now);
  journal.record('first', '2026-09-01T00:00:00.000Z');
  journal.record('second', '2026-09-10T00:00:00.000Z');
  expect(journal.count()).toBe(2);
  expect(journal.cleanup()).toBe(0);

  // 35 days after the first deletion, the hourly retention job must drop it.
  now = new Date('2026-10-07T00:00:00.000Z');
  expect(journal.count()).toBe(1);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(journal.cleanup()).toBe(1);
  const kept = readFileSync(path, 'utf8').trim().split('\n');
  expect(kept).toHaveLength(1);
  expect(kept[0]).toContain(hashDiscordUserId('second'));
  expect(new DeletionJournal(journalPath()).cleanup()).toBe(0);
});
