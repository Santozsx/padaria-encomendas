// Painel do dono do sistema: cadastro e gestão de estabelecimentos.
import { AppError, unwrap } from '../lib/errors.js';
import { formatDocument } from '../lib/documents.js';
import { licenseInfo } from '../lib/license.js';

const EST_FIELDS = 'id, slug, name, doc_type, doc_number, address, phone, active, created_at, next_order_code';
const LICENSE_FIELDS = 'id, license_mode, trial_ends_at, paid_until, subscription_status, custom_price_cents, billing_email';

function friendlyUnique(error) {
  if (error?.code !== '23505') return null;
  const msg = `${error.message} ${error.details ?? ''}`;
  if (/doc/.test(msg)) return new AppError(409, 'DOC_DUPLICADO', 'Já existe um estabelecimento com este CNPJ/CPF.');
  if (/slug/.test(msg)) return new AppError(409, 'LINK_EM_USO', 'Este link já está em uso por outro estabelecimento. Escolha outro.');
  return new AppError(409, 'DUPLICADO', 'Já existe um estabelecimento com esses dados.');
}

function licenseOf(l, plan) {
  if (!l) return { ...licenseInfo({ licenseMode: 'cortesia' }), mode: 'cortesia', price_cents: null };
  const info = licenseInfo({ licenseMode: l.license_mode, trialEndsAt: l.trial_ends_at, paidUntil: l.paid_until }, plan?.grace_days ?? 3);
  return {
    ...info,
    mode: l.license_mode,
    trial_ends_at: l.trial_ends_at,
    paid_until: l.paid_until,
    subscription_status: l.subscription_status,
    custom_price: l.custom_price_cents != null,
    price_cents: l.custom_price_cents ?? plan?.price_cents ?? null,
    billing_email: l.billing_email,
  };
}

export function createPlatformService(db, { team, catalog, settings }) {
  async function list() {
    const [ests, staff, lic, plan] = await Promise.all([
      db.from('establishments').select(EST_FIELDS).order('created_at'),
      db.from('staff_profiles').select('establishment_id, role, active'),
      db.from('establishments').select(LICENSE_FIELDS),   // falha só se a migração 007 não rodou
      settings.plan ? settings.plan() : null,
    ]);
    const licById = new Map((lic.data ?? []).map((l) => [l.id, l]));
    const counts = new Map();
    for (const s of unwrap(staff)) {
      const c = counts.get(s.establishment_id) ?? { staff: 0, admins: 0 };
      if (s.active) { c.staff++; if (s.role === 'admin') c.admins++; }
      counts.set(s.establishment_id, c);
    }
    return unwrap(ests).map((e) => ({
      ...e,
      doc_formatted: formatDocument(e.doc_type, e.doc_number),
      orders_count: Math.max(0, Number(e.next_order_code) - 1001),
      staff_count: counts.get(e.id)?.staff ?? 0,
      admins_count: counts.get(e.id)?.admins ?? 0,
      license: licenseOf(licById.get(e.id), plan),
    }));
  }

  /** Cria a loja, o cardápio inicial (categorias e horários) e o 1º administrador. */
  async function create({ name, slug, doc, address, phone, admin }) {
    const { data, error } = await db.from('establishments').insert({
      name, slug, doc_type: doc.type, doc_number: doc.number, address, phone,
    }).select(EST_FIELDS).single();
    if (error) throw friendlyUnique(error) ?? unwrap({ error });

    try {
      await catalog.seedDefaults(data.id);
      const adminUser = await team.create(data.id, { ...admin, role: 'admin' });
      return { establishment: data, admin: adminUser };
    } catch (e) {
      // desfaz a loja recém-criada se o administrador não pôde ser criado
      await db.from('time_slots').delete().eq('establishment_id', data.id);
      await db.from('categories').delete().eq('establishment_id', data.id);
      await db.from('establishments').delete().eq('id', data.id);
      throw e;
    }
  }

  async function update(id, patch) {
    const row = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.slug !== undefined) row.slug = patch.slug;
    if (patch.address !== undefined) row.address = patch.address;
    if (patch.phone !== undefined) row.phone = patch.phone;
    if (patch.active !== undefined) row.active = patch.active;
    if (patch.doc !== undefined) { row.doc_type = patch.doc.type; row.doc_number = patch.doc.number; }
    const { data, error } = await db.from('establishments').update(row).eq('id', id).select(EST_FIELDS).maybeSingle();
    if (error) throw friendlyUnique(error) ?? unwrap({ error });
    if (!data) throw new AppError(404, 'LOJA_NAO_ENCONTRADA', 'Estabelecimento não encontrado.');
    settings.invalidate(id);
    return data;
  }

  async function assertExists(id) {
    const { data, error } = await db.from('establishments').select('id').eq('id', id).maybeSingle();
    if (error) unwrap({ error });
    if (!data) throw new AppError(404, 'LOJA_NAO_ENCONTRADA', 'Estabelecimento não encontrado.');
  }

  return { list, create, update, assertExists };
}
