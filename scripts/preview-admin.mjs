// Starts the admin panel against an in-memory database filled with explicitly
// synthetic users, servers and games, so the UI can be reviewed without Discord
// or production data. Run `npm run preview:admin`, then open the printed URL.
import { AdminSessions } from '../dist/admin/admin-auth.js';
import { adminUiDirectory } from '../dist/admin/admin-panel.js';
import { readRoutes } from '../dist/admin/admin-routes.js';
import { AdminServer } from '../dist/admin/admin-server.js';
import { LogBuffer } from '../dist/admin/log-buffer.js';
import { AdminQueryService } from '../dist/application/admin/admin-query-service.js';
import { AdminRepository } from '../dist/persistence/admin-repository.js';
import { createDatabase } from '../dist/persistence/database.js';
import { PollScheduleRepository } from '../dist/persistence/poll-schedule-repository.js';
import { UserConfigRepository } from '../dist/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../dist/persistence/wishlist-state-repository.js';
import { actionRoutes } from '../dist/admin/admin-action-routes.js';
import { AdminActionService } from '../dist/application/admin/admin-action-service.js';
import { BroadcastService } from '../dist/application/admin/broadcast-service.js';
import { RuntimeSettings } from '../dist/application/admin/runtime-settings.js';
import { AdminControlRepository } from '../dist/persistence/admin-control-repository.js';
import { BroadcastRepository } from '../dist/persistence/broadcast-repository.js';
import { TelemetryRepository } from '../dist/persistence/telemetry-repository.js';

const port = Number(process.argv[2] ?? 8790);
const token = 'preview-only-token-0123456789abcdef';
const now = Date.now();
const iso = (offsetMs) => new Date(now - offsetMs).toISOString();
const day = 86_400_000;
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (list) => list[Math.floor(random() * list.length)];

const games = [
  [1091500, 'Cyberpunk 2077'], [292030, 'The Witcher 3: Wild Hunt'], [1245620, 'ELDEN RING'],
  [1086940, "Baldur's Gate 3"], [413150, 'Stardew Valley'], [367520, 'Hollow Knight'], [1145360, 'Hades'],
  [814380, 'Sekiro: Shadows Die Twice'], [1174180, 'Red Dead Redemption 2'], [990080, 'Hogwarts Legacy'],
  [2050650, 'Resident Evil 4'], [1817070, "Marvel's Spider-Man Remastered"], [1593500, 'God of War'],
  [1144200, 'Ready or Not'], [1426210, 'It Takes Two'], [105600, 'Terraria'], [646570, 'Slay the Spire'],
  [1794680, 'Vampire Survivors'], [2379780, 'Balatro'], [1716740, 'Starfield'],
];
const countries = [['TR', 'USD', 'tr'], ['TR', 'USD', 'tr'], ['TR', 'USD', 'tr'], ['DE', 'EUR', 'de'],
  ['US', 'USD', 'en'], ['FR', 'EUR', 'fr'], ['GB', 'GBP', 'en'], ['TR', 'USD', 'en']];

