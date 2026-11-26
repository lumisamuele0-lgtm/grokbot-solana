'use strict';
// Applicazione web (API + interfaccia) con tutte le protezioni. Separata da server.js per poterla testare (tests/security).
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { PublicKey } = require('@solana/web3.js');
const { Keystore } = require('./keystore');
const { Auth } = require('./auth');
const { Engine } = require('./engine');
const chain = require('./chain');
const { USDC } = require('./tokens');
const { writeAtomic } = require('./store');
const { BOT_IDS } = require('./desk');
const { redact } = require('./redact');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = 'sb_session';
const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; worker-src 'self'";
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LIMITS = { BODY: '32kb', STR: 4096, ARR: 300, DEPTH: 6 };
const RATE = { API: { n: 600, ms: 60e3 }, AUTH: { n: 20, ms: 60e3 } };

// ---------- validazione dei parametri
class Bad extends Error {}
const V = {
  str(x, { min = 0, max = 256, re = null, name = 'valore' } = {}) {
    if (typeof x !== 'string' || x.length < min || x.length > max || (re && !re.test(x))) throw new Bad(`${name} non valido`);
    return x;
  },
  bool(x, name = 'valore') { if (typeof x !== 'boolean') throw new Bad(`${name} non valido`); return x; },
  num(x, { min = 0, max = 1e12, name = 'importo' } = {}) { const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x; if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Bad(`${name} non valido`); return n; },
  pass(x) { return V.str(x, { min: 8, max: 256, name: 'Password' }); },
  addr(x) { V.str(x, { min: 32, max: 44, re: /^[1-9A-HJ-NP-Za-km-z]+$/, name: 'Indirizzo' }); try { return new PublicKey(x).toBase58(); } catch { throw new Bad('Indirizzo non valido'); } },
  sig(x) { return V.str(x, { min: 64, max: 100, re: /^[1-9A-HJ-NP-Za-km-z]+$/, name: 'Firma della transazione' }); },
  mint(x) { return V.str(x, { min: 32, max: 44, re: /^[1-9A-HJ-NP-Za-km-z]+$/, name: 'mint' }); },
};
// corpo JSON: solo oggetti semplici, niente chiavi pericolose (prototype pollution), profondità e dimensioni limitate
function checkBody(v, depth = 0) {
  if (depth > LIMITS.DEPTH) throw new Bad('Richiesta troppo annidata');
  if (typeof v === 'string') { if (v.length > LIMITS.STR) throw new Bad('Testo troppo lungo'); return; }
  if (Array.isArray(v)) { if (v.length > LIMITS.ARR) throw new Bad('Elenco troppo lungo'); v.forEach((x) => checkBody(x, depth + 1)); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (BAD_KEYS.has(k) || k.length > 64) throw new Bad('Campo non ammesso'); checkBody(v[k], depth + 1); }
}

