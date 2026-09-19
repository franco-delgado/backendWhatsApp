// Notificaciones Web Push (VAPID). Envía avisos al celular/PC aunque la app
// esté cerrada. Las suscripciones se guardan en Supabase (tabla
// "push_subscriptions") porque el disco de Render se borra en cada deploy.
const webpush = require("web-push");
const { supabase } = require("../supabaseClient");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let pushActivo = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushActivo = true;
    console.log("🔔 Web Push activo.");
  } catch (e) {
    console.error("❌ Claves VAPID inválidas, Web Push desactivado:", e.message);
  }
} else {
  console.warn(
    "⚠️ Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: las notificaciones push están desactivadas."
  );
}

function suscripcionValida(sub) {
  return Boolean(
    sub &&
      typeof sub.endpoint === "string" &&
      sub.endpoint.startsWith("https://") &&
      sub.keys &&
      sub.keys.p256dh &&
      sub.keys.auth
  );
}

async function guardarSuscripcion(sub) {
  if (!suscripcionValida(sub)) throw new Error("Suscripción push inválida.");
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      [{ endpoint: sub.endpoint, subscription: sub }],
      { onConflict: "endpoint" }
    );
  if (error) throw new Error(error.message);
}

async function eliminarSuscripcion(endpoint) {
  if (!endpoint) return;
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint);
  if (error) throw new Error(error.message);
}

async function enviarUna(sub, payload) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 60 * 60 * 24, // si el celu está apagado, se entrega hasta 24 h después
      urgency: "high", // despierta el equipo aunque esté en modo ahorro (Doze)
    });
    return true;
  } catch (err) {
    // 404/410 = la suscripción ya no existe (desinstalaron la app o revocaron
    // el permiso). Se borra para no seguir intentando.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await eliminarSuscripcion(sub.endpoint).catch(() => {});
    } else {
      console.error(
        `[Push] Error ${err.statusCode || ""} enviando a ${sub.endpoint.slice(0, 60)}…:`,
        err.body || err.message
      );
    }
    return false;
  }
}

// Envía a todos los dispositivos suscriptos, o solo a `soloEndpoint` (prueba).
async function enviarPush(payload, soloEndpoint = null) {
  if (!pushActivo) return { enviados: 0, fallidos: 0, motivo: "push desactivado" };

  let query = supabase.from("push_subscriptions").select("subscription");
  if (soloEndpoint) query = query.eq("endpoint", soloEndpoint);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const resultados = await Promise.all(
    (data || []).map((fila) => enviarUna(fila.subscription, payload))
  );
  const enviados = resultados.filter(Boolean).length;
  return { enviados, fallidos: resultados.length - enviados };
}

// Texto corto para mostrar en la notificación según el tipo de mensaje.
function previewMensaje(msg, texto) {
  const limpio = String(texto || "").trim();
  switch (msg.type) {
    case "image":
    case "sticker":
      return limpio ? `📷 ${limpio}` : "📷 Imagen";
    case "audio":
    case "voice":
      return "🎵 Audio";
    case "video":
      return limpio ? `🎬 ${limpio}` : "🎬 Video";
    case "document":
      return limpio ? `📄 ${limpio}` : "📄 Documento";
    default:
      return limpio ? (limpio.length > 140 ? limpio.slice(0, 137) + "…" : limpio) : "Nuevo mensaje";
  }
}

async function notificarMensajeNuevo({ msg, contactName, numero, texto }) {
  const resultado = await enviarPush({
    title: contactName || numero,
    body: previewMensaje(msg, texto),
    numero,
    // Mismo tag por conversación: los mensajes seguidos se agrupan en una sola
    // notificación en vez de apilar 20, pero cada uno vuelve a sonar (renotify).
    tag: `chat-${numero}`,
    url: `/?chat=${numero}`,
  });
  console.log(`🔔 Push por mensaje de ${numero}:`, JSON.stringify(resultado));
}

module.exports = {
  VAPID_PUBLIC_KEY,
  pushActivo: () => pushActivo,
  guardarSuscripcion,
  eliminarSuscripcion,
  enviarPush,
  notificarMensajeNuevo,
};
