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
public/admin.html               → panel de administración (HTML/JS puro, sin build), servido como estático
public/admin-contenido.html     → panel de contenido del sitio (CMS liviano), enlazado desde admin.html
public/index.html, catalogo.html, producto.html, checkout.html,
public/organizaciones.html, organizacion-registro/login/dashboard.html
                                 → frontend público (HTML/JS puro, sin build), servido como estático
public/css/huayca.css, public/js/huayca.js
                                 → estilos y helpers compartidos por todo el frontend público
src/routes/contenido.js         → GET /api/contenido (público, combinado)
```

## Panel de administración

`public/admin.html` es un panel liviano (login, gestión de marcas/proveedores con logo, y sus productos con precio/comisiones) servido directo por Express en `/admin.html` — vive en el mismo dominio que la API, así que no hay problemas de CORS y usa `localStorage` para el token del admin. Consume `POST /api/admin/login`, `GET/POST /api/admin/proveedores` y `GET/POST/PUT /api/admin/productos` (con filtro `?proveedor_id=`).

## Frontend público

HTML/CSS/JS plano, sin build step, mismo patrón que `admin.html` — servido por Express desde `/public` (un solo dominio, sin CORS). `js/huayca.js` centraliza el helper de fetch, el formateo de precios/fechas y la atribución de organización.

- **`index.html`** — home: hero, tipos de organización, productos destacados (`GET /api/productos`), bloque de impacto y confianza.
- **`catalogo.html`** — grid de productos con filtro por categoría (chips + `?categoria=`) y buscador (`?q=`).
- **`producto.html?slug=X`** — ficha de producto (`GET /api/productos/:slug`); es el punto de entrada del link compartible de una organización: `.../producto.html?slug=gps-vehicular&org=colegio-los-andes`.
- **`checkout.html?slug=X`** — formulario de datos + resumen, `POST /api/pedidos`, y a continuación `POST /api/pagos/preferencia` para redirigir al comprador a pagar en Mercado Pago (`sandbox_init_point` mientras `MP_ACCESS_TOKEN` sea de prueba). Si `MP_ACCESS_TOKEN` no está configurado o falla la creación de la preferencia, no se corta el flujo: cae a la pantalla de confirmación de siempre ("pedido registrado, pendiente de pago"). Mercado Pago redirige de vuelta a `pago-resultado.html?pedido=...` (ver sección de comisiones más abajo).
- **`organizaciones.html`** — buscador/listado público de organizaciones aprobadas (`GET /api/organizaciones?q=`), para el botón "Buscar organización".
- **`organizacion-registro.html` / `organizacion-login.html` / `organizacion-dashboard.html`** — alta, login y dashboard de comisiones + link para compartir, usando las rutas ya documentadas más abajo.

**Atribución del link:** cualquier página que cargue con `?org={slug}` guarda ese slug en `localStorage` (no expira mientras no se borre el storage ni cambie el link, igual que la regla de negocio) y lo reutiliza en catálogo → ficha → checkout, mostrando el banner "Estás comprando a través de...". El backend igual es la fuente de verdad: si el slug no corresponde a una organización aprobada, `POST /api/pedidos` la trata como venta directa sin importar lo que diga el frontend.

**Dos rutas públicas nuevas** que agregué en `src/routes/organizaciones.js` para que el frontend funcionara (no estaban en el esqueleto original):
- `GET /api/organizaciones?q=texto` — listado de organizaciones aprobadas.
- `GET /api/organizaciones/:slug` — perfil público de una organización aprobada (nombre, tipo, logo, comuna/región, descripción del proyecto).

## Contenido del sitio (CMS liviano)

Los textos e imágenes del home (franja superior, hero, tarjetas de tipo de organización, banner "apoya a tu organización", "cómo funciona" y footer) son editables desde el panel de admin, sin tocar código.

- **Tabla** `contenido_sitio` (`clave` VARCHAR PK, `valor` JSON): una fila por bloque (`header`, `hero`, `organizaciones_cards`, `banner_apoya`, `como_funciona`, `footer`). Se crea e inicializa sola vía la misma auto-migración del server (`src/db/migrate.js`): si la tabla no existe la crea, y **siempre** intenta sembrar las 6 claves por defecto con `INSERT IGNORE` — no pisa nunca una fila que el admin ya haya editado, así que es seguro que corra en cada boot.
- **`GET /api/contenido`** — pública, sin auth. Devuelve las 6 claves combinadas en un solo objeto. El frontend la llama una vez por carga de página (`Huayca.cargarContenidoSitio()` en `js/huayca.js`, memoizada).
- **`PUT /api/admin/contenido/:clave`** — admin, reemplaza el valor completo de esa clave (no hace merge parcial). Valida que `:clave` sea una de las 6 conocidas.
- **`public/admin-contenido.html`** — un formulario por clave, con su propio botón "Guardar cambios" (reutiliza el token de admin en `localStorage`, igual que `admin.html`). Enlazado desde el header de `admin.html` una vez logueado.
- **Nunca rompe el sitio**: si `GET /api/contenido` falla (red, DB caída) o una clave/campo específico viene vacío, el frontend (`Huayca.aplicarHeaderFooter` / `Huayca.aplicarContenidoHome`) simplemente no toca ese elemento — el texto/imagen que ya está escrito a mano en el HTML queda como fallback. Probado explícitamente abortando la petición y confirmando que el hero se sigue viendo con su contenido por defecto.
- El campo `hero.imagenes` acepta emojis/texto corto (se muestran tal cual) o URLs (`http(s)://`, rutas que empiecen con `/`, o `data:image/...`), que se renderizan como `<img>` — así no hace falta esperar a tener fotos reales para que el campo funcione.
- El franja superior y el footer (tagline + redes sociales) se aplican en **todas** las páginas públicas, no solo en el home; el resto de los bloques (hero, tarjetas, banner, cómo funciona) son exclusivos de `index.html`.

