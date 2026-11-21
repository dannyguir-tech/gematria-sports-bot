# VolTrak: decisions, design notes and roadmap

Everything agreed in the planning conversation, in one place. **Status:** only the userscript exists. The worker, database,
harness, paper trading, optimization loop and live engine below are designs; nothing of them is built yet.

## 1. Where things stand

- **Userscript 4.9.3** (`voltrak-steroids.user.js`), copy page: https://claude.ai/artifact/Do2dTMB3GAhTZSxyqMT2sD
  - Discord → GMGN handoff, live panel, chain checks (Helius key), GMGN data, verdict bar, monitor (GMGN Scan tab,
    Photon dock), backtest report with a table per rule, CSV export.
  - 4.9.3 was built on the user's own 4.9.2 (4.9.0 + a launchpad filter added outside this repo).
- **Tests:** `node --test test/voltrak-core.test.mjs` (37 tests). Browser checks were run on simulated pages only: the real
  data sites are blocked from the build environment.

## 2. Standing decisions

| Decision | Detail |
|---|---|
| Launchpads | Only **Pumpfun, Bonk, Stonk.fun**. Bonk = GMGN "bonkers", letsbonk / bonk.fun, or a mint ending in "bonk". Unknown or other launchpads are not listed in the monitor; the verdict bar says SKIP. |
| Other pools | Coins not traceable to those three stay SKIP (user does not want them). |
| Name / version | `@name` and `@version` both carry the version and **change on every edit**. |
| Dump warnings | "DUMP NOW" always shows before SKIP. |
| Launchpad skip | Saved separately (`x49.pad`); the saved verdict is the trading rules' one. |
| Trading | The script never trades. Hotkeys (press GMGN's own buttons) are off by default. |
| VolTrak | Keep it running alongside the new pipeline as a free comparison source. |
| Direction | Move from following VolTrak calls to scanning new pairs on chain directly. |
| Live money | Only after paper trading is profitable over ~100+ decisions, and only with the user's approval per rules version. |

## 3. How the grade resolves conflicts (current rules)

Pillars: Risk, Demand, Entry, Data. They are **not** added together for the grade.

1. **Hard veto → AVOID:** dev selling (chain-confirmed, last 10 min, needs Helius key and verified creator), or insiders
   leaving together (3+ insider wallets in 60 s, or 3%+ of supply in 2 min).
2. **AVOID by threshold:** Risk ≤ −4 or Entry ≤ −3.
3. **PARTIAL:** fewer than 5 checks with data.
4. **RISKY:** Risk ≤ −1, Demand ≤ −2 or Entry ≤ −1 (weakest pillar decides; demand cannot cancel a risk).
5. **CLEAN:** otherwise, and only if insider bag, top 10 and dev all have data (else PARTIAL).

- A dev moving tokens to a plain wallet is not a veto: that wallet joins the insider bag.
- Volume pumping is worth at most +1 in Demand; Volume/MC 10×+ counts −1 unless bots are known to be under 35%.
- Verdict bar order: dump → skip → stay away → wait → green light (CLEAN, or RISKY with a holding bundle, and 58%+ buy share
  from live trades).
- **None of these thresholds has been tested against outcomes.** The backtest report has tables for the grade and the
  verdict.

## 4. Gaps found in the current data

1. The hard-veto reasons are saved (`gm.<id>.hard`) but not in the CSV.
2. The saved record is a single snapshot 10–180 s after the alert; vetoes that fire later are never saved.
3. Few calls trigger the vetoes; testing them needs a few hundred calls.

The worker below closes 1 and 2 (timed `veto_events`).

## 5. Build order

1. **Collector worker** (no trading): every Pumpfun / Bonk / Stonk.fun launch through cheap filters, snapshots at fixed
   ages, 1-in-20 sample of rejects, per-stage counts.
2. **Fake Helius harness** to break the worker before mainnet.
3. **Paper trading** with telemetry.
4. **Optimization loop** (needs a few weeks of collector data).
5. **Live trading**, only if 3 is profitable.

## 6. Collector and funnel

```
All launches (Pumpfun, Bonk, Stonk.fun)
  → stage 1, bulk numbers (GMGN/Photon lists, DEX Screener 30 per request, PumpPortal launches): MC > X, volume,
    fees paid by traders, buy share, top 10, bundlers, dev %
  → stage 2, cheap per coin: DEX paid / boosts, holder growth over 2 min, bot share
  → stage 3, Helius: dev history, funder, launch block, live insider exits, syndicate graph
  → paper trade
```

- Cost scales with coins that pass, not coins that launch.
- GMGN data only comes through the logged-in browser (GMGN blocks servers): the GMGN tab does stages 1–2 and passes
  survivors to the worker, which does stage 3.
- **1-in-20 sample of rejected coins** gets one cheap outcome (MC 30 min later, DEX Screener batched) so filters can be judged.
- Snapshots at 30 s, 2, 5 and 15 min after launch. Winner defined from the decision moment (e.g. doubles within 30 min of
  the 5-min mark without first dropping 50%, after costs).
- Default stage-1 thresholds to start: MC ≥ $15K, age ≥ 2 min, 60%+ buys over 5 min, top 10 < 35%, dev < 10%.
  **Open:** user to confirm, and what "paid fees" means (DEX paid profile, trader fees, or both).

## 7. Current ingestion (browser only)

- Discord tab reads alerts from the page → Tampermonkey shared storage → GMGN receiver tab opens the coin.
- GMGN tab: GMGN's own websocket (read-only) for live trades; HTTP polling: GMGN token data every 5 s (first 3 min) then 15 s,
  Helius history once 3 s after the alert, Helius catch-up every 20 s (feed quiet) or 2 min, DEX Screener 3–10 s,
  Jupiter 15 s, RugCheck 5 min, GeckoTerminal fallback.
- No Helius websocket, no backend. Three simultaneous calls: chain scans run one at a time; only the coin on screen stays live.

## 8. Worker: Helius websocket and rate limits

- One socket, all active calls (coin + dev + funder, 30 min each).
- Heartbeat ping 30 s; no message for 60 s while subscribed → reconnect. Backoff 1, 2, 4… 30 s with jitter.
- Resubscribe from a saved list; HTTP gap fill since the last seen transaction; de-dupe by signature; log every outage.
- One request queue paced to the plan's limit, priority: live gap fills / dev checks → holder checks → funder lookups →
  history scans (max 2 at a time). 429: honour the stated wait, halve the pace, recover slowly. Shared caches for funders
  and program accounts. Credit budget per call.
- Socket down > 2 min: poll live calls every 5 s within budget; panel shows "chain: polling".
- Browser link to the worker resends missed events by last event ID.

## 9. Telemetry

- Hot path writes to an in-memory buffer; a separate task writes batches every 1–2 s.
- Per call, ms after the alert: received → first chain event → checks done → decision → quote → fill.
- Slippage: paper = quote vs volume-weighted price of the next 3 s of trades; live = tokens received vs quoted.
- RPC health per endpoint: response time, errors, 429s, last websocket message age, **slot lag vs a second provider every
  5 s**. Rolled up per minute; status page, panel health light, Telegram only on state changes.

## 10. Database schema (Postgres, append-only, every derived row carries `rules_version`)

```sql
calls        (call_id PK, discord_msg_id UNIQUE, mint, alert_at, received_at, symbol, name, call_mc, launchpad, raw JSONB)
tokens       (mint PK, launchpad, creator, funder, created_slot, created_at, migrated_at, pool)
snapshots    (call_id, taken_at, rules_version, grade, risk, demand, entry, verdict,
              insider_pct, top10_pct, dev_pct, bundler_pct, org_share, ..., features JSONB)
chain_events (id, mint, slot, block_time, sig, wallet, role, kind, tokens, pct_supply, sol, source, seen_at,
              UNIQUE (sig, wallet, kind))
veto_events  (call_id, rule, fired_at, first_event_id, details JSONB)
prices_1m    (mint, minute, o, h, l, c, v, PRIMARY KEY (mint, minute))
paper_trades (trade_id PK, call_id, rules_version, decided_at, quote_px, fill_px, fill_at, size_sol, exit_reason,
              exit_px, exit_at, pnl_pct, pnl_sol_net, costs JSONB, degraded BOOL)
live_orders  (order_id PK, trade_id, side, signed_at, sig UNIQUE, sent_at, landed_slot, confirmed_at, expected_out,
              actual_out, slippage_bps, prio_fee, tip, status, error)
rpc_health   (endpoint, minute, p50_ms, p99_ms, errors, rate_limited, slot_lag_max, ws_reconnects, gap_tx_recovered)
wallet_funding (wallet PK, funder, amount, funded_at, hop)
rule_versions  (id, params JSONB, code_sha, dataset_id, metrics JSONB, status, created_at, promoted_at)
```

Indexes: `calls(alert_at)`, `chain_events(mint, block_time)`, `veto_events(rule, fired_at)`,
`paper_trades(rules_version, decided_at)`. View `call_outcomes`: call + snapshot + first veto + paper result + returns at
+10 / +30 / +120 min. Nightly Parquet export for DuckDB if per-trade data grows large.

## 11. Circuit breakers

| State | When | New entries | Open positions |
|---|---|---|---|
| Healthy | socket alive, slot lag < 20 slots, errors < 20% | allowed | normal |
| Degraded | socket silent 60 s+, lag > 20 slots, or a 429 storm | paper only, marked degraded | price exits continue; polling + second provider |
| Blind | no trustworthy chain data 60 s+ from either provider | none | price exits continue; default: sell after 60 s blind (or tighten stop) |

- No double sells: sign and save before sending; unconfirmed after 30 s → check the signature on the second provider
  before any resend; filled only when an in-sync provider confirms.
- Back to Healthy only after 2 clean minutes and a finished gap fill; vetoes that would have fired during the outage are
  logged as late.
- Always: daily loss cap, 3 failed orders in a row, kill switch (panel / Telegram) stop new entries.

## 12. Fake Helius harness

- Worker reads all endpoints from config and takes an injected clock (tests run 50× real time, deterministic).
- Fake chain generator (same transaction format the script parses), plus replays of recorded real traffic.
- Fake Helius HTTP + websocket, a second provider instance, fake Jupiter / DEX Screener, later fake Jito.
- Scenario files with a timeline of faults (seeded). Faults: socket close / half-open / refused reconnects / reset
  subscription IDs; dropped, duplicated, reordered, delayed frames; 429 storms, 500s, timeouts, broken JSON, looping
  pagination; slot lag and stuck providers; reorgs (confirmed tx disappears); orders that never land, expired blockhashes,
  late or one-provider confirmations; price sources down.
- Checks after every run: nothing lost, nothing invented, states switch on time, no live entries while degraded / blind,
  rate limit holds, price exits work while blind, no double sells, detection latency when healthy, bounded memory and CPU.
- Fixed scenarios on every change (incl. three simultaneous calls during a 429 storm and a socket drop), ~1,000 random
  seeds nightly, a 24-fake-hour soak.
- Check the fake against a few minutes of recorded real enhanced-websocket traffic before trusting results.

## 13. Paper trading

Every green light: simulated buy at that moment's real price, then the exit the rules would take (target, stop,
trailing, 5-min rule), logged with telemetry. Costs nothing; answers whether green lights make money after costs.

