const { Resend } = require('resend');

// El cliente solo se instancia si hay API key configurada, mismo patrón
// que src/config/mercadopago.js: el resto de la app puede levantar en un
// ambiente donde Resend todavía no está conectado — los envíos
// simplemente se loguean como no enviados en vez de romper nada (ver
// src/services/notificaciones.service.js).
const resendClient = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

module.exports = resendClient;
