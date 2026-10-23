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

### 3.7.0

- Live gauge reads organic (bot-free) flow first. Wash trades are ~50/50 by construction and dragged every other source toward 50%. Flags when bot-like trades are 40%+ of volume.
- Backtest "stands out" now compares each bucket with the rest on average per trade (Welch t) and corrects for the ~40 buckets tested (Bonferroni). On data with no real effect, the old rule showed a false edge in ~36% of reports; the new one in ~7%.
- New lookahead-free splits: move into entry (crowding after the call), 15-min run-up before the alert, migrated at call, hour (UTC); organic buy share and real buyers in the first 2 min (from GMGN live or Helius readings).
- New exit rule in the paired comparison and forward test: trailing exit (arm at half the target, give back 30% from the peak, earlier candles' highs only).
- Survivorship check in the report; default cost 5% (old default 3% was below typical fees + tips + price impact).
