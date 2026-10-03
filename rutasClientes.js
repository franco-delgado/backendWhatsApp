// API de la agenda de clientes: nombre, apellido, DNI, teléfono y monto.
const express = require("express");
const { requireAuth, usuarioObjetivo } = require("./utils/auth");
const clientes = require("./utils/clientes");

const router = express.Router();

function responderError(res, e, donde) {
  if (!e.status) console.error(`[Clientes] ${donde}:`, e.message);
  res.status(e.status || 500).json({ success: false, error: e.message });
}

router.get("/api/clientes", requireAuth, async (req, res) => {
  try {
    const data = await clientes.listar(usuarioObjetivo(req));
    res.json({ success: true, total: data.length, data });
  } catch (e) {
    responderError(res, e, "listar");
  }
});

router.post("/api/clientes", requireAuth, async (req, res) => {
  try {
    const data = await clientes.crear(req.user.id, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) {
    responderError(res, e, "crear");
  }
});

// Migración desde localStorage: { contactos: [...] }
router.post("/api/clientes/importar", requireAuth, async (req, res) => {
  try {
    const data = await clientes.importar(req.user.id, req.body?.contactos);
    res.json({ success: true, ...data });
  } catch (e) {
    responderError(res, e, "importar");
  }
});

// Carga masiva desde Excel: { filas: [{ fila, nombre, apellido, dni, numero, monto }] }
router.post("/api/clientes/importar-excel", requireAuth, async (req, res) => {
  try {
    const data = await clientes.importarFilas(req.user.id, req.body?.filas);
    res.json({ success: true, ...data });
  } catch (e) {
    responderError(res, e, "importar-excel");
  }
});

router.put("/api/clientes/:id", requireAuth, async (req, res) => {
  try {
    const data = await clientes.actualizar(req.user.id, req.params.id, req.body);
    res.json({ success: true, data });
  } catch (e) {
    responderError(res, e, "actualizar");
  }
});

router.delete("/api/clientes/:id", requireAuth, async (req, res) => {
  try {
    await clientes.eliminar(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (e) {
    responderError(res, e, "eliminar");
  }
});

module.exports = router;
