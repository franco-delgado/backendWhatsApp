// Consulta de saldo por WhatsApp, resuelta por el servidor (NO por la IA).
//
// Flujo:
//   1. El cliente pregunta cuánto debe / cuánto tiene que pagar.
//   2. El bot le pide su DNI (sin puntos ni comas) o su nombre y apellido.
//   3. El cliente responde:
//      - DNI (con o sin puntos, espacios, texto alrededor...): se dejan solo los dígitos
//        y se compara con los DNI de la agenda.
//      - Nombre y apellido: se compara (sin tildes ni mayúsculas) con la agenda. Solo se
//        responde si coincide UN solo cliente; si hay homónimos se pide el DNI, para no
//        informar la deuda de otra persona.
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
  "Para consultar el total a pagar necesito tu número de DNI o tu nombre y apellido 🙂\n" +
  "Si es el DNI, enviámelo sin puntos ni comas (por ejemplo: 27345678).";

const MSG_DNI_INVALIDO =
  "No pude leer un DNI válido. Tiene que tener entre 6 y 8 números, " +
  "enviado sin puntos ni comas (por ejemplo: 27345678).";

const MSG_NO_ENCONTRADO =
  "No encontré ese DNI en nuestros registros 😕\n" +
  "Revisalo y enviámelo de nuevo, sin puntos ni comas.";

const MSG_NOMBRE_NO_ENCONTRADO =
  "No encontré ese nombre en nuestros registros 😕\n" +
  "Revisalo, o enviame tu DNI sin puntos ni comas.";

const MSG_NOMBRE_AMBIGUO =
  "Encontré más de un cliente con ese nombre 🙂 Para estar seguros de que es tu cuenta, " +
  "enviame tu DNI sin puntos ni comas (por ejemplo: 27345678).";

const MSG_FALTA_APELLIDO =
  "Necesito tu nombre y apellido completos, o tu DNI sin puntos ni comas, para buscar tu cuenta 🙂";

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
  /\b(cu[aá]nto\s+(debo|debe|tengo|es|son|sale|me\s+toca|hay|pago|abono|adeudo)|cu[aá]nto\s+.{0,25}(pagar|abonar|deuda)|monto|saldo|deuda|adeudo|debo|abonar|total\s+a\s+pagar|importe|resumen\s+de\s+(mi\s+)?cuenta)\b/i;

function esConsultaDeuda(texto) {
  const t = String(texto || "");
  if (/\b(abrir|apertura|requisito)/i.test(t) && !/\b(debo|deuda|saldo|abonar)\b/i.test(t)) {
    return false;
  }
  return RE_CONSULTA.test(t);
}

// "27.345.678" / "27,345,678" / "27 345 678" / "DNI: 27345678" -> "27345678"
const extraerDigitos = clientes.limpiarDni;

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

// Opcional (BOT_NOMBRE_EXIGE_MISMO_TELEFONO=1): por NOMBRE solo se informa el monto si quien
// escribe lo hace desde el teléfono agendado de ese cliente. Evita que alguien consulte la
// deuda de otra persona sabiendo solo su nombre. Por DNI no se aplica.
const EXIGIR_MISMO_TELEFONO = process.env.BOT_NOMBRE_EXIGE_MISMO_TELEFONO === "1";

// Palabras que NO son parte de un nombre: saludos, la propia consulta y relleno. Lo que queda
// después de sacarlas es el nombre. (Ya normalizadas: sin tildes, en minúsculas.)
const PALABRAS_NO_NOMBRE = new Set(
  (
    "hola buenas buenos dia dias tarde tardes noche noches soy me llamo llama mi mio mia nombre apellido " +
    "titular es son a de del el la lo los las un una por favor porfa porfavor quiero quisiera queria " +
    "necesito saber consultar consulta cuanto cuanta debo debe deuda adeudo saldo monto pago pagar " +
    "abonar abono total importe resumen cuenta tengo tenes que cual sale toca hay y mas gracias dni " +
    "documento numero para con si no se nose nada ok dale bueno listo perfecto ya ayuda disculpa " +
    "disculpe perdon ahora aca aqui medicamento medicamentos pedido precio stock receta"
  ).split(" ")
);

// Frases con las que alguien dice su nombre ("soy...", "a nombre de...", "cuánto debe ...").
const RE_PRESENTACION = /\b(soy|me llamo|mi nombre es|a nombre de|nombre|apellido|titular|cuanto debe)\b/;

