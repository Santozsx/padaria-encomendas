// Define quem é o DONO DO SISTEMA (pode cadastrar estabelecimentos no
// Painel do sistema). A conta precisa existir (crie antes com staff:create).
// Uso:
//   npm run platform:admin -- --email voce@exemplo.com
//   npm run platform:admin -- --email voce@exemplo.com --remove
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createServiceClient } from '../src/lib/supabase.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, remove: { type: 'boolean' } } });
const email = values.email?.trim().toLowerCase();
if (!email) {
  console.error('Uso: npm run platform:admin -- --email voce@exemplo.com [--remove]');
  process.exit(1);
}

const db = createServiceClient(loadConfig());

let user = null;
for (let page = 1; page <= 50 && !user; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error('Erro ao consultar contas:', error.message); process.exit(1); }
  user = data.users.find((u) => u.email?.toLowerCase() === email) || null;
  if (data.users.length < 200) break;
}
if (!user) {
  console.error(`Nenhuma conta com o e-mail ${email}. Crie antes (opção 3 do iniciar.bat).`);
  process.exit(1);
}

const { error } = values.remove
  ? await db.from('platform_admins').delete().eq('user_id', user.id)
  : await db.from('platform_admins').upsert({ user_id: user.id });
if (error) {
  console.error('Falha:', error.message);
  if (/platform_admins/.test(error.message)) console.error('-> Rode supabase/migrations/004_estabelecimentos.sql no Supabase antes.');
  process.exit(1);
}
console.log(values.remove ? `OK: ${email} deixou de ser dono do sistema.` : `OK: ${email} agora é DONO DO SISTEMA (acesse /plataforma).`);
