// Rotas internas (atendimento, cozinha, gestão). Todas exigem login.
import { Router } from 'express';
import { ah } from '../middleware/error-handler.js';
import { AppError } from '../lib/errors.js';
import { todayInTz, deliveryWindow } from '../lib/dates.js';
import {
  parse,
  OrdersQuerySchema,
  OrderStatusSchema,
  ItemStatusSchema,
  KitchenQuerySchema,
  ReportQuerySchema,
  ProductCreateSchema,
  ProductUpdateSchema,
  TeamCreateSchema,
  TeamUpdateSchema,
  TeamPasswordSchema,
  CategoryCreateSchema,
  SubscribeSchema,
  BrandingSchema,
} from '../schemas.js';
import { brandInfo } from '../lib/brand.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(value) {
  if (!UUID.test(value)) throw new AppError(422, 'VALIDACAO', 'Identificador inválido.');
  return value;
}
function intParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(422, 'VALIDACAO', 'Identificador inválido.');
  return n;
}

export function staffRoutes({ auth, settings, catalog, orders, reports, team, billing, branding }) {
  const r = Router();
  // Toda consulta usa SEMPRE a loja de quem está logado (nunca um id vindo do navegador)
  const est = (req) => req.staff.establishment_id;

  // Licença vencida (passou a tolerância): só /me e a tela de Assinatura funcionam
  const licensed = ah(async (req, _res, next) => {
    const lic = await settings.license(await settings.get(est(req)));
    if (lic.blocked) {
      throw new AppError(402, 'LICENCA_VENCIDA', req.staff.role === 'admin'
        ? 'A licença desta loja venceu. Renove em "Assinatura" para voltar a usar o sistema.'
        : 'A licença desta loja venceu. Peça ao administrador da loja para renovar a assinatura.');
    }
    next();
  });
  const anyStaff = [auth.requireStaff(), licensed];
  const desk = [auth.requireStaff('atendimento'), licensed]; // admin sempre passa
  const adminOnly = [auth.requireStaff('admin'), licensed];
  const adminBilling = auth.requireStaff('admin');           // funciona mesmo com licença vencida

  r.get('/me', auth.requireStaff(), ah(async (req, res) => {
    const s = await settings.get(est(req));
    const license = await settings.license(s);
    res.json({
      id: req.staff.id,
      email: req.staff.email,
      name: req.staff.name,
      role: req.staff.role,
      isPlatformAdmin: req.staff.isPlatformAdmin,
      establishment: {
        id: s.id, slug: s.slug, name: s.name, address: s.address, phone: s.phone, timezone: s.timezone,
        ...deliveryWindow(s),
        brand: brandInfo(s), // cores + logo da loja (telas aplicam o visual)
      },
      license,
    });
  }));

  // ----- Aparência da loja: cores e logo (somente administradores) -----
  r.get('/branding', adminOnly, ah(async (req, res) => {
    res.json({ ...(await branding.get(est(req))), ready: settings.brandingReady ? settings.brandingReady() : true });
  }));

  r.put('/branding', adminOnly, ah(async (req, res) => {
    res.json(await branding.save(est(req), parse(BrandingSchema, req.body)));
  }));

  // ----- Assinatura da loja (somente administradores) -----
  r.get('/billing', adminBilling, ah(async (req, res) => {
    res.json(await billing.summary(est(req), { force: req.query.refresh === '1' }));
  }));

  r.post('/billing/subscribe', adminBilling, ah(async (req, res) => {
    res.json(await billing.subscribe(est(req), parse(SubscribeSchema, req.body)));
  }));

  r.post('/billing/cancel', adminBilling, ah(async (req, res) => {
    res.json(await billing.cancel(est(req)));
  }));

  // ----- Pedidos -----
  r.get('/orders', anyStaff, ah(async (req, res) => {
    res.json(await orders.list(est(req), parse(OrdersQuerySchema, req.query)));
  }));

  r.get('/orders/:id', anyStaff, ah(async (req, res) => {
    res.json(await orders.getById(est(req), uuidParam(req.params.id)));
  }));

  r.get('/orders/:id/events', anyStaff, ah(async (req, res) => {
    res.json(await orders.events(est(req), uuidParam(req.params.id)));
  }));

  r.patch('/orders/:id/status', anyStaff, ah(async (req, res) => {
    const body = parse(OrderStatusSchema, req.body);
    res.json(await orders.setStatus(req.staff, uuidParam(req.params.id), body));
  }));

  r.patch('/order-items/:id/status', anyStaff, ah(async (req, res) => {
    const body = parse(ItemStatusSchema, req.body);
    res.json(await orders.setItemStatus(req.staff, intParam(req.params.id), body));
  }));

  r.get('/time-slots', anyStaff, ah(async (req, res) => {
    res.json(await catalog.timeSlots(est(req)));
  }));

  // ----- Cozinha -----
  r.get('/kitchen/board', anyStaff, ah(async (req, res) => {
    const q = parse(KitchenQuerySchema, req.query);
    const s = await settings.get(est(req));
    const date = q.date ?? todayInTz(s.timezone);
    const [board, slots] = await Promise.all([
      orders.kitchenBoard(est(req), { date, slot_id: q.slot_id }),
      catalog.timeSlots(est(req)),
    ]);
    res.json({ ...board, time_slots: slots.filter((x) => x.active) });
  }));

  // ----- Produtos e categorias -----
  r.get('/products', desk, ah(async (req, res) => {
    res.json(await catalog.adminProducts(est(req)));
  }));

  r.post('/products', desk, ah(async (req, res) => {
    res.status(201).json(await catalog.createProduct(est(req), parse(ProductCreateSchema, req.body)));
  }));

  r.patch('/products/:id', desk, ah(async (req, res) => {
    res.json(await catalog.updateProduct(est(req), intParam(req.params.id), parse(ProductUpdateSchema, req.body)));
  }));

  r.post('/categories', desk, ah(async (req, res) => {
    res.status(201).json(await catalog.createCategory(est(req), parse(CategoryCreateSchema, req.body).name));
  }));

  // ----- Relatórios (somente administradores da loja) -----
  r.get('/reports/sales', adminOnly, ah(async (req, res) => {
    res.json(await reports.sales(est(req), parse(ReportQuerySchema, req.query)));
  }));

  r.get('/reports/sales.csv', adminOnly, ah(async (req, res) => {
    const f = parse(ReportQuerySchema, req.query);
    const s = await settings.get(est(req));
    const csv = await reports.salesCsv(est(req), f, s.name);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="vendas_${s.slug}_${f.from}_a_${f.to}.csv"`);
    res.send(csv);
  }));

  // ----- Equipe e acessos (somente administradores da loja) -----
  r.get('/team', adminOnly, ah(async (req, res) => {
    res.json(await team.list(est(req)));
  }));

  r.post('/team', adminOnly, ah(async (req, res) => {
    res.status(201).json(await team.create(est(req), parse(TeamCreateSchema, req.body)));
  }));

  r.patch('/team/:id', adminOnly, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    const updated = await team.update(req.staff, est(req), id, parse(TeamUpdateSchema, req.body));
    auth.invalidateUser?.(id); // o novo papel vale na próxima requisição
    res.json(updated);
  }));

  r.post('/team/:id/password', adminOnly, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    res.json(await team.resetPassword(est(req), id, parse(TeamPasswordSchema, req.body).password));
  }));

  return r;
}
