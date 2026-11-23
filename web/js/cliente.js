// Tela do cliente: catálogo → data/horário/dados → sucesso.
import { api, money, esc, toast, dateBr, phoneBr, icon, hydrateIcons, norm, CATEGORY_TILES, applyBrand, placeLogo } from './common.js';

const $ = (sel) => document.querySelector(sel);
// Cada loja tem seu link: /loja/<slug>. Tudo (cardápio, pedido, carrinho) é daquela loja.
const SLUG = (location.pathname.match(/^\/loja\/([a-z0-9-]+)/) || [])[1] || null;
const STORE_API = `/public/stores/${SLUG}`;
const CART_KEY = `padaria-cart-v1:${SLUG}`;
const WEEKDAYS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];

const state = {
  config: null,
  catalog: { categories: [], products: [], time_slots: [] },
  cart: loadCart(),        // { [productId]: { qty, notes, noteOpen } }
  category: 'all',
  search: '',
  date: null,              // data escolhida (YYYY-MM-DD)
  slotId: null,
  slots: [],               // vagas da data escolhida
  submitting: false,
};

// ================================================================ utilidades
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const s = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const hhmm = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
};

// ================================================================ carrinho
function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; }
}
function saveCart() {
  try {
    const slim = Object.fromEntries(Object.entries(state.cart).map(([k, v]) => [k, { qty: v.qty, notes: v.notes || '' }]));
    localStorage.setItem(CART_KEY, JSON.stringify(slim));
  } catch { /* modo privado */ }
}
const productById = (id) => state.catalog.products.find((p) => Number(p.id) === Number(id));

function setQty(productId, qty) {
  const p = productById(productId);
  if (!p) return;
  qty = Math.round(Number(qty) || 0);
  if (qty <= 0) {
    delete state.cart[productId];
  } else {
    qty = Math.min(Math.max(qty, p.min_quantity), p.max_quantity);
    state.cart[productId] = { ...(state.cart[productId] || { notes: '' }), qty };
  }
  saveCart();
  renderProducts();
  renderCart();
}

function reconcileCart() {
  let removed = 0;
  for (const id of Object.keys(state.cart)) {
    const p = productById(id);
    if (!p || !p.available) { delete state.cart[id]; removed++; continue; }
    const c = state.cart[id];
    c.qty = Math.min(Math.max(c.qty, p.min_quantity), p.max_quantity);
  }
  saveCart();
  return removed;
}

function cartLines() {
  return Object.entries(state.cart)
    .map(([id, c]) => ({ product: productById(id), ...c }))
    .filter((l) => l.product);
}
const cartTotal = () => cartLines().reduce((sum, l) => sum + l.product.price_cents * l.qty, 0);

// ================================================================ catálogo
function tileFor(categoryId) {
  const idx = state.catalog.categories.findIndex((c) => c.id === categoryId);
  return CATEGORY_TILES[(idx < 0 ? 0 : idx) % CATEGORY_TILES.length];
}

function visibleProducts() {
  const q = norm(state.search.trim());
  return state.catalog.products.filter((p) =>
    (state.category === 'all' || String(p.category_id) === String(state.category)) &&
    (!q || norm(`${p.name} ${p.description}`).includes(q)));
}

function renderChips() {
  const { categories, products } = state.catalog;
  const counts = new Map();
  products.forEach((p) => counts.set(p.category_id, (counts.get(p.category_id) || 0) + 1));
  const list = [{ id: 'all', name: 'Todos', n: products.length },
    ...categories.filter((c) => counts.get(c.id)).map((c) => ({ id: c.id, name: c.name, n: counts.get(c.id) }))];
  $('#category-chips').innerHTML = list.map((c) =>
    `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${String(state.category) === String(c.id)}">${esc(c.name)} <span class="count">${c.n}</span></button>`).join('');
}

