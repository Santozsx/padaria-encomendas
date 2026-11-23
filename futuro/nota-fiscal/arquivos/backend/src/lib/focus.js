// Cliente mínimo da API da Focus NFe (emissão de NFC-e).
// Docs: https://doc.focusnfe.com.br
//  - Autenticação: HTTP Basic, usuário = token, senha vazia.
//  - Homologação (testes, sem valor fiscal): https://homologacao.focusnfe.com.br
//  - Produção: https://api.focusnfe.com.br
//  - A emissão de NFC-e é síncrona: autoriza ou rejeita na mesma requisição.
//
// Dois tipos de token:
//  - FOCUS_TOKEN (do .env): token principal da SUA conta (dono do sistema),
//    usado para cadastrar as empresas (lojas) pela API de Empresas.
//  - token de cada loja (produção e homologação): devolvido no cadastro da
//    empresa e guardado em fiscal_secrets; é ele que emite as notas.
import { AppError } from './errors.js';

export const FOCUS_BASES = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};

export function createFocus({ masterToken = '', fetchImpl = globalThis.fetch, timeoutMs = 30_000, bases = FOCUS_BASES } = {}) {
  async function call(base, token, method, path, body) {
    if (!token) throw new AppError(409, 'FISCAL_NAO_CONFIGURADO', 'A emissão de nota fiscal desta loja ainda não foi configurada.');
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      const e = new AppError(502, 'FOCUS_INDISPONIVEL', 'Não foi possível falar com o emissor de notas (Focus NFe). Tente de novo em instantes.');
      e.retryable = true;
      throw e;
    }
    const json = await res.json().catch(() => ({}));
    return { httpStatus: res.status, json };
  }

  const message = (json, fallback) =>
    json?.mensagem_sefaz || json?.mensagem || json?.erros?.map((e) => e.mensagem).join(' ') || fallback;

  return {
    masterConfigured: Boolean(masterToken),
    absolute: (env, path) => (path ? (/^https?:/i.test(path) ? path : `${bases[env]}${path}`) : null),

    /** Cadastra (ou atualiza) a loja como empresa emitente na sua conta Focus. */
    async saveCompany(companyId, data) {
      if (!masterToken) {
        throw new AppError(503, 'FOCUS_SEM_TOKEN', 'O dono do sistema ainda não configurou a conta da Focus NFe (FOCUS_TOKEN no .env do servidor).');
      }
      const path = companyId ? `/v2/empresas/${encodeURIComponent(companyId)}` : '/v2/empresas';
      const { httpStatus, json } = await call(bases.producao, masterToken, companyId ? 'PUT' : 'POST', path, data);
      if (httpStatus >= 400) {
        throw new AppError(422, 'FOCUS_EMPRESA', `Focus NFe recusou o cadastro: ${message(json, `erro ${httpStatus}`)}`);
      }
      return {
        id: json.id != null ? String(json.id) : companyId,
        tokenProducao: json.token_producao ?? null,
        tokenHomologacao: json.token_homologacao ?? null,
        certValidUntil: json.certificado_valido_ate ?? null,
      };
    },

    /** Emite a NFC-e (síncrono). Devolve a resposta da Focus normalizada. */
    async emitNfce(env, token, ref, nfce) {
      const { httpStatus, json } = await call(bases[env], token, 'POST', `/v2/nfce?ref=${encodeURIComponent(ref)}`, nfce);
      return normalize(httpStatus, json, message);
    },

    async getNfce(env, token, ref) {
      const { httpStatus, json } = await call(bases[env], token, 'GET', `/v2/nfce/${encodeURIComponent(ref)}`);
      return normalize(httpStatus, json, message);
    },

    /** Cancela (a SEFAZ aceita só até 30 min depois da emissão). */
    async cancelNfce(env, token, ref, justificativa) {
      const { httpStatus, json } = await call(bases[env], token, 'DELETE', `/v2/nfce/${encodeURIComponent(ref)}`, { justificativa });
      return normalize(httpStatus, json, message);
    },
  };
}

function normalize(httpStatus, json, message) {
  return {
    httpStatus,
    status: json.status ?? (httpStatus >= 400 ? 'erro' : null), // autorizado | erro_autorizacao | denegado | cancelado | processando_autorizacao
    code: json.codigo ?? null,                                   // ex.: "nfe_nao_encontrada", "already_processed"
    sefazStatus: json.status_sefaz ?? null,
    message: message(json, httpStatus >= 400 ? `erro ${httpStatus}` : ''),
    chave: json.chave_nfe ?? null,
    numero: json.numero ?? null,
    serie: json.serie ?? null,
    danfe: json.caminho_danfe ?? null,
    xml: json.caminho_xml_nota_fiscal ?? null,
    qrcode: json.qrcode_url ?? null,
    consulta: json.url_consulta_nf ?? null,
  };
}
