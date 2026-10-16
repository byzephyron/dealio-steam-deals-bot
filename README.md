<p align="center">
  <img src="docs/assets/dealio-onboarding-banner.png" alt="Dealio — a blue price tag and heart on a dark background" width="960">
</p>

<h1 align="center">🎮 Your wishlist. Your rules.</h1>

<p align="center">
  A personal Steam price assistant, right inside Discord.<br>
  Pick your price. Choose when to hear about it. Let Dealio keep watch.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.tr.md">Türkçe</a>
</p>

<p align="center">
  <a href="https://discord.com/oauth2/authorize?client_id=1540325119690412172"><img src="https://img.shields.io/badge/Add_to_Discord-5865F2?style=for-the-badge&amp;logo=discord&amp;logoColor=white" alt="Add to Discord"></a>
  <a href="#a-look-inside"><img src="https://img.shields.io/badge/See_it_in_Discord-1B2838?style=for-the-badge&amp;logo=steam&amp;logoColor=white" alt="See it in Discord"></a>
  <a href="#latest-updates"><img src="https://img.shields.io/badge/What%E2%80%99s_new-8B5CF6?style=for-the-badge" alt="What's new"></a>
</p>

<p align="center">
  <a href="https://github.com/byzephyron/dealio-steam-deals-bot/releases/latest"><img src="https://img.shields.io/badge/Release-v1.0.0-8B5CF6?style=flat-square" alt="Release v1.0.0"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/Languages-TR_%C2%B7_EN_%C2%B7_DE_%C2%B7_FR-2980B9?style=flat-square" alt="Languages: Turkish, English, German, French"></a>
  <a href="#start-in-discord"><img src="https://img.shields.io/badge/Setup-no_Steam_password-238636?style=flat-square" alt="Setup: no Steam password"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2980B9?style=flat-square" alt="MIT license"></a>
</p>

---

## 🎮 Less checking. More playing.

There's a game on your Steam wishlist, but the price isn't quite right. Tell Dealio what you'd like to pay. It checks Steam at regular intervals and sends you a Discord DM when your rule is met, with everything you need to decide on the spot.

Set a different target for each game, or use one discount threshold across your list. Choose quiet hours if you don't want late-night notifications. To browse your games or change a setting, just open `/dealio`.

| 🎯 Your price | 🔕 Your schedule | 📊 Your context |
| :--- | :--- | :--- |
| Set a target price or a discount threshold for each game, or let Dealio wait for the historical low. Mute the games you want to skip. | Get alerts when detected, hold them during quiet hours in your time zone, or choose a daily digest. | See the historical low, Steam reviews, Steam Deck status and when the sale ends, right in the alert. |

<a name="a-look-inside"></a>

## 👀 A look inside Discord

<p align="center">
  <a href="docs/assets/screenshots/sale-alert-dm.png"><img src="docs/assets/screenshots/sale-alert-dm.png" alt="A Dealio sale alert DM for Red Dead Redemption 2: 75% off at $14.99, matching its all-time low, savings, sale end time, Very Positive reviews, Steam Deck status and platforms" width="760"></a><br>
  <sub><strong>📬 A sale alert in your DMs</strong> · price, savings, historical low, reviews, Steam Deck and when the sale ends</sub>
</p>

<table>
  <tr>
    <td width="33%" valign="top" align="center"><strong>🏠 Home</strong><br><sub>Your best matching deal and a quick status</sub><br><br><a href="docs/assets/screenshots/home-panel.png"><img src="docs/assets/screenshots/home-panel.png" alt="Dealio Home tab: tracking status, a matching deal with game artwork, wishlist counts and the last and next check" width="260"></a></td>
    <td width="33%" valign="top" align="center"><strong>🎮 Wishlist</strong><br><sub>Matching deals first, then the biggest discounts</sub><br><br><a href="docs/assets/screenshots/wishlist-panel.png"><img src="docs/assets/screenshots/wishlist-panel.png" alt="Dealio Wishlist tab: games with prices, discounts and rule status, search, filters and pages" width="260"></a></td>
    <td width="33%" valign="top" align="center"><strong>🎯 Game detail</strong><br><sub>Your rule, price history and a one-tap lowest-price target</sub><br><br><a href="docs/assets/screenshots/game-detail.png"><img src="docs/assets/screenshots/game-detail.png" alt="Dealio game detail for Prey: price, sale end, reviews, Steam Deck Verified, rule buttons, the historical low and recent price changes" width="260"></a></td>
  </tr>
