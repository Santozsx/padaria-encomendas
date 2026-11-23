-- =====================================================================
--  ARQUIVO UNICO PARA INSTALACAO NOVA (schema + lojas + exemplos + horarios + licencas + aparencia)
--  Supabase > SQL Editor > New query > cole TUDO > Run
--  Pode rodar mais de uma vez sem duplicar nada.
--  Quem JA tem o banco instalado: rode so as migracoes que faltam
--  (004_estabelecimentos.sql, 006_horarios_30min.sql, 007_licencas.sql, 009_identidade_visual.sql)
-- =====================================================================

-- =====================================================================
--  PADARIA — SISTEMA DE ENCOMENDAS
--  Migração 001: schema, regras de negócio, segurança (RLS) e realtime
--
--  Como aplicar: Supabase Dashboard > SQL Editor > cole este arquivo > Run
--  (ou: supabase db push, se usar a Supabase CLI)
--
--  Princípios:
--   * Valores em CENTAVOS (inteiros) — nunca float para dinheiro.
--   * Preço e nome do produto são copiados (snapshot) para o item do pedido,
--     assim mudar o catálogo nunca altera pedidos antigos.
--   * Regras críticas (antecedência mínima, preço, transições de status)
--     são garantidas AQUI no banco, mesmo que alguém pule a API.
--   * Escrita só pelo back-end (service_role). Telas internas só LEEM
--     via RLS + Realtime, e só se o usuário for da equipe (staff).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tipos enumerados
-- ---------------------------------------------------------------------
do $$ begin
  create type public.order_status as enum ('recebido','em_producao','pronto','entregue','cancelado');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_status as enum ('pendente','em_producao','produzido');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.fulfillment_type as enum ('retirada','entrega');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.staff_role as enum ('admin','atendimento','cozinha');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 2. Configurações (linha única)
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  id                  smallint primary key default 1 check (id = 1),
  store_name          text not null default 'Padaria Bela Vista',
  timezone            text not null default 'America/Sao_Paulo',
  min_lead_days       int  not null default 1  check (min_lead_days between 1 and 30),
  max_lead_days       int  not null default 60,
  max_items_per_order int  not null default 40 check (max_items_per_order between 1 and 200),
  updated_at          timestamptz not null default now(),
  constraint lead_days_range check (max_lead_days >= min_lead_days)
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- "Hoje" no fuso da loja (não no fuso do servidor, que é UTC)
create or replace function public.app_today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone (select timezone from app_settings where id = 1))::date;
$$;

create or replace function public.min_delivery_date() returns date
language sql stable set search_path = public as $$
  select app_today() + (select min_lead_days from app_settings where id = 1);
$$;

-- ---------------------------------------------------------------------
-- 3. Catálogo
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id          bigint generated always as identity primary key,
  name        text not null unique check (char_length(btrim(name)) between 2 and 60),
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.products (
  id            bigint generated always as identity primary key,
  category_id   bigint not null references public.categories(id) on delete restrict,
  name          text not null check (char_length(btrim(name)) between 2 and 120),
  description   text not null default '' check (char_length(description) <= 500),
  price_cents   integer not null check (price_cents > 0 and price_cents <= 1000000), -- até R$ 10.000
  unit_label    text not null default 'un' check (char_length(unit_label) between 1 and 20),
  image_url     text check (image_url is null or image_url ~* '^https?://'),
  available     boolean not null default true,   -- aceitando encomendas agora?
  active        boolean not null default true,   -- false = arquivado (some do catálogo)
  min_quantity  integer not null default 1   check (min_quantity >= 1),
  max_quantity  integer not null default 200 check (max_quantity <= 1000),
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint qty_range check (max_quantity >= min_quantity)
);
create index if not exists products_category_idx on public.products (category_id) where active;

-- Faixas de horário para retirada/entrega (ex.: 07h–09h)
create table if not exists public.time_slots (
  id          bigint generated always as identity primary key,
  label       text not null unique,
  start_time  time not null,
  end_time    time not null,
  max_orders  integer check (max_orders is null or max_orders > 0), -- capacidade por data (null = sem limite)
  active      boolean not null default true,
  sort_order  int not null default 0,
  constraint slot_range check (end_time > start_time)
);

-- ---------------------------------------------------------------------
-- 4. Equipe (vinculada ao Supabase Auth)
-- ---------------------------------------------------------------------
create table if not exists public.staff_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  role        public.staff_role not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_profiles where user_id = auth.uid() and active);
$$;

-- ---------------------------------------------------------------------
-- 5. Pedidos
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id                     uuid primary key default gen_random_uuid(),
  code                   bigint generated always as identity (start with 1001) unique, -- nº legível
  customer_name          text not null check (char_length(btrim(customer_name)) between 2 and 100),
  customer_phone         text not null check (customer_phone ~ '^[0-9]{10,13}$'),       -- só dígitos
  fulfillment            public.fulfillment_type not null,
  delivery_address       text check (delivery_address is null or char_length(delivery_address) <= 300),
  delivery_date          date not null,
  time_slot_id           bigint not null references public.time_slots(id),
  time_slot_label        text not null,  -- snapshot
  slot_start             time not null,  -- snapshot (ordenação por urgência)
  notes                  text not null default '' check (char_length(notes) <= 500),
  status                 public.order_status not null default 'recebido',
  total_cents            bigint not null default 0 check (total_cents >= 0),
  cancel_reason          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  production_started_at  timestamptz,
  ready_at               timestamptz,
  delivered_at           timestamptz,
  cancelled_at           timestamptz,
  constraint address_required_for_delivery check (
    fulfillment = 'retirada'
    or (delivery_address is not null and char_length(btrim(delivery_address)) >= 5)
  )
);
create index if not exists orders_schedule_idx on public.orders (delivery_date, slot_start);
create index if not exists orders_status_idx   on public.orders (status);
create index if not exists orders_created_idx  on public.orders (created_at);
create index if not exists orders_phone_idx    on public.orders (customer_phone);

create table if not exists public.order_items (
  id                bigint generated always as identity primary key,
  order_id          uuid not null references public.orders(id) on delete cascade,
  product_id        bigint not null references public.products(id) on delete restrict,
  product_name      text not null,      -- snapshot
  unit_label        text not null,      -- snapshot
  unit_price_cents  integer not null check (unit_price_cents > 0), -- snapshot
  quantity          integer not null check (quantity between 1 and 1000),
  subtotal_cents    bigint generated always as (unit_price_cents::bigint * quantity) stored,
  notes             text not null default '' check (char_length(notes) <= 200),
  status            public.item_status not null default 'pendente',
  produced_at       timestamptz,
  updated_at        timestamptz not null default now()
);
create index if not exists order_items_order_idx   on public.order_items (order_id);
create index if not exists order_items_product_idx on public.order_items (product_id);

-- Histórico / auditoria (quem mudou o quê e quando)
create table if not exists public.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  item_id     bigint references public.order_items(id) on delete cascade,
  event_type  text not null check (event_type in ('criado','status','item_status')),
  from_value  text,
  to_value    text,
  actor_id    uuid,
  actor_name  text,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events (order_id, created_at);

-- ---------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------

-- 6.1 updated_at automático
create or replace function public.trg_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists set_updated_at on public.products;
create trigger set_updated_at before update on public.products
  for each row execute function public.trg_set_updated_at();
drop trigger if exists set_updated_at on public.orders;
create trigger set_updated_at before update on public.orders
  for each row execute function public.trg_set_updated_at();
drop trigger if exists set_updated_at on public.order_items;
create trigger set_updated_at before update on public.order_items
  for each row execute function public.trg_set_updated_at();

-- Helpers para ler quem está agindo (definido pelas funções RPC abaixo)
create or replace function public.ctx(p_key text) returns text
language sql stable as $$
  select nullif(current_setting('app.' || p_key, true), '');
$$;

-- 6.2 Pedido: antecedência mínima + máquina de estados + carimbos de horário
create or replace function public.trg_orders_rules() returns trigger
language plpgsql set search_path = public as $$
declare
  s app_settings;
  v_min date;
  v_active order_status[] := array['recebido','em_producao','pronto']::order_status[];
