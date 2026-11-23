-- =====================================================================
--  Migração 008: NOTA FISCAL (NFC-e) de cada pedido, emitida pela Focus NFe
--
--  Rode no SQL Editor do Supabase depois do 007. Pode rodar de novo.
--
--  * Cada loja configura os dados fiscais (Atendimento > Nota fiscal):
--    inscrição estadual, regime, endereço completo, CSC e certificado A1.
--  * Cada produto pode ter NCM, CFOP e CEST (o contador informa).
--  * O cliente pode informar "CPF na nota".
--  * A nota é emitida automaticamente quando o pedido é marcado como
--    ENTREGUE/RETIRADO (a loja pode trocar para "ao confirmar a encomenda"
--    ou "só manual") e fica registrada em fiscal_notes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Dados fiscais da loja
-- ---------------------------------------------------------------------
alter table public.establishments
  add column if not exists fiscal_enabled        boolean not null default false,
  add column if not exists fiscal_env            text    not null default 'homologacao',
  add column if not exists fiscal_emit_on        text    not null default 'entrega',
  add column if not exists inscricao_estadual    text,
  add column if not exists regime_tributario     smallint not null default 1,  -- 1 Simples, 2 Simples excesso, 3 Normal, 4 MEI
  add column if not exists razao_social          text,
  add column if not exists addr_street           text,
  add column if not exists addr_number           text,
  add column if not exists addr_district         text,
  add column if not exists addr_city             text,
  add column if not exists addr_uf               text,
  add column if not exists addr_zip              text,
  add column if not exists fiscal_cfop           text not null default '5101',  -- produção própria
  add column if not exists fiscal_csosn          text not null default '102',   -- Simples sem crédito
  add column if not exists fiscal_pis_cst        text not null default '49',
  add column if not exists fiscal_cofins_cst     text not null default '49',
  add column if not exists fiscal_ncm_default    text,
  add column if not exists fiscal_payment_form   text not null default '01',    -- 01 dinheiro
  add column if not exists fiscal_ibs_cbs        boolean not null default false,
  add column if not exists fiscal_ibs_cbs_cst    text,
  add column if not exists fiscal_cclasstrib     text,
  add column if not exists focus_company_id      text,
  add column if not exists fiscal_cert_valid_until timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'establishments_fiscal_env_chk') then
    alter table public.establishments add constraint establishments_fiscal_env_chk
      check (fiscal_env in ('homologacao','producao'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'establishments_fiscal_emit_on_chk') then
    alter table public.establishments add constraint establishments_fiscal_emit_on_chk
      check (fiscal_emit_on in ('pedido','entrega','manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'establishments_regime_chk') then
    alter table public.establishments add constraint establishments_regime_chk
      check (regime_tributario between 1 and 4);
  end if;
end $$;

-- Tokens da Focus NFe de cada loja: só o back-end lê
create table if not exists public.fiscal_secrets (
  establishment_id        uuid primary key references public.establishments(id) on delete cascade,
  focus_token_producao    text,
  focus_token_homologacao text,
  updated_at              timestamptz not null default now()
);
alter table public.fiscal_secrets enable row level security;   -- sem políticas
revoke all on public.fiscal_secrets from anon, authenticated;
grant all on public.fiscal_secrets to service_role;

-- ---------------------------------------------------------------------
-- 2. Dados fiscais dos produtos e CPF na nota
-- ---------------------------------------------------------------------
alter table public.products
  add column if not exists ncm  text,
  add column if not exists cfop text,
  add column if not exists cest text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_ncm_chk') then
    alter table public.products add constraint products_ncm_chk check (ncm is null or ncm ~ '^\d{8}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_cfop_chk') then
    alter table public.products add constraint products_cfop_chk check (cfop is null or cfop ~ '^\d{4}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_cest_chk') then
    alter table public.products add constraint products_cest_chk check (cest is null or cest ~ '^\d{7}$');
  end if;
end $$;

alter table public.orders add column if not exists customer_cpf text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_customer_cpf_chk') then
    alter table public.orders add constraint orders_customer_cpf_chk check (customer_cpf is null or customer_cpf ~ '^\d{11}$');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Notas emitidas (uma por pedido)
--    status: pendente | processando | autorizada | erro | cancelada | cancelamento_negado
-- ---------------------------------------------------------------------
create table if not exists public.fiscal_notes (
  id               bigint generated always as identity primary key,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  order_id         uuid not null unique references public.orders(id) on delete cascade,
  ref              text not null unique,             -- referência enviada à Focus
  env              text not null,                    -- homologacao | producao
  status           text not null default 'pendente',
  numero           text,
  serie            text,
  chave            text,
  danfe_url        text,
  xml_url          text,
  qrcode_url       text,
  consulta_url     text,
  sefaz_status     text,
  message          text,
  attempts         integer not null default 0,
  authorized_at    timestamptz,
  cancelled_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint fiscal_notes_status_chk check (status in ('pendente','processando','autorizada','erro','cancelada','cancelamento_negado'))
);
create index if not exists fiscal_notes_est_idx on public.fiscal_notes (establishment_id, created_at desc);

alter table public.fiscal_notes enable row level security;
drop policy if exists fiscal_notes_staff_read on public.fiscal_notes;
create policy fiscal_notes_staff_read on public.fiscal_notes for select to authenticated
  using (establishment_id = public.staff_establishment());
grant select on public.fiscal_notes to authenticated;
grant all on public.fiscal_notes to service_role;

-- O atendimento recebe a mudança da nota em tempo real
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'fiscal_notes') then
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      alter publication supabase_realtime add table public.fiscal_notes;
    end if;
  end if;
end $$;

-- Conferência
select name as loja, fiscal_enabled as nota_ligada, fiscal_env as ambiente from public.establishments order by created_at;
