/* Osservatorio Galattico — scena su canvas (vanilla, nessuna libreria esterna).
   Sole = portafoglio (equity e PnL), pianeti = i 14 bot (dimensione = capitale, colore = PnL, velocità d'orbita = attività),
   comete = nuove operazioni, esplosioni/dissolvenze = chiusure, faro = Mentore (il fascio indica i bot che sta correggendo).
   60 fps: stelle e nebulose pre-disegnate, aloni come sprite in cache, niente shadowBlur nel ciclo; rispetta prefers-reduced-motion. */
(function () {
  'use strict';
  const RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const TAU = Math.PI * 2;
  let cv, ctx, W = 0, H = 0, DPR = 1, onTap = () => {};
  let st = null, visible = true, running = false, last = 0, tAcc = 0;
  let layers = [], nebula = null; let par = { x: 0, y: 0, tx: 0, ty: 0 };
  const planets = new Map(); // id -> stato animato
  const fx = []; // comete, scintille, onde
  const sprites = new Map();
  let selected = null, beam = { a: -0.6, target: null, idx: 0, t: 0 };
  const coinPos = new Map();
  let sunPulse = 0, sunFlash = 0, sunCol = [255, 196, 90];

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const mix = (c1, c2, k) => [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)];
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  function hsl(h, s, l) { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [255 * f(0), 255 * f(8), 255 * f(4)]; }
  const GAIN = [46, 242, 181], GAIN2 = [120, 255, 160], LOSS = [255, 84, 112], IDLE = [150, 160, 200];

  // alone radiale pre-disegnato (una volta per colore/dimensione)
  function glow(c, size = 64) {
    const k = `${c.map((x) => x | 0).join(',')}|${size}`; let s = sprites.get(k); if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = size * 2; const g = s.getContext('2d');
    const gr = g.createRadialGradient(size, size, 0, size, size, size);
    gr.addColorStop(0, rgb(c, 0.9)); gr.addColorStop(0.25, rgb(c, 0.45)); gr.addColorStop(0.6, rgb(c, 0.12)); gr.addColorStop(1, rgb(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, size * 2, size * 2);
    if (sprites.size > 160) sprites.clear(); sprites.set(k, s); return s;
  }
  function rnd(seed) { let x = seed || 1; return () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; }

  function buildBackground() {
    const r = rnd(42);
    layers = [0.15, 0.35, 0.7].map((depth, li) => {
      const c = document.createElement('canvas'); const w = Math.ceil(W * DPR * 1.15), h = Math.ceil(H * DPR * 1.15); c.width = w; c.height = h; const g = c.getContext('2d');
      const n = Math.round((W * H) / (li === 0 ? 900 : li === 1 ? 2600 : 7000));
      for (let i = 0; i < n; i++) {
        const x = r() * w, y = r() * h, s = (li === 0 ? 0.5 : li === 1 ? 0.9 : 1.4) * DPR * (0.6 + r() * 0.8);
        const tint = r(); g.fillStyle = tint < 0.15 ? 'rgba(170,200,255,' : tint > 0.9 ? 'rgba(255,220,180,' : 'rgba(255,255,255,';
        g.fillStyle += (0.35 + r() * 0.6) + ')'; g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
      }
      return { c, depth };
    });
    nebula = document.createElement('canvas'); nebula.width = Math.ceil(W * DPR); nebula.height = Math.ceil(H * DPR); const g = nebula.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 0, nebula.height); bg.addColorStop(0, '#04040c'); bg.addColorStop(0.55, '#070a1a'); bg.addColorStop(1, '#03030a');
    g.fillStyle = bg; g.fillRect(0, 0, nebula.width, nebula.height);
    const blob = (x, y, rad, c, a) => { const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, rgb(c, a)); gr.addColorStop(1, rgb(c, 0)); g.fillStyle = gr; g.fillRect(0, 0, nebula.width, nebula.height); };
    const D = DPR;
    blob(W * 0.15 * D, H * 0.22 * D, 260 * D, [90, 40, 170], 0.22); blob(W * 0.9 * D, H * 0.35 * D, 240 * D, [20, 110, 160], 0.2);
    blob(W * 0.6 * D, H * 0.85 * D, 300 * D, [140, 30, 110], 0.14); blob(W * 0.45 * D, H * 0.48 * D, 200 * D, [30, 60, 140], 0.16);
    // lo strato di stelle più lontano (si muove appena) viene fuso nella nebulosa: un disegno a schermo intero in meno per frame
    const far = layers.shift(); g.drawImage(far.c, -W * 0.075 * D, -H * 0.075 * D);
  }
  // twinkle: poche stelle brillanti animate
  let twinkles = [];
  function buildTwinkles() { const r = rnd(7); twinkles = Array.from({ length: 26 }, () => ({ x: r() * W, y: r() * H, p: r() * TAU, s: 0.6 + r() * 1.4, sp: 0.6 + r() * 1.6 })); }

  function resize() {
    const rc = cv.getBoundingClientRect(); if (!rc.width) return;
    DPR = Math.min(2, window.devicePixelRatio || 1); W = rc.width; H = rc.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    buildBackground(); buildTwinkles(); layout(); draw(0);
  }
  // geometria: centro un po' sopra la metà, ellissi inclinate (prospettiva)
  function geo() {
    const cx = W / 2, cy = H * 0.46; const rx = Math.min(W * 0.47, H * 0.62); const tilt = 0.56;
    return { cx, cy, rx, tilt, sunR: clamp(Math.min(W, H) * 0.085, 26, 46) };
  }
  function layout() {
    if (!st || !st.galaxy) return;
    const g = geo(); const bots = st.galaxy.bots; const n = bots.length;
    const maxCap = Math.max(1e-9, ...bots.map((b) => Math.max(0, b.capital)));
    const rings = [0.42, 0.56, 0.7, 0.84, 0.98];
    bots.forEach((b, i) => {
      let p = planets.get(b.id);
      const ring = rings[i % rings.length];
      if (!p) { p = { id: b.id, a: (i / n) * TAU * 3.1 + i * 0.37, flash: 0, flashCol: GAIN, col: IDLE.slice(), glowA: 0.3, r: 8, sp: 0, wob: Math.random() * TAU }; planets.set(b.id, p); }
      p.ring = ring; p.b = b;
      const k = Math.sqrt(Math.max(0.02, b.capital) / maxCap);
      p.rTarget = clamp(6 + k * 9, 6, 16) * (W < 360 ? 0.9 : 1);
      const base = hsl(b.hue, 55, 62);
      const share = Math.max(1e-9, b.share || 1); const rel = clamp(b.pnl / (share * 0.05), -1, 1); // ±5% della quota = colore pieno
      p.colTarget = b.paused ? [110, 116, 130] : rel > 0.02 ? mix(base, rel > 0.6 ? GAIN2 : GAIN, 0.35 + 0.65 * rel) : rel < -0.02 ? mix(base, LOSS, 0.35 + 0.65 * -rel) : base;
      p.glowTarget = b.paused ? 0.08 : 0.22 + Math.abs(rel) * 0.55 + (b.open ? 0.15 : 0);
      p.spTarget = b.paused || b.resting ? 0 : (0.05 + b.activity * 0.28) * (1.15 - ring * 0.45);
    });
    for (const id of [...planets.keys()]) if (!bots.some((b) => b.id === id)) planets.delete(id);
    // monete di focus: piccoli astri sul bordo alto
    coinPos.clear(); const f = (st.galaxy.focus || []);
    // le cripto di focus sono le «stelle» in alto: le comete volano verso i loro chip
    const cr = cv.getBoundingClientRect();
    f.forEach((c, i) => {
      const el = document.querySelector(`#focus [data-coin="${CSS.escape(c.symbol)}"]`); const r = el && el.getBoundingClientRect();
      if (r && r.width) coinPos.set(c.symbol, { x: r.left - cr.left + 12, y: r.top - cr.top + r.height / 2, c });
      else coinPos.set(c.symbol, { x: W * (0.2 + (0.6 * (i + 0.5)) / Math.max(1, f.length)), y: Math.max(54, H * 0.1), c });
    });
  }
  function planetXY(p, g) { const ang = p.a; const rr = g.rx * p.ring; return { x: g.cx + Math.cos(ang) * rr, y: g.cy + Math.sin(ang) * rr * g.tilt, z: Math.sin(ang) }; }

  // ---------- disegno
  function drawBg(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (nebula) ctx.drawImage(nebula, 0, 0);
    const rm = RM.matches;
    for (const L of layers) {
      const dx = (rm ? 0 : (t * 0.004 * L.depth) % (W * 0.15)) + par.x * L.depth * 22, dy = par.y * L.depth * 22;
      ctx.drawImage(L.c, (-W * 0.075 - dx) * DPR, (-H * 0.075 - dy) * DPR);
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!rm) for (const s of twinkles) { const a = 0.25 + 0.75 * Math.max(0, Math.sin(s.p + t * 0.001 * s.sp)); ctx.fillStyle = `rgba(255,255,255,${a * 0.9})`; ctx.fillRect(s.x - s.s / 2, s.y - s.s / 2, s.s, s.s); if (a > 0.85) { ctx.fillStyle = `rgba(200,220,255,${(a - 0.85) * 2})`; ctx.fillRect(s.x - s.s * 2, s.y - 0.3, s.s * 4, 0.6); ctx.fillRect(s.x - 0.3, s.y - s.s * 2, 0.6, s.s * 4); } }
  }
  function drawOrbits(g) {
    ctx.lineWidth = 1;
    for (const ring of [0.42, 0.56, 0.7, 0.84, 0.98]) {
      ctx.strokeStyle = 'rgba(140,170,255,0.07)'; ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx * ring, g.rx * ring * g.tilt, 0, 0, TAU); ctx.stroke();
    }
  }
  function drawSun(g, t) {
    const pnl = st && st.pnlBox ? st.pnlBox.total : 0; const se = st && st.startEquity ? Math.abs(st.startEquity) : 1;
    const rel = clamp(pnl / (se * 0.03), -1, 1);
    const target = rel > 0.01 ? mix([255, 196, 90], [120, 255, 190], rel * 0.7) : rel < -0.01 ? mix([255, 196, 90], [255, 90, 100], -rel * 0.7) : [255, 196, 90];
    sunCol = mix(sunCol, target, 0.04);
    const pul = RM.matches ? 0 : Math.sin(t * 0.0016) * 0.05; const R = g.sunR * (1 + pul + sunFlash * 0.25);
    const live = st && st.trading;
    ctx.globalCompositeOperation = 'lighter';
    const gs = glow(sunCol, 96); const GR = R * (live ? 4.4 : 3.4); ctx.globalAlpha = live ? 0.9 : 0.6; ctx.drawImage(gs, g.cx - GR, g.cy - GR, GR * 2, GR * 2);
    // corona rotante
    if (!RM.matches) { ctx.globalAlpha = 0.18; ctx.strokeStyle = rgb(sunCol, 1); ctx.lineWidth = 1.2; for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + t * 0.00012; const l = R * (1.35 + 0.25 * Math.sin(t * 0.002 + i * 1.7)); ctx.beginPath(); ctx.moveTo(g.cx + Math.cos(a) * R * 1.05, g.cy + Math.sin(a) * R * 1.05); ctx.lineTo(g.cx + Math.cos(a) * l, g.cy + Math.sin(a) * l); ctx.stroke(); } }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const core = ctx.createRadialGradient(g.cx - R * 0.3, g.cy - R * 0.35, R * 0.1, g.cx, g.cy, R);
    core.addColorStop(0, 'rgba(255,255,245,1)'); core.addColorStop(0.45, rgb(mix(sunCol, [255, 255, 255], 0.35), 1)); core.addColorStop(1, rgb(mix(sunCol, [80, 40, 10], 0.25), 1));
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(g.cx, g.cy, R, 0, TAU); ctx.fill();
    sunFlash *= 0.94;
  }
  function drawPlanet(p, g, t, dt) {
    const pos = planetXY(p, g); const depth = 0.82 + 0.18 * (pos.z + 1) / 2; const r = p.r * depth;
    p.x = pos.x; p.y = pos.y; p.dr = r;
    const b = p.b; const col = p.col;
    // alone
    ctx.globalCompositeOperation = 'lighter';
    const ga = p.glowA + p.flash * 0.8; const gr = r * (3 + p.flash * 2.5);
    ctx.globalAlpha = clamp(ga, 0, 1); ctx.drawImage(glow(p.flash > 0.05 ? mix(col, p.flashCol, p.flash) : col, 48), pos.x - gr, pos.y - gr, gr * 2, gr * 2);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // corpo con terminatore (luce dal sole)
    const lx = g.cx - pos.x, ly = g.cy - pos.y; const ll = Math.hypot(lx, ly) || 1; const ox = (lx / ll) * r * 0.45, oy = (ly / ll) * r * 0.45;
    const body = ctx.createRadialGradient(pos.x + ox, pos.y + oy, r * 0.1, pos.x, pos.y, r * 1.05);
    body.addColorStop(0, rgb(mix(col, [255, 255, 255], 0.5), 1)); body.addColorStop(0.55, rgb(col, 1)); body.addColorStop(1, rgb(mix(col, [5, 5, 20], 0.75), 1));
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, TAU); ctx.fill();
    // anello per i bot con posizione aperta
    if (b.open) { ctx.strokeStyle = rgb(mix(col, [255, 255, 255], 0.3), 0.75); ctx.lineWidth = 1.3; ctx.beginPath(); ctx.ellipse(pos.x, pos.y, r * 1.75, r * 0.5, -0.35, 0, TAU); ctx.stroke(); }
    // pausa / riposo
    if (b.paused) { ctx.fillStyle = 'rgba(230,235,245,0.9)'; ctx.fillRect(pos.x - r * 0.32, pos.y - r * 0.38, r * 0.2, r * 0.76); ctx.fillRect(pos.x + r * 0.12, pos.y - r * 0.38, r * 0.2, r * 0.76); }
    else if (b.resting) { ctx.strokeStyle = 'rgba(255,200,90,0.8)'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 4, 0, TAU); ctx.stroke(); ctx.setLineDash([]); }
    if (selected === p.id) { ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; const s = r + 6 + (RM.matches ? 0 : Math.sin(t * 0.006) * 1.5); ctx.beginPath(); ctx.arc(pos.x, pos.y, s, 0, TAU); ctx.stroke(); }
    // nome
    ctx.font = `600 ${W < 360 ? 9.5 : 10.5}px -apple-system, "SF Pro Text", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(b.name, pos.x + 0.6, pos.y + r + 4.6);
    ctx.fillStyle = b.paused ? 'rgba(200,205,215,0.7)' : 'rgba(235,240,255,0.92)'; ctx.fillText(b.name, pos.x, pos.y + r + 4);
    p.flash *= Math.pow(0.12, dt / 1000);
  }
  function drawCoins(t) {
    ctx.font = '700 10px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const { x, y, c } of coinPos.values()) {
      const col = hexRgb(c.color) || [200, 220, 255]; const tw = RM.matches ? 1 : 0.8 + 0.2 * Math.sin(t * 0.003 + x);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55 * tw; ctx.drawImage(glow(col, 32), x - 22, y - 22, 44, 44); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
  }
  function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  // faro del Mentore: in basso a sinistra; il fascio punta i bot corretti (a turno) o spazza lentamente il cielo
  // il faro sta appena sopra la scheda del Mentore (che copre il fondo del cielo)
  let lhY = 0, lhAt = 0;
  function lighthouse(g) {
    const now = performance.now();
    if (now - lhAt > 1000) { lhAt = now; const el = document.getElementById('beacon'); const r = el && el.getBoundingClientRect(); const cr = cv.getBoundingClientRect(); lhY = r && r.height ? r.top - cr.top - 22 : H - 44; }
    return { x: Math.max(28, W * 0.08), y: Math.min(H - 30, Math.max(g.cy + g.rx * g.tilt + 20, lhY)) };
  }
  function drawBeacon(g, t, dt) {
    const L = lighthouse(g); const corr = (st && st.galaxy && st.galaxy.corrections) || [];
    beam.t += dt;
    if (corr.length) { if (beam.t > 2600 || !beam.target) { beam.t = 0; beam.idx = (beam.idx + 1) % corr.length; beam.target = corr[beam.idx].bot; } } else beam.target = null;
    let want;
    const tp = beam.target && planets.get(beam.target);
    if (tp && tp.x != null) want = Math.atan2(tp.y - L.y, tp.x - L.x);
    else want = -Math.PI / 2 + 0.75 * Math.sin(t * 0.00035) - 0.25;
    let d = want - beam.a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; beam.a += d * (RM.matches ? 1 : Math.min(1, dt / 380));
    const len = Math.hypot(W, H); const spread = tp ? 0.085 : 0.12;
    const grd = ctx.createLinearGradient(L.x, L.y, L.x + Math.cos(beam.a) * len * 0.8, L.y + Math.sin(beam.a) * len * 0.8);
    const bc = tp ? [255, 214, 120] : [170, 200, 255];
    grd.addColorStop(0, rgb(bc, tp ? 0.38 : 0.18)); grd.addColorStop(1, rgb(bc, 0));
    ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(L.x, L.y - 14);
    ctx.lineTo(L.x + Math.cos(beam.a - spread) * len, L.y - 14 + Math.sin(beam.a - spread) * len); ctx.lineTo(L.x + Math.cos(beam.a + spread) * len, L.y - 14 + Math.sin(beam.a + spread) * len); ctx.closePath(); ctx.fill();
    if (tp && tp.x != null) { ctx.globalAlpha = 0.75; const s = tp.dr * 4.2; ctx.drawImage(glow([255, 214, 120], 48), tp.x - s, tp.y - s, s * 2, s * 2); ctx.globalAlpha = 1; }
    ctx.globalCompositeOperation = 'source-over';
    // torre
    ctx.fillStyle = '#1b2236'; ctx.beginPath(); ctx.moveTo(L.x - 7, L.y + 14); ctx.lineTo(L.x - 4, L.y - 10); ctx.lineTo(L.x + 4, L.y - 10); ctx.lineTo(L.x + 7, L.y + 14); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e9eefc'; ctx.fillRect(L.x - 5.4, L.y - 1, 10.8, 3); ctx.fillRect(L.x - 6.2, L.y + 7, 12.4, 3);
    ctx.fillStyle = '#2c3654'; ctx.fillRect(L.x - 6, L.y - 12, 12, 3);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.95; ctx.drawImage(glow(bc, 24), L.x - 14, L.y - 28, 28, 28); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff6d8'; ctx.beginPath(); ctx.arc(L.x, L.y - 14, 3, 0, TAU); ctx.fill();
  }
  function drawFx(dt) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i]; f.t += dt;
      if (f.kind === 'comet') {
        const k = clamp(f.t / f.d, 0, 1); const e = 1 - Math.pow(1 - k, 2.2);
        const p = planets.get(f.from); const sx = p && p.x != null ? p.x : W / 2, sy = p && p.y != null ? p.y : H / 2;
        const cx = (sx + f.tx) / 2 + f.bend, cy = Math.min(sy, f.ty) - 40;
        const bez = (u) => ({ x: (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cx + u * u * f.tx, y: (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cy + u * u * f.ty });
        for (let j = 0; j < 14; j++) { const u = Math.max(0, e - j * 0.018); const q = bez(u); const a = (1 - j / 14) * (1 - Math.max(0, k - 0.85) / 0.15); const s = (6 - j * 0.35); if (s <= 0) continue; ctx.globalAlpha = clamp(a, 0, 1); ctx.drawImage(glow(f.col, 24), q.x - s * 2, q.y - s * 2, s * 4, s * 4); }
        const h = bez(e); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(h.x, h.y, 2, 0, TAU); ctx.fill();
        if (k >= 1) { fx.splice(i, 1); spark(f.tx, f.ty, f.col, 10, 50); }
      } else if (f.kind === 'p') {
        f.x += f.vx * dt / 1000; f.y += f.vy * dt / 1000; f.vx *= 0.985; f.vy *= 0.985; const a = 1 - f.t / f.d; if (a <= 0) { fx.splice(i, 1); continue; }
        ctx.globalAlpha = a; const s = f.s * (0.5 + a); ctx.drawImage(glow(f.col, 16), f.x - s * 2, f.y - s * 2, s * 4, s * 4);
      } else if (f.kind === 'ring') {
        const a = 1 - f.t / f.d; if (a <= 0) { fx.splice(i, 1); continue; } const p = planets.get(f.id); const x = p ? p.x : f.x, y = p ? p.y : f.y;
        ctx.globalAlpha = a * 0.8; ctx.strokeStyle = rgb(f.col, 1); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, y, f.r0 + (f.r1 - f.r0) * (f.shrink ? a : 1 - a), 0, TAU); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  function spark(x, y, col, n, speed) { for (let i = 0; i < n; i++) { const a = Math.random() * TAU, v = speed * (0.4 + Math.random()); fx.push({ kind: 'p', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, d: 700 + Math.random() * 600, s: 1.2 + Math.random() * 1.8, col }); } }

  function draw(dt) {
    if (!ctx || !W) return;
    const t = performance.now(); const g = geo();
    par.x += (par.tx - par.x) * 0.06; par.y += (par.ty - par.y) * 0.06;
    drawBg(t); drawOrbits(g); drawCoins(t);
    const ps = [...planets.values()];
    for (const p of ps) {
      p.r = lerp(p.r, p.rTarget || 8, 0.08); p.col = mix(p.col, p.colTarget || IDLE, 0.06); p.glowA = lerp(p.glowA, p.glowTarget || 0.2, 0.06);
      p.sp = lerp(p.sp, p.spTarget || 0, 0.03); if (!RM.matches) p.a += p.sp * dt / 1000;
    }
    const pos = ps.map((p) => ({ p, z: Math.sin(p.a) })).sort((a, b) => a.z - b.z);
    for (const { p, z } of pos) if (z < 0) drawPlanet(p, g, t, dt);
    drawSun(g, t);
    for (const { p, z } of pos) if (z >= 0) drawPlanet(p, g, t, dt);
    drawBeacon(g, t, dt);
    drawFx(dt);
  }
  function loop(now) {
    if (!running) return;
    const dt = Math.min(64, now - (last || now)); last = now;
    draw(dt);
    requestAnimationFrame(loop);
  }
  function setRun() {
    const want = visible && !document.hidden && !!W;
    if (want && !running) { running = true; last = 0; requestAnimationFrame(loop); } else if (!want) running = false;
  }

  // ---------- API
  const Sky = {
    init(canvas, opts = {}) {
      cv = canvas; ctx = cv.getContext('2d'); onTap = opts.onTap || onTap;
      const ro = window.ResizeObserver ? new ResizeObserver(() => { resize(); setRun(); }) : null; if (ro) ro.observe(cv); else window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', setRun);
      cv.addEventListener('pointermove', (e) => { if (RM.matches) return; const r = cv.getBoundingClientRect(); par.tx = (e.clientX - r.left) / r.width - 0.5; par.ty = (e.clientY - r.top) / r.height - 0.5; }, { passive: true });
      cv.addEventListener('click', (e) => {
        const r = cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; const g = geo();
        let best = null, bd = 1e9;
        for (const p of planets.values()) { if (p.x == null) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < Math.max(22, p.dr + 14) && d < bd) { bd = d; best = p; } }
        if (best) { selected = best.id; return onTap({ type: 'bot', id: best.id }); }
        if (Math.hypot(g.cx - x, g.cy - y) < g.sunR * 1.6) return onTap({ type: 'sun' });
        const L = lighthouse(g); if (Math.hypot(L.x - x, L.y - 8 - y) < 34) return onTap({ type: 'beacon' });
        for (const [sym, c] of coinPos) if (Math.hypot(c.x - x, c.y - y) < 22) return onTap({ type: 'coin', symbol: sym });
        selected = null;
      });
      resize(); setRun();
    },
    setState(s) { st = s; layout(); if (!running) draw(16); },
    setVisible(v) { visible = !!v; if (v) resize(); setRun(); },
    select(id) { selected = id; },
    sun() { const g = geo(); return { x: g.cx, y: g.cy, r: g.sunR }; },
    event(e) {
      if (!e) return;
      const p = e.bot ? planets.get(e.bot) : null;
      if (e.type === 'comet' && p) {
        const target = coinPos.get(e.symbol) || { x: p.x > W / 2 ? W - 30 : 30, y: 60 };
        const col = e.side === 'SHORT' ? [255, 120, 150] : [140, 230, 255];
        if (RM.matches) { p.flash = 1; p.flashCol = col; return; }
        fx.push({ kind: 'comet', from: e.bot, tx: target.x, ty: target.y, t: 0, d: 1300, col, bend: (Math.random() - 0.5) * 120 });
      }
      if (e.type === 'trade' && p && (e.side === 'SELL' || e.short || e.side === 'PARTIAL')) {
        const gain = (e.pnl || 0) >= 0;
        p.flash = 1; p.flashCol = gain ? GAIN2 : LOSS;
        if (!RM.matches) {
          if (gain) { spark(p.x, p.y, [255, 230, 140], 22, 90); spark(p.x, p.y, GAIN2, 16, 60); fx.push({ kind: 'ring', id: e.bot, t: 0, d: 900, r0: 6, r1: 46, col: GAIN2 }); sunFlash = Math.max(sunFlash, 0.6); }
          else fx.push({ kind: 'ring', id: e.bot, t: 0, d: 1200, r0: 4, r1: 30, col: LOSS, shrink: true });
        }
      }
      if (e.type === 'correct' && p) { p.flash = 0.8; p.flashCol = [255, 214, 120]; beam.target = e.bot; beam.t = 0; }
      if (fx.length > 400) fx.splice(0, fx.length - 400);
    },
  };
  window.Sky = Sky;
})();
