// Agenda de clientes (tabla `clientes` de Supabase).
// Cada cliente pertenece a un usuario de la app. Guarda nombre, apellido, DNI,
// teléfono y monto. El DNI siempre se guarda solo con dígitos.
const { supabase } = require("../supabaseClient");

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
  if (e.code === "23505") return httpError(409, "Ya existe un cliente con ese DNI.");
  if (e.code === "23514") return httpError(400, "Datos inválidos (revisá DNI y monto).");
  if (e.code === "42703" || e.code === "PGRST204") {
    return httpError(500, "Faltan las columnas de invitación. Ejecutá invitaciones.sql en Supabase > SQL Editor.");
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

// Supabase devuelve como máximo 1000 filas por consulta (límite por defecto). Se piden
// de a páginas para traer TODOS los clientes; si no, con más de 1000 contactos los últimos
// no aparecerían en el buscador ni en la plantilla de cobro.
const TAMANO_PAGINA = 1000;

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
  const { data, error } = await supabase.from("clientes").insert([fila]).select().single();
  if (error) throw traducir(error);
  return aApi(data);
}

async function actualizar(userId, id, datos) {
  const cambios = { ...normalizar(datos, { parcial: true }), updated_at: new Date().toISOString() };
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

// Pasa la agenda vieja (localStorage) al servidor. Salta los teléfonos que ya existen,
// así que repetirlo no duplica nada.
async function importar(userId, lista) {
  if (!Array.isArray(lista)) throw httpError(400, "Se esperaba una lista de contactos.");
  const existentes = new Set((await listar(userId)).map((c) => c.numero.slice(-10)));

  const filas = [];
  let omitidos = 0;
  for (const c of lista.slice(0, 5000)) {
    try {
      const f = normalizar({ ...c, monto: c.monto ?? 0 });
      const k = f.numero.slice(-10);
      if (existentes.has(k)) {
        omitidos++;
        continue;
      }
      existentes.add(k);
      filas.push({
        ...f,
        user_id: userId,
        alta: Boolean(c.alta),
        fecha_alta: c.alta ? c.fechaAlta || new Date().toISOString() : null,
      });
    } catch {
      omitidos++;
    }
  }

  if (filas.length) {
    const { error } = await supabase.from("clientes").insert(filas);
    if (error) throw traducir(error);
  }
  return { importados: filas.length, omitidos };
}

// Importación desde Excel. Recibe filas ya leídas por el frontend:
//   [{ fila, nombre, apellido, dni, numero, monto }]   (`fila` = número de fila en el Excel)
// Valida cada fila, salta duplicados (teléfono o DNI ya cargados, o repetidos dentro del
// mismo archivo) y devuelve el detalle de lo que no se pudo cargar, con su número de fila.
// Repetirlo no duplica nada.
async function importarFilas(userId, filas) {
  if (!Array.isArray(filas)) throw httpError(400, "Se esperaba una lista de filas.");
  if (filas.length > 5000) throw httpError(400, "Máximo 5000 filas por archivo.");

  const existentes = await listar(userId);
  const telefonos = new Set(existentes.map((c) => c.numero.slice(-10)));
  const dnis = new Set(existentes.map((c) => c.dni).filter(Boolean));

  const errores = [];
  const validas = []; // { fila, datos }
  for (const f of filas) {
    const nroFila = f?.fila ?? "?";
    try {
      const datos = normalizar({ ...f, monto: f.monto ?? 0 });
      const k = datos.numero.slice(-10);
      if (telefonos.has(k)) throw httpError(409, "Teléfono repetido (ya está cargado).");
      if (datos.dni && dnis.has(datos.dni)) throw httpError(409, "DNI repetido (ya está cargado).");
      telefonos.add(k);
      if (datos.dni) dnis.add(datos.dni);
      validas.push({ fila: nroFila, datos: { ...datos, user_id: userId, alta: false } });
    } catch (e) {
      errores.push({ fila: nroFila, motivo: e.message });
    }
  }

  // Inserta de a 500. Si un bloque falla (p. ej. restricción única en la base),
  // reintenta fila por fila para saber cuál fue y no perder el resto.
  let importados = 0;
  const TAM = 500;
  for (let i = 0; i < validas.length; i += TAM) {
    const bloque = validas.slice(i, i + TAM);
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

  errores.sort((a, b) => Number(a.fila) - Number(b.fila));
  return { importados, omitidos: errores.length, errores };
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

// Busca un cliente por DNI (comparando solo dígitos). Devuelve null si no existe.
// Un usuario busca en SU agenda; el administrador, si no lo encuentra en la suya,
// busca en la de todos (los clientes que escriben por su cuenta le llegan a él).
async function buscarPorDni(usuario, dni) {
  const d = limpiarDni(dni);
  if (!dniValido(d)) return null;

  const propio = await supabase
    .from("clientes")
    .select("*")
    .eq("user_id", usuario.id)
    .eq("dni", d)
    .maybeSingle();
  if (propio.error) throw traducir(propio.error);
  if (propio.data) return aApi(propio.data);

  if (usuario.role !== "admin") return null;

  const global = await supabase.from("clientes").select("*").eq("dni", d).limit(1);
  if (global.error) throw traducir(global.error);
  return global.data?.[0] ? aApi(global.data[0]) : null;
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
  importar,
  importarFilas,
  marcarInvitado,
  buscarPorDni,
};
