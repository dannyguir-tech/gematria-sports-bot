# VolTrak: decisions, design notes and roadmap

Everything agreed in the planning conversation, in one place. **Status:** the userscript and the backtest engine exist.
The worker, database, harness, paper trading, optimization loop and live engine below are designs; not built yet.

## 1. Where things stand

- **Userscript 4.9.4** (`voltrak-steroids.user.js`), copy page: https://claude.ai/artifact/Do2dTMB3GAhTZSxyqMT2sD
  - Discord → GMGN handoff, live panel, chain checks (Helius key), GMGN data, verdict bar, monitor (GMGN Scan tab,
    Photon dock), backtest report with a table per rule, CSV export.
  - 4.9.3 was built on the user's own 4.9.2 (4.9.0 + a launchpad filter added outside this repo).
  - 4.9.4 adds "Copy for AI" (list + fixed instructions for Grok etc.) and an AI pick log checked 1 h / 4 h later
    against same-list coins not picked.
- **Backtest engine** (`engine/`, see `engine/README.md`): point-in-time features, rules with safety vetoes, exit
  simulation (runner / steady), day-by-day portfolio, random-coin baseline, filter ablation, Markdown report.
  Runs on fake coins now; waiting for real data from the backfill. 13 tests (`node --test engine/test/engine.test.mjs`).
- **Paper bot** (`bot/`, deploy guide `bot/DEPLOY.md`): live Pumpfun feed (logs or Helius transactions mode,
  reconnects, stale watchdog), coin book, the engine's rules every 30 s, paper desk with the agreed limits and the
  engine's exit code (shared `makePosition`), Telegram alerts + daily report, JSONL events / daily / collected coins,
  state save + restore, `/health` and `/status`. Dockerfile and systemd unit. No wallet. 6 tests with a fake websocket.
  Hosting: Devin sets it up on an always-on server (Devin itself is not a host); the owner types the keys.
- **Tests:** `npm test` (62: 40 userscript, 16 engine, 6 bot). Browser checks were run on simulated pages only: the real
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

Revised after "is this overkill": build only what proves or disproves an edge first.

