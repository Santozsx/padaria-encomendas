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
import { createFiscalService } from './services/fiscal.service.js';
import { createFocus } from './lib/focus.js';
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
  fiscal: createFiscalService(db, { focus: createFocus({ masterToken: config.FOCUS_TOKEN }) }),
  auth: createAuth(db),
};

// Notas que ficaram "processando" na SEFAZ: consulta a cada 2 minutos
setInterval(() => deps.fiscal.sweep().catch((e) => console.error('[nota]', e.message)), 2 * 60_000).unref();

// Sincroniza as assinaturas com o Asaas de hora em hora (funciona mesmo sem webhook)
if (deps.billing.enabled) {
  const run = () => deps.billing.sweep().catch((e) => console.error('[licenças]', e.message));
  setTimeout(run, 30_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

const app = createApp(deps);
const server = app.listen(config.PORT, () => {
  console.log(`API e telas rodando em http://localhost:${config.PORT}`);
  console.log(`  Loja (link): http://localhost:${config.PORT}/loja/padaria-bela-vista`);
  console.log(`  Atendimento: http://localhost:${config.PORT}/atendimento`);
  console.log(`  Cozinha:     http://localhost:${config.PORT}/cozinha/`);
  console.log(`  Painel do sistema: http://localhost:${config.PORT}/plataforma`);
  console.log(deps.billing.enabled
    ? `  Cobrança das licenças: Asaas (${config.ASAAS_ENV === 'production' ? 'PRODUÇÃO' : 'sandbox de testes'})`
    : '  Cobrança das licenças: desligada (sem ASAAS_API_KEY no .env)');
  console.log(config.FOCUS_TOKEN
    ? '  Nota fiscal (NFC-e): Focus NFe configurada'
    : '  Nota fiscal (NFC-e): sem FOCUS_TOKEN no .env (lojas não conseguem cadastrar o emissor)');
});

// Encerramento limpo (Ctrl+C, deploy)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} recebido, encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