begin
  select * into s from app_settings where id = 1;

  -- (a) data de entrega: valida na criação e quando a data é alterada
  if tg_op = 'INSERT' or new.delivery_date is distinct from old.delivery_date then
    v_min := app_today() + s.min_lead_days;
    if new.delivery_date < v_min then
      raise exception using errcode = 'P0001', message = 'DATA_ANTECEDENCIA',
        hint = format('A data mínima para encomendas é %s.', to_char(v_min, 'DD/MM/YYYY'));
    end if;
    if new.delivery_date > app_today() + s.max_lead_days then
      raise exception using errcode = 'P0001', message = 'DATA_MUITO_DISTANTE',
        hint = format('Aceitamos encomendas com até %s dias de antecedência.', s.max_lead_days);
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'recebido';
    return new;
  end if;

  -- (b) transições de status permitidas
  if new.status is distinct from old.status then
    if not (
         (old.status = any(v_active) and new.status = any(v_active))      -- vai e volta na produção
      or (old.status = 'pronto' and new.status = 'entregue')
      or (old.status = any(v_active) and new.status = 'cancelado')
    ) then
      raise exception using errcode = 'P0001', message = 'TRANSICAO_INVALIDA',
        hint = format('Não é possível mudar de "%s" para "%s".', old.status, new.status);
    end if;

    case new.status
      when 'em_producao' then new.production_started_at := coalesce(old.production_started_at, now());
                              new.ready_at := null;
      when 'pronto'      then new.ready_at := now();
                              new.production_started_at := coalesce(old.production_started_at, now());
      when 'recebido'    then new.ready_at := null; new.production_started_at := null;
      when 'entregue'    then new.delivered_at := now();
      when 'cancelado'   then new.cancelled_at := now();
    end case;
  end if;
  return new;
end $$;

drop trigger if exists orders_rules on public.orders;
create trigger orders_rules before insert or update on public.orders
  for each row execute function public.trg_orders_rules();

-- 6.3 Pedido: registra eventos (criação e mudança de status)
create or replace function public.trg_orders_log() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into order_events (order_id, event_type, to_value, note)
    values (new.id, 'criado', new.status::text, 'Pedido recebido');
  elsif new.status is distinct from old.status then
    insert into order_events (order_id, event_type, from_value, to_value, actor_id, actor_name, note)
    values (new.id, 'status', old.status::text, new.status::text,
            ctx('actor_id')::uuid, ctx('actor_name'), ctx('note'));
  end if;
  return null;
end $$;

drop trigger if exists orders_log on public.orders;
create trigger orders_log after insert or update of status on public.orders
  for each row execute function public.trg_orders_log();

-- 6.4 Item: bloqueia mudanças em pedido encerrado e carimba produced_at
create or replace function public.trg_items_rules() returns trigger
language plpgsql set search_path = public as $$
declare v_status order_status;
begin
  if new.status is distinct from old.status then
    select status into v_status from orders where id = new.order_id;
    if v_status in ('entregue','cancelado') then
      raise exception using errcode = 'P0001', message = 'PEDIDO_ENCERRADO',
        hint = 'Este pedido já foi entregue ou cancelado.';
    end if;
    new.produced_at := case when new.status = 'produzido' then now() else null end;
  end if;
  return new;
end $$;

drop trigger if exists items_rules on public.order_items;
create trigger items_rules before update on public.order_items
  for each row execute function public.trg_items_rules();

-- 6.5 Status do pedido derivado dos itens
create or replace function public.recalc_order_status(p_order_id uuid) returns void
language plpgsql set search_path = public as $$
declare
  v_status order_status;
  v_total int; v_done int; v_started int;
  v_new order_status;
begin
  select status into v_status from orders where id = p_order_id for update;
  if v_status is null or v_status in ('entregue','cancelado') then return; end if;

  select count(*),
         count(*) filter (where status = 'produzido'),
         count(*) filter (where status <> 'pendente')
    into v_total, v_done, v_started
    from order_items where order_id = p_order_id;

  v_new := case
             when v_total > 0 and v_done = v_total then 'pronto'
             when v_started > 0                    then 'em_producao'
             else                                       'recebido'
           end;
  if v_new <> v_status then
    update orders set status = v_new where id = p_order_id;
  end if;
end $$;

create or replace function public.trg_items_after() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into order_events (order_id, item_id, event_type, from_value, to_value, actor_id, actor_name)
    values (new.order_id, new.id, 'item_status', old.status::text, new.status::text,
            ctx('actor_id')::uuid, ctx('actor_name'));
    if coalesce(ctx('skip_recalc'), 'off') <> 'on' then
      perform recalc_order_status(new.order_id);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists items_after on public.order_items;
create trigger items_after after update of status on public.order_items
  for each row execute function public.trg_items_after();

-- ---------------------------------------------------------------------
-- 7. Funções RPC (chamadas SOMENTE pelo back-end com service_role)
-- ---------------------------------------------------------------------

-- Pedido completo em JSON (pedido + itens)
create or replace function public.order_json(p_id uuid) returns jsonb
language sql stable set search_path = public as $$
  select to_jsonb(o) || jsonb_build_object(
           'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.id)
                                from order_items i where i.order_id = o.id), '[]'::jsonb))
    from orders o where o.id = p_id;
$$;

-- Cria o pedido de forma ATÔMICA. Preços vêm SEMPRE da tabela products.
-- Payload: { customer_name, customer_phone, fulfillment, delivery_address?,
--            delivery_date, time_slot_id, notes?, expected_total_cents?,
--            items: [{ product_id, quantity, notes? }] }
create or replace function public.create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s        app_settings;
  v_slot   time_slots;
  v_prod   products;
  v_order  orders;
  v_item   jsonb;
  v_qty    int;
  v_total  bigint := 0;
  v_count  int;
  v_seen   bigint[] := '{}';
  v_date   date := (p->>'delivery_date')::date;
begin
  select * into s from app_settings where id = 1;

  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception using errcode = 'P0001', message = 'ITENS_VAZIOS', hint = 'Adicione pelo menos um produto.';
  end if;
  if jsonb_array_length(p->'items') > s.max_items_per_order then
    raise exception using errcode = 'P0001', message = 'ITENS_DEMAIS',
      hint = format('Máximo de %s produtos diferentes por pedido.', s.max_items_per_order);
  end if;

  select * into v_slot from time_slots where id = (p->>'time_slot_id')::bigint and active;
  if not found then
    raise exception using errcode = 'P0001', message = 'HORARIO_INVALIDO', hint = 'Escolha uma faixa de horário válida.';
  end if;

  -- capacidade da faixa (lock evita dois pedidos simultâneos estourarem o limite)
  if v_slot.max_orders is not null then
    perform pg_advisory_xact_lock(hashtextextended('slot:' || v_slot.id || ':' || v_date, 0));
    select count(*) into v_count from orders
     where delivery_date = v_date and time_slot_id = v_slot.id and status <> 'cancelado';
    if v_count >= v_slot.max_orders then
      raise exception using errcode = 'P0001', message = 'HORARIO_LOTADO',
        hint = format('A faixa %s já está lotada para %s. Escolha outro horário.', v_slot.label, to_char(v_date, 'DD/MM'));
    end if;
  end if;

  if p->>'fulfillment' = 'entrega' and char_length(btrim(coalesce(p->>'delivery_address', ''))) < 5 then
    raise exception using errcode = 'P0001', message = 'ENDERECO_OBRIGATORIO', hint = 'Informe o endereço completo para entrega.';
  end if;

  insert into orders (customer_name, customer_phone, fulfillment, delivery_address, delivery_date,
                      time_slot_id, time_slot_label, slot_start, notes)
  values (btrim(p->>'customer_name'),
          p->>'customer_phone',
          (p->>'fulfillment')::fulfillment_type,
          case when p->>'fulfillment' = 'entrega' then nullif(btrim(coalesce(p->>'delivery_address','')), '') end,
          v_date, v_slot.id, v_slot.label, v_slot.start_time,
          coalesce(btrim(p->>'notes'), ''))
  returning * into v_order;

  for v_item in select value from jsonb_array_elements(p->'items') loop
    select * into v_prod from products
     where id = (v_item->>'product_id')::bigint and active and available;
    if not found then
      raise exception using errcode = 'P0001', message = 'PRODUTO_INDISPONIVEL',
        hint = 'Um dos produtos do carrinho não está mais disponível. Atualize a página.';
    end if;
    if v_prod.id = any(v_seen) then
      raise exception using errcode = 'P0001', message = 'PRODUTO_DUPLICADO', hint = 'Produto repetido no pedido.';
    end if;
    v_seen := v_seen || v_prod.id;

    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < v_prod.min_quantity or v_qty > v_prod.max_quantity then
      raise exception using errcode = 'P0001', message = 'QUANTIDADE_INVALIDA',
        hint = format('A quantidade de "%s" deve ficar entre %s e %s.', v_prod.name, v_prod.min_quantity, v_prod.max_quantity);
    end if;

    insert into order_items (order_id, product_id, product_name, unit_label, unit_price_cents, quantity, notes)
    values (v_order.id, v_prod.id, v_prod.name, v_prod.unit_label, v_prod.price_cents, v_qty,
            left(coalesce(btrim(v_item->>'notes'), ''), 200));
    v_total := v_total + v_prod.price_cents::bigint * v_qty;
  end loop;

  -- Se o cliente viu um total diferente (preço mudou), recusa e pede para revisar
  if p ? 'expected_total_cents' and (p->>'expected_total_cents')::bigint <> v_total then
    raise exception using errcode = 'P0001', message = 'PRECO_ALTERADO',
      hint = 'Os preços foram atualizados. Revise o carrinho antes de confirmar.';
  end if;

  update orders set total_cents = v_total where id = v_order.id;
  return order_json(v_order.id);
