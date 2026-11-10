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
