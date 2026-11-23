// Monta a aplicação Express. Separado do server.js para facilitar testes
// (os testes injetam serviços falsos em vez do Supabase real).
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { publicRoutes } from './routes/public.routes.js';
import { staffRoutes } from './routes/staff.routes.js';
import { platformRoutes } from './routes/platform.routes.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { brandInfo, cssVars } from './lib/brand.js';
import { SLUG_RE } from './lib/documents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

export function createApp(deps) {
  const { config } = deps;
  const app = express();

  if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

  const supabaseHost = new URL(config.SUPABASE_URL).host;
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'], // blob: prévia da logo antes de enviar
          'connect-src': ["'self'", `https://${supabaseHost}`, `wss://${supabaseHost}`],
          'upgrade-insecure-requests': config.isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    '/api',
    cors({
      origin(origin, cb) {
        // sem Origin = mesma origem, curl, app nativo
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );
  // A aparência da loja leva a logo (imagem): limite maior só nessas rotas
  app.use(['/api/staff/branding', '/api/platform/establishments/:id/branding'], express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api/public', publicRoutes(deps));
  app.use('/api/staff', staffRoutes(deps));
  if (deps.platform) app.use('/api/platform', platformRoutes(deps));

  // Aviso do Asaas (cobrança das licenças). O Asaas manda o token que você
  // cadastrou no painel dele no cabeçalho "asaas-access-token".
  if (deps.billing) {
    app.post('/api/webhooks/asaas', async (req, res) => {
      try {
        const result = await deps.billing.webhook(req.get('asaas-access-token') || '', req.body);
        res.json({ received: true, ...result });
      } catch (err) {
        if (err.status === 401) return res.status(401).json({ error: { code: err.code, message: err.message } });
        console.error('[webhook asaas]', err.message);
        // 500 faz o Asaas tentar de novo mais tarde
        res.status(500).json({ error: { code: 'ERRO', message: 'Falha ao processar o aviso.' } });
      }
    });
  }
  app.use('/api', notFound);

  // ----- Arquivos estáticos das telas -----
  // Biblioteca do Supabase servida localmente (sem depender de CDN)
  try {
    const supabaseUmd = path.join(
      path.dirname(require.resolve('@supabase/supabase-js/package.json')),
      'dist', 'umd', 'supabase.js',
    );
    const sendLib = (_req, res) => res.sendFile(supabaseUmd, { maxAge: '7d' });
    app.get('/vendor/supabase.js', sendLib);
    app.get('/cozinha/vendor/supabase.js', sendLib); // no APK o arquivo é copiado para www/vendor
  } catch {
    /* pacote ausente em testes */
  }
  app.use('/cozinha', express.static(path.join(ROOT, 'kitchen-app', 'www'), { maxAge: 0 }));
  // Link próprio de cada loja: /loja/<slug> e /loja/<slug>/acompanhar.
  // A página já sai do servidor com o nome, as cores, a logo e o ícone da
  // aba da padaria (sem "piscar" o visual padrão, e com prévia certa no WhatsApp).
  const htmlCache = new Map();
  async function template(file) {
    if (config.isProd && htmlCache.has(file)) return htmlCache.get(file);
    const html = await readFile(path.join(ROOT, 'web', file), 'utf8');
    htmlCache.set(file, html);
    return html;
  }
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brandedPage = (file, titleOf) => async (req, res, next) => {
    try {
      let html = await template(file);
      const slug = String(req.params.slug || '').toLowerCase();
      let est = null;
      if (SLUG_RE.test(slug) && deps.settings) est = await deps.settings.getBySlug(slug).catch(() => null);
      if (est) {
        const b = brandInfo(est);
        const origin = config.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        const head = [
          `<title>${esc(titleOf(est.name))}</title>`,
          `<meta name="theme-color" content="${b.theme_color || '#0E6E63'}">`,
          b.logo_url ? `<link rel="icon" href="${esc(b.logo_url)}">` : '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
          `<meta property="og:title" content="${esc(est.name)}">`,
          '<meta property="og:description" content="Faça sua encomenda online e retire fresquinho.">',
          b.logo_url ? `<meta property="og:image" content="${esc(origin + b.logo_url)}">` : '',
          cssVars(b),
        ].filter(Boolean).join('\n  ');
        html = html
          .replace(/<!--brand:head-->[\s\S]*?<!--\/brand:head-->/, head)
          .replace(/(<strong id="store-name">)[^<]*(<\/strong>)/, `$1${esc(est.name)}$2`);
        if (b.logo_url) {
          html = html.replace(
            /<!--brand:mark-->[\s\S]*?<!--\/brand:mark-->/g,
            `<img class="brand-logo" src="${esc(b.logo_url)}" alt="">`,
          );
        }
      }
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(html);
    } catch (err) {
      next(err);
    }
  };
  app.get('/loja/:slug', brandedPage('loja.html', (name) => `Encomendas — ${name}`));
  app.get('/loja/:slug/acompanhar', brandedPage('acompanhar.html', (name) => `Acompanhar pedido — ${name}`));
  app.use('/', express.static(path.join(ROOT, 'web'), { maxAge: 0, extensions: ['html'] }));

  app.use(errorHandler);
  return app;
}
