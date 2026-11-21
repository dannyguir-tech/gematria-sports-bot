// Settings come from environment variables (set them on the server; never commit keys).
import { DEFAULT_PARAMS } from '../../engine/src/rules.mjs';
import { POLICIES, DEFAULT_COSTS } from '../../engine/src/sim.mjs';

const num = (v, d) => (v == null || v === '' || !Number.isFinite(+v) ? d : +v);

export function loadConfig(env = process.env) {
  const key = env.HELIUS_API_KEY;
  return {
    rpcUrl: env.RPC_URL || (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null),
    wsUrl: env.WS_URL || (key ? `wss://mainnet.helius-rpc.com/?api-key=${key}` : null),
    feedMode: env.FEED_MODE === 'transactions' ? 'transactions' : 'logs', // transactions = Helius enhanced websocket
    telegramToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramChat: env.TELEGRAM_CHAT_ID || null,
    dataDir: env.DATA_DIR || './data',
    port: num(env.PORT, 8080),
    tzOffsetMin: num(env.TZ_OFFSET_MIN, 0),           // day boundary for reports (0 = UTC)
    scanMs: num(env.SCAN_MS, 30_000),
    staleMs: num(env.STALE_MS, 30_000),               // no message this long = reconnect + Degraded
    maxTracked: num(env.MAX_TRACKED, 30_000),
    collect: env.COLLECT || 'all',                    // all | active | off: write finished coins for the backtest
    alerts: env.ALERTS || 'trades',                   // trades | daily | off
    policy: POLICIES[env.EXIT_STYLE] || POLICIES.runner,
    costs: DEFAULT_COSTS,
    params: DEFAULT_PARAMS,
    paper: {
      bankroll: num(env.PAPER_BANKROLL, 10), sizeFrac: num(env.SIZE_FRAC, 0.03), maxTradesPerDay: num(env.MAX_TRADES_PER_DAY, 15),
      maxOpen: num(env.MAX_OPEN, 4), dailyLossCap: num(env.DAILY_LOSS_CAP, 0.10),
    },
  };
}

// What can be shown in logs (no keys).
export function redact(cfg) {
  return { ...cfg, rpcUrl: cfg.rpcUrl ? cfg.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***') : null, wsUrl: cfg.wsUrl ? cfg.wsUrl.replace(/api-key=[^&]+/, 'api-key=***') : null,
    telegramToken: cfg.telegramToken ? '***' : null, params: undefined, costs: undefined };
}
