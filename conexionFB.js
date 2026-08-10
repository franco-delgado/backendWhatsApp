const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const serviceAccount = require('./serviceAccountKey.json');

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

  // Se apunta directamente al nodo del mensaje usando su ID único de WhatsApp
  const mensajeRef = db.ref(`DB_mensajes/${mensajeObj.id}`);

  // .set() crea el nodo o lo actualiza si ya existe, evitando duplicados
  return await mensajeRef.set({
    ...mensajeObj,
    fechaCreacion: new Date().toISOString()
  });
}

module.exports = {
  enviarMensajeFirebase
};