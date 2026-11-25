'use strict';
// Nessun segreto in risposte, log o messaggi d'errore
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { boot, req, apost, login, PIN } = require('./helpers');
const { redact, maskUrl } = require('../../src/redact');
const store = require('../../src/store');

test('stato e eventi dell\'app: nessun PIN, hash, sale, token, chiave dati, chiave privata', async () => {
  const s = await boot();
  try {
    const l = await login(s.base);
    const pw = 'Password-Segreta-987';
    const cw = await apost(s.base, l, '/api/wallet/create', { password: pw }); assert.strictEqual(cw.status, 200);
    const st = await req(s.base, '/api/state', { cookie: l.cookie }); assert.strictEqual(st.status, 200);
    const auth = store.readJson(path.join(s.dir, 'auth.json'), null);
    const dk = fs.readFileSync(path.join(s.dir, store.KEY_FILE), 'utf8').trim();
    const wallet = JSON.parse(fs.readFileSync(path.join(s.dir, 'wallet.enc.json'), 'utf8'));
    const all = [st.text, (await req(s.base, '/api/auth/status', { cookie: l.cookie })).text, (await req(s.base, '/api/research/status')).text].join('\n');
    for (const [name, v] of [['PIN', PIN], ['password', pw], ['pinHash', auth.pinHash], ['salt', auth.salt], ['token', l.cookie], ['chiave dati', dk], ['ct wallet', wallet.ct], ['sale wallet', wallet.kdf.salt]]) assert.ok(!all.includes(v), `${name} esposto`);
    assert.ok(!/secretKey|pinHash|"salt"|sessions/.test(all));
    // l'hash di sessione su disco non è il token
    assert.ok(!JSON.stringify(auth.sessions).includes(l.cookie));
    // log del motore e del server
    const logs = JSON.stringify(s.engine.snapshot()) + s.logger.lines.join('\n');
    for (const v of [PIN, pw, l.cookie, dk]) assert.ok(!logs.includes(v));
    // password sbagliata: errore generico
    const bad = await apost(s.base, l, '/api/wallet/export', { password: 'x', confirm: 'HO CAPITO' }); assert.strictEqual(bad.status, 400); assert.ok(!bad.text.includes('x"'));
  } finally { await s.close(); }
});

test('URL RPC con chiave API: mascherato nello stato; salvare il valore mascherato non perde la chiave vera', async () => {
  const s = await boot();
  try {
    const l = await login(s.base);
    const rpc = 'https://mainnet.helius-rpc.com/?api-key=0123abcd-SECRET-KEY-9999'; // gitleaks:allow (finta chiave di test)
    assert.strictEqual((await apost(s.base, l, '/api/config', { rpcUrl: rpc })).status, 200);
    const st = await req(s.base, '/api/state', { cookie: l.cookie });
    assert.ok(!st.text.includes('SECRET-KEY')); assert.ok(st.json.cfg.rpcUrl.includes('helius-rpc.com'));
    assert.strictEqual((await apost(s.base, l, '/api/config', { rpcUrl: st.json.cfg.rpcUrl })).status, 200);
    assert.strictEqual(s.engine.cfg.rpcUrl, rpc, 'la chiave vera resta salvata (cifrata)');
    s.engine.cfgWriter.flush();
    assert.ok(!fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8').includes('SECRET-KEY'));
    assert.strictEqual((await apost(s.base, l, '/api/config', { rpcUrl: 'http://evil.example/rpc' })).status === 200 ? s.engine.cfg.rpcUrl : rpc, rpc, 'RPC non https rifiutato');
  } finally { await s.close(); }
});

test('redazione dei log: chiavi API, password, PIN, token esadecimali', () => {
  const tok = 'a'.repeat(64);
  const out = redact(`GET https://x.io/v1?api-key=SEGRETO1&q=1 token=${tok} {"password":"Pw123456","pin":"482913"} secretKey: abc BOT_WALLET_PASSWORD=zzz`);
  for (const v of ['SEGRETO1', tok, 'Pw123456', '482913', 'zzz']) assert.ok(!out.includes(v), v);
  assert.ok(out.includes('x.io') && out.includes('q=1'));
  assert.strictEqual(maskUrl('https://user:pw@rpc.io/?token=abc'), 'https://••••@rpc.io/?token=••••');
  assert.strictEqual(redact(null), null);
});

test('il motore redige anche i propri log', async () => {
  const s = await boot();
  try {
    s.engine.log('SISTEMA', `chiamata https://api.x.io/?apikey=TOPSECRET123 password=Hunter2222`);
    const txt = JSON.stringify(s.engine.snapshot());
    assert.ok(!txt.includes('TOPSECRET123') && !txt.includes('Hunter2222'));
  } finally { await s.close(); }
});