## 14. Optimization loop

```
nightly: freeze dataset → sweep → walk-forward → gates → shadow (3–7 days) → user approval (Telegram) → canary 10% → live,
         with automatic rollback
```

- Dataset: point-in-time features only, labels from the decision moment after measured costs, rugs count −100%, funnel
  rejects weighted ×20, Parquet with a fixed ID.
- Rules are one pure function `decide(features, params)` shared by backtest and worker; ≤ ~8 tunable settings in a file.
- Anti-overfitting: walk-forward (tune 14 days, judge next 3, step 3), 2-h gap between tune and judge data, 7-day lockbox
  checked once per candidate, plateau not peak, penalty for number of tries (deflated Sharpe or bootstrap), flag winners at
  the edge of a range, pause on meta shift, consistency across launchpads / time of day / windows.
- Gates: beats live rules on the same calls with the 95% range of the difference above zero, ≥ ~100 test trades, drawdown
  no worse, passes lockbox, tests and harness pass.
- `rule_versions` statuses: candidate → shadow → canary → live → retired; worker hot-loads the active version; every
  decision stamped. Rollback on drawdown limit, losing streak, or live results outside the predicted range.
- Nightly report page. Needs a few weeks of collector data first.

## 15. Live execution engine (only after paper trading is profitable)

