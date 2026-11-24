'use strict';
// Accesso all'app con PIN (necessario perché l'interfaccia è raggiungibile dalla rete Wi-Fi).
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');

const SESSION_DAYS = 30;
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), 32, { N: 1 << 14, r: 8, p: 1 }).toString('base64');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Auth {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, null);
    this.fails = new Map(); // ip -> {n, until}
  }
  isSetup() { return !!(this.data && this.data.pinHash); }
  setup(pin) {
    if (this.isSetup()) throw new Error('PIN già impostato');
    if (!/^\d{6,12}$/.test(String(pin))) throw new Error('Il PIN deve avere da 6 a 12 cifre');
    const salt = crypto.randomBytes(16).toString('base64');
    this.data = { salt, pinHash: hashPin(pin, salt), sessions: {} };
    this.save();
    return this.newSession();
  }
  save() { writeJson(this.file, this.data); }
  newSession() {
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions[sha(token)] = Date.now() + SESSION_DAYS * 864e5;
    // pulizia
    for (const [k, exp] of Object.entries(this.data.sessions)) if (exp < Date.now()) delete this.data.sessions[k];
    this.save();
    return token;
  }
  login(pin, ip) {
    const f = this.fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw new Error(`Troppi tentativi. Riprova tra ${Math.ceil((f.until - Date.now()) / 60000)} min`);
    const ok = this.isSetup() && crypto.timingSafeEqual(Buffer.from(hashPin(pin, this.data.salt)), Buffer.from(this.data.pinHash));
    if (!ok) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; }
      this.fails.set(ip, f);
      throw new Error('PIN errato');
    }
    this.fails.delete(ip);
    return this.newSession();
  }
  check(token) {
    if (!token || !this.isSetup()) return false;
    const exp = this.data.sessions[sha(token)];
    return !!exp && exp > Date.now();
  }
  logout(token) { if (token && this.data) { delete this.data.sessions[sha(token)]; this.save(); } }
}
module.exports = { Auth };
