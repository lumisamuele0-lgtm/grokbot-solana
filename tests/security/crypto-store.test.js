'use strict';
// Archivio cifrato dei dati (AES-256-GCM + HMAC-SHA256): andata e ritorno, nessun dato in chiaro, manomissioni, migrazione, permessi;
// PIN (scrypt + pepe) e wallet (scrypt + AES-256-GCM) con migrazione senza perdere l'accesso
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const store = require('../../src/store');
const { Auth, KDF } = require('../../src/auth');
const { Keystore, encryptSecret, decryptSecret } = require('../../src/keystore');
const { Keypair } = require('@solana/web3.js');
const { boot, login, PIN } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbcr-'));
const warns = []; store.setWarn((m) => warns.push(m));
const mode = (f) => fs.statSync(f).mode & 0o777;

test('andata e ritorno: i dati tornano identici e sul disco non c\'è nulla in chiaro', () => {
  const d = tmp(); const f = path.join(d, 'state.json');
  const obj = { userWallet: 'SoLWaLLeT1111111111111111111111111111111111', positions: [{ id: 'p1', amount: 12.5 }], note: 'segretissimo àèì 🐸' };
  store.writeJson(f, obj);
  assert.deepStrictEqual(store.readJson(f, null), obj);
  const raw = fs.readFileSync(f, 'utf8'); const env = JSON.parse(raw);
  assert.strictEqual(env.sbenc, 1); assert.strictEqual(env.alg, 'A256GCM+HS256'); assert.strictEqual(Buffer.from(env.iv, 'base64').length, 12); assert.strictEqual(Buffer.from(env.tag, 'base64').length, 16); assert.strictEqual(Buffer.from(env.mac, 'base64').length, 32);
  for (const s of ['SoLWaLLeT', 'segretissimo', 'positions', 'p1']) assert.ok(!raw.includes(s), `in chiaro: ${s}`);
  const env2 = JSON.parse((store.writeJson(f, obj), fs.readFileSync(f, 'utf8'))); assert.notStrictEqual(env2.iv, env.iv, 'IV nuovo a ogni scrittura');
  assert.strictEqual(mode(f), 0o600); assert.strictEqual(mode(path.join(d, store.KEY_FILE)), 0o600);
  assert.ok(!fs.readdirSync(d).some((x) => x.endsWith('.tmp')), 'nessun file temporaneo rimasto');
});

test('manomissione: testo cifrato, tag, firma HMAC o file scambiati → rilevati, messi da parte, mai usati', () => {
  const d = tmp(); const a = path.join(d, 'config.json'); const b = path.join(d, 'state.json');
  const flip = (s) => { const x = Buffer.from(s, 'base64'); x[0] ^= 1; return x.toString('base64'); };
  for (const field of ['ct', 'tag', 'mac', 'iv']) {
    store.writeJson(a, { trading: false, field }); const env = JSON.parse(fs.readFileSync(a, 'utf8')); env[field] = flip(env[field]); fs.writeFileSync(a, JSON.stringify(env));
    assert.deepStrictEqual(store.readJson(a, { def: true }), { def: true }, field);
    assert.ok(!fs.existsSync(a)); assert.ok(fs.readdirSync(d).some((x) => x.startsWith('config.json.corrupt-')));
  }
  // file scambiati (AAD lega il contenuto al nome del file)
  store.writeJson(a, { who: 'config' }); fs.copyFileSync(a, b);
  assert.deepStrictEqual(store.readJson(b, 'def'), 'def');
  // HMAC ricalcolato senza la chiave giusta (attaccante che conosce il formato)
  store.writeJson(a, { x: 1 }); const env = JSON.parse(fs.readFileSync(a, 'utf8'));
  const fakeMac = crypto.createHmac('sha256', crypto.randomBytes(32)).update('x').digest('base64'); env.mac = fakeMac; fs.writeFileSync(a, JSON.stringify(env));
  assert.strictEqual(store.readJson(a, null), null);
  // JSON rotto
  fs.writeFileSync(a, '{oops'); assert.strictEqual(store.readJson(a, 7), 7);
  assert.ok(warns.some((w) => /illeggibile/.test(w)));
});

