// Pausa del agente de IA por contacto.
//
// Cuando vos contestás a mano una conversación, el bot no debe meterse por un
// tiempo (por defecto 60 min, configurable con IA_PAUSA_MINUTOS en el .env).
//
// La pausa se guarda en memoria (rápido) Y en Supabase (tabla ia_pausas), así
// sobrevive a los reinicios / "sueño" del plan free de Render.
// Si la tabla todavía no existe, funciona igual solo en memoria y avisa en el log.
const { supabase } = require("../supabaseClient");

const MINUTOS_POR_DEFECTO =
  Number(process.env.IA_PAUSA_MINUTOS) > 0 ? Number(process.env.IA_PAUSA_MINUTOS) : 60;

// clave (últimos 10 dígitos) -> timestamp en ms hasta el que está pausado (0 = no pausado)
const cache = new Map();

// En Argentina el mismo celular aparece como 549XXXXXXXXXX (webhook) o
// 54XXXXXXXXXX (a veces al enviar). Los últimos 10 dígitos son siempre iguales.
function clave(numero) {
  return String(numero || "").replace(/\D/g, "").slice(-10);
}

async function pausarIA(numero, minutos = MINUTOS_POR_DEFECTO) {
  const k = clave(numero);
  if (!k) return null;

  const hasta = Date.now() + minutos * 60 * 1000;
  cache.set(k, hasta);

  try {
    const { error } = await supabase
      .from("ia_pausas")
      .upsert(
        [{ numero: k, pausado_hasta: new Date(hasta).toISOString() }],
        { onConflict: "numero" }
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
async function iaPausadaHasta(numero) {
  const k = clave(numero);
  if (!k) return null;

  let hasta = cache.get(k);

  if (hasta === undefined) {
    // Primera vez que vemos este número desde que arrancó el proceso: miramos la DB.
    try {
      const { data, error } = await supabase
        .from("ia_pausas")
        .select("pausado_hasta")
        .eq("numero", k)
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

async function reanudarIA(numero) {
  const k = clave(numero);
  if (!k) return;
  cache.set(k, 0);
  try {
    const { error } = await supabase.from("ia_pausas").delete().eq("numero", k);
    if (error) throw error;
  } catch (e) {
    console.warn("[PausaIA] No se pudo borrar la pausa en Supabase:", e.message);
  }
  console.log(`▶️  IA reactivada para ${k}.`);
}

// Lista de pausas vigentes (para que el frontend muestre el estado).
async function listarPausasActivas() {
  try {
    const { data, error } = await supabase
      .from("ia_pausas")
      .select("numero, pausado_hasta")
      .gt("pausado_hasta", new Date().toISOString());
    if (error) throw error;
    return data || [];
  } catch (e) {
    // Fallback: lo que haya en memoria.
    const ahora = Date.now();
    return [...cache.entries()]
      .filter(([, hasta]) => hasta > ahora)
      .map(([numero, hasta]) => ({ numero, pausado_hasta: new Date(hasta).toISOString() }));
  }
}

module.exports = {
  pausarIA,
  iaPausadaHasta,
  reanudarIA,
  listarPausasActivas,
  MINUTOS_POR_DEFECTO,
};
