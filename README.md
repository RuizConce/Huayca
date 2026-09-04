# Huayca API

Backend de la plataforma Huayca — marketplace administrado con organizaciones/afiliados, proveedores y comisiones automáticas por pedido.

## Estructura

```
schema.sql                     → tablas completas de MySQL, ejecutar primero (o `npm run migrate`)
server.js                      → punto de entrada Express
src/config/db.js               → pool de conexión MySQL (usa vars de Railway)
src/config/mercadopago.js      → cliente de Mercado Pago (null si falta MP_ACCESS_TOKEN)
src/config/resend.js           → cliente de Resend, correos transaccionales (null si falta RESEND_API_KEY)
src/services/notificaciones.service.js → los 3 correos de "pedido aprobado" (admin/proveedor/organización)
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
public/admin-panel.html          → shell del panel: login + pestañas persistentes, punto de entrada único
public/admin.html               → pestaña "Marcas y Productos" (HTML/JS puro, sin build), cargada en iframe por admin-panel.html
public/admin-contenido.html     → pestaña "Contenido del sitio" (CMS liviano)
public/admin-organizaciones.html → pestaña "Organizaciones": aprobar/rechazar/suspender/reactivar
public/admin-pedidos.html       → pestaña "Pedidos": listado filtrable + marcar pagado
public/admin-logistica.html     → pestaña "Logística": pedidos aprobados pendientes de despacho, agrupados por proveedor
public/admin-actividad.html     → pestaña "Actividad": dashboard del embudo de conversión (eventos_actividad)
public/admin-ventas.html        → pestaña "Ventas": resumen financiero + rankings + export CSV
public/admin-sincronizar-pago.html → pestaña "Sincronizar pago": plan B manual, consulta y sincroniza un pago contra Mercado Pago
public/admin-configuracion.html → pestaña "Configuración": email/nombre y cambio de contraseña del admin
public/index.html, catalogo.html, producto.html, checkout.html, pago-resultado.html,
public/organizaciones.html, organizacion-registro/login/dashboard.html
                                 → frontend público (HTML/JS puro, sin build), servido como estático
public/css/huayca.css, public/js/huayca.js
                                 → estilos y helpers compartidos por todo el frontend público
src/routes/contenido.js         → GET /api/contenido (público, combinado)
src/routes/eventos.js           → POST /api/eventos (público, tracking del embudo de conversión)
```

## Panel de administración

El punto de entrada único es **`public/admin-panel.html`** — un shell con login (`POST /api/admin/login`) y una barra de pestañas persistente (Marcas y Productos, Organizaciones, Pedidos, Logística, Actividad, Ventas, Sincronizar pago, Contenido del sitio, Configuración) servido directo por Express, mismo dominio que la API. Cada pestaña es, por dentro, una de las páginas de admin que ya existían (`admin.html`, `admin-organizaciones.html`, `admin-logistica.html`, etc.) sin reescribir — el shell las carga en un `<iframe src="admin-xxx.html?embed=1">` la primera vez que se visita esa pestaña y después solo la esconde/muestra (nunca la destruye), así que cambiar de pestaña no recarga nada y el estado de cada una (filtros, scroll, un formulario a medio llenar) queda intacto al volver. `?tab=<clave>` en la URL del shell fija la pestaña inicial; cada pestaña actualiza esa URL sin navegar (`history.replaceState`) para que recargar la página completa vuelva al mismo lugar.

**Modo `?embed=1`:** cada página de admin detecta este parámetro y, si está presente, oculta su propio `<header>` (el shell ya tiene la barra de pestañas) y, en vez de navegar el iframe cuando no hay token o la sesión expira (401/403), avisa al shell por `postMessage({ type: 'huayca-logout' })` — el shell escucha ese mensaje y cierra sesión de las 9 pestañas a la vez, no solo la que detectó el problema. El login es uno solo porque las 9 páginas viven en el mismo origen y comparten el mismo `localStorage` (`huayca_admin_token`) — el shell no le "pasa" el token a los iframes de ninguna forma especial, cada uno lo lee directo de ahí. Acceder directo a cualquier `admin-xxx.html` sin `?embed=1` (ej. un bookmark viejo) reenvía automáticamente a `admin-panel.html?tab=xxx`, así ya no quedan dos formas distintas de navegar el panel.