**Landing and MEV**
- Main protection is a tight minimum-out from a fresh quote: allowed slippage = min(hard cap 3–5%, share of expected edge).
- Swap and Jito tip in the same transaction, sent as a one-transaction bundle; compute limit from simulation + 10%;
  priority fee from Helius's per-account estimate.
- Tip = min(value of landing now × 0.3, tip cap, share of expected profit), where value of landing now uses the speed
  table's return lost per second. Below Jito's current floor (≈ 50th–75th percentile of landed tips) → skip the trade.
  Exits (stop / insiders leaving) may pay more, capped by position value.

**Failover**
- Ladder: Jito bundle (nearest regional block engine, or two) → staked connection with priority fee, same tight limit →
  never a plain public send with loose slippage.
- Entries don't chase: not landed in ~3–5 slots → cancel, log as missed. Exits escalate fee per retry after checking the
  previous signature on two providers.
- Pause entries if < ~70% of the last 20 orders landed, or the tip floor stays above the cap for a minute.

**Keys**
- Separate trading wallet with a small float; profits auto-swept to one cold address; top-ups manual or capped per day.
- Separate signing service: the worker sends structured orders; the signer builds the transaction and enforces allowed
  programs (pump.fun, PumpSwap, Raydium LaunchLab, Jupiter, compute budget, Jito tip accounts), SOL out only to swaps,
  tips and the sweep address, per-trade / hour / day limits, kill switch.
