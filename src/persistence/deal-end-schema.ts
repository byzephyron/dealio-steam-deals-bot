import type { DatabaseSync } from 'node:sqlite';

/**
 * v17: when a sale (wishlist_item_state) or a met target (game_rule) last ended.
 * Steam's store can answer one read with the price from before the daily change,
 * so a deal can seem to end and start again within minutes. Until the next Steam
 * price change, a deal that comes back keeps the alert level it already had.
 */
export function migrateDealEnds(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version >= 17) return;
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name));
  try {
    db.exec('BEGIN IMMEDIATE');
    // An empty column list means the table is missing (a partial legacy schema).
    for (const [table, column] of [['wishlist_item_state', 'sale_ended_at'], ['game_rule', 'target_ended_at']] as const) {
      const existing = columns(table);
      if (existing.size > 0 && !existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    db.exec('PRAGMA user_version = 17');
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
