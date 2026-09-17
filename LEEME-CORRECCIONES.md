# Correcciones aplicadas al backend

Esta carpeta es tu `backendWhatsApp` completo, listo para usar. Reemplaza a la que tenías.

## Qué cambió respecto a tu carpeta original

| Archivo | Acción |
|---|---|
| `supabaseClient.js` | **Nuevo.** Cliente Supabase único para todo el backend (antes había uno duplicado en `server.js`, `whatsappService.js` y `whatsappProcessor.js`). |
| `server.js` | Corregido (ver detalle abajo). |
| `whatsappService.js` | Corregido. |
| `utils/whatsappProcessor.js` | Corregido. |
| `package.json` / `package-lock.json` | Se sacaron `firebase`, `firebase-admin` y `mongoose`: no los usa ningún archivo activo del proyecto. |
| `.env.example` | **Nuevo.** Plantilla sin secretos para que armes tu `.env`. |
| `conexionFB.js`, `models/Mensaje.js`, `serviceAccountKey.json`, `auth_info/` | **Eliminados.** Eran de una etapa anterior con Firebase/Baileys y no los importaba nada. |
| `.env` original | **No incluido** — tenía credenciales reales de Meta y Supabase. Rotalas y completá el `.env.example`. |

Todo lo demás (`README.md`, `Dockerfile`, `.gitignore`, `.dockerignore`, `info.txt`) quedó igual.

## Instalación

```bash
cd backendWhatsApp
npm install
cp .env.example .env   # completar con tus credenciales reales
node server.js
```

## Qué se arregló

**El bug que te impedía recibir mensajes**

`procesarMensajeEntrante(msg, contactName)` se llamaba sin `await` ni `.catch()`, y el `supabase.insert()` estaba fuera del `try/catch`. Un fallo de red contra Supabase producía un *unhandled rejection* que en Node 20 termina el proceso. En Render eso se ve como un reinicio silencioso, y los webhooks que llegan durante el arranque se pierden. Ahora el insert está dentro del `try`, la llamada lleva `await` + `.catch()`, y hay handlers globales de `unhandledRejection` / `uncaughtException` como red de seguridad.

**Resto de correcciones**

- Deduplicación por `msg.id`: Meta reintenta el mismo webhook y te duplicaba filas.
- `value.contacts.find(c => c.wa_id === msg.from)` fallaba en Argentina porque `wa_id` y `from` difieren por el "9". Ahora compara los últimos 8 dígitos y cae al primer contacto si no hay match. Antes el remitente quedaba como "Desconocido".
- `cors({ origin: "*", credentials: true })` es una combinación que el navegador rechaza. `credentials` pasó a `false`.
- `/api/mensajes` ahora devuelve `numero`, `nombre` y `entrante` por separado. El frontend agrupaba por el string completo de `sender`, así que `"Franco (549...)"` y `"Soporte (549...)"` aparecían como dos contactos distintos y tus respuestas no se veían en el hilo. Agrupá por `numero`.
- `whatsappService.js` metía un parámetro fijo `'Franco'` cuando no venían parámetros, lo que rompe plantillas sin variables (error 132000 de Meta). Se eliminó.
- Se borró la copia muerta de `procesarMensajeEntrante` que vivía en `whatsappProcessor.js` y que guardaba el sender sin nombre.
- Log del payload de cada webhook y un 404 explícito en rutas inexistentes.

## Cómo verificar en 2 minutos

Después de desplegar, abrí en el navegador:

```
https://backend-whatsapp-docker.onrender.com/api/diag
```

Te devuelve si están las variables de entorno, si Supabase **lee**, si Supabase **escribe** (hace un insert de prueba y lo borra) y la hora del último webhook recibido. Con eso sabés al instante si el problema es Meta, Supabase o el código.

- `supabase.escritura.ok: false` → el problema es la tabla o las políticas RLS, no el webhook.
- `ultimoWebhook: null` después de mandarte un WhatsApp → Meta no está llegando a tu servidor. Revisá en Meta for Developers > WhatsApp > Configuración que la URL del webhook apunte a `/webhook` y que el campo **`messages`** esté suscripto (es un checkbox aparte de la verificación; verificar el webhook no alcanza).

## Dos cosas que no son código

1. **Plan free de Render.** El servicio se duerme a los 15 minutos y el cold start tarda ~50 s. Meta corta antes y descarta el evento. Si querés recibir mensajes de forma confiable, necesitás el plan pago o un ping externo cada 10 minutos.
2. **Ventana de 24 horas.** Fuera de ella Meta sólo acepta plantillas aprobadas, no texto libre. Si `/api/mensajes/responder` te devuelve error 131047, es eso.

## Pendientes menores en el frontend

- `useClientesDifusion.js` apunta a `http://localhost:3000`; en producción no resuelve.
- `TemplateConfig.jsx` llama a `/plantilla`, `/actualizar-plantilla` y `/enviar-mensajes`, y `useObtenerQR.js` a `/qr`. Ninguna de esas rutas existe en `server.js` (quedaron de la etapa Baileys). Hoy devuelven 404.
- La URL del backend está hardcodeada en cuatro archivos mientras existe `VITE_API_URL` en `.env.production`. Conviene centralizarla.
