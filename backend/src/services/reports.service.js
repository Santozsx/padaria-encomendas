// Relatórios de vendas: a agregação roda no banco (função sales_report).
import { unwrap } from '../lib/errors.js';
import { toCsv, centsToBr } from '../lib/csv.js';
import { formatBr } from '../lib/dates.js';

const STATUS_LABEL = {
  recebido: 'Recebido',
  em_producao: 'Em produção',
  pronto: 'Pronto',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};

export function createReportsService(db) {
  async function sales(estId, f) {
    return unwrap(
      await db.rpc('sales_report', {
        p_establishment_id: estId,
        p_from: f.from,
        p_to: f.to,
        p_date_field: f.date_field,
        p_statuses: f.status?.length ? f.status : null,
        p_fulfillment: f.fulfillment ?? null,
        p_product_id: f.product_id ?? null,
      }),
    );
  }

  /** Mesmo relatório em CSV (abre direto no Excel). */
  async function salesCsv(estId, f, storeName = '') {
    const r = await sales(estId, f);
    const s = r.summary;
    const rows = [
      ['Relatório de vendas', storeName],
      ['Período', `${formatBr(f.from)} a ${formatBr(f.to)}`, 'Base', f.date_field === 'pedido' ? 'Data do pedido' : 'Data de entrega'],
      [],
      ['Pedidos válidos', s.orders_count],
      ['Cancelados', s.cancelled_count],
      ['Faturamento (R$)', centsToBr(s.revenue_cents)],
      ['Faturamento entregue (R$)', centsToBr(s.delivered_revenue_cents)],
      ['Ticket médio (R$)', centsToBr(s.avg_ticket_cents)],
      ['Itens vendidos', s.items_qty],
      [],
      ['Produtos mais encomendados'],
      ['Produto', 'Quantidade', 'Faturamento (R$)'],
      ...r.top_products.map((p) => [p.product_name, p.quantity, centsToBr(p.revenue_cents)]),
      [],
      ['Vendas por dia'],
      ['Dia', 'Pedidos', 'Faturamento (R$)'],
      ...r.by_day.map((d) => [formatBr(d.day), d.orders_count, centsToBr(d.revenue_cents)]),
      [],
      ['Pedidos'],
      ['Nº', 'Entrega', 'Horário', 'Cliente', 'Telefone', 'Modalidade', 'Status', 'Total (R$)'],
      ...r.orders.map((o) => [
        o.code,
        formatBr(o.delivery_date),
        o.time_slot_label,
        o.customer_name,
        o.customer_phone,
        o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada',
        STATUS_LABEL[o.status] ?? o.status,
        centsToBr(o.total_cents),
      ]),
    ];
    return toCsv(rows);
  }

  return { sales, salesCsv };
}