test('migrazione trasparente: un file in chiaro viene letto e subito riscritto cifrato', () => {
  const d = tmp(); const f = path.join(d, 'knowledge.json'); const obj = { lessons: ['a', 'b'], n: 3 };
  fs.writeFileSync(f, JSON.stringify(obj));
  assert.deepStrictEqual(store.readJson(f, null), obj);
  assert.ok(store.isEncrypted(f)); assert.deepStrictEqual(store.readJson(f, null), obj); assert.strictEqual(mode(f), 0o600);
});

test('chiave: diversa per ogni cartella dati, chiave sbagliata o DATA_ENC_KEY mancante → nessuna lettura', () => {
  const d1 = tmp(); const d2 = tmp(); const f1 = path.join(d1, 'state.json');
  store.writeJson(f1, { s: 1 });
  assert.notStrictEqual(fs.readFileSync(path.join(d1, store.KEY_FILE), 'utf8'), (store.writeJson(path.join(d2, 'x.json'), {}), fs.readFileSync(path.join(d2, store.KEY_FILE), 'utf8')));
  fs.copyFileSync(f1, path.join(d2, 'state.json')); assert.strictEqual(store.readJson(path.join(d2, 'state.json'), 'no'), 'no', 'file copiato su un altro server: illeggibile');
  // con DATA_ENC_KEY
  const d3 = tmp(); const f3 = path.join(d3, 'state.json');
  process.env.DATA_ENC_KEY = 'test-only-not-a-real-secret';
  try { store.writeJson(f3, { s: 3 }); assert.deepStrictEqual(store.readJson(f3, null), { s: 3 }); assert.strictEqual(JSON.parse(fs.readFileSync(f3, 'utf8')).kid, 'fe1'); }
  finally { delete process.env.DATA_ENC_KEY; }
  assert.strictEqual(store.readJson(f3, 'senza'), 'senza');
  assert.ok(warns.some((w) => /DATA_ENC_KEY/.test(w)));
});

test('scrittura atomica: file temporanei esclusivi 0600, nessun residuo; scritture ripetute veloci restano leggibili', () => {
  const d = tmp(); const f = path.join(d, 'matches.json');
  for (let i = 0; i < 50; i++) store.writeJson(f, { i });
  assert.deepStrictEqual(store.readJson(f, null), { i: 49 });
  assert.deepStrictEqual(fs.readdirSync(d).sort(), [store.KEY_FILE, 'matches.json'].sort());
  const w = store.debounceWriter(f, () => ({ final: true }), 10); w.schedule(); w.flush(); assert.deepStrictEqual(store.readJson(f, null), { final: true });
});

test('l\'app salva TUTTI i file dati cifrati (nessun .json in chiaro nella cartella dati)', async () => {
  const s = await boot();
  try {
    const l = await login(s.base); assert.strictEqual(l.status, 200);
    for (const w of ['cfgWriter', 'stWriter', 'kbWriter']) s.engine[w].flush();
    for (const fn of ['mentor', 'research', 'match']) { const x = s.engine[fn]; if (x && x.writer && x.writer.flush) x.writer.flush(); }
    const files = fs.readdirSync(s.dir).filter((x) => x.endsWith('.json') && x !== 'wallet.enc.json');
    for (const need of ['auth.json', 'config.json', 'state.json', 'knowledge.json']) assert.ok(files.includes(need), files.join(','));
    for (const x of files) assert.ok(store.isEncrypted(path.join(s.dir, x)), `${x} in chiaro`);
    const dk = fs.readFileSync(path.join(s.dir, store.KEY_FILE), 'utf8');
    for (const x of files) assert.ok(!fs.readFileSync(path.join(s.dir, x), 'utf8').includes(dk), 'chiave mai dentro i file');
  } finally { await s.close(); }
});

