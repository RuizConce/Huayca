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

const app = express();
app.use(cors());
// Límite subido de 100kb (default de Express) a 8mb: las imágenes subidas
// desde el panel viajan como data: URI en base64 dentro del JSON de
// contenido_sitio / proveedores / productos (ver POST /api/admin/upload-imagen).
app.use(express.json({ limit: '8mb' }));

// Panel de administración estático (HTML/JS puro, sin build step):
// queda disponible en /admin.html, sirviéndose desde el mismo dominio que
// la API para no tener que lidiar con CORS.
app.use(express.static('public'));

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

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Huayca API corriendo en puerto ${PORT}`);
});

// Best-effort: aplica schema.sql al arrancar (sirve para el primer deploy
// contra una base vacía). No bloquea el arranque del server ni lo tumba si
// falla — queda logueado, y de todas formas se puede reintentar a mano vía
// GET /api/bootstrap/migrate?token=... o `npm run migrate`.
runMigration()
  .then((r) => console.log(`[migrate] ${r.mensaje}`))
  .catch((err) => console.error('[migrate] No se pudo aplicar el schema automáticamente:', err.message));
