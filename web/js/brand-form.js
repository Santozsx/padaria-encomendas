// Formulário de "Aparência" da loja: logo + cor principal + cor secundária,
// com prévia ao vivo. Usado no Atendimento (administrador da loja) e no
// Painel do sistema (dono do SaaS deixando a loja pronta para o cliente).
import { api, esc, toast, icon } from './common.js';

// Visual padrão do sistema (para a prévia quando a loja não tem cores)
const DEFAULT_VARS = {
  '--brand': '#0E6E63', '--brand-hover': '#0A574E', '--brand-ink': '#FFFFFF', '--brand-soft': '#E3F2EF',
  '--brand-text': '#0A574E', '--bg': '#F5F7F6', '--surface-2': '#E6F0EE',
};
const DEFAULT_SIDE = { '--brand-2': '#13262B', '--brand-2-ink': '#FFFFFF' };

// Sugestões comuns em padarias
const PRESETS = ['#7A3E12', '#A0522D', '#C0392B', '#D35400', '#E1A100', '#2E7D32', '#0E6E63', '#1F4E79', '#6A1B9A', '#222222'];
const PRESETS_2 = ['#2B1A10', '#3E2723', '#1B2A41', '#13262B', '#FFF4D6', '#FDEBD0', '#F5F0E6', '#FFFFFF'];

const LOGO_MAX_SIDE = 512;
const LOGO_TARGET_BYTES = 420 * 1024;

const isHex = (v) => /^#[0-9A-F]{6}$/.test(v);
function cleanHex(v) {
  let s = String(v || '').trim().toUpperCase();
  if (!s) return '';
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9A-F]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return isHex(s) ? s : null;
}

/** Lê o arquivo, reduz para no máx. 512 px e devolve { dataUrl, base64, bytes }. */
async function shrinkImage(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Use uma imagem PNG, JPG ou WebP.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Não consegui abrir essa imagem.'));
      i.src = url;
    });
    const scale = Math.min(1, LOGO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const keepAlpha = file.type !== 'image/jpeg';
    let side = scale;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const w = Math.max(1, Math.round(img.naturalWidth * side));
      const h = Math.max(1, Math.round(img.naturalHeight * side));
      const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = canvas.getContext('2d');
      if (!keepAlpha) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(img, 0, 0, w, h);
      const type = keepAlpha ? (attempt === 0 ? 'image/png' : 'image/webp') : 'image/jpeg';
      const dataUrl = canvas.toDataURL(type, 0.88);
      const base64 = dataUrl.split(',')[1];
      const bytes = Math.floor(base64.length * 0.75);
      if (bytes <= LOGO_TARGET_BYTES) return { dataUrl, base64, bytes, canvas };
      side *= 0.8;
    }
    throw new Error('A imagem ficou grande demais mesmo reduzida. Tente outra logo.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Cores mais presentes na logo (ignora branco, preto, cinza e transparente). */
function logoColors(canvas, max = 5) {
  const size = 48;
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 200) continue;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn < 28) continue; // cinzas, branco e preto
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n += 1; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
  const found = [...buckets.values()].sort((x, y) => y.n - x.n)
    .map((e) => `#${hex(e.r / e.n)}${hex(e.g / e.n)}${hex(e.b / e.n)}`.toUpperCase());
  // evita sugerir tons quase iguais
  const out = [];
  for (const h of found) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (out.every((o) => {
      const [r2, g2, b2] = [1, 3, 5].map((i) => parseInt(o.slice(i, i + 2), 16));
      return Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2) > 70;
    })) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Monta o formulário dentro de `root`.
 * @param {HTMLElement} root
 * @param {{ load: () => Promise<any>, save: (body: object) => Promise<any>, onSaved?: (brand: any) => void, storeName?: string }} opts
 */
