// Último middleware: transforma qualquer erro em JSON padronizado
// e nunca vaza detalhes internos (stack, SQL) para o cliente.

export function notFound(req, res) {
  res.status(404).json({ error: { code: 'ROTA_NAO_ENCONTRADA', message: `Rota ${req.method} ${req.path} não existe.` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'JSON_INVALIDO', message: 'Corpo da requisição não é um JSON válido.' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_GRANDE', message: 'Requisição muito grande.' } });
  }

  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err.cause || err);
  }
  res.status(status).json({
    error: {
      code: err.code || 'ERRO_INTERNO',
      message: status >= 500 && !err.code ? 'Erro interno. Tente novamente em instantes.' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

/** Envolve handlers async para que erros caiam no errorHandler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
