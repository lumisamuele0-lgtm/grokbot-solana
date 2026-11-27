'use strict';
// Candele pubbliche e gratuite di Binance (data-api.binance.vision, nessuna chiave) per il backtest → <dir>/<SYM>USDT[_tf].json  [t,o,h,l,c,v]
// Uso: node tools/fetch-klines.js <dir> [giorni=90] [tf=1m]   es. node tools/fetch-klines.js ./bt-data 730 15m
const fs = require('fs'); const path = require('path');
const dir = process.argv[2] || './bt-data'; const days = +process.argv[3] || 90; const tf = process.argv[4] || '1m';
const ms = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5 }[tf]; if (!ms) throw new Error('tf: 1m, 5m, 15m, 1h');
const wait = (t) => new Promise((z) => setTimeout(z, t));
(async () => { fs.mkdirSync(dir, { recursive: true });
  for (const s of ['BTCUSDT', 'SOLUSDT', 'ETHUSDT']) {
    const end = Math.floor(Date.now() / ms) * ms; let t = end - days * 864e5; const out = [];
    while (t < end) { const u = `https://data-api.binance.vision/api/v3/klines?symbol=${s}&interval=${tf}&startTime=${t}&limit=1000`;
      let r; for (let k = 0; k < 4; k++) { try { r = await (await fetch(u)).json(); break; } catch { await wait(1500); } }
      if (!Array.isArray(r) || !r.length) break; for (const x of r) if (x[0] < end) out.push([x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]); t = r[r.length - 1][0] + ms; await wait(120); }
    const f = path.join(dir, s + (tf === '1m' ? '' : '_' + tf) + '.json'); fs.writeFileSync(f, JSON.stringify(out)); console.log(f, out.length); } })();
