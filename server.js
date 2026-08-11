// Servidor Node.js para producción con WhatsApp Business Cloud API (Meta).
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
dns.setDefaultResultOrder("ipv4first");

const express = require('express');
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

// Módulos modularizados
const { descargarMediaWhatsApp } = require("./whatsappService");
const { enviarMensajeFirebase } = require("./conexionFB"); // Conexión a Firebase
const Mensaje = require("./models/Mensaje");              // Modelo MongoDB
const { procesarEnvio } = require("./utils/whatsappProcessor");

const app = express();
const PORT = process.env.PORT || 3000;

// CONEXIÓN A MONGODB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsapp_db';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado exitosamente a la Base de Datos MongoDB'))
  .catch((err) => console.error('❌ Error de conexión a MongoDB:', err.message));

// MIDDLEWARES GENERALES
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder'],
  credentials: true
}));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

app.use((req, res, next) => {
  res.setHeader('Bypass-Tunnel-Reminder', 'true');
  next();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ENDPOINTS DE UTILIDAD Y SALUD
app.get("/status", (req, res) => {
  res.json({
    status: "connected",
    environment: process.env.NODE_ENV || "production",
    provider: "Meta WhatsApp Cloud API",
    timestamp: new Date().toISOString(),
  });
});

// =========================================================================
// ENDPOINTS DE MENSAJES (FRONTEND)
// =========================================================================

// 1. Obtener todos los mensajes
app.get("/api/mensajes", async (req, res) => {
  try {
    const mensajes = await Mensaje.find().sort({ timestamp: -1 });
    res.json({ success: true, total: mensajes.length, data: mensajes });
  } catch (error) {
    console.error("[Servidor] Error al consultar mensajes de BD:", error.message);
    res.status(500).json({ success: false, error: "Error al consultar mensajes." });
  }
});

// 2. Eliminar un mensaje individual por ID (_id de Mongo o id de WhatsApp)
app.delete("/api/mensajes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[DELETE] Solicitud para eliminar mensaje ID: ${id}`);

    // Búsqueda flexible (por _id de Mongo o id string de WhatsApp)
    const orConditions = [{ id: id }];
    if (mongoose.Types.ObjectId.isValid(id)) {
      orConditions.push({ _id: new mongoose.Types.ObjectId(id) });
    }

    const mensajeAEliminar = await Mensaje.findOne({ $or: orConditions });

    if (!mensajeAEliminar) {
      console.log(`[DELETE 404] Mensaje no encontrado con ID: ${id}`);
      return res.status(404).json({ success: false, error: "Mensaje no encontrado." });
    }

    // Borrar archivo adjunto si existía en servidor local
    if (mensajeAEliminar.mediaUrl && mensajeAEliminar.mediaUrl.startsWith('/uploads/')) {
      const rutaArchivo = path.join(__dirname, 'public', mensajeAEliminar.mediaUrl);
      if (fs.existsSync(rutaArchivo)) {
        fs.unlink(rutaArchivo, (err) => {
          if (err) console.error(`[Archivos] Error al eliminar ${rutaArchivo}:`, err);
          else console.log(`🗑️ Archivo local borrado: ${rutaArchivo}`);
        });
      }
    }

    // Borrar el documento de MongoDB
    await Mensaje.deleteOne({ _id: mensajeAEliminar._id });

    console.log(`✅ Mensaje ${id} eliminado con éxito de MongoDB.`);
    return res.json({ success: true, message: "Mensaje eliminado con éxito." });
  } catch (error) {
    console.error("[Servidor] Error al eliminar mensaje individual:", error.message);
    res.status(500).json({ success: false, error: "Error interno al eliminar el mensaje." });
  }
});

