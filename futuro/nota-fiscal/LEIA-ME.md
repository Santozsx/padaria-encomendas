# Nota fiscal (NFC-e) — guardada para o futuro

Esta pasta guarda o módulo de **nota fiscal ao consumidor (NFC-e) pela Focus NFe**.
Ele foi feito, testado com uma Focus simulada e depois **retirado do sistema**,
porque o volume de encomendas ainda é baixo. Nada daqui roda hoje: o servidor e as
telas não leem esta pasta.

## O que o módulo faz (quando reativado)

- Emite a NFC-e automaticamente quando o pedido é marcado como **Entregue/Retirado**
  (dá para trocar para "ao confirmar a encomenda" ou "só manual").
- Aba **Nota fiscal** no Atendimento: dados da empresa, endereço, tributação padrão
  (CFOP, CSOSN, PIS/COFINS), certificado A1, CSC, ambiente teste/produção, IBS/CBS.
- Campos **NCM, CFOP e CEST** em cada produto.
- No detalhe do pedido: número da nota, link do DANFE, consulta na SEFAZ,
  "Tentar de novo" quando dá erro e cancelamento (até 30 min após a emissão).
- **CPF na nota** (opcional) no checkout do cliente e link "Ver nota fiscal" na
  página de acompanhamento.

## O que tem aqui

| Item | Para que serve |
|---|---|
| `nota-fiscal.patch` | Todas as mudanças de uma vez. É o jeito mais rápido de reativar. |
| `arquivos/` | Cópia completa de cada arquivo na versão **com** nota fiscal, nas mesmas pastas do projeto. Serve de consulta se o patch não encaixar mais. |

Arquivos novos do módulo (estão em `arquivos/`):

- `backend/src/lib/focus.js` — conversa com a API da Focus NFe
- `backend/src/services/fiscal.service.js` — monta a nota, emite, cancela, consulta
- `backend/test/fiscal.test.js` — testes automáticos
- `supabase/migrations/008_notas_fiscais.sql` — tabelas e colunas do banco

Os outros 19 arquivos em `arquivos/` são versões alteradas de arquivos que já existem
no projeto (rotas, telas, `schemas.js`, `banco_completo.sql` etc.).

## Como reativar

1. Abra um terminal na pasta `padaria` do projeto e teste se o patch ainda encaixa:

   ```
   git apply --check futuro/nota-fiscal/nota-fiscal.patch
   ```

   Se não aparecer nenhuma mensagem, está tudo certo. Aplique:

   ```
   git apply futuro/nota-fiscal/nota-fiscal.patch
   ```

   Se der erro (porque o projeto mudou muito desde então), use os arquivos de
   `arquivos/` como referência, ou peça ao Claude para reaplicar o módulo a partir
   desta pasta.

2. Rode os testes: `cd backend` e depois `npm test`.
3. No Supabase, rode `supabase/migrations/008_notas_fiscais.sql` (SQL Editor).
4. Crie a conta na Focus NFe e coloque o token principal no `backend\.env`:
   `FOCUS_TOKEN=...` (opção 6 do `iniciar.bat`). Reinicie o servidor.
5. Em **Atendimento → Nota fiscal**, preencha os dados, ligue a emissão e
   **comece em Homologação** (teste, sem valor fiscal). Informe o NCM dos produtos.
   Quando as notas de teste saírem certas, troque para **Produção**.

## O que a padaria vai precisar

- CNPJ com inscrição estadual (CPF não emite NFC-e).
- Certificado digital **A1** (arquivo .pfx) com o CNPJ da empresa.
- Credenciamento como emissor de NFC-e na SEFAZ e o **CSC** (código de segurança).
- O **contador** confirmando regime tributário, CFOP, CSOSN e NCM de cada produto.

## Observações

- O certificado e o CSC são repassados direto para a Focus; o sistema não os guarda.
- O token da Focus fica só no `.env` do servidor, nunca no navegador nem no GitHub.
- Se o `008_notas_fiscais.sql` já tiver sido rodado no Supabase, não tem problema:
  as tabelas e colunas extras ficam paradas e o sistema funciona normalmente sem elas.
