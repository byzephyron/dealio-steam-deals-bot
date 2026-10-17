import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dealio-reopen-'));
  directories.push(directory);
  return join(directory, 'wishlist.db');
}

it('reopens a current database any number of times without changing it', () => {
  const path = databasePath();
  const first = createDatabase(path);
  new UserConfigRepository(first).upsert('reopen-user', '76561198000000050', 'de', 'DE', '2026-10-01T00:00:00.000Z');
  const schema = first.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
  first.close();

  for (let restart = 0; restart < 3; restart += 1) {
    const database = createDatabase(path);
    try {
      expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
      expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
      expect(new UserConfigRepository(database).findByDiscordUserId('reopen-user')?.language).toBe('de');
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  }
});

it('adds the admin tables to a version 12 database and keeps its users', () => {
  const path = databasePath();
  const database = createDatabase(path);
  new UserConfigRepository(database).upsert('v12-user', '76561198000000051', 'en', 'US', '2026-10-01T00:00:00.000Z');
  for (const table of ['guild_event', 'interaction_event', 'admin_audit', 'runtime_setting', 'user_block',
    'guild_block', 'broadcast_recipient', 'broadcast']) database.exec(`DROP TABLE ${table}`);
  database.exec('PRAGMA user_version = 12');
  database.close();

  const upgraded = createDatabase(path);
  try {
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 });
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'broadcast_recipient'")
      .get()).toEqual({ n: 1 });
    expect(new UserConfigRepository(upgraded).deleteByDiscordUserId('v12-user')).toBe(true);
  } finally {
    upgraded.close();
  }
});
