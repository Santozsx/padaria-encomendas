// Utilitários compartilhados pelas telas web (cliente e atendimento).

/** Chamada à API com tratamento de erro padronizado. */
export async function api(path, { method = 'GET', body, token, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'SEM_CONEXAO', 'Sem conexão com o servidor. Verifique a internet.');
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw new ApiError(res.status, e.code || 'ERRO', e.message || 'Erro inesperado.', e.details);
  }
  return data;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents) => brl.format((Number(cents) || 0) / 100);

/** '2026-11-20' -> 'sex., 20/11' */
export function dateBr(iso, withWeekday = true) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const opts = { day: '2-digit', month: '2-digit', timeZone: 'UTC', ...(withWeekday ? { weekday: 'short' } : {}) };
  return new Intl.DateTimeFormat('pt-BR', opts).format(dt);
}

export function timeBr(ts) {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(ts));
}

export function phoneBr(digits = '') {
  const d = digits.replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return digits;
}

/** Escapa HTML — TODO conteúdo vindo do usuário passa por aqui. */
export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const STATUS = {
  recebido:    { label: 'Recebido',    cls: 'st-recebido' },
  em_producao: { label: 'Em produção', cls: 'st-producao' },
  pronto:      { label: 'Pronto',      cls: 'st-pronto' },
  entregue:    { label: 'Entregue',    cls: 'st-entregue' },
  cancelado:   { label: 'Cancelado',   cls: 'st-cancelado' },
};
export const ITEM_STATUS = {
  pendente:    'A produzir',
  em_producao: 'Em produção',
  produzido:   'Produzido',
};

export function statusBadge(status) {
  const s = STATUS[status] || { label: status, cls: '' };
  return `<span class="badge ${s.cls}">${esc(s.label)}</span>`;
}

/** Aviso flutuante simples. */
export function toast(message, type = 'info', ms = 4000) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Diálogo de confirmação acessível (usa <dialog>). Opcionalmente pede um texto. */
export function confirmDialog({ title, message, confirmText = 'Confirmar', danger = false, input = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm';
    dlg.innerHTML = `
      <form method="dialog">
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        ${input ? `<label class="field"><span>${esc(input.label)}</span>
          <input name="txt" required minlength="${input.minLength || 0}" maxlength="300" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" autocomplete="off" spellcheck="false"></label>` : ''}
        <div class="actions">
          <button type="button" class="btn ghost" value="cancel">Voltar</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(confirmText)}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const txt = dlg.querySelector('input[name=txt]');
    dlg.querySelector('[value=cancel]').addEventListener('click', () => dlg.close('cancel'));
    form.addEventListener('submit', (e) => {
      if (txt && !txt.checkValidity()) { e.preventDefault(); txt.reportValidity(); return; }
      dlg.returnValue = 'ok';
    });
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      resolve(ok ? (txt ? txt.value.trim() : true) : false);
      dlg.remove();
    });
    dlg.showModal();
    (txt || dlg.querySelector('[value=ok]')).focus();
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- Ícones (traço, sem emoji) ---------- */
const ICONS = {
  bread: '<path d="M4 13c0-4.4 3.6-8 8-8s8 3.6 8 8v4H4z"/><path d="M9 9l-1 4M12 8v5M15 9l1 4"/>',
  store: '<path d="M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9h18M9 20v-6h6v6"/>',
  truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  chat: '<path d="M21 12a9 9 0 0 1-13.5 7.8L3 21l1.3-4.4A9 9 0 1 1 21 12z"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  board: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="10" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  tv: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  printer: '<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  dots: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  building: '<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3"/>',
};
export function icon(name, { size = 18, stroke = 1.9, cls = '' } = {}) {
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/** Cores suaves por categoria (fundo, ícone). */
export const CATEGORY_TILES = [
  ['#FCEFD0', '#8A5A00'], ['#F9E0E3', '#9B2C3F'], ['#E3F0E1', '#2F6B3A'],
  ['#ECE3F5', '#5B3A86'], ['#E0ECF4', '#245A80'], ['#F3E6DA', '#7A4A24'],
];

/** Texto sem acentos e minúsculo (para busca). */
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Troca <span data-icon="nome"> pelo SVG correspondente. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.querySelector('svg')) el.innerHTML = icon(el.dataset.icon);
  });
}

// ---------- Licença (SaaS) ----------
const dmy = (iso) => (iso ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso)) : '');

/** Selo colorido com a situação da licença. */
export function licenseBadge(lic) {
  if (!lic) return '';
  return `<span class="badge lic-${esc(lic.state)}">${esc(lic.label || lic.state)}</span>`;
}

/** Frase curta explicando a licença (ex.: "Teste grátis até 05/12 (13 dias)"). */
export function licenseText(lic) {
  if (!lic) return '';
  const days = lic.days_left;
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
  switch (lic.state) {
    case 'cortesia': return 'Liberada sem cobrança.';
    case 'teste': return `Teste grátis até ${dmy(lic.valid_until)}${days != null ? ` (${plural(Math.max(days, 0), 'dia', 'dias')})` : ''}.`;
    case 'ativa': return `Paga até ${dmy(lic.valid_until)}.`;
    case 'atrasada': return `Venceu em ${dmy(lic.valid_until)}. A loja será bloqueada em ${dmy(lic.blocks_at)} se o pagamento não for feito.`;
    case 'bloqueada': return `Venceu em ${dmy(lic.valid_until)}. A loja está bloqueada até o pagamento.`;
    default: return '';
  }
}
export { dmy as dateFull };
