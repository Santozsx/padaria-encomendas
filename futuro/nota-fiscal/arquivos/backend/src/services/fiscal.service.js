// Nota fiscal (NFC-e, modelo 65) de cada pedido, emitida pela Focus NFe.
//
// Quando emite (configurável por loja, establishments.fiscal_emit_on):
//   'entrega' (padrão) -> ao marcar o pedido como entregue/retirado
//   'pedido'           -> assim que o cliente confirma a encomenda
//   'manual'           -> só pelo botão "Emitir nota" no atendimento
//
// O que o contador precisa definir (tela Atendimento > Nota fiscal):
// regime tributário, CFOP, CSOSN/CST, PIS/COFINS e o NCM de cada produto.
// Nada aqui decide tributação por conta própria: são os valores informados.
import { AppError, unwrap } from '../lib/errors.js';
import { createFocus } from '../lib/focus.js';

const FISCAL_FIELDS = [
  'id', 'slug', 'name', 'doc_type', 'doc_number', 'phone', 'timezone',
  'fiscal_enabled', 'fiscal_env', 'fiscal_emit_on', 'inscricao_estadual', 'regime_tributario', 'razao_social',
  'addr_street', 'addr_number', 'addr_district', 'addr_city', 'addr_uf', 'addr_zip',
  'fiscal_cfop', 'fiscal_csosn', 'fiscal_pis_cst', 'fiscal_cofins_cst', 'fiscal_ncm_default', 'fiscal_payment_form',
  'fiscal_ibs_cbs', 'fiscal_ibs_cbs_cst', 'fiscal_cclasstrib', 'focus_company_id', 'fiscal_cert_valid_until',
].join(', ');

// Alíquotas-teste de 2026 da Reforma Tributária (CBS 0,9% e IBS 0,1%)
const IBS_CBS_TEST = { cbs: '0.90', ibsUf: '0.10', ibsMun: '0.00' };