`public/admin.html` (pestaña "Marcas y Productos") consume `GET/POST /api/admin/proveedores` y `GET/POST/PUT /api/admin/productos` (con filtro `?proveedor_id=`).

**Categoría del producto:** el formulario tiene un selector poblado con `GET /api/admin/categorias`, con una opción final "+ Nueva categoría…" que abre un mini-formulario inline (nombre + un emoji como ícono, sin selector de imagen) y llama `POST /api/admin/categorias` — la categoría queda creada y ya seleccionada, sin salir del modal de producto. Elegir "Sin categoría" manda `categoria_id: null` (no usa `COALESCE` en el `UPDATE`, mismo motivo que `regiones_disponibles`: si lo usara, nunca se podría desasignar una categoría ya puesta).

**Oferta destacada:** checkbox "Marcar como oferta destacada (se ancla arriba)" + un campo de fecha opcional "Destacar hasta" que aparece al marcarlo (vacío = anclado sin vencimiento, hasta que se desmarque a mano) — ver "Ofertas ancladas" más abajo para la lógica de orden. El listado de productos de cada marca muestra un badge `📌 Destacado` (o `📌 Destacado hasta DD/MM` si tiene fecha) en los que están anclados **activos** ahora mismo — uno cuya fecha ya venció deja de mostrar el badge aunque el checkbox interno siga marcado, mismo criterio que usa el `ORDER BY` del catálogo.

**Restricción de productos por región:** al crear/editar un producto hay un checkbox "¿Este producto tiene restricción de región?"; si se activa, aparece un multi-select con las 16 regiones de Chile (mismo dataset que el checkout, ver más abajo) para elegir dónde se despacha. Se guarda en `productos.regiones_disponibles` (columna JSON). El formulario siempre reenvía el estado completo, así que `PUT /api/admin/productos/:id` escribe esa columna sin `COALESCE` (a diferencia del resto de los campos del UPDATE) — si no lo hiciera así, sería imposible quitarle la restricción a un producto una vez puesta, porque `COALESCE(?, valor_actual)` nunca deja pasar un `null` explícito.

## Frontend público

HTML/CSS/JS plano, sin build step, mismo patrón que `admin.html` — servido por Express desde `/public` (un solo dominio, sin CORS). `js/huayca.js` centraliza el helper de fetch, el formateo de precios/fechas y la atribución de organización.

- **`index.html`** — home: hero, tipos de organización, carrusel de "Productos destacados" (`GET /api/productos`, primeros 10), bloque de impacto y confianza.
- **`catalogo.html`** — grid de productos con filtro por categoría (chips + `?categoria=`, contra `categoria_id`/`categorias.slug` reales — nunca datos de ejemplo) y buscador (`?q=`).

**Ofertas ancladas:** ambas vistas comparten la misma fuente (`GET /api/productos`) y su orden — `productos.destacado` + `destacado_hasta` (opcional) permiten anclar un producto arriba del todo por un período más largo que "lo último subido". El `ORDER BY` pone primero los productos con `destacado=true` **y** (`destacado_hasta IS NULL` o todavía no venció), ordenados por `destacado_desde` descendente (el ancla más reciente primero); después, el resto de los activos por `created_at` descendente, como siempre. Un anclado cuya `destacado_hasta` ya pasó cae solo al bloque normal en la siguiente consulta — no hace falta ningún job/cron, la condición de fecha ya lo saca del bloque anclado. `destacado_desde` no lo toca el admin directamente: lo calcula `PUT /api/admin/productos/:id` (se fija a `NOW()` recién cuando `destacado` pasa de `false` a `true`, y se limpia a `NULL` al desmarcarlo) — así, reeditar un producto que ya estaba anclado (ej. cambiarle el stock) no lo revuelve de posición dentro del bloque anclado.
- **`producto.html?slug=X`** — ficha de producto (`GET /api/productos/:slug`); es el punto de entrada del link compartible de una organización: `.../producto.html?slug=gps-vehicular&org=colegio-los-andes`. Si el producto tiene restricción de región, muestra un aviso "📍 Disponible solo para: [regiones]" antes de llegar al checkout. La descripción se colapsa ("Ver más"/"Ver menos") cuando pasa los ~300 caracteres — se trunca en el corte de palabra más cercano, nunca a la mitad de una; una descripción corta no se toca.

