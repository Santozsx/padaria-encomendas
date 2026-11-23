// Estabelecimentos (lojas): leitura com cache curto em memória.
// Substitui a antiga configuração única (app_settings): agora cada loja
// tem nome, fuso e regras de antecedência próprios.
import { AppError, unwrap } from '../lib/errors.js';
import { licenseInfo } from '../lib/license.js';

const TTL_MS = 30_000;
const BASE_FIELDS = 'id, slug, name, doc_type, doc_number, address, phone, timezone, min_lead_days, max_lead_days, max_items_per_order, active';
// Colunas que vêm de migrações opcionais. Se o banco ainda não tem uma delas,
// o sistema continua funcionando sem aquele grupo (e avisa no log).
const OPTIONAL_GROUPS = [
  {
    key: 'license',
    fields: ['license_mode', 'trial_ends_at', 'paid_until', 'billing_email', 'asaas_customer_id', 'asaas_subscription_id', 'subscription_status', 'custom_price_cents'],
    warn: '[licenças] Rode supabase/migrations/007_licencas.sql no Supabase. Até lá, todas as lojas ficam liberadas.',
  },
  {
    key: 'brand',
    fields: ['brand_color', 'brand_color_2', 'logo_updated_at'],
    warn: '[aparência] Rode supabase/migrations/009_identidade_visual.sql no Supabase. Até lá, as lojas ficam com o visual padrão.',
  },
];
const DEFAULT_PLAN = { name: 'Plano Padaria', price_cents: 9990, trial_days: 14, grace_days: 3 };

function shape(row) {
  return {
    id: row.id,
    slug: row.slug,
    storeName: row.name,
    name: row.name,
    docType: row.doc_type,
    docNumber: row.doc_number,
    address: row.address,
    phone: row.phone,
    timezone: row.timezone,
    minLeadDays: row.min_lead_days,
    maxLeadDays: row.max_lead_days,
    maxItemsPerOrder: row.max_items_per_order,
    active: row.active,
    // licença (SaaS)
    licenseMode: row.license_mode ?? 'cortesia',
    trialEndsAt: row.trial_ends_at ?? null,
    paidUntil: row.paid_until ?? null,
    billingEmail: row.billing_email ?? null,
    asaasCustomerId: row.asaas_customer_id ?? null,
    asaasSubscriptionId: row.asaas_subscription_id ?? null,
    subscriptionStatus: row.subscription_status ?? 'sem_assinatura',
    customPriceCents: row.custom_price_cents ?? null,
    // identidade visual
    brandColor: row.brand_color ?? null,
    brandColor2: row.brand_color_2 ?? null,
    logoUpdatedAt: row.logo_updated_at ?? null,
  };
}

export function createSettingsService(db) {
  const byId = new Map();
  const bySlug = new Map();

  function remember(est) {
    const entry = { est, at: Date.now() };
    byId.set(est.id, entry);
    bySlug.set(est.slug, entry);
    return est;
  }
  const fresh = (e) => e && Date.now() - e.at < TTL_MS;
  let planCache = null;
  const enabled = new Set(OPTIONAL_GROUPS.map((g) => g.key)); // grupos que o banco aceita
  const selectList = () => [BASE_FIELDS, ...OPTIONAL_GROUPS.filter((g) => enabled.has(g.key)).map((g) => g.fields.join(', '))].join(', ');
  const missingColumn = (error) => error && (error.code === '42703' || /does not exist|could not find/i.test(error.message || ''));

  /** Lê a loja; se o banco ainda não tem colunas de uma migração, funciona sem elas. */
  async function fetchOne(col, value) {
    for (;;) {
      const { data, error } = await db.from('establishments').select(selectList()).eq(col, value).maybeSingle();
      if (missingColumn(error) && enabled.size) {
        // descobre qual grupo falta pelo nome da coluna na mensagem de erro
        const msg = error.message || '';
        const group = OPTIONAL_GROUPS.find((g) => enabled.has(g.key) && g.fields.some((f) => msg.includes(f)))
          ?? [...OPTIONAL_GROUPS].reverse().find((g) => enabled.has(g.key));
        enabled.delete(group.key);
        console.warn(group.warn);
        continue;
      }
      if (error) unwrap({ error });
      return data;
    }
  }
  /** O banco já tem as colunas de identidade visual? */
  const brandingReady = () => enabled.has('brand');

  /** O plano único do SaaS (preço, dias de teste e de tolerância). */
  async function plan() {
    if (fresh(planCache)) return planCache.plan;
    const { data, error } = await db.from('saas_plan').select('*').maybeSingle();
    if (error && !/saas_plan/.test(error.message || '')) unwrap({ error });
    planCache = { plan: { ...DEFAULT_PLAN, ...(data ?? {}) }, at: Date.now() };
    return planCache.plan;
  }

  /** Situação da licença da loja + preço que ela paga. */
  async function license(est) {
    const p = await plan();
    return {
      ...licenseInfo(est, p.grace_days),
      mode: est.licenseMode,
      trial_ends_at: est.trialEndsAt,
      paid_until: est.paidUntil,
      price_cents: est.customPriceCents ?? p.price_cents,
      custom_price: est.customPriceCents != null,
      plan_name: p.name,
      subscription_status: est.subscriptionStatus,
    };
  }

  /** Loja pelo id (para telas internas). */
  async function get(id) {
    if (!id) throw new AppError(500, 'SEM_LOJA', 'Estabelecimento não informado.');
    const hit = byId.get(id);
    if (fresh(hit)) return hit.est;
    const data = await fetchOne('id', id);
    if (!data) throw new AppError(404, 'LOJA_NAO_ENCONTRADA', 'Estabelecimento não encontrado.');
    return remember(shape(data));
  }

  /** Loja pelo link público. Lojas desativadas não aparecem. */
  async function getBySlug(slug) {
    const hit = bySlug.get(slug);
    let est = fresh(hit) ? hit.est : null;
    if (!est) {
      const data = await fetchOne('slug', slug);
      if (data) est = remember(shape(data));
    }
    if (!est || !est.active) throw new AppError(404, 'LOJA_NAO_ENCONTRADA', 'Loja não encontrada. Confira o link que você recebeu.');
    return est;
  }

  function invalidate(id) {
    const hit = id && byId.get(id);
    if (hit) { byId.delete(id); bySlug.delete(hit.est.slug); }
    if (!id) { byId.clear(); bySlug.clear(); planCache = null; }
  }
  function invalidatePlan() { planCache = null; }

  return { get, getBySlug, invalidate, plan, license, invalidatePlan, brandingReady };
}
