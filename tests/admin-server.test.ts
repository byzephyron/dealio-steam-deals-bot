import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminSessions } from '../src/admin/admin-auth.js';
import { AdminServer, assetVersion, isLocalHost } from '../src/admin/admin-server.js';

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

async function signIn(port: number): Promise<{ cookie: string; csrf: string }> {
  const reply = await call(port, '/api/login', { method: 'POST', body: { token } });
  expect(reply.status).toBe(200);
  const cookie = String(reply.headers['set-cookie']).split(';')[0]!;
  return { cookie, csrf: (JSON.parse(reply.body) as { csrf: string }).csrf };
}

describe('admin server', () => {
  let server: AdminServer;
  let port: number;
  let staticDirectory: string;
  const mutations: unknown[] = [];

  beforeEach(async () => {
    staticDirectory = mkdtempSync(join(tmpdir(), 'dealio-admin-ui-'));
    writeFileSync(join(staticDirectory, 'index.html'), '<!doctype html><title>admin</title>');
    writeFileSync(join(staticDirectory, 'app.js'), 'export {};');
    server = new AdminServer({
      port: 0,
      sessions: new AdminSessions(token),
      staticDirectory,
      failedLoginDelayMs: 1,
      logger: { log: () => undefined, error: () => undefined },
      routes: [
        { method: 'GET', path: '/api/things/:id', handler: ({ params }) => ({ json: { id: params.id } }) },
        { method: 'POST', path: '/api/things', handler: ({ body }) => { mutations.push(body); return { json: { ok: true } }; } },
      ],
    });
    port = await server.start();
    mutations.length = 0;
  });

  afterEach(async () => {
    await server.stop();
    rmSync(staticDirectory, { recursive: true, force: true });
  });

  it('accepts only loopback host names, whatever the tunnel port is', () => {
    expect(isLocalHost('localhost:8787')).toBe(true);
    expect(isLocalHost('127.0.0.1:9999')).toBe(true);
    expect(isLocalHost('[::1]:8787')).toBe(true);
    expect(isLocalHost('dealio.example.com')).toBe(false);
    expect(isLocalHost('localhost.evil.com:8787')).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });

  it('rejects a foreign Host header (DNS rebinding) before anything else', async () => {
    const reply = await call(port, '/api/session', { headers: { Host: 'evil.example:80' } });
    expect(reply.status).toBe(421);
  });

  it('requires a session for API routes and sends security headers', async () => {
    const reply = await call(port, '/api/things/1');
    expect(reply.status).toBe(401);
    expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(reply.headers['x-frame-options']).toBe('DENY');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });

  it('signs in with the token and sets an HttpOnly, SameSite=Strict cookie', async () => {
    const reply = await call(port, '/api/login', { method: 'POST', body: { token } });
    expect(reply.status).toBe(200);
    expect(String(reply.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    const { cookie } = await signIn(port);
    const session = await call(port, '/api/session', { headers: { Cookie: cookie } });
    expect(JSON.parse(session.body)).toMatchObject({ authenticated: true });
    const thing = await call(port, '/api/things/42', { headers: { Cookie: cookie } });
    expect(JSON.parse(thing.body)).toEqual({ id: '42' });
  });

  it('rejects a wrong token and locks sign-in after repeated failures', async () => {
    const wrong = await call(port, '/api/login', { method: 'POST', body: { token: 'nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await call(port, '/api/login', { method: 'POST', body: { token: 'nope' } });
    }
    const locked = await call(port, '/api/login', { method: 'POST', body: { token } });
    expect(locked.status).toBe(429);
  });

  it('requires the CSRF token and a same-origin Origin for changes', async () => {
    const { cookie, csrf } = await signIn(port);
    const missing = await call(port, '/api/things', { method: 'POST', body: { a: 1 }, headers: { Cookie: cookie } });
    expect(missing.status).toBe(403);
    const crossOrigin = await call(port, '/api/things', {
      method: 'POST', body: { a: 1 },
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
    const ok = await call(port, '/api/things', {
      method: 'POST', body: { a: 1 },
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: `http://localhost:${port}` },
    });
    expect(ok.status).toBe(200);
    expect(mutations).toEqual([{ a: 1 }]);
  });

  it('signs in through a single-use login code so the token never travels in a URL', async () => {
    const wrong = await call(port, '/api/login-code', { method: 'POST', body: { token: 'nope' } });
    expect(wrong.status).toBe(401);
    const issued = await call(port, '/api/login-code', { method: 'POST', body: { token } });
    expect(issued.status).toBe(200);
    expect(issued.headers['set-cookie']).toBeUndefined();
    const { code } = JSON.parse(issued.body) as { code: string };
    expect(code).toMatch(/^[\w-]{43}$/);
    expect(code).not.toContain(token);

    const redeemed = await call(port, '/api/login', { method: 'POST', body: { code } });
    expect(redeemed.status).toBe(200);
    expect(String(redeemed.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    const again = await call(port, '/api/login', { method: 'POST', body: { code } });
    expect(again.status).toBe(401);
    expect(again.headers['set-cookie']).toBeUndefined();
    // A code is not a token, and the token is not a code.
    expect((await call(port, '/api/login', { method: 'POST', body: { token: code } })).status).toBe(401);
    expect((await call(port, '/api/login', { method: 'POST', body: { code: token } })).status).toBe(401);
    // Cross-site pages cannot mint codes either.
    const crossSite = await call(port, '/api/login-code', {
      method: 'POST', body: { token }, headers: { Origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('answers a malformed path parameter with 400, not an internal error', async () => {
    const errors: unknown[] = [];
    const strict = new AdminServer({
      port: 0, sessions: new AdminSessions(token), staticDirectory: null, failedLoginDelayMs: 1,
      logger: { log: () => undefined, error: (...values: unknown[]) => { errors.push(values); } },
      routes: [{ method: 'GET', path: '/api/things/:id', handler: ({ params }) => ({ json: { id: params.id } }) }],
    });
    const strictPort = await strict.start();
    try {
      const { cookie } = await signIn(strictPort);
      const reply = await call(strictPort, '/api/things/%E0%A4%A', { headers: { Cookie: cookie } });
      expect(reply.status).toBe(400);
      expect(errors).toEqual([]);
    } finally { await strict.stop(); }
  });

  it('signs out', async () => {
    const { cookie, csrf } = await signIn(port);
    await call(port, '/api/logout', { method: 'POST', body: {}, headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
    expect((await call(port, '/api/things/1', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('serves the UI, falls back to index.html for routes and never leaves its directory', async () => {
    expect((await call(port, '/app.js')).headers['content-type']).toContain('text/javascript');
    expect((await call(port, '/users')).body).toContain('<title>admin</title>');
    expect((await call(port, '/../package.json')).status).toBe(404);
    expect((await call(port, '/..%2f..%2fpackage.json')).status).toBe(404);
    expect((await call(port, '/missing.js')).status).toBe(404);
    expect((await call(port, '/', { method: 'POST' })).status).toBe(405);
  });

  it('compresses the UI, caches versioned URLs for good and revalidates the rest', async () => {
    const script = `export const text = ${JSON.stringify('Dealio '.repeat(400))};`;
    writeFileSync(join(staticDirectory, 'app.js'), script);
    const version = assetVersion(Buffer.from(script));

    const plain = await call(port, '/app.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(script);
    expect(plain.headers['cache-control']).toBe('no-cache');
    expect(plain.headers.etag).toBe(`"${version}"`);

    const compressed = await call(port, `/app.js?v=${version}`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(compressed.headers.vary).toBe('Accept-Encoding');
    expect(compressed.headers['cache-control']).toContain('immutable');
    expect(Number(compressed.headers['content-length'])).toBeLessThan(script.length / 10);
    expect((await call(port, '/app.js', { headers: { 'Accept-Encoding': 'br, gzip;q=0' } })).headers['content-encoding']).toBeUndefined();
    // A stale version is served as it is now, but not cached for good.
    expect((await call(port, '/app.js?v=000000000000')).headers['cache-control']).toBe('no-cache');

    const revalidated = await call(port, '/app.js', { headers: { 'If-None-Match': `"${version}"` } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body).toBe('');

    // A rebuilt file is read again.
    writeFileSync(join(staticDirectory, 'app.js'), 'export const changed = true;');
    const rebuilt = await call(port, '/app.js', { headers: { 'If-None-Match': `"${version}"` } });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body).toBe('export const changed = true;');
  });
});

describe('admin sessions', () => {
  it('expire after twelve hours', () => {
    let now = 0;
    const sessions = new AdminSessions(token, () => now);
    const result = sessions.login(token);
    expect(result.status).toBe('ok');
    const id = result.status === 'ok' ? result.session.id : '';
    expect(sessions.get(id)).not.toBeNull();
    now = 12 * 3600_000;
    expect(sessions.get(id)).toBeNull();
  });

  it('issue login codes only for the token, valid once and for one minute', () => {
    let now = 0;
    const sessions = new AdminSessions(token, () => now);
    expect(sessions.issueLoginCode('wrong').status).toBe('invalid');
    const first = sessions.issueLoginCode(token);
    const second = sessions.issueLoginCode(token);
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected codes');
    expect(sessions.redeemLoginCode(first.code).status).toBe('ok');
    expect(sessions.redeemLoginCode(first.code).status).toBe('invalid');
    now = 60_000;
    expect(sessions.redeemLoginCode(second.code).status).toBe('invalid');
    expect(sessions.redeemLoginCode('').status).toBe('invalid');
  });

  it('count wrong tokens for codes toward the same lockout', () => {
    const sessions = new AdminSessions(token, () => 0);
    for (let attempt = 0; attempt < 10; attempt += 1) sessions.issueLoginCode('wrong');
    expect(sessions.issueLoginCode(token).status).toBe('locked');
    expect(sessions.login(token).status).toBe('locked');
  });
});
