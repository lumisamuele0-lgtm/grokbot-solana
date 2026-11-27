'use strict';
// Ripristino: una configurazione salvata dalle versioni annullate (cfg v15, margine fino al 100%) si carica senza errori e torna nei limiti di questa versione.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const C = require('../src/config');
const { Engine } = require('../src/engine'); const { Keystore } = require('../src/keystore');

test('config salvata dalla v15 annullata (TREND 4H): migrazione v16 → TREND 2–4H, rischio 1%, margine riportato al 20%, Omega attivo, il resto invariato', () => {
  const { cfg, changed } = C.migrateConfig({ cfgVersion: 15, edgeOn: true, riskPerTradePct: 2, spotLongs: false, maxTradePct: 60, leverage: 10, dailyLossPct: 15, pace: 'normale', mode: 'SIM', realSpot: false });
  assert.strictEqual(cfg.cfgVersion, C.CFG_VERSION); assert.strictEqual(C.CFG_VERSION, 16); assert.strictEqual(changed, true);
  assert.strictEqual(cfg.maxTradePct, 20); assert.ok(!('edgeOn' in cfg)); assert.strictEqual(cfg.trendOn, true); assert.strictEqual(cfg.riskPerTradePct, 1); assert.strictEqual(cfg.spotLongs, true);
  assert.strictEqual(cfg.leverage, 10); assert.strictEqual(cfg.dailyLossPct, 15); assert.strictEqual(cfg.pace, 'normale'); assert.strictEqual(cfg.mode, 'SIM'); assert.strictEqual(cfg.realSpot, false);
  assert.strictEqual(C.migrateConfig(cfg).changed, false, 'una volta sola');
  const v14 = C.migrateConfig({ cfgVersion: 14, maxTradePct: 12, riskPerTradePct: 9 }).cfg; assert.strictEqual(v14.maxTradePct, 12); assert.strictEqual(v14.riskPerTradePct, 1); assert.strictEqual(v14.trendOn, true);
});

test('protezione al caricamento: config di una versione futura → versione attuale, campi sconosciuti tolti, valori nei limiti', () => {
  const { cfg } = C.migrateConfig({ cfgVersion: 99, edgeOn: true, maxTradePct: 50, riskPerTradePct: 9, trendOn: false, spotLongs: false, dailyLossPct: 999, leverage: 10 });
  assert.strictEqual(cfg.cfgVersion, C.CFG_VERSION); assert.ok(!('edgeOn' in cfg)); assert.strictEqual(cfg.maxTradePct, 20); assert.strictEqual(cfg.riskPerTradePct, 3);
  assert.strictEqual(cfg.dailyLossPct, 50); assert.strictEqual(cfg.spotLongs, true); assert.strictEqual(cfg.trendOn, false, 'scelta dell\'utente rispettata'); assert.strictEqual(cfg.leverage, 10);
  assert.strictEqual(C.sanitize({ riskPerTradePct: 0.1 }, cfg).riskPerTradePct, 0.5); assert.strictEqual(C.sanitize({ maxTradePct: 100 }, cfg).maxTradePct, 20);
});

test('il motore parte con la config v15 salvata (niente crash) e usa il margine massimo 20%', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrestore-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ cfgVersion: 15, budget: 1000, baseCurrency: 'USDC', edgeOn: true, riskPerTradePct: 2, spotLongs: false, maxTradePct: 100 }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  assert.strictEqual(e.cfg.maxTradePct, 20); assert.strictEqual(e.cfg.spotLongs, true); assert.ok(!('edgeOn' in e.cfg)); assert.strictEqual(e.cfg.trendOn, true); assert.strictEqual(e.cfg.riskPerTradePct, 1);
  assert.ok(e.snapshot());
});