</table>

<sub>Real Discord screenshots from 6 October 2026, with the English UI and the Türkiye Store. The DM shown is a test alert, which uses the same layout as a real one. Prices come from Steam and change over time.</sub>

<a name="whats-inside"></a>

### ✨ What's inside?

- 🏠 **One panel, four tabs.** 🏠 Home, 🎮 Wishlist, 🔔 Alerts and ⚙️ Settings switch in place inside a single `/dealio` message.
- 🎮 **A list you can browse.** Matching deals come first, then the biggest discounts. Search, filter, move through three-game pages, or open any game.
- 🎯 **A choice for each game.** Use your default discount threshold, set a different percentage, enter a target price, or tap **Alert me at the lowest** to aim for the historical low. Mute games you want to skip.
- 📈 **Prices over time.** Alerts and game details show Steam's historical low for your Store region (from IsThereAnyDeal, same currency only, never converted), and the game detail lists recent price changes.
- ⭐ **Steam's own context.** Review score, Steam Deck compatibility, platforms and the time a sale ends, whenever Steam states them. A 100% discount is shown as a free game to keep.
- 🗓️ **Honest about every game.** Unreleased games show 🗓️ *coming soon* with their release date; games not sold in your region (🚫) or removed from Steam (🗑️) are labelled as such, never as failed checks.
- 🖥️ **Straight to the store.** Open a game on the Steam website, or directly in the Steam app.
- 🔔 **Alerts on your schedule.** On detection, with quiet hours, or as a daily digest. Waiting alerts are re-checked before they're sent.
- 📬 **A record of your alerts.** See pending and sent DMs, and send a test message if delivery isn't working.
- 👤 **Switch accounts without starting over.** Change your Steam account from ⚙️ Settings; your default discount, alert timing and language stay.
- 🌍 **Turkish, English, German and French.** Setup, panels and notifications in all four, using Steam's own words for the wishlist in each language.

<a name="latest-updates"></a>

## ✨ Latest updates

> **9 October 2026 · v1.0.0: open to everyone**
>
> Dealio is now available to everyone. Add it to your Discord apps or to a server, run `/setup`, and it starts watching your wishlist. It's free, and the source code is open under the MIT license.

> **6 October 2026 · v0.2.0: one panel, richer alerts**
>
> Everything now lives in one `/dealio` panel with Home, Wishlist, Alerts and Settings tabs. Sale alerts and game details show Steam's review score, Steam Deck status, platforms and when the sale ends, next to the historical low. You can set a target at the lowest price in one tap, open a game straight in the Steam app, and see upcoming games with their release date. Setup now starts with a language choice and shows your Steam name and avatar before you confirm. [Read the v0.2.0 notes →](https://github.com/byzephyron/dealio-steam-deals-bot/releases/tag/v0.2.0)

> **4 October 2026 · Account switch and steadier alerts**
>
> You can now change your Steam account from ⚙️ Settings without deleting your data. If Steam briefly leaves a game out of your wishlist, Dealio no longer treats it as a new sale when the game comes back, so you won't get duplicate alerts. Sale DMs now carry only the panel button; the optional support link moved to the Home panel.

<a name="start-in-discord"></a>

## 🚀 Start in Discord

Dealio is free. All you need is a Discord account and a public Steam wishlist.

