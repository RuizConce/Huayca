const { MercadoPagoConfig } = require('mercadopago');

// El cliente solo se instancia si hay token configurado, así el resto de la
// app puede levantar en un ambiente donde Mercado Pago todavía no está
// conectado (por ejemplo, mientras se prueba el flujo con confirmación
// manual de pago desde /api/admin/pedidos/:id/marcar-pagado).
const mpClient = process.env.MP_ACCESS_TOKEN
  ? new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN })
  : null;

module.exports = mpClient;
