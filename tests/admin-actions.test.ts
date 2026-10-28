import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { AdminActionError, AdminActionService } from '../src/application/admin/admin-action-service.js';
import { BroadcastService } from '../src/application/admin/broadcast-service.js';
import { InvalidSettingError, RuntimeSettings } from '../src/application/admin/runtime-settings.js';
import { SetupCapacityReachedError, SetupService } from '../src/application/setup-service.js';
import { AdminControlRepository } from '../src/persistence/admin-control-repository.js';
import { AdminRepository } from '../src/persistence/admin-repository.js';
import { BroadcastRepository } from '../src/persistence/broadcast-repository.js';
import { createDatabase } from '../src/persistence/database.js';
import { TelemetryRepository } from '../src/persistence/telemetry-repository.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { seedUser } from './helpers/admin-seed.js';

describe('AdminActionService', () => {
  let database: DatabaseSync;
  let controls: AdminControlRepository;
  let users: UserConfigRepository;
  let settings: RuntimeSettings;
  let presence: Array<string | null>;
  let left: string[];
  const runNow = vi.fn(() => true);
  const check = vi.fn(async () => ({ status: 'success', checkedCount: 3 }) as never);

  function actions(extra: Partial<ConstructorParameters<typeof AdminActionService>[0]> = {}): AdminActionService {
    const adminRepository = new AdminRepository(database);
    const broadcasts = new BroadcastService({
      repository: new BroadcastRepository(database),
      users: () => adminRepository.users(),
      isBlocked: (id) => controls.isUserBlocked(id),
      sender: { send: async () => ({ messageId: '1' }) },
      onDmBlocked: () => undefined,
    });
    return new AdminActionService({
      users: {
        get: (id) => users.findByDiscordUserId(id),
        setEnabled: async (id, enabled) => users.setEnabled(id, enabled, new Date().toISOString()),
        setStoreCountry: async (id, code) => users.setStoreCountryCode(id, code as never, new Date().toISOString()),
        setLanguage: async (id, language) => users.setLanguage(id, language, new Date().toISOString()),
        deleteData: async (id) => users.deleteByDiscordUserId(id),
      },
      checks: { check },
      notifications: { deliverPending: async () => ({ candidateCount: 1, sentCount: 1, failedCount: 0 }) },
      testNotifications: { send: async () => undefined },
      scheduler: { runNow },
      retryScheduler: { runOnce: async () => ({ userCount: 0, completedCount: 0, errorCount: 0 }) as never },
      controls,
      broadcasts,
      settings,
      telemetry: new TelemetryRepository(database),
      applyPresence: (text) => presence.push(text),
      guilds: {
        name: (id) => (id === '900000000000000001' ? 'Club' : null),
        leave: async (id) => {
          if (id !== '900000000000000001') return false;
          left.push(id);
          return true;
        },
      },
      ...extra,
    });
  }

  beforeEach(() => {
    database = createDatabase(':memory:');
    controls = new AdminControlRepository(database);
    users = new UserConfigRepository(database);
    settings = new RuntimeSettings(controls, 200);
    presence = [];
    left = [];
    seedUser(database, { id: '100000000000000001' });
    seedUser(database, { id: '100000000000000002', blocked: true });
  });
  afterEach(() => database.close());

  it('audits successful and failed actions', async () => {
    const service = actions();
    await service.pauseUser('100000000000000001');
    expect(users.findByDiscordUserId('100000000000000001')?.enabled).toBe(false);
    await expect(service.pauseUser('199999999999999999')).rejects.toBeInstanceOf(AdminActionError);
    expect(controls.auditEntries(10).map((entry) => [entry.action, entry.outcome])).toEqual([
      ['user.pause', 'failed'], ['user.pause', 'ok'],
    ]);
  });

  it('turning monitoring back on clears a recorded DM block', async () => {
    const result = await actions().resumeUser('100000000000000002') as { enabled: boolean; dmDeliveryBlockedAt: string | null };
    expect(result).toMatchObject({ enabled: true, dmDeliveryBlockedAt: null });
  });

  it('blocks a user (pausing monitoring) and unblocks', async () => {
    const service = actions();
    await service.blockUser('100000000000000001', ' spam ');
    expect(controls.isUserBlocked('100000000000000001')).toBe(true);
    expect(users.findByDiscordUserId('100000000000000001')?.enabled).toBe(false);
    expect(controls.userBlocks()[0]?.reason).toBe('spam');
    await service.unblockUser('100000000000000001');
    expect(controls.isUserBlocked('100000000000000001')).toBe(false);
  });

  it('checks a user now and delivers what is pending', async () => {
    await expect(actions().checkUser('100000000000000001')).resolves.toEqual({ status: 'success', checked: 3, sent: 1, failed: 0 });
    expect(check).toHaveBeenCalledWith('100000000000000001', 'manual', { bypassCooldown: true });
  });

  it('refuses a direct message to someone who cannot receive DMs, without creating it', async () => {
    const service = actions();
    await expect(service.messageUser('100000000000000002', { tr: { title: 'a', body: 'b' } }))
      .rejects.toMatchObject({ status: 409 });
    expect(new BroadcastRepository(database).list(10)).toHaveLength(0);
    const sent = await service.messageUser('100000000000000001', { tr: { title: 'a', body: 'b' } });
    expect(sent.recipientCount).toBe(1);
  });

  it('deletes like /delete-data and reports when nothing is stored', async () => {
    const service = actions();
    await expect(service.deleteUser('100000000000000001')).resolves.toMatchObject({ deleted: true });
    await expect(service.deleteUser('100000000000000001')).rejects.toMatchObject({ status: 404 });
  });

  it('leaves and blocks servers', async () => {
    const service = actions();
    await expect(service.leaveGuild('900000000000000009')).rejects.toMatchObject({ status: 404 });
    await service.blockGuild('900000000000000001', 'raid');
    expect(left).toEqual(['900000000000000001']);
    expect(controls.guildBlocks()[0]).toMatchObject({ guildId: '900000000000000001', guildName: 'Club', reason: 'raid' });
  });

  it('starts a scan unless one is running', async () => {
    await actions().scanNow();
    runNow.mockReturnValueOnce(false);
    await expect(actions().scanNow()).rejects.toMatchObject({ status: 409 });
  });

  it('pauses and resumes automatic scans as a stored setting', async () => {
    expect(settings.scansPaused()).toBe(false);
    await expect(actions().updateSettings({ scansPaused: true })).resolves.toMatchObject({ scansPaused: true });
    expect(new RuntimeSettings(controls, 200).scansPaused()).toBe(true);
    await actions().updateSettings({ scansPaused: false });
    expect(settings.scansPaused()).toBe(false);
  });

  it('restarts or stops the process only after answering, and audits it', async () => {
    const requestExit = vi.fn();
    const deferred: Array<{ work: () => void; delayMs: number }> = [];
    const service = actions({ requestExit, defer: (work, delayMs) => deferred.push({ work, delayMs }) });
    await expect(service.restartBot()).resolves.toEqual({ accepted: true, mode: 'restart' });
    expect(requestExit).not.toHaveBeenCalled();
    expect(deferred[0]?.delayMs).toBeGreaterThan(0);
    deferred[0]!.work();
    expect(requestExit).toHaveBeenCalledWith('restart');
    await service.stopBot();
    deferred[1]!.work();
    expect(requestExit).toHaveBeenLastCalledWith('stop');
    expect(controls.auditEntries(10).map((entry) => [entry.action, entry.outcome])).toEqual([
      ['system.stop', 'ok'], ['system.restart', 'ok'],
    ]);
  });

  it('reads the audit trail by period, not by a fixed number of rows', () => {
    controls.audit('system.scan-now', null, null, 'ok', '2026-01-01T00:00:00.000Z');
    controls.audit('system.retry-now', null, null, 'ok', '2026-10-20T00:00:00.000Z');
    controls.audit('system.settings', null, null, 'ok', '2026-10-27T00:00:00.000Z');
    expect(controls.auditEntriesSince('2026-10-01T00:00:00.000Z', 10).map((entry) => entry.action))
      .toEqual(['system.settings', 'system.retry-now']);
    expect(controls.auditEntriesSince('2025-11-01T00:00:00.000Z', 2).map((entry) => entry.action))
      .toEqual(['system.settings', 'system.retry-now']);
  });

  it('refuses a restart where the process cannot be controlled', async () => {
    await expect(actions().restartBot()).rejects.toMatchObject({ status: 409 });
    expect(controls.auditEntries(1)[0]).toMatchObject({ action: 'system.restart', outcome: 'failed' });
  });

  it('updates runtime settings and applies the presence', async () => {
    const snapshot = await actions().updateSettings({ maxUsers: 300, signupsOpen: false, presenceText: '  Sale watch ' });
    expect(snapshot).toEqual({
      maxUsers: 300, maxUsersOverride: 300, defaultMaxUsers: 200, signupsOpen: false, presenceText: 'Sale watch', scansPaused: false,
    });
    expect(presence).toEqual(['Sale watch']);
    await expect(actions().updateSettings({ maxUsers: 0 })).rejects.toBeInstanceOf(InvalidSettingError);
    expect((await actions().updateSettings({ maxUsers: null, signupsOpen: true, presenceText: '' })))
      .toMatchObject({ maxUsers: 200, signupsOpen: true, presenceText: null });
  });
});

