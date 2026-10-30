// Consulta de saldo por WhatsApp, resuelta por el servidor (NO por la IA).
//
// Flujo:
//   1. El cliente pregunta cuánto debe / cuánto tiene que pagar.
//   2. El servidor mira PRIMERO desde qué número de WhatsApp llegó el mensaje y lo compara
//      con los teléfonos de la base de datos (últimos 10 dígitos). Si hay coincidencia,
//      responde con TODOS los datos que corresponden a ese número (nombre, apellido, DNI,
//      teléfono y total a pagar) y no pide nada más.
//   3. Si el número NO está en la base, intenta identificarlo con lo que escriba, en este orden:
//        a) un DNI escrito en el mensaje (con o sin puntos, espacios, texto alrededor...);
//        b) un teléfono escrito en el mensaje;
//        c) su nombre y apellido.
//      Si no puede, le pide el DNI, el nombre y apellido o el teléfono.
//
// El monto lo arma el servidor leyendo la base. La IA nunca lo ve ni lo inventa.
// No hay estado en memoria que se pierda: "estamos esperando el dato" se deduce de que
// el último mensaje del bot en esa conversación fue un pedido de identificación (hace poco).
const { supabase } = require("../supabaseClient");
const clientes = require("./clientes");

// Frase que está en TODOS los mensajes que dejan al bot esperando un dato.
// Sirve para reconocerlos en el historial; no la cambies sin cambiar los textos.
const FRASE_ESPERA = "sin puntos ni comas";

const MSG_PEDIR_DNI =
  "Para consultar el total a pagar necesito identificarte 🙂\n" +
  "Enviame tu número de DNI (sin puntos ni comas, por ejemplo: 27345678), " +
  "o tu nombre y apellido, o tu teléfono.";

const MSG_DNI_INVALIDO =
  "No pude identificarte con ese dato. Enviame tu DNI (entre 6 y 8 números, " +
  "sin puntos ni comas, por ejemplo: 27345678) o tu nombre y apellido completos.";

const MSG_NO_ENCONTRADO =
  "No encontré tus datos en nuestros registros 😕\n" +
  "Revisalos y enviámelos de nuevo: tu DNI sin puntos ni comas, o tu nombre y apellido completos.";

const MSG_AMBIGUO =
  "Encontré más de un cliente con ese nombre 🤔 Para verificarte necesito tu DNI, " +
  "sin puntos ni comas (por ejemplo: 27345678).";

const MSG_NOMBRE_INCOMPLETO =
  "Necesito tu nombre y apellido completos, o tu DNI sin puntos ni comas " +
  "(por ejemplo: 27345678), para identificarte.";

const MSG_DERIVAR =
  "No pude verificar tus datos. En cuanto sea posible un representante se estará comunicando con vos.";

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

