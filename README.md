# Huayca API

Backend de la plataforma Huayca — marketplace administrado con organizaciones/afiliados, proveedores y comisiones automáticas por pedido.

## Estructura

```
schema.sql                     → tablas completas de MySQL, ejecutar primero (o `npm run migrate`)
server.js                      → punto de entrada Express
src/config/db.js               → pool de conexión MySQL (usa vars de Railway)
src/config/mercadopago.js      → cliente de Mercado Pago (null si falta MP_ACCESS_TOKEN)
src/middleware/auth.js         → JWT para organizaciones/admin
src/services/pagos.service.js  → aprobar/rechazar pago de un pedido (activa comisiones, devuelve stock)
src/routes/productos.js        → catálogo público + categorías
src/routes/organizaciones.js   → registro, login, dashboard de comisiones
src/routes/pedidos.js          → creación de pedido (reserva stock, resuelve atribución del link)
src/routes/pagos.js            → preferencia de pago y webhook de Mercado Pago
src/routes/liquidaciones.js    → solicitud (organización) y aprobación/pago (admin)
src/routes/tickets.js          → devoluciones/garantías
src/routes/admin.js            → login admin, aprobar/rechazar organizaciones, CRUD proveedores/productos/categorías
scripts/migrate.js             → corre schema.sql contra la base conectada
scripts/seed.js                → carga admin + proveedor PROTEGE+ + productos + organización demo
```

## Cómo se reparte la comisión (lo importante)

Cada producto tiene fijo: `precio_proveedor + comision_afiliado + comision_huayca = precio_final`. Estos montos los define Huayca al crear/editar el producto (`/api/admin/productos`); la organización nunca puede editarlos.

Flujo de un pedido:

1. `POST /api/pedidos` — reserva stock y congela los montos del producto en el pedido. Si viene `organizacion_slug` de un link válido y aprobado, el pedido queda atribuido a esa organización (la atribución no expira: se resuelve en cada compra a partir del link usado, no de una cookie con vencimiento).
2. `POST /api/pagos/preferencia` — crea la preferencia en Mercado Pago para ese pedido.
3. Mercado Pago notifica a `POST /api/pagos/webhook` (o el admin confirma manualmente con `PATCH /api/admin/pedidos/:id/marcar-pagado`, útil mientras no haya credenciales de Mercado Pago o para pruebas). Recién ahí:
   - `pedidos.estado_pago` pasa a `aprobado`.
   - Se **activan** las comisiones: se insertan las filas en `comisiones` (proveedor / huayca / afiliado).
     - Si hubo organización → su comisión se registra a nombre de esa organización.
     - Si NO hubo organización → esa misma comisión se suma directo a Huayca (no existe "afiliado casa").
   - Se actualiza `organizaciones.saldo_disponible`.
4. Si el pago es rechazado/cancelado, el stock reservado se devuelve automáticamente y no se genera ninguna comisión.

Los montos se **congelan** en el pedido al momento de la compra (no se recalculan si el producto cambia de precio después).

## Liquidaciones

La comisión acumulada de una organización no es un retiro directo:

1. La organización solicita liquidar su saldo: `POST /api/liquidaciones` con `motivo_solicitud` (para qué proyecto se destinan los fondos). Agrupa todas sus comisiones `pendiente` en una liquidación `solicitada`.
2. Huayca la revisa (`GET /api/liquidaciones?estado=solicitada`), la aprueba (`PATCH /:id/aprobar`) y, una vez gestionada la transferencia, la marca pagada (`PATCH /:id/pagar`, con `comprobante_url` opcional). También puede rechazarla (`PATCH /:id/rechazar`), lo que devuelve las comisiones a estado `pendiente` para una futura solicitud.

## Tickets (devoluciones / garantías)

`POST /api/tickets` (público, valida email contra el pedido) y `GET /api/tickets/pedido/:codigo?email=...` para que el cliente vea el estado. El equipo Huayca gestiona la bandeja completa en `GET /api/tickets` y `PATCH /api/tickets/:id` (deriva al proveedor, responde, resuelve), según la política de Huayca y la normativa chilena de protección al consumidor — el proveedor es responsable de la garantía en sí, Huayca media vía el ticket.

## Rutas de administración

