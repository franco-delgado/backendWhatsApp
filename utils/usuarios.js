// Acceso a la tabla app_users + reglas de "de quién es cada número de WhatsApp".
const { supabase } = require("../supabaseClient");
const { hashPassword } = require("./seguridad");

const TTL_MS = 30 * 1000;
const cachePorId = new Map(); // id -> { user, hasta }
const cachePorNumero = new Map(); // phone_number_id -> { user, hasta }
let cacheAdmin = null; // { user, hasta }

function invalidarCache() {
  cachePorId.clear();
  cachePorNumero.clear();
  cacheAdmin = null;
}

async function buscarPorUsername(username) {
  const { data, error } = await supabase
    .from("app_users")
    .select("*")
    .ilike("username", String(username || "").trim())
    .limit(1);
  if (error) throw error;
  const u = data?.[0];
  // ilike trata % y _ como comodines: confirmamos que sea exactamente el mismo nombre.
  return u && u.username.toLowerCase() === String(username).trim().toLowerCase() ? u : null;
}

async function obtenerPorId(id) {
  const c = cachePorId.get(id);
  if (c && c.hasta > Date.now()) return c.user;
  const { data, error } = await supabase.from("app_users").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (data) cachePorId.set(id, { user: data, hasta: Date.now() + TTL_MS });
  return data || null;
}

async function obtenerAdmin() {
  if (cacheAdmin && cacheAdmin.hasta > Date.now()) return cacheAdmin.user;
  const { data, error } = await supabase
    .from("app_users")
    .select("*")
    .eq("role", "admin")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const admin = data?.[0] || null;
  if (admin) cacheAdmin = { user: admin, hasta: Date.now() + TTL_MS };
  return admin;
}

// Dueño de un mensaje entrante según el número de WhatsApp (phone_number_id)
// al que escribió el cliente. Si ningún usuario lo tiene asignado, lo recibe el
// administrador (así el número original de tu .env sigue funcionando igual).
async function resolverDuenioWebhook(phoneNumberId) {
  try {
    if (phoneNumberId) {
      const c = cachePorNumero.get(phoneNumberId);
      if (c && c.hasta > Date.now()) return c.user;
      const { data, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("phone_number_id", String(phoneNumberId))
        .maybeSingle();
      if (error) throw error;
      if (data) {
        cachePorNumero.set(phoneNumberId, { user: data, hasta: Date.now() + TTL_MS });
        return data;
      }
    }
    return await obtenerAdmin();
  } catch (e) {
    console.error("[Usuarios] No se pudo resolver el dueño del mensaje:", e.message);
    return null;
  }
}

// Credenciales de Meta con las que envía cada usuario. Solo el administrador
// puede caer en el número del .env; un usuario sin número asignado NO puede
// enviar (si no, mandaría desde el número del administrador).
function credencialesMeta(user) {
  const phoneNumberId =
    user.phone_number_id || (user.role === "admin" ? process.env.META_PHONE_NUMBER_ID : null);
  const token = user.meta_access_token || process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId) {
    throw new Error(
      "Tu usuario no tiene un número de WhatsApp asignado. Pedile al administrador que lo configure."
    );
  }
  if (!token) throw new Error("Falta el token de acceso de Meta para este usuario.");
  return { phoneNumberId, token };
}

function publico(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    activo: u.activo,
    ia_activa: u.ia_activa,
    phone_number_id: u.phone_number_id || null,
    tiene_token: Boolean(u.meta_access_token),
    created_at: u.created_at,
  };
}

// Se llama al arrancar: crea el administrador si no existe y le asigna todo lo
// que ya estaba guardado antes de que hubiera usuarios.
async function asegurarAdmin() {
  let admin = await obtenerAdmin();

  if (!admin) {
    const username = process.env.ADMIN_USER || "FRANCO";
    const password = process.env.ADMIN_PASSWORD || "232015";
    const { data, error } = await supabase
      .from("app_users")
      .insert([
        {
          username,
          password_hash: await hashPassword(password),
          role: "admin",
          ia_activa: true, // conserva el comportamiento actual: el bot responde en el número principal
        },
      ])
      .select()
      .single();
    if (error) throw error;
    admin = data;
    invalidarCache();
    console.log(`👑 Administrador "${username}" creado. Cambiá la contraseña desde la app.`);
  }

  for (const tabla of ["messages", "push_subscriptions"]) {
    const { error } = await supabase.from(tabla).update({ user_id: admin.id }).is("user_id", null);
    if (error) console.warn(`[Usuarios] No se pudo asignar ${tabla} huérfanos al admin:`, error.message);
  }
  return admin;
}

module.exports = {
  buscarPorUsername,
  obtenerPorId,
  obtenerAdmin,
  resolverDuenioWebhook,
  credencialesMeta,
  asegurarAdmin,
  invalidarCache,
  publico,
};
