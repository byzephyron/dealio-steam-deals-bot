import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { handleSetup } from '../src/discord/commands/setup.js';
import { buildSetupWishlistHiddenPanel } from '../src/discord/setup-view.js';
import { SteamWishlistError } from '../src/domain/steam.js';
import { languages } from '../src/domain/user-config.js';

class SetupCollectorFake extends EventEmitter {
  public stop(reason?: string): void {
    this.emit('end', [], reason);
  }
}

const hidden = () => new SteamWishlistError('STEAM_WISHLIST_INACCESSIBLE', 'private wishlist');
const prepared = {
  discordUserId: 'discord-user', steamId64: '76561198000000000', language: 'tr', storeCountryCode: 'TR',
};

function setupInteraction(collector: SetupCollectorFake) {
  return {
    id: 'setup-session',
    locale: 'tr',
    user: { id: 'discord-user' },
    client: { user: null },
    options: { getString: vi.fn().mockReturnValue(null) },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ createMessageComponentCollector: vi.fn().mockReturnValue(collector) }),
  };
}

function startWithModal(profile: string, country: string) {
  const modal = {
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    fields: { getTextInputValue: () => profile, getStringSelectValues: () => [country] },
  };
  return {
    customId: 'setup:setup-session:start',
    user: { id: 'discord-user' },
    showModal: vi.fn().mockResolvedValue(undefined),
    awaitModalSubmit: vi.fn().mockResolvedValue(modal),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  };
}

const retryClick = () => ({ customId: 'setup:setup-session:retry', deferUpdate: vi.fn().mockResolvedValue(undefined) });
const lastPayload = (interaction: ReturnType<typeof setupInteraction>) =>
  JSON.stringify(interaction.editReply.mock.calls.at(-1)?.[0]);

describe('setup on a hidden wishlist', () => {
  it('shows the steps and retries with the same profile and region, without the form', async () => {
    const collector = new SetupCollectorFake();
    const interaction = setupInteraction(collector);
    const service = {
      hasExistingConfiguration: vi.fn().mockReturnValue(false),
      prepare: vi.fn()
        .mockRejectedValueOnce(hidden())
        .mockRejectedValueOnce(hidden())
        .mockResolvedValueOnce(prepared),
      confirm: vi.fn(), configure: vi.fn(),
    };
    const onWishlistHidden = vi.fn();
    const handling = handleSetup(interaction as never, service as never, undefined, { onWishlistHidden });
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());
    const start = startWithModal('https://steamcommunity.com/id/someone', 'DE');
    collector.emit('collect', start);

    await vi.waitFor(() => expect(lastPayload(interaction)).toContain('İstek listen gizli görünüyor'));
    let payload = lastPayload(interaction);
    expect(payload).toContain('setup:setup-session:retry');
    expect(payload).toContain('https://steamcommunity.com/my/edit/settings');
    expect(payload).toContain('setup:setup-session:start');
    expect(payload).toContain('Oyun ayrıntıları');
    expect(onWishlistHidden).toHaveBeenCalledWith('discord-user', 'tr');

    // Still hidden: the same panel, saying Steam can take a moment.
    collector.emit('collect', retryClick());
    await vi.waitFor(() => expect(lastPayload(interaction)).toContain('Hâlâ gizli görünüyor'));
    payload = lastPayload(interaction);
    expect(payload).toContain('setup:setup-session:retry');

    // Now public: straight to the confirmation, the form was never shown again.
    collector.emit('collect', retryClick());
    await vi.waitFor(() => expect(service.prepare).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(lastPayload(interaction)).toContain('setup:setup-session:confirm'));
    for (const call of service.prepare.mock.calls) {
      expect(call).toEqual(['discord-user', 'https://steamcommunity.com/id/someone', 'tr', 'DE']);
    }
    expect(start.showModal).toHaveBeenCalledOnce();
    expect(service.confirm).not.toHaveBeenCalled();
    collector.emit('end', [], 'time');
    await handling;
  });

  it('keeps the general error panel for other Steam failures, and ignores a stray retry', async () => {
    const collector = new SetupCollectorFake();
    const interaction = setupInteraction(collector);
    const service = {
      hasExistingConfiguration: vi.fn().mockReturnValue(false),
      prepare: vi.fn().mockRejectedValue(new SteamWishlistError('STEAM_TIMEOUT', 'timeout')),
      confirm: vi.fn(), configure: vi.fn(),
    };
    const handling = handleSetup(interaction as never, service as never);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());
    collector.emit('collect', startWithModal('76561198000000000', 'TR'));
    await vi.waitFor(() => expect(lastPayload(interaction)).toContain('Kurulumu bitiremedik'));
    expect(lastPayload(interaction)).not.toContain(':retry');
    const calls = interaction.editReply.mock.calls.length;
    collector.emit('collect', retryClick());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.prepare).toHaveBeenCalledOnce();
    expect(interaction.editReply.mock.calls.length).toBe(calls);
    collector.emit('end', [], 'time');
    await handling;
  });

  it.each(languages)('builds the hidden-wishlist panel in %s within Discord limits', (language) => {
    for (const stillHidden of [false, true]) {
      const json = JSON.stringify(buildSetupWishlistHiddenPanel(language, 'session', stillHidden).toJSON());
      expect(json).toContain('setup:session:retry');
      expect(json).toContain('https://steamcommunity.com/my/edit/settings');
    }
  });
});
