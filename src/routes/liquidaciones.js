const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

// -------------------------------------------------
// Organización: solicitar liquidación de su saldo pendiente
// -------------------------------------------------

// POST /api/liquidaciones  Body: { motivo_solicitud }
// Junta todas las comisiones de afiliado en estado 'pendiente' de la
// organización en una sola liquidación a solicitar. No es un retiro
// automático: Huayca debe aprobarla y gestionarla (PATCH .../aprobar, .../pagar).
router.post('/', requireAuth(['organizacion']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { motivo_solicitud } = req.body;
    if (!motivo_solicitud || !motivo_solicitud.trim()) {
      return res.status(400).json({ error: 'motivo_solicitud es requerido (para qué proyecto se destinan los fondos)' });
    }
    const orgId = req.user.id;

    await conn.beginTransaction();

    const [comisionesPendientes] = await conn.query(
      `SELECT id, monto FROM comisiones
       WHERE organizacion_id = ? AND tipo = 'afiliado' AND estado = 'pendiente'
       FOR UPDATE`,
      [orgId]
    );

    if (!comisionesPendientes.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'No tienes saldo pendiente disponible para liquidar' });
    }

    const montoTotal = comisionesPendientes.reduce((acc, c) => acc + Number(c.monto), 0);

    const [resultLiq] = await conn.query(
      `INSERT INTO liquidaciones (organizacion_id, monto_total, estado, motivo_solicitud, solicitada_at)
       VALUES (?, ?, 'solicitada', ?, NOW())`,
      [orgId, montoTotal, motivo_solicitud]
    );
    const liquidacionId = resultLiq.insertId;

    await conn.query(
      `UPDATE comisiones SET estado = 'solicitada', liquidacion_id = ?
       WHERE id IN (?)`,
      [liquidacionId, comisionesPendientes.map((c) => c.id)]
    );

    await conn.commit();
    res.status(201).json({ id: liquidacionId, monto_total: montoTotal, estado: 'solicitada' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al solicitar liquidación' });
  } finally {
    conn.release();
  }
});

// GET /api/liquidaciones/mias - historial propio de la organización
router.get('/mias', requireAuth(['organizacion']), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, monto_total, estado, motivo_solicitud, comprobante_url,
              solicitada_at, aprobada_at, pagada_at, created_at
       FROM liquidaciones WHERE organizacion_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener liquidaciones' });
  }
});

// -------------------------------------------------
// Admin: revisar, aprobar, rechazar y marcar como pagada
// -------------------------------------------------

// GET /api/liquidaciones?estado=solicitada
router.get('/', requireAuth(['admin']), async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `
      SELECT l.*, o.nombre AS organizacion_nombre, o.slug AS organizacion_slug
      FROM liquidaciones l
      LEFT JOIN organizaciones o ON o.id = l.organizacion_id
    `;
    const params = [];
    if (estado) { query += ' WHERE l.estado = ?'; params.push(estado); }
    query += ' ORDER BY l.created_at DESC';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar liquidaciones' });
  }
});

// PATCH /api/liquidaciones/:id/aprobar
router.patch('/:id/aprobar', requireAuth(['admin']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `UPDATE liquidaciones SET estado = 'aprobada', aprobada_at = NOW()
       WHERE id = ? AND estado = 'solicitada'`,
      [req.params.id]
    );
    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(409).json({ error: 'La liquidación no existe o no está en estado solicitada' });
    }
    await conn.query(`UPDATE comisiones SET estado = 'aprobada' WHERE liquidacion_id = ?`, [req.params.id]);
    await conn.commit();
    res.json({ ok: true, mensaje: 'Liquidación aprobada' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al aprobar liquidación' });
  } finally {
    conn.release();
  }
});

// PATCH /api/liquidaciones/:id/rechazar
router.patch('/:id/rechazar', requireAuth(['admin']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM liquidaciones WHERE id = ? AND estado IN ('solicitada','aprobada') FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'La liquidación no existe o ya fue procesada' });
    }
    await conn.query(`UPDATE liquidaciones SET estado = 'rechazada' WHERE id = ?`, [req.params.id]);
    // Las comisiones vuelven a estar disponibles para una futura solicitud
    await conn.query(
      `UPDATE comisiones SET estado = 'pendiente', liquidacion_id = NULL WHERE liquidacion_id = ?`,
      [req.params.id]
    );
    await conn.commit();
    res.json({ ok: true, mensaje: 'Liquidación rechazada, el saldo vuelve a estar disponible' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al rechazar liquidación' });
  } finally {
    conn.release();
  }
});

// PATCH /api/liquidaciones/:id/pagar  Body: { comprobante_url }
router.patch('/:id/pagar', requireAuth(['admin']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { comprobante_url } = req.body;
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM liquidaciones WHERE id = ? AND estado = 'aprobada' FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'La liquidación no existe o no está aprobada' });
    }
    const liquidacion = rows[0];

    await conn.query(
      `UPDATE liquidaciones SET estado = 'pagada', pagada_at = NOW(), comprobante_url = COALESCE(?, comprobante_url)
       WHERE id = ?`,
      [comprobante_url || null, req.params.id]
    );
    await conn.query(`UPDATE comisiones SET estado = 'pagada' WHERE liquidacion_id = ?`, [req.params.id]);
    if (liquidacion.organizacion_id) {
      await conn.query(
        `UPDATE organizaciones SET saldo_disponible = saldo_disponible - ? WHERE id = ?`,
        [liquidacion.monto_total, liquidacion.organizacion_id]
      );
    }
    await conn.commit();
    res.json({ ok: true, mensaje: 'Liquidación marcada como pagada' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el pago de la liquidación' });
  } finally {
    conn.release();
  }
});

module.exports = router;
