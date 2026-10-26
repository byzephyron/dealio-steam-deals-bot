import { describe, expect, it } from 'vitest';
import { createSaleKey } from '../src/domain/sale.js';
import type { WishlistItem } from '../src/domain/steam.js';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';

/** One game, a 30% default threshold, and observations ten minutes apart. */
function fixture(minimumDiscountPercent = 30) {
  const database = createDatabase(':memory:');
  const users = new UserConfigRepository(database);
  const states = new WishlistStateRepository(database);
  users.upsert('u', '76561198000000000', 'en', 'US', '2026-09-12T00:00:00.000Z');
  users.setMinimumDiscountPercent('u', minimumDiscountPercent, '2026-09-12T00:00:00.000Z');
  const config = () => users.findByDiscordUserId('u')!;
  let clock = Date.parse('2026-09-12T12:00:00.000Z');
  const observe = (discountPercent: number, options: { baseline?: boolean } = {}) => {
    clock += 10 * 60 * 1000;
    const item: WishlistItem = {
      appId: 10, name: 'A Game', priority: null, dateAdded: null, onSale: discountPercent > 0,
      price: { currency: 'USD', initialMinor: 1000, finalMinor: 1000 - discountPercent * 10, discountPercent, isFree: false },
    };
    return states.recordObservation(config(), {
      item,
      saleKey: item.onSale ? createSaleKey(item.price!) : null,
      observedAt: new Date(clock).toISOString(),
    }, options).notificationCandidate;
  };
  const markSent = (candidate: NonNullable<ReturnType<typeof observe>>) => database.prepare(
    `UPDATE notification_log SET status = 'sent' WHERE app_id = ? AND sale_episode_id = ?`,
  ).run(candidate.appId, candidate.saleEpisodeId);
  const status = (candidate: NonNullable<ReturnType<typeof observe>>) => states.findNotificationStatus(candidate);
  /** Moves the clock without an observation, e.g. past the next Steam price change. */
  const advance = (ms: number) => { clock += ms; };
  const now = () => new Date(clock).toISOString();
  return { database, users, states, config, observe, markSent, status, advance, now };
}

describe('alerts within one sale', () => {
  it('alerts again when an alerted sale gets at least ten points deeper', () => {
    const f = fixture();
    try {
      f.observe(0);
      const first = f.observe(35);
      expect(first).toMatchObject({ discountPercent: 35 });
      f.markSent(first!);
      expect(f.observe(40)).toBeNull();
      const deeper = f.observe(45);
      expect(deeper).toMatchObject({ discountPercent: 45 });
      expect(deeper!.saleEpisodeId).not.toBe(first!.saleEpisodeId);
      f.markSent(deeper!);
      expect(f.observe(50)).toBeNull();
      expect(f.observe(55)).toMatchObject({ discountPercent: 55 });
    } finally {
      f.database.close();
    }
  });

  it('lets a waiting alert carry a deeper price instead of sending two', () => {
    const f = fixture();
    try {
      f.observe(0);
      const waiting = f.observe(35);
      expect(f.observe(60)).toBeNull();
      expect(f.status(waiting!)).toBe('candidate');
      expect(f.database.prepare('SELECT discount_percent FROM notification_log').all())
        .toEqual([{ discount_percent: 60 }]);
    } finally {
      f.database.close();
    }
  });

  it('treats a sale that was below the rule at setup as a crossing once it meets the rule', () => {
    const f = fixture();
    try {
      expect(f.observe(20, { baseline: true })).toBeNull();
      expect(f.observe(25)).toBeNull();
      expect(f.observe(30)).toMatchObject({ discountPercent: 30 });
    } finally {
      f.database.close();
    }
  });

  it('does not alert for a sale that already met the rule at setup, only for a clearly deeper one', () => {
    const f = fixture();
    try {
      expect(f.observe(40, { baseline: true })).toBeNull();
      expect(f.observe(45)).toBeNull();
      expect(f.observe(50)).toMatchObject({ discountPercent: 50 });
    } finally {
      f.database.close();
    }
  });
});

