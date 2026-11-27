const B = require('./bt'); const G = require('./grid');
const end = Date.UTC(2026, 10, 27), Mo = 30.44 * 864e5;
for (const g of ['perp', 'spot']) {
  const res = G.CFG.map((c) => ({ c, T: G.allTrades(g, c) }));
  for (const [l, a, b] of [['first12', end - 24 * Mo, end - 12 * Mo], ['last12', end - 12 * Mo, end]]) {
    const sc = res.map((x) => ({ ...x, p: B.portfolio(x.T, 0.01, a, b) })).filter((x) => x.p.perMonth >= 2).sort((p, q) => q.p.pf - p.p.pf);
    console.log(g, l, sc.slice(0, 5).map((x) => `${G.name(x.c)} PF${x.p.pf.toFixed(2)} ${x.p.perMonth.toFixed(1)}/m ret${(x.p.ret * 100).toFixed(1)} dd${(x.p.dd * 100).toFixed(1)}`).join('\n   '));
    if (l === 'first12') { const o = B.portfolio(sc[0].T, 0.01, end - 12 * Mo, end); console.log('   -> OOS last12', o.n, o.perMonth.toFixed(1), 'PF', o.pf.toFixed(2), 'ret', (o.ret * 100).toFixed(1), 'dd', (o.dd * 100).toFixed(1)); }
  }
}
