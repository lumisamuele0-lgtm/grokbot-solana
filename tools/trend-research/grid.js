// Ricerca TREND 2–4H (walk-forward, costi inclusi). Uso: node fetch-klines.js ./bt-data 730 15m (SYMS=JUPUSDT,... per le cripto spot);
// DATA=./bt-data TFS=2h,4h MINPM=2 SPOT=JUP,RAY,JTO,PYTH,RENDER,W,ORCA,KMNO node grid.js perp|spot ; node summary.js 2h,4h ; node pick.js
'use strict';
const B = require('./bt');
const SPOT = (process.env.SPOT || 'JUP,RAY,JTO,PYTH,RENDER,W,ORCA').split(',').filter(Boolean);
const ENTRIES = []; for (const [f, s] of [[10, 30], [20, 50], [20, 100]]) for (const filt of ['none', 'htf', 'e200']) ENTRIES.push({ fam: 'cross', f, s, filt });
for (const n of [20, 55, 100]) for (const filt of ['none', 'htf', 'e200']) ENTRIES.push({ fam: 'donch', n, filt });
const EXITS = []; for (const sl of [1.5, 2.5, 4]) for (const tr of [2, 3, 5, 8]) for (const act of [1]) EXITS.push({ sl, tr, act });
const CFG = []; for (const tf of (process.env.TFS || '15m,1h').split(',')) for (const E of ENTRIES) for (const X0 of EXITS) CFG.push({ tf, E, X: { ...X0, hold: { '15m': 3, '1h': 7, '2h': 14, '4h': 21 }[tf] * 96 } });
const name = (c) => `${c.tf} ${c.E.fam}${c.E.fam === 'cross' ? c.E.f + '/' + c.E.s : c.E.n} ${c.E.filt} sl${c.X.sl} tr${c.X.tr} a${c.X.act}`;
// tutte le operazioni per configurazione e gruppo (calcolate una volta)
function allTrades(group, c) {
  const syms = group === 'perp' ? B.PERPS : SPOT; let T = [];
  for (const s of syms) { const P = B.prepCoin(s); const sg = B.signals(P, c.tf, c.E); T = T.concat(B.trades(P, sg, c.X, group, group === 'spot')); }
  return T;
}
module.exports = { CFG, name, allTrades, SPOT };
if (require.main === module) {
  const group = process.argv[2] || 'perp'; const t0 = Date.now();
  const end = Date.UTC(2026, 10, 27); const Mo = 30.44 * 864e5;
  const folds = [0, 1, 2, 3].map((k) => { const os = end - (4 - k) * 3 * Mo; return { isFrom: os - 12 * Mo, isTo: os, osFrom: os, osTo: os + 3 * Mo }; });
  const minPM = +(process.env.MINPM || 5);
  const res = CFG.map((c) => ({ c, T: allTrades(group, c) }));
  console.error('trades computed', (Date.now() - t0) / 1e3, 's');
  const out = { group, folds: [], oosTrades: [] };
  for (const f of folds) {
    const scored = res.map(({ c, T }) => ({ c, T, is: B.portfolio(T, 0.01, f.isFrom, f.isTo) })).filter((x) => x.is.perMonth >= minPM).sort((a, b) => b.is.pf - a.is.pf);
    const best = scored[0]; const os = B.portfolio(best.T, 0.01, f.osFrom, f.osTo);
    out.folds.push({ os: new Date(f.osFrom).toISOString().slice(0, 10), pick: name(best.c), is: { pf: +best.is.pf.toFixed(2), pm: +best.is.perMonth.toFixed(1), ret: +best.is.ret.toFixed(3) }, oos: { n: os.n, pm: +os.perMonth.toFixed(1), win: +os.win.toFixed(2), pf: +os.pf.toFixed(2), ret: +os.ret.toFixed(3), dd: +os.dd.toFixed(3) },
      top5: scored.slice(0, 5).map((x) => `${name(x.c)} IS${x.is.pf.toFixed(2)} OOS${B.portfolio(x.T, 0.01, f.osFrom, f.osTo).pf.toFixed(2)}`) });
    out.oosTrades.push(...best.T.filter((t) => t.T >= f.osFrom && t.T < f.osTo).map((t) => ({ ...t, pick: name(best.c) })));
  }
  // robustezza: quante configurazioni hanno PF>1 su IS fisso (primi 12 mesi) e OOS fisso (ultimi 12)
  const isF = folds[0].isFrom, mid = folds[0].osFrom; let both = 0, isPos = 0; const fixed = [];
  for (const { c, T } of res) { const a = B.portfolio(T, 0.01, isF, mid), b = B.portfolio(T, 0.01, mid, end); if (a.pf > 1) isPos++; if (a.pf > 1 && b.pf > 1) both++; fixed.push({ k: name(c), isPF: +a.pf.toFixed(2), isPM: +a.perMonth.toFixed(1), osPF: +b.pf.toFixed(2), osRet: +b.ret.toFixed(3), osDD: +b.dd.toFixed(3), osPM: +b.perMonth.toFixed(1) }); }
  out.robust = { configs: res.length, isPF1: isPos, bothPF1: both };
  out.fixedTopIS = fixed.filter((x) => x.isPM >= minPM).sort((a, b) => b.isPF - a.isPF).slice(0, 12);
  require('fs').writeFileSync(`./res-${group}-${process.env.TFS || '15m,1h'}.json`, JSON.stringify(out));
  const { oosTrades, ...show } = out; console.log(JSON.stringify(show, null, 1));
}
