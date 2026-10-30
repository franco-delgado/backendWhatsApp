// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Apuntamos correctamente a botDeuda dentro de la carpeta utils
const botDeuda = require('./utils/botDeuda');

async function ejecutarPrueba() {
  console.log("--- INICIANDO PRUEBA LOCAL DE BOT DEUDA ---");

  // Simula un objeto de usuario de tu base de datos
  const usuarioSimulado = { id: "1" }; 
  const numeroCliente = "5493825123456"; // Número de teléfono de prueba

  // PRUEBA 1: Simular que el cliente pregunta por su deuda
  const mensaje1 = "Hola, ¿cuánto tengo que pagar?";
  console.log(`\nCliente dice: "${mensaje1}"`);
  
  const respuesta1 = await botDeuda.procesar({
    usuario: usuarioSimulado,
    numero: numeroCliente,
    texto: mensaje1
  });
  console.log(`Bot responde:\n${respuesta1}`);

  // PRUEBA 2: Simular que el cliente envía su DNI de prueba
  const mensaje2 = "Mi DNI es 27345678";
  console.log(`\nCliente dice: "${mensaje2}"`);
  
  const respuesta2 = await botDeuda.procesar({
    usuario: usuarioSimulado,
    numero: numeroCliente,
    texto: mensaje2
  });
  console.log(`Bot responde:\n${respuesta2}`);
}

ejecutarPrueba();