function productCard(p) {
  const c = state.cart[p.id];
  const qty = c?.qty || 0;
  const [bg, ink] = tileFor(p.category_id);
  const thumb = p.image_url
    ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">`
    : `<span style="color:${ink}">${icon('bread', { size: 44, stroke: 1.4 })}</span>`;
  let control;
  if (!p.available) control = '<span class="unavail-text">Indisponível no momento</span>';
  else if (!qty) control = `<button type="button" class="add-btn" data-add="${p.id}" aria-label="Adicionar ${esc(p.name)}">${icon('plus', { size: 16, stroke: 2.6 })} Adicionar</button>`;
  else control = `
    <div class="stepper-qty" role="group" aria-label="Quantidade de ${esc(p.name)}">
      <button type="button" data-dec="${p.id}" aria-label="Diminuir">−</button>
      <input type="number" inputmode="numeric" min="0" max="${p.max_quantity}" value="${qty}" data-qty="${p.id}" aria-label="Quantidade">
      <button type="button" data-inc="${p.id}" aria-label="Aumentar">+</button>
    </div>`;
  return `
    <article class="product ${qty ? 'in-cart' : ''} ${p.available ? '' : 'unavailable'}">
      <div class="thumb" style="background:${bg}">${thumb}</div>
      <div class="p-body">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.description)}</p>
        ${p.min_quantity > 1 ? `<span class="min-tag">Mínimo ${p.min_quantity} ${esc(p.unit_label)}</span>` : ''}
        <div class="p-foot">
          <span class="price num">${money(p.price_cents)} <small>/ ${esc(p.unit_label)}</small></span>
          ${control}
        </div>
      </div>
    </article>`;
}

function renderProducts() {
  const list = visibleProducts();
  if (!state.catalog.products.length) {
    $('#products').innerHTML = '<p class="empty">Nenhum produto disponível no momento.</p>';
    return;
  }
  if (!list.length) {
    $('#products').innerHTML = `<p class="empty">Nada encontrado para “${esc(state.search)}”.</p>`;
    return;
  }
  const active = document.activeElement?.dataset?.qty;
  $('#products').innerHTML = state.catalog.categories.map((c) => {
    const items = list.filter((p) => p.category_id === c.id);
    if (!items.length) return '';
    return `<section class="cat-group"><h2>${esc(c.name)}</h2><div class="grid-products">${items.map(productCard).join('')}</div></section>`;
  }).join('');
  if (active) {
    const el = document.querySelector(`[data-qty="${active}"]`);
    if (el) { el.focus(); el.setSelectionRange?.(99, 99); }
  }
}

function renderCart() {
  const lines = cartLines();
  const total = cartTotal();
  const units = lines.reduce((s, l) => s + l.qty, 0);
  $('#cart-empty').classList.toggle('hidden', lines.length > 0);
  $('#cart-count').textContent = lines.length ? `${lines.length} ${lines.length === 1 ? 'produto' : 'produtos'}` : '';
  $('#cart-items').innerHTML = lines.map((l) => {
    const showNote = l.noteOpen || l.notes;
    return `
    <li class="cart-item">
      <div class="top">
        <div><div class="name">${esc(l.product.name)}</div>
          <div class="line num">${l.qty} ${esc(l.product.unit_label)} × ${money(l.product.price_cents)}</div></div>
        <span class="sub">${money(l.product.price_cents * l.qty)}</span>
      </div>
      ${showNote ? `<input class="item-note" data-note="${l.product.id}" maxlength="200" value="${esc(l.notes || '')}" placeholder="Ex.: sem lactose, bem assado" aria-label="Observação para ${esc(l.product.name)}">` : ''}
      <div class="actions">
        ${showNote ? '' : `<button type="button" data-open-note="${l.product.id}">+ Observação</button>`}
        <button type="button" class="rm" data-remove="${l.product.id}">Remover</button>
      </div>
    </li>`;
  }).join('');
  $('#cart-subtotal').textContent = money(total);
  $('#cart-total').textContent = money(total);
  $('#go-checkout').disabled = !lines.length;
  $('#mobile-total').textContent = money(total);
  $('#mobile-count').textContent = `${lines.length} ${lines.length === 1 ? 'produto' : 'produtos'} · ${units} ${units === 1 ? 'item' : 'itens'}`;
  $('#mobile-bar').hidden = !lines.length || !$('#view-checkout').classList.contains('hidden');
  renderSummary();
}

// ================================================================ data e horário
function renderDays() {
  const { today, minDate, maxDate } = state.config;
  const days = [today];
  for (let i = 0; days.length < 7; i++) {
    const d = addDays(minDate, i);
    if (d > maxDate) break;
    days.push(d);
  }
  const custom = state.date && !days.includes(state.date);
  $('#days').innerHTML = days.map((d) => {
    const off = d < minDate;
    const [, , dd] = d.split('-');
    return `<button type="button" class="day" role="radio" aria-checked="${state.date === d}" ${off ? 'disabled' : ''} data-day="${d}">
      <span class="wd">${WEEKDAYS[weekday(d)]}</span><span class="dd">${dd}</span>
      <span class="sub">${d === today ? 'Hoje' : (off ? 'Indisponível' : 'Disponível')}</span></button>`;
  }).join('');
  const other = $('#other-date');
  other.min = minDate;
  other.max = maxDate;
  if (custom) { other.classList.remove('hidden'); other.value = state.date; }
}

