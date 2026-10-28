import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync, type Stats } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { safeLogger } from '../application/safe-logger.js';
import { csrfMatches, type AdminSession, type AdminSessions } from './admin-auth.js';
import { InvalidOwnerCredentialsError } from './owner-credentials.js';

export class AdminHttpError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AdminHttpError';
  }
}

export interface AdminRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly session: AdminSession;
}

export interface AdminResponse {
  readonly status?: number;
  readonly json?: unknown;
}

export interface AdminRoute {
  readonly method: 'GET' | 'POST';
  /** `/api/users/:id` style; parameters match one path segment. */
  readonly path: string;
  readonly handler?: (request: AdminRequest) => AdminResponse | Promise<AdminResponse>;
  /** Long-lived responses (server-sent events) write to the response themselves. */
  readonly stream?: (request: AdminRequest, response: ServerResponse) => void;
}

export interface AdminServerOptions {
  readonly port: number;
  readonly sessions: AdminSessions;
  readonly routes: readonly AdminRoute[];
  readonly staticDirectory: string | null;
  readonly logger?: Pick<Console, 'log' | 'error'>;
  /** Wait after a wrong token; tests shorten it. */
  readonly failedLoginDelayMs?: number;
  /** Writes sign-ins and owner account changes to the audit trail. */
  readonly audit?: (action: string, detail: string | null, outcome: 'ok' | 'failed') => void;
}

type SignInMethod = 'password' | 'code' | 'token';

const cookieName = 'dealio_admin';
const maximumBodyBytes = 64 * 1024;
const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};
const compressible = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json']);

/** Same hash as `version` in scripts/build-admin-ui.mjs, which puts it in `?v=`. */
export function assetVersion(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

interface StaticFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly type: string;
  readonly version: string;
  readonly body: Buffer;
  readonly gzip: Buffer | null;
}

/** Whether Accept-Encoding lists gzip without turning it down with `q=0`. */
function acceptsGzip(header: string | undefined): boolean {
  return (header ?? '').split(',').some((part) => {
    const [name = '', ...parameters] = part.trim().toLowerCase().split(';');
    return name.trim() === 'gzip' && !parameters.some((parameter) => /^\s*q=0(\.0*)?\s*$/.test(parameter));
  });
}

function etagMatches(header: string | undefined, etag: string): boolean {
  return (header ?? '').split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

export const adminContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://cdn.discordapp.com https://*.steamstatic.com https://steamcdn-a.akamaihd.net",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', adminContentSecurityPolicy);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(payload);
}

/** The tunnel only reaches 127.0.0.1; any other Host is DNS rebinding or a mistake. */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(hostHeader.trim().toLowerCase());
  return match !== null && localHostnames.has(match[1]!);
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLocalHost(url.host)
      && url.host === request.headers.host?.toLowerCase();
  } catch {
    return false;
  }
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maximumBodyBytes) throw new AdminHttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new AdminHttpError(415, 'JSON body required');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AdminHttpError(400, 'Invalid JSON');
  }
}

interface CompiledRoute {
  readonly route: AdminRoute;
  readonly pattern: RegExp;
  readonly names: readonly string[];
}

function compile(route: AdminRoute): CompiledRoute {
  const names: string[] = [];
  const source = route.path.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      names.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { route, pattern: new RegExp(`^${source}$`), names };
}

export class AdminServer {
  private readonly server: Server;
  private readonly routes: readonly CompiledRoute[];
  private readonly logger: Pick<Console, 'log' | 'error'>;
  private readonly openStreams = new Set<ServerResponse>();
  /** The built UI, read and compressed once per file version. */
  private readonly staticFiles = new Map<string, StaticFile>();