**Imagen de producto:** `index.html` (destacados), `catalogo.html` y el resumen de `checkout.html` muestran `imagen_principal` cuando el producto tiene una (mismo patrón que `producto.html`: `<img>` si hay imagen, si no el emoji de `Huayca.iconoProducto()` como placeholder) — antes, esas tres vistas ignoraban `imagen_principal` y siempre mostraban el emoji aunque el producto tuviera una foto real subida desde el admin, el mismo tipo de bug ya visto una vez con el logo del header.
- **`checkout.html?slug=X`** — formulario de datos + resumen, `POST /api/pedidos`, y a continuación `POST /api/pagos/preferencia` para redirigir al comprador a pagar en Mercado Pago (`sandbox_init_point` mientras `MP_ACCESS_TOKEN` sea de prueba). Si `MP_ACCESS_TOKEN` no está configurado o falla la creación de la preferencia, no se corta el flujo: cae a la pantalla de confirmación de siempre ("pedido registrado, pendiente de pago"). Mercado Pago redirige de vuelta a `pago-resultado.html?pedido=...` (ver sección de comisiones más abajo).
  Nombre, email, teléfono, calle, número, región y comuna son obligatorios (depto/referencia sigue siendo opcional): el botón "Confirmar pedido" arranca deshabilitado y se re-evalúa en cada cambio del formulario, y `POST /api/pedidos` repite la misma validación en el backend (400 con el detalle de qué campo falta) porque el frontend nunca es la única línea de defensa. Región y comuna son selects en cascada — la comuna queda deshabilitada y vacía hasta elegir región — poblados desde `public/js/chile-regiones-comunas.js`, un dataset propio con las 16 regiones oficiales de Chile (orden geográfico norte→sur, post-2018 con Región de Ñuble ya separada de Biobío) y sus ~346 comunas, expuesto como `<script>` global (`CHILE_REGIONES`) y también vía `require()` para que el backend valide contra los mismos nombres. Si el producto tiene `regiones_disponibles` (ver panel de admin arriba), elegir una región no incluida en esa lista bloquea el botón y muestra "Este producto no está disponible para envío a [región]. Regiones disponibles: [...]"; `POST /api/pedidos` repite este chequeo del lado del servidor antes de crear el pedido.
- **`organizaciones.html`** — buscador/listado público de organizaciones aprobadas (`GET /api/organizaciones?q=`), para el botón "Buscar organización".
- **`organizacion-registro.html` / `organizacion-login.html` / `organizacion-dashboard.html`** — alta, login y dashboard de comisiones + link para compartir, usando las rutas ya documentadas más abajo. El dashboard está organizado en 2 pestañas (mismo patrón shell-liviano del admin, pero sin iframes: acá todo el contenido ya vive en una sola página, así que cambiar de pestaña es puro mostrar/ocultar dos `<div>` vía JS — ambas ya están armadas en el DOM desde la carga inicial, no hay un segundo fetch al cambiar):
  - **"Mis comisiones"** (la que ya existía) — saldo disponible, total generado, total pagado, ventas realizadas, el link único para compartir, y "Últimas comisiones" (pedido/monto/estado/fecha).
  - **"Productos y mis comisiones"** — el catálogo completo de productos activos (`GET /api/organizaciones/catalogo-comisiones`, auth de organización) ordenado de mayor a menor comisión, para que la organización decida qué le conviene promocionar — con un botón "Copiar mi link" por producto (mismo patrón `?org=slug`, apuntando a `producto.html?slug=X&org=Y`). Esa ruta expone SOLO `id, nombre, slug, imagen_principal, precio_final` y `comision_afiliado` renombrada `tu_comision` en la respuesta — el `SELECT` elige las columnas de forma explícita a propósito (nunca `SELECT p.*`) para que sea imposible que `precio_proveedor`, `comision_huayca` o `comision_eliss` se cuelen ahí, ni siquiera inspeccionando la petición desde el navegador.

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

