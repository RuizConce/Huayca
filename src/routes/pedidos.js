const express = require('express');
const router = express.Router();
const db = require('../config/db');

function generarCodigoPedido(id) {
  return `HUY-${String(id).padStart(6, '0')}`;
}

// POST /api/pedidos
// Body: { producto_id, cantidad, cliente: {...}, organizacion_slug (opcional), direccion_envio }
//
// organizacion_slug viene del link que el cliente usó para llegar
// (ej: huayca.cl/o/junta-vecinos-y/producto/gps-vehicular).
// Si no viene, la venta es directa y la comisión de afiliado
// queda registrada como comisión de Huayca (sin "afiliado casa").
router.post('/', async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { producto_id, cantidad = 1, cliente, organizacion_slug, direccion_envio } = req.body;

    if (!producto_id || !cliente?.email || !cliente?.nombre) {
      return res.status(400).json({ error: 'producto_id y datos del cliente son requeridos' });
    }

    await conn.beginTransaction();

    // 1. Bloquear y validar producto + stock
    const [productos] = await conn.query(
      `SELECT * FROM productos WHERE id = ? AND estado = 'activo' FOR UPDATE`,
      [producto_id]
    );
    if (!productos.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Producto no disponible' });
    }
    const producto = productos[0];
    if (producto.stock < cantidad) {
      await conn.rollback();
      return res.status(409).json({ error: 'Stock insuficiente' });
    }

    // 2. Resolver organización a partir del link (si existe)
    let organizacionId = null;
    if (organizacion_slug) {
      const [orgs] = await conn.query(
        `SELECT id FROM organizaciones WHERE slug = ? AND estado = 'aprobada'`,
        [organizacion_slug]
      );
      if (orgs.length) organizacionId = orgs[0].id;
      // Si el slug no existe o la org no está aprobada, se trata como venta directa
    }

    // 3. Crear o reutilizar cliente
    let clienteId;
    const [clientesExistentes] = await conn.query(
      'SELECT id FROM clientes WHERE email = ?', [cliente.email]
    );
    if (clientesExistentes.length) {
      clienteId = clientesExistentes[0].id;
    } else {
      const [resultCliente] = await conn.query(
        `INSERT INTO clientes (nombre, email, telefono, rut, direccion)
         VALUES (?, ?, ?, ?, ?)`,
        [cliente.nombre, cliente.email, cliente.telefono || null, cliente.rut || null,
         JSON.stringify(direccion_envio || null)]
      );
      clienteId = resultCliente.insertId;
    }

    // 4. Congelar montos del producto al momento de la compra
    const montoProveedor = producto.precio_proveedor * cantidad;
    const montoComisionAfiliado = producto.comision_afiliado * cantidad;
    const montoComisionHuayca = producto.comision_huayca * cantidad;
    const montoTotal = montoProveedor + montoComisionAfiliado + montoComisionHuayca;

    // 5. Crear pedido
    const [resultPedido] = await conn.query(
      `INSERT INTO pedidos
       (codigo, cliente_id, producto_id, proveedor_id, organizacion_id,
        monto_proveedor, monto_comision_afiliado, monto_comision_huayca, monto_total,
        cantidad, direccion_envio, estado_liquidacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'TEMP', clienteId, producto.id, producto.proveedor_id, organizacionId,
        montoProveedor, montoComisionAfiliado, montoComisionHuayca, montoTotal,
        cantidad, JSON.stringify(direccion_envio || null),
        organizacionId ? 'pendiente' : 'no_aplica'
      ]
    );
    const pedidoId = resultPedido.insertId;
    const codigo = generarCodigoPedido(pedidoId);
    await conn.query('UPDATE pedidos SET codigo = ? WHERE id = ?', [codigo, pedidoId]);

    // 6. Descontar stock (reserva optimista mientras se concreta el pago;
    // si el pago termina rechazado/cancelado, el webhook devuelve el stock)
    await conn.query('UPDATE productos SET stock = stock - ? WHERE id = ?', [cantidad, producto.id]);

    // Nota: las comisiones (proveedor/afiliado/huayca) NO se registran acá.
    // Recién se "activan" -es decir, se insertan en la tabla `comisiones`-
    // cuando el pago queda aprobado (ver src/services/pagos.service.js),
    // para que el saldo de la organización nunca cuente ventas no pagadas.

    await conn.commit();

    res.status(201).json({
      pedido_id: pedidoId,
      codigo,
      monto_total: montoTotal,
      organizacion_atribuida: organizacionId ? organizacion_slug : null,
      siguiente_paso: 'POST /api/pagos/preferencia con { pedido_codigo: codigo } para obtener el link de pago de Mercado Pago'
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al crear el pedido' });
  } finally {
    conn.release();
  }
});

// GET /api/pedidos/:codigo - seguimiento público del pedido
router.get('/:codigo', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT codigo, estado_pago, estado_despacho, monto_total, created_at
       FROM pedidos WHERE codigo = ?`,
      [req.params.codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedido' });
  }
});

module.exports = router;
