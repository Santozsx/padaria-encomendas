// Identidade visual da loja: a partir de 1 ou 2 cores escolhidas pela
// padaria, monta a paleta completa usada pelas telas (variáveis CSS).
// Tudo é calculado aqui no servidor, para as telas só aplicarem o resultado.
// Cuida do contraste: se a cor for clara (ex.: amarelo), o texto do botão
// fica escuro, e links/ícones usam uma versão mais escura que dá para ler.

export const HEX_RE = /^#[0-9A-F]{6}$/;

/** "#a1b2c3" / "a1b2c3" / "#abc" → "#A1B2C3" (ou null se inválido). */
export function normalizeHex(value) {
  if (value == null || value === '') return null;
  let v = String(value).trim().toUpperCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9A-F]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX_RE.test(v) ? v : null;
}

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** Mistura a cor `a` com `b`: t=0 → a, t=1 → b. */
export function mix(a, b, t) {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}

/** Luminância relativa (WCAG). */
export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste entre duas cores (1 a 21). 4.5 = mínimo para texto normal. */
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const WHITE = '#FFFFFF';
const DARK = '#141414';

/** Branco ou quase-preto: o que for mais legível em cima da cor. */
export function inkOn(hex) {
  return contrast(hex, WHITE) >= contrast(hex, DARK) ? WHITE : DARK;
}

/** Escurece a cor até dar contraste `min` sobre o fundo (para texto/ícones). */
export function readableOn(hex, bg = WHITE, min = 4.5) {
  let c = hex;
  for (let i = 0; i < 20 && contrast(c, bg) < min; i += 1) c = mix(c, '#000000', 0.08);
  return c;
}

/**
 * Paleta da loja. Sem cores, devolve null (as telas ficam no visual padrão).
 * @returns {{ vars: Record<string,string>, side_tone: 'dark'|'light'|null, theme_color: string } | null}
 */
export function palette(primary, secondary) {
  const p = normalizeHex(primary);
  const s = normalizeHex(secondary);
  if (!p && !s) return null;
  const vars = {};
  if (p) {
    // Cores "do meio" (ex.: rosa #E91E63) não dão 4.5:1 nem com branco nem com
    // preto: escurecemos um pouco o fundo do botão até o texto branco ficar legível.
    let btn = p;
    let ink = inkOn(btn);
    if (contrast(btn, ink) < 4.5) {
      btn = readableOn(p, WHITE);
      ink = WHITE;
    }
    const text = readableOn(p);
    Object.assign(vars, {
      '--brand': btn,
      '--brand-raw': p, // a cor exata escolhida (faixas e detalhes sem texto)
      // mouse em cima: escurece (texto branco) ou clareia (texto escuro), sem perder contraste
      '--brand-hover': ink === WHITE ? mix(btn, '#000000', 0.16) : mix(btn, WHITE, 0.14),
      '--brand-ink': ink,
      '--brand-soft': mix(p, WHITE, 0.87),
      '--brand-text': text,
      '--brand-text-hover': mix(text, '#000000', 0.22),
      // fundos e bordas levemente tingidos com a cor da loja
      '--bg': mix('#F7F7F7', p, 0.035),
      '--bg-staff': mix('#F3F3F3', p, 0.04),
      '--surface-2': mix(p, WHITE, 0.9),
      '--surface-3': mix(p, WHITE, 0.94),
      '--lane': mix('#ECECEC', p, 0.06),
      '--line': mix('#E3E3E3', p, 0.06),
      '--line-2': mix('#D9D9D9', p, 0.06),
      '--line-3': mix('#CCCCCC', p, 0.06),
    });
  }
  // Cor secundária: menu lateral do atendimento e detalhes da loja.
  const second = s || null;
  let sideTone = null;
  if (second) {
    let side = second;
    if (contrast(side, inkOn(side)) < 4.5) side = readableOn(second, WHITE);
    sideTone = inkOn(side) === WHITE ? 'dark' : 'light';
    vars['--brand-2'] = side;
    vars['--brand-2-ink'] = sideTone === 'dark' ? WHITE : DARK;
  }
  return { vars, side_tone: sideTone, theme_color: p || second };
}

/** Bloco <style> com as variáveis (para colocar no <head>).
 *  "html:root" pesa mais que o ":root" do base.css, então vale mesmo vindo antes dele. */
export function cssVars(pal) {
  if (!pal || !pal.vars) return '';
  const body = Object.entries(pal.vars).map(([k, v]) => `${k}:${v}`).join(';');
  return `<style id="brand-vars">html:root{${body}}</style>`;
}

/** Dados de marca que vão para as telas. */
export function brandInfo(est) {
  const primary = normalizeHex(est.brandColor);
  const secondary = normalizeHex(est.brandColor2);
  const logoUrl = est.logoUpdatedAt
    ? `/api/public/logos/${est.slug}?v=${new Date(est.logoUpdatedAt).getTime()}`
    : null;
  return { primary, secondary, logo_url: logoUrl, ...(palette(primary, secondary) ?? { vars: null, side_tone: null, theme_color: null }) };
}
