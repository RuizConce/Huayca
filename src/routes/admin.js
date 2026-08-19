const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { aprobarPagoPedido } = require('../services/pagos.service');

// Railway no tiene disco persistente entre deploys, así que no guardamos
// archivos en el filesystem: se reciben en memoria y se convierten a
// data: URI (base64) para guardarlos directo en la fila correspondiente
// (proveedores.logo_url, productos.imagen_principal, contenido_sitio.valor).
// 400KB de tope para que un solo PUT con varias imágenes (ej. las 6 del
// carrusel del hero) no se acerque al límite de payload de la base ni del
// body-parser de Express.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 400 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('El archivo debe ser una imagen'));
    cb(null, true);
  }
});

function slugify(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// POST /api/admin/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM administradores WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });

    const admin = rows[0];
    const valido = await bcrypt.compare(password, admin.password_hash);
    if (!valido) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign(
      { id: admin.id, tipo: 'admin', rol: admin.rol },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, admin: { id: admin.id, nombre: admin.nombre, rol: admin.rol } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// Todo lo que sigue requiere admin autenticado
router.use(requireAuth(['admin']));

// -------------------------------------------------
// SUBIDA DE IMÁGENES (logo de marca, imagen de producto, contenido del sitio)
// -------------------------------------------------

// POST /api/admin/upload-imagen  Body: multipart/form-data, campo "imagen"
// Devuelve { url } — un data: URI listo para guardar tal cual en cualquiera
// de los campos de imagen (todos ya aceptan data:image/... además de URLs).
router.post('/upload-imagen', (req, res) => {
  upload.single('imagen')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'La imagen pesa más de 400KB. Comprimila (ej. en tinypng.com) y volvé a intentar.' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen (campo "imagen")' });

    const url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    res.json({ url, bytes: req.file.size });
  });
});

// -------------------------------------------------
// ORGANIZACIONES: aprobar / rechazar / suspender
// -------------------------------------------------

// GET /api/admin/organizaciones?estado=pendiente
router.get('/organizaciones', async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `SELECT id, nombre, tipo, slug, email, telefono, region, comuna,
                        descripcion_proyecto, estado, saldo_disponible, created_at
                 FROM organizaciones`;
    const params = [];
    if (estado) {
      query += ' WHERE estado = ?';
      params.push(estado);
    }
    query += ' ORDER BY created_at DESC';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar organizaciones' });
  }
});

// PATCH /api/admin/organizaciones/:id/aprobar
router.patch('/organizaciones/:id/aprobar', async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE organizaciones SET estado = 'aprobada', aprobada_por = ?, aprobada_at = NOW()
       WHERE id = ? AND estado = 'pendiente'`,
      [req.user.id, req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ error: 'La organización no existe o no está pendiente de aprobación' });
    }
    res.json({ ok: true, mensaje: 'Organización aprobada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al aprobar organización' });
  }
});

// PATCH /api/admin/organizaciones/:id/rechazar
router.patch('/organizaciones/:id/rechazar', async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE organizaciones SET estado = 'rechazada' WHERE id = ? AND estado = 'pendiente'`,
      [req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ error: 'La organización no existe o no está pendiente de aprobación' });
    }
    res.json({ ok: true, mensaje: 'Organización rechazada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al rechazar organización' });
  }
});

// PATCH /api/admin/organizaciones/:id/suspender (organización ya aprobada, por mal uso)
router.patch('/organizaciones/:id/suspender', async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE organizaciones SET estado = 'suspendida' WHERE id = ? AND estado = 'aprobada'`,
      [req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ error: 'La organización no existe o no está aprobada' });
    }
    res.json({ ok: true, mensaje: 'Organización suspendida' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al suspender organización' });
  }
});

// -------------------------------------------------
// PROVEEDORES (CRUD)
// -------------------------------------------------

router.get('/proveedores', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM proveedores ORDER BY nombre');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar proveedores' });
  }
});

router.post('/proveedores', async (req, res) => {
  try {
    const { nombre, razon_social, rut, email_contacto, telefono_contacto, logo_url, datos_bancarios, gestiona_despacho } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });

    const [result] = await db.query(
      `INSERT INTO proveedores (nombre, razon_social, rut, email_contacto, telefono_contacto, logo_url, datos_bancarios, gestiona_despacho)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nombre, razon_social || null, rut || null, email_contacto || null, telefono_contacto || null,
        logo_url || null, JSON.stringify(datos_bancarios || null), gestiona_despacho ?? true
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear proveedor' });
  }
});

