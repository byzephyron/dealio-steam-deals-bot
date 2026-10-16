# Architecture

## Current Design

```text
Discord commands ---------> application services ----------> SQLite
                                  ^                            |
Steam wishlist scheduler ---------+                            |
                                  |                            v
Notification retry scheduler -> durable notification queue -> Discord DM
```

## Modules

- `src/discord`: bot client, slash commands, and DM delivery
- `src/steam`: safe profile parsing, vanity resolution, wishlist retrieval, and price normalization
- `src/domain`: sale, account-generation, and duplicate-notification rules
- `src/persistence`: SQLite schema and repositories
- `src/application`: checks, both schedulers, delivery, assistant rules, lifecycle, health, and locking
- `src/price-history`: Steam historical lows from the IsThereAnyDeal API
- `src/operations`: encrypted backup envelope and the independent health-ping logic
- `scripts`: backup, restore, monitoring, metrics report, release gate, and public-site build (Node scripts run outside the bot process)

## Reliability Model

Steam responses are validated and timed out. Wishlist access uses Steam's `X-EResult` so a private wishlist is not mistaken for an empty one. App-detail requests use the user's selected Steam Store country independently from the localized Steam response language; Steam's regional currency is stored and displayed without conversion. Sale candidates, deterministic notification-panel batch membership, and delivery attempts are persisted before Discord calls. Delivery is at-least-once: an uncertain Discord outcome can cause a duplicate batch retry, but a process crash does not silently discard the durable candidates.

`SteamIdentityResolver` parses numeric IDs and `/profiles/` links locally. Vanity inputs are resolved through a URL constructed from the fixed HTTPS `ResolveVanityURL` endpoint, the environment-only API key, and a validated vanity name. User-provided URLs are never request targets. Identity resolution, canonical wishlist validation, and the final upsert execute in that order under the same per-user coordinator; only the canonical SteamID64 reaches SQLite.

`SetupService` separates read-only preparation from confirmation. The five-minute Discord Components V2 wizard resolves the identity, validates public wishlist access, suggests a Store region from the Discord locale, and exposes 24 common countries plus an alphabetical route to the complete country catalog. It displays the canonical account, editable Store region, language, polling frequency, and proactive-DM consent before writing anything. Confirmation records consent, creates a fresh pricing generation, persists a notification-free baseline, and sends one localized message whose owner-bound paginator keeps the banner visible while showing exactly one confirmed active discount at a time. A Discord 50007 (DMs closed) or 50278 (no shared server, no app install) recipient delivery error records a visible delivery block with its reason, so the panel names the right fix, and disables automatic work; a transient failure leaves the setup active without becoming a false sale.

The Wishlist tab of `/dealio` opens the assistant workflow from a persisted wishlist snapshot when one exists. It supports three-game pages (matching deals first, then the deepest discounts), name search, a matching-rule filter, game details, notification timing, and delivery history. An explicit refresh uses the coordinated check path and can update persisted observations, sale state, and candidates; it is no longer a purely read-only live fetch. `AssistantService` serializes rule/preference mutations with other user operations and rejects stale configuration identities.

The `/dealio` Home and Settings read paths perform no Steam request. They combine persisted configuration, check summaries, queue counts, and pricing context. `/dealio` additionally reads the saved assistant snapshot and current rules/preferences. Its home panel shows a large Steam game image, observed price, matching counts, and three contextual navigation sections for wishlist rules, alert timing, and history. Queue counts use canonical `notification_log` rows rather than batch parents/items.

Database migration v5 adds nullable last-success wishlist metrics to `check_state` and a singleton persisted wishlist poll schedule. Failed or unavailable checks update the latest attempt without erasing the last successful metrics; changing Steam accounts clears those metrics. The scheduler mirrors its exact next automatic target to enabled users' `next_scheduled_at` values and resumes a future persisted target after restart.

Database migration v6 adds the global `minimum_discount_percent`, config-version-scoped `game_discount_threshold` overrides, and an internal episode eligibility flag. Global thresholds survive a Steam-account change, while old game overrides remain isolated to the old configuration generation. The candidate state machine keeps first observations as a baseline, marks later not-on-sale to on-sale episodes eligible, and uses an idempotent episode-keyed insert when an eligible active sale reaches its effective threshold. Thresholds affect candidate creation only; they do not redefine Steam sale state, split episodes, or retire an already-created candidate.

Database migration v7 assigns each user configuration lifetime a random identity. Modal mutations compare this identity, and game mutations additionally compare `config_version`, so a stale interaction cannot write into a configuration deleted and recreated under the same Discord user ID.

