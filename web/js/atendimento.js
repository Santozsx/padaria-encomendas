// Tela de atendimento: quadro de pedidos em tempo real, detalhe, vendas e produtos.
import {
  api, money, esc, toast, dateBr, timeBr, phoneBr, statusBadge, confirmDialog, debounce,
  STATUS, ITEM_STATUS, icon, hydrateIcons, norm, CATEGORY_TILES,
  licenseBadge, licenseText, dateFull,
} from './common.js';
import { createSupabase, watchOrders, beep } from './realtime.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const ACTIVE = ['recebido', 'em_producao', 'pronto'];
const ROLE_LABEL = { admin: 'Administração', atendimento: 'Atendimento', cozinha: 'Cozinha' };
const LANES = [
  { status: 'recebido', title: 'Recebido', color: '#2B5F9E' },
  { status: 'em_producao', title: 'Em produção', color: '#C98A1B' },
  { status: 'pronto', title: 'Pronto', color: '#2F7D4A' },
  { status: 'entregue', title: 'Entregue', color: '#6B7A7D' },
];
const STATUS_COLORS = { recebido: '#2B5F9E', em_producao: '#C98A1B', pronto: '#2F7D4A', entregue: '#6B7A7D', cancelado: '#B3261E' };

const state = {
  config: null,
  sb: null,
  staff: null,
  isAdmin: false,
  team: [],
  tab: 'orders',
  view: localStorage.getItem('padaria-view') || 'board',
  range: 'today',
  orders: [],
  slots: new Map(),               // time_slot_id -> { start_time, end_time }
  statusFilter: new Set(ACTIVE),  // usado na Lista
  newIds: new Set(),
  openOrderId: null,
  products: null,
  productCat: 'all',
  report: null,
  reportPage: 0,
  license: null,
  locked: false,   // licença vencida: admin só acessa "Assinatura"
  billing: null,
};

// ============================================================ helpers
function todayTz() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: state.config.timezone }).format(new Date());
}
function nowMinutes() {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: state.config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date()).split(':').map(Number);
  return h * 60 + m;
}
const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
async function token() {
  const { data } = await state.sb.auth.getSession();
  return data.session?.access_token;
}
async function staffApi(path, opts = {}) {
  try {
    return await api(`/staff${path}`, { ...opts, token: await token() });
  } catch (e) {
    if (e.status === 401 && state.staff) await logout();
    throw e;
  }
}
function parsePriceToCents(text) {
  let s = String(text).trim().replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Situação do horário: late | now | later | ok | off */
function urgency(o) {
  if (o.status === 'pronto') return 'ok';
  if (!ACTIVE.includes(o.status)) return 'off';
  const today = todayTz();
  if (o.delivery_date < today) return 'late';
  if (o.delivery_date > today) return 'later';
  const slot = state.slots.get(o.time_slot_id);
  const start = toMin(o.slot_start);
  const end = slot ? toMin(slot.end_time) : start + 180;
  const now = nowMinutes();
  if (now > end) return 'late';
  if (now >= start - 60) return 'now';
  return 'later';
}

// ============================================================ autenticação
async function login(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  $('#login-error').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const { error } = await state.sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) {
      $('#login-error').textContent = /confirm/i.test(error.message)
        ? 'E-mail ainda não confirmado. Crie o usuário pela opção 3 do iniciar.bat.'
        : 'E-mail ou senha incorretos.';
      return;
    }
    await enterApp();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function logout() {
  await state.sb.auth.signOut();
  location.reload();
}

async function enterApp() {
  try {
    state.staff = await staffApi('/me');
  } catch (e) {
    await state.sb.auth.signOut();
    $('#login-error').textContent = e.message;
    $('#login-view').classList.remove('hidden');
    return;
  }
  if (state.staff.role === 'cozinha') {
    $('#login-error').textContent = 'Este usuário é da cozinha. Use a tela da cozinha.';
    await state.sb.auth.signOut();
    state.staff = null;
    $('#login-view').classList.remove('hidden');
    return;
  }
  const est = state.staff.establishment;
  state.license = state.staff.license ?? null;
  if (state.license?.blocked && state.staff.role !== 'admin') {
    $('#login-view').classList.add('hidden');
    $('#blocked-view').classList.remove('hidden');
    return;
  }
  state.locked = Boolean(state.license?.blocked);
  state.config = { storeName: est.name, timezone: est.timezone, slug: est.slug, address: est.address, phone: est.phone };
  try {
    const slots = await staffApi('/time-slots');
    state.slots.clear();
    slots.forEach((s) => state.slots.set(s.id, s));
  } catch { /* sem horários: a lista mostra só a data */ }
  $('#store-name').textContent = est.name;
  document.title = `Atendimento — ${est.name}`;
  $('#store-link').value = `/loja/${est.slug}`;
  $('#store-link').dataset.url = `${location.origin}/loja/${est.slug}`;
  $('#store-link-open').href = `/loja/${est.slug}`;
  $('#platform-link').classList.toggle('hidden', !state.staff.isPlatformAdmin);

  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-name').textContent = state.staff.name;
  // e-mail junto do papel: deixa claro com qual conta (e loja) você entrou
  $('#user-role').textContent = `${ROLE_LABEL[state.staff.role] || ''} · ${state.staff.email}`;
  $('#user-role').title = state.staff.email;
  state.isAdmin = state.staff.role === 'admin';
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !state.isAdmin));
  $$('.nav-item[data-tab]').forEach((b) => b.classList.toggle('locked', state.locked && b.dataset.tab !== 'billing'));
  if (state.locked) {
    $('#rt-status').lastElementChild.textContent = 'Pausado (licença vencida)';
    state.tab = 'billing';
    showTab('billing');
    tickClock();
    return; // sem tempo real nem pedidos até renovar
  }
  $('#sound-toggle').checked = localStorage.getItem('padaria-sound') === '1';
  setView(state.view);
  placeLicenseBanner();

  watchOrders(state.sb, {
    establishmentId: est.id,
    onChange: refreshVisible,
    onStatus: (s) => {
      const el = $('#rt-status');
      el.className = `rt ${s}`;
      el.lastElementChild.textContent = s === 'online' ? 'Tempo real conectado' : 'Reconectando…';
    },
    onNewOrder: (o) => {
      state.newIds.add(o.id);
      toast(`Novo pedido #${o.code} — ${o.customer_name}`, 'ok', 6000);
      if ($('#sound-toggle').checked) beep({ freq: 880, times: 2 });
    },
  });
  setReportPeriod('7d');
  tickClock();
  setInterval(() => { tickClock(); if (state.tab === 'orders') renderOrders(); }, 60_000);
}

function tickClock() {
  const opts = (o) => new Intl.DateTimeFormat('pt-BR', { timeZone: state.config.timezone, ...o }).format(new Date());
  $('#now-label').textContent = `${opts({ weekday: 'long' })} · ${opts({ day: '2-digit', month: '2-digit' })} · ${opts({ hour: '2-digit', minute: '2-digit' })}`;
}

