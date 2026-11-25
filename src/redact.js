'use strict';
// Niente segreti nei log o nelle risposte: maschera chiavi API negli URL, campi password/PIN/segreti, token di sessione.
const SECRET_Q = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|secret|auth)=)[^&#\s"']+/gi;
const SECRET_F = /("?(?:password|pin|secret|secretKey|privateKey|token|walletEncJson|BOT_WALLET_PASSWORD|SETUP_PIN|DATA_ENC_KEY)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi;
const HEX64 = /\b[a-f0-9]{64}\b/g;
const MASK = '••••';
function redact(s) {
  if (s == null) return s;
  return String(s).replace(SECRET_Q, `$1${MASK}`).replace(SECRET_F, `$1"${MASK}"`).replace(HEX64, MASK);
}
// URL RPC mostrato nell'app: host visibile, chiavi nascoste
function maskUrl(u) { return typeof u === 'string' ? u.replace(SECRET_Q, `$1${MASK}`).replace(/\/\/([^/@\s]+)@/, `//${MASK}@`) : u; }
const isMasked = (u) => typeof u === 'string' && u.includes(MASK);
module.exports = { redact, maskUrl, isMasked, MASK };
