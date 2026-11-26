/* GrokBot · Osservatorio Galattico — interfaccia (mobile first, iPhone). Tutti i dati arrivano dal motore via SSE. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const EUR = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf = (x, d = 2) => (x == null || !isFinite(x) ? '—' : Number(x).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const eur = (x) => (x == null || !isFinite(x) ? '—' : EUR.format(x));
  const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '—');
  const hhmm = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  let S = null; // ultima istantanea
  let es = null;
  let sheetRefresh = null;
  let tab = 'sky';
  const ICONS = {
    scout: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/></svg>',
    social: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"><path d="M4 10v4h3l6 4V6L7 10z"/><path d="M17 9a4 4 0 010 6"/></svg>',
    brain: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 0V7a3 3 0 00-3-3zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 0"/></svg>',
    scale: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"><path d="M12 4v16M6 7h12M6 7l-3 6h6zM18 7l-3 6h6zM8 20h8"/></svg>',
    risk: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/></svg>',
    exec: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2" stroke-linejoin="round"><path d="M3 5.5C5.5 4.5 9 4.5 12 6.5c3-2 6.5-2 9-1v13c-2.5-1-6-1-9 1-3-2-6.5-2-9-1z"/><path d="M12 6.5v13"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  };

  // token CSRF legato alla sessione (lo dà il server dopo l'accesso); se manca o è scaduto si rinnova una volta e si riprova
  let csrf = null;
  async function refreshCsrf() { try { const st = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json(); csrf = st.csrf || null; return st; } catch { return null; } }
  async function api(path, body, retry = true) {
    const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sb': '1', ...(csrf ? { 'x-csrf': csrf } : {}) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { csrf = null; showLogin(); throw new Error(j.error || 'Accesso richiesto'); }
    if (r.status === 403 && j.csrf && retry) { await refreshCsrf(); return api(path, body, false); }
    if (!r.ok) throw new Error(j.error || 'Errore ' + r.status);
    if (j && typeof j.csrf === 'string') csrf = j.csrf;
    return j;
  }
  function toast(msg, ms = 3200) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), ms); }
  function show(id) { ['login', 'setup', 'dash'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id)); window.scrollTo(0, 0); if (window.Sky) Sky.setVisible(id === 'dash' && tab === 'sky'); }

  // ---------- accesso
  let setupMode = false;
  async function boot() {
    let st;
    st = await refreshCsrf(); if (!st) { $('#loginErr').textContent = 'Server non raggiungibile'; show('login'); return; }
    if (!st.loggedIn) return showLogin(st);
    await start();
  }
  function showLogin(st) {
    if (es) { es.close(); es = null; }
    show('login');
    setupMode = st && !st.setup;
    $('#pin2Wrap').classList.toggle('hidden', !setupMode);
    $('#tokWrap').classList.toggle('hidden', !(setupMode && st && st.needsToken));
    $('#loginSub').textContent = setupMode ? (st && st.needsToken ? 'Primo avvio: inserisci il codice dei log e crea il PIN' : 'Primo avvio: crea il PIN per proteggere l\'app') : 'Inserisci il PIN per entrare';
    $('#loginBtn').textContent = setupMode ? 'Crea PIN ed entra' : 'Entra';
    setTimeout(() => $('#pin').focus(), 50);
  }
  async function doLogin() {
    $('#loginErr').textContent = '';
    const pin = $('#pin').value.trim();
    try {
      if (setupMode) { if (pin !== $('#pin2').value.trim()) throw new Error('I due PIN non coincidono'); await api('/api/auth/setup', { pin, token: $('#tok').value.trim() }); }
      else await api('/api/auth/login', { pin });
      $('#pin').value = ''; $('#pin2').value = '';
      await start();
    } catch (e) { $('#loginErr').textContent = e.message; }
  }
  $('#loginBtn').addEventListener('click', doLogin);
  $('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#pin2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  async function start() {
    S = await api('/api/state');
    if (!window.__skyInit) { window.__skyInit = 1; Sky.init($('#skyCanvas'), { onTap: onSkyTap }); }
    if (!localStorage.getItem('sb_started')) openSetup(false); else { show('dash'); }
    render(S);
    applyList(); let t0 = 'sky'; try { t0 = sessionStorage.getItem('sb_tab') || 'sky'; } catch {} setTab(t0);
    connect();
  }
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('snap', (m) => { S = JSON.parse(m.data); render(S); if (sheetRefresh) sheetRefresh(); });
    es.addEventListener('ev', (m) => onEv(JSON.parse(m.data)));
    es.onerror = () => { $('#live').classList.add('off'); $('#live').lastChild.textContent = 'OFFLINE'; fetch('/api/auth/status').then((r) => r.json()).then((st) => { if (!st.loggedIn) showLogin(st); }).catch(() => {}); };
  }

  // ---------- setup: capitale di partenza
  let capMode = 'SIM', capCur = 'USDC';
  function openSetup(back) {
    show('setup');
    capMode = S.mode; capCur = S.base;
    $$('#capMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === capMode));
    const demo = !!(S.host && S.host.demo); $('#capMode [data-v="REAL"]').disabled = demo; $('#capMode [data-v="REAL"]').textContent = demo ? 'Reale (no in demo)' : 'Reale';
    $$('#capCur button').forEach((b) => b.classList.toggle('on', b.dataset.v === capCur));
    $('#capAmt').value = S.cfg.budget;
    $('#capBack').classList.toggle('hidden', !back);
    $('#capForm').classList.remove('hidden');
    $('#capBar').style.transition = 'none'; $('#capBar').style.width = '0%';
    $('#capNum').textContent = eur(0);
    capPreview();
  }
  function rateEur(cur) { if (!S) return null; return cur === 'SOL' ? (S.solUsd || 0) * S.eurPerUsd : S.eurPerUsd; }
  function capPreview() {
    const a = Number($('#capAmt').value) || 0;
    $('#capAmtLbl').textContent = `Budget massimo (${capCur})`;
    $('#capEur').textContent = `≈ ${eur(a * (rateEur(capCur) || 0))} · ${capMode === 'SIM' ? 'soldi finti, prezzi e quote Jupiter reali' : 'soldi veri: il bot non userà mai più di questo importo'}`;
    $('#capGo').textContent = capMode === 'SIM' ? 'Avvia sessione di simulazione' : 'Continua: prepara il trading reale';
  }
  $('#capMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; capMode = b.dataset.v; $$('#capMode button').forEach((x) => x.classList.toggle('on', x === b)); capPreview(); });
  $('#capCur').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; capCur = b.dataset.v; $$('#capCur button').forEach((x) => x.classList.toggle('on', x === b)); if (capCur === 'SOL' && Number($('#capAmt').value) > 50) $('#capAmt').value = 1; if (capCur === 'USDC' && Number($('#capAmt').value) < 5) $('#capAmt').value = 100; capPreview(); });
  $('#capAmt').addEventListener('input', capPreview);
  $('#capBack').addEventListener('click', () => show('dash'));
  $('#capGo').addEventListener('click', async () => {
    $('#capErr').textContent = '';
    const budget = Number($('#capAmt').value);
    if (!(budget > 0)) { $('#capErr').textContent = 'Inserisci un importo maggiore di zero'; return; }
    try {
      if (S.trading) await api('/api/trading', { on: false });
      await api('/api/config', { budget, baseCurrency: capCur });
      if (capMode === 'SIM') {
        if (S.mode !== 'SIM') await api('/api/mode', { mode: 'SIM' });
        await api('/api/reset-sim', {});
        $('#capForm').classList.add('hidden');
        await countUp(budget * (rateEur(capCur) || 1), 1);
        localStorage.setItem('sb_started', '1');
        show('dash'); toast('Sessione pronta: premi Avvia per far lavorare i bot');
      } else {
        localStorage.setItem('sb_started', '1');
        show('dash'); realGuide();
      }
    } catch (e) { $('#capErr').textContent = e.message; }
  });
  function countUp(target, frac) {
    return new Promise((res) => {
      const bar = $('#capBar'); bar.style.transition = 'none';
      const t0 = performance.now(), d = 1700;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - p, 3);
        $('#capNum').textContent = eur(target * e); bar.style.width = (e * frac * 100) + '%';
        if (p < 1) requestAnimationFrame(step); else setTimeout(res, 450);
      };
      requestAnimationFrame(step);
    });
  }

  // ---------- numeri animati
  const tw = {};
  const RMQ = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function tween(key, el, target, fmt) {
    const o = tw[key] || (tw[key] = { v: target, from: target, to: target, t0: 0 });
    if (target == null || !isFinite(target)) { el.textContent = '—'; return; }
    if (o.to !== target) { o.from = o.v; o.to = target; o.t0 = performance.now(); }
    o.el = el; o.fmt = fmt;
  }
  (function tick(now) {
    for (const o of Object.values(tw)) {
      if (!o.el) continue;
      const p = RMQ ? 1 : Math.min(1, (now - o.t0) / 900), e = 1 - Math.pow(1 - p, 3);
      o.v = o.from + (o.to - o.from) * e;
      const s = o.fmt(o.v); if (o.el.textContent !== s) o.el.textContent = s;
    }
    requestAnimationFrame(tick);
  })(0);

  // ---------- pannello guadagni/perdite (in alto, aggiornato a ogni istantanea live ~2 s)
  const sgn = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
  const fUsd = (v) => (v == null || !isFinite(v) ? '—' : sgn(v) + (Math.abs(v) < 0.995 && v !== 0 ? nf(Math.abs(v), 3) + ' $' : nf(Math.abs(v), 2) + ' $'));
  const fSol = (v) => (v == null || !isFinite(v) ? '—' : sgn(v) + '◎' + nf(Math.abs(v), 4));
  const pbLive = []; let pbLast = null;
  function pnlConv(s) {
    const pb = s.pnlBox || {}; const bu = s.baseUsd || pb.baseUsd; const su = s.solUsd || pb.solUsd;
    const usd = (x) => (x == null || !bu ? null : x * bu);
    const sol = (x) => (s.base === 'SOL' ? x : (usd(x) != null && su ? usd(x) / su : null));
    const fmt = (x) => (usd(x) != null ? fUsd(usd(x)) : sgn(x) + nf(Math.abs(x), s.base === 'SOL' ? 4 : 2) + ' ' + s.base);
    return { pb, usd, sol, fmt };
  }
  function renderPnl(s) {
    const bar = $('#pnlBar'); if (!bar || !s.pnlBox) return;
    const { pb, usd, sol, fmt } = pnlConv(s);
    const tot = pb.total; const pct = s.startEquity > 0 ? (tot / s.startEquity) * 100 : 0;
    $('#pbMode').textContent = s.mode === 'REAL' ? 'REALE' : 'SIM';
    const tEl = $('#pbTotal');
    tween('pbTotal', tEl, usd(tot) != null ? usd(tot) : tot, usd(tot) != null ? fUsd : (v) => sgn(v) + nf(Math.abs(v), s.base === 'SOL' ? 4 : 2) + ' ' + s.base);
    tEl.className = 'pb-total ' + (tot > 0 ? 'mint' : tot < 0 ? 'red' : '');
    if (pbLast != null && Math.abs(tot - pbLast) > Math.abs(s.startEquity || 1) * 1e-6) { tEl.classList.add(tot > pbLast ? 'flash-up' : 'flash-dn'); }
    pbLast = tot;
    bar.classList.toggle('up', tot > 0); bar.classList.toggle('down', tot < 0);
    $('#pbSub').textContent = `${fSol(sol(tot))} · ${sgnN(pct)}${nf(Math.abs(pct), 2)}%${s.equityEur != null ? ' · ' + (s.pnlEur >= 0 ? '+' : '−') + eur(Math.abs(s.pnlEur)) : ''}`;
    const cell = (id, v) => { const el = $(id); el.textContent = fmt(v); el.className = v > 0 ? 'mint' : v < 0 ? 'red' : ''; };
    cell('#pbDay', pb.day); cell('#pbReal', pb.realized); cell('#pbOpen', pb.unrealized);
    const closed = s.wins + s.losses;
    $('#pbWL').innerHTML = `<span class="mint">${s.wins}</span> / <span class="red">${s.losses}</span>${closed ? ` <small class="mu">${nf(s.winRate, 0)}%</small>` : ''}`;
    $('#pbGW').textContent = 'guadagni ' + fmt(pb.grossWin || 0);
    $('#pbGL').textContent = 'perdite ' + fmt(pb.grossLoss || 0);
    $('#pbDayWL').textContent = `oggi ${pb.dayWins || 0}✓ ${pb.dayLosses || 0}✗`;
    pbLive.push({ t: s.t || Date.now(), v: tot }); if (pbLive.length > 400) pbLive.shift();
    renderCap(s);
  }
  // ---------- ripartizione del capitale: Capitale totale = Disponibile + In posizioni (− commissioni SOL esterne)
  // nella valuta del bot (USDC = $, SOL = ◎), senza conversioni: gli stessi numeri del motore e del Logger
  function capFmt(s) {
    return (v) => (v == null || !isFinite(v) ? '—' : (v < 0 ? '−' : '') + (s.base === 'SOL' ? '◎' + nf(Math.abs(v), 4) : nf(Math.abs(v), 2) + ' $'));
  }
  function renderCap(s) {
    const c = s.capital; if (!c || !$('#pbCap')) return;
    const f = capFmt(s);
    tween('capTot', $('#capTot'), c.total, f);
    tween('capAv', $('#capAv'), c.available, f);
    tween('capIn', $('#capIn'), c.inPositions, f);
    $('#capBarAv').style.width = c.availablePct.toFixed(2) + '%'; $('#capBarIn').style.width = c.inPositionsPct.toFixed(2) + '%';
    const n = s.positions.length; const mv = c.openMove;
    $('#capSub').innerHTML = n
      ? `${nf(c.inPositionsPct, 1)}% impegnato in ${n} ${n === 1 ? 'posizione' : 'posizioni'} · investiti ${f(c.committed)} · <span class="${mv >= 0 ? 'mint' : 'red'}">${mv >= 0 ? '+' : '−'}${f(Math.abs(mv))}</span>${c.extFees > 0 ? ` · commissioni SOL ${f(c.extFees)}` : ''}`
      : `tutto disponibile · nessuna posizione aperta${c.extFees > 0 ? ` · commissioni SOL ${f(c.extFees)}` : ''}`;
  }
  // animazione: soldi che escono dal Disponibile verso la posizione (apertura) o rientrano (presa parziale/chiusura)
  function cashFx(e) {
    if (!S) return;
    const f = capFmt(S); const av = $('#capAv'); if (!av) return;
    const out = e.kind === 'open'; const good = out ? null : (e.pnl == null ? e.delta >= 0 : e.pnl >= 0);
    const col = out ? 'out' : good ? 'win' : 'loss';
    const txt = (e.delta >= 0 ? '+' : '−') + f(Math.abs(e.delta));
    const box = av.closest('.pc-i'); box.classList.remove('hit-out', 'hit-win', 'hit-loss'); void box.offsetWidth; box.classList.add('hit-' + col);
    const ar = av.getBoundingClientRect();
    const fl = document.createElement('div'); fl.className = 'capFloat ' + col; fl.textContent = txt;
    fl.style.left = ar.left + 'px'; fl.style.top = ar.top + 'px'; document.body.appendChild(fl);
    if (RMQ) { setTimeout(() => fl.remove(), 1600); return; }
    // destinazione/partenza: la card della posizione se visibile, altrimenti la sala operativa
    const card = document.querySelector(`.pcard[data-pid="${e.id}"]`); const vis = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width ? r : null; };
    const tr = vis(card) || vis($('#sky')) || vis($('#pos'));
    const chip = document.createElement('div'); chip.className = 'capChip ' + col; chip.textContent = txt; document.body.appendChild(chip);
    const from = out ? { x: ar.left + ar.width / 2, y: ar.top + ar.height / 2 } : tr ? { x: tr.left + tr.width / 2, y: tr.top + Math.min(40, tr.height / 2) } : { x: ar.left, y: ar.top + 80 };
    const to = out ? (tr ? { x: tr.left + tr.width / 2, y: tr.top + Math.min(40, tr.height / 2) } : { x: ar.left, y: ar.top + 120 }) : { x: ar.left + ar.width / 2, y: ar.top + ar.height / 2 };
    chip.animate([{ transform: `translate(${from.x}px,${from.y}px) translate(-50%,-50%) scale(1)`, opacity: 1 }, { transform: `translate(${(from.x + to.x) / 2}px,${Math.min(from.y, to.y) - 40}px) translate(-50%,-50%) scale(1.15)`, opacity: 1, offset: 0.5 }, { transform: `translate(${to.x}px,${to.y}px) translate(-50%,-50%) scale(.6)`, opacity: 0 }], { duration: 1100, easing: 'cubic-bezier(.4,0,.2,1)' }).onfinish = () => chip.remove();
    if (card && !out) card.classList.add('drain');
    setTimeout(() => fl.remove(), 1700);
  }
  function trimHist(s) { const h = s.equityHist || []; const lt = h.length ? h[h.length - 1].t : 0; return h.map((p) => p.v - s.startEquity).concat(pbLive.filter((p) => p.t > lt).map((p) => p.v)); }
  function drawPbSpark() {
    const c = $('#pbSpark');
    if (c && S && S.pnlBox) {
      const r = c.getBoundingClientRect(); const dpr = Math.min(2.5, devicePixelRatio || 1);
      if (r.width > 0) {
        if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
        const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
        let pts = trimHist(S).slice(-160); if (pts.length < 2) pts = [0, S.pnlBox.total];
        let mn = Math.min(0, ...pts), mx = Math.max(0, ...pts); if (mx - mn < 1e-12) { mn -= 1; mx += 1; }
        const W = r.width, H = r.height, pad = 4; const Y = (v) => H - pad - ((v - mn) / (mx - mn)) * (H - pad * 2);
        x.strokeStyle = '#ffffff22'; x.setLineDash([2, 3]); x.beginPath(); x.moveTo(0, Y(0)); x.lineTo(W, Y(0)); x.stroke(); x.setLineDash([]);
        const P = pts.map((v, i) => [pad + (i / (pts.length - 1)) * (W - pad * 2), Y(v)]);
        const lastV = pts[pts.length - 1]; const col = lastV >= 0 ? '#00FF88' : '#ff5a6a';
        x.beginPath(); P.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b)));
        x.strokeStyle = col; x.lineWidth = 1.6; x.lineJoin = 'round'; x.stroke();
        x.lineTo(P[P.length - 1][0], Y(0)); x.lineTo(P[0][0], Y(0)); x.closePath(); x.fillStyle = lastV >= 0 ? '#00FF8822' : '#ff5a6a22'; x.fill();
        const [lx, ly] = P[P.length - 1]; const pulse = 2.4 + Math.sin(performance.now() / 260) * 1;
        x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 10; x.beginPath(); x.arc(lx, ly, pulse, 0, 6.28); x.fill(); x.shadowBlur = 0;
      }
    }
    requestAnimationFrame(drawPbSpark);
  }
  requestAnimationFrame(drawPbSpark);
  (function () {
    const chk = () => { const b = $('#pnlBar'); if (!b || b.offsetParent === null) return; const top = parseFloat(getComputedStyle(b).top) || 0; b.classList.toggle('stuck', b.getBoundingClientRect().top <= top + 0.5 && window.scrollY > 0); };
    window.addEventListener('scroll', chk, { passive: true }); window.addEventListener('resize', chk);
    $('#pbTotal').addEventListener('animationend', (e) => e.target.classList.remove('flash-up', 'flash-dn'));
    const bar = $('#pnlBar'); const setC = (on) => { bar.classList.toggle('compact', on); $('#pbTip').textContent = on ? '▾' : '▴'; };
    setC(localStorage.getItem('sb_pnl_compact') === '1');
    bar.addEventListener('click', () => { const on = !bar.classList.contains('compact'); localStorage.setItem('sb_pnl_compact', on ? '1' : '0'); setC(on); });
  })();

  // ---------- conoscenze del MENTORE
  const pctS = (x) => (x == null ? '—' : (x >= 0 ? '+' : '−') + nf(Math.abs(x), 2) + '%');
  function knowledgeHtml(k, full) {
    if (!k) return '<div class="empty">in caricamento…</div>';
    const row = (x, good) => `<div class="kn-row"><span class="kn-dot ${good ? 'g' : 'r'}"></span><span class="kn-l">${esc(x.label)}</span><span class="kn-v ${good ? 'mint' : 'red'}">${nf(x.winRate * 100, 0)}% · ${pctS(x.exp)}</span><small>${x.n} trade</small></div>`;
    const head = `<div class="kn-head"><div><b>${k.trades}</b> trade studiati <small class="mu">(${k.sim} simulati · ${k.real} reali)</small></div><div class="mu kn-up">${k.updatedAt ? 'aggiornato ' + hhmm(k.updatedAt) : 'nessun aggiornamento'}</div></div>`;
    const status = k.active
      ? `<div class="kn-st on">Consigli attivi: riordina i candidati e blocca i setup storicamente perdenti</div>`
      : `<div class="kn-st">Sta osservando: inizia a consigliare dopo ancora <b>${k.need}</b> trade chiusi</div>`;
    const lists = (k.best.length || k.worst.length)
      ? `${k.best.length ? `<div class="lbl kn-t">Cosa funziona</div>${k.best.map((x) => row(x, true)).join('')}` : ''}${k.worst.length ? `<div class="lbl kn-t">Da evitare</div>${k.worst.map((x) => row(x, false)).join('')}` : ''}`
      : '<div class="empty" style="padding:6px 0">Nessun pattern ancora affidabile (servono almeno 5 trade con la stessa caratteristica).</div>';
    const last = k.lastLesson ? `<div class="mu kn-last">Ultima lezione: ${esc(k.lastLesson.text)}</div>` : '';
    const note = full ? '<p class="note">Il Mentore impara da ogni trade chiuso (anche in simulazione). Le percentuali sono smussate: con pochi dati restano vicine alla media. Non cambia mai il 7% per operazione, i filtri minimi, lo stop-loss o il kill switch: può solo rendere i bot più selettivi.</p>' : '';
    return head + status + lists + last + note;
  }
  // ---------- strategie studiate dal MENTORE (ricerca sul web + backtest walk-forward)
  function researchHtml(r, full) {
    if (!r) return '<div class="empty">in caricamento…</div>';
    const busy = r.running || (r.lastFeeds && Date.now() - r.lastFeeds < 20000);
    const src = r.sources || {};
    const srcTxt = [src.candele && `candele ${esc(src.candele)}`, src.funding && `funding ${esc(src.funding)}`, src.openInterest && `open interest ${esc(src.openInterest)}`, src.fearGreed && `Fear & Greed ${esc(src.fearGreed)}`, src.longShort && `long/short ${esc(src.longShort)}`, src.notizie && `notizie ${esc(src.notizie)} (ogni 90 s${r.news && r.news.lastCheck ? ', ultimo controllo ' + new Date(r.news.lastCheck).toLocaleTimeString('it-IT') : ''})`, src.globale && `mercato ${esc(src.globale)}`, src.tvl && `TVL ${esc(src.tvl)}`].filter(Boolean).join(' · ') || 'in attesa della prima lettura';
    const act = r.strategies.filter((x) => x.active).length;
    const head = `<div class="rs-head"><span class="rs-globe${busy ? ' spin' : ''}" aria-hidden="true">🌐</span><div><b>${r.strategies.length}</b> strategie studiate · <b class="${act ? 'mint' : ''}">${act}</b> attive
      <div class="mu rs-up">${r.running ? 'sto studiando ora…' : r.lastBacktest ? `ultimo studio ${hhmm(r.lastBacktest)}${r.lev ? ` · leva ${r.lev}x` : ''} · si ripete ogni 2 ore` : 'primo studio tra pochi secondi'}</div></div></div>`;
    const fng = r.fng ? `<span class="rs-chip">Fear &amp; Greed <b>${r.fng.value}</b> ${esc(r.fng.label)}</span>` : '';
    const reg = r.regimes ? Object.entries(r.regimes).filter(([, v]) => v).map(([k, v]) => `<span class="rs-chip">${k} ${v === 'rialzo' ? '▲' : v === 'ribasso' ? '▼' : '↔'} ${v}</span>`).join('') : '';
    const sig = (r.liveSignals || []).map((x) => `<span class="rs-chip ${x.dir > 0 ? 'g' : 'r'}">${x.asset} ${x.dir > 0 ? 'LONG' : 'SHORT'} · ${esc((r.strategies.find((q) => q.id === x.id) || {}).name || x.id)}</span>`).join('');
    const row = (x) => {
      const b = x.best;
      const stats = b ? `${b.asset} ${b.tf} · ${b.n} op. · vincenti ${nf(b.winRate, 0)}% · resa ${pctS(b.expPct)}/op · capitale ${pctS(b.retPct)} · drawdown ${nf(b.ddPct, 1)}%` : esc(x.reason);
      const per = full && x.assets.length ? `<div class="rs-per">${x.assets.map((a) => `<span class="${a.active ? 'mint' : 'mu'}">${a.asset} ${a.tf}: ${a.n} op · ${nf(a.winRate, 0)}% · ${pctS(a.expPct)}</span>`).join('')}</div>` : '';
      return `<div class="rs-row"><div class="rs-top"><span class="rs-n">${esc(x.name)}</span><span class="rs-st ${x.active ? 'on' : 'off'}">${x.active ? 'attiva' + (x.activeOn.length ? ' · ' + x.activeOn.join('/') : '') : 'scartata'}</span></div>
        <div class="rs-s mu">${stats}</div>${full ? `<div class="rs-d mu">${esc(x.desc)}${!x.active && x.best ? ' · ' + esc(x.reason) : ''}</div>` : ''}${per}</div>`;
    };
    const chips = fng || reg || sig ? `<div class="rs-chips">${fng}${reg}${sig}</div>` : '';
    const note = `<div class="mu rs-src">Fonti: ${srcTxt}${r.lastError ? ` · <span class="red">ultimo errore: ${esc(r.lastError)}</span>` : ''}</div>`;
    const expl = full ? '<p class="note">Risultati FUORI CAMPIONE: i parametri si scelgono sul passato, poi si misura la strategia su settimane mai viste (walk-forward), con commissioni Jupiter, slittamento, prestito, la tua leva, stop prima della liquidazione e margine 7%. Si attiva solo se resta positiva dopo lo "sconto" per pochi dati (almeno 8 operazioni, profit factor &gt; 1,1, drawdown &lt; 25%). Le attive danno un voto al CAPO; quelle contrarie possono bloccare un ingresso. I risultati passati non garantiscono quelli futuri.</p>' : '';
    return head + chips + r.strategies.map(row).join('') + note + expl;
  }
  // ---------- diario del MENTORE: post-mortem, lezioni, correzioni, ultima ricerca
  const sgnN = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '−') + nf(Math.abs(x), d));
  function mentorHtml(m, r, full) {
    if (!m) return '<div class="empty">in caricamento…</div>';
    const head = `<div class="rs-head"><span class="rs-globe${m.pending ? ' spin' : ''}" aria-hidden="true">🧠</span><div><b>${m.trained}</b> trade analizzati · <b>${m.reviewed}</b> verificati${m.pending ? ` · ${m.pending} in verifica (60 min dopo l'uscita)` : ''}
      <div class="mu rs-up">ogni trade chiuso viene studiato: errore, correzione, lezione per tutti i bot</div></div></div>`;
    const errs = m.errors.length ? `<div class="lbl kn-t">Errori più frequenti</div><div class="rs-chips">${m.errors.slice(0, full ? 8 : 4).map((e) => `<span class="rs-chip r">${esc(e.label.split(' (')[0])} · ${e.n}</span>`).join('')}</div>` : '';
    const les = m.lessons.length ? `<div class="lbl kn-t">Lezioni apprese</div>${m.lessons.slice(0, full ? 8 : 3).map((l) => `<div class="md-row"><span class="kn-dot ${l.pnlPct >= 0 ? 'g' : 'r'}"></span><span>${esc(l.text)}</span><small class="mu">${hhmm(l.t)}</small></div>`).join('')}` : '<div class="empty" style="padding:6px 0">Nessuna lezione ancora: il primo post-mortem arriva 60 minuti dopo la chiusura di un trade.</div>';
    const cor = m.corrections.length ? `<div class="lbl kn-t">Errori corretti</div>${m.corrections.slice(0, full ? 8 : 3).map((c) => `<div class="md-row"><span>${c.kind === 'rollback' ? '↩' : c.kind === 'confermata' ? '✔' : '🔧'}</span><span>${esc(c.text)}</span><small class="mu">${hhmm(c.t)}</small></div>`).join('')}` : '';
    const tune = full && m.tune.length ? `<div class="lbl kn-t">Correzioni attive</div>${m.tune.map((t) => `<div class="md-row"><span>${esc(t.key.replace('|', ' '))}</span><span class="mu">stop ×${nf(t.slMult, 2)} · target ×${nf(t.tpMult, 2)} · selettività ${nf(t.level, 1)}/3${t.blocks.length ? ' · pause: ' + t.blocks.map((b) => b.kind + (b.regime ? ' ' + b.regime : '') + ' fino ' + hhmm(b.until)).join(', ') : ''}${t.evaluating != null ? ` · in prova (${t.evaluating}/6)` : ''}</span></div>`).join('')}` : '';
    let web = '';
    if (r && (r.news || r.context)) {
      const n = r.news; const ctx = r.context || {};
      const as = n ? Object.entries(n.assets).filter(([, v]) => v).map(([a, v]) => `<span class="rs-chip ${v.sentiment > 0.15 ? 'g' : v.sentiment < -0.15 ? 'r' : ''}">${a} sentiment ${sgnN(v.sentiment)}${v.risk >= 0.3 ? ` · rischio ${nf(v.risk * 100, 0)}%` : ''}</span>`).join('') : '';
      const cx = [ctx.global && `mercato 24h ${sgnN(ctx.global.mcapChange24h, 1)}%`, ctx.tvl && ctx.tvl.Solana && `TVL Solana ${sgnN(ctx.tvl.Solana.ch1d, 1)}%`, ctx.lsr && ctx.lsr.SOL && `long/short SOL ${nf(ctx.lsr.SOL.ratio, 2)}`].filter(Boolean).map((t) => `<span class="rs-chip">${t}</span>`).join('');
      const heads = n && n.latest ? n.latest.slice(0, full ? 6 : 2).map((h) => `<div class="md-row"><span class="kn-dot ${h.risk ? 'r' : h.sentiment > 0 ? 'g' : h.sentiment < 0 ? 'r' : ''}"></span><span>${esc(h.title)}</span><small class="mu">${esc(h.source)}</small></div>`).join('') : '';
      const hms = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const every = n && n.intervalSec ? (n.intervalSec >= 60 ? `${nf(n.intervalSec / 60, n.intervalSec % 60 ? 1 : 0)} min` : `${n.intervalSec} s`) : '90 s';
      web = `<div class="lbl kn-t">Notizie crypto · lette ogni ${every}</div>${n ? `<div class="mu rs-up">ultimo controllo ${hms(n.lastCheck || n.t)} · ultimo titolo nuovo ${hhmm(n.lastNew || n.t)} · ${n.count} titoli (24h) da ${n.sources.length} fonti</div>` : ''}<div class="rs-chips">${as}${cx}</div>${heads}`;
    }
    const note = full ? '<p class="note">Le correzioni sono piccole e graduali: stop ×0,8–1,3, target ×1–1,4, selettività 0–3, pause di 2–6 ore. Se dopo 6 trade vanno peggio di prima vengono annullate. Non cambiano mai la leva (minimo 5x), il margine del 7%, lo stop prima della liquidazione o il kill switch. Le notizie si leggono ogni 90 secondi da 6 feed RSS gratuiti (solo i titoli nuovi vengono valutati). Il sentiment è un conteggio di parole nei titoli: un indizio, non una previsione.</p>' : '';
    return head + errs + les + cor + tune + web + note;
  }
  let lastMdH = '';
  function renderMentor(s) { const h = mentorHtml(s.mentor, s.research, false); if (h !== lastMdH) { lastMdH = h; $('#mentorDiary').innerHTML = h; } }
  let lastRsH = '';
  function renderResearch(s) { const h = researchHtml(s.research, false); if (h !== lastRsH) { lastRsH = h; $('#research').innerHTML = h; } }
  let lastKnH = '';
  function renderKnowledge(s) { const h = knowledgeHtml(s.knowledge, false); if (h !== lastKnH) { lastKnH = h; $('#know').innerHTML = h; } }

  // ---------- agenti (Mentore)
  function agentSheet(id) {
    const draw = () => {
      const a = S.agents.find((z) => z.id === id);
      const lines = S.log.filter((l) => l.agent === id).slice(-12).reverse();
      return `<div class="row"><span class="ic" style="width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:${a.color}">${ICONS[a.icon] || ''}</span><div><h4>${a.id}</h4><div class="mu" style="font-size:13px">${esc(a.role)} · ${a.count} ${a.unit}</div></div></div>
      ${id === 'MENTORE' ? `<div class="glass know research" style="margin-top:14px"><div class="lbl kn-t">Diario del Mentore</div>${mentorHtml(S.mentor, S.research, true)}</div><div class="glass know" style="margin-top:12px">${knowledgeHtml(S.knowledge, true)}</div><div class="glass know research" style="margin-top:12px"><div class="lbl kn-t">Strategie studiate dal Mentore</div>${researchHtml(S.research, true)}</div>` : ''}
      <div class="glass" style="margin-top:14px"><div class="lbl">Decisione attuale</div><div style="margin-top:6px;font-size:15px;line-height:1.45">${esc(a.last ? a.last.text : 'In attesa…')}</div></div>
      <div class="grp"><span class="lbl">Ultime azioni</span><div class="console mono" style="height:auto;max-height:260px">${lines.map(logLine).join('') || '<div>nessuna azione registrata</div>'}</div></div>
      <div class="btns"><button class="btn ghost" data-close>Chiudi</button></div>`;
    };
    openSheet(draw, null, true);
  }


  // ---------- OSSERVATORIO: schede, cielo, pianeti
  const TABS = { sky: '#vSky', pos: '#vPos', mentor: '#vMentor', set: '#vSet' };
  function setTab(t) {
    if (!TABS[t]) t = 'sky'; tab = t;
    for (const [k, sel] of Object.entries(TABS)) $(sel).classList.toggle('hidden', k !== t);
    $$('#nav [data-tab]').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
    document.body.classList.toggle('on-sky', t === 'sky');
    Sky.setVisible(t === 'sky' && !$('#dash').classList.contains('hidden') && !$('#sheet').classList.contains('open'));
    if (t !== 'sky') window.scrollTo(0, 0);
    try { sessionStorage.setItem('sb_tab', t); } catch {}
  }
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  const botOf = (id) => (S && S.galaxy ? S.galaxy.bots.find((b) => b.id === id) : null);
  const botName = (id) => { const b = botOf(id); return b ? b.name : null; };
  function onSkyTap(t) {
    if (t.type === 'bot') botSheet(t.id);
    else if (t.type === 'sun') setTab('pos');
    else if (t.type === 'beacon') setTab('mentor');
    else if (t.type === 'coin') { const c = (S.galaxy.focus || []).find((x) => x.symbol === t.symbol); if (c) toast(`🔭 Focus del Mentore: ${c.symbol} · ${c.label}${c.phantom ? ' · nel tuo Phantom' : ''}`); }
  }
  // vista a lista (alternativa accessibile al cielo)
  let listMode = localStorage.getItem('sb_list') === '1';
  function applyList() { $('#botList').classList.toggle('hidden', !listMode); $('#sky').classList.toggle('listing', listMode); $('#listToggle').textContent = listMode ? '🪐 Cielo' : '☰ Lista'; $('#listToggle').setAttribute('aria-pressed', listMode ? 'true' : 'false'); }
  $('#listToggle').addEventListener('click', () => { listMode = !listMode; localStorage.setItem('sb_list', listMode ? '1' : '0'); applyList(); });
  $('#botList').addEventListener('click', (e) => { const b = e.target.closest('[data-bot]'); if (b) botSheet(b.dataset.bot); });
  $('#beacon').addEventListener('click', () => setTab('mentor'));
  $('#beacon').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab('mentor'); } });
  $('#focus').addEventListener('click', (e) => { const c = e.target.closest('[data-coin]'); if (c) onSkyTap({ type: 'coin', symbol: c.dataset.coin }); });
  const dot = (b) => `hsl(${b.hue} 70% 62%)`;
  const pnlCls = (v) => (v > 1e-9 ? 'mint' : v < -1e-9 ? 'red' : 'mu');
  function botStatus(b) {
    if (b.paused) return '⏸ in pausa';
    if (b.resting) return `🔧 ricalibrazione fino alle ${hhmm(b.resting)}`;
    if (b.open) return '🛰 posizione aperta';
    if (b.corrected) return `🔦 più selettivo (${b.selectivity}/2)`;
    return S.trading ? '● in orbita, cerca segnali' : '○ fermo (premi Avvia)';
  }
  function renderBotList(s) {
    const h = s.galaxy.bots.map((b) => `<button class="bl glass" role="listitem" data-bot="${esc(b.id)}"><span class="bl-dot" style="background:${dot(b)};box-shadow:0 0 12px ${dot(b)}"></span><span class="bl-n"><b>${esc(b.name)}</b><small>${esc(b.strategyName)}</small><small class="bl-s">${esc(botStatus(b))}</small></span><span class="bl-v"><b class="${pnlCls(b.pnl)}">${money(b.pnl)}</b><small>${b.trades} trade · ${b.wins}V/${b.losses}P</small></span></button>`).join('');
    const el = $('#botList'); if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; }
  }
  function renderFocus(s) {
    const f = s.galaxy.focus || [];
    const h = f.length ? `<span class="fl" title="Cripto di focus del Mentore">🔭</span>${f.map((c) => `<button class="fc" data-coin="${esc(c.symbol)}" style="--c:${esc(c.color || '#9ab')}"><i></i>${c.meme ? '🐸 ' : ''}${esc(c.symbol)}<small>${esc(c.perp ? (s.cfg.leverage || 5) + 'x L/S' : 'spot')}</small></button>`).join('')}` : '<span class="fl">🔭 il Mentore sceglie…</span>';
    const el = $('#focus'); if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; }
  }
  let tickerH = '';
  function renderBeacon(s) {
    const g = s.galaxy; const ins = g.insight;
    const corr = g.corrections || [];
    const txt = corr.length ? corr.map((c) => c.text).filter(Boolean)[0] || `${corr.length} bot sotto correzione` : ins ? ins.text : (s.entryBlock ? s.entryBlock : 'Il faro osserva i mercati e sceglie le cripto di focus.');
    $('#beaconX').textContent = txt; $('#beaconT').textContent = ins ? hhmm(ins.t) : '';
    $('#beacon').classList.toggle('alert', corr.length > 0);
    const news = (s.research && s.research.news && s.research.news.latest) || [];
    const h = news.length ? news.map((n) => `<span class="tk ${n.sentiment > 0.15 ? 'up' : n.sentiment < -0.15 ? 'dn' : ''}">${n.sentiment > 0.15 ? '▲' : n.sentiment < -0.15 ? '▼' : '•'} ${esc(n.title)} <small>${esc(n.source || '')}</small></span>`).join('') : '<span class="tk">Notizie in arrivo (controllo ogni 90 s)…</span>';
    if (h !== tickerH) { tickerH = h; $('#tickerIn').innerHTML = h + (news.length ? h : ''); $('#tickerIn').style.animationDuration = Math.max(30, news.length * 9) + 's'; }
  }
  function renderMentorTab(s) {
    const g = s.galaxy;
    $('#mInsight').textContent = g.insight ? g.insight.text : 'Nessuna indicazione nuova: il Mentore osserva.';
    $('#mFocus').textContent = (g.focus || []).length ? `Focus: ${g.focus.map((c) => c.symbol + ' (' + c.label + ')').join(' · ')}` : '';
    const corr = g.corrections || [];
    const ch = corr.length ? corr.map((c) => { const b = botOf(c.bot); return `<button class="kv corr" data-bot="${esc(c.bot)}"><span><i class="bl-dot" style="background:${b ? dot(b) : '#999'}"></i> <b>${esc(b ? b.name : c.bot)}</b></span><span class="mu">${esc(c.resting ? 'pausa di 2 min' : 'più selettivo')}</span></button><div class="mu small">${esc(c.text)}</div>`; }).join('') : '<div class="empty">Nessun bot sotto correzione: tutti in orbita regolare.</div>';
    if ($('#mCorr').dataset.h !== ch) { $('#mCorr').dataset.h = ch; $('#mCorr').innerHTML = ch; }
    const n = s.research && s.research.news;
    const nh = n && n.latest && n.latest.length ? n.latest.map((x) => `<a class="nw" href="${esc(/^https:\/\//.test(x.link || '') ? x.link : '#')}" target="_blank" rel="noopener noreferrer"><span class="nw-s ${x.sentiment > 0.15 ? 'mint' : x.sentiment < -0.15 ? 'red' : 'mu'}">${x.sentiment > 0.15 ? '▲' : x.sentiment < -0.15 ? '▼' : '•'}</span><span><b>${esc(x.title)}</b><small class="mu">${esc(x.source || '')}${x.t ? ' · ' + hhmm(x.t) : ''}${x.assets && x.assets.length ? ' · ' + esc(x.assets.join(', ')) : ''}${x.risk > 0.3 ? ' · ⚠️ rischio' : ''}</small></span></a>`).join('') : '<div class="empty">Nessuna notizia recente.</div>';
    if ($('#news').dataset.h !== nh) { $('#news').dataset.h = nh; $('#news').innerHTML = nh; }
    $('#newsT').textContent = n && n.lastCheck ? `ogni 90 s · ultimo controllo ${hhmm(n.lastCheck)}` : 'ogni 90 s';
  }
  $('#mCorr').addEventListener('click', (e) => { const b = e.target.closest('[data-bot]'); if (b) botSheet(b.dataset.bot); });
  $('#know').addEventListener('click', () => agentSheet('MENTORE'));
  $('#research').addEventListener('click', () => agentSheet('MENTORE'));
  $('#mentorDiary').addEventListener('click', () => agentSheet('MENTORE'));
  $('#logoutBtn').addEventListener('click', async () => { try { await api('/api/auth/logout', {}); } catch {} location.reload(); });

  // scheda di un pianeta (bot)
  function botSheet(id) {
    if (!botOf(id)) return;
    Sky.select(id);
    const draw = () => {
      const b = botOf(id); if (!b) return '<div class="empty">Bot non trovato</div>';
      const d = S.base === 'SOL' ? 4 : 2;
      const ps = S.positions.filter((p) => p.bot === id);
      const posH = ps.length ? ps.map((p) => `<div class="kv"><span><b>$${esc(p.symbol)}</b> <span class="side ${p.side === 'SHORT' ? 'short' : 'long'}">${p.side === 'SHORT' ? '▼ SHORT' : '▲ LONG'} ${p.lev || 1}x</span><br><small class="mu">ingresso ${hhmm(p.openedAt)} · ${p.stopKind === 'trailing' ? 'trailing' : 'stop'} ${p.stopPct != null ? nf(p.stopPct, 1) + '%' : '−' + nf(p.slPct, 1) + '%'}</small></span><span class="r"><b class="${pnlCls(p.pnl)}">${p.pnl >= 0 ? '+' : ''}${nf(p.pnl, d)}</b><br><small>${nf(p.pnlPct, 2)}%</small> <button class="chip" data-closepos="${esc(p.id)}">Chiudi</button></span></div>`).join('') : '<div class="empty">Nessuna posizione aperta.</div>';
      const hist = b.history.length ? b.history.map((t) => `<div class="kv"><span>${hhmm(t.closedAt)} <b>$${esc(t.symbol)}</b> <small class="mu">${t.side === 'SHORT' ? '▼' : '▲'}${t.lev > 1 ? ' ' + t.lev + 'x' : ''} · ${esc(t.reason || '')}</small></span><b class="${pnlCls(t.pnl)}">${t.pnl >= 0 ? '+' : ''}${nf(t.pnl, d)}</b></div>`).join('') : '<div class="empty">Ancora nessuna operazione chiusa.</div>';
      const wr = b.wins + b.losses ? Math.round((b.wins / (b.wins + b.losses)) * 100) + '%' : '—';
      return `<div class="bs-h"><span class="planet" style="--h:${b.hue}"></span><div><h4>${esc(b.name)}</h4><div class="mu">${esc(b.strategyName)} · ${esc(b.styleLabel)}</div></div>
        <span class="sp"></span><button class="tgl ${b.paused ? '' : 'on'}" id="bPause" role="switch" aria-checked="${b.paused ? 'false' : 'true'}" aria-label="Bot attivo"><i></i></button></div>
        <div class="bs-st">${esc(botStatus(b))}</div>
        ${b.note ? `<div class="bs-note">🔦 ${esc(b.note)}</div>` : ''}
        <div class="grid3"><div class="cell"><span>PnL</span><b class="${pnlCls(b.pnl)}">${money(b.pnl)}</b></div><div class="cell"><span>Capitale</span><b>${money(b.capital, false)}</b></div><div class="cell"><span>Vincenti</span><b>${wr}</b></div>
        <div class="cell"><span>Trade</span><b>${b.trades}</b></div><div class="cell"><span>Aperto</span><b class="${pnlCls(b.unrealized)}">${money(b.unrealized)}</b></div><div class="cell"><span>Attività</span><b>${Math.round(b.activity * 100)}%</b></div></div>
        <div class="grp"><span class="lbl">Strategia</span><div class="glass pad"><b>${esc(b.strategyName)}</b><p class="note">${esc(b.strategyDesc)}${b.strategy ? ` · ${b.strategyActive ? `✅ attiva fuori campione su ${esc((b.strategyOn || []).join(', '))}` : '⏳ in studio: conta solo quando il backtest la promuove'}` : ''}</p><p class="note">Leva e short solo su SOL/BTC/ETH · sulle altre cripto spot 1x solo long · margine ${S.cfg.maxTradePct}% per operazione · una posizione alla volta.</p></div></div>
        <div class="grp"><span class="lbl">Posizioni aperte</span><div class="glass pad">${posH}</div></div>
        <div class="grp"><span class="lbl">Storico</span><div class="glass pad">${hist}</div></div>
        <div class="btns"><button class="btn ghost" data-close>Chiudi</button></div>`;
    };
    openSheet(draw, (body) => {
      const t = $('#bPause', body); if (t) t.addEventListener('click', async () => {
        const b = botOf(id); const paused = !b.paused; t.disabled = true;
        try { await api('/api/bot/pause', { id, paused }); b.paused = paused; toast(paused ? `⏸ ${b.name} in pausa (le posizioni aperte restano gestite)` : `▶ ${b.name} di nuovo in orbita`); S.galaxy.bots = S.galaxy.bots.slice(); Sky.setState(S); }
        catch (er) { toast(er.message); } finally { t.disabled = false; }
      });
    }, true);
  }

  // ---------- eventi live
  function onEv(e) {
    Sky.event(e);
    const who = e.bot ? botName(e.bot) : null; const tag = who ? ` · ${who}` : '';
    if (e.type === 'log') appendLog(e);
    if (e.type === 'cash') cashFx(e);
    if (e.type === 'correct') toast(`🔦 ${e.text}`);
    const d = S && S.base === 'SOL' ? 4 : 2; const u = S ? S.base : '';
    if (e.type === 'trade' && e.side === 'PARTIAL') toast(`💰 Presa parziale ${e.pct}% su $${e.symbol}${tag} · ${(e.pnl >= 0 ? '+' : '') + nf(e.pnl, d)} ${u}`);
    else if (e.type === 'trade' && e.side === 'SHORT') toast(`☄️ SHORT ${e.lev}x su $${e.symbol}${tag}${e.mode === 'SIM' ? ' (simulato)' : ''}`);
    else if (e.type === 'trade' && e.short) toast(`${(e.pnl || 0) >= 0 ? '✨' : '🌑'} Chiuso $${e.symbol}${tag} · ${(e.pnl >= 0 ? '+' : '') + nf(e.pnl, d)} ${u}`);
    else if (e.type === 'trade') toast(e.side === 'BUY' ? `☄️ ${e.lev > 1 ? `LONG ${e.lev}x su` : 'Comprato'} $${e.symbol}${tag}${e.mode === 'SIM' ? ' (simulato)' : ''}` : `${(e.pnl || 0) >= 0 ? '✨' : '🌑'} Venduto $${e.symbol}${tag} · ${(e.pnl >= 0 ? '+' : '') + nf(e.pnl, d)} ${u}`);
  }

  let lastLogT = 0;
  function logLine(l) {
    const cls = l.level === 'warn' ? 'w' : l.level === 'error' ? 'e' : /comprato|venduto/.test(l.text) ? 'tr' : '';
    const t = esc(l.text).replace(/(https:\/\/solscan\.io\/tx\/[A-Za-z0-9]+)/g, '<a href="$1" target="_blank" rel="noopener">Solscan</a>');
    return `<div class="${cls}">${hhmm(l.t)} ${esc(l.agent)}: ${t}</div>`;
  }
  function appendLog(l) {
    if (l.t < lastLogT) return; lastLogT = l.t;
    const c = $('#console'); const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 20;
    c.insertAdjacentHTML('beforeend', logLine(l));
    while (c.children.length > 200) c.firstChild.remove();
    if (stick) c.scrollTop = c.scrollHeight;
  }

  document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.closest('.coin')) t.replaceWith(Object.assign(document.createElement('i'), { className: 'cdot' })); }, true); // logo non disponibile
  const money = (v, sign = true) => { const d = S && S.base === 'SOL' ? 4 : 2; return (sign ? (v >= 0 ? '+' : '−') : '') + nf(Math.abs(v || 0), d) + (S && S.base === 'SOL' ? ' ◎' : ' $'); };
  // ---------- render
  let firstRender = true;
  function render(s) {
    if (!s) return;
    const real = s.mode === 'REAL';
    $('#modePill').textContent = real ? 'REALE · SOLDI VERI' : 'SIMULAZIONE';
    $('#modePill').className = 'mode ' + (real ? 'real' : 'sim');
    document.body.classList.toggle('is-real', real);
    $('#demoPill').classList.toggle('hidden', !(s.host && s.host.demo));
    const lv = $('#live'); lv.classList.toggle('off', !s.live); lv.lastChild.textContent = s.live ? 'LIVE' : 'IN ATTESA';
    // sole: equity e PnL leggibili sopra il canvas
    $('#sunLbl').textContent = real ? 'Portafoglio reale' : 'Portafoglio simulato';
    const pctAll = s.startEquity > 0 ? (s.pnl / s.startEquity) * 100 : 0;
    if (s.equityEur != null) tween('bal', $('#bal'), s.equityEur, eur); else tween('bal', $('#bal'), s.equity, (v) => nf(v, s.base === 'SOL' ? 4 : 2) + ' ' + s.base);
    if (s.pnlEur != null) tween('pl', $('#pl'), s.pnlEur, (v) => `${v >= 0 ? '+' : '−'}${eur(Math.abs(v))} · ${pctAll >= 0 ? '+' : '−'}${nf(Math.abs(pctAll), 2)}%`);
    else tween('pl', $('#pl'), s.pnl, (v) => `${v >= 0 ? '+' : '−'}${nf(Math.abs(v), s.base === 'SOL' ? 4 : 2)} ${s.base} · ${pctAll >= 0 ? '+' : '−'}${nf(Math.abs(pctAll), 2)}%`);
    $('#pl').className = 'sr-p ' + pnlCls(s.pnl);
    $('#heroMeta').textContent = `${nf(s.equity, s.base === 'SOL' ? 4 : 2)} ${s.base} · vincenti ${s.winRate == null ? '—' : nf(s.winRate, 0) + '%'} (${s.wins}/${s.wins + s.losses}) · commissioni ${nf(s.fees, s.base === 'SOL' ? 5 : 3)} ${s.base} · ROI ${nf(s.roi, 2)}x`;
    const kb = $('#killBox'); kb.classList.toggle('hidden', !s.killed);
    if (s.killed) kb.innerHTML = `<b>Kill switch attivo.</b> ${esc(s.killReason || '')} · Il bot ha venduto tutto e si è fermato. Per ripartire: Sicurezza → Impostazioni → Riarma.`;
    const g = s.galaxy || { bots: [], focus: [], corrections: [] };
    const eb = $('#entryBlock'); const blockTxt = s.entryBlock ? '⏸ ' + (g.realWaiting || s.entryBlock) + ' Le posizioni già aperte restano gestite.' : g.realNote ? 'ℹ️ ' + g.realNote : '';
    eb.classList.toggle('hidden', !blockTxt); eb.textContent = blockTxt;
    tween('sA', $('#sA'), s.counters.analyzed, (v) => Math.round(v).toLocaleString('it-IT'));
    tween('sR', $('#sR'), s.counters.rejected, (v) => Math.round(v).toLocaleString('it-IT'));
    tween('sO', $('#sO'), s.counters.approved, (v) => Math.round(v).toLocaleString('it-IT'));
    renderPnl(s);
    renderKnowledge(s); renderResearch(s); renderMentor(s);
    renderFocus(s); renderBeacon(s); renderBotList(s); renderMentorTab(s);
    if (firstRender) { $('#console').innerHTML = s.log.map(logLine).join(''); lastLogT = s.log.length ? s.log[s.log.length - 1].t : 0; $('#console').scrollTop = 1e9; firstRender = false; }
    $('#secSpot').textContent = s.cfg.realSpot ? 'ACCESO (swap veri)' : 'spento'; $('#secSpot').className = s.cfg.realSpot ? 'red' : 'mint';
    const pb = $('#posBadge'); pb.classList.toggle('hidden', !s.positions.length); pb.textContent = s.positions.length;
    // regole
    const rules = Object.entries(s.counters.rules).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const max = rules.length ? rules[0][1] : 1;
    const rh = rules.map(([k, v]) => `<div class="rule"><div class="rl"><span>${esc(k)}</span><b>${v}</b></div><div class="rb"><i style="width:${(v / max) * 100}%"></i></div></div>`).join('') || '<div class="empty">ancora nessuno scarto</div>';
    if ($('#rules').dataset.h !== rh) { const old = $('#rules').innerHTML; $('#rules').dataset.h = rh; $('#rules').innerHTML = rh.replace(/width:[\d.]+%/g, (m) => (old ? m : 'width:0%')); if (!old) requestAnimationFrame(() => { $('#rules').innerHTML = rh; }); }
    // posizioni
    const nm = (id) => { const b = botOf(id); return b ? `<span class="who" style="--h:${b.hue}">${esc(b.name)}</span>` : ''; };
    const d = s.base === 'SOL' ? 4 : 2;
    $('#posN').textContent = `${s.positions.length} / ${s.cfg.maxOpen}`;
    $('#pos').innerHTML = s.positions.map((p) => {
      const lo = p.stop != null ? p.stop : p.sl, hi = p.next != null ? p.next : p.tp;
      const span = hi - lo; const k = span !== 0 && p.price ? Math.max(0, Math.min(1, (p.price - lo) / span)) : 0.5;
      const sgnP = (x) => (x >= 0 ? '+' : '−') + nf(Math.abs(x), 1) + '%';
      const sh = p.side === 'SHORT'; const pp = sh || p.perp; const px = (x) => (x >= 100 ? nf(x, 0) : x >= 1 ? nf(x, 2) : nf(x, 4));
      const badge = `<span class="side ${sh ? 'short' : 'long'}">${sh ? '▼ SHORT' : '▲ LONG'} ${p.lev || 1}x</span>`;
      return `<div data-pid="${esc(p.id)}" class="pcard${sh ? ' isShort' : ''}${pp && (p.lev || 1) >= 5 ? ' hiLev' : ''}"><div><div class="sym">$${esc(p.symbol)} ${badge} ${nm(p.bot)}</div><div class="sub2">${pp ? `margine ${nf(p.costBase, d)} ${s.base} · esposizione $${nf(p.sizeUsd, 2)} · ingresso $${px(p.entryPrice)}` : `ingresso ${nf(p.costBase, d)} ${s.base}`} · ${hhmm(p.openedAt)}${p.sigOpen ? ` · <a href="https://solscan.io/tx/${p.sigOpen}" target="_blank" rel="noopener">tx</a>` : ''}</div></div>
      <div class="pnl ${p.pnl >= 0 ? 'mint' : 'red'}">${p.pnl >= 0 ? '+' : ''}${nf(p.pnl, d)}<div class="sub2">${nf(p.pnlPct, 2)}%</div></div>
      ${pp ? `<div class="sub2 liq" style="grid-column:1/3">☠️ liquidazione $${px(p.liqPrice)} (${sgnP(((p.liqPrice - p.entryPrice) / p.entryPrice) * 100)}) · ora $${p.price ? px(p.price) : '—'} · commissioni $${nf(p.perpFeesUsd || 0, 3)}</div>` : ''}
      ${p.partialsN ? `<div class="sub2 pp" style="grid-column:1/3">💰 ${p.partialsN} ${p.partialsN === 1 ? 'presa parziale' : 'prese parziali'} (${p.soldPct}% ${sh ? 'ricomprato' : 'venduto'}) · incassato ${p.realizedPart >= 0 ? '+' : ''}${nf(p.realizedPart, d)} ${s.base}</div>` : ''}
      <div class="rng" title="stop → prossimo obiettivo"><i style="left:calc(${k * 100}% - 1px)"></i></div>
      <div class="sub2">${p.stopKind === 'trailing' ? '🪜 trailing' : p.stopKind === 'pareggio' ? '🛡 pareggio' : 'stop'} ${p.stopPct != null ? sgnP(p.stopPct) : '−' + nf(p.slPct, 1) + '%'}</div><div class="sub2" style="text-align:right">${p.nextLabel ? esc(p.nextLabel) + ' ' + sgnP(p.nextPct) : 'target +' + nf(p.tpPct, 1) + '%'} <button class="chip" data-closepos="${p.id}" style="margin-left:6px;padding:3px 8px">Chiudi</button></div></div>`;
    }).join('') || '<div class="empty">Nessuna posizione aperta: i bot entrano solo quando tutte le regole sono rispettate.</div>';
    $('#histN').textContent = s.trades.length ? `${s.trades.length} chiuse` : '';
    $('#hist').innerHTML = s.trades.length ? `<table class="h">${s.trades.slice(0, 25).map((t) => `<tr><td>${hhmm(t.closedAt)}</td><td><b>$${esc(t.symbol)}</b> <span class="side ${t.side === 'SHORT' ? 'short' : 'long'}">${t.side === 'SHORT' ? '▼ S' : '▲ L'}${t.lev > 1 ? ' ' + t.lev + 'x' : ''}</span><div class="mu" style="font-size:11px">${esc(t.reason)}</div></td><td class="r ${t.pnl >= 0 ? 'mint' : 'red'}">${t.pnl >= 0 ? '+' : ''}${nf(t.pnl, d)}<div style="font-size:11px">${nf(t.pnlPct, 2)}%</div></td><td class="r">${t.sigClose ? `<a href="https://solscan.io/tx/${t.sigClose}" target="_blank" rel="noopener">tx</a>` : '<span class="mu">sim</span>'}</td></tr>`).join('')}</table>` : '<div class="empty">Ancora nessuna operazione chiusa.</div>';
    // portafogli
    const wb = s.wallet.balances; const ub = s.user.balances;
    $('#wallet').innerHTML = `
      <div class="kv"><span>Wallet del bot</span><span class="addr">${s.wallet.exists ? `<a href="https://solscan.io/account/${s.wallet.publicKey}" target="_blank" rel="noopener">${short(s.wallet.publicKey)}</a> ${s.wallet.unlocked ? '🔓' : '🔒'}` : 'non creato'}</span></div>
      ${wb ? `<div class="kv"><span>Saldo bot</span><span>${nf(wb.sol, 4)} SOL · ${nf(wb.usdc, 2)} USDC</span></div>` : ''}
      <div class="kv"><span>Phantom</span><span class="addr">${s.user.address ? short(s.user.address) : 'non collegato'}</span></div>
      ${ub ? `<div class="kv"><span>Saldo Phantom</span><span>${nf(ub.sol, 4)} SOL · ${nf(ub.usdc, 2)} USDC</span></div>` : ''}
      <div class="kv"><span>Prelievi verso</span><span class="addr">${s.user.withdrawAddress ? short(s.user.withdrawAddress) : '— (impostato al primo deposito)'}</span></div>
      ${s.realTxs.length ? `<div class="lbl" style="margin-top:6px">Transazioni reali</div>${s.realTxs.slice(0, 6).map((x) => `<div class="kv"><span>${hhmm(x.t)} ${esc(x.label)}</span><a href="${x.url}" target="_blank" rel="noopener">${x.err ? '⚠ ' : ''}Solscan</a></div>`).join('')}` : ''}
      ${s.lastErr ? `<div class="mu" style="font-size:11px">Ultimo avviso: ${esc(s.lastErr)}</div>` : ''}`;
    // pulsante Avvia/Pausa
    const run = $('#runBtn'); run.classList.toggle('on', s.trading);
    run.innerHTML = s.trading ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg><span>Pausa</span>' : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span>Avvia</span>';
    $('#navPh').textContent = s.user.address ? short(s.user.address).slice(0, 6) : 'Phantom';
    Sky.setState(s);
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-closepos]'); if (!b) return;
    b.disabled = true;
    try { await api('/api/close', { id: b.dataset.closepos }); toast('Posizione chiusa'); } catch (er) { toast(er.message); b.disabled = false; }
  });

  // ---------- bottom sheet
  function openSheet(html, mount, live) {
    const body = $('#sheetBody');
    const paint = () => { body.innerHTML = typeof html === 'function' ? html() : html; $$('[data-close]', body).forEach((b) => b.addEventListener('click', closeSheet)); mount && mount(body); };
    paint();
    sheetRefresh = live ? () => { if (!body.contains(document.activeElement) || document.activeElement === document.body) paint(); } : null;
    $('#sheetBg').classList.remove('hidden'); requestAnimationFrame(() => { $('#sheetBg').classList.add('open'); $('#sheet').classList.add('open'); });
    setTimeout(() => { if ($('#sheet').classList.contains('open') && window.Sky) Sky.setVisible(false); }, 320);
  }
  function closeSheet() { sheetRefresh = null; $('#sheet').classList.remove('open'); $('#sheetBg').classList.remove('open'); setTimeout(() => $('#sheetBg').classList.add('hidden'), 250); if (window.Sky) { Sky.select(null); Sky.setVisible(tab === 'sky' && !$('#dash').classList.contains('hidden')); } }
  $('#sheetBg').addEventListener('click', closeSheet);

  // ---------- Phantom
  function provider() {
    const p = (window.phantom && window.phantom.solana) || window.solana;
    return p && p.isPhantom ? p : null;
  }
  function phantomDeepLink() { return `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`; }
  async function connectPhantom() {
    const p = provider();
    if (!p) {
      if (isMobile) {
        openSheet(`<h4>Apri in Phantom</h4><p class="note">Su iPhone il collegamento funziona dentro l'app Phantom. Tocca il pulsante: si aprirà questa pagina nel browser interno di Phantom, dove potrai collegare il wallet e firmare il deposito. Lì dovrai inserire di nuovo il PIN.</p>
          <div class="btns"><a class="btn pri" href="${phantomDeepLink()}">Apri in Phantom</a><button class="btn ghost" data-close>Annulla</button></div>
          <p class="note">Se Phantom non si apre, installalo dall'App Store, poi in Phantom tocca la lente (Esplora) e incolla questo indirizzo: <span class="addr">${esc(location.origin)}</span></p>`);
      } else {
        openSheet(`<h4>Phantom non trovato</h4><p class="note">Installa l'estensione Phantom per il tuo browser (Chrome, Brave, Edge o Firefox) da <a href="https://phantom.com/download" target="_blank" rel="noopener">phantom.com/download</a>, poi ricarica questa pagina.</p><div class="btns"><button class="btn ghost" data-close>Ok</button></div>`);
      }
      return null;
    }
    const r = await p.connect();
    const addr = r.publicKey.toString();
    await api('/api/user-wallet', { address: addr });
    toast('Phantom collegato: ' + short(addr));
    return addr;
  }
  let web3p = null;
  function loadWeb3() {
    if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3);
    if (!web3p) web3p = new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/web3.js'; s.onload = () => res(window.solanaWeb3); s.onerror = () => rej(new Error('Libreria Solana non caricata')); document.head.appendChild(s); });
    return web3p;
  }
  async function doDeposit(amount, currency, out) {
    const p = provider(); if (!p) { await connectPhantom(); return; }
    if (!p.isConnected || !p.publicKey || p.publicKey.toString() !== S.user.address) await connectPhantom();
    out.textContent = 'Preparo la transazione…';
    const r = await api('/api/deposit/build', { amount, currency });
    const w3 = await loadWeb3();
    const bytes = Uint8Array.from(atob(r.transaction), (c) => c.charCodeAt(0));
    const tx = w3.VersionedTransaction.deserialize(bytes);
    out.textContent = 'Conferma la transazione in Phantom…';
    const { signature } = await p.signAndSendTransaction(tx);
    out.innerHTML = `Inviata. Attendo conferma on-chain… <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener">Solscan</a>`;
    await api('/api/deposit/confirm', { signature });
    out.innerHTML = `✅ Deposito confermato. <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener">Vedi su Solscan</a>`;
    toast('Deposito confermato');
  }


  // ---------- azioni (barra in alto e scheda Sicurezza)
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b || !S) return;
    const a = b.dataset.a;
    try {
      if (a === 'phantom') { if (S.user.address) phantomSheet(); else await connectPhantom(); }
      if (a === 'budget') openSetup(true);
      if (a === 'deposit') depositSheet();
      if (a === 'toggle') {
        b.disabled = true;
        try {
          if (S.trading) { await api('/api/trading', { on: false }); toast('⏸ Bot in pausa: le posizioni aperte restano protette da stop e target'); }
          else { await api('/api/trading', { on: true }); toast('🚀 I 14 bot sono in orbita'); }
        } finally { b.disabled = false; }
      }
      if (a === 'withdraw') withdrawSheet();
      if (a === 'settings') settingsSheet();
    } catch (er) { toast(er.message, 4500); }
  });


  function phantomSheet() {
    openSheet(() => `<h4>Phantom</h4>
      <div class="card wallet" style="margin-top:10px"><div class="kv"><span>Collegato</span><span class="addr">${esc(S.user.address || '—')}</span></div>
      ${S.user.balances ? `<div class="kv"><span>Saldo</span><span>${nf(S.user.balances.sol, 4)} SOL · ${nf(S.user.balances.usdc, 2)} USDC</span></div>` : ''}
      <div class="kv"><span>Prelievi verso</span><span class="addr">${esc(S.user.withdrawAddress || '— (al primo deposito)')}</span></div></div>
      <div class="btns"><button class="btn pri" id="phRe">Ricollega / cambia account</button><button class="btn ghost" data-close>Chiudi</button></div>
      <p class="note">L'indirizzo di prelievo viene fissato al primo deposito. Per cambiarlo serve la password del wallet del bot (Impostazioni → Portafoglio).</p>`, (b) => {
      $('#phRe', b).addEventListener('click', async () => { try { await connectPhantom(); closeSheet(); } catch (er) { toast(er.message); } });
    });
  }

  function depositSheet() {
    const cur = S.base;
    openSheet(`<h4>Deposita sul bot</h4>
      <p class="note">Sposti fondi dal tuo Phantom al wallet dedicato del bot. Firmi tu in Phantom: nessuno può muovere i tuoi fondi senza la tua conferma. Aggiungo ${S.cfg.feeReserveSol} SOL di riserva per le commissioni.</p>
      ${S.mode === 'SIM' ? '<div class="warn">Sei in SIMULAZIONE: il deposito è reale ma il bot userà i fondi solo dopo che attivi la modalità REALE.</div>' : ''}
      <div class="field"><span>Valuta</span><div class="seg" id="dCur"><button data-v="USDC" class="${cur === 'USDC' ? 'on' : ''}">USDC</button><button data-v="SOL" class="${cur === 'SOL' ? 'on' : ''}">SOL</button></div></div>
      <label class="field"><span>Importo (il tuo budget)</span><input class="in" id="dAmt" type="number" inputmode="decimal" step="any" value="${S.cfg.budget}"></label>
      <div class="note" id="dInfo"></div>
      <div class="btns"><button class="btn pri" id="dGo">Firma in Phantom e deposita</button><button class="btn ghost" data-close>Annulla</button></div>
      <div class="note" id="dOut"></div>`, (b) => {
      let c = cur;
      const info = () => { const a = Number($('#dAmt', b).value) || 0; $('#dInfo', b).textContent = `Da ${S.user.address ? short(S.user.address) : 'Phantom (da collegare)'} → bot ${S.wallet.exists ? short(S.wallet.publicKey) : '(da creare in Impostazioni)'} · ≈ ${eur(a * (rateEur(c) || 0))}${c !== S.base ? ` · attenzione: la valuta base del bot è ${S.base}` : ''}`; };
      $('#dCur', b).addEventListener('click', (e) => { const x = e.target.closest('button'); if (!x) return; c = x.dataset.v; $$('#dCur button', b).forEach((y) => y.classList.toggle('on', y === x)); info(); });
      $('#dAmt', b).addEventListener('input', info); info();
      $('#dGo', b).addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          if (!S.wallet.exists) throw new Error('Crea prima il wallet del bot: Impostazioni → Portafoglio del bot');
          if (!S.user.address) { await connectPhantom(); if (!provider()) return; }
          await doDeposit(Number($('#dAmt', b).value), c, $('#dOut', b));
        } catch (er) { $('#dOut', b).innerHTML = `<span class="red">${esc(er.message)}</span>`; }
        e.target.disabled = false;
      });
    });
  }

  function withdrawSheet() {
    if (S.mode === 'SIM') {
      openSheet(`<h4>Preleva tutto (simulazione)</h4><p class="note">In simulazione non ci sono fondi veri: chiudo tutte le posizioni simulate al prezzo di mercato attuale e metto in pausa i bot.</p>
        <div class="btns"><button class="btn pri" id="wGo">Chiudi tutto</button><button class="btn ghost" data-close>Annulla</button></div><div class="note" id="wOut"></div>`, (b) => {
        $('#wGo', b).addEventListener('click', async (e) => { e.target.disabled = true; try { const r = await api('/api/withdraw', {}); $('#wOut', b).textContent = `Fatto. Saldo simulato: ${nf(r.cash, 4)} ${S.base}`; } catch (er) { $('#wOut', b).textContent = er.message; } });
      });
      return;
    }
    openSheet(`<h4>Preleva tutto</h4>
      <p class="note">Il bot si ferma, vende tutte le posizioni, poi invia tutti gli USDC e i SOL al tuo Phantom:</p>
      <div class="card addr" style="margin-top:8px">${esc(S.user.withdrawAddress || 'nessun indirizzo: fai prima un deposito')}</div>
      <label class="field"><span>Password del wallet del bot</span><input class="in" id="wPw" type="password" autocomplete="current-password"></label>
      <div class="btns"><button class="btn dan" id="wGo">Vendi tutto e preleva</button><button class="btn ghost" data-close>Annulla</button></div><div class="note" id="wOut"></div>`, (b) => {
      $('#wGo', b).addEventListener('click', async (e) => {
        e.target.disabled = true; $('#wOut', b).textContent = 'Vendo le posizioni e invio i fondi… può richiedere un minuto.';
        try { const r = await api('/api/withdraw', { password: $('#wPw', b).value }); $('#wOut', b).innerHTML = '✅ Prelievo completato: ' + r.steps.map((s) => `<a href="https://solscan.io/tx/${s.sig}" target="_blank" rel="noopener">${s.step}</a>`).join(' · '); }
        catch (er) { $('#wOut', b).innerHTML = `<span class="red">${esc(er.message)}</span>`; e.target.disabled = false; }
      });
    });
  }

  // guida alla modalità reale (checklist che si aggiorna da sola)
  function realGuide() {
    const draw = () => {
      const w = S.wallet, bal = w.balances; const need = S.cfg.budget;
      const have = bal ? (S.base === 'SOL' ? Math.max(0, bal.sol - S.cfg.feeReserveSol) : bal.usdc) : 0;
      const fund = need > 0 ? Math.min(1, have / need) : 0;
      const step = (ok, n, t, body) => `<div class="card" style="margin-top:10px"><div class="row"><b style="color:${ok ? 'var(--mint)' : '#fff'}">${ok ? '✓' : n}</b><b>${t}</b></div>${ok ? '' : `<div style="margin-top:8px">${body}</div>`}</div>`;
      return `<h4>Trading reale</h4><p class="note">Quattro passi. Il bot opera solo con il wallet dedicato e non userà mai più di ${nf(need, 4)} ${S.base}.</p>
      ${step(w.exists && w.unlocked, '1', w.exists ? 'Sblocca il wallet del bot' : 'Crea il wallet del bot', `<input class="in" id="g1" type="password" placeholder="${w.exists ? 'Password del wallet' : 'Nuova password (min. 8 caratteri)'}"><button class="btn pri" style="margin-top:8px" id="g1b">${w.exists ? 'Sblocca' : 'Crea wallet cifrato'}</button>`)}
      ${step(!!S.user.address, '2', 'Collega Phantom', '<button class="btn pri" id="g2b">Collega Phantom</button>')}
      <div class="card" style="margin-top:10px"><div class="row"><b style="color:${fund >= 1 ? 'var(--mint)' : '#fff'}">${fund >= 1 ? '✓' : '3'}</b><b>Deposita il budget</b><span class="sp"></span><span class="mu">${nf(have, 4)} / ${nf(need, 4)} ${S.base}</span></div>
        <div class="bar" style="margin-top:10px"><i style="width:${fund * 100}%"></i></div>${fund >= 1 ? '' : '<button class="btn pri" style="margin-top:10px" id="g3b">Deposita da Phantom</button>'}</div>
      ${step(S.mode === 'REAL', '4', 'Attiva la modalità reale', `<div class="warn">Soldi veri: puoi perderli. La strategia non garantisce profitti. Il PC deve restare acceso.</div><input class="in" id="g4" placeholder="Scrivi: ATTIVA REALE" style="margin-top:8px" autocapitalize="characters"><button class="btn dan" style="margin-top:8px" id="g4b">Attiva modalità reale</button>`)}
      <div class="btns"><button class="btn ghost" data-close>Chiudi</button></div><div class="err" id="gErr"></div>`;
    };
    openSheet(draw, (b) => {
      const err = (e) => { const x = $('#gErr', b); if (x) x.textContent = e.message; };
      const g1 = $('#g1b', b); if (g1) g1.addEventListener('click', async () => { try { await api(S.wallet.exists ? '/api/wallet/unlock' : '/api/wallet/create', { password: $('#g1', b).value }); toast(S.wallet.exists ? 'Wallet sbloccato' : 'Wallet creato e cifrato'); S = await api('/api/state'); sheetRefresh && sheetRefresh(); } catch (e) { err(e); } });
      const g2 = $('#g2b', b); if (g2) g2.addEventListener('click', () => connectPhantom().catch(err));
      const g3 = $('#g3b', b); if (g3) g3.addEventListener('click', depositSheet);
      const g4 = $('#g4b', b); if (g4) g4.addEventListener('click', async () => { try { await api('/api/mode', { mode: 'REAL', confirm: $('#g4', b).value.trim() }); toast('Modalità REALE attiva. Premi Avvia quando vuoi.'); closeSheet(); } catch (e) { err(e); } });
    }, true);
  }

  // ---------- impostazioni
  function settingsSheet() {
    const c = S.cfg;
    const num = (k, label, step = 'any') => `<label class="field"><span>${label}</span><input class="in" data-k="${k}" type="number" inputmode="decimal" step="${step}" value="${c[k]}"></label>`;
    const core = [['SOL', 'So11111111111111111111111111111111111111112'], ['BTC', 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij'], ['ETH', '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'], ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'], ['RAY', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'], ['KMNO', 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS'], ['JTO', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'], ['PYTH', 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'], ['ORCA', 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'], ['RENDER', 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'], ['HNT', 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux'], ['W', '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ']];
    const custom = c.tokens.filter((m) => !core.some(([, x]) => x === m));
    openSheet(`<h4>Impostazioni</h4>
      <div class="grp"><span class="lbl">Modalità</span>
        <div class="card"><div class="row"><b>${S.mode === 'REAL' ? 'REALE · soldi veri' : 'SIMULAZIONE'}</b><span class="sp"></span><button class="chip" id="sMode">${S.mode === 'REAL' ? 'Passa a simulazione' : 'Passa a reale…'}</button></div></div></div>
      <div class="grp"><span class="lbl">Gestione del rischio</span><div class="grid2">
        ${num('maxLossPct', 'Kill switch: perdita totale %')}${num('maxLossAbs', `Kill switch: perdita max (${S.base}, 0=off)`)}
        ${num('dailyLossPct', 'Stop giornaliero %')}${num('maxTradePct', 'Rischio per operazione (% capitale)')}
        ${num('maxOpen', 'Posizioni max', '1')}${num('slippageBps', 'Slippage (bps, 100=1%)', '1')}
        ${num('maxPriceImpactPct', 'Impatto prezzo max %')}${num('cooldownMin', 'Pausa dopo un token (min)', '1')}
        ${num('maxHoldMin', 'Durata max posizione (min)', '1')}${num('feeReserveSol', 'Riserva SOL commissioni')}</div>
        <p class="note">Ogni nuova operazione è con leva (min 5x) su SOL/BTC/ETH. Stop-loss e target sono calcolati sulla volatilità (ATR).</p></div>
      <div class="grp"><span class="lbl">Short (LONG + SHORT)</span>
        <div class="switch"><span>Short su SOL, BTC, ETH (Jupiter Perps, collaterale USDC)</span><span class="toggle ${c.shortsOn ? 'on' : ''}" data-t="shortsOn"></span></div>
        <div class="switch"><span>Long con leva su SOL, BTC, ETH (spento = solo short)</span><span class="toggle ${c.perpLongs ? 'on' : ''}" data-t="perpLongs"></span></div>
        <span class="field"><span>Leva perps (minimo 5x)</span></span>
        <div class="seg" id="sLev">${[5, 10].map((l) => `<button type="button" class="${(c.leverage || 5) === l ? 'on' : ''} hot" data-lev="${l}">${l}x</button>`).join('')}</div>
        <input type="hidden" data-k="leverage" value="${c.leverage || 5}">
        <div class="note" id="sLevNote"></div>
        <p class="note">Margine = ${c.maxTradePct}% del capitale (non cambia con la leva). Commissioni Jupiter: 0,06% apertura + 0,06% chiusura sull'esposizione + prestito orario (oggi ~0,0001%/h, in simulazione contiamo 0,001%/h). Lo stop-loss resta sempre entro il 40% della distanza dalla liquidazione e il bot chiude comunque all'80%; con più leva stop, prese parziali e trailing diventano più stretti. Mai un long e uno short insieme sullo stesso asset.</p>
        ${S.shorts && !S.shorts.realEnabled ? `<p class="note warnTxt">⚠️ ${esc(S.shorts.realMsg)}</p>` : ''}</div>
      <div class="grp"><span class="lbl">Uscite furbe</span>
        <div class="switch"><span>Uscite furbe (prese parziali, trailing, uscite rapide)</span><span class="toggle ${c.smartExits ? 'on' : ''}" data-t="smartExits"></span></div>
        <div class="switch"><span>Prese di profitto parziali</span><span class="toggle ${c.partialTp ? 'on' : ''}" data-t="partialTp"></span></div>
        <div class="grid2">${num('tp1R', 'Presa 1 a × stop (R)')}${num('tp1Pct', 'Presa 1: % venduta', '1')}${num('tp2R', 'Presa 2 a × stop (R)')}${num('tp2Pct', 'Presa 2: % dell\'iniziale', '1')}${num('beBufferPct', 'Pareggio dopo presa 1: +%')}${num('memeExitMult', 'Meme: distanze ×')}</div>
        <div class="switch"><span>Trailing stop</span><span class="toggle ${c.trailOn ? 'on' : ''}" data-t="trailOn"></span></div>
        <div class="grid2">${num('trailActR', 'Attiva dopo × stop (R)')}${num('trailAtrMult', 'Distanza × volatilità (ATR)')}</div>
        <div class="switch"><span>Uscita se ferma troppo a lungo</span><span class="toggle ${c.timeStopOn ? 'on' : ''}" data-t="timeStopOn"></span></div>
        <div class="grid2">${num('timeStopMin', 'Dopo minuti', '1')}${num('timeStopMinGainPct', 'Se guadagno sotto %')}</div>
        <div class="switch"><span>Uscita rapida su inversione / ondata di vendite</span><span class="toggle ${c.reversalExit ? 'on' : ''}" data-t="reversalExit"></span></div>
        <div class="grid2">${num('reversalPct', 'Crollo 5 min oltre %')}</div>
        <p class="note">R = distanza dello stop-loss iniziale (dipende dalla volatilità). Esempio: stop −4% → presa 1 a +4% vende il 40%, lo stop sale a pareggio; presa 2 a +8% vende un altro 30%; il resto segue il trailing (distanza 1,5 × ATR, mai più larga dello stop iniziale). Sui meme le distanze sono ×0,75.</p></div>
      <div class="grp"><span class="lbl">🐸 Memecoin: filtri allentati</span>
        <div class="switch"><span>Memecoin: filtri allentati (molte più memecoin di Solana/Phantom)</span><span class="toggle ${c.memeLoose ? 'on' : ''}" data-t="memeLoose"></span></div>
        <div class="grid2">${num('memeMinLiqUsd', 'Liquidità minima $', '1000')}${num('memeMinVol24hUsd', 'Volume 24h minimo $', '1000')}
        ${num('memeMinMcapUsd', 'Capitalizzazione minima $', '1000')}${num('memeMinAgeHours', 'Età minima (ore)', '1')}
        ${num('memeMaxTopHoldersPct', 'Top holder max %', '1')}${num('memeMinOrganic', 'Volume organico min (0-100)', '1')}</div>
        <p class="note">Con i filtri allentati entrano anche i token «community»/«strict» di Jupiter (non solo i verificati) e i Token-2022 senza commissioni di trasferimento, hook, delegati permanenti o blocchi. <b>Anti-truffa sempre attivi</b>: via di vendita su Jupiter (anti-honeypot), niente autorità di mint/freeze, RugCheck senza rischi gravi (punteggio ≤ ${c.maxRugScore}), tetto agli holder, niente pump > ${c.maxPump1hPct}% in 1h né crolli > ${c.maxDump24hPct}% in 24h. Le memecoin si comprano solo <b>spot 1x long</b>, ${c.maxTradePct}% per operazione, con uscite furbe; in REALE serve «Spot REALE». Le memecoin sono molto volatili: nessun guadagno garantito.</p></div>
      <div class="grp"><span class="lbl">Cripto su cui lavorano i bot</span>
        <div class="chips" style="margin-top:4px">${['SOL', 'BTC', 'ETH'].map((x) => `<span class="chip on">${x} · ${c.leverage || 5}x L/S</span>`).join('')}<span class="chip">tutte le altre · spot 1x long</span></div>
        <p class="note">I 14 bot lavorano su <b>massimo 3 cripto di focus</b> scelte dal Mentore fra tutte quelle scambiabili su Solana con Phantom/Jupiter (anche quelle nel tuo Phantom) che superano i filtri di sicurezza: verificate su Jupiter, niente autorità di mint/freeze, niente Token-2022, liquidità ≥ ${Math.round(c.uniMinLiqUsd / 1000)}k $, volume 24h ≥ ${Math.round(c.uniMinVol24hUsd / 1000)}k $, capitalizzazione ≥ ${Math.round(c.uniMinMcapUsd / 1e6)}M $, età ≥ ${c.uniMinAgeDays} giorni, RugCheck e via di vendita su Jupiter. <b>Leva e short solo su SOL, BTC, ETH</b> (Jupiter Perps, min 5x); sulle altre cripto <b>spot 1x, solo long</b>, stessa dimensione (${c.maxTradePct}%) e uscite furbe.</p>
        <div class="switch"><span>Spot 1x solo long sulle cripto senza leva</span><span class="toggle ${c.spotLongs ? 'on' : ''}" data-t="spotLongs"></span></div>
        <div class="switch"><span>Spot REALE (swap veri su Jupiter, soldi veri)</span><span class="toggle ${c.realSpot ? 'on' : ''}" data-t="realSpot" id="sRealSpot"></span></div>
        <p class="note warnTxt">In REALE lo spot compra cripto vere col wallet del bot (rispetta budget, kill switch e limiti giornalieri). È spento finché non lo accendi tu. Leva e short reali restano bloccati fino al test con 5-10 USDC.</p></div>
      <div class="grp"><span class="lbl">Rete Solana</span>${`<label class="field"><span>RPC (gratuito di default; puoi usarne uno tuo)</span><input class="in" data-k="rpcUrl" value="${esc(c.rpcUrl)}"></label>`}</div>
      <div class="btns"><button class="btn pri" id="sSave">Salva impostazioni</button></div><div class="err" id="sErr"></div>
      <div class="grp"><span class="lbl">Portafoglio del bot</span><div class="card wallet">
        <div class="kv"><span>Indirizzo</span><span class="addr">${S.wallet.exists ? esc(S.wallet.publicKey) : 'non creato'}</span></div>
        <div class="kv"><span>Stato</span><span>${S.wallet.exists ? (S.wallet.unlocked ? '🔓 sbloccato' : '🔒 bloccato') : '—'}</span></div></div>
        <label class="field"><span>Password del wallet</span><input class="in" id="sPw" type="password" placeholder="${S.wallet.exists ? 'password' : 'nuova password (min. 8)'}"></label>
        <div class="btns">${S.wallet.exists ? `<button class="btn" id="sUnlock">${S.wallet.unlocked ? 'Blocca' : 'Sblocca'}</button><button class="btn ghost" id="sExport">Esporta chiave privata…</button><button class="btn ghost" id="sWAddr">Imposta indirizzo di prelievo = Phantom collegato</button>` : '<button class="btn pri" id="sCreate">Crea wallet cifrato</button>'}</div>
        ${S.host && !S.host.persistent ? '<div class="warn">Questo server ha un disco temporaneo: a ogni riavvio i file si cancellano. Dopo aver creato il wallet premi “Backup cifrato” e incolla il testo nella variabile WALLET_ENC_JSON dell\'hosting, altrimenti perderai l\'accesso ai fondi del bot.</div>' : ''}
        ${S.wallet.exists ? '<div class="btns"><button class="btn ghost" id="sBackup">Backup cifrato (per l\'hosting)</button></div>' : ''}
        <p class="note">La chiave è cifrata sul server dove gira il bot (scrypt + AES-256-GCM) e non viene mai inviata altrove. Se perdi la password non si recupera: tieni il wallet vuoto quando non serve.</p><div class="note" id="sWOut"></div></div>
      <div class="grp"><span class="lbl">Apri da iPhone</span><div id="sLan" class="note">Carico…</div></div>
      <div class="grp"><span class="lbl">Sessione</span><div class="btns">
        <button class="btn" id="sGuide">Guida trading reale</button>
        <button class="btn" id="sRearm" ${S.killed ? '' : 'disabled'}>Riarma dopo kill switch</button>
        <button class="btn dan" id="sKill">STOP di emergenza (vendi tutto)</button>
        <button class="btn ghost" id="sReset">Nuova sessione di simulazione</button>
        <button class="btn ghost" id="sLogout">Esci</button><button class="btn ghost" data-close>Chiudi</button></div></div>`, (b) => {
      const pw = () => $('#sPw', b).value;
      const out = (t) => { $('#sWOut', b).innerHTML = t; };
      $$('.toggle', b).forEach((t) => t.addEventListener('click', () => {
        if (t.dataset.t === 'realSpot' && !t.classList.contains('on') && !window.confirm('Attivare lo spot REALE? In modalità REALE il bot comprerà cripto vere (solo long, 1x) con il wallet del bot, entro budget e limiti. Ricordati di premere Salva.')) return;
        t.classList.toggle('on');
      }));
      // selettore leva 5x / 10x (minimo 5x) con avviso rosso
      const levNote = (l) => {
        const dist = (S.shorts && S.shorts.liqDist && S.shorts.liqDist[l]) || (100 / l - 0.32);
        const n = $('#sLevNote', b); if (!n) return;
        const txt = `Con ${l}x: liquidazione a circa ${nf(dist, 1)}% di movimento contrario · stop-loss al massimo ${nf(dist * 0.4, 1)}% · chiusura forzata a ${nf(dist * 0.8, 1)}% · esposizione ${nf(c.maxTradePct * l, 0)}% del capitale.`;
        n.className = l >= 5 ? 'note levWarn' : 'note';
        n.textContent = l >= 5 ? `⚠️ Leva alta. ${txt} Un movimento di ${nf(dist, 1)}% contro di te azzera il margine: le perdite sono ${l} volte il movimento del prezzo.` : txt;
      };
      $$('#sLev button', b).forEach((x) => x.addEventListener('click', () => { $$('#sLev button', b).forEach((y) => y.classList.toggle('on', y === x)); $('[data-k="leverage"]', b).value = x.dataset.lev; levNote(Number(x.dataset.lev)); }));
      levNote(c.leverage || 5);
      $('#sSave', b).addEventListener('click', async () => {
        const patch = {}; $$('[data-k]', b).forEach((i) => { patch[i.dataset.k] = i.dataset.k === 'rpcUrl' ? i.value.trim() : Number(i.value); });
        $$('.toggle', b).forEach((t) => { patch[t.dataset.t] = t.classList.contains('on'); });
        try { await api('/api/config', patch); toast('Impostazioni salvate'); closeSheet(); } catch (e) { $('#sErr', b).textContent = e.message; }
      });
      $('#sMode', b).addEventListener('click', async () => { if (S.mode === 'REAL') { try { await api('/api/mode', { mode: 'SIM' }); toast('Modalità simulazione'); closeSheet(); } catch (e) { toast(e.message); } } else { closeSheet(); setTimeout(realGuide, 280); } });
      const on = (id, f) => { const x = $(id, b); if (x) x.addEventListener('click', async () => { try { await f(); } catch (e) { out(`<span class="red">${esc(e.message)}</span>`); } }); };
      on('#sCreate', async () => { const r = await api('/api/wallet/create', { password: pw() }); out('✅ Wallet creato: ' + esc(r.publicKey)); });
      on('#sUnlock', async () => { if (S.wallet.unlocked) { await api('/api/wallet/lock', {}); out('Wallet bloccato'); } else { await api('/api/wallet/unlock', { password: pw() }); out('✅ Sbloccato'); } });
      on('#sExport', async () => { const c2 = prompt('ATTENZIONE: chi ha questa chiave può prendere tutti i fondi del bot. Non condividerla mai.\nScrivi HO CAPITO per continuare:'); if (!c2) return; const r = await api('/api/wallet/export', { password: pw(), confirm: c2.trim() }); out(`<div class="warn">Chiave privata (base58), importabile in Phantom:<br><span class="addr" style="user-select:all">${esc(r.secret)}</span></div>`); });
      on('#sBackup', async () => { const r = await api('/api/wallet/backup', { password: pw() }); out(`<div class="warn">Backup CIFRATO (serve comunque la password per usarlo). Copialo nella variabile <b>WALLET_ENC_JSON</b>:<br><textarea class="in mono" rows="4" readonly style="font-size:11px">${esc(r.walletEncJson)}</textarea></div>`); });
      on('#sWAddr', async () => { if (!S.user.address) throw new Error('Collega prima Phantom'); await api('/api/withdraw-address', { address: S.user.address, password: pw() }); out('✅ Prelievi verso ' + esc(S.user.address)); });
      on('#sGuide', async () => { closeSheet(); setTimeout(realGuide, 280); });
      on('#sRearm', async () => { await api('/api/rearm', {}); toast('Bot riarmato'); closeSheet(); });
      on('#sKill', async () => { if (!confirm('Vendere tutte le posizioni e fermare il bot?')) return; await api('/api/kill', {}); toast('Kill switch attivato'); closeSheet(); });
      on('#sReset', async () => { if (!confirm('Azzerare la simulazione e ripartire dal budget?')) return; await api('/api/reset-sim', {}); toast('Nuova simulazione'); closeSheet(); });
      on('#sLogout', async () => { await api('/api/auth/logout', {}); location.reload(); });
      api('/api/lan').then((r) => { $('#sLan', b).innerHTML = r.urls.length ? `Con l'iPhone sulla stessa Wi-Fi apri <b class="addr">${esc(r.urls[0])}</b> in Safari, entra con il PIN, poi Condividi → <b>Aggiungi alla schermata Home</b>.${r.qr ? `<img class="qr" alt="QR" src="${r.qr}">` : ''}Per usarlo fuori casa leggi la sezione “Accesso da fuori casa” nel file LEGGIMI.` : 'Nessuna rete locale trovata.'; }).catch(() => {});
    });
  }

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  boot();
})();
