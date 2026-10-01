// Servidor Node.js para producción con WhatsApp Business Cloud API (Meta) y Supabase
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { supabase } = require("./supabaseClient");
const { descargarMediaWhatsApp, enviarTextoLibreWhatsApp } = require("./whatsappService");
const { procesarEnvio } = require("./utils/whatsappProcessor");
const { responderConIA } = require("./utils/aiAgent");
const push = require("./utils/pushService");
const { pausarIA, iaPausadaHasta, reanudarIA, listarPausasActivas, MINUTOS_POR_DEFECTO } = require("./utils/pausaIA");
const { requireAuth, requireAdmin, usuarioObjetivo } = require("./utils/auth");
const usuarios = require("./utils/usuarios");
const contactos = require("./utils/contactos");

// Interruptor general del agente de IA. Poné AI_AUTORESPONDER=false en
// Render (Environment) si alguna vez necesitás apagarlo sin tocar código.
const AI_AUTORESPONDER_ACTIVO =
  String(process.env.AI_AUTORESPONDER || "true").toLowerCase() !== "false";

const app = express();
const PORT = process.env.PORT || 3000;

// Render (y cualquier proxy) antepone su IP: sin esto, el freno a intentos de
// login vería siempre la misma IP para todo el mundo.
app.set("trust proxy", 1);

console.log("✅ Cliente de Supabase inicializado");

// =========================================================================
// RED DE SEGURIDAD GLOBAL
// Sin esto, una promesa rechazada sin .catch() mata el proceso en Node >= 15.
// Era la causa de que los webhooks "desaparecieran": el server se reiniciaba.
// =========================================================================
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ [unhandledRejection] El proceso NO se cae. Motivo:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ [uncaughtException] El proceso NO se cae. Motivo:", err);
});

// =========================================================================
// MIDDLEWARES GENERALES
// =========================================================================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Bypass-Tunnel-Reminder"],
    // credentials:true es incompatible con origin:"*" y el navegador rechaza
    // la respuesta. Si algún día necesitás cookies, poné el origen exacto.
    credentials: false,
  })
);

app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
  res.setHeader("Bypass-Tunnel-Reminder", "true");
  next();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Login, sesión y administración de usuarios.
app.use(require("./rutasAuth"));

// =========================================================================
// SALUD Y DIAGNÓSTICO
// =========================================================================
app.get("/status", (req, res) => {
  res.json({
    status: "connected",
    environment: process.env.NODE_ENV || "production",
    provider: "Meta WhatsApp Cloud API + Supabase",
    timestamp: new Date().toISOString(),
  });
});

// Abrí https://TU-BACKEND/api/diag en el navegador: te dice exactamente
// qué pieza está rota sin tener que leer logs.
app.get("/api/diag", requireAuth, requireAdmin, async (req, res) => {
  const diag = {
    env: {
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      META_PHONE_NUMBER_ID: Boolean(process.env.META_PHONE_NUMBER_ID),
      META_ACCESS_TOKEN: Boolean(process.env.META_ACCESS_TOKEN),
      META_WEBHOOK_VERIFY_TOKEN: Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN),
      VAPID_PUBLIC_KEY: Boolean(process.env.VAPID_PUBLIC_KEY),
      VAPID_PRIVATE_KEY: Boolean(process.env.VAPID_PRIVATE_KEY),
    },
    supabase: { lectura: null, escritura: null },
    ultimoWebhook: ultimoWebhookRecibido,
  };

  const lectura = await supabase.from("messages").select("id").limit(1);
  diag.supabase.lectura = lectura.error
    ? { ok: false, ...lectura.error }
    : { ok: true, filas: lectura.data.length };

  const escritura = await supabase
    .from("messages")
    .insert([
      {
        sender: "__DIAG__",
        body: "prueba de escritura",
        media_url: null,
        mime_type: "text/plain",
      },
    ])
    .select();

  if (escritura.error) {
    diag.supabase.escritura = { ok: false, ...escritura.error };
  } else {
    diag.supabase.escritura = { ok: true };
    const idPrueba = escritura.data?.[0]?.id;
    if (idPrueba) await supabase.from("messages").delete().eq("id", idPrueba);
  }

  res.json(diag);
});

// =========================================================================
// ENDPOINTS DE MENSAJES (API REST)
// =========================================================================

