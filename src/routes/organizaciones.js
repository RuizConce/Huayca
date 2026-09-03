const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

function slugify(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// GET /api/organizaciones?q=texto - listado público (solo aprobadas), para el
// buscador "Apoya a tu organización favorita" del frontend.
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    let query = `
      SELECT id, nombre, tipo, slug, logo_url, descripcion_proyecto, region, comuna
      FROM organizaciones WHERE estado = 'aprobada'
    `;
    const params = [];
    if (q) {
      query += ' AND nombre LIKE ?';
      params.push(`%${q}%`);
    }
    query += ' ORDER BY nombre';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar organizaciones' });
  }
});

// POST /api/organizaciones/registro
router.post('/registro', async (req, res) => {
  try {
    const { nombre, tipo, email, password, telefono, region, comuna, descripcion_proyecto } = req.body;
    if (!nombre || !email || !password) {
      return res.status(400).json({ error: 'nombre, email y password son requeridos' });
    }

    let slug = slugify(nombre);
    const [existe] = await db.query('SELECT id FROM organizaciones WHERE slug = ?', [slug]);
    if (existe.length) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `INSERT INTO organizaciones
       (nombre, tipo, slug, email, password_hash, telefono, region, comuna, descripcion_proyecto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nombre, tipo || 'otro', slug, email, password_hash, telefono, region, comuna, descripcion_proyecto]
    );

    res.status(201).json({
      id: result.insertId,
      slug,
      mensaje: 'Registro recibido. Tu organización queda pendiente de aprobación por Huayca.'
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al registrar organización' });
  }
});

// POST /api/organizaciones/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM organizaciones WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });

    const org = rows[0];
    const valido = await bcrypt.compare(password, org.password_hash);
    if (!valido) return res.status(401).json({ error: 'Credenciales inválidas' });

    if (org.estado !== 'aprobada') {
      return res.status(403).json({ error: `Tu organización está en estado: ${org.estado}` });
    }

    const token = jwt.sign(
      { id: org.id, tipo: 'organizacion', slug: org.slug },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, organizacion: { id: org.id, nombre: org.nombre, slug: org.slug } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/organizaciones/mi-dashboard - resumen de comisiones (requiere auth)
router.get('/mi-dashboard', requireAuth(['organizacion']), async (req, res) => {
  try {
    const orgId = req.user.id;

    const [[org]] = await db.query(
      'SELECT saldo_disponible FROM organizaciones WHERE id = ?',
      [orgId]
    );

    const [[resumen]] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN estado != 'anulada' THEN monto END), 0) AS total_generado,
         COALESCE(SUM(CASE WHEN estado = 'pendiente' THEN monto END), 0) AS saldo_pendiente,
         COALESCE(SUM(CASE WHEN estado = 'pagada' THEN monto END), 0) AS total_pagado,
         COUNT(CASE WHEN estado != 'anulada' THEN 1 END) AS ventas_realizadas
       FROM comisiones
       WHERE organizacion_id = ? AND tipo = 'afiliado'`,
      [orgId]
    );

    const [ultimasComisiones] = await db.query(
      `SELECT c.id, c.monto, c.estado, c.created_at, p.codigo AS pedido_codigo
       FROM comisiones c
       JOIN pedidos p ON p.id = c.pedido_id
       WHERE c.organizacion_id = ? AND c.tipo = 'afiliado'
       ORDER BY c.created_at DESC
       LIMIT 10`,
      [orgId]
    );

    res.json({
      saldo_disponible: org.saldo_disponible, // comisiones activadas y aún no liquidadas
      resumen,
      ultimas_comisiones: ultimasComisiones
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener dashboard' });
  }
});

// GET /api/organizaciones/catalogo-comisiones - catálogo de productos
// activos para que la organización decida qué le conviene promocionar,
// pero SOLO con lo que le importa desde su perspectiva: nombre, imagen,
// precio final y SU comisión (comision_afiliado, acá renombrada
// "tu_comision"). El SELECT elige columnas de forma explícita a propósito
// (nunca "SELECT p.*") para que sea imposible que precio_proveedor,
// comision_huayca o comision_eliss se cuelen en la respuesta — esa info es
// interna de Huayca, ni siquiera debería poder verse inspeccionando la
// petición desde el navegador. Ordenado de mayor a menor comisión: lo
// primero que ve la organización es lo que más le conviene vender.
// Va ANTES de /:slug (mismo motivo que /mi-dashboard): si se registrara
// después, "catalogo-comisiones" matchearía ahí como si fuera un slug.
router.get('/catalogo-comisiones', requireAuth(['organizacion']), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.nombre, p.slug, p.imagen_principal, p.precio_final,
              p.comision_afiliado AS tu_comision
       FROM productos p
       WHERE p.estado = 'activo'
       ORDER BY tu_comision DESC, p.nombre`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el catálogo de comisiones' });
  }
});

// GET /api/organizaciones/:slug - perfil público de una organización aprobada
// (usado para el banner "estás comprando a través de..." y su página de perfil).
// Va al final: si se registrara antes que /mi-dashboard, "mi-dashboard"
// matchearía acá como si fuera un slug y nunca llegaría a esa ruta.
router.get('/:slug', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, nombre, tipo, slug, logo_url, descripcion_proyecto, region, comuna
       FROM organizaciones WHERE slug = ? AND estado = 'aprobada'`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Organización no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener organización' });
  }
});

module.exports = router;
