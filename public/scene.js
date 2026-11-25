/* STADIO: 14 bot in due squadre (6 giocatori + allenatore) si sfidano a chi fa più profitto in 20 minuti.
   Le animazioni seguono gli eventi reali del motore. Canvas 2D leggero (niente librerie), si ferma quando non è visibile
   e rispetta "Riduci movimento" di iPhone. */
(function () {
  'use strict';
  const W = 400, H = 330;
  const RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const AMP = RM ? 0.35 : 1;
  const ROWY = [98, 172, 246]; // una fila per ognuna delle (max) 3 cripto della squadra
  const XS = { A: { LONG: 160, SHORT: 98 }, B: { LONG: 240, SHORT: 302 } };
  const VAULT = { A: { x: 17, y: 172 }, B: { x: 383, y: 172 } };
  const ORB = { x: 200, y: 172 };
  const BENCH = { A: { x: 120, y: 314 }, B: { x: 280, y: 314 } };
  const colOf = (b) => b.coinColor || '#ffffff';
  // posto in campo: fila = cripto, colonna = attaccante (long) avanti, difensore (short) o scalper dietro; panchina per le riserve
  function homeOf(teamId, p, i) {
    if (p.slot == null || p.slot < 0 || !p.mint) { const B = BENCH[teamId]; return { x: B.x + (teamId === 'A' ? -1 : 1) * (22 + (i % 3) * 13), y: 312 + Math.floor(i / 3) * 4 }; }
    const back = p.side === 'SHORT' || p.lineRole === 'scalper';
    return { x: XS[teamId][back ? 'SHORT' : 'LONG'], y: ROWY[p.slot] || 172 };
  }
  const ACT_ICON = { scan: '🔍', pick: '⚡', block: '✋', flow: '📊', verify: '✔', idle: '…', size: '⚖', risk: '🛡', exec: '🚀', watch: '👀', kill: '⛔', teach: '📚', learn: '📚' };

  let cv, ctx, dpr = 1, scale = 1, ox = 0, oy = 0, cssW = 0, cssH = 0, bg = null;
  let t = 0, last = 0, running = true, visible = true, onTap = null;
  const bots = {}; const fx = []; const later = [];
  const st = { trading: false, mode: 'SIM', base: 'USDC', m: null, skew: 0, built: false, banner: null, finale: null, alarm: 0, crowd: { A: 0, B: 0 }, mentorT: 0, shake: 0, lastBeat: -1, lastTick: -1 };
  const after = (s, f) => later.push({ at: t + s, f });

  // ---------- squadre
  function build(m) {
    for (const T of m.teams) {
      const mk = (p, coach, i) => {
        const home = coach ? BENCH[T.id] : homeOf(T.id, p, i);
        bots[p.id] = { id: p.id, team: T.id, coach, name: p.name, num: p.num || 0, look: p.look, asset: p.asset, side: p.side, coinColor: p.coinColor, perp: p.perp, color: T.color, color2: T.color2,
          x: home.x, y: home.y, hx: home.x, hy: home.y, path: [], face: T.id === 'A' ? 1 : -1, phase: Math.random() * 6, walk: 0, moving: false,
          jz: 0, jv: 0, happyT: 0, sadT: 0, spinT: 0, emote: null, emoteT: 0, talk: null, talkT: 0, hold: null, blinkT: 2 + Math.random() * 3, shakeHand: 0, sit: 0 };
      };
      T.players.forEach((p, i) => mk(p, false, i));
      mk({ id: T.coach.id, name: T.coach.name, look: T.coach.look }, true, 0);
    }
    st.built = true;
  }
  const teamBots = (id) => Object.values(bots).filter((b) => b.team === id && !b.coach);
  const coachOf = (id) => Object.values(bots).find((b) => b.team === id && b.coach);
  function go(b, x, y, f) { b.path.push({ x, y, f }); }
  function home(b, f) { go(b, b.hx, b.hy, f); }
  function jump(b, h = 10) { if (b.jz > 0.5) return; b.jv = Math.sqrt(2 * 600 * h * AMP); }
  function happy(b, s = 2.2) { b.sadT = 0; b.happyT = Math.max(b.happyT, s); jump(b, 12); if (!RM) b.spinT = 0.6; after(0.5, () => jump(b, 8)); }
  function sad(b, s = 2.6) { b.happyT = 0; b.sadT = Math.max(b.sadT, s); }
  function emote(b, txt, s = 1.4) { b.emote = txt; b.emoteT = s; }
  function say(b, text, s = 5.5) { if (!b) return; b.talk = wrap(text, 118, 3); b.talkT = s; }
  function banner(txt, sub, col = '#fff', d = 2.6) { st.banner = { txt, sub, col, t: 0, d }; }

  // ---------- effetti
  const MAXFX = RM ? 60 : 260;
  function addFx(f) { if (fx.length < MAXFX) fx.push(f); }
  function coins(from, to, n, col, delay = 0) { n = RM ? Math.min(2, n) : n; for (let i = 0; i < n; i++) addFx({ k: 'coin', x0: from.x, y0: from.y, x1: to.x + (Math.random() - 0.5) * 8, y1: to.y + (Math.random() - 0.5) * 6, t: -delay - i * 0.07, d: 0.75, color: col, arc: 26 + Math.random() * 22 }); }
  function floatTxt(x, y, txt, col, d = 1.8) { addFx({ k: 'txt', x, y, txt, color: col, t: 0, d }); }
  function burst(x, y, col, n = 14) { if (RM) n = 4; for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, v = 40 + Math.random() * 80; addFx({ k: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: col, t: 0, d: 0.7 + Math.random() * 0.6 }); } }
  function confetti(cols, n, x0 = 0, x1 = W) { if (RM) n = Math.min(n, 6); for (let i = 0; i < n; i++) addFx({ k: 'conf', x: x0 + Math.random() * (x1 - x0), y: -10 - Math.random() * 40, vx: (Math.random() - 0.5) * 30, vy: 40 + Math.random() * 50, r: Math.random() * 6, vr: (Math.random() - 0.5) * 10, color: cols[i % cols.length], t: 0, d: 4 + Math.random() * 2 }); }
  function firework(x, y, cols) { addFx({ k: 'rocket', x, y0: H, y1: y, t: 0, d: 0.55, color: cols[0], cols }); }
  const money = (v, sign = true) => { const d = st.base === 'SOL' ? 4 : 2; const s = Math.abs(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }); return (sign ? (v >= 0 ? '+' : '−') : '') + s + (st.base === 'SOL' ? ' ◎' : ' $'); };

  // ---------- eventi dal motore
  function onEvent(e) {
    if (!e || !st.built) return;
    if (e.type === 'match') {
      if (e.phase === 'start') kickoff();
      else if (e.phase === 'whistle') { banner('FISCHIO FINALE', 'chiudo le posizioni della partita', '#FFD54A'); Object.values(bots).forEach((b) => { if (!b.coach) emote(b, '🏁', 2); }); }
      else if (e.phase === 'end') finale(e.winner, e.mvp, false);
      return;
    }
    if (e.type === 'coach') {
      const c = coachOf(e.team); if (!c) return; say(c, e.text); c.gest = 1.6;
      if (e.kind === 'win') jump(c, 8);
      if (e.kind === 'timeout') { banner('TIME-OUT', c.name, '#FFB020', 2); teamBots(e.team).forEach((b) => { b.sit = 2.2; emote(b, '⏸', 2); }); }
      if (e.kind === 'focus') teamBots(e.team).filter((b) => b.asset && b.asset.replace(/\W/g, '') && new RegExp(`\\b${b.asset.replace(/\W/g, '')}\\b`).test(e.text)).forEach((b) => { emote(b, '🎯', 2); b.glowT = 2.4; });
      if (e.kind === 'coins') teamBots(e.team).forEach((b, i) => after(i * 0.08, () => jump(b, 6)));
      if (e.kind === 'select') teamBots(e.team).forEach((b) => emote(b, '🧐', 1.6));
      if (e.kind === 'mentor') st.mentorT = 2.4;
      return;
    }
    if (e.type === 'agent' && e.agent === 'MENTORE') { st.mentorT = 2.2; return; }
    if (e.type === 'agent' && e.player && bots[e.player]) {
      const b = bots[e.player];
      if (e.action === 'pick') { emote(b, '⚡', 1.6); jump(b, 6); } else if (e.action === 'block') emote(b, '✋', 1.4); else if (ACT_ICON[e.action] && !b.emote) emote(b, ACT_ICON[e.action], 1);
      return;
    }
    if (e.type === 'trading') { st.trading = !!e.on; return; }
    if (e.type === 'trade' && e.team && e.player && bots[e.player]) {
      const b = bots[e.player]; const V = VAULT[e.team]; const amt = Number(e.amount) || 0;
      if (e.side === 'BUY' || e.side === 'SHORT') {
        // il giocatore corre al centro (la borsa): le monete escono dalla cassa di squadra
        b.path = []; emote(b, e.side === 'SHORT' ? '▼' : '▲', 1.6);
        go(b, ORB.x + (e.team === 'A' ? -16 : 16), ORB.y + (b.hy - ORB.y) * 0.25, () => { st.orbT = 1.2; burst(ORB.x, ORB.y, colOf(b), 10); home(b); });
        coins(V, ORB, 6, '#FFD54A'); floatTxt(V.x + (e.team === 'A' ? 22 : -22), V.y - 16, '−' + money(amt, false), '#ff6b7a'); st.vaultT = st.vaultT || {}; st.vaultT[e.team] = 1;
      } else if (e.side === 'SELL' || e.side === 'PARTIAL') {
        const win = (e.pnl || 0) >= 0; const partial = e.side === 'PARTIAL';
        coins(ORB, V, win ? (partial ? 4 : 8) : 3, win ? '#FFD54A' : '#b9a46a', 0.1);
        floatTxt(b.x, b.y - 34, money(e.pnl || 0) + (partial ? ' parziale' : ''), win ? '#3dffa0' : '#ff6b7a', 2.2);
        after(0.9, () => floatTxt(V.x + (e.team === 'A' ? 26 : -26), V.y - 16, '+' + money(amt, false), '#ffe27a'));
        if (partial) { emote(b, '💰', 1.6); jump(b, 6); return; }
        if (win) { happy(b); burst(b.x, b.y - 20, b.color2, 16); teamBots(e.team).forEach((o, i) => o !== b && after(0.15 + i * 0.08, () => jump(o, 7))); st.crowd[e.team] = 2.5; const c = coachOf(e.team); if (c) { c.gest = 1.4; jump(c, 6); } }
        else { sad(b); emote(b, '💧', 1.8); const c = coachOf(e.team); if (c) c.gest = 1; }
      }
      return;
    }
    if (e.type === 'log' && e.level === 'error' && /KILL SWITCH/.test(e.text || '')) st.alarm = 3;
  }
  function kickoff() {
    clearFinale();
    banner("CALCIO D'INIZIO!", '20 minuti · vince chi fa più profitto', '#fff', 2.8);
    Object.values(bots).forEach((b, i) => {
      if (b.coach) { b.x = b.hx; b.y = b.hy; jump(b, 8); return; }
      b.x = BENCH[b.team].x + (Math.random() - 0.5) * 30; b.y = 318; b.path = []; b.happyT = 0; b.sadT = 0;
      after(0.1 + (i % 7) * 0.12, () => { home(b, () => jump(b, 6)); });
    });
    burst(ORB.x, ORB.y, '#fff', 20);
  }
  function finale(winner, mvp, quiet) {
    st.finale = { winner, mvp, t: quiet ? 20 : 0, quiet };
    if (!winner) {
      banner('PAREGGIO!', 'stretta di mano tra gli allenatori', '#fff', 3.5);
      const a = coachOf('A'), b = coachOf('B');
      if (a && b) { a.path = []; b.path = []; go(a, 191, 312, () => { a.shakeHand = 3; }); go(b, 209, 312, () => { b.shakeHand = 3; }); after(4.5, () => { home(a); home(b); }); }
      Object.values(bots).forEach((x) => !x.coach && emote(x, '🤝', 2.5));
      return;
    }
    const loser = winner === 'A' ? 'B' : 'A'; const T = teamBots(winner)[0];
    banner(`VINCONO I ${(T ? (winner === 'A' ? 'FULMINI ROSSI' : 'SQUALI BLU') : '')}!`, mvp ? `migliore in campo: ${mvp.name}` : 'fischio finale', T ? T.color2 : '#fff', 4);
    teamBots(winner).forEach((b, i) => after(i * 0.1, () => happy(b, 6)));
    teamBots(loser).forEach((b) => sad(b, 8));
    const c = coachOf(winner); if (c) { say(c, 'Campioni! Che partita, ragazzi!', 5); happy(c, 4); }
    const l = coachOf(loser); if (l) say(l, 'Complimenti agli avversari. La prossima è nostra!', 5);
  }
  function clearFinale() { st.finale = null; Object.values(bots).forEach((b) => { b.happyT = 0; b.sadT = 0; }); }

  // ---------- API
  const Scene = {
    init(canvas, cb) {
      cv = canvas; ctx = cv.getContext('2d'); onTap = cb;
      resize(); window.addEventListener('resize', resize);
      if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(cv.parentElement);
      if (window.IntersectionObserver) new IntersectionObserver((en) => { const v = en[0].isIntersecting; if (v && !visible) { visible = true; wake(); } visible = v; }).observe(cv);
      cv.addEventListener('pointerdown', tap);
      document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) wake(); });
      wake();
    },
    setState(s) {
      st.trading = s.trading; st.mode = s.mode; st.base = s.base || 'USDC'; if (s.killed) st.alarm = Math.max(st.alarm, 0.6);
      const m = s.match; if (!m || !m.teams) return;
      if (!st.built) build(m);
      st.m = m; st.skew = (m.now || Date.now()) - Date.now();
      const pos = s.positions || [];
      Object.values(bots).forEach((b) => { if (b.coach) return; const p = pos.find((x) => x.player === b.id && x.team === b.team); b.hold = p ? { pct: p.pnlPct, side: p.side, lev: p.lev } : null; });
      const T = Object.fromEntries(m.teams.map((x) => [x.id, x])); st.teams = T;
      // formazione dinamica: se l'allenatore cambia cripto i giocatori corrono al nuovo posto
      for (const team of m.teams) team.players.forEach((p, i) => {
        const b = bots[p.id]; if (!b) return; b.asset = p.asset; b.side = p.side; b.coinColor = p.coinColor; b.perp = p.perp; b.lineRole = p.lineRole;
        const h = homeOf(team.id, p, i); if (Math.abs(h.x - b.hx) > 0.5 || Math.abs(h.y - b.hy) > 0.5) { b.hx = h.x; b.hy = h.y; if (!b.hold) { b.path = []; home(b); } }
      });
      if (st.finale && (m.state === 'live' || !m.awaitingNew)) clearFinale();
      if (!st.finale && m.state === 'ended' && m.awaitingNew && m.result) finale(m.result.winner, m.result.mvp, true);
    },
    setScreen() {},
    event: onEvent,
    botPos(id) { const b = bots[id]; return b ? toScreen(b.x, b.y - 30) : null; },
  };
  window.Scene = Scene;
  function wake() { if (!running || !visible) return; last = performance.now(); if (!st.loop) { st.loop = true; requestAnimationFrame(loop); } }

  function resize() {
    if (!cv) return; const r = cv.parentElement.getBoundingClientRect(); if (!r.width) return;
    if (Math.abs(r.width - cssW) < 0.5 && cv.width) return;
    cssW = r.width; cssH = Math.max(270, Math.min(480, cssW * 0.83));
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.style.height = cssH + 'px'; cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    scale = Math.min(cssW / W, cssH / H); ox = (cssW - W * scale) / 2; oy = (cssH - H * scale) / 2;
    bg = null;
  }
  const toScreen = (x, y) => ({ x: ox + x * scale, y: oy + y * scale });
  function tap(e) {
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left - ox) / scale, y = (e.clientY - r.top - oy) / scale;
    let best = null, bd = 26;
    for (const b of Object.values(bots)) { const d = Math.hypot(b.x - x, b.y - 8 - y); if (d < bd) { bd = d; best = b; } }
    if (onTap) { if (best) { const p = toScreen(best.x, best.y - 30); onTap(best.id, p.x, p.y); } else onTap(null); }
    if (best) { jump(best, 8); emote(best, best.coach ? '📋' : '👋', 1.2); }
  }

  // ---------- tempo partita
  function remaining() { const m = st.m; if (!m || m.state !== 'live') return null; return Math.max(0, m.endAt - (Date.now() + st.skew)); }

  // ---------- aggiornamento
  function update(dt) {
    t += dt;
    for (let i = later.length - 1; i >= 0; i--) if (later[i].at <= t) { const f = later[i].f; later.splice(i, 1); f(); }
    const rem = remaining(); const tense = rem != null && rem < 60e3;
    if (tense && !RM) { const beat = Math.floor(rem / 1000); if (beat !== st.lastBeat) { st.lastBeat = beat; st.shake = rem < 10e3 ? 0.35 : 0.18; } }
    st.shake = Math.max(0, st.shake - dt);
    for (const b of Object.values(bots)) {
      if (b.path.length) {
        const p = b.path[0]; const dx = p.x - b.x, dy = p.y - b.y; const d = Math.hypot(dx, dy); const sp = (RM ? 160 : 95) * (tense ? 1.25 : 1);
        if (d < 1.5) { b.x = p.x; b.y = p.y; b.path.shift(); p.f && p.f(); } else { const k = Math.min(1, (sp * dt) / d); b.x += dx * k; b.y += dy * k; if (Math.abs(dx) > 0.5) b.face = dx > 0 ? 1 : -1; b.walk += dt * 14; }
        b.moving = true;
      } else { b.moving = false; b.face = b.coach ? (b.team === 'A' ? 1 : -1) : b.team === 'A' ? 1 : -1; if (!b.coach && !RM && b.hold == null && Math.random() < dt * 0.03 && !st.finale) { go(b, b.hx + (Math.random() - 0.5) * 22, b.hy + (Math.random() - 0.5) * 16); home(b); } }
      if (b.jz > 0 || b.jv) { b.jv -= 600 * dt; b.jz += b.jv * dt; if (b.jz <= 0) { b.jz = 0; b.jv = 0; } }
      b.happyT = Math.max(0, b.happyT - dt); b.sadT = Math.max(0, b.sadT - dt); b.spinT = Math.max(0, b.spinT - dt); b.emoteT = Math.max(0, b.emoteT - dt); if (!b.emoteT) b.emote = null;
      b.talkT = Math.max(0, b.talkT - dt); b.gest = Math.max(0, (b.gest || 0) - dt); b.shakeHand = Math.max(0, b.shakeHand - dt); b.sit = Math.max(0, b.sit - dt); b.glowT = Math.max(0, (b.glowT || 0) - dt);
      b.blinkT -= dt; if (b.blinkT < -0.12) b.blinkT = 2 + Math.random() * 3;
      if (st.finale && st.finale.winner === b.team && b.happyT < 0.3) happy(b, 2); // festa continua
    }
    for (const k of ['A', 'B']) st.crowd[k] = Math.max(0, st.crowd[k] - dt);
    st.mentorT = Math.max(0, st.mentorT - dt); st.orbT = Math.max(0, (st.orbT || 0) - dt); st.alarm = Math.max(0, st.alarm - dt);
    if (st.vaultT) for (const k in st.vaultT) st.vaultT[k] = Math.max(0, st.vaultT[k] - dt);
    if (st.banner) { st.banner.t += dt; if (st.banner.t > st.banner.d) st.banner = null; }
    // festa finale: coriandoli e fuochi d'artificio per chi vince
    const F = st.finale;
    if (F) {
      F.t += dt;
      if (F.winner) {
        const W0 = F.winner === 'A' ? 0 : W / 2; const cols = F.winner === 'A' ? ['#FF4D5E', '#FFB020', '#fff'] : ['#3BA4FF', '#00E5C7', '#fff'];
        const heavy = F.t < 12 && !F.quiet;
        if (Math.random() < dt * (heavy ? 18 : 3)) confetti(cols, heavy ? 3 : 1, W0, W0 + W / 2);
        if (!RM && heavy && Math.random() < dt * 1.6) firework(W0 + 40 + Math.random() * 120, 60 + Math.random() * 70, cols);
      }
    }
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i]; f.t += dt; if (f.t < 0) continue;
      if (f.k === 'spark') { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 140 * dt; f.vx *= 0.98; }
      if (f.k === 'conf') { f.x += (f.vx + Math.sin(t * 3 + f.r) * 14) * dt; f.y += f.vy * dt; f.r += f.vr * dt; }
      if (f.k === 'rocket' && f.t >= f.d) { const n = 26; for (let j = 0; j < n; j++) { const a = (j / n) * 6.28, v = 60 + Math.random() * 40; addFx({ k: 'spark', x: f.x, y: f.y1, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: f.cols[j % f.cols.length], t: 0, d: 1.1 + Math.random() * 0.5 }); } }
      if (f.t >= f.d) fx.splice(i, 1);
    }
  }

  // ---------- disegno di base
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function text(s, x, y, size, col, align = 'center', weight = '700') { ctx.font = `${weight} ${size}px Inter,-apple-system,Segoe UI,Roboto,sans-serif`; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y); }
  function wrap(s, maxW, maxL) {
    if (!ctx) return [s]; ctx.font = '700 7px Inter,-apple-system,Segoe UI,sans-serif';
    const words = String(s).split(/\s+/); const lines = []; let cur = '';
    for (const w of words) { const n = cur ? cur + ' ' + w : w; if (ctx.measureText(n).width > maxW && cur) { lines.push(cur); cur = w; } else cur = n; }
    if (cur) lines.push(cur);
    if (lines.length > maxL) { lines.length = maxL; lines[maxL - 1] = lines[maxL - 1].replace(/\s*\S*$/, '') + '…'; }
    return lines;
  }
  // sfondo (campo e tribune) disegnato una volta sola
  function paintBg() {
    bg = document.createElement('canvas'); bg.width = cv.width; bg.height = cv.height; const g = bg.getContext('2d'); const c0 = ctx; ctx = g;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#06100b'; ctx.fillRect(0, 0, cssW, cssH);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    // tribune
    const gr = ctx.createLinearGradient(0, 0, 0, 46); gr.addColorStop(0, '#0b0f1a'); gr.addColorStop(1, '#141b2b'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, 46);
    // prato a strisce
    for (let i = 0; i < 10; i++) { ctx.fillStyle = i % 2 ? '#0f3d22' : '#124a29'; ctx.fillRect(i * 40, 46, 40, 254); }
    const vg = ctx.createRadialGradient(200, 172, 40, 200, 172, 260); vg.addColorStop(0, 'rgba(255,255,255,0.05)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)'); ctx.fillStyle = vg; ctx.fillRect(0, 46, W, 254);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2;
    ctx.strokeRect(6, 52, W - 12, 242); ctx.beginPath(); ctx.moveTo(200, 52); ctx.lineTo(200, 294); ctx.stroke();
    ctx.beginPath(); ctx.arc(200, 172, 34, 0, 6.28); ctx.stroke();
    ctx.strokeRect(6, 122, 40, 100); ctx.strokeRect(W - 46, 122, 40, 100);
    ctx.beginPath(); ctx.arc(46, 172, 16, -1.2, 1.2); ctx.stroke(); ctx.beginPath(); ctx.arc(W - 46, 172, 16, Math.PI - 1.2, Math.PI + 1.2); ctx.stroke();
    // panchina
    ctx.fillStyle = '#0a1a12'; ctx.fillRect(0, 300, W, 30); ctx.fillStyle = '#ffffff14'; ctx.fillRect(84, 322, 72, 5); ctx.fillRect(244, 322, 72, 5);
    ctx = c0;
  }
  function drawCrowd() {
    // tifosi: puntini nei colori delle squadre che saltano quando la loro squadra incassa
    for (let i = 0; i < 46; i++) {
      const side = i < 23 ? 'A' : 'B'; const k = i % 23; const x = side === 'A' ? 6 + (k % 12) * 9.5 + (k >= 12 ? 4.5 : 0) : 286 + (k % 12) * 9.5 + (k >= 12 ? 4.5 : 0); const row = k >= 12 ? 1 : 0;
      const T = st.teams && st.teams[side]; const col = T ? (i % 3 ? T.color : T.color2) : '#556';
      const hop = st.crowd[side] > 0 ? Math.abs(Math.sin(t * 9 + i)) * 4 * AMP : (st.finale && st.finale.winner === side ? Math.abs(Math.sin(t * 7 + i)) * 3 * AMP : Math.sin(t * 1.5 + i) * 0.4 * AMP);
      const y = 16 + row * 13 - hop; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.28); ctx.fill(); ctx.fillRect(x - 3, y + 2.5, 6, 5);
      if (st.crowd[side] > 0 && i % 4 === 0) { ctx.fillRect(x - 0.5, y - 9, 1, 7); ctx.fillStyle = T ? T.color2 : '#fff'; ctx.fillRect(x, y - 9, 6, 4); }
    }
  }
  function drawBoard() {
    // tabellone luminoso: punteggio $ delle due squadre e cronometro
    const m = st.m; const T = st.teams; const rem = remaining();
    ctx.fillStyle = '#05070d'; ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1; rr(120, 4, 160, 38, 6); ctx.fill(); ctx.stroke();
    if (!T) { text('STADIO GROKBOT', 200, 23, 9, '#9fb0d0', 'center', '900'); return; }
    const A = T.A, B = T.B;
    text(A.short, 136, 13, 7.5, A.color, 'center', '900'); text(B.short, 264, 13, 7.5, B.color, 'center', '900');
    text(money(A.pnl), 136, 27, 6.8, A.pnl >= 0 ? '#3dffa0' : '#ff6b7a', 'center', '800'); text(money(B.pnl), 264, 27, 6.8, B.pnl >= 0 ? '#3dffa0' : '#ff6b7a', 'center', '800');
    text((A.pct >= 0 ? '+' : '') + A.pct.toFixed(2) + '%', 136, 36, 5.5, '#9fb0d0'); text((B.pct >= 0 ? '+' : '') + B.pct.toFixed(2) + '%', 264, 36, 5.5, '#9fb0d0');
    let clock = '20:00', col = '#fff', sz = 13;
    if (m && m.state === 'live' && rem != null) {
      const s = Math.ceil(rem / 1000); clock = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      if (rem < 60e3) { const p = 0.5 + 0.5 * Math.sin(t * (rem < 10e3 ? 16 : 8)); col = `rgb(255,${Math.round(60 + 120 * (1 - p))},${Math.round(70 + 60 * (1 - p))})`; sz = 13 + (RM ? 0 : p * 1.6); }
    } else if (m && m.state === 'closing') { clock = 'FINE'; col = '#FFD54A'; } else if (m && m.state === 'ended') { clock = 'FINALE'; col = '#FFD54A'; sz = 10; } else { clock = '20:00'; col = '#9fb0d0'; }
    text(clock, 200, 20, sz, col, 'center', '900');
    const prog = m && m.state === 'live' && rem != null ? 1 - rem / (m.durationMs || 1200e3) : m && m.state !== 'none' ? 1 : 0;
    ctx.fillStyle = '#1b2236'; rr(176, 32, 48, 3, 1.5); ctx.fill(); ctx.fillStyle = rem != null && rem < 60e3 ? '#ff4d5e' : '#FFD54A'; rr(176, 32, Math.max(2, 48 * prog), 3, 1.5); ctx.fill();
    if (st.mode === 'REAL') text('REALE', 200, 39.5, 4.5, '#ff9aa5', 'center', '900');
  }
  function drawCoinRows() {
    // le (max) 3 cripto di ogni squadra: nome, colore e "5x · L/S" o "Spot · Long"
    if (!st.teams) return;
    for (const id of ['A', 'B']) {
      const T = st.teams[id]; if (!T || !T.coins) continue; const x = id === 'A' ? 129 : 271;
      T.coins.forEach((c, i) => {
        const y = ROWY[i] - 35; const lbl = `${c.symbol} · ${c.perp ? c.label.replace(' · ', ' ') : 'spot'}`;
        ctx.font = '800 5.6px Inter,-apple-system,sans-serif'; const w = ctx.measureText(lbl).width + 12;
        ctx.fillStyle = 'rgba(0,0,0,0.38)'; rr(x - w / 2, y - 4.5, w, 9, 4); ctx.fill();
        ctx.fillStyle = c.color || '#fff'; ctx.beginPath(); ctx.arc(x - w / 2 + 5, y, 2.2, 0, 6.28); ctx.fill();
        text(lbl, x + 3, y + 0.2, 5.6, '#ffffffdd', 'center', '800');
      });
    }
  }
  function drawVault(id) {
    const V = VAULT[id]; const T = st.teams && st.teams[id]; const col = T ? T.color : '#888'; const g = (st.vaultT && st.vaultT[id]) || 0;
    ctx.save(); ctx.fillStyle = '#ffffff22'; ctx.fillRect(id === 'A' ? 2 : W - 12, 146, 10, 52);
    ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 1.5; ctx.strokeRect(id === 'A' ? 2 : W - 12, 146, 10, 52);
    // forziere della squadra
    ctx.translate(V.x + (id === 'A' ? 4 : -4), V.y); const sh = g > 0 && !RM ? Math.sin(t * 40) * g * 1.5 : 0; ctx.translate(sh, 0);
    ctx.fillStyle = '#3a2a0c'; rr(-9, -6, 18, 13, 2); ctx.fill(); ctx.fillStyle = col; ctx.fillRect(-9, -2, 18, 2.4);
    ctx.fillStyle = '#FFD54A'; ctx.beginPath(); ctx.arc(0, 1, 1.8, 0, 6.28); ctx.fill();
    ctx.restore();
    if (T) text(money(T.bankroll + T.pnl, false), V.x + (id === 'A' ? 6 : -6), V.y + 34, 5.2, '#ffe27a', 'center', '800');
  }
  function drawOrb() {
    // la "borsa" al centro: dove i giocatori aprono e chiudono le operazioni
    const k = st.orbT || 0; const r = 9 + Math.sin(t * 2) * 0.6 * AMP + k * 3;
    ctx.save(); ctx.shadowColor = '#7CF9D0'; ctx.shadowBlur = 8 + k * 14;
    const g = ctx.createRadialGradient(ORB.x - 3, ORB.y - 3, 1, ORB.x, ORB.y, r); g.addColorStop(0, '#e6fff7'); g.addColorStop(0.5, '#38d9a9'); g.addColorStop(1, '#0b5e4a');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ORB.x, ORB.y, r, 0, 6.28); ctx.fill(); ctx.restore();
    if (!RM) { ctx.strokeStyle = '#7CF9D088'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.ellipse(ORB.x, ORB.y, r + 5, (r + 5) * 0.35, t * 0.8, 0, 6.28); ctx.stroke(); }
    text('BORSA', ORB.x, ORB.y + r + 7, 5, '#bff5e4', 'center', '900');
  }
  function drawMentor() {
    // il MENTORE (in tribuna) manda le lezioni agli allenatori
    const x = 200, y = 52; const k = st.mentorT;
    ctx.save(); ctx.globalAlpha = 0.55 + 0.45 * Math.min(1, k); ctx.fillStyle = '#FDE68A'; ctx.beginPath(); ctx.arc(x, y - 1, 3, 0, 6.28); ctx.fill(); ctx.restore();
    if (k > 0) for (const id of ['A', 'B']) {
      const c = coachOf(id); if (!c) continue; const p = 1 - (k % 1.1) / 1.1;
      const bx = x + (c.x - x) * p, by = y + (c.y - 20 - y) * p - Math.sin(p * 3.14) * 30;
      ctx.save(); ctx.shadowColor = '#FDE68A'; ctx.shadowBlur = 10; ctx.fillStyle = '#FFF7C2'; ctx.beginPath(); ctx.arc(bx, by, 2.2, 0, 6.28); ctx.fill(); ctx.restore();
    }
  }
  function drawLook(b, hy) {
    const c2 = b.color2; ctx.fillStyle = c2; ctx.strokeStyle = c2; ctx.lineWidth = 1;
    switch (b.look) {
      case 'antenna': ctx.beginPath(); ctx.moveTo(0, hy - 6); ctx.lineTo(0, hy - 11); ctx.stroke(); ctx.beginPath(); ctx.arc(0, hy - 12, 1.6 + Math.sin(t * 6 + b.phase) * 0.4, 0, 6.28); ctx.fill(); break;
      case 'horns': ctx.beginPath(); ctx.moveTo(-5, hy - 4); ctx.lineTo(-7, hy - 10); ctx.lineTo(-2.5, hy - 6); ctx.fill(); ctx.beginPath(); ctx.moveTo(5, hy - 4); ctx.lineTo(7, hy - 10); ctx.lineTo(2.5, hy - 6); ctx.fill(); break;
      case 'mohawk': for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(i * 1.8 - 1, hy - 6); ctx.lineTo(i * 1.8, hy - 10 - (2 - Math.abs(i)) * 1.2); ctx.lineTo(i * 1.8 + 1, hy - 6); ctx.fill(); } break;
      case 'visor': ctx.fillRect(-6.5, hy - 5, 13, 1.8); ctx.fillRect(b.face > 0 ? 2 : -9, hy - 4.5, 7, 1.2); break;
      case 'fins': ctx.beginPath(); ctx.moveTo(-6, hy); ctx.lineTo(-10, hy - 4); ctx.lineTo(-6, hy - 3); ctx.fill(); ctx.beginPath(); ctx.moveTo(6, hy); ctx.lineTo(10, hy - 4); ctx.lineTo(6, hy - 3); ctx.fill(); break;
      case 'band': ctx.fillRect(-6.4, hy - 3.6, 12.8, 1.8); ctx.fillRect(-b.face * 6.4 - 1, hy - 3, 1.5, 4 + Math.sin(t * 5) * AMP); break;
      case 'fin': ctx.beginPath(); ctx.moveTo(-3, hy - 6); ctx.quadraticCurveTo(1, hy - 15, 4, hy - 6); ctx.fill(); break;
      case 'goggles': ctx.strokeStyle = c2; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(-2.6, hy - 5, 1.8, 0, 6.28); ctx.arc(2.6, hy - 5, 1.8, 0, 6.28); ctx.stroke(); break;
      case 'bun': ctx.beginPath(); ctx.arc(0, hy - 7.5, 2.4, 0, 6.28); ctx.fill(); break;
      case 'cap': ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(0, hy - 2, 6.6, 3.14, 0); ctx.fill(); ctx.fillRect(b.face > 0 ? 0 : -9, hy - 2.6, 9, 1.8); break;
      case 'beanie': ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(0, hy - 2, 6.6, 3.14, 0); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, hy - 9, 1.8, 0, 6.28); ctx.fill(); break;
    }
  }
  function drawBot(b) {
    const happyNow = b.happyT > 0, sadNow = b.sadT > 0; const tense = remaining() != null && remaining() < 60e3 && !b.coach;
    const bob = b.moving ? Math.abs(Math.sin(b.walk)) * 1.6 * AMP : Math.sin(t * 2.2 + b.phase) * 0.6 * AMP;
    const x = b.x, y = b.y - b.jz - bob + (b.sit > 0 ? 3 : 0);
    ctx.fillStyle = 'rgba(0,0,0,0.32)'; ctx.beginPath(); ctx.ellipse(b.x, b.y + 10, 7 - Math.min(3, b.jz / 6), 2.2, 0, 0, 6.28); ctx.fill();
    if (b.glowT > 0) { ctx.strokeStyle = b.color2; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 8); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(b.x, b.y + 10, 11, 4, 0, 0, 6.28); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.save(); ctx.translate(x, y);
    if (b.spinT > 0) ctx.scale(Math.cos((1 - b.spinT / 0.6) * 6.28), 1); else ctx.scale(b.face, 1);
    if (sadNow) ctx.rotate(0.08);
    // gambe
    const lg = b.moving ? Math.sin(b.walk) * 2.4 * AMP : 0;
    ctx.fillStyle = '#d7dde5'; ctx.fillRect(-4 + lg * 0.5, 5, 2.6, 5); ctx.fillRect(1.4 - lg * 0.5, 5, 2.6, 5);
    ctx.fillStyle = '#111'; ctx.fillRect(-4.6 + lg * 0.5, 9.4, 3.4, 1.8); ctx.fillRect(1 - lg * 0.5, 9.4, 3.4, 1.8);
    // maglia
    const kit = b.coach ? '#1d2433' : b.color;
    ctx.fillStyle = kit; rr(-7, -5, 14, 11, 4); ctx.fill();
    ctx.fillStyle = b.color2; if (b.coach) { ctx.fillRect(-7, -1, 14, 1.4); } else if (b.team === 'A') { ctx.fillRect(-1.5, -5, 3, 11); } else { ctx.fillRect(-7, -1, 14, 2); }
    if (!b.coach) { ctx.save(); ctx.scale(b.face, 1); text(String(b.num), 0, 1.5, 5.5, '#fff', 'center', '900'); ctx.restore(); }
    // braccia
    ctx.strokeStyle = '#d7dde5'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
    const up = happyNow ? 1 : 0; const wv = Math.sin(t * 14) * 2 * AMP;
    let la = [-9, 5], ra = [9, 5];
    if (up) { la = [-10, -9 + wv]; ra = [10, -9 - wv]; } else if (sadNow) { la = [-7.5, 7]; ra = [7.5, 7]; }
    else if (b.gest > 0) { ra = [12, -4 + Math.sin(t * 10) * 2 * AMP]; }
    else if (b.shakeHand > 0) { ra = [11, 1 + Math.sin(t * 16) * 1.5]; }
    else if (b.moving) { la = [-8.5, 4 + Math.sin(b.walk) * 2]; ra = [8.5, 4 - Math.sin(b.walk) * 2]; }
    ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(la[0], la[1]); ctx.moveTo(6, -2); ctx.lineTo(ra[0], ra[1]); ctx.stroke();
    if (b.coach) { ctx.fillStyle = '#e8e2c8'; ctx.fillRect(-11, 1, 5, 6); ctx.fillStyle = '#999'; ctx.fillRect(-10, 2.4, 3, 0.6); ctx.fillRect(-10, 4, 3, 0.6); }
    // testa
    const hy = -11 + (sadNow ? 1.6 : 0);
    ctx.fillStyle = '#e9eef4'; ctx.beginPath(); ctx.arc(0, hy, 6.4, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#0d1420'; rr(-4.6, hy - 2.6, 9.6, 5, 2.2); ctx.fill();
    const blink = b.blinkT < 0; ctx.fillStyle = sadNow ? '#8fb3ff' : b.color2;
    if (blink) { ctx.fillRect(-2.8, hy, 2, 0.6); ctx.fillRect(1.4, hy, 2, 0.6); }
    else if (happyNow) { ctx.strokeStyle = b.color2; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(-3, hy + 0.8); ctx.lineTo(-2, hy - 0.6); ctx.lineTo(-1, hy + 0.8); ctx.moveTo(1.2, hy + 0.8); ctx.lineTo(2.2, hy - 0.6); ctx.lineTo(3.2, hy + 0.8); ctx.stroke(); }
    else if (sadNow) { ctx.fillRect(-2.8, hy + 0.2, 2, 1); ctx.fillRect(1.4, hy + 0.2, 2, 1); }
    else { ctx.beginPath(); ctx.arc(-1.8 + 0.6, hy, 1.1, 0, 6.28); ctx.arc(2.4 + 0.6, hy, 1.1, 0, 6.28); ctx.fill(); }
    if (b.talkT > 0 && Math.sin(t * 18) > 0) { ctx.fillStyle = '#fff'; ctx.fillRect(-1, hy + 3.4, 3, 0.9); }
    drawLook(b, hy);
    if (tense && !RM) { const d = (t * 0.9 + b.phase) % 1; ctx.fillStyle = `rgba(140,200,255,${1 - d})`; ctx.beginPath(); ctx.arc(-6, hy - 2 + d * 8, 1.1, 0, 6.28); ctx.fill(); }
    ctx.restore();
    // pallone = posizione aperta (colore della cripto) che il giocatore palleggia
    if (b.hold) {
      const bx = b.x + b.face * 9, by = b.y + 7 - Math.abs(Math.sin(t * 5 + b.phase)) * 5 * AMP; const col = colOf(b);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(bx, by, 3.3, 0, 6.28); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.7; ctx.stroke();
      const pc = b.hold.pct || 0; const lbl = `${b.hold.side === 'SHORT' ? '▼' : '▲'}${(b.hold.lev || 1) > 1 ? b.hold.lev + 'x' : ''} ${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%`;
      ctx.font = '800 5.6px Inter,-apple-system,sans-serif'; const w = ctx.measureText(lbl).width + 6;
      ctx.fillStyle = pc >= 0 ? '#06301cdd' : '#3a0a12dd'; rr(b.x - w / 2, y - 31, w, 8, 3); ctx.fill(); text(lbl, b.x, y - 27, 5.6, pc >= 0 ? '#3dffa0' : '#ff6b7a', 'center', '800');
    }
    text(b.coach ? b.name.replace('Mister ', 'Mr ') : b.name, b.x, b.y + 15.5, 5.4, b.coach ? '#fff' : b.color2, 'center', '800');
    if (!b.coach) text(b.asset ? `${b.asset}${b.side === 'SHORT' ? '▼' : '▲'}${b.perp ? '' : b.lineRole === 'scalper' ? ' scalp' : ' spot'}` : 'riserva', b.x, b.y + 21.5, 4.4, b.coinColor || '#ffffff88', 'center', '700');
    if (b.emote && !b.hold) { ctx.globalAlpha = Math.min(1, b.emoteT * 3); text(b.emote, b.x, y - 26 - (1 - Math.min(1, b.emoteT)) * 4, 8, '#fff'); ctx.globalAlpha = 1; }
    if (sadNow && st.finale && !RM) { // nuvoletta di pioggia per chi perde
      const cx = b.x, cy = y - 32; ctx.fillStyle = '#7b8494'; ctx.beginPath(); ctx.arc(cx - 3, cy, 3.2, 0, 6.28); ctx.arc(cx + 2, cy - 1, 4, 0, 6.28); ctx.arc(cx + 6, cy + 0.5, 2.6, 0, 6.28); ctx.fill();
      ctx.strokeStyle = '#8fb3ff'; ctx.lineWidth = 0.7; for (let i = 0; i < 3; i++) { const d = (t * 2 + i / 3 + b.phase) % 1; ctx.beginPath(); ctx.moveTo(cx - 3 + i * 4, cy + 3 + d * 8); ctx.lineTo(cx - 3.6 + i * 4, cy + 5 + d * 8); ctx.stroke(); }
    }
  }
  function drawTalk(b) {
    if (!b.talk || b.talkT <= 0) return;
    const lines = b.talk; ctx.font = '700 7px Inter,-apple-system,Segoe UI,sans-serif';
    const w = Math.min(130, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10); const h = lines.length * 8.5 + 6;
    let bx = b.x - w / 2; bx = Math.max(4, Math.min(W - w - 4, bx)); const by = b.y - 34 - h;
    const a = Math.min(1, b.talkT * 2, (5.5 - b.talkT) * 6 + 0.2); ctx.globalAlpha = Math.max(0, Math.min(1, a));
    const pop = RM ? 1 : 1 + Math.max(0, 0.15 - (5.5 - b.talkT)) * 1.2;
    ctx.save(); ctx.translate(b.x, by + h); ctx.scale(pop, pop); ctx.translate(-b.x, -(by + h));
    ctx.fillStyle = '#ffffff'; rr(bx, by, w, h, 5); ctx.fill(); ctx.beginPath(); ctx.moveTo(b.x - 3, by + h); ctx.lineTo(b.x, by + h + 5); ctx.lineTo(b.x + 3, by + h); ctx.fill();
    ctx.fillStyle = b.color; ctx.fillRect(bx, by + 3, 2, h - 6);
    lines.forEach((l, i) => text(l, bx + 6, by + 7 + i * 8.5, 7, '#111', 'left', '700'));
    ctx.restore(); ctx.globalAlpha = 1;
  }
  function drawTrophy(x, k) {
    const y = 92 + 42 * Math.min(1, k) + (k < 1 ? 0 : Math.sin(t * 2) * 2 * AMP);
    ctx.save(); ctx.shadowColor = '#FFD54A'; ctx.shadowBlur = 16 + Math.sin(t * 4) * 6 * AMP;
    ctx.fillStyle = '#FFD54A'; ctx.beginPath(); ctx.moveTo(x - 11, y - 12); ctx.lineTo(x + 11, y - 12); ctx.quadraticCurveTo(x + 10, y + 4, x, y + 6); ctx.quadraticCurveTo(x - 10, y + 4, x - 11, y - 12); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#FFD54A'; ctx.beginPath(); ctx.arc(x - 12, y - 6, 4, 1.6, 4.7); ctx.stroke(); ctx.beginPath(); ctx.arc(x + 12, y - 6, 4, -1.6, 1.6); ctx.stroke();
    ctx.fillRect(x - 2, y + 6, 4, 6); ctx.fillStyle = '#b8860b'; ctx.fillRect(x - 8, y + 12, 16, 4); ctx.restore();
    if (!RM) for (let i = 0; i < 4; i++) { const a = t * 2 + i * 1.57; const sx = x + Math.cos(a) * 18, sy = y - 3 + Math.sin(a) * 10; ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 6 + i); ctx.fillRect(sx - 0.8, sy - 0.8, 1.6, 1.6); ctx.globalAlpha = 1; }
    text('VINCITORI', x, y + 22, 6.5, '#FFD54A', 'center', '900');
  }
  function drawFx() {
    for (const f of fx) {
      if (f.t < 0) continue; const p = Math.min(1, f.t / f.d);
      if (f.k === 'coin') {
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const x = f.x0 + (f.x1 - f.x0) * e, y = f.y0 + (f.y1 - f.y0) * e - Math.sin(p * 3.14) * f.arc;
        ctx.fillStyle = f.color; ctx.beginPath(); ctx.ellipse(x, y, 3 * Math.abs(Math.cos(t * 10 + f.x1)) + 0.6, 3, 0, 0, 6.28); ctx.fill();
        ctx.strokeStyle = '#8a6a00'; ctx.lineWidth = 0.5; ctx.stroke();
      } else if (f.k === 'txt') {
        ctx.globalAlpha = 1 - p * p; const s = 1 + (RM ? 0 : Math.max(0, 0.2 - f.t) * 3);
        ctx.font = '900 9px Inter,-apple-system,sans-serif'; const w = ctx.measureText(f.txt).width;
        ctx.fillStyle = '#000a'; rr(f.x - w / 2 - 3, f.y - p * 22 - 6, w + 6, 12, 4); ctx.fill();
        text(f.txt, f.x, f.y - p * 22, 9 * s, f.color, 'center', '900'); ctx.globalAlpha = 1;
      } else if (f.k === 'spark') { ctx.fillStyle = f.color; ctx.globalAlpha = 1 - p; ctx.fillRect(f.x - 1.1, f.y - 1.1, 2.2, 2.2); ctx.globalAlpha = 1; }
      else if (f.k === 'conf') { ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.r); ctx.globalAlpha = p > 0.85 ? (1 - p) / 0.15 : 1; ctx.fillStyle = f.color; ctx.fillRect(-2, -1, 4, 2 * Math.abs(Math.cos(f.r * 2)) + 0.4); ctx.restore(); ctx.globalAlpha = 1; }
      else if (f.k === 'rocket') { const y = f.y0 + (f.y1 - f.y0) * (1 - (1 - p) * (1 - p)); ctx.fillStyle = '#fff'; ctx.fillRect(f.x - 0.8, y - 2, 1.6, 4); ctx.fillStyle = f.color; ctx.globalAlpha = 0.5; ctx.fillRect(f.x - 0.5, y + 2, 1, 6); ctx.globalAlpha = 1; }
    }
  }
  function drawOverlay() {
    const m = st.m; const rem = remaining();
    if (rem != null && rem < 60e3) {
      // ultimo minuto: battito rosso ai bordi e numeroni negli ultimi 10 secondi
      const beat = 1 - ((rem % 1000) / 1000); const k = Math.pow(beat, 3) * (rem < 10e3 ? 0.55 : 0.32);
      const g = ctx.createRadialGradient(200, 172, 90, 200, 172, 260); g.addColorStop(0, 'rgba(255,40,60,0)'); g.addColorStop(1, `rgba(255,40,60,${k})`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (rem >= 10e3) text('ULTIMO MINUTO!', 200, 64, 7.5, `rgba(255,120,130,${0.6 + 0.4 * Math.sin(t * 8)})`, 'center', '900');
      if (rem < 10e3) { const s = Math.ceil(rem / 1000); const fr = (rem % 1000) / 1000; const sz = RM ? 60 : 50 + fr * 30; ctx.globalAlpha = 0.35 + 0.5 * fr; text(String(s), 200, 166, sz, '#ffffff', 'center', '900'); ctx.globalAlpha = 1; }
    }
    const F = st.finale;
    if (F && F.winner) drawTrophy(F.winner === 'A' ? 129 : 271, RM ? 1 : Math.min(1, F.t / 1.2));
    if (st.banner) {
      const b = st.banner; const p = b.t / b.d; const a = p < 0.12 ? p / 0.12 : p > 0.85 ? (1 - p) / 0.15 : 1; const s = RM ? 1 : p < 0.12 ? 0.6 + 0.4 * (p / 0.12) + Math.sin(p * 26) * 0.04 : 1;
      ctx.globalAlpha = a; ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 140, W, 46);
      ctx.save(); ctx.translate(200, 158); ctx.scale(s, s); text(b.txt, 0, 0, 16, b.col, 'center', '900'); ctx.restore();
      if (b.sub) text(b.sub, 200, 177, 7, '#e8eefc', 'center', '700'); ctx.globalAlpha = 1;
    }
    if (st.alarm > 0) { ctx.fillStyle = `rgba(255,40,60,${0.12 + 0.12 * Math.sin(t * 12)})`; ctx.fillRect(0, 0, W, H); text('KILL SWITCH', 200, 70, 12, '#ff5a6a', 'center', '900'); }
    if (!m || m.state === 'none') { if (!st.banner) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; rr(100, 196, 200, 22, 8); ctx.fill(); text("Premi Avvia per il calcio d'inizio", 200, 207, 8, '#fff', 'center', '800'); } }
    else if (m.state === 'live' && !st.trading && !st.banner) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; rr(110, 196, 180, 22, 8); ctx.fill(); text('IN PAUSA · premi Avvia', 200, 207, 8, '#fff', 'center', '800'); }
    if (m && m.realWaiting && m.state === 'live') { ctx.fillStyle = 'rgba(60,8,16,0.82)'; rr(70, 280, 260, 13, 5); ctx.fill(); text('REALE in attesa del test 5-10 USDC · nessun ordine reale', 200, 286.5, 6, '#ffb3bc', 'center', '800'); }
  }
  function draw() {
    if (!bg) paintBg();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg, 0, 0);
    const sx = st.shake > 0 ? (Math.random() - 0.5) * st.shake * 4 : 0, sy = st.shake > 0 ? (Math.random() - 0.5) * st.shake * 4 : 0;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx * scale), dpr * (oy + sy * scale));
    drawCrowd(); drawBoard(); drawCoinRows(); drawVault('A'); drawVault('B'); drawOrb(); drawMentor();
    Object.values(bots).sort((a, b) => a.y - b.y).forEach(drawBot);
    drawFx();
    Object.values(bots).forEach(drawTalk);
    drawOverlay();
  }
  function loop(now) {
    if (!running || !visible) { st.loop = false; return; }
    if (!cssW) { resize(); if (!cssW) { last = now; requestAnimationFrame(loop); return; } }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    update(dt); draw();
    requestAnimationFrame(loop);
  }
})();