// Saca el nombre de un mensaje SIN números. Devuelve las palabras normalizadas
// (["juan", "perez"]) o null si el mensaje no parece traer un nombre.
//  - "soy Juan Pérez, cuánto debo?"  -> ["juan","perez"]
//  - "Juan Pérez" (respondiendo al pedido) -> ["juan","perez"]
//  - "cuánto debo en octubre"        -> null (es una consulta, no un nombre)
function extraerNombre(texto, { consulta = false } = {}) {
  const norm = clientes.normalizarTexto(texto);
  if (!norm) return null;
  const resto = norm.split(" ").filter((w) => !PALABRAS_NO_NOMBRE.has(w));
  if (resto.length < 1 || resto.length > 4 || resto.some((w) => w.length < 2)) return null;
  // En medio de una consulta ("cuánto debo en octubre") solo es un nombre si se presentó.
  if (consulta && !RE_PRESENTACION.test(norm)) return null;
  return resto;
}

// Escapa lo que WhatsApp interpretaría como formato (*negrita*, _cursiva_, ~tachado~).
const limpiarParaWhatsApp = (t) => String(t || "").replace(/[*_~`]/g, "").trim();

// Arma la respuesta con el total. `verificacion` = cómo se identificó al cliente.
function mensajeMonto(cliente, verificacion) {
  const quien =
    verificacion === "dni"
      ? "Verifiqué tu DNI ✅"
      : `Encontré a *${limpiarParaWhatsApp(`${cliente.nombre} ${cliente.apellido || ""}`)}* ✅`;
  if (cliente.monto <= 0) {
    return `${quien} Actualmente no registrás ningún monto pendiente de pago ✅`;
  }
  return (
    `${quien} El total a pagar es de *${formatearMonto(cliente.monto)}*.\n` +
    "Recordá abonar antes del día 15 para evitar el recargo de intereses."
  );
}

// Busca el DNI y arma la respuesta con el total.
async function responderConDni(usuario, numero, dni) {
  const clave = `${usuario.id}:${ult10(numero)}`;
  if (bloqueado(clave)) return MSG_DERIVAR;

  const cliente = await clientes.buscarPorDni(usuario, dni);
  if (!cliente) {
    anotarFallo(clave);
    return bloqueado(clave) ? MSG_DERIVAR : MSG_NO_ENCONTRADO;
  }

  fallos.delete(clave);
  return mensajeMonto(cliente, "dni");
}

// Busca por nombre y apellido y arma la respuesta con el total.
async function responderConNombre(usuario, numero, palabras) {
  const clave = `${usuario.id}:${ult10(numero)}`;
  if (bloqueado(clave)) return MSG_DERIVAR;

  let encontrados = await clientes.buscarPorNombre(usuario, palabras);
  if (EXIGIR_MISMO_TELEFONO) {
    encontrados = encontrados.filter((c) => ult10(c.numero) === ult10(numero));
  }

  if (encontrados.length === 0) {
    if (palabras.length < 2) return MSG_FALTA_APELLIDO; // falta el apellido: no es un fallo
    anotarFallo(clave);
    return bloqueado(clave) ? MSG_DERIVAR : MSG_NOMBRE_NO_ENCONTRADO;
  }
  // Homónimos: no se adivina de quién es la deuda; se pide el DNI.
  if (encontrados.length > 1) return MSG_NOMBRE_AMBIGUO;

  fallos.delete(clave);
  return mensajeMonto(encontrados[0], "nombre");
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
      // Un mensaje con muchos números que no es un DNI (ej. un teléfono o un monto) en
      // plena consulta: se pide de nuevo en vez de buscar basura.
      if (!clientes.dniValido(digitos)) return esperando ? MSG_DNI_INVALIDO : MSG_PEDIR_DNI;
      return await responderConDni(usuario, numero, digitos);
    }

    // Sin números: puede haber dicho su nombre ("soy Juan Pérez", o solo "Juan Pérez"
    // como respuesta al pedido).
    const palabras = extraerNombre(texto, { consulta });
    if (palabras) return await responderConNombre(usuario, numero, palabras);

    // Pregunta por su saldo y todavía no dio el DNI ni el nombre.
    if (consulta) return MSG_PEDIR_DNI;

    // Estábamos esperando datos pero el mensaje no trae números ni un nombre: es otro tema,
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
  extraerNombre,
  formatearMonto,
  MSG_PEDIR_DNI,
  MSG_SIN_DATOS,
};
