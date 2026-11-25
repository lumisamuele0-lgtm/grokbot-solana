const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { DEFAULTS, LIMITS, sanitize, migrateConfig, CFG_VERSION } = require('../src/config');
const { Engine } = require('../src/engine');
const { Keystore } = require('../src/keystore');

test('default: rischio 7%, filtri più severi per tutte le cripto (volume 24h min 100k $, età min 1 giorno)', () => {
  assert.strictEqual(DEFAULTS.maxTradePct, 7);
  assert.strictEqual(DEFAULTS.minVolume24hUsd, 100000);
  assert.strictEqual(DEFAULTS.minPairAgeMin, 1440);
  assert.strictEqual(DEFAULTS.spotLongs, true); assert.strictEqual(DEFAULTS.realSpot, false, 'spot reale spento finché non lo attivi');
  assert.ok(!('minPairAgeHours' in DEFAULTS));
  assert.ok(LIMITS.maxTradePct[1] >= 7, 'il limite massimo deve permettere il 7%');
  assert.strictEqual(sanitize({ maxTradePct: 7 }, DEFAULTS).maxTradePct, 7);
  assert.strictEqual(sanitize({ cfgVersion: 1 }, DEFAULTS).cfgVersion, CFG_VERSION);
});
test('migrazione: vecchia configurazione → nuovi valori, il resto resta', () => {
  const old = { budget: 0.5, baseCurrency: 'SOL', maxTradePct: 20, minVolume24hUsd: 100000, minPairAgeHours: 6, memeSizeMult: 0.5, maxLossPct: 15, rpcUrl: 'https://x.example' };
  const { cfg, changed } = migrateConfig(old);
  assert.strictEqual(changed, true);
  assert.strictEqual(cfg.maxTradePct, 7); assert.strictEqual(cfg.minVolume24hUsd, 100000); assert.strictEqual(cfg.minPairAgeMin, 1440); assert.strictEqual(cfg.memeSizeMult, 1);
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
  assert.strictEqual(e.cfg.maxTradePct, 7); assert.strictEqual(e.cfg.minVolume24hUsd, 100000); assert.strictEqual(e.cfg.minPairAgeMin, 1440); assert.strictEqual(e.cfg.budget, 50);
  const disk = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
  assert.strictEqual(disk.maxTradePct, 7); assert.strictEqual(disk.cfgVersion, CFG_VERSION); assert.ok(!('minPairAgeHours' in disk));
  assert.strictEqual(fs.readFileSync(path.join(d, 'w.json'), 'utf8'), wallet);
  const snap = e.snapshot();
  assert.ok(snap.pnlBox && typeof snap.pnlBox.total === 'number' && typeof snap.pnlBox.unrealized === 'number' && typeof snap.pnlBox.day === 'number');
  e.stop && e.stop();
});

test('v4: solo cripto principali, niente meme, token aggiunti a mano conservati', () => {
  const { CORE, OLD_MEMES } = require('../src/tokens');
  assert.strictEqual(DEFAULTS.scanMemes, false);
  for (const m of OLD_MEMES) assert.ok(!CORE.some((t) => t.mint === m), 'nessun meme nella lista');
  assert.ok(CORE.every((t) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.mint) && t.decimals > 0));
  const custom = 'Custom111111111111111111111111111111111111';
  const { cfg } = migrateConfig({ cfgVersion: 3, scanMemes: true, maxTradePct: 7, budget: 2, tokens: [CORE[0].mint, OLD_MEMES[0], OLD_MEMES[2], custom] });
  assert.strictEqual(cfg.scanMemes, false); assert.strictEqual(cfg.budget, 2); assert.strictEqual(cfg.maxTradePct, 7);
  assert.ok(!cfg.tokens.some((m) => OLD_MEMES.includes(m))); assert.ok(cfg.tokens.includes(custom));
  assert.strictEqual(cfg.tokens.filter((m) => m === CORE[0].mint).length, 1);
  assert.ok(CORE.every((t) => cfg.tokens.includes(t.mint)));
});
test('v4: il ciclo non apre meme, ma le posizioni meme già aperte restano gestite', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbv4-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 100, cfgVersion: 3, scanMemes: true }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  assert.strictEqual(e.cfg.scanMemes, false);
  const MEME = 'Meme1111111111111111111111111111111111111111';
  e.watch.set(MEME, { symbol: 'MEME', core: false });
  e.market.stats[MEME] = { symbol: 'MEME', buys1h: 10, sells1h: 1 }; e.market.candles[MEME] = Array.from({ length: 100 }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: 1 + i * 0.001 }));
  await e.pipeline();
  assert.ok(!(e.st.agents.CAPO && /MEME/.test(e.st.agents.CAPO.text || '')), 'meme ignorato dal CAPO');
  e.book.positions.push({ id: 'p1', mint: MEME, symbol: 'MEME', qty: 1, qtyRaw: '1000000', decimals: 6, costBase: 5, feesBase: 0, entryPrice: 1, slPct: 5, tpPct: 9, openedAt: Date.now(), core: false });
  assert.ok(e.tradeMints().includes(MEME), 'prezzo della posizione meme ancora seguito');
});
