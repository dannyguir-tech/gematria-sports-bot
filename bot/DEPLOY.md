# Deploying the paper bot

For whoever sets up the server (you, or an AI agent such as Devin acting for you).

## What this is

A **paper-trading** bot. It watches every new Pumpfun launch live, applies the rules in `engine/src/rules.mjs`
every 30 seconds, and records fake buys and sells at real prices with the exits in `engine/src/sim.mjs`.
It sends Telegram alerts and a daily report, and saves every finished coin so the backtest can run on real data.

**It has no wallet and cannot spend money.** The only secrets are a Helius API key (read-only data) and an optional
Telegram bot token.

### Rules for an agent doing this deployment

- Never ask for, create, store or handle a **wallet private key or seed phrase**. This bot doesn't need one, ever.
- The owner types the Helius key and Telegram token into the server's settings themselves (env file or the hosting
  dashboard). Don't paste them into chat, code, git, logs or screenshots.
- Don't change the trading rules, exits or limits. Deploy what is in the repo.
- Do not add real trading.

## Requirements

- Node.js **22 or newer** (it uses Node's built-in WebSocket; no npm packages needed).
- An always-on machine: ~1 vCPU, 1 GB RAM, 10 GB disk is plenty.
- A persistent folder for `DATA_DIR` (events, daily reports, collected coins, `state.json`).
- Outbound internet to `mainnet.helius-rpc.com` (and `api.telegram.org` for alerts).

## Settings (environment variables)

See `bot/.env.example`. Required: `HELIUS_API_KEY`. Recommended: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Telegram setup (owner): message **@BotFather** → `/newbot` → copy the token. Send any message to the new bot, then
get your chat id (for example from **@userinfobot**).

## Option A: a plain Linux server (Hetzner, DigitalOcean, …), systemd

```bash
# as root on Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git
useradd --system --create-home --home-dir /var/lib/voltrak voltrak
git clone <this repo URL> /opt/voltrak && cd /opt/voltrak && git checkout <branch>
npm test                                     # all tests must pass before starting
install -m 600 -o root -g root /dev/null /etc/voltrak-bot.env
# The OWNER edits /etc/voltrak-bot.env now (nano /etc/voltrak-bot.env) and adds at least:
#   HELIUS_API_KEY=...
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_CHAT_ID=...
#   DATA_DIR=/var/lib/voltrak/data
cp bot/deploy/voltrak-bot.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now voltrak-bot
journalctl -u voltrak-bot -f                 # live log
curl -s localhost:8080/status                # numbers
```

Update later: `cd /opt/voltrak && git pull && npm test && systemctl restart voltrak-bot`.

## Option B: Railway / Fly.io / Render (Docker)

- Build from the repo root with `bot/Dockerfile`.
- Mount a **persistent volume at `/data`** (without it, the collected coins and state are lost on every deploy).
- Add the environment variables in the platform's dashboard (owner types the key).
- Health check path: `/health` on port 8080 (returns `ok`, or 503 while the feed is down).

## First hour checklist

Open `/status` (or watch the log line printed every minute):

| Field | Healthy |
|---|---|
| `feed.connected` | `true` |
| `feed.msgs` | rising fast (Pumpfun is busy) |
| `feed.events` | rising |
| `counts.launches` | rising: new coins seen |
| `tracked` | hundreds to thousands |
| `counts.signals` | may stay 0 for a while: coins need 2+ minutes and must pass every filter |

**If `msgs` rises but `events` stays 0** (the bot also sends a Telegram hint): Pumpfun's events are not in the
transaction logs on this setup. Set `FEED_MODE=transactions` (uses Helius's enhanced `transactionSubscribe`,
which needs a Helius plan that includes it) and restart.

**If `connected` is false / reconnects keep rising:** check the key, the plan's websocket limits, and outbound access
to `mainnet.helius-rpc.com`.

Cost note: the Pumpfun feed is large. Check how your Helius plan counts websocket data, and watch usage the first day.

## What it produces

In `DATA_DIR`:

- `events-YYYY-MM-DD.jsonl`: every signal (with its features), paper entry, partial sale, exit, veto, feed up/down.
- `daily.jsonl`: one line per day (P&L, trades, wins, rugs, bankroll).
- `coins-YYYY-MM-DD.jsonl`: every coin after its 6-hour window, in the backtest format.
- `state.json`: paper bankroll and history, saved every minute and on shutdown.

Backtest on the collected coins (any machine with Node 22):

```
node engine/bin/backtest.mjs --data /var/lib/voltrak/data
```

## Behaviour worth knowing

- Only coins launched **after** the bot starts are tracked (their age is known exactly).
- Pumpfun only for now. Bonk and Stonk.fun need their own decoders.
- Trades after graduation (PumpSwap) aren't followed yet: a position still open at graduation exits on its time rule
  at the last curve price.
- Mint settings (mint / freeze authority, Token-2022 extensions) are checked once per coin, only when it passes
  every other filter (one RPC call).
- Feed down 30 s+ → reconnect with backoff; no new entries until 60 s of steady data; Telegram alert after 60 s.
- On shutdown (SIGTERM) open paper positions are sold at their last price ("shutdown"). After a crash they are
  counted at their last saved value ("restart").