  public constructor(private readonly options: AdminServerOptions) {
    this.routes = options.routes.map(compile);
    this.logger = options.logger ?? safeLogger;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.logger.error('Admin panel request failed', error);
        if (!response.headersSent) sendJson(response, 500, { error: 'Internal error' });
        else response.end();
      });
    });
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 30_000;
    // Through the SSH tunnel a new connection costs extra round trips; keep idle ones
    // open across the pages' 30-second refreshes.
    this.server.keepAliveTimeout = 65_000;
  }

  public start(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      this.server.once('error', reject);
      // Loopback only: the panel is reached through an SSH tunnel, never the internet.
      this.server.listen(this.options.port, '127.0.0.1', () => {
        this.server.off('error', reject);
        const address = this.server.address();
        resolvePort(typeof address === 'object' && address ? address.port : this.options.port);
      });
    });
  }

  public stop(): Promise<void> {
    for (const stream of this.openStreams) stream.end();
    this.openStreams.clear();
    return new Promise((resolveStop) => {
      if (!this.server.listening) {
        resolveStop();
        return;
      }
      this.server.close(() => resolveStop());
      this.server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response);
    if (!isLocalHost(request.headers.host)) {
      sendJson(response, 421, { error: 'Unknown host' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }
      this.serveStatic(url, request, response);
      return;
    }

    if (method === 'POST' && !originAllowed(request)) {
      sendJson(response, 403, { error: 'Cross-origin request rejected' });
      return;
    }

    if (url.pathname === '/api/session' && method === 'GET') {
      const session = this.options.sessions.get(readCookie(request, cookieName));
      sendJson(response, 200, session ? { authenticated: true, csrf: session.csrf } : { authenticated: false });
      return;
    }
    if (url.pathname === '/api/login-options' && method === 'GET') {
      sendJson(response, 200, { password: this.options.sessions.passwordLoginEnabled() });
      return;
    }
    if (url.pathname === '/api/login' && method === 'POST') {
      await this.login(request, response);
      return;
    }
    if (url.pathname === '/api/login-code' && method === 'POST') {
      await this.loginCode(request, response);
      return;
    }

    const session = this.options.sessions.get(readCookie(request, cookieName));
    if (!session) {
      sendJson(response, 401, { error: 'Sign in required' });
      return;
    }
    if (method === 'POST') {
      const header = request.headers['x-csrf-token'];
      if (!csrfMatches(session.csrf, typeof header === 'string' ? header : undefined)) {
        sendJson(response, 403, { error: 'Invalid CSRF token' });
        return;
      }
    }
    if (url.pathname === '/api/logout' && method === 'POST') {
      this.options.sessions.logout(session.id);
      this.record('account.sign-out', null, 'ok');
      response.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/account' && method === 'GET') {
      sendJson(response, 200, { username: this.options.sessions.ownerUsername() });
      return;
    }
    if (url.pathname === '/api/account/credentials' && method === 'POST') {
      await this.setOwnerCredentials(request, response, session);
      return;
    }
    if (url.pathname === '/api/account/credentials/clear' && method === 'POST') {
      this.options.sessions.clearOwnerCredentials(session.id);
      this.logger.log(`${new Date().toISOString()} [admin] Owner removed the admin panel password.`);
      this.record('account.credentials-clear', null, 'ok');
      sendJson(response, 200, { result: { username: null } });
      return;
    }

    for (const compiled of this.routes) {
      if (compiled.route.method !== method) continue;
      const match = compiled.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      try {
        compiled.names.forEach((name, index) => {
          params[name] = decodeURIComponent(match[index + 1]!);
        });
      } catch {
        sendJson(response, 400, { error: 'Bad path' });
        return;
      }
      try {
        const adminRequest: AdminRequest = {
          method,
          path: url.pathname,
          query: url.searchParams,
          params,
          body: method === 'POST' ? await readBody(request) : null,
          session,
        };
        if (compiled.route.stream) {
          this.openStreams.add(response);
          response.on('close', () => this.openStreams.delete(response));
          compiled.route.stream(adminRequest, response);
          return;
        }
        const result = await compiled.route.handler!(adminRequest);
        sendJson(response, result.status ?? 200, result.json ?? { ok: true });
      } catch (error: unknown) {
        if (error instanceof AdminHttpError) {
          sendJson(response, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  private async readCredentials(request: IncomingMessage, response: ServerResponse)
    : Promise<{ readonly token?: string; readonly code?: string; readonly username?: string; readonly password?: string } | null> {
    try {
      const body = await readBody(request);
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
      return {
        ...(typeof record.token === 'string' ? { token: record.token } : {}),
        ...(typeof record.code === 'string' ? { code: record.code } : {}),
        ...(typeof record.username === 'string' ? { username: record.username } : {}),
        ...(typeof record.password === 'string' ? { password: record.password } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof AdminHttpError) {
        sendJson(response, error.status, { error: error.message });
        return null;
      }
      throw error;
    }
  }

  /** Trades the token for a one-minute, single-use code that `#login=<code>` redeems. */
  private async loginCode(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const credentials = await this.readCredentials(request, response);
    if (!credentials) return;
    const result = this.options.sessions.issueLoginCode(credentials.token ?? '');
    if (result.status === 'locked') {
      sendJson(response, 429, { error: 'Too many attempts', retryAfterMs: result.retryAfterMs });
      return;
    }
    if (result.status === 'invalid') {
      await this.rejectSignIn(response, 'token');
      return;
    }
    sendJson(response, 200, { code: result.code });
  }

  /** The record never stops a sign-in: a failed write is only logged. */
  private record(action: string, detail: string | null, outcome: 'ok' | 'failed'): void {
    try {
      this.options.audit?.(action, detail, outcome);
    } catch (error: unknown) {
      this.logger.error(`${new Date().toISOString()} [admin] Could not write ${action} to the audit trail.`, error);
    }
  }

  /** Only the method is recorded, never the entered username, token or password. */
  private async rejectSignIn(response: ServerResponse, method: SignInMethod): Promise<void> {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, this.options.failedLoginDelayMs ?? 750));
    this.logger.log(`${new Date().toISOString()} [admin] Rejected an admin panel sign-in.`);
    this.record('account.sign-in', method, 'failed');
    sendJson(response, 401, { error: 'Invalid token' });
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const credentials = await this.readCredentials(request, response);
    if (!credentials) return;
    const signInMethod: SignInMethod = credentials.username !== undefined && credentials.password !== undefined
      ? 'password'
      : credentials.code !== undefined && credentials.token === undefined ? 'code' : 'token';
    const result = signInMethod === 'password'
      ? await this.options.sessions.loginWithPassword(credentials.username!, credentials.password!)
      : signInMethod === 'code'
        ? this.options.sessions.redeemLoginCode(credentials.code!)
        : this.options.sessions.login(credentials.token ?? '');
    // Locked attempts are refused unchecked and not recorded; the failures that set the lock are.
    if (result.status === 'locked') {
      sendJson(response, 429, { error: 'Too many attempts', retryAfterMs: result.retryAfterMs });
      return;
    }
    if (result.status === 'invalid') {
      await this.rejectSignIn(response, signInMethod);
      return;
    }
    response.setHeader('Set-Cookie',
      `${cookieName}=${result.session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
    this.logger.log(`${new Date().toISOString()} [admin] Owner signed in to the admin panel.`);
    this.record('account.sign-in', signInMethod, 'ok');
    sendJson(response, 200, { authenticated: true, csrf: result.session.csrf });
  }

  private async setOwnerCredentials(request: IncomingMessage, response: ServerResponse, session: AdminSession): Promise<void> {
    const credentials = await this.readCredentials(request, response);
    if (!credentials) return;
    try {
      await this.options.sessions.setOwnerCredentials(
        credentials.username?.trim() ?? '', credentials.password ?? '', session.id);
    } catch (error: unknown) {
      if (error instanceof InvalidOwnerCredentialsError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    this.logger.log(`${new Date().toISOString()} [admin] Owner set the admin panel username and password.`);
    this.record('account.credentials', this.options.sessions.ownerUsername(), 'ok');
    sendJson(response, 200, { result: { username: this.options.sessions.ownerUsername() } });
  }

  private serveStatic(url: URL, request: IncomingMessage, response: ServerResponse): void {
    const root = this.options.staticDirectory;
    if (!root) {
      sendJson(response, 404, { error: 'Admin UI is not built' });
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      sendJson(response, 400, { error: 'Bad path' });
      return;
    }
    const base = resolve(root);
    const candidate = resolve(join(base, normalize(decoded)));
    if (candidate !== base && !candidate.startsWith(base + sep)) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    // Unknown paths without an extension are client-side routes of the single page.
    const file = fileStats(candidate)?.isFile() ? candidate : extname(decoded) === '' ? join(base, 'index.html') : null;
    const stats = file ? fileStats(file) : null;
    if (!file || !stats?.isFile()) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const asset = this.staticFile(file, stats);
    const etag = `"${asset.version}"`;
    // index.html names every asset with `?v=<hash>` (scripts/build-admin-ui.mjs), so
    // such a URL never changes content; anything else is checked on each load.
    response.setHeader('Cache-Control', url.searchParams.get('v') === asset.version
      ? 'private, max-age=31536000, immutable' : 'no-cache');
    response.setHeader('ETag', etag);
    response.setHeader('Content-Type', asset.type);
    if (asset.gzip) response.setHeader('Vary', 'Accept-Encoding');
    if (etagMatches(request.headers['if-none-match'], etag)) {
      response.statusCode = 304;
      response.end();
      return;
    }
    const gzip = asset.gzip && acceptsGzip(request.headers['accept-encoding']) ? asset.gzip : null;
    const body = gzip ?? asset.body;
    if (gzip) response.setHeader('Content-Encoding', 'gzip');
    response.statusCode = 200;
    response.setHeader('Content-Length', body.length);
    response.end(body);
  }

  private staticFile(file: string, stats: Stats): StaticFile {
    const cached = this.staticFiles.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;
    const body = readFileSync(file);
    const compress = compressible.has(extname(file)) && body.length > 1024;
    const asset: StaticFile = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      type: contentTypes[extname(file)] ?? 'application/octet-stream',
      version: assetVersion(body),
      body,
      // gzip takes milliseconds; brotli would hold the bot's event loop far longer for a few kilobytes.
      gzip: compress ? gzipSync(body, { level: 9 }) : null,
    };
    this.staticFiles.set(file, asset);
    return asset;
  }
}

function fileStats(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function existingDirectory(...candidates: readonly string[]): string | null {
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}