Cada producto tiene fijo un desglose de 5 componentes, sumados en la columna generada `productos.precio_final`:

```
precio_final = precio_proveedor + comision_afiliado + comision_huayca + comision_eliss
               + (impuesto_incluido ? 0 : monto_impuesto)
```

- `precio_proveedor` — lo que recibe el proveedor.
- `comision_afiliado` — comisión de la **organización** (nombre de columna histórico: se llama "afiliado" desde antes de que "organización" fuera el término, no se renombró para no romper nada existente — en pedidos/comisiones/reportes se la trata siempre como la comisión de la organización).
- `comision_huayca` — comisión de Huayca como marca comercial.
- `comision_eliss` — comisión de **Eliss Conecta SpA**, la empresa de infraestructura/operación detrás de Huayca (separada como negocio). Se registra igual que las demás, con o sin organización de por medio — a diferencia de `comision_afiliado`, que sin organización se le suma directo a Huayca (ver más abajo), la de Eliss no tiene ese caso especial: siempre es su propia fila.
- `impuesto_incluido` (boolean, default `true`) + `monto_impuesto` — a veces `precio_proveedor` ya incluye el impuesto (caso normal, no se suma nada aparte); si no, `impuesto_incluido=false` y `monto_impuesto` se suma al final.

Estos montos los define Huayca al crear/editar el producto (`/api/admin/productos`, con los campos correspondientes en el formulario de `admin.html` — comisión Eliss, el checkbox de impuesto y el campo condicional de monto); la organización nunca puede editarlos ni verlos completos (ver más abajo, "catálogo con comisiones").

**Nunca se expone al público:** `GET /api/productos/:slug` saca `precio_proveedor`, `comision_afiliado`, `comision_huayca`, `comision_eliss`, `impuesto_incluido` y `monto_impuesto` de la respuesta antes de mandarla — el catálogo público y `producto.html` solo ven `precio_final`. `GET /api/admin/productos/desglose` (auth admin) sí devuelve el desglose completo de todos los productos activos, para la sub-pestaña "Desglose de productos" dentro de la pestaña Ventas del panel (`admin-ventas.html`).

Flujo de un pedido:

1. `POST /api/pedidos` — reserva stock y congela los montos del producto en el pedido. Si viene `organizacion_slug` de un link válido y aprobado, el pedido queda atribuido a esa organización (la atribución no expira: se resuelve en cada compra a partir del link usado, no de una cookie con vencimiento).
2. `POST /api/pagos/preferencia` — crea la preferencia en Mercado Pago para ese pedido.
3. Mercado Pago notifica a `POST /api/pagos/webhook` (o el admin confirma manualmente con `PATCH /api/admin/pedidos/:id/marcar-pagado`, útil mientras no haya credenciales de Mercado Pago o para pruebas). El webhook entiende tanto el formato moderno (`?type=payment&data.id=`) como el IPN clásico (`?topic=payment&id=` o `?topic=merchant_order&id=`) — un pago aprobado en Mercado Pago que nunca actualizó el pedido en Huayca (bug de HUY-000006) resultó ser justo una notificación en el formato viejo que el webhook no reconocía y descartaba en silencio (devolvía 200 igual, así que ni figuraba como error). Como plan B para cuando el webhook falle o tarde, `POST /api/admin/pedidos/:id/sincronizar-pago` (con UI en `admin-sincronizar-pago.html`, `:id` acepta el código del pedido o el id numérico) consulta el pago real contra Mercado Pago — por `payment_id`/`collection_id` si se lo pasás, o por `external_reference` si no — y aplica exactamente la misma lógica que el webhook (`procesarPagoInfo` en `pagos.service.js`, compartida entre los dos). Recién con el webhook (o la sincronización manual):
   - `pedidos.estado_pago` pasa a `aprobado`.
   - Se **activan** las comisiones: se insertan las filas en `comisiones` (proveedor / huayca / afiliado / eliss).
     - Si hubo organización → su comisión (`afiliado`) se registra a nombre de esa organización.
     - Si NO hubo organización → esa misma comisión se suma directo a Huayca (no existe "afiliado casa").
     - `eliss` se registra siempre, tenga o no organización el pedido — es independiente de esa lógica.
   - Se actualiza `organizaciones.saldo_disponible`.
