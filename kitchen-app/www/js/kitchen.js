// Tela da cozinha (TV / APK).
// - "Por horário": uma coluna por faixa de horário (ATRASADO / AGORA / EM 2H…).
// - "Resumo de produção": quanto falta de cada produto no dia (ou na faixa).
// - Toque/OK num item avança: A produzir → Fazendo → Pronto.
// - Cada ação vai para a API; o Supabase Realtime avisa as outras telas na hora.
// - Funciona com controle remoto (setas + OK) graças à navegação espacial.

/* global supabase */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const isNative = !!window.Capacitor?.isNativePlatform?.();
const LS = {
  get: (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  api: null,
  config: null,
  sb: null,
  date: null,
  slotId: null,          // filtro do resumo
  view: LS.get('k-view2', 'lanes'),
  board: null,
  newIds: new Map(),     // id -> expiração
  sound: LS.get('k-sound', '1') === '1',
  busy: false,
};

const ITEM_LABEL = { pendente: 'A PRODUZIR', em_producao: 'FAZENDO', produzido: 'PRONTO' };
const NEXT_ITEM = { pendente: 'em_producao', em_producao: 'produzido' };
const ICON = {
  store: '<path d="M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9h18M9 20v-6h6v6"/>',
  truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  soundOn: '<path d="M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  soundOff: '<path d="M11 5L6 9H3v6h3l5 4zM17 9l5 6M22 9l-5 6"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// ============================================================ utilidades
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function todayTz() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: state.config.timezone }).format(new Date());
}
function nowMinutesTz() {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: state.config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date()).split(':').map(Number);
  return h * 60 + m;
}
const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function fmtDate(iso, opts) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', ...opts }).format(new Date(Date.UTC(y, m - 1, d)));
}
function dayLabel(iso) {
  const t = todayTz();
  if (iso === t) return 'HOJE';
  if (iso === addDays(t, 1)) return 'AMANHÃ';
  if (iso === addDays(t, -1)) return 'ONTEM';
  return fmtDate(iso, { weekday: 'short', day: '2-digit', month: '2-digit' }).toUpperCase();
}
const hhmm = (t) => t?.slice(0, 5) ?? '';
const firstName = (n) => n.trim().split(/\s+/)[0];
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

let toastTimer;
function toast(msg, type = '') {
  const el = $('#ktoast');
  el.textContent = msg;
  el.className = `ktoast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

let audioCtx;
function beep(times = 2, freq = 988) {
  if (!state.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const t0 = audioCtx.currentTime + i * 0.32;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.25);
    }
  } catch { /* sem áudio */ }
}

function kconfirm(title, msg, okText = 'Confirmar') {
  return new Promise((resolve) => {
    const d = $('#kconfirm');
    $('#kconfirm-title').textContent = title;
    $('#kconfirm-msg').textContent = msg;
    $('#kconfirm-ok').textContent = okText;
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.showModal();
    $('#kconfirm-ok').focus();
  });
}

// ============================================================ API
async function apiFetch(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.sb) {
    const { data } = await state.sb.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res;
  // Sem limite de tempo, um IP errado ou bloqueado pelo firewall deixa a tela
  // presa por minutos. Com 10 s a pessoa vê o erro e pode corrigir.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    res = await fetch(`${state.api}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch {
    const e = new Error(ctrl.signal.aborted ? 'O servidor não respondeu em 10 segundos.' : 'Sem conexão com o servidor.');
    e.code = 'SEM_CONEXAO';
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error?.message || 'Erro inesperado.');
    e.status = res.status;
    e.code = json.error?.code;
    if (res.status === 401) showLogin();
    throw e;
  }
  return json;
}

// ============================================================ fluxo inicial
function resolveApiBase() {
  const saved = LS.get('k-api');
  if (saved) return saved;
  if (!isNative && /^https?:$/.test(location.protocol)) return location.origin; // servido pelo back-end (/cozinha)
  return null;
}

