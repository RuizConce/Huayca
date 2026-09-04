const db = require('../config/db');

// Adjunta `categorias: [{id, nombre, slug, icono}, ...]` a cada producto del
// array recibido (lo muta y lo devuelve, para poder encadenarlo justo antes
// de un res.json(...)). Un producto puede estar en varias categorías a la
// vez (tabla producto_categorias, M:N) — esto reemplaza al viejo
// categoria_nombre/categoria_slug de "una sola categoría por producto".
// Se comparte entre las rutas públicas (productos.js) y las de admin
// (admin.js) para que ambas arrastren exactamente la misma forma de datos.
async function adjuntarCategorias(productos) {
  if (!productos.length) return productos;
  const ids = productos.map((p) => p.id);
  const [filas] = await db.query(
    `SELECT pc.producto_id, c.id, c.nombre, c.slug, c.icono
     FROM producto_categorias pc
     JOIN categorias c ON c.id = pc.categoria_id
     WHERE pc.producto_id IN (?)
     ORDER BY c.orden, c.nombre`,
    [ids]
  );
  const porProducto = new Map(productos.map((p) => [p.id, []]));
  for (const f of filas) {
    porProducto.get(f.producto_id)?.push({ id: f.id, nombre: f.nombre, slug: f.slug, icono: f.icono });
  }
  productos.forEach((p) => { p.categorias = porProducto.get(p.id) || []; });
  return productos;
}

// Reemplaza TODAS las relaciones de un producto por el set de ids recibido
// (borra todo y vuelve a insertar lo marcado) — más simple que hacer diff,
// y para el volumen de categorías por producto no hay problema de
// performance. ids puede venir vacío (el producto se guarda sin ninguna
// categoría marcada).
async function sincronizarCategoriasProducto(productoId, categoriaIds) {
  await db.query('DELETE FROM producto_categorias WHERE producto_id = ?', [productoId]);
  if (categoriaIds.length) {
    await db.query(
      'INSERT INTO producto_categorias (producto_id, categoria_id) VALUES ?',
      [categoriaIds.map((catId) => [productoId, catId])]
    );
  }
}

module.exports = { adjuntarCategorias, sincronizarCategoriasProducto };
