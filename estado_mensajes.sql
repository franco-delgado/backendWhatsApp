-- Ejecutar UNA vez en Supabase > SQL Editor.
-- Permite mostrar ✓ enviado / ✓✓ entregado / ✓✓ azul leído en los mensajes salientes.
alter table public.messages add column if not exists wa_message_id text;  -- id (wamid) que devuelve Meta
alter table public.messages add column if not exists status text;         -- sent | delivered | read | failed

create index if not exists messages_wa_message_id_idx on public.messages (wa_message_id);

-- Refresca el caché de esquema de la API de Supabase para que vea las columnas nuevas.
notify pgrst, 'reload schema';
