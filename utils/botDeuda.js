// Consulta de saldo por WhatsApp, resuelta por el servidor (NO por la IA).
//
// Flujo:
//   1. El cliente pregunta cuánto debe / cuánto tiene que pagar.
//   2. El bot le pide su DNI sin puntos ni comas.
//   3. El cliente lo envía (con o sin puntos, espacios, texto alrededor...): se
//      dejan solo los dígitos y se compara con los DNI de la agenda.
//   4. Si lo encuentra, le informa el total a pagar.
//
// El monto lo arma el servidor leyendo la base. La IA nunca lo ve ni lo inventa.
// No hay estado en memoria que se pierda: "estamos esperando el DNI" se deduce de que
// el último mensaje del bot en esa conversación fue el pedido de DNI (hace poco).
const { supabase } = require("../supabaseClient");
const clientes = require("./clientes");

// Frase que está en TODOS los mensajes que dejan al bot esperando un DNI.
// Sirve para reconocerlos en el historial; no la cambies sin cambiar los textos.
const FRASE_ESPERA = "sin puntos ni comas";

const MSG_PEDIR_DNI =
  "Para consultar el total a pagar necesito tu número de DNI 🙂\n" +
  "Enviámelo sin puntos ni comas (por ejemplo: 27345678).";

const MSG_DNI_INVALIDO =
  "No pude leer un DNI válido. Tiene que tener entre 6 y 8 números, " +
  "enviado sin puntos ni comas (por ejemplo: 27345678).";

const MSG_NO_ENCONTRADO =
  "No encontré ese DNI en nuestros registros 😕\n" +
  "Revisalo y enviámelo de nuevo, sin puntos ni comas.";

const MSG_DERIVAR =
  "No pude verificar tu DNI. En cuanto sea posible un representante se estará comunicando con vos.";

const MSG_SIN_DATOS =
  "Actualmente no tengo ese dato disponible pero en cuanto sea posible un representante se estará comunicando.";

const VENTANA_ESPERA_MS = 30 * 60 * 1000; // el pedido de DNI "vale" 30 minutos
const MAX_FALLOS = 5; // DNI incorrectos por conversación...
const BLOQUEO_MS = 60 * 60 * 1000; // ...por hora (frena a quien prueba DNI al azar)
const fallos = new Map(); // "userId:ult10" -> { n, desde }

const ult10 = (n) => String(n || "").replace(/\D/g, "").slice(-10);

// ¿El mensaje pregunta por lo que debe / el monto a pagar?
// Se excluye "cuenta" suelta: "quiero abrir la cuenta" no es una consulta de saldo.
const RE_CONSULTA =
  /\b(cu[aá]nto\s+(debo|tengo|es|son|sale|me\s+toca|hay|pago|abono|adeudo)|cu[aá]nto\s+.{0,25}(pagar|abonar|deuda)|monto|saldo|deuda|adeudo|debo|abonar|total\s+a\s+pagar|importe|resumen\s+de\s+(mi\s+)?cuenta)\b/i;

function esConsultaDeuda(texto) {
  const t = String(texto || "");
  if (/\b(abrir|apertura|requisito)/i.test(t) && !/\b(debo|deuda|saldo|abonar)\b/i.test(t)) {
    return false;
  }
  return RE_CONSULTA.test(t);
}

// Solo dígitos de TODO el texto: sirve para saber si el mensaje trae algún número.
const extraerDigitos = clientes.limpiarDni;

// Busca el/los posibles DNI dentro del mensaje. Antes se juntaban TODOS los dígitos del
// texto, así que "mi dni es 27345678, tengo 35 años" o "27345678 y mi cel es 3825123456"
// daba un número de 10+ dígitos, se rechazaba como DNI inválido y el bot nunca lo buscaba.
//
// Reconoce "27345678", "27.345.678", "27,345,678", "27 345 678", "DNI: 27345678".
// Devuelve hasta MAX_CANDIDATOS números de 6 a 8 dígitos, primero los que van pegados a
// la palabra "DNI"/"documento" y después el resto, de izquierda a derecha.
const MAX_CANDIDATOS = 3; // tope: frena a quien manda muchos números para probar DNI al azar
const RE_TRAMO_NUMERICO = /\d(?:[\d.,\-\s]*\d)?/g;
const RE_ROTULO_DNI = /(?:d\.?\s?n\.?\s?i\.?|documento)\W{0,4}$/i;