async function selectDate(date) {
  if (!date || date < state.config.minDate || date > state.config.maxDate) {
    toast(`Escolha uma data entre ${dateBr(state.config.minDate, false)} e ${dateBr(state.config.maxDate, false)}.`, 'error');
    return;
  }
  state.date = date;
  renderDays();
  renderSummary();
  $('#slots').innerHTML = '<div class="skeleton" style="height:70px;grid-column:1/-1"></div>';
  try {
    const r = await api(`${STORE_API}/availability?date=${date}`);
    state.slots = r.slots;
  } catch {
    // sem vagas calculadas: mostra os horários sem a contagem
    state.slots = state.catalog.time_slots.map((s) => ({ ...s, remaining: null, full: false }));
  }
  const cur = state.slots.find((s) => s.id === state.slotId);
  if (!cur || cur.full) state.slotId = state.slots.find((s) => !s.full)?.id ?? null;
  renderSlots();
  renderSummary();
}

function renderSlots() {
  const ful = document.querySelector('[name=fulfillment]:checked')?.value;
  $('#slots-title').textContent = ful === 'entrega' ? 'Horário de entrega' : 'Horário de retirada';
  if (!state.slots.length) {
    $('#slots').innerHTML = '<p class="muted">Nenhum horário disponível para esta data.</p>';
    return;
  }
  $('#slots').innerHTML = state.slots.map((s) => {
    const label = s.full ? 'Lotado'
      : s.remaining == null ? 'Disponível'
      : `Resta${s.remaining === 1 ? '' : 'm'} ${s.remaining} vaga${s.remaining === 1 ? '' : 's'}`;
    return `<button type="button" class="slot" role="radio" aria-checked="${state.slotId === s.id}" ${s.full ? 'disabled' : ''} data-slot="${s.id}">
      <span class="t">${esc(s.label)}</span><span class="r">${label}</span></button>`;
  }).join('');
}

function renderSummary() {
  const lines = cartLines();
  $('#summary-items').innerHTML = lines.map((l) =>
    `<li><span class="n">${l.qty} ${esc(l.product.unit_label)} · ${esc(l.product.name)}</span><span class="num">${money(l.product.price_cents * l.qty)}</span></li>`).join('');
  $('#summary-total').textContent = money(cartTotal());
  const ful = document.querySelector('[name=fulfillment]:checked')?.value || 'retirada';
  const slot = state.slots.find((s) => s.id === state.slotId);
  $('#summary-when').innerHTML = `
    <span>${icon(ful === 'entrega' ? 'truck' : 'store')} ${ful === 'entrega' ? 'Entrega' : 'Retirada na loja'}</span>
    <span>${icon('calendar')} ${state.date ? `${esc(longDate(state.date))}${slot ? ` · ${esc(slot.label)}` : ''}` : '<span class="pending">Escolha o dia e o horário</span>'}</span>`;
}

// ================================================================ navegação entre etapas
function showView(name) {
  $('#view-catalog').classList.toggle('hidden', name !== 'catalog');
  $('#view-checkout').classList.toggle('hidden', name !== 'checkout');
  $('#view-success').classList.toggle('hidden', name !== 'success');
  $('#back-to-catalog').classList.toggle('hidden', name !== 'checkout');
  document.body.classList.toggle('in-checkout', name === 'checkout');
  setStep(name === 'checkout' ? 2 : 1);
  $('#mobile-bar').hidden = name !== 'catalog' || !cartLines().length;
  window.scrollTo({ top: 0 });
}

function goCheckout() {
  if (!cartLines().length) return;
  showView('checkout');
  if (!state.date) selectDate(state.config.minDate);
  else renderSummary();
}

/** Etapa atual no indicador (2 = data/horário, 3 = dados). */
function setStep(n) {
  document.querySelectorAll('.stepper li').forEach((li, i) => {
    li.classList.toggle('done', i + 1 < n);
    li.classList.toggle('current', i + 1 === n);
    li.querySelector('span').textContent = i + 1 < n ? '✓' : String(i + 1);
  });
}

