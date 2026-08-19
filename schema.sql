-- =========================================================
-- HUAYCA - Schema de base de datos (MySQL)
-- Marketplace administrado con afiliados/organizaciones,
-- proveedores y comisiones automáticas por pedido.
-- =========================================================

-- -------------------------------------------------
-- PROVEEDORES
-- Empresas que ofrecen productos/servicios en Huayca
-- -------------------------------------------------
CREATE TABLE proveedores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  razon_social VARCHAR(150),
  rut VARCHAR(20),
  email_contacto VARCHAR(150),
  telefono_contacto VARCHAR(30),
  datos_bancarios JSON, -- {banco, tipo_cuenta, numero, titular, rut}
  logo_url LONGTEXT, -- URL o imagen subida como data: URI (ver POST /api/admin/upload-imagen)
  gestiona_despacho BOOLEAN DEFAULT TRUE,
  estado ENUM('activo','inactivo') DEFAULT 'activo',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- -------------------------------------------------
-- CATEGORÍAS DE PRODUCTOS
-- -------------------------------------------------
CREATE TABLE categorias (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  icono VARCHAR(255),
  orden INT DEFAULT 0
);

-- -------------------------------------------------
-- PRODUCTOS
-- Huayca es quien define precio y comisión (no editable
-- por la organización). precio_final se calcula pero se
-- guarda también para no recalcular históricos si cambia
-- el precio base más adelante.
-- -------------------------------------------------
CREATE TABLE productos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proveedor_id INT NOT NULL,
  categoria_id INT,
  nombre VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL UNIQUE,
  descripcion TEXT,
  imagen_principal LONGTEXT, -- URL o imagen subida como data: URI (ver POST /api/admin/upload-imagen)
  imagenes JSON, -- array de URLs adicionales
  precio_proveedor DECIMAL(10,0) NOT NULL,   -- monto que recibe el proveedor
  comision_afiliado DECIMAL(10,0) NOT NULL DEFAULT 0,
  comision_huayca DECIMAL(10,0) NOT NULL DEFAULT 0,
  precio_final DECIMAL(10,0) GENERATED ALWAYS AS
    (precio_proveedor + comision_afiliado + comision_huayca) STORED,
  precio_normal DECIMAL(10,0), -- precio "tachado" de referencia/marketing
  stock INT DEFAULT 0,
  garantia_meses INT DEFAULT 6,
  estado ENUM('borrador','activo','agotado','pausado') DEFAULT 'borrador',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (proveedor_id) REFERENCES proveedores(id),
  FOREIGN KEY (categoria_id) REFERENCES categorias(id)
);

-- -------------------------------------------------
-- ORGANIZACIONES (Afiliados)
-- Se registran, generan perfil y un slug único para
-- compartir productos. Requieren aprobación de Huayca.
-- -------------------------------------------------
CREATE TABLE organizaciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  tipo ENUM('colegio','junta_vecinos','club_deportivo','fundacion','centro_comunitario','otro') DEFAULT 'otro',
  slug VARCHAR(100) NOT NULL UNIQUE, -- usado en el link: huayca.cl/o/{slug}
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  telefono VARCHAR(30),
  region VARCHAR(100),
  comuna VARCHAR(100),
  descripcion_proyecto TEXT, -- para qué usarán los fondos
  datos_bancarios JSON,
  logo_url VARCHAR(500),
  estado ENUM('pendiente','aprobada','rechazada','suspendida') DEFAULT 'pendiente',
  aprobada_por INT NULL, -- admin_id
  aprobada_at TIMESTAMP NULL,
  saldo_disponible DECIMAL(12,0) DEFAULT 0, -- acumulado, informativo (fuente real: comisiones)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- -------------------------------------------------
-- CLIENTES (compradores finales)
-- -------------------------------------------------
CREATE TABLE clientes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  telefono VARCHAR(30),
  rut VARCHAR(20),
  direccion JSON, -- {calle, numero, depto, comuna, region, referencia}
  password_hash VARCHAR(255) NULL, -- null = compra como invitado
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------
-- ADMINISTRADORES (equipo Huayca)
-- -------------------------------------------------
CREATE TABLE administradores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol ENUM('super_admin','operaciones','soporte') DEFAULT 'operaciones',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------
-- PEDIDOS (el corazón del sistema)
-- organizacion_id NULL = venta directa (comisión afiliado
-- queda en comision_huayca, sin "afiliado casa")
-- -------------------------------------------------
CREATE TABLE pedidos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(20) NOT NULL UNIQUE, -- ej: HUY-000125
  cliente_id INT NOT NULL,
  producto_id INT NOT NULL,
  proveedor_id INT NOT NULL,
  organizacion_id INT NULL, -- link usado en la compra, si existe

  -- Congelamos los montos al momento de la compra
  -- (si el producto cambia de precio después, el pedido histórico no cambia)
  monto_proveedor DECIMAL(10,0) NOT NULL,
  monto_comision_afiliado DECIMAL(10,0) NOT NULL DEFAULT 0,
  monto_comision_huayca DECIMAL(10,0) NOT NULL DEFAULT 0,
  monto_total DECIMAL(10,0) NOT NULL,

  cantidad INT DEFAULT 1,

  estado_pago ENUM('pendiente','aprobado','rechazado','reembolsado') DEFAULT 'pendiente',
  estado_despacho ENUM('pendiente','preparando','enviado','entregado','no_aplica') DEFAULT 'pendiente',
  estado_liquidacion ENUM('no_aplica','pendiente','liquidado') DEFAULT 'pendiente',

  direccion_envio JSON,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  FOREIGN KEY (producto_id) REFERENCES productos(id),
  FOREIGN KEY (proveedor_id) REFERENCES proveedores(id),
  FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id)
);

