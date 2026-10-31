/**
 * Posts Dealio's server count to its top.gg page, so the listing shows how many
 * servers use it. Optional: runs only when TOPGG_TOKEN is set. Every request has a
 * timeout, and a failure is logged and retried at the next interval; top.gg never
 * affects price checks or alerts.
 */

export type TopggFetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status'>>;

export interface TopggStatsOptions {
  readonly token: string;
  /** The bot's Discord application ID, as in its top.gg URL. */
  readonly botId: string;
  /** The current server count, or null while the gateway is not ready. */
  readonly serverCount: () => number | null;
  readonly fetchImpl?: TopggFetch;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly logger?: Pick<Console, 'warn'>;
}

export const topggStatsIntervalMs = 60 * 60 * 1000;
const defaultTimeoutMs = 10_000;

export class TopggStatsPoster {
  private readonly fetchImpl: TopggFetch;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly logger: Pick<Console, 'warn'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPosted: number | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly options: TopggStatsOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.intervalMs = options.intervalMs ?? topggStatsIntervalMs;
    this.logger = options.logger ?? console;
  }

  /** Posts now and then once per interval. */
  start(): void {
    if (this.timer) return;
    void this.post();
    this.timer = setInterval(() => void this.post(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /**
   * Sends the current count; true when top.gg accepted it. An unchanged count is
   * sent again only by `force`, so the hourly post stays a no-op when nothing moved.
   */
  post(force = false): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const count = this.options.serverCount();
    if (count === null || (!force && count === this.lastPosted)) return Promise.resolve(false);
    this.inFlight = this.send(count).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async send(count: number): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`https://top.gg/api/bots/${this.options.botId}/stats`, {
        method: 'POST',
        headers: { Authorization: this.options.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_count: count }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.logger.warn(`top.gg stats update failed with HTTP ${response.status}`);
        return false;
      }
      this.lastPosted = count;
      return true;
    } catch (error: unknown) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed';
      this.logger.warn(`top.gg stats update ${reason}`);
      return false;
    }
  }
}
