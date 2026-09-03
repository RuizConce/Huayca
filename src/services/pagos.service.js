const db = require('../config/db');
const { notificarPedidoAprobado } = require('./notificaciones.service');

// Busca el pedido por id o por código y lo bloquea (FOR UPDATE) dentro de
// una transacción ya abierta, para evitar condiciones de carrera si llegan
// dos notificaciones del webhook casi al mismo tiempo.
async function buscarPedidoParaActualizar(conn, { id, codigo }) {
  const [rows] = id
    ? await conn.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [id])
    : await conn.query('SELECT * FROM pedidos WHERE codigo = ? FOR UPDATE', [codigo]);
  return rows[0] || null;
}

// Marca el pedido como pagado y "activa" las comisiones asociadas: recién
// en este momento se crean las filas en `comisiones` (proveedor / huayca /
// afiliado según corresponda). Antes de esto el pedido existe con stock ya
// reservado, pero ninguna comisión cuenta para el saldo de la organización,
// porque el pago todavía no está confirmado.
//
// Es idempotente: si el pedido ya estaba aprobado (reintento del webhook,
// doble notificación), no vuelve a insertar comisiones ni a duplicar nada.
async function aprobarPagoPedido({ id, codigo, referencia_externa, metodo_pago, payload_respuesta, monto }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const pedido = await buscarPedidoParaActualizar(conn, { id, codigo });
    if (!pedido) {
      await conn.rollback();
      return { ok: false, motivo: 'pedido_no_encontrado' };
    }

    if (pedido.estado_pago === 'aprobado') {
      await conn.commit();
      return { ok: true, pedido, ya_procesado: true };
    }

    await conn.query(`UPDATE pedidos SET estado_pago = 'aprobado' WHERE id = ?`, [pedido.id]);

    await conn.query(
      `INSERT INTO pagos (pedido_id, referencia_externa, monto, estado, metodo_pago, payload_respuesta)
       VALUES (?, ?, ?, 'aprobado', ?, ?)`,
      [
        pedido.id,
        referencia_externa || null,
        monto || pedido.monto_total,
        metodo_pago || null,
        JSON.stringify(payload_respuesta || null)
      ]
    );

    // Si no hay organización, la comisión de afiliado queda para Huayca
    // (no existe "afiliado casa").
    const comisiones = [
      [pedido.id, 'proveedor', null, pedido.monto_proveedor],
      [
        pedido.id,
        'huayca',
        null,
        pedido.organizacion_id
          ? pedido.monto_comision_huayca
          : Number(pedido.monto_comision_huayca) + Number(pedido.monto_comision_afiliado)
      ]
    ];
    if (pedido.organizacion_id) {
      comisiones.push([pedido.id, 'afiliado', pedido.organizacion_id, pedido.monto_comision_afiliado]);
    }
    // La comisión de Eliss Conecta SpA es independiente de si la venta vino
    // con organización o no (a diferencia de 'afiliado', que sin
    // organización se le suma a 'huayca' más arriba) — es la operación de
    // infraestructura de Huayca como negocio, siempre se registra igual.
    comisiones.push([pedido.id, 'eliss', null, pedido.monto_comision_eliss]);
    for (const c of comisiones) {
      await conn.query(
        `INSERT INTO comisiones (pedido_id, tipo, organizacion_id, monto) VALUES (?, ?, ?, ?)`,
        c
      );
    }

    if (pedido.organizacion_id) {
      await conn.query(
        `UPDATE organizaciones SET saldo_disponible = saldo_disponible + ? WHERE id = ?`,
        [pedido.monto_comision_afiliado, pedido.organizacion_id]
      );
    }

    await conn.commit();

    // Fire and forget de verdad: NO se espera (sin await) porque esta
    // función la llaman, y esperan una respuesta rápida de, el webhook de
    // Mercado Pago (que tiene su propio timeout) y los endpoints de admin
    // (sincronizar-pago, marcar-pagado) — mandar 3 correos no puede ser lo
    // que demore esa respuesta. notificarPedidoAprobado() nunca lanza
    // (todo queda atrapado y logueado adentro), así que ni hace falta un
    // .catch() acá, pero se agrega uno igual como redundancia explícita.
    // Es EL único lugar desde donde se llama: los 3 caminos donde un
    // pedido puede aprobarse (webhook, sincronizar-pago, marcar-pagado)
    // ya convergen acá, así que no hace falta triplicar la llamada en
    // cada endpoint.
    notificarPedidoAprobado(pedido.id).catch((err) => {
      console.error(`[notificaciones] Error inesperado disparando las notificaciones del pedido ${pedido.id}:`, err);
    });

    return { ok: true, pedido };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Marca el pedido como rechazado/reembolsado y devuelve el stock reservado
// al crear el pedido, ya que la venta finalmente no se concretó. No toca
// comisiones porque, si el pago nunca fue aprobado, nunca se crearon.
async function rechazarPagoPedido({ id, codigo, referencia_externa, metodo_pago, payload_respuesta, monto, motivo_estado = 'rechazado' }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const pedido = await buscarPedidoParaActualizar(conn, { id, codigo });
    if (!pedido) {
      await conn.rollback();
      return { ok: false, motivo: 'pedido_no_encontrado' };
    }

    if (pedido.estado_pago === 'aprobado') {
      // Ya se había aprobado antes (notificación duplicada o fuera de orden); no revertimos ventas concretadas.
      await conn.commit();
      return { ok: true, pedido, ignorado: true };
    }
    if (pedido.estado_pago === motivo_estado) {
      await conn.commit();
      return { ok: true, pedido, ya_procesado: true };
    }

    await conn.query('UPDATE pedidos SET estado_pago = ? WHERE id = ?', [motivo_estado, pedido.id]);
    await conn.query('UPDATE productos SET stock = stock + ? WHERE id = ?', [pedido.cantidad, pedido.producto_id]);

    await conn.query(
      `INSERT INTO pagos (pedido_id, referencia_externa, monto, estado, metodo_pago, payload_respuesta)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        pedido.id,
        referencia_externa || null,
        monto || pedido.monto_total,
        motivo_estado === 'reembolsado' ? 'reembolsado' : 'rechazado',
        metodo_pago || null,
        JSON.stringify(payload_respuesta || null)
      ]
    );

    await conn.commit();
    return { ok: true, pedido };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Interpreta un objeto "payment" tal como lo devuelve la API de Mercado
// Pago (via Payment.get() o Payment.search(), da igual la fuente) y aplica
// la acción que corresponda sobre el pedido asociado por
// external_reference. La comparten POST /api/pagos/webhook y POST
// /api/admin/pedidos/:id/sincronizar-pago (el "plan B" manual) para no
// duplicar esta interpretación en dos lugares que podrían divergir — el
// bug de HUY-000006 (pago aprobado en Mercado Pago que nunca actualizó el
// pedido) fue justamente el webhook fallando en silencio antes de llegar
// a este punto, no un problema de esta lógica en sí.
async function procesarPagoInfo(info) {
  const codigo = info.external_reference;
  if (!codigo) return { ok: false, motivo: 'sin_external_reference' };

  const datosComunes = {
    codigo,
    referencia_externa: String(info.id),
    metodo_pago: info.payment_method_id,
    payload_respuesta: info,
    monto: info.transaction_amount
  };

  if (info.status === 'approved') {
    return aprobarPagoPedido(datosComunes);
  }
  if (['rejected', 'cancelled'].includes(info.status)) {
    return rechazarPagoPedido({ ...datosComunes, motivo_estado: 'rechazado' });
  }
  // 'pending' / 'in_process' / cualquier otro: todavía no hay nada que
  // cambiar, se espera la próxima notificación (o la próxima sincronización manual).
  return { ok: true, sin_cambios: true, estado_mercadopago: info.status };
}

module.exports = { aprobarPagoPedido, rechazarPagoPedido, procesarPagoInfo };