// 3. Vaciar todo el historial de mensajes
app.delete("/api/mensajes", async (req, res) => {
  try {
    await Mensaje.deleteMany({});
    res.json({ success: true, message: "Historial de mensajes limpiado de la base de datos." });
  } catch (error) {
    console.error("[Servidor] Error al vaciar historial de BD:", error.message);
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
      type: 'text',
      text: mensaje,
      contextMessageId: contextMessageId || null
    });

    const respuestaId = result?.messages?.[0]?.id || `out_${Date.now()}`;
    const nuevoMensajeOut = {
      id: respuestaId,
      from: 'me',
      to: destinatario,
      nombre: 'Soporte',
      type: 'text_out',
      text: mensaje,
      timestamp: new Date().toISOString()
    };

    // Guardar en MongoDB sin duplicar
    try {
      await Mensaje.updateOne(
        { id: respuestaId },
        { $setOnInsert: nuevoMensajeOut },
        { upsert: true }
      );
    } catch (dbErr) {
      console.error("[MongoDB Outbound Error]:", dbErr.message);
    }

    // Sincronizar en Firebase sin duplicar
    try {
      await enviarMensajeFirebase(nuevoMensajeOut);
      console.log(`🔥 Respuesta ${respuestaId} sincronizada en Firebase.`);
    } catch (fbErr) {
      console.error("[Firebase Outbound Error]:", fbErr);
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
                const contactObj = value.contacts?.find(c => c.wa_id === msg.from);
                const contactName = contactObj?.profile?.name || "Desconocido";
                
                let textoMensaje = "";
                let mediaUrl = "";

                if (msg.type === "text" && msg.text?.body) {
                  textoMensaje = msg.text.body;
                } else if (msg.type === "button" && msg.button?.text) {
                  textoMensaje = msg.button.text;
                } else if (msg.type === "interactive") {
                  textoMensaje = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Respuesta Interactiva]";
                } else if (msg.type === "image" && msg.image?.id) {
                  textoMensaje = msg.image?.caption || "";
                  try { 
                    mediaUrl = await descargarMediaWhatsApp(msg.image.id); 
                  } catch (e) { 
                    console.error("[Media Error Imagen]:", e.message);
                    textoMensaje = "[Error al descargar imagen]"; 
                  }
                } else if (msg.type === "audio" && msg.audio?.id) {
                  try { 
                    mediaUrl = await descargarMediaWhatsApp(msg.audio.id); 
                  } catch (e) { 
                    console.error("[Media Error Audio]:", e.message);
                    textoMensaje = "[Error al descargar audio]"; 
                  }
                } else {
                  textoMensaje = `[Mensaje de tipo: ${msg.type}]`;
                }

                const mensajeId = msg.id || `msg_${Date.now()}`;
                const timestampVal = msg.timestamp ? parseInt(msg.timestamp) * 1000 : Date.now();
                
                const nuevoMensaje = {
                  id: mensajeId,
                  from: msg.from,
                  nombre: contactName,
                  type: msg.type,
                  text: textoMensaje,
                  mediaUrl: mediaUrl,
                  timestamp: new Date(timestampVal).toISOString()
                };

                try {
                  const result = await Mensaje.updateOne(
                    { id: mensajeId },
                    { $setOnInsert: nuevoMensaje },
                    { upsert: true }
                  );
                  if (result.upsertedCount > 0) {
                    console.log(`💾 Nuevo mensaje ${mensajeId} guardado en MongoDB.`);
                  } else {
                    console.log(`ℹ️ Mensaje ${mensajeId} ya existía en MongoDB.`);
                  }
                } catch (dbErr) {
                  console.error("[MongoDB Error]:", dbErr.message);
                }

                try {
                  await enviarMensajeFirebase(nuevoMensaje);
                  console.log(`🔥 Mensaje ${mensajeId} guardado con éxito en Firebase DB_mensajes.`);
                } catch (fbErr) {
                  console.error("[Firebase Error Detallado]:", fbErr);
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
  console.log(`[Servidor Producción] API corriendo en puerto ${PORT}`);
});