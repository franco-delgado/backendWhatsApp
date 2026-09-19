// Servidor Node.js para producción con WhatsApp Business Cloud API (Meta) y Supabase
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { supabase } = require("./supabaseClient");
const { descargarMediaWhatsApp, enviarTextoLibreWhatsApp } = require("./whatsappService");
const { procesarEnvio } = require("./utils/whatsappProcessor");
const { responderConIA } = require("./utils/aiAgent");
const push = require("./utils/pushService");

// Interruptor general del agente de IA. Poné AI_AUTORESPONDER=false en
// Render (Environment) si alguna vez necesitás apagarlo sin tocar código.
const AI_AUTORESPONDER_ACTIVO =
  String(process.env.AI_AUTORESPONDER || "true").toLowerCase() !== "false";

const app = express();
const PORT = process.env.PORT || 3000;

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
app.get("/api/diag", async (req, res) => {
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

app.get("/api/mensajes", async (req, res) => {
  try {
    const { data: mensajes, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: true });

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

    const mensajesFormateados = (mensajes || []).map((m) => ({
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
      created_at: m.created_at,
    }));

    return res.json({
      success: true,
      total: mensajesFormateados.length,
      data: mensajesFormateados,
    });
  } catch (err) {
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

app.delete("/api/mensajes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[DELETE] Solicitud para eliminar mensaje ID: ${id}`);

    const { data, error } = await supabase
      .from("messages")
      .delete()
      .eq("id", id)
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

app.delete("/api/mensajes", async (req, res) => {
  try {
    const { error } = await supabase
      .from("messages")
      .delete()
      .neq("sender", "___DUMMY_FILTER___");

    if (error) throw error;

    res.json({ success: true, message: "Historial de mensajes limpiado de Supabase." });
  } catch (error) {
    console.error("[Servidor] Error al vaciar historial de Supabase:", error.message);
    res.status(500).json({ success: false, error: "Error al limpiar historial." });
  }
});

// Usada tanto por el endpoint manual como por el agente de IA: manda el
// mensaje por WhatsApp y lo deja guardado en Supabase como "Soporte (numero)".
async function enviarRespuestaSoporte(numeroLimpio, texto, contextMessageId = null) {
  const result = await procesarEnvio({
    to: numeroLimpio,
    type: "text",
    text: texto,
    contextMessageId,
  });

  const respuestaId = result?.messages?.[0]?.id || `out_${Date.now()}`;

  const { error: sbErr } = await supabase.from("messages").insert([
    {
      sender: `Soporte (${numeroLimpio})`,
      body: texto,
      media_url: null,
      mime_type: "text/plain",
    },
  ]);

  if (sbErr) {
    console.error("[Supabase Outbound Error]:", sbErr.message);
  } else {
    console.log(`⚡ Respuesta ${respuestaId} guardada en Supabase.`);
  }

  return result;
}

app.post("/api/mensajes/responder", async (req, res) => {
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
    const result = await enviarRespuestaSoporte(numeroLimpio, mensaje, contextMessageId || null);

    res.json({ success: true, message: "Respuesta enviada con éxito.", data: result });
  } catch (err) {
    console.error("[Servidor] Error en /api/mensajes/responder:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
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

app.post("/api/push/subscribe", async (req, res) => {
  try {
    await push.guardarSuscripcion(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error("[Push] subscribe:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  try {
    await push.eliminarSuscripcion(req.body?.endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error("[Push] unsubscribe:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Manda una notificación de prueba SOLO al dispositivo que la pide.
app.post("/api/push/test", async (req, res) => {
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
      endpoint
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

async function procesarMensajeEntrante(msg, contactName) {
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
      if (mediaData?.id) mediaUrl = await descargarMediaWhatsApp(mediaData.id, mimeType);
    } else if (["audio", "voice"].includes(msg.type)) {
      const mediaData = msg.audio || msg.voice;
      mimeType = mediaData?.mime_type || "audio/ogg";
      if (mediaData?.id) mediaUrl = await descargarMediaWhatsApp(mediaData.id, mimeType);
    } else if (msg.type === "document" && msg.document?.id) {
      textoMensaje = msg.document?.caption || msg.document?.filename || "";
      mimeType = msg.document?.mime_type || "application/pdf";
      mediaUrl = await descargarMediaWhatsApp(msg.document.id, mimeType);
    } else if (msg.type === "video" && msg.video?.id) {
      textoMensaje = msg.video?.caption || "";
      mimeType = msg.video?.mime_type || "video/mp4";
      mediaUrl = await descargarMediaWhatsApp(msg.video.id, mimeType);
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
    const { error: sbErr } = await supabase.from("messages").insert([
      {
        sender: `${contactName} (${numeroLimpio})`,
        body: textoMensaje,
        media_url: mediaUrl,
        mime_type: mimeType,
      },
    ]);

    if (sbErr) {
      console.error("[Supabase Error]:", sbErr.message, sbErr.details || "", sbErr.hint || "");
    } else {
      console.log(`⚡ Mensaje ${msg.id || Date.now()} de ${numeroLimpio} guardado.`);
    }
  } catch (e) {
    console.error("[Supabase Excepción al insertar]:", e.message);
  }

  // Notificación push al celular/PC. Sin await a propósito: no debe demorar
  // la respuesta automática de la IA ni el 200 hacia Meta.
  push
    .notificarMensajeNuevo({ msg, contactName, numero: numeroLimpio, texto: textoMensaje })
    .catch((e) => console.error("[Push] Error notificando:", e.message));

  // Agente de IA: solo para mensajes de texto con contenido real. Los
  // audios/imágenes se guardan igual arriba, pero no disparan respuesta
  // automática (Gemini no "ve" el archivo en este flujo).
  if (AI_AUTORESPONDER_ACTIVO && msg.type === "text" && textoMensaje.trim()) {
    try {
      const historial = await obtenerHistorialParaIA(numeroLimpio);
      const respuestaIA = await responderConIA(textoMensaje, historial);

      if (respuestaIA && respuestaIA.trim()) {
        await enviarRespuestaSoporte(numeroLimpio, respuestaIA.trim());
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
async function obtenerHistorialParaIA(numeroLimpio, limite = 10) {
  const { data, error } = await supabase
    .from("messages")
    .select("sender, body, created_at")
    .ilike("sender", `%(${numeroLimpio})`)
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
          }
        }

        if (Array.isArray(value?.messages)) {
          for (const msg of value.messages) {
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
            await procesarMensajeEntrante(msg, contactName).catch((e) =>
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

function coincideNumero(a, b) {
  const da = String(a || "").replace(/\D/g, "");
  const db = String(b || "").replace(/\D/g, "");
  if (!da || !db) return false;
  return da.slice(-8) === db.slice(-8);
}

// =========================================================================
// ENDPOINTS DE ENVÍO MASIVO / INDIVIDUAL
// =========================================================================

app.post("/send", async (req, res) => {
  try {
    const result = await procesarEnvio(req.body || {});
    res.json({ success: true, message: "Mensaje procesado con éxito.", data: result });
  } catch (err) {
    console.error("[Servidor] Error en /send:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/send-bulk", async (req, res) => {
  const { contacts, delayMs = 200 } = req.body || {};

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: "Se requiere un arreglo 'contacts' válido." });
  }

  const results = [];
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    try {
      const response = await procesarEnvio(contact);
      results.push({ number: contact.number || contact.to, status: "success", response });
    } catch (err) {
      results.push({ number: contact.number || contact.to, status: "error", error: err.message });
    }

    if (i < contacts.length - 1) await delay(delayMs);
  }

  res.json({ success: true, processed: results.length, results });
});

// 404 explícito: así distinguís "ruta inexistente" de "servidor caído".
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`[Servidor Producción] API corriendo en puerto ${PORT} con Supabase`);
});
