// Constant-product math for bonding curves (virtual reserves) and pools.
// Backtest only: plain numbers (SOL, whole tokens). Live execution uses integer math (roadmap 15d).

export const PADS = {
  // Pumpfun defaults (from memory; verify against recorded transactions before trusting real-data results).
  pump: { vSol0: 30, vTok0: 1_073_000_000, realTok0: 793_100_000, supply: 1_000_000_000, fee: 0.01 },
  // Bonk (Raydium LaunchLab) and Stonk.fun: placeholders until their curve parameters are confirmed.
  bonk: { vSol0: 30, vTok0: 1_073_000_000, realTok0: 793_100_000, supply: 1_000_000_000, fee: 0.01 },
  stonk: { vSol0: 30, vTok0: 1_073_000_000, realTok0: 793_100_000, supply: 1_000_000_000, fee: 0.01 },
};
export const padConfig = pad => PADS[pad] || PADS.pump;

export const spot = (vSol, vTok) => vSol / vTok;

// SOL in -> tokens out; fee taken from the SOL input.
export function buyOut(vSol, vTok, solIn, fee) {
  const a = solIn * (1 - fee);
  return (vTok * a) / (vSol + a);
}

// Tokens in -> SOL out; fee taken from the SOL output.
export function sellOut(vSol, vTok, tokIn, fee) {
  const gross = (vSol * tokIn) / (vTok + tokIn);
  return gross * (1 - fee);
}

// Reserves after a trade (fee leaves the pool, so only the net amount moves the curve).
export function applyBuy(r, solIn, fee) {
  const a = solIn * (1 - fee), out = (r.vTok * a) / (r.vSol + a);
  return { vSol: r.vSol + a, vTok: r.vTok - out, out };
}
export function applySell(r, tokIn, fee) {
  const gross = (r.vSol * tokIn) / (r.vTok + tokIn);
  return { vSol: r.vSol - gross, vTok: r.vTok + tokIn, out: gross * (1 - fee) };
}

// Fill reserves on trades that lack them, replaying the curve from launch.
export function fillReserves(coin) {
  const cfg = padConfig(coin.pad);
  let r = { vSol: cfg.vSol0, vTok: cfg.vTok0 };
  for (const tr of coin.trades) {
    if (Number.isFinite(tr.vSol) && Number.isFinite(tr.vTok)) { r = { vSol: tr.vSol, vTok: tr.vTok }; continue; }
    // Trades carry both legs; move reserves by the token leg and the SOL leg net of fee.
    if (tr.side === 'buy') r = { vSol: r.vSol + tr.sol * (1 - cfg.fee), vTok: r.vTok - tr.tokens };
    else r = { vSol: r.vSol - tr.sol / (1 - cfg.fee), vTok: r.vTok + tr.tokens };
    tr.vSol = r.vSol; tr.vTok = r.vTok;
  }
  return coin;
}
