'use strict';
// ARCHIVIO CIFRATO: TUTTE le letture/scritture dei file dati (/data: config, stato, conoscenza, mentore, partite, ricerca, accesso)
// passano da qui. Ogni file è cifrato con AES-256-GCM e firmato con HMAC-SHA256 (doppio controllo d'integrità); il nome del
// file è legato al contenuto (AAD), così un file non si può scambiare con un altro. Scrittura atomica (file temporaneo 0600,
// fsync, rename). Migrazione trasparente: un file ancora in chiaro viene letto e subito riscritto cifrato.
// Chiave: 32 byte casuali in <cartella dati>/.sb-datakey (permessi 0600, MAI in git), opzionalmente combinata con la
// variabile DATA_ENC_KEY (se la imposti, non toglierla più: i file scritti con lei servono anche lei). Le due chiavi di lavoro
// (cifratura e firma) sono derivate con HKDF-SHA256. Un file manomesso o illeggibile viene messo da parte (.corrupt-…) e mai usato.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = '.sb-datakey';
const VERSION = 1;
const keys = new Map(); // cartella -> { kid, enc, mac }
let warn = (m) => console.error(m);

class IntegrityError extends Error { constructor(m) { super(m); this.name = 'IntegrityError'; } }

function writeAtomic(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(tmp, mode); } catch { /* file system senza permessi POSIX */ }
  fs.renameSync(tmp, file);
  try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* non tutti i sistemi permettono fsync della cartella */ }
}

function masterKey(dir) {
  const f = path.join(dir, KEY_FILE);
  try {
    const hex = fs.readFileSync(f, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(hex)) { try { fs.chmodSync(f, 0o600); } catch {} return Buffer.from(hex, 'hex'); }
    warn('  ATTENZIONE: chiave dati non valida, ne creo una nuova (i file cifrati con la vecchia verranno messi da parte)');
    fs.renameSync(f, `${f}.corrupt-${Date.now()}`);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(f, k.toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') return masterKey(dir); throw e; }
  return k;
}
function keysFor(dir) {
  const env = process.env.DATA_ENC_KEY ? String(process.env.DATA_ENC_KEY) : '';
  const id = `${path.resolve(dir)}|${env ? crypto.createHash('sha256').update(env).digest('hex').slice(0, 8) : ''}`;
  if (keys.has(id)) return keys.get(id);
  const ikm = env ? Buffer.concat([masterKey(dir), crypto.createHash('sha256').update(env).digest()]) : masterKey(dir);
  const salt = Buffer.from('grokbot-store-v1');
  const k = { kid: env ? 'fe1' : 'f1',
    enc: Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('aes-256-gcm:data'), 32)),
    mac: Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('hmac-sha256:data'), 32)),
    tok: Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('hmac-sha256:tokens'), 32)) };
  keys.set(id, k);
  return k;
}
const aadOf = (file, kid) => Buffer.from(`sbenc${VERSION}|${path.basename(file)}|${kid}`);
const macOf = (k, aad, iv, tag, ct) => crypto.createHmac('sha256', k.mac).update(aad).update(iv).update(tag).update(ct).digest();

function seal(file, obj) {
  const k = keysFor(path.dirname(file)); const iv = crypto.randomBytes(12); const aad = aadOf(file, k.kid);
  const c = crypto.createCipheriv('aes-256-gcm', k.enc, iv); c.setAAD(aad);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]); const tag = c.getAuthTag();
  return JSON.stringify({ sbenc: VERSION, kid: k.kid, alg: 'A256GCM+HS256', iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64'), mac: macOf(k, aad, iv, tag, ct).toString('base64') });
}
function open(file, env) {
  const k = keysFor(path.dirname(file));
  if (env.sbenc !== VERSION || typeof env.ct !== 'string' || typeof env.iv !== 'string' || typeof env.tag !== 'string' || typeof env.mac !== 'string') throw new IntegrityError('formato cifrato sconosciuto');
  if (env.kid !== k.kid) throw new IntegrityError(env.kid === 'fe1' ? 'serve la variabile DATA_ENC_KEY usata per cifrare questo file' : 'chiave diversa da quella del file');
  const aad = aadOf(file, env.kid); const iv = Buffer.from(env.iv, 'base64'); const tag = Buffer.from(env.tag, 'base64'); const ct = Buffer.from(env.ct, 'base64');
  const mac = Buffer.from(env.mac, 'base64'); const want = macOf(k, aad, iv, tag, ct);
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) throw new IntegrityError('firma HMAC non valida (file manomesso o chiave diversa)');
  try { const d = crypto.createDecipheriv('aes-256-gcm', k.enc, iv); d.setAAD(aad); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')); }
  catch { throw new IntegrityError('controllo AES-GCM fallito'); }
}
function quarantine(file, why) {
  const dest = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, dest); } catch { /* già spostato */ }
  warn(`  ATTENZIONE: ${path.basename(file)} illeggibile (${why}): messo da parte come ${path.basename(dest)}, uso i valori iniziali`);
}

// legge un file dati (cifrato o, per la migrazione, ancora in chiaro). Manca → def. Manomesso → messo da parte, def.
function readJson(file, def) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return def; }
  let j;
  try { j = JSON.parse(raw); } catch { quarantine(file, 'JSON non valido'); return def; }
  if (j && typeof j === 'object' && j.sbenc !== undefined) {
    try { return open(file, j); } catch (e) { quarantine(file, e.message); return def; }
  }
  try { writeAtomic(file, seal(file, j)); } catch (e) { warn(`  cifratura di ${path.basename(file)} rinviata: ${e.message}`); } // migrazione dal chiaro
  return j;
}
function writeJson(file, obj) { writeAtomic(file, seal(file, obj)); }
function isEncrypted(file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return !!(j && j.sbenc); } catch { return false; } }
function debounceWriter(file, getObj, ms = 1500) {
  let t = null;
  const flush = () => { clearTimeout(t); t = null; writeJson(file, getObj()); };
  return { schedule() { if (!t) t = setTimeout(flush, ms); }, flush };
}
// chiave HMAC per firmare token (CSRF) legata alla cartella dati
function tokenKey(dir) { return keysFor(dir).tok; }
function setWarn(fn) { warn = fn; }
function _resetKeys() { keys.clear(); }
module.exports = { readJson, writeJson, writeAtomic, debounceWriter, isEncrypted, tokenKey, IntegrityError, setWarn, _resetKeys, KEY_FILE };
