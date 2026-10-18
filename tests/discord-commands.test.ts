import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { commands } from '../src/discord/register-commands.js';
import { handleCheck } from '../src/discord/commands/check.js';
import { handleSetup } from '../src/discord/commands/setup.js';
import { findStoreCountryChoices } from '../src/discord/store-country-options.js';
import { SteamWishlistError } from '../src/domain/steam.js';
import { SteamIdentityError } from '../src/domain/steam-identity.js';

describe('Discord slash commands', () => {
  const componentText = (payload: unknown): string => JSON.stringify(
    (payload as { components?: unknown[] } | undefined)?.components ?? [],
  );

  it('registers the supported commands', () => {
    // Everything else lives in the /dealio panel.
    expect(commands.map((command) => command.name)).toEqual([
      'dealio',
      'setup',
      'delete-data',
    ]);
  });

  it('uses an option-free interactive confirmation flow for data deletion', () => {
    const command = commands.find((candidate) => candidate.name === 'delete-data');
    expect(command?.toJSON()).toMatchObject({
      name: 'delete-data',
      description_localizations: { tr: 'Dealio verilerini kalıcı olarak sil' },
      options: [],
    });
  });

  it('registers setup as a guided command without technical options', () => {
    const setup = commands.find((command) => command.name === 'setup');
    expect(setup?.toJSON()).toMatchObject({
      name: 'setup',
      description: 'Connect your Steam wishlist in about a minute',
      options: [],
    });
  });

  it('blocks repeated setup before opening the wizard and points to data deletion', async () => {
    const interaction = {
      user: { id: 'discord-user' },
      locale: 'tr',
      client: { user: null },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      options: { getString: vi.fn() },
    };
    const service = {
      hasExistingConfiguration: vi.fn().mockReturnValue(true),
      prepare: vi.fn(),
      confirm: vi.fn(),
      configure: vi.fn(),
    };

    await handleSetup(interaction as never, service as never);

    expect(service.hasExistingConfiguration).toHaveBeenCalledWith('discord-user');
    const reply = interaction.editReply.mock.calls[0]?.[0];
    expect(componentText(reply)).toContain('zaten kurulu');
    expect(componentText(reply)).toContain('/delete-data');
    expect(reply.flags).toBe(MessageFlags.IsComponentsV2);
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
    expect(service.configure).not.toHaveBeenCalled();
  });

  it('finds Store countries by name or code for the region search', () => {
    expect(findStoreCountryChoices('united st', 'en')[0]).toEqual({
      name: 'United States (US)',
      value: 'US',
    });
    expect(findStoreCountryChoices('almanya', 'tr')).toContainEqual({
      name: 'Almanya (DE)',
      value: 'DE',
    });
    expect(findStoreCountryChoices('', 'en')).toHaveLength(25);
  });

  it('explains an inaccessible wishlist after a manual check', async () => {
    const interaction = {
      user: { id: 'discord-user' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    const checkService = {
      check: vi.fn().mockResolvedValue({
        status: 'unavailable',
        errorCode: 'STEAM_WISHLIST_INACCESSIBLE',
      }),
    };
    const statusService = {
      get: vi.fn().mockReturnValue({
        config: { language: 'en' },
        checkState: null,
      }),
    };
    const notificationService = { deliverPending: vi.fn() };

    await handleCheck(
      interaction as never,
      checkService as never,
      statusService as never,
      notificationService as never,
    );

    const panel = componentText(interaction.editReply.mock.calls.at(-1)?.[0]);
    expect(panel).toContain('Your profile looks private');
    expect(panel).toContain('**Game details** to **Public**');
    expect(panel).not.toContain('isn’t responding');
    expect(notificationService.deliverPending).not.toHaveBeenCalled();
  });

  it('checks a disabled user manually without delivering queued notifications', async () => {
    const interaction = {
      user: { id: 'discord-user' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    const checkService = {
      check: vi.fn().mockResolvedValue({
        status: 'success',
        checkedCount: 2,
        notificationCandidates: [{ appId: 10 }],
        failedItems: [],
        unavailableItems: [],
        upcomingCount: 0,
        unknownPriceCount: 0,
      }),
    };
    const notificationService = { deliverPending: vi.fn() };

    await handleCheck(
      interaction as never,
      checkService as never,
      { get: vi.fn().mockReturnValue({
        config: { language: 'en', enabled: false },
        checkState: null,
      }) } as never,
      notificationService as never,
    );

    expect(checkService.check).toHaveBeenCalledWith('discord-user');
    expect(notificationService.deliverPending).not.toHaveBeenCalled();
    expect(componentText(interaction.editReply.mock.calls.at(-1)?.[0]))
      .toContain('Your alerts are off, so I didn’t send any DMs');
  });

  it('re-reads notification state after a manual check before delivering DMs', async () => {
    const interaction = {
      user: { id: 'discord-user' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    const statusService = {
      get: vi.fn()
        .mockReturnValueOnce({ config: { language: 'en', enabled: true } })
        .mockReturnValueOnce({ config: { language: 'en', enabled: false } }),
    };
    const notificationService = { deliverPending: vi.fn() };

    await handleCheck(
      interaction as never,
      { check: vi.fn().mockResolvedValue({
        status: 'success',
        checkedCount: 1,
        notificationCandidates: [],
        failedItems: [],
        unavailableItems: [],
        upcomingCount: 0,
        unknownPriceCount: 0,
      }) } as never,
      statusService as never,
      notificationService as never,
    );

    expect(statusService.get).toHaveBeenCalledTimes(2);
    expect(notificationService.deliverPending).not.toHaveBeenCalled();
    expect(componentText(interaction.editReply.mock.calls.at(-1)?.[0]))
      .toContain('Your alerts are off');
  });

  it('rejects setup when Steam reports an inaccessible wishlist', async () => {
    const interaction = {
      user: { id: 'discord-user' },
      options: {
        getString: vi.fn((name: string) => {
          if (name === 'language') return 'en';
          if (name === 'store-country') return 'US';
          return '76561198000000000';
        }),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    const service = {
      configure: vi.fn().mockRejectedValue(
        new SteamWishlistError('STEAM_WISHLIST_INACCESSIBLE', 'private wishlist'),
      ),
    };

    const onWishlistHidden = vi.fn(() => {
      // The DM never runs ahead of the panel that already shows the fix.
      expect(interaction.editReply).toHaveBeenCalled();
    });

    await handleSetup(interaction as never, service as never, undefined, { onWishlistHidden });

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const panel = componentText(interaction.editReply.mock.calls.at(-1)?.[0]);
    expect(panel).toContain('I can’t see your Steam wishlist');
    expect(panel).toContain('https://steamcommunity.com/my/edit/settings');
    expect(onWishlistHidden).toHaveBeenCalledTimes(1);
    expect(onWishlistHidden).toHaveBeenCalledWith('discord-user', 'en');
  });

  it('sends no hidden-wishlist DM when setup fails for another reason', async () => {
    const interaction = {
      user: { id: 'discord-user' },
      options: { getString: vi.fn((name: string) => (name === 'language' ? 'en' : name === 'store-country' ? 'US' : '76561198000000000')) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    const service = { configure: vi.fn().mockRejectedValue(new SteamWishlistError('STEAM_TIMEOUT', 'timed out')) };
    const onWishlistHidden = vi.fn();

    await handleSetup(interaction as never, service as never, undefined, { onWishlistHidden });

    expect(onWishlistHidden).not.toHaveBeenCalled();
  });

  it.each([
    ['tr', 'Steam profilini buldum'],
    ['en', 'I found your Steam profile'],
  ] as const)('confirms a verified setup in %s', async (language, expectedText) => {
    const interaction = {
      user: { id: 'discord-user' },
      options: {
        getString: vi.fn((name: string) => {
          if (name === 'language') return language;
          if (name === 'store-country') return 'US';
          return 'steamcommunity.com/id/example-name';
        }),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    const service = {
      configure: vi.fn().mockResolvedValue({
        config: { language },
        summary: { status: 'sent', saleCount: 2 },
      }),
    };

    await handleSetup(interaction as never, service as never);

    expect(service.configure).toHaveBeenCalledWith(
      'discord-user',
      'steamcommunity.com/id/example-name',
      language,
      'US',
    );
    expect(componentText(interaction.editReply.mock.calls.at(-1)?.[0])).toContain(expectedText);
  });

  it.each([
    ['steam-unavailable', 'couldn’t reach Steam prices'],
    ['persistence-error', 'couldn’t reach Steam prices'],
    ['dm-transient-failed', 'stopped the welcome message'],
  ] as const)('keeps setup successful when the initial summary result is %s', async (
    status,
    expectedText,
  ) => {
    const interaction = {
      user: { id: 'discord-user' },
      options: {
        getString: vi.fn((name: string) => {
          if (name === 'language') return 'en';
          if (name === 'store-country') return 'US';
          return '76561198000000000';
        }),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await handleSetup(
      interaction as never,
      {
        configure: vi.fn().mockResolvedValue({
          config: { language: 'en' },
          summary: { status },
        }),
      } as never,
    );

    expect(componentText(interaction.editReply.mock.calls.at(-1)?.[0])).toContain(expectedText);
    expect(componentText(interaction.editReply.mock.calls[0]?.[0]))
      .toContain('I’m now keeping an eye on your wishlist');
  });

  it('accepts the legacy steamid64 payload while global command changes propagate', async () => {
    const interaction = {
      user: { id: 'discord-user' },
      options: {
        getString: vi.fn((name: string) => {
          if (name === 'steam-profile') return null;
          if (name === 'steamid64') return '76561198000000000';
          if (name === 'store-country') return null;
          return 'en';
        }),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    const service = {
      configure: vi.fn().mockResolvedValue({
        config: { language: 'en' },
        summary: { status: 'sent', saleCount: 0 },
      }),
    };

    await handleSetup(interaction as never, service as never);

    expect(service.configure).toHaveBeenCalledWith(
      'discord-user',
      '76561198000000000',
      'en',
      undefined,
    );
  });

  it.each([
    [
      'STEAM_PROFILE_INVALID',
      'Invalid Steam profile input',
      'doesn’t look like a Steam profile',
    ],
    [
      'STEAM_VANITY_NOT_FOUND',
      'Vanity not found',
      'couldn’t find a Steam profile with that name',
    ],
    [
      'STEAM_VANITY_UNAVAILABLE',
      'technical endpoint detail secret-api-key',
      'can’t look up Steam profile names right now',
    ],
    [
      'STEAM_WEB_API_KEY_MISSING',
      'secret-api-key is absent',
      'Looking up profiles by name is off right now',
    ],
  ] as const)('localizes safe setup identity error %s', async (code, detail, expectedText) => {
    const interaction = {
      user: { id: 'discord-user' },
      options: {
        getString: vi.fn((name: string) => {
          if (name === 'language') return 'en';
          if (name === 'store-country') return 'US';
          return 'example-name';
        }),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await handleSetup(
      interaction as never,
      {
        configure: vi.fn().mockRejectedValue(new SteamIdentityError(code, detail)),
      } as never,
    );

    const content = componentText(interaction.editReply.mock.calls[0]?.[0]);
    expect(content).toContain(expectedText);
    expect(content).not.toContain('secret-api-key');
    expect(content).not.toContain('endpoint');
  });
});
