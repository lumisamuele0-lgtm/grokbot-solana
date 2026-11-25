'use strict';
// Portafoglio del bot cifrato su disco: scrypt (KDF, N=2^17) + AES-256-GCM con la password del wallet. La chiave non lascia mai il server.
// Volutamente NON dipende dalla chiave dell'archivio dati: con la sola password (o il backup WALLET_ENC_JSON) il wallet si apre sempre.
// I file con il vecchio scrypt (N=2^15) restano validi e vengono ricifrati col nuovo al primo sblocco riuscito (scrittura atomica, verificata).
const crypto = require('crypto');
const fs = require('fs');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;

const KDF = { N: 1 << 17, r: 8, p: 1, keylen: 32 };
const { writeAtomic } = require('./store');

function deriveKey(password, salt, kdf = KDF) {
  return crypto.scryptSync(String(password).normalize('NFKC'), salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

function encryptSecret(secretBytes, password) {
  if (!password || String(password).length < 8) throw new Error('La password deve avere almeno 8 caratteri');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secretBytes)), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return { v: 1, kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

function decryptSecret(blob, password) {
  const salt = Buffer.from(blob.kdf.salt, 'base64');
  const key = deriveKey(password, salt, blob.kdf);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]);
  } catch {
    throw new Error('Password errata');
  } finally { key.fill(0); }
}

class Keystore {
  constructor(file) { this.file = file; this.kp = null; }
  exists() { return fs.existsSync(this.file); }
  info() {
    if (!this.exists()) return { exists: false, unlocked: false };
    const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { exists: true, unlocked: !!this.kp, publicKey: j.publicKey, createdAt: j.createdAt };
  }
  create(password) {
    if (this.exists()) throw new Error('Esiste già un portafoglio del bot');
    const kp = Keypair.generate();
    const blob = encryptSecret(kp.secretKey, password);
    const out = { publicKey: kp.publicKey.toBase58(), createdAt: new Date().toISOString(), ...blob };
    writeAtomic(this.file, JSON.stringify(out, null, 2));
    this.kp = kp;
    return out.publicKey;
  }
  unlock(password) {
    const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const sk = decryptSecret(j, password);
    const kp = Keypair.fromSecretKey(new Uint8Array(sk));
    sk.fill(0);
    if (kp.publicKey.toBase58() !== j.publicKey) throw new Error('File portafoglio corrotto');
    this.kp = kp;
    if (!j.kdf || j.kdf.N < KDF.N) this.upgrade(j, password, kp);
    return j.publicKey;
  }
  // ricifra col KDF più forte; scrive solo dopo aver verificato che il nuovo file si apre e dà la stessa chiave
  upgrade(j, password, kp) {
    try {
      const blob = encryptSecret(kp.secretKey, password);
      const chk = decryptSecret(blob, password); const same = Buffer.compare(chk, Buffer.from(kp.secretKey)) === 0; chk.fill(0);
      if (!same) return false;
      writeAtomic(this.file, JSON.stringify({ publicKey: j.publicKey, createdAt: j.createdAt, ...blob }, null, 2));
      return true;
    } catch { return false; }
  }
  verify(password) {
    const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    decryptSecret(j, password).fill(0);
    return true;
  }
  lock() { this.kp = null; }
  exportBase58(password) {
    const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const sk = decryptSecret(j, password);
    const s = bs58.encode(sk); sk.fill(0); return s;
  }
}

module.exports = { Keystore, encryptSecret, decryptSecret };
