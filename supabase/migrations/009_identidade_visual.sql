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
