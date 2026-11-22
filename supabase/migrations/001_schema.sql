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
