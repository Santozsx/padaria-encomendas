// Testa as rotas HTTP com serviços falsos (sem Supabase real).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createOrdersService } from '../src/services/orders.service.js';
import { AppError } from '../src/lib/errors.js';

const config = {
  SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-publica-123456',
  corsOrigins: ['http://localhost'],
  isProd: false,
  TRUST_PROXY: 0,
};

const STORE_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', slug: 'padaria-bela-vista', name: 'Padaria Bela Vista', storeName: 'Padaria Bela Vista', address: 'Rua A, 1', phone: '1133334444', timezone: 'America/Sao_Paulo', minLeadDays: 1, maxLeadDays: 60, active: true };
const STORE_B = { ...STORE_A, id: 'bbbbbbbb-0000-0000-0000-000000000002', slug: 'doce-sabor', name: 'Doce Sabor', storeName: 'Doce Sabor' };
// loja com licença vencida (bloqueada)
const STORE_C = { ...STORE_A, id: 'cccccccc-0000-0000-0000-000000000003', slug: 'vencida', name: 'Vencida', storeName: 'Vencida', blocked: true };
const STORES = [STORE_A, STORE_B, STORE_C];
const settings = {
  get: async (id) => STORES.find((s) => s.id === id),
  license: async (s) => ({ state: s.blocked ? 'bloqueada' : 'ativa', blocked: Boolean(s.blocked) }),
  plan: async () => ({ name: 'Plano', price_cents: 9990, trial_days: 14, grace_days: 3 }),
  getBySlug: async (slug) => {
    const s = STORES.find((x) => x.slug === slug);
    if (!s) throw new AppError(404, 'LOJA_NAO_ENCONTRADA', 'Loja não encontrada.');
    return s;
  },
  invalidate() {},
};

// "banco" falso que só registra a chamada RPC
const rpcCalls = [];
const fakeDb = {
  rpc: async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'set_order_status' && args.p_status === 'entregue') {
      return { data: null, error: { message: 'TRANSICAO_INVALIDA', hint: 'Não é possível mudar de "em_producao" para "entregue".' } };
    }
    return { data: { id: 'x', code: 1001, status: 'recebido', total_cents: 900, items: [] }, error: null };
  },
};

const S = (id, role, est) => ({ id, name: id, role, establishment_id: est.id, establishment: { ...est }, isPlatformAdmin: false });
const staffByToken = {
  tv: S('u1', 'cozinha', STORE_A),
  desk: S('u2', 'atendimento', STORE_A),
  boss: S('u3', 'admin', STORE_A),
  bossB: S('u4', 'admin', STORE_B),
  bossC: S('u5', 'admin', STORE_C),
  deskC: S('u6', 'atendimento', STORE_C),
};
const auth = {
  requireStaff: (...roles) => (req, _res, next) => {
    const s = staffByToken[(req.get('authorization') || '').replace('Bearer ', '')];
    if (!s) return next(new AppError(401, 'NAO_AUTENTICADO', 'Faça login.'));
    if (roles.length && !roles.includes(s.role) && s.role !== 'admin') return next(new AppError(403, 'SEM_PERMISSAO', 'Sem acesso.'));
    req.staff = s;
    next();
  },
  requirePlatformAdmin: () => (req, _res, next) => {
    if ((req.get('authorization') || '') !== 'Bearer owner') return next(new AppError(403, 'SEM_PERMISSAO', 'Somente o dono do sistema.'));
    req.platformUser = { id: 'owner-1', email: 'dono@x.com' };
    next();
  },
  invalidateUser() {},
  invalidateAll() {},
};

// espiões: registram com qual loja cada serviço foi chamado
const calls = [];
const spy = (name, ret) => async (...args) => { calls.push({ name, args }); return typeof ret === 'function' ? ret(...args) : ret; };

