// Lê e valida as variáveis de ambiente uma única vez.
// Se faltar algo obrigatório, o servidor nem sobe — melhor falhar cedo.
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Endereço público do sistema na internet (ex.: https://app.suapadaria.com.br)
  PUBLIC_URL: z.string().url().optional().or(z.literal('')).transform((v) => (v || '').replace(/\/+$/, '')),
  // Cobrança das licenças (Asaas). Sem a chave, o dono libera as lojas manualmente.
  ASAAS_API_KEY: z.string().optional().default(''),
  ASAAS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  ASAAS_WEBHOOK_TOKEN: z.string().optional().default(''),
});

export function loadConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Variáveis de ambiente inválidas (veja backend/.env.example):\n${missing}`);
  }
  const c = parsed.data;
  return {
    ...c,
    isProd: c.NODE_ENV === 'production',
    corsOrigins: [
      ...c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
      // origens usadas pelo WebView do Capacitor no APK da cozinha
      'http://localhost',
      'https://localhost',
      'capacitor://localhost',
    ],
  };
}
