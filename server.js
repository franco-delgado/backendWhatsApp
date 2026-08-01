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

// Configuración de CORS restringida a los dominios autorizados
app.use(cors({
  origin: [
    'https://whatsapp-multidestinos.onrender.com', // Frontend en Render
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder'],
  credentials: true
}));

app.use(express.json());

// Middleware para bypass de la pantalla de advertencia de localtunnel
app.use((req, res, next) => {
  res.setHeader('Bypass-Tunnel-Reminder', 'true');
  next();
});

// ==========================================
// ALMACENAMIENTO EN MEMORIA DE MENSAJES
// ==========================================
// Mantiene los mensajes recibidos para ser consultados desde el Frontend
let mensajesRecibidos = [];

// Helper para pausar ejecuciones en envíos masivos y no saturar la API de Meta
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Función auxiliar para enrutar según el tipo de mensaje solicitado
async function procesarEnvio(payload) {
  // Extraemos datos tolerando distintas convenciones de nombres desde el frontend
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
      // 🔍 LOG DE CONTROL EN CONSOLA
      console.log(`[procesarEnvio] Solicitado template: "${templateName}" para destino: ${number}`);
      
      return await enviarPlantillaWhatsApp(
        number, 
        parameters, 
        templateName, // Pasa directamente el nombre extraído del cliente
        languageCode
      );
    
    case 'text':
      if (!payload.text) throw new Error("Para mensajes de tipo 'text', el campo 'text' es obligatorio.");
      
      // Capturamos la variable contextMessageId si el frontend la manda para citar mensajes
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

// Obtener todos los mensajes recibidos
app.get("/api/mensajes", (req, res) => {
  res.json({
    success: true,
    total: mensajesRecibidos.length,
    data: mensajesRecibidos,
  });
});

// Vaciar bandeja de entrada
app.delete("/api/mensajes", (req, res) => {
  mensajesRecibidos = [];
  res.json({
    success: true,
    message: "Historial de mensajes limpiado.",
  });
});

// Responder a un mensaje desde la interfaz de React
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

// 1. GET /webhook: Para la verificación inicial del Webhook desde el panel de Meta Developers
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
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    // Responder a Meta inmediatamente con 200 OK para evitar reintentos duplicados
    res.status(200).send("EVENT_RECEIVED");

    // Procesar evento en segundo plano
    body.entry?.forEach((entry) => {
      const changes = entry.changes;
      changes?.forEach((change) => {
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
          value.messages.forEach((msg) => {
            console.log(`[Mensaje Recibido] De: ${msg.from} | Tipo: ${msg.type}`);
            
            // Extraer el nombre del contacto si viene en el payload
            const contactName = value.contacts?.[0]?.profile?.name || "Desconocido";

            const nuevoMensaje = {
              id: msg.id,
              from: msg.from,
              nombre: contactName,
              type: msg.type,
              text: msg.type === "text" ? msg.text.body : `[Mensaje de tipo: ${msg.type}]`,
              timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
            };

            if (msg.type === "text") {
              console.log(`[Texto]: ${msg.text.body}`);
            }

            // Almacenar el mensaje al inicio del arreglo
            mensajesRecibidos.unshift(nuevoMensaje);
          });
        }
      });
    });
  } else {
    res.sendStatus(404);
  }
});

// ==========================================
// ENDPOINTS DE ENVÍO
// ==========================================

// Endpoint de envío individual (soporta plantillas, texto libre, imágenes, PDFs)
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

// Endpoint de envío masivo con control de pacing (delay)
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
      // Pasa el objeto 'contact' entero para que procesarEnvio extraiga todo limpiamente
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

    // Aplicar pausa entre peticiones para respetar Rate Limits
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