const database = createDatabase(':memory:');
const users = [];
for (let index = 0; index < 46; index += 1) {
  const id = String(400000000000000000n + BigInt(index * 7919));
  const [country, currency, language] = pick(countries);
  const createdAt = iso(Math.floor(random() * 80 * day));
  const blocked = index % 17 === 5;
  const enabled = blocked ? 0 : index % 9 === 4 ? 0 : 1;
  users.push({ id, country, currency });
  database.prepare(`INSERT INTO user_config (discord_user_id, steam_id64, language, enabled, created_at, updated_at,
      config_version, minimum_discount_percent, configuration_id, store_country_code, dm_opt_in_at,
      dm_delivery_blocked_at, dm_delivery_error_code)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(id, String(76561198000000000n + BigInt(index * 31337)), language,
    enabled, createdAt, createdAt, pick([0, 0, 20, 50]), crypto.randomUUID(), country, createdAt,
    blocked ? iso(3 * day) : null, blocked ? '50007' : null);
  const status = index % 13 === 3 ? 'unavailable' : index % 19 === 7 ? 'failed' : 'success';
  database.prepare(`INSERT INTO check_state (discord_user_id, last_started_at, last_completed_at, last_status, last_error_code,
      last_success_completed_at, last_success_checked_count, last_success_on_sale_count, last_success_free_count,
      last_success_unknown_price_count, last_success_failed_item_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`)
    .run(id, iso(20 * 60_000), iso(19 * 60_000), status,
      status === 'unavailable' ? 'STEAM_WISHLIST_INACCESSIBLE' : status === 'failed' ? 'STEAM_UPSTREAM_ERROR' : null,
      iso(19 * 60_000), 0, 0);
  const owned = games.filter(() => random() < 0.45);
  const items = owned.map(([appId, name], position) => {
    const discount = random() < 0.35 ? pick([10, 25, 33, 50, 60, 75, 90]) : 0;
    const initial = pick([999, 1999, 2999, 3999, 5999, 6999]);
    return { appId, name, priority: position, dateAdded: Math.floor((now - random() * 400 * day) / 1000), onSale: discount > 0,
      price: { currency, initialMinor: initial, finalMinor: Math.round(initial * (100 - discount) / 100), discountPercent: discount, isFree: false } };
  });
  database.prepare('INSERT INTO wishlist_snapshot VALUES (?, 1, ?, ?, ?)')
    .run(id, language, iso(19 * 60_000), JSON.stringify({ items, errors: [] }));
  for (const item of items) {
    database.prepare(`INSERT INTO wishlist_item_state (discord_user_id, steam_id64, config_version, app_id, on_sale, sale_episode_id,
        currency, normal_price_minor, final_price_minor, discount_percent, last_seen_at, store_country_code)
      VALUES (?, 'x', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, item.appId, item.onSale ? 1 : 0, item.onSale ? `e-${item.appId}` : null,
      currency, item.price.initialMinor, item.price.finalMinor, item.price.discountPercent, iso(19 * 60_000), country);
    if (random() < 0.12) {
      database.prepare(`INSERT INTO game_rule (discord_user_id, config_version, app_id, mode, percent, muted, updated_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`).run(id, item.appId, random() < 0.5 ? 'percent' : 'inherit', 40, random() < 0.4 ? 1 : 0, iso(day));
    }
    if (item.onSale && random() < 0.8) {
      const sentAt = iso(Math.floor(random() * 28 * day));
      const statusName = random() < 0.9 ? 'sent' : pick(['failed', 'terminal_failed', 'candidate']);
      database.prepare(`INSERT INTO notification_log (discord_user_id, steam_id64, config_version, app_id, sale_episode_id, sale_key,
          game_name, currency, normal_price_minor, final_price_minor, discount_percent, status, attempt_count, created_at,
          last_attempt_at, delivered_at, store_country_code, last_error)
        VALUES (?, 'x', 1, ?, ?, 'k', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(id, item.appId, `e-${item.appId}`, item.name, currency,
        item.price.initialMinor, item.price.finalMinor, item.price.discountPercent, statusName, sentAt, sentAt,
        statusName === 'sent' ? sentAt : null, country,
        // Discord's own messages, as older alert rows keep them.
        statusName === 'terminal_failed' ? pick(['Cannot send messages to this user due to having no mutual guilds',
          'Cannot send messages to this user', 'Internal Server Error']) : null);
    }
  }
}
database.prepare("INSERT OR REPLACE INTO wishlist_poll_schedule VALUES ('wishlist', ?)").run(new Date(now + 11 * 60_000).toISOString());

const names = ['Mert', 'Zeynep', 'Lukas', 'Camille', 'Alex', 'Elif', 'Can', 'Sophie', 'Ahmet', 'Emma', 'Deniz', 'Noah'];
const profile = (id, index) => ({ id, username: `${names[index % names.length].toLowerCase()}${index}`, globalName: `${names[index % names.length]} (örnek)`,
  avatarUrl: `https://cdn.discordapp.com/embed/avatars/${index % 6}.png`, createdAt: iso((900 + index * 37) * day), bot: false });
const guilds = ['Örnek Oyun Kulübü', 'Synthetic Deals', 'Test Lobisi', 'Beispiel Server', 'Serveur Démo'].map((name, index) => ({
  id: String(900000000000000000n + BigInt(index)), name, iconUrl: null, memberCount: [1240, 86, 12, 431, 57][index],
  ownerId: users[index].id, joinedAt: iso((index * 9 + 2) * day), createdAt: iso((700 + index * 50) * day),
  preferredLocale: ['tr', 'en-US', 'tr', 'de', 'fr'][index], large: index === 0, description: null,
  features: index === 0 ? ['COMMUNITY'] : [],
}));
const directory = {
  status: () => ({ ready: true, pingMs: 48, botUser: { ...profile('1', 3), username: 'Dealio (önizleme)', bot: true } }),
  guilds: () => guilds,
  applicationCounts: async () => ({ approximateGuildCount: guilds.length, approximateUserInstallCount: 38 }),
  users: async (ids) => new Map(ids.map((id) => [id, profile(id, users.findIndex((user) => user.id === id) + 1)])),
};

// Synthetic usage telemetry and server history.
const telemetry = new TelemetryRepository(database);
const controls = new AdminControlRepository(database);
const broadcasts = new BroadcastRepository(database);
// Action codes as the bot records them (src/discord/interaction-telemetry.ts).
const actionsList = ['/dealio', '/dealio', '/dealio', 'assistant:tab-games', 'assistant:next', 'assistant:game', 'dealio:tab-alerts',
  'dealio-open:home', 'status-v2:minimum-discount', '/setup', 'setup:confirm', 'dealio:check', 'dealio:deals', 'assistant:target'];
for (const [index, user] of users.entries()) {
  const guild = index % 4 === 3 ? null : guilds[index % guilds.length];
  for (let event = 0; event < 4 + Math.floor(random() * 30); event += 1) {
    telemetry.recordInteraction({ discordUserId: user.id, guildId: guild && random() < 0.8 ? guild.id : null,
      context: guild ? 'guild' : 'bot_dm', install: guild ? 'guild' : 'user', kind: 'command', action: pick(actionsList),
      locale: pick(['tr', 'tr', 'en-US', 'de', 'fr']), occurredAt: iso(Math.floor(random() * 29 * day)) });
  }
  telemetry.recordInteraction({ discordUserId: user.id, guildId: null, context: 'unknown', install: 'unknown', kind: 'setup',
    action: 'prepare-ok', locale: null, occurredAt: iso(Math.floor(random() * 29 * day)) });
  telemetry.recordInteraction({ discordUserId: user.id, guildId: null, context: 'unknown', install: 'unknown', kind: 'setup',
    action: 'confirm-ok', locale: null, occurredAt: iso(Math.floor(random() * 29 * day)) });
}
for (let index = 0; index < 9; index += 1) {
  telemetry.recordInteraction({ discordUserId: String(500000000000000000n + BigInt(index)), guildId: guilds[0].id, context: 'guild',
    install: 'guild', kind: 'setup', action: pick(['prepare-failed:STEAM_WISHLIST_INACCESSIBLE', 'prepare-failed:STEAM_NOT_FOUND',
      'prepare-failed:SetupCapacityReachedError']), locale: null, occurredAt: iso(Math.floor(random() * 20 * day)) });
}
for (const guild of guilds) telemetry.recordGuildEvent({ guildId: guild.id, guildName: guild.name, memberCount: guild.memberCount, event: 'join', occurredAt: guild.joinedAt });
telemetry.recordGuildEvent({ guildId: '900000000000000099', guildName: 'Eski Test Sunucusu', memberCount: 4, event: 'join', occurredAt: iso(60 * day) });
telemetry.recordGuildEvent({ guildId: '900000000000000099', guildName: 'Eski Test Sunucusu', memberCount: 4, event: 'leave', occurredAt: iso(12 * day) });
controls.audit('system.settings', null, '{"presenceText":"Steam indirimlerini izliyor"}', 'ok', iso(2 * day));
controls.audit('user.check', users[0].id, null, 'ok', iso(day));

const logs = new LogBuffer();
logs.install();
const wishlistState = new WishlistStateRepository(database);
const adminRepository = new AdminRepository(database);
const settings = new RuntimeSettings(controls, null);
const broadcastService = new BroadcastService({
  repository: broadcasts,
  users: () => adminRepository.users(),
  isBlocked: (id) => controls.isUserBlocked(id),
  // Preview only: nothing is sent to Discord.
  sender: { send: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return { messageId: String(Date.now()) }; } },
  onDmBlocked: () => undefined,
  intervalMs: 300,
});
broadcastService.start();
const userConfigRepository = new UserConfigRepository(database);
const fakeUsers = {
  get: (id) => userConfigRepository.findByDiscordUserId(id),
  setEnabled: async (id, enabled) => userConfigRepository.setEnabled(id, enabled, new Date().toISOString()),
  setStoreCountry: async (id, code) => userConfigRepository.setStoreCountryCode(id, code, new Date().toISOString()),
  setLanguage: async (id, language) => userConfigRepository.setLanguage(id, language, new Date().toISOString()),
  deleteData: async (id) => userConfigRepository.deleteByDiscordUserId(id),
};
const query = new AdminQueryService({
  adminRepository,
  userConfigRepository,
  assistant: wishlistState.assistant,
  pollSchedule: new PollScheduleRepository(database),
  directory,
  schedulerStatus: () => ({ intervalMs: 1_800_000, running: false, runStartedAt: null, paused: settings.scansPaused(), lastRun: {
    userCount: 40, completedCount: 40, errorCount: 2, startedAt: iso(19 * 60_000), completedAt: iso(18 * 60_000), durationMs: 64_000,
    checkedGames: 3120, steamItemErrors: 3, unknownPrices: 1, unavailable: 1, dmSent: 4, dmFailed: 0 } }),
  telemetry,
  controls,
  broadcasts,
  runtimeSettings: () => settings.snapshot(),
  databasePath: ':memory:',
  settings: { pollIntervalHours: 0.5, notificationRetryIntervalSeconds: 60,
    priceHistoryEnabled: true, steamVanityEnabled: true, production: false },
});
const actions = new AdminActionService({
  users: fakeUsers,
  checks: { check: async () => ({ status: 'success', checkedCount: 12 }) },
  notifications: { deliverPending: async () => ({ candidateCount: 0, sentCount: 0, failedCount: 0 }) },
  testNotifications: { send: async () => undefined },
  scheduler: { runNow: () => true },
  retryScheduler: { runOnce: async () => ({ userCount: 0 }) },
  controls,
  broadcasts: broadcastService,
  settings,
  telemetry,
  applyPresence: () => undefined,
  // Preview only: the process keeps running, so the panel's restart screen returns at once.
  requestExit: (mode) => console.log(`${new Date().toISOString()} [preview] Owner ${mode} requested; the preview keeps running.`),
  guilds: { name: (id) => guilds.find((guild) => guild.id === id)?.name ?? null, leave: async (id) => guilds.some((guild) => guild.id === id) },
});
const server = new AdminServer({
  port, sessions: new AdminSessions(token), staticDirectory: adminUiDirectory(),
  routes: [...readRoutes({ query, logs }), ...actionRoutes({ actions, query, broadcasts: broadcastService })],
});
await server.start();
console.log(`Admin preview (synthetic data): http://localhost:${port}/  token: ${token}`);
setInterval(() => console.log(`${new Date().toISOString()} [scheduler] Check completed (${Math.ceil(random() * 40)}/40): status=success.`), 4000).unref();
setInterval(() => console.error(`${new Date().toISOString()} [scheduler] Check completed: status=unavailable code=STEAM_WISHLIST_INACCESSIBLE.`), 15000).unref();
process.on('SIGINT', () => { void server.stop().then(() => process.exit(0)); });