0. **Backtest on past coins** (done: engine; next: backfill 2–4 weeks of Pumpfun / Bonk / Stonk.fun launches from
   Dune or Helius into the engine's JSONL format). Goals agreed with the user: no rugs (rug rate < 5%), strong coins,
   ≥ 70% green days after costs, worst day ≥ −10%, 2–5% of bankroll per trade, daily loss stop.
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

**Leader schedule and routing** (aim: land reliably within a slot or two, not beat searchers)
- In memory: leader schedule per epoch (cached; 4 slots per leader), validator network addresses (refreshed every few
  minutes), which leaders run Jito, and the current slot from slot subscriptions on two providers, with the worker's
  measured lag behind the chain corrected for.
- Next leaders run Jito → bundle to the Jito block engine region nearest that leader (leader IP → region). Otherwise →
  staked connection (e.g. Helius Sender) with the same tight limit; no raw unstaked sends.
- Send to the current and next leader; skip a leader whose window ends before arrival (measured delay); fresh blockhash
  and short validity on every send. Server near Frankfurt, Amsterdam or New York. Log aimed slot vs landed slot per route.

**Slippage against toxic flow (PumpSwap)**
- limit = own price impact (exact, from reserves and fee) + drift buffer (recent volatility × √expected landing time)
  + fee; capped by a share of expected edge and the 3–5% hard cap.
- Pool toxicity: observed sandwiches on the pool (same wallet before and after a trade in one slot), share of MEV-tagged
  wallets, volatility. Higher → smaller size, tighter limit; above a threshold → skip. Private routing only.
- Every fill logs expected vs actual; a route or pool that keeps filling at the minimum out is flagged and avoided.

**Rent reclamation**
- Full sell: close-account instruction inside the sell transaction (atomic, rent back at once).
- Dust: background sweeper in the lowest-priority queue, only when no trade is in flight, minimal fee, ~10–20 accounts
  per transaction (burn dust + close); skip open positions, coins traded in the last hour, and Token-2022 accounts with
  withheld fees until cleared.
- Signer allows close-account only with rent returned to the trading wallet. Rent paid and returned count in net profit.
  (0.00203928 SOL is a standard token account; Token-2022 accounts with extensions cost more.)

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

## 15b. Disaster recovery

**Crash recovery (worker dies after sending a bundle)**
- Write-ahead order log in Postgres: `INTENT → SIGNED → SENT → LANDED | FAILED | EXPIRED`. Each step is committed before the
  next action. SIGNED stores the signature, the raw signed transaction, the blockhash and its `lastValidBlockHeight`.
  A Solana signature is the transaction's ID, so it is known before sending.
- One open order per (wallet, coin, side): a unique partial index makes a second buy impossible even if two code paths race.
- Single writer: the worker holds a Postgres advisory lock (lease); a restarted process waits until the old one's lock is
  gone, so a zombie and a new process never trade at the same time. The signer refuses orders without the current lease.
- On boot, state = RECOVERING (a circuit-breaker state): no new entries until reconciliation finishes; exits allowed.
- Reconcile in ~3–4 RPC calls, not one per order:
  1. All unfinished signatures in one `getSignatureStatuses` call (up to 256, with transaction history search).
     Found and successful → LANDED; found with an error → FAILED.
  2. Not found and the chain's block height is past `lastValidBlockHeight` → EXPIRED: it can never land, safe to retry
     with a new transaction. Not found and still valid → resend the **same** signed bytes (idempotent) and wait until it
     lands or expires. Never sign a new transaction for an order whose old one can still land. Recent blockhashes only,
     no durable nonces (they never expire, so recovery could not prove a drop).
  3. Truth check: wallet token balances (`getTokenAccountsByOwner`, classic and Token-2022) against the positions table.
     Tokens with no position → "adopted" position, entry from the wallet's transaction history, normal exit rules.
     Position with zero balance → closed, matched to the sell found in `getSignaturesForAddress` since the last checkpoint.
- Sell size always comes from the on-chain balance at signing time, never from the database: no ghost sells, no
  oversized sells.
- Jito bundle status is only a hint (its in-flight status covers ~5 minutes); the signature status is the truth.
- Harness: kill -9 the worker at every state boundary; checks: no double buy, no lost or invented position, no sell larger
  than the balance, recovery finishes within ~10 s.

**Copy-traders and wallet tracking**
- Honest view: copy bots buy after we buy (that pushes the price up, which does not hurt the entry). The harm is on exits
  (they sell alongside us) and in the signal getting crowded. Solana has no public mempool to front-run from, and orders go
  privately through Jito / staked connections.
- Detect it: "followers" = wallets buying the same coin within a few slots after us. The same follower on ≥ 3 of the last
  10 trades → the wallet is tracked.
- Wallet pool in the signer: table `wallets (id, pubkey, key_ref, status active | cooling | retired, opened_at)`. Each
  position stays in one wallet from buy to sell. Rotation changes only which wallet new positions use; a retired wallet
  can still exit, then is swept and closed. Limits apply per wallet **and** across all wallets (rotation must not
  multiply them). Fee and rent float split across active wallets.
- Funding without an obvious link: fund new wallets by withdrawal from an exchange account, and sweep profits back through
  the exchange instead of straight to the cold wallet (a shared cold address links every hot wallet). No mixers (legal and
  sanction risk; mixer-funded wallets also get flagged).
- No fingerprints: no round sizes, no fixed tip, no fixed take-profit levels (split exits), small timing jitter on slow
  "waking up" entries (never on exits).
- Rotate on detection or every ~N trades, not on a fixed clock.

**Load spikes (message rate × 10)**
- Two lanes, two processes (or worker threads), two websocket connections:
  - Exit lane: only coins we hold (pool accounts, holder / insider moves). Small by design; never shares a queue, CPU loop
    or rate budget with discovery. Fallback: one `getMultipleAccounts` for all held pools every ~2 s if its socket lags.
  - Discovery lane: new pairs and candidates.
- Rate budget: token bucket with a reserved share (~40%) for exits and reconciliation; on 429s discovery backs off first.
- Filter at the source (subscribe only to the launchpad programs / accounts needed); the socket reader only parses,
  filters and stores the latest state per coin (updates for the same coin merge; nothing waits in an unbounded queue).
- Shedding ladder by queue fill, slot lag and event-loop delay, with hysteresis:
  - L1: merge updates, skip extra lookups for coins clearly failing stage 1.
  - L2: raise stage-1 thresholds, drop events older than a few slots (stale signals are worthless).
  - L3: disconnect discovery, Degraded breaker, no new entries; the exit lane is untouched.
- Telemetry sheds too: raw-frame archive is dropped first, decisions and orders never.
- Harness scenario: 10× message storm with a socket drop; checks: exit reaction time p99 unchanged, memory bounded,
  no lost exit signal.

## 15c. Searcher competition, blast radius, telemetry without jitter

**Tip auction (many bots on the same graduation tick or whale fill)**
- Jito works like a sealed first-price auction among bundles that touch the same accounts. A bundle that loses costs
  nothing: the tip sits in the same transaction as the swap, so it is paid only when the swap lands. The only way to lose
  money on tips is to win and overpay (winner's curse).
- Bid against the value *given that we win*, not the average value: in a contested race we tend to win when the others
  valued it less. value_if_win = expected profit after fees and slippage at the position we would land in (first in block
  vs later), measured from our own logs of contested trades.
- Shade the bid: tip ≤ value_if_win × (N−1)/N (first-price rule of thumb), with N = competing bots seen recently on that
  pool / event type; and never more than ~30–50% of value_if_win or the absolute cap.
- Concede: if the expected winning tip (landed tips on the same kind of event, recent percentiles) is above that limit →
  skip and log "conceded". Entries are one shot, no tip escalation. Only exits escalate, worth up to the loss avoided.
- Feedback: each contested trade logs tip, landed or not, predicted and realized profit. If realized profit on won races
  falls below predicted, shading increases automatically. If tips plus losses on contested trades are negative over the
  last ~50 → stop contesting that event type.
- Strategy: a co-located searcher wins the graduation tick. Our edge is in what they don't bid on (filters, slower
  "waking up" coins, syndicate and migration analysis), where tips stay near the floor.

**Blast radius (runaway loop from an optimizer bug or an agent)**
Each layer works even if everything above it fails:
1. Float: the hot wallet only holds what you accept losing in a day. Top-ups are manual. Nothing more can drain.
2. Signer policy, outside the worker: per trade max, orders per minute / hour, open positions max, buys in a row without a
   sell, net SOL out over a rolling 10 minutes. Breaking any → LOCKED, latched: only a human unlock (Telegram + passphrase).
   With a hosted policy signer (e.g. Turnkey) the policy is enforced at the provider, so even root on the server can't
   exceed it.
3. Parameters from the optimizer are checked against hard bounds the signer owns; out of bounds → rejected. Devin never
   gets production access.
4. OS: signer is its own user, key file unreadable by the worker, policy file read-only to the worker, systemd limits,
   firewall so only the signer path can send transactions.
5. Watchdog on a second cheap machine: reads the wallet balance every few seconds; an unexplained drop of X% in 5 minutes
   → revoke / stop the signer through its API and alert. A dead-man switch, independent of the main server.
6. Kill switch: Telegram command and, as a last resort, revoking the key at the signer provider.
- Worst case in 30 s with limits like 1 order / 2 s and 0.2 SOL per trade: a few trades, then latched.

**Telemetry without slowing the event loop**
- The hot path never does I/O, JSON or per-tick object creation: it writes fixed-size records into a preallocated ring
  buffer (shared memory). If the buffer is full, it drops and counts, never waits.
- A separate low-priority process (nice / ionice idle, other CPU cores) drains the buffer, batches it and writes Parquet
  every ~60 s or ~100k rows. DuckDB only reads finished files, never inside the hot process.
- Volume control: decisions and orders kept 100%; ticks become 1-second bars per coin; latencies go into histograms, with
  full traces only sampled or around orders.
- Main risk in Node is garbage collection, not disk: typed arrays, no allocation per tick, larger young generation.
- Measured: event-loop delay p99 alert above ~5 ms; harness storm test with the writer running.
- Honestly, sub-10 ms matters little here: network delay to the leader is tens of ms. If the hot path ever needs better,
  port it to Rust.

## 15d. Forks, fee forecasting, integer math

**Forks and commitment levels**
- Premise check (from memory, verify): short forks drop *processed* blocks. "Confirmed" means 2/3 of stake voted for the
  block, and no confirmed block is known to have been rolled back on mainnet since optimistic confirmation. Still designed
  for it.
- Three levels per order: processed = seen, nothing changes. Confirmed = act on it (free the slot, next decision, start
  exit timers). Finalized (~32 slots, ~13 s) = accounting truth: position closed, PnL booked.
- States: `SENT → CONFIRMED → FINALIZED`, plus `ORPHANED`. A confirmed signature whose status disappears before finalized
  (batch status checks every few seconds) → ORPHANED. The position goes back to open, the exit rules run again.
- Orphaned but blockhash still valid → resend the same signed bytes (usually lands in the next block). Expired → new
  sell, sized from the balance read at confirmed commitment.
- Sells are safe to repeat: sized from the balance, so if the old sell lands too, the second fails for lack of tokens
  (cost: a fee). Buys never: no new buy while the old one can still land (section 15b).
- Balances for sizing are read at confirmed, never processed (processed balances can come back after a fork).
- Harness: fake chain drops a confirmed block now and then; checks: no lost inventory, no double sell, exit retried in
  time.

**Priority fees**
- Fees are local: the price depends on the accounts the swap writes to (the pool), not the whole chain. Forecast per pool:
  Helius `getPriorityFeeEstimate` with the transaction's account keys, plus `getRecentPrioritizationFees` for those
  accounts, plus our own landing log.
- Biggest overpay is the compute limit: fee = price × limit. Limit = simulated units + 10%, never the 200k default.
- Percentile by urgency: entries ~50th–75th, exits ~75th–95th. Smoothed over recent slots, jumps on a detected spike.
- Our own calibration: from every send, P(lands within k slots | fee percentile, route). Pick the lowest fee that reaches
  the target landing rate.
- Caps in the signer: lamports per transaction and share of trade value; nothing pays 100× by mistake.
- Starvation: entries not landed in ~3–5 slots → cancel. Exits escalate ×1.5 per retry up to the cap.
- On the Jito route the tip decides ordering; priority fee stays near the floor there. The forecast matters for the
  staked-connection route.

**Integer math**
- All amounts are BigInt, read straight from account bytes (u64 little-endian). Never JS numbers (exact only to 2^53) or
  "UI amounts". Decimals come from the mint. Floats only for display and analytics.
- BigInt can't overflow, so the guard is range checks: every input and result must fit u64 (and intermediates u128, as
  in the program); otherwise reject the quote.
