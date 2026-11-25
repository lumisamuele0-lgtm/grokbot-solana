const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { DEFAULTS, LIMITS, sanitize, migrateConfig, CFG_VERSION } = require('../src/config');
const { Engine } = require('../src/engine');
const { Keystore } = require('../src/keystore');

test('default: rischio 7%, volume 24h min 3000 $, età min 1 minuto', () => {
  assert.strictEqual(DEFAULTS.maxTradePct, 7);
  assert.strictEqual(DEFAULTS.minVolume24hUsd, 3000);
  assert.strictEqual(DEFAULTS.minPairAgeMin, 1);
  assert.ok(!('minPairAgeHours' in DEFAULTS));
  assert.ok(LIMITS.maxTradePct[1] >= 7, 'il limite massimo deve permettere il 7%');
  assert.strictEqual(sanitize({ maxTradePct: 7 }, DEFAULTS).maxTradePct, 7);
  assert.strictEqual(sanitize({ cfgVersion: 1 }, DEFAULTS).cfgVersion, CFG_VERSION);
});
test('migrazione: vecchia configurazione → nuovi valori, il resto resta', () => {
  const old = { budget: 0.5, baseCurrency: 'SOL', maxTradePct: 20, minVolume24hUsd: 100000, minPairAgeHours: 6, memeSizeMult: 0.5, maxLossPct: 15, rpcUrl: 'https://x.example' };
  const { cfg, changed } = migrateConfig(old);
  assert.strictEqual(changed, true);
  assert.strictEqual(cfg.maxTradePct, 7); assert.strictEqual(cfg.minVolume24hUsd, 3000); assert.strictEqual(cfg.minPairAgeMin, 1); assert.strictEqual(cfg.memeSizeMult, 1);
  assert.ok(!('minPairAgeHours' in cfg));
  assert.strictEqual(cfg.budget, 0.5); assert.strictEqual(cfg.baseCurrency, 'SOL'); assert.strictEqual(cfg.maxLossPct, 15); assert.strictEqual(cfg.rpcUrl, 'https://x.example');
  assert.strictEqual(cfg.cfgVersion, CFG_VERSION);
});
test('migrazione: una sola volta (le modifiche successive dell\'utente restano)', () => {
  const { cfg } = migrateConfig({ cfgVersion: CFG_VERSION, maxTradePct: 5, minVolume24hUsd: 9000, minPairAgeMin: 10 });
  assert.strictEqual(cfg.maxTradePct, 5); assert.strictEqual(cfg.minVolume24hUsd, 9000); assert.strictEqual(cfg.minPairAgeMin, 10);
  assert.strictEqual(migrateConfig({ cfgVersion: CFG_VERSION }).changed, false);
});
test('motore: config.json esistente viene migrato e riscritto, wallet e stato non toccati', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 50, maxTradePct: 20, minVolume24hUsd: 100000, minPairAgeHours: 6 }));
  const wallet = '{"publicKey":"x","enc":"y"}'; fs.writeFileSync(path.join(d, 'w.json'), wallet);
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  assert.strictEqual(e.cfg.maxTradePct, 7); assert.strictEqual(e.cfg.minVolume24hUsd, 3000); assert.strictEqual(e.cfg.minPairAgeMin, 1); assert.strictEqual(e.cfg.budget, 50);
  const disk = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
  assert.strictEqual(disk.maxTradePct, 7); assert.strictEqual(disk.cfgVersion, CFG_VERSION); assert.ok(!('minPairAgeHours' in disk));
  assert.strictEqual(fs.readFileSync(path.join(d, 'w.json'), 'utf8'), wallet);
  const snap = e.snapshot();
  assert.ok(snap.pnlBox && typeof snap.pnlBox.total === 'number' && typeof snap.pnlBox.unrealized === 'number' && typeof snap.pnlBox.day === 'number');
  e.stop && e.stop();
});
