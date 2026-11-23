// Rotas públicas (cliente). Cada loja tem seu link: /loja/<slug>.
// A API pública é sempre /api/public/stores/<slug>/..., e o servidor
// descobre o estabelecimento pelo slug — o navegador nunca escolhe o id.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ah } from '../middleware/error-handler.js';
import { parse, CreateOrderSchema, TrackQuerySchema } from '../schemas.js';
import { deliveryWindow, checkDeliveryDate } from '../lib/dates.js';
import { SLUG_RE } from '../lib/documents.js';
import { AppError } from '../lib/errors.js';

export function publicRoutes({ config, settings, catalog, orders, fiscal }) {
  const r = Router();

  // Limita abuso: no máximo 10 pedidos a cada 10 min por IP
  const orderLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'MUITAS_REQUISICOES', message: 'Muitos pedidos em sequência. Aguarde alguns minutos.' } },
  });
  const readLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

  // Configuração geral (telas internas): só as chaves públicas do Supabase
  r.get('/config', (_req, res) => {
    res.json({ supabaseUrl: config.SUPABASE_URL, supabaseAnonKey: config.SUPABASE_ANON_KEY });
  });

  // Descobre a loja pelo link e deixa em req.store
  r.use('/stores/:slug', ah(async (req, _res, next) => {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) throw new AppError(404, 'LOJA_NAO_ENCONTRADA', 'Loja não encontrada. Confira o link que você recebeu.');
    req.store = await settings.getBySlug(slug);
    // licença vencida: a loja some para os clientes até renovar
    if (settings.license && (await settings.license(req.store)).blocked) {
      throw new AppError(404, 'LOJA_INDISPONIVEL', 'Esta loja está temporariamente indisponível para encomendas.');
    }
    next();
  }));

  r.get('/stores/:slug', (req, res) => {
    const s = req.store;
    res.json({
      slug: s.slug,
      storeName: s.name,
      address: s.address,
      phone: s.phone,
      timezone: s.timezone,
      ...deliveryWindow(s), // today, minDate, maxDate — no fuso da loja
    });
  });

  r.get('/stores/:slug/catalog', ah(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=30');
    res.json(await catalog.publicCatalog(req.store.id));
  }));

  r.get('/stores/:slug/availability', readLimiter, ah(async (req, res) => {
    const date = String(req.query.date || '');
    const err = checkDeliveryDate(date, req.store);
    if (err) throw new AppError(422, err.code, err.message);
    res.set('Cache-Control', 'no-store');
    res.json({ date, slots: await catalog.availability(req.store.id, date) });
  }));

  r.post('/stores/:slug/orders', orderLimiter, ah(async (req, res) => {
    const payload = parse(CreateOrderSchema, req.body);
    const order = await orders.create(req.store, payload);
    fiscal?.onOrderCreated(req.store.id, order).catch((e) => console.error('[nota]', e.message));
    res.status(201).json(order);
  }));

  r.get('/stores/:slug/orders/:code', readLimiter, ah(async (req, res) => {
    const code = Number(req.params.code);
    if (!Number.isInteger(code) || code <= 0) throw new AppError(422, 'VALIDACAO', 'Número do pedido inválido.');
    const { phone } = parse(TrackQuerySchema, req.query);
    const data = await orders.track(req.store.id, code, phone);
    data.nota_fiscal = fiscal ? await fiscal.publicNote(req.store.id, data.id) : null;
    delete data.id;
    res.json(data);
  }));

  return r;
}
