// The trading rules: one pure function shared by the backtest and (later) the worker.
// Safety vetoes always apply; filters can be switched off one at a time for the ablation report.

export const ALLOWED_PADS = new Set(['pump', 'bonk', 'stonk']);
const BAD_EXTENSIONS = new Set(['transferHook', 'permanentDelegate', 'nonTransferable', 'defaultAccountState', 'pausable']);

export const DEFAULT_PARAMS = {
  minAgeMin: 2, maxAgeMin: 120,
  minMcapUsd: 8_000, maxMcapUsd: 300_000,
  minUniqueBuyers: 40,
  minVol5mSol: 5,
  minBuyShare5m: 0.55,
  minPriceChange5m: 0,
  maxDrawdownFromAth: 0.4,
  maxTop10: 0.35,
  maxDevShare: 0.08,
  maxDevSoldFrac: 0.25,
  maxBundleShare: 0.15,
  minOrganicShare: 0.6,
  maxSameSizeShare: 0.5,
  maxTransferFeeBps: 100,
};

// Filters: [name, test(features, params)]. Order = how they are reported.
export const FILTERS = [
  ['age', (f, p) => f.ageMin >= p.minAgeMin && f.ageMin <= p.maxAgeMin],
  ['mcap', (f, p) => f.mcapUsd >= p.minMcapUsd && f.mcapUsd <= p.maxMcapUsd],
  ['buyers', (f, p) => f.uniqueBuyers >= p.minUniqueBuyers],
  ['volume', (f, p) => f.vol5m >= p.minVol5mSol],
  ['buyShare', (f, p) => f.buyShare5m >= p.minBuyShare5m],
  ['momentum', (f, p) => f.priceChange5m >= p.minPriceChange5m],
  ['notDumped', (f, p) => f.drawdownFromAth <= p.maxDrawdownFromAth],
  ['top10', (f, p) => f.top10Share <= p.maxTop10],
  ['devHolding', (f, p) => f.devShare <= p.maxDevShare],
  ['devSelling', (f, p) => f.devSoldFrac <= p.maxDevSoldFrac],
  ['bundles', (f, p) => f.bundleShare <= p.maxBundleShare],
  ['organic', (f, p) => f.organicShare == null || f.organicShare >= p.minOrganicShare],
  ['sameSize', (f, p) => f.sameSizeShare <= p.maxSameSizeShare],
];

// Safety vetoes from the coin itself (mint settings, launch provenance). Never switched off.
export function safetyVetoes(coin, p = DEFAULT_PARAMS) {
  const v = [], m = coin.mintInfo || {};
  if (!ALLOWED_PADS.has(coin.pad)) v.push('launchpad');
  if (coin.provenance === false) v.push('notFromLaunchpad');
  if (m.mintAuthority) v.push('mintAuthority');
  if (m.freezeAuthority) v.push('freezeAuthority');
  for (const e of m.extensions || []) if (BAD_EXTENSIONS.has(e)) v.push('ext:' + e);
  if ((m.transferFeeBps || 0) > p.maxTransferFeeBps) v.push('transferFee');
  return v;
}

export function decide(features, coin, params = DEFAULT_PARAMS, disabled = null) {
  const vetoes = safetyVetoes(coin, params);
  const fails = [];
  for (const [name, test] of FILTERS) if (!(disabled && disabled.has(name)) && !test(features, params)) fails.push(name);
  return { buy: vetoes.length === 0 && fails.length === 0, vetoes, fails };
}