Todo bajo `/api/admin` requiere `POST /api/admin/login` primero (tabla `administradores`, no confundir con el login de organizaciones):

- Organizaciones: `GET /organizaciones`, `PATCH /organizaciones/:id/aprobar`, `.../rechazar`, `.../suspender`.
- Proveedores: `GET/POST /proveedores`, `PUT/DELETE /proveedores/:id` (delete = baja lógica a `inactivo`).
- Categorías: `GET/POST /categorias`.
- Productos: `GET/POST /productos`, `PUT/DELETE /productos/:id` (delete = baja lógica a `pausado`). Acá se fijan `precio_proveedor`, `comision_afiliado` y `comision_huayca`.
- Pedidos (operación): `GET /pedidos`, `PATCH /pedidos/:id/marcar-pagado`, `PATCH /pedidos/:id/despacho`.

## Variables de entorno

Ver `.env.example`. En Railway con el plugin de MySQL conectado, `MYSQLHOST/MYSQLPORT/MYSQLUSER/MYSQLPASSWORD/MYSQLDATABASE` los inyecta Railway solo — no hace falta declararlos. Hay que configurar manualmente en el servicio: `JWT_SECRET`, `APP_BASE_URL` (una vez que Railway asigne el dominio público) y `MP_ACCESS_TOKEN` cuando se conecte Mercado Pago.

## Deploy en Railway

1. Repo conectado a Railway → New Project → Deploy from GitHub repo.
2. Agregar el plugin de MySQL (Railway inyecta `MYSQLHOST`/`MYSQLUSER`/etc. automáticamente al servicio).
3. En la pestaña Variables del servicio backend, agregar `JWT_SECRET` y, más adelante, `MP_ACCESS_TOKEN`.
4. Activar el dominio público en Settings → Networking, y setear `APP_BASE_URL` con esa URL.
5. El schema se aplica solo al arrancar el server (`server.js` corre `schema.sql` en el boot, sin romper el arranque si falla — queda logueado). Para el primer deploy contra una base vacía no hace falta hacer nada más.

### Cargar el seed de prueba (PROTEGE+ + organización demo) sin terminal

Si tenés Railway CLI a mano: `railway run npm run migrate` y `railway run npm run seed`.

Si no (por ejemplo, trabajando desde una tablet), usá las rutas de bootstrap:

1. En Variables del servicio, agregá `BOOTSTRAP_TOKEN` con cualquier string secreto y volvé a desplegar.
2. Desde el navegador, visitá `https://tu-servicio.up.railway.app/api/bootstrap/migrate?token=EL_TOKEN` (por si el auto-migrate del boot no llegó a correr) y después `https://tu-servicio.up.railway.app/api/bootstrap/seed?token=EL_TOKEN`.
3. La respuesta del `/seed` trae el email/password del admin y de la organización demo (o confirma que ya existían). Ambas rutas son idempotentes: se pueden visitar más de una vez sin duplicar nada.
4. Una vez cargado, quitá o cambiá `BOOTSTRAP_TOKEN` — sin esa variable configurada, ambas rutas responden 404.

## Flujo de prueba end-to-end (con el seed cargado)

```
POST /api/pedidos          { producto_id, cantidad, cliente, organizacion_slug: "colegio-los-andes" }
POST /api/admin/login      { email: "admin@huayca.cl", password: "..." }
PATCH /api/admin/pedidos/:id/marcar-pagado     (con el token de admin)
POST /api/organizaciones/login   { email: "demo@colegiolosandes.cl", password: "..." }
GET  /api/organizaciones/mi-dashboard          (con el token de la organización → la comisión aparece activada)
POST /api/liquidaciones    { motivo_solicitud: "..." }   (con el token de la organización)
PATCH /api/liquidaciones/:id/aprobar  y  /pagar           (con el token de admin)
```

## Pendientes / decisiones abiertas

- Facturación manual (fuera de la boleta que ya emite Mercado Pago) no tiene endpoint propio todavía — se maneja fuera del sistema mientras el volumen sea bajo, tal como se definió.
- No hay un job que libere stock reservado por pedidos que nunca llegan a pagarse (abandono de checkout); hoy solo se libera si Mercado Pago notifica rechazo/cancelación explícito.
