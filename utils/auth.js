// Middlewares de Express: exigen sesión válida y, opcionalmente, rol admin.
const { verificarToken, versionPassword } = require("./seguridad");
const usuarios = require("./usuarios");
const { esUuid } = require("./contactos");

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const payload = h.startsWith("Bearer ") ? verificarToken(h.slice(7)) : null;
  if (!payload) {
    return res.status(401).json({ success: false, error: "Sesión inválida o vencida." });
  }
  try {
    const user = await usuarios.obtenerPorId(payload.sub);
    if (!user || !user.activo || payload.pv !== versionPassword(user)) {
      return res.status(401).json({ success: false, error: "Sesión inválida o vencida." });
    }
    req.user = user;
    next();
  } catch (e) {
    console.error("[Auth] Error validando sesión:", e.message);
    res.status(500).json({ success: false, error: "No se pudo validar la sesión." });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ success: false, error: "Solo el administrador puede hacer esto." });
  }
  next();
}

// Usuario cuyos datos se consultan. Cada uno solo ve los propios; el admin
// puede pedir los de otro con ?userId=<id>, o los de todos con ?userId=todos.
function usuarioObjetivo(req) {
  const pedido = req.query.userId;
  if (!pedido || pedido === req.user.id) return req.user.id;
  if (req.user.role !== "admin") {
    const err = new Error("No tenés permiso para ver los datos de otro usuario.");
    err.status = 403;
    throw err;
  }
  if (pedido === "todos") return "todos";
  if (!esUuid(pedido)) {
    const err = new Error("userId inválido.");
    err.status = 400;
    throw err;
  }
  return String(pedido);
}

module.exports = { requireAuth, requireAdmin, usuarioObjetivo };
