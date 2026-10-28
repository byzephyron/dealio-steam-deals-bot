import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminSessions } from '../src/admin/admin-auth.js';
import { AdminServer } from '../src/admin/admin-server.js';
import {
  hashOwnerPassword, InvalidOwnerCredentialsError, settingOwnerCredentialStore, validateOwnerCredentials,
  verifyOwnerPassword, type OwnerCredentialStore,
} from '../src/admin/owner-credentials.js';

const token = 'test-admin-token-0123456789abcdefghij';

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function call(port: number, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown;
} = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: {
        Host: `localhost:${port}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        ...options.headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function memoryStore(): OwnerCredentialStore & { raw(): string | null } {
  const settings = new Map<string, string>();
  const store = settingOwnerCredentialStore({
    setting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => { if (value === null) settings.delete(key); else settings.set(key, value); },
  });
  return { ...store, raw: () => settings.get('admin.ownerCredentials') ?? null };
}

async function signIn(port: number, body: unknown): Promise<{ status: number; cookie: string; csrf: string }> {
  const reply = await call(port, '/api/login', { method: 'POST', body });
  return reply.status === 200
    ? { status: 200, cookie: String(reply.headers['set-cookie']).split(';')[0]!, csrf: (JSON.parse(reply.body) as { csrf: string }).csrf }
    : { status: reply.status, cookie: '', csrf: '' };
}

describe('owner password hashing', () => {
  it('stores a salted scrypt hash, never the password', async () => {
    const first = await hashOwnerPassword('correct horse battery');
    const second = await hashOwnerPassword('correct horse battery');
    expect(first).toMatch(/^scrypt:16384:8:1:[\w-]+:[\w-]+$/);
    expect(first).not.toContain('correct');
    expect(first).not.toBe(second);
    await expect(verifyOwnerPassword('correct horse battery', first)).resolves.toBe(true);
    await expect(verifyOwnerPassword('correct horse batterz', first)).resolves.toBe(false);
  });

  it('rejects malformed or oversized stored hashes instead of throwing', async () => {
    await expect(verifyOwnerPassword('x', 'plain-text')).resolves.toBe(false);
    await expect(verifyOwnerPassword('x', 'scrypt:1048576:8:1:c2FsdA:aGFzaA')).resolves.toBe(false);
  });

  it('requires a sensible username and a password of at least ten characters', () => {
    expect(() => validateOwnerCredentials('bilgehan', 'short')).toThrow(InvalidOwnerCredentialsError);
    expect(() => validateOwnerCredentials('a', 'long enough password')).toThrow(InvalidOwnerCredentialsError);
    expect(() => validateOwnerCredentials('has space', 'long enough password')).toThrow(InvalidOwnerCredentialsError);
    expect(() => validateOwnerCredentials('bilgehan', 'long enough password')).not.toThrow();
  });
});

describe('admin panel sign-in with the owner password', () => {
  let server: AdminServer;
  let port: number;
  let store: ReturnType<typeof memoryStore>;
  let audit: Array<[string, string | null, string]>;

  beforeEach(async () => {
    store = memoryStore();
    audit = [];
    server = new AdminServer({
      port: 0,
      sessions: new AdminSessions(token, Date.now, store),
      staticDirectory: null,
      failedLoginDelayMs: 1,
      logger: { log: () => undefined, error: () => undefined },
      routes: [],
      audit: (action, detail, outcome) => { audit.push([action, detail, outcome]); },
    });
    port = await server.start();
  });

  afterEach(async () => { await server.stop(); });

  it('offers password sign-in only after the owner sets one', async () => {
    expect(JSON.parse((await call(port, '/api/login-options')).body)).toEqual({ password: false });
    expect((await signIn(port, { username: 'bilgehan', password: 'anything-at-all' })).status).toBe(401);

    const owner = await signIn(port, { token });
    const saved = await call(port, '/api/account/credentials', {
      method: 'POST',
      headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
      body: { username: 'bilgehan', password: 'a long owner password' },
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toEqual({ result: { username: 'bilgehan' } });
    expect(store.raw()).toContain('scrypt:');
    expect(store.raw()).not.toContain('a long owner password');

    expect(JSON.parse((await call(port, '/api/login-options')).body)).toEqual({ password: true });
    expect((await signIn(port, { username: 'bilgehan', password: 'a long owner password' })).status).toBe(200);
    expect((await signIn(port, { username: 'bilgehan', password: 'a wrong owner password' })).status).toBe(401);
    expect((await signIn(port, { username: 'someone', password: 'a long owner password' })).status).toBe(401);
    // The environment token still works, e.g. for the tunnel script or a forgotten password.
    expect((await signIn(port, { token })).status).toBe(200);
  });

  it('needs a signed-in session and the CSRF token to set credentials', async () => {
    const anonymous = await call(port, '/api/account/credentials', {
      method: 'POST', body: { username: 'attacker', password: 'attacker password' },
    });
    expect(anonymous.status).toBe(401);
    const owner = await signIn(port, { token });
    const withoutCsrf = await call(port, '/api/account/credentials', {
      method: 'POST', headers: { Cookie: owner.cookie }, body: { username: 'attacker', password: 'attacker password' },
    });
    expect(withoutCsrf.status).toBe(403);
    expect(store.read()).toBeNull();
  });

  it('rejects weak credentials with a readable message', async () => {
    const owner = await signIn(port, { token });
    const reply = await call(port, '/api/account/credentials', {
      method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
      body: { username: 'bilgehan', password: 'short' },
    });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).error).toContain('10');
    expect(store.read()).toBeNull();
  });

  it('signs out every other session when the credentials change, and can remove them', async () => {
    const other = await signIn(port, { token });
    const owner = await signIn(port, { token });
    await call(port, '/api/account/credentials', {
      method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
      body: { username: 'bilgehan', password: 'a long owner password' },
    });
    expect((await call(port, '/api/account', { headers: { Cookie: other.cookie } })).status).toBe(401);
    expect(JSON.parse((await call(port, '/api/account', { headers: { Cookie: owner.cookie } })).body))
      .toEqual({ username: 'bilgehan' });

    const cleared = await call(port, '/api/account/credentials/clear', {
      method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf }, body: {},
    });
    expect(cleared.status).toBe(200);
    expect(store.read()).toBeNull();
    expect((await signIn(port, { username: 'bilgehan', password: 'a long owner password' })).status).toBe(401);
  });

  it('writes sign-ins and credential changes to the audit trail without the secrets', async () => {
    expect((await signIn(port, { token: 'wrong-token' })).status).toBe(401);
    const owner = await signIn(port, { token });
    const headers = { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf };
    await call(port, '/api/account/credentials', {
      method: 'POST', headers, body: { username: 'bilgehan', password: 'a long owner password' },
    });
    expect((await signIn(port, { username: 'bilgehan', password: 'a wrong owner password' })).status).toBe(401);
    expect((await signIn(port, { username: 'bilgehan', password: 'a long owner password' })).status).toBe(200);
    await call(port, '/api/account/credentials/clear', { method: 'POST', headers, body: {} });
    await call(port, '/api/logout', { method: 'POST', headers, body: {} });

    expect(audit).toEqual([
      ['account.sign-in', 'token', 'failed'],
      ['account.sign-in', 'token', 'ok'],
      ['account.credentials', 'bilgehan', 'ok'],
      ['account.sign-in', 'password', 'failed'],
      ['account.sign-in', 'password', 'ok'],
      ['account.credentials-clear', null, 'ok'],
      ['account.sign-out', null, 'ok'],
    ]);
    expect(JSON.stringify(audit)).not.toContain('owner password');
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('still signs the owner in when the audit write fails', async () => {
    await server.stop();
    server = new AdminServer({
      port: 0,
      sessions: new AdminSessions(token, Date.now, store),
      staticDirectory: null,
      failedLoginDelayMs: 1,
      logger: { log: () => undefined, error: () => undefined },
      routes: [],
      audit: () => { throw new Error('disk full'); },
    });
    port = await server.start();
    expect((await signIn(port, { token })).status).toBe(200);
  });

  it('counts wrong passwords toward the shared lockout', async () => {
    const owner = await signIn(port, { token });
    await call(port, '/api/account/credentials', {
      method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
      body: { username: 'bilgehan', password: 'a long owner password' },
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await signIn(port, { username: 'bilgehan', password: `wrong password ${attempt}` })).status).toBe(401);
    }
    expect((await signIn(port, { username: 'bilgehan', password: 'a long owner password' })).status).toBe(429);
    expect((await signIn(port, { token })).status).toBe(429);
  });
});
