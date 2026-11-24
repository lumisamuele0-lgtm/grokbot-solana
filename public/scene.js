/* Sala operativa: gli 8 bot si muovono davvero in base agli eventi reali del motore. Canvas 2D, 60fps. */
(function () {
  'use strict';
  const W = 400, H = 300;
  const ST = { // stazioni
    radar: { x: 50, y: 66 }, screen: { x: 200, y: 50 }, antenna: { x: 350, y: 64 }, gate: { x: 108, y: 150 },
    desk: { x: 200, y: 152 }, scale: { x: 288, y: 150 }, shield: { x: 352, y: 150 }, vault: { x: 50, y: 252 }, portal: { x: 350, y: 250 },
  };
  const HOME = {
    SCANSIONE: [78, 104], VERIFICA: [108, 186], SOCIAL: [322, 100], CAPO: [200, 188], DIMENSIONE: [282, 188],
    RISCHIO: [352, 188], ESECUZIONE: [296, 254], SORVEGLIANZA: [196, 234],
  };
  const COLORS = { SCANSIONE: '#3B82F6', VERIFICA: '#EAB308', SOCIAL: '#EC4899', CAPO: '#F97316', DIMENSIONE: '#06B6D4', RISCHIO: '#EF4444', ESECUZIONE: '#22C55E', SORVEGLIANZA: '#A855F7' };
  const SHORT = { SCANSIONE: 'SCOUT', VERIFICA: 'FILTRO', SOCIAL: 'SOCIAL', CAPO: 'CAPO', DIMENSIONE: 'DIM', RISCHIO: 'RISCHIO', ESECUZIONE: 'ESEC', SORVEGLIANZA: 'SORV' };

  let cv, ctx, dpr = 1, scale = 1, ox = 0, oy = 0, cssW = 0, cssH = 0;
  let t = 0, last = 0, running = true;
  const bots = {};
  const fx = []; // effetti
  const st = { radarA: 0, radarFast: 0, gate: null, gateT: 0, waves: 0, tilt: 0, tiltT: 0, shield: null, shieldT: 0, portal: 0, alarm: 0, screenSym: '', screenLine: [], screenTxt: '', pods: [], vaultGlow: 0, trading: false, mode: 'SIM' };
  let onTap = null;

  function Bot(id) {
    const [x, y] = HOME[id];
    return { id, x, y, hx: x, hy: y, color: COLORS[id], tasks: [], carry: null, emote: null, emoteT: 0, phase: Math.random() * 6, moving: false, face: 1, blink: 0, beam: null, idleT: 2 + Math.random() * 4 };
  }

  // ---------- API pubblica
  const Scene = {
    init(canvas, cb) {
      cv = canvas; ctx = cv.getContext('2d'); onTap = cb;
      Object.keys(HOME).forEach((id) => { bots[id] = Bot(id); });
      resize(); window.addEventListener('resize', resize);
      if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(cv.parentElement);
      cv.addEventListener('pointerdown', tap);
      document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { last = performance.now(); requestAnimationFrame(loop); } });
      last = performance.now(); requestAnimationFrame(loop);
    },
    setState(s) {
      st.trading = s.trading; st.mode = s.mode;
      st.pods = (s.positions || []).slice(0, 4).map((p, i, a) => ({ sym: p.symbol, pct: p.pnlPct, x: 200 + (i - (a.length - 1) / 2) * 44, y: 280 }));
      if (s.killed) st.alarm = Math.max(st.alarm, 0.6);
    },
    setScreen(sym, closes, txt) { st.screenSym = sym; st.screenLine = closes || []; st.screenTxt = txt || ''; },
    event: onEvent,
    botPos(id) { const b = bots[id]; return b ? toScreen(b.x, b.y - 40) : null; },
  };
  window.Scene = Scene;

  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    if (!r.width) return;
    if (Math.abs(r.width - cssW) < 0.5 && cv.width) return;
    cssW = r.width; cssH = Math.max(250, Math.min(440, cssW * 0.75));
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.style.height = cssH + 'px'; cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    scale = Math.min(cssW / W, cssH / H); ox = (cssW - W * scale) / 2; oy = (cssH - H * scale) / 2;
  }
  const toScreen = (x, y) => ({ x: ox + x * scale, y: oy + y * scale });
  function tap(e) {
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left - ox) / scale, y = (e.clientY - r.top - oy) / scale;
    let best = null, bd = 30;
    for (const b of Object.values(bots)) { const d = Math.hypot(b.x - x, b.y - 18 - y); if (d < bd) { bd = d; best = b; } }
    if (best && onTap) { const p = toScreen(best.x, best.y - 44); onTap(best.id, p.x, p.y); best.tasks.length < 3 && best.tasks.push({ k: 'call', f: () => emote(best, '👋', 1.2) }); }
    else if (onTap) onTap(null);
  }

  // ---------- compiti
  const go = (b, x, y, run) => b.tasks.push({ k: 'move', x, y, v: run ? 125 : 72 });
  const wait = (b, s) => b.tasks.push({ k: 'wait', s });
  const call = (b, f) => b.tasks.push({ k: 'call', f });
  const home = (b) => go(b, b.hx, b.hy);
  function emote(b, txt, s = 1.6, col) { b.emote = { txt, col }; b.emoteT = s; }
  function busy(b) { return b.tasks.length > 5; }
  function deliver(b, to, item, after) {
    const r = bots[to];
    call(b, () => { b.carry = item; });
    go(b, r.x + (r.x > b.x ? -16 : 16), r.y, true);
    call(b, () => { b.carry = null; emote(r, '📥', 0.8); after && after(); });
    home(b);
  }
  const packet = (b, label) => ({ type: 'packet', color: b.color, label: label || '' });

  // effetti
  function coins(from, to, n, color, dur = 0.9) { for (let i = 0; i < n; i++) fx.push({ k: 'coin', x0: from.x, y0: from.y, x1: to.x + (Math.random() - 0.5) * 10, y1: to.y + (Math.random() - 0.5) * 6, t: -i * 0.08, d: dur, color }); }
  function bits(from, to, n, color) { for (let i = 0; i < n; i++) fx.push({ k: 'bit', x0: from.x + (Math.random() - 0.5) * 40, y0: from.y, x1: to.x, y1: to.y, t: -i * 0.07, d: 0.8, color }); }
  function ring(p, color, r = 26) { fx.push({ k: 'ring', x: p.x, y: p.y, t: 0, d: 0.8, color, r }); }
  function floatTxt(p, txt, color) { fx.push({ k: 'txt', x: p.x, y: p.y, t: 0, d: 1.8, color, txt }); }
  function burst(p, color) { for (let i = 0; i < 14; i++) { const a = Math.random() * 6.28, s = 30 + Math.random() * 50; fx.push({ k: 'spark', x: p.x, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, t: 0, d: 0.7, color }); } }

  const tok = (e) => (e.token ? '$' + String(e.token).slice(0, 8) : '');
  function podFor(sym) { return st.pods.find((p) => p.sym === sym) || st.pods[0] || { x: 200, y: 280 }; }

  function onEvent(e) {
    if (e.type === 'trade') {
      if (e.side === 'BUY') { coins(ST.vault, ST.portal, 6, '#FFD54A'); st.portal = 2.5; st.vaultGlow = 1; }
      else { const p = podFor(e.symbol); const win = (e.pnl || 0) >= 0; coins(p, ST.vault, 8, win ? '#00FF88' : '#ff5a6a'); burst(p, win ? '#00FF88' : '#ff5a6a'); st.vaultGlow = 1;
        floatTxt({ x: ST.vault.x, y: ST.vault.y - 30 }, (win ? '+' : '') + (e.pnl || 0).toFixed(e.amount < 5 ? 4 : 2), win ? '#00FF88' : '#ff5a6a'); }
      return;
    }
    if (e.type === 'trading') { Object.values(bots).forEach((b) => emote(b, e.on ? '▶' : '⏸', 1.2)); return; }
    if (e.type !== 'agent') return;
    const b = bots[e.agent]; if (!b) return;
    const a = e.action;
    switch (e.agent) {
      case 'SCANSIONE':
        st.radarFast = 2.5; bits({ x: ST.radar.x, y: -5 }, ST.radar, 8, '#3B82F6');
        if (!busy(b)) { go(b, ST.radar.x + 18, ST.radar.y + 30); call(b, () => { b.beam = { x: ST.radar.x, y: ST.radar.y, s: 1.2 }; emote(b, '📡', 1.2); }); wait(b, 1.1); deliver(b, 'VERIFICA', packet(b, 'N')); }
        break;
      case 'VERIFICA':
        st.gate = a === 'reject' ? 'r' : a === 'approve' ? 'g' : null; st.gateT = 1.1;
        if (a === 'reject') { burst({ x: ST.gate.x, y: ST.gate.y - 6 }, '#ff5a6a'); if (!busy(b)) { call(b, () => emote(b, '✗ ' + tok(e), 1.1, '#ff5a6a')); wait(b, 0.4); } }
        if (a === 'approve') { bits(ST.gate, ST.desk, 4, '#EAB308'); if (!busy(b)) { call(b, () => emote(b, '✓ ' + tok(e), 1.4, '#00FF88')); deliver(b, 'CAPO', packet(b, '✓')); } }
        break;
      case 'SOCIAL':
        st.waves = 2.2; if (!busy(b)) { call(b, () => emote(b, '📣 ' + tok(e), 1.3)); wait(b, 0.8); deliver(b, 'CAPO', packet(b, '#')); }
        break;
      case 'CAPO':
        if (!busy(b)) {
          go(b, ST.screen.x, ST.screen.y + 52);
          call(b, () => { b.beam = { x: ST.screen.x, y: ST.screen.y + 10, s: 1 }; emote(b, a === 'pick' ? '🧠 ' + tok(e) : '🤔', 1.6, a === 'pick' ? '#00FF88' : null); });
          wait(b, 1.2);
          if (a === 'pick') deliver(b, 'DIMENSIONE', packet(b, '★')); else home(b);
        }
        break;
      case 'DIMENSIONE':
        st.tilt = a === 'block' ? 0 : 1; st.tiltT = 2;
        if (!busy(b)) { go(b, ST.scale.x - 14, ST.scale.y + 22); call(b, () => emote(b, a === 'block' ? '✗' : '⚖', 1.2)); wait(b, 0.9); if (a === 'size') deliver(b, 'RISCHIO', { type: 'coin' }); else home(b); }
        break;
      case 'RISCHIO':
        st.shield = a === 'plan' ? 'g' : 'r'; st.shieldT = 1.8;
        if (a === 'kill') { st.alarm = 4; Object.values(bots).forEach((x) => emote(x, '!', 2, '#ff5a6a')); }
        if (!busy(b)) { call(b, () => emote(b, a === 'plan' ? '🛡 SL/TP' : '✋', 1.4, a === 'plan' ? '#00FF88' : '#ff5a6a')); wait(b, 0.8); if (a === 'plan') deliver(b, 'ESECUZIONE', packet(b, '!')); }
        break;
      case 'ESECUZIONE':
        if (a === 'quote') { if (!busy(b)) { go(b, ST.portal.x - 22, ST.portal.y + 8); call(b, () => { b.beam = { x: ST.portal.x, y: ST.portal.y, s: 0.8 }; emote(b, 'quote?', 1); st.portal = 1.2; }); } }
        else if (a === 'buy' || a === 'swap') {
          if (a === 'buy') {
            go(b, ST.vault.x + 22, ST.vault.y + 8, true); call(b, () => { b.carry = { type: 'coin' }; st.vaultGlow = 1; });
            go(b, ST.portal.x - 22, ST.portal.y + 8, true); call(b, () => { b.carry = null; st.portal = 2.5; ring(ST.portal, '#22C55E', 30); });
            wait(b, 0.7); call(b, () => { b.carry = { type: 'gem', label: tok(e) }; });
            const p = podFor(e.token); go(b, p.x, p.y + 16, true); call(b, () => { b.carry = null; ring(p, '#00FF88', 20); emote(b, '✓ ' + tok(e), 1.5, '#00FF88'); });
            home(b);
          } else { call(b, () => emote(b, '✍ firma', 1.2)); }
        } else if (a === 'fail') { call(b, () => emote(b, '✗ errore', 1.6, '#ff5a6a')); }
        break;
      case 'SORVEGLIANZA':
        if (a === 'win' || a === 'loss') {
          const p = podFor(e.token); b.tasks = [];
          go(b, p.x, p.y + 16, true); call(b, () => { b.beam = { x: p.x, y: p.y, s: 0.6 }; emote(b, a === 'win' ? '💰' : '🩸', 1.5, a === 'win' ? '#00FF88' : '#ff5a6a'); });
          wait(b, 0.6); call(b, () => { b.carry = { type: 'coin', color: a === 'win' ? '#00FF88' : '#ff5a6a' }; });
          go(b, ST.vault.x + 24, ST.vault.y, true); call(b, () => { b.carry = null; st.vaultGlow = 1; }); home(b);
        }
        break;
    }
  }

  // ---------- simulazione
  function update(dt) {
    t += dt;
    st.radarA += dt * (st.radarFast > 0 ? 6 : 1.4); st.radarFast -= dt;
    st.gateT -= dt; st.waves -= dt; st.tiltT -= dt; st.shieldT -= dt; st.portal -= dt; st.alarm -= dt; st.vaultGlow = Math.max(0, st.vaultGlow - dt);
    for (const b of Object.values(bots)) {
      b.emoteT -= dt; if (b.emoteT <= 0) b.emote = null;
      if (b.beam) { b.beam.s -= dt; if (b.beam.s <= 0) b.beam = null; }
      b.blink -= dt; if (b.blink < -3 - Math.random() * 3) b.blink = 0.12;
      if (b.tasks.length > 14) b.tasks.splice(0, b.tasks.length - 14);
      const k = b.tasks[0];
      b.moving = false;
      if (!k) { idle(b, dt); continue; }
      if (k.k === 'move') {
        const dx = k.x - b.x, dy = k.y - b.y, d = Math.hypot(dx, dy);
        const v = k.v * (b.tasks.length > 6 ? 1.8 : 1);
        if (d < 1.5) { b.x = k.x; b.y = k.y; b.tasks.shift(); }
        else { const s = Math.min(d, v * dt); b.x += (dx / d) * s; b.y += (dy / d) * s; b.moving = true; b.phase += dt * v * 0.22; if (Math.abs(dx) > 0.5) b.face = dx > 0 ? 1 : -1; }
      } else if (k.k === 'wait') { k.s -= dt * (b.tasks.length > 6 ? 2 : 1); if (k.s <= 0) b.tasks.shift(); }
      else if (k.k === 'call') { b.tasks.shift(); try { k.f(); } catch (e) { /* ignora */ } }
    }
    for (let i = fx.length - 1; i >= 0; i--) { const f = fx[i]; f.t += dt; if (f.k === 'spark' && f.t > 0) { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 120 * dt; } if (f.t >= f.d) fx.splice(i, 1); }
  }
  function idle(b, dt) {
    b.idleT -= dt;
    if (b.idleT > 0) return;
    b.idleT = 3 + Math.random() * 5;
    if (b.id === 'SORVEGLIANZA' && st.pods.length) {
      // pattuglia le posizioni aperte
      st.pods.forEach((p) => { go(b, p.x, p.y + 18); call(b, () => { b.beam = { x: p.x, y: p.y, s: 0.5 }; }); wait(b, 0.5); });
      home(b); b.idleT = 1; return;
    }
    if (b.id === 'SCANSIONE' && st.trading) { go(b, ST.radar.x + 18, ST.radar.y + 32); call(b, () => { b.beam = { x: ST.radar.x, y: ST.radar.y, s: 0.8 }; }); wait(b, 0.8); home(b); return; }
    const r = st.trading ? 10 : 6;
    go(b, b.hx + (Math.random() - 0.5) * r * 2, b.hy + (Math.random() - 0.5) * r);
    if (Math.random() < 0.5) home(b);
  }

  // ---------- disegno
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function glow(c, b) { ctx.shadowColor = c; ctx.shadowBlur = b; }
  function noGlow() { ctx.shadowBlur = 0; }
  function text(s, x, y, size, col, align = 'center', weight = '700') { ctx.font = `${weight} ${size}px Inter,-apple-system,Segoe UI,Roboto,sans-serif`; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y); }

  function drawFloor() {
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#070b0a'); g.addColorStop(1, '#0a1410');
    ctx.fillStyle = g; ctx.fillRect(-ox / scale, -oy / scale, cssW / scale, cssH / scale);
    ctx.strokeStyle = '#00ff8812'; ctx.lineWidth = 1;
    for (let i = -8; i <= 8; i++) { ctx.beginPath(); ctx.moveTo(200 + i * 18, 110); ctx.lineTo(200 + i * 60, H + 10); ctx.stroke(); }
    for (let j = 0; j < 8; j++) { const y = 110 + Math.pow(j / 7, 1.6) * 200; ctx.beginPath(); ctx.moveTo(-40, y); ctx.lineTo(W + 40, y); ctx.stroke(); }
    // percorso della pipeline
    ctx.setLineDash([3, 5]); ctx.strokeStyle = '#ffffff14'; ctx.beginPath();
    [[78, 104], [108, 186], [200, 188], [282, 188], [352, 188], [296, 254]].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.setLineDash([]);
  }
  function drawStations() {
    // radar SCOUT
    const R = ST.radar; ctx.save(); ctx.translate(R.x, R.y);
    ctx.fillStyle = '#0e1a2e'; ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, 24, 0, 6.28); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#3B82F655'; ctx.beginPath(); ctx.arc(0, 0, 15, 0, 6.28); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, 7, 0, 6.28); ctx.stroke();
    const gr = ctx.createConicGradient ? ctx.createConicGradient(st.radarA, 0, 0) : null;
    if (gr) { gr.addColorStop(0, '#3B82F6aa'); gr.addColorStop(0.15, '#3B82F600'); gr.addColorStop(1, '#3B82F600'); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, 24, 0, 6.28); ctx.fill(); }
    ctx.strokeStyle = '#8ab8ff'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(st.radarA) * 24, Math.sin(st.radarA) * 24); ctx.stroke();
    ctx.restore(); text('RADAR', R.x, R.y + 32, 6.5, '#3B82F6aa');
    // schermo grafico CAPO
    const S = ST.screen; ctx.save(); glow('#F97316', 10); ctx.fillStyle = '#120c06'; ctx.strokeStyle = '#F97316'; ctx.lineWidth = 1.3; rr(S.x - 62, S.y - 30, 124, 62, 6); ctx.fill(); ctx.stroke(); noGlow();
    const L = st.screenLine;
    if (L.length > 2) {
      const mn = Math.min(...L), mx = Math.max(...L), sp = mx - mn || 1;
      ctx.strokeStyle = L[L.length - 1] >= L[0] ? '#00FF88' : '#ff5a6a'; ctx.lineWidth = 1.3; ctx.beginPath();
      L.forEach((v, i) => { const x = S.x - 56 + (i / (L.length - 1)) * 112, y = S.y + 24 - ((v - mn) / sp) * 36; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    } else { ctx.strokeStyle = '#F9731655'; ctx.beginPath(); for (let i = 0; i <= 40; i++) { const x = S.x - 56 + i * 2.8, y = S.y + 6 + Math.sin(i * 0.5 + t * 2) * 6; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
    text(st.screenSym ? '$' + st.screenSym : 'IN ATTESA DI SEGNALE', S.x - 56, S.y - 22, 7.5, '#fff', 'left', '800');
    if (st.screenTxt) text(st.screenTxt, S.x + 56, S.y - 22, 6.5, '#F9A86b', 'right', '600');
    ctx.restore();
    // antenna SOCIAL
    const A = ST.antenna; ctx.strokeStyle = '#EC4899'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(A.x - 9, A.y + 22); ctx.lineTo(A.x, A.y - 10); ctx.lineTo(A.x + 9, A.y + 22); ctx.moveTo(A.x - 5, A.y + 8); ctx.lineTo(A.x + 5, A.y + 8); ctx.stroke();
    ctx.fillStyle = '#EC4899'; ctx.beginPath(); ctx.arc(A.x, A.y - 12, 3, 0, 6.28); ctx.fill();
    const wv = st.waves > 0 ? 1 : 0.25;
    for (let i = 0; i < 3; i++) { const r = ((t * 22 + i * 10) % 30) + 4; ctx.strokeStyle = `rgba(236,72,153,${wv * (1 - r / 34)})`; ctx.beginPath(); ctx.arc(A.x, A.y - 12, r, -2.4, -0.7); ctx.stroke(); ctx.beginPath(); ctx.arc(A.x, A.y - 12, r, -2.4 - 3.14 + 3.14, -0.7); ctx.stroke(); }
    text('FLUSSO', A.x, A.y + 30, 6.5, '#EC4899aa');
    // varco FILTRO
    const G = ST.gate; const gc = st.gateT > 0 && st.gate ? (st.gate === 'g' ? '#00FF88' : '#ff5a6a') : '#EAB308';
    ctx.save(); glow(gc, st.gateT > 0 ? 14 : 4); ctx.strokeStyle = gc; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(G.x - 16, G.y + 16); ctx.lineTo(G.x - 16, G.y - 12); ctx.arc(G.x, G.y - 12, 16, 3.14, 0); ctx.lineTo(G.x + 16, G.y + 16); ctx.stroke(); noGlow(); ctx.restore();
    if (st.gateT > 0 && st.gate) { ctx.fillStyle = gc + '33'; ctx.fillRect(G.x - 14, G.y - 14, 28, 30); }
    text('FILTRO', G.x, G.y - 34, 6.5, '#EAB308aa');
    // scrivania CAPO
    const D = ST.desk; ctx.fillStyle = '#1f150c'; ctx.strokeStyle = '#F9731688'; ctx.lineWidth = 1; rr(D.x - 22, D.y - 6, 44, 14, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#F97316'; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 3); ctx.beginPath(); ctx.arc(D.x, D.y - 12, 5, 0, 6.28); ctx.fill(); ctx.globalAlpha = 1;
    // bilancia DIMENSIONE
    const B = ST.scale; const tl = st.tiltT > 0 ? Math.sin(Math.min(1, (2 - st.tiltT) * 2) * 1.57) * 0.35 * st.tilt : Math.sin(t) * 0.04;
    ctx.strokeStyle = '#06B6D4'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(B.x, B.y + 16); ctx.lineTo(B.x, B.y - 10); ctx.stroke();
    ctx.save(); ctx.translate(B.x, B.y - 10); ctx.rotate(tl); ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(18, 0); ctx.stroke();
    [-18, 18].forEach((x) => { ctx.save(); ctx.translate(x, 0); ctx.rotate(-tl); ctx.beginPath(); ctx.moveTo(-6, 9); ctx.lineTo(0, 0); ctx.lineTo(6, 9); ctx.stroke(); ctx.fillStyle = '#06B6D455'; ctx.fillRect(-7, 9, 14, 3); if (x > 0 && st.tiltT > 0) { ctx.fillStyle = '#FFD54A'; ctx.beginPath(); ctx.arc(0, 6, 3, 0, 6.28); ctx.fill(); } ctx.restore(); });
    ctx.restore(); text('DIMENSIONE', B.x, B.y - 22, 6.5, '#06B6D4aa');
    // scudo RISCHIO
    const Sh = ST.shield; const sc = st.shieldT > 0 && st.shield ? (st.shield === 'g' ? '#00FF88' : '#ff5a6a') : '#EF4444';
    ctx.save(); glow(sc, st.shieldT > 0 ? 16 : 5); ctx.fillStyle = sc + '33'; ctx.strokeStyle = sc; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(Sh.x, Sh.y - 18); ctx.lineTo(Sh.x + 14, Sh.y - 12); ctx.quadraticCurveTo(Sh.x + 13, Sh.y + 8, Sh.x, Sh.y + 16); ctx.quadraticCurveTo(Sh.x - 13, Sh.y + 8, Sh.x - 14, Sh.y - 12); ctx.closePath(); ctx.fill(); ctx.stroke(); noGlow(); ctx.restore();
    text('RISCHIO', Sh.x, Sh.y - 26, 6.5, '#EF4444aa');
    // cassaforte / wallet
    const V = ST.vault; ctx.save(); glow('#FFD54A', 6 + st.vaultGlow * 20); ctx.fillStyle = '#1d1a0c'; ctx.strokeStyle = '#FFD54A'; ctx.lineWidth = 1.4; rr(V.x - 22, V.y - 22, 44, 36, 5); ctx.fill(); ctx.stroke(); noGlow();
    ctx.beginPath(); ctx.arc(V.x, V.y - 4, 9, 0, 6.28); ctx.stroke(); ctx.save(); ctx.translate(V.x, V.y - 4); ctx.rotate(t * 0.6); ctx.beginPath(); for (let i = 0; i < 3; i++) { ctx.moveTo(0, 0); ctx.lineTo(Math.cos(i * 2.09) * 8, Math.sin(i * 2.09) * 8); } ctx.stroke(); ctx.restore(); ctx.restore();
    text(st.mode === 'REAL' ? 'WALLET BOT' : 'CASSA SIM', V.x, V.y + 22, 6.5, '#FFD54Aaa');
    // portale Jupiter
    const P = ST.portal; const sp = st.portal > 0 ? 5 : 1.2;
    ctx.save(); ctx.translate(P.x, P.y); for (let i = 0; i < 3; i++) { ctx.rotate(t * sp * (i % 2 ? -1 : 1) * 0.5 + i); ctx.strokeStyle = ['#22C55E', '#A3E635', '#14B8A6'][i]; ctx.lineWidth = 2; glow(ctx.strokeStyle, st.portal > 0 ? 16 : 6); ctx.beginPath(); ctx.ellipse(0, 0, 20 - i * 4, 11 - i * 2, 0, 0, 4.4); ctx.stroke(); } noGlow(); ctx.restore();
    text('JUPITER', P.x, P.y + 22, 6.5, '#22C55Eaa');
    // capsule delle posizioni
    st.pods.forEach((p) => {
      const c = p.pct >= 0 ? '#00FF88' : '#ff5a6a';
      ctx.save(); glow(c, 8); ctx.fillStyle = '#0f1512'; ctx.strokeStyle = c; ctx.lineWidth = 1.2; rr(p.x - 19, p.y - 13, 38, 24, 7); ctx.fill(); ctx.stroke(); noGlow(); ctx.restore();
      text('$' + p.sym.slice(0, 6), p.x, p.y - 5, 6.5, '#fff', 'center', '800');
      text((p.pct >= 0 ? '+' : '') + p.pct.toFixed(1) + '%', p.x, p.y + 4, 6.5, c, 'center', '700');
    });
    if (!st.pods.length) text('nessuna posizione', 200, 282, 6.5, '#ffffff30');
  }

  function drawBot(b) {
    const x = b.x, y = b.y, c = b.color;
    const bob = b.moving ? Math.abs(Math.sin(b.phase)) * 1.6 : Math.sin(t * 2 + b.phase) * 0.6;
    const sw = b.moving ? Math.sin(b.phase) * 3.2 : 0;
    ctx.fillStyle = '#00000080'; ctx.beginPath(); ctx.ellipse(x, y + 1, 9, 3, 0, 0, 6.28); ctx.fill();
    if (b.beam) { ctx.save(); ctx.strokeStyle = c; ctx.globalAlpha = 0.25 + 0.25 * Math.sin(t * 20); ctx.lineWidth = 3; glow(c, 10); ctx.beginPath(); ctx.moveTo(x, y - 30); ctx.lineTo(b.beam.x, b.beam.y); ctx.stroke(); noGlow(); ctx.restore(); }
    ctx.strokeStyle = '#cfd6dc'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 3.5, y - 8 - bob); ctx.lineTo(x - 3.5 + sw, y); ctx.moveTo(x + 3.5, y - 8 - bob); ctx.lineTo(x + 3.5 - sw, y); ctx.stroke();
    const by = y - 21 - bob;
    // braccia
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    if (b.carry) { ctx.beginPath(); ctx.moveTo(x - 7, by + 4); ctx.lineTo(x - 5, by - 16); ctx.moveTo(x + 7, by + 4); ctx.lineTo(x + 5, by - 16); ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(x - 8, by + 3); ctx.lineTo(x - 10 - sw * 0.4, by + 11); ctx.moveTo(x + 8, by + 3); ctx.lineTo(x + 10 + sw * 0.4, by + 11); ctx.stroke(); }
    ctx.save(); glow(c, 8); ctx.fillStyle = c; rr(x - 8, by, 16, 13, 4); ctx.fill(); noGlow(); ctx.restore();
    ctx.fillStyle = '#ffffff55'; rr(x - 5, by + 3, 10, 2.2, 1); ctx.fill();
    // testa
    const hy = by - 12;
    ctx.fillStyle = '#e9edf1'; rr(x - 7.5, hy, 15, 11, 4); ctx.fill();
    ctx.fillStyle = '#0b0f14'; rr(x - 5.8, hy + 2.6, 11.6, 5.4, 2.5); ctx.fill();
    if (b.blink <= 0) { ctx.fillStyle = c; glow(c, 6); const ex = b.face * 0.9; ctx.fillRect(x - 3.6 + ex, hy + 4, 2.2, 2); ctx.fillRect(x + 1.4 + ex, hy + 4, 2.2, 2); noGlow(); }
    ctx.strokeStyle = '#cfd6dc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy - 4); ctx.stroke();
    ctx.fillStyle = Math.sin(t * 4 + b.phase) > 0 ? c : '#ffffff'; ctx.beginPath(); ctx.arc(x, hy - 5, 1.6, 0, 6.28); ctx.fill();
    // oggetto trasportato
    if (b.carry) {
      const cy = hy - 9; const it = b.carry;
      if (it.type === 'coin') { ctx.save(); glow(it.color || '#FFD54A', 10); ctx.fillStyle = it.color || '#FFD54A'; ctx.beginPath(); ctx.arc(x, cy, 4.5, 0, 6.28); ctx.fill(); noGlow(); ctx.restore(); text('◎', x, cy + 0.3, 5.5, '#3a2a00'); }
      else if (it.type === 'gem') { ctx.save(); glow('#00FF88', 12); ctx.fillStyle = '#00FF88'; ctx.beginPath(); ctx.moveTo(x, cy - 6); ctx.lineTo(x + 5, cy); ctx.lineTo(x, cy + 5); ctx.lineTo(x - 5, cy); ctx.closePath(); ctx.fill(); noGlow(); ctx.restore(); }
      else { ctx.save(); glow(it.color, 10); ctx.fillStyle = it.color; rr(x - 5, cy - 5, 10, 9, 2); ctx.fill(); noGlow(); ctx.restore(); text(it.label || '', x, cy - 0.5, 5.5, '#000', 'center', '900'); }
    }
    text(SHORT[b.id], x, y + 8, 6, c, 'center', '800');
    if (b.emote) {
      const a = Math.min(1, b.emoteT * 3); ctx.globalAlpha = a;
      ctx.font = '700 7px Inter,-apple-system,Segoe UI,sans-serif'; const w = ctx.measureText(b.emote.txt).width + 8;
      const ey = hy - (b.carry ? 24 : 13);
      ctx.fillStyle = '#ffffffee'; rr(x - w / 2, ey - 6, w, 11, 5); ctx.fill();
      text(b.emote.txt, x, ey - 0.3, 7, b.emote.col ? (b.emote.col === '#00FF88' ? '#007a40' : b.emote.col === '#ff5a6a' ? '#c01f33' : b.emote.col) : '#111');
      ctx.globalAlpha = 1;
    }
  }
  function drawFx() {
    for (const f of fx) {
      if (f.t < 0) continue; const p = Math.min(1, f.t / f.d);
      if (f.k === 'coin' || f.k === 'bit') {
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const x = f.x0 + (f.x1 - f.x0) * e, y = f.y0 + (f.y1 - f.y0) * e - Math.sin(p * 3.14) * (f.k === 'coin' ? 40 : 10);
        ctx.save(); glow(f.color, 10); ctx.fillStyle = f.color;
        if (f.k === 'coin') { ctx.beginPath(); ctx.ellipse(x, y, 3.4 * Math.abs(Math.cos(t * 10 + f.x0)) + 0.6, 3.4, 0, 0, 6.28); ctx.fill(); } else ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        noGlow(); ctx.restore();
      } else if (f.k === 'ring') { ctx.strokeStyle = f.color; ctx.globalAlpha = 1 - p; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(f.x, f.y, f.r * p + 4, 0, 6.28); ctx.stroke(); ctx.globalAlpha = 1; }
      else if (f.k === 'spark') { ctx.fillStyle = f.color; ctx.globalAlpha = 1 - p; ctx.fillRect(f.x - 1, f.y - 1, 2.2, 2.2); ctx.globalAlpha = 1; }
      else if (f.k === 'txt') { ctx.globalAlpha = 1 - p * p; text(f.txt, f.x, f.y - p * 26, 9, f.color, 'center', '900'); ctx.globalAlpha = 1; }
    }
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cssW, cssH);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    drawFloor(); drawStations();
    Object.values(bots).sort((a, b) => a.y - b.y).forEach(drawBot);
    drawFx();
    if (st.alarm > 0) { ctx.fillStyle = `rgba(255,40,60,${0.12 + 0.12 * Math.sin(t * 12)})`; ctx.fillRect(-ox / scale, -oy / scale, cssW / scale, cssH / scale); text('KILL SWITCH', 200, 20, 12, '#ff5a6a', 'center', '900'); }
    if (!st.trading && st.alarm <= 0) text('IN PAUSA · premi Avvia', 200, 132, 8, '#ffffff55', 'center', '700');
  }
  function loop(now) {
    if (!running) return;
    if (!cssW) { resize(); if (!cssW) { last = now; requestAnimationFrame(loop); return; } }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    update(dt); draw();
    requestAnimationFrame(loop);
  }
})();
