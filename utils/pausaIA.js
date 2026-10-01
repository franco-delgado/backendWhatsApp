// Pausa del agente de IA por contacto.
//
// Cuando vos contestás a mano una conversación, el bot no debe meterse por un
// tiempo (por defecto 60 min, configurable con IA_PAUSA_MINUTOS en el .env).
//
// Cada usuario tiene sus propias pausas: la clave es (usuario + contacto).
//
// La pausa se guarda en memoria (rápido) Y en Supabase (tabla ia_pausas), así
// sobrevive a los reinicios / "sueño" del plan free de Render.
// Si la tabla todavía no existe, funciona igual solo en memoria y avisa en el log.
const { supabase } = require("../supabaseClient");

const MINUTOS_POR_DEFECTO =
  Number(process.env.IA_PAUSA_MINUTOS) > 0 ? Number(process.env.IA_PAUSA_MINUTOS) : 60;

// clave (userId:últimos 10 dígitos) -> timestamp en ms hasta el que está pausado (0 = no pausado)
const cache = new Map();

// En Argentina el mismo celular aparece como 549XXXXXXXXXX (webhook) o
// 54XXXXXXXXXX (a veces al enviar). Los últimos 10 dígitos son siempre iguales.
function ultimos10(numero) {
  return String(numero || "").replace(/\D/g, "").slice(-10);
}
function clave(userId, numero) {
  const n = ultimos10(numero);
  return userId && n ? `${userId}:${n}` : "";
}

async function pausarIA(userId, numero, minutos = MINUTOS_POR_DEFECTO) {
  const k = clave(userId, numero);
  if (!k) return null;

  const hasta = Date.now() + minutos * 60 * 1000;
  cache.set(k, hasta);

  try {
    const { error } = await supabase
      .from("ia_pausas")
      .upsert(
        [{ user_id: userId, numero: ultimos10(numero), pausado_hasta: new Date(hasta).toISOString() }],
        { onConflict: "user_id,numero" }
      );
    if (error) throw error;
  } catch (e) {
    console.warn(
      `[PausaIA] No se pudo guardar la pausa en Supabase (¿falta correr ia_pausas.sql?). ` +
        `Queda solo en memoria. Motivo: ${e.message}`
    );
  }

  console.log(`⏸️  IA pausada para ${k} hasta ${new Date(hasta).toISOString()} (${minutos} min).`);
  return new Date(hasta);
}

// Devuelve la Date hasta la que está pausada, o null si la IA puede responder.
async function iaPausadaHasta(userId, numero) {
  const k = clave(userId, numero);
  if (!k) return null;

  let hasta = cache.get(k);

  if (hasta === undefined) {
    // Primera vez que vemos este número desde que arrancó el proceso: miramos la DB.
    try {
      const { data, error } = await supabase
        .from("ia_pausas")
        .select("pausado_hasta")
        .eq("user_id", userId)
        .eq("numero", ultimos10(numero))
        .maybeSingle();
      if (error) throw error;
      hasta = data ? new Date(data.pausado_hasta).getTime() : 0;
      cache.set(k, hasta);
    } catch (e) {
      console.warn("[PausaIA] No se pudo consultar la pausa en Supabase:", e.message);
      hasta = 0; // sin cachear, así reintenta la próxima vez
    }
  }

  return hasta > Date.now() ? new Date(hasta) : null;
}

async function reanudarIA(userId, numero) {
  const k = clave(userId, numero);
  if (!k) return;
  cache.set(k, 0);
  try {
    const { error } = await supabase
      .from("ia_pausas")
      .delete()
      .eq("user_id", userId)
      .eq("numero", ultimos10(numero));
    if (error) throw error;
  } catch (e) {
    console.warn("[PausaIA] No se pudo borrar la pausa en Supabase:", e.message);
  }
  console.log(`▶️  IA reactivada para ${k}.`);
}

// Lista de pausas vigentes (para que el frontend muestre el estado).
// userId = "todos" (solo lo pide el admin) devuelve las de todos los usuarios.
async function listarPausasActivas(userId) {
  const todos = !userId || userId === "todos";
  try {
    let q = supabase
      .from("ia_pausas")
      .select("user_id, numero, pausado_hasta")
      .gt("pausado_hasta", new Date().toISOString());
    if (!todos) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  } catch (e) {
    // Fallback: lo que haya en memoria.
    const ahora = Date.now();
    return [...cache.entries()]
      .filter(([k, hasta]) => (todos || k.startsWith(`${userId}:`)) && hasta > ahora)
      .map(([k, hasta]) => {
        const i = k.indexOf(":");
        return {
          user_id: k.slice(0, i),
          numero: k.slice(i + 1),
          pausado_hasta: new Date(hasta).toISOString(),
        };
      });
  }
}

module.exports = {
  pausarIA,
  iaPausadaHasta,
  reanudarIA,
  listarPausasActivas,
  MINUTOS_POR_DEFECTO,
};