4. Si el pago es rechazado/cancelado, el stock reservado se devuelve automáticamente y no se genera ninguna comisión.

Los montos se **congelan** en el pedido al momento de la compra (no se recalculan si el producto cambia de precio después).

## Correos automáticos al aprobarse un pedido

`estado_pago` puede pasar a `aprobado` por 3 caminos distintos (webhook, `sincronizar-pago`, `marcar-pagado`), pero los 3 convergen en una sola función, `aprobarPagoPedido()` (`src/services/pagos.service.js`) — ahí, y solo ahí, se dispara (sin `await`, fire-and-forget de verdad) `notificarPedidoAprobado(pedidoId)` (`src/services/notificaciones.service.js`). No hizo falta agregar la llamada en los 3 endpoints por separado: ya estaban todos pasando por ese mismo lugar.

Tres correos por Resend, cada uno independiente (si uno falla no frena a los otros — `Promise.allSettled`, no `Promise.all`):

1. **Admin** (`ADMIN_NOTIFICATION_EMAIL`) — aviso interno: código, producto, monto, organización o "venta directa", cliente.
2. **Proveedor** (`proveedores.email_contacto`) — "se vendió tu producto", con un botón `wa.me/{teléfono}` pre-armado si el cliente dejó teléfono (si no, se muestra su email como contacto alternativo), más la dirección de envío.
3. **Organización** (`organizaciones.email`) — solo si el pedido tiene `organizacion_id` (venta directa = no se manda). Mensaje sin montos ("se generó una nueva comisión"), con botón a `organizacion-dashboard.html`.

Anti-duplicados: `notificarPedidoAprobado()` reclama el pedido con un `UPDATE pedidos SET notificaciones_enviadas_at = NOW() WHERE id = ? AND notificaciones_enviadas_at IS NULL` antes de mandar nada — si dos llamadas caen sobre el mismo pedido (o se llama la función a mano dos veces), solo la primera manda los 3 correos.

Sin `RESEND_API_KEY` configurada (o si a un proveedor/organización le falta el email), el envío correspondiente se loguea con `console.error` y ahí queda — nunca bloquea ni afecta la confirmación del pago al comprador.

## Liquidaciones

La comisión acumulada de una organización no es un retiro directo:

1. La organización solicita liquidar su saldo: `POST /api/liquidaciones` con `motivo_solicitud` (para qué proyecto se destinan los fondos). Agrupa todas sus comisiones `pendiente` en una liquidación `solicitada`.
2. Huayca la revisa (`GET /api/liquidaciones?estado=solicitada`), la aprueba (`PATCH /:id/aprobar`) y, una vez gestionada la transferencia, la marca pagada (`PATCH /:id/pagar`, con `comprobante_url` opcional). También puede rechazarla (`PATCH /:id/rechazar`), lo que devuelve las comisiones a estado `pendiente` para una futura solicitud.

## Tickets (devoluciones / garantías)

`POST /api/tickets` (público, valida email contra el pedido) y `GET /api/tickets/pedido/:codigo?email=...` para que el cliente vea el estado. El equipo Huayca gestiona la bandeja completa en `GET /api/tickets` y `PATCH /api/tickets/:id` (deriva al proveedor, responde, resuelve), según la política de Huayca y la normativa chilena de protección al consumidor — el proveedor es responsable de la garantía en sí, Huayca media vía el ticket.

## Logística (`admin-logistica.html`)

