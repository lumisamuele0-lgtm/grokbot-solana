'use strict';
// PARTITA: due squadre da 7 bot (6 giocatori + 1 allenatore) si sfidano a chi fa più profitto in 20 minuti.
// Ogni giocatore è specialista di una cripto e di una direzione (SOL/BTC/ETH × LONG/SHORT) e svolge per la sua
// operazione tutte le fasi di prima (scansione, verifica, flusso, scelta, dimensione, rischio, esecuzione, sorveglianza).
// Le squadre hanno stili diversi: FULMINI = trend/momentum, SQUALI = contropiede (mean reversion).
// L'allenatore riceve le lezioni del MENTORE e "potenzia" i giocatori SOLO in modo limitato: piccoli bonus di punteggio,
// più selettività dopo le perdite, time-out. Non cambia MAI margine (7%), leva (5–10x), stop o kill switch.
// Funziona in SIMULAZIONE e in REALE (in REALE resta il blocco dei perps finché il test con 5-10 USDC non è approvato).
const path = require('path');
const { readJson, debounceWriter } = require('./store');
const P = require('./perps');
const S = require('./strategy');
const K = require('./knowledge');
const { uid, sleep } = require('./util');

const MATCH_MS = 20 * 60e3;
const CLOSE_GRACE_MS = 2 * 60e3;
const COACH = { BONUS_STEP: 0.25, BONUS_MAX: 0.5, FOCUS_BONUS: 0.2, SEL_MAX: 2, TIMEOUT_MS: 2 * 60e3, FOCUS_EVERY_MS: 2 * 60e3, TALK_EVERY_MS: 3 * 60e3 };
const ASSET_MINT = Object.fromEntries(Object.entries(P.SHORT_MARKETS).map(([m, s]) => [s, m]));
const ROLE = { LONG: 'attaccante', SHORT: 'difensore' };

