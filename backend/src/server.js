// Ponto de entrada: carrega config, cria serviços e sobe o HTTP.
import { loadConfig } from './config.js';
import { createServiceClient } from './lib/supabase.js';
import { createSettingsService } from './services/settings.service.js';
import { createCatalogService } from './services/catalog.service.js';
import { createOrdersService } from './services/orders.service.js';
import { createReportsService } from './services/reports.service.js';
import { createTeamService } from './services/team.service.js';
import { createPlatformService } from './services/platform.service.js';
import { createBillingService } from './services/billing.service.js';
import { createAsaas } from './lib/asaas.js';
import { createBrandingService } from './services/branding.service.js';
import { createAuth } from './middleware/auth.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = createServiceClient(config);
const settings = createSettingsService(db);
const catalog = createCatalogService(db);
const team = createTeamService(db);
const deps = {
  config,
  settings,
  catalog,
  team,
  orders: createOrdersService(db),
  reports: createReportsService(db),
  platform: createPlatformService(db, { team, catalog, settings }),
  billing: createBillingService(db, {
    settings,
    asaas: createAsaas({ apiKey: config.ASAAS_API_KEY, env: config.ASAAS_ENV }),
    webhookToken: config.ASAAS_WEBHOOK_TOKEN,
    publicUrl: config.PUBLIC_URL,
  }),
  branding: createBrandingService(db, { settings }),
  auth: createAuth(db),
};

// Sincroniza as assinaturas com o Asaas de hora em hora (funciona mesmo sem webhook)
if (deps.billing.enabled) {
  const run = () => deps.billing.sweep().catch((e) => console.error('[licenças]', e.message));
  setTimeout(run, 30_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

const app = createApp(deps);
const server = app.listen(config.PORT, () => {
  // Na nuvem mostra o endereço público; no computador, o localhost
  const base = config.PUBLIC_URL || `http://localhost:${config.PORT}`;
  console.log(`API e telas rodando em ${base} (porta ${config.PORT})`);
  console.log(`  Loja (link): ${base}/loja/padaria-bela-vista`);
  console.log(`  Atendimento: ${base}/atendimento`);
  console.log(`  Cozinha:     ${base}/cozinha/`);
  console.log(`  Painel do sistema: ${base}/plataforma`);
  console.log(deps.billing.enabled
    ? `  Cobrança das licenças: Asaas (${config.ASAAS_ENV === 'production' ? 'PRODUÇÃO' : 'sandbox de testes'})`
    : '  Cobrança das licenças: desligada (sem ASAAS_API_KEY no .env)');
});

// Encerramento limpo (Ctrl+C, deploy)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} recebido, encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