Vista operativa enfocada solo en lo que ya está pagado y falta despachar — a diferencia de `GET /api/admin/pedidos` (que trae todo). Filtra `estado_pago = 'aprobado'` y `estado_despacho` distinto de `entregado` **y** de `no_aplica` (un admin puede marcar a mano un pedido como "no aplica" para algo que no necesita envío, y ese tampoco debería contar como trabajo pendiente), agrupa por proveedor (cada proveedor gestiona su propio despacho, ver `proveedores.gestiona_despacho`) y ofrece un botón de "avanzar" que recorre `pendiente → preparando → enviado → entregado` llamando `PATCH /api/admin/pedidos/:id/despacho`. No agrega ningún endpoint nuevo: reutiliza `GET /api/admin/pedidos` (que ahora también devuelve `cliente_telefono`, `direccion_envio` y `proveedor_id`, campos que esta vista necesita) y el `PATCH .../despacho` que ya existía.

## Actividad / embudo de conversión (`admin-actividad.html`)

Trackea el recorrido de una visita — sin cuentas de usuario — vía un `session_id` que el frontend genera una vez y guarda en `sessionStorage` (`Huayca.trackEvento()` en `js/huayca.js`). Cuatro momentos del embudo se registran en `eventos_actividad` a través de `POST /api/eventos` (público, sin auth, "fire and forget": nunca bloquea ni condiciona el flujo de compra si falla):

- `vista_producto` — al cargar `producto.html`.
- `agregar_carrito` — al hacer click en "Comprar ahora" (no hay carrito real; representa la intención de compra de ese producto).
- `inicio_checkout` — al llegar a `checkout.html` con el producto ya resuelto.
- `compra_completada` — cuando `POST /api/pedidos` responde OK (incluye `pedido_id`). Marca que el checkout se completó, no que el pago ya se aprobó — eso lo confirma el webhook de Mercado Pago por su cuenta y queda en `pedidos.estado_pago`, un dato aparte.

`GET /api/admin/actividad?desde=ISO&hasta=ISO` (por defecto, últimos 30 días) agrega todo esto: totales por tipo, tasa de abandono (`(inicio_checkout - compra_completada) / inicio_checkout`), top 5 productos más vistos, y la lista de "carritos abandonados" — sesiones con `inicio_checkout` en el rango que **nunca** (en ninguna fecha, no solo dentro del rango) dispararon `compra_completada`.

## Pedidos (`admin-pedidos.html`)

Vista general de pedidos para el equipo Huayca, con filtros combinables (rango de fecha, estado de pago, estado de despacho, organización, proveedor y una búsqueda por código/nombre/email) sobre `GET /api/admin/pedidos`, que ahora acepta `desde=`, `hasta=`, `proveedor_id=`, `organizacion_id=` y `q=` además de los `estado_pago=`/`estado_despacho=` que ya usaba Logística (todos opcionales — sin ellos, el endpoint se comporta exactamente igual que antes). Incluye un botón "Marcar pagado" para los pedidos `pendiente`, que reutiliza `PATCH /api/admin/pedidos/:id/marcar-pagado` (mismo servicio que usa el webhook de Mercado Pago, así que activa las comisiones igual).

## Ventas / reportes financieros (`admin-ventas.html`)

Dashboard de control de ventas para llevar contabilidad fuera del sistema: selector de rango (presets Hoy/7 días/30 días + fechas personalizadas) y filtros opcionales por proveedor/organización, sobre dos rutas nuevas:

- **`GET /api/admin/reportes/resumen?desde=&hasta=&proveedor_id=&organizacion_id=`** — resumen financiero del período **solo sobre pedidos con `estado_pago='aprobado'`** (una venta que nunca se pagó no es plata vendida ni comisión generada): total vendido (`SUM(monto_total)`), total pagado a proveedores (`SUM(monto_proveedor)`), comisión de organizaciones generada (`SUM(monto_comision_afiliado)`, separada en pagada vs. pendiente de liquidar según `estado_liquidacion`), total retenido por Huayca (`SUM(monto_comision_huayca)`) y cantidad de pedidos aprobados — más dos rankings: organizaciones por comisión generada y productos por monto vendido (no confundir con "más vistos" de Actividad, acá es venta real).
- **`GET /api/admin/reportes/pedidos.csv?desde=&hasta=&proveedor_id=&organizacion_id=`** — descarga un CSV (una fila por pedido, con BOM UTF-8 para que Excel en Windows no rompa tildes/ñ) con columnas `fecha, codigo_pedido, cliente_nombre, cliente_email, producto, cantidad, organizacion, proveedor, monto_proveedor, monto_comision_afiliado, monto_comision_huayca, monto_total, estado_pago, estado_despacho`. A diferencia del resumen, el CSV **no** filtra por `estado_pago` — trae el registro completo del período (incluye pendientes y rechazados) porque es lo que Cristian usa para su propia contabilidad, donde la completitud importa más que "solo lo aprobado". El nombre del archivo es descriptivo (`huayca-pedidos-2026-08-01-a-2026-08-31.csv`) y se descarga con un `fetch` autenticado (no un link plano, porque la ruta exige el Bearer token) que arma un blob y dispara la descarga a mano.

