import type { DatabaseSync } from 'node:sqlite';

/**
 * v16: how long Steam has kept a followed wishlist hidden, and the one DM that tells
 * the user how to fix it. `wishlist_hidden_checks` counts consecutive checks that
 * Steam answered "private" (a single answer can be a Steam hiccup); the notice
 * columns record the attempt before Discord is called and the delivery after it.
 * A successful read clears all four, so the next hidden period gets its own DM.
 */
export function migrateWishlistHiddenNotice(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version >= 16) return;
  const columns = new Set((db.prepare('PRAGMA table_info(check_state)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  try {
    db.exec('BEGIN IMMEDIATE');
    if (!columns.has('wishlist_hidden_checks')) {
      db.exec('ALTER TABLE check_state ADD COLUMN wishlist_hidden_checks INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('wishlist_hidden_notice_attempt_at')) {
      db.exec('ALTER TABLE check_state ADD COLUMN wishlist_hidden_notice_attempt_at TEXT');
    }
    if (!columns.has('wishlist_hidden_notice_attempts')) {
      db.exec('ALTER TABLE check_state ADD COLUMN wishlist_hidden_notice_attempts INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('wishlist_hidden_notice_sent_at')) {
      db.exec('ALTER TABLE check_state ADD COLUMN wishlist_hidden_notice_sent_at TEXT');
    }
    // A wishlist already hidden at upgrade counts as one hidden check, so the next
    // "private" answer confirms it instead of starting the count from zero.
    db.exec(`UPDATE check_state SET wishlist_hidden_checks = 1
      WHERE last_status = 'unavailable' AND last_error_code = 'STEAM_WISHLIST_INACCESSIBLE'`);
    db.exec('PRAGMA user_version = 16');
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
