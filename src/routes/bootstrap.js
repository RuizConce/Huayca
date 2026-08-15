const express = require('express');
const router = express.Router();
const { runMigration } = require('../db/migrate');
const { runSeed } = require('../db/seed');

// Rutas pensadas para dispararse una sola vez desde el navegador (ej. desde
// una tablet, sin terminal ni Railway CLI a mano). Se protegen con
// BOOTSTRAP_TOKEN: si esa variable no está configurada en el servicio, las
// rutas responden 404 como si no existieran.
function verificarToken(req, res) {
  const configurado = process.env.BOOTSTRAP_TOKEN;
  if (!configurado) {
    res.status(404).json({ error: 'No encontrado' });
    return false;
  }
  if (req.query.token !== configurado) {
    res.status(403).json({ error: 'Token inválido' });
    return false;
  }
  return true;
}

// GET /api/bootstrap/migrate?token=...  → aplica schema.sql
router.get('/migrate', async (req, res) => {
  if (!verificarToken(req, res)) return;
  try {
    const resultado = await runMigration();
    res.json(resultado);
  } catch (err) {
    console.error('Error en /api/bootstrap/migrate:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bootstrap/seed?token=...  → carga admin + PROTEGE+ + productos + organización demo
router.get('/seed', async (req, res) => {
  if (!verificarToken(req, res)) return;
  try {
    const resultado = await runSeed();
    res.json(resultado);
  } catch (err) {
    console.error('Error en /api/bootstrap/seed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