**Sub-pestaña "Desglose de productos"** (dentro de la misma `admin-ventas.html`, sin fecha — es "estado actual del catálogo", no algo que varíe por rango): tabla con TODOS los productos activos y sus 5 componentes de precio uno al lado del otro (proveedor, comisión organización, comisión Huayca, comisión Eliss, impuesto o "Incluido", precio final) más el stock, para ver de un vistazo la composición de precio de todo el catálogo sin entrar producto por producto. La trae `GET /api/admin/productos/desglose` (auth admin), cargada recién la primera vez que se visita esa sub-pestaña (lazy load).

## Configuración del admin (`admin-configuracion.html`)

Autogestión de la propia cuenta de administrador: cambiar nombre/email (`GET/PUT /api/admin/me`) y cambiar la contraseña (`PUT /api/admin/me/password`, pide la contraseña actual y valida mínimo 8 caracteres en la nueva). No hay recuperación de contraseña por email todavía — si alguien pierde el acceso, hay que actualizar `password_hash` directo en la base.

## Rutas de administración

Todo bajo `/api/admin` requiere `POST /api/admin/login` primero (tabla `administradores`, no confundir con el login de organizaciones):

- Organizaciones: `GET /organizaciones`, `PATCH /organizaciones/:id/aprobar`, `.../rechazar`, `.../suspender`, `.../reactivar` (rechazada o suspendida → aprobada).
- Proveedores: `GET/POST /proveedores`, `PUT/DELETE /proveedores/:id` (delete = baja lógica a `inactivo`).
- Categorías: `GET/POST /categorias`.
- Productos: `GET/POST /productos`, `PUT/DELETE /productos/:id`, `GET /productos/desglose` (ver sección de Ventas arriba). Acá se fijan `precio_proveedor`, `comision_afiliado`, `comision_huayca`, `comision_eliss`, `impuesto_incluido` y `monto_impuesto` (ver "Cómo se reparte la comisión" más arriba). El DELETE borra de verdad **solo si el producto nunca tuvo pedidos** (y limpia primero sus filas de tracking en `eventos_actividad`/`link_clicks`, que también referencian `producto_id`); si alguna vez tuvo uno, no lo borra —rompería `pedidos.producto_id`, el registro histórico de esa venta— y en su lugar lo pasa a `estado='pausado'` (ya no aparece en el catálogo), devolviendo `{ eliminado: false, mensaje }` para que el admin sepa por qué. El botón "Eliminar" del panel (junto a "Editar") pide confirmación y, si vuelve `eliminado:false`, muestra ese mensaje con un `alert()`.
- Pedidos (operación): `GET /pedidos` (filtros opcionales `estado_pago`, `estado_despacho`, `desde`, `hasta`, `proveedor_id`, `organizacion_id`, `q`), `PATCH /pedidos/:id/marcar-pagado`, `PATCH /pedidos/:id/despacho`, `POST /pedidos/:id/sincronizar-pago` (plan B manual, ver arriba).
- Actividad: `GET /actividad?desde=&hasta=` (ver sección de arriba).
- Reportes/ventas: `GET /reportes/resumen?desde=&hasta=&proveedor_id=&organizacion_id=`, `GET /reportes/pedidos.csv?...` (ver sección de arriba).
- Perfil propio: `GET/PUT /me`, `PUT /me/password`.

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
