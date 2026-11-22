-- =====================================================================
--  Migração 003: permissões explícitas nas tabelas
--
--  Projetos novos do Supabase podem NÃO conceder acesso automático às
--  tabelas do schema public. Sem isto o back-end recebe
--  "permission denied for table ..." (aparece como "Falha ao acessar o
--  banco de dados"). Pode rodar quantas vezes quiser.
-- =====================================================================
grant usage on schema public to anon, authenticated, service_role;

-- back-end (service_role): acesso completo
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- navegador (anon/authenticated): SOMENTE leitura.
-- Quem pode ver cada linha continua sendo decidido pela RLS
-- (pedidos: só a equipe logada; catálogo: itens ativos).
grant select on all tables in schema public to anon, authenticated;
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

-- funções usadas pelas políticas de RLS
grant execute on function public.is_staff()          to anon, authenticated, service_role;
grant execute on function public.app_today()         to anon, authenticated, service_role;
grant execute on function public.min_delivery_date() to anon, authenticated, service_role;