// Supabase/PostgREST devuelve como mucho 1000 filas por consulta. Pedimos los
// MÁS RECIENTES (antes, sin orden descendente, a partir de la fila 1001 los
// mensajes nuevos dejaban de aparecer).
const MAX_MENSAJES = 1000;

app.get("/api/mensajes", requireAuth, async (req, res) => {
  try {
    // Cada usuario ve SOLO sus mensajes. El admin puede pedir los de otro con
    // ?userId=<id>, o los de todos con ?userId=todos.
    const objetivo = usuarioObjetivo(req);

    let consulta = supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: false })
      .range(0, MAX_MENSAJES - 1);
    if (objetivo !== "todos") consulta = consulta.eq("user_id", objetivo);

    const { data: mensajes, error } = await consulta;

    if (error) {
      console.error("❌ ERROR DIRECTO DE SUPABASE:", error);
      return res.status(500).json({
        success: false,
        error: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }

    // El admin ve de quién es cada conversación (para poder reasignarla).
    let nombres = {};
    if (req.user.role === "admin") {
      const { data: us } = await supabase.from("app_users").select("id, username");
      nombres = Object.fromEntries((us || []).map((u) => [u.id, u.username]));
    }

    const mensajesFormateados = (mensajes || []).reverse().map((m) => ({
      id: m.id,
      remitente: m.sender,
      // Número limpio y nombre por separado: el frontend agrupa por número,
      // así entrantes y salientes caen en la MISMA conversación.
      numero: extraerNumero(m.sender),
      nombre: extraerNombre(m.sender),
      entrante: !String(m.sender || "").startsWith("Soporte ("),
      cuerpo: m.body,
      URL_de_medios: m.media_url,
      tipo_mime: m.mime_type,
      estado: m.status || null, // sent | delivered | read | failed (solo salientes)
      wamid: m.wa_message_id || null, // id de WhatsApp: sirve para citar el mensaje al responder
      usuario_id: m.user_id || null, // dueño de la conversación
      usuario: nombres[m.user_id] || null, // (solo lo recibe el admin)
      created_at: m.created_at,
    }));

    return res.json({
      success: true,
      total: mensajesFormateados.length,
      data: mensajesFormateados,
    });
  } catch (err) {
    if (err.status === 403 || err.status === 400) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    console.error("❌ EXCEPCIÓN DE SERVIDOR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Extrae "5493827402013" de "Franco (5493827402013)" o de "Soporte (549...)"
function extraerNumero(sender) {
  const m = String(sender || "").match(/\(([^)]+)\)\s*$/);
  return m ? m[1].replace(/\D/g, "") : String(sender || "").replace(/\D/g, "");
}

function extraerNombre(sender) {
  const m = String(sender || "").match(/^(.*?)\s*\([^)]*\)\s*$/);
  return m ? m[1].trim() : String(sender || "");
}

// Borra toda la conversación con un contacto (solo los mensajes del usuario que lo pide).
// Coincide por los últimos 10 dígitos: entrantes ("Franco (549…)") y salientes ("Soporte (54…)").
app.delete("/api/mensajes/contacto/:numero", requireAuth, async (req, res) => {
  try {
    const k = contactos.ultimos10(req.params.numero);
    if (!k) return res.status(400).json({ success: false, error: "Número inválido." });

    const { data, error } = await supabase
      .from("messages")
      .delete()
      .eq("user_id", req.user.id)
      .ilike("sender", `%${k})`)
      .select("id");
    if (error) throw error;

    res.json({ success: true, eliminados: data?.length || 0 });
  } catch (error) {
    console.error("[Servidor] Error al eliminar conversación:", error.message);
    res.status(500).json({ success: false, error: "Error interno al eliminar la conversación." });
  }
});

app.delete("/api/mensajes/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[DELETE] Solicitud para eliminar mensaje ID: ${id}`);

    const { data, error } = await supabase
      .from("messages")
      .delete()
      .eq("id", id)
      .eq("user_id", req.user.id) // solo se pueden borrar mensajes propios
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Mensaje no encontrado." });
    }

    console.log(`✅ Mensaje ${id} eliminado con éxito de Supabase.`);
    return res.json({ success: true, message: "Mensaje eliminado con éxito." });
  } catch (error) {
    console.error("[Servidor] Error al eliminar mensaje individual:", error.message);
    res
      .status(500)
      .json({ success: false, error: "Error interno al eliminar el mensaje." });
  }
});

