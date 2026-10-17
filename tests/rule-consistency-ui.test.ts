import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WishlistItem } from '../src/domain/steam.js';
import { buildAssistantView, matchesRule, staleTarget } from '../src/discord/assistant-view.js';
import type { GameRule } from '../src/persistence/assistant-repository.js';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';

const eurSale: WishlistItem = {
  appId: 10, name: 'Euro Game', priority: null, dateAdded: null, onSale: true,
  price: { currency: 'EUR', initialMinor: 2000, finalMinor: 1000, discountPercent: 50, isFree: false },
};
const usdTarget: GameRule = { mode: 'target', percent: null, targetMinor: 500, currency: 'USD', muted: false, revision: 1 };
const config = {
  discordUserId: 'u', configurationId: 'c', steamId64: '76561198000000000', configVersion: 1, language: 'tr',
  storeCountryCode: 'DE', enabled: true, minimumDiscountPercent: 30, createdAt: '', updatedAt: '',
} as never;

describe('a target left in an old currency', () => {
  it('falls back to the default discount rule, exactly like the alerts do', () => {
    expect(staleTarget(eurSale, usdTarget)).toBe(true);
    expect(matchesRule(eurSale, usdTarget, 30)).toBe(true);
    expect(matchesRule(eurSale, usdTarget, 60)).toBe(false);
    expect(staleTarget(eurSale, { ...usdTarget, currency: 'EUR' })).toBe(false);
    expect(matchesRule(eurSale, { ...usdTarget, currency: 'EUR' }, 30)).toBe(false);
  });

  it('says so in the wishlist and in the game detail', () => {
    const data = {
      config, items: [eurSale], capturedAt: '2026-10-04T00:00:00.000Z', rules: new Map([[10, usdTarget]]), history: [],
      preference: { mode: 'instant' as const, timezone: null, quietStart: null, quietEnd: null, digestMinute: null },
    };
    const list = JSON.stringify(buildAssistantView(data, { screen: 'wishlist', page: 0, query: '', eligibleOnly: false }, 's').toJSON());
    expect(list).toContain('oyunun hedef fiyatı eski para biriminde');
    expect(list).toContain('yenisini kaydedene kadar genel kuralın geçerli');
    const detail = JSON.stringify(buildAssistantView(data,
      { screen: 'detail', page: 0, query: '', eligibleOnly: false, selectedAppId: 10 }, 's').toJSON());
    expect(detail).toContain('eski para biriminde');
    expect(detail).toContain('indirim en az 10 puan daha artarsa haber veririm');
  });
});

describe('one wishlist snapshot per user', () => {
  it('keeps showing the latest read after a language change and drops older ones', () => {
    const database = createDatabase(':memory:');
    try {
      const users = new UserConfigRepository(database);
      const states = new WishlistStateRepository(database);
      const turkish = users.upsert('u', '76561198000000000', 'tr', 'TR', '2026-10-04T00:00:00.000Z');
      states.assistant.saveSnapshot(turkish, { items: [eurSale], errors: [] }, '2026-10-04T01:00:00.000Z');
      const english = users.setLanguage('u', 'en', '2026-10-04T02:00:00.000Z')!;

      expect(states.assistant.snapshot(english)).toMatchObject({ language: 'tr', capturedAt: '2026-10-04T01:00:00.000Z' });
      states.assistant.saveSnapshot(english, { items: [eurSale], errors: [] }, '2026-10-04T03:00:00.000Z');
      expect(database.prepare('SELECT language FROM wishlist_snapshot').all()).toEqual([{ language: 'en' }]);
      // Switching back never resurrects the old Turkish read.
      const backToTurkish = users.setLanguage('u', 'tr', '2026-10-04T04:00:00.000Z')!;
      expect(states.assistant.snapshot(backToTurkish)).toMatchObject({ language: 'en', capturedAt: '2026-10-04T03:00:00.000Z' });
    } finally {
      database.close();
    }
  });
});

describe('upgrading to alert levels', () => {
  it('counts an alerted or baselined ongoing sale as already alerted, so the upgrade sends nothing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dealio-alert-levels-'));
    const path = join(directory, 'wishlist.db');
    try {
      const current = createDatabase(path);
      const users = new UserConfigRepository(current);
      const states = new WishlistStateRepository(current);
      const user = users.upsert('u', '76561198000000000', 'en', 'US', '2026-10-04T00:00:00.000Z');
      const sale = (appId: number, discountPercent: number): WishlistItem => ({
        appId, name: `Game ${appId}`, priority: null, dateAdded: null, onSale: discountPercent > 0,
        price: { currency: 'USD', initialMinor: 1000, finalMinor: 1000 - discountPercent * 10, discountPercent, isFree: false },
      });
      const observe = (item: WishlistItem, at: string, baseline = false) => states.recordObservation(user, {
        item, saleKey: item.onSale ? `USD:1000:${item.price!.finalMinor}:${item.price!.discountPercent}` : null, observedAt: at,
      }, { baseline });
      observe(sale(1, 40), '2026-10-04T01:00:00.000Z', true);
      observe(sale(2, 0), '2026-10-04T01:00:00.000Z');
      observe(sale(2, 50), '2026-10-04T01:10:00.000Z');
      current.exec(`UPDATE wishlist_item_state SET alerted_discount_percent = NULL;
        UPDATE notification_log SET status = 'sent';
        ALTER TABLE wishlist_item_state DROP COLUMN alerted_discount_percent;
        ALTER TABLE game_rule DROP COLUMN alerted_minor;
        PRAGMA user_version = 11;`);
      current.close();

      const migrated = createDatabase(path);
      try {
        expect(migrated.prepare('SELECT app_id, alerted_discount_percent FROM wishlist_item_state ORDER BY app_id').all())
          .toEqual([{ app_id: 1, alerted_discount_percent: 40 }, { app_id: 2, alerted_discount_percent: 50 }]);
      } finally {
        migrated.close();
      }
      const check = new DatabaseSync(path);
      expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(15);
      check.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