// ================================================================ envio
function maskPhone(e) {
  const d = e.target.value.replace(/\D/g, '').slice(0, 11);
  let out = d;
  if (d.length > 2) out = `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length > 7) out = `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  e.target.value = out;
}

async function submitOrder(e) {
  e.preventDefault();
  const form = $('#order-form');
  const err = $('#form-error');
  err.textContent = '';
  const fd = new FormData(form);
  const fulfillment = fd.get('fulfillment');
  const lines = cartLines();

  const fail = (msg, el) => { err.textContent = msg; el?.focus(); };
  if (!lines.length) return fail('Seu pedido está vazio.');
  if (fulfillment === 'entrega' && String(fd.get('delivery_address') || '').trim().length < 5) return fail('Informe o endereço para entrega.', form.delivery_address);
  if (!state.date) return fail('Escolha o dia.');
  if (!state.slotId) return fail('Escolha um horário disponível.');
  if (String(fd.get('customer_name') || '').trim().length < 2) return fail('Informe seu nome.', form.customer_name);
  if (String(fd.get('customer_phone') || '').replace(/\D/g, '').length < 10) return fail('Informe o WhatsApp com DDD.', form.customer_phone);

  const payload = {
    customer_name: fd.get('customer_name'),
    customer_phone: fd.get('customer_phone'),
    fulfillment,
    delivery_address: fulfillment === 'entrega' ? fd.get('delivery_address') : '',
    delivery_date: state.date,
    time_slot_id: state.slotId,
    notes: fd.get('notes'),
    expected_total_cents: cartTotal(), // o servidor recalcula e compara
    items: lines.map((l) => ({ product_id: l.product.id, quantity: l.qty, notes: l.notes || '' })),
  };

  state.submitting = true;
  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.lastChild.textContent = ' Enviando…';
  try {
    const order = await api(`${STORE_API}/orders`, { method: 'POST', body: payload });
    showSuccess(order);
  } catch (ex) {
    err.textContent = ex.message;
    if (['PRECO_ALTERADO', 'PRODUTO_INDISPONIVEL'].includes(ex.code)) {
      await loadCatalog();
      const removed = reconcileCart();
      renderProducts(); renderCart();
      toast(removed ? 'Alguns itens saíram do cardápio e foram removidos.' : 'Os preços foram atualizados. Confira o total.', 'error', 6000);
    }
    if (ex.code === 'HORARIO_LOTADO') selectDate(state.date);
  } finally {
    state.submitting = false;
    btn.disabled = false;
    btn.lastChild.textContent = ' Confirmar encomenda';
  }
}

function showSuccess(order) {
  state.cart = {};
  saveCart();
  renderCart();
  renderProducts();
  showView('success');
  $('#success-code').textContent = `#${order.code}`;
  $('#success-summary').innerHTML = `
    <p><strong>${order.fulfillment === 'entrega' ? 'Entrega' : 'Retirada'}:</strong> ${esc(longDate(order.delivery_date))}, ${esc(order.time_slot_label)}</p>
    <ul>${order.items.map((i) => `<li>${i.quantity} ${esc(i.unit_label)} — ${esc(i.product_name)}</li>`).join('')}</ul>
    <p><strong>Total: ${money(order.total_cents)}</strong></p>
    <p class="small muted">Contato: ${esc(phoneBr(order.customer_phone))}</p>`;
  $('#success-track').href = `/loja/${SLUG}/acompanhar?pedido=${order.code}&tel=${encodeURIComponent(order.customer_phone)}`;
}

