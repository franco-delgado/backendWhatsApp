/**
 * server.js
 * Servidor Node.js que conecta con WhatsApp (protocolo WhatsApp Web) usando Baileys,
 * genera un código QR para vincular el número, y expone una API REST simple
 * para que un frontend (React u otro) pueda:
 *   - Ver el estado de conexión
 *   - Obtener el QR como imagen
 *   - Enviar mensajes de WhatsApp
 *
 * Uso:
 *   1) npm install
 *   2) node server.js
 *   3) Abrir http://TU_SERVIDOR:3000/qr en el navegador (o consumirlo desde React)
 *   4) Escanear el QR con WhatsApp > Dispositivos vinculados > Vincular dispositivo
 */

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = path.join(__dirname, 'auth_info'); // acá se guarda la sesión (no borrar mientras esté en uso)

// Estado en memoria que consulta el frontend
const state = {
  connectionStatus: 'disconnected', // 'disconnected' | 'connecting' | 'qr' | 'connected'
  qrDataUrl: null,                  // imagen QR en base64 (data URL), lista para <img src="..." />
  lastUpdate: Date.now(),
};

let sock; // instancia global del socket de WhatsApp

async function startWhatsApp() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    logger: pino({ level: 'silent' }), // cambiar a 'info' o 'debug' si necesitás ver logs detallados
    printQRInTerminal: false, // lo manejamos nosotros para convertirlo en imagen
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Se generó un nuevo QR: lo convertimos a imagen base64 para servirlo por HTTP
      state.connectionStatus = 'qr';
      state.qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      state.lastUpdate = Date.now();
      console.log('[WhatsApp] Nuevo QR generado. Escaneá desde /qr');
    }

    if (connection === 'connecting') {
      state.connectionStatus = 'connecting';
      state.lastUpdate = Date.now();
    }

    if (connection === 'open') {
      state.connectionStatus = 'connected';
      state.qrDataUrl = null; // ya no hace falta el QR
      state.lastUpdate = Date.now();
      console.log('[WhatsApp] Conectado correctamente ✅');
    }

    if (connection === 'close') {
      state.connectionStatus = 'disconnected';
      state.lastUpdate = Date.now();

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log('[WhatsApp] Conexión cerrada. ¿Cerró sesión el usuario?', loggedOut);

      if (!loggedOut) {
        // Reintentar conexión automáticamente (ej: se cayó la red)
        console.log('[WhatsApp] Reintentando conexión...');
        startWhatsApp();
      } else {
        // El usuario desvinculó el dispositivo desde el celular: hay que volver a escanear QR
        console.log('[WhatsApp] Sesión cerrada. Borrá la carpeta auth_info y reiniciá para generar un nuevo QR.');
      }
    }
  });

  return sock;
}

// ---------------------- API REST ----------------------

const app = express();
app.use(cors());          // permite que tu React (en otro puerto/dominio) consuma esta API
app.use(express.json());

/**
 * GET /status
 * Devuelve el estado actual de la conexión.
 * El frontend puede hacer polling cada 2-3 segundos a este endpoint.
 */
app.get('/status', (req, res) => {
  res.json({
    status: state.connectionStatus, // 'disconnected' | 'connecting' | 'qr' | 'connected'
    lastUpdate: state.lastUpdate,
  });
});

/**
 * GET /qr
 * Devuelve el QR como JSON con la imagen en base64 (data URL),
 * lista para usar directamente en un <img src={qrDataUrl} />.
 */
app.get('/qr', (req, res) => {
  if (state.connectionStatus === 'connected') {
    return res.status(200).json({ message: 'Ya está conectado, no hace falta escanear QR.' });
  }
  if (!state.qrDataUrl) {
    return res.status(202).json({ message: 'QR aún no generado, esperá unos segundos y reintentá.' });
  }
  res.json({ qr: state.qrDataUrl });
});

/**
 * GET /qr/image
 * Igual que /qr pero devuelve directamente la imagen PNG (útil para probar en el navegador
 * poniendo la URL directa, ej: http://localhost:3000/qr/image).
 */
app.get('/qr/image', (req, res) => {
  if (!state.qrDataUrl) {
    return res.status(404).send('QR no disponible todavía');
  }
  const base64Data = state.qrDataUrl.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(imgBuffer);
});

/**
 * POST /send
 * Body JSON: { "number": "5491122334455", "message": "Hola desde la API" }
 * El número va sin "+" y sin espacios, con código de país incluido.
 */
app.post('/send', async (req, res) => {
  try {
    const { number, message } = req.body;

    if (!number || !message) {
      return res.status(400).json({ error: 'Faltan los campos "number" y/o "message".' });
    }

    if (state.connectionStatus !== 'connected') {
      return res.status(409).json({ error: 'WhatsApp no está conectado todavía. Escaneá el QR primero.' });
    }

    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });

    res.json({ success: true, to: number });
  } catch (err) {
    console.error('[Error /send]', err);
    res.status(500).json({ error: 'Error al enviar el mensaje.', details: err.message });
  }
});

/**
 * POST /logout
 * Cierra la sesión actual de WhatsApp (borra credenciales) para poder vincular otro número.
 */
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }
    state.connectionStatus = 'disconnected';
    state.qrDataUrl = null;
    res.json({ success: true, message: 'Sesión cerrada. Reiniciá el servidor para generar un nuevo QR.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Servidor] API corriendo en http://localhost:${PORT}`);
  console.log(`[Servidor] Endpoints: GET /status | GET /qr | GET /qr/image | POST /send | POST /logout`);
});

startWhatsApp();
