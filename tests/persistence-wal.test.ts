import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dealio-wal-'));
  directories.push(directory);
  return join(directory, 'wishlist.db');
}

const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0];

it('opens a file database in WAL mode with full fsync durability', () => {
  const database = createDatabase(databasePath());
  try {
    expect(pragma(database, 'journal_mode')).toBe('wal');
    expect(pragma(database, 'synchronous')).toBe(2); // FULL
  } finally {
    database.close();
  }
});

it('keeps an in-memory database usable (WAL does not apply there)', () => {
  const database = createDatabase(':memory:');
  try {
    expect(pragma(database, 'journal_mode')).toBe('memory');
  } finally {
    database.close();
  }
});

it('lets the bot write while another connection (health ping, backup) is reading', () => {
  const path = databasePath();
  const database = createDatabase(path);
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM user_config').get();
    const startedAt = Date.now();
    database.prepare("UPDATE wishlist_poll_schedule SET next_scheduled_at = '2026-11-01T00:00:00.000Z'").run();
    expect(Date.now() - startedAt).toBeLessThan(500);
    reader.exec('COMMIT');
  } finally {
    reader.close();
    database.close();
  }
});

it('empties the WAL after /delete-data so no earlier copy of the user rows stays in it', () => {
  const path = databasePath();
  const database = createDatabase(path);
  try {
    const users = new UserConfigRepository(database);
    users.upsert('100000000000000001', '76561190000000001', 'en', 'US', new Date().toISOString());
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(users.deleteByDiscordUserId('100000000000000001')).toBe(true);
    expect(statSync(`${path}-wal`).size).toBe(0);
    expect(database.prepare('SELECT count(*) AS c FROM user_config').get()).toEqual({ c: 0 });
  } finally {
    database.close();
  }
});