let server, base;
before(async () => {
  const app = createApp({
    config,
    settings,
    auth,
    catalog: {
      publicCatalog: spy('publicCatalog', { categories: [], products: [], time_slots: [] }),
      timeSlots: spy('timeSlots', []),
      availability: spy('availability', [{ id: 1, label: '07h – 09h', remaining: 0, full: true }, { id: 2, label: '09h – 12h', remaining: 5, full: false }]),
    },
    orders: Object.assign(createOrdersService(fakeDb), { list: spy('orders.list', []) }),
    reports: { sales: spy('reports.sales', { summary: {} }) },
    team: {
      list: spy('team.list', [{ user_id: 'u3', email: 'gabriel@padaria.com', role: 'admin', active: true }]),
      create: spy('team.create', (est, d) => ({ ...d, user_id: 'novo' })),
    },
    billing: {
      summary: spy('billing.summary', (estId) => ({ estId })),
      subscribe: spy('billing.subscribe', (estId, d) => ({ estId, ...d })),
      webhook: async (token, body) => {
        if (token !== 'segredo') throw new AppError(401, 'WEBHOOK_NAO_AUTORIZADO', 'Token inválido.');
        calls.push({ name: 'billing.webhook', args: [body] });
        return { ok: true };
      },
      updatePlan: spy('billing.updatePlan', (patch, o) => ({ patch, o })),
      adjustLicense: spy('billing.adjustLicense', (id, d) => ({ id, d })),
      enabled: true, env: 'sandbox', webhookUrl: 'https://app/api/webhooks/asaas',
    },
    platform: {
      list: spy('platform.list', []),
      create: spy('platform.create', (d) => ({ establishment: { id: 'nova', slug: d.slug, name: d.name }, admin: { email: d.admin.email } })),
      assertExists: spy('platform.assertExists', undefined),
    },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const dates = () => {
  const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const [y, m, d] = t.split('-').map(Number);
  return { today: t, tomorrow: new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10) };
};
const req = (method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const get = (path, token) => req('GET', path, null, token);
const order = (date, extra = {}) => ({
  customer_name: 'Ana', customer_phone: '11999998888', fulfillment: 'retirada',
  delivery_date: date, time_slot_id: 1, items: [{ product_id: 1, quantity: 10 }], ...extra,
});

// ---------------------------------------------------------------- público
test('config geral só expõe as chaves públicas', async () => {
  const j = await (await get('/api/public/config')).json();
  assert.deepEqual(Object.keys(j).sort(), ['supabaseAnonKey', 'supabaseUrl']);
});

test('loja pelo link: dados públicos + data mínima no fuso da loja; link inexistente → 404', async () => {
  const j = await (await get('/api/public/stores/padaria-bela-vista')).json();
  assert.equal(j.storeName, 'Padaria Bela Vista');
  assert.equal(j.minDate, dates().tomorrow);
  assert.equal(j.docNumber, undefined); // CNPJ/CPF não vai para o cliente
  assert.equal((await get('/api/public/stores/nao-existe')).status, 404);
  assert.equal((await get('/api/public/stores/..%2Fetc')).status, 404);
});

test('catálogo e vagas usam a loja do link', async () => {
  calls.length = 0;
  await get('/api/public/stores/doce-sabor/catalog');
  assert.equal(calls.find((c) => c.name === 'publicCatalog').args[0], STORE_B.id);
  assert.equal((await get(`/api/public/stores/doce-sabor/availability?date=${dates().today}`)).status, 422);
  const r = await get(`/api/public/stores/doce-sabor/availability?date=${dates().tomorrow}`);
  assert.equal((await r.json()).slots[1].remaining, 5);
});

test('pedido para HOJE → 422 DATA_ANTECEDENCIA (nem chega no banco)', async () => {
  rpcCalls.length = 0;
  const r = await req('POST', '/api/public/stores/padaria-bela-vista/orders', order(dates().today));
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'DATA_ANTECEDENCIA');
  assert.equal(rpcCalls.length, 0);
});

test('pedido: a LOJA vem do link (o navegador não consegue escolher outra) e preço do cliente é ignorado', async () => {
  rpcCalls.length = 0;
  const r = await req('POST', '/api/public/stores/doce-sabor/orders',
    order(dates().tomorrow, { establishment_id: STORE_A.id, total_cents: 1 }));
  assert.equal(r.status, 201);
  assert.equal(rpcCalls[0].name, 'create_order');
  assert.equal(rpcCalls[0].args.p.establishment_id, STORE_B.id);
  assert.equal(rpcCalls[0].args.p.total_cents, undefined);
});

test('JSON inválido → 400 amigável', async () => {
  const r = await fetch(base + '/api/public/stores/padaria-bela-vista/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'JSON_INVALIDO');
});

// ---------------------------------------------------------------- equipe da loja
test('rotas internas exigem login', async () => {
  assert.equal((await get('/api/staff/orders')).status, 401);
});

test('cada funcionário só consulta a PRÓPRIA loja', async () => {
  calls.length = 0;
  await get('/api/staff/orders', 'boss');
  await get('/api/staff/orders', 'bossB');
  const ests = calls.filter((c) => c.name === 'orders.list').map((c) => c.args[0]);
  assert.deepEqual(ests, [STORE_A.id, STORE_B.id]);
  const me = await (await get('/api/staff/me', 'bossB')).json();
  assert.equal(me.establishment.name, 'Doce Sabor');
});

test('status: RPC recebe a loja do funcionário; cozinha não cancela; erro do banco vira 409', async () => {
  const id = '00000000-0000-0000-0000-000000000001';
  rpcCalls.length = 0;
  let r = await req('PATCH', `/api/staff/orders/${id}/status`, { status: 'cancelado', note: 'teste' }, 'tv');
  assert.equal(r.status, 403);
  r = await req('PATCH', `/api/staff/orders/${id}/status`, { status: 'em_producao' }, 'bossB');
  assert.equal(rpcCalls[0].args.p_establishment_id, STORE_B.id);
  r = await req('PATCH', `/api/staff/orders/${id}/status`, { status: 'entregue' }, 'desk');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'TRANSICAO_INVALIDA');
});

test('relatório de vendas: só administrador, sempre da própria loja', async () => {
  const q = '/api/staff/reports/sales?from=2026-11-01&to=2026-11-30';
  assert.equal((await get(q, 'desk')).status, 403);
  assert.equal((await get(q, 'tv')).status, 403);
  calls.length = 0;
  assert.equal((await get(q, 'bossB')).status, 200);
  assert.equal(calls.find((c) => c.name === 'reports.sales').args[0], STORE_B.id);
  assert.equal((await get('/api/staff/reports/sales.csv?from=2026-11-01&to=2026-11-30', 'desk')).status, 403);
});

test('equipe: só administrador; novo acesso fica na loja de quem cadastrou', async () => {
  assert.equal((await get('/api/staff/team', 'desk')).status, 403);
  const ok = { email: ' Maria@Padaria.com ', full_name: 'Maria', role: 'atendimento', password: 'senha-forte-1' };
  assert.equal((await req('POST', '/api/staff/team', ok, 'desk')).status, 403);
  calls.length = 0;
  const r = await req('POST', '/api/staff/team', ok, 'bossB');
  assert.equal(r.status, 201);
  const c = calls.find((x) => x.name === 'team.create');
  assert.equal(c.args[0], STORE_B.id);
  assert.equal(c.args[1].email, 'maria@padaria.com');
  assert.equal((await req('POST', '/api/staff/team', { ...ok, password: '123' }, 'boss')).status, 422);
});

// ---------------------------------------------------------------- dono do sistema
test('painel do sistema: só o dono; administrador de loja é barrado', async () => {
  assert.equal((await get('/api/platform/establishments', 'boss')).status, 403);
  assert.equal((await get('/api/platform/establishments', 'owner')).status, 200);
});

test('cadastro de estabelecimento: valida CNPJ/CPF e gera o link pelo nome', async () => {
  const base = {
    name: 'Padaria São José', address: 'Rua das Flores, 100 - Centro', phone: '(11) 3333-4444',
    admin_name: 'José', admin_email: 'jose@saojose.com', admin_password: 'senha-forte-1',
  };
  let r = await req('POST', '/api/platform/establishments', { ...base, doc: '11.222.333/0001-80' }, 'owner');
  assert.equal(r.status, 422); // dígito verificador errado
  r = await req('POST', '/api/platform/establishments', { ...base, doc: '11.222.333/0001-81' }, 'owner');
  assert.equal(r.status, 201);
  assert.equal((await r.json()).establishment.slug, 'padaria-sao-jose');
  const c = calls.filter((x) => x.name === 'platform.create').pop();
  assert.deepEqual(c.args[0].doc, { type: 'cnpj', number: '11222333000181' });
  assert.equal(c.args[0].phone, '1133334444');
  r = await req('POST', '/api/platform/establishments', { ...base, doc: '529.982.247-25' }, 'owner');
  assert.equal(r.status, 201); // CPF válido também
});

test('telas: link da loja, atendimento, cozinha e painel', async () => {
  for (const p of ['/loja/padaria-bela-vista', '/loja/padaria-bela-vista/acompanhar', '/atendimento', '/cozinha/', '/plataforma']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
});

test('licença vencida: loja some para clientes e equipe só acessa /me e Assinatura', async () => {
  let r = await get('/api/public/stores/vencida');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'LOJA_INDISPONIVEL');

  r = await get('/api/staff/orders', 'deskC');
  assert.equal(r.status, 402);
  assert.match((await r.json()).error.message, /administrador/);
  r = await get('/api/staff/kitchen/board', 'bossC');
  assert.equal(r.status, 402);

  r = await get('/api/staff/me', 'deskC');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).license.state, 'bloqueada');

  calls.length = 0;
  r = await get('/api/staff/billing', 'bossC');
  assert.equal(r.status, 200);
  assert.equal(calls[0].args[0], STORE_C.id);          // sempre a loja de quem está logado
  r = await get('/api/staff/billing', 'deskC');
  assert.equal(r.status, 403);                          // só administrador

  r = await req('POST', '/api/staff/billing/subscribe', { email: 'nao-email' }, 'bossC');
  assert.equal(r.status, 422);
  r = await req('POST', '/api/staff/billing/subscribe', { email: 'Dono@Loja.com' }, 'bossC');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { estId: STORE_C.id, email: 'dono@loja.com' });

  // loja em dia continua normal
  r = await get('/api/staff/orders', 'desk');
  assert.equal(r.status, 200);
});

