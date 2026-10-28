import { AdminActionError, type AdminActionService } from '../application/admin/admin-action-service.js';
import {
  InvalidAnnouncementError, normalizeAudience, normalizeContent, type BroadcastService,
} from '../application/admin/broadcast-service.js';
import { InvalidSettingError } from '../application/admin/runtime-settings.js';
import type { AdminQueryService } from '../application/admin/admin-query-service.js';
import { TestNotificationCooldownError } from '../application/test-notification-service.js';
import { InvalidUserConfigurationError } from '../application/user-configuration-service.js';
import { requireBroadcastId, requireDiscordId } from './admin-routes.js';
import { AdminHttpError, type AdminRequest, type AdminResponse, type AdminRoute } from './admin-server.js';

export interface AdminActionRouteDependencies {
  readonly actions: AdminActionService;
  readonly query: AdminQueryService;
  readonly broadcasts: Pick<BroadcastService, 'preview'>;
}

function body(request: AdminRequest): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
}

/** Destructive actions repeat the target ID, so a stray click or replayed request cannot run them. */
function requireConfirmation(request: AdminRequest, target: string): void {
  if (body(request).confirm !== target) throw new AdminHttpError(400, 'Type the ID to confirm');
}

/** Maps domain errors to HTTP answers; anything else is a 500 logged by the server. */
async function run(work: () => Promise<unknown>): Promise<AdminResponse> {
  try {
    return { json: { ok: true, result: await work() } };
  } catch (error: unknown) {
    if (error instanceof AdminActionError) throw new AdminHttpError(error.status, error.message);
    if (error instanceof InvalidAnnouncementError || error instanceof InvalidSettingError
      || error instanceof InvalidUserConfigurationError) {
      throw new AdminHttpError(400, error.message);
    }
    if (error instanceof TestNotificationCooldownError) {
      throw new AdminHttpError(409, `Wait ${error.retryAfterSeconds} seconds before another test alert`);
    }
    throw error;
  }
}

export function actionRoutes({ actions, query, broadcasts }: AdminActionRouteDependencies): AdminRoute[] {
  const userAction = (name: string, handler: (id: string, request: AdminRequest) => Promise<unknown>): AdminRoute => ({
    method: 'POST',
    path: `/api/users/:id/${name}`,
    handler: (request) => run(() => handler(requireDiscordId(request.params.id), request)),
  });
  const guildAction = (name: string, handler: (id: string, request: AdminRequest) => Promise<unknown>): AdminRoute => ({
    method: 'POST',
    path: `/api/guilds/:id/${name}`,
    handler: (request) => run(() => handler(requireDiscordId(request.params.id), request)),
  });
  return [
    {
      method: 'GET',
      path: '/api/usage',
      handler: ({ query: search }) => {
        const days = Math.min(90, Math.max(1, Number(search.get('days') ?? 30) || 30));
        return { json: query.usage(days) };
      },
    },
    {
      method: 'GET',
      path: '/api/guilds/:id',
      handler: async ({ params }) => {
        const guild = await query.guild(requireDiscordId(params.id));
        if (!guild) throw new AdminHttpError(404, 'Server not found');
        return { json: guild };
      },
    },
    {
      method: 'GET',
      path: '/api/audit',
      handler: ({ query: search }) => {
        // The trail is kept a year (auditRetentionMs); the row cap keeps one answer small.
        const days = Math.min(365, Math.max(1, Number(search.get('days') ?? 30) || 30));
        return { json: query.audit(days, 5000) };
      },
    },
    { method: 'GET', path: '/api/broadcasts', handler: () => ({ json: query.broadcastList() }) },
    {
      method: 'GET',
      path: '/api/broadcasts/:id',
      handler: async ({ params }) => {
        const broadcast = await query.broadcastDetail(requireBroadcastId(params.id));
        if (!broadcast) throw new AdminHttpError(404, 'Announcement not found');
        return { json: broadcast };
      },
    },
    {
      method: 'POST',
      path: '/api/broadcasts/preview',
      handler: (request) => ({ json: broadcasts.preview(normalizeAudience(body(request).audience)) }),
    },
    {
      method: 'POST',
      path: '/api/broadcasts',
      handler: (request) => run(async () => {
        const content = normalizeContent(body(request).content);
        const audience = normalizeAudience(body(request).audience);
        if (body(request).confirm !== 'GÖNDER') throw new AdminHttpError(400, 'Type GÖNDER to confirm');
        return actions.announce(content, audience);
      }),
    },
    {
      method: 'POST',
      path: '/api/broadcasts/:id/status',
      handler: (request) => run(async () => {
        const status = body(request).status;
        if (status !== 'sending' && status !== 'paused' && status !== 'cancelled') throw new AdminHttpError(400, 'Invalid status');
        return actions.setBroadcastStatus(requireBroadcastId(request.params.id), status);
      }),
    },
    userAction('pause', (id) => actions.pauseUser(id)),
    userAction('resume', (id) => actions.resumeUser(id)),
    userAction('check', (id) => actions.checkUser(id)),
    userAction('test-alert', (id) => actions.testAlert(id)),
    userAction('region', (id, request) => actions.setRegion(id, body(request).country)),
    userAction('language', (id, request) => actions.setLanguage(id, body(request).language)),
    userAction('message', (id, request) => actions.messageUser(id, normalizeContent(body(request).content))),
    userAction('block', (id, request) => {
      requireConfirmation(request, id);
      return actions.blockUser(id, body(request).reason);
    }),
    userAction('unblock', (id) => actions.unblockUser(id)),
    userAction('delete', (id, request) => {
      requireConfirmation(request, id);
      return actions.deleteUser(id);
    }),
    guildAction('leave', (id, request) => {
      requireConfirmation(request, id);
      return actions.leaveGuild(id);
    }),
    guildAction('block', (id, request) => {
      requireConfirmation(request, id);
      return actions.blockGuild(id, body(request).reason);
    }),
    guildAction('unblock', (id) => actions.unblockGuild(id)),
    { method: 'POST', path: '/api/system/scan-now', handler: () => run(() => actions.scanNow()) },
    { method: 'POST', path: '/api/system/retry-now', handler: () => run(() => actions.retryNow()) },
    {
      method: 'POST',
      path: '/api/system/restart',
      handler: (request) => run(() => {
        requireConfirmation(request, 'restart');
        return actions.restartBot();
      }),
    },
    {
      method: 'POST',
      path: '/api/system/stop',
      handler: (request) => run(() => {
        requireConfirmation(request, 'DURDUR');
        return actions.stopBot();
      }),
    },
    {
      method: 'POST',
      path: '/api/settings',
      handler: (request) => run(() => {
        const input = body(request);
        return actions.updateSettings({
          ...(input.maxUsers === null || typeof input.maxUsers === 'number' ? { maxUsers: input.maxUsers } : {}),
          ...(typeof input.signupsOpen === 'boolean' ? { signupsOpen: input.signupsOpen } : {}),
          ...(input.presenceText === null || typeof input.presenceText === 'string' ? { presenceText: input.presenceText } : {}),
          ...(typeof input.scansPaused === 'boolean' ? { scansPaused: input.scansPaused } : {}),
        });
      }),
    },
  ];
}
