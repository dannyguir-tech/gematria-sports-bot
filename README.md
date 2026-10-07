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

`voltrak-steroids.user.js` is a Tampermonkey userscript for Discord and GMGN. It reads new VolTrak calls in Discord and loads them in one GMGN "receiver" tab. There it shows free DEX Screener snapshots and 1m trade flow from GeckoTerminal. It is for analysis only: it never submits trades.

## 3.1.0 changes

- **Faster after a call loads:** the GMGN receiver keeps its role across its own reload. In v3.0.0 it became display-only for about 20s and fetched nothing.
- **Faster refresh:** the open token is polled every 3s while its tab is visible, up from 10s. URL changes are detected within 1s. A worker keeps background tabs ticking.
- **Right pool after migration:** pool selection no longer stays pinned to a drained bonding curve.
- **All pools counted:** swap counts and volume are summed over every indexed pool.
- **Market cap fallback:** market cap falls back to FDV when DEX Screener leaves it out.
- **1m trade flow:** 1m buys/sells, buy/sell USD, unique wallets and the age of the last trade come from GeckoTerminal. When the 1m window has at least 10 trades, the gauge uses 1m USD volume.
- **Headline state:** call-time review flags (top holder, cluster, entry timing) are listed next to the live state. Only data problems still force `CAUTION`.
- **Second GMGN tabs** show live data for their own token.
- **Safer alert parsing:** a labelled `CA` field wins over other addresses, and the embed description is parsed.
- **Fixes:** Alt+V / Alt+I now work on macOS, storage no longer grows by one key per alerted mint, and the panel no longer stops working without Web Locks. The script now matches all of `discord.com`, so it also loads when you open Discord at `/app`.
- **Optional hardening:** set `AUTHOR_ID` to VolTrak's Discord ID so look-alike names are ignored.

## Tests

```
node --test
```
