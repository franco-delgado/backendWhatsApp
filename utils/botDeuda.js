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

// "27.345.678" / "27,345,678" / "27 345 678" / "DNI: 27345678" -> "27345678"
const extraerDigitos = clientes.limpiarDni;

// Saca el DNI de un mensaje. Antes se juntaban TODOS los dígitos del mensaje, así que
// "mi dni es 27345678 y mi cel 3825123456" daba 18 dígitos y se rechazaba.
//  1) Si todos los dígitos juntos forman un DNI válido ("27.345.678", "DNI: 27345678"), ese es.
//  2) Si hay más números, se toma el que viene después de la palabra "DNI".
//  3) Si no, el único número con forma de DNI (6 a 8 dígitos, no parte de uno más largo).
// Devuelve null si no hay un DNI claro (0 o más de uno).
const GRUPO_DNI = "\\d{1,2}[.,\\s]\\d{3}[.,\\s]\\d{3}|\\d{6,8}";
const RE_DNI_PALABRA = new RegExp(`\\bd\\.?\\s?n\\.?\\s?i\\.?\\D{0,15}?(${GRUPO_DNI})(?!\\d)`, "i");
const RE_DNI_SUELTO = new RegExp(`(?<!\\d)(${GRUPO_DNI})(?!\\d)`, "g");

function extraerDni(texto) {
  const t = String(texto || "");
  const todo = clientes.limpiarDni(t);
  if (clientes.dniValido(todo)) return todo;

  const conPalabra = t.match(RE_DNI_PALABRA);
  if (conPalabra) {
    const d = clientes.limpiarDni(conPalabra[1]);
    if (clientes.dniValido(d)) return d;
  }

  const candidatos = [...new Set([...t.matchAll(RE_DNI_SUELTO)].map((m) => clientes.limpiarDni(m[1])))].filter(
    clientes.dniValido
  );
  return candidatos.length === 1 ? candidatos[0] : null;
}

const formatearMonto = (monto) =>
  "$" + Number(monto).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ¿El último mensaje del bot en esta conversación quedó esperando el DNI?
async function esperandoDni(userId, numero) {
  const { data, error } = await supabase
    .from("messages")
    .select("sender, body, created_at")
    .eq("user_id", userId)
    .ilike("sender", `%${ult10(numero)})`) // mismo filtro que el historial de la IA (entrantes y salientes)
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) {
    console.error("[BotDeuda] No se pudo leer el último mensaje del bot:", error.message);
    return false;
  }
  const ultimo = (data || []).find((m) => String(m.sender || "").startsWith("Soporte ("));
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

// Busca el DNI y arma la respuesta con el total.
async function responderConDni(usuario, numero, dni) {
  const clave = `${usuario.id}:${ult10(numero)}`;
  if (bloqueado(clave)) return MSG_DERIVAR;

  const cliente = await clientes.buscarPorDni(usuario, dni, numero);
  console.log(
    `[BotDeuda] DNI ***${dni.slice(-3)} (${dni.length} díg.) de ${ult10(numero)} -> ` +
      `${cliente ? "ENCONTRADO" : "NO encontrado"} (usuario ${usuario.id}, rol ${usuario.role})`
  );
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
    const hayNumeros = extraerDigitos(texto).length > 0;
    const consulta = esConsultaDeuda(texto);
    const esperando = await esperandoDni(usuario.id, numero);

    if (!consulta && !esperando) return null;

    // Ya mandó (o está mandando) el DNI.
    if (hayNumeros && (esperando || consulta)) {
      // Un mensaje con números que no traen un DNI claro (ej. solo un teléfono o un monto)
      // en plena consulta: se pide de nuevo en vez de buscar basura.
      const dni = extraerDni(texto);
      if (!dni) return esperando ? MSG_DNI_INVALIDO : MSG_PEDIR_DNI;
      return await responderConDni(usuario, numero, dni);
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
  extraerDni,
  formatearMonto,
  MSG_PEDIR_DNI,
  MSG_SIN_DATOS,
};
