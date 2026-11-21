# Backtest engine

Answers one question before any money is risked: **do the rules pick coins that make money after costs, most days,
without rugs?** No dependencies; Node 20+.

```
node engine/bin/backtest.mjs --fake 2000 --days 14 --seed 1   # test the engine on made-up coins
node engine/bin/backtest.mjs --data coins.jsonl                # real coins (from the backfill)
node --test engine/test/engine.test.mjs                        # tests
```

Writes `engine/out/report.md` (plain-language report) and `engine/out/result.json`.

## Getting real coins (backfill)

```
HELIUS_API_KEY=your-key node engine/bin/backfill.mjs --check <a Pumpfun launch signature>   # verify decoding first
HELIUS_API_KEY=your-key node engine/bin/backfill.mjs --days 14 --perDay 150 --out coins.jsonl
node engine/bin/backtest.mjs --data coins.jsonl
```

- Lists Pumpfun launches from the history of Pumpfun's mint-authority account (touched only by launches), samples
  `--perDay` per UTC day, then pulls each coin's bonding-curve transactions for its first 6 hours and decodes the
  trade events (logs and self-CPI events). Mint settings come from the mint account.
- Resumable (skips coins already in the output), rate-limited (`--rps`, default 8), retries 429 / 5xx.
- Rough cost: 1 call per transaction plus paging; ~150 coins/day × 14 days is a few hundred thousand calls.
- **Verify first:** the event layouts and the mint-authority address are from memory. Run `--check` on a known
  launch and compare the printed trades with a block explorer before trusting a full run.
- Pumpfun only for now. Bonk and Stonk.fun need their own decoders once their layouts are confirmed. Trades after
  graduation (PumpSwap) are not pulled yet, so positions held through graduation exit at the last curve price.
- No wallet-funding lookup yet, so the organic-volume filter is skipped on backfilled data.

## What it does

1. **Scan.** Every coin is checked every 30 s from 2 to 120 minutes old, using only trades up to that moment
   (no lookahead, tested). Safety vetoes first (launchpad, mint / freeze authority, bad Token-2022 extensions,
   transfer fee, launch provenance), then the filters in `src/rules.mjs`. First pass = entry.
2. **Exit.** Each entry is played forward on the real trade path (`src/sim.mjs`), with launchpad fees, exact curve
   impact, extra slippage and transaction costs. Two exit styles:
   - **runner** (default): stop −25%, sell half at +40%, trailing stop 25% from the high, out after 4 h, or after
     60 min if it never reached +15%.
   - **steady**: stop −20%, sell 70% at +30%, trail 15%, out after 2 h, or 45 min if never +10%.
   - Rug = price down 60% from its 60-second high; a rug while holding counts as −100% of what is still held.
3. **Portfolio, day by day** (`src/backtest.mjs`): 10 SOL start, 3% of the day's bankroll per trade, max 15 trades a
   day, max 4 open, no new entries after −10% on the day.
4. **Score.** Green-day share, average / median / worst day, win rate, rug rate, drawdown. Compared with **random
   coins** (same launchpads, safety checks only, random entry time, same number per day), and with every filter
   switched off one at a time to see which ones actually help.

Targets (from the user's goals): ≥ 70% green days, rug rate < 5%, worst day ≥ −10%, positive average day,
beats random coins, ≥ 100 trades before trusting it.

## Real data format (JSON Lines, one coin per line)

```json
{"mint":"…","pad":"pump|bonk|stonk|other","creator":"…","createdAt":1730000000000,"createdSlot":123,
 "provenance":true,
 "mintInfo":{"mintAuthority":null,"freezeAuthority":null,"extensions":[],"transferFeeBps":0},
 "funding":{"wallet":"first funder of that wallet"},
 "trades":[{"t":1730000001000,"slot":123,"wallet":"…","side":"buy","sol":0.5,"tokens":17000000,
            "vSol":30.49,"vTok":1055000000}]}
```

- `vSol` / `vTok` = virtual reserves after the trade. If missing they are rebuilt from launch using the curve
  parameters in `src/curve.mjs` (Pumpfun values from memory; Bonk and Stonk.fun are placeholders until confirmed).
- `funding` is optional (needed for the organic-volume / wash check; null feature otherwise).
- `mintInfo` missing = mint checks can't run; the report counts such coins.

## Limits

- Fake data proves the code works, not that the rules make money.
- Our own orders are not fed back into the price path (fine at small size).
- Post-graduation trading needs pool reserves in the trade rows; graduation itself isn't modelled separately yet.
