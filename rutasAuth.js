// Login, sesión actual y administración de usuarios.
const express = require("express");
const { supabase } = require("./supabaseClient");
const { hashPassword, verifyPassword, crearToken } = require("./utils/seguridad");
const { requireAuth, requireAdmin } = require("./utils/auth");
const usuarios = require("./utils/usuarios");

const router = express.Router();

const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;
const MIN_PASSWORD = 6;

// ---- Freno a la fuerza bruta: 5 intentos fallidos => 15 min de bloqueo ----
const intentos = new Map(); // "ip|usuario" -> { n, hasta }
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

function claveIntento(req, usuario) {
  return `${req.ip}|${String(usuario || "").toLowerCase()}`;
}
function estaBloqueado(k) {
  const i = intentos.get(k);
  if (!i) return false;
  if (i.hasta && i.hasta > Date.now()) return true;
  if (i.hasta && i.hasta <= Date.now()) intentos.delete(k);
  return false;
}
function registrarFallo(k) {
  const i = intentos.get(k) || { n: 0, hasta: 0 };
  i.n += 1;
  if (i.n >= MAX_INTENTOS) i.hasta = Date.now() + BLOQUEO_MS;
  intentos.set(k, i);
  if (intentos.size > 5000) intentos.clear();
}

function errorDeTabla(e) {
  return e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "42703" || e.code === "PGRST204");
}
function responderError(res, e, contexto) {
  console.error(`[${contexto}]`, e.message || e);
  if (errorDeTabla(e)) {
    return res.status(500).json({
      success: false,
      error: "Falta la estructura de usuarios en la base. Ejecutá usuarios.sql en Supabase > SQL Editor.",
    });
  }
  if (e && e.code === "23505") {
    const msg = String(e.message || "").includes("phone_number_id")
      ? "Ese número de WhatsApp ya está asignado a otro usuario."
      : "Ya existe un usuario con ese nombre.";
    return res.status(409).json({ success: false, error: msg });
  }
  res.status(500).json({ success: false, error: "Error interno del servidor." });
}

// ------------------------------------------------------------------ sesión
router.post("/api/auth/login", async (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario || !password) {
    return res.status(400).json({ success: false, error: "Ingresá usuario y contraseña." });
  }

  const k = claveIntento(req, usuario);
  if (estaBloqueado(k)) {
    return res
      .status(429)
      .json({ success: false, error: "Demasiados intentos fallidos. Probá de nuevo en 15 minutos." });
  }

  try {
    const user = await usuarios.buscarPorUsername(usuario);
    const ok = user && user.activo && (await verifyPassword(password, user.password_hash));
    if (!ok) {
      registrarFallo(k);
      return res.status(401).json({ success: false, error: "Usuario o contraseña incorrectos." });
    }
    intentos.delete(k);
    res.json({ success: true, token: crearToken(user), usuario: usuarios.publico(user) });
  } catch (e) {
    responderError(res, e, "Auth login");
  }
});

router.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ success: true, usuario: usuarios.publico(req.user) });
});

router.post("/api/auth/cambiar-password", requireAuth, async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (!(await verifyPassword(actual || "", req.user.password_hash))) {
    return res.status(400).json({ success: false, error: "La contraseña actual no es correcta." });
  }
  if (String(nueva || "").length < MIN_PASSWORD) {
    return res
      .status(400)
      .json({ success: false, error: `La nueva contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
  }
  try {
    const { data, error } = await supabase
      .from("app_users")
      .update({ password_hash: await hashPassword(nueva) })
      .eq("id", req.user.id)
      .select()
      .single();
    if (error) throw error;
    usuarios.invalidarCache();
    // Devuelve un token nuevo: el anterior deja de valer al cambiar la contraseña.
    res.json({ success: true, token: crearToken(data) });
  } catch (e) {
    responderError(res, e, "Auth cambiar-password");
  }
});

// ---------------------------------------------------- administración (admin)
router.get("/api/admin/usuarios", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("app_users")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: (data || []).map(usuarios.publico) });
  } catch (e) {
    responderError(res, e, "Admin listar usuarios");
  }
});

// Normaliza y valida los campos opcionales compartidos por alta y edición.
function leerCampos(body, parcial) {
  const out = {};
  if (body.phone_number_id !== undefined) {
    const v = String(body.phone_number_id ?? "").trim();
    if (v && !/^\d{5,25}$/.test(v)) throw new Error("El Phone Number ID debe contener solo dígitos.");
    out.phone_number_id = v || null;
  }
  if (body.meta_access_token !== undefined) {
    const v = body.meta_access_token === null ? "" : String(body.meta_access_token).trim();
    out.meta_access_token = v || null;
  }
  if (body.ia_activa !== undefined) out.ia_activa = Boolean(body.ia_activa);
  if (parcial && body.activo !== undefined) out.activo = Boolean(body.activo);
  if (body.role !== undefined) {
    if (!["admin", "user"].includes(body.role)) throw new Error("Rol inválido.");
    out.role = body.role;
  }
  return out;
}

router.post("/api/admin/usuarios", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!USERNAME_RE.test(String(username || ""))) {
      return res.status(400).json({
        success: false,
        error: "El usuario debe tener entre 3 y 30 caracteres (letras, números, punto, guion).",
      });
    }
    if (String(password || "").length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ success: false, error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
    }
    const campos = leerCampos(req.body, false);

    const { data, error } = await supabase
      .from("app_users")
      .insert([{ username, password_hash: await hashPassword(password), ...campos }])
      .select()
      .single();
    if (error) throw error;
    usuarios.invalidarCache();
    res.status(201).json({ success: true, data: usuarios.publico(data) });
  } catch (e) {
    if (e.message && !e.code) return res.status(400).json({ success: false, error: e.message });
    responderError(res, e, "Admin crear usuario");
  }
});

router.patch("/api/admin/usuarios/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const cambios = leerCampos(req.body || {}, true);

    // Para no quedarte afuera: el admin no puede desactivarse ni quitarse el rol a sí mismo.
    if (id === req.user.id && (cambios.activo === false || (cambios.role && cambios.role !== "admin"))) {
      return res
        .status(400)
        .json({ success: false, error: "No podés desactivarte ni quitarte el rol de administrador." });
    }

    if (req.body?.password !== undefined && req.body.password !== "") {
      if (String(req.body.password).length < MIN_PASSWORD) {
        return res
          .status(400)
          .json({ success: false, error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
      }
      cambios.password_hash = await hashPassword(req.body.password);
    }
    if (Object.keys(cambios).length === 0) {
      return res.status(400).json({ success: false, error: "No hay cambios para guardar." });
    }

    const { data, error } = await supabase
      .from("app_users")
      .update(cambios)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: "Usuario no encontrado." });
    usuarios.invalidarCache();
    res.json({ success: true, data: usuarios.publico(data) });
  } catch (e) {
    if (e.message && !e.code) return res.status(400).json({ success: false, error: e.message });
    responderError(res, e, "Admin editar usuario");
  }
});

module.exports = router;
