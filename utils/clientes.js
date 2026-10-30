// Agenda de clientes (tabla `clientes` de Supabase).
// Cada cliente pertenece a un usuario de la app. Guarda nombre, apellido, DNI,
// teléfono y monto. El DNI siempre se guarda solo con dígitos.
const { supabase } = require("../supabaseClient");

const TAMANO_PAGINA = 1000; // Supabase devuelve como máximo 1000 filas por consulta
const DNI_MIN = 6;
const DNI_MAX = 8;

// Deja ÚNICAMENTE dígitos: "27.345.678", "27,345,678", "27 345 678" -> "27345678".
const limpiarDni = (v) => String(v ?? "").replace(/\D/g, "");
const limpiarNumero = (v) => String(v ?? "").replace(/\D/g, "");
const dniValido = (d) => d.length >= DNI_MIN && d.length <= DNI_MAX;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Traduce errores de Postgres/PostgREST a mensajes entendibles.
function traducir(e) {
  if (!e) return e;
  if (e.code === "42P01" || e.code === "PGRST205") {
    return httpError(500, "Falta la tabla de clientes. Ejecutá clientes.sql en Supabase > SQL Editor.");
  }
  if (e.code === "23505") {
    // La restricción única de la base (clientes_user_tel_uniq / clientes_user_dni_uniq) es la
    // última barrera si dos altas llegan al mismo tiempo; acá se dice cuál de las dos saltó.
    const detalle = `${e.message || ""} ${e.details || ""}`;
    return httpError(409, /tel|numero/i.test(detalle)
      ? "Ese teléfono ya está agendado."
      : "Ya existe un cliente con ese DNI.");
  }
  if (e.code === "23514") return httpError(400, "Datos inválidos (revisá DNI y monto).");
  if (e.code === "42703" || e.code === "PGRST204") {
    return httpError(500, "Faltan columnas en la tabla de clientes. Ejecutá clientes.sql en Supabase > SQL Editor.");
  }
  return e;
}

// Fila de la base -> forma que usa el frontend.
const aApi = (r) => ({
  id: r.id,
  nombre: r.nombre,
  apellido: r.apellido || "",
  dni: r.dni || "",
  numero: r.numero,
  monto: Number(r.monto) || 0,
  alta: Boolean(r.alta),
  fechaAlta: r.fecha_alta || null,
  invitado: Boolean(r.invitado), // ya se le envió la plantilla de invitación
  fechaInvitacion: r.fecha_invitacion || null,
  usuario_id: r.user_id,
});

// Valida y normaliza lo que manda el frontend. `parcial` = PUT/PATCH sin todos los campos.
function normalizar(datos = {}, { parcial = false } = {}) {
  const out = {};

  if (!parcial || datos.nombre !== undefined) {
    const nombre = String(datos.nombre ?? "").trim();
    if (!nombre) throw httpError(400, "El nombre es obligatorio.");
    out.nombre = nombre;
  }
  if (datos.apellido !== undefined) out.apellido = String(datos.apellido ?? "").trim();

  if (!parcial || datos.numero !== undefined) {
    const numero = limpiarNumero(datos.numero);
    if (numero.length < 8) throw httpError(400, "El número de teléfono no es válido.");
    out.numero = numero;
  }

  if (datos.dni !== undefined) {
    const dni = limpiarDni(datos.dni);
    if (dni === "") out.dni = null; // DNI opcional
    else if (!dniValido(dni)) {
      throw httpError(400, `El DNI debe tener entre ${DNI_MIN} y ${DNI_MAX} números.`);
    } else out.dni = dni;
  }

  if (!parcial || datos.monto !== undefined) {
    const monto = Number(String(datos.monto ?? "").replace(",", "."));
    if (!Number.isFinite(monto) || monto < 0) throw httpError(400, "El monto no es válido.");
    out.monto = Math.round(monto * 100) / 100;
  }

  if (datos.alta !== undefined) {
    out.alta = Boolean(datos.alta);
    out.fecha_alta = out.alta ? datos.fechaAlta || new Date().toISOString() : null;
  }
  return out;
}