- Key storage, strongest first: hosted policy signer (e.g. Turnkey), cloud KMS with Ed25519 (verify support), or encrypted
  on disk and unlocked into the signer's memory with a typed passphrase. Never plain text, env var or git.
- SSH keys only, firewall, 2FA on the provider, signer as its own user, every signature logged, Telegram alert on any
  non-trade transfer. Devin never gets the production key.
- Test with a fake Jito (rejects, throttling, tip spikes, expiry, late landing), then mainnet with a tiny float.

## 16. Syndicate / sybil detection

**Speed and cost**
- Build the funding graph continuously from launch, so the alert is a lookup.
- Free first: GMGN holder rows carry each wallet's first funder and funding time.
- Each wallet's first funder is looked up once and cached forever (`wallet_funding`); only launch-block / first-minute
  buyers and holders ≥ 0.3%; batched JSON-RPC.
- Second hop only for funders of 3+ buyers. High-fan-out addresses (exchanges, bridges) are not links; exchange-funded
  wallets link by pattern (same amount ±5% within 10 min).
- Union-find groups updated per new link.

**Organic vs wash**
- Count clusters as one buyer; Herfindahl concentration of buy volume across clusters; gross volume ÷ net tokens bought by
  independent buyers; loops (mirror and round-trip rules on clusters); independent buyers still holding after 2–5 min;
  share of fresh single-trade wallets (weak alone).
