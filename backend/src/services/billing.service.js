// Licenças do SaaS: assinatura mensal de cada estabelecimento, cobrada pelo Asaas.
//
// Fluxo:
//  1. Loja nova ganha o teste grátis (o banco define trial_ends_at).
//  2. O admin da loja abre "Assinatura" e clica em "Assinar": criamos o
//     cliente e a assinatura mensal no Asaas. O 1º vencimento é o fim do teste.
//  3. O Asaas emite a fatura todo mês (Pix, boleto ou cartão) e avisa o
//     servidor (webhook). Pagamento confirmado = licença estendida por 1 mês.
//  4. Sem pagamento: depois dos dias de tolerância a loja fica bloqueada.
//
// O dono do sistema pode mudar o preço do plano (e aplicar às assinaturas
// atuais), dar preço especial para uma loja, cortesia ou dias extras.
import { AppError, unwrap } from '../lib/errors.js';
import { createAsaas, mapPayment } from '../lib/asaas.js';
import { todayInTz } from '../lib/dates.js';

const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const SYNC_EVERY_MS = 30_000;   // consulta automática ao abrir a tela
const SYNC_FORCE_MS = 5_000;    // botão "Já paguei — atualizar"

export function createBillingService(db, { settings, asaas = createAsaas(), webhookToken = '', publicUrl = '', log = console } = {}) {
  const lastSync = new Map();

  async function priceFor(est) {
    const plan = await settings.plan();
    return est.customPriceCents ?? plan.price_cents;
  }

  async function payments(estId) {
    return unwrap(await db.from('license_payments').select('*').eq('establishment_id', estId)
      .order('due_date', { ascending: false }).limit(24));
  }

  async function register(estId, p) {
    return unwrap(await db.rpc('register_license_payment', {
      p_establishment_id: estId,
      p_asaas_payment_id: p.id,
      p_value_cents: p.valueCents,
      p_status: p.status,
      p_billing_type: p.billingType,
      p_due_date: p.dueDate,
      p_paid_at: p.paidAt ? new Date(p.paidAt).toISOString() : null,
      p_invoice_url: p.invoiceUrl,
    }));
  }

  /** Busca as cobranças da assinatura no Asaas e atualiza o histórico/licença. */
  async function sync(est, { force = false } = {}) {
    if (!est.asaasSubscriptionId || !asaas.configured) return false;
    const last = lastSync.get(est.id) ?? 0;
    if (Date.now() - last < (force ? SYNC_FORCE_MS : SYNC_EVERY_MS)) return false;
    lastSync.set(est.id, Date.now());
    const list = await asaas.listSubscriptionPayments(est.asaasSubscriptionId);
    for (const p of list) await register(est.id, p);
    settings.invalidate(est.id);
    return true;
  }

  // ---------------------------------------------------------- tela "Assinatura" (admin da loja)
  async function summary(estId, { refresh = true, force = false } = {}) {
    let est = await settings.get(estId);
    if (refresh) {
      try {
        if (await sync(est, { force })) est = await settings.get(estId);
      } catch (e) { log.error?.(`[licença] sincronizar ${est.slug}: ${e.message}`); }
    }
    const license = await settings.license(est);
    const history = await payments(estId);
    const open = history
      .filter((p) => !PAID.has(p.status) && ['PENDING', 'OVERDUE'].includes(p.status))
      .sort((a, b) => a.due_date.localeCompare(b.due_date))[0] ?? null;
    return {
      license,
      billing_enabled: asaas.configured,
      billing_email: est.billingEmail,
      has_document: Boolean(est.docNumber),
      subscription: { id: est.asaasSubscriptionId, status: est.subscriptionStatus },
      next_invoice: open && {
        due_date: open.due_date, value_cents: open.value_cents, status: open.status, invoice_url: open.invoice_url,
      },
      payments: history.map((p) => ({
        id: p.asaas_payment_id, due_date: p.due_date, value_cents: p.value_cents, status: p.status,
        billing_type: p.billing_type, paid_at: p.paid_at, invoice_url: p.invoice_url,
      })),
    };
  }

  /** Cria (ou recria) a assinatura mensal no Asaas. */
  async function subscribe(estId, { email }) {
    const est = await settings.get(estId);
    if (est.licenseMode === 'cortesia') {
      throw new AppError(409, 'LOJA_CORTESIA', 'Esta loja é cortesia: não precisa de assinatura.');
    }
    if (est.asaasSubscriptionId && est.subscriptionStatus === 'ativa') {
      return summary(estId);
    }
    if (!est.docNumber) {
      throw new AppError(422, 'DOCUMENTO_OBRIGATORIO', 'O CNPJ/CPF da loja não está cadastrado. Peça ao dono do sistema para completar o cadastro.');
    }
    let customer = est.asaasCustomerId;
    const contact = { name: est.name, cpfCnpj: est.docNumber, email, mobilePhone: est.phone || undefined };
    if (!customer) {
      customer = (await asaas.createCustomer({ ...contact, externalReference: est.id })).id;
    } else {
      await asaas.updateCustomer(customer, contact);
    }

    // 1º vencimento: fim do teste grátis (ou hoje, se o teste já acabou)
    const today = todayInTz(est.timezone);
    const trialEnd = est.trialEndsAt ? todayInTz(est.timezone, new Date(est.trialEndsAt)) : today;
    const paidEnd = est.paidUntil ? todayInTz(est.timezone, new Date(est.paidUntil)) : today;
    const nextDueDate = [today, trialEnd, paidEnd].sort().at(-1);

    const plan = await settings.plan();
    const sub = await asaas.createSubscription({
      customer,
      valueCents: await priceFor(est),
      nextDueDate,
      description: `${plan.name} - ${est.name}`,
      externalReference: est.id,
    });
    unwrap(await db.from('establishments').update({
      billing_email: email, asaas_customer_id: customer, asaas_subscription_id: sub.id, subscription_status: 'ativa',
    }).eq('id', est.id));
    settings.invalidate(est.id);
    lastSync.delete(est.id);
    try { await sync(await settings.get(est.id), { force: true }); lastSync.delete(est.id); } catch (e) { log.error?.(`[licença] ${e.message}`); }
    return summary(estId, { refresh: false });
  }

  /** Cancela a cobrança recorrente. A licença vale até o fim do período pago. */
  async function cancel(estId) {
    const est = await settings.get(estId);
    if (!est.asaasSubscriptionId || est.subscriptionStatus !== 'ativa') {
      throw new AppError(409, 'SEM_ASSINATURA', 'Esta loja não tem assinatura ativa.');
    }
    await asaas.cancelSubscription(est.asaasSubscriptionId);
    unwrap(await db.from('establishments').update({ subscription_status: 'cancelada' }).eq('id', est.id));
    settings.invalidate(est.id);
    return summary(estId, { refresh: false });
  }

  // ---------------------------------------------------------- aviso do Asaas (webhook)
  async function webhook(token, body) {
    if (!webhookToken || token !== webhookToken) {
      throw new AppError(401, 'WEBHOOK_NAO_AUTORIZADO', 'Token do webhook inválido.');
    }
    const raw = body?.payment;
    if (!raw?.id) return { ignored: true };
    // Nunca confiamos só no aviso: buscamos a cobrança direto no Asaas.
    let p;
    try {
      p = asaas.configured ? await asaas.getPayment(raw.id) : mapPayment(raw);
    } catch (e) {
      // cobrança que não existe (ou de outra conta): ignora, para o Asaas não ficar reenviando
      if (e.code === 'ASAAS_ERRO') return { ignored: true };
      throw e;
    }
    if (!p) return { ignored: true };
    let est = null;
    if (p.subscription) {
      ({ data: est } = await db.from('establishments').select('id').eq('asaas_subscription_id', p.subscription).maybeSingle());
    }
    if (!est && isUuid(p.externalReference)) {
      ({ data: est } = await db.from('establishments').select('id').eq('id', p.externalReference).maybeSingle());
    }
    if (!est) return { ignored: true };
    const row = await register(est.id, p);
    settings.invalidate(est.id);
    return { ok: true, credited: row.credited, status: p.status };
  }

  // ---------------------------------------------------------- dono do sistema
  async function updatePlan(patch, { applyToSubscriptions = false } = {}) {
    const row = { ...patch, updated_at: new Date().toISOString() };
    unwrap(await db.from('saas_plan').update(row).eq('id', true));
    settings.invalidatePlan();
    settings.invalidate();
    let updated = 0;
    const failed = [];
    if (applyToSubscriptions && patch.price_cents && asaas.configured) {
      // só lojas SEM preço especial acompanham o preço do plano
      const { data } = await db.from('establishments').select('id, name, asaas_subscription_id')
        .eq('subscription_status', 'ativa').is('custom_price_cents', null);
      for (const e of data ?? []) {
        if (!e.asaas_subscription_id) continue;
        try { await asaas.updateSubscriptionValue(e.asaas_subscription_id, patch.price_cents); updated++; }
        catch (err) { failed.push(`${e.name}: ${err.message}`); }
      }
    }
    return { plan: await settings.plan(), subscriptions_updated: updated, failed };
  }

  /** Ajustes manuais do dono numa loja: cortesia, preço especial, dias extras, fim do teste. */
  async function adjustLicense(estId, { mode, custom_price_cents, add_days, trial_ends_at }) {
    const est = await settings.get(estId);
    const row = {};
    if (mode) row.license_mode = mode;
    if (custom_price_cents !== undefined) row.custom_price_cents = custom_price_cents;
    if (trial_ends_at !== undefined) row.trial_ends_at = trial_ends_at;
    if (add_days) {
      const base = Math.max(Date.now(), est.paidUntil ? new Date(est.paidUntil).getTime() : 0);
      row.paid_until = new Date(base + add_days * 86_400_000).toISOString();
    }
    if (mode === 'assinatura' && est.licenseMode === 'cortesia' && !est.trialEndsAt && trial_ends_at === undefined && !add_days) {
      // saiu da cortesia: ganha o teste grátis a partir de hoje
      const plan = await settings.plan();
      row.trial_ends_at = new Date(Date.now() + plan.trial_days * 86_400_000).toISOString();
    }
    if (Object.keys(row).length) unwrap(await db.from('establishments').update(row).eq('id', estId));
    settings.invalidate(estId);

    // preço especial muda também a cobrança recorrente da loja
    let subscriptionUpdated = false;
    if (custom_price_cents !== undefined && est.asaasSubscriptionId && est.subscriptionStatus === 'ativa' && asaas.configured) {
      const plan = await settings.plan();
      await asaas.updateSubscriptionValue(est.asaasSubscriptionId, custom_price_cents ?? plan.price_cents);
      subscriptionUpdated = true;
    }
    const fresh = await settings.get(estId);
    return { license: await settings.license(fresh), subscription_updated: subscriptionUpdated };
  }

  /** Rotina (de hora em hora): sincroniza assinaturas com o Asaas, mesmo sem webhook. */
  async function sweep() {
    if (!asaas.configured) return { synced: 0 };
    const { data, error } = await db.from('establishments').select('id, asaas_subscription_id');
    if (error) return { synced: 0 };
    let synced = 0;
    for (const { id } of data.filter((e) => e.asaas_subscription_id)) {
      lastSync.delete(id);
      try { if (await sync(await settings.get(id), { force: true })) synced++; }
      catch (e) { log.error?.(`[licença] rotina: ${e.message}`); }
    }
    return { synced };
  }

  return {
    summary, subscribe, cancel, webhook, updatePlan, adjustLicense, sweep,
    webhookUrl: publicUrl ? `${publicUrl}/api/webhooks/asaas` : null,
    enabled: asaas.configured,
    env: asaas.env,
  };
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v ?? ''));
}
