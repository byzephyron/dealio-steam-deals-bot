import { ApplicationIntegrationType, InteractionContextType, RateLimitError, Routes } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { safeLogger } from '../src/application/safe-logger.js';
import type { EnvironmentConfig } from '../src/config/environment.js';
import {
  cleanupLegacyGuildCommands,
  commands,
  registerCommands,
  registerGlobalCommands,
} from '../src/discord/register-commands.js';

const environment: EnvironmentConfig = {
  discordToken: 'test-token',
  discordClientId: '123456789012345678',
  databasePath: ':memory:',
  pollIntervalHours: 6,
  notificationRetryIntervalSeconds: 60,
  maxUsers: 200,
};

describe('Discord command registration', () => {
  const commandNames = commands.map((command) => command.name);
  const discordCommands = commandNames.map((name) => ({ name }));

  it('registers and verifies every slash command on the global application route', async () => {
    const put = vi.fn().mockResolvedValue(discordCommands);
    const get = vi.fn().mockResolvedValue(discordCommands);
    const log = vi.fn();
    const signal = new AbortController().signal;

    const registeredNames = await registerGlobalCommands(
      { get, put } as never,
      environment.discordClientId,
      signal,
      log,
    );

    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(
      Routes.applicationCommands(environment.discordClientId),
      {
        body: expect.arrayContaining(commands.map((command) =>
          expect.objectContaining({ name: command.name })
        )),
        signal,
      },
    );
    expect(put.mock.calls[0]?.[0]).not.toContain('/guilds/');
    const deployedBody = put.mock.calls[0]?.[1]?.body as Array<{
      name: string;
      options?: Array<{ name: string }>;
    }>;
    expect(deployedBody.find((command) => command.name === 'setup')?.options ?? [])
      .toEqual([]);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      Routes.applicationCommands(environment.discordClientId),
      { signal },
    );
    expect(registeredNames).toEqual(commandNames);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      `Registering global commands: ${commandNames.join(', ')}`,
      `Registered global commands: ${commandNames.join(', ')}`,
      `Verified global commands: ${commandNames.join(', ')}`,
    ]);
    expect(log.mock.calls.flat().join(' ')).not.toContain(environment.discordToken);
  });

  it('offers every command to server and personal (user) installs in all contexts', async () => {
    const put = vi.fn().mockResolvedValue(discordCommands);
    const get = vi.fn().mockResolvedValue(discordCommands);

    await registerGlobalCommands({ get, put } as never, environment.discordClientId, undefined, vi.fn());

    const deployedBody = put.mock.calls[0]?.[1]?.body as Array<{
      name: string;
      integration_types?: number[];
      contexts?: number[];
    }>;
    expect(deployedBody).toHaveLength(commandNames.length);
    for (const command of deployedBody) {
      expect(command.integration_types, command.name).toEqual([
        ApplicationIntegrationType.GuildInstall,
        ApplicationIntegrationType.UserInstall,
      ]);
      expect(command.contexts, command.name).toEqual([
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ]);
    }
  });

  it('fails startup verification when Discord GET omits a deployed command', async () => {
    const put = vi.fn().mockResolvedValue(discordCommands);
    const get = vi.fn().mockResolvedValue(
      discordCommands.filter((command) => command.name !== 'delete-data'),
    );

    await expect(registerGlobalCommands(
      { get, put } as never,
      environment.discordClientId,
      undefined,
      vi.fn(),
    )).rejects.toThrow(
      'Discord global command verification failed; missing commands: delete-data',
    );
  });

  it('clears legacy commands only from the configured migration guild', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;
    const guildId = '987654321098765432';

    await cleanupLegacyGuildCommands(
      { put } as never,
      environment.discordClientId,
      guildId,
      signal,
    );

    expect(put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands(environment.discordClientId, guildId),
      { body: [], signal },
    );
  });

  it('registers globally before cleaning the optional legacy guild', async () => {
    const put = vi.fn()
      .mockResolvedValueOnce(discordCommands)
      .mockResolvedValueOnce([]);
    const get = vi.fn().mockResolvedValue(discordCommands);
    const signal = new AbortController().signal;
    const guildId = '987654321098765432';

    await registerCommands(
      { ...environment, discordGuildId: guildId },
      signal,
      { get, put } as never,
      vi.fn(),
    );

    expect(put.mock.calls).toEqual([
      [Routes.applicationCommands(environment.discordClientId), {
        body: expect.any(Array),
        signal,
      }],
      [Routes.applicationGuildCommands(environment.discordClientId, guildId), {
        body: [],
        signal,
      }],
    ]);
    expect(get).toHaveBeenCalledWith(
      Routes.applicationCommands(environment.discordClientId),
      { signal },
    );
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(put.mock.invocationCallOrder[1]);
  });

  it('does not call a guild route when no migration guild is configured', async () => {
    const put = vi.fn().mockResolvedValue(discordCommands);
    const get = vi.fn().mockResolvedValue(discordCommands);

    await registerCommands(environment, undefined, { get, put } as never, vi.fn());

    expect(put).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(
      Routes.applicationCommands(environment.discordClientId),
      expect.objectContaining({ body: expect.any(Array) }),
    );
  });

  // 16 October 2026: a guild Dealio had left (50001) and then the registration rate
  // limit kept every restart from starting, so a deploy became a four-minute outage.
  it('starts anyway when the legacy guild is no longer reachable', async () => {
    const logged = vi.spyOn(safeLogger, 'error').mockImplementation(() => undefined);
    const missingAccess = Object.assign(new Error('Missing Access'), { code: 50_001, status: 403 });
    const put = vi.fn().mockResolvedValueOnce(discordCommands).mockRejectedValueOnce(missingAccess);
    const get = vi.fn().mockResolvedValue(discordCommands);

    await expect(registerCommands({ ...environment, discordGuildId: '987654321098765432' }, undefined,
      { get, put } as never, vi.fn())).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('legacy guild commands'), missingAccess);
    logged.mockRestore();
  });

  it('keeps the commands Discord already has when registration is rate limited', async () => {
    const logged = vi.spyOn(safeLogger, 'error').mockImplementation(() => undefined);
    const rateLimited = new RateLimitError({
      timeToReset: 32_000, limit: 2, method: 'PUT', hash: 'Global(PUT:/applications/:id/commands)',
      url: 'https://discord.com/api/v10/applications/1/commands', route: '/applications/:id/commands',
      majorParameter: 'global', global: false, retryAfter: 33_000, sublimitTimeout: 0, scope: 'user',
    });
    const put = vi.fn().mockRejectedValue(rateLimited);

    await expect(registerCommands(environment, undefined, { get: vi.fn(), put } as never, vi.fn()))
      .resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('rate limited'), rateLimited);
    logged.mockRestore();
  });

  it('still refuses to start when registration fails for another reason', async () => {
    const put = vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));

    await expect(registerCommands(environment, undefined, { get: vi.fn(), put } as never, vi.fn()))
      .rejects.toThrow('Unauthorized');
  });
});
