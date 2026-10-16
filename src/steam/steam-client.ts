import {
  SteamWishlistError,
  type SteamWishlistResult,
  type WishlistItem,
} from '../domain/steam.js';
import { isLanguage, type Language } from '../domain/user-config.js';
import { nextSteamPriceChange } from '../domain/steam-price-schedule.js';

/** Steam Store's own name for each language, so reviews and release notes come back in it. */
const steamLanguage: Readonly<Record<Language, string>> = {
  tr: 'turkish',
  en: 'english',
  de: 'german',
  fr: 'french',
};
import {
  parseStoreCountryCode,
  type StoreCountryCode,
} from '../domain/store-country.js';
import {
  parsePriceOverviewResponse,
  parseStoreItemsResponse,
  parseWishlistResponse,
  type ParsedPriceEntry,
  type ParsedStoreItem,
} from './wishlist-parser.js';
import {
  globalSteamRequestLimiter,
  type SteamRequestLimiter,
} from './request-limiter.js';

export type SteamFetch = (
  input: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<Response>;

export interface SteamClientOptions {
  readonly fetchImpl?: SteamFetch;
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly requestLimiter?: Pick<SteamRequestLimiter, 'run' | 'deferFor'>;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly lifecycleSignal?: AbortSignal;
  readonly cacheTtlMs?: number;
  readonly metadataCacheTtlMs?: number;
  readonly now?: () => number;
}

/** Apps per batched Steam request; appdetails rejects 200 IDs, GetItems URLs fail near 300. */
export const steamBatchSize = 100;

const wishlistEndpoint = 'https://api.steampowered.com/IWishlistService/GetWishlist/v1/';
const appDetailsEndpoint = 'https://store.steampowered.com/api/appdetails';
const storeItemsEndpoint = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
const defaultMetadataCacheTtlMs = 6 * 60 * 60 * 1000;
const maxCacheEntries = 20_000;
const defaultTimeoutMs = 10_000;
const defaultMaxConcurrency = 3;
const defaultMaxRetries = 2;
const defaultRetryBaseDelayMs = 1_000;
const defaultMaxRetryDelayMs = 60_000;

function defaultFetch(input: string, init?: { readonly signal?: AbortSignal }): Promise<Response> {
  return globalThis.fetch(input, init);
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (
    Number.isSafeInteger(seconds) &&
    seconds >= 0 &&
    Number.isSafeInteger(seconds * 1000)
  ) {
    return seconds;
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function errorForStatus(response: Response): SteamWishlistError {
  const retryAfterSeconds = response.status === 429 ? parseRetryAfter(response) : undefined;

  if (response.status === 400) {
    return new SteamWishlistError('STEAM_INVALID_REQUEST', 'Steam rejected the request', 400);
  }

  if (response.status === 404) {
    return new SteamWishlistError('STEAM_NOT_FOUND', 'Steam endpoint or resource was not found', 404);
  }

  if (response.status === 429) {
    return new SteamWishlistError(
      'STEAM_RATE_LIMITED',
      'Steam rate limited the request',
      429,
      retryAfterSeconds,
    );
  }

  return new SteamWishlistError(
    'STEAM_UPSTREAM_ERROR',
    `Steam returned HTTP ${response.status}`,
    response.status,
  );
}

async function runWithConcurrency<T>(
  values: readonly T[],
  maxConcurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(values[index]);
    }
  }

  const workerCount = Math.min(values.length, maxConcurrency);
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
}

/** A per-app outcome: a value with its observation time, or that app's own Steam error. */
type Lookup<V> =
  | { readonly value: V; readonly observedAt: string }
  | { readonly error: SteamWishlistError };

interface BatchCache<V> {
  readonly entries: Map<string, { readonly lookup: Lookup<V>; readonly expiresAt: number }>;
  readonly inflight: Map<string, Promise<Lookup<V>>>;
}

interface BatchSource<V> {
  readonly cache: BatchCache<V>;
  readonly ttlMs: number;
  /** An instant after which a value requested at this time may be wrong, whatever the TTL says. */
  readonly validUntil?: (requestedAtMs: number) => number;
  readonly key: (appId: number) => string;
  readonly fetch: (appIds: readonly number[]) => Promise<Map<number, V | SteamWishlistError>>;
  readonly cacheable: (value: V) => boolean;
}

function createBatchCache<V>(): BatchCache<V> {
  return { entries: new Map(), inflight: new Map() };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export class SteamClient {
  private readonly priceCache = createBatchCache<ParsedPriceEntry>();
  private readonly metadataCache = createBatchCache<ParsedStoreItem>();
  private readonly metadataCacheTtlMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: SteamFetch;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly requestLimiter: Pick<SteamRequestLimiter, 'run' | 'deferFor'>;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly lifecycleSignal?: AbortSignal;

  public constructor(options: SteamClientOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.metadataCacheTtlMs = options.metadataCacheTtlMs ?? defaultMetadataCacheTtlMs;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxConcurrency = options.maxConcurrency ?? defaultMaxConcurrency;
    this.requestLimiter = options.requestLimiter ?? globalSteamRequestLimiter;
    this.maxRetries = options.maxRetries ?? defaultMaxRetries;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? defaultRetryBaseDelayMs;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? defaultMaxRetryDelayMs;
    this.lifecycleSignal = options.lifecycleSignal;

    for (const ttl of [this.cacheTtlMs, this.metadataCacheTtlMs]) {
      if (!Number.isSafeInteger(ttl) || ttl < 0) throw new Error('Steam cache TTL must be a non-negative integer');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Steam timeout must be a positive safe integer');
    }

    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency <= 0) {
      throw new Error('Steam max concurrency must be a positive safe integer');
    }

    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error('Steam max retries must be a non-negative safe integer');
    }

    for (const [name, value] of [
      ['retry base delay', this.retryBaseDelayMs],
      ['maximum retry delay', this.maxRetryDelayMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Steam ${name} must be a positive safe integer`);
      }
    }
  }

  public async getWishlist(
    steamId64: string,
    storeCountryCode: StoreCountryCode,
    language: Language,
  ): Promise<WishlistItem[]> {
    const result = await this.getWishlistWithErrors(steamId64, storeCountryCode, language);
    if (result.items.length === 0 && result.errors.length > 0) {
      throw new SteamWishlistError(
        result.errors[0]?.code ?? 'STEAM_UPSTREAM_ERROR',
        'Steam app details were unavailable for the entire wishlist',
      );
    }
    return result.items;
  }

  public async validateWishlistAccess(steamId64: string): Promise<void> {
    await this.getWishlistEntries(steamId64);
  }

  public async getWishlistWithErrors(
    steamId64: string,
    storeCountryInput: StoreCountryCode,
    language: Language,
  ): Promise<SteamWishlistResult> {
    const storeCountryCode = parseStoreCountryCode(storeCountryInput);
    if (!storeCountryCode || !isLanguage(language)) {
      throw new SteamWishlistError(
        'STEAM_INVALID_REQUEST',
        'Steam store country or response language is invalid',
      );
    }
    const wishlistEntries = await this.getWishlistEntries(steamId64);
    const appIds = [...new Set(wishlistEntries.map((entry) => entry.appId))];
    const [metadata, prices] = await Promise.all([
      this.loadBatched(appIds, this.metadataSource(storeCountryCode, language)),
      this.loadBatched(appIds, this.priceSource(storeCountryCode)),
    ]);

    const items: WishlistItem[] = [];
    const errors: SteamWishlistResult['errors'] = [];
    for (const entry of wishlistEntries) {
      const details = metadata.get(entry.appId)!;
      const priced = prices.get(entry.appId)!;
      if ('error' in details || 'error' in priced) {
        const error = 'error' in details ? details.error : (priced as { error: SteamWishlistError }).error;
        errors.push({ appId: entry.appId, code: error.code });
        continue;
      }

      // A listed price wins over a possibly stale cached free flag.
      const price = priced.value ?? (details.value.isFree ? freePrice : null);
      items.push({
        appId: entry.appId,
        priceObservedAt: priced.observedAt,
        name: details.value.name,
        ...(details.value.headerImageUrl ? { headerImageUrl: details.value.headerImageUrl } : {}),
        ...(details.value.storeFacts ? { storeFacts: details.value.storeFacts } : {}),
        // A listed price means it is on sale, whatever a cached release flag says.
        ...(details.value.upcoming && !priced.value ? { upcoming: details.value.upcoming } : {}),
        priority: entry.priority,
        dateAdded: entry.dateAdded,
        price,
        onSale: price === null ? null : !price.isFree && price.discountPercent > 0,
      });
    }

    return { items, errors };
  }

  public clearPriceCache(): void { this.priceCache.entries.clear(); }

  private priceSource(storeCountryCode: StoreCountryCode): BatchSource<ParsedPriceEntry> {
    return {
      cache: this.priceCache,
      ttlMs: this.cacheTtlMs,
      // A price read just before Steam's daily change must not hide a sale that starts at it.
      validUntil: (requestedAtMs) => nextSteamPriceChange(new Date(requestedAtMs)).getTime(),
      key: (appId) => `${storeCountryCode}:${appId}`,
      // Unpriced/unavailable products are not reusable successful prices.
      cacheable: (price) => price !== null,
      fetch: async (appIds) => parsePriceOverviewResponse(
        await this.requestJson(
          `${appDetailsEndpoint}?appids=${appIds.join(',')}&cc=${storeCountryCode}&filters=price_overview`,
        ),
        appIds,
      ),
    };
  }

  private metadataSource(
    storeCountryCode: StoreCountryCode,
    language: Language,
  ): BatchSource<ParsedStoreItem> {
    return {
      cache: this.metadataCache,
      ttlMs: this.metadataCacheTtlMs,
      // A sale that starts at the daily change brings its end time; the alert must show it.
      validUntil: (requestedAtMs) => nextSteamPriceChange(new Date(requestedAtMs)).getTime(),
      key: (appId) => `${storeCountryCode}:${language}:${appId}`,
      cacheable: () => true,
      fetch: async (appIds) => {
        const input = JSON.stringify({
          ids: appIds.map((appid) => ({ appid })),
          context: {
            language: steamLanguage[language],
            country_code: storeCountryCode,
            steam_realm: 1,
          },
          data_request: {
            include_assets: true, include_platforms: true, include_reviews: true, include_all_purchase_options: true,
            include_release: true,
          },
        });
        return parseStoreItemsResponse(
          await this.requestJson(`${storeItemsEndpoint}?input_json=${encodeURIComponent(input)}`),
          appIds,
        );
      },
    };
  }

  /**
   * Resolves every app from cache, from a request another caller already started, or
   * from new batched requests. Requests are registered before they run, so concurrent
   * scans of overlapping wishlists share them instead of asking Steam twice.
   */
  private async loadBatched<V>(
    appIds: readonly number[],
    source: BatchSource<V>,
  ): Promise<Map<number, Lookup<V>>> {
    if (this.lifecycleSignal?.aborted) {
      throw cancelledError();
    }

    const results = new Map<number, Lookup<V>>();
    const waiting: Array<readonly [number, Promise<Lookup<V>>]> = [];
    const missing: number[] = [];
    const nowMs = this.now();
    for (const appId of appIds) {
      const key = source.key(appId);
      const cached = source.cache.entries.get(key);
      const running = source.cache.inflight.get(key);
      if (cached && cached.expiresAt > nowMs) {
        results.set(appId, cached.lookup);
      } else if (running) {
        waiting.push([appId, running]);
      } else {
        missing.push(appId);
      }
    }

    const batches = chunk(missing, steamBatchSize).map((batchAppIds) => {
      let start!: () => void;
      const request = new Promise<void>((resolve) => { start = resolve; })
        .then(() => this.fetchLookups(batchAppIds, source));
      for (const appId of batchAppIds) {
        const key = source.key(appId);
        const lookup = request.then((lookups) => lookups.get(appId)!);
        source.cache.inflight.set(key, lookup);
        waiting.push([appId, lookup]);
        const release = (): void => {
          if (source.cache.inflight.get(key) === lookup) {
            source.cache.inflight.delete(key);
          }
        };
        void lookup.then(release, release);
      }
      return { start, request };
    });

    // Every batch must start, even after a failure, or callers sharing it would wait forever.
    await runWithConcurrency(batches, this.maxConcurrency, async (batch) => {
      batch.start();
      await batch.request.catch(() => undefined);
    });

    for (const [appId, lookup] of waiting) {
      results.set(appId, await lookup);
    }
    return results;
  }

  private async fetchLookups<V>(
    appIds: readonly number[],
    source: BatchSource<V>,
  ): Promise<Map<number, Lookup<V>>> {
    // Steam may have answered with the price from before its daily change even when
    // the response (after queueing or a rate-limit retry) arrives after it.
    const requestedAtMs = this.now();
    let parsed: Map<number, V | SteamWishlistError>;
    try {
      parsed = await source.fetch(appIds);
    } catch (error: unknown) {
      if (!(error instanceof SteamWishlistError) || error.code === 'STEAM_CANCELLED') {
        throw error;
      }
      return new Map(appIds.map((appId) => [appId, { error }]));
    }

    const fetchedAtMs = this.now();
    const observedAt = new Date(fetchedAtMs).toISOString();
    const expiresAt = Math.min(fetchedAtMs + source.ttlMs, source.validUntil?.(requestedAtMs) ?? Number.POSITIVE_INFINITY);
    const lookups = new Map<number, Lookup<V>>();
    for (const appId of appIds) {
      const value = parsed.get(appId)!;
      if (value instanceof SteamWishlistError) {
        lookups.set(appId, { error: value });
        continue;
      }

      const lookup = { value, observedAt };
      lookups.set(appId, lookup);
      if (source.cacheable(value)) {
        const key = source.key(appId);
        source.cache.entries.delete(key);
        if (source.cache.entries.size >= maxCacheEntries) {
          source.cache.entries.delete(source.cache.entries.keys().next().value!);
        }
        source.cache.entries.set(key, { lookup, expiresAt });
      }
    }
    return lookups;
  }

  private async getWishlistEntries(
    steamId64: string,
  ): Promise<ReturnType<typeof parseWishlistResponse>> {
    if (!/^\d{17}$/.test(steamId64)) {
      throw new SteamWishlistError(
        'STEAM_INVALID_REQUEST',
        'SteamID64 must contain exactly 17 digits',
      );
    }

    const encodedSteamId = encodeURIComponent(steamId64);
    const wishlistPayload = await this.requestJson(
      `${wishlistEndpoint}?steamid=${encodedSteamId}`,
      true,
    );

    return parseWishlistResponse(wishlistPayload);
  }

  private async requestJson(url: string, requireWishlistAccess = false): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.lifecycleSignal?.aborted) {
        throw cancelledError();
      }

      try {
        return await this.requestLimiter.run(async () => {
          try {
            return await this.requestJsonAttempt(
              url,
              requireWishlistAccess,
              this.lifecycleSignal,
            );
          } catch (error: unknown) {
            if (error instanceof SteamWishlistError && error.code === 'STEAM_RATE_LIMITED') {
              const retryDelayMs = error.retryAfterSeconds === undefined
                ? Math.min(this.retryBaseDelayMs * (2 ** attempt), this.maxRetryDelayMs)
                : Math.min(error.retryAfterSeconds * 1000, this.maxRetryDelayMs);
              this.requestLimiter.deferFor(retryDelayMs, this.lifecycleSignal);
            }

            throw error;
          }
        }, this.lifecycleSignal);
      } catch (error: unknown) {
        if (this.lifecycleSignal?.aborted) {
          throw cancelledError();
        }

        if (
          !(error instanceof SteamWishlistError) ||
          error.code !== 'STEAM_RATE_LIMITED' ||
          attempt >= this.maxRetries
        ) {
          throw error;
        }

      }
    }
  }

  private async requestJsonAttempt(
    url: string,
    requireWishlistAccess: boolean,
    lifecycleSignal?: AbortSignal,
  ): Promise<unknown> {
    if (lifecycleSignal?.aborted) {
      throw cancelledError();
    }

    const controller = new AbortController();
    let rejectCancellation: ((error: SteamWishlistError) => void) | undefined;
    const cancellationPromise = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (): void => {
      controller.abort();
      rejectCancellation?.(cancelledError());
    };
    lifecycleSignal?.addEventListener('abort', cancel, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SteamWishlistError('STEAM_TIMEOUT', 'Steam request timed out'));
      }, this.timeoutMs);
    });

    let response: Response;
    try {
      response = await Promise.race([
        this.fetchImpl(url, { signal: controller.signal }),
        timeoutPromise,
        cancellationPromise,
      ]);
    } catch (error: unknown) {
      lifecycleSignal?.removeEventListener('abort', cancel);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      if (error instanceof SteamWishlistError) {
        throw error;
      }

      if (lifecycleSignal?.aborted) {
        throw cancelledError();
      }

      if (controller.signal.aborted) {
        throw new SteamWishlistError('STEAM_TIMEOUT', 'Steam request timed out');
      }

      throw new SteamWishlistError(
        'STEAM_NETWORK_ERROR',
        `Steam request failed: ${error instanceof Error ? error.message : 'unknown network error'}`,
      );
    }

    try {
      if (!response.ok) {
        throw errorForStatus(response);
      }

      if (requireWishlistAccess) {
        const result = response.headers.get('x-eresult')?.trim();
        if (result === '15') {
          throw new SteamWishlistError(
            'STEAM_WISHLIST_INACCESSIBLE',
            'Steam wishlist is private, unavailable, or the SteamID64 does not exist',
            response.status,
          );
        }

        if (result !== '1') {
          throw new SteamWishlistError(
            'STEAM_INVALID_RESPONSE',
            'Steam wishlist response did not include a successful X-EResult',
            response.status,
          );
        }
      }

      return await Promise.race([response.json(), timeoutPromise, cancellationPromise]) as unknown;
    } catch (error: unknown) {
      // An unread error body keeps its connection busy; during a 429 storm that piles up.
      discardBody(response);
      if (error instanceof SteamWishlistError) {
        throw error;
      }

      if (lifecycleSignal?.aborted) {
        throw cancelledError();
      }

      if (controller.signal.aborted) {
        throw new SteamWishlistError('STEAM_TIMEOUT', 'Steam response timed out');
      }

      throw new SteamWishlistError(
        'STEAM_INVALID_RESPONSE',
        `Steam returned invalid JSON: ${error instanceof Error ? error.message : 'unknown response error'}`,
      );
    } finally {
      lifecycleSignal?.removeEventListener('abort', cancel);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

const freePrice = {
  currency: null,
  initialMinor: 0,
  finalMinor: 0,
  discountPercent: 0,
  isFree: true,
} as const;

/** Releases the connection behind a response whose body will not be read. */
export function discardBody(response: Response): void {
  if (!response.bodyUsed) {
    response.body?.cancel().catch(() => undefined);
  }
}

function cancelledError(): SteamWishlistError {
  return new SteamWishlistError('STEAM_CANCELLED', 'Steam request cancelled');
}
