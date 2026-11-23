// Pedidos de UMA loja: criação, consulta, status e visão da cozinha.
// Toda função recebe o estabelecimento; as funções SQL conferem de novo
// que o pedido/item pertence a ele (um funcionário nunca mexe em outra loja).
import { AppError, unwrap } from '../lib/errors.js';
import { checkDeliveryDate } from '../lib/dates.js';

const ORDER_SELECT = '*, items:order_items(*)';

// A cozinha só mexe na produção; entregar/cancelar é do atendimento
const KITCHEN_ALLOWED = new Set(['recebido', 'em_producao', 'pronto']);

export function createOrdersService(db) {
  /** est = loja vinda do link público (settings.getBySlug). */
  async function create(est, payload) {
    // 1ª barreira (mensagem rápida). O banco valida de novo no trigger.
    const dateError = checkDeliveryDate(payload.delivery_date, est);
    if (dateError) throw new AppError(422, dateError.code, dateError.message);

    const { customer_cpf: cpf, ...rest } = payload;
    const body = {
      ...rest,
      establishment_id: est.id, // definido pelo servidor, nunca pelo navegador
      delivery_address: payload.fulfillment === 'entrega' ? payload.delivery_address : null,
    };
    const order = unwrap(await db.rpc('create_order', { p: body }));
    if (cpf) {
      // "CPF na nota": guardado à parte (a função create_order não conhece o campo)
      const { error } = await db.from('orders').update({ customer_cpf: cpf }).eq('id', order.id);
      if (!error) order.customer_cpf = cpf;
    }
    return order;
  }

  async function list(estId, { from, to, status, fulfillment, q, limit }) {
    let query = db
      .from('orders')
      .select(ORDER_SELECT)
      .eq('establishment_id', estId)
      .order('delivery_date', { ascending: true })
      .order('slot_start', { ascending: true })
      .order('code', { ascending: true })
      .limit(limit);

    if (from) query = query.gte('delivery_date', from);
    if (to) query = query.lte('delivery_date', to);
    if (status?.length) query = query.in('status', status);
    if (fulfillment) query = query.eq('fulfillment', fulfillment);
    if (q) {
      const digits = q.replace(/\D/g, '');
      if (/^\d{1,9}$/.test(q.trim())) {
        query = query.eq('code', Number(q.trim()));
      } else if (digits.length >= 4) {
        query = query.ilike('customer_phone', `%${digits}%`);
      } else {
        const safe = q.replace(/[%_,()]/g, ' ').trim(); // escapa curingas do ilike
        query = query.ilike('customer_name', `%${safe}%`);
      }
    }
    return unwrap(await query);
  }

  async function getById(estId, id) {
    const { data, error } = await db.from('orders').select(ORDER_SELECT).eq('id', id).eq('establishment_id', estId).maybeSingle();
    if (error) unwrap({ error });
    if (!data) throw new AppError(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.');
    data.items.sort((a, b) => a.id - b.id);
    return data;
  }

  async function events(estId, id) {
    return unwrap(
      await db.from('order_events').select('*').eq('order_id', id).eq('establishment_id', estId).order('created_at', { ascending: true }),
    );
  }

  async function setStatus(staff, id, { status, note }) {
    if (staff.role === 'cozinha' && !KITCHEN_ALLOWED.has(status)) {
      throw new AppError(403, 'SEM_PERMISSAO', 'A cozinha não pode entregar ou cancelar pedidos.');
    }
    return unwrap(
      await db.rpc('set_order_status', {
        p_establishment_id: staff.establishment_id,
        p_order_id: id,
        p_status: status,
        p_actor_id: staff.id,
        p_actor_name: staff.name,
        p_note: note ?? null,
      }),
    );
  }

  async function setItemStatus(staff, itemId, { status }) {
    return unwrap(
      await db.rpc('set_item_status', {
        p_establishment_id: staff.establishment_id,
        p_item_id: itemId,
        p_status: status,
        p_actor_id: staff.id,
        p_actor_name: staff.name,
      }),
    );
  }

  /** Quadro da cozinha: pedidos em aberto da data + resumo consolidado. */
  async function kitchenBoard(estId, { date, slot_id }) {
    let q = db
      .from('orders')
      .select(ORDER_SELECT)
      .eq('establishment_id', estId)
      .eq('delivery_date', date)
      .in('status', ['recebido', 'em_producao', 'pronto'])
      .order('slot_start', { ascending: true })
      .order('code', { ascending: true });
    if (slot_id) q = q.eq('time_slot_id', slot_id);

    const [orders, summary] = await Promise.all([
      q,
      db.rpc('production_summary', { p_establishment_id: estId, p_date: date, p_slot_id: slot_id ?? null }),
    ]);
    const list = unwrap(orders);
    list.forEach((o) => o.items.sort((a, b) => a.id - b.id));
    return { date, orders: list, summary: unwrap(summary) };
  }

  /** Acompanhamento público: exige loja + código + telefone e expõe o mínimo. */
  async function track(estId, code, phone) {
    const { data, error } = await db
      .from('orders')
      .select('id, code, status, delivery_date, time_slot_label, fulfillment, total_cents, created_at, customer_phone, items:order_items(product_name, quantity, unit_label, status)')
      .eq('establishment_id', estId)
      .eq('code', code)
      .maybeSingle();
    if (error) unwrap({ error });
    if (!data || data.customer_phone !== phone) {
      throw new AppError(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado. Confira o número e o telefone.');
    }
    delete data.customer_phone;
    return data;
  }

  return { create, list, getById, events, setStatus, setItemStatus, kitchenBoard, track };
}
