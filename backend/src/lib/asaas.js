// Cliente mínimo da API do Asaas (cobrança recorrente das licenças).
// Docs: https://docs.asaas.com  — a chave (API Key) é SUA, do dono do sistema,
// e fica só no .env do servidor (ASAAS_API_KEY).
import { AppError } from './errors.js';

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',   // testes: dinheiro de mentira
  production: 'https://api.asaas.com/v3',        // cobrança real
};

const cents = (value) => Math.round(Number(value ?? 0) * 100);

/** Converte uma cobrança do Asaas para o formato usado no sistema. */
export function mapPayment(p) {
  return {
    id: p.id,
    subscription: p.subscription ?? null,
    customer: p.customer ?? null,
    externalReference: p.externalReference ?? null,
    valueCents: cents(p.value),
    status: p.status,                     // PENDING, RECEIVED, CONFIRMED, OVERDUE, REFUNDED, ...
    billingType: p.billingType ?? null,   // PIX, BOLETO, CREDIT_CARD, UNDEFINED
    dueDate: p.dueDate,
    paidAt: p.clientPaymentDate || p.paymentDate || p.confirmedDate || null,
    invoiceUrl: p.invoiceUrl ?? null,
  };
}

export function createAsaas({ apiKey, env = 'sandbox', fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const base = BASES[env] ?? BASES.sandbox;
  const configured = Boolean(apiKey);

  async function call(method, path, body) {
    if (!configured) {
      throw new AppError(503, 'COBRANCA_NAO_CONFIGURADA', 'A cobrança automática ainda não foi configurada pelo dono do sistema.');
    }
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { access_token: apiKey, 'Content-Type': 'application/json', 'User-Agent': 'padaria-encomendas' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AppError(502, 'ASAAS_INDISPONIVEL', 'Não foi possível falar com o Asaas agora. Tente de novo em instantes.');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new AppError(502, 'ASAAS_CHAVE_INVALIDA', 'O Asaas recusou a chave de API (ASAAS_API_KEY). Confira o .env do servidor.');
      const detail = json.errors?.map((e) => e.description).join(' ') || `erro ${res.status}`;
      throw new AppError(502, 'ASAAS_ERRO', `Asaas: ${detail}`);
    }
    return json;
  }

  return {
    configured,
    env,

    async createCustomer({ name, cpfCnpj, email, mobilePhone, externalReference }) {
      const c = await call('POST', '/customers', { name, cpfCnpj, email, mobilePhone, externalReference, notificationDisabled: false });
      return { id: c.id };
    },

    async updateCustomer(id, fields) {
      await call('PUT', `/customers/${encodeURIComponent(id)}`, fields);
    },

    /** Assinatura mensal. billingType UNDEFINED: o cliente escolhe Pix, boleto ou cartão na fatura. */
    async createSubscription({ customer, valueCents, nextDueDate, description, externalReference }) {
      const s = await call('POST', '/subscriptions', {
        customer,
        billingType: 'UNDEFINED',
        value: valueCents / 100,
        nextDueDate,
        cycle: 'MONTHLY',
        description,
        externalReference,
      });
      return { id: s.id, status: s.status };
    },

    /** Muda o valor da assinatura (e das cobranças ainda não pagas). */
    async updateSubscriptionValue(id, valueCents) {
      await call('PUT', `/subscriptions/${encodeURIComponent(id)}`, { value: valueCents / 100, updatePendingPayments: true });
    },

    async cancelSubscription(id) {
      await call('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
    },

    async listSubscriptionPayments(id) {
      const r = await call('GET', `/subscriptions/${encodeURIComponent(id)}/payments?limit=100`);
      return (r.data ?? []).map(mapPayment);
    },

    async getPayment(id) {
      return mapPayment(await call('GET', `/payments/${encodeURIComponent(id)}`));
    },
  };
}