- "Zero precision loss" isn't possible with integer division; the goal is a bit-exact match with each program's own
  formula and rounding: outputs round down, inputs up, fees in the program's order (Pump curve, PumpSwap LP + protocol +
  creator fees, Raydium CPMM).
- Slippage in basis points with integers: `minOut = quote × (10000 − bps) / 10000`, rounded down.
- Safety: the program enforces the minimum on chain, so a math error causes a failed transaction (a fee), not a bad fill.
  The real risks are elsewhere: Token-2022 transfer fees and hooks (received < output), fake pools (check the pool
  account's owner program and mints), absurd supplies or reserves (range checks).
- Tests: golden tests comparing our quote with `simulateTransaction` on recorded pool states (must match exactly); fuzz
  against the program's own Rust code with random values up to u64 max; property tests (output never above reserves,
  round trip never profitable).

## 15e. Split-brain providers, fragmented pools, profit sweeping

**Providers disagree on the slot (A says N, B says N+12)**
- 12 slots ≈ 5 s. Almost always one provider is lagging, not lying.
- Each provider has its own cursor: latest confirmed slot, time since last update, rate of advance (~2.5 slots / s).
  Engine slot = highest confirmed slot from a healthy provider. It never goes backwards.
- A provider more than ~4 slots behind the engine slot is Degraded: its live events are tagged stale and used only for
  gap fill. Execution keeps running on the healthy one; no halt.
