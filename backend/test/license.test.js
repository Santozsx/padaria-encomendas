import { test } from 'node:test';
import assert from 'node:assert/strict';
import { licenseInfo } from '../src/lib/license.js';

const DAY = 86_400_000;
const now = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('cortesia nunca vence', () => {
  const l = licenseInfo({ licenseMode: 'cortesia' }, 3, now);
  assert.equal(l.state, 'cortesia');
  assert.equal(l.blocked, false);
});

test('teste grátis, atrasada na tolerância e bloqueada depois', () => {
  assert.equal(licenseInfo({ licenseMode: 'assinatura', trialEndsAt: iso(now + 5 * DAY) }, 3, now).state, 'teste');
  assert.equal(licenseInfo({ licenseMode: 'assinatura', trialEndsAt: iso(now + 5 * DAY) }, 3, now).days_left, 5);
  assert.equal(licenseInfo({ licenseMode: 'assinatura', trialEndsAt: iso(now - 2 * DAY) }, 3, now).state, 'atrasada');
  const b = licenseInfo({ licenseMode: 'assinatura', trialEndsAt: iso(now - 4 * DAY) }, 3, now);
  assert.equal(b.state, 'bloqueada');
  assert.equal(b.blocked, true);
});

test('pagamento em dia deixa a licença ativa', () => {
  const l = licenseInfo({ licenseMode: 'assinatura', trialEndsAt: iso(now - 40 * DAY), paidUntil: iso(now + 20 * DAY) }, 3, now);
  assert.equal(l.state, 'ativa');
  assert.equal(l.days_left, 20);
  assert.equal(licenseInfo({ licenseMode: 'assinatura', paidUntil: iso(now - 1 * DAY) }, 3, now).state, 'atrasada');
});
