const express = require('express');
const router = express.Router();
const { Preference, Payment } = require('mercadopago');
const db = require('../config/db');
const mpClient = require('../config/mercadopago');
const { aprobarPagoPedido, rechazarPagoPedido } = require('../services/pagos.service');

// POST /api/pagos/preferencia
// Body: { pedido_codigo }
//
// Crea la preferencia de pago en Mercado Pago para un pedido ya creado
// (POST /api/pedidos) que todavía esté con estado_pago = 'pendiente'.
// El front debe redirigir al cliente a `init_point`.
router.post('/preferencia', async (req, res) => {
  try {
    if (!mpClient) {
      return res.status(503).json({ error: 'Mercado Pago no está configurado (falta MP_ACCESS_TOKEN)' });
    }
    const { pedido_codigo } = req.body;
    if (!pedido_codigo) return res.status(400).json({ error: 'pedido_codigo es requerido' });

    const [rows] = await db.query(
      `SELECT p.*, pr.nombre AS producto_nombre
       FROM pedidos p JOIN productos pr ON pr.id = p.producto_id
       WHERE p.codigo = ?`,
      [pedido_codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    const pedido = rows[0];

    if (pedido.estado_pago !== 'pendiente') {
      return res.status(409).json({ error: `El pedido ya está en estado de pago: ${pedido.estado_pago}` });
    }

    const baseUrl = process.env.APP_BASE_URL;
    const preference = new Preference(mpClient);
    const resultado = await preference.create({
      body: {
        items: [{
          title: pedido.producto_nombre,
          quantity: pedido.cantidad,
          unit_price: Number(pedido.monto_total) / pedido.cantidad,
          currency_id: 'CLP'
        }],
        external_reference: pedido.codigo,
        notification_url: process.env.MP_NOTIFICATION_URL || (baseUrl ? `${baseUrl}/api/pagos/webhook` : undefined),
        // Las 3 rutas de vuelta apuntan al mismo archivo estático
        // (public/pago-resultado.html) con un query param que distingue el
        // caso — la página igual reconsulta GET /api/pedidos/:codigo como
        // fuente de verdad (nunca confía solo en por qué back_url volvió),
        // porque el webhook puede demorar unos segundos más que el redirect.
        back_urls: baseUrl
          ? {
              success: `${baseUrl}/pago-resultado.html?pedido=${pedido.codigo}&resultado=exito`,
              failure: `${baseUrl}/pago-resultado.html?pedido=${pedido.codigo}&resultado=error`,
              pending: `${baseUrl}/pago-resultado.html?pedido=${pedido.codigo}&resultado=pendiente`
            }
          : undefined,
        auto_return: baseUrl ? 'approved' : undefined,
        metadata: { pedido_id: pedido.id, pedido_codigo: pedido.codigo }
      }
    });

    await db.query(
      `INSERT INTO pagos (pedido_id, referencia_externa, monto, estado, payload_respuesta)
       VALUES (?, ?, ?, 'pendiente', ?)`,
      [pedido.id, resultado.id, pedido.monto_total, JSON.stringify({ preference_id: resultado.id })]
    );

    res.status(201).json({
      preference_id: resultado.id,
      init_point: resultado.init_point,
      sandbox_init_point: resultado.sandbox_init_point
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear preferencia de pago' });
  }
});

// POST /api/pagos/webhook
//
// Mercado Pago notifica acá cada cambio de estado de un pago, típicamente
// como POST con query params (?type=payment&data.id=XXXX) o con el mismo
// dato en el body, según la integración. Consultamos el pago real a la API
// de Mercado Pago (nunca confiamos en el body de la notificación a secas)
// y usamos `external_reference` (el código del pedido) para ubicarlo.
router.post('/webhook', async (req, res) => {
  try {
    const tipo = req.query.type || req.body?.type;
    const paymentId = req.query['data.id'] || req.body?.data?.id || req.body?.id;

    if (tipo !== 'payment' || !paymentId) {
      // Ignoramos otros tipos de notificación (ej. merchant_order)
      return res.sendStatus(200);
    }
    if (!mpClient) {
      console.warn('Webhook de Mercado Pago recibido pero MP_ACCESS_TOKEN no está configurado');
      return res.sendStatus(200);
    }

    const payment = new Payment(mpClient);
    const info = await payment.get({ id: paymentId });

    const codigo = info.external_reference;
    if (!codigo) return res.sendStatus(200);

    const datosComunes = {
      codigo,
      referencia_externa: String(info.id),
      metodo_pago: info.payment_method_id,
      payload_respuesta: info,
      monto: info.transaction_amount
    };

    if (info.status === 'approved') {
      await aprobarPagoPedido(datosComunes);
    } else if (['rejected', 'cancelled'].includes(info.status)) {
      await rechazarPagoPedido({ ...datosComunes, motivo_estado: 'rechazado' });
    }
    // status 'pending' / 'in_process' -> no hacemos nada, esperamos la próxima notificación

    res.sendStatus(200);
  } catch (err) {
    console.error('Error procesando webhook de Mercado Pago:', err);
    // Respondemos 500 para que Mercado Pago reintente la notificación más tarde.
    res.sendStatus(500);
  }
});

module.exports = router;
