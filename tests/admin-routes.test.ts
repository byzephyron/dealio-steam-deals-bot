import { describe, expect, it, vi } from 'vitest';
import { actionRoutes } from '../src/admin/admin-action-routes.js';
import { readRoutes } from '../src/admin/admin-routes.js';
import { AdminHttpError, type AdminRequest, type AdminRoute } from '../src/admin/admin-server.js';
import { LogBuffer } from '../src/admin/log-buffer.js';

function route(routes: readonly AdminRoute[], method: 'GET' | 'POST', path: string): AdminRoute {
  const found = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`No route ${method} ${path}`);
  return found;
}

function request(overrides: Partial<AdminRequest>): AdminRequest {
  return {
    method: 'GET', path: '/', query: new URLSearchParams(), params: {}, body: null,
    session: { id: 's', csrf: 'c', expiresAt: 0 }, ...overrides,
  };
}

describe('admin routes', () => {
  it('rejects announcement IDs that are not UUIDs before reaching the services', async () => {
    const broadcastDetail = vi.fn(async () => null);
    const setBroadcastStatus = vi.fn(async () => ({ status: 'paused' }));
    const routes = actionRoutes({
      actions: { setBroadcastStatus } as never,
      query: { broadcastDetail } as never,
      broadcasts: { preview: () => ({}) } as never,
    });
    const detail = route(routes, 'GET', '/api/broadcasts/:id');
    const status = route(routes, 'POST', '/api/broadcasts/:id/status');
    for (const id of ['x'.repeat(5000), '../../etc', '']) {
      await expect(detail.handler!(request({ params: { id } }))).rejects.toMatchObject({ status: 400 });
      await expect(status.handler!(request({ method: 'POST', params: { id }, body: { status: 'paused' } })))
        .rejects.toBeInstanceOf(AdminHttpError);
    }
    expect(broadcastDetail).not.toHaveBeenCalled();
    expect(setBroadcastStatus).not.toHaveBeenCalled();

    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await status.handler!(request({ method: 'POST', params: { id }, body: { status: 'paused' } }));
    expect(setBroadcastStatus).toHaveBeenCalledWith(id, 'paused');
  });

  it('restarts or stops the bot only with the typed confirmation', async () => {
    const restartBot = vi.fn(async () => ({ accepted: true }));
    const stopBot = vi.fn(async () => ({ accepted: true }));
    const routes = actionRoutes({
      actions: { restartBot, stopBot } as never,
      query: {} as never,
      broadcasts: { preview: () => ({}) } as never,
    });
    const restart = route(routes, 'POST', '/api/system/restart');
    const stop = route(routes, 'POST', '/api/system/stop');
    await expect(restart.handler!(request({ method: 'POST', body: {} }))).rejects.toMatchObject({ status: 400 });
    await expect(stop.handler!(request({ method: 'POST', body: { confirm: 'durdur' } }))).rejects.toMatchObject({ status: 400 });
    expect(restartBot).not.toHaveBeenCalled();
    expect(stopBot).not.toHaveBeenCalled();
    await restart.handler!(request({ method: 'POST', body: { confirm: 'restart' } }));
    await stop.handler!(request({ method: 'POST', body: { confirm: 'DURDUR' } }));
    expect(restartBot).toHaveBeenCalledOnce();
    expect(stopBot).toHaveBeenCalledOnce();
  });

  it('accepts the scan pause switch in the settings update', async () => {
    const updateSettings = vi.fn(async (update: unknown) => update);
    const routes = actionRoutes({ actions: { updateSettings } as never, query: {} as never, broadcasts: { preview: () => ({}) } as never });
    await route(routes, 'POST', '/api/settings').handler!(request({ method: 'POST', body: { scansPaused: true, junk: 1 } }));
    expect(updateSettings).toHaveBeenCalledWith({ scansPaused: true });
  });

  it('looks up at most one chunk of distinct, valid profile IDs per request', async () => {
    const profiles = vi.fn(async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, null])));
    const routes = readRoutes({ query: { profiles } as never, logs: new LogBuffer() });
    const ids = Array.from({ length: 500 }, (_, index) => String(100000000000000000n + BigInt(index)));
    await route(routes, 'GET', '/api/profiles').handler!(request({
      query: new URLSearchParams({ ids: [ids[0], ids[0], 'bad', ...ids].join(',') }),
    }));
    const asked = profiles.mock.calls[0]![0];
    expect(asked).toHaveLength(50);
    expect(new Set(asked).size).toBe(50);
    expect(asked).not.toContain('bad');
  });
});
