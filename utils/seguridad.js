// Contraseñas (scrypt) y tokens de sesión firmados (HMAC-SHA256).
// Solo usa el módulo "crypto" de Node: no hace falta instalar nada.
const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const DURACION_TOKEN_SEG = 30 * 24 * 60 * 60; // 30 días

function secreto() {
  // AUTH_SECRET es lo recomendado. Si no está, se deriva de la service key de
  // Supabase (que ya es secreta y estable), así las sesiones sobreviven a los
  // reinicios de Render.
  return (
    process.env.AUTH_SECRET ||
    crypto
      .createHash("sha256")
      .update("wa-auth-v1:" + (process.env.SUPABASE_SERVICE_ROLE_KEY || "sin-clave"))
      .digest("hex")
  );
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password, guardado) {
  try {
    const [alg, saltHex, hashHex] = String(guardado || "").split("$");
    if (alg !== "scrypt" || !saltHex || !hashHex) return false;
    const esperado = Buffer.from(hashHex, "hex");
    const calculado = await scrypt(String(password), Buffer.from(saltHex, "hex"), esperado.length);
    return crypto.timingSafeEqual(esperado, calculado);
  } catch {
    return false;
  }
}

// Cambia cuando cambia la contraseña: así, al resetearla, las sesiones viejas dejan de valer.
function versionPassword(user) {
  return crypto.createHash("sha256").update(String(user.password_hash)).digest("hex").slice(0, 12);
}

function firmar(cuerpo) {
  return crypto.createHmac("sha256", secreto()).update(cuerpo).digest("base64url");
}

function crearToken(user) {
  const payload = {
    sub: user.id,
    pv: versionPassword(user),
    exp: Math.floor(Date.now() / 1000) + DURACION_TOKEN_SEG,
  };
  const cuerpo = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${cuerpo}.${firmar(cuerpo)}`;
}

function verificarToken(token) {
  try {
    const [cuerpo, firma] = String(token || "").split(".");
    if (!cuerpo || !firma) return null;
    const esperada = firmar(cuerpo);
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(cuerpo, "base64url").toString("utf8"));
    if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, crearToken, verificarToken, versionPassword };
