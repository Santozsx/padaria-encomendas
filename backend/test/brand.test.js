// Identidade visual: cores (contraste) e validação da logo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHex, palette, contrast, brandInfo, cssVars } from '../src/lib/brand.js';
import { decodeLogo, sniffImage } from '../src/services/branding.service.js';

// PNG 1x1 transparente
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('normaliza cores', () => {
  assert.equal(normalizeHex('#a1b2c3'), '#A1B2C3');
  assert.equal(normalizeHex('abc'), '#AABBCC');
  assert.equal(normalizeHex(''), null);
  assert.equal(normalizeHex('vermelho'), null);
});

test('sem cores: visual padrão', () => {
  assert.equal(palette(null, null), null);
  assert.equal(cssVars(null), '');
});

test('cor escura: texto do botão branco', () => {
  const p = palette('#5A2D0C', null); // marrom
  assert.equal(p.vars['--brand-ink'], '#FFFFFF');
  assert.ok(contrast(p.vars['--brand'], p.vars['--brand-ink']) >= 4.5);
  assert.equal(p.side_tone, null);
});

test('cor clara (amarelo): texto escuro e links legíveis', () => {
  const p = palette('#FFD23F', '#FFF4D6');
  assert.notEqual(p.vars['--brand-ink'], '#FFFFFF');
  assert.ok(contrast(p.vars['--brand'], p.vars['--brand-ink']) >= 4.5);
  // links/ícones sobre branco precisam de 4.5:1
  assert.ok(contrast(p.vars['--brand-text'], '#FFFFFF') >= 4.5);
  // secundária clara → menu lateral com texto escuro
  assert.equal(p.side_tone, 'light');
  assert.ok(contrast(p.vars['--brand-2'], p.vars['--brand-2-ink']) >= 4.5);
});

test('qualquer cor gera combinações legíveis', () => {
  for (const c of ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#000000', '#E91E63', '#7FFFD4', '#808080', '#C0A060']) {
    const p = palette(c, c);
    assert.ok(contrast(p.vars['--brand'], p.vars['--brand-ink']) >= 4.5, `botão ${c}`);
    assert.ok(contrast(p.vars['--brand-hover'], p.vars['--brand-ink']) >= 4.5, `botão (mouse em cima) ${c}`);
    assert.ok(contrast(p.vars['--brand-text'], '#FFFFFF') >= 4.5, `texto ${c}`);
    assert.ok(contrast(p.vars['--brand-2'], p.vars['--brand-2-ink']) >= 4.5, `menu ${c}`);
    // fundos continuam claros (só um toque da cor), texto escuro continua legível
    for (const k of ['--bg', '--bg-staff', '--surface-2', '--surface-3', '--brand-soft', '--lane']) {
      assert.ok(contrast(p.vars[k], '#13262B') >= 10, `${k} claro demais/escuro demais com ${c}: ${p.vars[k]}`);
    }
  }
});

test('endereço da logo muda quando a logo muda', () => {
  const est = { slug: 'doce-sabor', brandColor: '#123456', logoUpdatedAt: '2026-11-23T19:00:00Z' };
  const b = brandInfo(est);
  assert.equal(b.logo_url, `/api/public/logos/doce-sabor?v=${Date.parse('2026-11-23T19:00:00Z')}`);
  assert.equal(brandInfo({ slug: 'x' }).logo_url, null);
  assert.match(cssVars(b), /^<style id="brand-vars">html:root\{--brand:#123456;/);
});

test('logo: aceita PNG e recusa o que não é imagem', () => {
  const { mime, buf } = decodeLogo(`data:image/png;base64,${PNG_1PX}`);
  assert.equal(mime, 'image/png');
  assert.equal(sniffImage(buf), 'image/png');
  // SVG/HTML disfarçado não passa
  const fake = Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');
  assert.throws(() => decodeLogo(fake), /PNG, JPG ou WebP/);
  assert.throws(() => decodeLogo('isso não é base64!'), /Não consegui ler/);
  const big = Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(600 * 1024)]).toString('base64');
  assert.throws(() => decodeLogo(big), /grande demais/);
});