export async function mountBrandForm(root, { load, save, onSaved, storeName = 'Sua padaria' }) {
  root.innerHTML = '<div class="skeleton" style="height:320px"></div>';
  let current;
  try {
    current = await load();
  } catch (e) {
    root.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p></div>`;
    return;
  }
  const st = {
    primary: current.primary || '',
    secondary: current.secondary || '',
    logoUrl: current.logo_url || null, // logo salva
    newLogo: null,                     // { base64, dataUrl } escolhida agora
    removeLogo: false,
    suggestions: [],
  };

  root.innerHTML = `
    ${current.ready === false ? `<div class="license-banner warn" style="margin-bottom:14px">${icon('alert', { size: 18 })}<span>Falta rodar <b>supabase/migrations/009_identidade_visual.sql</b> no Supabase para salvar a aparência.</span></div>` : ''}
    <form class="brand-form" novalidate>
      <div class="col" style="display:grid;gap:16px">
        <section class="card">
          <h2>Logo</h2>
          <div class="logo-drop">
            <div class="logo-preview" data-logo-preview></div>
            <div style="display:grid;gap:8px">
              <label class="btn" style="cursor:pointer">${icon('image', { size: 18 })}Escolher imagem
                <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" data-logo-file>
              </label>
              <button type="button" class="btn ghost sm" data-logo-remove>Remover logo</button>
            </div>
          </div>
          <p class="muted small no-margin">PNG com fundo transparente fica melhor. JPG e WebP também servem. A imagem é reduzida automaticamente. Ela aparece no topo da loja, no ícone da aba do navegador, no atendimento e na TV da cozinha.</p>
          <div data-suggest-wrap class="hidden">
            <small class="muted">Cores da sua logo (clique para usar):</small>
            <div class="swatches" data-suggest></div>
          </div>
        </section>

        <section class="card">
          <h2>Cor principal</h2>
          <p class="muted small no-margin">Botões, destaques, dia e horário escolhidos, links.</p>
          <div class="color-row">
            <input type="color" data-c="primary" aria-label="Cor principal">
            <input type="text" data-t="primary" maxlength="7" placeholder="#7A3E12" aria-label="Código da cor principal">
            <button type="button" class="btn ghost sm" data-clear="primary">Usar a padrão</button>
          </div>
          <div class="swatches" data-presets="primary"></div>
        </section>

        <section class="card">
          <h2>Cor secundária <span class="muted small">(opcional)</span></h2>
          <p class="muted small no-margin">Menu lateral do atendimento e detalhes da loja. Sem ela, o menu fica escuro.</p>
          <div class="color-row">
            <input type="color" data-c="secondary" aria-label="Cor secundária">
            <input type="text" data-t="secondary" maxlength="7" placeholder="#2B1A10" aria-label="Código da cor secundária">
            <button type="button" class="btn ghost sm" data-clear="secondary">Sem cor secundária</button>
          </div>
          <div class="swatches" data-presets="secondary"></div>
        </section>
      </div>

      <div style="display:grid;gap:16px;position:sticky;top:16px">
        <section class="card">
          <h2>Prévia</h2>
          <div class="bp" data-preview>
            <div class="bp-top">
              <span data-pv-logo></span>
              <strong style="font-family:var(--serif)">${esc(storeName)}</strong>
            </div>
            <div class="bp-hero" style="background:var(--surface-2)">
              <strong>Encomende hoje, a gente prepara fresquinho.</strong>
              <div class="bp-row">
                <span class="bp-step" style="background:var(--brand-2);color:var(--brand-2-ink)">1</span>
                <span class="bp-btn" style="background:var(--brand);color:var(--brand-ink)">Adicionar</span>
                <span class="bp-btn" style="background:var(--brand-soft);border:2px solid var(--brand);color:var(--ink)">14:30</span>
                <span class="bp-link" style="color:var(--brand-text)">Acompanhar pedido</span>
              </div>
            </div>
            <div class="bp-side" style="background:var(--brand-2);color:var(--brand-2-ink)">
              <span data-pv-logo-side></span>
              <span class="bp-nav" style="background:rgba(127,127,127,.25)">Pedidos</span>
              <span class="bp-nav" style="opacity:.8">Produtos</span>
            </div>
          </div>
          <p class="contrast-note" data-note></p>
        </section>
        <div class="row" style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
          <button type="button" class="btn ghost" data-reset>Voltar ao visual padrão</button>
          <button type="submit" class="btn primary">${icon('check', { size: 18 })}Salvar aparência</button>
        </div>
      </div>
    </form>`;

  const $ = (s) => root.querySelector(s);
  const form = $('form');
  const preview = $('[data-preview]');

  const swatch = (c, kind) => `<button type="button" title="${c}" aria-label="Usar ${c}" data-pick="${kind}" data-color="${c}" style="background:${c}"></button>`;
  $('[data-presets="primary"]').innerHTML = PRESETS.map((c) => swatch(c, 'primary')).join('');
  $('[data-presets="secondary"]').innerHTML = PRESETS_2.map((c) => swatch(c, 'secondary')).join('');

  function logoSrc() {
    if (st.newLogo) return st.newLogo.dataUrl;
    if (st.removeLogo) return null;
    return st.logoUrl;
  }

  let seq = 0;
  async function refreshPreview() {
    // campos
    for (const k of ['primary', 'secondary']) {
      $(`[data-c="${k}"]`).value = st[k] || (k === 'primary' ? '#0E6E63' : '#13262B');
      const t = $(`[data-t="${k}"]`);
      if (document.activeElement !== t) t.value = st[k];
    }
    const src = logoSrc();
    $('[data-logo-preview]').innerHTML = src ? `<img src="${esc(src)}" alt="Logo">` : '<span>Sem logo<br>(usa o ícone padrão)</span>';
    $('[data-logo-remove]').classList.toggle('hidden', !src);
    const mark = src
      ? `<img src="${esc(src)}" alt="" style="height:30px;max-width:110px;object-fit:contain">`
      : `<span class="bp-mark" style="background:var(--brand);color:var(--brand-ink)">${icon('bread', { size: 18 })}</span>`;
    $('[data-pv-logo]').innerHTML = mark;
    $('[data-pv-logo-side]').innerHTML = src
      ? `<span class="logo-tile" style="height:34px"><img src="${esc(src)}" alt="" style="max-height:26px"></span>`
      : '';
    const sug = $('[data-suggest]');
    $('[data-suggest-wrap]').classList.toggle('hidden', !st.suggestions.length);
    sug.innerHTML = st.suggestions.map((c) => swatch(c, 'primary')).join('');

    // paleta calculada pelo servidor (mesmo contraste das telas)
    const my = ++seq;
    let pal = { vars: null };
    if (st.primary || st.secondary) {
      try {
        pal = await api(`/public/brand-palette?p=${encodeURIComponent(st.primary)}&s=${encodeURIComponent(st.secondary)}`);
      } catch { /* sem prévia exata: usa o padrão */ }
    }
    if (my !== seq) return;
    const vars = { ...DEFAULT_VARS, ...DEFAULT_SIDE, ...(pal.vars || {}) };
    for (const [k, v] of Object.entries(vars)) preview.style.setProperty(k, v);
    preview.style.setProperty('--bp-bg', vars['--bg']);
    const notes = [];
    if (pal.vars && st.primary && pal.vars['--brand'] !== st.primary) notes.push('A cor principal foi escurecida um pouco nos botões para o texto ficar legível.');
    if (pal.vars && pal.vars['--brand-ink'] && pal.vars['--brand-ink'] !== '#FFFFFF') notes.push('Cor clara: o texto dos botões fica escuro.');
    $('[data-note]').textContent = notes.join(' ');
  }

  function setColor(kind, value) {
    const v = cleanHex(value);
    if (v === null) return false;
    st[kind] = v;
    refreshPreview();
    return true;
  }

  root.addEventListener('input', (e) => {
    const c = e.target.closest('[data-c]');
    if (c) { setColor(c.dataset.c, c.value); return; }
    const t = e.target.closest('[data-t]');
    if (t) {
      const v = cleanHex(t.value);
      t.setAttribute('aria-invalid', String(v === null));
      if (v !== null && (v === '' || v.length === 7)) setColor(t.dataset.t, v);
    }
  });
  root.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) { setColor(pick.dataset.pick, pick.dataset.color); return; }
    const clear = e.target.closest('[data-clear]');
    if (clear) { st[clear.dataset.clear] = ''; refreshPreview(); return; }
    if (e.target.closest('[data-logo-remove]')) {
      st.newLogo = null;
      st.removeLogo = Boolean(st.logoUrl);
      st.suggestions = [];
      $('[data-logo-file]').value = '';
      refreshPreview();
      return;
    }
    if (e.target.closest('[data-reset]')) {
      st.primary = '';
      st.secondary = '';
      refreshPreview();
      toast('Cores voltaram ao padrão. Clique em "Salvar aparência" para confirmar.');
    }
  });
  $('[data-logo-file]').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const shrunk = await shrinkImage(file);
      st.newLogo = shrunk;
      st.removeLogo = false;
      st.suggestions = logoColors(shrunk.canvas);
      // primeira vez: já sugere a cor principal a partir da logo
      if (!st.primary && st.suggestions[0]) st.primary = st.suggestions[0];
      refreshPreview();
    } catch (err) {
      toast(err.message, 'error');
      e.target.value = '';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const body = { brand_color: st.primary || null, brand_color_2: st.secondary || null };
    if (st.newLogo) body.logo = st.newLogo.base64;
    else if (st.removeLogo) body.remove_logo = true;
    btn.disabled = true;
    try {
      const saved = await save(body);
      st.logoUrl = saved.logo_url || null;
      st.newLogo = null;
      st.removeLogo = false;
      toast('Aparência salva. A loja e as telas já estão com o novo visual.', 'ok');
      onSaved?.(saved);
      refreshPreview();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  refreshPreview();
}
