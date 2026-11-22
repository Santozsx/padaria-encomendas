import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCpf, isValidCnpj, parseDocument, formatDocument, slugify } from '../src/lib/documents.js';

test('CPF: dígitos verificadores', () => {
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('529.982.247-24'), false);
  assert.equal(isValidCpf('111.111.111-11'), false);
});

test('CNPJ: dígitos verificadores', () => {
  assert.equal(isValidCnpj('11.222.333/0001-81'), true);
  assert.equal(isValidCnpj('11.222.333/0001-80'), false);
  assert.equal(isValidCnpj('00.000.000/0000-00'), false);
});

test('parseDocument descobre o tipo e formata', () => {
  assert.deepEqual(parseDocument('11222333000181'), { type: 'cnpj', number: '11222333000181' });
  assert.deepEqual(parseDocument('52998224725'), { type: 'cpf', number: '52998224725' });
  assert.equal(parseDocument('123'), null);
  assert.equal(formatDocument('cnpj', '11222333000181'), '11.222.333/0001-81');
  assert.equal(formatDocument('cpf', '52998224725'), '529.982.247-25');
});

test('link da loja a partir do nome', () => {
  assert.equal(slugify('Padaria São José!'), 'padaria-sao-jose');
  assert.equal(slugify('  Doce & Cia  '), 'doce-cia');
});
