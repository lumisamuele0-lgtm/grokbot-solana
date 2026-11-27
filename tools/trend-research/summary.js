const B = require('./bt'); const fs = require('fs');
const tfs = process.argv[2] || '15m,1h';
const P = JSON.parse(fs.readFileSync(`res-perp-${tfs}.json`)), S = JSON.parse(fs.readFileSync(`res-spot-${tfs}.json`));
const end = Date.UTC(2026, 10, 27), Mo = 30.44 * 864e5, from = end - 12 * Mo;
const f = (p) => `n${p.n} ${p.perMonth ? p.perMonth.toFixed(1) : '-'}/mese win${(p.win * 100).toFixed(0)}% PF${p.pf.toFixed(2)} ret${(p.ret * 100).toFixed(1)}% DD${(p.dd * 100).toFixed(1)}%`;
const all = [...P.oosTrades, ...S.oosTrades];
for (const [l, T] of [['Alpha perps', P.oosTrades], ['Omega spot', S.oosTrades], ['Insieme', all]]) {
  console.log(`== ${l}: ${f(B.portfolio(T, 0.01, from, end))}`);
  for (let k = 0; k < 4; k++) { const a = from + k * 3 * Mo; console.log('   ', new Date(a).toISOString().slice(0, 7), f(B.portfolio(T, 0.01, a, a + 3 * Mo))); }
}
const syms = [...new Set(all.map((t) => t.sym))];
for (const s of syms) { const T = all.filter((t) => t.sym === s); const r = B.rstats(T); console.log('  ', s, `n${r.n} win${(r.win * 100).toFixed(0)}% PF${r.pf.toFixed(2)} media ${r.expR.toFixed(2)}R`, f(B.portfolio(T, 0.01, from, end))); }
