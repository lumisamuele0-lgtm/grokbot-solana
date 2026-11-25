'use strict';
// Utility per l'hosting cloud gratuito (Render / Railway / Northflank).

// Indirizzo pubblico da "pingare" per non far addormentare il servizio (Render free: 15 min senza visite).
function keepAliveUrl(env) {
  const v = String(env.KEEPALIVE_URL || '').trim();
  if (/^(off|0|no|false)$/i.test(v)) return null;
  const u = v || (env.RENDER ? String(env.RENDER_EXTERNAL_URL || '').trim() : '');
  if (!/^https?:\/\//i.test(u)) return null;
  return u.replace(/\/+$/, '');
}

module.exports = { keepAliveUrl };