function showOnly(id) {
  ['#loading-view', '#setup-view', '#login-view', '#board-view'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
  setTimeout(() => $(`${id} [data-nav]`)?.focus(), 50);
}
function showSetup(msg = '') {
  $('#setup-form').api.value = LS.get('k-api', '');
  $('#setup-error').textContent = msg;
  showOnly('#setup-view');
}
function showLogin(msg = '') {
  $('#login-error').textContent = msg;
  showOnly('#login-view');
}

async function boot() {
  state.api = resolveApiBase();
  if (!state.api) return showSetup();
  $('#loading-text').textContent = `Conectando a ${state.api}…`;
  showOnly('#loading-view');
  try {
    state.config = await apiFetch('/public/config');
  } catch (e) {
    return showSetup(`Não consegui falar com ${state.api}: ${e.message} ` +
      'Confira: o servidor está ligado no computador, o IP está certo, a TV está no mesmo Wi-Fi e a porta foi liberada no firewall (opção 8 do iniciar.bat).');
  }
  state.sb = supabase.createClient(state.config.supabaseUrl, state.config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'padaria-kitchen-auth' },
  });
  const { data } = await state.sb.auth.getSession();
  if (!data.session) return showLogin();
  await startBoard();
}

let started = false;
async function startBoard() {
  try {
    // A loja vem do usuário logado: a TV só enxerga os pedidos da loja dele.
    const me = await apiFetch('/staff/me');
    if (me.license?.blocked) {
      return showLogin('A licença desta loja venceu. O administrador precisa renovar a assinatura (Atendimento → Assinatura).');
    }
    state.est = me.establishment;
    state.config.timezone = me.establishment.timezone;
    document.title = `Cozinha — ${me.establishment.name}`;
  } catch (e) {
    return showLogin(e.message);
  }
  state.date = todayTz();
  applyView();
  showOnly('#board-view');
  if (started) { subscribeRealtime(); return loadBoard(); } // re-login (talvez outra loja)
  started = true;
  keepAwake();
  subscribeRealtime();
  await loadBoard();
  setInterval(tick, 30_000); // relógio + urgência
  tick();
}

// ============================================================ dados
async function loadBoard() {
  if (state.busy) return;
  state.busy = true;
  try {
    const qs = new URLSearchParams({ date: state.date });
    if (state.view === 'summary' && state.slotId) qs.set('slot_id', state.slotId);
    state.board = await apiFetch(`/staff/kitchen/board?${qs}`);
    render();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy = false;
  }
}

let rtChannel;
let pollTimer;
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadBoard, 300);
}
function setRt(kind, text) {
  const el = $('#rt');
  el.className = `rt ${kind}`;
  el.lastElementChild.textContent = text;
}
function subscribeRealtime() {
  if (rtChannel) state.sb.removeChannel(rtChannel);
  const filter = `establishment_id=eq.${state.est.id}`;
  rtChannel = state.sb
    .channel(`cozinha-${state.est.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders', filter }, ({ new: o }) => {
      if (o.delivery_date === state.date) {
        state.newIds.set(o.id, Date.now() + 90_000);
        beep(3);
        toast(`NOVO PEDIDO #${o.code}`);
      } else {
        beep(1, 660);
        toast(`Novo pedido #${o.code} para ${dayLabel(o.delivery_date).toLowerCase()}`);
      }
      scheduleRefresh();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter }, scheduleRefresh)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setRt('online', 'Ao vivo');
        clearInterval(pollTimer); pollTimer = null;
        scheduleRefresh();
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        setRt('offline', 'Reconectando');
        pollTimer ||= setInterval(loadBoard, 15_000);
      }
    });
}

// ============================================================ ações
async function advanceItem(itemId, current, productName) {
  let next = NEXT_ITEM[current];
  if (!next) {
    const ok = await kconfirm('Desfazer?', `Voltar "${productName}" para A PRODUZIR?`, 'Desfazer');
    if (!ok) return;
    next = 'pendente';
  }
  updateItemLocally(itemId, next); // resposta imediata na TV
  try {
    await apiFetch(`/staff/order-items/${itemId}/status`, { method: 'PATCH', body: { status: next } });
  } catch (e) {
    toast(e.message, 'error');
  }
  scheduleRefresh();
}

async function markOrderReady(order) {
  const ok = await kconfirm(`Pedido #${order.code} pronto?`, 'Todos os itens serão marcados como produzidos e o atendimento será avisado.', 'Tudo pronto');
  if (!ok) return;
  try {
    await apiFetch(`/staff/orders/${order.id}/status`, { method: 'PATCH', body: { status: 'pronto' } });
    toast(`#${order.code} PRONTO`);
    beep(1, 1318);
  } catch (e) {
    toast(e.message, 'error');
  }
  scheduleRefresh();
}

