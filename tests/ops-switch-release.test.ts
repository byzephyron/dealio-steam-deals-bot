import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/persistence/database.js';

// Runs deploy/switch-release.sh against a fake home directory. git, sudo and
// systemctl are stubs; sha256sum, tar, diff and node are real. The stubbed
// `systemctl start` plays the new build: healthy, or crashing (optionally after
// migrating the schema or writing a row).

function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  // Never WSL's System32\bash.exe: Git for Windows' MSYS bash runs the script here.
  const candidate = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
  return existsSync(candidate) ? candidate : null;
}

const bash = findBash();
const sha = 'abc1234';
const tree = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const slash = (path: string): string => path.replace(/\\/g, '/');

const stubs: Record<string, string> = {
  sudo: 'exec "$@"\n',
  git: `echo "git $*" >> "$STUB_LOG"
if [ "$1" = -C ]; then shift 2; fi
case "$1" in
  rev-parse) if [ "$2" = HEAD ]; then echo "$STUB_PREV"; else echo "$STUB_TREE"; fi ;;
  diff) exit "\${STUB_LOCK_CHANGED:-0}" ;;
  log) echo "$STUB_PREV current" ;;
esac
exit 0
`,
  systemctl: `echo "systemctl $*" >> "$STUB_LOG"
if [ "$1" = start ]; then
  starts=$(cat "$STUB_LOG.starts" 2>/dev/null || echo 0); echo $((starts + 1)) > "$STUB_LOG.starts"
  [ "$starts" = 0 ] || exit 0
  case "$STUB_BOT" in
    healthy) node -e 'const fs = require("node:fs"); fs.mkdirSync(".runtime", { recursive: true });
fs.writeFileSync(".runtime/bot.health.json", JSON.stringify({ startedAt: new Date().toISOString(), phase: "ready", discordReady: true }));' ;;
    migrate) node -e 'new (require("node:sqlite").DatabaseSync)("data/wishlist.db").exec("PRAGMA user_version = 99")' 2>/dev/null ;;
    write) node -e 'new (require("node:sqlite").DatabaseSync)("data/wishlist.db").exec("CREATE TABLE written_by_new_build (x)")' 2>/dev/null ;;
  esac
fi
exit 0
`,
};

interface Run { status: number | null; output: string; log: string }