### Hero como carrusel

`hero.imagenes` maneja el carrusel del hero (`Huayca.iniciarCarruselHero()` / `construirSlidesHero()` en `js/huayca.js`), pensado para fotos de producto (idealmente PNG con fondo transparente) flotando sobre la forma orgánica verde:

- Autoplay cada 4.5s, flechas prev/next, puntos indicadores, swipe táctil en móvil, transición deslizante suave.
- 1 sola imagen → queda fija, sin flechas ni puntos (no tiene sentido carrusel de un elemento).
- 0 imágenes (el admin borró todas) → un placeholder limpio (ícono), nunca deja el espacio en blanco.
- El carrusel arranca interactivo con el fallback de 6 íconos ya escrito en el HTML **antes** de esperar la respuesta de `/api/contenido` — si la llamada falla, ese fallback sigue funcionando (autoplay incluido) tal cual.
- Cada campo de imagen del panel (header, hero, tarjetas de organización, banner) muestra la medida recomendada debajo del input y, si la imagen carga, sus dimensiones reales como referencia (nunca bloquea el guardado). Mismo patrón aplicado al logo de marca y a la imagen principal de producto en `admin.html`.

### Imágenes: se suben, no se pegan por URL

Todos los campos de imagen de ambos paneles (logo de marca, imagen de producto, logo del header, imágenes del hero, imagen del banner, imagen de cada tarjeta de organización) son de subida de archivo, no de URL — con preview y botón "✕" para quitar la imagen.

- **`POST /api/admin/upload-imagen`** (admin, `multipart/form-data`, campo `imagen`): recibe el archivo en memoria (nunca toca el filesystem) y devuelve `{ url }` con la imagen codificada como `data:` URI en base64, lista para guardar tal cual en el campo correspondiente.
- **¿Por qué base64 en la base en vez de guardar el archivo en `/public`?** Railway no tiene disco persistente entre deploys — cualquier archivo escrito ahí se pierde en el próximo push. Guardar la imagen codificada dentro de la fila (MySQL sí persiste) evita ese problema sin necesitar un servicio de storage externo.
- **Tope de 400KB por imagen** (`multer` con `limits.fileSize`, mensaje claro si se excede) para que un solo `PUT` con varias imágenes (ej. las 6 del carrusel del hero en un solo request) no se acerque al límite de payload. `express.json()` corre con `limit: '8mb'` para tener margen.
- `proveedores.logo_url` y `productos.imagen_principal` pasaron de `VARCHAR(500)` a `LONGTEXT` (schema.sql + migración incremental `ensureColumnType` en `src/db/migrate.js`, que ensancha la columna en bases que ya habían migrado con el tipo viejo). `contenido_sitio.valor` ya era `JSON`, sin cambios.
- El campo `hero.imagenes` sigue aceptando emoji/texto corto como placeholder liviano — el botón "📤" de cada fila sube una foto y reemplaza lo que hubiera en esa fila.

No hay carrito multi-producto: el modelo de pedidos es un producto por pedido (así está diseñado el backend), así que "Comprar ahora" lleva directo al checkout de ese producto. El ícono de carrito en el header queda como afordancia visual, sin funcionalidad real, para no prometer algo que el backend no soporta todavía.

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
