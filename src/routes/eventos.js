const express = require('express');
const router = express.Router();
const db = require('../config/db');

const TIPOS_VALIDOS = ['vista_producto', 'agregar_carrito', 'inicio_checkout', 'compra_completada'];

// POST /api/eventos - tracking del embudo de conversión, público y sin
// auth a propósito (session_id reemplaza cualquier noción de cuenta acá).
// El frontend lo llama "fire and forget" (sin esperar la respuesta de
// forma crítica para nada del flujo de compra), así que este endpoint
// tiene que ser liviano y, sobre todo, nunca tirar un error que se sienta
// como "rompió algo": cualquier body raro simplemente no se guarda, sin
// tumbar nada aguas arriba.
router.post('/', async (req, res) => {
  try {
    const { tipo, producto_id, organizacion_id, session_id, pedido_id } = req.body || {};

    if (!TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_VALIDOS.join(', ')}` });
    }
    // session_id lo genera el frontend (ver capturarSessionId en huayca.js)
    // y viaja en cada evento — sin él no hay forma de agrupar el embudo por
    // visita, así que es el único campo realmente obligatorio.
    const sessionId = typeof session_id === 'string' ? session_id.trim().slice(0, 64) : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id es requerido' });
    }

    // Los ids pueden llegar como string (ej. tomados directo de un query
    // param) o número; se normalizan acá en vez de confiar en el tipo que
    // mandó el front.
    const aEnteroONulo = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) ? n : null;
    };

    await db.query(
      `INSERT INTO eventos_actividad (tipo, producto_id, organizacion_id, session_id, pedido_id)
       VALUES (?, ?, ?, ?, ?)`,
      [tipo, aEnteroONulo(producto_id), aEnteroONulo(organizacion_id), sessionId, aEnteroONulo(pedido_id)]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    // Tracking best-effort: se loguea para poder debuggear, pero nunca
    // debería tumbar nada del lado del comprador (el front ni siquiera
    // espera esta respuesta de forma bloqueante).
    console.error('Error al guardar evento de actividad:', err);
    res.status(500).json({ error: 'Error al guardar el evento' });
  }
});

module.exports = router;