const TEAMS = {
  A: { id: 'A', name: 'Fulmini Rossi', short: 'FUL', style: 'trend', styleLabel: 'trend e momentum', color: '#FF4D5E', color2: '#FFB020', motto: 'Il trend è nostro amico!',
    strategies: ['ema_adx', 'donchian', 'macd', 'vwap', 'squeeze', 'supertrend', 'roc'],
    coach: { id: 'A0', name: 'Mister Fiamma', look: 'cap' },
    players: [
      { id: 'A1', name: 'Saetta', asset: 'SOL', side: 'LONG', num: 7, look: 'antenna' }, { id: 'A2', name: 'Brace', asset: 'SOL', side: 'SHORT', num: 4, look: 'horns' },
      { id: 'A3', name: 'Vulcano', asset: 'BTC', side: 'LONG', num: 9, look: 'mohawk' }, { id: 'A4', name: 'Scintilla', asset: 'BTC', side: 'SHORT', num: 3, look: 'visor' },
      { id: 'A5', name: 'Razzo', asset: 'ETH', side: 'LONG', num: 11, look: 'fins' }, { id: 'A6', name: 'Tuono', asset: 'ETH', side: 'SHORT', num: 5, look: 'band' },
    ] },
  B: { id: 'B', name: 'Squali Blu', short: 'SQU', style: 'contra', styleLabel: 'contropiede sugli eccessi', color: '#3BA4FF', color2: '#00E5C7', motto: 'Colpiamo quando esagerano!',
    strategies: ['rsi_bb', 'rsi2', 'funding', 'fng', 'lsratio'],
    coach: { id: 'B0', name: 'Mister Ghiaccio', look: 'beanie' },
    players: [
      { id: 'B1', name: 'Onda', asset: 'SOL', side: 'LONG', num: 10, look: 'fin' }, { id: 'B2', name: 'Abisso', asset: 'SOL', side: 'SHORT', num: 2, look: 'goggles' },
      { id: 'B3', name: 'Corallo', asset: 'BTC', side: 'LONG', num: 8, look: 'antenna' }, { id: 'B4', name: 'Tempesta', asset: 'BTC', side: 'SHORT', num: 6, look: 'visor' },
      { id: 'B5', name: 'Marea', asset: 'ETH', side: 'LONG', num: 14, look: 'bun' }, { id: 'B6', name: 'Gelo', asset: 'ETH', side: 'SHORT', num: 1, look: 'horns' },
    ] },
};
for (const t of Object.values(TEAMS)) for (const p of t.players) p.role = `${ROLE[p.side]} ${p.asset} (${p.side === 'LONG' ? 'long ▲' : 'short ▼'})`;
const TEAM_IDS = ['A', 'B'];
const playerOf = (teamId, asset, side) => TEAMS[teamId].players.find((p) => p.asset === asset && p.side === side);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const TALK = {
  start: { A: ['Ragazzi, seguiamo il trend e niente follie: 7% a colpo!', 'Fulmini, si parte! Entriamo solo quando il mercato corre.'], B: ['Squali, pazienza: aspettiamo gli eccessi e colpiamo.', 'Calma e sangue freddo: il contropiede premia chi aspetta.'] },
  win: ['Grande giocata {p}! Così si fa!', 'Gol di {p}! Continuate così!', 'Bravo {p}, applausi!'],
  loss: ['Tranquillo {p}, lo stop ci ha protetti.', 'Rialziamoci, {p}: perdita piccola, testa alta.'],
  select: ['Due errori di fila: da ora entriamo solo con segnali più forti!', 'Più selettivi, ragazzi: niente tiri da lontano.'],
  timeout: ['TIME-OUT! Due minuti di pausa per ritrovare la calma.'],
  focus: ['Il Mentore dice che oggi {a} è il campo giusto: occhi su {a}!', 'Focus su {a}: le strategie studiate sono dalla nostra.'],
  mentor: ['Il Mentore ci avvisa: {e}. Attenzione!', 'Lezione del Mentore: {e}.'],
  lastMin: { lead: ['Ultimo minuto: difendiamo il vantaggio, niente regali!'], behind: ['Ultimo minuto: crediamoci, ma sempre con lo stop!'], tie: ['Ultimo minuto, è tutto aperto!'] },
  idle: { A: ['Aspettiamo che il trend parta, niente fretta.', 'Occhi aperti: appena il mercato corre, si entra.'], B: ['Lasciamoli esagerare, poi colpiamo.', 'Pazienza: l\'eccesso arriva sempre.'] },
};
const fill = (s, o) => s.replace(/\{(\w)\}/g, (_, k) => o[k] || '');