// ================================================================ eventos
function bindEvents() {
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderProducts(); });
  $('#category-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.category = b.dataset.cat;
    renderChips();
    renderProducts();
  });

  $('#products').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.add) setQty(t.dataset.add, productById(t.dataset.add).min_quantity);
    if (t.dataset.inc) setQty(t.dataset.inc, state.cart[t.dataset.inc].qty + 1);
    if (t.dataset.dec) {
      const p = productById(t.dataset.dec);
      const next = state.cart[p.id].qty - 1;
      setQty(p.id, next < p.min_quantity ? 0 : next);
    }
  });
  $('#products').addEventListener('change', (e) => {
    if (e.target.dataset.qty) setQty(e.target.dataset.qty, e.target.value);
  });

  $('#cart-items').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.remove) setQty(t.dataset.remove, 0);
    if (t.dataset.openNote) {
      state.cart[t.dataset.openNote].noteOpen = true;
      renderCart();
      document.querySelector(`[data-note="${t.dataset.openNote}"]`)?.focus();
    }
  });
  $('#cart-items').addEventListener('input', (e) => {
    const id = e.target.dataset.note;
    if (id && state.cart[id]) { state.cart[id].notes = e.target.value; saveCart(); }
  });

  $('#go-checkout').addEventListener('click', goCheckout);
  $('#mobile-continue').addEventListener('click', goCheckout);
  $('#back-to-catalog').addEventListener('click', () => showView('catalog'));
  $('#edit-items').addEventListener('click', () => showView('catalog'));
  $('#brand-link').addEventListener('click', (e) => { e.preventDefault(); showView('catalog'); });

  $('#days').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (b && !b.disabled) selectDate(b.dataset.day);
  });
  $('#other-date-btn').addEventListener('click', () => {
    const el = $('#other-date');
    el.classList.remove('hidden');
    el.focus();
    el.showPicker?.();
  });
  $('#other-date').addEventListener('change', (e) => selectDate(e.target.value));
  $('#slots').addEventListener('click', (e) => {
    const b = e.target.closest('[data-slot]');
    if (!b || b.disabled) return;
    state.slotId = Number(b.dataset.slot);
    renderSlots();
    renderSummary();
  });

  const form = $('#order-form');
  form.addEventListener('submit', submitOrder);
  form.customer_phone.addEventListener('input', maskPhone);
  form.addEventListener('focusin', (e) => {
    setStep(['customer_name', 'customer_phone', 'notes'].includes(e.target.name) ? 3 : 2);
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'fulfillment') {
      $('#address-field').classList.toggle('hidden', e.target.value !== 'entrega');
      renderSlots();
      renderSummary();
    }
  });

  $('#new-order').addEventListener('click', () => {
    form.reset();
    $('#address-field').classList.add('hidden');
    showView('catalog');
  });
}

// ================================================================ início
async function loadCatalog() {
  state.catalog = await api(`${STORE_API}/catalog`);
}

function showNotFound(err) {
  if (err?.code === 'LOJA_INDISPONIVEL') {
    $('#notfound-title').textContent = 'Encomendas pausadas';
    $('#notfound-text').textContent = 'Esta loja não está aceitando encomendas pelo site no momento. Fale direto com o estabelecimento.';
  }
  ['#view-catalog', '#view-checkout', '#view-success'].forEach((s) => $(s).classList.add('hidden'));
  $('#view-notfound').classList.remove('hidden');
  $('#track-link').classList.add('hidden');
}

function fillStoreInfo(c) {
  document.title = `Encomendas — ${c.storeName}`;
  $('#store-name').textContent = c.storeName;
  // cores e logo da padaria (o servidor já manda a página pronta; aqui é o reforço)
  applyBrand(c.brand);
  placeLogo($('.brand-mark'), c.brand);
  $('#brand-link').href = `/loja/${SLUG}`;
  $('#track-link').href = `/loja/${SLUG}/acompanhar`;
  if (c.address) $('#pickup-address').textContent = `Sem taxa · ${c.address}`;
  $('#footer-name').textContent = c.storeName;
  $('#footer-address').innerHTML = c.address ? `${icon('pin', { size: 16 })}${esc(c.address)}` : '';
  $('#footer-phone').innerHTML = c.phone ? `${icon('chat', { size: 16 })}${esc(phoneBr(c.phone))}` : '';
  $('#store-footer').classList.remove('hidden');
}

async function init() {
  hydrateIcons();
  bindEvents();
  if (!SLUG) { showNotFound(); return; }
  try {
    const [config] = await Promise.all([api(STORE_API), loadCatalog()]);
    state.config = config;
    fillStoreInfo(config);
    $('#next-date').textContent = `Próxima data: ${dateBr(config.minDate)}`;
    const slots = state.catalog.time_slots;
    if (slots.length) {
      $('#hours-range').textContent = `Horários das ${hhmm(slots[0].start_time)} às ${hhmm(slots[slots.length - 1].end_time)}`;
    }
    renderDays();
    if (reconcileCart()) toast('Alguns itens do seu carrinho não estão mais disponíveis.');
    renderChips();
    renderProducts();
    renderCart();
  } catch (e) {
    if (e.status === 404) { showNotFound(e); return; }
    $('#products').innerHTML = `<p class="empty">Não foi possível carregar o cardápio. ${esc(e.message)}</p>`;
  }
}

init();
