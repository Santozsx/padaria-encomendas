// Catálogo de UMA loja: categorias, produtos e faixas de horário.
// Todas as funções recebem o id do estabelecimento (estId).
import { unwrap, AppError } from '../lib/errors.js';

export const DEFAULT_CATEGORIES = ['Pães', 'Bolos', 'Salgados', 'Doces', 'Tortas'];
// Horários de retirada/entrega de uma loja nova: de 30 em 30 minutos,
// 07:00, 07:30 ... 18:00. Formato: [rótulo, início, fim, limite de pedidos]
export const DEFAULT_SLOTS = Array.from({ length: 23 }, (_, i) => {
  const min = 7 * 60 + i * 30;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return [hhmm(min), hhmm(min), hhmm(min + 30), null];
});

export function createCatalogService(db) {
  /** Catálogo público: só itens ativos da loja. */
  async function publicCatalog(estId) {
    const [categories, products, slots] = await Promise.all([
      db.from('categories').select('id, name, sort_order').eq('establishment_id', estId).eq('active', true).order('sort_order'),
      db.from('products')
        .select('id, category_id, name, description, price_cents, unit_label, image_url, available, min_quantity, max_quantity, sort_order')
        .eq('establishment_id', estId).eq('active', true)
        .order('sort_order').order('name'),
      db.from('time_slots').select('id, label, start_time, end_time').eq('establishment_id', estId).eq('active', true).order('sort_order'),
    ]);
    return { categories: unwrap(categories), products: unwrap(products), time_slots: unwrap(slots) };
  }

  /** Visão administrativa: inclui arquivados. */
  async function adminProducts(estId) {
    const [categories, products] = await Promise.all([
      db.from('categories').select('*').eq('establishment_id', estId).order('sort_order'),
      db.from('products').select('*').eq('establishment_id', estId).order('category_id').order('sort_order').order('name'),
    ]);
    return { categories: unwrap(categories), products: unwrap(products) };
  }

  async function assertCategory(estId, categoryId) {
    const { data, error } = await db.from('categories').select('id').eq('id', categoryId).eq('establishment_id', estId).maybeSingle();
    if (error) unwrap({ error });
    if (!data) throw new AppError(422, 'CATEGORIA_INVALIDA', 'Categoria inválida.');
  }

  async function createProduct(estId, data) {
    await assertCategory(estId, data.category_id);
    return unwrap(await db.from('products').insert({ ...data, establishment_id: estId }).select().single());
  }

  async function updateProduct(estId, id, patch) {
    const { data: current, error } = await db.from('products').select('min_quantity, max_quantity')
      .eq('id', id).eq('establishment_id', estId).maybeSingle();
    if (error) unwrap({ error });
    if (!current) throw new AppError(404, 'NAO_ENCONTRADO', 'Produto não encontrado.');
    if (patch.category_id !== undefined) await assertCategory(estId, patch.category_id);
    const min = patch.min_quantity ?? current.min_quantity;
    const max = patch.max_quantity ?? current.max_quantity;
    if (max < min) throw new AppError(422, 'VALIDACAO', 'Quantidade máxima deve ser ≥ mínima.');
    return unwrap(await db.from('products').update(patch).eq('id', id).eq('establishment_id', estId).select().single());
  }

  async function createCategory(estId, name) {
    const { data: last } = await db.from('categories').select('sort_order').eq('establishment_id', estId)
      .order('sort_order', { ascending: false }).limit(1).maybeSingle();
    return unwrap(await db.from('categories')
      .insert({ establishment_id: estId, name, sort_order: (last?.sort_order ?? 0) + 1 }).select().single());
  }

  /** Vagas por faixa de horário numa data (pedidos não cancelados). */
  async function availability(estId, date) {
    const [slotsRes, ordersRes] = await Promise.all([
      db.from('time_slots').select('id, label, start_time, end_time, max_orders').eq('establishment_id', estId).eq('active', true).order('sort_order'),
      db.from('orders').select('time_slot_id').eq('establishment_id', estId).eq('delivery_date', date).neq('status', 'cancelado'),
    ]);
    const slots = unwrap(slotsRes);
    const booked = new Map();
    for (const o of unwrap(ordersRes)) booked.set(o.time_slot_id, (booked.get(o.time_slot_id) ?? 0) + 1);
    return slots.map((s) => {
      const n = booked.get(s.id) ?? 0;
      const remaining = s.max_orders == null ? null : Math.max(0, s.max_orders - n);
      return { id: s.id, label: s.label, start_time: s.start_time, end_time: s.end_time, remaining, full: remaining === 0 };
    });
  }

  async function timeSlots(estId) {
    return unwrap(await db.from('time_slots').select('*').eq('establishment_id', estId).order('sort_order'));
  }

  /** Cardápio inicial de uma loja nova: categorias e faixas de horário padrão. */
  async function seedDefaults(estId) {
    unwrap(await db.from('categories').insert(DEFAULT_CATEGORIES.map((name, i) => ({ establishment_id: estId, name, sort_order: i + 1 }))));
    unwrap(await db.from('time_slots').insert(DEFAULT_SLOTS.map(([label, start_time, end_time, max_orders], i) => ({
      establishment_id: estId, label, start_time, end_time, max_orders, sort_order: i + 1,
    }))));
  }

  return { publicCatalog, adminProducts, createProduct, updateProduct, createCategory, timeSlots, availability, seedDefaults };
}
