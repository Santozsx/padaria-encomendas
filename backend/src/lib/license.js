// Regra da licença (a mesma da função SQL license_state, em 007_licencas.sql).
//   cortesia  -> liberada sem cobrança
//   teste     -> dentro do teste grátis
//   ativa     -> assinatura paga em dia
//   atrasada  -> venceu, mas ainda está nos dias de tolerância (funciona, com aviso)
//   bloqueada -> venceu e passou a tolerância: não recebe pedidos
const DAY = 86_400_000;

export const LICENSE_LABEL = {
  cortesia: 'Cortesia',
  teste: 'Teste grátis',
  ativa: 'Ativa',
  atrasada: 'Pagamento atrasado',
  bloqueada: 'Bloqueada',
};

/**
 * @param {{ licenseMode: string, trialEndsAt?: string|null, paidUntil?: string|null }} est
 * @param {number} graceDays
 */
export function licenseInfo(est, graceDays = 3, now = Date.now()) {
  const t = (v) => (v ? new Date(v).getTime() : -Infinity);
  const paid = t(est.paidUntil);
  const trial = t(est.trialEndsAt);
  const validUntil = Math.max(paid, trial);
  let state;
  if (est.licenseMode === 'cortesia') state = 'cortesia';
  else if (now <= validUntil && est.paidUntil && now <= paid) state = 'ativa';
  else if (now <= validUntil) state = 'teste';
  else if (now <= validUntil + graceDays * DAY) state = 'atrasada';
  else state = 'bloqueada';

  const until = Number.isFinite(validUntil) ? new Date(validUntil).toISOString() : null;
  const blockAt = Number.isFinite(validUntil) ? new Date(validUntil + graceDays * DAY).toISOString() : null;
  return {
    state,
    label: LICENSE_LABEL[state],
    valid_until: state === 'cortesia' ? null : until,
    blocks_at: state === 'cortesia' ? null : blockAt,
    days_left: state === 'cortesia' || !Number.isFinite(validUntil) ? null : Math.ceil((validUntil - now) / DAY),
    blocked: state === 'bloqueada',
  };
}