test('PIN: hash scrypt N=2^17 + pepe; il vecchio hash (N=2^14) entra con lo STESSO PIN e viene rifatto al primo accesso', () => {
  const d = tmp(); const f = path.join(d, 'auth.json');
  const salt = crypto.randomBytes(16).toString('base64');
  const legacy = crypto.scryptSync(PIN, Buffer.from(salt, 'base64'), 32, { N: 1 << 14, r: 8, p: 1 }).toString('base64');
  fs.writeFileSync(f, JSON.stringify({ salt, pinHash: legacy, sessions: {} }));
  const a = new Auth(f); assert.throws(() => a.login('000000', 'i'), /PIN errato/);
  assert.ok(a.login(PIN, 'i'), 'Samuele entra col suo PIN di sempre');
  const disk = store.readJson(f, null); assert.strictEqual(disk.pinKdf.name, 'scrypt-hmac'); assert.strictEqual(disk.pinKdf.N, KDF.N); assert.notStrictEqual(disk.pinHash, legacy);
  const b = new Auth(f); assert.ok(b.login(PIN, 'j'), 'dopo la migrazione il PIN funziona ancora'); assert.throws(() => b.login('482914', 'j'));
  assert.ok(!fs.readFileSync(f, 'utf8').includes(disk.pinHash), 'anche l\'hash è cifrato sul disco');
  // il pepe dipende dalla chiave dati: lo stesso PIN con lo stesso sale in un'altra cartella dà un hash diverso
  const c = new Auth(path.join(tmp(), 'auth.json')); assert.notStrictEqual(c.hash(PIN, disk.salt), disk.pinHash);
});

test('auth.json manomesso: nessun accesso con dati falsi; SETUP_PIN ripristina lo stesso PIN (il proprietario non resta fuori)', async () => {
  const d = tmp(); let s = await boot({}, d);
  await s.close();
  const env = JSON.parse(fs.readFileSync(path.join(d, 'auth.json'), 'utf8')); env.ct = Buffer.from('x').toString('base64'); fs.writeFileSync(path.join(d, 'auth.json'), JSON.stringify(env));
  s = await boot({}, d);
  try { const l = await login(s.base); assert.strictEqual(l.status, 200, 'stesso PIN di prima'); } finally { await s.close(); }
});

test('wallet: AES-256-GCM + scrypt N=2^17; il vecchio formato si apre con la stessa password, viene ricifrato senza cambiare chiave; backup vecchio ancora valido', () => {
  const d = tmp(); const f = path.join(d, 'wallet.enc.json'); const pw = 'password-di-test-123';
  const kp = Keypair.generate();
  // vecchio formato (N=2^15)
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pw.normalize('NFKC'), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(Buffer.from(kp.secretKey)), c.final()]);
  const old = { publicKey: kp.publicKey.toBase58(), createdAt: 'x', v: 1, kdf: { name: 'scrypt', N: 1 << 15, r: 8, p: 1, keylen: 32, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  fs.writeFileSync(f, JSON.stringify(old));
  const ks = new Keystore(f);
  assert.throws(() => ks.unlock('sbagliata-123'), /Password errata/);
  assert.strictEqual(ks.unlock(pw), kp.publicKey.toBase58());
  const nj = JSON.parse(fs.readFileSync(f, 'utf8')); assert.strictEqual(nj.kdf.N, 1 << 17); assert.strictEqual(nj.publicKey, old.publicKey); assert.strictEqual(mode(f), 0o600);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(Buffer.from(kp.secretKey).toString('base64')));
  const ks2 = new Keystore(f); assert.strictEqual(ks2.unlock(pw), old.publicKey, 'dopo la ricifratura stessa chiave');
  assert.ok(Buffer.compare(decryptSecret(old, pw), Buffer.from(kp.secretKey)) === 0, 'il vecchio backup WALLET_ENC_JSON resta valido');
  // manomissione del wallet → rifiutato
  const t = { ...nj, ct: Buffer.from(Buffer.from(nj.ct, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64') };
  assert.throws(() => decryptSecret(t, pw), /Password errata/);
  assert.throws(() => encryptSecret(kp.secretKey, 'corta'), /almeno 8/);
});
