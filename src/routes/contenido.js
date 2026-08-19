const express = require('express');
const router = express.Router();
const db = require('../config/db');

// GET /api/contenido - contenido editable del sitio público, combinado en
// un solo objeto { header, hero, organizaciones_cards, banner_apoya,
// como_funciona, footer }. Pública, sin auth: el frontend la llama una vez
// al cargar la página. Si una clave no existiera (nunca debería pasar, ver
// el seed en src/db/migrate.js), simplemente no viene en la respuesta y el
// frontend cae al valor por defecto que ya tiene escrito en el HTML.
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT clave, valor FROM contenido_sitio');
    const contenido = {};
    for (const fila of rows) {
      contenido[fila.clave] = typeof fila.valor === 'string' ? JSON.parse(fila.valor) : fila.valor;
    }
    res.json(contenido);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el contenido del sitio' });
  }
});

module.exports = router;
