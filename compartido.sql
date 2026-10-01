-- Ejecutar UNA vez en Supabase > SQL Editor (después de usuarios.sql y estado_mensajes.sql).
--
-- NÚMERO COMPARTIDO: varios usuarios pueden usar el mismo número de WhatsApp.
-- Cada contacto (cliente) tiene UN dueño. Todo lo que ese contacto escribe,
-- y todo lo que se le envía, queda en la bandeja de su dueño. El administrador
-- ve todo y puede reasignar un contacto a otro usuario.
--
-- Esta tabla solo aplica al número compartido (el META_PHONE_NUMBER_ID del servidor).
-- Un usuario con su propio phone_number_id sigue teniendo su línea aparte.

create table if not exists public.contact_owners (
  numero       text primary key,                                   -- últimos 10 dígitos del teléfono
  user_id      uuid not null references public.app_users(id) on delete cascade,
  asignado_por uuid references public.app_users(id) on delete set null,
  updated_at   timestamptz not null default now()
);
create index if not exists contact_owners_user_id_idx on public.contact_owners (user_id);

-- Sin políticas: solo el backend (service_role) puede leer/escribir.
alter table public.contact_owners enable row level security;

-- Contactos que ya existían: pasan a ser del usuario con el que tienen mensajes.
-- Se ignoran los usuarios con número propio (esos no usan el número compartido).
insert into public.contact_owners (numero, user_id)
select distinct on (c.numero) c.numero, c.user_id
  from (
    select right(regexp_replace(coalesce(substring(m.sender from '\(([^)]*)\)\s*$'), ''), '\D', '', 'g'), 10) as numero,
           m.user_id,
           m.created_at
      from public.messages m
      join public.app_users u on u.id = m.user_id
     where u.phone_number_id is null          -- los usuarios con número propio no usan el compartido
       and m.sender <> '__DIAG__'
  ) c
 where c.numero <> ''
 order by c.numero, c.created_at desc
on conflict (numero) do nothing;

-- A quienes ya se les envió una plantilla antes de que existieran los usuarios
-- (tabla message_log, si existe): pasan al administrador.
do $$
begin
  if to_regclass('public.message_log') is not null then
    insert into public.contact_owners (numero, user_id)
    select distinct right(regexp_replace(l.numero_destino, '\D', '', 'g'), 10),
           (select id from public.app_users where role = 'admin' order by created_at limit 1)
      from public.message_log l
     where regexp_replace(coalesce(l.numero_destino, ''), '\D', '', 'g') <> ''
       and exists (select 1 from public.app_users where role = 'admin')
    on conflict (numero) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
