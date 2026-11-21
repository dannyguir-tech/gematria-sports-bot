# Kalshi Gematria Bot

A Tampermonkey userscript that adds a floating gematria calculator to [Kalshi](https://kalshi.com) sports markets.

## What it does

- Adds a draggable panel to any Kalshi page
- Calculates English ordinal gematria (A=1, B=2, …, Z=26) and full reduction values
- Lets you enter two market sides and an optional date
- Suggests a pick based on the numbers
- Tries to auto-detect team/market names from the page title

## Install

1. Install the [Tampermonkey extension](https://www.tampermonkey.net/) in your browser.
2. Click the raw `kalshi-gematria-bot.user.js` file in this repo.
3. Tampermonkey will prompt you to install the script.

Or copy the contents of `kalshi-gematria-bot.user.js` into a new Tampermonkey script.

## How to use

1. Open any Kalshi sports market page.
2. The Gematria Bot panel appears on the top-right.
3. Enter Side A and Side B (team names, player names, or market titles).
4. Optionally enter the event date.
5. Click **Calculate**.

## Pick logic

1. If one side's reduced value matches the reduced date value, that side is the pick.
2. Otherwise, the side with the higher ordinal gematria value is the pick.
3. If both values are equal, it's a tie.

## Disclaimer

This is for entertainment only. Gematria is not a proven betting or trading strategy. Do not risk money based on this script.

---

# VolTrak Steroids

`voltrak-steroids.user.js` is a separate Tampermonkey userscript for Discord + GMGN: VolTrak call context, a read-only GMGN live trade feed, volume-bot detection, and a backtest of past calls. It is analysis only and never submits trades.

Regression tests for its pure core (`VTCore`): `node --test test/voltrak-core.test.mjs`

### 4.9.4

- **Copy for AI** (monitor, on GMGN and Photon): copies the current list with fixed instructions for a chat agent such as Grok. The agent answers `PICK <mint> | reason` (at most 2) or `NONE`.
- **Log AI picks**: paste the agent's answer. Only coins from the copied list count (made-up addresses are ignored). Each pick is saved with its market cap, next to a coin from the same list it did not pick.
- **AI picks scoreboard**: what the picks did 1 hour and 4 hours later (median change, share higher, share down 80%+), against the not-picked coins. Checks run while a GMGN or Photon tab is open; a check more than 2 hours late is skipped. About 50 picks are needed before it means anything.
- The agent never trades and nothing is sent anywhere: you copy and paste by hand.

### Backtest engine (`engine/`)

Separate from the userscript: tests whether rules that scan new Pumpfun / Bonk / Stonk.fun coins make money after costs, day by day, against random coins. Runs on fake coins now; `engine/bin/backfill.mjs` pulls real past Pumpfun coins with a Helius key. See `engine/README.md`.

### 4.9.3

Built on the 4.9.2 file in use (4.9.0 plus a launchpad filter).

- **Three launchpads only: Pumpfun, Bonk and Stonk.fun.** Bonk covers GMGN's "bonkers" label, letsbonk / bonk.fun and mints ending in "bonk". Coins from any other launchpad, or whose launchpad is not known, are not listed in the monitor; the verdict bar says SKIP.
- **A dump warning comes before SKIP**, so a coin you already hold still warns you.
- **The launchpad skip is saved on its own.** The saved verdict is what the trading rules said, so the verdict table in the backtest stays a test of the rules. The report has a table per launchpad and the CSV a launchpad column.
- **DEX Screener lookups follow the settings again** (verdict bar on, tab visible or receiving calls).
- **Removed a stray word at the end of the file** that threw an error on every page.
- **The script name now carries the version** and changes with every release.

### 4.9.0

The 4.5–4.8 add-ons (wake-up monitor, Scanner tab, Photon dock, verdict bar, tape and bundle rules) rebuilt on top of the verified 4.4.2. The 4.8.3 file was a fork of 4.4.0: it had none of the 4.4.1/4.4.2 fixes and most of the backtest report had been cut out of it.

- **Back from 4.4.2.** The position-card, speed-table, bucket-test, bot-pairing and Discord fixes, and the full report: speed table, your real trades, measured cost, forward test, late checks, bots on past calls, CSV export.
- **Faster.** On a busy coin page the panel now costs about a third of the main-thread time (87 ms per second against 268, measured in Chromium on a simulated page). The causes were two endless CSS animations, four full rebuilds of the panel per second, and three add-ons that each parsed every websocket frame and every fetch response.
- **Monitor.** One module for GMGN (Scan tab) and Photon (dock). Photon cards open the coin: they use the row's own link, and DEX Screener resolves the pool to the mint for the GMGN link. Refresh button. Token names are written as text, never as HTML. A scoreboard records what flagged coins did 10 and 30 minutes later, next to a sample of coins that were seen and not flagged.
- **Rules.** The add-on rules are now pure functions with tests. Same-size buys ignore round button sizes (the old rule marked about 100% of ordinary tapes as a trap). A holding bundle is capped at RISKY and needs a known organic buy share from 20+ trades (the old one turned AVOID into CLEAN when the share was unknown). Stealth bundles need two signatures (the old equal-bag test fired on about 98% of ordinary holder lists). DS needs a sale that is 30+ minutes old. Chasing is monotonic.
- **Verdict bar.** Works from the panel's real values, not from its own text. The verdict is saved with each call and the backtest report has a table for it; the bar shows your own record for the verdict on screen. The base "4.3 rules" grade is saved unchanged, so its forward test stays clean.
- **Safety.** Quick-trade hotkeys are off by default (they press GMGN's own buttons, found by their text). The size tag copies the amount instead of typing into a GMGN field. The second PumpPortal socket per tab is gone. The link guard's OK and Cancel now do what the text says.

### 4.4.2

Eight small edge cases found by a second review of 4.4.1, all rated low.

- **Your position.** Two sells in the same second give the same result whichever order they arrived in; a rounding remainder is not counted as a bag still held.
- **Wallet.** Removing the address and later entering a different one starts with clean fills (entering the same one again keeps them).
- **Discord.** Text changing outside the message list (typing indicator, clocks) no longer triggers a scan. Two alerts with no numbers arriving together each wait at most about 160ms. A message whose header arrives late is judged from when it was first seen, not from its send time.
- **UI.** The state title wraps instead of being cut once the clock shows hours; a long check value wraps on a narrow panel.

### 4.4.1

Fixes for defects an independent review found in 4.4.0.

- **Your position.** The card shows only the position held now: an earlier round trip on the same coin is no longer blended into the entry, the profit or the 5-minute rule. A sale of tokens the tab never saw bought counts only for the part it did see, so it cannot appear as profit. The 5-minute notification fires once per entry, across tabs and reloads. A wallet saved in one tab is picked up by the others; a different address starts with clean fills.
- **Speed table.** A Helius window cut short at 40 pages no longer saves "price did not move": the two minutes after the alert are read again on their own. Rows whose SOL amount is only fees are left out. Speed prices saved by 4.4.0 are not used until "Add trades to past calls" reads those calls again.
- **Backtest.** A small bucket that happens to hold no winner no longer "stands out" (the test now uses the larger of the Welch and the pooled error).
- **Volume bots.** A held earlier buy can no longer take the sell of a 10-second round trip (which turned counted bots into "possible"). A slow flat trip from a trading-app wallet is not marked.
- **Discord.** The follow-up scan no longer re-arms itself (it scanned about 8 times a second forever); the panel refreshes on its own again; an alert whose embed arrives in parts is read when its text arrives.
- **UI.** Dial arcs render in Firefox; position row, state title, check values and grade title are no longer cut off.

### 4.4.0

- **Speed.** Discord alerts are read on the first page change instead of after a restarted 120ms wait. In a simulated busy channel the time from alert to published call went from 1.7–3.9s to about 5ms.
- **Speed table.** "Add trades to past calls" (Helius) now also prices a buy 2, 5, 10, 15, 30 and 60s after each alert from the real trades, and the report scores each: what every second of delay costs.
- **Real costs.** All-in round trip = Jupiter pool cost + platform fee + priority fee and tip (Settings). The report compares its measured median with the Costs setting.
- **Your own fills.** Optional wallet address: a live position card (profit, entry delay, entry vs the call price, 5-minute rule) and a "Your real trades" section in the report.
- **Backtest.** Five primary hypotheses (late fill, late call, the two grades, exit cost) are tested as their own family, so a real effect in them is easier to detect.
- **Volume bots.** The counted share is a floor (shown as ≥). Flat round trips taking 10–60s, the pattern of wash trading spread over one-use wallets, are reported as "possible".
- **GMGN data report.** Settings → Copy GMGN data report lists every field GMGN returns, to find data the script does not use yet.
- **UI.** Radial buy-share dial, hex grade badge, bar meters for risk / demand / entry / data, new frame.

### 3.7.0

- Live gauge reads organic (bot-free) flow first. Wash trades are ~50/50 by construction and dragged every other source toward 50%. Flags when bot-like trades are 40%+ of volume.
- Backtest "stands out" now compares each bucket with the rest on average per trade (Welch t) and corrects for the ~40 buckets tested (Bonferroni). On data with no real effect, the old rule showed a false edge in ~36% of reports; the new one in ~7%.
- New lookahead-free splits: move into entry (crowding after the call), 15-min run-up before the alert, migrated at call, hour (UTC); organic buy share and real buyers in the first 2 min (from GMGN live or Helius readings).
- New exit rule in the paired comparison and forward test: trailing exit (arm at half the target, give back 30% from the peak, earlier candles' highs only).
- Survivorship check in the report; default cost 5% (old default 3% was below typical fees + tips + price impact).
