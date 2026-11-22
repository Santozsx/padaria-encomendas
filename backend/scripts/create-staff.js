// Cria (ou atualiza) um usuário da equipe no Supabase Auth e vincula o papel.
// Se o e-mail já existir, atualiza a senha e grava/corrige o perfil —
// útil quando o usuário foi criado mas o papel não chegou a ser salvo.
//
// Uso:
//   npm run staff:create -- --email cozinha@padaria.com --password 'Senha@Forte1' --name "TV Cozinha" --role cozinha --store padaria-bela-vista
// Papéis: admin | atendimento | cozinha
// --store = link da loja (padrão: padaria-bela-vista)
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createServiceClient } from '../src/lib/supabase.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    store: { type: 'string' },
  },
});

const email = values.email?.trim().toLowerCase();
const { password, name } = values;
const role = values.role?.trim().toLowerCase();

if (!email || !password || !name || !['admin', 'atendimento', 'cozinha'].includes(role)) {
  console.error('Uso: npm run staff:create -- --email X --password Y --name "Nome" --role admin|atendimento|cozinha');
  console.error('Papel informado: "' + (values.role ?? '') + '" (use admin, atendimento ou cozinha)');
  process.exit(1);
}
if (password.length < 8) {
  console.error('A senha precisa ter pelo menos 8 caracteres.');
  process.exit(1);
}

const db = createServiceClient(loadConfig());

const storeSlug = (values.store || 'padaria-bela-vista').trim().toLowerCase();
const { data: store, error: storeErr } = await db.from('establishments').select('id, name').eq('slug', storeSlug).maybeSingle();
if (storeErr || !store) {
  console.error(`Estabelecimento "${storeSlug}" não encontrado. Rode a migração 004 no Supabase e confira o link da loja.`);
  process.exit(1);
}

/** Procura um usuário pelo e-mail (pagina a lista de usuários do Auth). */
async function findUserByEmail(target) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

let userId;
let action;

const { data: created, error: createErr } = await db.auth.admin.createUser({ email, password, email_confirm: true });
if (!createErr) {
  userId = created.user.id;
  action = 'criado';
} else {
  // já existe? então atualiza a senha e confirma o e-mail
  let existing = null;
  try {
    existing = await findUserByEmail(email);
  } catch (e) {
    console.error('Erro ao consultar usuários:', e.message);
    process.exit(1);
  }
  if (!existing) {
    console.error('Erro ao criar usuário:', createErr.message);
    process.exit(1);
  }
  const { error: updErr } = await db.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
  if (updErr) {
    console.error('Usuário já existia, mas falhou ao atualizar a senha:', updErr.message);
    process.exit(1);
  }
  userId = existing.id;
  action = 'já existia — senha atualizada';
}

const { data: current } = await db.from('staff_profiles').select('establishment_id').eq('user_id', userId).maybeSingle();
if (current && current.establishment_id !== store.id) {
  console.error('Este e-mail já está ligado a OUTRO estabelecimento. Use outro e-mail.');
  process.exit(1);
}
const { error: profErr } = await db
  .from('staff_profiles')
  .upsert({ user_id: userId, full_name: name, role, active: true, establishment_id: store.id });
if (profErr) {
  console.error('Falha ao salvar o perfil da equipe:', profErr.message);
  if (/permission denied/i.test(profErr.message)) {
    console.error('-> Rode supabase/migrations/003_permissoes.sql e 004_estabelecimentos.sql no SQL Editor do Supabase e tente de novo.');
  }
  process.exit(1);
}

console.log(`OK: ${email} (${action}) com papel "${role}" em "${store.name}".`);