class MatchManager {
  constructor(engine, dataDir) {
    this.e = engine;
    this.hist = (dataDir && readJson(path.join(dataDir, 'matches.json'), null)) || { tally: { A: 0, B: 0, draws: 0 }, history: [] };
    this.writer = dataDir ? debounceWriter(path.join(dataDir, 'matches.json'), () => this.hist, 500) : { schedule() {}, flush() {} };
    this.firstTeam = 0;
  }
  get m() { return this.e.st.match || null; }
  live() { const m = this.m; return !!(m && m.state === 'live'); }
  // ---------- inizio
  start(now = Date.now()) {
    const e = this.e; const b = e.book;
    if (b.killed) throw new Error('Kill switch attivo: riarma il bot prima di una nuova partita');
    if (this.m && (this.m.state === 'live' || this.m.state === 'closing')) return this.m;
    const avail = Math.max(0, e.cash());
    const half = avail / 2;
    const teams = {};
    for (const id of TEAM_IDS) teams[id] = { bankroll: half, coach: { selectivity: 0, timeoutUntil: 0, focus: null, focusAt: 0, bonus: {}, wins: 0, losses: 0, talkAt: now, lastMin: false }, actions: [] };
    e.st.match = { id: uid(), state: 'live', mode: e.cfg.mode, startAt: now, endAt: now + MATCH_MS, teams, result: null, awaitingNew: false, number: (this.hist.history[0] ? this.hist.history[0].number || this.hist.history.length : this.hist.history.length) + 1 };
    e.save();
    const fm = (x) => e.fmtBase(x);
    e.log('PARTITA', `Calcio d'inizio! Partita n.${e.st.match.number} (${e.cfg.mode === 'SIM' ? 'SIMULAZIONE' : 'REALE'}) · 20 minuti · ${TEAMS.A.name} vs ${TEAMS.B.name} · cassa ${fm(half)} per squadra (metà del disponibile ciascuna)`);
    const block = e.entryBlock();
    if (block) e.log('PARTITA', `Partita REALE in attesa: ${block} Nessun ordine reale finché il test non è approvato.`, 'warn');
    e.emit('ev', { type: 'match', phase: 'start', id: e.st.match.id, endAt: e.st.match.endAt });
    for (const id of TEAM_IDS) this.talk(id, pick(TALK.start[id]), 'start', now);
    this.mentorBrief(now);
    return e.st.match;
  }
  // l'allenatore riferisce la lezione principale del MENTORE (errori più frequenti nel diario)
  mentorBrief(now) {
    try {
      const sm = this.e.mentor.summary(); const top = sm.errors[0];
      if (top) for (const id of TEAM_IDS) this.talk(id, fill(pick(TALK.mentor), { e: top.label.split(' (')[0].toLowerCase() }), 'mentor', now);
    } catch { /* il Mentore può non avere ancora dati */ }
  }
  talk(teamId, text, kind = 'talk', now = Date.now()) {
    const m = this.m; if (!m) return;
    const t = m.teams[teamId]; t.coach.talkAt = now; t.coach.lastTalk = { t: now, text, kind };
    t.actions.unshift({ t: now, kind, text }); if (t.actions.length > 12) t.actions.pop();
    this.e.emit('ev', { type: 'coach', team: teamId, coach: TEAMS[teamId].coach.id, kind, text });
    if (kind !== 'idle') this.e.log('PARTITA', `${TEAMS[teamId].coach.name} (${TEAMS[teamId].name}): «${text}»`);
  }
  // ---------- punteggio
  score(now = Date.now()) {
    const e = this.e; const m = this.m; if (!m) return null;
    const out = {};
    for (const id of TEAM_IDS) {
      const T = TEAMS[id]; const st = m.teams[id];
      const trades = e.book.trades.filter((x) => x.matchId === m.id && x.team === id);
      const open = e.book.positions.filter((p) => p.matchId === m.id && p.team === id);
      const realized = trades.reduce((a, x) => a + x.pnl, 0);
      const unreal = open.reduce((a, p) => a + (e.posValue(p) - p.costBase - p.feesBase + (p.realizedPart || 0)), 0);
      const players = T.players.map((pl) => {
        const tr = trades.filter((x) => x.player === pl.id); const op = open.filter((p) => p.player === pl.id);
        const pnl = tr.reduce((a, x) => a + x.pnl, 0) + op.reduce((a, p) => a + (e.posValue(p) - p.costBase - p.feesBase + (p.realizedPart || 0)), 0);
        return { id: pl.id, pnl, trades: tr.length + op.length, wins: tr.filter((x) => x.pnl >= 0).length, losses: tr.filter((x) => x.pnl < 0).length, holding: op.length > 0, bonus: st.coach.bonus[pl.id] || 0 };
      });
      const pnl = realized + unreal;
      out[id] = { pnl, pct: st.bankroll > 0 ? (pnl / st.bankroll) * 100 : 0, realized, unrealized: unreal, trades: trades.length + open.length, closed: trades.length, open: open.length,
        wins: trades.filter((x) => x.pnl >= 0).length, losses: trades.filter((x) => x.pnl < 0).length, players,
        capital: st.bankroll + realized, free: st.bankroll + realized - open.reduce((a, p) => a + p.costBase, 0) };
    }
    return out;
  }
  // ---------- giro dell'orologio (ogni secondo)
  async tick(now = Date.now()) {
    const m = this.m; if (!m) return;
    if (m.state === 'live') {
      if (now >= m.endAt) return this.end('Fine dei 20 minuti', now);
      this.coachTick(now);
    } else if (m.state === 'closing') {
      if (this.closing) return;
      await this.closeMatchPositions(now);
      if (!this.matchPositions().length || now - m.closingAt > CLOSE_GRACE_MS) this.finalize(now);
    }
  }
  matchPositions() { const m = this.m; return m ? this.e.book.positions.filter((p) => p.matchId === m.id) : []; }
  async closeMatchPositions() {
    this.closing = true;
    try { for (const p of this.matchPositions()) { if (p.closing) continue; try { await this.e.closePosition(p, 'Fine partita'); } catch (err) { this.e.log('PARTITA', `chiusura $${p.symbol} rinviata: ${err.message}`, 'warn'); } } }
    finally { this.closing = false; }
  }
  // fischio finale: si chiudono le posizioni della partita (simulate al prezzo di mercato; reali con la chiusura reale esistente)
  async end(reason = 'Fine dei 20 minuti', now = Date.now()) {
    const m = this.m; if (!m || m.state !== 'live') return;
    m.state = 'closing'; m.closingAt = now; m.endReason = reason; this.e.save();
    this.e.log('PARTITA', `Fischio finale (${reason}): chiudo le posizioni della partita`);
    this.e.emit('ev', { type: 'match', phase: 'whistle', id: m.id });
    await this.closeMatchPositions(now);
    if (!this.matchPositions().length) this.finalize(now);
  }
  finalize(now = Date.now()) {
    const e = this.e; const m = this.m; if (!m || m.state === 'ended') return;
    const sc = this.score(now);
    const a = sc.A.pnl, bb = sc.B.pnl; const eps = e.cfg.baseCurrency === 'SOL' ? 1e-6 : 0.005;
    const winner = Math.abs(a - bb) < eps ? null : a > bb ? 'A' : 'B';
    m.state = 'ended'; m.endedAt = now; m.awaitingNew = true;
    m.result = { winner, score: { A: { pnl: a, pct: sc.A.pct, trades: sc.A.trades }, B: { pnl: bb, pct: sc.B.pct, trades: sc.B.trades } }, mvp: this.mvp(sc), reason: m.endReason, stillOpen: this.matchPositions().length };
    if (winner) this.hist.tally[winner]++; else this.hist.tally.draws++;
    this.hist.history.unshift({ id: m.id, number: m.number, mode: m.mode, startAt: m.startAt, endAt: now, winner, score: m.result.score, mvp: m.result.mvp, reason: m.endReason });
    if (this.hist.history.length > 50) this.hist.history.pop();
    this.writer.schedule(); this.writer.flush();
    e.cfg.trading = false; e.saveCfg(); e.save();
    const fm = (x) => e.fmtBase(x);
    e.log('PARTITA', winner ? `VINCONO i ${TEAMS[winner].name}! ${TEAMS.A.name} ${a >= 0 ? '+' : ''}${fm(a)} · ${TEAMS.B.name} ${bb >= 0 ? '+' : ''}${fm(bb)}${m.result.mvp ? ` · migliore in campo ${m.result.mvp.name}` : ''}` : `PAREGGIO: ${fm(a)} a ${fm(bb)}`);
    e.emit('ev', { type: 'match', phase: 'end', id: m.id, winner, score: m.result.score, mvp: m.result.mvp });
    e.emit('ev', { type: 'trading', on: false });
  }
  mvp(sc) {
    let best = null;
    for (const id of TEAM_IDS) for (const p of sc[id].players) if (p.trades && (!best || p.pnl > best.pnl)) best = { ...p, team: id, name: TEAMS[id].players.find((x) => x.id === p.id).name };
    return best && best.pnl > 0 ? { id: best.id, team: best.team, name: best.name, pnl: best.pnl } : null;
  }
  dismiss() { const m = this.m; if (m && m.state === 'ended') { m.awaitingNew = false; this.e.save(); } }
  // ---------- allenatori
  coachTick(now) {
    const m = this.m; const sc = this.score(now);
    for (const id of TEAM_IDS) {
      const c = m.teams[id].coach;
      // focus: la cripto dove le strategie studiate dal MENTORE (stile della squadra) e le notizie sono più favorevoli
      if (now - (c.focusAt || 0) >= COACH.FOCUS_EVERY_MS) {
        c.focusAt = now; let best = null, bs = 0;
        for (const asset of ['SOL', 'BTC', 'ETH']) {
          let s = 0; for (const side of ['LONG', 'SHORT']) s += this.e.research.signalFor(asset, side, TEAMS[id].strategies).score;
          const nw = this.e.research.newsFor(asset); s += Math.abs(nw.sentiment) * 0.5 - nw.risk;
          if (s > bs) { bs = s; best = asset; }
        }
        if (best !== c.focus) { c.focus = best; if (best) this.talk(id, fill(pick(TALK.focus), { a: best }), 'focus', now); }
      }
      // ultimo minuto
      if (!c.lastMin && m.endAt - now <= 60e3) {
        c.lastMin = true; const other = id === 'A' ? 'B' : 'A'; const d = sc[id].pnl - sc[other].pnl;
        this.talk(id, pick(Math.abs(d) < 1e-9 ? TALK.lastMin.tie : d > 0 ? TALK.lastMin.lead : TALK.lastMin.behind), 'lastmin', now);
      } else if (now - c.talkAt >= COACH.TALK_EVERY_MS) this.talk(id, pick(TALK.idle[id]), 'idle', now);
    }
  }
  // trade chiuso di una squadra: l'allenatore reagisce (bonus limitato, selettività, time-out)
  onClose(tr, now = Date.now()) {
    const m = this.m; if (!m || tr.matchId !== m.id || !m.teams[tr.team]) return;
    const c = m.teams[tr.team].coach; const pl = TEAMS[tr.team].players.find((x) => x.id === tr.player); const name = pl ? pl.name : 'squadra';
    if (tr.pnl >= 0) {
      c.wins++; c.losses = 0;
      if (pl) c.bonus[pl.id] = Math.min(COACH.BONUS_MAX, (c.bonus[pl.id] || 0) + COACH.BONUS_STEP);
      if (c.selectivity > 0) c.selectivity--;
      this.talk(tr.team, fill(pick(TALK.win), { p: name }), 'win', now);
    } else {
      c.losses++; c.wins = 0; if (pl) c.bonus[pl.id] = 0;
      if (c.losses >= 3) { c.timeoutUntil = now + COACH.TIMEOUT_MS; c.losses = 0; this.talk(tr.team, pick(TALK.timeout), 'timeout', now); }
      else if (c.losses >= 2) { c.selectivity = Math.min(COACH.SEL_MAX, c.selectivity + 1); this.talk(tr.team, pick(TALK.select), 'select', now); }
      else this.talk(tr.team, fill(pick(TALK.loss), { p: name }), 'loss', now);
    }
    this.e.save();
  }
  // ---------- turno di gioco di una squadra (stesse fasi e limiti di rischio del banco)
  async teamTurn(teamId, now = Date.now()) {
    const prevCtx = this.e.actx; this.e.actx = { team: teamId };
    try { return await this.teamTurnInner(teamId, now); } finally { this.e.actx = prevCtx; }
  }
  async teamTurnInner(teamId, now) {
    const e = this.e; const cfg = e.cfg; const b = e.book; const m = this.m; const T = TEAMS[teamId]; const ts = m.teams[teamId]; const c = ts.coach;
    if (c.timeoutUntil > now) { e.agent('CAPO', `${T.name}: time-out dell'allenatore`, 'idle'); return null; }
    const sc = this.score(now)[teamId];
    const teamMax = Math.max(1, Math.ceil(cfg.maxOpen / 2));
    if (sc.open >= teamMax) { e.agent('CAPO', `${T.name}: già ${sc.open} posizioni (max ${teamMax} per squadra)`, 'idle'); return null; }
    e.agent('SCANSIONE', `${T.name}: scansione SOL, BTC, ETH (leva ${e.leverage()}x)`, 'scan');
    const cands = [];
    for (const asset of ['SOL', 'BTC', 'ETH']) {
      const mint = ASSET_MINT[asset]; const candles = e.market.candles[mint]; if (!candles) continue;
      const a = S.analyze(candles); const rev = T.style === 'contra' ? S.reversion(candles) : null;
      const st = e.market.stats[mint] || {}; const s = { ...st, symbol: asset };
      const f = st.buys1h != null ? S.flowScore(st) : { score: 0, ratio: 0, volAccel: 1, buys: 0, sells: 0 };
      for (const side of ['LONG', 'SHORT']) {
        if (side === 'LONG' && !cfg.perpLongs) continue;
        if (side === 'SHORT' && !cfg.shortsOn) continue;
        const pl = playerOf(teamId, asset, side);
        if (b.positions.some((p) => p.mint === mint && (p.team === teamId || (p.side === side || (!p.perp && side === 'LONG'))))) continue; // una posizione per cripto per squadra; mai due uguali (stesso conto on-chain)
        const cdKey = `${teamId}:${mint}:${side}`;
        if (b.cooldown[cdKey] && b.cooldown[cdKey] > now) continue;
        if (!a.ok) continue;
        const d = side === 'SHORT' ? -1 : 1;
        const sig = T.style === 'contra'
          ? rev[side]
          : side === 'SHORT' ? { signal: a.short.signal, conf: a.short.confidence, score: a.short.score, reason: a.short.reason, checks: a.short.checks } : { signal: a.signal === 'LONG', conf: a.confidence, score: a.score, reason: a.reason, checks: a.checks };
        const rs = e.research.signalFor(asset, side, T.strategies);
        const feat = [...K.featuresOf({ s, a, f, core: true, solMom60: e.solMom60(), side: side === 'SHORT' ? 'short' : 'long' }), `${side === 'SHORT' ? 'short.' : ''}leva:${e.leverage()}x`, ...rs.strategies.map((id) => (side === 'SHORT' ? 'short.' : '') + 'strat:' + id)];
        const kn = K.assess(e.kb, feat);
        const boost = (c.bonus[pl.id] || 0) + (c.focus === asset ? COACH.FOCUS_BONUS : 0); // spinta dell'allenatore (limitata)
        const flowW = T.style === 'contra' ? 0.3 : 1;
        const x = { m: mint, s, a, f, feat, kn, rs, side, sig, pl, boost, conf: sig.conf, total: sig.score + d * f.score * flowW + kn.adj + rs.score - rs.against + boost };
        e.mentorGate(x);
        if (rs.against >= 1 && rs.against > rs.score && !x.block) x.block = 'strategie contrarie';
        cands.push(x);
      }
    }
    if (!cands.length) { e.agent('CAPO', `${T.name}: nessun mercato libero (cooldown, posizioni o candele in caricamento)`, 'idle'); return null; }
    const libOk = (x) => x.rs.score >= 1 && x.rs.against < 1;
    const sigOk = (x) => x.sig.signal || libOk(x);
    const flowOk = (x) => (T.style === 'contra' ? (x.side === 'SHORT' ? x.f.score < 0.6 : x.f.score > -0.6) : x.side === 'SHORT' ? x.f.score < 0.2 : x.f.score > -0.2);
    const selOk = (x) => c.selectivity === 0 || (c.selectivity === 1 ? x.sig.conf >= 0.75 || libOk(x) : x.total >= 2 && (x.sig.conf >= 0.9 || libOk(x)));
    cands.sort((x, y) => y.total - x.total);
    const top = cands[0];
    e.agent('SOCIAL', `${T.name} · ${top.pl.name}: $${top.s.symbol} ${top.f.buys} acquisti / ${top.f.sells} vendite (1h)`, 'flow', { token: top.s.symbol, player: top.pl.id });
    const best = cands.find((x) => sigOk(x) && flowOk(x) && !x.kn.skip && !x.block && selOk(x));
    if (!best) {
      const blocked = cands.find((x) => x.block && sigOk(x));
      e.agent('CAPO', blocked ? `${T.name} · ${blocked.pl.name}: ${blocked.block}` : `${T.name}: nessun segnale (${top.pl.name} su $${top.s.symbol}: ${top.sig.reason || 'segnale debole'})`, 'idle', { token: top.s.symbol, player: top.pl.id });
      return null;
    }
    const prev = e.actx; e.actx = { team: teamId, player: best.pl.id };
    try {
      const passed = Object.values(best.sig.checks || {}).filter(Boolean).length;
      e.agent('CAPO', `${best.pl.name} (${T.name}) entra ${best.side === 'SHORT' ? 'SHORT ▼' : 'LONG ▲'} su $${best.s.symbol}: ${passed}/${Object.keys(best.sig.checks || {}).length} condizioni${best.boost ? ` · spinta allenatore +${best.boost.toFixed(2)}` : ''}${best.rs.strategies.length ? ' · strategie: ' + best.rs.strategies.join(', ') : ''}`, 'pick', { token: best.s.symbol, side: best.side });
      e.log('PARTITA', `${best.pl.name} (${T.name}, ${T.styleLabel}) sceglie $${best.s.symbol} ${best.side} · punteggio ${best.total.toFixed(2)} · fiducia ${(best.sig.conf * 100).toFixed(0)}%`);
      await sleep(250);
      const fromLib = !best.sig.signal;
      const pos = await e.enterTrade(best, { conf: best.sig.conf, fromLib, capital: sc.capital, cash: sc.free, team: teamId, player: best.pl.id });
      return (pos && pos.mint ? pos : null) || b.positions.find((p) => p.team === teamId && p.player === best.pl.id) || null;
    } finally { e.actx = prev; }
  }
  async turn(now = Date.now()) {
    const order = this.firstTeam ? ['B', 'A'] : ['A', 'B']; this.firstTeam ^= 1;
    for (const id of order) { if (!this.live()) break; await this.teamTurn(id, now); }
  }
  view(now = Date.now()) {
    const m = this.m; const sc = m ? this.score(now) : null;
    const teams = TEAM_IDS.map((id) => {
      const T = TEAMS[id]; const st = m && m.teams[id]; const s = sc && sc[id];
      return { id, name: T.name, short: T.short, style: T.style, styleLabel: T.styleLabel, color: T.color, color2: T.color2, motto: T.motto,
        bankroll: st ? st.bankroll : 0, pnl: s ? s.pnl : 0, pct: s ? s.pct : 0, trades: s ? s.trades : 0, wins: s ? s.wins : 0, losses: s ? s.losses : 0, open: s ? s.open : 0,
        coach: { ...T.coach, selectivity: st ? st.coach.selectivity : 0, timeoutUntil: st ? st.coach.timeoutUntil : 0, focus: st ? st.coach.focus : null, lastTalk: st ? st.coach.lastTalk || null : null },
        actions: st ? st.actions.slice(0, 6) : [],
        players: T.players.map((p) => { const ps = s ? s.players.find((x) => x.id === p.id) : null; return { ...p, pnl: ps ? ps.pnl : 0, trades: ps ? ps.trades : 0, wins: ps ? ps.wins : 0, losses: ps ? ps.losses : 0, holding: ps ? ps.holding : false, bonus: ps ? ps.bonus : 0 }; }) };
    });
    const block = this.e.entryBlock();
    return { id: m ? m.id : null, number: m ? m.number : null, state: m ? m.state : 'none', mode: m ? m.mode : this.e.cfg.mode, startAt: m ? m.startAt : null, endAt: m ? m.endAt : null, now, durationMs: MATCH_MS,
      remainingMs: m && m.state === 'live' ? Math.max(0, m.endAt - now) : 0, teams, result: m ? m.result : null, awaitingNew: !!(m && m.awaitingNew),
      realWaiting: block && (!m || m.mode === 'REAL' || this.e.cfg.mode === 'REAL') ? 'Partita REALE in attesa del test con 5-10 USDC: nessun ordine reale finché non approvi il test.' : null,
      tally: this.hist.tally, history: this.hist.history.slice(0, 5) };
  }
}
module.exports = { MatchManager, TEAMS, TEAM_IDS, MATCH_MS, COACH, playerOf };