- Ahead or suspicious? A provider that jumps forward far faster than the chain can move, or that a third witness (a free
  endpoint's `getSlot` every few seconds) does not back up, is quarantined instead.
- No ghost slots: decisions use confirmed data only. An entry signal seen on one provider only is checked on the other
  (`getSignatureStatuses`) before buying. Exit signals act on one provider (a false exit costs little, a missed one a lot).
- Events from both providers are merged by signature (idempotent), ordered by slot then position in the block.
- Entries need at least one provider fresh within ~2 slots of the engine slot; exits are always allowed. Both stale or
  in disagreement → Degraded / Blind (section 11).

**Fragmented pools after graduation**
- Pool registry per coin. Canonical pool = the one the migration created (known address, section 16b). Other pools
  (Meteora, Raydium, …) are untrusted until: liquidity above X SOL, LP burned or locked, some minimum age, real volume
  from many wallets, pool owned by the expected program, correct mints.
- Fair price comes from the canonical pool (or volume-weighted across trusted pools), never from an untrusted pool.
- Minimum out is computed from the fair price minus our own price impact, not from the pool's own quote. A thin or
  pushed pool then fails the minimum and the transaction just doesn't fill.
- Routing: direct pool math (section 15d) or Jupiter restricted to trusted pools. Split across trusted pools only when it
  beats a single pool after fees, all legs in one transaction (no leg can be picked off between transactions).
- A pool trading more than ~X% away from the fair price is being arbitraged: don't trade into it.
- Volume on untrusted pools is excluded from the demand pillar (likely wash).

**Profit sweeping without linking wallets**
- Everything on Solana is public. This hides wallets from copy bots, not from the exchange or tax authorities: every
  sweep is logged in the database for taxes. No mixers or privacy pools (legal and sanction risk).
- Route: hot wallet → exchange deposit address → (you) → cold wallet. Never hot → hot or hot → cold directly.
- One exchange sub-account per hot wallet where the exchange offers it: a shared deposit address would link the wallets.
- Funding: withdrawals from the exchange (its hot wallet funds millions of users, so it links nothing).
- Sweeper lives in the signer. The only allowed destinations are the deposit addresses on an allowlist that only you can
  change (approval + passphrase).
- Not on a fixed schedule: sweep when the balance is above the float target by a margin, at a random time in a window of
  hours, with non-round amounts, and preferably when a wallet is retired.
- Exchange → cold: manual, or an exchange API key whose only withdraw address is the cold wallet (exchange whitelist),
  kept on a different machine from the trading server.

## 15f. Hardware-backed signing, malicious tokens, live canary

**Signing with KMS / Nitro Enclaves / YubiHSM**
- Threat model: an attacker with root on the VPS can't *copy* a key held in an HSM or enclave, but can still *ask it to
  sign*. A key store that signs any bytes it's given stops theft, not a drain. The policy has to sit inside the same
  protected boundary as the key.
- Options, best fit first:
  1. Hosted policy signer (e.g. Turnkey: keys in secure enclaves, policy engine checks each transaction). No hardware to
     run; cost per their pricing.
  2. AWS Nitro Enclave: an isolated VM with no network or disk; the parent instance (even root) can't read its memory.
     The key is encrypted with KMS; the KMS key policy only decrypts for an enclave whose attested image hash (PCRs)
     matches ours. The enclave decodes each Solana transaction, applies the policy (programs, destinations, amounts,
     rate limits, latched lock) and only then signs. Needs an enclave-capable EC2 instance (roughly $70–150 / month,
     check), not a $5 VPS.
  3. AWS KMS alone: verify current Ed25519 support. Even if supported, KMS can't read Solana transactions, so it gives no
     policy: an attacker signs a drain. Only useful inside option 2.
  4. YubiHSM 2: supports Ed25519, but it's a USB device (needs our own hardware, not a VPS) and can't apply a
     transaction policy either. Fine for the cold wallet, not for the hot path.
- No "ephemeral session keys" are needed: the hot key is long-lived and stays in the enclave; the session between worker
  and enclave is authenticated (vsock + attestation). Zero-knowledge proofs don't apply to this problem.
- The small float (section 15c) stays the final limit whatever the signer is.

**Malicious tokens and honeypots**
- Premise check: Solana tokens don't carry their own bytecode. Pumpfun, Bonk and Stonk.fun mints use the shared SPL Token
  / Token-2022 programs. The traps are in mint settings and fake launches, not custom contract code.
- Static checks, one `getAccountInfo` on the mint (usually already in hand from the create transaction), reject if:
  mint authority not revoked; freeze authority set; Token-2022 transfer hook, permanent delegate, non-transferable,
  default-frozen accounts, pausable, or transfer fee above a small cap.
- Launch provenance: the mint must be created by the launchpad program itself, with its curve account at the expected
  address owned by that program. A mint that merely ends in "pump" or "bonk" but was made elsewhere → reject. After
  graduation, pool owner program and mints are checked (sections 16b, 15e).
- Sell simulation, only for coins about to be bought: simulate buy then sell of the received amount in sequence (Jito
  `simulateBundle`, or local curve math for bonding curves). Sell fails or returns below X% → skip. Catches honeypots
  whatever the mechanism; adds ~50–150 ms.
- Upgradeable launchpad programs: watch the upgrade events of every program on our allowlist; an upgrade pauses entries
  on that program until re-verified (the honeypot risk at the platform level).
- Dev / funder history from the syndicate graph (section 16).

**Live canary and shadow execution**
- Shadow: every live decision also builds and simulates its transaction without sending it; logs expected fill and
  compute units, compared later with the actual price at the target slot.
- Canary: real sends with tiny amounts, on a random subset of the shadow decisions (random, so canary fills are
  comparable to the shadow predictions on the same decisions), from a separate wallet never reused.
- What tiny trades measure: landing rate, latency, fees and tips, quote math matching the program exactly, failure modes.
  What they don't: price impact at real size. That comes from the curve math (exact-match tests, section 15d) and a ramp:
  1% → 10% → 25% → 100% of target size, each step with its own gate.
- Cost per trade: base fee, priority fee, tip floor, 1% launchpad fee, and token-account rent (~0.002 SOL), which is
  returned by closing the account in the sell.
- Market makers: bonding curves have none, and a tiny order is invisible among bots. The real watcher is copy bots, hence
  the separate, single-use canary wallet.
- Telemetry: every order tagged `mode` (paper / shadow / canary / live) and size class. Canary rows are kept out of
  strategy statistics and the optimization dataset; used only for execution metrics, measured in basis points with
  medians and percentiles (fixed costs reported separately, since they dominate tiny trades).

## 15g. Launchpad adapters, location, the slippage formula

**One parser, one adapter per launchpad**
- The three launchpads are Pumpfun (graduates to PumpSwap), Bonk (built on Raydium LaunchLab, graduates to a Raydium
  pool) and Stonk.fun (program and graduation path still to be confirmed from recorded transactions). Verify each
  graduation and LP handling on recorded transactions before trusting it.
- One worker. Each instruction is routed by its program ID to an adapter; accounts are recognised by their 8-byte
  discriminator and decoded from layouts generated from the program's IDL (declarative, not hand-written parsers).
- Adapter interface: program IDs; decode create / trade; curve state → {virtual and real reserves, fee, complete};
  graduation detection → {new pool, pool program, LP mint, LP action: burned / locked / fee-key}; pool math for the
  destination pool; expected LP handling and timings.
- Adapters emit one shared event model: Launch, Trade, CurveProgress, GraduationStarted, PoolCreated, LpBurned / LpLocked,
  Migrated. The migration state machine (section 16b), the rules and the database only see these events.
- Unknown discriminator, layout mismatch or a program upgrade → that launchpad is marked unverified and its entries pause
  (section 15f). Adding a launchpad = one adapter file + recorded fixtures; golden tests per adapter.

**Location against co-located searchers**
- We won't win speed races against co-located Rust searchers and don't try (section 15c). Being beaten in a race isn't
  being front-run: min-out caps the damage and a bundle that misses its price fails at no cost. Sandwiches are prevented
  by private routing and tight limits.
- Server in Amsterdam or Frankfurt (Jito block engines there, a large share of stake in Europe), ~1–5 ms to the block
  engine. Jito forwards bundles to the leader over its own network.
- Optional small relays (~$5 each) in New York and Tokyo: hold signed transactions sent from the main worker and submit to
  the local block engine / staked endpoint when the leader is nearer to them. Worth it only if the landing log shows
  misses on far leaders.
- Data latency matters more than send latency: same-region data provider first; a gRPC stream (Yellowstone / LaserStream)
  instead of websockets if the funnel measures it as a bottleneck (costs more).

**Slippage formula (constant product: PumpSwap, Raydium, and bonding curves on virtual reserves)**
```
x, y   reserves in / out (bonding curve: virtual reserves; out capped by real reserves)
f      total fee share, a = Δx·(1−f) effective input
quote  Δy = y·a / (x + a)                     (integer, rounded down; section 15d)
impact I = 1 − (1−f)·x / (x + a)              (vs mid price; decides size, not tolerance)

tolerance covers what changes between quote and landing:
  drift   s_d = z·σ·√τ                         σ: EWMA volatility per √second of the pool, τ: expected landing time
                                               for the route (from the landing log), z ≈ 1.65
  crowd   s_c = 1 − x(x+a) / ((x+q')(x+q'+a))  q' = q·(1−f), q = same-direction volume expected ahead of us
                                               (p75 per slot × landing slots, raised for toxic pools)
  round   ε   = a few bps
  s = s_d + s_c + ε
  cap = min(hard cap 3–5%, κ · expected edge), κ ≈ 0.5
  s > cap → skip the trade (don't widen)
minOut = Δy · (10000 − ceil(s·10000)) / 10000   (integers)
```
- Sells use the same formula with token in, SOL out.
- Example: x = 60 SOL, buy 0.5 SOL, f = 1%: I = 1.81%. σ = 0.8% / √s, τ = 0.8 s → s_d = 1.18%.
  Calm (q = 0.3 SOL) → s_c = 0.98%, s ≈ 2.2% → trade. Crowded launch (q = 2 SOL) → s_c = 6.26%, above the cap → skip.
  Making the order smaller barely changes the crowd term, so crowded moments are skipped, not traded smaller.
- Every fill logs predicted vs actual; σ, τ and q are recalibrated from those logs.

## 15h. Cluster halt and restart

Context (from memory, verify): in the Feb 2024 outage (~5 h) validators restarted from an agreed slot with patched
software (a hard fork from the last optimistically confirmed slot). What happened before that slot survived; anything
seen only as processed after it was gone. No leverage here, so nothing can be liquidated; the real risks are stale signed
buys landing after restart, timers firing at once, and quotes on pre-halt reserves.

**Key fact:** a transaction's validity counts blocks, not time. No blocks during a halt → a buy signed before the halt can
still land in the first ~150 blocks after restart (~1 min), at a price assumption hours old.

**Detection: HALTED state (circuit breaker)**
- Engine slot not advancing for ~10 s on both providers and the third witness, while they still answer (if they time out,
  it's our network, not the cluster). Confirmed by the watchdog in another region.
- On HALTED: freeze all sends (no resend spam: queued transactions could land later), pause every exit timer (rules run
  on slot time, not wall-clock time, so a 5-minute rule doesn't fire the instant blocks resume), snapshot state, alert.

**Stale buys can't land late**
- Every buy carries a time bound: an on-chain assertion instruction (e.g. Lighthouse; verify current support) that fails
  the transaction if the cluster clock is more than ~30 s past signing time. Clock time jumps forward after a halt, so a
  pre-halt buy fails at no cost instead of filling. Slot-based bounds don't work here (slots don't move during a halt).
- Without that instruction: entries stay frozen until the block height passes every in-flight buy's last valid height;
  any that landed are adopted by reconciliation and exit normally.
- Sells need no bound: sized from the balance, a late one can't oversell (section 15b).

**Restart**
1. Restart detected: slots advancing again at a normal rate, both providers agree, software / shred version changed.
   Allow a rebase: the engine slot may go *back* to the restart slot. Everything seen after it that wasn't finalized is
   re-verified.
2. Reconcile (section 15b): one batch status call for all in-flight signatures, wallet balances against positions
   (adopt / close), Jito bundle status ignored (expired anyway).
3. Market state reset: every cached reserve, price, volatility and crowd estimate is dropped; all curve and pool accounts
   re-read at confirmed (`getMultipleAccounts`, ~100 per call). Price = unknown until a few slots of real trades.
4. Restart window (~5 min or N slots): no entries. Exits only on rug signals (dev selling, coordinated insider exit) or
   rules evaluated on fresh state; tolerance uses post-restart volatility, so most trades get skipped rather than
   dumped into a thin book. Emergency exits may raise the cap up to the position's value.
5. Back to Healthy only after the window and the normal 2-clean-minutes rule (section 11).

**Rent**
- Token accounts are created inside the buy transaction (idempotent create); a failed buy creates nothing. Tips sit
  inside the swap transaction, so a dead bundle pays nothing.
- Orphan or empty token accounts from any path appear in the balance scan and are closed by the dust sweeper.

**Harness:** halt scenario (blocks stop for 5 fake hours with orders in flight, restart from an earlier slot,
clock jump). Checks: no stale buy fills, no double spend, no timer fires on restart, no quote on pre-halt reserves, every
rent account accounted for.

## 15i. Zero-copy decoding, compute units, wash rings, off-box exits, migration buys

Tier per item: [now] before any money, [live] before live money, [later] only if logs show it costs money (section on
scope in the conversation: build the first tier first).

**Zero-copy decoding [later]**
- The plan is Node; Rust only if the hot path measures too slow (section 15c). Same ideas apply in both.
- Websocket frames are JSON with base64 account data: JSON parsing allocates, so zero-copy only pays off on binary feeds
  (gRPC / protobuf). Rust: pooled frame buffers, in-place parser (simd-json / sonic-rs) with borrowed strings, base64 into
  a reused scratch buffer, per-frame arena reset after each frame, mimalloc / jemalloc, no logging allocations.
- Fixed-layout accounts (8-byte discriminator + fixed fields, e.g. a bonding curve's reserves) are read in place:
  `zerocopy` / `bytemuck` on `#[repr(C)]` structs with unaligned field types, or direct little-endian reads at known
  offsets (`Buffer.readBigUInt64LE` in Node). Layouts and offsets come from the IDL and are checked by golden tests.
  Variable-length Borsh fields (strings, vectors) can't be cast; only the fixed prefix that's needed is read.

**Compute units [live]**
- "Exact" isn't possible: state can change between estimate and execution (e.g. token account exists or not).
- Profile table per (program, instruction path, token account exists?) built from landed transactions
  (`computeUnitsConsumed`): limit = p99 + small margin. No simulation on the hot path; simulate (limit 1.4M, read
  `unitsConsumed`) only for paths not in the table yet.
- The fee is price × *requested* limit, so a tight limit is the main saving; smaller requests also schedule more easily.
- An out-of-compute failure still pays the fee: alert if more than ~0.5% fail that way, then raise the margin.

**Wash trading and circular funding [now, simple version]**
- Only for coins that pass stage 1, and only their top ~30 buyers (bounded cost, cached).
- Funding lookup up to 2–3 hops back; exchange hot wallets and big shared services are stop nodes (everyone is funded by
  them, so they link nothing). Union-find clusters (section 16).
- Wash signals: the same cluster on both buy and sell sides; round trips (a cluster buys and sells back within minutes,
  net position ~0); SOL cycles A→B→C→A in a short window (bounded depth-first search, depth ≤ 4); fresh wallets funded
  minutes before whose first trade is this coin; same sizes / same timing (the script's existing tape checks).
- Output: organic volume = volume minus intra-cluster round trips. The demand pillar uses organic volume; organic share
  below X% → reject.

**Off-box dead man switch [live]**
- Watchdog on a $5 server in another region (not a cron service with minute granularity).
- Main worker sends a signed heartbeat every ~2 s. No heartbeat for ~20 s and the main box unreachable from two vantage
  points → takeover in exit-only mode, Telegram alert.
- Signing: the watchdog has its own credential at the hosted policy signer, whose policy allows only selling tokens the
  wallet already holds for SOL into the same wallet: no buys, no transfers. A compromised watchdog can at worst sell.
- Lease outside the main box (signer lock or a small hosted store) so the main worker, when it comes back, sees the
  takeover and stays in RECOVERING until handed back. Sells are sized from the balance, so overlap can't oversell.
- Exit policy: no instant dump. Fresh quotes, tightened stops, exit everything within N minutes with the normal
  slippage cap; immediate exit on rug signals. Telegram "sell all" also goes through the watchdog.

**Migration buys as a free oracle [live]**
- Solana has no public mempool (Jito's was shut down in 2024): a bundle sent directly to Jito or a trusted staked sender
  isn't visible before it lands. Never use RPCs or relays that sell order flow.
- Swap and tip in one transaction (an unbundled tip can't be paid without the swap).
- Jito's "don't front" marker account (verify current support), so nobody can be placed ahead of our transaction inside a
  bundle.
- Leader-aware sends: skip slots of leaders flagged for sandwiching (public MEV data), wait for the next leader.
- Tight minimum out from the destination pool's exact starting price (known from the migration parameters).
- Mostly moot: the plan doesn't buy in the migration block; it waits for LP verification (section 16b), so there's no
  first-in-block race to leak.

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