end $$;

-- Muda o status do pedido inteiro (atendimento / cozinha)
create or replace function public.set_order_status(
  p_order_id uuid, p_status order_status,
  p_actor_id uuid default null, p_actor_name text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order orders;
begin
  perform set_config('app.actor_id',   coalesce(p_actor_id::text, ''), true);
  perform set_config('app.actor_name', coalesce(p_actor_name, ''),     true);
  perform set_config('app.note',       coalesce(p_note, ''),           true);

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PEDIDO_NAO_ENCONTRADO', hint = 'Pedido não encontrado.';
  end if;
  if v_order.status = p_status then return order_json(p_order_id); end if;

  -- mantém os itens coerentes com o novo status do pedido (sem recálculo em cascata)
  if v_order.status in ('recebido','em_producao','pronto') and p_status in ('recebido','em_producao','pronto') then
    perform set_config('app.skip_recalc', 'on', true);
    update order_items set status = case p_status
                                      when 'pronto'      then 'produzido'::item_status
                                      when 'em_producao' then 'em_producao'::item_status
                                      else 'pendente'::item_status end
     where order_id = p_order_id;
    perform set_config('app.skip_recalc', 'off', true);
  end if;

  update orders
     set status = p_status,
         cancel_reason = case when p_status = 'cancelado' then nullif(btrim(p_note), '') else cancel_reason end
   where id = p_order_id;

  return order_json(p_order_id);
end $$;

-- Muda o status de UM item (cozinha marca o que já produziu)
create or replace function public.set_item_status(
  p_item_id bigint, p_status item_status,
  p_actor_id uuid default null, p_actor_name text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order_id uuid;
begin
  perform set_config('app.actor_id',   coalesce(p_actor_id::text, ''), true);
  perform set_config('app.actor_name', coalesce(p_actor_name, ''),     true);

  update order_items set status = p_status where id = p_item_id returning order_id into v_order_id;
  if v_order_id is null then
    raise exception using errcode = 'P0001', message = 'ITEM_NAO_ENCONTRADO', hint = 'Item não encontrado.';
  end if;
  return order_json(v_order_id);
end $$;

-- Resumo consolidado de produção (quanto de cada produto para a data/faixa)
create or replace function public.production_summary(p_date date, p_slot_id bigint default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(t order by t.pending_qty desc, t.product_name), '[]'::jsonb) from (
    select i.product_id,
           max(i.product_name)                                              as product_name,
           max(i.unit_label)                                                as unit_label,
           sum(i.quantity)::int                                             as total_qty,
           coalesce(sum(i.quantity) filter (where i.status = 'produzido'), 0)::int   as produced_qty,
           coalesce(sum(i.quantity) filter (where i.status = 'em_producao'), 0)::int as in_progress_qty,
           coalesce(sum(i.quantity) filter (where i.status = 'pendente'), 0)::int    as pending_qty,
           count(distinct o.id)::int                                        as orders_count,
           coalesce(jsonb_agg(distinct i.notes) filter (where i.notes <> ''), '[]'::jsonb) as notes
      from order_items i
      join orders o on o.id = i.order_id
     where o.delivery_date = p_date
       and o.status <> 'cancelado'
       and (p_slot_id is null or o.time_slot_id = p_slot_id)
     group by i.product_id
  ) t;
$$;

-- Relatório de vendas
--  p_date_field: 'entrega' (data de entrega) ou 'pedido' (data em que foi feito)
--  Faturamento ignora cancelados. Com filtro de produto, os valores consideram
--  apenas as linhas daquele produto.
create or replace function public.sales_report(
  p_from date, p_to date,
  p_date_field text default 'entrega',
  p_statuses order_status[] default null,
  p_fulfillment fulfillment_type default null,
  p_product_id bigint default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := (select timezone from app_settings where id = 1);
  v_result jsonb;
begin
  if p_to < p_from then
    raise exception using errcode = 'P0001', message = 'PERIODO_INVALIDO', hint = 'A data final deve ser maior ou igual à inicial.';
  end if;
  if p_to - p_from > 366 then
    raise exception using errcode = 'P0001', message = 'PERIODO_LONGO', hint = 'O período máximo do relatório é de 1 ano.';
  end if;

  with base as (
    select o.*,
           case when p_date_field = 'pedido' then (o.created_at at time zone v_tz)::date
                else o.delivery_date end as ref_date
      from orders o
  ), filtered as (
    select * from base b
     where b.ref_date between p_from and p_to
       and (p_statuses   is null or b.status = any(p_statuses))
       and (p_fulfillment is null or b.fulfillment = p_fulfillment)
       and (p_product_id is null or exists (select 1 from order_items i
                                             where i.order_id = b.id and i.product_id = p_product_id))
  ), valid as (
    select * from filtered where status <> 'cancelado'
  ), lines as (
    select i.*, v.ref_date, v.status as order_status
      from order_items i join valid v on v.id = i.order_id
     where p_product_id is null or i.product_id = p_product_id
  ), totals as (
    select (select count(*) from valid)                                         as orders_count,
           (select count(*) from filtered where status = 'cancelado')           as cancelled_count,
           (select coalesce(sum(subtotal_cents), 0) from lines)                 as revenue_cents,
           (select coalesce(sum(subtotal_cents), 0) from lines where order_status = 'entregue') as delivered_revenue_cents,
           (select coalesce(sum(quantity), 0) from lines)                       as items_qty
  )
  select jsonb_build_object(
    'filters', jsonb_build_object('from', p_from, 'to', p_to, 'date_field', p_date_field,
                                  'statuses', p_statuses, 'fulfillment', p_fulfillment, 'product_id', p_product_id),
    'summary', (select jsonb_build_object(
                  'orders_count', orders_count,
                  'cancelled_count', cancelled_count,
                  'revenue_cents', revenue_cents,
                  'delivered_revenue_cents', delivered_revenue_cents,
                  'items_qty', items_qty,
                  'avg_ticket_cents', case when orders_count > 0 then round(revenue_cents::numeric / orders_count) else 0 end)
                from totals),
    'by_status', coalesce((select jsonb_object_agg(status, n)
                             from (select status, count(*) n from filtered group by status) x), '{}'::jsonb),
    'by_fulfillment', coalesce((select jsonb_object_agg(fulfillment, n)
                             from (select fulfillment, count(*) n from valid group by fulfillment) x), '{}'::jsonb),
    'top_products', coalesce((select jsonb_agg(x order by x.quantity desc, x.revenue_cents desc)
                                from (select product_id, max(product_name) as product_name,
                                             sum(quantity)::int as quantity, sum(subtotal_cents) as revenue_cents
                                        from lines group by product_id
                                        order by sum(quantity) desc limit 20) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(x order by x.day)
                          from (select l.ref_date as day,
                                       count(distinct l.order_id)::int as orders_count,
                                       sum(l.subtotal_cents) as revenue_cents
                                  from lines l group by l.ref_date) x), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', f.id, 'code', f.code, 'created_at', f.created_at,
                          'delivery_date', f.delivery_date, 'time_slot_label', f.time_slot_label,
                          'customer_name', f.customer_name, 'customer_phone', f.customer_phone,
                          'fulfillment', f.fulfillment, 'status', f.status, 'total_cents', f.total_cents)
                          order by f.ref_date, f.slot_start, f.code)
                          from (select * from filtered order by ref_date, slot_start, code limit 2000) f), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- 8. Permissões
--    O Supabase concede EXECUTE em funções novas para anon/authenticated
--    por padrão. As RPCs de escrita ficam restritas ao service_role.
-- ---------------------------------------------------------------------
revoke execute on function public.create_order(jsonb)                                      from public, anon, authenticated;
revoke execute on function public.set_order_status(uuid, order_status, uuid, text, text)   from public, anon, authenticated;
revoke execute on function public.set_item_status(bigint, item_status, uuid, text)         from public, anon, authenticated;
revoke execute on function public.production_summary(date, bigint)                         from public, anon, authenticated;
revoke execute on function public.sales_report(date, date, text, order_status[], fulfillment_type, bigint) from public, anon, authenticated;
revoke execute on function public.recalc_order_status(uuid)                                from public, anon, authenticated;
revoke execute on function public.order_json(uuid)                                         from public, anon, authenticated;

grant execute on function public.create_order(jsonb)                                      to service_role;
grant execute on function public.set_order_status(uuid, order_status, uuid, text, text)   to service_role;
grant execute on function public.set_item_status(bigint, item_status, uuid, text)         to service_role;
grant execute on function public.production_summary(date, bigint)                         to service_role;
grant execute on function public.sales_report(date, date, text, order_status[], fulfillment_type, bigint) to service_role;
grant execute on function public.recalc_order_status(uuid)                                to service_role;
grant execute on function public.order_json(uuid)                                         to service_role;

-- ---------------------------------------------------------------------
-- 9. Row Level Security
--    service_role (back-end) ignora RLS. Não há políticas de escrita:
--    ninguém escreve direto pelo navegador.
-- ---------------------------------------------------------------------
-- Permissões explícitas (projetos novos do Supabase podem não conceder
-- acesso automático às tabelas). service_role = back-end; navegador só lê,
-- e a RLS abaixo decide QUAIS linhas cada um vê.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;
grant execute on function public.is_staff()          to anon, authenticated, service_role;
grant execute on function public.app_today()         to anon, authenticated, service_role;
grant execute on function public.min_delivery_date() to anon, authenticated, service_role;

-- defesa em profundidade: navegador nunca escreve direto nas tabelas
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

alter table public.app_settings   enable row level security;
alter table public.categories     enable row level security;
alter table public.products       enable row level security;
alter table public.time_slots     enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.orders         enable row level security;
alter table public.order_items    enable row level security;
alter table public.order_events   enable row level security;

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to anon, authenticated using (true);

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to anon, authenticated using (active or public.is_staff());

drop policy if exists products_read on public.products;
create policy products_read on public.products for select to anon, authenticated using (active or public.is_staff());

drop policy if exists slots_read on public.time_slots;
create policy slots_read on public.time_slots for select to anon, authenticated using (active or public.is_staff());

drop policy if exists staff_self_read on public.staff_profiles;
create policy staff_self_read on public.staff_profiles for select to authenticated using (user_id = auth.uid());

-- Pedidos: somente equipe pode ler (é isso que libera o Realtime para as telas internas)
drop policy if exists orders_staff_read on public.orders;
create policy orders_staff_read on public.orders for select to authenticated using (public.is_staff());

drop policy if exists items_staff_read on public.order_items;
create policy items_staff_read on public.order_items for select to authenticated using (public.is_staff());

drop policy if exists events_staff_read on public.order_events;
create policy events_staff_read on public.order_events for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------
-- 10. Realtime: publica mudanças de pedidos, itens e produtos
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['orders','order_items','products'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- =====================================================================
--  Migração 004: VÁRIOS ESTABELECIMENTOS (multi-loja) com isolamento
--
--  O que muda:
--   * Nova tabela `establishments` (nome, CNPJ/CPF, endereço, telefone,
--     link próprio, fuso e regras de antecedência de cada loja).
--   * Todas as tabelas de negócio ganham `establishment_id`.
--   * Cada funcionário (staff_profiles) pertence a UM estabelecimento e
--     só enxerga dados dele (regras no banco + RLS + API).
--   * Numeração de pedidos é por loja (#1001, #1002... em cada uma).
--   * `platform_admins`: o dono do sistema, que cadastra estabelecimentos.
--   * Dados que já existem vão para a "Padaria Bela Vista".
--
--  Pode rodar mais de uma vez (idempotente).
--  Supabase > SQL Editor > New query > cole TUDO > Run
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Estabelecimentos e dono do sistema
-- ---------------------------------------------------------------------
create table if not exists public.establishments (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,                 -- usado no link: /loja/<slug>
  name                text not null,
  doc_type            text,                                  -- 'cnpj' | 'cpf'
  doc_number          text,                                  -- só dígitos
  address             text,
  phone               text,                                  -- só dígitos
  timezone            text not null default 'America/Sao_Paulo',
  min_lead_days       int  not null default 1,
  max_lead_days       int  not null default 60,
  max_items_per_order int  not null default 40,
  next_order_code     bigint not null default 1001,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint est_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  constraint est_name_len   check (char_length(btrim(name)) between 2 and 120),
  constraint est_doc_type   check (doc_type is null or doc_type in ('cnpj', 'cpf')),
  constraint est_doc_pair   check ((doc_type is null) = (doc_number is null)),
  constraint est_doc_len    check (doc_type is null
                                   or (doc_type = 'cpf'  and doc_number ~ '^[0-9]{11}$')
                                   or (doc_type = 'cnpj' and doc_number ~ '^[0-9]{14}$')),
  constraint est_address    check (address is null or char_length(address) <= 300),
  constraint est_phone      check (phone is null or phone ~ '^[0-9]{10,13}$'),
  constraint est_lead       check (min_lead_days between 1 and 30 and max_lead_days >= min_lead_days),
  constraint est_items      check (max_items_per_order between 1 and 200)
);
create unique index if not exists establishments_doc_uk on public.establishments (doc_number) where doc_number is not null;

drop trigger if exists set_updated_at on public.establishments;
create trigger set_updated_at before update on public.establishments
  for each row execute function public.trg_set_updated_at();

create table if not exists public.platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Primeiro estabelecimento = configuração atual da loja
insert into public.establishments (slug, name, timezone, min_lead_days, max_lead_days, max_items_per_order)
select 'padaria-bela-vista', s.store_name, s.timezone, s.min_lead_days, s.max_lead_days, s.max_items_per_order
  from public.app_settings s where s.id = 1
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- 2. establishment_id em todas as tabelas (dados atuais → Bela Vista)
-- ---------------------------------------------------------------------
do $$
declare
  v_est uuid := (select id from public.establishments where slug = 'padaria-bela-vista');
  t text;
begin
  foreach t in array array['categories','products','time_slots','orders','staff_profiles'] loop
    execute format('alter table public.%I add column if not exists establishment_id uuid references public.establishments(id) on delete restrict', t);
    execute format('update public.%I set establishment_id = $1 where establishment_id is null', t) using v_est;
    execute format('alter table public.%I alter column establishment_id set not null', t);
  end loop;

  -- itens e eventos herdam a loja do pedido
  alter table public.order_items  add column if not exists establishment_id uuid references public.establishments(id) on delete restrict;
  alter table public.order_events add column if not exists establishment_id uuid references public.establishments(id) on delete restrict;
  update public.order_items i  set establishment_id = o.establishment_id from public.orders o where o.id = i.order_id and i.establishment_id is null;
  update public.order_events e set establishment_id = o.establishment_id from public.orders o where o.id = e.order_id and e.establishment_id is null;
  alter table public.order_items  alter column establishment_id set not null;
  alter table public.order_events alter column establishment_id set not null;
end $$;

-- Nomes únicos POR LOJA (antes eram únicos no sistema todo)
alter table public.categories drop constraint if exists categories_name_key;
alter table public.time_slots drop constraint if exists time_slots_label_key;
create unique index if not exists categories_est_name_uk on public.categories (establishment_id, name);
create unique index if not exists time_slots_est_label_uk on public.time_slots (establishment_id, label);

-- Número do pedido POR LOJA
do $$ begin
  alter table public.orders alter column code drop identity if exists;
exception when others then null; end $$;
alter table public.orders drop constraint if exists orders_code_key;
create unique index if not exists orders_est_code_uk on public.orders (establishment_id, code);
update public.establishments e
   set next_order_code = greatest(e.next_order_code, coalesce((select max(o.code) + 1 from public.orders o where o.establishment_id = e.id), 1001));

create index if not exists products_est_idx       on public.products (establishment_id) where active;
create index if not exists categories_est_idx     on public.categories (establishment_id);
create index if not exists time_slots_est_idx     on public.time_slots (establishment_id);
create index if not exists orders_est_sched_idx   on public.orders (establishment_id, delivery_date, slot_start);
create index if not exists orders_est_created_idx on public.orders (establishment_id, created_at);
create index if not exists order_items_est_idx    on public.order_items (establishment_id);
create index if not exists order_events_est_idx   on public.order_events (establishment_id);
create index if not exists staff_est_idx          on public.staff_profiles (establishment_id);

-- ---------------------------------------------------------------------
-- 3. Funções auxiliares
-- ---------------------------------------------------------------------
-- "Hoje" no fuso de uma loja
create or replace function public.est_today(p_est uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone timezone)::date from establishments where id = p_est;
$$;

-- Loja do usuário logado (null se não for da equipe ou estiver desativado)
create or replace function public.staff_establishment() returns uuid
language sql stable security definer set search_path = public as $$
  select sp.establishment_id
    from staff_profiles sp join establishments e on e.id = sp.establishment_id
   where sp.user_id = auth.uid() and sp.active and e.active;
$$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;

-- Itens e eventos sempre recebem a loja do pedido (ninguém consegue "misturar")
create or replace function public.trg_fill_establishment() returns trigger
language plpgsql set search_path = public as $$
begin
  select establishment_id into new.establishment_id from orders where id = new.order_id;
  return new;
end $$;

drop trigger if exists fill_establishment on public.order_items;
create trigger fill_establishment before insert or update of order_id on public.order_items
  for each row execute function public.trg_fill_establishment();
drop trigger if exists fill_establishment on public.order_events;
create trigger fill_establishment before insert on public.order_events
  for each row execute function public.trg_fill_establishment();

-- Pedido não muda de loja; produto/horário do pedido precisam ser da mesma loja
create or replace function public.trg_same_establishment() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'orders' then
    if tg_op = 'UPDATE' and new.establishment_id is distinct from old.establishment_id then
      raise exception using errcode = 'P0001', message = 'LOJA_IMUTAVEL', hint = 'Um pedido não pode mudar de estabelecimento.';
    end if;
    if not exists (select 1 from time_slots where id = new.time_slot_id and establishment_id = new.establishment_id) then
      raise exception using errcode = 'P0001', message = 'HORARIO_INVALIDO', hint = 'Faixa de horário de outro estabelecimento.';
    end if;
  elsif tg_table_name = 'order_items' then
    if not exists (select 1 from products where id = new.product_id and establishment_id = new.establishment_id) then
      raise exception using errcode = 'P0001', message = 'PRODUTO_INDISPONIVEL', hint = 'Produto de outro estabelecimento.';
    end if;
  elsif tg_table_name = 'products' then
    if not exists (select 1 from categories where id = new.category_id and establishment_id = new.establishment_id) then
      raise exception using errcode = 'P0001', message = 'CATEGORIA_INVALIDA', hint = 'Categoria de outro estabelecimento.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists same_establishment on public.orders;
create trigger same_establishment before insert or update of establishment_id, time_slot_id on public.orders
  for each row execute function public.trg_same_establishment();
drop trigger if exists same_establishment on public.order_items;
create trigger same_establishment after insert or update of product_id on public.order_items
  for each row execute function public.trg_same_establishment();
drop trigger if exists same_establishment on public.products;
create trigger same_establishment before insert or update of category_id, establishment_id on public.products
  for each row execute function public.trg_same_establishment();

-- Regras do pedido agora usam as configurações DA LOJA
create or replace function public.trg_orders_rules() returns trigger
language plpgsql set search_path = public as $$
declare
  e establishments;
  v_today date;
  v_min date;
  v_active order_status[] := array['recebido','em_producao','pronto']::order_status[];
begin
  select * into e from establishments where id = new.establishment_id;
  v_today := (now() at time zone e.timezone)::date;

  if tg_op = 'INSERT' or new.delivery_date is distinct from old.delivery_date then
    v_min := v_today + e.min_lead_days;
    if new.delivery_date < v_min then
      raise exception using errcode = 'P0001', message = 'DATA_ANTECEDENCIA',
        hint = format('A data mínima para encomendas é %s.', to_char(v_min, 'DD/MM/YYYY'));
    end if;
    if new.delivery_date > v_today + e.max_lead_days then
      raise exception using errcode = 'P0001', message = 'DATA_MUITO_DISTANTE',
        hint = format('Aceitamos encomendas com até %s dias de antecedência.', e.max_lead_days);
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'recebido';
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = any(v_active) and new.status = any(v_active))
      or (old.status = 'pronto' and new.status = 'entregue')
      or (old.status = any(v_active) and new.status = 'cancelado')
    ) then
      raise exception using errcode = 'P0001', message = 'TRANSICAO_INVALIDA',
        hint = format('Não é possível mudar de "%s" para "%s".', old.status, new.status);
    end if;
    case new.status
      when 'em_producao' then new.production_started_at := coalesce(old.production_started_at, now()); new.ready_at := null;
      when 'pronto'      then new.ready_at := now(); new.production_started_at := coalesce(old.production_started_at, now());
      when 'recebido'    then new.ready_at := null; new.production_started_at := null;
      when 'entregue'    then new.delivered_at := now();
      when 'cancelado'   then new.cancelled_at := now();
    end case;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 4. Funções RPC (back-end) com o estabelecimento obrigatório
-- ---------------------------------------------------------------------
drop function if exists public.set_order_status(uuid, order_status, uuid, text, text);
drop function if exists public.set_item_status(bigint, item_status, uuid, text);
drop function if exists public.production_summary(date, bigint);
drop function if exists public.sales_report(date, date, text, order_status[], fulfillment_type, bigint);

-- Payload igual ao anterior + establishment_id (definido pelo SERVIDOR a partir do link da loja)
create or replace function public.create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e        establishments;
  v_slot   time_slots;
  v_prod   products;
  v_order  orders;
  v_item   jsonb;
  v_qty    int;
  v_total  bigint := 0;
  v_count  int;
  v_code   bigint;
  v_seen   bigint[] := '{}';
  v_date   date := (p->>'delivery_date')::date;
begin
  select * into e from establishments where id = (p->>'establishment_id')::uuid and active;
  if not found then
    raise exception using errcode = 'P0001', message = 'LOJA_INDISPONIVEL', hint = 'Este estabelecimento não está aceitando encomendas.';
  end if;

  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception using errcode = 'P0001', message = 'ITENS_VAZIOS', hint = 'Adicione pelo menos um produto.';
  end if;
  if jsonb_array_length(p->'items') > e.max_items_per_order then
    raise exception using errcode = 'P0001', message = 'ITENS_DEMAIS',
      hint = format('Máximo de %s produtos diferentes por pedido.', e.max_items_per_order);
  end if;

  select * into v_slot from time_slots where id = (p->>'time_slot_id')::bigint and establishment_id = e.id and active;
  if not found then
    raise exception using errcode = 'P0001', message = 'HORARIO_INVALIDO', hint = 'Escolha uma faixa de horário válida.';
  end if;

  if v_slot.max_orders is not null then
    perform pg_advisory_xact_lock(hashtextextended('slot:' || v_slot.id || ':' || v_date, 0));
    select count(*) into v_count from orders
     where establishment_id = e.id and delivery_date = v_date and time_slot_id = v_slot.id and status <> 'cancelado';
    if v_count >= v_slot.max_orders then
      raise exception using errcode = 'P0001', message = 'HORARIO_LOTADO',
        hint = format('A faixa %s já está lotada para %s. Escolha outro horário.', v_slot.label, to_char(v_date, 'DD/MM'));
    end if;
  end if;

  if p->>'fulfillment' = 'entrega' and char_length(btrim(coalesce(p->>'delivery_address', ''))) < 5 then
    raise exception using errcode = 'P0001', message = 'ENDERECO_OBRIGATORIO', hint = 'Informe o endereço completo para entrega.';
  end if;

  -- próximo número da loja (a linha da loja fica travada até o fim da transação)
  update establishments set next_order_code = next_order_code + 1 where id = e.id
  returning next_order_code - 1 into v_code;

  insert into orders (establishment_id, code, customer_name, customer_phone, fulfillment, delivery_address, delivery_date,
                      time_slot_id, time_slot_label, slot_start, notes)
  values (e.id, v_code, btrim(p->>'customer_name'), p->>'customer_phone', (p->>'fulfillment')::fulfillment_type,
          case when p->>'fulfillment' = 'entrega' then nullif(btrim(coalesce(p->>'delivery_address','')), '') end,
          v_date, v_slot.id, v_slot.label, v_slot.start_time, coalesce(btrim(p->>'notes'), ''))
  returning * into v_order;

  for v_item in select value from jsonb_array_elements(p->'items') loop
    select * into v_prod from products
     where id = (v_item->>'product_id')::bigint and establishment_id = e.id and active and available;
    if not found then
      raise exception using errcode = 'P0001', message = 'PRODUTO_INDISPONIVEL',
        hint = 'Um dos produtos do carrinho não está mais disponível. Atualize a página.';
    end if;
    if v_prod.id = any(v_seen) then
      raise exception using errcode = 'P0001', message = 'PRODUTO_DUPLICADO', hint = 'Produto repetido no pedido.';
    end if;
    v_seen := v_seen || v_prod.id;

    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < v_prod.min_quantity or v_qty > v_prod.max_quantity then
      raise exception using errcode = 'P0001', message = 'QUANTIDADE_INVALIDA',
        hint = format('A quantidade de "%s" deve ficar entre %s e %s.', v_prod.name, v_prod.min_quantity, v_prod.max_quantity);
    end if;

    insert into order_items (order_id, product_id, product_name, unit_label, unit_price_cents, quantity, notes)
    values (v_order.id, v_prod.id, v_prod.name, v_prod.unit_label, v_prod.price_cents, v_qty,
            left(coalesce(btrim(v_item->>'notes'), ''), 200));
    v_total := v_total + v_prod.price_cents::bigint * v_qty;
  end loop;

  if p ? 'expected_total_cents' and (p->>'expected_total_cents')::bigint <> v_total then
    raise exception using errcode = 'P0001', message = 'PRECO_ALTERADO',
      hint = 'Os preços foram atualizados. Revise o carrinho antes de confirmar.';
  end if;

  update orders set total_cents = v_total where id = v_order.id;
  return order_json(v_order.id);
end $$;

create or replace function public.set_order_status(
  p_establishment_id uuid, p_order_id uuid, p_status order_status,
  p_actor_id uuid default null, p_actor_name text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order orders;
begin
  perform set_config('app.actor_id',   coalesce(p_actor_id::text, ''), true);
  perform set_config('app.actor_name', coalesce(p_actor_name, ''),     true);
  perform set_config('app.note',       coalesce(p_note, ''),           true);

  select * into v_order from orders where id = p_order_id and establishment_id = p_establishment_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PEDIDO_NAO_ENCONTRADO', hint = 'Pedido não encontrado.';
  end if;
  if v_order.status = p_status then return order_json(p_order_id); end if;

  if v_order.status in ('recebido','em_producao','pronto') and p_status in ('recebido','em_producao','pronto') then
    perform set_config('app.skip_recalc', 'on', true);
    update order_items set status = case p_status
                                      when 'pronto'      then 'produzido'::item_status
                                      when 'em_producao' then 'em_producao'::item_status
                                      else 'pendente'::item_status end
     where order_id = p_order_id;
    perform set_config('app.skip_recalc', 'off', true);
  end if;

  update orders
     set status = p_status,
         cancel_reason = case when p_status = 'cancelado' then nullif(btrim(p_note), '') else cancel_reason end
   where id = p_order_id;
  return order_json(p_order_id);
end $$;

create or replace function public.set_item_status(
  p_establishment_id uuid, p_item_id bigint, p_status item_status,
  p_actor_id uuid default null, p_actor_name text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order_id uuid;
begin
  perform set_config('app.actor_id',   coalesce(p_actor_id::text, ''), true);
  perform set_config('app.actor_name', coalesce(p_actor_name, ''),     true);
  update order_items set status = p_status
   where id = p_item_id and establishment_id = p_establishment_id
  returning order_id into v_order_id;
  if v_order_id is null then
    raise exception using errcode = 'P0001', message = 'ITEM_NAO_ENCONTRADO', hint = 'Item não encontrado.';
  end if;
  return order_json(v_order_id);
end $$;

create or replace function public.production_summary(p_establishment_id uuid, p_date date, p_slot_id bigint default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(t order by t.pending_qty desc, t.product_name), '[]'::jsonb) from (
    select i.product_id,
           max(i.product_name)                                                        as product_name,
           max(i.unit_label)                                                          as unit_label,
           sum(i.quantity)::int                                                       as total_qty,
           coalesce(sum(i.quantity) filter (where i.status = 'produzido'), 0)::int    as produced_qty,
           coalesce(sum(i.quantity) filter (where i.status = 'em_producao'), 0)::int  as in_progress_qty,
           coalesce(sum(i.quantity) filter (where i.status = 'pendente'), 0)::int     as pending_qty,
           count(distinct o.id)::int                                                  as orders_count,
           coalesce(jsonb_agg(distinct i.notes) filter (where i.notes <> ''), '[]'::jsonb) as notes
      from order_items i
      join orders o on o.id = i.order_id
     where o.establishment_id = p_establishment_id
       and o.delivery_date = p_date
       and o.status <> 'cancelado'
       and (p_slot_id is null or o.time_slot_id = p_slot_id)
     group by i.product_id
  ) t;
$$;

create or replace function public.sales_report(
  p_establishment_id uuid,
  p_from date, p_to date,
  p_date_field text default 'entrega',
  p_statuses order_status[] default null,
  p_fulfillment fulfillment_type default null,
  p_product_id bigint default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := (select timezone from establishments where id = p_establishment_id);
  v_result jsonb;
begin
  if v_tz is null then
    raise exception using errcode = 'P0001', message = 'LOJA_INDISPONIVEL', hint = 'Estabelecimento não encontrado.';
  end if;
  if p_to < p_from then
    raise exception using errcode = 'P0001', message = 'PERIODO_INVALIDO', hint = 'A data final deve ser maior ou igual à inicial.';
  end if;
  if p_to - p_from > 366 then
    raise exception using errcode = 'P0001', message = 'PERIODO_LONGO', hint = 'O período máximo do relatório é de 1 ano.';
  end if;

  with base as (
    select o.*,
           case when p_date_field = 'pedido' then (o.created_at at time zone v_tz)::date else o.delivery_date end as ref_date
      from orders o
     where o.establishment_id = p_establishment_id
  ), filtered as (
    select * from base b
     where b.ref_date between p_from and p_to
       and (p_statuses   is null or b.status = any(p_statuses))
       and (p_fulfillment is null or b.fulfillment = p_fulfillment)
       and (p_product_id is null or exists (select 1 from order_items i where i.order_id = b.id and i.product_id = p_product_id))
  ), valid as (
    select * from filtered where status <> 'cancelado'
  ), lines as (
    select i.*, v.ref_date, v.status as order_status
      from order_items i join valid v on v.id = i.order_id
     where p_product_id is null or i.product_id = p_product_id
  ), totals as (
    select (select count(*) from valid)                                                   as orders_count,
           (select count(*) from filtered where status = 'cancelado')                     as cancelled_count,
           (select coalesce(sum(subtotal_cents), 0) from lines)                           as revenue_cents,
           (select coalesce(sum(subtotal_cents), 0) from lines where order_status = 'entregue') as delivered_revenue_cents,
           (select coalesce(sum(quantity), 0) from lines)                                 as items_qty
  )
  select jsonb_build_object(
    'filters', jsonb_build_object('from', p_from, 'to', p_to, 'date_field', p_date_field,
                                  'statuses', p_statuses, 'fulfillment', p_fulfillment, 'product_id', p_product_id),
    'summary', (select jsonb_build_object(
                  'orders_count', orders_count, 'cancelled_count', cancelled_count,
                  'revenue_cents', revenue_cents, 'delivered_revenue_cents', delivered_revenue_cents,
                  'items_qty', items_qty,
                  'avg_ticket_cents', case when orders_count > 0 then round(revenue_cents::numeric / orders_count) else 0 end)
                from totals),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from filtered group by status) x), '{}'::jsonb),
    'by_fulfillment', coalesce((select jsonb_object_agg(fulfillment, n) from (select fulfillment, count(*) n from valid group by fulfillment) x), '{}'::jsonb),
    'top_products', coalesce((select jsonb_agg(x order by x.quantity desc, x.revenue_cents desc)
                                from (select product_id, max(product_name) as product_name,
                                             sum(quantity)::int as quantity, sum(subtotal_cents) as revenue_cents
                                        from lines group by product_id order by sum(quantity) desc limit 20) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(x order by x.day)
                          from (select l.ref_date as day, count(distinct l.order_id)::int as orders_count, sum(l.subtotal_cents) as revenue_cents
                                  from lines l group by l.ref_date) x), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', f.id, 'code', f.code, 'created_at', f.created_at,
                          'delivery_date', f.delivery_date, 'time_slot_label', f.time_slot_label,
                          'customer_name', f.customer_name, 'customer_phone', f.customer_phone,
                          'fulfillment', f.fulfillment, 'status', f.status, 'total_cents', f.total_cents)
                          order by f.ref_date, f.slot_start, f.code)
                          from (select * from filtered order by ref_date, slot_start, code limit 2000) f), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- 5. Permissões
-- ---------------------------------------------------------------------
grant all on public.establishments, public.platform_admins to service_role;
revoke all on public.establishments, public.platform_admins from anon, authenticated;

revoke execute on function public.create_order(jsonb)                                                 from public, anon, authenticated;
revoke execute on function public.set_order_status(uuid, uuid, order_status, uuid, text, text)          from public, anon, authenticated;
revoke execute on function public.set_item_status(uuid, bigint, item_status, uuid, text)                from public, anon, authenticated;
revoke execute on function public.production_summary(uuid, date, bigint)                              from public, anon, authenticated;
revoke execute on function public.sales_report(uuid, date, date, text, order_status[], fulfillment_type, bigint) from public, anon, authenticated;
revoke execute on function public.est_today(uuid)                                                     from public, anon;
revoke execute on function public.trg_fill_establishment()                                            from public, anon, authenticated;
revoke execute on function public.trg_same_establishment()                                            from public, anon, authenticated;

grant execute on function public.create_order(jsonb)                                                  to service_role;
grant execute on function public.set_order_status(uuid, uuid, order_status, uuid, text, text)           to service_role;
grant execute on function public.set_item_status(uuid, bigint, item_status, uuid, text)                 to service_role;
grant execute on function public.production_summary(uuid, date, bigint)                               to service_role;
grant execute on function public.sales_report(uuid, date, date, text, order_status[], fulfillment_type, bigint) to service_role;
grant execute on function public.est_today(uuid)                                                      to authenticated, service_role;
grant execute on function public.staff_establishment()                                                to anon, authenticated, service_role;
grant execute on function public.is_platform_admin()                                                  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. RLS: cada funcionário só enxerga a PRÓPRIA loja (vale para o Realtime)
-- ---------------------------------------------------------------------
alter table public.establishments  enable row level security;   -- sem políticas: só o back-end lê
alter table public.platform_admins enable row level security;   -- sem políticas: só o back-end lê

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to anon, authenticated
  using (active or establishment_id = public.staff_establishment());

drop policy if exists products_read on public.products;
create policy products_read on public.products for select to anon, authenticated
  using (active or establishment_id = public.staff_establishment());

drop policy if exists slots_read on public.time_slots;
create policy slots_read on public.time_slots for select to anon, authenticated
  using (active or establishment_id = public.staff_establishment());

drop policy if exists orders_staff_read on public.orders;
create policy orders_staff_read on public.orders for select to authenticated
  using (establishment_id = public.staff_establishment());

drop policy if exists items_staff_read on public.order_items;
create policy items_staff_read on public.order_items for select to authenticated
  using (establishment_id = public.staff_establishment());

drop policy if exists events_staff_read on public.order_events;
create policy events_staff_read on public.order_events for select to authenticated
  using (establishment_id = public.staff_establishment());

-- ---------------------------------------------------------------------
-- 7. Dono do sistema
--    Depois de rodar este arquivo, defina quem é o dono do sistema
--    (pode cadastrar estabelecimentos). Troque o e-mail e rode:
--
-- insert into public.platform_admins (user_id)
-- select id from auth.users where email = 'SEU-EMAIL@exemplo.com'
-- on conflict do nothing;
--
--    (ou use a opção "Definir dono do sistema" do iniciar.bat)
-- ---------------------------------------------------------------------

-- =====================================================================
--  Migração 005 (opcional): cardápio e horários de EXEMPLO para a
--  "Padaria Bela Vista". Use só em instalação nova. Pode editar à vontade.
--  Requer a 004 (estabelecimentos) já aplicada.
-- =====================================================================
do $$
declare v_est uuid := (select id from public.establishments where slug = 'padaria-bela-vista');
begin
  if v_est is null then return; end if;

  insert into public.categories (establishment_id, name, sort_order)
  select v_est, c.name, c.ord from (values ('Pães',1),('Bolos',2),('Salgados',3),('Doces',4),('Tortas',5)) c(name, ord)
   where not exists (select 1 from public.categories x where x.establishment_id = v_est and x.name = c.name);

  insert into public.time_slots (establishment_id, label, start_time, end_time, max_orders, sort_order)
  select v_est, s.label, s.st::time, s.en::time, s.mx, s.ord
    from (values ('07h – 09h','07:00','09:00',30,1), ('09h – 12h','09:00','12:00',30,2),
                 ('12h – 15h','12:00','15:00',25,3), ('15h – 18h','15:00','18:00',25,4)) s(label, st, en, mx, ord)
   where not exists (select 1 from public.time_slots x where x.establishment_id = v_est and x.label = s.label);

  insert into public.products (establishment_id, category_id, name, description, price_cents, unit_label, min_quantity, max_quantity, sort_order)
  select v_est, c.id, p.name, p.description, p.price_cents, p.unit_label, p.min_q, p.max_q, p.sort_order
    from (values
      ('Pães',     'Pão francês',                  'Crocante por fora, macio por dentro.',            90,   'un',    10, 500, 1),
      ('Pães',     'Pão de forma integral',        'Fatiado, 500 g, com grãos.',                      1490, 'un',    1,  30,  2),
      ('Pães',     'Baguete tradicional',          'Fermentação natural, 60 cm.',                     1200, 'un',    1,  40,  3),
      ('Bolos',    'Bolo de cenoura c/ chocolate', 'Forma redonda, serve 12 fatias.',                 5900, 'un',    1,  10,  1),
      ('Bolos',    'Bolo de aniversário (kg)',     'Massa branca ou chocolate. Recheio a combinar nas observações.', 8900, 'kg', 1, 15, 2),
      ('Salgados', 'Coxinha de frango (cento)',    'Mini coxinhas para festa.',                       9500, 'cento', 1,  20,  1),
      ('Salgados', 'Esfiha de carne',              'Esfiha aberta tradicional.',                      650,  'un',    6,  300, 2),
      ('Doces',    'Brigadeiro gourmet (cento)',   'Chocolate belga, forminha inclusa.',              14000,'cento', 1,  10,  1),
      ('Doces',    'Sonho de creme',               'Recheio de creme de baunilha.',                   790,  'un',    1,  100, 2),
      ('Tortas',   'Torta de frango',              'Forma retangular, serve 10 pessoas.',             7900, 'un',    1,  10,  1)
    ) as p(category, name, description, price_cents, unit_label, min_q, max_q, sort_order)
    join public.categories c on c.establishment_id = v_est and c.name = p.category
   where not exists (select 1 from public.products x where x.establishment_id = v_est and x.name = p.name)
   order by c.sort_order, p.sort_order;
end $$;

-- =====================================================================
--  Migração 006: horários de retirada/entrega de 30 em 30 minutos
--  (07:00, 07:30, 08:00 ... 17:30, 18:00) em todas as lojas.
--
--  Rode no SQL Editor do Supabase depois do 004. Pode rodar de novo
--  sem duplicar nada.
--
--  Os horários antigos (07h – 09h, 09h – 12h...) ficam DESATIVADOS, não
--  apagados: os pedidos que já existem continuam mostrando o horário que
--  o cliente escolheu.
-- =====================================================================
do $$
declare
  e record;
  t time;
  i int;
begin
  for e in select id from public.establishments loop
    -- só converte a loja uma vez (se já tem o 07:00, foi convertida)
    if not exists (select 1 from public.time_slots where establishment_id = e.id and label = '07:00') then
      update public.time_slots set active = false where establishment_id = e.id;
      i := 1;
      t := time '07:00';
      loop
        insert into public.time_slots (establishment_id, label, start_time, end_time, max_orders, sort_order, active)
        values (e.id, to_char(t, 'HH24:MI'), t, t + interval '30 minutes', null, i, true)
        on conflict (establishment_id, label) do update set active = true, sort_order = excluded.sort_order;
        exit when t >= time '18:00';
        t := t + interval '30 minutes';
        i := i + 1;
      end loop;
    end if;
  end loop;
end $$;

-- Conferência: deve listar 07:00, 07:30 ... 18:00 (23 horários por loja)
select e.name as loja, count(*) as horarios, string_agg(s.label, ' ' order by s.sort_order) as lista
  from public.time_slots s
  join public.establishments e on e.id = s.establishment_id
 where s.active
 group by e.name;

-- =====================================================================
--  Migração 007: LICENÇAS (SaaS) — assinatura mensal por estabelecimento
--
--  Rode no SQL Editor do Supabase depois do 004 e do 006.
--  Pode rodar de novo sem estragar nada.
--
--  Como funciona:
--   * Existe UM plano (nome, preço, dias de teste, dias de tolerância),
--     editável pelo dono do sistema no Painel.
--   * Toda loja nova ganha o teste grátis. Depois, precisa da assinatura
--     paga (cobrança recorrente pelo Asaas). Cada pagamento confirmado
--     estende a licença por 1 mês.
--   * Licença vencida + tolerância = loja BLOQUEADA: não recebe pedidos
--     e a equipe só consegue abrir a tela de assinatura.
--   * Mudança de valor: o dono pode mudar o preço do plano (e aplicar às
--     assinaturas atuais) ou dar um preço especial para uma loja.
--   * "Cortesia": loja liberada sem cobrança (ex.: a sua própria loja).
--     As lojas que já existem viram cortesia para nada parar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Plano (uma linha só)
-- ---------------------------------------------------------------------
create table if not exists public.saas_plan (
  id           boolean primary key default true check (id),
  name         text    not null default 'Plano Padaria',
  price_cents  integer not null default 9990 check (price_cents >= 500),
  trial_days   integer not null default 14   check (trial_days between 0 and 90),
  grace_days   integer not null default 3    check (grace_days between 0 and 30),
  updated_at   timestamptz not null default now()
);
insert into public.saas_plan (id) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Licença da loja
-- ---------------------------------------------------------------------
-- license_mode nasce 'cortesia' só para as lojas que JÁ existem;
-- logo abaixo o padrão vira 'assinatura' para as novas.
alter table public.establishments
  add column if not exists license_mode          text not null default 'cortesia',
  add column if not exists trial_ends_at         timestamptz,
  add column if not exists paid_until            timestamptz,
  add column if not exists billing_email         text,
  add column if not exists asaas_customer_id     text,
  add column if not exists asaas_subscription_id text,
  add column if not exists subscription_status   text not null default 'sem_assinatura',
  -- preço especial desta loja (null = preço do plano). Ex.: desconto.
  add column if not exists custom_price_cents    integer;
alter table public.establishments alter column license_mode set default 'assinatura';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'establishments_license_mode_chk') then
    alter table public.establishments add constraint establishments_license_mode_chk
      check (license_mode in ('assinatura','cortesia'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'establishments_custom_price_chk') then
    alter table public.establishments add constraint establishments_custom_price_chk
      check (custom_price_cents is null or custom_price_cents >= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'establishments_subscription_status_chk') then
    alter table public.establishments add constraint establishments_subscription_status_chk
      check (subscription_status in ('sem_assinatura','ativa','cancelada'));
  end if;
end $$;

-- Loja nova: começa o teste grátis no cadastro
create or replace function public.trg_establishment_trial() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.license_mode = 'assinatura' and new.trial_ends_at is null then
    new.trial_ends_at := now() + make_interval(days => (select trial_days from saas_plan limit 1));
  end if;
  return new;
end $$;
drop trigger if exists establishment_trial on public.establishments;
create trigger establishment_trial before insert on public.establishments
  for each row execute function public.trg_establishment_trial();

-- Situação da licença (a mesma regra existe no servidor, em lib/license.js):
--   cortesia | teste | ativa | atrasada (venceu, mas está na tolerância) | bloqueada
create or replace function public.license_state(p_est uuid) returns text
language sql stable security definer set search_path = public as $$
  with e as (
    select license_mode, trial_ends_at, paid_until,
           greatest(coalesce(paid_until, '-infinity'::timestamptz), coalesce(trial_ends_at, '-infinity'::timestamptz)) as valid_until
      from establishments where id = p_est
  ), p as (select grace_days from saas_plan limit 1)
  select case
           when e.license_mode = 'cortesia' then 'cortesia'
           when now() <= e.valid_until and e.paid_until is not null and now() <= e.paid_until then 'ativa'
           when now() <= e.valid_until then 'teste'
           when now() <= e.valid_until + make_interval(days => p.grace_days) then 'atrasada'
           else 'bloqueada'
         end
    from e, p;
$$;

-- ---------------------------------------------------------------------
-- 3. Cobranças da assinatura (histórico, vindo do Asaas)
-- ---------------------------------------------------------------------
create table if not exists public.license_payments (
  id                bigint generated always as identity primary key,
  establishment_id  uuid not null references public.establishments(id) on delete cascade,
  asaas_payment_id  text not null unique,
  value_cents       integer not null,
  status            text not null,          -- PENDING, RECEIVED, CONFIRMED, OVERDUE, REFUNDED...
  billing_type      text,                   -- PIX, BOLETO, CREDIT_CARD, UNDEFINED
  due_date          date not null,
  paid_at           timestamptz,
  invoice_url       text,
  credited          boolean not null default false,  -- já estendeu a licença?
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists license_payments_est_idx on public.license_payments (establishment_id, due_date desc);
alter table public.license_payments enable row level security;  -- sem políticas: só o back-end
alter table public.saas_plan        enable row level security;  -- sem políticas: só o back-end
revoke all on public.license_payments, public.saas_plan from anon, authenticated;
grant all on public.license_payments, public.saas_plan to service_role;

-- Registra/atualiza uma cobrança. Pagamento confirmado estende a licença
-- por 1 mês a partir do vencimento (uma vez só por cobrança).
create or replace function public.register_license_payment(
  p_establishment_id uuid, p_asaas_payment_id text, p_value_cents integer, p_status text,
  p_billing_type text, p_due_date date, p_paid_at timestamptz, p_invoice_url text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v license_payments;
  v_tz text;
  v_until timestamptz;
begin
  insert into license_payments (establishment_id, asaas_payment_id, value_cents, status, billing_type, due_date, paid_at, invoice_url)
  values (p_establishment_id, p_asaas_payment_id, p_value_cents, p_status, p_billing_type, p_due_date, p_paid_at, p_invoice_url)
  on conflict (asaas_payment_id) do update
     set status = excluded.status, value_cents = excluded.value_cents, billing_type = excluded.billing_type,
         due_date = excluded.due_date, paid_at = coalesce(excluded.paid_at, license_payments.paid_at),
         invoice_url = coalesce(excluded.invoice_url, license_payments.invoice_url), updated_at = now()
   where license_payments.establishment_id = p_establishment_id
  returning * into v;
  if v.id is null then
    raise exception using errcode = 'P0001', message = 'COBRANCA_DE_OUTRA_LOJA', hint = 'Cobrança não pertence a esta loja.';
  end if;

  if p_status in ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') and not v.credited then
    select timezone into v_tz from establishments where id = p_establishment_id;
    -- vale até o fim do dia do vencimento + 1 mês, no fuso da loja
    v_until := ((p_due_date + interval '1 month')::date + 1)::timestamp at time zone v_tz;
    update establishments set paid_until = greatest(coalesce(paid_until, v_until), v_until)
     where id = p_establishment_id;
    update license_payments set credited = true where id = v.id;
    v.credited := true;
  end if;
  return to_jsonb(v);
end $$;

-- ---------------------------------------------------------------------
-- 4. Loja bloqueada não recebe pedido (vale mesmo se alguém pular a API)
-- ---------------------------------------------------------------------
create or replace function public.trg_orders_license() returns trigger
language plpgsql set search_path = public as $$
begin
  if license_state(new.establishment_id) = 'bloqueada' then
    raise exception using errcode = 'P0001', message = 'LICENCA_VENCIDA',
      hint = 'Esta loja está temporariamente indisponível para encomendas.';
  end if;
  return new;
end $$;
drop trigger if exists orders_license on public.orders;
create trigger orders_license before insert on public.orders
  for each row execute function public.trg_orders_license();

-- ---------------------------------------------------------------------
-- 5. Permissões
-- ---------------------------------------------------------------------
revoke execute on function public.license_state(uuid) from public, anon, authenticated;
revoke execute on function public.register_license_payment(uuid, text, integer, text, text, date, timestamptz, text) from public, anon, authenticated;
grant  execute on function public.license_state(uuid) to service_role;
grant  execute on function public.register_license_payment(uuid, text, integer, text, text, date, timestamptz, text) to service_role;

-- Conferência
select name as loja, license_mode as modo, public.license_state(id) as situacao from public.establishments order by created_at;

-- =====================================================================
--  Migração 009: IDENTIDADE VISUAL de cada loja (cores + logo)
--
--  Rode no SQL Editor do Supabase (depois das anteriores).
--  Pode rodar de novo sem estragar nada.
--
--  * brand_color   = cor principal (botões, destaques, links)
--  * brand_color_2 = cor secundária (menu lateral do atendimento e detalhes)
--  * A logo fica numa tabela separada (a imagem em base64), para não pesar
--    nas consultas da loja. O sistema serve a imagem em
--    /api/public/logos/<link-da-loja>.
--  Sem cores/logo, a loja continua com o visual padrão do sistema.
-- =====================================================================

alter table public.establishments
  add column if not exists brand_color      text,
  add column if not exists brand_color_2    text,
  add column if not exists logo_updated_at  timestamptz;

do $$ begin
  alter table public.establishments
    add constraint establishments_brand_color_chk   check (brand_color   is null or brand_color   ~ '^#[0-9A-F]{6}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.establishments
    add constraint establishments_brand_color_2_chk check (brand_color_2 is null or brand_color_2 ~ '^#[0-9A-F]{6}$');
exception when duplicate_object then null; end $$;

create table if not exists public.establishment_logos (
  establishment_id uuid primary key references public.establishments (id) on delete cascade,
  mime             text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  data_base64      text not null check (length(data_base64) <= 720000),  -- ~512 KB
  updated_at       timestamptz not null default now()
);

-- Só o back-end (service_role) mexe na logo; o público recebe pela API.
alter table public.establishment_logos enable row level security;
revoke all on public.establishment_logos from anon, authenticated;
grant all on public.establishment_logos to service_role;

-- Conferência
select id, name, brand_color, brand_color_2, logo_updated_at from public.establishments order by name;
