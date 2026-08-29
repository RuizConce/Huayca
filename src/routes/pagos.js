const express = require('express');
const router = express.Router();
const { Preference, Payment, MerchantOrder } = require('mercadopago');
const db = require('../config/db');
const mpClient = require('../config/mercadopago');
const { procesarPagoInfo } = require('../services/pagos.service');

// Mercado Pago siempre devuelve ambos campos al crear una preferencia
// (init_point e sandbox_init_point), sin importar qué token se haya usado
// para crearla — no hay forma de pedirle "dame solo el real". La URL
// correcta para redirigir al comprador depende del tipo de credencial
// configurada, no de cuál de los dos campos "parece" venir lleno:
// - MP_ACCESS_TOKEN empieza con "APP_USR-" (producción) -> init_point
// - MP_ACCESS_TOKEN empieza con "TEST-" (prueba)         -> sandbox_init_point
// Se lee process.env.MP_ACCESS_TOKEN en cada llamada (no un booleano
// cacheado en config) para que cambiar la credencial en Railway alcance
// solo con reiniciar el servicio, sin tocar código, en cualquier
// dirección (volver a probar con TEST- también sigue funcionando solo).
function esTokenDeProduccion() {
  return (process.env.MP_ACCESS_TOKEN || '').startsWith('APP_USR-');
}

function elegirUrlCheckout(resultadoPreferencia) {
  return esTokenDeProduccion()
    ? resultadoPreferencia.init_point
    : resultadoPreferencia.sandbox_init_point;
}