// Teléfonos escritos en el mensaje (10 a 13 dígitos: "3825123456", "+54 9 3825 12-3456").
function extraerTelefonos(texto) {
  const salida = [];
  for (const m of String(texto || "").matchAll(RE_TRAMO_NUMERICO)) {
    const d = clientes.limpiarDni(m[0]);
    if (d.length >= 10 && d.length <= 13 && !salida.includes(d)) salida.push(d);
  }
  return salida.slice(0, MAX_CANDIDATOS);
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

const enmascarar = (d) => "***" + String(d).slice(-3); // en el log no se escriben DNI completos

// Datos del cliente + total a pagar.
//  - `completo`: se identificó por su DNI o por el WhatsApp desde el que escribe, así que
//    se le muestran todos sus datos.
//  - Si se lo encontró solo por un nombre o un teléfono escrito (algo que cualquiera podría
//    escribir), se muestran únicamente el nombre y el total, sin DNI ni teléfono.
function armarRespuesta(cliente, completo) {
  const nombre = `${cliente.nombre} ${cliente.apellido}`.trim();
  const lineas = ["Verifiqué tus datos ✅", `👤 Cliente: *${nombre}*`];
  if (completo && cliente.dni) lineas.push(`🪪 DNI: ${cliente.dni}`);
  if (completo && cliente.numero) lineas.push(`📱 Teléfono: ${cliente.numero}`);

  if (cliente.monto <= 0) {
    lineas.push("💰 Actualmente no registrás ningún monto pendiente de pago ✅");
  } else {
    lineas.push(
      `💰 Total a pagar: *${formatearMonto(cliente.monto)}*`,
      "",
      "Recordá abonar antes del día 15 para evitar el recargo de intereses."
    );
  }
  return lineas.join("\n");
}

// Respuesta cuando el cliente fue identificado por el número desde el que escribe.
// `lista` trae todos los registros de la base con ese teléfono (normalmente uno). Se muestran
// todos sus datos: nombre, apellido, DNI, teléfono y el monto a pagar.
function armarRespuestaPorNumero(lista) {
  if (lista.length === 1) return armarRespuesta(lista[0], true);

  const lineas = [`Verifiqué tu número ✅ Encontré ${lista.length} cuentas asociadas a este teléfono:`];
  lista.forEach((c, i) => {
    const nombre = `${c.nombre} ${c.apellido}`.trim();
    lineas.push("", `*${i + 1})* 👤 ${nombre}`);
    if (c.dni) lineas.push(`🪪 DNI: ${c.dni}`);
    if (c.numero) lineas.push(`📱 Teléfono: ${c.numero}`);
    lineas.push(c.monto > 0 ? `💰 A pagar: *${formatearMonto(c.monto)}*` : "💰 Sin monto pendiente ✅");
  });
  const total = lista.reduce((suma, c) => suma + (c.monto > 0 ? c.monto : 0), 0);
  if (total > 0) {
    lineas.push(
      "",
      `💰 Total a pagar: *${formatearMonto(total)}*`,
      "",
      "Recordá abonar antes del día 15 para evitar el recargo de intereses."
    );
  }
  return lineas.join("\n");
}

// Intenta identificar al cliente con lo que escribió: DNI, teléfono o nombre.
// Devuelve { cliente, completo, via, ambiguo }.
async function identificarPorTexto(usuario, numero, texto, candidatos, telefonos) {
  for (const dni of candidatos) {
    const c = await clientes.buscarPorDni(usuario, dni);
    if (c) return { cliente: c, completo: true, via: "dni" };
  }
  for (const tel of telefonos) {
    const c = await clientes.buscarPorTelefono(usuario, tel);
    // Si el teléfono escrito es el mismo desde el que escribe, es él mismo: datos completos.
    if (c) return { cliente: c, completo: ult10(tel) === ult10(numero), via: "teléfono escrito" };
  }
  const porNombre = await clientes.buscarPorNombre(usuario, texto);
  if (porNombre.cliente) return { cliente: porNombre.cliente, completo: false, via: "nombre" };
  return { cliente: null, ambiguo: porNombre.ambiguo };
}

/**
 * Decide si este mensaje es parte de la consulta de saldo.
 * @param {boolean} [forzarConsulta] true cuando la IA ya detectó que es una consulta de saldo
 *   que el filtro por palabras no reconoció.
 * @returns {Promise<string|null>} el texto a enviar, o null si NO es una consulta
 *   de saldo (en ese caso el mensaje sigue su camino normal hacia la IA).
 */
async function procesar({ usuario, numero, texto, forzarConsulta = false }) {
  try {
    const consulta = forzarConsulta || esConsultaDeuda(texto);
    const esperando = await esperandoDni(usuario.id, numero);
    if (!consulta && !esperando) return null;

    const clave = `${usuario.id}:${ult10(numero)}`;

    // PRIMERO: ¿el número desde el que escribe está en la base? Si está, se responde con
    // todos sus datos y no se le pide nada. Esto va antes que cualquier dato escrito en el
    // mensaje, y sin el freno de intentos fallidos: no se está probando nada al azar.
    if (consulta) {
      const propios = await clientes.buscarTodosPorTelefono(usuario, numero);
      if (propios.length > 0) {
        fallos.delete(clave);
        console.log(
          `[BotDeuda] OK usuario=${usuario.id} (${usuario.role}) vía número de WhatsApp ` +
            `(${enmascarar(ult10(numero))}) registros=${propios.map((c) => c.id).join(",")}`
        );
        return armarRespuestaPorNumero(propios);
      }
    }

    const digitos = extraerDigitos(texto);
    const candidatos = extraerCandidatosDni(texto);
    const telefonos = extraerTelefonos(texto);

    // Quien ya falló muchas veces no puede seguir probando DNI/nombres al azar
    // (sí puede consultar si su propio WhatsApp está en la agenda).
    const puedeProbar = !bloqueado(clave);

    let r = { cliente: null, ambiguo: false };
    if (puedeProbar) r = await identificarPorTexto(usuario, numero, texto, candidatos, telefonos);

    if (r.cliente) {
      fallos.delete(clave);
      console.log(
        `[BotDeuda] OK usuario=${usuario.id} (${usuario.role}) cliente=${r.cliente.id} vía ${r.via}`
      );
      return armarRespuesta(r.cliente, r.completo);
    }

    // ---- No se pudo identificar (y su número tampoco está en la base) ----
    console.log(
      `[BotDeuda] SIN COINCIDENCIA usuario=${usuario.id} (${usuario.role}) consulta=${consulta} ` +
        `esperando=${esperando} dni=[${candidatos.map(enmascarar).join(",")}] ` +
        `tel=[${telefonos.map(enmascarar).join(",")}] agenda: ${await clientes.resumenAgenda(usuario)}`
    );

    if (!puedeProbar) return MSG_DERIVAR;
    if (r.ambiguo) return MSG_AMBIGUO;

    const intentoEscrito = candidatos.length > 0 || telefonos.length > 0;
    if (intentoEscrito) {
      anotarFallo(clave);
      return bloqueado(clave) ? MSG_DERIVAR : MSG_NO_ENCONTRADO;
    }

    // Mandó números que no pueden ser un DNI ni un teléfono (un monto, una edad...).
    if (digitos.length > 0) return esperando ? MSG_DNI_INVALIDO : MSG_PEDIR_DNI;

    // Pregunta por su saldo y todavía no se lo pudo identificar.
    if (consulta) return MSG_PEDIR_DNI;

    // Esperábamos el dato y escribió algo con pinta de nombre que no está en la agenda.
    const palabras = clientes.palabrasDeNombre(texto);
    if (palabras.length >= 2) {
      anotarFallo(clave);
      return bloqueado(clave) ? MSG_DERIVAR : MSG_NO_ENCONTRADO;
    }
    // Un solo nombre de pila ("Lucía"): no alcanza para identificar a nadie.
    if (palabras.length === 1 && String(texto).trim().split(/\s+/).length <= 2) {
      return MSG_NOMBRE_INCOMPLETO;
    }

    // Era otro tema: dejamos que siga el flujo normal.
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
  extraerTelefonos,
  formatearMonto,
  MSG_PEDIR_DNI,
  MSG_SIN_DATOS,
};
