-- Ejecutar UNA vez en Supabase > SQL Editor.
create table if not exists public.push_subscriptions (
  id           bigint generated always as identity primary key,
  endpoint     text not null unique,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);

-- RLS activado y sin políticas: solo el backend (service_role) puede leer/escribir.
-- Así nadie con la clave "anon" puede ver los dispositivos suscriptos.
alter table public.push_subscriptions enable row level security;