- Organic momentum = net buy volume from independent buyers over the last 1–2 min.

**Veto (starting points, untested)**
- Syndicate = 4+ buyers linked by funding within 24 h before launch (exchanges excluded) or same-source funding within
  10 min with amounts within 5%.
- AVOID if: one syndicate holds 25%+ of supply; all syndicates 40%+; a dev- or dev-funder-linked syndicate 10%+; buy-volume
  Herfindahl ≥ 0.25; gross ÷ independent net ≥ 5× with syndicates doing 50%+ of trades; a syndicate sells 3%+ of supply in
  2 min. Below that: a risk penalty.
- Blind spots: many-hop or mixer funding; old exchange withdrawals of random sizes. The live exit veto is the backstop.

## 16b. Migration (graduation)

Facts to verify against each program's published layout before coding: pump.fun graduates to **PumpSwap** (not Raydium)
almost instantly; Bonk (Raydium LaunchLab) graduates to **Raydium CPMM**; Stonk.fun's mechanics are unknown.

**States:** CURVE → NEAR_FILL (90%+) → COMPLETE (curve closed, trading frozen) → MIGRATING → POOL_VERIFIED → TRADING;
STUCK (no verified pool within a timeout) → alert, no entries.

- **Fill instant:** websocket subscription to the bonding-curve account; decode reserves and the `complete` flag on every
  change. Fill % = 1 − real token reserves left ÷ starting real token reserves.
- **Freeze:** cancel pending curve orders; send nothing and enter nothing in COMPLETE / MIGRATING.
- **New pool before indexers:** PumpSwap and Raydium CPMM pool addresses are derived from known inputs (coin, SOL, pool
  settings, program), so compute the address while on the curve and subscribe to it in advance. Backups: the migration
  transaction in the coin's stream, PumpPortal's migration feed.

**Pool verification (all must pass):** created by the official migration (allowed program, launchpad's migration account
signed); at the precomputed address; created right after the curve completed with reserves matching the curve's final
reserves minus the fee; LP burned or held by the lock program (LP mint supply and largest holders); no mint authority and
no freeze authority; reject Token-2022 coins with transfer hooks, transfer fees or a permanent delegate. Trade only on the
verified pool (pass it explicitly or restrict Jupiter to it). Four or five account reads, high-priority queue.

**Hold / scalp / exit:** paper trade all three on every graduating coin and let the optimization loop decide:
A) sell on the curve at 90–95% filled, B) hold through, C) buy the new pool's open (usually loses to snipers).
Until then: never enter in the last ~10% of the curve; sell 50–75% at 90%+ filled, keep the rest on a tight stop restarted
on the verified pool; no new entries until the pool is verified and the first post-migration sell-off has played out.
Log per graduation: fill time, freeze length, verification time, first 30 min on the new pool, results of A, B and C.

## 17. Costs (from memory; check current prices)

| Item | Start | Comfortable |
|---|---|---|
| Server (worker + Postgres) | $5–10 / month | $20–40 |
| Helius | free (~1M credits) | ~$50 Developer; enhanced websocket may need a higher plan |
| Second RPC | free tier | ~$50 |
| PumpPortal trade stream | $0 (use Helius) | paid key, price unknown |
| GMGN, DEX Screener, Jupiter | free | free |
| Devin | per Cognition pricing | |

Start ≈ $5–60 / month; full setup ≈ $100–600 / month. Live trading costs ~1% per side plus priority fees, tips and
slippage (5–15% round trip on small trades), so paper trading comes first.

## 18. Open items for the user

- Server: VPS or Fly.io (~$5 / month).
- Helius plan: rate limit, and whether it includes the enhanced websocket.
- Second RPC provider (needed by step 2).
- Stage-1 filter thresholds, or "use the defaults".
- Meaning of "paid fees".
- Check how real GMGN and Photon label Bonk and Stonk.fun coins (send the Photon / GMGN data report if they don't show up).
