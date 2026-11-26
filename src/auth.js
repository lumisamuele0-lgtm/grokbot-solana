'use strict';
// Accesso all'app con PIN.
// - PIN: scrypt (N=2^17, r=8, p=1, sale casuale da 16 byte) su HMAC-SHA256(pepe, PIN); confronto a tempo costante.
//   I vecchi hash (scrypt N=2^14 senza pepe) restano validi e vengono rifatti col nuovo schema al primo accesso riuscito.
// - Sessioni: token casuali da 256 bit, sul disco solo lo SHA-256 del token; scadenza assoluta 30 giorni e per inattività
//   14 giorni; rotazione del token ogni 12 ore (il vecchio vale ancora 60 s per le richieste già partite); max 20 sessioni.
// - Tentativi: dopo 5 PIN errati dallo stesso indirizzo blocco 5 minuti, poi 10, 20… fino a 1 ora; rallentamento globale se
//   arrivano troppi errori da indirizzi diversi (senza mai bloccare del tutto il proprietario).
// - CSRF: token HMAC-SHA256 legato alla sessione (non cambia con la rotazione).
// auth.json è salvato tramite l'archivio cifrato (AES-256-GCM + HMAC-SHA256).
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJson, tokenKey } = require('./store');

const SESSION_DAYS = 30, IDLE_DAYS = 14, ROTATE_MS = 12 * 3600e3, GRACE_MS = 60e3, MAX_SESSIONS = 20;
const KDF = { name: 'scrypt-hmac', N: 1 << 17, r: 8, p: 1, keylen: 32 };
const LEGACY = { name: 'scrypt', N: 1 << 14, r: 8, p: 1, keylen: 32 };
const LOCK = { FAILS: 5, BASE_MS: 5 * 60e3, MAX_MS: 3600e3, GLOBAL_WINDOW_MS: 15 * 60e3, GLOBAL_FAILS: 30 };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isTok = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);