// Usuarios de la app: { id -> username }. Son pocos, se leen de una vez.
async function mapaUsuarios() {
  const { data, error } = await supabase.from("app_users").select("id, username");
  if (error) throw traducir(error);
  return new Map((data || []).map((u) => [u.id, u.username]));
}

// ¿Ya existe OTRO cliente con ese teléfono o ese DNI?
//  - TELÉFONO: se busca en la agenda de TODOS los usuarios. Se compara por los últimos
//    10 dígitos (549XXXXXXXXXX y 54XXXXXXXXXX son el mismo celular). Si lo tiene otro
//    usuario, el error dice cuál (solo su nombre de usuario, no los datos de su cliente).
//  - DNI: solo dentro de la agenda del propio usuario.
// `excluirId` sirve al editar, para no chocar con el propio cliente.
// Devuelve un Error 409 listo para lanzar, o null si no hay repetido.
async function buscarDuplicado(userId, { numero, dni }, excluirId = null) {
  if (numero) {
    const k = limpiarNumero(numero).slice(-10);
    let q = supabase
      .from("clientes")
      .select("id, nombre, apellido, user_id")
      .like("numero", `%${k}`)
      .limit(1);
    if (excluirId) q = q.neq("id", excluirId);
    const { data, error } = await q;
    if (error) throw traducir(error);
    const dup = data?.[0];
    if (dup) {
      if (dup.user_id === userId) {
        const nombre = `${dup.nombre} ${dup.apellido || ""}`.trim();
        return httpError(409, `Ya tenés agendado ese teléfono: ${nombre}.`);
      }
      const dueno = (await mapaUsuarios()).get(dup.user_id);
      return httpError(
        409,
        dueno
          ? `Ese teléfono ya está agendado por el usuario "${dueno}".`
          : "Ese teléfono ya está agendado por otro usuario."
      );
    }
  }

  if (dni) {
    let q = supabase.from("clientes").select("id, nombre, apellido").eq("user_id", userId).eq("dni", dni).limit(1);
    if (excluirId) q = q.neq("id", excluirId);
    const { data, error } = await q;
    if (error) throw traducir(error);
    if (data?.[0]) {
      const nombre = `${data[0].nombre} ${data[0].apellido || ""}`.trim();
      return httpError(409, `Ya existe un cliente con ese DNI: ${nombre}.`);
    }
  }
  return null;
}

// Teléfonos de TODA la base: { últimos 10 dígitos -> { id, user_id, monto } }.
async function telefonosGlobales() {
  const mapa = new Map();
  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    const { data, error } = await supabase
      .from("clientes")
      .select("id, numero, user_id, monto, alta, dni, apellido")
      .order("id", { ascending: true })
      .range(desde, desde + TAMANO_PAGINA - 1);
    if (error) throw traducir(error);
    for (const r of data || []) mapa.set(String(r.numero).slice(-10), r);
    if (!data || data.length < TAMANO_PAGINA) break;
  }
  return mapa;
}

// Supabase devuelve como máximo 1000 filas por consulta (límite por defecto). Se piden
// de a páginas para traer TODOS los clientes; si no, con más de 1000 contactos los últimos
// no aparecerían en el buscador ni en la plantilla de cobro.
async function listar(userId) {
  const filas = [];
  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    let q = supabase
      .from("clientes")
      .select("*")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }) // desempate: paginar necesita un orden estable
      .range(desde, desde + TAMANO_PAGINA - 1);
    if (userId !== "todos") q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) throw traducir(error);
    filas.push(...(data || []));
    if (!data || data.length < TAMANO_PAGINA) break;
  }
  return filas.map(aApi);
}

