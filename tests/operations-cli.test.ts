import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createDatabase } from '../src/persistence/database.js';
import { openBackup } from '../src/operations/backup-envelope.js';

// Build before this integration test: operational commands use the exact dist
// deployed to production, without opening a Discord connection.
it('exports an open SQLite database encrypted and rehearses recovery without changing the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dealio-ops-cli-'));
  const source = join(directory, 'source.db');
  const keyPath = join(directory, 'public.pem');
  const artifact = join(directory, 'snapshot.encrypted.json');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
  const db = createDatabase(source);
  try {
    await writeFile(keyPath, keys.publicKey);
    db.prepare('CREATE TABLE recovery_probe (value TEXT)').run();
    db.prepare('INSERT INTO recovery_probe VALUES (?)').run('private-recovery-probe');
    const encrypted = execFileSync(process.execPath, [resolve('scripts/export-backup.mjs')], {
      cwd: directory, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, DATABASE_PATH: source, DEALIO_BACKUP_PUBLIC_KEY_FILE: keyPath },
    });
    expect(encrypted).not.toContain('private-recovery-probe');
    const restored = join(directory, 'copy.db');
    await writeFile(restored, openBackup(encrypted, keys.privateKey));
    const copy = createDatabase(restored);
    try { expect(copy.prepare('SELECT value FROM recovery_probe').get()?.value).toBe('private-recovery-probe'); }
    finally { copy.close(); }
    await writeFile(artifact, encrypted);
    const evidence = execFileSync(process.execPath, [resolve('scripts/restore-encrypted-backup.mjs'), artifact], {
      cwd: directory, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, DEALIO_BACKUP_PRIVATE_KEY: keys.privateKey },
    });
    expect(JSON.parse(evidence)).toMatchObject({ ok: true, schemaVersion: 17 });
    expect(db.prepare('SELECT value FROM recovery_probe').get()?.value).toBe('private-recovery-probe');
    expect(await readFile(artifact, 'utf8')).toBe(encrypted);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
  // RSA key generation and two child processes can exceed the default 5s on a cold start.
}, 40_000);
