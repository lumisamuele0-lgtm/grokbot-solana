/* GrokBot Solana — interfaccia (mobile first). Tutti i dati arrivano dal motore locale via SSE. */
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

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sb': '1' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { showLogin(); throw new Error(j.error || 'Accesso richiesto'); }
    if (!r.ok) throw new Error(j.error || 'Errore ' + r.status);
    return j;
  }
  function toast(msg, ms = 3200) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), ms); }
  function show(id) { ['login', 'setup', 'dash'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id)); $('#nav').classList.toggle('hidden', id !== 'dash'); window.scrollTo(0, 0); }

  // ---------- accesso
  let setupMode = false;
  async function boot() {
    let st;
    try { st = await (await fetch('/api/auth/status')).json(); } catch { $('#loginErr').textContent = 'Server non raggiungibile'; show('login'); return; }
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
    buildAgents();
    if (!window.__sceneInit) { window.__sceneInit = 1; Scene.init($('#scene'), onBotTap); }
    if (!localStorage.getItem('sb_started')) openSetup(false); else { show('dash'); }
    render(S);
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
  function tween(key, el, target, fmt) {
    const o = tw[key] || (tw[key] = { v: target, from: target, to: target, t0: 0 });
    if (target == null || !isFinite(target)) { el.textContent = '—'; return; }
    if (o.to !== target) { o.from = o.v; o.to = target; o.t0 = performance.now(); }
    o.el = el; o.fmt = fmt;
  }
  (function tick(now) {
    for (const o of Object.values(tw)) {
      if (!o.el) continue;
      const p = Math.min(1, (now - o.t0) / 900), e = 1 - Math.pow(1 - p, 3);
      o.v = o.from + (o.to - o.from) * e;
      const s = o.fmt(o.v); if (o.el.textContent !== s) o.el.textContent = s;
    }
    requestAnimationFrame(tick);
  })(0);

  // ---------- sparkline
  let sparkP = 0;
  function drawSpark() {
    const c = $('#spark'); if (!c || !S) return;
    const r = c.getBoundingClientRect(); const dpr = Math.min(2.5, devicePixelRatio || 1);
    if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
    let pts = (S.equityHist || []).map((p) => p.v); if (S.equity != null) pts = pts.concat([S.equity]);
    if (pts.length < 2) pts = [S.startEquity, S.equity ?? S.startEquity];
    let mn = Math.min(...pts), mx = Math.max(...pts); if (mx - mn < Math.abs(mx) * 1e-4) { mn -= Math.abs(mx) * 0.001 + 1e-9; mx += Math.abs(mx) * 0.001 + 1e-9; } const sp = mx - mn;
    const W = r.width, H = r.height, pad = 8;
    const P = pts.map((v, i) => [pad + (i / (pts.length - 1)) * (W - pad * 2), H - pad - ((v - mn) / sp) * (H - pad * 2)]);
    sparkP = Math.min(1, sparkP + 0.025);
    const n = Math.max(2, Math.ceil(P.length * sparkP));
    const up = pts[pts.length - 1] >= pts[0]; const col = up ? '#00FF88' : '#ff5a6a';
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, up ? '#00FF8833' : '#ff5a6a33'); g.addColorStop(1, '#00000000');
    x.beginPath(); P.slice(0, n).forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b)));
    const [lx, ly] = P[n - 1];
    x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = 'round'; x.shadowColor = col; x.shadowBlur = 8; x.stroke(); x.shadowBlur = 0;
    x.lineTo(lx, H); x.lineTo(P[0][0], H); x.closePath(); x.fillStyle = g; x.fill();
    const pulse = 3 + Math.sin(performance.now() / 300) * 1.2;
    x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 16; x.beginPath(); x.arc(lx, ly, pulse, 0, 6.28); x.fill(); x.shadowBlur = 0;
    requestAnimationFrame(drawSpark);
  }

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
    $('#pbSub').textContent = `${fSol(sol(tot))} · ${sgn(pct)}${nf(Math.abs(pct), 2)}%${s.equityEur != null ? ' · ' + (s.pnlEur >= 0 ? '+' : '−') + eur(Math.abs(s.pnlEur)) : ''}`;
    const cell = (id, v) => { const el = $(id); el.textContent = fmt(v); el.className = v > 0 ? 'mint' : v < 0 ? 'red' : ''; };
    cell('#pbDay', pb.day); cell('#pbReal', pb.realized); cell('#pbOpen', pb.unrealized);
    const closed = s.wins + s.losses;
    $('#pbWL').innerHTML = `<span class="mint">${s.wins}</span> / <span class="red">${s.losses}</span>${closed ? ` <small class="mu">${nf(s.winRate, 0)}%</small>` : ''}`;
    $('#pbGW').textContent = 'guadagni ' + fmt(pb.grossWin || 0);
    $('#pbGL').textContent = 'perdite ' + fmt(pb.grossLoss || 0);
    $('#pbDayWL').textContent = `oggi ${pb.dayWins || 0}✓ ${pb.dayLosses || 0}✗`;
    pbLive.push({ t: s.t || Date.now(), v: tot }); if (pbLive.length > 400) pbLive.shift();
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
  let lastKnH = '';
  function renderKnowledge(s) { const h = knowledgeHtml(s.knowledge, false); if (h !== lastKnH) { lastKnH = h; $('#know').innerHTML = h; } }

  // ---------- agenti
  function buildAgents() {
    $('#agents').innerHTML = S.agents.map((a) => `
      <button class="ag" data-id="${a.id}">
        <span class="ic" style="background:${a.color};color:${a.color}">${ICONS[a.icon] || ''}</span>
        <span class="tx"><div class="nm">${a.id}<small>${esc(a.role)}</small></div><div class="act" data-act>in attesa…</div></span>
        <span class="cnt" data-cnt>0</span>
      </button>`).join('');
    $('#agN').textContent = S.agents.length;
    $('#agents').addEventListener('click', (e) => { const b = e.target.closest('.ag'); if (b) agentSheet(b.dataset.id); });
    $('#know').addEventListener('click', () => agentSheet('MENTORE'));
  }
  const lastAct = {};
  function renderAgents() {
    for (const a of S.agents) {
      const row = $(`.ag[data-id="${a.id}"]`); if (!row) continue;
      const txt = a.last ? a.last.text : 'in attesa…';
      const el = row.querySelector('[data-act]');
      if (lastAct[a.id] !== txt) { el.textContent = txt; if (lastAct[a.id] !== undefined) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } lastAct[a.id] = txt; }
      row.querySelector('[data-cnt]').textContent = `${a.count} ${a.unit}`;
      row.querySelector('.ic').classList.toggle('busy', !!(a.last && Date.now() - a.last.t < 4000));
    }
  }
  function onBotTap(id, x, y) {
    $$('.bubble').forEach((b) => b.remove());
    if (!id) return;
    const a = S.agents.find((z) => z.id === id); if (!a) return;
    const d = document.createElement('div'); d.className = 'bubble';
    const box = $('#sceneBox').getBoundingClientRect();
    d.style.left = Math.max(125, Math.min(box.width - 125, x)) + 'px'; d.style.top = Math.max(70, y) + 'px';
    d.innerHTML = `<b style="color:${a.color}">${a.id} · ${esc(a.role)}</b>${esc(a.last ? a.last.text : 'In attesa di lavoro…')}<small>${a.count} ${a.unit}${a.last ? ' · ' + hhmm(a.last.t) : ''} · tocca per dettagli</small>`;
    d.addEventListener('click', () => { d.remove(); agentSheet(id); });
    $('#sceneBox').appendChild(d);
    setTimeout(() => d.remove(), 7000);
  }
  function agentSheet(id) {
    const draw = () => {
      const a = S.agents.find((z) => z.id === id);
      const lines = S.log.filter((l) => l.agent === id).slice(-12).reverse();
      return `<div class="row"><span class="ic" style="width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:${a.color}">${ICONS[a.icon]}</span><div><h4>${a.id}</h4><div class="mu" style="font-size:13px">${esc(a.role)} · ${a.count} ${a.unit}</div></div></div>
      ${id === 'MENTORE' ? `<div class="card know" style="margin-top:14px">${knowledgeHtml(S.knowledge, true)}</div>` : ''}
      <div class="card" style="margin-top:14px"><div class="lbl">Decisione attuale</div><div style="margin-top:6px;font-size:15px;line-height:1.45">${esc(a.last ? a.last.text : 'In attesa…')}</div></div>
      <div class="grp"><span class="lbl">Ultime azioni</span><div class="console mono" style="height:auto;max-height:260px">${lines.map(logLine).join('') || '<div>nessuna azione registrata</div>'}</div></div>
      <div class="btns"><button class="btn ghost" data-close>Chiudi</button></div>`;
    };
    openSheet(draw, null, true);
  }

  // ---------- eventi live
  function onEv(e) {
    Scene.event(e);
    if (e.type === 'log') appendLog(e);
    if (e.type === 'agent' && e.agent === 'CAPO' && e.token && S) {
      const w = (S.watch || []).find((x) => x.symbol === e.token);
      if (w) fetch('/api/candles?mint=' + w.mint).then((r) => r.json()).then((c) => Scene.setScreen(e.token, c.slice(-90).map((k) => k.c), e.action === 'pick' ? 'SEGNALE LONG' : 'in analisi')).catch(() => {});
    }
    if (e.type === 'trade') toast(e.side === 'BUY' ? `🟢 Comprato $${e.symbol}${e.mode === 'SIM' ? ' (simulato)' : ''}` : `${(e.pnl || 0) >= 0 ? '💰' : '🔻'} Venduto $${e.symbol} · ${(e.pnl >= 0 ? '+' : '') + nf(e.pnl, S && S.base === 'SOL' ? 4 : 2)} ${S ? S.base : ''}`);
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

  // ---------- render dashboard
  let firstRender = true;
  function render(s) {
    if (!s) return;
    const real = s.mode === 'REAL';
    $('#modePill').textContent = real ? 'REALE · SOLDI VERI' : 'SIMULAZIONE · paper su dati live';
    $('#modePill').classList.toggle('real', real);
    $('#demoPill').classList.toggle('hidden', !(s.host && s.host.demo));
    const lv = $('#live'); lv.classList.toggle('off', !s.live); lv.lastChild.textContent = s.live ? 'LIVE' : 'DATI IN ATTESA';
    $('#hSol').textContent = real ? `◎ ${nf(s.wallet.balances ? s.wallet.balances.sol : null, 4)}` : `◎ ${nf(s.solReserve, 4)} sim`;
    $('#hSolPx').textContent = `SOL ${s.solUsd ? nf(s.solUsd, 2) + ' $' : '—'}`;
    const rate = s.equityEur != null && s.equity ? s.equityEur / s.equity : null;
    $('#heroLbl').textContent = real ? 'Saldo di trading del bot' : 'Saldo simulato';
    tween('bal', $('#bal'), s.equityEur, eur);
    const pe = s.pnlEur; const pct = s.startEquity > 0 ? (s.pnl / s.startEquity) * 100 : 0;
    tween('pl', $('#pl'), pe, (v) => `${v >= 0 ? '+ ' : '− '}${eur(Math.abs(v))} (${nf(pct, 1)}%)`);
    $('#pl').className = pe >= 0 ? 'mint' : 'red';
    $('#roi').textContent = nf(s.roi, 2) + 'x'; $('#roi').classList.toggle('neg', s.roi < 1);
    $('#heroMeta').textContent = `${nf(s.equity, s.base === 'SOL' ? 4 : 2)} ${s.base} · vincenti ${s.winRate == null ? '—' : nf(s.winRate, 0) + '%'} (${s.wins}/${s.wins + s.losses}) · commissioni ${nf(s.fees, s.base === 'SOL' ? 5 : 3)} ${s.base}`;
    const kb = $('#killBox'); kb.classList.toggle('hidden', !s.killed);
    if (s.killed) kb.innerHTML = `<b>Kill switch attivo.</b> ${esc(s.killReason || '')}<br>Il bot ha venduto tutto e si è fermato. Per ripartire: Impostazioni → Riarma.`;
    tween('sA', $('#sA'), s.counters.analyzed, (v) => Math.round(v).toLocaleString('it-IT'));
    tween('sR', $('#sR'), s.counters.rejected, (v) => Math.round(v).toLocaleString('it-IT'));
    tween('sO', $('#sO'), s.counters.approved, (v) => Math.round(v).toLocaleString('it-IT'));
    renderAgents();
    renderPnl(s);
    renderKnowledge(s);
    if (firstRender) { $('#console').innerHTML = s.log.map(logLine).join(''); lastLogT = s.log.length ? s.log[s.log.length - 1].t : 0; $('#console').scrollTop = 1e9; firstRender = false; requestAnimationFrame(drawSpark); }
    // regole
    const rules = Object.entries(s.counters.rules).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const max = rules.length ? rules[0][1] : 1;
    const rh = rules.map(([k, v]) => `<div class="rule"><div class="rl"><span>${esc(k)}</span><b>${v}</b></div><div class="rb"><i style="width:${(v / max) * 100}%"></i></div></div>`).join('') || '<div class="empty">ancora nessuno scarto</div>';
    if ($('#rules').dataset.h !== rh) { const old = $('#rules').innerHTML; $('#rules').dataset.h = rh; $('#rules').innerHTML = rh.replace(/width:[\d.]+%/g, (m) => (old ? m : 'width:0%')); if (!old) requestAnimationFrame(() => { $('#rules').innerHTML = rh; }); }
    // posizioni
    const d = s.base === 'SOL' ? 4 : 2;
    $('#posN').textContent = `${s.positions.length} / ${s.cfg.maxOpen}`;
    $('#pos').innerHTML = s.positions.map((p) => {
      const span = p.tp - p.sl; const k = span > 0 && p.price ? Math.max(0, Math.min(1, (p.price - p.sl) / span)) : 0.5;
      return `<div class="pcard"><div><div class="sym">$${esc(p.symbol)}</div><div class="sub2">ingresso ${nf(p.costBase, d)} ${s.base} · ${hhmm(p.openedAt)}${p.sigOpen ? ` · <a href="https://solscan.io/tx/${p.sigOpen}" target="_blank" rel="noopener">tx</a>` : ''}</div></div>
      <div class="pnl ${p.pnl >= 0 ? 'mint' : 'red'}">${p.pnl >= 0 ? '+' : ''}${nf(p.pnl, d)}<div class="sub2">${nf(p.pnlPct, 2)}%</div></div>
      <div class="rng" title="stop → target"><i style="left:calc(${k * 100}% - 1px)"></i></div>
      <div class="sub2">stop −${nf(p.slPct, 1)}%</div><div class="sub2" style="text-align:right">target +${nf(p.tpPct, 1)}% <button class="chip" data-closepos="${p.id}" style="margin-left:6px;padding:3px 8px">Chiudi</button></div></div>`;
    }).join('') || '<div class="empty">Nessuna posizione aperta: i bot entrano solo quando tutte le regole sono rispettate.</div>';
    $('#histN').textContent = s.trades.length ? `${s.trades.length} chiuse` : '';
    $('#hist').innerHTML = s.trades.length ? `<table class="h">${s.trades.slice(0, 25).map((t) => `<tr><td>${hhmm(t.closedAt)}</td><td><b>$${esc(t.symbol)}</b><div class="mu" style="font-size:11px">${esc(t.reason)}</div></td><td class="r ${t.pnl >= 0 ? 'mint' : 'red'}">${t.pnl >= 0 ? '+' : ''}${nf(t.pnl, d)}<div style="font-size:11px">${nf(t.pnlPct, 2)}%</div></td><td class="r">${t.sigClose ? `<a href="https://solscan.io/tx/${t.sigClose}" target="_blank" rel="noopener">tx</a>` : '<span class="mu">sim</span>'}</td></tr>`).join('')}</table>` : '<div class="empty">Ancora nessuna operazione chiusa.</div>';
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
    // nav
    const run = $('#navRun'); run.classList.toggle('on', s.trading);
    run.innerHTML = s.trading ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg><span>Pausa</span>' : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span>Avvia</span>';
    $('#navPh').textContent = s.user.address ? short(s.user.address).slice(0, 6) : 'Phantom';
    Scene.setState(s);
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
  }
  function closeSheet() { sheetRefresh = null; $('#sheet').classList.remove('open'); $('#sheetBg').classList.remove('open'); setTimeout(() => $('#sheetBg').classList.add('hidden'), 250); }
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

  // ---------- azioni della barra
  $('#nav').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'phantom') { if (S.user.address && provider()) phantomSheet(); else if (S.user.address) phantomSheet(); else await connectPhantom(); }
      if (a === 'budget') openSetup(true);
      if (a === 'deposit') depositSheet();
      if (a === 'toggle') { await api('/api/trading', { on: !S.trading }); toast(S.trading ? 'Bot in pausa' : 'Bot avviati'); }
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
    const core = [['SOL', 'So11111111111111111111111111111111111111112'], ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'], ['BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'], ['WIF', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'], ['JTO', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'], ['PYTH', 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'], ['RAY', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'], ['POPCAT', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr']];
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
        <p class="note">Solo spot (leva 1x): nessuna leva sui fondi reali. Stop-loss e target sono calcolati sulla volatilità (ATR).</p></div>
      <div class="grp"><span class="lbl">Token</span>
        <div class="switch"><span>Scansiona meme coin (DexScreener)</span><span class="toggle ${c.scanMemes ? 'on' : ''}" data-t="scanMemes"></span></div>
        <div class="chips" id="sToks" style="margin-top:10px">${core.map(([s, m]) => `<button class="chip ${c.tokens.includes(m) ? 'on' : ''}" data-m="${m}">${s}</button>`).join('')}${custom.map((m) => `<button class="chip on" data-m="${m}">${short(m)}</button>`).join('')}</div>
        <label class="field"><span>Aggiungi token (indirizzo mint)</span><input class="in" id="sMint" placeholder="es. 7GCi…"></label>
        <div class="grid2">${num('minLiquidityUsd', 'Liquidità min ($)', '1000')}${num('minVolume24hUsd', 'Volume 24h min ($)', '1000')}${num('minPairAgeMin', 'Età min creazione token (minuti)', '1')}${num('maxRugScore', 'RugCheck max (0–100)', '1')}${num('minMcapUsd', 'Market cap min meme ($)', '1000')}${num('maxPump1hPct', 'Scarta se +% in 1h oltre')}</div></div>
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
      $$('.toggle', b).forEach((t) => t.addEventListener('click', () => t.classList.toggle('on')));
      $('#sToks', b).addEventListener('click', (e) => { const x = e.target.closest('.chip'); if (x) x.classList.toggle('on'); });
      $('#sSave', b).addEventListener('click', async () => {
        const patch = {}; $$('[data-k]', b).forEach((i) => { patch[i.dataset.k] = i.dataset.k === 'rpcUrl' ? i.value.trim() : Number(i.value); });
        $$('.toggle', b).forEach((t) => { patch[t.dataset.t] = t.classList.contains('on'); });
        patch.tokens = $$('#sToks .chip.on', b).map((x) => x.dataset.m); const nm = $('#sMint', b).value.trim(); if (nm) patch.tokens.push(nm);
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
