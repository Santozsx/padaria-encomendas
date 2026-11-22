// Cliente Supabase do SERVIDOR (service_role): ignora RLS.
// Só é usado aqui no back-end; a chave nunca vai para o navegador.
import { createClient } from '@supabase/supabase-js';

export function createServiceClient(config) {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'padaria-api' } },
  });
}
