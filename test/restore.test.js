'use strict';
// Ripristino: una configurazione salvata dalle versioni annullate (cfg v15, margine fino al 100%) si carica senza errori e torna nei limiti di questa versione.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const C = require('../src/config');
const { Engine } = require('../src/engine'); const { Keystore } = require('../src/keystore');

test('config salvata da v15: margine riportato al 20%, campi nuovi tolti, Omega riattivato, il resto invariato', () => {
  const { cfg, changed } = C.migrateConfig({ cfgVersion: 15, edgeOn: true, riskPerTradePct: 2, spotLongs: false, maxTradePct: 60, leverage: 10, dailyLossPct: 15, pace: 'normale', mode: 'SIM', realSpot: false });
  assert.strictEqual(cfg.cfgVersion, C.CFG_VERSION); assert.strictEqual(changed, false, 'nessuna migrazione rieseguita');
  assert.strictEqual(cfg.maxTradePct, 20); assert.ok(!('edgeOn' in cfg) && !('riskPerTradePct' in cfg)); assert.strictEqual(cfg.spotLongs, true);
  assert.strictEqual(cfg.leverage, 10); assert.strictEqual(cfg.dailyLossPct, 15); assert.strictEqual(cfg.pace, 'normale'); assert.strictEqual(cfg.mode, 'SIM'); assert.strictEqual(cfg.realSpot, false);
  const v14 = C.migrateConfig({ cfgVersion: 14, spotLongs: false, maxTradePct: 12 }).cfg; assert.strictEqual(v14.spotLongs, false, 'una scelta fatta su v14 resta'); assert.strictEqual(v14.maxTradePct, 12);
});

test('il motore parte con la config v15 salvata (niente crash) e usa il margine massimo 20%', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrestore-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ cfgVersion: 15, budget: 1000, baseCurrency: 'USDC', edgeOn: true, riskPerTradePct: 2, spotLongs: false, maxTradePct: 100 }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  assert.strictEqual(e.cfg.maxTradePct, 20); assert.strictEqual(e.cfg.spotLongs, true); assert.ok(!('edgeOn' in e.cfg));
  assert.ok(e.snapshot());
});
