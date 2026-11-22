import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, CreateOrderSchema, OrderStatusSchema, ReportQuerySchema, ProductUpdateSchema } from '../src/schemas.js';
import { toCsv, centsToBr } from '../src/lib/csv.js';

const valid = {
  customer_name: '  Ana Souza ',
  customer_phone: '(11) 99999-8888',
  fulfillment: 'retirada',
  delivery_date: '2026-11-20',
  time_slot_id: '2',
  items: [{ product_id: 1, quantity: '10' }],
};

test('pedido válido é normalizado (telefone só dígitos, trim, números)', () => {
  const o = parse(CreateOrderSchema, valid);
  assert.equal(o.customer_name, 'Ana Souza');
  assert.equal(o.customer_phone, '11999998888');
  assert.equal(o.time_slot_id, 2);
  assert.equal(o.items[0].quantity, 10);
});

test('cliente NÃO consegue enviar preço — campo é descartado', () => {
  const o = parse(CreateOrderSchema, { ...valid, items: [{ product_id: 1, quantity: 1, unit_price_cents: 1 }], total_cents: 1 });
  assert.equal(o.items[0].unit_price_cents, undefined);
  assert.equal(o.total_cents, undefined);
});

test('entrega exige endereço; produto duplicado é rejeitado', () => {
  assert.throws(() => parse(CreateOrderSchema, { ...valid, fulfillment: 'entrega' }), /endereço/);
  assert.throws(
    () => parse(CreateOrderSchema, { ...valid, items: [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 2 }] }),
    /repetido/,
  );
});

test('quantidade inválida e telefone curto', () => {
  assert.throws(() => parse(CreateOrderSchema, { ...valid, items: [{ product_id: 1, quantity: 0 }] }));
  assert.throws(() => parse(CreateOrderSchema, { ...valid, customer_phone: '1234' }), /Telefone/);
});

test('cancelar exige motivo', () => {
  assert.throws(() => parse(OrderStatusSchema, { status: 'cancelado' }), /motivo/);
  assert.equal(parse(OrderStatusSchema, { status: 'cancelado', note: 'Cliente desistiu' }).status, 'cancelado');
});

test('relatório: período invertido e lista de status', () => {
  assert.throws(() => parse(ReportQuerySchema, { from: '2026-11-20', to: '2026-11-01' }));
  const q = parse(ReportQuerySchema, { from: '2026-11-01', to: '2026-11-30', status: 'entregue,pronto' });
  assert.deepEqual(q.status, ['entregue', 'pronto']);
  assert.throws(() => parse(ReportQuerySchema, { from: '2026-11-01', to: '2026-11-30', status: 'hackeado' }));
});

test('PATCH de produto altera só o que foi enviado', () => {
  assert.deepEqual(parse(ProductUpdateSchema, { available: false }), { available: false });
  assert.throws(() => parse(ProductUpdateSchema, {}));
  assert.throws(() => parse(ProductUpdateSchema, { id: 5 })); // campo desconhecido
});

test('CSV: separador ;, BOM e proteção contra fórmula', () => {
  const csv = toCsv([['=HYPERLINK("x")', 'a;b'], [centsToBr(12345)]]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"a;b"'));
  assert.ok(csv.includes('123,45'));
});
