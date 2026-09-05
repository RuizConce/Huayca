require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { runMigration } = require('./src/db/migrate');

const productosRouter = require('./src/routes/productos');
const organizacionesRouter = require('./src/routes/organizaciones');
const pedidosRouter = require('./src/routes/pedidos');
const adminRouter = require('./src/routes/admin');
const pagosRouter = require('./src/routes/pagos');
const liquidacionesRouter = require('./src/routes/liquidaciones');
const ticketsRouter = require('./src/routes/tickets');
const bootstrapRouter = require('./src/routes/bootstrap');
const contenidoRouter = require('./src/routes/contenido');
const eventosRouter = require('./src/routes/eventos');
const codigosDescuentoRouter = require('./src/routes/codigosDescuento');
const APP_BASE_URL = require('./src/config/appBaseUrl');

const app = express();
app.use(cors());
// Límite subido de 100kb (default de Express) a 8mb: las imágenes subidas
// desde el panel viajan como data: URI en base64 dentro del JSON de
// contenido_sitio / proveedores / productos (ver POST /api/admin/upload-imagen).
app.use(express.json({ limit: '8mb' }));

// Colapsa barras repetidas en la ruta ("//api/pagos/webhook" ->
// "/api/pagos/webhook") ANTES de que Express intente matchear rutas. Esto
// NO es el fix real del bug de la doble barra (eso es no generar URLs mal
// formadas desde el origen — ver src/config/appBaseUrl.js, que ya
// normaliza APP_BASE_URL) — es una red de seguridad aparte, porque
// cualquier preferencia de Mercado Pago que ya se haya creado ANTES de
// ese fix quedó con notification_url/back_urls con la doble barra
// guardados ahí mismo, y Mercado Pago le va a seguir pegando a esa URL
// exacta indefinidamente (no hay forma de corregir una preferencia ya
// creada). Con esto, esas notificaciones viejas también van a matchear
// bien la ruta en vez de perderse en un 404 antes de llegar al handler.
app.use((req, res, next) => {
  const signoPregunta = req.url.indexOf('?');
  const pathname = signoPregunta === -1 ? req.url : req.url.slice(0, signoPregunta);
  const query = signoPregunta === -1 ? '' : req.url.slice(signoPregunta);
  const pathnameNormalizado = pathname.replace(/\/{2,}/g, '/');
  if (pathnameNormalizado !== pathname) {
    console.log(`[normalizar-ruta] "${pathname}" -> "${pathnameNormalizado}" (doble barra colapsada)`);
    req.url = pathnameNormalizado + query;
  }
  next();
});

// Panel de administración estático (HTML/JS puro, sin build step):
// queda disponible en /admin.html, sirviéndose desde el mismo dominio que
// la API para no tener que lidiar con CORS.
// no-cache (no no-store) en HTML/JS/CSS: cada deploy nuevo se sirve al
// toque sin depender de que el navegador o algún proxy/CDN de por medio
// decida cuándo revalidar — sigue permitiendo 304 vía ETag, así que no
// resigna el cacheo, solo obliga a chequear frescura en cada carga.
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/', (req, res) => {
  res.json({ ok: true, servicio: 'Huayca API', version: '1.0.0' });
});

app.use('/api/productos', productosRouter);
app.use('/api/organizaciones', organizacionesRouter);
app.use('/api/pedidos', pedidosRouter);
app.use('/api/admin', adminRouter);
app.use('/api/pagos', pagosRouter);
app.use('/api/liquidaciones', liquidacionesRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/bootstrap', bootstrapRouter);
app.use('/api/contenido', contenidoRouter);
app.use('/api/eventos', eventosRouter);
app.use('/api/codigos-descuento', codigosDescuentoRouter);

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Huayca API corriendo en puerto ${PORT}`);
  // Diagnóstico de arranque para el problema del webhook de Mercado Pago
  // que no llega en compras reales: deja registrado, en cada deploy, con
  // qué configuración de Mercado Pago corre ESTA instancia — así se puede
  // comparar directamente (sin esperar una compra) contra lo que dice el
  // panel de Mercado Pago (aplicación, modo test/producción del token) y
  // detectar un desalinee de token/URL apenas arranca, no recién cuando
  // falla una notificación real. El token nunca se imprime completo.
  const mpToken = process.env.MP_ACCESS_TOKEN || '';
  const tokenEnmascarado = !mpToken
    ? '(no configurado)'
    : mpToken.length <= 16
      ? mpToken.slice(0, 4) + '…(corto)'
      : `${mpToken.slice(0, 12)}…${mpToken.slice(-4)} (${mpToken.length} caracteres, ${mpToken.startsWith('APP_USR-') ? 'producción' : mpToken.startsWith('TEST-') ? 'prueba' : 'prefijo desconocido'})`;
  console.log('[MP config] MP_ACCESS_TOKEN:', tokenEnmascarado);
  // Se loguean las dos versiones (cruda y normalizada) para que quede
  // explícito en cada arranque si la variable en Railway tiene barra(s)
  // final(es) — la normalizada es la que efectivamente usa el código para
  // armar notification_url/back_urls (ver src/config/appBaseUrl.js), así
  // que si difieren de la cruda, ya no importa: el código igual arma bien
  // la URL de cualquier forma en que esté escrita la variable.
  console.log('[MP config] APP_BASE_URL (tal cual en Railway):', process.env.APP_BASE_URL || '(no configurado)');
  console.log('[MP config] APP_BASE_URL (normalizada, la que se usa de verdad):', APP_BASE_URL || '(no configurado)');
  console.log('[MP config] MP_NOTIFICATION_URL (override manual, opcional):', process.env.MP_NOTIFICATION_URL || '(no configurado — se arma como {APP_BASE_URL}/api/pagos/webhook)');
});

// Best-effort: aplica schema.sql al arrancar (sirve para el primer deploy
// contra una base vacía). No bloquea el arranque del server ni lo tumba si
// falla — queda logueado, y de todas formas se puede reintentar a mano vía
// GET /api/bootstrap/migrate?token=... o `npm run migrate`.
runMigration()
  .then((r) => console.log(`[migrate] ${r.mensaje}`))
  .catch((err) => console.error('[migrate] No se pudo aplicar el schema automáticamente:', err.message));
