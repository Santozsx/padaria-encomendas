// Autenticação: o front faz login no Supabase Auth e envia
// "Authorization: Bearer <access_token>". Aqui validamos o token e
// descobrimos QUEM é e de QUAL ESTABELECIMENTO é (staff_profiles).
// Toda rota interna usa req.staff.establishment_id para filtrar os dados.
import { AppError } from '../lib/errors.js';

const CACHE_MS = 30_000;

function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function createAuth(db) {
  const cache = new Map(); // token -> { user, staff, isPlatformAdmin, at }

  async function resolve(token) {
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;

    const { data: userData, error } = await db.auth.getUser(token);
    if (error || !userData?.user) {
      throw new AppError(401, 'NAO_AUTENTICADO', 'Sessão inválida ou expirada. Faça login novamente.');
    }
    const user = userData.user;

    const [profRes, platRes] = await Promise.all([
      db.from('staff_profiles')
        .select('full_name, role, active, establishment_id, establishment:establishments(id, name, slug, active)')
        .eq('user_id', user.id)
        .maybeSingle(),
      db.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    ]);
    if (profRes.error) {
      const e = new AppError(502, 'ERRO_BANCO', 'Falha ao consultar o perfil da equipe no banco.');
      e.cause = profRes.error;
      throw e;
    }
    const p = profRes.data;
    const staff = p ? {
      id: user.id,
      email: user.email,
      name: p.full_name,
      role: p.role,
      active: p.active,
      establishment_id: p.establishment_id,
      establishment: p.establishment,
    } : null;

    const entry = { user, staff, isPlatformAdmin: !!platRes.data, at: Date.now() };
    cache.set(token, entry);
    if (cache.size > 500) cache.delete(cache.keys().next().value); // evita crescer sem limite
    return entry;
  }

  /** requireStaff() = qualquer membro; requireStaff('admin','atendimento') = só esses papéis (admin sempre passa). */
  function requireStaff(...roles) {
    return async (req, _res, next) => {
      try {
        const token = bearer(req);
        if (!token) throw new AppError(401, 'NAO_AUTENTICADO', 'Faça login para continuar.');
        const { user, staff, isPlatformAdmin } = await resolve(token);
        if (!staff) {
          throw new AppError(403, 'SEM_PERFIL', isPlatformAdmin
            ? 'Sua conta é de dono do sistema, mas não pertence a nenhum estabelecimento. Use o Painel do sistema.'
            : `O usuário ${user.email} não está ligado a nenhum estabelecimento. Peça ao administrador da loja para cadastrá-lo.`);
        }
        if (!staff.active) throw new AppError(403, 'USUARIO_INATIVO', 'Este usuário da equipe está desativado.');
        if (!staff.establishment?.active) throw new AppError(403, 'LOJA_DESATIVADA', 'O estabelecimento desta conta está desativado.');
        if (roles.length && !roles.includes(staff.role) && staff.role !== 'admin') {
          throw new AppError(403, 'SEM_PERMISSAO', 'Seu perfil não tem acesso a esta função.');
        }
        req.staff = { ...staff, isPlatformAdmin };
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  /** Só o dono do sistema (tabela platform_admins). Não precisa pertencer a uma loja. */
  function requirePlatformAdmin() {
    return async (req, _res, next) => {
      try {
        const token = bearer(req);
        if (!token) throw new AppError(401, 'NAO_AUTENTICADO', 'Faça login para continuar.');
        const { user, isPlatformAdmin } = await resolve(token);
        if (!isPlatformAdmin) throw new AppError(403, 'SEM_PERMISSAO', 'Somente o dono do sistema acessa este painel.');
        req.platformUser = { id: user.id, email: user.email };
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  /** Esquece sessões em cache de um usuário (após mudar papel, loja ou desativar). */
  function invalidateUser(userId) {
    for (const [tok, v] of cache) if (v.user.id === userId) cache.delete(tok);
  }
  /** Esquece todas as sessões (ex.: loja desativada). */
  function invalidateAll() { cache.clear(); }

  return { requireStaff, requirePlatformAdmin, invalidateUser, invalidateAll };
}
