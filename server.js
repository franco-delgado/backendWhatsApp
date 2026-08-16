// Servidor Node.js para producción con WhatsApp Business Cloud API (Meta) y Supabase
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");


// Módulos modularizados
const { descargarMediaWhatsApp } = require("./whatsappService");
const { procesarEnvio } = require("./utils/whatsappProcessor");

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================
// CONEXIÓN A SUPABASE
// =========================================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Usa la Service Role Key para evitar bloqueos por RLS

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Faltan las variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el archivo .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log("✅ Conectado exitosamente a Supabase");

// MIDDLEWARES GENERALES
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Bypass-Tunnel-Reminder"],
    credentials: true,
  })
);

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Bypass-Tunnel-Reminder", "true");
  next();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ENDPOINT DE ESTADO / SALUD
app.get("/status", (req, res) => {
  res.json({
    status: "connected",
    environment: process.env.NODE_ENV || "production",
    provider: "Meta WhatsApp Cloud API + Supabase",
    timestamp: new Date().toISOString(),
  });
});

// =========================================================================
// ENDPOINTS DE MENSAJES (FRONTEND / API REST)
// =========================================================================

// 1. Obtener todos los mensajes ordenados por fecha de creación
app.get("/api/mensajes", async (req, res) => {
  try {
    const { data: mensajes, error } = await supabase
      .from("mensajes")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ success: true, total: mensajes.length, data: mensajes });
  } catch (error) {
    console.error("[Servidor] Error al consultar mensajes de Supabase:", error.message);
    res.status(500).json({ success: false, error: "Error al consultar mensajes." });
  }
});

// 2. Eliminar un mensaje individual por ID
app.delete("/api/mensajes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[DELETE] Solicitud para eliminar mensaje ID: ${id}`);

    // Eliminar por UUID de Supabase o por identificador de la columna 'id'
    const { data, error } = await supabase
      .from("mensajes")
      .delete()
      .or(`id.eq.${id},identificacion.eq.${id}`)
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      console.log(`[DELETE 404] Mensaje no encontrado con ID: ${id}`);
      return res.status(404).json({ success: false, error: "Mensaje no encontrado." });
    }

    console.log(`✅ Mensaje ${id} eliminado con éxito de Supabase.`);
    return res.json({ success: true, message: "Mensaje eliminado con éxito." });
  } catch (error) {
    console.error("[Servidor] Error al eliminar mensaje individual:", error.message);
    res.status(500).json({ success: false, error: "Error interno al eliminar el mensaje." });
  }
});

// 3. Vaciar todo el historial de mensajes
app.delete("/api/mensajes", async (req, res) => {
  try {
    // Borrado general filtrando por registros cuyo ID exista
    const { error } = await supabase
      .from("mensajes")
      .delete()
      .neq("remitente", "___DUMMY_FILTER___");

    if (error) throw error;

    res.json({ success: true, message: "Historial de mensajes limpiado de Supabase." });
  } catch (error) {
    console.error("[Servidor] Error al vaciar historial de Supabase:", error.message);
    res.status(500).json({ success: false, error: "Error al limpiar historial." });
  }
});

