'use strict';
// Wallet: tutte le rotte di deposito/prelievo/Phantom/wallet del bot esistono, sono protette, e l'interfaccia le espone.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { boot, req, post, apost, login, routes } = require('./helpers');

const WALLET_ROUTES = [
  ['POST', '/api/wallet/create'], ['POST', '/api/wallet/unlock'], ['POST', '/api/wallet/lock'], ['POST', '/api/wallet/backup'], ['POST', '/api/wallet/export'],
  ['POST', '/api/user-wallet'], ['POST', '/api/withdraw-address'], ['POST', '/api/deposit/build'], ['POST', '/api/deposit/confirm'], ['POST', '/api/withdraw'], ['GET', '/api/wallet/qr'],
];

test('rotte wallet registrate e tutte private (401 senza sessione)', async () => {
  const s = await boot();
  try {
    const have = routes(s.app).map((r) => r.method + ' ' + r.path);
    for (const [m, p] of WALLET_ROUTES) {
      assert.ok(have.includes(m + ' ' + p), `${m} ${p} manca`);
      const r = m === 'GET' ? await req(s.base, p) : await post(s.base, p, {});
      assert.strictEqual(r.status, 401, `${m} ${p} senza sessione`);
    }
  } finally { await s.close(); }
});

test('QR dell\'indirizzo del bot: solo l\'indirizzo pubblico, mai segreti; prelievo REALE senza password rifiutato', async () => {
  const s = await boot();
  try {
    const l = await login(s.base);
    let r = await req(s.base, '/api/wallet/qr', { cookie: l.cookie }); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json, { address: null, qr: null });
    const pw = 'Password-di-prova-123';
    const cw = await apost(s.base, l, '/api/wallet/create', { password: pw }); assert.strictEqual(cw.status, 200);
    const pk = s.engine.ks.info().publicKey;
    r = await req(s.base, '/api/wallet/qr', { cookie: l.cookie }); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.address, pk); assert.match(r.json.qr, /^data:image\/png;base64,/);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['address', 'qr']);
    const file = JSON.parse(fs.readFileSync(s.engine.ks.file, 'utf8') || '{}');
    for (const k of ['ct', 'iv', 'tag']) if (file[k]) assert.ok(!r.text.includes(file[k]), k + ' esposto');
    assert.ok(!r.text.includes(pw));
    // prelievo reale: password obbligatoria e controllata come prima (nessuna scorciatoia)
    s.engine.cfg.mode = 'REAL';
    const w1 = await apost(s.base, l, '/api/withdraw', {}); assert.strictEqual(w1.status, 400);
    const w2 = await apost(s.base, l, '/api/withdraw', { password: 'sbagliata' }); assert.notStrictEqual(w2.status, 200);
  } finally { await s.close(); }
});

test('interfaccia: scheda Wallet con Deposita, Preleva, Phantom, Budget, Wallet bot, Guida REALE, QR e copia; flussi wallet presenti', () => {
  const pub = path.join(__dirname, '..', '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8'); const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8'); const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  for (const sel of ['data-tab="wallet"', 'id="vWallet"', 'data-a="deposit"', 'data-a="withdraw"', 'data-a="phantom"', 'data-a="budget"', 'data-a="botwallet"', 'data-a="guide"', 'id="wQr"', 'id="wCopy"', 'id="wAddr"', 'id="wallet"', 'id="hSol"', 'id="hSolPx"', 'id="roi"', 'id="navPh"'])
    assert.ok(html.includes(sel), sel + ' manca in index.html');
  for (const f of ['function depositSheet', 'function withdrawSheet', 'function phantomSheet', 'function connectPhantom', 'function doDeposit', 'function realGuide', 'function settingsSheet', 'function renderWallet', "'/api/deposit/build'", "'/api/deposit/confirm'", "'/api/withdraw'", "'/api/wallet/create'", "'/api/wallet/unlock'", "'/api/wallet/lock'", "'/api/wallet/export'", "'/api/wallet/backup'", "'/api/withdraw-address'", "'/api/user-wallet'", "'/api/wallet/qr'", "id=\"wPw\""])
    assert.ok(js.includes(f), f + ' manca in app.js');
  assert.match(sw, /grokbot-v28/); assert.ok(!/<script>/.test(html), 'nessuno script inline (CSP)');
});