async function crear(userId, datos) {
  const fila = { ...normalizar(datos), user_id: userId };
  const duplicado = await buscarDuplicado(userId, fila);
  if (duplicado) throw duplicado;
  const { data, error } = await supabase.from("clientes").insert([fila]).select().single();
  if (error) throw traducir(error);
  return aApi(data);
}

async function actualizar(userId, id, datos) {
  const cambios = { ...normalizar(datos, { parcial: true }), updated_at: new Date().toISOString() };
  // Solo se revisa lo que realmente se está cambiando (teléfono y/o DNI).
  const duplicado = await buscarDuplicado(userId, { numero: cambios.numero, dni: cambios.dni }, id);
  if (duplicado) throw duplicado;
  const { data, error } = await supabase
    .from("clientes")
    .update(cambios)
    .eq("id", id)
    .eq("user_id", userId) // solo se edita lo propio
    .select()
    .maybeSingle();
  if (error) throw traducir(error);
  if (!data) throw httpError(404, "Cliente no encontrado.");
  return aApi(data);
}

async function eliminar(userId, id) {
  const { data, error } = await supabase
    .from("clientes")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");
  if (error) throw traducir(error);
  if (!data?.length) throw httpError(404, "Cliente no encontrado.");
}

// Importación desde Excel. Recibe filas ya leídas por el frontend:
//   [{ fila, nombre, apellido, dni, numero, monto }]   (`fila` = número de fila en el Excel)
// Los clientes del Excel YA TIENEN la cuenta, así que quedan "con alta": aparecen en
// Cobrar (si tienen monto) y NO en Invitar. Por cada fila:
//   - Teléfono NUEVO                      -> se crea el cliente, con alta.
//   - Teléfono ya en la agenda del usuario -> se ACTUALIZA el monto a cobrar y, si todavía
//                                            no tenía alta, se le da (el resto no se toca).
//   - Teléfono agendado por OTRO usuario   -> no se carga ni se toca; se informa de quién es.
//   - DNI ya cargado (con otro teléfono) o teléfono repetido dentro del mismo archivo
//                                          -> no se carga; queda en `errores` con su fila.
// Devuelve { importados, actualizados, sinCambios, omitidos, errores }.
async function importarFilas(userId, filas) {
  if (!Array.isArray(filas)) throw httpError(400, "Se esperaba una lista de filas.");
  if (filas.length > 5000) throw httpError(400, "Máximo 5000 filas por archivo.");

  const telefonos = await telefonosGlobales(); // todos los usuarios
  const usuarios = await mapaUsuarios();
  const propios = await listar(userId);
  const dnis = new Map(propios.filter((c) => c.dni).map((c) => [limpiarDni(c.dni), c.id])); // dni -> id

  const ahora = new Date().toISOString();
  const errores = [];
  const nuevas = []; // { fila, datos }
  const aActualizar = []; // { fila, id, monto }
  const vistos = new Set(); // teléfonos ya procesados en este archivo
  let sinCambios = 0;

  for (const f of filas) {
    const nroFila = f?.fila ?? "?";
    try {
      const datos = normalizar({ ...f, monto: f.monto ?? 0 });
      const k = datos.numero.slice(-10);

      if (vistos.has(k)) throw httpError(409, "Teléfono repetido dentro del archivo.");
      vistos.add(k);

      const existente = telefonos.get(k);
      if (existente) {
        if (existente.user_id !== userId) {
          const dueno = usuarios.get(existente.user_id);
          throw httpError(
            409,
            dueno
              ? `Teléfono ya agendado por el usuario "${dueno}".`
              : "Teléfono ya agendado por otro usuario."
          );
        }
        // Ya está en la agenda de este usuario: se actualiza el monto y se le da el alta
        // si no la tenía (si ya la tenía, no se toca su fecha de alta).
        const mismoMonto = Number(existente.monto) === datos.monto;

        // DNI: si el cliente ya estaba agendado SIN DNI (o con otro), el del Excel se guarda.
        // Antes se ignoraba y el bot nunca lo encontraba. Si ese DNI ya lo tiene OTRO cliente
        // del usuario, no se pisa: queda en `errores`.
        let nuevoDni;
        if (datos.dni && limpiarDni(existente.dni) !== datos.dni) {
          const duenoDni = dnis.get(datos.dni);
          if (duenoDni !== undefined && duenoDni !== existente.id) {
            throw httpError(409, "DNI ya cargado en otro cliente.");
          }
          nuevoDni = datos.dni;
          dnis.set(datos.dni, existente.id);
        }
        const nuevoApellido = !existente.apellido && datos.apellido ? datos.apellido : undefined;

        if (mismoMonto && existente.alta && !nuevoDni && !nuevoApellido) sinCambios++;
        else {
          aActualizar.push({
            fila: nroFila,
            id: existente.id,
            monto: datos.monto,
            darAlta: !existente.alta,
            dni: nuevoDni,
            apellido: nuevoApellido,
          });
        }
        continue;
      }

      if (datos.dni && dnis.has(datos.dni)) throw httpError(409, "DNI repetido (ya está cargado).");
      if (datos.dni) dnis.set(datos.dni, "nuevo");
      nuevas.push({
        fila: nroFila,
        datos: { ...datos, user_id: userId, alta: true, fecha_alta: ahora },
      });
    } catch (e) {
      errores.push({ fila: nroFila, motivo: e.message });
    }
  }

  // Altas: de a 500. Si un bloque falla (p. ej. restricción única en la base),
  // reintenta fila por fila para saber cuál fue y no perder el resto.
  let importados = 0;
  const TAM = 500;
  for (let i = 0; i < nuevas.length; i += TAM) {
    const bloque = nuevas.slice(i, i + TAM);
    const { error } = await supabase.from("clientes").insert(bloque.map((v) => v.datos));
    if (!error) {
      importados += bloque.length;
      continue;
    }
    for (const v of bloque) {
      const r = await supabase.from("clientes").insert([v.datos]);
      if (r.error) errores.push({ fila: v.fila, motivo: traducir(r.error).message });
      else importados++;
    }
  }

  // Actualización de montos: de a 25 en paralelo.
  let actualizados = 0;
  for (let i = 0; i < aActualizar.length; i += 25) {
    await Promise.all(
      aActualizar.slice(i, i + 25).map(async (u) => {
        const { error } = await supabase
          .from("clientes")
          .update({
            monto: u.monto,
            updated_at: ahora,
            ...(u.darAlta ? { alta: true, fecha_alta: ahora } : {}),
            ...(u.dni ? { dni: u.dni } : {}),
            ...(u.apellido ? { apellido: u.apellido } : {}),
          })
          .eq("id", u.id)
          .eq("user_id", userId); // solo se toca lo propio
        if (error) errores.push({ fila: u.fila, motivo: traducir(error).message });
        else actualizados++;
      })
    );
  }

  errores.sort((a, b) => Number(a.fila) - Number(b.fila));
  return { importados, actualizados, sinCambios, omitidos: errores.length, errores };
}

