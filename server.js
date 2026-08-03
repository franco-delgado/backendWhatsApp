/**
 * server.js
 * Servidor Node.js para producción con WhatsApp Business Cloud API (Meta).
 */
require("dotenv").config();

const express = require('express');
const cors = require("cors");
const path = require("path");
const { 
  enviarPlantillaWhatsApp, 
  enviarTextoLibreWhatsApp, 
  enviarImagenWhatsApp, 
  enviarDocumentoWhatsApp,
  descargarMediaWhatsApp 
} = require("./whatsappService");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// MIDDLEWARES GENERALES Y CORS
// ==========================================

app.use(cors({
  origin: [
    'https://whatsapp-multidestinos.onrender.com', // Frontend en Render
    'http://localhost:5173',                        // Frontend local (Vite)
    'http://localhost:3000'                         // Pruebas locales
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder'],
  credentials: true
}));

app.use(express.json());

// Servir archivos descargados (Imágenes / Audios) de forma pública
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Middleware para bypass de la pantalla de advertencia de localtunnel
app.use((req, res, next) => {
  res.setHeader('Bypass-Tunnel-Reminder', 'true');
  next();
});

// ==========================================
// ALMACENAMIENTO EN MEMORIA DE MENSAJES
// ==========================================
let mensajesRecibidos = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function procesarEnvio(payload) {
  const number = payload.number || payload.to || payload.phone;
  const type = payload.type || 'template';
  const parameters = payload.parameters || payload.params || [];
  const templateName = payload.templateName || payload.template_name || payload.template;
  const languageCode = payload.languageCode || payload.language_code || 'es_AR';

  if (!number) {
    throw new Error("El parámetro 'number' (o 'to') es obligatorio.");
  }

  switch (type) {
    case 'template':
      console.log(`[procesarEnvio] Solicitado template: "${templateName}" para destino: ${number}`);
      return await enviarPlantillaWhatsApp(number, parameters, templateName, languageCode);
    
    case 'text':
      if (!payload.text) throw new Error("Para mensajes de tipo 'text', el campo 'text' es obligatorio.");
      const contextMessageId = payload.contextMessageId || payload.context_message_id || null;
      return await enviarTextoLibreWhatsApp(number, payload.text, contextMessageId);
    
    case 'image':
      if (!payload.mediaUrl) throw new Error("Para tipo 'image', el campo 'mediaUrl' es obligatorio.");
      return await enviarImagenWhatsApp(number, payload.mediaUrl, payload.caption || '');
    
    case 'document':
      if (!payload.mediaUrl) throw new Error("Para tipo 'document', el campo 'mediaUrl' es obligatorio.");
      return await enviarDocumentoWhatsApp(number, payload.mediaUrl, payload.filename || 'archivo.pdf', payload.caption || '');
    
    default:
      throw new Error(`Tipo de mensaje no soportado: '${type}'. Tipos válidos: template, text, image, document.`);
  }
}

// ENDPOINTS DE UTILIDAD Y SALUD

app.get("/status", (req, res) => {
  res.json({
    status: "connected",
    environment: process.env.NODE_ENV || "production",
    provider: "Meta WhatsApp Cloud API",
    timestamp: new Date().toISOString(),
  });
});

// ENDPOINTS PARA EL FRONTEND (BANDEJA DE ENTRADA)

app.get("/api/mensajes", (req, res) => {
  res.json({
    success: true,
    total: mensajesRecibidos.length,
    data: mensajesRecibidos,
  });
});

app.delete("/api/mensajes", (req, res) => {
  mensajesRecibidos = [];
  res.json({
    success: true,
    message: "Historial de mensajes limpiado.",
  });
});

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

    res.json({
      success: true,
      message: "Respuesta enviada con éxito.",
      data: result,
    });
  } catch (err) {
    console.error("[Servidor] Error en /api/mensajes/responder:", err.message);
    res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

// WEBHOOK PARA META (VERIFICACIÓN Y RECEPCIÓN)

app.get("/webhook", (req, res) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === verifyToken) {
      console.log("[Webhook] Verificado con éxito por Meta.");
      return res.status(200).send(challenge);
    } else {
      console.warn("[Webhook] Falló la verificación. Token incorrecto.");
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// 2. POST /webhook: Para recibir los estados de los mensajes y respuestas de usuarios
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    // Responder a Meta inmediatamente con 200 OK para evitar reintentos duplicados
    res.status(200).send("EVENT_RECEIVED");

    if (body.entry) {
      for (const entry of body.entry) {
        if (!entry.changes) continue;
        for (const change of entry.changes) {
          const value = change.value;

          // Caso A: Notificación de estados de entrega (sent, delivered, read, failed)
          if (value?.statuses) {
            value.statuses.forEach((status) => {
              console.log(`[Status Update] ID: ${status.id} | Estado: ${status.status} | Destino: ${status.recipient_id}`);
              if (status.status === "failed") {
                console.error("[Status Error Details]:", JSON.stringify(status.errors, null, 2));
              }
            });
          }

          // Caso B: El usuario responde un mensaje
          if (value?.messages) {
            for (const msg of value.messages) {
              console.log(`[Mensaje Recibido] De: ${msg.from} | Tipo: ${msg.type}`);
              
              const contactName = value.contacts?.[0]?.profile?.name || "Desconocido";
              let contenido = "";

              // Procesar según el tipo de mensaje recibido
              if (msg.type === "text") {
                contenido = msg.text.body;
              } else if (msg.type === "image" && msg.image?.id) {
                try {
                  contenido = await descargarMediaWhatsApp(msg.image.id);
                } catch (err) {
                  contenido = "[Error al descargar imagen]";
                }
              } else if (msg.type === "audio" && msg.audio?.id) {
                try {
                  contenido = await descargarMediaWhatsApp(msg.audio.id);
                } catch (err) {
                  contenido = "[Error al descargar audio]";
                }
              } else {
                contenido = `[Mensaje de tipo: ${msg.type}]`;
              }

              const nuevoMensaje = {
                id: msg.id,
                from: msg.from,
                nombre: contactName,
                type: msg.type,
                text: contenido, // Si es media, contiene la URL pública local (/uploads/xxx.ext)
                timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
              };

              mensajesRecibidos.unshift(nuevoMensaje);
            }
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// ENDPOINTS DE ENVÍO

app.post("/send", async (req, res) => {
  try {
    const result = await procesarEnvio(req.body);

    res.json({
      success: true,
      message: "Mensaje procesado con éxito.",
      data: result,
    });
  } catch (err) {
    console.error("[Servidor] Error en /send:", err.message);
    res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

app.post("/send-bulk", async (req, res) => {
  const { contacts, delayMs = 200 } = req.body; 

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un arreglo 'contacts' válido y no vacío.",
    });
  }

  const results = [];

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];

    try {
      const response = await procesarEnvio(contact);

      results.push({
        number: contact.number || contact.to,
        status: "success",
        response,
      });
    } catch (err) {
      results.push({
        number: contact.number || contact.to,
        status: "error",
        error: err.message,
      });
    }

    if (i < contacts.length - 1) {
      await delay(delayMs);
    }
  }

  res.json({
    success: true,
    processed: results.length,
    results,
  });
});

app.listen(PORT, () => {
  console.log(`[Servidor Producción] API corriendo en puerto ${PORT}`);
});