router.put('/proveedores/:id', async (req, res) => {
  try {
    const { nombre, razon_social, rut, email_contacto, telefono_contacto, logo_url, datos_bancarios, gestiona_despacho, estado } = req.body;
    const [result] = await db.query(
      `UPDATE proveedores SET
         nombre = COALESCE(?, nombre),
         razon_social = COALESCE(?, razon_social),
         rut = COALESCE(?, rut),
         email_contacto = COALESCE(?, email_contacto),
         telefono_contacto = COALESCE(?, telefono_contacto),
         logo_url = COALESCE(?, logo_url),
         datos_bancarios = COALESCE(?, datos_bancarios),
         gestiona_despacho = COALESCE(?, gestiona_despacho),
         estado = COALESCE(?, estado)
       WHERE id = ?`,
      [
        nombre || null, razon_social || null, rut || null, email_contacto || null, telefono_contacto || null,
        logo_url || null, datos_bancarios ? JSON.stringify(datos_bancarios) : null, gestiona_despacho, estado || null, req.params.id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar proveedor' });
  }
});

// Baja lógica: no se elimina, hay productos/pedidos históricos que dependen de él
router.delete('/proveedores/:id', async (req, res) => {
  try {
    const [result] = await db.query(`UPDATE proveedores SET estado = 'inactivo' WHERE id = ?`, [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json({ ok: true, mensaje: 'Proveedor marcado como inactivo' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al desactivar proveedor' });
  }
});

// -------------------------------------------------
// CATEGORÍAS (soporte mínimo para poder clasificar productos)
// -------------------------------------------------

router.get('/categorias', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM categorias ORDER BY orden, nombre');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar categorías' });
  }
});

router.post('/categorias', async (req, res) => {
  try {
    const { nombre, icono, orden } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });

    let slug = slugify(nombre);
    const [existe] = await db.query('SELECT id FROM categorias WHERE slug = ?', [slug]);
    if (existe.length) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    const [result] = await db.query(
      'INSERT INTO categorias (nombre, slug, icono, orden) VALUES (?, ?, ?, ?)',
      [nombre, slug, icono || null, orden || 0]
    );
    res.status(201).json({ id: result.insertId, slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear categoría' });
  }
});

// -------------------------------------------------
// PRODUCTOS (CRUD) — Huayca define precio_proveedor / comisiones, no la organización
// -------------------------------------------------

// GET /api/admin/productos?proveedor_id=X - incluye todos los estados (borrador, agotado, pausado, activo)
router.get('/productos', async (req, res) => {
  try {
    const { proveedor_id } = req.query;
    let query = `
      SELECT p.*, pr.nombre AS proveedor_nombre, c.nombre AS categoria_nombre
      FROM productos p
      JOIN proveedores pr ON pr.id = p.proveedor_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
    `;
    const params = [];
    if (proveedor_id) {
      query += ' WHERE p.proveedor_id = ?';
      params.push(proveedor_id);
    }
    query += ' ORDER BY p.created_at DESC';

    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar productos' });
  }
});

router.post('/productos', async (req, res) => {
  try {
    const {
      proveedor_id, categoria_id, nombre, descripcion, imagen_principal, imagenes,
      precio_proveedor, comision_afiliado, comision_huayca, precio_normal,
      stock, garantia_meses, estado
    } = req.body;

    if (!proveedor_id || !nombre || precio_proveedor == null) {
      return res.status(400).json({ error: 'proveedor_id, nombre y precio_proveedor son requeridos' });
    }

    let slug = slugify(nombre);
    const [existe] = await db.query('SELECT id FROM productos WHERE slug = ?', [slug]);
    if (existe.length) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    const [result] = await db.query(
      `INSERT INTO productos
       (proveedor_id, categoria_id, nombre, slug, descripcion, imagen_principal, imagenes,
        precio_proveedor, comision_afiliado, comision_huayca, precio_normal, stock, garantia_meses, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proveedor_id, categoria_id || null, nombre, slug, descripcion || null, imagen_principal || null,
        JSON.stringify(imagenes || []), precio_proveedor, comision_afiliado || 0, comision_huayca || 0,
        precio_normal || null, stock ?? 0, garantia_meses ?? 6, estado || 'borrador'
      ]
    );
    res.status(201).json({ id: result.insertId, slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

router.put('/productos/:id', async (req, res) => {
  try {
    const {
      categoria_id, nombre, descripcion, imagen_principal, imagenes,
      precio_proveedor, comision_afiliado, comision_huayca, precio_normal,
      stock, garantia_meses, estado
    } = req.body;

    const [result] = await db.query(
      `UPDATE productos SET
         categoria_id = COALESCE(?, categoria_id),
         nombre = COALESCE(?, nombre),
         descripcion = COALESCE(?, descripcion),
         imagen_principal = COALESCE(?, imagen_principal),
         imagenes = COALESCE(?, imagenes),
         precio_proveedor = COALESCE(?, precio_proveedor),
         comision_afiliado = COALESCE(?, comision_afiliado),
         comision_huayca = COALESCE(?, comision_huayca),
         precio_normal = COALESCE(?, precio_normal),
         stock = COALESCE(?, stock),
         garantia_meses = COALESCE(?, garantia_meses),
         estado = COALESCE(?, estado)
       WHERE id = ?`,
      [
        categoria_id ?? null, nombre || null, descripcion || null, imagen_principal || null,
        imagenes ? JSON.stringify(imagenes) : null,
        precio_proveedor ?? null, comision_afiliado ?? null, comision_huayca ?? null, precio_normal ?? null,
        stock ?? null, garantia_meses ?? null, estado || null, req.params.id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

// Baja lógica: pausa el producto; no se borra por integridad con pedidos históricos
router.delete('/productos/:id', async (req, res) => {
  try {
    const [result] = await db.query(`UPDATE productos SET estado = 'pausado' WHERE id = ?`, [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, mensaje: 'Producto pausado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al pausar producto' });
  }
});

// -------------------------------------------------
// PEDIDOS (vista operativa para el equipo Huayca)
// -------------------------------------------------

// GET /api/admin/pedidos?estado_pago=&estado_despacho=
router.get('/pedidos', async (req, res) => {
  try {
    const { estado_pago, estado_despacho } = req.query;
    let query = `
      SELECT p.id, p.codigo, p.monto_total, p.cantidad, p.estado_pago, p.estado_despacho,
             p.estado_liquidacion, p.created_at,
             c.nombre AS cliente_nombre, c.email AS cliente_email,
             pr.nombre AS producto_nombre, prov.nombre AS proveedor_nombre,
             o.nombre AS organizacion_nombre, o.slug AS organizacion_slug
      FROM pedidos p
      JOIN clientes c ON c.id = p.cliente_id
      JOIN productos pr ON pr.id = p.producto_id
      JOIN proveedores prov ON prov.id = p.proveedor_id
      LEFT JOIN organizaciones o ON o.id = p.organizacion_id
      WHERE 1 = 1
    `;
    const params = [];
    if (estado_pago) { query += ' AND p.estado_pago = ?'; params.push(estado_pago); }
    if (estado_despacho) { query += ' AND p.estado_despacho = ?'; params.push(estado_despacho); }
    query += ' ORDER BY p.created_at DESC LIMIT 200';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar pedidos' });
  }
});

// PATCH /api/admin/pedidos/:id/marcar-pagado
// Confirmación manual de pago (transferencia directa, o para probar el flujo
// de punta a punta sin depender de Mercado Pago). Usa el mismo servicio que
// el webhook, así que activa las comisiones exactamente igual.
router.patch('/pedidos/:id/marcar-pagado', async (req, res) => {
  try {
    const resultado = await aprobarPagoPedido({
      id: req.params.id,
      metodo_pago: 'manual',
      payload_respuesta: { confirmado_por_admin: req.user.id }
    });
    if (!resultado.ok) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({
      ok: true,
      mensaje: resultado.ya_procesado
        ? 'El pedido ya estaba aprobado'
        : 'Pedido marcado como pagado y comisiones activadas'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar pedido como pagado' });
  }
});

// PATCH /api/admin/pedidos/:id/despacho  Body: { estado_despacho }
router.patch('/pedidos/:id/despacho', async (req, res) => {
  try {
    const { estado_despacho } = req.body;
    const validos = ['pendiente', 'preparando', 'enviado', 'entregado', 'no_aplica'];
    if (!validos.includes(estado_despacho)) {
      return res.status(400).json({ error: `estado_despacho debe ser uno de: ${validos.join(', ')}` });
    }
    const [result] = await db.query('UPDATE pedidos SET estado_despacho = ? WHERE id = ?', [estado_despacho, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar despacho' });
  }
});

// -------------------------------------------------
// CONTENIDO DEL SITIO (CMS liviano clave/valor)
// -------------------------------------------------

const CLAVES_CONTENIDO_VALIDAS = [
  'header', 'hero', 'organizaciones_cards', 'banner_apoya', 'como_funciona', 'footer'
];

// PUT /api/admin/contenido/:clave  Body = el valor JSON completo de esa clave
// (reemplaza el contenido anterior entero, no hace merge parcial).
router.put('/contenido/:clave', async (req, res) => {
  try {
    const { clave } = req.params;
    if (!CLAVES_CONTENIDO_VALIDAS.includes(clave)) {
      return res.status(400).json({ error: `clave debe ser una de: ${CLAVES_CONTENIDO_VALIDAS.join(', ')}` });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'El body debe ser un objeto JSON' });
    }
    await db.query(
      `INSERT INTO contenido_sitio (clave, valor) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [clave, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el contenido' });
  }
});

module.exports = router;
