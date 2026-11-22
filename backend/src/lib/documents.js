// Validação de CPF/CNPJ (dígitos verificadores) e geração do link da loja.

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

export function isValidCpf(value) {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

export function isValidCnpj(value) {
  const d = onlyDigits(value);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(d[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** Descobre o tipo pelo tamanho e valida. Retorna { type, number } ou null. */
export function parseDocument(value) {
  const d = onlyDigits(value);
  if (d.length === 11 && isValidCpf(d)) return { type: 'cpf', number: d };
  if (d.length === 14 && isValidCnpj(d)) return { type: 'cnpj', number: d };
  return null;
}

export function formatDocument(type, number) {
  if (!number) return '';
  if (type === 'cpf') return number.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return number.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

/** "Padaria Pão Quente!" -> "padaria-pao-quente" */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
