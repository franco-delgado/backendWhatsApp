// Dueño de cada contacto en el NÚMERO COMPARTIDO.
//
// Varios usuarios pueden usar el mismo número de WhatsApp. Para que cada uno vea
// solo lo suyo, cada contacto (cliente) tiene UN dueño (tabla contact_owners):
//   - Si un usuario le escribe primero a un contacto libre, ese contacto pasa a ser suyo.
//   - Cuando el contacto responde, el mensaje cae en la bandeja de su dueño.
//   - Un contacto sin dueño que escribe por su cuenta lo recibe el administrador.
//   - El administrador puede ver todo y reasignar un contacto a otro usuario.
//
// La clave es siempre los últimos 10 dígitos: en Argentina el mismo celular llega
// como 549XXXXXXXXXX o 54XXXXXXXXXX (con y sin el "9").
const { supabase } = require("../supabaseClient");
const { reanudarIA } = require("./pausaIA");

const ultimos10 = (numero) => String(numero || "").replace(/\D/g, "").slice(-10);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esUuid = (v) => UUID_RE.test(String(v || ""));

function errorDeEstructura(e) {
  return e && (e.code === "42P01" || e.code === "PGRST205");
}

function falta(e) {
  if (errorDeEstructura(e)) {
    const err = new Error(
      "Falta la tabla de contactos compartidos. Ejecutá compartido.sql en Supabase > SQL Editor."
    );
    err.status = 500;
    return err;
  }
  return e;
}

// id del usuario dueño del contacto, o null si nadie lo reclamó todavía.
async function duenioDeContacto(numero) {
  const k = ultimos10(numero);
  if (!k) return null;
  const { data, error } = await supabase
    .from("contact_owners")
    .select("user_id")
    .eq("numero", k)
    .maybeSingle();
  if (error) throw falta(error);
  return data?.user_id || null;
}

// ANTES de enviar por el número compartido: ¿puede este usuario escribirle a ese contacto?
// Devuelve el id del dueño actual (o null si está libre). Si es de otro usuario,
// solo el administrador puede escribirle.
async function verificarPermisoEnvio(user, numero) {
  if (!ultimos10(numero)) throw new Error("El número de destino no es válido.");
  const duenio = await duenioDeContacto(numero);
  if (duenio && duenio !== user.id && user.role !== "admin") {
    const err = new Error(
      "Este contacto está asignado a otro usuario. Pedile al administrador que te lo asigne."
    );
    err.status = 403;
    throw err;
  }
  return duenio;
}

// DESPUÉS de un envío exitoso: si el contacto estaba libre, pasa a ser de quien envió.
// Si dos usuarios le escriben al mismo contacto libre a la vez, gana el primero.
// Devuelve el id del dueño final.
async function reclamarSiLibre(user, numero) {
  const k = ultimos10(numero);
  if (!k) return user.id;
  const { error } = await supabase
    .from("contact_owners")
    .upsert([{ numero: k, user_id: user.id, asignado_por: user.id }], {
      onConflict: "numero",
      ignoreDuplicates: true, // si ya tiene dueño, no se pisa
    });
  if (error) throw falta(error);
  return (await duenioDeContacto(k)) || user.id;
}

// Solo administrador: pasa un contacto (y todo su historial) a otro usuario.
async function asignarContacto(numero, nuevoUserId, adminId) {
  const k = ultimos10(numero);
  if (!k) throw new Error("Número inválido.");

  const anterior = (await duenioDeContacto(k)) || adminId; // sin dueño = lo tiene el admin

  const { error } = await supabase.from("contact_owners").upsert(
    [{ numero: k, user_id: nuevoUserId, asignado_por: adminId, updated_at: new Date().toISOString() }],
    { onConflict: "numero" }
  );
  if (error) throw falta(error);

  let movidos = 0;
  if (anterior !== nuevoUserId) {
    // El historial viaja con el contacto. Coincide por los últimos 10 dígitos,
    // así entrantes ("Franco (549…)") y salientes ("Soporte (54…)") se mueven juntos.
    const { data, error: errMsg } = await supabase
      .from("messages")
      .update({ user_id: nuevoUserId })
      .eq("user_id", anterior)
      .ilike("sender", `%${k})`)
      .select("id");
    if (errMsg) throw errMsg;
    movidos = data?.length || 0;

    // La pausa del bot era del dueño anterior: el nuevo empieza limpio.
    await reanudarIA(anterior, k).catch(() => {});
  }
  return { numero: k, user_id: nuevoUserId, mensajes_movidos: movidos };
}

module.exports = {
  ultimos10,
  esUuid,
  duenioDeContacto,
  verificarPermisoEnvio,
  reclamarSiLibre,
  asignarContacto,
};
