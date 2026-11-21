// Synthetic coins for testing the engine end to end before real data exists.
// Archetypes are made up; results on fake data prove the plumbing works, not that the rules make money.
import { padConfig, applyBuy, applySell } from './curve.mjs';
import { rng } from './backtest.mjs';

const MIN = 60_000, DAY = 86_400_000;

export const ARCHETYPES = [
  ['runner', 0.12], ['pumpDump', 0.25], ['rug', 0.15], ['wash', 0.10], ['dud', 0.33], ['honeypot', 0.03], ['otherPad', 0.02],
];

function pick(rand, table) { let u = rand(), acc = 0; for (const [k, w] of table) { acc += w; if (u < acc) return k; } return table[table.length - 1][0]; }
const gauss = rand => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const logn = (rand, mean, sigma = 0.8) => Math.exp(Math.log(mean) - sigma * sigma / 2 + sigma * gauss(rand));

export function fakeCoin(rand, id, createdAt, type) {
  const pad = type === 'otherPad' ? 'other' : pick(rand, [['pump', 0.8], ['bonk', 0.15], ['stonk', 0.05]]);
  const cfg = padConfig(pad), creator = `dev${id}`, supply = cfg.supply;
  const coin = {
    mint: `fake${id}${pad}`, pad, creator, createdAt, createdSlot: Math.floor(createdAt / 400), supply, archetype: type,
    provenance: true, mintInfo: { mintAuthority: null, freezeAuthority: type === 'honeypot' ? 'dev' : null, extensions: [] },
    funding: {}, trades: [],
  };
  let r = { vSol: cfg.vSol0, vTok: cfg.vTok0 }, w = 0;
  const hold = new Map();
  const newWallet = funder => { const name = `w${id}_${w++}`; coin.funding[name] = funder ?? `cex${Math.floor(rand() * 5)}`; return name; };
  const buy = (t, wallet, sol) => {
    const n = applyBuy(r, sol, cfg.fee); r = { vSol: n.vSol, vTok: n.vTok };
    hold.set(wallet, (hold.get(wallet) || 0) + n.out);
    coin.trades.push({ t, slot: Math.floor(t / 400), wallet, side: 'buy', sol, tokens: n.out, vSol: r.vSol, vTok: r.vTok });
  };
  const sell = (t, wallet, frac) => {
    const b = hold.get(wallet) || 0, tok = b * frac; if (tok <= 0) return;
    const n = applySell(r, tok, cfg.fee); r = { vSol: n.vSol, vTok: n.vTok };
    hold.set(wallet, b - tok);
    coin.trades.push({ t, slot: Math.floor(t / 400), wallet, side: 'sell', sol: n.out, tokens: tok, vSol: r.vSol, vTok: r.vTok });
  };
  const holders = () => [...hold.entries()].filter(([, b]) => b > 1).map(([k]) => k);
  const randomHolder = (exclude) => { const h = holders().filter(x => !exclude || !exclude.has(x)); return h.length ? h[Math.floor(rand() * h.length)] : null; };

  // Launch: dev buy, plus a creation-slot bundle for rugs.
  buy(createdAt, creator, type === 'rug' ? 3 : 0.5 + rand());
  const insiders = new Set([creator]);
  if (type === 'rug') for (let k = 0; k < 5; k++) { const x = newWallet(creator); insiders.add(x); buy(createdAt, x, 2 + rand() * 2); }
  const washers = []; if (type === 'wash') for (let k = 0; k < 8; k++) washers.push(newWallet(creator));
  const pumpers = []; if (type === 'pumpDump') { const k0 = 4 + Math.floor(rand() * 16); for (let k = 0; k < k0; k++) pumpers.push(newWallet(`syn${id}`)); }

  const life = { runner: 360, pumpDump: 90, rug: 120, wash: 150, dud: 40, honeypot: 180, otherPad: 180 }[type];
  const rugAt = 15 + rand() * 45, dumpAt = 10 + rand() * 50;
  // Runners don't always run: their buy pressure is drawn per coin, and some fade after the first hour.
  const runBias = 0.54 + rand() * 0.12, fadeAt = rand() < 0.35 ? 45 + rand() * 60 : Infinity;
  let t = createdAt;
  while (true) {
    const tau = (t - createdAt) / MIN;
    const lambda = type === 'dud' ? 0.3 : tau < 60 ? 3 : 1.2; // trades per minute
    t += (-Math.log(rand() + 1e-12) / lambda) * MIN;
    const m = (t - createdAt) / MIN; if (m > life) break;
    if (type === 'rug' && m >= rugAt && insiders.size) { for (const x of insiders) sell(t, x, 1); insiders.clear(); continue; }
    let pBuy, size = logn(rand, 0.4);
    switch (type) {
      case 'runner': pBuy = m >= fadeAt ? 0.42 : m < 180 ? runBias : 0.5; break;
      case 'pumpDump': pBuy = m < dumpAt ? 0.75 : 0.25; break;
      case 'rug': pBuy = 0.62; break;
      case 'wash': pBuy = 0.5; break;
      case 'honeypot': pBuy = 1; break;
      default: pBuy = 0.5;
    }
    if (type === 'wash' && rand() < 0.7) { // washers trade among themselves, same sizes
      const x = washers[Math.floor(rand() * washers.length)];
      if ((hold.get(x) || 0) > 1 && rand() < 0.5) sell(t, x, 1); else buy(t, x, 0.5);
      continue;
    }
    if (rand() < pBuy) {
      if (type === 'pumpDump' && m < dumpAt && rand() < 0.5) buy(t, pumpers[Math.floor(rand() * pumpers.length)], size * 2);
      else buy(t, (rand() < 0.7 ? null : randomHolder(insiders)) || newWallet(), size);
    } else {
      const x = type === 'pumpDump' && m >= dumpAt && rand() < 0.5 ? pumpers[Math.floor(rand() * pumpers.length)] : randomHolder(type === 'rug' ? insiders : null);
      if (x && x !== creator) sell(t, x, 0.3 + rand() * 0.7);
    }
  }
  return coin;
}

export function fakeDataset({ n = 2000, days = 14, seed = 1, start = Date.UTC(2026, 9, 1) } = {}) {
  const rand = rng(seed), coins = [];
  for (let i = 0; i < n; i++) coins.push(fakeCoin(rand, i, start + Math.floor(rand() * days * DAY), pick(rand, ARCHETYPES)));
  return coins.sort((a, b) => a.createdAt - b.createdAt);
}
