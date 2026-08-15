// Carga datos de prueba: un admin, una categoría, el proveedor PROTEGE+ con
// 3 productos, y una organización demo ya aprobada. Es idempotente (se
// puede correr varias veces sin duplicar filas). Se usa tanto desde
// scripts/seed.js (CLI) como desde GET /api/bootstrap/seed.
const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function upsertAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@huayca.cl';
  const password = process.env.SEED_ADMIN_PASSWORD || 'CambiaEstaClave2026!';
  const [existe] = await db.query('SELECT id FROM administradores WHERE email = ?', [email]);
  if (existe.length) return { email, creado: false };

  const password_hash = await bcrypt.hash(password, 10);
  await db.query(
    `INSERT INTO administradores (nombre, email, password_hash, rol) VALUES (?, ?, ?, 'super_admin')`,
    ['Admin Huayca', email, password_hash]
  );
  return { email, password, creado: true };
}

async function upsertCategoria() {
  const [existe] = await db.query("SELECT id FROM categorias WHERE slug = 'seguridad-vehicular'");
  if (existe.length) return existe[0].id;
  const [result] = await db.query(
    'INSERT INTO categorias (nombre, slug, orden) VALUES (?, ?, ?)',
    ['Seguridad y Protección Vehicular', 'seguridad-vehicular', 1]
  );
  return result.insertId;
}

async function upsertProveedor() {
  const [existe] = await db.query("SELECT id FROM proveedores WHERE nombre = 'PROTEGE+'");
  if (existe.length) return existe[0].id;
  const [result] = await db.query(
    `INSERT INTO proveedores (nombre, razon_social, rut, email_contacto, telefono_contacto, gestiona_despacho, estado)
     VALUES (?, ?, ?, ?, ?, ?, 'activo')`,
    ['PROTEGE+', 'Protege Más SpA', '77.123.456-7', 'contacto@protegemas.cl', '+56912345678', true]
  );
  return result.insertId;
}

async function upsertProducto(proveedorId, categoriaId, datos) {
  const [existe] = await db.query('SELECT id FROM productos WHERE slug = ?', [datos.slug]);
  if (existe.length) return { slug: datos.slug, creado: false };

  await db.query(
    `INSERT INTO productos
     (proveedor_id, categoria_id, nombre, slug, descripcion, precio_proveedor, comision_afiliado, comision_huayca, precio_normal, stock, garantia_meses, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo')`,
    [
      proveedorId, categoriaId, datos.nombre, datos.slug, datos.descripcion,
      datos.precio_proveedor, datos.comision_afiliado, datos.comision_huayca, datos.precio_normal,
      datos.stock, datos.garantia_meses
    ]
  );
  return { slug: datos.slug, nombre: datos.nombre, creado: true };
}

async function upsertOrganizacionDemo() {
  const email = process.env.SEED_ORG_EMAIL || 'demo@colegiolosandes.cl';
  const password = process.env.SEED_ORG_PASSWORD || 'CambiaEstaClave2026!';
  const [existe] = await db.query('SELECT id FROM organizaciones WHERE email = ?', [email]);
  if (existe.length) return { email, slug: 'colegio-los-andes', creado: false };

  const password_hash = await bcrypt.hash(password, 10);
  await db.query(
    `INSERT INTO organizaciones
     (nombre, tipo, slug, email, password_hash, telefono, region, comuna, descripcion_proyecto, estado, aprobada_at)
     VALUES (?, 'colegio', 'colegio-los-andes', ?, ?, '+56911112222', 'Región Metropolitana', 'Ñuñoa', ?, 'aprobada', NOW())`,
    ['Colegio Los Andes', email, password_hash, 'Fondos para renovar la biblioteca del colegio']
  );
  return { email, password, slug: 'colegio-los-andes', creado: true };
}

async function runSeed() {
  const admin = await upsertAdmin();
  const categoriaId = await upsertCategoria();
  const proveedorId = await upsertProveedor();

  const productos = [];
  productos.push(await upsertProducto(proveedorId, categoriaId, {
    nombre: 'GPS Vehicular PROTEGE+ con Monitoreo 24/7',
    slug: 'gps-vehicular-protege-mas',
    descripcion: 'Rastreador GPS con monitoreo 24/7, alertas de movimiento y corte remoto de motor. Incluye instalación.',
    precio_proveedor: 45000,
    comision_afiliado: 8000,
    comision_huayca: 7000,
    precio_normal: 79990,
    stock: 50,
    garantia_meses: 12
  }));

  productos.push(await upsertProducto(proveedorId, categoriaId, {
    nombre: 'Alarma Vehicular Inteligente PROTEGE+',
    slug: 'alarma-vehicular-inteligente-protege-mas',
    descripcion: 'Alarma con sensor de impacto, control vía app y notificaciones en tiempo real.',
    precio_proveedor: 28000,
    comision_afiliado: 5000,
    comision_huayca: 4000,
    precio_normal: 49990,
    stock: 80,
    garantia_meses: 12
  }));

  productos.push(await upsertProducto(proveedorId, categoriaId, {
    nombre: 'Kit Rastreo Satelital PROTEGE+ Flota',
    slug: 'kit-rastreo-satelital-protege-mas-flota',
    descripcion: 'Kit de rastreo satelital pensado para flotas pequeñas, incluye dashboard de administración.',
    precio_proveedor: 120000,
    comision_afiliado: 15000,
    comision_huayca: 15000,
    precio_normal: 189990,
    stock: 20,
    garantia_meses: 12
  }));

  const organizacionDemo = await upsertOrganizacionDemo();

  return {
    ok: true,
    admin,
    productos,
    organizacion_demo: organizacionDemo,
    siguiente_paso: [
      'POST /api/pedidos con organizacion_slug="colegio-los-andes" y el producto_id del GPS.',
      'POST /api/pagos/preferencia con { pedido_codigo } (requiere MP_ACCESS_TOKEN), o PATCH /api/admin/pedidos/:id/marcar-pagado con un token de admin para simular el pago.',
      'GET /api/organizaciones/mi-dashboard con el token de la organización demo: la comisión debería aparecer activada.'
    ]
  };
}

module.exports = { runSeed };
