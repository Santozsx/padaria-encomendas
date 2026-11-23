// Painel do sistema (só o dono do sistema): cadastra estabelecimentos e
// administra a equipe de cada um. Toda regra de verdade (CNPJ/CPF válido,
// link único, quem pode entrar) é conferida no servidor; aqui é só a tela.
import {
  api, esc, toast, timeBr, phoneBr, confirmDialog, icon, hydrateIcons, norm, money,
  licenseBadge, licenseText, dateFull,
  setupSidebar,
} from './common.js';
import { createSupabase } from './realtime.js';
import { mountBrandForm } from './brand-form.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const ROLE_LABEL = { admin: 'Administrador', atendimento: 'Atendimento', cozinha: 'Cozinha' };
const state = { sb: null, me: null, list: [], search: '', store: null, team: [], plan: null, billing: null };
const parseMoney = (v) => {
  let t = String(v ?? '').trim().replace(/[R$\s]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
};
const centsToInput = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const MISSING = '<button type="button" class="missing" data-fill>Completar cadastro</button>';
const storeUrl = (slug) => `${location.origin}/loja/${slug}`;

// ------------------------------------------------------------ máscaras
const digits = (v) => String(v ?? '').replace(/\D/g, '');
function maskDoc(v) {
  const d = digits(v).slice(0, 14);
  if (d.length <= 11) { // CPF: 000.000.000-00
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}
function maskPhone(v) {
  const d = digits(v).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
// Igual ao slugify do servidor: "Padaria São João" -> "padaria-sao-joao"
function slugify(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}
function generatePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const raw = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => abc[b % abc.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}
function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

// ------------------------------------------------------------ API
async function token() {
  const { data } = await state.sb.auth.getSession();
  return data.session?.access_token;
}
async function platformApi(path, opts = {}) {
  try {
    return await api(`/platform${path}`, { ...opts, token: await token() });
  } catch (e) {
    if (e.status === 401 && state.me) await logout();
    throw e;
  }
}

// ------------------------------------------------------------ login
async function login(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  $('#login-error').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const { error } = await state.sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) { $('#login-error').textContent = 'E-mail ou senha incorretos.'; return; }
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
    state.me = await platformApi('/me');
  } catch (e) {
    await state.sb.auth.signOut();
    $('#login-error').textContent = e.status === 403
      ? 'Esta conta não é do dono do sistema. Use a opção "Definir dono do sistema" do iniciar.bat.'
      : e.message;
    $('#login-view').classList.remove('hidden');
    return;
  }
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-email').textContent = state.me.email;
  $('#slug-prefix').textContent = `${location.host}/loja/`;
  await loadList();
}

// ------------------------------------------------------------ lista
async function loadList() {
  try {
    const [list, plan] = await Promise.all([platformApi('/establishments'), platformApi('/plan').catch(() => null)]);
    state.list = list;
    if (plan) { state.plan = plan.plan; state.billing = plan.billing; }
  } catch (e) {
    $('#est-table').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  renderList();
}

function renderList() {
  const all = state.list;
  const active = all.filter((e) => e.active);
  $('#est-count').textContent = `${plural(all.length, 'estabelecimento', 'estabelecimentos')} · ${plural(active.length, 'ativo', 'ativos')}`;
  const staff = active.reduce((s, e) => s + e.staff_count, 0);
  const orders = all.reduce((s, e) => s + e.orders_count, 0);
  const paying = all.filter((e) => e.active && e.license?.mode === 'assinatura' && ['ativa', 'atrasada'].includes(e.license?.state));
  const mrr = paying.reduce((sum, e) => sum + (e.license.price_cents || 0), 0);
  $('#est-kpis').className = 'kpis';
  renderPlan();
  $('#est-kpis').innerHTML = `
    <div class="kpi good"><span class="label">Receita mensal</span><span class="value">${money(mrr)}</span><span class="sub">${plural(paying.length, 'loja pagante', 'lojas pagantes')}</span></div>
    <div class="kpi"><span class="label">Lojas ativas</span><span class="value">${active.length}</span><span class="sub">de ${all.length} cadastradas</span></div>
    <div class="kpi"><span class="label">Pessoas com acesso</span><span class="value">${staff}</span><span class="sub">nas lojas ativas</span></div>
    <div class="kpi"><span class="label">Pedidos recebidos</span><span class="value">${orders}</span><span class="sub">somando todas as lojas</span></div>`;

  const q = norm(state.search);
  const rows = all.filter((e) => !q || norm(`${e.name} ${e.doc_number} ${e.doc_formatted} ${e.address} ${e.slug}`).includes(q));
  $('#est-table').innerHTML = `<section class="card table-card"><div class="table-wrap"><table class="data">
    <thead><tr><th>Estabelecimento</th><th>CNPJ / CPF</th><th>Endereço e telefone</th><th>Licença</th><th class="r">Equipe</th><th class="r">Pedidos</th><th>Situação</th><th class="r">Ações</th></tr></thead>
    <tbody>${rows.map((e) => `
      <tr class="${e.active ? '' : 'inactive'}">
        <td><div class="est-name"><b>${esc(e.name)}</b><a href="/loja/${esc(e.slug)}" target="_blank" rel="noopener">/loja/${esc(e.slug)}</a></div></td>
        <td>${e.doc_number ? `<span class="doc-tag">${e.doc_type === 'cnpj' ? 'CNPJ' : 'CPF'}</span>${esc(e.doc_formatted)}` : MISSING}</td>
        <td class="cell-small">${e.address ? esc(e.address) : MISSING}<br>${e.phone ? esc(phoneBr(e.phone)) : ''}</td>
        <td>${licenseCell(e.license)}</td>
        <td class="r">${e.staff_count}${e.admins_count ? '' : `<br><small class="no-admin" title="Sem administrador ativo">sem admin</small>`}</td>
        <td class="r">${e.orders_count}</td>
        <td><button type="button" class="switch" role="switch" aria-checked="${e.active}" data-toggle="${e.id}" aria-label="Loja ${esc(e.name)} ativa">
          <span class="track"></span>${e.active ? 'Ativa' : 'Desativada'}</button></td>
        <td><div class="row-actions">
          <button type="button" class="btn sm" data-open="${e.id}">${icon('users', { size: 16 })}Equipe</button>
          <button type="button" class="btn sm ghost" data-license="${e.id}">${icon('key', { size: 16 })}Licença</button>
          <button type="button" class="btn sm ghost" data-brand="${e.id}">${icon('palette', { size: 16 })}Aparência</button>
          <button type="button" class="btn sm ghost" data-edit="${e.id}">Editar</button>
        </div></td>
      </tr>`).join('') || `<tr><td colspan="8" class="empty">${all.length ? 'Nada encontrado nessa busca.' : 'Nenhum estabelecimento cadastrado ainda. Clique em “Novo estabelecimento”.'}</td></tr>`}
    </tbody></table></div></section>`;
}

function licenseCell(lic) {
  if (!lic) return '';
  let sub = '';
  if (lic.state === 'teste' || lic.state === 'ativa') sub = `até ${dateFull(lic.valid_until)}`;
  else if (lic.state === 'atrasada') sub = `bloqueia ${dateFull(lic.blocks_at)}`;
  else if (lic.state === 'bloqueada') sub = `venceu ${dateFull(lic.valid_until)}`;
  const price = lic.mode === 'assinatura' && lic.price_cents ? `${money(lic.price_cents)}/mês${lic.custom_price ? ' (especial)' : ''}` : '';
  return `<div class="lic-cell">${licenseBadge(lic)}${sub ? `<small>${esc(sub)}</small>` : ''}${price ? `<small>${esc(price)}</small>` : ''}</div>`;
}

function renderPlan() {
  const p = state.plan;
  const b = state.billing;
  if (!p) { $('#plan-card').classList.add('hidden'); return; }
  const chip = !b?.enabled
    ? '<span class="billing-chip off">Cobrança automática desligada</span>'
    : b.env === 'production'
      ? '<span class="billing-chip on">Asaas · cobrança real</span>'
      : '<span class="billing-chip test">Asaas · sandbox (testes)</span>';
  $('#plan-card').innerHTML = `
    <div class="plan-main"><span class="muted small">Plano</span><b>${esc(p.name)} · ${money(p.price_cents)}/mês</b></div>
    <div class="plan-facts"><span>Teste grátis: <b>${p.trial_days} dias</b></span><span>Tolerância: <b>${p.grace_days} dias</b></span>${chip}</div>
    <button type="button" class="btn" id="edit-plan">${icon('pencil', { size: 16 })}Editar plano e preço</button>`;
}

function openPlanDialog() {
  const f = $('#plan-form');
  const p = state.plan;
  f.name.value = p.name;
  f.price.value = centsToInput(p.price_cents);
  f.trial_days.value = p.trial_days;
  f.grace_days.value = p.grace_days;
  f.apply.checked = true;
  $('#plan-error').textContent = '';
  $('#plan-dialog').showModal();
}

async function savePlan(e) {
  e.preventDefault();
  const f = e.target;
  const price = parseMoney(f.price.value);
  if (!price || Number.isNaN(price)) { $('#plan-error').textContent = 'Valor inválido.'; return; }
  const body = { name: f.name.value.trim(), price_cents: price, trial_days: Number(f.trial_days.value), grace_days: Number(f.grace_days.value) };
  const changedPrice = price !== state.plan.price_cents;
  if (changedPrice && f.apply.checked) body.apply_to_subscriptions = true;
  try {
    const r = await platformApi('/plan', { method: 'PUT', body });
    $('#plan-dialog').close();
    state.plan = r.plan;
    const msg = changedPrice && f.apply.checked
      ? `Plano salvo. ${plural(r.subscriptions_updated, 'assinatura atualizada', 'assinaturas atualizadas')} para ${money(price)}.`
      : 'Plano salvo.';
    toast(msg, 'ok', 6000);
    if (r.failed?.length) toast(`Não atualizou: ${r.failed.join(' · ')}`, 'error', 9000);
    loadList();
  } catch (ex) { $('#plan-error').textContent = ex.details?.[0]?.message || ex.message; }
}

let licenseFor = null;
function openLicenseDialog(id) {
  const e = state.list.find((x) => x.id === id);
  licenseFor = e;
  const lic = e.license;
  const f = $('#license-form');
  f.reset();
  $('#license-store').textContent = e.name;
  $('#license-now').innerHTML = `${licenseBadge(lic)} ${esc(licenseText(lic))}`;
  f.mode.value = lic.mode;
  f.price.value = lic.custom_price ? centsToInput(lic.price_cents) : '';
  f.price.placeholder = state.plan ? `${centsToInput(state.plan.price_cents)} (plano)` : 'Preço do plano';
  $('#license-sub').textContent = lic.mode === 'assinatura'
    ? (lic.subscription_status === 'ativa' ? `Assinatura ativa no Asaas · faturas para ${lic.billing_email || '—'}.`
      : lic.subscription_status === 'cancelada' ? 'Assinatura cancelada pela loja.' : 'A loja ainda não assinou (o admin assina em Atendimento → Assinatura).')
    : '';
  $('#license-error').textContent = '';
  $('#license-dialog').showModal();
}

async function saveLicense(ev) {
  ev.preventDefault();
  const f = ev.target;
  const lic = licenseFor.license;
  const body = {};
  if (f.mode.value !== lic.mode) body.mode = f.mode.value;
  const price = parseMoney(f.price.value);
  if (Number.isNaN(price)) { $('#license-error').textContent = 'Preço inválido.'; return; }
  const currentCustom = lic.custom_price ? lic.price_cents : null;
  if (price !== currentCustom) body.custom_price_cents = price;
  if (f.add_days.value) body.add_days = Number(f.add_days.value);
  if (!Object.keys(body).length) { $('#license-dialog').close(); return; }
  try {
    const r = await platformApi(`/establishments/${licenseFor.id}/license`, { method: 'PATCH', body });
    $('#license-dialog').close();
    toast(`Licença atualizada: ${r.license.label}.${r.subscription_updated ? ' O valor da assinatura no Asaas também mudou.' : ''}`, 'ok', 6000);
    loadList();
  } catch (ex) { $('#license-error').textContent = ex.details?.[0]?.message || ex.message; }
}

async function toggleStore(id) {
  const e = state.list.find((x) => x.id === id);
  const turningOff = e.active;
  const ok = await confirmDialog({
    title: turningOff ? `Desativar ${e.name}?` : `Reativar ${e.name}?`,
    message: turningOff
      ? 'O link da loja para de aceitar pedidos e a equipe desta loja não consegue mais entrar. Nada é apagado: você pode reativar depois.'
      : 'O link volta a aceitar pedidos e a equipe volta a entrar.',
    confirmText: turningOff ? 'Desativar' : 'Reativar',
    danger: turningOff,
  });
  if (!ok) return;
  try {
    await platformApi(`/establishments/${id}`, { method: 'PATCH', body: { active: !e.active } });
    toast(turningOff ? 'Loja desativada.' : 'Loja reativada.', 'ok');
  } catch (ex) { toast(ex.message, 'error'); }
  await loadList();
  if (state.store?.id === id) renderStoreCard();
}

// ------------------------------------------------------------ cadastro/edição
function openEstDialog(est = null) {
  const f = $('#est-form');
  f.reset();
  f.dataset.id = est?.id ?? '';
  f.dataset.slugTouched = est ? '1' : '';
  $('#est-error').textContent = '';
  $('#est-dialog-title').textContent = est ? `Editar: ${est.name}` : 'Novo estabelecimento';
  $('#est-submit').textContent = est ? 'Salvar' : 'Cadastrar';
  $('#admin-box').classList.toggle('hidden', Boolean(est));
  if (est) {
    f.name.value = est.name;
    f.doc.value = maskDoc(est.doc_number ?? '');
    f.phone.value = maskPhone(est.phone ?? '');
    f.address.value = est.address ?? '';
    f.slug.value = est.slug;
  } else {
    f.admin_password.value = generatePassword();
  }
  updateDocHint();
  $('#est-dialog').showModal();
  f.name.focus();
}

function updateDocHint() {
  const n = digits($('#est-form').doc.value).length;
  $('#doc-hint').textContent = n === 0 ? 'Digite só os números; a máscara entra sozinha.'
    : n <= 11 ? `CPF (${n}/11 números)` : `CNPJ (${n}/14 números)`;
}

async function saveEst(e) {
  e.preventDefault();
  const f = e.target;
  const editing = Boolean(f.dataset.id);
  // Validação rápida aqui; a definitiva (dígitos do CNPJ/CPF etc.) é no servidor.
  const required = ['name', 'doc', 'phone', 'address', ...(editing ? [] : ['admin_name', 'admin_email', 'admin_password'])];
  for (const k of required) {
    if (!f[k].value.trim()) { $('#est-error').textContent = 'Preencha todos os campos.'; f[k].focus(); return; }
  }
  const body = {
    name: f.name.value.trim(), doc: f.doc.value, phone: f.phone.value, address: f.address.value.trim(),
  };
  if (f.slug.value.trim()) body.slug = f.slug.value.trim();
  if (!editing) Object.assign(body, {
    admin_name: f.admin_name.value.trim(), admin_email: f.admin_email.value.trim(), admin_password: f.admin_password.value,
  });
  const btn = $('#est-submit');
  btn.disabled = true;
  $('#est-error').textContent = '';
  try {
    if (editing) {
      const cur = state.list.find((x) => x.id === f.dataset.id);
      const patch = Object.fromEntries(Object.entries(body).filter(([k, v]) => {
        if (k === 'doc') return digits(v) !== (cur.doc_number ?? '');
        if (k === 'phone') return digits(v) !== digits(cur.phone ?? '');
        return v !== cur[k];
      }));
      if (!Object.keys(patch).length) { $('#est-dialog').close(); return; }
      await platformApi(`/establishments/${f.dataset.id}`, { method: 'PATCH', body: patch });
      $('#est-dialog').close();
      toast('Dados atualizados.', 'ok');
      await loadList();
      if (state.store?.id === f.dataset.id) { state.store = state.list.find((x) => x.id === f.dataset.id); renderStoreCard(); }
    } else {
      const res = await platformApi('/establishments', { method: 'POST', body });
      $('#est-dialog').close();
      await loadList();
      const est = res.establishment;
      showCreds('Estabelecimento cadastrado',
        `${est.name}\n` +
        `Link para clientes: ${storeUrl(est.slug)}\n\n` +
        `Acesso do administrador\nTela: ${location.origin}/atendimento\nE-mail: ${body.admin_email}\n` +
        `Senha: ${body.admin_password}` +
        (res.admin?.existed ? '\n(este e-mail já tinha conta; a senha dele passou a ser esta)' : ''));
    }
  } catch (ex) {
    $('#est-error').textContent = ex.details?.[0]?.message || ex.message;
  } finally { btn.disabled = false; }
}

function showCreds(title, text) {
  $('#creds-title').textContent = title;
  $('#creds-text').textContent = text;
  $('#creds-dialog').showModal();
}

// ------------------------------------------------------------ uma loja
async function openStore(id) {
  state.store = state.list.find((x) => x.id === id);
  if (!state.store) return;
  go('store');
  renderStoreCard();
  $('#team-table').innerHTML = '<div class="skeleton" style="height:180px"></div>';
  await loadTeam();
}

function renderStoreCard() {
  const e = state.list.find((x) => x.id === state.store.id) || state.store;
  state.store = e;
  $('#store-title').textContent = e.name;
  $('#store-sub').textContent = e.active ? 'Loja ativa' : 'Loja desativada — não aceita pedidos e a equipe não entra';
  $('#member-store').textContent = e.name;
  $('#store-card').innerHTML = `
    <div><dt>${e.doc_type === 'cpf' ? 'CPF' : 'CNPJ'}</dt><dd>${e.doc_number ? esc(e.doc_formatted) : '<span class="muted">Não informado</span>'}</dd></div>
    <div><dt>Telefone</dt><dd>${e.phone ? esc(phoneBr(e.phone)) : '<span class="muted">Não informado</span>'}</dd></div>
    <div><dt>Endereço</dt><dd>${e.address ? esc(e.address) : '<span class="muted">Não informado</span>'}</dd></div>
    <div><dt>Licença</dt><dd>${licenseCell(e.license)}</dd></div>
    <div><dt>Link para clientes</dt><dd class="link-line">
      <a href="/loja/${esc(e.slug)}" target="_blank" rel="noopener">${esc(storeUrl(e.slug))}</a>
      <button type="button" class="btn sm ghost" data-copy="${esc(storeUrl(e.slug))}">${icon('copy', { size: 16 })}Copiar</button></dd></div>`;
}

async function loadTeam() {
  try {
    state.team = await platformApi(`/establishments/${state.store.id}/team`);
  } catch (e) {
    $('#team-table').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  renderTeam();
}

function renderTeam() {
  $('#team-table').innerHTML = `<section class="card table-card"><div class="table-wrap"><table class="data">
    <thead><tr><th>Pessoa</th><th>Papel</th><th>Último acesso</th><th>Situação</th><th class="r">Senha</th></tr></thead>
    <tbody>${state.team.map((m) => `
      <tr class="${m.active ? '' : 'inactive'}">
        <td><div class="person"><span class="avatar">${esc(initials(m.full_name))}</span>
          <span><b>${esc(m.full_name)}</b><small>${esc(m.email)}</small></span></div></td>
        <td>
          <label class="sr-only" for="role-${m.user_id}">Papel de ${esc(m.full_name)}</label>
          <select class="role-select" id="role-${m.user_id}" data-role-of="${m.user_id}">
            ${Object.entries(ROLE_LABEL).map(([r, l]) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </td>
        <td class="muted">${m.last_sign_in_at ? esc(timeBr(m.last_sign_in_at)) : 'Nunca entrou'}</td>
        <td><button type="button" class="switch" role="switch" aria-checked="${m.active}" data-active-of="${m.user_id}" aria-label="Acesso de ${esc(m.full_name)}">
          <span class="track"></span>${m.active ? 'Ativo' : 'Desativado'}</button></td>
        <td class="r"><button type="button" class="btn sm" data-reset-of="${m.user_id}">${icon('key', { size: 16 })}Redefinir</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">Ninguém cadastrado nesta loja.</td></tr>'}</tbody></table></div></section>`;
}

async function updateMember(userId, patch, okMsg) {
  try {
    await platformApi(`/establishments/${state.store.id}/team/${userId}`, { method: 'PATCH', body: patch });
    toast(okMsg, 'ok');
  } catch (e) { toast(e.message, 'error'); }
  await loadTeam();
  loadList();
}

async function changeRole(userId, role, sel) {
  const m = state.team.find((x) => x.user_id === userId);
  const ok = await confirmDialog({
    title: `Mudar para ${ROLE_LABEL[role]}?`,
    message: role === 'admin' ? `${m.full_name} passará a ver vendas e relatórios e a gerenciar a equipe desta loja.`
      : `${m.full_name} passará a ter o acesso de ${ROLE_LABEL[role]}.`,
    confirmText: 'Confirmar',
  });
  if (!ok) { sel.value = m.role; return; }
  updateMember(userId, { role }, `${m.full_name} agora é ${ROLE_LABEL[role]}.`);
}

async function toggleMember(userId) {
  const m = state.team.find((x) => x.user_id === userId);
  const ok = await confirmDialog({
    title: m.active ? `Desativar ${m.full_name}?` : `Reativar ${m.full_name}?`,
    message: m.active ? 'A pessoa não consegue mais entrar. Os pedidos e o histórico continuam.' : 'A pessoa volta a entrar com a senha atual.',
    confirmText: m.active ? 'Desativar' : 'Reativar', danger: m.active,
  });
  if (ok) updateMember(userId, { active: !m.active }, m.active ? 'Acesso desativado.' : 'Acesso reativado.');
}

async function resetPassword(userId) {
  const m = state.team.find((x) => x.user_id === userId);
  const pw = await confirmDialog({
    title: `Nova senha para ${m.full_name}`, message: 'A senha antiga deixa de funcionar na hora.',
    confirmText: 'Trocar senha', input: { label: 'Nova senha (mín. 8)', minLength: 8, value: generatePassword() },
  });
  if (!pw) return;
  try {
    await platformApi(`/establishments/${state.store.id}/team/${userId}/password`, { method: 'POST', body: { password: pw } });
    showCreds('Senha redefinida', `Acesso — ${state.store.name}\nE-mail: ${m.email}\nNova senha: ${pw}`);
  } catch (e) { toast(e.message, 'error'); }
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
  const body = { full_name: f.full_name.value.trim(), email: f.email.value.trim(), role: f.role.value, password: f.password.value };
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#member-error').textContent = '';
  try {
    const res = await platformApi(`/establishments/${state.store.id}/team`, { method: 'POST', body });
    $('#member-dialog').close();
    const where = body.role === 'cozinha' ? `${location.origin}/cozinha/` : `${location.origin}/atendimento`;
    showCreds('Acesso criado',
      `Acesso — ${state.store.name}\nTela: ${where}\nE-mail: ${body.email}\n` +
      `Senha: ${body.password}\nPapel: ${ROLE_LABEL[body.role]}` +
      (res.existed ? '\n(este e-mail já tinha conta; a senha dele passou a ser esta)' : ''));
    await loadTeam();
    loadList();
  } catch (ex) {
    $('#member-error').textContent = ex.details?.[0]?.message || ex.message;
  } finally { btn.disabled = false; }
}

// ------------------------------------------------------------ navegação
function go(view) {
  $('#view-list').classList.toggle('hidden', view !== 'list');
  $('#view-store').classList.toggle('hidden', view !== 'store');
  if (view === 'list') { state.store = null; renderList(); }
  window.scrollTo(0, 0);
}

// Aparência (logo + cores) de uma loja — o dono do sistema deixa pronta para o cliente
function openBrandDialog(id) {
  const est = state.list.find((x) => x.id === id);
  if (!est) return;
  $('#brand-store').textContent = est.name;
  mountBrandForm($('#brand-dialog-body'), {
    storeName: est.name,
    load: () => platformApi(`/establishments/${id}/branding`),
    save: (body) => platformApi(`/establishments/${id}/branding`, { method: 'PUT', body }),
  });
  $('#brand-dialog').showModal();
}

async function copy(text, ok = 'Copiado.') {
  try { await navigator.clipboard.writeText(text); toast(ok, 'ok'); }
  catch { toast('Selecione o texto e copie com Ctrl+C.'); }
}

function bindEvents() {
  $('#login-form').addEventListener('submit', login);
  $('#logout').addEventListener('click', logout);
  $('#new-est').addEventListener('click', () => openEstDialog());
  $('#est-cancel').addEventListener('click', () => $('#est-dialog').close());
  $('#est-form').addEventListener('submit', saveEst);
  $('#gen-admin-password').addEventListener('click', () => { $('#est-form').admin_password.value = generatePassword(); });
  $('#edit-store').addEventListener('click', () => openEstDialog(state.store));
  $('#new-member').addEventListener('click', openMemberDialog);
  $('#member-cancel').addEventListener('click', () => $('#member-dialog').close());
  $('#gen-password').addEventListener('click', () => { $('#member-form').password.value = generatePassword(); });
  $('#member-form').addEventListener('submit', saveMember);
  $('#copy-creds').addEventListener('click', () => copy($('#creds-text').textContent));
  $('#plan-cancel').addEventListener('click', () => $('#plan-dialog').close());
  $('#plan-form').addEventListener('submit', savePlan);
  $('#license-cancel').addEventListener('click', () => $('#license-dialog').close());
  $('#brand-close').addEventListener('click', () => $('#brand-dialog').close());
  $('#license-form').addEventListener('submit', saveLicense);
  $('#est-search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });

  const f = $('#est-form');
  f.doc.addEventListener('input', () => { f.doc.value = maskDoc(f.doc.value); updateDocHint(); });
  f.phone.addEventListener('input', () => { f.phone.value = maskPhone(f.phone.value); });
  // O link acompanha o nome até a pessoa mexer nele.
  f.name.addEventListener('input', () => { if (!f.dataset.slugTouched) f.slug.value = slugify(f.name.value); });
  f.slug.addEventListener('input', () => {
    f.dataset.slugTouched = '1';
    f.slug.value = f.slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-');
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#edit-plan')) { openPlanDialog(); return; }
    const t = e.target.closest('[data-go],[data-open],[data-edit],[data-toggle],[data-copy],[data-active-of],[data-reset-of],[data-fill],[data-license],[data-brand]');
    if (!t) return;
    if (t.dataset.brand) { openBrandDialog(t.dataset.brand); return; }
    if (t.dataset.license) { openLicenseDialog(t.dataset.license); return; }
    if ('fill' in t.dataset) openEstDialog(state.list.find((x) => x.id === t.closest('tr').querySelector('[data-edit]').dataset.edit));
    else if (t.dataset.go) go(t.dataset.go);
    else if (t.dataset.open) openStore(t.dataset.open);
    else if (t.dataset.edit) openEstDialog(state.list.find((x) => x.id === t.dataset.edit));
    else if (t.dataset.toggle) toggleStore(t.dataset.toggle);
    else if (t.dataset.copy) copy(t.dataset.copy, 'Link copiado.');
    else if (t.dataset.activeOf) toggleMember(t.dataset.activeOf);
    else if (t.dataset.resetOf) resetPassword(t.dataset.resetOf);
  });
  $('#team-table').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-role-of]');
    if (sel) changeRole(sel.dataset.roleOf, sel.value, sel);
  });
}

async function init() {
  setupSidebar();
  hydrateIcons();
  bindEvents();
  try {
    state.sb = createSupabase(await api('/public/config'));
  } catch (e) {
    document.body.innerHTML = `<p class="empty">Não foi possível conectar ao servidor: ${esc(e.message)}</p>`;
    return;
  }
  const { data } = await state.sb.auth.getSession();
  if (data.session) await enterApp();
  else $('#login-view').classList.remove('hidden');
}

init();