// 4. Responder a un mensaje
app.post("/api/mensajes/responder", async (req, res) => {
  try {
    const { to, number, messageText, text, contextMessageId } = req.body;
    const destinatario = to || number;
    const mensaje = messageText || text;

    if (!destinatario || !mensaje) {
      return res.status(400).json({
        success: false,
        error: "Los campos 'to' (o 'number') y 'messageText' (o 'text') son obligatorios.",
      });
    }

    const result = await procesarEnvio({
      to: destinatario,
      type: "text",
      text: mensaje,
      contextMessageId: contextMessageId || null,
    });

    const respuestaId = result?.messages?.[0]?.id || `out_${Date.now()}`;

    // Guardar respuesta en Supabase
    const { error: sbErr } = await supabase.from("mensajes").insert([
      {
        remitente: `Soporte (${destinatario})`,
        cuerpo: mensaje,
        URL_de_medios: null,
        tipo_mime: "text/plain",
      },
    ]);

    if (sbErr) {
      console.error("[Supabase Outbound Error]:", sbErr.message);
    } else {
      console.log(`⚡ Respuesta ${respuestaId} guardada en Supabase.`);
    }

    res.json({ success: true, message: "Respuesta enviada con éxito.", data: result });
  } catch (err) {
    console.error("[Servidor] Error en /api/mensajes/responder:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// =========================================================================
// WEBHOOK DE META (WHATSAPP CLOUD API)
// =========================================================================

app.get("/webhook", (req, res) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === verifyToken) {
    console.log("[Webhook] Verificado con éxito por Meta.");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object === "whatsapp_business_account") {
      res.status(200).send("EVENT_RECEIVED");

      if (body.entry) {
        for (const entry of body.entry) {
          if (!entry.changes) continue;
          for (const change of entry.changes) {
            const value = change.value;

            if (value?.statuses) {
              value.statuses.forEach((status) => {
                console.log(`[Status Update] ID: ${status.id} | Estado: ${status.status}`);
              });
            }

            if (value?.messages) {
              for (const msg of value.messages) {
                const contactObj = value.contacts?.find((c) => c.wa_id === msg.from);
                const contactName = contactObj?.profile?.name || "Desconocido";

                let textoMensaje = "";
                let mediaUrl = null;
                let mimeType = "text/plain";

                // TEXTO O BOTONES
                if (msg.type === "text" && msg.text?.body) {
                  textoMensaje = msg.text.body;
                  mimeType = "text/plain";
                } else if (msg.type === "button" && msg.button?.text) {
                  textoMensaje = msg.button.text;
                } else if (msg.type === "interactive") {
                  textoMensaje =
                    msg.interactive?.button_reply?.title ||
                    msg.interactive?.list_reply?.title ||
                    "[Respuesta Interactiva]";

                // IMÁGENES / STICKERS
                } else if ((msg.type === "image" && msg.image?.id) || (msg.type === "sticker" && msg.sticker?.id)) {
                  const mediaData = msg.image || msg.sticker;
                  textoMensaje = mediaData?.caption || "";
                  mimeType = mediaData?.mime_type || "image/jpeg";
                  try {
                    mediaUrl = await descargarMediaWhatsApp(mediaData.id, mimeType);
                  } catch (e) {
                    console.error("[Media Error Imagen]:", e.message);
                    textoMensaje = "[Error al descargar imagen]";
                  }

                // AUDIOS Y NOTAS DE VOZ
                } else if ((msg.type === "audio" && msg.audio?.id) || (msg.type === "voice" && msg.voice?.id)) {
                  const mediaData = msg.audio || msg.voice;
                  mimeType = mediaData?.mime_type || "audio/ogg";
                  try {
                    mediaUrl = await descargarMediaWhatsApp(mediaData.id, mimeType);
                  } catch (e) {
                    console.error("[Media Error Audio]:", e.message);
                    textoMensaje = "[Error al descargar audio]";
                  }

                // DOCUMENTOS
                } else if (msg.type === "document" && msg.document?.id) {
                  textoMensaje = msg.document?.caption || msg.document?.filename || "";
                  mimeType = msg.document?.mime_type || "application/pdf";
                  try {
                    mediaUrl = await descargarMediaWhatsApp(msg.document.id, mimeType);
                  } catch (e) {
                    console.error("[Media Error Documento]:", e.message);
                    textoMensaje = "[Error al descargar documento]";
                  }

                // VIDEOS
                } else if (msg.type === "video" && msg.video?.id) {
                  textoMensaje = msg.video?.caption || "";
                  mimeType = msg.video?.mime_type || "video/mp4";
                  try {
                    mediaUrl = await descargarMediaWhatsApp(msg.video.id, mimeType);
                  } catch (e) {
                    console.error("[Media Error Video]:", e.message);
                    textoMensaje = "[Error al descargar video]";
                  }

                } else {
                  textoMensaje = `[Mensaje de tipo: ${msg.type}]`;
                }

                const mensajeId = msg.id || `msg_${Date.now()}`;

                // Insertar directamente en la tabla 'mensajes' de Supabase
                try {
                  const { error: sbErr } = await supabase.from("mensajes").insert([
                    {
                      remitente: `${contactName} (${msg.from})`,
                      cuerpo: textoMensaje,
                      URL_de_medios: mediaUrl,
                      tipo_mime: mimeType,
                    },
                  ]);

                  if (sbErr) {
                    console.error("[Supabase Error]:", sbErr.message);
                  } else {
                    console.log(`⚡ Mensaje ${mensajeId} guardado con éxito en Supabase.`);
                  }
                } catch (dbErr) {
                  console.error("[Supabase Insert Exception]:", dbErr.message);
                }
              }
            }
          }
        }
      }
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("[Webhook Error]:", error);
    if (!res.headersSent) res.status(200).send("EVENT_RECEIVED");
  }
});

// =========================================================================
// ENDPOINTS DE ENVÍO MASIVO / INDIVIDUAL
// =========================================================================

app.post("/send", async (req, res) => {
  try {
    const result = await procesarEnvio(req.body);
    res.json({ success: true, message: "Mensaje procesado con éxito.", data: result });
  } catch (err) {
    console.error("[Servidor] Error en /send:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/send-bulk", async (req, res) => {
  const { contacts, delayMs = 200 } = req.body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ success: false, error: "Se requiere un arreglo 'contacts' válido." });
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

app.listen(PORT, () => {
  console.log(`[Servidor Producción] API corriendo en puerto ${PORT} con Supabase`);
});