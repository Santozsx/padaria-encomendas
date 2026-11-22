// Datas "de calendário" (YYYY-MM-DD) calculadas no fuso da loja.
// O servidor pode estar em UTC: às 22h de São Paulo já é "amanhã" em UTC,
// por isso NUNCA usamos new Date().toISOString().slice(0, 10) para "hoje".

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Data de hoje (YYYY-MM-DD) no fuso informado. */
export function todayInTz(timeZone, now = new Date()) {
  // 'en-CA' formata como 2026-11-19
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Soma dias a uma data YYYY-MM-DD (aritmética em UTC, sem horário de verão). */
export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** true se a string é uma data real (rejeita 2026-02-30). */
export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Janela de datas aceitas para entrega/retirada. */
export function deliveryWindow({ timezone, minLeadDays, maxLeadDays }, now = new Date()) {
  const today = todayInTz(timezone, now);
  return {
    today,
    minDate: addDays(today, minLeadDays),
    maxDate: addDays(today, maxLeadDays),
  };
}

/** Valida uma data de entrega. Retorna null se ok, ou { code, message }. */
export function checkDeliveryDate(date, settings, now = new Date()) {
  if (!isValidIsoDate(date)) {
    return { code: 'DATA_INVALIDA', message: 'Data de entrega inválida.' };
  }
  const { minDate, maxDate } = deliveryWindow(settings, now);
  // comparação de strings funciona porque o formato é YYYY-MM-DD
  if (date < minDate) {
    return { code: 'DATA_ANTECEDENCIA', message: `A data mínima para encomendas é ${formatBr(minDate)}.` };
  }
  if (date > maxDate) {
    return { code: 'DATA_MUITO_DISTANTE', message: `Aceitamos encomendas até ${formatBr(maxDate)}.` };
  }
  return null;
}

export function formatBr(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}