function updateItemLocally(itemId, status) {
  for (const o of state.board?.orders ?? []) {
    const it = o.items.find((i) => i.id === itemId);
    if (it) {
      it.status = status;
      if (o.items.every((i) => i.status === 'produzido')) o.status = 'pronto';
      else if (o.status === 'pronto' || o.items.some((i) => i.status !== 'pendente')) o.status = 'em_producao';
      render();
      return;
    }
  }
}

// ============================================================ render: faixas
function laneInfo(slot, orders) {
  const active = orders.filter((o) => o.status !== 'pronto');
  const today = todayTz();
  if (state.date !== today) {
    const past = state.date < today;
    if (past && active.length) return { kind: 'late', tag: 'ATRASADO' };
    return { kind: past ? 'past' : 'later', tag: plural(orders.length, 'PEDIDO', 'PEDIDOS') };
  }
  const now = nowMinutesTz();
  const start = toMin(slot.start_time);
  const end = toMin(slot.end_time);
  if (now > end) {
    if (active.length) return { kind: 'late', tag: 'ATRASADO' };
    return { kind: 'past', tag: orders.length ? 'CONCLUÍDO' : 'ENCERRADO' };
  }
  if (now >= start - 30) return { kind: 'now', tag: 'AGORA' };
  const diff = start - now;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return { kind: 'later', tag: `EM ${h ? `${h}H` : ''}${h && m ? String(m).padStart(2, '0') : (h ? '' : `${m} MIN`)}` };
}

function orderCard(o) {
  const isNew = (state.newIds.get(o.id) ?? 0) > Date.now();
  return `
    <article class="ocard ${isNew ? 'is-new' : ''}">
      <div class="ohead">
        <span class="ocode">#${o.code}</span>
        <span class="owho">${isNew ? '<span class="new-flag">NOVO</span>' : ''}${svg(o.fulfillment === 'entrega' ? 'truck' : 'store')}<span>${esc(firstName(o.customer_name))}</span></span>
      </div>
      ${o.notes ? `<p class="onote">${svg('alert')}<span>${esc(o.notes)}</span></p>` : ''}
      ${o.items.map((i) => `
        <button type="button" class="item ${i.status}" data-nav data-key="i${i.id}" data-item="${i.id}" data-status="${i.status}" data-name="${esc(i.product_name)}">
          <span class="qty"><b>${i.quantity}</b><small>${esc(i.unit_label)}</small></span>
          <span class="name"><span>${esc(i.product_name)}</span>${i.notes ? `<span class="inote">${svg('alert')}${esc(i.notes)}</span>` : ''}</span>
          <span class="st">${ITEM_LABEL[i.status]}</span>
        </button>`).join('')}
      <button type="button" class="ready-btn" data-nav data-key="o${o.id}" data-ready="${o.id}">${svg('check')}Tudo pronto</button>
    </article>`;
}