Database migration v8 adds the selected Store country to user configuration and regional provenance to wishlist and notification records. Existing users migrate to `TR`. A Store-country change increments `config_version`, retires retryable alerts from the old pricing context, preserves discount thresholds, clears check metrics, and makes the first new-region snapshot a notification-free baseline. Current-region currencies are derived from known wishlist state for `/status`.

Database migration v9 records the user's DM opt-in timestamp and the latest permanent Discord delivery block. Existing configured users are backfilled from their original setup timestamp. Re-enabling notifications clears the delivery-block marker; a new confirmed setup also clears it.

Migration v8 also records each tracked item's latest observation as `known`, `unknown`, `error`, or `missing`. Unknown prices and item-level app-detail errors preserve the last known episode but suspend candidate and failed durable-batch claims. A later known observation resumes the same active episode without creating a duplicate and refreshes undelivered notification payloads from the confirmed price; a confirmed not-on-sale or missing item ends the episode. Already-sending batches retain at-least-once recovery semantics. All state transitions, candidate inserts or refreshes, missing reconciliation, and the successful check summary for one Steam snapshot commit in a single `BEGIN IMMEDIATE` transaction; repository methods join an existing transaction instead of committing partial item state.

Pre-v5 `next_scheduled_at` values are not imported into the singleton because that field previously had no authoritative production writer. The first v5 startup therefore performs one real scheduler cycle when no canonical target exists, then persists the exact completion-based next target.

Notification enable/disable and Store-region changes run through the same per-user coordinator as setup, checks, delivery, and deletion. Disabling preserves account generation, wishlist state, durable notification queues, batches, and history. A region change creates a safe new pricing generation while preserving applicable per-game preferences. Automatic checks distinguish their source and reject stale scheduler work after disable; notification delivery also revalidates `enabled` under the coordinator before claiming queue state. Manual `/check` deliberately remains available but skips DM delivery while disabled. The `/status` component session is owner-bound, exposes notification, threshold, and region controls, expires with disabled controls, and is stopped during application shutdown.

Steam polling defaults to a 30-minute wait after each completed scan (POLL_INTERVAL_HOURS=0.5), pulled forward to two minutes after Steam's daily 10:00 Pacific price change when that comes first; cached prices expire at that change; notification retries remain independent at 60 seconds. A shorter interval clamps a persisted future scan on restart, so changing from six hours does not retain the old six-hour wait. This is polling, not a real-time Steam event subscription. Per-user coordination serializes setup, checks, delivery, account changes, and deletion. Runtime health is written atomically without user or credential data. A process lock permits one local bot instance per SQLite database and conservatively reclaims only locks whose recorded PID is definitively absent.

