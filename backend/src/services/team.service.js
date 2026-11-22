// Equipe de UMA loja: contas de acesso ligadas ao estabelecimento.
// As contas ficam no Supabase Auth; papel e loja ficam em staff_profiles.
// Usado pelo administrador da loja (Equipe e acessos) e pelo dono do
// sistema (Painel do sistema), sempre com o id da loja.
import { AppError, unwrap } from '../lib/errors.js';

export const ROLES = ['admin', 'atendimento', 'cozinha'];

/**
 * Regras de segurança ao alterar alguém da equipe (função pura, testável).
 * - ninguém tira o próprio acesso de admin nem se desativa;
 * - sempre sobra pelo menos 1 administrador ativo na loja.
 */
export function checkTeamChange({ actorId, target, patch, activeAdmins }) {
  const isSelf = actorId === target.user_id;
  const losesAdmin = target.role === 'admin' && target.active &&
    ((patch.role && patch.role !== 'admin') || patch.active === false);
  if (isSelf && patch.active === false) {
    throw new AppError(409, 'PROPRIA_CONTA', 'Você não pode desativar a sua própria conta.');
  }
  if (isSelf && patch.role && patch.role !== 'admin') {
    throw new AppError(409, 'PROPRIA_CONTA', 'Você não pode tirar o seu próprio acesso de administrador. Peça a outro administrador.');
  }
  if (losesAdmin && activeAdmins <= 1) {
    throw new AppError(409, 'ULTIMO_ADMIN', 'É preciso manter pelo menos um administrador ativo no estabelecimento.');
  }
}

export function createTeamService(db) {
  /** Todos os usuários do Auth (paginado), indexados por id. */
  async function authUsers() {
    const map = new Map();
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new AppError(502, 'ERRO_AUTH', 'Falha ao consultar as contas de acesso.');
      data.users.forEach((u) => map.set(u.id, u));
      if (data.users.length < 200) break;
    }
    return map;
  }

  async function list(estId) {
    const [profiles, users] = await Promise.all([
      db.from('staff_profiles').select('user_id, full_name, role, active, created_at').eq('establishment_id', estId).order('created_at'),
      authUsers(),
    ]);
    return unwrap(profiles).map((p) => {
      const u = users.get(p.user_id);
      return { ...p, email: u?.email ?? '—', last_sign_in_at: u?.last_sign_in_at ?? null };
    }).sort((a, b) => Number(b.active) - Number(a.active) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.full_name.localeCompare(b.full_name));
  }

  async function getProfile(estId, userId) {
    const { data, error } = await db.from('staff_profiles').select('*').eq('user_id', userId).eq('establishment_id', estId).maybeSingle();
    if (error) unwrap({ error });
    if (!data) throw new AppError(404, 'NAO_ENCONTRADO', 'Pessoa não encontrada na equipe deste estabelecimento.');
    return data;
  }

  async function countActiveAdmins(estId) {
    const { count, error } = await db.from('staff_profiles').select('user_id', { count: 'exact', head: true })
      .eq('establishment_id', estId).eq('role', 'admin').eq('active', true);
    if (error) unwrap({ error });
    return count ?? 0;
  }

  /** Cria a conta (ou reaproveita um e-mail sem loja) e liga ao estabelecimento. */
  async function create(estId, { email, full_name, role, password }) {
    let userId;
    let existed = false;
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (!error) {
      userId = data.user.id;
    } else {
      const users = await authUsers();
      const found = [...users.values()].find((u) => u.email?.toLowerCase() === email);
      if (!found) throw new AppError(422, 'CONTA_INVALIDA', `Não foi possível criar a conta: ${error.message}`);
      const { data: prof } = await db.from('staff_profiles').select('establishment_id').eq('user_id', found.id).maybeSingle();
      if (prof && prof.establishment_id === estId) {
        throw new AppError(409, 'JA_NA_EQUIPE', 'Este e-mail já faz parte da equipe. Altere o papel na lista.');
      }
      if (prof) {
        throw new AppError(409, 'OUTRA_LOJA', 'Este e-mail já está ligado a outro estabelecimento. Use outro e-mail.');
      }
      const { error: upd } = await db.auth.admin.updateUserById(found.id, { password, email_confirm: true });
      if (upd) throw new AppError(422, 'CONTA_INVALIDA', `Não foi possível atualizar a conta: ${upd.message}`);
      userId = found.id;
      existed = true;
    }
    unwrap(await db.from('staff_profiles').insert({ user_id: userId, full_name, role, active: true, establishment_id: estId }));
    return { user_id: userId, email, full_name, role, active: true, existed };
  }

  async function update(actor, estId, userId, patch) {
    const target = await getProfile(estId, userId);
    checkTeamChange({ actorId: actor.id, target, patch, activeAdmins: await countActiveAdmins(estId) });
    return unwrap(await db.from('staff_profiles').update(patch).eq('user_id', userId).eq('establishment_id', estId).select().single());
  }

  async function resetPassword(estId, userId, password) {
    await getProfile(estId, userId);
    const { error } = await db.auth.admin.updateUserById(userId, { password });
    if (error) throw new AppError(422, 'SENHA_INVALIDA', `Não foi possível trocar a senha: ${error.message}`);
    return { ok: true };
  }

  return { list, create, update, resetPassword };
}
