// Erros de negócio padronizados: { error: { code, message, details? } }

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Códigos levantados pelas funções SQL (raise exception using message = 'CODIGO')
const DB_CODES = {
  DATA_ANTECEDENCIA: 422,
  DATA_MUITO_DISTANTE: 422,
  ENDERECO_OBRIGATORIO: 422,
  ITENS_VAZIOS: 422,
  ITENS_DEMAIS: 422,
  HORARIO_INVALIDO: 422,
  HORARIO_LOTADO: 409,
  PRODUTO_INDISPONIVEL: 409,
  PRODUTO_DUPLICADO: 422,
  QUANTIDADE_INVALIDA: 422,
  PRECO_ALTERADO: 409,
  PEDIDO_NAO_ENCONTRADO: 404,
  ITEM_NAO_ENCONTRADO: 404,
  TRANSICAO_INVALIDA: 409,
  PEDIDO_ENCERRADO: 409,
  PERIODO_INVALIDO: 422,
  PERIODO_LONGO: 422,
  LOJA_INDISPONIVEL: 409,
  LOJA_IMUTAVEL: 409,
  CATEGORIA_INVALIDA: 422,
  LICENCA_VENCIDA: 402,
  COBRANCA_DE_OUTRA_LOJA: 409,
};

/** Converte um erro do Supabase/PostgREST em AppError amigável. */
export function fromDbError(err) {
  if (!err) return null;
  const code = err.message?.trim();
  if (code && DB_CODES[code]) {
    return new AppError(DB_CODES[code], code, err.hint || 'Não foi possível concluir a operação.');
  }
  if (err.code === '23514' || err.code === '22P02' || err.code === '23502') {
    return new AppError(422, 'DADOS_INVALIDOS', 'Alguns dados enviados são inválidos.');
  }
  if (err.code === '23505') {
    return new AppError(409, 'DUPLICADO', 'Já existe um registro com esses dados.');
  }
  if (err.code === '23503') {
    return new AppError(409, 'REFERENCIA_INVALIDA', 'Registro relacionado não encontrado ou em uso.');
  }
  if (err.code === 'PGRST116') {
    return new AppError(404, 'NAO_ENCONTRADO', 'Registro não encontrado.');
  }
  const e = new AppError(502, 'ERRO_BANCO', 'Falha ao acessar o banco de dados. Tente novamente.');
  e.cause = err;
  return e;
}

/** Lança se o Supabase devolveu erro; senão devolve data. */
export function unwrap({ data, error }) {
  if (error) throw fromDbError(error);
  return data;
}
