/**
 * server.js
 * Servidor Node.js que conecta con WhatsApp usando Baileys corregido para Render.
 * Incluye verificación dinámica de prefijo 9 en Argentina y retraso inteligente anti-spam.
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

// FUNCIÓN AUXILIAR PARA GENERAR TIEMPOS DE ESPERA (ENTRE 6 Y 8 SEGUNDOS)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        console.log("[WhatsApp] Reintentando conexión...");
        startWhatsApp();
      } else {
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

    // Limpieza inicial: removemos el 15 si el usuario lo ingresó al principio
    if (formattedNumber.startsWith("15")) {
      formattedNumber = formattedNumber.substring(2);
    }

    // Aseguramos que empiece con el código de Argentina (54)
    if (!formattedNumber.startsWith("54")) {
      formattedNumber = "54" + formattedNumber;
    }

    // Armamos las dos variantes posibles en la base de datos de WhatsApp
    let versionCon9 = formattedNumber;
    let versionSin9 = formattedNumber;

    if (!formattedNumber.startsWith("549")) {
      versionCon9 = "549" + formattedNumber.substring(2);
    } else {
      versionSin9 = "54" + formattedNumber.substring(3);
    }

    let jidResult = versionCon9 + "@s.whatsapp.net"; // Por defecto apuntamos a la versión con 9
    console.log(
      `[Servidor] Buscando formato correcto en WhatsApp para: ${number}`,
    );

    // Consultamos al servidor de WhatsApp si existe la versión con '549'
    let [exists] = await sock.onWhatsApp(versionCon9);

    // Si no existe con el 9, le consultamos por el formato viejo sin el 9 ('54')
    if (!exists || !exists.exists) {
      console.log(
        `[Servidor] No se encontró con 549. Probando formato sin 9: ${versionSin9}`,
      );
      [exists] = await sock.onWhatsApp(versionSin9);
    }

    // Si WhatsApp validó cualquiera de los dos formatos, asignamos su JID real
    if (exists && exists.exists) {
      jidResult = exists.jid;
      console.log(`[Servidor] Formato validado por WhatsApp: ${jidResult}`);
    } else {
      console.log(
        `[Servidor] Advertencia: El número no arrojó coincidencias en WhatsApp. Se intentará forzar el envío.`,
      );
    }

    // 🔥 RETARDO INTELIGENTE DE 6 A 8 SEGUNDOS
    // Genera un número aleatorio entre 6000 y 8000 milisegundos
    const tiempoEspera = Math.floor(Math.random() * (8000 - 6000 + 1)) + 6000;
    console.log(
      `[Servidor] Aplicando delay anti-bloqueo de ${(tiempoEspera / 1000).toFixed(1)} segundos...`,
    );
    await delay(tiempoEspera);

    // Ejecutamos el envío real del mensaje
    await sock.sendMessage(jidResult, { text: message });
    console.log(`[Servidor] Mensaje entregado a Baileys para: ${jidResult}`);

    res.json({
      success: true,
      message: "Mensaje enviado con éxito en el servidor.",
      targetJid: jidResult,
    });
  } catch (err) {
    console.error("[Servidor] Error al enviar el mensaje:", err);
    res
      .status(500)
      .json({ success: false, error: "No se pudo entregar el mensaje." });
  }
});

app.post("/logout", async (req, res) => {
  try {
    state.connectionStatus = "disconnected";
    state.qrDataUrl = null;

    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.log("[Servidor] El socket ya estaba desconectado.");
      }
    }

    limpiarCarpetaAutenticacion();
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
