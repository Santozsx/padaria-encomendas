// CSV compatível com Excel em português: separador ';', BOM UTF-8 e
// vírgula decimal. Protege contra "CSV injection" (=, +, -, @ no início).

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[;"\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

export function centsToBr(cents) {
  const n = Number(cents || 0) / 100;
  return n.toFixed(2).replace('.', ',');
}
