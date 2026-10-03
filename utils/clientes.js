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

async function listar(userId) {
  let q = supabase.from("clientes").select("*").order("created_at", { ascending: true });
  if (userId !== "todos") q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw traducir(error);
  return (data || []).map(aApi);
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
  buscarPorDni,
};