const money = (cents) => (Number(cents) / 100).toFixed(2);
const UNITS = { un: 'UN', unidade: 'UN', kg: 'KG', g: 'G', cento: 'CENTO', dz: 'DZ', duzia: 'DZ', pct: 'PCT', fatia: 'FATIA' };
const unitOf = (label) => UNITS[String(label || '').toLowerCase().trim()] || String(label || 'UN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'UN';

/** "2026-11-23T14:55:00-03:00" no fuso da loja (a SEFAZ aceita até 5 min de diferença). */
export function isoWithOffset(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offMin = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

/**
 * Monta o JSON da NFC-e no formato da Focus NFe.
 * Lança AppError com mensagem clara se faltar dado fiscal (ex.: NCM).
 */
export function buildNfce(est, order, products, now = new Date()) {
  if (est.doc_type !== 'cnpj') {
    throw new AppError(422, 'FISCAL_SEM_CNPJ', 'NFC-e só pode ser emitida por loja com CNPJ.');
  }
  const byId = new Map(products.map((p) => [Number(p.id), p]));
  const simples = [1, 2, 4].includes(Number(est.regime_tributario));
  const items = order.items.map((it, i) => {
    const p = byId.get(Number(it.product_id)) ?? {};
    const ncm = p.ncm || est.fiscal_ncm_default;
    if (!ncm) {
      throw new AppError(422, 'FISCAL_SEM_NCM', `Falta o NCM do produto "${it.product_name}". Cadastre em Produtos (ou um NCM padrão em Nota fiscal).`);
    }
    const unit = unitOf(it.unit_label);
    const item = {
      numero_item: i + 1,
      codigo_produto: String(it.product_id),
      descricao: it.product_name,
      codigo_ncm: ncm,
      cfop: p.cfop || est.fiscal_cfop,
      unidade_comercial: unit,
      quantidade_comercial: Number(it.quantity),
      valor_unitario_comercial: money(it.unit_price_cents),
      valor_bruto: money(Number(it.unit_price_cents) * Number(it.quantity)),
      unidade_tributavel: unit,
      quantidade_tributavel: Number(it.quantity),
      valor_unitario_tributavel: money(it.unit_price_cents),
      icms_origem: '0',
      icms_situacao_tributaria: est.fiscal_csosn, // CSOSN no Simples; CST no Regime Normal
      pis_situacao_tributaria: est.fiscal_pis_cst,
      cofins_situacao_tributaria: est.fiscal_cofins_cst,
    };
    if (p.cest) item.cest = p.cest;
    if (est.fiscal_ibs_cbs) {
      Object.assign(item, {
        ibs_cbs_situacao_tributaria: est.fiscal_ibs_cbs_cst,
        ibs_cbs_classificacao_tributaria: est.fiscal_cclasstrib,
        ibs_cbs_base_calculo: item.valor_bruto,
        ibs_uf_aliquota: IBS_CBS_TEST.ibsUf,
        ibs_mun_aliquota: IBS_CBS_TEST.ibsMun,
        cbs_aliquota: IBS_CBS_TEST.cbs,
      });
    }
    return item;
  });

  const nfce = {
    cnpj_emitente: est.doc_number,
    data_emissao: isoWithOffset(now, est.timezone || 'America/Sao_Paulo'),
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    presenca_comprador: order.fulfillment === 'entrega' ? '4' : '1', // 4 = entrega em domicílio, 1 = presencial
    modalidade_frete: '9',  // sem frete
    local_destino: '1',     // operação interna
    items,
    formas_pagamento: [{ forma_pagamento: est.fiscal_payment_form || '01', valor_pagamento: money(order.total_cents) }],
    informacoes_adicionais_contribuinte: `Pedido #${order.code}${simples ? ' - Documento emitido por ME ou EPP optante pelo Simples Nacional' : ''}`,
  };
  if (order.customer_cpf) {
    nfce.cpf_destinatario = order.customer_cpf;
    nfce.nome_destinatario = String(order.customer_name).slice(0, 60);
  }
  return nfce;
}

export function createFiscalService(db, { focus = createFocus(), log = console } = {}) {
  async function loadEst(estId) {
    const { data, error } = await db.from('establishments').select(FISCAL_FIELDS).eq('id', estId).maybeSingle();
    if (error) unwrap({ error });
    if (!data) throw new AppError(404, 'LOJA_NAO_ENCONTRADA', 'Loja não encontrada.');
    return data;
  }

  async function tokens(estId) {
    const { data, error } = await db.from('fiscal_secrets').select('focus_token_producao, focus_token_homologacao')
      .eq('establishment_id', estId).maybeSingle();
    if (error) unwrap({ error });
    return { producao: data?.focus_token_producao || null, homologacao: data?.focus_token_homologacao || null };
  }

  // ------------------------------------------------------------ configuração (admin da loja)
  async function getConfig(estId) {
    const est = await loadEst(estId);
    const tk = await tokens(estId);
    const { focus_company_id: companyId, ...cfg } = est;
    return {
      ...cfg,
      company_registered: Boolean(companyId),
      token_ok: { producao: Boolean(tk.producao), homologacao: Boolean(tk.homologacao) },
      focus_ready: focus.masterConfigured,
      ready: Boolean(est.fiscal_enabled && companyId && tk[est.fiscal_env]),
    };
  }

  function companyPayload(est, extra = {}) {
    return {
      nome: est.razao_social || est.name,
      nome_fantasia: est.name,
      cnpj: est.doc_number,
      inscricao_estadual: est.inscricao_estadual,
      regime_tributario: Number(est.regime_tributario),
      logradouro: est.addr_street,
      numero: est.addr_number,
      bairro: est.addr_district,
      municipio: est.addr_city,
      uf: est.addr_uf,
      cep: est.addr_zip,
      telefone: est.phone || undefined,
      habilita_nfce: true,
      ...extra,
    };
  }

  /** Envia o cadastro da loja para a Focus (com certificado e CSC, quando informados). */
  async function syncCompany(estId, { certificateBase64, certificatePassword, csc } = {}) {
    const est = await loadEst(estId);
    if (est.doc_type !== 'cnpj') throw new AppError(422, 'FISCAL_SEM_CNPJ', 'NFC-e só pode ser emitida por loja com CNPJ. Esta loja está cadastrada com CPF.');
    const missing = [['inscricao_estadual', 'inscrição estadual'], ['addr_street', 'rua'], ['addr_number', 'número'],
      ['addr_district', 'bairro'], ['addr_city', 'cidade'], ['addr_uf', 'UF'], ['addr_zip', 'CEP']]
      .filter(([k]) => !est[k]).map(([, l]) => l);
    if (missing.length) throw new AppError(422, 'FISCAL_INCOMPLETO', `Preencha antes: ${missing.join(', ')}.`);

    const extra = {};
    if (certificateBase64) Object.assign(extra, { arquivo_certificado_base64: certificateBase64, senha_certificado: certificatePassword });
    if (csc?.producao_id && csc?.producao) Object.assign(extra, { id_token_nfce_producao: csc.producao_id, csc_nfce_producao: csc.producao });
    if (csc?.homologacao_id && csc?.homologacao) Object.assign(extra, { id_token_nfce_homologacao: csc.homologacao_id, csc_nfce_homologacao: csc.homologacao });
    if (!est.focus_company_id && !certificateBase64) {
      throw new AppError(422, 'FISCAL_SEM_CERTIFICADO', 'Envie o certificado digital A1 (.pfx) da loja para concluir o cadastro.');
    }

    const r = await focus.saveCompany(est.focus_company_id, companyPayload(est, extra));
    const row = { focus_company_id: r.id };
    if (r.certValidUntil) row.fiscal_cert_valid_until = r.certValidUntil;
    unwrap(await db.from('establishments').update(row).eq('id', estId));
    if (r.tokenProducao || r.tokenHomologacao) {
      const secret = { establishment_id: estId, updated_at: new Date().toISOString() };
      if (r.tokenProducao) secret.focus_token_producao = r.tokenProducao;
      if (r.tokenHomologacao) secret.focus_token_homologacao = r.tokenHomologacao;
      const { data: exists } = await db.from('fiscal_secrets').select('establishment_id').eq('establishment_id', estId).maybeSingle();
      unwrap(exists
        ? await db.from('fiscal_secrets').update(secret).eq('establishment_id', estId)
        : await db.from('fiscal_secrets').insert(secret));
    }
    return getConfig(estId);
  }

  async function saveConfig(estId, cfg) {
    const { csc, certificate_base64: cert, certificate_password: certPwd, ...fields } = cfg;
    if (Object.keys(fields).length) unwrap(await db.from('establishments').update(fields).eq('id', estId));
    const est = await loadEst(estId);
    // reenvia para a Focus quando já existe cadastro, ou quando chegou certificado/CSC
    if (cert || csc || est.focus_company_id) {
      return syncCompany(estId, { certificateBase64: cert, certificatePassword: certPwd, csc });
    }
    return getConfig(estId);
  }

  // ------------------------------------------------------------ notas
  const view = (n) => n && {
    status: n.status, env: n.env, numero: n.numero, serie: n.serie, chave: n.chave, message: n.message,
    danfe_url: focus.absolute(n.env, n.danfe_url), xml_url: focus.absolute(n.env, n.xml_url),
    qrcode_url: n.qrcode_url, consulta_url: n.consulta_url, attempts: n.attempts,
    authorized_at: n.authorized_at, cancelled_at: n.cancelled_at, updated_at: n.updated_at,
    can_cancel: n.status === 'autorizada' && n.authorized_at && Date.now() - new Date(n.authorized_at).getTime() < 30 * 60_000,
  };

  async function noteRow(estId, orderId) {
    const { data, error } = await db.from('fiscal_notes').select('*').eq('establishment_id', estId).eq('order_id', orderId).maybeSingle();
    if (error) unwrap({ error });
    return data;
  }

  async function noteFor(estId, orderId) {
    return view(await noteRow(estId, orderId));
  }

  /** Nota do pedido + se a loja emite nota e quando (para a tela do pedido). */
  async function orderFiscal(estId, orderId) {
    const { data: est } = await db.from('establishments').select('fiscal_enabled, fiscal_emit_on, fiscal_env').eq('id', estId).maybeSingle();
    return {
      enabled: Boolean(est?.fiscal_enabled), emit_on: est?.fiscal_emit_on ?? 'entrega', env: est?.fiscal_env ?? null,
      note: est ? view(await noteRow(estId, orderId)) : null,
    };
  }

  async function saveNote(estId, orderId, fields, current) {
    const row = { ...fields, updated_at: new Date().toISOString() };
    if (current) {
      return unwrap(await db.from('fiscal_notes').update(row).eq('id', current.id).select().single());
    }
    return unwrap(await db.from('fiscal_notes').insert({ establishment_id: estId, order_id: orderId, ...row }).select().single());
  }

  function applyResult(r) {
    if (r.status === 'autorizado') {
      return {
        status: 'autorizada', numero: r.numero, serie: r.serie, chave: r.chave, danfe_url: r.danfe, xml_url: r.xml,
        qrcode_url: r.qrcode, consulta_url: r.consulta, sefaz_status: r.sefazStatus, message: r.message || 'Autorizada',
        authorized_at: new Date().toISOString(),
      };
    }
    if (r.status === 'processando_autorizacao') return { status: 'processando', message: 'Aguardando a SEFAZ…' };
    return { status: 'erro', sefaz_status: r.sefazStatus, message: r.message || 'Nota rejeitada.' };
  }

  /**
   * Emite a nota do pedido. Seguro para chamar mais de uma vez: se já está
   * autorizada (ou em processamento) não emite de novo.
   * @returns a nota (formato de view) ou null se a loja não emite nota.
   */
  async function emitForOrder(estId, orderId, { force = false } = {}) {
    const est = await loadEst(estId);
    if (!est.fiscal_enabled) {
      if (force) throw new AppError(409, 'FISCAL_DESLIGADO', 'A emissão de nota fiscal está desligada nesta loja (Atendimento > Nota fiscal).');
      return null;
    }
    const current = await noteRow(estId, orderId);
    if (current && ['autorizada', 'processando', 'cancelada'].includes(current.status)) return view(current);

    const { data: order, error } = await db.from('orders').select('*, items:order_items(*)')
      .eq('id', orderId).eq('establishment_id', estId).maybeSingle();
    if (error) unwrap({ error });
    if (!order) throw new AppError(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.');
    if (order.status === 'cancelado') throw new AppError(409, 'PEDIDO_CANCELADO', 'Pedido cancelado não recebe nota fiscal.');

    const attempt = (current?.attempts ?? 0) + 1;
    const ref = `pedido-${order.id}-${attempt}`; // única na conta Focus (vale para todas as lojas)
    const base = { env: est.fiscal_env, ref, attempts: attempt };

    let payload;
    try {
      const ids = order.items.map((i) => i.product_id);
      const { data: products } = await db.from('products').select('id, ncm, cfop, cest').in('id', ids);
      payload = buildNfce(est, order, products ?? []);
    } catch (e) {
      return view(await saveNote(estId, orderId, { ...base, status: 'erro', message: e.message }, current));
    }
    const token = (await tokens(estId))[est.fiscal_env];
    if (!token) {
      return view(await saveNote(estId, orderId, { ...base, status: 'erro', message: 'A loja ainda não concluiu o cadastro fiscal (certificado/CSC) na Focus NFe.' }, current));
    }

    let note = await saveNote(estId, orderId, { ...base, status: 'processando', message: 'Enviando para a SEFAZ…' }, current);
    try {
      const r = await focus.emitNfce(est.fiscal_env, token, ref, payload);
      note = await saveNote(estId, orderId, applyResult(r), note);
    } catch (e) {
      note = await saveNote(estId, orderId, { status: 'erro', message: e.message }, note);
    }
    if (note.status === 'erro') log.warn?.(`[nota] pedido #${order.code} (${est.slug}): ${note.message}`);
    return view(note);
  }

  /** Dispara a emissão sem segurar a resposta da tela (erros ficam registrados na nota). */
  function emitInBackground(estId, orderId) {
    setImmediate(() => {
      emitForOrder(estId, orderId).catch((e) => log.error?.(`[nota] ${e.message}`));
    });
  }

  /** Chamado quando um pedido muda de situação. */
  async function onOrderStatus(estId, order) {
    const { data: est } = await db.from('establishments').select('fiscal_enabled, fiscal_emit_on').eq('id', estId).maybeSingle();
    if (!est?.fiscal_enabled) return;
    if (order.status === 'entregue' && est.fiscal_emit_on === 'entrega') emitInBackground(estId, order.id);
    if (order.status === 'cancelado') {
      const n = await noteRow(estId, order.id);
      if (n?.status === 'autorizada') cancelForOrder(estId, order.id, 'Pedido cancelado pela loja').catch((e) => log.error?.(`[nota] ${e.message}`));
    }
  }

  /** Chamado logo depois que o cliente confirma a encomenda. */
  async function onOrderCreated(estId, order) {
    const { data: est } = await db.from('establishments').select('fiscal_enabled, fiscal_emit_on').eq('id', estId).maybeSingle();
    if (est?.fiscal_enabled && est.fiscal_emit_on === 'pedido') emitInBackground(estId, order.id);
  }

  async function cancelForOrder(estId, orderId, justificativa) {
    const est = await loadEst(estId);
    const n = await noteRow(estId, orderId);
    if (!n || n.status !== 'autorizada') throw new AppError(409, 'NOTA_NAO_AUTORIZADA', 'Não há nota autorizada para cancelar.');
    const token = (await tokens(estId))[n.env];
    const motivo = String(justificativa || '').trim().padEnd(15, '.').slice(0, 255);
    let r;
    try {
      r = await focus.cancelNfce(n.env, token, n.ref, motivo);
    } catch (e) {
      return view(await saveNote(estId, orderId, { message: `Cancelamento não enviado: ${e.message}` }, n));
    }
    if (r.status === 'cancelado') {
      return view(await saveNote(estId, orderId, { status: 'cancelada', cancelled_at: new Date().toISOString(), message: r.message || 'Cancelada' }, n));
    }
    log.warn?.(`[nota] cancelamento negado (${est.slug}): ${r.message}`);
    return view(await saveNote(estId, orderId, {
      status: 'cancelamento_negado',
      message: `Cancelamento negado: ${r.message || 'prazo de 30 minutos encerrado'}. Fale com o contador.`,
    }, n));
  }

  /** Rotina: consulta notas que ficaram "processando" na SEFAZ. */
  async function sweep() {
    const { data } = await db.from('fiscal_notes').select('*').eq('status', 'processando').limit(50);
    let updated = 0;
    for (const n of data ?? []) {
      if (Date.now() - new Date(n.updated_at).getTime() < 60_000) continue;
      try {
        const token = (await tokens(n.establishment_id))[n.env];
        const r = await focus.getNfce(n.env, token, n.ref);
        if (r.status && r.status !== 'processando_autorizacao') {
          await saveNote(n.establishment_id, n.order_id, applyResult(r), n);
          updated++;
        }
      } catch (e) { log.error?.(`[nota] rotina: ${e.message}`); }
    }
    return { updated };
  }

  /** Notas de vários pedidos (para marcar os cartões do atendimento). */
  async function statusByOrders(estId, orderIds) {
    if (!orderIds.length) return {};
    const { data } = await db.from('fiscal_notes').select('order_id, status, numero').eq('establishment_id', estId).in('order_id', orderIds);
    return Object.fromEntries((data ?? []).map((n) => [n.order_id, { status: n.status, numero: n.numero }]));
  }

  /** Para o cliente: link da nota autorizada no acompanhamento. */
  async function publicNote(estId, orderId) {
    const n = await noteRow(estId, orderId).catch(() => null);
    if (!n || n.status !== 'autorizada') return null;
    return { numero: n.numero, danfe_url: focus.absolute(n.env, n.danfe_url), consulta_url: n.consulta_url, qrcode_url: n.qrcode_url, env: n.env };
  }

  return {
    getConfig, saveConfig, syncCompany, emitForOrder, emitInBackground, cancelForOrder,
    onOrderStatus, onOrderCreated, noteFor, orderFiscal, statusByOrders, publicNote, sweep,
  };
}
