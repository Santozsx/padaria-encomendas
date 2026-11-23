// Validação de TODOS os payloads que chegam na API (zod).
// O banco valida de novo — são duas camadas independentes.
import { z } from 'zod';
import { isValidIsoDate } from './lib/dates.js';
import { parseDocument, SLUG_RE, isValidCpf } from './lib/documents.js';

export const ORDER_STATUSES = ['recebido', 'em_producao', 'pronto', 'entregue', 'cancelado'];
export const ITEM_STATUSES = ['pendente', 'em_producao', 'produzido'];
export const FULFILLMENTS = ['retirada', 'entrega'];

const isoDate = z.string().refine(isValidIsoDate, 'Data inválida (use AAAA-MM-DD).');
const cleanText = (max) => z.string().trim().max(max);

/** Deixa só dígitos; aceita "(11) 99999-8888" ou "+55 11 99999-8888". */
export const phone = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => /^\d{10,13}$/.test(v), 'Telefone inválido. Informe DDD + número.');

export const CreateOrderSchema = z
  .object({
    customer_name: cleanText(100).min(2, 'Informe seu nome.'),
    customer_phone: phone,
    fulfillment: z.enum(FULFILLMENTS),
    delivery_address: cleanText(300).optional().default(''),
    delivery_date: isoDate,
    time_slot_id: z.coerce.number().int().positive(),
    notes: cleanText(500).optional().default(''),
    // "CPF na nota" (opcional)
    customer_cpf: z.string().optional()
      .transform((v) => (v ? v.replace(/\D/g, '') : undefined))
      .refine((v) => v === undefined || v === '' || isValidCpf(v), 'CPF inválido. Confira os números ou deixe em branco.')
      .transform((v) => v || undefined),
    expected_total_cents: z.coerce.number().int().nonnegative().optional(),
    items: z
      .array(
        z.object({
          product_id: z.coerce.number().int().positive(),
          quantity: z.coerce.number().int().min(1).max(1000),
          notes: cleanText(200).optional().default(''),
        }),
      )
      .min(1, 'Adicione pelo menos um produto.')
      .max(40, 'Muitos produtos em um único pedido.'),
  })
  .superRefine((o, ctx) => {
    if (o.fulfillment === 'entrega' && o.delivery_address.length < 5) {
      ctx.addIssue({ code: 'custom', path: ['delivery_address'], message: 'Informe o endereço para entrega.' });
    }
    const ids = o.items.map((i) => i.product_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Produto repetido no pedido.' });
    }
  });

export const OrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: cleanText(300).optional(),
}).superRefine((o, ctx) => {
  if (o.status === 'cancelado' && !(o.note && o.note.length >= 3)) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'Informe o motivo do cancelamento.' });
  }
});

export const ItemStatusSchema = z.object({ status: z.enum(ITEM_STATUSES) });

const csvList = (values) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(values)));

export const OrdersQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: csvList(ORDER_STATUSES),
  fulfillment: z.enum(FULFILLMENTS).optional(),
  q: cleanText(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const KitchenQuerySchema = z.object({
  date: isoDate.optional(),
  slot_id: z.coerce.number().int().positive().optional(),
});

export const ReportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    date_field: z.enum(['entrega', 'pedido']).default('entrega'),
    status: csvList(ORDER_STATUSES),
    fulfillment: z.enum(FULFILLMENTS).optional(),
    product_id: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => q.to >= q.from, { path: ['to'], message: 'A data final deve ser maior ou igual à inicial.' });

export const TrackQuerySchema = z.object({ phone });

function fiscalCode(re, msg) {
  return z.union([z.string().trim().transform((v) => v.replace(/[.\s-]/g, '')), z.null()])
    .refine((v) => v === null || v === '' || re.test(v), msg)
    .transform((v) => v || null)
    .optional();
}