describe('setup with runtime settings', () => {
  function setup(options: ConstructorParameters<typeof SetupService>[3], count = 1) {
    const service = new SetupService(
      { countUsers: () => count, get: () => null, prepare: async () => ({ discordUserId: 'u' }) } as never,
      {} as never,
      { runExclusive: async (_key: string, work: () => unknown) => work() } as never,
      options,
    );
    return service;
  }

  it('has no cap without a limit, and the owner can still set one as a brake', () => {
    const stored = new Map<string, string>();
    const settings = new RuntimeSettings({
      setting: (key) => stored.get(key) ?? null,
      setSetting: (key, value) => { if (value === null) stored.delete(key); else stored.set(key, value); },
    }, null);
    expect(settings.snapshot()).toMatchObject({ maxUsers: null, maxUsersOverride: null, defaultMaxUsers: null });
    const service = setup({ maxUsers: () => settings.maxUsers() }, 5_000);
    expect(service.acceptsNewUsers()).toBe(true);
    settings.update({ maxUsers: 5_000 });
    expect(service.acceptsNewUsers()).toBe(false);
    settings.update({ maxUsers: null });
    expect(settings.maxUsers()).toBeNull();
    expect(service.acceptsNewUsers()).toBe(true);
  });

  it('follows the owner’s limit and the sign-up switch', () => {
    let limit = 1;
    let open = true;
    const service = setup({ maxUsers: () => limit, signupsOpen: () => open });
    expect(service.acceptsNewUsers()).toBe(false);
    limit = 2;
    expect(service.acceptsNewUsers()).toBe(true);
    open = false;
    expect(service.acceptsNewUsers()).toBe(false);
  });

  it('reports setup steps without letting telemetry break setup', async () => {
    const steps: string[] = [];
    const service = setup({ maxUsers: 1, onStep: (_user, step, code) => steps.push(code ? `${step}:${code}` : step) });
    await expect(service.prepare('u', 'x', 'tr', 'TR')).rejects.toBeInstanceOf(SetupCapacityReachedError);
    const open = setup({ onStep: (_user, step) => { steps.push(step); throw new Error('telemetry down'); } });
    await expect(open.prepare('u', 'x', 'tr', 'TR')).resolves.toEqual({ discordUserId: 'u' });
    expect(steps).toEqual(['prepare-failed:SetupCapacityReachedError', 'prepare-ok']);
  });
});