describe.skipIf(bash === null)('deploy/switch-release.sh', () => {
  let home: string;
  let app: string;
  let candidate: string;
  let stubDirectory: string;
  let log: string;
  let originalVersion: number;

  function packArchive(content: string): string {
    const build = join(home, 'build');
    mkdirSync(join(build, 'dist'), { recursive: true });
    writeFileSync(join(build, 'dist', 'index.js'), content);
    const result = spawnSync(bash!, ['-c', `export PATH="/usr/bin:/bin:$PATH"; tar -czf "dist-${sha}.tar.gz" dist`], {
      cwd: build, encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
    const archive = readFileSync(join(build, `dist-${sha}.tar.gz`));
    writeFileSync(join(candidate, `dist-${sha}.tar.gz`), archive);
    return createHash('sha256').update(archive).digest('hex');
  }

  function writeManifest(archiveSha256: string): void {
    writeFileSync(join(candidate, `manifest-${sha}.json`),
      JSON.stringify({ sourceCommit: sha, sourceTree: tree, distArchiveSha256: archiveSha256 }, null, 2));
  }

  function run(argument: string, env: Record<string, string> = {}): Run {
    const script = resolve('deploy/switch-release.sh');
    // Git for Windows' bash started directly has no /usr/bin on PATH, so cygpath must be
    // found there first; otherwise "C:/…" stays in PATH, splits at the colon, and the
    // real git runs instead of the stub.
    const result = spawnSync(bash!, ['-c', `
      export PATH="/usr/bin:/bin:$PATH"
      if command -v cygpath >/dev/null; then HOME=$(cygpath -u "$HOME"); STUBS=$(cygpath -u "$STUBS"); NODE_DIR=$(cygpath -u "$NODE_DIR"); fi
      export HOME PATH="$STUBS:$NODE_DIR:/usr/bin:/bin:$PATH"
      exec bash "$0" "$1"`, slash(script), argument], {
      encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env, HOME: slash(home), STUBS: slash(stubDirectory), NODE_DIR: slash(dirname(process.execPath)),
        STUB_LOG: slash(log), STUB_TREE: tree, STUB_PREV: previous, STUB_BOT: 'healthy',
        DEALIO_SWITCH_HEALTH_TIMEOUT: '4', ...env,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  }

  const liveDist = (): string => readFileSync(join(app, 'dist', 'index.js'), 'utf8');
  const userVersion = (): number => {
    const db = new DatabaseSync(join(app, 'data', 'wishlist.db'), { readOnly: true });
    try { return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version); }
    finally { db.close(); }
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dealio-switch-'));
    app = join(home, 'steam-wishlist-discord-bot');
    candidate = join(home, `dealio-candidate-${sha}`);
    stubDirectory = join(home, 'stubs');
    log = join(home, 'calls.log');
    for (const directory of [join(app, 'data'), join(app, 'dist'), candidate, stubDirectory]) mkdirSync(directory, { recursive: true });
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(stubDirectory, name), `#!/usr/bin/env bash\n${body}`);
      chmodSync(join(stubDirectory, name), 0o755);
    }
    writeFileSync(join(app, 'dist', 'index.js'), 'old build');
    createDatabase(join(app, 'data', 'wishlist.db')).close();
    originalVersion = userVersion();
    // A stale hand extraction must never be what goes live.
    mkdirSync(join(candidate, 'extracted', 'dist'), { recursive: true });
    writeFileSync(join(candidate, 'extracted', 'dist', 'index.js'), 'tampered build');
    writeManifest(packArchive('new build'));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('deploys a fresh extraction of the checksummed archive once the new build reports ready', () => {
    const result = run(sha);
    expect(result.status, result.output).toBe(0);
    expect(liveDist()).toBe('new build');
    expect(result.log).toContain('git merge -q --ff-only origin/main');
    expect(result.log).not.toContain('reset');
    const backups = join(home, 'dealio-backups');
    const [backup] = readdirSync(backups);
    expect(readFileSync(join(backups, backup!, 'dist', 'index.js'), 'utf8')).toBe('old build');
    expect(existsSync(join(backups, backup!, 'wishlist.db'))).toBe(true);
  }, 60_000);

  it('deletes database copies of releases older than seven days only after a successful switch', () => {
    const backups = join(home, 'dealio-backups');
    const day = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
    const folders = { old: `${day(30)}-1111111`, recent: `${day(2)}-2222222`, unrelated: 'manual-copy' };
    for (const folder of Object.values(folders)) {
      mkdirSync(join(backups, folder, 'dist'), { recursive: true });
      for (const file of ['wishlist.db', 'wishlist.db-wal', 'restore-test.db', join('dist', 'index.js')]) {
        writeFileSync(join(backups, folder, file), 'copy');
      }
    }

    expect(run(sha, { STUB_BOT: 'migrate' }).status).not.toBe(0);
    expect(existsSync(join(backups, folders.old, 'wishlist.db'))).toBe(true);

    rmSync(`${log}.starts`, { force: true });
    const result = run(sha);
    expect(result.status, result.output).toBe(0);
    for (const file of ['wishlist.db', 'wishlist.db-wal', 'restore-test.db']) {
      expect(existsSync(join(backups, folders.old, file)), file).toBe(false);
    }
    expect(readFileSync(join(backups, folders.old, 'dist', 'index.js'), 'utf8')).toBe('copy');
    expect(existsSync(join(backups, folders.recent, 'wishlist.db'))).toBe(true);
    expect(existsSync(join(backups, folders.unrelated, 'wishlist.db'))).toBe(true);
    // The failed attempt and the rerun keep separate folders; neither nests a dist.
    const releases = readdirSync(backups).filter((name) => name.includes(`-${sha}`));
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(existsSync(join(backups, release, 'wishlist.db'))).toBe(true);
      expect(readFileSync(join(backups, release, 'dist', 'index.js'), 'utf8')).toBe('old build');
      expect(existsSync(join(backups, release, 'dist', 'dist'))).toBe(false);
    }
  }, 60_000);

  it('changes nothing when the archive does not match the manifest or the argument is not a sha', () => {
    writeManifest('0'.repeat(64));
    const mismatch = run(sha);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.output).toContain('archive checksum mismatch');
    expect(mismatch.log).not.toContain('systemctl');
    expect(liveDist()).toBe('old build');

    const traversal = run('../../etc');
    expect(traversal.status).not.toBe(0);
    expect(traversal.output).toContain('not a commit sha');
  }, 60_000);

  it('refuses a dependency change until production dependencies are declared ready', () => {
    const refused = run(sha, { STUB_LOCK_CHANGED: '1' });
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain('package-lock.json changes');
    expect(refused.log).not.toContain('systemctl');
    rmSync(`${log}`, { force: true });
    expect(run(sha, { STUB_LOCK_CHANGED: '1', DEALIO_DEPENDENCIES_READY: '1' }).status).toBe(0);
    expect(liveDist()).toBe('new build');
  }, 60_000);

  it('rolls back code, dist and a migrated database when the new build never becomes ready', () => {
    const result = run(sha, { STUB_BOT: 'migrate' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('did not report ready');
    expect(liveDist()).toBe('old build');
    expect(result.log).toContain(`git -C`);
    expect(result.log).toContain(`reset -q --hard ${previous}`);
    expect(userVersion()).toBe(originalVersion);
    expect(result.log.match(/systemctl start dealio/g)).toHaveLength(2);
  }, 60_000);

  it('keeps the live database on rollback when the schema version did not move', () => {
    const result = run(sha, { STUB_BOT: 'write' });
    expect(result.status).not.toBe(0);
    expect(liveDist()).toBe('old build');
    const db = new DatabaseSync(join(app, 'data', 'wishlist.db'), { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'written_by_new_build'").get()).toBeDefined();
    } finally { db.close(); }
  }, 60_000);
});
