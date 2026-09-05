const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { adjuntarCategorias } = require('../services/categorias.service');

// GET /api/productos/categorias - listado público para armar filtros/menú
router.get('/categorias', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, nombre, slug, icono FROM categorias ORDER BY orden, nombre');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
});

// GET /api/productos - catálogo público (solo activos)
router.get('/', async (req, res) => {
  try {
    const { categoria } = req.query;
    let query = `
      SELECT p.id, p.nombre, p.slug, p.descripcion, p.imagen_principal,
             p.precio_final, p.precio_normal, p.stock, p.garantia_meses
      FROM productos p
      WHERE p.estado = 'activo'
    `;
    const params = [];
    if (categoria) {
      // Un producto puede estar en varias categorías a la vez
      // (producto_categorias, M:N) — coincide si CUALQUIERA de ellas es la
      // pedida, no una sola columna directa como antes.
      query += ` AND EXISTS (
        SELECT 1 FROM producto_categorias pc
        JOIN categorias c ON c.id = pc.categoria_id
        WHERE pc.producto_id = p.id AND c.slug = ?
      )`;
      params.push(categoria);
    }
    // Ofertas ancladas primero (destacado=true y, si tiene fecha límite,
    // todavía no venció), ordenadas por el momento en que se marcaron como
    // destacadas (más reciente primero); el resto, por más nuevo primero,
    // como siempre. Un producto destacado cuya destacado_hasta ya pasó cae
    // solo al bloque de abajo — no hace falta ningún job que lo desmarque,
    // la condición de fecha ya lo saca del bloque anclado en cada consulta.
    query += `
      ORDER BY
        CASE WHEN p.destacado = 1 AND (p.destacado_hasta IS NULL OR p.destacado_hasta >= CURDATE()) THEN 0 ELSE 1 END,
        CASE WHEN p.destacado = 1 AND (p.destacado_hasta IS NULL OR p.destacado_hasta >= CURDATE()) THEN p.destacado_desde END DESC,
        p.created_at DESC
    `;

    const [rows] = await db.query(query, params);
    await adjuntarCategorias(rows);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// GET /api/productos/:slug - detalle público de un producto
router.get('/:slug', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, pr.nombre AS proveedor_nombre
       FROM productos p
       JOIN proveedores pr ON pr.id = p.proveedor_id
       WHERE p.slug = ? AND p.estado = 'activo'`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });

    // No exponer el desglose interno de comisión al público (ni el normal
    // ni el _promo de códigos de descuento) — acepta_codigo_descuento SÍ
    // se deja pasar, es lo que usa checkout.html para decidir si muestra
    // el campo "¿Tienes un código?"; el precio con descuento en sí solo se
    // entrega recién al validar un código real (POST
    // /api/codigos-descuento/validar), nunca de entrada.
    const { precio_proveedor, comision_afiliado, comision_huayca, comision_eliss,
      impuesto_incluido, monto_impuesto,
      descuento_monto, precio_proveedor_promo, comision_afiliado_promo, comision_huayca_promo,
      comision_eliss_promo, impuesto_incluido_promo, monto_impuesto_promo, precio_final_promo,
      ...producto } = rows[0];
    await adjuntarCategorias([producto]);
    res.json(producto);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

module.exports = router;