function extraerCandidatosDni(texto) {
  const t = String(texto || "");
  const rotulados = [];
  const otros = [];
  const vistos = new Set();

  const agregar = (digitos, rotulado) => {
    if (!clientes.dniValido(digitos) || vistos.has(digitos)) return;
    vistos.add(digitos);
    (rotulado ? rotulados : otros).push(digitos);
  };

  for (const m of t.matchAll(RE_TRAMO_NUMERICO)) {
    const tramo = m[0];
    const rotulado = RE_ROTULO_DNI.test(t.slice(Math.max(0, m.index - 12), m.index));

    // 1) El tramo completo: "27.345.678" o "27 345 678" (puntos/espacios dentro del DNI).
    const completo = clientes.limpiarDni(tramo);
    if (clientes.dniValido(completo)) {
      agregar(completo, rotulado);
      continue;
    }
    // 2) Si el tramo mezcla varios números ("27345678 3825123456"), cada uno por separado.
    for (const parte of tramo.split(/\s+/)) agregar(clientes.limpiarDni(parte), rotulado);
  }

  return [...rotulados, ...otros].slice(0, MAX_CANDIDATOS);
}

const formatearMonto = (monto) =>
  "$" + Number(monto).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ¿El último mensaje del bot en esta conversación quedó esperando el DNI?
async function esperandoDni(userId, numero) {
  const { data, error } = await supabase
    .from("messages")
    .select("body, created_at")
    .eq("user_id", userId)
    .ilike("sender", `Soporte (%${ult10(numero)})`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[BotDeuda] No se pudo leer el último mensaje del bot:", error.message);
    return false;
  }
  const ultimo = data?.[0];
  if (!ultimo) return false;
  const reciente = Date.now() - new Date(ultimo.created_at).getTime() < VENTANA_ESPERA_MS;
  return reciente && String(ultimo.body || "").includes(FRASE_ESPERA);
}

function bloqueado(clave) {
  const f = fallos.get(clave);
  if (!f) return false;
  if (Date.now() - f.desde > BLOQUEO_MS) {
    fallos.delete(clave);
    return false;
  }
  return f.n >= MAX_FALLOS;
}
function anotarFallo(clave) {
  const f = fallos.get(clave);
  if (!f || Date.now() - f.desde > BLOQUEO_MS) fallos.set(clave, { n: 1, desde: Date.now() });
  else f.n++;
}

// Busca el DNI y arma la respuesta con el total. `candidatos` es la lista de posibles
// DNI del mensaje; se usa el primero que esté en la agenda. Un mensaje cuenta como UN
// solo intento fallido aunque traiga varios números.
async function responderConDni(usuario, numero, candidatos) {
  const clave = `${usuario.id}:${ult10(numero)}`;
  if (bloqueado(clave)) return MSG_DERIVAR;

  let cliente = null;
  for (const dni of candidatos) {
    cliente = await clientes.buscarPorDni(usuario, dni);
    if (cliente) break;
  }
  if (!cliente) {
    anotarFallo(clave);
    return bloqueado(clave) ? MSG_DERIVAR : MSG_NO_ENCONTRADO;
  }

  fallos.delete(clave);
  if (cliente.monto <= 0) {
    return "Verifiqué tu DNI y actualmente no registrás ningún monto pendiente de pago ✅";
  }
  return (
    `Verifiqué tu DNI ✅ El total a pagar es de *${formatearMonto(cliente.monto)}*.\n` +
    "Recordá abonar antes del día 15 para evitar el recargo de intereses."
  );
}

/**
 * Decide si este mensaje es parte de la consulta de saldo.
 * @returns {Promise<string|null>} el texto a enviar, o null si NO es una consulta
 *   de saldo (en ese caso el mensaje sigue su camino normal hacia la IA).
 */
async function procesar({ usuario, numero, texto }) {
  try {
    const digitos = extraerDigitos(texto);
    const consulta = esConsultaDeuda(texto);
    const esperando = await esperandoDni(usuario.id, numero);

    if (!consulta && !esperando) return null;

    // Ya mandó (o está mandando) el DNI.
    if (digitos.length > 0 && (esperando || consulta)) {
      // Se busca el DNI DENTRO del mensaje (puede venir con texto u otros números).
      // Si no hay ningún número que pueda ser un DNI (ej. solo un monto o una edad),
      // se pide de nuevo en vez de buscar basura.
      const candidatos = extraerCandidatosDni(texto);
      if (candidatos.length === 0) return esperando ? MSG_DNI_INVALIDO : MSG_PEDIR_DNI;
      return await responderConDni(usuario, numero, candidatos);
    }

    // Pregunta por su saldo y todavía no dio el DNI.
    if (consulta) return MSG_PEDIR_DNI;

    // Estábamos esperando el DNI pero el mensaje no trae números: es otro tema,
    // dejamos que siga el flujo normal.
    return null;
  } catch (e) {
    console.error("[BotDeuda] Error en la consulta de saldo:", e.message);
    return MSG_SIN_DATOS;
  }
}

module.exports = {
  procesar,
  esConsultaDeuda,
  extraerDigitos,
  extraerCandidatosDni,
  formatearMonto,
  MSG_PEDIR_DNI,
  MSG_SIN_DATOS,
};
