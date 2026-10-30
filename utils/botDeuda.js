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

// Saca el DNI de un mensaje libre y devuelve SOLO dígitos.
//   "27345678" / "27.345.678" / "27,345,678" / "27 345 678" / "DNI: 27345678"   -> "27345678"
//   "tengo 2 hijos, mi dni es 27345678"                                          -> "27345678"
//   "mi tel es 3825123456 y mi dni 27.345.678"                                   -> "27345678"
// Antes se juntaban TODOS los números del mensaje, así que cualquier otro número
// ("2 hijos", un teléfono...) rompía la lectura del DNI.
// Si no hay ningún número con forma de DNI, devuelve todos los dígitos juntos
// (el llamador los rechaza por inválidos) o "" si no hay ninguno.
function extraerDni(texto) {
  const t = String(texto ?? "");
  const grupos = t.match(/\d+(?:[.,\s]\d+)*/g) || []; // "27.345.678", "27 345 678", "2", "3825123456"
  for (const g of grupos) {
    const junto = clientes.limpiarDni(g);
    if (clientes.dniValido(junto)) return junto;
  }
  // Un grupo pegado a otro número ("27345678 3825123456"): se prueba número por número.
  for (const n of t.match(/\d+/g) || []) {
    if (clientes.dniValido(n)) return n;
  }
  return clientes.limpiarDni(t);
}
const extraerDigitos = extraerDni;

const formatearMonto = (monto) =>
  "$" + Number(monto).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Nombre y apellido tal como están en la agenda, listos para WhatsApp: sin saltos de línea
// ni asteriscos (que romperían el *negrita*) y con un largo razonable.
function nombreCompleto(cliente) {
  return `${cliente.nombre || ""} ${cliente.apellido || ""}`
    .replace(/[\r\n\t*_~`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// Marca en memoria de "le pedí el DNI a este número". Es un respaldo del historial de la
// base: cubre el caso en que el cliente contesta antes de que el pedido quede guardado,
// o en que la lectura del historial falla. Se pierde al reiniciar; la base cubre ese caso.
const esperas = new Map(); // últimos 10 dígitos -> timestamp
const marcarEspera = (numero) => esperas.set(ult10(numero), Date.now());
const limpiarEspera = (numero) => esperas.delete(ult10(numero));
function esperaEnMemoria(numero) {
  const t = esperas.get(ult10(numero));
  if (!t) return false;
  if (Date.now() - t > VENTANA_ESPERA_MS) {
    esperas.delete(ult10(numero));
    return false;
  }
  return true;
}

// Supabase puede devolver la fecha sin zona horaria ("2026-10-30T06:00:00"): JavaScript la
// tomaría como hora local del servidor y el pedido de DNI parecería vencido (o del futuro).
// Las fechas de la base están en UTC, así que se fuerza.
function aMs(fecha) {
  const s = String(fecha || "");
  return new Date(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(s) ? s : s.replace(" ", "T") + "Z").getTime();
}

// ¿Le pedimos el DNI a este cliente y todavía está vigente el pedido?
// Se mira el último mensaje del bot en esa conversación (se identifica por el número, no por
// el usuario: así no depende de a qué usuario quedó asignado el contacto).
async function esperandoDni(numero) {
  if (esperaEnMemoria(numero)) return true;

  const { data, error } = await supabase
    .from("messages")
    .select("body, created_at")
    .ilike("sender", `Soporte (%${ult10(numero)})`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[BotDeuda] No se pudo leer el último mensaje del bot:", error.message);
    return false;
  }
  const ultimo = data?.[0];
  if (!ultimo) return false;
  const reciente = Date.now() - aMs(ultimo.created_at) < VENTANA_ESPERA_MS;
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

// Busca el DNI y arma la respuesta con el total.
async function responderConDni(usuario, numero, dni) {
  const clave = `${usuario.id}:${ult10(numero)}`;
  if (bloqueado(clave)) return MSG_DERIVAR;

  const cliente = await clientes.buscarPorDni(usuario, dni, numero);
  if (!cliente) {
    anotarFallo(clave);
    // Diagnóstico (sin el DNI completo): ayuda a distinguir "no existe" de "está en la agenda de otro usuario".
    const enOtra = await clientes.existeEnOtraAgenda(usuario, dni);
    console.warn(
      `[BotDeuda] DNI ***${dni.slice(-3)} no encontrado para el usuario ${usuario.id}` +
        (enOtra ? " (existe en la agenda de OTRO usuario)" : " (no existe en ninguna agenda)")
    );
    return bloqueado(clave) ? MSG_DERIVAR : MSG_NO_ENCONTRADO;
  }

  fallos.delete(clave);
  limpiarEspera(numero); // ya se resolvió: un número posterior no se toma como DNI
  const nombre = nombreCompleto(cliente);
  const saludo = nombre ? `Verifiqué tu DNI ✅ *${nombre}*` : "Verifiqué tu DNI ✅";

  if (cliente.monto <= 0) {
    return `${saludo}\nActualmente no registrás ningún monto pendiente de pago.`;
  }
  return (
    `${saludo}\n` +
    `El total a pagar es de *${formatearMonto(cliente.monto)}*.\n` +
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
    const digitos = extraerDni(texto);
    const consulta = esConsultaDeuda(texto);
    const esperando = await esperandoDni(numero);

    console.log(
      `[BotDeuda] ${ult10(numero)} | consulta=${consulta} esperandoDni=${esperando} ` +
        `digitosLeidos=${digitos.length}`
    );

    if (!consulta && !esperando) return null;

    // Ya mandó (o está mandando) el DNI.
    if (digitos.length > 0 && (esperando || consulta)) {
      // Un mensaje con muchos números que no es un DNI (ej. un teléfono o un monto) en
      // plena consulta: se pide de nuevo en vez de buscar basura.
      if (!clientes.dniValido(digitos)) {
        marcarEspera(numero);
        return esperando ? MSG_DNI_INVALIDO : MSG_PEDIR_DNI;
      }
      return await responderConDni(usuario, numero, digitos);
    }

    // Pregunta por su saldo y todavía no dio el DNI.
    if (consulta) {
      marcarEspera(numero);
      return MSG_PEDIR_DNI;
    }

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
  extraerDni,
  marcarEspera,
  formatearMonto,
  MSG_PEDIR_DNI,
  MSG_SIN_DATOS,
};
