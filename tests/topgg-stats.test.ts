import { describe, expect, it, vi } from 'vitest';
import { TopggStatsPoster, type TopggFetch } from '../src/operations/topgg-stats.js';

function poster(count: () => number | null, fetchImpl: TopggFetch, logger = { warn: vi.fn() }) {
  return { logger, poster: new TopggStatsPoster({ token: 'topgg-test-token', botId: '123', serverCount: count, fetchImpl, logger }) };
}

describe('TopggStatsPoster', () => {
  it('posts the server count with the token and a timeout', async () => {
    const fetchImpl = vi.fn<TopggFetch>(async () => ({ ok: true, status: 200 }));
    const { poster: stats } = poster(() => 7, fetchImpl);
    await expect(stats.post()).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://top.gg/api/bots/123/stats');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'topgg-test-token' });
    expect(JSON.parse(String(init.body))).toEqual({ server_count: 7 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('skips an unchanged count and a gateway that is not ready', async () => {
    let count: number | null = null;
    const fetchImpl = vi.fn<TopggFetch>(async () => ({ ok: true, status: 200 }));
    const { poster: stats } = poster(() => count, fetchImpl);
    await expect(stats.post()).resolves.toBe(false);
    count = 4;
    await stats.post();
    await expect(stats.post()).resolves.toBe(false);
    count = 5;
    await expect(stats.post()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('logs failures without the token and retries the same count later', async () => {
    const fetchImpl = vi.fn<TopggFetch>()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'TimeoutError' }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const { poster: stats, logger } = poster(() => 3, fetchImpl);
    await expect(stats.post()).resolves.toBe(false);
    await expect(stats.post()).resolves.toBe(false);
    await expect(stats.post()).resolves.toBe(true);
    expect(logger.warn.mock.calls.map(call => call[0])).toEqual([
      'top.gg stats update failed with HTTP 401', 'top.gg stats update timed out']);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('topgg-test-token');
  });

  it('stops its timer and waits for a request in flight', async () => {
    let release!: () => void;
    const fetchImpl = vi.fn<TopggFetch>(() => new Promise(resolve => { release = () => resolve({ ok: true, status: 200 }); }));
    const { poster: stats } = poster(() => 2, fetchImpl);
    stats.start();
    let stopped = false;
    const stopping = stats.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
