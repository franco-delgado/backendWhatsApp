const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const fs = require('fs');
const path = require('path');

let serviceAccount;

// 1. Intentar cargar desde Secret Files de Render (/etc/secrets/serviceAccountKey.json)
const renderSecretPath = '/etc/secrets/serviceAccountKey.json';
// 2. Intentar cargar desde el directorio raíz local
const localPath = path.join(__dirname, 'serviceAccountKey.json');

if (fs.existsSync(renderSecretPath)) {
  serviceAccount = JSON.parse(fs.readFileSync(renderSecretPath, 'utf8'));
} else if (fs.existsSync(localPath)) {
  serviceAccount = require('./serviceAccountKey.json');
} else if (process.env.FIREBASE_CREDENTIALS) {
  serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} else {
  throw new Error('[Firebase Error] No se encontraron credenciales de servicio.');
}

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: 'https://delgadowebs-firebase-default-rtdb.firebaseio.com'
  });
}

const db = getDatabase();

async function enviarMensajeFirebase(mensajeObj) {
  if (!mensajeObj || !mensajeObj.id) {
    throw new Error("[Firebase] El objeto debe incluir un 'id' válido.");
  }

  const mensajeRef = db.ref(`DB_mensajes/${mensajeObj.id}`);

  return await mensajeRef.set({
    ...mensajeObj,
    fechaCreacion: new Date().toISOString()
  });
}

module.exports = {
  enviarMensajeFirebase
};