test('webhook do Asaas exige o token; plano e licenças só para o dono do sistema', async () => {
  let r = await req('POST', '/api/webhooks/asaas', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } });
  assert.equal(r.status, 401);
  r = await fetch(base + '/api/webhooks/asaas', {
    method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'segredo' },
    body: JSON.stringify({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }),
  });
  assert.equal(r.status, 200);

  r = await req('PUT', '/api/platform/plan', { price_cents: 12990 }, 'boss');
  assert.equal(r.status, 403);
  r = await req('PUT', '/api/platform/plan', { price_cents: 100 }, 'owner');
  assert.equal(r.status, 422);
  calls.length = 0;
  r = await req('PUT', '/api/platform/plan', { price_cents: 12990, apply_to_subscriptions: true }, 'owner');
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0].args, [{ price_cents: 12990 }, { applyToSubscriptions: true }]);

  r = await req('PATCH', `/api/platform/establishments/${STORE_B.id}/license`, { custom_price_cents: 4990 }, 'owner');
  assert.equal(r.status, 200);
  r = await req('PATCH', `/api/platform/establishments/${STORE_B.id}/license`, { mode: 'gratis' }, 'owner');
  assert.equal(r.status, 422);
  r = await get('/api/platform/plan', 'owner');
  assert.equal((await r.json()).plan.price_cents, 9990);
});