function renderLanes() {
  const { orders, time_slots: slots } = state.board;
  // Com horários de 30 em 30 min a loja tem ~23 horários: mostrar todos
  // deixaria a TV ilegível. Aparecem só os horários que têm pedido no dia.
  const lanes = [];
  for (const o of orders) {
    if (lanes.some((l) => l.id === o.time_slot_id)) continue;
    const s = slots.find((x) => x.id === o.time_slot_id);
    lanes.push(s ? { ...s } : { id: o.time_slot_id, label: o.time_slot_label, start_time: o.slot_start, end_time: o.slot_start });
  }
  lanes.sort((a, b) => a.start_time.localeCompare(b.start_time));
  let late = 0;
  $('#lanes').style.setProperty('--lanes', Math.max(1, lanes.length));
  $('#lanes').innerHTML = lanes.map((l) => {
    const list = orders.filter((o) => o.time_slot_id === l.id).sort((a, b) => a.code - b.code);
    const info = laneInfo(l, list);
    const active = list.filter((o) => o.status !== 'pronto');
    const ready = list.filter((o) => o.status === 'pronto');
    if (info.kind === 'late') late += active.length;
    return `
      <section class="lane ${info.kind}" aria-label="Faixa ${esc(l.label)}">
        <header class="lane-head"><span class="lane-time">${esc(l.label)}</span><span class="lane-tag">${esc(info.tag)}</span></header>
        ${active.map(orderCard).join('')}
        ${ready.map((o) => `<div class="done-row"><span class="c">#${o.code}</span><span class="t">${o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada'} · ${esc(firstName(o.customer_name))}</span><span class="p">PRONTO</span></div>`).join('')}
        ${list.length ? '' : '<div class="lane-empty">Nada nesta faixa</div>'}
      </section>`;
  }).join('') || '<div class="lane-empty lanes-none">Nenhum pedido para produzir nesta data.</div>';
  const chip = $('#late-chip');
  chip.classList.toggle('hidden', !late);
  chip.innerHTML = `${svg('alert')}${plural(late, 'atrasado', 'atrasados')}`;
}

// ============================================================ render: resumo
function renderSummary() {
  const rows = state.board.summary;
  const pending = rows.filter((r) => r.pending_qty + r.in_progress_qty > 0);
  const done = rows.filter((r) => r.pending_qty + r.in_progress_qty === 0);
  const units = pending.reduce((s, r) => s + r.pending_qty + r.in_progress_qty, 0);
  const slots = state.board.time_slots;
  const dl = dayLabel(state.date).toLowerCase();
  $('#summary').innerHTML = `
    <div class="sum-head">
      <div><h1>Falta produzir ${state.date === todayTz() ? 'hoje' : (dl === 'amanhã' ? 'amanhã' : `em ${esc(dl)}`)}</h1>
        <p>${plural(units, 'unidade', 'unidades')} em ${plural(pending.length, 'produto', 'produtos')}${done.length ? ` · ${plural(done.length, 'concluído', 'concluídos')}` : ''}</p></div>
      <div class="slot-chips" role="group" aria-label="Faixa de horário">
        <button type="button" data-nav data-slot="" aria-pressed="${!state.slotId}">Todos</button>
        ${slots.filter((s) => String(state.slotId) === String(s.id) || state.board.orders.some((o) => o.time_slot_id === s.id))
          .map((s) => `<button type="button" data-nav data-slot="${s.id}" aria-pressed="${String(state.slotId) === String(s.id)}">${esc(hhmm(s.start_time))}</button>`).join('')}
      </div>
    </div>
    ${pending.length ? `<div class="sum-grid">${pending.map((r) => {
      const left = r.pending_qty + r.in_progress_qty;
      return `
        <article class="ptile">
          <div class="top"><h2>${esc(r.product_name)}</h2><span class="left"><b>${left}</b><small>${esc(r.unit_label)}</small></span></div>
          <div class="pbar"><span class="d" style="width:${(r.produced_qty / r.total_qty) * 100}%"></span><span class="w" style="width:${(r.in_progress_qty / r.total_qty) * 100}%"></span></div>
          <div class="pstats"><span>Total <b>${r.total_qty}</b></span><span class="g">Feito ${r.produced_qty}</span>${r.in_progress_qty ? `<span class="a">Fazendo ${r.in_progress_qty}</span>` : ''}<span>${plural(r.orders_count, 'pedido', 'pedidos')}</span></div>
          ${r.notes.length ? `<div class="pnotes">${r.notes.map((n) => `<span>${svg('alert')}${esc(n)}</span>`).join('')}</div>` : ''}
        </article>`;
    }).join('')}</div>` : `<div class="sum-empty">${rows.length ? 'Tudo produzido!' : 'Nada para produzir nesta data.'}</div>`}
    ${done.length ? `<div class="done-strip">${svg('check')}<b>Concluído:</b>${done.map((r) => `<span>${esc(r.product_name)} — ${r.total_qty} ${esc(r.unit_label)}</span>`).join('<span>·</span>')}</div>` : ''}`;
  $('#late-chip').classList.add('hidden');
}

function render() {
  if (!state.board) return;
  const focusedKey = document.activeElement?.dataset?.key;
  $('#day-label').textContent = dayLabel(state.date);
  $('#day-sub').textContent = fmtDate(state.date, { weekday: 'long', day: '2-digit', month: '2-digit' });
  if (state.view === 'lanes') renderLanes();
  else renderSummary();
  if (focusedKey) $(`[data-key="${focusedKey}"]`)?.focus({ preventScroll: true });
}

function applyView() {
  $('#lanes').classList.toggle('hidden', state.view !== 'lanes');
  $('#summary').classList.toggle('hidden', state.view !== 'summary');
  $('#khint').classList.toggle('hidden', state.view !== 'lanes');
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
}

function tick() {
  $('#clock').textContent = new Intl.DateTimeFormat('pt-BR', { timeZone: state.config.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date());
  render(); // reavalia urgência
}

function setSoundButton() {
  const b = $('#sound-btn');
  b.innerHTML = svg(state.sound ? 'soundOn' : 'soundOff');
  b.setAttribute('aria-pressed', String(state.sound));
  b.setAttribute('aria-label', state.sound ? 'Som ligado' : 'Som desligado');
  b.classList.toggle('ghost', !state.sound);
}

// ============================================================ tela sempre ligada
async function keepAwake() {
  try {
    const KA = window.Capacitor?.Plugins?.KeepAwake;
    if (KA) { await KA.keepAwake(); return; }
    if ('wakeLock' in navigator) {
      const req = () => navigator.wakeLock.request('screen').catch(() => {});
      await req();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) req(); });
    }
  } catch { /* opcional */ }
}

// ============================================================ navegação por controle remoto
function spatialMove(dir) {
  const els = $$('[data-nav]').filter((e) => e.offsetParent !== null && !e.disabled && !e.closest('.hidden'));
  const dlg = $('#kconfirm');
  const scope = dlg.open ? els.filter((e) => dlg.contains(e)) : els;
  const cur = document.activeElement;
  if (!scope.includes(cur)) { scope[0]?.focus(); return; }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of scope) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const ok = { ArrowRight: dx > 4, ArrowLeft: dx < -4, ArrowDown: dy > 4, ArrowUp: dy < -4 }[dir];
    if (!ok) continue;
    const horiz = dir === 'ArrowRight' || dir === 'ArrowLeft';
    const score = (horiz ? Math.abs(dx) : Math.abs(dy)) + (horiz ? Math.abs(dy) : Math.abs(dx)) * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// ============================================================ eventos
function bindEvents() {
  $('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let url = e.target.api.value.trim().replace(/\/+$/, '');
    // Facilita no controle remoto: "192.168.0.10:3000" vira "http://192.168.0.10:3000"
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    if (/^http:\/\/[\d.]+$/.test(url)) url += ':3000'; // só o IP: usa a porta padrão
    try { new URL(url); } catch { $('#setup-error').textContent = 'Endereço inválido. Ex.: 192.168.0.10:3000'; return; }
    LS.set('k-api', url);
    boot();
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    const { error } = await state.sb.auth.signInWithPassword({ email: e.target.email.value.trim(), password: e.target.password.value });
    if (error) { $('#login-error').textContent = 'E-mail ou senha incorretos.'; return; }
    startBoard();
  });
  $('#change-server').addEventListener('click', () => { LS.del('k-api'); showSetup(); });
  $('#loading-change').addEventListener('click', () => showSetup());

  $('#board-view').addEventListener('click', (e) => {
    const item = e.target.closest('[data-item]');
    if (item) return advanceItem(Number(item.dataset.item), item.dataset.status, item.dataset.name);
    const ready = e.target.closest('[data-ready]');
    if (ready) return markOrderReady(state.board.orders.find((o) => o.id === ready.dataset.ready));
    const day = e.target.closest('[data-day]');
    if (day) { state.date = addDays(state.date, Number(day.dataset.day)); return loadBoard(); }
    const slot = e.target.closest('[data-slot]');
    if (slot) { state.slotId = slot.dataset.slot || null; return loadBoard(); }
    const view = e.target.closest('[data-view]');
    if (view) { state.view = view.dataset.view; LS.set('k-view2', state.view); applyView(); return loadBoard(); }
  });

  $('#sound-btn').addEventListener('click', () => {
    state.sound = !state.sound;
    LS.set('k-sound', state.sound ? '1' : '0');
    setSoundButton();
    if (state.sound) beep(1); // primeiro gesto destrava o áudio
  });

  $('#menu-btn').addEventListener('click', async () => {
    if (await kconfirm('Sair da tela da cozinha?', 'Será necessário fazer login novamente.', 'Sair')) {
      await state.sb.auth.signOut();
      location.reload();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (e.target.tagName === 'INPUT' && ['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      spatialMove(e.key);
    }
  });

  // Botão "voltar" do Android: fecha diálogo em vez de sair do app
  window.Capacitor?.Plugins?.App?.addListener?.('backButton', () => {
    const d = $('#kconfirm');
    if (d.open) d.close('cancel');
  });

  window.addEventListener('online', scheduleRefresh);
}

bindEvents();
setSoundButton();
boot();