// ============================================================ navegação
function showTab(tab) {
  if (['sales', 'team', 'billing'].includes(tab) && !state.isAdmin) tab = 'orders'; // só administradores
  if (state.locked && tab !== 'billing') {
    toast('A licença venceu. Renove a assinatura para liberar o sistema.', 'error');
    tab = 'billing';
  }
  state.tab = tab;
  $$('.nav-item[data-tab]').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $$('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
  placeLicenseBanner();
  refreshVisible();
}

function refreshVisible() {
  if (state.tab === 'orders') loadOrders();
  if (state.tab === 'sales') loadReport();
  if (state.tab === 'products') loadProducts();
  if (state.tab === 'team') loadTeam();
  if (state.tab === 'billing') loadBilling();
  if (state.openOrderId) openOrder(state.openOrderId, { silent: true });
}

function setView(v) {
  state.view = v;
  localStorage.setItem('padaria-view', v);
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('#status-chips').classList.toggle('hidden', v !== 'list');
  if (state.orders.length || v) renderOrders();
}

// ============================================================ pedidos
function rangeDates() {
  const t = todayTz();
  switch (state.range) {
    case 'today': return { from: t, to: t };
    case 'tomorrow': return { from: addDays(t, 1), to: addDays(t, 1) };
    case 'week': return { from: t, to: addDays(t, 7) };
    case 'open': return { from: addDays(t, -30) };
    case 'custom': return { from: $('#f-from').value || t, to: $('#f-to').value || undefined };
    default: return {};
  }
}
const RANGE_LABEL = {
  today: 'Pedidos para hoje', tomorrow: 'Pedidos para amanhã', week: 'Pedidos nos próximos 7 dias',
  open: 'Pedidos em aberto', custom: 'Pedidos no período',
};

async function loadOrders() {
  const params = new URLSearchParams({ limit: '500', ...rangeDates() });
  if (state.range === 'open') params.set('status', ACTIVE.join(','));
  const ful = $('#f-fulfillment').value;
  const q = $('#f-q').value.trim();
  if (ful) params.set('fulfillment', ful);
  if (q) params.set('q', q);
  try {
    state.orders = await staffApi(`/orders?${params}`);
    renderOrders();
  } catch (e) {
    $('#orders-board').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function renderKpis() {
  const valid = state.orders.filter((o) => o.status !== 'cancelado');
  const late = state.orders.filter((o) => urgency(o) === 'late');
  const ready = state.orders.filter((o) => o.status === 'pronto');
  const delivered = state.orders.filter((o) => o.status === 'entregue');
  const sum = valid.reduce((s, o) => s + Number(o.total_cents), 0);
  const open = state.orders.filter((o) => ACTIVE.includes(o.status)).length;
  $('#open-count').textContent = open || '';
  $('#kpis').innerHTML = `
    <div class="kpi"><span class="label">${RANGE_LABEL[state.range]}</span><span class="value">${valid.length}</span><span class="sub">${money(sum)} em encomendas</span></div>
    <div class="kpi ${late.length ? 'bad' : ''}"><span class="label">Atrasados</span><span class="value">${late.length}</span><span class="sub">${late.length ? 'O horário combinado já passou' : 'Tudo dentro do horário'}</span></div>
    <div class="kpi good"><span class="label">Aguardando retirada/entrega</span><span class="value">${ready.length}</span><span class="sub">Prontos na loja</span></div>
    <div class="kpi"><span class="label">Entregues</span><span class="value">${delivered.length}</span><span class="sub">de ${plural(valid.length, 'pedido', 'pedidos')}</span></div>`;
}

function slotTag(o, multiDay) {
  const u = urgency(o);
  let label = o.time_slot_label;
  if (u === 'late') label += ' · atrasado';
  else if (u === 'now') label += ' · agora';
  if (multiDay && o.delivery_date !== todayTz()) label = `${dateBr(o.delivery_date, false).slice(0, 5)} · ${label}`;
  return `<span class="slot-tag ${u}">${esc(label)}</span>`;
}

function quickAction(o) {
  if (o.status === 'recebido') return `<button type="button" class="quick" data-quick="em_producao">Iniciar produção</button>`;
  if (o.status === 'em_producao') return `<button type="button" class="quick" data-quick="pronto">Tudo pronto</button>`;
  if (o.status === 'pronto') return `<button type="button" class="quick primary" data-quick="entregue">${o.fulfillment === 'entrega' ? 'Saiu p/ entrega' : 'Entregar'}</button>`;
  return '';
}

function orderCard(o, multiDay) {
  const total = o.items.length;
  const done = o.items.filter((i) => i.status === 'produzido').length;
  const notes = [o.notes, ...o.items.map((i) => i.notes)].filter(Boolean);
  return `
    <article class="ocard ${urgency(o) === 'late' ? 'late' : ''} ${state.newIds.has(o.id) ? 'is-new' : ''}" data-order="${o.id}">
      <div class="row1"><button type="button" class="code" data-open="${o.id}">#${o.code}</button>${slotTag(o, multiDay)}</div>
      <div class="who">${icon(o.fulfillment === 'entrega' ? 'truck' : 'store', { size: 16 })}<b>${esc(o.customer_name)}</b><span class="muted">· ${o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada'}</span></div>
      <div class="items">${o.items.map((i) => `${i.quantity}× ${esc(i.product_name)}`).join(' · ')}</div>
      ${notes.length ? `<span class="note-tag">${icon('alert', { size: 13, stroke: 2.2 })}${esc(notes[0])}${notes.length > 1 ? ` (+${notes.length - 1})` : ''}</span>` : ''}
      ${o.status === 'em_producao' ? `<div class="prog-row"><div class="prog"><i style="width:${Math.max(6, (done / total) * 100)}%"></i></div><span>${done} de ${plural(total, 'item', 'itens')}</span></div>` : ''}
      <div class="row3"><strong>${money(o.total_cents)}</strong>${quickAction(o)}</div>
    </article>`;
}

function renderOrders() {
  if (!state.config) return;
  renderKpis();
  const multiDay = !['today', 'tomorrow'].includes(state.range);
  if (state.view === 'board') renderBoard(multiDay);
  else renderList(multiDay);
  setTimeout(() => state.newIds.clear(), 3000);
}

function sortBySchedule(a, b) {
  return a.delivery_date.localeCompare(b.delivery_date) || a.slot_start.localeCompare(b.slot_start) || a.code - b.code;
}

function renderBoard(multiDay) {
  const cancelled = state.orders.filter((o) => o.status === 'cancelado').length;
  const lanes = LANES.map((l) => {
    const cards = state.orders.filter((o) => o.status === l.status).sort(sortBySchedule);
    const empty = l.status === 'entregue' ? 'Nenhum pedido entregue ainda' : 'Nenhum pedido aqui';
    return `
      <section class="lane" aria-label="${l.title}">
        <header class="lane-head"><span><i style="background:${l.color}"></i>${l.title}</span><span class="n">${cards.length}</span></header>
        ${cards.length ? cards.map((o) => orderCard(o, multiDay)).join('') : `<div class="lane-empty">${icon('check', { size: 26, stroke: 1.6 })}${empty}</div>`}
      </section>`;
  }).join('');
  $('#orders-board').innerHTML = `<div class="board">${lanes}</div>
    ${cancelled ? `<p class="board-foot">${plural(cancelled, 'pedido cancelado', 'pedidos cancelados')} neste período — veja na visualização em <button type="button" class="btn sm ghost" data-view="list">Lista</button></p>` : ''}`;
}

function renderList(multiDay) {
  const counts = Object.fromEntries(Object.keys(STATUS).map((s) => [s, 0]));
  state.orders.forEach((o) => counts[o.status]++);
  $('#status-chips').innerHTML = Object.entries(STATUS).map(([k, v]) => `
    <button type="button" data-status="${k}" aria-pressed="${state.statusFilter.has(k)}"><span class="badge ${v.cls}">${esc(v.label)}</span><b>${counts[k]}</b></button>`).join('');
  const list = state.orders.filter((o) => state.statusFilter.has(o.status)).sort(sortBySchedule);
  if (!list.length) { $('#orders-board').innerHTML = '<p class="empty">Nenhum pedido com esses filtros.</p>'; return; }
  const groups = new Map();
  list.forEach((o) => { if (!groups.has(o.delivery_date)) groups.set(o.delivery_date, []); groups.get(o.delivery_date).push(o); });
  $('#orders-board').innerHTML = [...groups].map(([day, orders]) => {
    const sum = orders.filter((o) => o.status !== 'cancelado').reduce((s, o) => s + Number(o.total_cents), 0);
    return `<div class="day-group"><h3>${esc(dateBr(day))} · ${plural(orders.length, 'pedido', 'pedidos')} · ${money(sum)}</h3>
      <div class="list-rows">${orders.map((o) => `
        <button type="button" class="order-row" data-open="${o.id}">
          <span class="code">#${o.code}</span>
          <span class="when"><small>${icon(o.fulfillment === 'entrega' ? 'truck' : 'store', { size: 14 })}${o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada'}</small>${slotTag(o, multiDay)}</span>
          <span><strong>${esc(o.customer_name)}</strong><br><span class="small muted">${esc(phoneBr(o.customer_phone))}</span></span>
          <span class="items">${esc(o.items.map((i) => `${i.quantity}× ${i.product_name}`).join(', '))}</span>
          <span class="total">${money(o.total_cents)}</span>
          <span>${statusBadge(o.status)}</span>
        </button>`).join('')}</div></div>`;
  }).join('');
}

// ---------------------------------------------------- detalhe do pedido
async function openOrder(id, { silent = false } = {}) {
  state.openOrderId = id;
  const dlg = $('#order-dialog');
  if (!silent) {
    $('#order-detail').innerHTML = '<div class="d-body"><div class="skeleton" style="height:320px"></div></div>';
    if (!dlg.open) dlg.showModal();
  }
  try {
    const [o, events] = await Promise.all([staffApi(`/orders/${id}`), staffApi(`/orders/${id}/events`)]);
    renderOrderDetail(o, events);
  } catch (e) {
    $('#order-detail').innerHTML = `<div class="d-body"><p>${esc(e.message)}</p><button class="btn" data-close>Fechar</button></div>`;
  }
}

function whatsappLink(o) {
  if (!/^\d{10,13}$/.test(o.customer_phone)) return null;
  const phone = o.customer_phone.length <= 11 ? `55${o.customer_phone}` : o.customer_phone;
  const first = o.customer_name.trim().split(/\s+/)[0];
  const store = state.config.storeName;
  let msg = `Olá, ${first}! Aqui é da ${store}, sobre o seu pedido #${o.code}.`;
  if (o.status === 'pronto') {
    msg = o.fulfillment === 'entrega'
      ? `Olá, ${first}! Seu pedido #${o.code} da ${store} está pronto e sai para entrega em breve.`
      : `Olá, ${first}! Seu pedido #${o.code} da ${store} está pronto para retirada (${o.time_slot_label}). Até já!`;
  }
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

function primaryAction(o) {
  if (o.status === 'recebido') return ['em_producao', 'Iniciar produção', 'clock'];
  if (o.status === 'em_producao') return ['pronto', 'Marcar tudo como pronto', 'check'];
  if (o.status === 'pronto') return o.fulfillment === 'entrega'
    ? ['entregue', 'Marcar como saiu para entrega', 'truck']
    : ['entregue', 'Marcar como retirado pelo cliente', 'check'];
  return null;
}

function renderOrderDetail(o, events) {
  const closed = !ACTIVE.includes(o.status);
  const wa = whatsappLink(o);
  const steps = [
    ['Recebido', o.created_at],
    ['Em produção', o.production_started_at],
    ['Pronto', o.ready_at],
    [o.fulfillment === 'entrega' ? 'Entregue' : 'Retirado', o.delivered_at],
  ];
  const reached = { recebido: 0, em_producao: 1, pronto: 2, entregue: 3 }[o.status] ?? -1;
  const timeline = o.status === 'cancelado'
    ? `<div class="cancel-banner">Pedido cancelado em ${esc(timeBr(o.cancelled_at || o.updated_at))}${o.cancel_reason ? ` — ${esc(o.cancel_reason)}` : ''}</div>`
    : `<ol class="tl" aria-label="Andamento">${steps.map(([label, ts], i) => `
        <li class="${i <= reached ? 'done' : ''}">
          <span class="dot"><i>${i <= reached ? icon('check', { size: 14, stroke: 3 }) : ''}</i><b class="${i < reached ? 'on' : ''}"></b></span>
          <span class="l">${label}</span><span class="w">${ts && i <= reached ? esc(timeBr(ts)) : (i === reached + 1 ? 'aguardando' : '')}</span>
        </li>`).join('')}</ol>`;
  const done = o.items.filter((i) => i.status === 'produzido').length;
  const act = primaryAction(o);
  const mapUrl = o.delivery_address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.delivery_address)}` : null;

  $('#order-detail').innerHTML = `
    <div class="d-body" data-id="${o.id}">
      <header class="d-head">
        <div><div class="t"><h2>Pedido #${o.code}</h2>${statusBadge(o.status)}</div>
          <span class="muted small">Feito em ${esc(timeBr(o.created_at))}</span></div>
        <button type="button" class="icon-btn" data-close aria-label="Fechar">${icon('close', { size: 20, stroke: 2 })}</button>
      </header>
      ${timeline}
      <section class="info-cards">
        <div class="info-card">
          <span class="k">Cliente</span>
          <strong>${esc(o.customer_name)}</strong>
          <span class="v">${esc(phoneBr(o.customer_phone))}</span>
          ${wa ? `<a class="btn wa" href="${wa}" target="_blank" rel="noopener">${icon('chat')}${o.status === 'pronto' ? 'Avisar que está pronto' : 'Falar no WhatsApp'}</a>` : ''}
        </div>
        <div class="info-card">
          <span class="k">${o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada na loja'}</span>
          <strong>${esc(dateBr(o.delivery_date))} · ${esc(o.time_slot_label)}</strong>
          ${o.delivery_address ? `<span class="v">${esc(o.delivery_address)}</span>` : '<span class="v">O cliente retira no balcão.</span>'}
          ${mapUrl ? `<a class="btn" href="${mapUrl}" target="_blank" rel="noopener">${icon('pin')}Abrir no mapa</a>` : ''}
        </div>
      </section>
      ${o.notes ? `<div class="notes-box">${icon('alert')}<span>${esc(o.notes)}</span></div>` : ''}
      <section>
        <div class="items-head"><h3>Itens</h3><span>${done} de ${plural(o.items.length, 'item produzido', 'itens produzidos')}</span></div>
        <div class="d-items">
          ${o.items.map((i) => `
            <div class="d-item ${i.status === 'produzido' ? 'done' : (i.status === 'em_producao' ? 'wip' : '')}">
              <span class="box">${i.status === 'produzido' ? icon('check', { size: 16, stroke: 3 }) : ''}</span>
              <span class="txt">
                <b>${i.quantity} ${esc(i.unit_label)} · ${esc(i.product_name)}</b>
                <small>${money(i.unit_price_cents)} cada · ${money(i.subtotal_cents)} · ${esc(ITEM_STATUS[i.status])}${i.produced_at ? ` às ${esc(timeBr(i.produced_at).slice(-5))}` : ''}</small>
                ${i.notes ? `<span class="note-tag">${icon('alert', { size: 13, stroke: 2.2 })}${esc(i.notes)}</span>` : ''}
              </span>
              ${closed ? '' : (i.status !== 'produzido'
                ? `<button type="button" class="btn sm ok" data-item="${i.id}" data-item-status="produzido">Produzido</button>`
                : `<button type="button" class="btn sm" data-item="${i.id}" data-item-status="pendente">Desfazer</button>`)}
            </div>`).join('')}
        </div>
        <div class="d-total"><span>Total</span><strong>${money(o.total_cents)}</strong></div>
      </section>
      <details class="history"><summary>Histórico (${events.length})</summary>
        <ul>${events.map((ev) => `<li><span class="h-when">${esc(timeBr(ev.created_at))}</span><span class="h-what">${esc(describeEvent(ev, o))}</span><span class="h-who">${esc(ev.actor_name || (ev.event_type === 'status' && !ev.actor_name ? 'automático' : '—'))}</span></li>`).join('')}</ul>
      </details>
    </div>
    ${closed ? '' : `
    <footer class="d-foot">
      ${act ? `<button type="button" class="btn primary lg block" data-set-status="${act[0]}">${icon(act[2], { size: 20 })}${act[1]}</button>` : ''}
      <div class="row">
        ${o.status === 'pronto' ? '<button type="button" class="btn" data-set-status="em_producao">Reabrir produção</button>' : '<span></span>'}
        <button type="button" class="btn link-danger" data-set-status="cancelado">Cancelar pedido…</button>
      </div>
    </footer>`}`;
}

function describeEvent(ev, o) {
  if (ev.event_type === 'criado') return 'Pedido recebido';
  if (ev.event_type === 'status') return `Status: ${STATUS[ev.from_value]?.label ?? ev.from_value} → ${STATUS[ev.to_value]?.label ?? ev.to_value}${ev.note ? ` (${ev.note})` : ''}`;
  const item = o.items.find((i) => i.id === ev.item_id);
  return `${item ? item.product_name : 'Item'}: ${ITEM_STATUS[ev.to_value] ?? ev.to_value}`;
}

async function changeOrderStatus(id, status) {
  const o = state.orders.find((x) => x.id === id);
  let note;
  if (status === 'cancelado') {
    note = await confirmDialog({
      title: 'Cancelar pedido?', message: 'Essa ação não pode ser desfeita.', confirmText: 'Cancelar pedido',
      danger: true, input: { label: 'Motivo', minLength: 3, placeholder: 'Ex.: cliente desistiu' },
    });
    if (!note) return;
  } else if (status === 'entregue') {
    const ent = o?.fulfillment === 'entrega';
    if (!(await confirmDialog({ title: ent ? 'Saiu para entrega?' : 'Cliente retirou?', message: `O pedido${o ? ` #${o.code}` : ''} será encerrado.`, confirmText: 'Confirmar' }))) return;
  } else if (status === 'pronto') {
    if (!(await confirmDialog({ title: 'Marcar tudo como pronto?', message: 'Todos os itens serão marcados como produzidos.', confirmText: 'Tudo pronto' }))) return;
  } else if (status === 'em_producao' && o?.status === 'pronto') {
    if (!(await confirmDialog({ title: 'Reabrir produção?', message: 'Os itens voltarão para "em produção" na cozinha.', confirmText: 'Reabrir' }))) return;
  }
  try {
    await staffApi(`/orders/${id}/status`, { method: 'PATCH', body: { status, note } });
    toast('Status atualizado.', 'ok');
    if (state.openOrderId === id) openOrder(id, { silent: true });
    loadOrders();
  } catch (e) { toast(e.message, 'error'); }
}

async function changeItemStatus(itemId, status) {
  try {
    await staffApi(`/order-items/${itemId}/status`, { method: 'PATCH', body: { status } });
    openOrder(state.openOrderId, { silent: true });
    loadOrders();
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================ vendas / relatórios
function setReportPeriod(p) {
  const t = todayTz();
  const f = $('#report-form');
  const [y, m] = t.split('-').map(Number);
  const ranges = {
    today: [t, t],
    '7d': [addDays(t, -6), t],
    month: [`${t.slice(0, 7)}-01`, t],
    lastmonth: [new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10)],
  };
  [f.from.value, f.to.value] = ranges[p];
  $$('#period-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === p)));
}

function reportParams() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('#report-form'))) if (v) p.set(k, v);
  return p;
}

async function loadReport() {
  if (!state.isAdmin) return;
  const f = $('#report-form');
  if (!f.from.value || !f.to.value) return;
  if (!state.products) loadProducts({ render: false });
  try {
    state.report = await staffApi(`/reports/sales?${reportParams()}`);
    state.reportPage = 0;
    renderReport();
  } catch (e) {
    $('#report').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function niceMax(v) {
  if (v <= 0) return 10000;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
const axisMoney = (c) => (c >= 100000 ? `${(c / 100000).toLocaleString('pt-BR')} mil` : money(c).replace(',00', ''));

function dayChart(r) {
  const { from, to } = r.filters;
  const byDay = new Map(r.by_day.map((d) => [d.day, d]));
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  let buckets;
  if (days.length <= 62) {
    buckets = days.map((d) => ({ label: dateBr(d, false).slice(0, 5), revenue: Number(byDay.get(d)?.revenue_cents ?? 0), orders: byDay.get(d)?.orders_count ?? 0 }));
  } else {
    const months = new Map();
    days.forEach((d) => {
      const k = d.slice(0, 7);
      const b = months.get(k) || { label: `${k.slice(5)}/${k.slice(2, 4)}`, revenue: 0, orders: 0 };
      b.revenue += Number(byDay.get(d)?.revenue_cents ?? 0);
      b.orders += byDay.get(d)?.orders_count ?? 0;
      months.set(k, b);
    });
    buckets = [...months.values()];
  }
  const top = niceMax(Math.max(...buckets.map((b) => b.revenue), 1));
  const peak = buckets.reduce((a, b) => (b.revenue > a.revenue ? b : a), buckets[0]);
  const every = Math.ceil(buckets.length / 14);
  const gridVals = [0, top / 2, top];
  return {
    unit: days.length > 62 ? 'mês' : 'dia',
    html: `
      <div class="cols-wrap" role="img" aria-label="Faturamento por período">
        ${gridVals.map((v) => `<div class="gridline" style="bottom:${(v / top) * 100}%"></div><span class="gridlabel" style="bottom:${(v / top) * 100}%">${axisMoney(v)}</span>`).join('')}
        <div class="cols">
          ${buckets.map((b) => `
            <div class="col" tabindex="0" data-tip="${esc(b.label)}: ${esc(money(b.revenue))} · ${plural(b.orders, 'pedido', 'pedidos')}">
              ${b === peak && b.revenue > 0 ? `<span class="peak" style="bottom:${(b.revenue / top) * 100}%">${money(b.revenue)}</span>` : ''}
              <i style="height:${(b.revenue / top) * 100}%"></i>
            </div>`).join('')}
        </div>
      </div>
      <div class="col-axis">${buckets.map((b, i) => `<span>${i % every === 0 ? esc(b.label) : ''}</span>`).join('')}</div>`,
  };
}

function renderReport() {
  const r = state.report;
  const s = r.summary;
  const f = r.filters;
  const maxQty = Math.max(...r.top_products.map((p) => p.quantity), 1);
  const chart = r.by_day.length ? dayChart(r) : { unit: 'dia', html: '<p class="empty">Sem vendas no período.</p>' };
  const statusTotal = Object.values(r.by_status).reduce((a, b) => a + b, 0);
  const productName = $('#report-product').selectedOptions[0]?.textContent;
  const PER = state.printAll ? Math.max(1, r.orders.length) : 10;
  const pages = Math.max(1, Math.ceil(r.orders.length / PER));
  const page = Math.min(state.reportPage, pages - 1);
  const rows = r.orders.slice(page * PER, page * PER + PER);

  $('#report').innerHTML = `
    <div class="print-head">
      <h2>Relatório de vendas — ${esc(state.config.storeName)}</h2>
      <p>${esc(dateBr(f.from, false))} a ${esc(dateBr(f.to, false))} · base: ${f.date_field === 'pedido' ? 'data do pedido' : 'data de entrega'}${f.product_id ? ` · produto: ${esc(productName)}` : ''} · gerado em ${esc(timeBr(new Date()))}</p>
    </div>
    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi kpi-lg"><span class="label">Faturamento</span><span class="value">${money(s.revenue_cents)}</span><span class="sub">Pedidos não cancelados</span></div>
      <div class="kpi kpi-lg"><span class="label">Pedidos</span><span class="value">${s.orders_count}</span><span class="sub">${plural(s.cancelled_count, 'cancelado', 'cancelados')} no período</span></div>
      <div class="kpi kpi-lg"><span class="label">Ticket médio</span><span class="value">${money(s.avg_ticket_cents)}</span><span class="sub">Faturamento ÷ pedidos</span></div>
      <div class="kpi kpi-lg"><span class="label">Já entregue</span><span class="value">${money(s.delivered_revenue_cents)}</span><span class="sub">${plural(s.items_qty, 'item vendido', 'itens vendidos')}</span></div>
    </div>
    <div class="report-grid" style="margin-bottom:16px">
      <section class="card chart-card">
        <div><h2>Faturamento por ${chart.unit}</h2><p class="cap">Pedidos não cancelados, ${f.date_field === 'pedido' ? 'pela data do pedido' : 'pela data de entrega'}. Passe o mouse nas colunas.</p></div>
        ${chart.html}
      </section>
      <section class="card chart-card">
        <div><h2>Produtos mais encomendados</h2><p class="cap">Quantidade vendida no período</p></div>
        <div class="hbars">${r.top_products.slice(0, 8).map((p) => `
          <div class="hbar" data-tip="${esc(p.product_name)}: ${p.quantity} · ${esc(money(p.revenue_cents))}">
            <span class="n">${esc(p.product_name)}</span>
            <span class="track"><i style="width:${Math.max(2, (p.quantity / maxQty) * 82)}%"></i><b>${p.quantity}</b></span>
          </div>`).join('') || '<p class="muted">—</p>'}</div>
        <div class="sep">
          <h2>Pedidos por status</h2>
          ${statusTotal ? `<div class="stack">${Object.keys(STATUS).filter((k) => r.by_status[k]).map((k) => `<span style="flex:${r.by_status[k]} 0 0;background:${STATUS_COLORS[k]}" title="${STATUS[k].label}: ${r.by_status[k]}"></span>`).join('')}</div>` : ''}
          <div class="legend">${Object.keys(STATUS).map((k) => `<span><i style="background:${STATUS_COLORS[k]}"></i>${STATUS[k].label} <b>${r.by_status[k] ?? 0}</b></span>`).join('')}</div>
          <span class="small muted">Retirada <b style="color:var(--ink)">${r.by_fulfillment.retirada ?? 0}</b> · Entrega <b style="color:var(--ink)">${r.by_fulfillment.entrega ?? 0}</b></span>
        </div>
      </section>
    </div>
    <section class="card table-card">
      <div class="table-head"><h2>Pedidos do período <span class="muted" style="font-weight:500">· ${r.orders.length}</span></h2>
        <span class="small muted">${r.orders.length ? `Mostrando ${page * PER + 1}–${page * PER + rows.length} de ${r.orders.length}` : ''}</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Pedido</th><th>Entrega</th><th>Cliente</th><th>Modalidade</th><th>Status</th><th class="r">Total</th></tr></thead>
        <tbody>${rows.map((o) => `<tr>
          <td><b>#${o.code}</b></td>
          <td>${esc(dateBr(o.delivery_date))} <span class="muted">· ${esc(o.time_slot_label)}</span></td>
          <td>${esc(o.customer_name)}<br><span class="small muted">${esc(phoneBr(o.customer_phone))}</span></td>
          <td>${o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada'}</td>
          <td>${statusBadge(o.status)}</td>
          <td class="r num"><b>${money(o.total_cents)}</b></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhum pedido no período.</td></tr>'}
        </tbody></table></div>
      ${pages > 1 ? `<div class="pager"><span>Página ${page + 1} de ${pages}</span>
        <button type="button" class="btn sm" data-page="-1" ${page === 0 ? 'disabled' : ''}>Anterior</button>
        <button type="button" class="btn sm" data-page="1" ${page >= pages - 1 ? 'disabled' : ''}>Próxima</button></div>` : ''}
    </section>`;
}

async function exportCsv() {
  try {
    const res = await api(`/staff/reports/sales.csv?${reportParams()}`, { token: await token(), raw: true });
    const url = URL.createObjectURL(await res.blob());
    const f = $('#report-form');
    const a = Object.assign(document.createElement('a'), { href: url, download: `vendas_${f.from.value}_a_${f.to.value}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast(e.message, 'error'); }
}

function printReport() {
  // na impressão, a tabela traz todos os pedidos (não só a página atual)
  state.printAll = true;
  if (state.report) renderReport();
  window.print();
  state.printAll = false;
  if (state.report) renderReport();
}

function bindTooltips() {
  const tip = $('#chart-tip');
  const show = (el, x, y) => { tip.textContent = el.dataset.tip; tip.hidden = false; tip.style.left = `${x + 12}px`; tip.style.top = `${y - 36}px`; };
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) { const r = el.getBoundingClientRect(); show(el, r.left, r.top); } else tip.hidden = true;
  });
}

// ============================================================ produtos
async function loadProducts({ render = true } = {}) {
  try {
    state.products = await staffApi('/products');
    const sel = $('#report-product');
    const current = sel.value;
    sel.innerHTML = '<option value="">Todos os produtos</option>' +
      state.products.products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    sel.value = current;
    if (render) renderProducts();
  } catch (e) {
    if (render) $('#products-table').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function renderProducts() {
  const { categories, products } = state.products;
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const tile = (catId) => CATEGORY_TILES[Math.max(0, categories.findIndex((c) => c.id === catId)) % CATEGORY_TILES.length];
  const showArchived = $('#show-archived').checked;
  const q = norm($('#product-q').value.trim());
  const active = products.filter((p) => p.active);
  $('#products-count').textContent = `${plural(active.length, 'produto', 'produtos')} · ${active.filter((p) => p.available).length} aceitando encomendas`;
  $('#product-cats').innerHTML = [{ id: 'all', name: 'Todos' }, ...categories].map((c) =>
    `<button type="button" class="chip" data-pcat="${c.id}" aria-pressed="${String(state.productCat) === String(c.id)}">${esc(c.name)}</button>`).join('');

  const list = products.filter((p) => (showArchived || p.active)
    && (state.productCat === 'all' || String(p.category_id) === String(state.productCat))
    && (!q || norm(p.name).includes(q)));

  $('#products-table').innerHTML = `<section class="card table-card"><div class="table-wrap"><table class="data">
    <thead><tr><th>Produto</th><th>Categoria</th><th>Preço</th><th>Por pedido</th><th>Encomendas</th><th class="r">Ações</th></tr></thead>
    <tbody>${list.map((p) => {
      const [bg, ink] = tile(p.category_id);
      return `
      <tr class="${p.active ? '' : 'archived'}">
        <td><div class="p-cell">
          <span class="p-tile" style="background:${bg};color:${ink}">${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : icon('bread', { size: 28, stroke: 1.5 })}</span>
          <span><b>${esc(p.name)}</b><small>vendido por ${esc(p.unit_label)}${p.active ? '' : ' · arquivado'}</small></span>
        </div></td>
        <td>${esc(catName[p.category_id] ?? '')}</td>
        <td><label class="price-field"><span>R$</span><span class="sr-only">Preço de ${esc(p.name)}</span>
          <input data-price="${p.id}" inputmode="decimal" value="${(p.price_cents / 100).toFixed(2).replace('.', ',')}"></label></td>
        <td class="num">${p.min_quantity} – ${p.max_quantity}</td>
        <td><button type="button" class="switch" role="switch" aria-checked="${p.available}" data-avail="${p.id}" aria-label="Aceitar encomendas de ${esc(p.name)}">
          <span class="track"></span>${p.available ? 'Aceitando' : 'Pausado'}</button></td>
        <td><div class="row-actions">
          <button type="button" class="btn sm" data-edit="${p.id}">Editar</button>
          <button type="button" class="btn sm ghost" data-archive="${p.id}">${p.active ? 'Arquivar' : 'Reativar'}</button>
        </div></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">Nenhum produto encontrado.</td></tr>'}</tbody></table></div></section>`;
}

async function patchProduct(id, patch, msg = 'Produto atualizado.') {
  try {
    await staffApi(`/products/${id}`, { method: 'PATCH', body: patch });
    toast(msg, 'ok');
  } catch (e) { toast(e.message, 'error'); }
  loadProducts();
}

function openProductDialog(product = null) {
  const f = $('#product-form');
  f.reset();
  $('#product-error').textContent = '';
  f.category_id.innerHTML = state.products.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#product-dialog-title').textContent = product ? `Editar: ${product.name}` : 'Novo produto';
  f.dataset.id = product?.id ?? '';
  if (product) {
    for (const k of ['name', 'category_id', 'unit_label', 'sort_order', 'min_quantity', 'max_quantity', 'description']) f[k].value = product[k] ?? '';
    f.image_url.value = product.image_url ?? '';
    f.price.value = (product.price_cents / 100).toFixed(2).replace('.', ',');
  }
  $('#product-dialog').showModal();
}

async function newCategory() {
  const name = await confirmDialog({
    title: 'Nova categoria', message: 'Ela aparece no cardápio da sua loja.',
    confirmText: 'Criar', input: { label: 'Nome da categoria', minLength: 2, placeholder: 'Ex.: Tortas' },
  });
  if (!name) return;
  try {
    const cat = await staffApi('/categories', { method: 'POST', body: { name } });
    state.products.categories.push(cat);
    const sel = $('#product-form').category_id;
    sel.insertAdjacentHTML('beforeend', `<option value="${cat.id}">${esc(cat.name)}</option>`);
    sel.value = String(cat.id);
    toast('Categoria criada.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function saveProduct(e) {
  e.preventDefault();
  const f = e.target;
  const price_cents = parsePriceToCents(f.price.value);
  if (!price_cents) { $('#product-error').textContent = 'Preço inválido.'; return; }
  const body = {
    name: f.name.value, category_id: Number(f.category_id.value), price_cents,
    unit_label: f.unit_label.value, sort_order: Number(f.sort_order.value || 0),
    min_quantity: Number(f.min_quantity.value), max_quantity: Number(f.max_quantity.value),
    description: f.description.value, image_url: f.image_url.value || null,
  };
  try {
    if (f.dataset.id) await staffApi(`/products/${f.dataset.id}`, { method: 'PATCH', body });
    else await staffApi('/products', { method: 'POST', body });
    $('#product-dialog').close();
    toast('Produto salvo.', 'ok');
    loadProducts();
  } catch (ex) { $('#product-error').textContent = ex.message; }
}


// ============================================================ equipe e acessos (admin)
const ROLE_CLASS = { admin: 'r-admin', atendimento: 'r-atendimento', cozinha: 'r-cozinha' };

// ---------------------------------------------------- licença / assinatura
let bannerEl;
function placeLicenseBanner() {
  const lic = state.license;
  bannerEl ||= Object.assign(document.createElement('div'), { id: 'license-banner' });
  let kind = '';
  let text = '';
  if (lic?.state === 'teste' && lic.days_left != null && lic.days_left <= 5) {
    kind = 'info'; text = `Seu teste grátis termina em ${Math.max(lic.days_left, 0)} ${lic.days_left === 1 ? 'dia' : 'dias'}.`;
  } else if (lic?.state === 'atrasada') {
    kind = 'warn'; text = licenseText(lic);
  } else if (lic?.state === 'bloqueada') {
    kind = 'bad'; text = 'A licença venceu e a loja está bloqueada: os clientes não conseguem fazer pedidos. Pague a fatura para liberar.';
  }
  if (!kind || (state.tab === 'billing' && kind === 'info')) { bannerEl.remove(); return; }
  bannerEl.className = `license-banner ${kind}`;
  bannerEl.innerHTML = `${icon('alert', { size: 18 })}<span>${esc(text)}</span>` +
    (state.isAdmin && state.tab !== 'billing' ? '<button type="button" class="btn sm" data-goto-billing>Ver assinatura</button>' : '');
  const panel = $(`#tab-${state.tab}`);
  if (panel) panel.insertBefore(bannerEl, panel.querySelector('.panel-head')?.nextSibling ?? panel.firstChild);
}

async function loadBilling({ force = false } = {}) {
  try {
    state.billing = await staffApi(force ? '/billing?refresh=1' : '/billing');
    state.license = state.billing.license;
    renderBilling();
    placeLicenseBanner();
  } catch (e) {
    $('#billing-body').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

const PAY_STATUS = {
  PENDING: ['Aguardando pagamento', 'st-recebido'], OVERDUE: ['Vencida', 'st-cancelado'],
  RECEIVED: ['Paga', 'st-pronto'], CONFIRMED: ['Paga', 'st-pronto'], RECEIVED_IN_CASH: ['Paga', 'st-pronto'],
  REFUNDED: ['Estornada', 'st-entregue'], REFUND_REQUESTED: ['Estorno pedido', 'st-entregue'],
};
const PAY_TYPE = { PIX: 'Pix', BOLETO: 'Boleto', CREDIT_CARD: 'Cartão', UNDEFINED: '—' };

function renderBilling() {
  const b = state.billing;
  const lic = b.license;
  const subActive = b.subscription.status === 'ativa';
  const firstDue = lic.valid_until && new Date(lic.valid_until) > new Date() ? dateFull(lic.valid_until) : 'hoje';
  let action = '';
  if (lic.mode === 'cortesia') {
    action = '<p class="muted">Esta loja é <b>cortesia</b>: o sistema está liberado sem cobrança.</p>';
  } else if (!b.billing_enabled) {
    action = '<p class="muted">O pagamento online ainda não está ativo. Fale com o suporte do sistema para renovar sua licença.</p>';
  } else if (!subActive) {
    action = `
      ${b.subscription.status === 'cancelada' ? '<p class="muted">A assinatura foi cancelada. A loja funciona até o fim do período pago.</p>' : ''}
      ${b.has_document ? '' : '<p class="field-error">O CNPJ/CPF da loja não está cadastrado. Peça ao suporte para completar o cadastro antes de assinar.</p>'}
      <form class="bill-form" id="subscribe-form">
        <label class="field">E-mail para receber as faturas
          <input name="email" type="email" required value="${esc(b.billing_email || state.staff.email || '')}" autocomplete="email"></label>
        <button class="btn primary" type="submit" ${b.has_document ? '' : 'disabled'}>${icon('check', { size: 18 })}Assinar agora</button>
      </form>
      <p class="muted small">A 1ª cobrança vence em <b>${esc(firstDue)}</b>. Depois, todo mês. Você paga como preferir:</p>
      <div class="bill-methods"><span>Pix</span><span>Boleto</span><span>Cartão de crédito</span></div>`;
  } else {
    const inv = b.next_invoice;
    action = inv ? `
      <div class="bill-row"><b>Próxima fatura:</b> ${esc(dateBr(inv.due_date))} · ${money(inv.value_cents)}
        <span class="badge ${PAY_STATUS[inv.status]?.[1] || ''}">${esc(PAY_STATUS[inv.status]?.[0] || inv.status)}</span></div>
      ${inv.invoice_url ? `<a class="btn primary lg" href="${esc(inv.invoice_url)}" target="_blank" rel="noopener">${icon('external', { size: 18 })}Pagar fatura (Pix, boleto ou cartão)</a>` : ''}
      <p class="muted small">Depois de pagar, a liberação é automática (Pix e cartão: na hora; boleto: até 3 dias úteis). Clique em "Já paguei — atualizar" se quiser conferir.</p>`
      : '<p class="muted">Nenhuma fatura em aberto. A próxima é gerada automaticamente antes do vencimento.</p>';
    action += `<div class="bill-row"><span class="muted small">Faturas enviadas para ${esc(b.billing_email || '—')}</span>
      <button type="button" class="btn sm ghost" id="cancel-subscription">Cancelar assinatura</button></div>`;
  }

  const rows = b.payments.map((p) => `
    <tr>
      <td>${esc(dateBr(p.due_date))}</td>
      <td class="r">${money(p.value_cents)}</td>
      <td><span class="badge ${PAY_STATUS[p.status]?.[1] || ''}">${esc(PAY_STATUS[p.status]?.[0] || p.status)}</span></td>
      <td>${esc(PAY_TYPE[p.billing_type] || p.billing_type || '—')}</td>
      <td class="r">${p.invoice_url ? `<a class="btn sm" href="${esc(p.invoice_url)}" target="_blank" rel="noopener">${['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(p.status) ? 'Comprovante' : 'Pagar'}</a>` : ''}</td>
    </tr>`).join('');

  $('#billing-body').innerHTML = `
    <div class="bill-grid">
      <section class="card bill-card">
        <div class="bill-row"><h2>${esc(lic.plan_name || 'Plano')}</h2>${licenseBadge(lic)}</div>
        ${lic.mode === 'cortesia' ? '' : `<div class="bill-price">${money(lic.price_cents)} <small>/ mês</small></div>`}
        <p>${esc(licenseText(lic))}</p>
        ${action}
      </section>
      <section class="card table-card">
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Vencimento</th><th class="r">Valor</th><th>Situação</th><th>Forma</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">Nenhuma cobrança ainda.</td></tr>'}</tbody>
        </table></div>
      </section>
    </div>`;
}

async function subscribe(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    state.billing = await staffApi('/billing/subscribe', { method: 'POST', body: { email: e.target.email.value.trim() } });
    state.license = state.billing.license;
    renderBilling();
    toast('Assinatura criada! Use o botão "Pagar fatura" quando quiser pagar.', 'ok', 6000);
  } catch (ex) {
    toast(ex.message, 'error', 6000);
    btn.disabled = false;
  }
}

async function cancelSubscription() {
  const ok = await confirmDialog({
    title: 'Cancelar assinatura?',
    message: 'As próximas faturas deixam de ser geradas. A loja continua funcionando até o fim do período já pago; depois disso, fica bloqueada.',
    confirmText: 'Cancelar assinatura', danger: true,
  });
  if (!ok) return;
  try {
    state.billing = await staffApi('/billing/cancel', { method: 'POST' });
    renderBilling();
    toast('Assinatura cancelada.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function refreshBilling() {
  const wasLocked = state.locked;
  await loadBilling({ force: true });
  if (wasLocked && state.license && !state.license.blocked) {
    toast('Licença liberada! Carregando o sistema…', 'ok');
    setTimeout(() => location.reload(), 900);
  } else if (state.billing) {
    toast('Situação atualizada.', 'ok');
  }
}

async function loadTeam() {
  if (!state.isAdmin) return;
  try {
    state.team = await staffApi('/team');
    renderTeam();
  } catch (e) {
    $('#team-table').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function renderTeam() {
  const active = state.team.filter((m) => m.active);
  const admins = active.filter((m) => m.role === 'admin').length;
  $('#team-count').textContent = `${plural(active.length, 'pessoa ativa', 'pessoas ativas')} · ${plural(admins, 'administrador', 'administradores')}`;
  $('#team-table').innerHTML = `<section class="card table-card"><div class="table-wrap"><table class="data">
    <thead><tr><th>Pessoa</th><th>Papel</th><th>Último acesso</th><th>Situação</th><th class="r">Senha</th></tr></thead>
    <tbody>${state.team.map((m) => {
      const self = m.user_id === state.staff.id;
      return `
      <tr class="${m.active ? '' : 'inactive'}">
        <td><div class="person"><span class="avatar">${esc(initials(m.full_name))}</span>
          <span><b>${esc(m.full_name)}${self ? '<span class="you-tag">Você</span>' : ''}</b><small>${esc(m.email)}</small></span></div></td>
        <td>
          <label class="sr-only" for="role-${m.user_id}">Papel de ${esc(m.full_name)}</label>
          <select class="role-select" id="role-${m.user_id}" data-role-of="${m.user_id}" ${self ? 'disabled title="Peça a outro administrador para mudar o seu papel."' : ''}>
            ${['admin', 'atendimento', 'cozinha'].map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE_LABEL[r] === 'Administração' ? 'Administrador' : ROLE_LABEL[r]}</option>`).join('')}
          </select>
        </td>
        <td class="muted">${m.last_sign_in_at ? esc(timeBr(m.last_sign_in_at)) : 'Nunca entrou'}</td>
        <td><button type="button" class="switch" role="switch" aria-checked="${m.active}" data-active-of="${m.user_id}" ${self ? 'disabled' : ''} aria-label="Acesso de ${esc(m.full_name)}">
          <span class="track"></span>${m.active ? 'Ativo' : 'Desativado'}</button></td>
        <td class="r"><button type="button" class="btn sm" data-reset-of="${m.user_id}">${icon('key', { size: 16 })}Redefinir</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Ninguém cadastrado.</td></tr>'}</tbody></table></div></section>`;
}

async function updateMember(userId, patch, okMsg) {
  try {
    await staffApi(`/team/${userId}`, { method: 'PATCH', body: patch });
    toast(okMsg, 'ok');
  } catch (e) { toast(e.message, 'error'); }
  loadTeam();
}

async function changeRole(userId, role, selectEl) {
  const m = state.team.find((x) => x.user_id === userId);
  const label = (r) => (r === 'admin' ? 'Administrador' : ROLE_LABEL[r]);
  const msg = role === 'admin'
    ? `${m.full_name} passará a ver vendas e relatórios e poderá gerenciar a equipe.`
    : (m.role === 'admin' ? `${m.full_name} deixará de ver vendas e relatórios e não poderá mais gerenciar a equipe.` : `${m.full_name} passará a ter o acesso de ${label(role)}.`);
  const ok = await confirmDialog({ title: `Mudar para ${label(role)}?`, message: msg, confirmText: 'Confirmar', danger: m.role === 'admin' });
  if (!ok) { selectEl.value = m.role; return; }
  updateMember(userId, { role }, `${m.full_name} agora é ${label(role)}.`);
}

function generatePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const raw = [...bytes].map((b) => abc[b % abc.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

function openMemberDialog() {
  const f = $('#member-form');
  f.reset();
  f.password.value = generatePassword();
  $('#member-error').textContent = '';
  $('#member-dialog').showModal();
  f.full_name.focus();
}

async function saveMember(e) {
  e.preventDefault();
  const f = e.target;
  if (!f.checkValidity()) { f.reportValidity(); return; }
  const body = { full_name: f.full_name.value, email: f.email.value, role: f.role.value, password: f.password.value };
  const btn = f.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const m = await staffApi('/team', { method: 'POST', body });
    $('#member-dialog').close();
    showCredentials(m.email, body.password, m.role, m.existed);
    loadTeam();
  } catch (ex) {
    $('#member-error').textContent = ex.message;
  } finally { btn.disabled = false; }
}

function showCredentials(email, password, role, existed) {
  const where = role === 'cozinha' ? `${location.origin}/cozinha/` : `${location.origin}/atendimento`;
  $('#creds-text').textContent =
    `Acesso — ${state.config.storeName}\nTela: ${where}\nE-mail: ${email}\nSenha: ${password}\nPapel: ${role === 'admin' ? 'Administrador' : ROLE_LABEL[role]}` +
    (existed ? '\n(este e-mail já tinha conta; a senha foi trocada)' : '');
  $('#creds-dialog').showModal();
}

async function resetPassword(userId) {
  const m = state.team.find((x) => x.user_id === userId);
  const suggestion = generatePassword();
  const pw = await confirmDialog({
    title: `Nova senha para ${m.full_name}`,
    message: 'A senha antiga deixa de funcionar na hora. Sugerimos a senha abaixo; você pode trocar.',
    confirmText: 'Salvar nova senha',
    input: { label: 'Nova senha (mínimo 8 caracteres)', minLength: 8, value: suggestion },
  });
  if (!pw) return;
  try {
    await staffApi(`/team/${userId}/password`, { method: 'POST', body: { password: pw } });
    showCredentials(m.email, pw, m.role, false);
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================ eventos
function bindEvents() {
  $('#login-form').addEventListener('submit', login);
  $('#logout').addEventListener('click', logout);
  $('#sound-toggle').addEventListener('change', (e) => {
    localStorage.setItem('padaria-sound', e.target.checked ? '1' : '0');
    if (e.target.checked) beep({ times: 1 }); // destrava o áudio com um gesto do usuário
  });
  $$('.nav-item[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) setView(v.dataset.view);
  });

  // filtros de pedidos
  $('#range-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    state.range = b.dataset.range;
    $$('#range-chips [data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#custom-range').classList.toggle('hidden', state.range !== 'custom');
    loadOrders();
  });
  ['#f-from', '#f-to', '#f-fulfillment'].forEach((s) => $(s).addEventListener('change', loadOrders));
  $('#f-q').addEventListener('input', debounce(loadOrders, 350));
  $('#status-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    const s = b.dataset.status;
    state.statusFilter.has(s) ? state.statusFilter.delete(s) : state.statusFilter.add(s);
    renderOrders();
  });
  $('#orders-board').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      e.stopPropagation();
      return changeOrderStatus(quick.closest('[data-order]').dataset.order, quick.dataset.quick);
    }
    const card = e.target.closest('[data-open], [data-order]');
    if (card) openOrder(card.dataset.open || card.dataset.order);
  });

  // detalhe
  const dlg = $('#order-dialog');
  dlg.addEventListener('close', () => { state.openOrderId = null; });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
    const st = e.target.closest('[data-set-status]');
    if (st) return changeOrderStatus(state.openOrderId, st.dataset.setStatus);
    const it = e.target.closest('[data-item]');
    if (it) return changeItemStatus(Number(it.dataset.item), it.dataset.itemStatus);
  });

  // relatórios
  $('#period-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (b) { setReportPeriod(b.dataset.period); loadReport(); }
  });
  $('#report-form').addEventListener('change', (e) => {
    if (['from', 'to'].includes(e.target.name)) $$('#period-seg button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    loadReport();
  });
  $('#report-form').addEventListener('submit', (e) => { e.preventDefault(); loadReport(); });
  $('#report').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) { state.reportPage += Number(b.dataset.page); renderReport(); }
  });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#print-report').addEventListener('click', printReport);
  bindTooltips();

  // equipe
  $('#new-member').addEventListener('click', openMemberDialog);
  $('#billing-refresh').addEventListener('click', refreshBilling);
  $('#blocked-logout').addEventListener('click', logout);
  document.addEventListener('submit', (e) => { if (e.target.id === 'subscribe-form') subscribe(e); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('#cancel-subscription')) cancelSubscription();
    if (e.target.closest('[data-goto-billing]')) showTab('billing');
  });
  $('#new-category').addEventListener('click', newCategory);
  $('#store-link-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#store-link').dataset.url); toast('Link copiado. Envie para seus clientes.', 'ok'); }
    catch { $('#store-link').select(); toast('Selecione o link e copie com Ctrl+C.'); }
  });
  $('#member-cancel').addEventListener('click', () => $('#member-dialog').close());
  $('#gen-password').addEventListener('click', () => { $('#member-form').password.value = generatePassword(); });
  $('#member-form').addEventListener('submit', saveMember);
  $('#copy-creds').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#creds-text').textContent); toast('Copiado.', 'ok'); }
    catch { toast('Selecione o texto e copie com Ctrl+C.'); }
  });
  $('#team-table').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-role-of]');
    if (sel) changeRole(sel.dataset.roleOf, sel.value, sel);
  });
  $('#team-table').addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-active-of]');
    if (sw && !sw.disabled) {
      const m = state.team.find((x) => x.user_id === sw.dataset.activeOf);
      if (m.active && !(await confirmDialog({ title: `Desativar ${m.full_name}?`, message: 'A pessoa não consegue mais entrar. Você pode reativar depois.', confirmText: 'Desativar', danger: true }))) return;
      return updateMember(m.user_id, { active: !m.active }, m.active ? `${m.full_name} foi desativado(a).` : `${m.full_name} foi reativado(a).`);
    }
    const rs = e.target.closest('[data-reset-of]');
    if (rs) resetPassword(rs.dataset.resetOf);
  });

  // produtos
  $('#new-product').addEventListener('click', () => openProductDialog());
  $('#product-cancel').addEventListener('click', () => $('#product-dialog').close());
  $('#product-form').addEventListener('submit', saveProduct);
  $('#show-archived').addEventListener('change', renderProducts);
  $('#product-q').addEventListener('input', debounce(renderProducts, 200));
  $('#product-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pcat]');
    if (b) { state.productCat = b.dataset.pcat; renderProducts(); }
  });
  $('#products-table').addEventListener('change', (e) => {
    const t = e.target;
    if (!t.dataset.price) return;
    const cents = parsePriceToCents(t.value);
    if (!cents) { toast('Preço inválido.', 'error'); loadProducts(); return; }
    patchProduct(Number(t.dataset.price), { price_cents: cents }, `Preço atualizado para ${money(cents)}.`);
  });
  $('#products-table').addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-avail]');
    if (sw) {
      const on = sw.getAttribute('aria-checked') !== 'true';
      return patchProduct(Number(sw.dataset.avail), { available: on }, on ? 'Produto voltou a aceitar encomendas.' : 'Produto pausado.');
    }
    const ar = e.target.closest('[data-archive]');
    if (ar) {
      const p = state.products.products.find((x) => x.id === Number(ar.dataset.archive));
      if (p.active && !(await confirmDialog({ title: 'Arquivar produto?', message: 'Ele some do cardápio do cliente. Pedidos antigos não são afetados.', confirmText: 'Arquivar' }))) return;
      return patchProduct(p.id, { active: !p.active }, p.active ? 'Produto arquivado.' : 'Produto reativado.');
    }
    const b = e.target.closest('[data-edit]');
    if (b) openProductDialog(state.products.products.find((p) => p.id === Number(b.dataset.edit)));
  });
}

// ============================================================ início
async function init() {
  hydrateIcons();
  bindEvents();
  try {
    // Só as chaves públicas do Supabase. Os dados da loja (nome, fuso etc.)
    // vêm depois do login, de /staff/me — cada funcionário vê só a loja dele.
    state.keys = await api('/public/config');
  } catch (e) {
    document.body.innerHTML = `<p class="empty">Não foi possível conectar ao servidor: ${esc(e.message)}</p>`;
    return;
  }
  state.sb = createSupabase(state.keys);
  const { data } = await state.sb.auth.getSession();
  if (data.session) await enterApp();
  else $('#login-view').classList.remove('hidden');
}

init();