// Marca como "invitado" al cliente (de este usuario) al que se le envió la plantilla de invitación.
// Compara por los últimos 10 dígitos (549XXXXXXXXXX y 54XXXXXXXXXX son el mismo celular).
// Devuelve cuántos clientes se marcaron.
async function marcarInvitado(userId, numero) {
  const k = limpiarNumero(numero).slice(-10);
  if (k.length < 8) return 0;
  const { data, error } = await supabase
    .from("clientes")
    .update({ invitado: true, fecha_invitacion: new Date().toISOString() })
    .eq("user_id", userId)
    .like("numero", `%${k}`)
    .select("id");
  if (error) throw traducir(error);
  return data?.length || 0;
}

// Filas de `clientes` con ese DNI (solo dígitos). `userId` limita a la agenda de un usuario;
// sin `userId` busca en la de todos.
async function filasPorDni(d, userId) {
  // 1) Coincidencia exacta: lo normal, porque el DNI se guarda solo con dígitos.
  let q = supabase.from("clientes").select("*").eq("dni", d).limit(5);
  if (userId) q = q.eq("user_id", userId);
  const exacto = await q;
  if (exacto.error) throw traducir(exacto.error);
  if (exacto.data?.length) return exacto.data;

  // 2) Respaldo: DNI guardado con formato ("27.345.678", "27345678 ", "DNI 27345678"...),
  //    por ejemplo cargado a mano en Supabase. Se traen los parecidos y se comparan solo dígitos.
  try {
    let q2 = supabase.from("clientes").select("*").ilike("dni", "%" + d.split("").join("%") + "%").limit(50);
    if (userId) q2 = q2.eq("user_id", userId);
    const flexible = await q2;
    if (flexible.error) throw flexible.error;
    return (flexible.data || []).filter((r) => limpiarDni(r.dni) === d);
  } catch (e) {
    console.warn("[Clientes] Búsqueda flexible de DNI no disponible:", e.message);
    return [];
  }
}

