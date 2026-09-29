-- Ejecutar UNA vez en Supabase > SQL Editor.
-- Guarda hasta cuándo el bot de IA está pausado para cada contacto
-- (se activa cuando contestás vos manualmente).
create table if not exists public.ia_pausas (
  numero        text primary key,           -- últimos 10 dígitos del teléfono
  pausado_hasta timestamptz not null,
  updated_at    timestamptz not null default now()
);

-- RLS activado y sin políticas: solo el backend (service_role) puede leer/escribir.
alter table public.ia_pausas enable row level security;