-- -------------------------------------------------
-- PAGOS (integración pasarela, ej. Mercado Pago)
-- -------------------------------------------------
CREATE TABLE pagos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pedido_id INT NOT NULL,
  pasarela VARCHAR(50) DEFAULT 'mercado_pago',
  referencia_externa VARCHAR(150), -- payment_id de MP
  monto DECIMAL(10,0) NOT NULL,
  estado ENUM('pendiente','aprobado','rechazado','reembolsado') DEFAULT 'pendiente',
  metodo_pago VARCHAR(50), -- webpay, tarjeta, transferencia, etc.
  payload_respuesta JSON, -- respuesta cruda de la pasarela para auditoría
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
);

-- -------------------------------------------------
-- COMISIONES
-- Un registro por cada "reparto" de dinero de un pedido
-- (permite reportes y liquidación independientes por tipo)
-- -------------------------------------------------
CREATE TABLE comisiones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pedido_id INT NOT NULL,
  tipo ENUM('afiliado','huayca','proveedor') NOT NULL,
  organizacion_id INT NULL, -- solo si tipo = afiliado
  monto DECIMAL(10,0) NOT NULL,
  estado ENUM('pendiente','solicitada','aprobada','pagada','anulada') DEFAULT 'pendiente',
  liquidacion_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
  FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id)
);

-- -------------------------------------------------
-- LIQUIDACIONES
-- Agrupa comisiones de afiliado (o proveedor) que se
-- gestionan/pagan en un lote. No es retiro automático:
-- la organización solicita, Huayca aprueba y gestiona.
-- -------------------------------------------------
CREATE TABLE liquidaciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organizacion_id INT NULL,
  proveedor_id INT NULL,
  monto_total DECIMAL(12,0) NOT NULL,
  estado ENUM('pendiente','solicitada','aprobada','pagada','rechazada') DEFAULT 'pendiente',
  motivo_solicitud TEXT, -- para qué proyecto se destina (si es afiliado)
  comprobante_url VARCHAR(500),
  solicitada_at TIMESTAMP NULL,
  aprobada_at TIMESTAMP NULL,
  pagada_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id),
  FOREIGN KEY (proveedor_id) REFERENCES proveedores(id)
);

ALTER TABLE comisiones
  ADD CONSTRAINT fk_comisiones_liquidacion
  FOREIGN KEY (liquidacion_id) REFERENCES liquidaciones(id);

-- -------------------------------------------------
-- TICKETS (devoluciones / garantías)
-- El proveedor es responsable según política de Huayca,
-- normativa chilena de protección al consumidor.
-- -------------------------------------------------
CREATE TABLE tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pedido_id INT NOT NULL,
  tipo ENUM('devolucion','garantia','reparacion','reclamo') NOT NULL,
  descripcion TEXT NOT NULL,
  estado ENUM('abierto','en_revision','derivado_proveedor','resuelto','rechazado') DEFAULT 'abierto',
  respuesta TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
);

-- -------------------------------------------------
-- CLICKS / TRACKING de links (opcional, para métricas
-- de conversión por organización, no afecta atribución
-- de la venta que se resuelve directo en el pedido)
-- -------------------------------------------------
CREATE TABLE link_clicks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organizacion_id INT NOT NULL,
  producto_id INT NULL,
  ip VARCHAR(45),
  user_agent VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id),
  FOREIGN KEY (producto_id) REFERENCES productos(id)
);

-- Contenido editable del sitio público (textos/imágenes del home, franjas,
-- footer, etc.) desde el panel de admin. Clave/valor JSON a propósito: así
-- se pueden agregar campos editables nuevos sin tener que migrar el schema
-- cada vez. Ver src/db/migrate.js para los defaults con los que se seedea.
CREATE TABLE contenido_sitio (
  clave VARCHAR(60) PRIMARY KEY,
  valor JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- -------------------------------------------------
-- Índices de apoyo para las consultas más frecuentes
-- -------------------------------------------------
CREATE INDEX idx_pedidos_organizacion ON pedidos(organizacion_id);
CREATE INDEX idx_pedidos_estado_pago ON pedidos(estado_pago);
CREATE INDEX idx_comisiones_organizacion ON comisiones(organizacion_id);
CREATE INDEX idx_comisiones_estado ON comisiones(estado);
CREATE INDEX idx_productos_estado ON productos(estado);
