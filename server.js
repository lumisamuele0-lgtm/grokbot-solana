'use strict';
// GrokBot Solana — server locale (gira sul tuo PC). Interfaccia: http://localhost:8787
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const { PublicKey } = require('@solana/web3.js');
const { Keystore } = require('./src/keystore');
const { Auth } = require('./src/auth');
const { Engine } = require('./src/engine');
const chain = require('./src/chain');
const { USDC } = require('./src/tokens');

const crypto = require('crypto');
const PORT = Number(process.env.PORT || 8787);
const DEMO = process.env.DEMO_MODE === '1';
const FORCE_HTTPS = process.env.FORCE_HTTPS === '1';
const IN_CONTAINER = process.env.IN_CONTAINER === '1';
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
try { fs.accessSync(DATA, fs.constants.W_OK); } catch { console.error(`ERRORE: la cartella dati ${DATA} non è scrivibile`); process.exit(1); }
// Hosting con disco temporaneo: il wallet cifrato può essere ripristinato da una variabile d'ambiente.
const WALLET_FILE = path.join(DATA, 'wallet.enc.json');
if (!fs.existsSync(WALLET_FILE) && process.env.WALLET_ENC_JSON) {
  try {
    const raw = process.env.WALLET_ENC_JSON.trim();
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(json); if (!j.publicKey || !j.ct) throw new Error('formato non valido');
    fs.writeFileSync(WALLET_FILE, JSON.stringify(j, null, 2), { mode: 0o600 });
    console.log(`  Wallet del bot ripristinato da WALLET_ENC_JSON: ${j.publicKey}`);
  } catch (e) { console.error('  WALLET_ENC_JSON non valido:', e.message); }
}
const PERSISTENT = process.env.DATA_PERSISTENT === '1' || !IN_CONTAINER;
const ks = new Keystore(WALLET_FILE);
const auth = new Auth(path.join(DATA, 'auth.json'));
// Primo PIN da remoto: da variabile SETUP_PIN oppure con un codice monouso stampato nei log.
let setupToken = null;
if (!auth.isSetup()) {
  if (process.env.SETUP_PIN) {
    try { auth.setup(String(process.env.SETUP_PIN).trim()); console.log('  PIN impostato da SETUP_PIN.'); } catch (e) { console.error('  SETUP_PIN non valido:', e.message); }
  }
  if (!auth.isSetup()) setupToken = crypto.randomBytes(4).toString('hex').toUpperCase();
}
const engine = new Engine({ dataDir: DATA, keystore: ks });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? true : 'loopback');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  next();
});
// Dietro un proxy HTTPS (hosting): reindirizza sempre su https
app.use((req, res, next) => {
  if (FORCE_HTTPS && req.headers['x-forwarded-proto'] === 'http' && req.path !== '/healthz') return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

const cookieOf = (req) => { const m = /(?:^|;\s*)sb_session=([a-f0-9]{64})/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
const isLocal = (req) => {
  const ip = req.socket.remoteAddress || '';
  const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'];
  return !proxied && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
};
const setCookie = (req, res, token) => {
  const secure = FORCE_HTTPS || req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${secure}`);
};
const wrap = (fn) => async (req, res) => {
  try { const r = await fn(req, res); if (!res.headersSent) res.json(r || { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

// Protezione CSRF: ogni POST deve avere l'header personalizzato (blocca form di altri siti).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-sb'] !== '1') return res.status(403).json({ error: 'Richiesta non valida' });
  next();
});

app.get('/api/auth/status', (req, res) => res.json({ setup: auth.isSetup(), loggedIn: auth.check(cookieOf(req)), canSetup: !auth.isSetup(), needsToken: !auth.isSetup() && !isLocal(req), demo: DEMO }));
app.post('/api/auth/setup', wrap(async (req, res) => {
  if (!isLocal(req)) {
    const t = String(req.body.token || '').trim().toUpperCase();
    if (!setupToken || t.length !== setupToken.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(setupToken))) {
      await new Promise((r) => setTimeout(r, 1500));
      throw new Error('Codice di configurazione errato: lo trovi nei log del server');
    }
  }
  setCookie(req, res, auth.setup(req.body.pin));
  setupToken = null;
}));
app.post('/api/auth/login', wrap(async (req, res) => { setCookie(req, res, auth.login(req.body.pin, req.ip)); }));
app.post('/api/auth/logout', wrap(async (req, res) => { auth.logout(cookieOf(req)); res.setHeader('Set-Cookie', 'sb_session=; Path=/; Max-Age=0'); }));

app.use('/api', (req, res, next) => (auth.check(cookieOf(req)) ? next() : res.status(401).json({ error: 'Accesso richiesto' })));
// Modalità DEMO: solo simulazione, nessun wallet o fondo reale su questo server.
const DEMO_BLOCK = ['/wallet/create', '/wallet/unlock', '/wallet/export', '/wallet/backup', '/deposit/build', '/deposit/confirm', '/withdraw-address'];
app.use('/api', (req, res, next) => {
  if (!DEMO || req.method !== 'POST') return next();
  if (DEMO_BLOCK.includes(req.path) || (req.path === '/mode' && req.body.mode === 'REAL') || (req.path === '/withdraw' && engine.cfg.mode === 'REAL')) return res.status(403).json({ error: 'Questa è una DEMO temporanea: solo simulazione, niente fondi reali. Per il trading reale usa la tua installazione.' });
  if (req.path === '/config' && req.body && 'rpcUrl' in req.body) delete req.body.rpcUrl;
  next();
});

const hostInfo = () => ({ demo: DEMO, persistent: PERSISTENT, container: IN_CONTAINER });
app.get('/api/state', (req, res) => res.json({ ...engine.snapshot(), host: hostInfo() }));
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const snap = () => ({ ...engine.snapshot(), host: hostInfo() });
  send('snap', snap());
  const onEv = (e) => send('ev', e);
  engine.on('ev', onEv);
  const iv = setInterval(() => send('snap', snap()), 2000);
  const ka = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(iv); clearInterval(ka); engine.off('ev', onEv); });
});
app.get('/api/candles', (req, res) => {
  const m = String(req.query.mint || '');
  res.json((engine.market.candles[m] || []).slice(-180));
});
app.post('/api/config', wrap(async (req) => { engine.setConfig(req.body || {}); }));
app.post('/api/trading', wrap(async (req) => { engine.setTrading(!!req.body.on); }));
app.post('/api/mode', wrap(async (req) => { await engine.setMode(req.body.mode === 'REAL' ? 'REAL' : 'SIM', req.body.confirm); }));
app.post('/api/reset-sim', wrap(async () => { engine.resetSim(); }));
app.post('/api/rearm', wrap(async () => { engine.rearm(); }));
app.post('/api/close', wrap(async (req) => {
  if (req.body.id === 'all') return engine.closeAll();
  const p = engine.book.positions.find((x) => x.id === req.body.id); if (!p) throw new Error('Posizione non trovata');
  await engine.closePosition(p, 'Chiusura manuale');
}));
app.post('/api/kill', wrap(async () => { await engine.killSwitch('Kill switch manuale'); }));

// Portafoglio del bot
app.post('/api/wallet/create', wrap(async (req) => { const pk = ks.create(req.body.password); engine.log('SISTEMA', `Creato portafoglio del bot ${pk}`); engine.refreshBalances(true); return { publicKey: pk }; }));
app.post('/api/wallet/unlock', wrap(async (req) => { const pk = ks.unlock(req.body.password); engine.log('SISTEMA', 'Portafoglio del bot sbloccato'); engine.reconcile().catch(() => {}); return { publicKey: pk }; }));
app.post('/api/wallet/lock', wrap(async () => { if (engine.cfg.mode === 'REAL') engine.setTrading(false); ks.lock(); engine.log('SISTEMA', 'Portafoglio del bot bloccato'); }));
app.post('/api/wallet/backup', wrap(async (req) => {
  ks.verify(req.body.password);
  const b64 = Buffer.from(fs.readFileSync(WALLET_FILE, 'utf8')).toString('base64');
  engine.log('SISTEMA', 'Backup cifrato del wallet copiato (per WALLET_ENC_JSON)', 'warn');
  return { walletEncJson: b64 };
}));
app.post('/api/wallet/export', wrap(async (req) => {
  if (req.body.confirm !== 'HO CAPITO') throw new Error('Conferma scrivendo: HO CAPITO');
  const secret = ks.exportBase58(req.body.password); engine.log('SISTEMA', 'Chiave privata del bot esportata', 'warn'); return { secret };
}));

// Phantom dell'utente
app.post('/api/user-wallet', wrap(async (req) => {
  const a = new PublicKey(String(req.body.address)).toBase58();
  engine.st.userWallet = a; engine.save(); engine.refreshBalances(true);
  engine.log('SISTEMA', `Phantom collegato: ${a}`);
  return { address: a, withdrawAddress: engine.st.withdrawAddress };
}));
app.post('/api/withdraw-address', wrap(async (req) => {
  ks.verify(req.body.password);
  engine.st.withdrawAddress = new PublicKey(String(req.body.address)).toBase58(); engine.save();
  engine.log('SISTEMA', `Indirizzo di prelievo impostato: ${engine.st.withdrawAddress}`, 'warn');
}));
app.post('/api/deposit/build', wrap(async (req) => {
  const info = ks.info(); if (!info.exists) throw new Error('Crea prima il portafoglio del bot (Impostazioni → Portafoglio)');
  const from = engine.st.userWallet; if (!from) throw new Error('Collega prima Phantom');
  const currency = req.body.currency === 'SOL' ? 'SOL' : 'USDC';
  const amount = Number(req.body.amount);
  if (!(amount > 0)) throw new Error('Importo non valido');
  const ub = await chain.getBalances(engine.conn, from);
  const reserve = engine.cfg.feeReserveSol;
  if (currency === 'SOL' && ub.sol < amount + reserve + 0.003) throw new Error(`Saldo Phantom insufficiente: ${ub.sol.toFixed(4)} SOL (servono ${(amount + reserve + 0.003).toFixed(4)})`);
  if (currency === 'USDC') {
    const u = ub.tokens[USDC] ? ub.tokens[USDC].ui : 0;
    if (u < amount) throw new Error(`USDC insufficienti su Phantom: ${u}`);
    if (ub.sol < reserve + 0.005) throw new Error(`Servono anche ${(reserve + 0.005).toFixed(3)} SOL per commissioni e conto USDC`);
  }
  const r = await chain.buildDepositTx(engine.conn, { from, to: info.publicKey, currency, amount, usdcMint: USDC, feeReserveSol: reserve });
  engine.log('SISTEMA', `Deposito preparato: ${amount} ${currency} + ${reserve} SOL riserva commissioni → bot (da firmare in Phantom)`);
  return { transaction: r.base64, amount, currency, reserve, to: info.publicKey };
}));
app.post('/api/deposit/confirm', wrap(async (req) => engine.recordDeposit(String(req.body.signature), engine.st.userWallet)));
app.post('/api/withdraw', wrap(async (req) => engine.withdrawAll(req.body.password)));

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}
app.get('/api/lan', wrap(async () => {
  const urls = lanUrls();
  return { urls, qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } }) : null };
}));

app.get('/vendor/web3.js', (req, res) => res.sendFile(require.resolve('@solana/web3.js/lib/index.iife.min.js')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));

const server = app.listen(PORT, HOST, async () => {
  const urls = lanUrls();
  console.log('\n  =============================================');
  console.log('     GROKBOT SOLANA - bot di trading attivo');
  console.log('  =============================================');
  if (IN_CONTAINER) console.log(`  In ascolto sulla porta ${PORT} (l'hosting fornisce l'indirizzo https)`);
  else { console.log(`  Su questo computer:  http://localhost:${PORT}`); for (const u of urls) console.log(`  Da iPhone (stessa Wi-Fi):  ${u}`); }
  if (urls[0] && !process.env.NO_QR && !IN_CONTAINER) { try { console.log(await QRCode.toString(urls[0], { type: 'terminal', small: true })); console.log('  Inquadra il QR con la fotocamera dell\'iPhone.'); } catch {} }
  if (!IN_CONTAINER) console.log('  Lascia questa finestra aperta: se la chiudi il bot si ferma.\n');
  if (DEMO) console.log('  MODALITÀ DEMO: solo simulazione, wallet e fondi reali disattivati.');
  if (!PERSISTENT) console.log('  ATTENZIONE: disco non persistente. Imposta SETUP_PIN e, se usi il trading reale, WALLET_ENC_JSON (backup cifrato).');
  if (setupToken) console.log(`\n  >>> CODICE DI CONFIGURAZIONE (primo accesso da remoto): ${setupToken} <<<\n`);
  if (process.env.KEEPALIVE_URL) {
    setInterval(() => fetch(process.env.KEEPALIVE_URL.replace(/\/$/, '') + '/healthz').catch(() => {}), 10 * 60000);
    console.log('  Keep-alive attivo verso', process.env.KEEPALIVE_URL);
  }
  engine.start();
  if (process.env.OPEN_BROWSER === '1') {
    const { exec } = require('child_process');
    const u = `http://localhost:${PORT}`;
    exec(process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`, () => {});
  }
});
const shutdown = () => { console.log('\nArresto in corso, salvo lo stato…'); engine.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
module.exports = { app, engine };
