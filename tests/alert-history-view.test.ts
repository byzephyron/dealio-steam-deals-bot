import { describe, expect, it } from 'vitest';
import { buildAssistantView } from '../src/discord/assistant-view.js';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';

describe('alert history', () => {
  it('says it lists at most the 30 newest alerts of the last 30 days, as the query returns', () => {
    const database = createDatabase(':memory:');
    try {
      const config = new UserConfigRepository(database)
        .upsert('u', '76561198000000000', 'en', 'US', new Date().toISOString());
      const insert = database.prepare(`INSERT INTO notification_log (discord_user_id, steam_id64, config_version,
        store_country_code, app_id, sale_episode_id, sale_key, game_name, currency, normal_price_minor,
        final_price_minor, discount_percent, created_at) VALUES (?, ?, ?, 'US', ?, ?, 'k', ?, 'USD', 1000, 500, 50, ?)`);
      for (let index = 0; index < 35; index += 1) {
        insert.run('u', config.steamId64, config.configVersion, index + 1, `episode-${index}`, `Game ${index}`,
          new Date(Date.now() - index * 60_000).toISOString());
      }
      const history = new WishlistStateRepository(database).assistant.history('u');
      expect(history).toHaveLength(30);

      const rendered = JSON.stringify(buildAssistantView({
        config, items: [], capturedAt: new Date().toISOString(), rules: new Map(),
        preference: { mode: 'instant', timezone: null, quietStart: null, quietEnd: null, digestMinute: null }, history,
      }, { screen: 'history', page: 0, query: '', eligibleOnly: false }, 's').toJSON());
      expect(rendered).toContain('Up to 30 latest alerts from the last 30 days.');
    } finally {
      database.close();
    }
  });
});
