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

## 3.6.0 changes

- **New panel design:**
  - A state band with a since-alert clock, plus two big numbers: buy share and move vs the call MC, each with a trend line.
  - A 20-cell buy/sell meter, KPI tiles, +10/+30 countdown chips, a 1m/5m flow table, and a footer that stays visible.
  - A collapsed "scoreboard" header (state · $SYMBOL · buy share · clock).
  - States are worded as descriptions: Buyers leading / Sellers leading / No clear side / Caution.
- **Volume bots (live, GMGN tab):** the share of the last 5 minutes' $ volume coming from wash-trading wallets, plus the count of real buyers. Wallets are flagged for:
  - a buy and a sell in one transaction
  - a flat buy-then-sell within 10 s
  - churn wallets
  - dust trades

  Arbitrage across pools, profitable flips and repeated preset buys are not flagged. Each new call saves a 60 s and a 120 s reading, so the backtest can test it later.
- **Helius (optional):** paste a Helius API key (the free plan works) in Settings, then press "Add volume bots to past calls". This reads every trade from 5 minutes before to 3 minutes after each past alert. The report and CSV gain volume-bot splits (`bots_pre_*`, `bots_2m_*`).
- **Late checks reworded:** ABOVE / BELOW / DOWN 30%+ / NO TRADES. They describe the price; they are not BUY/FADE verdicts. On 95 past calls, no late-check group made money. Notifications are now off by default and say "not a buy signal".
- **Market tab:** launches and graduations with pace vs the 30-minute average, and connection diagnostics. PumpPortal's trade stream now needs a funded API key, so the script no longer asks for it.
- **Backtest follows the 95-call analysis:**
  - Buying every call at the alert won 24% (break-even about 35%), and the filters from the first 22 calls failed on 73 newer calls. So the setup card shows "No proven setup" with your own win rate vs break-even.
  - The cluster and top-holder warnings are gone.
  - New options: a +1 min entry, "sell at 5 min if not up", and cautious fills.
  - The report has a verdict line, an exit-rules table (paired against target/stop only) and a forward test on calls after Oct 11 03:30 UTC.
- **Data checks:**
  - "Copy GMGN feed report" (Settings) lists the fields GMGN's live feed sends.
  - On Photon (tinyastro.io), a "VolTrak: copy Photon report" button records the shape of Photon's data, with tokens and keys redacted. This is the first step toward showing Photon's volume-bot number in the GMGN panel.

## 3.5.0 changes

- **Late checks (Calls tab):** 10 and 30 min after each new call, the script reads DEX Screener once and grades the call: BUY (at or above the call price and still trading), WAIT (down 0–30%), FADE (down 30% or more, or a cluster of 30% or more) or DEAD (no trades for 5 min). The last 20 calls are listed with both grades, and a BUY grade sends a notification (it can be turned off in Settings). The rule is untested until the backtest says otherwise.
- **Backtest "Buy at":** scores buying at the alert, at +10 min or at +30 min from the same cached candles, with no new requests. The report compares the three entry times, shows how each late-check grade did on past calls, and lists every call's +10/+30 grade next to the result of buying then.
- The CSV adds `r10`, `r30` and, for +10 and +30, `buyN_grade`, `buyN_outcome`, `buyN_trade_return`, `buyN_peak`, `buyN_peak_min`, `buyN_r15` and `buyN_r60`.
- 3.4.1: GeckoTerminal pacing adapts after a rate limit (60s pause, then slower), and the GMGN tab's GeckoTerminal fallback stays quiet while scoring runs.

## 3.4.0 changes

- **Load channel history (Calls tab, Discord):** scrolls the VolTrak channel back to its start for you, saving every alert as it loads, so the backtest has hundreds of calls to score instead of only the ones that arrived since install.
- The script now keeps up to 2,000 saved calls (was 500), and stores scored candles more compactly.
- The Calls tab shows the oldest saved call next to the counts, so you can see how far back your history goes.

## 3.3.0 changes

- **Backtest (Calls tab):** first scroll back through the VolTrak channel, which saves every alert you pass. Then press **Score calls**: the script pulls 2h of 1-minute GeckoTerminal candles per call, about 7s each. The candles are cached, so changing the target, stop or costs re-scores instantly.
- **Backtest report:** win rate with its 95% range, average result per trade after costs, median peak and timing. It also breaks results down by every alert field (cluster, bots, fresh wallets, top holder, MC, age, holders, experienced traders, snipers). A bucket is only marked as standing out when it has at least 15 calls and its whole range sits clear of the overall win rate. You can download the results as CSV.
- **Market tab:** pump.fun launches, graduations, bonding-curve volume, active traders and average traders per token over the last 1/5/10/30 minutes. The data comes from PumpPortal's public data socket (one connection, from the receiving GMGN tab), and the Discord tab mirrors it.
- **New layout:** Live / Market / Calls / Settings tabs, readings as labelled tiles (green for buys, red for sells), a colored state badge, and a dot showing whether data is live. Collapsing the panel leaves the state and buy share in the header.

## 3.2.0 changes

- **GMGN live feed:** the script now reads GMGN's own page connection (`ws.gmgn.ai`), using `token_activity` for each trade and `token_stat` for GMGN's 1m/5m rollups. It's read-only: it never sends on GMGN's connection or changes a message, and it keeps only messages for the token on screen. The gauge uses GMGN's 1m buy/sell volume, and new tokens work before DEX Screener has indexed them.
- **Fallbacks:** DEX Screener and GeckoTerminal are now only used when the live feed is quiet. While it's flowing, GeckoTerminal pauses and DEX Screener slows to every 10s.
- **Instant token switch:** a new call opens inside the GMGN page through its own router, without a full reload. If the router isn't available, it falls back to a reload.
- **Panel:** shows the last trade (side, size, age) and live market cap (price × 1B supply for pump.fun tokens).
- **Timing:** the script now runs at `document-start`, so it attaches before GMGN opens its connection.

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
