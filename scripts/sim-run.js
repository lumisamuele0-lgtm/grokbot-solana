// Prova del motore in SIMULAZIONE su dati live per N minuti (uso: node scripts/sim-run.js 8)
const path = require('path'); const fs = require('fs');
const { Engine } = require('../src/engine'); const { Keystore } = require('../src/keystore');
const dir = path.join(require('os').tmpdir(), 'sb-sim-' + Date.now()); fs.mkdirSync(dir, { recursive: true });
const minutes = Number(process.argv[2] || 5);
// impostazioni di prova più permissive per vedere aprire/chiudere operazioni in pochi minuti
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ budget: 100, cycleSec: 15, maxHoldMin: Number(process.env.HOLD || 3), slMinPct: 0.6, cooldownMin: 1 }));
const e = new Engine({ dataDir: dir, keystore: new Keystore(path.join(dir, 'w.json')) });
e.on('ev', (x) => { if (x.type === 'log' || x.type === 'trade') console.log(new Date().toISOString().slice(11, 19), x.type, x.agent || x.side, x.text || JSON.stringify(x)); });
e.start(); e.setTrading(true);
setTimeout(() => { const s = e.snapshot(); console.log('\n=== RISULTATO', JSON.stringify({ equity: s.equity, pnl: s.pnl, open: s.positions.length, closed: s.trades.length, wins: s.wins, losses: s.losses, counters: { a: s.counters.analyzed, r: s.counters.rejected, ok: s.counters.approved }, rules: s.counters.rules, trades: s.trades.map(t => `${t.symbol} ${t.pnl.toFixed(4)} ${t.reason}`) }, null, 1)); e.stop(); process.exit(0); }, minutes * 60000);