// POST /api/pagos/preferencia
// Body: { pedido_codigo }
//
// Crea la preferencia de pago en Mercado Pago para un pedido ya creado
// (POST /api/pedidos) que todavía esté con estado_pago = 'pendiente'.
// El front debe redirigir al cliente a `checkout_url` (ver
// elegirUrlCheckout arriba) — init_point/sandbox_init_point quedan en la
// respuesta solo como referencia/debug, no para que el front elija.
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
      checkout_url: elegirUrlCheckout(resultado),
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
// Mercado Pago tiene DOS formatos de notificación que pueden llegar acá
// según cómo esté configurada la aplicación del lado de Mercado Pago (el
// "Webhooks v2" moderno y el IPN clásico, más viejo pero que Mercado Pago
// sigue mandando en algunos casos/cuentas):
//   - Webhooks v2:  ?type=payment&data.id=XXXX        (o topic=payment en body.type)
//   - IPN clásico:  ?topic=payment&id=XXXX
//   - Cualquiera de los dos, pero con topic=merchant_order en vez de
//     payment — común en compras vía Checkout Pro.
// BUG CORREGIDO (HUY-000006, 28/ago): esta ruta solo entendía el primer
// formato (type/data.id). Una notificación en cualquiera de los otros dos
// formatos no coincidía con ese chequeo y caía derecho al primer
// `return res.sendStatus(200)` — Mercado Pago la daba por entregada
// (200 = éxito) y nunca la reintentaba, así que el pago quedaba aprobado
// del lado de Mercado Pago sin que Huayca se enterara nunca, SIN ningún
// error en los logs (porque técnicamente no fallaba nada: simplemente no
// hacía nada). Ahora se entienden los 3 formatos.
//
// En todos los casos se vuelve a consultar el recurso real a la API de
// Mercado Pago (nunca se confía en el body/query de la notificación a
// secas) — eso ya estaba bien y no cambió.
//
// FIX (reportado al usar "Simular notificaciones" con un payment_id que
// no existe): un webhook SIEMPRE tiene que responder 200 rápido, incluso
// cuando no pudo procesar algo — devolver 500 hace que Mercado Pago
// interprete que la ENTREGA falló y reintente indefinidamente, y puede
// terminar marcando la integración como poco confiable. La distinción que
// importa no es "hubo un error sí/no", sino DE QUIÉN es el error:
//   - Si el problema es al CONSULTAR el recurso en Mercado Pago (404
//     porque el id no existe, timeout, cualquier error de esa llamada):
//     no hay nada útil que un reintento logre — se loguea y se responde
//     200 igual. Si hiciera falta reprocesar ese pago más adelante, está
//     POST /api/admin/pedidos/:id/sincronizar-pago para eso.
//   - Si el problema es NUESTRO al guardar el resultado (ej. la base de
//     datos no responde durante procesarPagoInfo) — ahí sí vale un 500,
//     porque un reintento de Mercado Pago más tarde puede sí resolverlo.
router.post('/webhook', async (req, res) => {
  try {
    const tipo = req.query.type || req.body?.type || req.query.topic || req.body?.topic;
    const recursoId = req.query['data.id'] || req.body?.data?.id || req.query.id || req.body?.id;

    if (!tipo || !recursoId) return res.sendStatus(200);
    if (!mpClient) {
      console.warn('Webhook de Mercado Pago recibido pero MP_ACCESS_TOKEN no está configurado');
      return res.sendStatus(200);
    }

    if (tipo === 'payment') {
      const payment = new Payment(mpClient);
      let info;
      try {
        info = await payment.get({ id: recursoId });
      } catch (errConsulta) {
        console.error(`Webhook de Mercado Pago: no se pudo consultar el pago ${recursoId} (puede no existir, ej. una notificación de prueba) —`, errConsulta.message || errConsulta);
        return res.sendStatus(200);
      }
      // A partir de acá cualquier error (ej. de base de datos) lo agarra
      // el catch de afuera y responde 500 — es un problema nuestro real.
      await procesarPagoInfo(info);
      return res.sendStatus(200);
    }

    if (tipo === 'merchant_order') {
      // Una merchant order agrupa los intentos de pago de una compra vía
      // Checkout Pro; puede traer 0, 1 o más pagos (reintentos incluidos).
      // Se procesan todos los que ya tengan un estado definitivo —
      // procesarPagoInfo es idempotente (aprobarPagoPedido/
      // rechazarPagoPedido no vuelven a aplicar nada si el pedido ya
      // estaba en ese estado), así que no hay riesgo de duplicar nada
      // aunque el mismo pago venga referenciado más de una vez.
      const merchantOrder = new MerchantOrder(mpClient);
      let orden;
      try {
        orden = await merchantOrder.get({ merchantOrderId: recursoId });
      } catch (errConsulta) {
        console.error(`Webhook de Mercado Pago: no se pudo consultar la merchant order ${recursoId} —`, errConsulta.message || errConsulta);
        return res.sendStatus(200);
      }
      const payment = new Payment(mpClient);
      for (const resumenPago of orden.payments || []) {
        if (resumenPago.status === 'approved' || ['rejected', 'cancelled'].includes(resumenPago.status)) {
          let info;
          try {
            info = await payment.get({ id: resumenPago.id });
          } catch (errConsulta) {
            // Un pago puntual de la orden no se pudo consultar: se loguea
            // y se sigue con los demás en vez de cortar todo acá.
            console.error(`Webhook de Mercado Pago: no se pudo consultar el pago ${resumenPago.id} (de la merchant order ${recursoId}) —`, errConsulta.message || errConsulta);
            continue;
          }
          await procesarPagoInfo(info);
        }
      }
      return res.sendStatus(200);
    }

    // Otro tipo de notificación que no manejamos (ej. algo nuevo de Mercado Pago).
    res.sendStatus(200);
  } catch (err) {
    // Solo debería llegar acá algo verdaderamente inesperado de nuestro
    // lado (ej. la base de datos no responde) — recién ahí vale la pena
    // que Mercado Pago reintente la notificación más tarde.
    console.error('Error inesperado procesando webhook de Mercado Pago:', err);
    res.sendStatus(500);
  }
});

module.exports = router;
