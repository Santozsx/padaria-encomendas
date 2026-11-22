import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayInTz, addDays, isValidIsoDate, checkDeliveryDate, deliveryWindow } from '../src/lib/dates.js';

const settings = { timezone: 'America/Sao_Paulo', minLeadDays: 1, maxLeadDays: 60 };

test('"hoje" respeita o fuso de São Paulo, não o UTC', () => {
  // 19/11 às 23h30 em SP = 20/11 02h30 em UTC
  const now = new Date('2026-11-20T02:30:00Z');
  assert.equal(todayInTz('America/Sao_Paulo', now), '2026-11-19');
  assert.equal(todayInTz('UTC', now), '2026-11-20');
});

test('data mínima é amanhã (antecedência de 1 dia)', () => {
  const now = new Date('2026-11-20T02:30:00Z'); // ainda dia 19 em SP
  assert.deepEqual(deliveryWindow(settings, now), { today: '2026-11-19', minDate: '2026-11-20', maxDate: '2027-01-18' });
  assert.equal(checkDeliveryDate('2026-11-20', settings, now), null);
  assert.equal(checkDeliveryDate('2026-11-19', settings, now).code, 'DATA_ANTECEDENCIA');
  assert.equal(checkDeliveryDate('2026-11-18', settings, now).code, 'DATA_ANTECEDENCIA');
  assert.equal(checkDeliveryDate('2027-03-01', settings, now).code, 'DATA_MUITO_DISTANTE');
});

test('addDays atravessa mês e ano', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('isValidIsoDate rejeita datas impossíveis e formatos errados', () => {
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('20/11/2026'), false);
  assert.equal(isValidIsoDate('2026-11-20'), true);
});