function createApp({ dataDir, env = process.env, engineOpts = {}, logger = console } = {}) {
  const DEMO = env.DEMO_MODE === '1';
  const FORCE_HTTPS = env.FORCE_HTTPS === '1';
  const IN_CONTAINER = env.IN_CONTAINER === '1';
  const ON_RAILWAY = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_PROJECT_ID);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch { /* volume senza permessi POSIX */ }
  // hosting con disco temporaneo: il wallet cifrato può essere ripristinato da una variabile d'ambiente
  const WALLET_FILE = path.join(dataDir, 'wallet.enc.json');
  if (!fs.existsSync(WALLET_FILE) && env.WALLET_ENC_JSON) {
    try {
      const raw = env.WALLET_ENC_JSON.trim();
      const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const j = JSON.parse(json); if (!j.publicKey || !j.ct) throw new Error('formato non valido');
      writeAtomic(WALLET_FILE, JSON.stringify(j, null, 2));
      logger.log(`  Wallet del bot ripristinato da WALLET_ENC_JSON: ${j.publicKey}`);
    } catch (e) { logger.error('  WALLET_ENC_JSON non valido:', e.message); }
  }
  try { if (fs.existsSync(WALLET_FILE)) fs.chmodSync(WALLET_FILE, 0o600); } catch {}
  const ks = new Keystore(WALLET_FILE);
  const auth = new Auth(path.join(dataDir, 'auth.json'));
  let setupToken = null;
  if (!auth.isSetup()) {
    if (env.SETUP_PIN) { try { auth.setup(String(env.SETUP_PIN).trim()); logger.log('  PIN impostato da SETUP_PIN.'); } catch (e) { logger.error('  SETUP_PIN non valido:', e.message); } }
    if (!auth.isSetup()) setupToken = crypto.randomBytes(5).toString('hex').toUpperCase();
  }
  const engine = new Engine({ dataDir, keystore: ks, ...engineOpts });

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  // dietro il proxy di Railway (o con TRUST_PROXY=1) l'indirizzo vero del client è quello aggiunto dal proxy (1 salto)
  app.set('trust proxy', env.TRUST_PROXY === '1' || ON_RAILWAY ? 1 : 'loopback');
  const httpsish = (req) => FORCE_HTTPS || req.secure;

  // intestazioni di sicurezza (come helmet)
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), interest-cohort=(), browsing-topics=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Origin-Agent-Cluster', '?1');
    if (httpsish(req)) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  });
  app.use((req, res, next) => {
    if (FORCE_HTTPS && req.headers['x-forwarded-proto'] === 'http' && req.path !== '/healthz') return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD, POST').json({ error: 'Metodo non ammesso' });
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

  // limite di richieste per indirizzo (finestra di 1 minuto)
  const hits = new Map();
  const limiter = (bucket, R) => (req, res, next) => {
    const now = Date.now(); const k = `${bucket}|${req.ip}`; let h = hits.get(k);
    if (!h || now - h.t > R.ms) { h = { t: now, n: 0 }; hits.set(k, h); }
    if (++h.n > R.n) { res.setHeader('Retry-After', String(Math.ceil((h.t + R.ms - now) / 1000))); return res.status(429).json({ error: 'Troppe richieste, riprova tra poco' }); }
    if (hits.size > 5000) for (const [kk, v] of hits) if (now - v.t > R.ms) hits.delete(kk);
    next();
  };
  app.use('/api/auth/login', limiter('auth', RATE.AUTH));
  app.use('/api/auth/setup', limiter('auth', RATE.AUTH));
  app.use('/api', limiter('api', RATE.API));
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); });

  // corpo JSON: solo application/json, max 32 KB, solo oggetti
  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const ct = String(req.headers['content-type'] || '');
    if (Number(req.headers['content-length'] || 0) > 0 && !/^application\/json\b/i.test(ct)) return res.status(415).json({ error: 'Formato non supportato' });
    next();
  });
  app.use(express.json({ limit: LIMITS.BODY, strict: true }));
  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (req.body === undefined) req.body = {};
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Richiesta non valida' });
    try { checkBody(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    next();
  });

  const cookieOf = (req) => { const m = /(?:^|;\s*)sb_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
  const isLocal = (req) => {
    const ip = req.socket.remoteAddress || '';
    const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers.forwarded;
    return !proxied && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
  };
  const setCookie = (req, res, token) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}; Priority=High${httpsish(req) ? '; Secure' : ''}`);
  };
  const clearCookie = (req, res) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${httpsish(req) ? '; Secure' : ''}`);
  const safeMsg = (e) => (e instanceof Bad || !e.code ? redact(String(e.message || 'Errore')).slice(0, 300) : 'Operazione non riuscita');
  const wrap = (fn) => async (req, res) => {
    try { const r = await fn(req, res); if (!res.headersSent) res.json(r || { ok: true }); }
    catch (e) { if (!res.headersSent) res.status(400).json({ error: safeMsg(e) }); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // CSRF (1): ogni POST deve avere l'header personalizzato, arrivare dallo stesso sito (Origin / Sec-Fetch-Site)
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.headers['x-sb'] !== '1') return res.status(403).json({ error: 'Richiesta non valida' });
    const sfs = req.headers['sec-fetch-site']; if (sfs && !['same-origin', 'none'].includes(sfs)) return res.status(403).json({ error: 'Richiesta da un altro sito bloccata' });
    const origin = req.headers.origin;
    if (origin) { let host = null; try { host = new URL(origin).host; } catch {} if (!host || host !== req.headers.host) return res.status(403).json({ error: 'Richiesta da un altro sito bloccata' }); }
    next();
  });

  // pubblico: stato della ricerca del MENTORE (nessun dato del portafoglio) e stato dell'accesso
  app.get('/api/research/status', (req, res) => res.json(engine.research.publicStatus()));
  app.get('/api/auth/status', (req, res) => {
    const tok = cookieOf(req); const ok = auth.check(tok);
    res.json({ setup: auth.isSetup(), loggedIn: ok, canSetup: !auth.isSetup(), needsToken: !auth.isSetup() && !isLocal(req), demo: DEMO, ...(ok ? { csrf: auth.csrf(tok) } : {}) });
  });
  app.post('/api/auth/setup', wrap(async (req, res) => {
    if (!isLocal(req)) {
      const t = typeof req.body.token === 'string' ? req.body.token.trim().toUpperCase() : '';
      if (!setupToken || t.length !== setupToken.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(setupToken))) { await sleep(1500); throw new Bad('Codice di configurazione errato: lo trovi nei log del server'); }
    }
    const tok = auth.setup(V.str(String(req.body.pin ?? ''), { min: 6, max: 12, re: /^\d+$/, name: 'PIN' }));
    setCookie(req, res, tok); setupToken = null; return { ok: true, csrf: auth.csrf(tok) };
  }));
  app.post('/api/auth/login', wrap(async (req, res) => {
    if (auth.underAttack()) await sleep(2000); // tanti errori da indirizzi diversi: rallenta tutti (senza bloccare)
    // il token eventualmente mandato dal client non viene mai riusato: dopo il login c'è sempre una sessione nuova (anti fixation)
    const old = cookieOf(req);
    try {
      const tok = auth.login(req.body.pin, req.ip);
      if (old && old !== tok) auth.logout(old);
      setCookie(req, res, tok); return { ok: true, csrf: auth.csrf(tok) };
    } catch (e) { await sleep(400 + Math.floor(Math.random() * 300)); throw new Bad(e.message); }
  }));
  app.post('/api/auth/logout', wrap(async (req, res) => { auth.logout(cookieOf(req)); clearCookie(req, res); }));

  // Resoconto in SOLA LETTURA con la chiave «resoconto» (Authorization: Bearer sbr_…): nessuna sessione, nessuna scrittura, limiti per IP
  const REP = { WINDOW: 10 * 60e3, OK: 30, BAD: 10, GLOBAL_BAD: 100 }; const repHits = new Map(); let repGlobalBad = [];
  const repDeny = (res, code, msg, wait) => { res.setHeader('Cache-Control', 'no-store'); if (wait) res.setHeader('Retry-After', String(Math.ceil(wait / 1000))); return res.status(code).json({ error: msg }); };
  app.get('/api/report', (req, res) => {
    const now = Date.now(); const ip = req.ip || 'unknown';
    const h = repHits.get(ip) || { ok: [], bad: [] }; h.ok = h.ok.filter((t) => now - t < REP.WINDOW); h.bad = h.bad.filter((t) => now - t < REP.WINDOW); repGlobalBad = repGlobalBad.filter((t) => now - t < REP.WINDOW);
    repHits.set(ip, h); if (repHits.size > 5000) repHits.clear();
    if (h.bad.length >= REP.BAD || repGlobalBad.length >= REP.GLOBAL_BAD) return repDeny(res, 429, 'Troppi tentativi con una chiave errata: riprova più tardi', REP.WINDOW - (now - (h.bad[0] || now)));
    if (h.ok.length >= REP.OK) return repDeny(res, 429, 'Troppe richieste: massimo 30 ogni 10 minuti', REP.WINDOW - (now - h.ok[0]));
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m || !auth.verifyReport(m[1], now)) { if (m) { h.bad.push(now); repGlobalBad.push(now); } res.setHeader('WWW-Authenticate', 'Bearer'); return repDeny(res, 401, 'Chiave resoconto mancante o non valida'); }
    h.ok.push(now);
    try { res.setHeader('Cache-Control', 'no-store'); return res.json({ ok: true, ...engine.report(now) }); }
    catch { return repDeny(res, 500, 'Resoconto non disponibile'); }
  });

  // da qui in poi: sessione valida (con rotazione del token) e, per i POST, token CSRF legato alla sessione
  app.use('/api', (req, res, next) => {
    const tok = cookieOf(req);
    if (!auth.check(tok)) return res.status(401).json({ error: 'Accesso richiesto' });
    if (req.method === 'POST' && !auth.checkCsrf(tok, req.headers['x-csrf'])) return res.status(403).json({ error: 'Sessione da aggiornare (CSRF): ricarica la pagina', csrf: true });
    const nt = auth.touch(tok); if (nt) { setCookie(req, res, nt); res.setHeader('X-Session-Rotated', '1'); }
    next();
  });
  // Modalità DEMO: solo simulazione, nessun wallet o fondo reale su questo server
  const DEMO_BLOCK = ['/wallet/create', '/wallet/unlock', '/wallet/export', '/wallet/backup', '/deposit/build', '/deposit/confirm', '/withdraw-address'];
  app.use('/api', (req, res, next) => {
    if (!DEMO || req.method !== 'POST') return next();
    if (DEMO_BLOCK.includes(req.path) || (req.path === '/mode' && req.body.mode === 'REAL') || (req.path === '/withdraw' && engine.cfg.mode === 'REAL')) return res.status(403).json({ error: 'Questa è una DEMO temporanea: solo simulazione, niente fondi reali. Per il trading reale usa la tua installazione.' });
    if (req.path === '/config' && req.body && 'rpcUrl' in req.body) delete req.body.rpcUrl;
    next();
  });

  const RAILWAY_VOL = env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH) : null;
  const PERSISTENT = env.DATA_PERSISTENT === '1' || !IN_CONTAINER || (RAILWAY_VOL !== null && RAILWAY_VOL === path.resolve(dataDir));
  const hostInfo = () => ({ demo: DEMO, persistent: PERSISTENT, container: IN_CONTAINER });
  // gestione della chiave resoconto (solo con la sessione del PIN): stato, nuova chiave (mostrata UNA volta), revoca
  app.get('/api/report-key', (req, res) => res.json(auth.reportStatus()));
  app.post('/api/report-key', wrap(async (req, res) => { res.setHeader('Cache-Control', 'no-store'); const token = auth.createReportKey(); return { ok: true, token, ...auth.reportStatus() }; }));
  app.post('/api/report-key/revoke', wrap(async () => { auth.revokeReport(); return { ok: true, ...auth.reportStatus() }; }));
  // RAZZO · Cacciatore di Razzi: radar, posizioni a scaglioni, statistiche (solo con la sessione del PIN)
  app.get('/api/rockets', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(engine.rocket.view()); });
  app.get('/api/state', (req, res) => res.json({ ...engine.snapshot(), host: hostInfo() }));
  let sse = 0;
  app.get('/api/events', (req, res) => {
    if (sse >= 20) return res.status(429).json({ error: 'Troppe connessioni aperte' });
    sse++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const tok = cookieOf(req);
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const snap = () => ({ ...engine.snapshot(), host: hostInfo() });
    send('snap', snap());
    const onEv = (e) => send('ev', e);
    engine.on('ev', onEv);
    // la connessione live si chiude se la sessione scade o viene chiusa (logout)
    const iv = setInterval(() => { if (!auth.check(tok)) { res.end(); return; } send('snap', snap()); }, 2000);
    const ka = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { sse--; clearInterval(iv); clearInterval(ka); engine.off('ev', onEv); });
  });
  app.get('/api/candles', (req, res) => {
    const m = typeof req.query.mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(req.query.mint) ? req.query.mint : '';
    res.json(m ? (engine.market.candles[m] || []).slice(-180) : []);
  });
  app.post('/api/config', wrap(async (req) => { engine.setConfig(req.body || {}); }));
  app.post('/api/trading', wrap(async (req) => { engine.setTrading(!!req.body.on); }));
  app.post('/api/mode', wrap(async (req) => { await engine.setMode(req.body.mode === 'REAL' ? 'REAL' : 'SIM', typeof req.body.confirm === 'string' ? req.body.confirm.slice(0, 64) : undefined); }));
  app.post('/api/reset-sim', wrap(async () => { engine.resetSim(); }));
  app.post('/api/rearm', wrap(async () => { engine.rearm(); }));
  // sala operativa: metti in pausa o riattiva un trader (Alpha/Omega) o escludi un analista dal consenso (le posizioni aperte restano gestite)
  app.post('/api/bot/pause', wrap(async (req) => {
    const id = V.str(req.body.id, { min: 2, max: 24, re: /^[a-z]+$/, name: 'Bot' });
    if (!BOT_IDS.includes(id)) throw new Bad('Bot sconosciuto');
    if (typeof req.body.paused !== 'boolean') throw new Bad('Valore non valido');
    return { id, paused: engine.desk.setPaused(id, req.body.paused) };
  }));
  // MENTE: ricerca web per bot, ripristino della versione precedente del cervello, laboratorio su richiesta (un bot, pochi ms)
  const botId = (req) => { const id = V.str(req.body.id, { min: 2, max: 24, re: /^[a-z]+$/, name: 'Bot' }); if (!BOT_IDS.includes(id)) throw new Bad('Bot sconosciuto'); return id; };
  app.post('/api/brain/web', wrap(async (req) => { const id = botId(req); if (typeof req.body.on !== 'boolean') throw new Bad('Valore non valido'); return engine.mind.setWeb(id, req.body.on); }));
  app.post('/api/brain/rollback', wrap(async (req) => { const id = botId(req); try { const r = engine.mind.lab.rollback(id); engine.mind.save(); return r; } catch (e) { throw new Bad(e.message); } }));
  app.post('/api/brain/lab', wrap(async (req) => { const id = botId(req); const r = engine.mind.lab.run(id); if (!r) throw new Bad('Servono almeno 30 esempi per il laboratorio'); engine.mind.save(); return { id, promoted: r.promoted, champ: r.champ, best: r.best }; }));
  app.post('/api/close', wrap(async (req) => {
    const id = V.str(req.body.id, { min: 1, max: 64, re: /^[A-Za-z0-9_-]+$/, name: 'Posizione' });
    if (id === 'all') return engine.closeAll();
    const p = engine.book.positions.find((x) => x.id === id); if (!p) throw new Bad('Posizione non trovata');
    await engine.closePosition(p, 'Chiusura manuale');
  }));
  app.post('/api/kill', wrap(async () => { await engine.killSwitch('Kill switch manuale'); }));

  // portafoglio del bot
  app.post('/api/wallet/create', wrap(async (req) => { const pk = ks.create(V.pass(req.body.password)); engine.log('SISTEMA', `Creato portafoglio del bot ${pk}`); engine.refreshBalances(true); return { publicKey: pk }; }));
  app.post('/api/wallet/unlock', wrap(async (req) => { const pk = ks.unlock(V.str(req.body.password, { min: 1, max: 256, name: 'Password' })); engine.log('SISTEMA', 'Portafoglio del bot sbloccato'); engine.reconcile().catch(() => {}); return { publicKey: pk }; }));
  app.post('/api/wallet/lock', wrap(async () => { if (engine.cfg.mode === 'REAL') engine.setTrading(false); ks.lock(); engine.log('SISTEMA', 'Portafoglio del bot bloccato'); }));
  app.post('/api/wallet/backup', wrap(async (req) => {
    ks.verify(V.str(req.body.password, { min: 1, max: 256, name: 'Password' }));
    const b64 = Buffer.from(fs.readFileSync(WALLET_FILE, 'utf8')).toString('base64');
    engine.log('SISTEMA', 'Backup cifrato del wallet copiato (per WALLET_ENC_JSON)', 'warn');
    return { walletEncJson: b64 };
  }));
  app.post('/api/wallet/export', wrap(async (req) => {
    if (req.body.confirm !== 'HO CAPITO') throw new Bad('Conferma scrivendo: HO CAPITO');
    const secret = ks.exportBase58(V.str(req.body.password, { min: 1, max: 256, name: 'Password' })); engine.log('SISTEMA', 'Chiave privata del bot esportata', 'warn'); return { secret };
  }));
  // Phantom dell'utente
  app.post('/api/user-wallet', wrap(async (req) => {
    const a = V.addr(req.body.address);
    engine.st.userWallet = a; engine.save(); engine.refreshBalances(true);
    engine.log('SISTEMA', `Phantom collegato: ${a}`);
    return { address: a, withdrawAddress: engine.st.withdrawAddress };
  }));
  app.post('/api/withdraw-address', wrap(async (req) => {
    const a = V.addr(req.body.address); ks.verify(V.str(req.body.password, { min: 1, max: 256, name: 'Password' }));
    engine.st.withdrawAddress = a; engine.save();
    engine.log('SISTEMA', `Indirizzo di prelievo impostato: ${engine.st.withdrawAddress}`, 'warn');
  }));
  app.post('/api/deposit/build', wrap(async (req) => {
    const info = ks.info(); if (!info.exists) throw new Bad('Crea prima il portafoglio del bot (Impostazioni → Portafoglio)');
    const from = engine.st.userWallet; if (!from) throw new Bad('Collega prima Phantom');
    const currency = req.body.currency === 'SOL' ? 'SOL' : 'USDC';
    const amount = V.num(req.body.amount, { min: 1e-9, max: 1e9 });
    const ub = await chain.getBalances(engine.conn, from);
    const reserve = engine.cfg.feeReserveSol;
    if (currency === 'SOL' && ub.sol < amount + reserve + 0.003) throw new Bad(`Saldo Phantom insufficiente: ${ub.sol.toFixed(4)} SOL (servono ${(amount + reserve + 0.003).toFixed(4)})`);
    if (currency === 'USDC') {
      const u = ub.tokens[USDC] ? ub.tokens[USDC].ui : 0;
      if (u < amount) throw new Bad(`USDC insufficienti su Phantom: ${u}`);
      if (ub.sol < reserve + 0.005) throw new Bad(`Servono anche ${(reserve + 0.005).toFixed(3)} SOL per commissioni e conto USDC`);
    }
    const r = await chain.buildDepositTx(engine.conn, { from, to: info.publicKey, currency, amount, usdcMint: USDC, feeReserveSol: reserve });
    engine.log('SISTEMA', `Deposito preparato: ${amount} ${currency} + ${reserve} SOL riserva commissioni → bot (da firmare in Phantom)`);
    return { transaction: r.base64, amount, currency, reserve, to: info.publicKey };
  }));
  app.post('/api/deposit/confirm', wrap(async (req) => engine.recordDeposit(V.sig(req.body.signature), engine.st.userWallet)));
  app.post('/api/withdraw', wrap(async (req) => engine.withdrawAll(V.str(req.body.password, { min: 1, max: 256, name: 'Password' }))));
  app.get('/api/lan', wrap(async () => {
    const urls = lanUrls(env.PORT || 8787);
    return { urls, qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } }) : null };
  }));
  // indirizzo PUBBLICO del wallet del bot come QR (per ricevere fondi anche senza Phantom): nessun segreto
  app.get('/api/wallet/qr', wrap(async () => {
    const w = ks.info(); if (!w.exists) return { address: null, qr: null };
    return { address: w.publicKey, qr: await QRCode.toDataURL(w.publicKey, { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } }) };
  }));
  app.all('/api/*', (req, res) => res.status(404).json({ error: 'Non trovato' }));

  app.get('/vendor/web3.js', (req, res) => res.sendFile(require.resolve('@solana/web3.js/lib/index.iife.min.js')));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], dotfiles: 'deny', index: 'index.html', redirect: false, setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.use((req, res) => res.status(404).type('text/plain').send('Non trovato'));
  // errori (JSON non valido, corpo troppo grande…): risposta generica, mai lo stack
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const st = err.status || err.statusCode || 500;
    res.status(st >= 400 && st < 600 ? st : 500).json({ error: st === 413 ? 'Richiesta troppo grande' : st === 400 ? 'Richiesta non valida' : 'Errore del server' });
  });
  return { app, engine, auth, ks, get setupToken() { return setupToken; }, persistent: PERSISTENT, demo: DEMO, inContainer: IN_CONTAINER };
}
function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${port}`);
  return out;
}
module.exports = { createApp, lanUrls, checkBody, V, CSP };
