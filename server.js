require('dotenv').config();
const express = require('express');
const cors = require('cors');

const productosRouter = require('./src/routes/productos');
const organizacionesRouter = require('./src/routes/organizaciones');
const pedidosRouter = require('./src/routes/pedidos');
const adminRouter = require('./src/routes/admin');
const pagosRouter = require('./src/routes/pagos');
const liquidacionesRouter = require('./src/routes/liquidaciones');
const ticketsRouter = require('./src/routes/tickets');

const app = express();
app.use(cors());
app.use(express.json());

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

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Huayca API corriendo en puerto ${PORT}`);
});
