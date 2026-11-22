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
