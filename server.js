/**
 * server.js
 * Servidor Node.js para producción con WhatsApp Business Cloud API (Meta).
 */
require("dotenv").config();

const express = require('express');
const cors = require("cors");
const { 
  enviarPlantillaWhatsApp, 
  enviarTextoLibreWhatsApp, 
  enviarImagenWhatsApp, 
  enviarDocumentoWhatsApp 
} = require("./whatsappService");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// MIDDLEWARES GENERALES Y CORS
// ==========================================

app.use(cors({
  origin: '*', // Permite peticiones desde cualquier origen (o mantén tu dominio de frontend)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder'],
  credentials: true
}));

app.use(express.json());

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
      return await enviarPlantillaWhatsApp(
        number, 
        parameters, 
        templateName, 
        languageCode
      );
    
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
      throw new Error(`Tipo de mensaje no soportado: '${type}'.`);
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

app.post("/webhook", (req, res) => {
  try {
    const body = req.body;

    if (body.object === "whatsapp_business_account") {
      // Responder a Meta INMEDIATAMENTE para evitar retries o timeouts (200 OK)
      res.status(200).send("EVENT_RECEIVED");

      body.entry?.forEach((entry) => {
        entry.changes?.forEach((change) => {
          const value = change.value;

          // A: Status updates
          if (value?.statuses) {
            value.statuses.forEach((status) => {
              console.log(`[Status Update] ID: ${status.id} | Estado: ${status.status}`);
            });
          }

          // B: Mensajes entrantes
          if (value?.messages) {
            value.messages.forEach((msg) => {
              // Buscar el nombre del contacto asociado a este numero específico
              const contactObj = value.contacts?.find(c => c.wa_id === msg.from);
              const contactName = contactObj?.profile?.name || "Desconocido";

              // Extraer contenido de forma segura según el tipo
              let contenidoTexto = "";
              if (msg.type === "text" && msg.text?.body) {
                contenidoTexto = msg.text.body;
              } else if (msg.type === "button" && msg.button?.text) {
                contenidoTexto = msg.button.text;
              } else if (msg.type === "interactive") {
                contenidoTexto = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Respuesta Interactiva]";
              } else {
                contenidoTexto = `[Mensaje de tipo: ${msg.type}]`;
              }

              const nuevoMensaje = {
                id: msg.id,
                from: msg.from,
                nombre: contactName,
                type: msg.type,
                text: contenidoTexto,
                timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
              };

              console.log(`[Mensaje Recibido] De: ${contactName} (${msg.from}): ${contenidoTexto}`);

              // Evitar duplicados por reintentos de Meta
              const yaExiste = mensajesRecibidos.some(m => m.id === msg.id);
              if (!yaExiste) {
                mensajesRecibidos.unshift(nuevoMensaje);
              }
            });
          }
        });
      });
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("[Webhook Error]: Fallo al procesar evento:", error);
    // Si la respuesta no fue enviada aún, mandar 200 de todos modos para que Meta no reintente
    if (!res.headersSent) {
      res.status(200).send("EVENT_RECEIVED");
    }
  }
});

// ==========================================
// ENDPOINTS DE ENVÍO
// ==========================================

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
