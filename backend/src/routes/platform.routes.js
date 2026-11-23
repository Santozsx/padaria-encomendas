// Painel do dono do sistema: cadastrar e administrar estabelecimentos.
// Só quem está na tabela platform_admins acessa.
import { Router } from 'express';
import { ah } from '../middleware/error-handler.js';
import { AppError } from '../lib/errors.js';
import { slugify, SLUG_RE } from '../lib/documents.js';
import {
  parse,
  EstablishmentCreateSchema,
  EstablishmentUpdateSchema,
  TeamCreateSchema,
  TeamUpdateSchema,
  TeamPasswordSchema,
  PlanUpdateSchema,
  LicenseAdjustSchema,
  BrandingSchema,
} from '../schemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (v) => {
  if (!UUID.test(v)) throw new AppError(422, 'VALIDACAO', 'Identificador inválido.');
  return v;
};

export function platformRoutes({ auth, platform, team, settings, billing, branding }) {
  const r = Router();
  const owner = auth.requirePlatformAdmin();

  r.get('/me', owner, (req, res) => res.json(req.platformUser));

  r.get('/establishments', owner, ah(async (_req, res) => {
    res.json(await platform.list());
  }));

  r.post('/establishments', owner, ah(async (req, res) => {
    const d = parse(EstablishmentCreateSchema, req.body);
    const slug = d.slug || slugify(d.name);
    if (!SLUG_RE.test(slug) || slug.length < 3) {
      throw new AppError(422, 'VALIDACAO', 'Não foi possível gerar o link a partir do nome. Informe um link (ex.: padaria-centro).');
    }
    const result = await platform.create({
      name: d.name, slug, doc: d.doc, address: d.address, phone: d.phone,
      admin: { full_name: d.admin_name, email: d.admin_email, password: d.admin_password },
    });
    auth.invalidateAll?.(); // se o e-mail já tinha conta, a nova loja vale na hora
    res.status(201).json(result);
  }));

  r.patch('/establishments/:id', owner, ah(async (req, res) => {
    const updated = await platform.update(uuidParam(req.params.id), parse(EstablishmentUpdateSchema, req.body));
    auth.invalidateAll?.(); // loja desativada/reativada vale na próxima requisição de todos
    res.json(updated);
  }));

  // ----- Plano e licenças (SaaS) -----
  // Aparência de uma loja (o dono do sistema pode deixar pronta para o cliente)
  r.get('/establishments/:id/branding', owner, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    res.json({ ...(await branding.get(id)), ready: settings.brandingReady ? settings.brandingReady() : true });
  }));

  r.put('/establishments/:id/branding', owner, ah(async (req, res) => {
    res.json(await branding.save(uuidParam(req.params.id), parse(BrandingSchema, req.body)));
  }));

  r.get('/plan', owner, ah(async (_req, res) => {
    res.json({
      plan: await settings.plan(),
      billing: { enabled: Boolean(billing?.enabled), env: billing?.env ?? null, webhook_url: billing?.webhookUrl ?? null },
    });
  }));

  r.put('/plan', owner, ah(async (req, res) => {
    const { apply_to_subscriptions: apply, ...patch } = parse(PlanUpdateSchema, req.body);
    if (!Object.keys(patch).length) throw new AppError(422, 'VALIDACAO', 'Nada para alterar.');
    res.json(await billing.updatePlan(patch, { applyToSubscriptions: apply }));
  }));

  r.patch('/establishments/:id/license', owner, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    await platform.assertExists(id);
    const result = await billing.adjustLicense(id, parse(LicenseAdjustSchema, req.body));
    auth.invalidateAll?.();
    res.json(result);
  }));

  r.get('/establishments/:id/billing', owner, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    await platform.assertExists(id);
    res.json(await billing.summary(id));
  }));

  // Equipe de qualquer loja (o dono do sistema não é "ator" da loja: sem trava de "própria conta")
  const ownerActor = (req) => ({ id: `owner:${req.platformUser.id}` });

  r.get('/establishments/:id/team', owner, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    await platform.assertExists(id);
    res.json(await team.list(id));
  }));

  r.post('/establishments/:id/team', owner, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    await platform.assertExists(id);
    const created = await team.create(id, parse(TeamCreateSchema, req.body));
    auth.invalidateUser?.(created.user_id);
    res.status(201).json(created);
  }));

  r.patch('/establishments/:id/team/:userId', owner, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    const userId = uuidParam(req.params.userId);
    const updated = await team.update(ownerActor(req), id, userId, parse(TeamUpdateSchema, req.body));
    auth.invalidateUser?.(userId);
    res.json(updated);
  }));

  r.post('/establishments/:id/team/:userId/password', owner, ah(async (req, res) => {
    const id = uuidParam(req.params.id);
    res.json(await team.resetPassword(id, uuidParam(req.params.userId), parse(TeamPasswordSchema, req.body).password));
  }));

  return r;
}
