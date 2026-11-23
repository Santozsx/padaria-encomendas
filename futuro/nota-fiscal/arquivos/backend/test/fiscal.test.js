import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNfce, isoWithOffset } from '../src/services/fiscal.service.js';

const est = {
  doc_type: 'cnpj', doc_number: '11222333000181', timezone: 'America/Sao_Paulo', regime_tributario: 1,
  fiscal_cfop: '5101', fiscal_csosn: '102', fiscal_pis_cst: '49', fiscal_cofins_cst: '49',
  fiscal_ncm_default: null, fiscal_payment_form: '01', fiscal_ibs_cbs: false,
};
const order = {
  code: 1081, fulfillment: 'retirada', total_cents: 4790, customer_name: 'Maria da Silva', customer_cpf: null,
  items: [
    { product_id: 1, product_name: 'Bolo de cenoura', unit_label: 'un', unit_price_cents: 3990, quantity: 1 },
    { product_id: 2, product_name: 'Pão de queijo', unit_label: 'cento', unit_price_cents: 400, quantity: 2 },
  ],
};
const products = [{ id: 1, ncm: '19059090', cfop: null, cest: null }, { id: 2, ncm: '19059090', cfop: '5102', cest: '1706400' }];

test('data de emissão com o fuso da loja', () => {
  assert.equal(isoWithOffset(new Date('2026-11-23T17:55:10Z'), 'America/Sao_Paulo'), '2026-11-23T14:55:10-03:00');
  assert.equal(isoWithOffset(new Date('2026-11-23T17:55:10Z'), 'UTC'), '2026-11-23T17:55:10+00:00');
});

test('monta a NFC-e com itens, CFOP do produto/loja, pagamento e Simples', () => {
  const n = buildNfce(est, order, products, new Date('2026-11-23T17:55:10Z'));
  assert.equal(n.cnpj_emitente, '11222333000181');
  assert.equal(n.presenca_comprador, '1');
  assert.equal(n.items.length, 2);
  assert.equal(n.items[0].cfop, '5101');
  assert.equal(n.items[1].cfop, '5102');
  assert.equal(n.items[1].cest, '1706400');
  assert.equal(n.items[1].unidade_comercial, 'CENTO');
  assert.equal(n.items[1].valor_bruto, '8.00');
  assert.equal(n.items[0].icms_situacao_tributaria, '102');
  assert.deepEqual(n.formas_pagamento, [{ forma_pagamento: '01', valor_pagamento: '47.90' }]);
  assert.equal(n.cpf_destinatario, undefined);
  assert.match(n.informacoes_adicionais_contribuinte, /Pedido #1081/);
});

test('CPF na nota, entrega e IBS/CBS opcionais', () => {
  const n = buildNfce({ ...est, fiscal_ibs_cbs: true, fiscal_ibs_cbs_cst: '000', fiscal_cclasstrib: '000001' },
    { ...order, fulfillment: 'entrega', customer_cpf: '52998224725' }, products);
  assert.equal(n.presenca_comprador, '4');
  assert.equal(n.cpf_destinatario, '52998224725');
  assert.equal(n.items[0].cbs_aliquota, '0.90');
  assert.equal(n.items[0].ibs_cbs_base_calculo, '39.90');
});

test('sem NCM ou sem CNPJ: erro claro, nada é enviado', () => {
  assert.throws(() => buildNfce(est, order, [{ id: 1 }, { id: 2 }]), /NCM do produto "Bolo de cenoura"/);
  assert.equal(buildNfce({ ...est, fiscal_ncm_default: '19059090' }, order, [{ id: 1 }, { id: 2 }]).items[0].codigo_ncm, '19059090');
  assert.throws(() => buildNfce({ ...est, doc_type: 'cpf' }, order, products), /CNPJ/);
});
