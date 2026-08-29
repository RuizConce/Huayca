const db = require('../config/db');
const resendClient = require('../config/resend');

const FROM = process.env.RESEND_FROM_EMAIL || 'Huayca <onboarding@resend.dev>';
const APP_BASE_URL = process.env.APP_BASE_URL || '';

function formatoCLP(monto) {
  return '$' + Number(monto || 0).toLocaleString('es-CL');
}

function soloNumeros(texto) {
  return (texto || '').replace(/[^\d]/g, '');
}

function formatoDireccion(direccionEnvio) {
  let d = direccionEnvio;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
  if (!d) return 'No especificada';
  const calleNumero = [d.calle, d.numero].filter(Boolean).join(' ');
  const resto = [d.comuna, d.region].filter(Boolean).join(', ');
  const partes = [calleNumero, resto].filter(Boolean);
  return partes.length ? partes.join(', ') : 'No especificada';
}

// Envoltorio visual compartido por los 3 correos: navy/verde, simple y
// liviano (nada de imágenes externas ni CSS complejo, para que se vea
// bien en cualquier cliente de correo).
function layout(contenidoHtml) {
  return `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; background:#f4f5f2; padding:24px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:14px; overflow:hidden;">
      <div style="background:#0d2b4e; padding:18px 24px;">
        <span style="color:#ffffff; font-size:17px; font-weight:800;">🤝 Huayca</span>
      </div>
      <div style="padding:26px 24px; color:#1a1a1a; font-size:14px; line-height:1.65;">
        ${contenidoHtml}
      </div>
      <div style="padding:16px 24px; border-top:1px solid #f0efe9; color:#999; font-size:11.5px;">
        Huayca — Conectamos comunidades.
      </div>
    </div>
  </div>`;
}

function botonHtml(texto, url, color) {
  return `<a href="${url}" style="display:inline-block; margin-top:18px; background:${color || '#1f7a4b'}; color:#ffffff; text-decoration:none; padding:12px 22px; border-radius:8px; font-weight:700; font-size:13.5px;">${texto}</a>`;
}

// Envío de un correo individual. Nunca lanza: cualquier problema (Resend
// sin configurar, sin destinatario, error de la API, excepción de red)
// vuelve como { ok:false, motivo }, logueado con console.error, para que
// el llamador pueda decidir qué hacer sin que esto tumbe nada.
async function enviarCorreo({ to, subject, html }) {
  if (!resendClient) {
    console.error(`[notificaciones] Resend no está configurado (falta RESEND_API_KEY) — no se envió "${subject}" a ${to}.`);
    return { ok: false, motivo: 'resend_no_configurado' };
  }
  if (!to) {
    console.error(`[notificaciones] Sin destinatario para "${subject}" — no se envió.`);
    return { ok: false, motivo: 'sin_destinatario' };
  }
  try {
    const { data, error } = await resendClient.emails.send({ from: FROM, to, subject, html });
    if (error) {
      console.error(`[notificaciones] Resend devolvió un error al enviar "${subject}" a ${to}:`, error);
      return { ok: false, motivo: error.message || error.name || 'error_resend' };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error(`[notificaciones] Excepción al enviar "${subject}" a ${to}:`, err.message);
    return { ok: false, motivo: err.message };
  }
}

// ---------- Correo 1: aviso interno a Huayca ----------
async function enviarCorreoAdmin(p) {
  const destino = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!destino) {
    console.error(`[notificaciones] ADMIN_NOTIFICATION_EMAIL no configurado — no se envió el aviso de venta del pedido ${p.codigo}.`);
    return { ok: false, motivo: 'sin_admin_notification_email' };
  }
  const html = layout(`
    <h2 style="color:#0d2b4e; margin:0 0 14px;">💰 Nueva venta aprobada</h2>
    <p><b>Pedido:</b> ${p.codigo}</p>
    <p><b>Producto:</b> ${p.producto_nombre} × ${p.cantidad}</p>
    <p><b>Monto total:</b> ${formatoCLP(p.monto_total)}</p>
    <p><b>Organización:</b> ${p.organizacion_nombre || 'Venta directa'}</p>
    <p><b>Cliente:</b> ${p.cliente_nombre}</p>
  `);
  return enviarCorreo({ to: destino, subject: `💰 Nueva venta — ${p.codigo}`, html });
}

// ---------- Correo 2: aviso al proveedor, con botón de WhatsApp ----------
async function enviarCorreoProveedor(p) {
  if (!p.proveedor_email) {
    console.error(`[notificaciones] Proveedor "${p.proveedor_nombre}" sin email_contacto cargado — no se le pudo avisar de la venta del pedido ${p.codigo}.`);
    return { ok: false, motivo: 'proveedor_sin_email' };
  }

  const telefono = soloNumeros(p.cliente_telefono);
  let contactoHtml;
  if (telefono) {
    const mensaje = encodeURIComponent(
      `Hola ${p.cliente_nombre}, te escribo de ${p.proveedor_nombre} por tu compra del pedido ${p.codigo} en Huayca. Coordinemos la entrega 🙂`
    );
    contactoHtml = botonHtml('Contactar al comprador por WhatsApp', `https://wa.me/${telefono}?text=${mensaje}`, '#1e8e3e');
  } else {
    // Sin teléfono: el email del cliente queda como forma de contacto
    // alternativa en vez del botón de WhatsApp.
    contactoHtml = `<p style="margin-top:16px;"><b>Contacto del comprador:</b> ${p.cliente_email} <span style="color:#999;">(no dejó teléfono)</span></p>`;
  }

  const html = layout(`
    <h2 style="color:#0d2b4e; margin:0 0 14px;">📦 Se vendió tu producto</h2>
    <p>${p.producto_nombre} × ${p.cantidad}</p>
    <p><b>Cliente:</b> ${p.cliente_nombre}</p>
    <p><b>Dirección de envío:</b> ${formatoDireccion(p.direccion_envio)}</p>
    ${contactoHtml}
  `);
  return enviarCorreo({ to: p.proveedor_email, subject: `📦 Se vendió tu producto — pedido ${p.codigo}`, html });
}

