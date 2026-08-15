const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const TIPOS_VALIDOS = ['devolucion', 'garantia', 'reparacion', 'reclamo'];
const ESTADOS_VALIDOS = ['abierto', 'en_revision', 'derivado_proveedor', 'resuelto', 'rechazado'];

// POST /api/tickets - el cliente abre un ticket de devolución/garantía sobre un pedido
// Body: { pedido_codigo, email, tipo, descripcion }
// El proveedor es responsable según política de Huayca y la normativa
// chilena de protección al consumidor; el ticket queda abierto para que
// Huayca lo derive.
router.post('/', async (req, res) => {
  try {
    const { pedido_codigo, email, tipo, descripcion } = req.body;
    if (!pedido_codigo || !email || !tipo || !descripcion) {
      return res.status(400).json({ error: 'pedido_codigo, email, tipo y descripcion son requeridos' });
    }
    if (!TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_VALIDOS.join(', ')}` });
    }

    // Se valida el email contra el pedido para que solo quien compró pueda abrir el ticket
    const [rows] = await db.query(
      `SELECT p.id FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       WHERE p.codigo = ? AND c.email = ?`,
      [pedido_codigo, email]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No se encontró un pedido con ese código para ese email' });
    }

    const [result] = await db.query(
      `INSERT INTO tickets (pedido_id, tipo, descripcion) VALUES (?, ?, ?)`,
      [rows[0].id, tipo, descripcion]
    );
    res.status(201).json({ id: result.insertId, estado: 'abierto' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear ticket' });
  }
});

// GET /api/tickets/pedido/:codigo?email=... - listar tickets de un pedido (verificado por email)
router.get('/pedido/:codigo', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email es requerido como query param' });

    const [rows] = await db.query(
      `SELECT t.id, t.tipo, t.descripcion, t.estado, t.respuesta, t.created_at, t.updated_at
       FROM tickets t
       JOIN pedidos p ON p.id = t.pedido_id
       JOIN clientes c ON c.id = p.cliente_id
       WHERE p.codigo = ? AND c.email = ?
       ORDER BY t.created_at DESC`,
      [req.params.codigo, email]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar tickets' });
  }
});

// -------------------------------------------------
// Admin: bandeja de tickets
// -------------------------------------------------

// GET /api/tickets?estado=abierto
router.get('/', requireAuth(['admin']), async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `
      SELECT t.*, p.codigo AS pedido_codigo, c.nombre AS cliente_nombre, c.email AS cliente_email,
             pr.nombre AS producto_nombre, prov.nombre AS proveedor_nombre, prov.email_contacto AS proveedor_email
      FROM tickets t
      JOIN pedidos p ON p.id = t.pedido_id
      JOIN clientes c ON c.id = p.cliente_id
      JOIN productos pr ON pr.id = p.producto_id
      JOIN proveedores prov ON prov.id = p.proveedor_id
    `;
    const params = [];
    if (estado) { query += ' WHERE t.estado = ?'; params.push(estado); }
    query += ' ORDER BY t.created_at DESC';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar tickets' });
  }
});

// PATCH /api/tickets/:id  Body: { estado, respuesta }
router.patch('/:id', requireAuth(['admin']), async (req, res) => {
  try {
    const { estado, respuesta } = req.body;
    if (estado && !ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}` });
    }
    const [result] = await db.query(
      `UPDATE tickets SET estado = COALESCE(?, estado), respuesta = COALESCE(?, respuesta) WHERE id = ?`,
      [estado || null, respuesta || null, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Ticket no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar ticket' });
  }
});

module.exports = router;
