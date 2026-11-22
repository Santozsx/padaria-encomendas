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