const productBase = {
  category_id: z.coerce.number().int().positive(),
  name: cleanText(120).min(2),
  description: cleanText(500).default(''),
  price_cents: z.coerce.number().int().min(1).max(1_000_000),
  unit_label: cleanText(20).min(1).default('un'),
  image_url: z.union([z.string().trim().url().max(500), z.literal(''), z.null()]).optional()
    .transform((v) => (v ? v : null)),
  available: z.boolean().default(true),
  active: z.boolean().default(true),
  min_quantity: z.coerce.number().int().min(1).default(1),
  max_quantity: z.coerce.number().int().min(1).max(1000).default(200),
  sort_order: z.coerce.number().int().default(0),
  // dados fiscais (o contador informa); vazio = usa o padrão da loja
  ncm: fiscalCode(/^\d{8}$/, 'NCM deve ter 8 números.'),
  cfop: fiscalCode(/^\d{4}$/, 'CFOP deve ter 4 números.'),
  cest: fiscalCode(/^\d{7}$/, 'CEST deve ter 7 números.'),
};

export const ProductCreateSchema = z.object(productBase).refine(
  (p) => p.max_quantity >= p.min_quantity,
  { path: ['max_quantity'], message: 'Máximo deve ser ≥ mínimo.' },
);

// No PATCH, nada tem valor padrão: só altera o que foi enviado
export const ProductUpdateSchema = z
  .object(Object.fromEntries(Object.entries(productBase).map(([k, v]) => [k, v.optional()])))
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nada para atualizar.');