describe('changing a rule mid-sale', () => {
  const scenarios = {
    'the default threshold': (f: ReturnType<typeof fixture>, percent: number) => {
      f.users.setMinimumDiscountPercent('u', percent, '2026-09-12T13:00:00.000Z');
    },
    'a game rule': (f: ReturnType<typeof fixture>, percent: number) => {
      f.states.assistant.saveRule(f.config(), 10, { mode: 'percent', percent, targetMinor: null, currency: null, muted: false });
    },
  } as const;

  for (const [name, change] of Object.entries(scenarios)) {
    it(`takes a baseline when ${name} is lowered under an ongoing sale`, () => {
      const f = fixture(50);
      try {
        f.observe(0);
        expect(f.observe(30)).toBeNull();
        change(f, 20);
        // Already true when the rule changed: no alert for it.
        expect(f.observe(30)).toBeNull();
        expect(f.observe(35)).toBeNull();
        expect(f.observe(40)).toMatchObject({ discountPercent: 40 });
      } finally {
        f.database.close();
      }
    });

    it(`keeps a waiting alert that still meets ${name}, and retires one that no longer does`, () => {
      const kept = fixture(30);
      try {
        kept.observe(0);
        const waiting = kept.observe(40);
        change(kept, 35);
        expect(kept.status(waiting!)).toBe('candidate');
      } finally {
        kept.database.close();
      }
      const retired = fixture(30);
      try {
        retired.observe(0);
        const waiting = retired.observe(40);
        change(retired, 50);
        expect(retired.status(waiting!)).toBe('expired');
        // Meeting the stricter rule later is a crossing.
        expect(retired.observe(50)).toMatchObject({ discountPercent: 50 });
      } finally {
        retired.database.close();
      }
    });
  }

  it('leaves games with their own rule alone when the default threshold changes', () => {
    const f = fixture(50);
    try {
      f.states.assistant.saveRule(f.config(), 10, { mode: 'percent', percent: 30, targetMinor: null, currency: null, muted: false });
      f.observe(0);
      const waiting = f.observe(35);
      f.users.setMinimumDiscountPercent('u', 60, '2026-09-12T13:00:00.000Z');
      expect(f.status(waiting!)).toBe('candidate');
    } finally {
      f.database.close();
    }
  });
});

describe('a sale that drops out for one read', () => {
  it('does not alert again when Steam shows the old price once after the daily change (2026-10-26)', () => {
    const f = fixture();
    try {
      const at = (iso: string, discountPercent: number) => f.states.recordObservation(f.config(), {
        item: {
          appId: 10, name: 'A Game', priority: null, dateAdded: null, onSale: discountPercent > 0,
          price: { currency: 'USD', initialMinor: 1000, finalMinor: 1000 - discountPercent * 10, discountPercent, isFree: false },
        },
        saleKey: discountPercent > 0 ? `USD:1000:${1000 - discountPercent * 10}:${discountPercent}` : null,
        observedAt: iso,
      }).notificationCandidate;
      at('2026-10-26T16:32:00.000Z', 0);
      // The sale starts at 10:00 Pacific; 10:02, 10:32 (stale, full price) and 11:02.
      const first = at('2026-10-26T17:02:00.000Z', 80);
      expect(first).toMatchObject({ discountPercent: 80 });
      f.markSent(first!);
      expect(at('2026-10-26T17:32:00.000Z', 0)).toBeNull();
      expect(at('2026-10-26T18:02:00.000Z', 80)).toBeNull();
      expect(f.database.prepare('SELECT COUNT(*) AS count FROM notification_log').get()).toEqual({ count: 1 });
      // A clearly deeper discount is still worth its own alert.
      expect(at('2026-10-26T18:32:00.000Z', 90)).toMatchObject({ discountPercent: 90 });
    } finally {
      f.database.close();
    }
  });

  it('alerts for a sale that starts again after the next Steam price change', () => {
    const f = fixture();
    try {
      f.observe(0);
      f.markSent(f.observe(35)!);
      expect(f.observe(0)).toBeNull();
      f.advance(24 * 60 * 60 * 1000);
      expect(f.observe(35)).toMatchObject({ discountPercent: 35 });
    } finally {
      f.database.close();
    }
  });

  it('keeps an alert that never reached the user for the returning sale', () => {
    const f = fixture();
    try {
      f.observe(0);
      const waiting = f.observe(35);
      expect(f.observe(0)).toBeNull();
      const again = f.observe(35);
      expect(again).toMatchObject({ discountPercent: 35 });
      expect(again!.saleEpisodeId).not.toBe(waiting!.saleEpisodeId);
    } finally {
      f.database.close();
    }
  });

  it('does not alert again for a game that Steam leaves out past the grace period on the same day', () => {
    const f = fixture();
    try {
      f.observe(0);
      f.markSent(f.observe(35)!);
      const scope = f.config();
      f.advance(5 * 60 * 1000);
      f.states.markMissingItemsInactive(scope, [], f.now());
      f.advance(25 * 60 * 1000);
      f.states.markMissingItemsInactive(scope, [], f.now());
      expect(f.states.findByDiscordUserAndAppId('u', 10)).toMatchObject({ onSale: false, saleEpisodeId: null });
      expect(f.observe(35)).toBeNull();
    } finally {
      f.database.close();
    }
  });
});
