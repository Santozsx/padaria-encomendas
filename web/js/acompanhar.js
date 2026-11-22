// Acompanhamento do pedido pelo cliente (nº + telefone).
import { api, esc, money, dateBr, statusBadge, icon, hydrateIcons } from './common.js';

hydrateIcons();
const SLUG = (location.pathname.match(/^\/loja\/([a-z0-9-]+)/) || [])[1] || null;
const STORE_API = `/public/stores/${SLUG}`;
const form = document.getElementById('track-form');
const out = document.getElementById('track-result');
const err = document.getElementById('track-error');
const STEPS = [
  ['recebido', 'Recebido'],
  ['em_producao', 'Em produção'],
  ['pronto', 'Pronto'],
  ['entregue', 'Entregue'],
];

document.querySelectorAll('[data-store-link]').forEach((a) => { a.href = `/loja/${SLUG}`; });
api(STORE_API).then((c) => {
  document.getElementById('store-name').textContent = c.storeName;
  document.title = `Acompanhar pedido — ${c.storeName}`;
}).catch(() => { document.getElementById('track-error').textContent = 'Loja não encontrada. Confira o link.'; });

async function consult(code, phone) {
  err.textContent = '';
  out.innerHTML = '<div class="skeleton" style="height:140px"></div>';
  try {
    const o = await api(`${STORE_API}/orders/${encodeURIComponent(code)}?phone=${encodeURIComponent(phone)}`);
    const idx = STEPS.findIndex(([s]) => s === o.status);
    const timeline = o.status === 'cancelado'
      ? '<p><span class="badge st-cancelado">Pedido cancelado</span></p>'
      : `<ol class="timeline">${STEPS.map(([, label], i) => `
          <li class="${i <= idx ? 'done' : ''} ${i === idx ? 'current' : ''}">
            <span class="dot"><i>${i <= idx ? icon('check', { size: 14, stroke: 3 }) : ''}</i><b class="${i < idx ? 'on' : ''}"></b></span>
            ${esc(label)}
          </li>`).join('')}</ol>`;
    out.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px">
        <h2 style="font-size:24px">Pedido #${o.code}</h2>${statusBadge(o.status)}
      </div>
      <p>${o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada'} em <strong>${esc(dateBr(o.delivery_date))}</strong>, ${esc(o.time_slot_label)}</p>
      ${timeline}
      <ul>${o.items.map((i) => `<li>${i.quantity} ${esc(i.unit_label)} — ${esc(i.product_name)}</li>`).join('')}</ul>
      <p><strong>Total: ${money(o.total_cents)}</strong></p>`;
  } catch (e) {
    out.innerHTML = '';
    err.textContent = e.message;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  consult(form.code.value.trim(), form.phone.value);
});

const params = new URLSearchParams(location.search);
if (params.get('pedido') && params.get('tel')) {
  form.code.value = params.get('pedido');
  form.phone.value = params.get('tel');
  consult(form.code.value, form.phone.value);
}