1. **[Add Dealio to Discord](https://discord.com/oauth2/authorize?client_id=1540325119690412172).** Choose *Add to My Apps* to use it anywhere, or add it to a server you manage.
2. **Run `/setup`.** Pick your language, enter your Steam profile link, custom URL name or SteamID64, confirm your Steam Store country, then explicitly enable sale DMs.
3. **Open `/dealio`.** Browse your wishlist, choose a game, and set the price you want.

Your Steam profile and “Game details” must be public so the wishlist can be read, and Discord must allow DMs from the bot. Dealio does not ask for a Steam password, cookie, or login session.

## 🔔 When will I hear from Dealio?

Dealio checks again **30 minutes after each scan finishes**, and right after Steam changes prices each day at 10:00 Pacific time, when most sales start. When a price change meets your rule, it sends a DM according to your notification schedule. Steam or Discord issues can add delay.

Initial setup may send a summary of existing discounts, rather than a new-sale alert for each one. Saving a rule, or changing your default discount, while a game already meets it won't trigger a DM either; Dealio alerts when that sale gets clearly better (at least 10 more discount points, or a met target 10% lower). Prices use your selected Steam Store currency; check the final price on Steam before buying.

<a name="commands"></a>

## 💬 Commands

| Command | Purpose |
| :--- | :--- |
| `/dealio` | Your panel: 🏠 Home, 🎮 Wishlist, 🔔 Alerts and ⚙️ Settings |
| `/setup` | Connect your Steam profile and choose your preferences |
| `/delete-data` | Delete your active account data after confirmation |

Everything else is in the `/dealio` panel: browse and search your wishlist, set targets or mute games, choose when alerts arrive, check Steam now, send a test DM, and change your region, language or Steam account in ⚙️ Settings (which also has *Delete my data*).

Panels are private and bound to the person who opened them. After a timeout or bot restart, open a fresh command to continue.

## 🔒 Privacy & control

Dealio stores your account identifiers, preferences, game rules, observed wishlist prices, and delivery records. It also keeps usage records (which command or button was used, never what you typed) for 90 days. It does not collect ordinary Discord message content or Steam credentials.

Notification history displays the last **30 days**; price observations are retained for **90 days**. Active deliveries and ongoing-offer deduplication records may be kept longer. `/delete-data` removes active account records. Existing backup copies are not rewritten, but a separate deletion record (a one-way hash of your Discord ID, kept for 35 days) makes sure a restore from backup can't bring your data back.

[Privacy](https://byzephyron.github.io/dealio-public-pages/privacy.html) · [Terms](https://byzephyron.github.io/dealio-public-pages/terms.html) · [Help](https://byzephyron.github.io/dealio-public-pages/help.html) · [Support server](https://dsc.gg/dealiosupport)

## ❓ A few useful answers

<details>
<summary><strong>What can I do if I get a “Failed” error?</strong></summary>

That message alone doesn't tell us the cause, and it doesn't necessarily mean you did anything wrong. Steam may not have returned prices, Discord may not have completed an action, or something may have gone wrong inside Dealio. Any extra detail in the message helps narrow it down.

Give it a moment, then try the command once more. If a cooldown is shown, wait for it to finish. If an old panel's button isn't working, open a fresh panel with `/dealio`. Still stuck? Open a ticket in the [support server](https://dsc.gg/dealiosupport) and share the command, approximate time, and error text. Hide personal details in screenshots; you don't need to delete your setup and start over as a first step.

</details>

<details>
<summary><strong>The bot works, but I'm not getting DMs. What should I check?</strong></summary>

Start with **Test DM** in `/dealio` → ⚙️ Settings. If the sample doesn't arrive either, check that you haven't blocked the bot and that Discord allows DMs from Dealio (added to your apps, or through a shared server). If tracking was paused because DMs were blocked, press **Resume tracking** in ⚙️ Settings after fixing the setting.

If the test arrives but a sale alert doesn't, check your notification status in `/dealio` → ⚙️ Settings, the game's target or discount threshold, its mute setting, and your quiet hours or daily digest. A test DM confirms you can receive messages; it doesn't mean every game currently qualifies for an alert.

</details>

<details>
<summary><strong>My Steam profile was found, but my wishlist won't load. Why?</strong></summary>

Check that the profile link is correct and your wishlist is visible to other people. Try opening your wishlist link in a browser window where you aren't signed into Steam; being able to see your profile alone may not be enough.

If you've just changed your Steam privacy settings, give it a moment and try again. If the list opens while signed out but Dealio still can't read it, Steam may be temporarily unavailable. If another attempt doesn't help, [open a ticket in the support server](https://dsc.gg/dealiosupport). Please don't share your Steam password or session details.

</details>

<details>
<summary><strong>I set a target. Why didn't a DM arrive immediately?</strong></summary>

Saving a rule establishes its starting state. An already-matching offer is visible in the panel; Dealio alerts when the price drops at least 10% further, or when it rises above your target and comes back. Check the game's rule, mute state, and your notification schedule. If your Store region changed currency, save the target again; until then the default discount rule applies.

</details>

<details>
<summary><strong>Some games show “coming soon” or “not sold”. Is something wrong?</strong></summary>

No. A game that hasn't been released has no price yet, so Dealio shows its release date instead and starts watching the price once it's out. Some games aren't sold in every Store region, and some have been removed from Steam; Dealio labels those too. None of them count as a failed check or an unknown price.

</details>

<details>
<summary><strong>How do I switch to another Steam account?</strong></summary>

Open `/dealio` → ⚙️ Settings → **Change Steam account**. The same profile form as setup opens; Dealio shows the new account and switches only after you confirm. Your default discount, alert timing and language stay. Rules, targets and waiting alerts for the old account's games don't carry over, and games already on sale in the new list don't trigger alerts. You don't need `/delete-data` for this.

</details>

<details>
<summary><strong>Can I pause alerts without deleting my setup?</strong></summary>

Yes. Press **Pause tracking** in `/dealio` → ⚙️ Settings. Your settings remain available, and **Check Steam now** on 🏠 Home still works while tracking is paused.

</details>

<details>
<summary><strong>Can an alert arrive twice?</strong></summary>

Dealio records the alerts it sends and skips routine repeats for the same offer. A game that Steam briefly leaves out of your wishlist keeps its sale state for a short grace period, so its return isn't a new sale. If Discord accepts a message but its acknowledgement is lost, a retry can still produce a duplicate. Please report it if you see one.

</details>

## 🛠️ Build & operate

TypeScript · discord.js Components V2 · `node:sqlite` · IsThereAnyDeal API · Azure VM

- [Development guide](docs/development.md) — isolated setup, environment, and checks
- [Architecture](docs/architecture.md) — pricing, rules, delivery, and persistence
- [Current operations setup, TR](deploy/FREE-OPERATIONS.tr.md) — free backups, alerts, and recovery
- [Admin panel, TR](docs/admin-panel.tr.md) — the owner's private web panel, reached only over an SSH tunnel
- [CI runs](https://github.com/byzephyron/dealio-steam-deals-bot/actions/workflows/ci.yml) — current verification

Dealio stays focused on Steam wishlists. Payments, a user-facing web dashboard, other stores, and estimated currency conversion are outside its scope.

<details>
<summary><strong>🔔 How alerts work, step by step</strong></summary>

<br>

**Checks run on a 30-minute schedule, not a live Steam event feed.** The next automatic scan is scheduled 30 minutes after the previous scan completes, or two minutes after Steam's 10:00 Pacific price change when that comes first. Steam or Discord outages can add delay.

| Stage | What happens |
| :--- | :--- |
| Observe | Read Steam prices for your configured country and language. Successful app-price requests share a five-minute cache; the original observation time is preserved. |
| Match | Evaluate your game's target or discount rule. An unavailable price is not treated as a deal. |
| Wait, if needed | Keep qualifying alerts in a persistent queue for quiet hours, a daily digest, or delivery retries. |
| Revalidate & deliver | Check pending offers again before sending. Offers confirmed to have ended are not sent. |

Setup establishes a baseline and can send a separate wishlist summary. It does **not** send a new-sale alert for every existing discount. Likewise, saving a target that the current price already meets does not create an initial alert.

Prices stay in Steam's reported currency, with no estimated exchange-rate conversion. Target prices are currency-bound; a region/currency change may require a new target. Historical lows come from IsThereAnyDeal; if that service is unavailable, the line is simply left out and the alert is never delayed. Always confirm the checkout price on Steam.

</details>

---

<p align="center">
  Made by <a href="https://github.com/byzephyron">Bilgehan</a>. Issues and ideas are welcome. 💙 · <a href="LICENSE">MIT license</a><br>
  <sub>Dealio is an independent project, not affiliated with Valve, Discord or IsThereAnyDeal.</sub>
</p>