// ---------- Correo 3: aviso a la organización, sin montos ----------
async function enviarCorreoOrganizacion(p) {
  if (!p.organizacion_email) {
    console.error(`[notificaciones] Organización "${p.organizacion_nombre}" (id ${p.organizacion_id}) sin email — no se le pudo avisar de la comisión del pedido ${p.codigo}.`);
    return { ok: false, motivo: 'organizacion_sin_email' };
  }
  const urlDashboard = APP_BASE_URL ? `${APP_BASE_URL}/organizacion-dashboard.html` : 'organizacion-dashboard.html';
  const html = layout(`
    <h2 style="color:#1f7a4b; margin:0 0 14px;">🎉 ¡Buenas noticias!</h2>
    <p>Se generó una nueva comisión para <b>${p.organizacion_nombre}</b> a través de tu link de Huayca.</p>
    <p>Cada compra que llega por tu link fortalece a tu comunidad — gracias por ser parte de Huayca.</p>
    ${botonHtml('Ver mi dashboard', urlDashboard)}
  `);
  return enviarCorreo({ to: p.organizacion_email, subject: '🎉 Nueva comisión generada para tu organización', html });
}

function resumenResultado(settled) {
  if (settled.status === 'rejected') return `error inesperado (${settled.reason})`;
  const v = settled.value;
  if (v.omitido) return `omitido (${v.omitido})`;
  return v.ok ? 'enviado' : `falló (${v.motivo})`;
}

// Punto ÚNICO de disparo de los 3 correos de "pedido aprobado". La llaman
// (sin esperarla — fire and forget real) los 3 caminos donde un pedido
// puede pasar a estado_pago='aprobado': el webhook de Mercado Pago, la
// sincronización manual y el marcar-pagado de admin — los 3 convergen en
// aprobarPagoPedido() (src/services/pagos.service.js), que es desde donde
// se llama esta función una sola vez, en vez de triplicar la llamada en
// cada endpoint.
//
// Anti-duplicados: antes de mandar nada, reclama el pedido con un UPDATE
// atómico (`WHERE notificaciones_enviadas_at IS NULL`). Si dos llamadas
// llegan casi al mismo tiempo (o si por error se llama dos veces sobre el
// mismo pedido), solo la primera "gana" la carrera y manda los correos;
// la segunda ve 0 filas afectadas y no hace nada más. Esto es una
// protección aparte de la que ya da aprobarPagoPedido() con su propio
// chequeo de estado_pago — belt and suspenders, no depende de que el
// llamador se acuerde de chequear nada.
async function notificarPedidoAprobado(pedidoId) {
  try {
    const [reclamo] = await db.query(
      `UPDATE pedidos SET notificaciones_enviadas_at = NOW() WHERE id = ? AND notificaciones_enviadas_at IS NULL`,
      [pedidoId]
    );
    if (!reclamo.affectedRows) {
      console.log(`[notificaciones] Pedido ${pedidoId}: las notificaciones ya se habían enviado antes, se omite.`);
      return;
    }

    const [rows] = await db.query(
      `SELECT p.id, p.codigo, p.cantidad, p.monto_total, p.direccion_envio,
              c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
              pr.nombre AS producto_nombre,
              prov.nombre AS proveedor_nombre, prov.email_contacto AS proveedor_email,
              o.id AS organizacion_id, o.nombre AS organizacion_nombre, o.email AS organizacion_email
       FROM pedidos p
       JOIN clientes c ON c.id = p.cliente_id
       JOIN productos pr ON pr.id = p.producto_id
       JOIN proveedores prov ON prov.id = p.proveedor_id
       LEFT JOIN organizaciones o ON o.id = p.organizacion_id
       WHERE p.id = ?`,
      [pedidoId]
    );
    if (!rows.length) {
      console.error(`[notificaciones] Pedido ${pedidoId} no encontrado — no se pudo notificar (reclamado pero sin datos, no debería pasar).`);
      return;
    }
    const p = rows[0];

    // Los 3 envíos son independientes: si uno falla no debe frenar a los
    // otros dos (allSettled, no all). El correo de organización se omite
    // por completo si es venta directa (sin organizacion_id) — ni
    // siquiera cuenta como "falló", es un resultado esperado.
    const resultados = await Promise.allSettled([
      enviarCorreoAdmin(p),
      enviarCorreoProveedor(p),
      p.organizacion_id ? enviarCorreoOrganizacion(p) : Promise.resolve({ ok: true, omitido: 'venta_directa' })
    ]);
    const [admin, proveedor, organizacion] = resultados;
    console.log(
      `[notificaciones] Pedido ${p.codigo}: admin=${resumenResultado(admin)}, proveedor=${resumenResultado(proveedor)}, organizacion=${resumenResultado(organizacion)}`
    );
  } catch (err) {
    // Última red de seguridad: pase lo que pase acá arriba, esta función
    // nunca debe propagar un error hacia el llamador (aprobarPagoPedido,
    // y transitivamente el webhook / sincronizar-pago / marcar-pagado).
    console.error(`[notificaciones] Error inesperado notificando el pedido ${pedidoId}:`, err);
  }
}

module.exports = { notificarPedidoAprobado };
