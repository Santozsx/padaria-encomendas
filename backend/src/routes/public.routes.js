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
import { brandInfo, palette, normalizeHex } from '../lib/brand.js';

export function publicRoutes({ config, settings, catalog, orders, branding }) {
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

  // Prévia de cores (tela de Aparência): mesma conta de contraste do servidor
  const paletteLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false });
  r.get('/brand-palette', paletteLimiter, (req, res) => {
    const p = normalizeHex(req.query.p);
    const s2 = normalizeHex(req.query.s);
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(palette(p, s2) ?? { vars: null, side_tone: null, theme_color: null });
  });

  // Logo da loja (imagem). O endereço leva ?v=<versão>, então pode ficar
  // em cache "para sempre": quando a logo muda, o endereço muda junto.
  r.get('/logos/:slug', ah(async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug) || !branding) throw new AppError(404, 'SEM_LOGO', 'Logo não encontrada.');
    const img = await branding.logo(await settings.getBySlug(slug));
    if (!img) throw new AppError(404, 'SEM_LOGO', 'Logo não encontrada.');
    res.set({
      'Content-Type': img.mime,
      'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      // o app da cozinha (outra origem) também mostra a logo
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.send(img.buf);
  }));

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
      brand: brandInfo(s), // cores + logo da loja
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
    res.status(201).json(await orders.create(req.store, payload));
  }));

  r.get('/stores/:slug/orders/:code', readLimiter, ah(async (req, res) => {
    const code = Number(req.params.code);
    if (!Number.isInteger(code) || code <= 0) throw new AppError(422, 'VALIDACAO', 'Número do pedido inválido.');
    const { phone } = parse(TrackQuerySchema, req.query);
    res.json(await orders.track(req.store.id, code, phone));
  }));

  return r;
}
