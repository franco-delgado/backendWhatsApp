-- Ejecutar UNA vez en Supabase > SQL Editor (antes de desplegar esta versión).
-- Crea la tabla de usuarios y marca de qué usuario es cada mensaje,
-- cada pausa del bot y cada dispositivo con notificaciones.

create table if not exists public.app_users (
  id                uuid primary key default gen_random_uuid(),
  username          text not null,
  password_hash     text not null,
  role              text not null default 'user' check (role in ('admin', 'user')),
  activo            boolean not null default true,
  ia_activa         boolean not null default false,  -- el bot de IA solo responde si está en true
  phone_number_id   text,                            -- número de WhatsApp (Meta) de este usuario
  meta_access_token text,                            -- opcional: token propio; si falta se usa META_ACCESS_TOKEN
  created_at        timestamptz not null default now()
);

create unique index if not exists app_users_username_key
  on public.app_users (lower(username));
create unique index if not exists app_users_phone_number_id_key
  on public.app_users (phone_number_id) where phone_number_id is not null;

-- Sin políticas: solo el backend (service_role) puede leer/escribir.
alter table public.app_users enable row level security;

-- Mensajes: cada uno pertenece a un usuario. Los que ya existen se asignan
-- al administrador automáticamente cuando arranca el servidor.
alter table public.messages add column if not exists user_id uuid
  references public.app_users(id) on delete set null;
create index if not exists messages_user_id_idx on public.messages (user_id, created_at);

-- Dispositivos con notificaciones push: cada uno pertenece a un usuario.
alter table public.push_subscriptions add column if not exists user_id uuid
  references public.app_users(id) on delete cascade;
create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

-- Pausas del bot: ahora son por usuario + contacto. Son temporales (1 h),
-- así que se recrea la tabla.
drop table if exists public.ia_pausas;
create table public.ia_pausas (
  user_id       uuid not null references public.app_users(id) on delete cascade,
  numero        text not null,                 -- últimos 10 dígitos del teléfono
  pausado_hasta timestamptz not null,
  updated_at    timestamptz not null default now(),
  primary key (user_id, numero)
);
alter table public.ia_pausas enable row level security;

notify pgrst, 'reload schema';
