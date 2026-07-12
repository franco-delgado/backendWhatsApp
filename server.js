/**
 * server.js
 * Servidor Node.js que conecta con WhatsApp usando Baileys corregido para Render.
 */

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = path.join(__dirname, "auth_info");

// Estado en memoria que consulta el frontend
const state = {
  connectionStatus: "disconnected", // 'disconnected' | 'connecting' | 'qr' | 'connected'
  qrDataUrl: null,
  lastUpdate: Date.now(),
};

let sock; // instancia global del socket de WhatsApp

// FUNCIÓN AUXILIAR PARA BORRAR LA CARPETA DE AUTENTICACIÓN
function limpiarCarpetaAutenticacion() {
  if (fs.existsSync(AUTH_FOLDER)) {
    try {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log("[WhatsApp] Carpeta auth_info eliminada automáticamente.");
    } catch (err) {
      console.error("[WhatsApp] Error al eliminar auth_info:", err);
    }
  }
}

async function startWhatsApp() {
  const { state: authState, saveCreds } =
    await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.connectionStatus = "qr";
      state.qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      state.lastUpdate = Date.now();
      console.log("[WhatsApp] Nuevo QR generado. Escaneá desde /qr");
    }

    if (connection === "connecting") {
      state.connectionStatus = "connecting";
      state.lastUpdate = Date.now();
    }

    if (connection === "open") {
      state.connectionStatus = "connected";
      state.qrDataUrl = null;
      state.lastUpdate = Date.now();
      console.log("[WhatsApp] Conectado correctamente ✅");
    }

    if (connection === "close") {
      state.connectionStatus = "disconnected";
      state.lastUpdate = Date.now();

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        "[WhatsApp] Conexión cerrada. ¿Cerró sesión el usuario?",
        loggedOut,
      );

      if (!loggedOut) {
        // Reintentar conexión automáticamente si se cayó la red
        console.log("[WhatsApp] Reintentando conexión...");
        startWhatsApp();
      } else {
        // SOLUCIÓN: El usuario cerró sesión en el celular. Limpiamos y re-inicializamos para pedir nuevo QR
        console.log(
          "[WhatsApp] Sesión cerrada. Limpiando datos y generando nuevo QR...",
        );
        limpiarCarpetaAutenticacion();
        startWhatsApp();
      }
    }
  });

  return sock;
}

// ---------------------- API REST ----------------------

const app = express();
app.use(cors());
app.use(express.json());

app.get("/status", (req, res) => {
  res.json({
    status: state.connectionStatus,
    lastUpdate: state.lastUpdate,
  });
});

app.get("/qr", (req, res) => {
  if (state.connectionStatus === "connected") {
    return res
      .status(200)
      .json({ message: "Ya está conectado, no hace falta escanear QR." });
  }
  if (!state.qrDataUrl) {
    return res.status(202).json({
      message: "QR aún no generado, esperá unos segundos y reintentá.",
    });
  }
  res.json({ qr: state.qrDataUrl });
});

app.get("/qr/image", (req, res) => {
  if (!state.qrDataUrl) {
    return res.status(404).send("QR no disponible todavía");
  }
  const base64Data = state.qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const imgBuffer = Buffer.from(base64Data, "base64");
  res.setHeader("Content-Type", "image/png");
  res.send(imgBuffer);
});

app.post("/send", async (req, res) => {
  let { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({ success: false, error: "Faltan parámetros" });
  }

  if (!sock || state.connectionStatus !== "connected") {
    return res
      .status(400)
      .json({ success: false, error: "WhatsApp no está conectado." });
  }

  try {
    let formattedNumber = number.replace(/\D/g, "");

    if (!formattedNumber.startsWith("54")) {
      if (formattedNumber.startsWith("15")) {
        formattedNumber = formattedNumber.substring(2);
      }
      formattedNumber = "549" + formattedNumber;
    } else if (
      formattedNumber.startsWith("54") &&
      !formattedNumber.startsWith("549")
    ) {
      formattedNumber = "549" + formattedNumber.substring(2);
    }

    const chatId = formattedNumber + "@s.whatsapp.net";
    console.log(`[Servidor] Baileys enviando mensaje a: ${chatId}`);

    await sock.sendMessage(chatId, { text: message });

    res.json({
      success: true,
      message: "Mensaje enviado con éxito en el servidor.",
    });
  } catch (err) {
    console.error("[Servidor] Error al enviar el mensaje:", err);
    res
      .status(500)
      .json({ success: false, error: "No se pudo entregar el mensaje." });
  }
});

/**
 * POST /logout
 * Cierra la sesión, limpia los archivos físicos y vuelve a iniciar Baileys para dar un QR nuevo.
 */
app.post("/logout", async (req, res) => {
  try {
    state.connectionStatus = "disconnected";
    state.qrDataUrl = null;

    if (sock) {
      // Usamos un try/catch interno por si el socket ya está roto/cerrado externamente
      try {
        await sock.logout();
      } catch (e) {
        console.log("[Servidor] El socket ya estaba desconectado.");
      }
    }

    // Forzamos la limpieza física de la carpeta
    limpiarCarpetaAutenticacion();

    // REINICIO AUTOMÁTICO EN MEMORIA: Creamos la nueva instancia inmediatamente
    startWhatsApp();

    res.json({
      success: true,
      message: "Sesión desvinculada con éxito. El nuevo QR se está generando.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FUNCIÓN DE LIMPIEZA INICIAL AL ARRANCAR EL CONTENEDOR
limpiarCarpetaAutenticacion();

app.listen(PORT, () => {
  console.log(`[Servidor] API corriendo en http://localhost:${PORT}`);
});

startWhatsApp();
