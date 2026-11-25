'use strict';
// Sessioni: fixation, replay dopo logout, scadenza, inattività, rotazione, flag del cookie, token mai salvati in chiaro
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { boot, req, login, apost, PIN } = require('./helpers');
const { Auth, SESSION_DAYS, IDLE_DAYS, ROTATE_MS } = require('../../src/auth');
const { readJson } = require('../../src/store');

test('session fixation: un token scelto dall\'attaccante non diventa mai valido; il login crea sempre una sessione nuova', async () => {
  const s = await boot();
  try {
    const evil = 'ab'.repeat(32);
    const l = await login(s.base, PIN, { cookie: evil });
    assert.strictEqual(l.status, 200); assert.notStrictEqual(l.cookie, evil);
    assert.strictEqual((await req(s.base, '/api/state', { cookie: evil })).status, 401);
    const l2 = await login(s.base, PIN, { cookie: l.cookie }); assert.notStrictEqual(l2.cookie, l.cookie, 'nuovo token a ogni login');
    assert.strictEqual((await req(s.base, '/api/state', { cookie: l.cookie })).status, 401, 'il vecchio token è chiuso');
  } finally { await s.close(); }
});

test('replay dopo il logout: il token non vale più (anche per la connessione live)', async () => {
  const s = await boot();
  try {
    const l = await login(s.base);
    assert.strictEqual((await req(s.base, '/api/state', { cookie: l.cookie })).status, 200);
    const out = await apost(s.base, l, '/api/auth/logout', {}); assert.strictEqual(out.status, 200); assert.match(out.setCookie, /Max-Age=0/);
    assert.strictEqual((await req(s.base, '/api/state', { cookie: l.cookie })).status, 401);
    assert.strictEqual((await req(s.base, '/api/events', { cookie: l.cookie })).status, 401);
    assert.strictEqual((await apost(s.base, l, '/api/trading', { on: true })).status, 401);
  } finally { await s.close(); }
});

test('cookie: HttpOnly, SameSite=Strict, Path=/, Secure con HTTPS', async () => {
  const s = await boot({ FORCE_HTTPS: '1' });
  try {
    const l = await login(s.base, PIN, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(l.setCookie, /HttpOnly/); assert.match(l.setCookie, /SameSite=Strict/); assert.match(l.setCookie, /Path=\//); assert.match(l.setCookie, /Secure/); assert.match(l.setCookie, /Max-Age=2592000/);
  } finally { await s.close(); }
});

test('scadenza assoluta 30 giorni, inattività 14 giorni, rotazione ogni 12 ore con 60 s di tolleranza, logout di tutta la famiglia', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbses-')); const a = new Auth(path.join(d, 'auth.json')); a.setup(PIN);
  const t0 = 1e12; const tok = a.login(PIN, 'ip', t0);
  assert.ok(a.check(tok, t0)); assert.ok(!a.check(tok, t0 + IDLE_DAYS * 864e5 + 1), 'scade per inattività');
  // rotazione
  const csrf0 = a.csrf(tok, t0);
  const nt = a.touch(tok, t0 + ROTATE_MS + 1); assert.ok(nt && nt !== tok);
  assert.ok(a.check(tok, t0 + ROTATE_MS + 30e3), 'tolleranza 60 s per le richieste in volo'); assert.ok(!a.check(tok, t0 + ROTATE_MS + 61e3), 'poi il vecchio token è morto');
  assert.strictEqual(a.csrf(nt, t0 + ROTATE_MS + 2), csrf0, 'il CSRF resta valido dopo la rotazione');
  // scadenza assoluta (con uso continuo e rotazioni)
  let cur = nt; let now = t0 + ROTATE_MS + 2;
  while (now < t0 + SESSION_DAYS * 864e5 - ROTATE_MS) { now += ROTATE_MS + 1; const x = a.touch(cur, now); if (x) cur = x; }
  assert.ok(a.check(cur, now)); assert.ok(!a.check(cur, t0 + SESSION_DAYS * 864e5 + 1), 'scadenza assoluta a 30 giorni');
  // logout chiude anche i token ruotati della stessa sessione
  const t2 = a.login(PIN, 'ip', now); const t3 = a.touch(t2, now + ROTATE_MS + 1);
  a.logout(t3); assert.ok(!a.check(t2, now + ROTATE_MS + 2) && !a.check(t3, now + ROTATE_MS + 2));
  // sul disco solo hash SHA-256 dei token
  const disk = readJson(path.join(d, 'auth.json'), null); const raw = JSON.stringify(disk);
  assert.ok(!raw.includes(tok) && !raw.includes(cur) && !raw.includes(PIN));
});

test('massimo 20 sessioni: le più vecchie vengono chiuse', () => {
  const a = new Auth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbses2-')), 'auth.json')); const first = a.setup(PIN);
  const toks = []; for (let i = 0; i < 25; i++) toks.push(a.newSession(null, Date.now() + i));
  assert.ok(Object.keys(a.data.sessions).length <= 20); assert.ok(!a.check(first)); assert.ok(a.check(toks[24]));
});

test('vecchie sessioni (formato precedente) restano valide: nessun nuovo login obbligatorio', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbses3-')); const f = path.join(d, 'auth.json');
  const crypto = require('crypto'); const tok = crypto.randomBytes(32).toString('hex'); const salt = crypto.randomBytes(16).toString('base64');
  const legacyHash = crypto.scryptSync(PIN, Buffer.from(salt, 'base64'), 32, { N: 1 << 14, r: 8, p: 1 }).toString('base64');
  fs.writeFileSync(f, JSON.stringify({ salt, pinHash: legacyHash, sessions: { [crypto.createHash('sha256').update(tok).digest('hex')]: Date.now() + 10 * 864e5 } }));
  const a = new Auth(f); assert.ok(a.check(tok), 'la sessione aperta sull\'iPhone resta valida');
});