Dealio is one panel with four tabs under every screen: Home, Wishlist, Alerts and Settings (`src/discord/ui/tab-bar.ts`). Only `/dealio`, `/setup` and `/delete-data` are registered; the retired `/wishlist`, `/status`, `/check`, `/region` and `/test-notification` names open the same panel if an old client still sends them. A tab click is acknowledged with `deferUpdate`; the current screen's session stops with reason `handoff`, finishes its queued edits and skips its disabled-cleanup render, then `createDealioNavigator` (`commands/dealio.ts`) opens the target screen in the same message with a new owner-bound session. Games and Alerts are screens of one assistant session and switch without a handoff. Every screen shares `src/discord/ui/design.ts`: one header pattern, an accent per tab (warnings and DM blocks still override it), the price line with the currency symbol, a strikethrough and a tier-coloured `−%90` badge (🟢 60%+, 🟡 30%+, 🟠 less; 🔥 marks only 60%+ deals), savings, and the Store-country flag. Steam's `IStoreBrowseService/GetItems` metadata request also asks for platforms, reviews and purchase options; `parseStoreFacts` keeps the review summary, platforms, Steam Deck category and the active discount end as optional `storeFacts` on each wishlist item (cached with metadata for six hours, so a passed end time is hidden). Alerts receive them at delivery from the saved snapshot like artwork; they never affect candidates or batch identity, and over Discord's text budget they are dropped before titles are shortened. A 100% discount renders as a free-to-keep alert (🎁). Discord link buttons accept only http(s), so "Open in the Steam app" points to `open.html` on the public site, which forwards only a numeric app id to `steam://store/<id>` under a hashed inline-script CSP. GetItems also asks for `include_release`: an unreleased game keeps Steam's planned date and its precision (day, month, quarter, year or Steam's own text) as `upcoming`, dropped as soon as a price is listed. A GetItems entry that is not `success: 1` becomes `STEAM_APP_REGION_UNAVAILABLE` when Steam flags a country restriction, else `STEAM_APP_NOT_FOUND` (removed). Both are permanent item errors (`isTransientItemError`): the check result reports them as `unavailableItems` and `upcomingCount`, and `unknownPriceCount` and `failedItemCount` (which drive the incomplete-check warnings) count only released games without a confirmed price and transient failures. A wishlist whose only items are permanently unavailable is a successful check. A newcomer's `/dealio` shows the setup welcome itself. Every Dealio DM (sale, digest, test, initial summary), expired panels and command notices end with a session-free `dealio-open:home` button, routed in `bot-events.ts` to a fresh ephemeral `/dealio` panel, so it keeps working after restarts. A test alert is the real alert layout with a TEST tag, built from the deepest current discount on the user's saved wishlist snapshot (muted games excluded) and its IsThereAnyDeal low; only when nothing is discounted does it use a labelled fixed example without price history. Setup, Settings and `/region` share one region picker (`ui/country-picker.ts`): popular countries, the full A–Z catalog, a name/code search and Cancel.

Discord-facing runtime messages use Components V2 with the required message flag and shared 40-component and 4,000-text-character validators. Main, status, wishlist, and check sessions live for ten minutes; setup lives for five minutes; the initial-DM paginator lives for fifteen minutes. Sessions are held only in memory, are bound to the invoking user, and disable their controls when they expire. A global component fallback returns a localized expiry panel when a button survives a restart. New sale batches contain at most five games, while previously persisted batches of up to ten remain renderable for backward-compatible delivery.


## Personal assistant schema and delivery

Migration v10 adds configuration-scoped game rules (inherit, percent, target), currency-bound target amounts, mute state, and rule revisions. Existing percentage overrides are migrated. Target crossings use durable rule-event identities; saving an already-matching rule establishes a baseline without an initial alert. A target replaces the global percentage threshold for that game.

Wishlist snapshots support fast panel opening. Steam is queried in batches of 100 apps: game names, free flags, and artwork come from `IStoreBrowseService/GetItems` (cached six hours per country/language), and prices with their currency come from `appdetails?filters=price_overview` (cached five minutes per country, and never past Steam's daily price change at 10:00 Pacific, `src/domain/steam-price-schedule.ts`). A 500-game wishlist therefore needs about ten Steam requests instead of one per game. Concurrent scans of overlapping wishlists share in-flight batches, and the original price-observation time survives cache hits. A failed batch marks only its own games as item errors, and failed or unpriced results are not cached as prices.

Notification preferences support detection-time delivery, IANA-timezone quiet hours, and a daily digest. Pending candidates remain durable while delivery is deferred. The sender revalidates them through the coordinated check path before sending; an unavailable upstream can therefore delay queued delivery. Discord message IDs record accepted delivery, not whether a user read the message.

When `ITAD_API_KEY` is set, a game's Wishlist detail panel shows its Steam price history (the low and the last five price changes, loaded beside the panel so navigation never waits), and delivery adds Steam's historical low for the user's Store region from IsThereAnyDeal (`/lookup/id/shop/61/v1`, then `/games/storelow/v2`). Only Steam app IDs and the Store country are sent, with the key in a header. Game IDs are cached in memory, lows for six hours. The line is presentation-only: it is added after a batch is claimed, never persisted or part of the batch identity, shown only when the currency matches Steam's (no conversion), and any failure omits it. When the recorded low is in an older currency (Turkey's Steam store switched from TRY to USD in 2023), the client reads that game's Steam price history (`/games/history/v2`, one request per game) and uses the lowest paid price since the current currency began; free giveaways are ignored and the alert says "lowest since <month year>" instead of "all-time". Requests time out after five seconds and a failure pauses lookups for five minutes (or longer when rate limited), so an unavailable service cannot delay deliveries.

Price observations are retained for 90 days; notification history displays 30 days. Cleanup preserves unresolved deliveries and the deduplication state of ongoing offers. Logging redacts credentials and interaction/webhook secrets. The dedicated seven-day journald policy is supplied as deployment configuration; it is not automatically activated by installing the application.

## Owner admin panel

Migration v13 adds `interaction_event`, `guild_event`, `admin_audit`, `runtime_setting`, `user_block`, `guild_block`, `broadcast` and `broadcast_recipient`. `bot-events.ts` records one usage row per command, component or modal (user, server, context, install type from `authorizingIntegrationOwners`, a session-free action name, locale) before routing; a telemetry failure is logged and never affects the reply. `SetupService` reports funnel steps through an `onStep` hook. `guild-tracking.ts` records server joins and leaves, reconciles them on ready, leaves blocked servers and applies the owner's presence text. Blocked users get one localized notice for every interaction except `/delete-data`. Usage rows and announcement deliveries are deleted with `/delete-data` and by the deletion journal after a restore; they are kept 90 days.

When `DEALIO_ADMIN_TOKEN` is set, `src/admin/admin-panel.ts` starts a `node:http` server on 127.0.0.1 (`DEALIO_ADMIN_PORT`, default 8787) that serves the prebuilt `dist/admin-ui` (Preact + htm, vendored at build time, no runtime CDN) and a JSON API. It rejects non-loopback `Host` headers, requires a token sign-in (in-memory sessions, `HttpOnly; SameSite=Strict`), a CSRF header and same-origin `Origin` for every change, and typed confirmation for destructive actions. `AdminQueryService` only reads; `AdminActionService` calls the existing services under the per-user coordinator and writes every outcome to `admin_audit`. `BroadcastService` writes all recipients first, claims one recipient at a time (`sending`), sends one DM every 1.5 seconds, defers on Discord rate limits without spending an attempt, marks 50007 and 50278 as a DM block and resumes interrupted deliveries after a restart (at-least-once). `RuntimeSettings` overrides `DEALIO_MAX_USERS` and can close sign-ups without a restart. A panel that cannot start is logged and skipped; the bot keeps running.

## Production isolation and rollout status

The production deployment uses a pinned Linux machine identity and an application-ID process lock, in addition to the database lock. The application lock is shared across database paths under the same OS user. This is a single-host safeguard, not a distributed lease guarantee.

Azure Blob leasing (`src/application/azure-lease.ts`) is implemented but **not provisioned**: startup would acquire a lease, renewal uncertainty would disconnect Discord, and orderly shutdown would release it after disconnect. The project uses no paid cloud resources, so the single-host safeguard is what protects production today.

### Operations outside the bot process

- **Backup.** A scheduled GitHub Actions job connects over a forced-command SSH key that can only run `scripts/export-backup.mjs`. The VM returns a consistent SQLite copy encrypted with the public key (`src/operations/backup-envelope.ts`); the private key never lives on the VM. The ciphertext goes to a private backup repository, one branch per weekday, so each copy is replaced after seven days; the public source repository never holds it.
- **Restore rehearsal.** A second job fetches the newest encrypted copy, decrypts it into a separate temporary copy, runs SQLite integrity and foreign-key checks, and applies the current migrations. It never touches the production database or Discord.
- **Independent alerting.** `dealio-health.timer` runs a health ping every minute, separate from the bot process, and reports only health categories to Healthchecks (no user IDs, prices, or database). A missing signal, including a powered-off VM, raises an e-mail alert. Backup and restore have their own checks.
- **Public site.** Only an allow-listed set of static files (privacy, terms, help, styles) is copied to a separate public Pages repository; user data never reaches it.
- **Release gate.** `npm run release:check` validates a release-evidence JSON, its artifact files, and the legal and help links for the exact commit. A gate counts as passed only with a recorded real run for that commit.

Setup and recovery steps are in [`deploy/FREE-OPERATIONS.tr.md`](../deploy/FREE-OPERATIONS.tr.md); VM rollout and rollback are in [`deploy/README.tr.md`](../deploy/README.tr.md).

## Local design review

Run `npm run preview:ui` to build the bot and generate `.runtime/ui-preview.html`.
The preview renders the production component builders with explicitly synthetic data.
It includes selected Turkish, English, German and French panels and synthetic states. The preview renderer may lag newer component structures. Browser rendering approximates Discord;
validate final spacing and interactions in Discord before publishing.

Panel clicks are serialized per panel and recover after failures. In the Wishlist,
Alerts and Settings panels and on tab switches, the click is answered with the new
screen itself (`component.update`, one Discord call) when that screen is ready within
1.5 s of the click; otherwise it is deferred first, as before
(`src/discord/ui/click-response.ts`, `PanelOperationQueue.enqueueClick`). A failed wishlist threshold edit
reports the error without poisoning later pagination. Steam cancellation covers
both response headers and body parsing. Contradictory price metadata is treated as
an item error, preserving the prior confirmed sale state. Malformed Discord
messages are terminal delivery failures, but only explicit recipient delivery
errors disable the user's monitoring.