app.delete("/api/mensajes", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("messages")
      .delete()
      .eq("user_id", req.user.id); // solo el historial del usuario que lo pide

    if (error) throw error;

    res.json({ success: true, message: "Tu historial de mensajes fue eliminado." });
  } catch (error) {
    console.error("[Servidor] Error al vaciar historial de Supabase:", error.message);
    res.status(500).json({ success: false, error: "Error al limpiar historial." });
  }
});

// Guarda un mensaje. Si todavía no corriste estado_mensajes.sql, las columnas
// opcionales (wa_message_id, status) no existen: reintenta sin ellas para NO perder el mensaje.
const COLUMNAS_OPCIONALES = ["wa_message_id", "status"];
async function guardarMensaje(registro) {
  let { error } = await supabase.from("messages").insert([registro]);
  if (error && (error.code === "PGRST204" || error.code === "42703")) {
    console.warn("[Supabase] Faltan las columnas wa_message_id/status (correr estado_mensajes.sql). Se guarda sin ellas.");
    const basico = { ...registro };
    for (const c of COLUMNAS_OPCIONALES) delete basico[c];
    ({ error } = await supabase.from("messages").insert([basico]));
  }
  return { error };
}

// Usada tanto por el endpoint manual como por el agente de IA: manda el
// mensaje por WhatsApp y lo deja guardado en Supabase como "Soporte (numero)".
// Devuelve { result, duenioId }: la conversación queda en la bandeja de su dueño.
async function enviarRespuestaSoporte(usuario, numeroLimpio, texto, contextMessageId = null) {
  const credenciales = usuarios.credencialesMeta(usuario); // envía desde el número de ESTE usuario (o el compartido)

  // Número compartido: solo se le escribe a contactos propios o libres (el admin, a cualquiera).
  let duenioPrevio = null;
  if (credenciales.compartido) {
    duenioPrevio = await contactos.verificarPermisoEnvio(usuario, numeroLimpio);
  }

  // Meta espera el id de WhatsApp ("wamid.…") para citar; con cualquier otra cosa falla.
  const contexto =
    typeof contextMessageId === "string" && contextMessageId.startsWith("wamid.")
      ? contextMessageId
      : null;

  const result = await procesarEnvio({
    to: numeroLimpio,
    type: "text",
    text: texto,
    contextMessageId: contexto,
    credenciales,
  });

  // Enviado: si el contacto estaba libre, pasa a ser de quien le escribió.
  let duenioId = usuario.id;
  if (credenciales.compartido) {
    duenioId =
      duenioPrevio ||
      (await contactos.reclamarSiLibre(usuario, numeroLimpio).catch((e) => {
        console.warn("[Contactos] No se pudo registrar el dueño del contacto:", e.message);
        return usuario.id;
      }));
  }

  const respuestaId = result?.messages?.[0]?.id || `out_${Date.now()}`;

  const { error: sbErr } = await guardarMensaje({
    user_id: duenioId,
    sender: `Soporte (${numeroLimpio})`,
    body: texto,
    media_url: null,
    mime_type: "text/plain",
    // wa_message_id permite después cruzar los avisos de Meta (entregado/leído) con este mensaje.
    wa_message_id: result?.messages?.[0]?.id || null,
    status: "sent",
  });

  if (sbErr) {
    console.error("[Supabase Outbound Error]:", sbErr.message);
  } else {
    console.log(`⚡ Respuesta ${respuestaId} guardada en Supabase.`);
  }

  return { result, duenioId };
}

