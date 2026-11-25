'use strict';
// Ripartizione del capitale per il pannello in alto: Capitale totale = Disponibile − commissioni SOL esterne + In posizioni.
// È la stessa formula di Engine.equity(), quindi i numeri tornano sempre al centesimo (SIMULAZIONE e REALE).
function capitalBreakdown(book, valueOf) {
  const positions = (book.positions || []).map((p) => {
    const value = valueOf(p);
    return { id: p.id, symbol: p.symbol, side: p.side || 'LONG', lev: p.lev || 1, committed: p.costBase, value };
  });
  const available = book.cash;
  const extFees = book.extFees || 0;
  const inPositions = positions.reduce((a, p) => a + p.value, 0);
  const committed = positions.reduce((a, p) => a + p.committed, 0);
  const total = available - extFees + inPositions;
  const den = Math.max(0, available) + Math.max(0, inPositions);
  const availablePct = den > 0 ? (Math.max(0, available) / den) * 100 : 100;
  return { total, available, inPositions, committed, openMove: inPositions - committed, extFees, availablePct, inPositionsPct: 100 - availablePct, positions };
}
// formato italiano per i messaggi del Logger: "35,00 $" (USDC) o "◎0,2500" (SOL)
function fmtMoney(x, base, signed = false) {
  const d = base === 'SOL' ? 4 : 2;
  const s = signed ? (x > 0 ? '+' : x < 0 ? '-' : '') : x < 0 ? '-' : '';
  const n = Math.abs(x).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' });
  return base === 'SOL' ? `${s}◎${n}` : `${s}${n} $`;
}
module.exports = { capitalBreakdown, fmtMoney };