class Auth {
  constructor(file) {
    this.file = file;
    this.pepper = crypto.createHmac('sha256', tokenKey(path.dirname(file))).update('pin-pepper-v1').digest();
    this.csrfKey = crypto.createHmac('sha256', tokenKey(path.dirname(file))).update('csrf-v1').digest();
    this.reportPep = crypto.createHmac('sha256', tokenKey(path.dirname(file))).update('report-key-v1').digest();
    this.data = readJson(file, null);
    this.fails = new Map(); // ip -> { n, until, level, last }
    this.globalFails = [];
    this.migrateSessions();
  }
  hash(pin, salt, kdf = KDF) {
    const input = kdf.name === 'scrypt-hmac' ? crypto.createHmac('sha256', this.pepper).update(String(pin)).digest() : Buffer.from(String(pin));
    return crypto.scryptSync(input, Buffer.from(salt, 'base64'), kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }).toString('base64');
  }
  isSetup() { return !!(this.data && this.data.pinHash); }
  setPin(pin) { const salt = crypto.randomBytes(16).toString('base64'); this.data.salt = salt; this.data.pinKdf = { ...KDF }; this.data.pinHash = this.hash(pin, salt, KDF); }
  setup(pin) {
    if (this.isSetup()) throw new Error('PIN già impostato');
    if (typeof pin !== 'string' && typeof pin !== 'number') throw new Error('Il PIN deve avere da 6 a 12 cifre');
    if (!/^\d{6,12}$/.test(String(pin))) throw new Error('Il PIN deve avere da 6 a 12 cifre');
    this.data = { sessions: {} }; this.setPin(String(pin));
    this.save();
    return this.newSession();
  }
  save() { writeJson(this.file, this.data); }
  migrateSessions() {
    if (!this.data || !this.data.sessions) return;
    let ch = false; const now = Date.now();
    for (const [k, v] of Object.entries(this.data.sessions)) if (typeof v === 'number') { this.data.sessions[k] = { fam: crypto.randomBytes(16).toString('hex'), created: now, last: now, rot: now, exp: v }; ch = true; }
    if (ch) this.save();
  }
  prune(now = Date.now()) {
    const S = this.data.sessions;
    for (const [k, s] of Object.entries(S)) if (!s || s.exp < now || (s.last && now - s.last > IDLE_DAYS * 864e5)) delete S[k];
    const live = Object.entries(S).filter(([, s]) => !s.replacedAt).sort((a, b) => b[1].last - a[1].last);
    for (const [k] of live.slice(MAX_SESSIONS)) delete S[k];
  }
  newSession(fam = null, now = Date.now()) {
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions[sha(token)] = { fam: fam || crypto.randomBytes(16).toString('hex'), created: now, last: now, rot: now, exp: now + SESSION_DAYS * 864e5 };
    this.prune(now); this.save();
    return token;
  }
  lockState(ip, now = Date.now()) { const f = this.fails.get(ip); return f && f.until > now ? f.until - now : 0; }
  // true se c'è un attacco distribuito in corso (il server aggiunge un ritardo, nessun blocco totale)
  underAttack(now = Date.now()) { this.globalFails = this.globalFails.filter((t) => now - t < LOCK.GLOBAL_WINDOW_MS); return this.globalFails.length >= LOCK.GLOBAL_FAILS; }
  login(pin, ip = 'unknown', now = Date.now()) {
    const f = this.fails.get(ip) || { n: 0, until: 0, level: 0, last: 0 };
    if (f.last && now - f.last > 24 * 3600e3) { f.level = 0; f.n = 0; }
    if (f.until > now) throw new Error(`Troppi tentativi. Riprova tra ${Math.ceil((f.until - now) / 60000)} min`);
    const p = typeof pin === 'string' || typeof pin === 'number' ? String(pin) : '';
    let ok = false;
    if (this.isSetup() && /^\d{6,12}$/.test(p)) {
      const kdf = this.data.pinKdf || LEGACY;
      const a = Buffer.from(this.hash(p, this.data.salt, kdf)); const b = Buffer.from(this.data.pinHash);
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (ok && (kdf.name !== KDF.name || kdf.N !== KDF.N)) { this.setPin(p); this.save(); } // nuovo hash al primo accesso riuscito
    }
    if (!ok) {
      f.n++; f.last = now; this.globalFails.push(now);
      if (f.n >= LOCK.FAILS) { f.until = now + Math.min(LOCK.MAX_MS, LOCK.BASE_MS * 2 ** f.level); f.level++; f.n = 0; }
      this.fails.set(ip, f);
      throw new Error('PIN errato');
    }
    this.fails.delete(ip);
    return this.newSession(null, now);
  }
  session(token, now = Date.now()) {
    if (!isTok(token) || !this.isSetup()) return null;
    const s = this.data.sessions[sha(token)];
    if (!s || s.exp <= now || (s.last && now - s.last > IDLE_DAYS * 864e5)) return null;
    return s;
  }
  check(token, now = Date.now()) { return !!this.session(token, now); }
  // aggiorna l'ultimo uso e, se serve, ruota il token: ritorna il nuovo token (o null)
  touch(token, now = Date.now()) {
    const s = this.session(token, now); if (!s) return null;
    let save = false;
    if (now - (s.last || 0) > 10 * 60e3) { s.last = now; save = true; }
    if (!s.replacedAt && now - (s.rot || s.created) > ROTATE_MS) {
      s.replacedAt = now; const oldExp = s.exp; s.exp = Math.min(s.exp, now + GRACE_MS);
      const nt = this.newSession(s.fam, now); const ns = this.data.sessions[sha(nt)]; ns.created = s.created; ns.exp = oldExp; // la scadenza assoluta non si allunga
      this.save(); return nt;
    }
    if (save) this.save();
    return null;
  }
  csrf(token, now = Date.now()) { const s = this.session(token, now); return s ? crypto.createHmac('sha256', this.csrfKey).update(s.fam).digest('hex') : null; }
  checkCsrf(token, value, now = Date.now()) {
    const want = this.csrf(token, now); if (!want || typeof value !== 'string' || value.length !== want.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(want));
  }
  // Chiave «resoconto» in sola lettura: il token è mostrato una volta sola; sul server resta solo l'HMAC (con pepe derivato dalla chiave dati)
  reportHash(tok) { return crypto.createHmac('sha256', this.reportPep).update(String(tok)).digest('hex'); }
  createReportKey(now = Date.now()) {
    const token = 'sbr_' + crypto.randomBytes(32).toString('base64url');
    this.data.report = { hash: this.reportHash(token), created: now, lastUsed: null, uses: 0 }; this.save();
    return token;
  }
  verifyReport(token, now = Date.now()) {
    const r = this.data && this.data.report; if (!r || !r.hash || typeof token !== 'string' || !/^sbr_[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const a = Buffer.from(this.reportHash(token), 'hex'); const b = Buffer.from(r.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    r.uses = (r.uses || 0) + 1; const save = !r.lastUsed || now - r.lastUsed > 60e3; r.lastUsed = now; if (save) this.save();
    return true;
  }
  revokeReport() { if (this.data && this.data.report) { delete this.data.report; this.save(); } }
  reportStatus() { const r = this.data && this.data.report; return r ? { active: true, created: r.created, lastUsed: r.lastUsed || null, uses: r.uses || 0 } : { active: false }; }
  logout(token) {
    if (!isTok(token) || !this.data || !this.data.sessions) return;
    const s = this.data.sessions[sha(token)]; if (!s) return;
    for (const [k, x] of Object.entries(this.data.sessions)) if (x.fam === s.fam) delete this.data.sessions[k]; // tutta la famiglia (anche i token ruotati)
    this.save();
  }
}
module.exports = { Auth, KDF, LOCK, SESSION_DAYS, IDLE_DAYS, ROTATE_MS };