app.post("/api/mensajes/responder", requireAuth, async (req, res) => {
  try {
    const { to, number, messageText, text, contextMessageId } = req.body || {};
    const destinatario = to || number;
    const mensaje = messageText || text;

    if (!destinatario || !mensaje) {
      return res.status(400).json({
        success: false,
        error:
          "Los campos 'to' (o 'number') y 'messageText' (o 'text') son obligatorios.",
      });
    }

    const numeroLimpio = String(destinatario).replace(/\D/g, "");
    const { result, duenioId } = await enviarRespuestaSoporte(
      req.user,
      numeroLimpio,
      mensaje,
      contextMessageId || null
    );

    // Contestaste vos a mano: el bot se calla un rato para no pisar la charla.
    // Cada respuesta manual renueva el plazo. Se pausa DESPUÉS de enviar, así
    // si el envío falla (ej. error 131047) el bot no queda apagado en vano.
    const pausadaHasta = await pausarIA(duenioId, numeroLimpio);

    res.json({
      success: true,
      message: "Respuesta enviada con éxito.",
      data: result,
      iaPausadaHasta: pausadaHasta ? pausadaHasta.toISOString() : null,
      iaPausaMinutos: MINUTOS_POR_DEFECTO,
    });
  } catch (err) {
    console.error("[Servidor] Error en /api/mensajes/responder:", err.message);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

// Solo administrador: pasa un contacto (con todo su historial) a otro usuario.
// Sirve para repartir los contactos que escribieron por su cuenta (los recibe el admin).
app.post("/api/admin/contactos/asignar", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { numero, userId } = req.body || {};
    if (!contactos.ultimos10(numero)) {
      return res.status(400).json({ success: false, error: "Número inválido." });
    }
    if (!contactos.esUuid(userId)) {
      return res.status(400).json({ success: false, error: "Usuario inválido." });
    }
    const destino = await usuarios.obtenerPorId(userId);
    if (!destino) return res.status(404).json({ success: false, error: "Usuario no encontrado." });

    const data = await contactos.asignarContacto(numero, userId, req.user.id);
    res.json({ success: true, message: `Contacto asignado a ${destino.username}.`, data });
  } catch (err) {
    console.error("[Servidor] Error en /api/admin/contactos/asignar:", err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Estado de las pausas vigentes (lo consulta el frontend para mostrar "🤖 pausado").
app.get("/api/ia/pausas", requireAuth, async (req, res) => {
  try {
    const pausas = await listarPausasActivas(usuarioObjetivo(req));
    res.json({ success: true, minutosPorDefecto: MINUTOS_POR_DEFECTO, data: pausas });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Reactivar el bot antes de que se cumpla la hora.
app.delete("/api/ia/pausas/:numero", requireAuth, async (req, res) => {
  await reanudarIA(req.user.id, req.params.numero);
  res.json({ success: true, message: "Bot reactivado para este contacto." });
});

// =========================================================================
// NOTIFICACIONES PUSH
// =========================================================================
app.get("/api/push/public-key", (req, res) => {
  if (!push.pushActivo()) {
    return res
      .status(503)
      .json({ success: false, error: "Push no configurado en el servidor (faltan claves VAPID)." });
  }
  res.json({ success: true, publicKey: push.VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", requireAuth, async (req, res) => {
  try {
    await push.guardarSuscripcion(req.body, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error("[Push] subscribe:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/push/unsubscribe", requireAuth, async (req, res) => {
  try {
    await push.eliminarSuscripcion(req.body?.endpoint, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error("[Push] unsubscribe:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Manda una notificación de prueba SOLO al dispositivo que la pide.
app.post("/api/push/test", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ success: false, error: "Falta 'endpoint'." });
    }
    const resultado = await push.enviarPush(
      {
        title: "Notificaciones activadas ✅",
        body: "Así vas a ver los mensajes nuevos, aunque la app esté cerrada.",
        tag: "prueba-push",
        url: "/",
        siempre: true, // se muestra aunque la app esté abierta
      },
      { userId: req.user.id, endpoint }
    );
    res.json({ success: true, ...resultado });
  } catch (err) {
    console.error("[Push] test:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// WEBHOOK DE META (WHATSAPP CLOUD API)
// =========================================================================

// Guardamos la marca del último webhook para poder verla desde /api/diag.
let ultimoWebhookRecibido = null;

app.get("/webhook", (req, res) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === verifyToken) {
    console.log("[Webhook] Verificado con éxito por Meta.");
    return res.status(200).send(challenge);
  }

  console.warn("[Webhook] Verificación rechazada. mode=%s token recibido=%s", mode, token);
  res.sendStatus(403);
});

async function procesarMensajeEntrante(msg, contactName, usuario, compartido = false) {
  // Token con el que se descargan los adjuntos: en el número compartido el del .env;
  // en el número propio de un usuario, el suyo (si cargó uno).
  const cred = { token: (!compartido && usuario.meta_access_token) || undefined };
  let textoMensaje = "";
  let mediaUrl = null;
  let mimeType = "text/plain";

  try {
    if (msg.type === "text" && msg.text?.body) {
      textoMensaje = msg.text.body;
    } else if (msg.type === "button" && msg.button?.text) {
      textoMensaje = msg.button.text;
    } else if (msg.type === "interactive") {
      textoMensaje =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        "[Respuesta Interactiva]";
    } else if (["image", "sticker"].includes(msg.type)) {
      const mediaData = msg.image || msg.sticker;
      textoMensaje = mediaData?.caption || "";
      mimeType = mediaData?.mime_type || "image/jpeg";
      if (mediaData?.id) mediaUrl = await descargarMediaWhatsApp(mediaData.id, mimeType, cred);
    } else if (["audio", "voice"].includes(msg.type)) {
      const mediaData = msg.audio || msg.voice;
      mimeType = mediaData?.mime_type || "audio/ogg";
      if (mediaData?.id) mediaUrl = await descargarMediaWhatsApp(mediaData.id, mimeType, cred);
    } else if (msg.type === "document" && msg.document?.id) {
      textoMensaje = msg.document?.caption || msg.document?.filename || "";
      mimeType = msg.document?.mime_type || "application/pdf";
      mediaUrl = await descargarMediaWhatsApp(msg.document.id, mimeType, cred);
    } else if (msg.type === "video" && msg.video?.id) {
      textoMensaje = msg.video?.caption || "";
      mimeType = msg.video?.mime_type || "video/mp4";
      mediaUrl = await descargarMediaWhatsApp(msg.video.id, mimeType, cred);
    } else {
      textoMensaje = `[Mensaje de tipo: ${msg.type}]`;
    }
  } catch (e) {
    // Si falla la descarga del adjunto, igual guardamos el mensaje.
    console.error(`[Media Error - Type ${msg.type}]:`, e.message);
    textoMensaje = textoMensaje || "[Error al descargar archivo adjunto]";
  }

  const numeroLimpio = String(msg.from || "").replace(/\D/g, "");

  // El insert AHORA está dentro del try/catch. Antes estaba afuera y cualquier
  // fallo de red contra Supabase tumbaba el proceso entero.
  try {
    const { error: sbErr } = await guardarMensaje({
      user_id: usuario.id,
      sender: `${contactName} (${numeroLimpio})`,
      body: textoMensaje,
      media_url: mediaUrl,
      mime_type: mimeType,
      wa_message_id: msg.id || null, // permite citar este mensaje al responder
    });

    if (sbErr) {
      console.error("[Supabase Error]:", sbErr.message, sbErr.details || "", sbErr.hint || "");
    } else {
      console.log(`⚡ Mensaje ${msg.id || Date.now()} de ${numeroLimpio} guardado.`);
    }
  } catch (e) {
    console.error("[Supabase Excepción al insertar]:", e.message);
  }

  // Número compartido: un contacto sin dueño que escribió por su cuenta queda a nombre de
  // quien lo recibe (el admin). Así tiene UN solo dueño y no se parte su historial.
  if (compartido) {
    await contactos.reclamarSiLibre(usuario, numeroLimpio).catch((e) =>
      console.warn("[Contactos] No se pudo registrar el dueño del contacto:", e.message)
    );
  }

  // Notificación push al celular/PC. Sin await a propósito: no debe demorar
  // la respuesta automática de la IA ni el 200 hacia Meta.
  push
    .notificarMensajeNuevo({ msg, contactName, numero: numeroLimpio, texto: textoMensaje, userId: usuario.id })
    .catch((e) => console.error("[Push] Error notificando:", e.message));

  // Agente de IA: solo para mensajes de texto con contenido real. Los
  // audios/imágenes se guardan igual arriba, pero no disparan respuesta
  // automática (Gemini no "ve" el archivo en este flujo).
  // El bot solo responde para usuarios con ia_activa (el prompt es de Farmanor Pay).
  if (AI_AUTORESPONDER_ACTIVO && usuario.activo && usuario.ia_activa && msg.type === "text" && textoMensaje.trim()) {
    try {
      // Si contestaste vos hace poco, el bot no interviene.
      const pausaInicial = await iaPausadaHasta(usuario.id, numeroLimpio);
      if (pausaInicial) {
        console.log(
          `🤖⏸️ IA pausada para ${numeroLimpio} hasta ${pausaInicial.toISOString()}. No se responde.`
        );
        return;
      }

      const historial = await obtenerHistorialParaIA(usuario.id, numeroLimpio);
      const respuestaIA = await responderConIA(textoMensaje, historial);

      // Gemini puede tardar varios segundos: si mientras tanto contestaste
      // vos a mano, se descarta la respuesta del bot para no pisarte.
      const pausaTardia = await iaPausadaHasta(usuario.id, numeroLimpio);
      if (pausaTardia) {
        console.log(
          `🤖⏸️ Contestaste a ${numeroLimpio} mientras la IA pensaba. Se descarta su respuesta.`
        );
        return;
      }

      if (respuestaIA && respuestaIA.trim()) {
        await enviarRespuestaSoporte(usuario, numeroLimpio, respuestaIA.trim());
        console.log(`🤖 Respuesta de IA enviada a ${numeroLimpio}.`);
      } else {
        console.warn(`🤖 La IA no devolvió texto para ${numeroLimpio}, no se envía nada.`);
      }
    } catch (e) {
      console.error("[Agente IA] Error generando/enviando respuesta:", e.message);
    }
  }
}

// Trae los últimos mensajes de esa conversación (por número) y los deja en
// el formato { esCliente, texto } que espera utils/aiAgent.js.
// Se llama DESPUÉS de guardar el mensaje entrante, así que el más reciente
// del resultado ES ese mismo mensaje: se descarta acá porque aiAgent.js ya
// lo recibe aparte como "mensajeActual" (si no, quedaría duplicado).
async function obtenerHistorialParaIA(userId, numeroLimpio, limite = 10) {
  const { data, error } = await supabase
    .from("messages")
    .select("sender, body, created_at")
    .eq("user_id", userId)
    .ilike("sender", `%${contactos.ultimos10(numeroLimpio)})`) // entrantes (549…) y salientes (54…)
    .order("created_at", { ascending: false })
    .limit(limite + 1);

  if (error) {
    console.error("[Agente IA] Error trayendo historial:", error.message);
    return [];
  }

  return (data || [])
    .reverse()
    .slice(0, -1) // saca el mensaje actual, que ya se agrega por separado
    .filter((m) => (m.body || "").trim() !== "")
    .map((m) => ({
      esCliente: !String(m.sender || "").startsWith("Soporte ("),
      texto: m.body,
    }));
}

// Deduplicación en memoria: Meta reintenta el mismo webhook varias veces.
const idsProcesados = new Set();
function yaProcesado(id) {
  if (!id) return false;
  if (idsProcesados.has(id)) return true;
  idsProcesados.add(id);
  // Evitamos que el Set crezca sin límite.
  if (idsProcesados.size > 5000) {
    idsProcesados.clear();
  }
  return false;
}

app.post("/webhook", (req, res) => {
  const body = req.body || {};

  ultimoWebhookRecibido = new Date().toISOString();
  console.log("[Webhook] POST recibido:", JSON.stringify(body).slice(0, 800));

  if (body.object !== "whatsapp_business_account") {
    return res.sendStatus(404);
  }

  // 200 inmediato a Meta para evitar timeouts y reintentos.
  res.status(200).send("EVENT_RECEIVED");

  (async () => {
    if (!Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        const value = change.value;

        if (Array.isArray(value?.statuses)) {
          for (const status of value.statuses) {
            console.log(`[Status Update] ID: ${status.id} | Estado: ${status.status}`);
            if (status.errors?.length) {
              console.error("[Status Error]:", JSON.stringify(status.errors));
            }
            await actualizarEstadoMensaje(status).catch((e) =>
              console.error("[Status] Error actualizando estado:", e.message)
            );
          }
        }

        if (Array.isArray(value?.messages)) {
          // ¿A cuál de tus usuarios le escribieron?
          //  - Número propio de un usuario: se decide por metadata.phone_number_id.
          //  - Número compartido: se decide por el dueño del contacto (contact_owners);
          //    si el contacto no tiene dueño, lo recibe el administrador.
          const phoneId = value?.metadata?.phone_number_id;
          const compartido = usuarios.esLineaCompartida(phoneId);

          for (const msg of value.messages) {
            const duenio = await usuarios.resolverDuenioWebhook(phoneId, msg.from);
            if (!duenio) {
              console.error("[Webhook] No se pudo determinar el usuario dueño del mensaje. Se descarta.");
              continue;
            }

            if (yaProcesado(msg.id)) {
              console.log(`[Webhook] Duplicado ignorado: ${msg.id}`);
              continue;
            }

            // El match exacto por wa_id falla en AR/MX (dígito 9 / 1 de más).
            // Comparamos sólo los últimos 8 dígitos y caemos al primer contacto.
            const contactObj =
              value.contacts?.find((c) => coincideNumero(c.wa_id, msg.from)) ||
              value.contacts?.[0];
            const contactName = contactObj?.profile?.name || "Desconocido";

            // await + catch: nunca más una promesa huérfana.
            await procesarMensajeEntrante(msg, contactName, duenio, compartido).catch((e) =>
              console.error("[procesarMensajeEntrante]:", e.message)
            );
          }
        }
      }
    }
  })().catch((error) => {
    console.error("[Webhook Async Processing Error]:", error);
  });
});

// Guarda en Supabase el estado que informa Meta para un mensaje saliente.
// "sent" ya se guarda al enviar, así que acá solo llegan delivered / read / failed.
// Los avisos pueden llegar desordenados: "delivered" nunca pisa a "read".
async function actualizarEstadoMensaje(status) {
  const nuevo = status?.status;
  if (!status?.id || !["delivered", "read", "failed"].includes(nuevo)) return;

  let q = supabase.from("messages").update({ status: nuevo }).eq("wa_message_id", status.id);
  if (nuevo === "delivered") q = q.or("status.is.null,status.eq.sent");

  const { error } = await q;
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204") {
      console.warn("[Status] Faltan columnas: correr estado_mensajes.sql en Supabase.");
    } else {
      console.error("[Status] Error de Supabase:", error.message);
    }
  }
}

function coincideNumero(a, b) {
  const da = String(a || "").replace(/\D/g, "");
  const db = String(b || "").replace(/\D/g, "");
  if (!da || !db) return false;
  return da.slice(-8) === db.slice(-8);
}

// =========================================================================
// ENDPOINTS DE ENVÍO MASIVO / INDIVIDUAL
// =========================================================================

app.post("/send", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const credenciales = usuarios.credencialesMeta(req.user);
    const destino = body.number || body.to || body.phone;

    // Número compartido: no se le puede escribir a un contacto que es de otro usuario.
    if (credenciales.compartido) await contactos.verificarPermisoEnvio(req.user, destino);

    // `credenciales` va al final: el cliente no puede mandar las suyas para usar otro número.
    const result = await procesarEnvio({ ...body, credenciales });

    // Enviado: si el contacto estaba libre, pasa a ser tuyo (así sus respuestas te llegan a vos).
    if (credenciales.compartido) {
      await contactos.reclamarSiLibre(req.user, destino).catch((e) =>
        console.warn("[Contactos] No se pudo registrar el dueño del contacto:", e.message)
      );
    }
    res.json({ success: true, message: "Mensaje procesado con éxito.", data: result });
  } catch (err) {
    console.error("[Servidor] Error en /send:", err.message);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

app.post("/send-bulk", requireAuth, async (req, res) => {
  const { contacts, delayMs = 200 } = req.body || {};

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: "Se requiere un arreglo 'contacts' válido." });
  }

  let credenciales;
  try {
    credenciales = usuarios.credencialesMeta(req.user);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const results = [];
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const destino = contact.number || contact.to || contact.phone;
    try {
      // Número compartido: los contactos de otro usuario se saltan (con su error en el resultado).
      if (credenciales.compartido) await contactos.verificarPermisoEnvio(req.user, destino);

      const response = await procesarEnvio({ ...contact, credenciales });

      if (credenciales.compartido) {
        await contactos.reclamarSiLibre(req.user, destino).catch((e) =>
          console.warn("[Contactos] No se pudo registrar el dueño del contacto:", e.message)
        );
      }
      results.push({ number: destino, status: "success", response });
    } catch (err) {
      results.push({ number: destino, status: "error", error: err.message });
    }

    if (i < contacts.length - 1) await delay(delayMs);
  }

  const errores = results.filter((r) => r.status === "error");
  res.json({
    success: true,
    processed: results.length,
    enviados: results.length - errores.length,
    fallidos: errores.length,
    results,
  });
});

// 404 explícito: así distinguís "ruta inexistente" de "servidor caído".
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`[Servidor Producción] API corriendo en puerto ${PORT} con Supabase`);

  // Crea el administrador la primera vez y asigna los datos viejos a ese usuario.
  usuarios.asegurarAdmin().catch((e) =>
    console.error(
      "❌ No se pudo preparar el administrador. ¿Ejecutaste usuarios.sql en Supabase? Motivo:",
      e.message
    )
  );
});
