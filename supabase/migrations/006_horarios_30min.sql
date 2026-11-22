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
