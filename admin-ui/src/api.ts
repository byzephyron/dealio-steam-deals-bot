/** JSON calls to the bot's admin API. The session cookie is HttpOnly; POSTs carry the CSRF token. */

export class ApiError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;
let onSignedOut: () => void = () => undefined;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function whenSignedOut(callback: () => void): void {
  onSignedOut = callback;
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') onSignedOut();
    throw new ApiError(response.status, payload?.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body ?? {}),
};

/** What boot.js asked for before app.js ran; each answer is used once. */
interface BootRequests {
  session?: Promise<unknown>;
  page?: { readonly path: string; readonly data: Promise<unknown> };
}

function bootRequests(): BootRequests | undefined {
  return (window as { dealioBoot?: BootRequests }).dealioBoot;
}

export function bootSession<T>(): Promise<T> | undefined {
  const requests = bootRequests();
  const session = requests?.session;
  if (requests) delete requests.session;
  return session as Promise<T> | undefined;
}

/** GETs `path`, taking boot.js's answer when it already asked for this path. */
export function getFirst<T>(path: string): Promise<T> {
  const requests = bootRequests();
  const early = requests?.page?.path === path ? requests.page.data as Promise<T> : undefined;
  if (early && requests) delete requests.page;
  return early?.catch(() => api.get<T>(path)) ?? api.get<T>(path);
}

/**
 * The last answer per GET path, for this browser tab only: a page opened again shows
 * it at once while it reloads, instead of an empty page for a round trip.
 */
const responses = new Map<string, { readonly data: unknown; readonly at: number }>();
const maximumResponses = 40;

export function rememberedResponse<T>(path: string): { readonly data: T; readonly at: number } | undefined {
  return responses.get(path) as { readonly data: T; readonly at: number } | undefined;
}

export function rememberResponse(path: string, data: unknown): void {
  responses.delete(path);
  responses.set(path, { data, at: Date.now() });
  if (responses.size > maximumResponses) responses.delete(responses.keys().next().value!);
}

export function forgetResponses(): void {
  responses.clear();
}
