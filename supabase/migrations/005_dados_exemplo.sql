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