/** Faz o parse e transforma erros do zod em 422 legível. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const details = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  const err = new Error(details[0]?.message || 'Dados inválidos.');
  err.status = 422;
  err.code = 'VALIDACAO';
  err.details = details;
  throw err;
}

// ----- Equipe (somente admin) -----
const strongPassword = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(72);

export const TeamCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido.'),
  full_name: cleanText(100).min(2, 'Informe o nome.'),
  role: z.enum(['admin', 'atendimento', 'cozinha']),
  password: strongPassword,
});

export const TeamUpdateSchema = z.object({
  role: z.enum(['admin', 'atendimento', 'cozinha']).optional(),
  active: z.boolean().optional(),
  full_name: cleanText(100).min(2).optional(),
}).strict().refine((p) => Object.keys(p).length > 0, 'Nada para atualizar.');

export const TeamPasswordSchema = z.object({ password: strongPassword });

// ----- Categorias (atendimento/admin) -----
export const CategoryCreateSchema = z.object({ name: cleanText(60).min(2, 'Informe o nome da categoria.') });

// ----- Estabelecimentos (somente dono do sistema) -----
const documentField = z.string()
  .transform((v, ctx) => {
    const doc = parseDocument(v);
    if (!doc) {
      ctx.addIssue({ code: 'custom', message: 'CNPJ ou CPF inválido. Confira os números.' });
      return z.NEVER;
    }
    return doc;
  });

const slugField = z.string().trim().toLowerCase()
  .refine((v) => SLUG_RE.test(v) && v.length >= 3 && v.length <= 60, 'Link inválido: use só letras minúsculas, números e hífen (3 a 60).');

const estFields = {
  name: cleanText(120).min(2, 'Informe o nome do estabelecimento.'),
  slug: slugField.optional(),
  doc: documentField,
  address: cleanText(300).min(8, 'Informe o endereço completo.'),
  phone,
};

export const EstablishmentCreateSchema = z.object({
  ...estFields,
  admin_name: cleanText(100).min(2, 'Informe o nome do administrador.'),
  admin_email: z.string().trim().toLowerCase().email('E-mail do administrador inválido.'),
  admin_password: strongPassword,
});

export const EstablishmentUpdateSchema = z.object({
  name: estFields.name.optional(),
  slug: slugField.optional(),
  doc: documentField.optional(),
  address: estFields.address.optional(),
  phone: phone.optional(),
  active: z.boolean().optional(),
}).strict().refine((p) => Object.keys(p).length > 0, 'Nada para atualizar.');

// ----- Licenças / assinatura (SaaS) -----
export const SubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email('Informe um e-mail válido para receber as faturas.'),
});

const priceCents = z.coerce.number().int().min(500, 'O valor mínimo é R$ 5,00.').max(10_000_000);

export const PlanUpdateSchema = z.object({
  name: cleanText(60).min(2).optional(),
  price_cents: priceCents.optional(),
  trial_days: z.coerce.number().int().min(0).max(90).optional(),
  grace_days: z.coerce.number().int().min(0).max(30).optional(),
  apply_to_subscriptions: z.boolean().optional().default(false),
}).strict();

export const LicenseAdjustSchema = z.object({
  mode: z.enum(['assinatura', 'cortesia']).optional(),
  custom_price_cents: priceCents.nullable().optional(),   // null = volta ao preço do plano
  add_days: z.coerce.number().int().min(1).max(366).optional(),
  trial_ends_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine((p) => Object.keys(p).length > 0, 'Nada para alterar.');

// ----- Nota fiscal (NFC-e) da loja -----
const digitsOnly = (min, max, msg) => z.string().trim().transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length >= min && v.length <= max, msg);
const twoDigits = (msg) => z.string().trim().regex(/^\d{2,3}$/, msg);

export const FiscalConfigSchema = z.object({
  fiscal_enabled: z.boolean().optional(),
  fiscal_env: z.enum(['homologacao', 'producao']).optional(),
  fiscal_emit_on: z.enum(['entrega', 'pedido', 'manual']).optional(),
  inscricao_estadual: z.string().trim().max(20).transform((v) => v.replace(/[.\-/\s]/g, '').toUpperCase())
    .refine((v) => /^(\d{2,14}|ISENTO)$/.test(v), 'Inscrição estadual inválida.').optional(),
  regime_tributario: z.coerce.number().int().min(1).max(4).optional(),
  razao_social: cleanText(120).optional(),
  addr_street: cleanText(120).min(2, 'Informe a rua.').optional(),
  addr_number: cleanText(20).min(1, 'Informe o número (ou SN).').optional(),
  addr_district: cleanText(60).min(2, 'Informe o bairro.').optional(),
  addr_city: cleanText(60).min(2, 'Informe a cidade.').optional(),
  addr_uf: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'UF inválida.').optional(),
  addr_zip: digitsOnly(8, 8, 'CEP deve ter 8 números.').optional(),
  fiscal_cfop: z.string().trim().regex(/^\d{4}$/, 'CFOP deve ter 4 números.').optional(),
  fiscal_csosn: twoDigits('CSOSN/CST inválido.').optional(),
  fiscal_pis_cst: twoDigits('CST do PIS inválido.').optional(),
  fiscal_cofins_cst: twoDigits('CST do COFINS inválido.').optional(),
  fiscal_ncm_default: z.union([z.string().trim().regex(/^\d{8}$/, 'NCM padrão deve ter 8 números.'), z.literal(''), z.null()])
    .transform((v) => v || null).optional(),
  fiscal_payment_form: z.enum(['01', '03', '04', '05', '10', '11', '15', '17', '20', '99']).optional(),
  fiscal_ibs_cbs: z.boolean().optional(),
  fiscal_ibs_cbs_cst: z.union([z.string().trim().regex(/^\d{3}$/, 'CST do IBS/CBS deve ter 3 números.'), z.literal(''), z.null()])
    .transform((v) => v || null).optional(),
  fiscal_cclasstrib: z.union([z.string().trim().regex(/^\d{6}$/, 'cClassTrib deve ter 6 números.'), z.literal(''), z.null()])
    .transform((v) => v || null).optional(),
  // vão direto para a Focus NFe (não ficam guardados aqui)
  csc: z.object({
    producao_id: z.string().trim().max(10).optional(),
    producao: z.string().trim().max(60).optional(),
    homologacao_id: z.string().trim().max(10).optional(),
    homologacao: z.string().trim().max(60).optional(),
  }).optional(),
  certificate_base64: z.string().max(800_000).regex(/^[A-Za-z0-9+/=\s]+$/, 'Arquivo do certificado inválido.').optional(),
  certificate_password: z.string().max(100).optional(),
}).strict().superRefine((c, ctx) => {
  if (c.certificate_base64 && !c.certificate_password) {
    ctx.addIssue({ code: 'custom', path: ['certificate_password'], message: 'Informe a senha do certificado.' });
  }
  if (c.fiscal_ibs_cbs && (!c.fiscal_ibs_cbs_cst || !c.fiscal_cclasstrib)) {
    ctx.addIssue({ code: 'custom', path: ['fiscal_ibs_cbs_cst'], message: 'Para informar IBS/CBS, preencha o CST e o cClassTrib (peça ao contador).' });
  }
});

export const FiscalCancelSchema = z.object({
  justificativa: cleanText(255).min(15, 'Explique o motivo com pelo menos 15 caracteres.'),
});