// Busca un cliente por DNI (comparando solo dígitos). Devuelve null si no existe.
// Un usuario busca en SU agenda; el administrador, si no lo encuentra en la suya,
// busca en la de todos (los clientes que escriben por su cuenta le llegan a él).
// `numero` (opcional) es el WhatsApp de quien escribe: si el DNI está en la agenda de OTRO
// usuario pero ese cliente tiene justo este teléfono, es la misma persona y se lo encuentra
// igual (en el número compartido la conversación puede caer en un usuario distinto al que
// cargó al cliente). No se expone ningún cliente que no sea el que escribe.
async function buscarPorDni(usuario, dni, numero = null) {
  const d = limpiarDni(dni);
  if (!dniValido(d)) return null;

  const propios = await filasPorDni(d, usuario.id);
  if (propios[0]) return aApi(propios[0]);

  const k = limpiarNumero(numero).slice(-10);
  const esAdmin = usuario.role === "admin";
  if (!esAdmin && k.length < 8) return null;

  const todos = await filasPorDni(d, null);
  const mismoTelefono = todos.find((r) => k.length >= 8 && limpiarNumero(r.numero).slice(-10) === k);
  if (mismoTelefono) return aApi(mismoTelefono);
  return esAdmin && todos[0] ? aApi(todos[0]) : null;
}

// Busca al cliente que escribe por su número de WhatsApp (compara los últimos 10 dígitos:
// 549XXXXXXXXXX y 54XXXXXXXXXX son el mismo celular). Sirve para que el bot sepa con
// quién habla. Un usuario busca en SU agenda; el administrador, si no lo encuentra en la
// suya, busca en la de todos (los clientes que escriben por su cuenta le llegan a él).
// Nunca lanza error: si algo falla devuelve null y el bot sigue como si no lo conociera.
async function buscarPorTelefono(usuario, numero) {
  try {
    const k = limpiarNumero(numero).slice(-10);
    if (k.length < 8) return null;

    const propio = await supabase
      .from("clientes")
      .select("*")
      .eq("user_id", usuario.id)
      .like("numero", `%${k}`)
      .limit(1);
    if (propio.error) throw traducir(propio.error);
    if (propio.data?.[0]) return aApi(propio.data[0]);

    if (usuario.role !== "admin") return null;

    const global = await supabase.from("clientes").select("*").like("numero", `%${k}`).limit(1);
    if (global.error) throw traducir(global.error);
    return global.data?.[0] ? aApi(global.data[0]) : null;
  } catch (e) {
    console.error("[Clientes] No se pudo buscar por teléfono:", e.message);
    return null;
  }
}

module.exports = {
  DNI_MIN,
  DNI_MAX,
  limpiarDni,
  dniValido,
  listar,
  crear,
  actualizar,
  eliminar,
  importarFilas,
  marcarInvitado,
  buscarPorDni,
  buscarPorTelefono,
};
