// Aplica schema.sql contra la base conectada. Se usa tanto desde
// scripts/migrate.js (CLI) como desde el arranque del server y desde
// GET /api/bootstrap/migrate (para poder correrlo desde el navegador
// cuando no hay acceso a una terminal ni a Railway CLI).
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Agrega una columna solo si todavía no existe, para poder ir sumando
// cambios de schema chicos a bases que ya corrieron schema.sql alguna vez
// (schema.sql corre como un solo batch y no vuelve a aplicarse una vez que
// la primera tabla ya existe, así que un ALTER nuevo dentro del CREATE TABLE
// original nunca llegaría a una base ya migrada sin esto).
async function ensureColumn(connection, tabla, columna, definicion) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS existe FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tabla, columna]
  );
  if (rows[0].existe > 0) return false;
  await connection.query(`ALTER TABLE ${tabla} ADD COLUMN ${definicion}`);
  return true;
}

// Ensancha una columna (ej. VARCHAR(500) -> LONGTEXT) solo si todavía no
// tiene ese tipo. MODIFY COLUMN es seguro de reintentar, pero chequeamos
// antes para no reescribir la tabla en cada boot una vez que ya se hizo.
async function ensureColumnType(connection, tabla, columna, tipoEsperado, alterSql) {
  const [rows] = await connection.query(
    `SELECT DATA_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tabla, columna]
  );
  if (!rows.length || rows[0].DATA_TYPE === tipoEsperado) return false;
  await connection.query(alterSql);
  return true;
}

// Igual que ensureColumn, pero para tablas nuevas agregadas después de la
// primera corrida de schema.sql (mismo problema: el batch completo se salta
// entero apenas la primera tabla ya existe).
async function ensureTable(connection, tabla, createSql) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS existe FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla]
  );
  if (rows[0].existe > 0) return false;
  await connection.query(createSql);
  return true;
}

// Igual que ensureTable, pero para índices agregados después de la primera
// corrida de schema.sql. CREATE INDEX no es "IF NOT EXISTS" en MySQL/MariaDB
// (a diferencia de CREATE TABLE), así que sin este chequeo reintentar la
// migración en una base ya migrada tiraría error de índice duplicado.
async function ensureIndex(connection, tabla, indice, definicionColumnas) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS existe FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [tabla, indice]
  );
  if (rows[0].existe > 0) return false;
  await connection.query(`CREATE INDEX ${indice} ON ${tabla} (${definicionColumnas})`);
  return true;
}

// Cambios de schema posteriores al schema.sql original, aplicados de forma
// incremental e idempotente (no rompen si ya existen).
const MIGRACIONES_INCREMENTALES = [
  { tabla: 'proveedores', columna: 'logo_url', definicion: 'logo_url VARCHAR(500) AFTER datos_bancarios' },
  { tabla: 'pedidos', columna: 'notificaciones_enviadas_at', definicion: 'notificaciones_enviadas_at TIMESTAMP NULL AFTER direccion_envio' },
  { tabla: 'productos', columna: 'regiones_disponibles', definicion: 'regiones_disponibles JSON AFTER estado' }
];

// Las columnas de imagen partieron como VARCHAR(500) (pensadas para URLs) y
// ahora también guardan imágenes subidas como data: URI en base64, que no
// entran en 500 caracteres ni de cerca.
const TIPOS_INCREMENTALES = [
  {
    tabla: 'proveedores', columna: 'logo_url', tipoEsperado: 'longtext',
    alterSql: 'ALTER TABLE proveedores MODIFY COLUMN logo_url LONGTEXT'
  },
  {
    tabla: 'productos', columna: 'imagen_principal', tipoEsperado: 'longtext',
    alterSql: 'ALTER TABLE productos MODIFY COLUMN imagen_principal LONGTEXT'
  }
];

const TABLAS_INCREMENTALES = [
  {
    tabla: 'contenido_sitio',
    createSql: `
      CREATE TABLE contenido_sitio (
        clave VARCHAR(60) PRIMARY KEY,
        valor JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `
  },
  {
    tabla: 'eventos_actividad',
    createSql: `
      CREATE TABLE eventos_actividad (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tipo ENUM('vista_producto','agregar_carrito','inicio_checkout','compra_completada') NOT NULL,
        producto_id INT NULL,
        organizacion_id INT NULL,
        session_id VARCHAR(64) NOT NULL,
        pedido_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (producto_id) REFERENCES productos(id),
        FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id),
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
      )
    `
  }
];

// Índices agregados después de la primera corrida de schema.sql (mismo
// motivo que TABLAS_INCREMENTALES: una base ya migrada nunca vuelve a
// correr el CREATE INDEX que está al final de schema.sql).
const INDICES_INCREMENTALES = [
  { tabla: 'eventos_actividad', indice: 'idx_eventos_session', columnas: 'session_id' },
  { tabla: 'eventos_actividad', indice: 'idx_eventos_tipo_fecha', columnas: 'tipo, created_at' }
];

// Valores por defecto de contenido_sitio: son los textos/imágenes que ya
// están escritos a mano en el HTML público. Se insertan con INSERT IGNORE
// (nunca pisan una fila que el admin ya haya editado) para que el sitio no
// dependa de que alguien entre al panel a cargar esto antes de poder mostrar
// algo razonable.
const CONTENIDO_DEFAULT = {
  header: {
    logo_url: '',
    mensaje_franja_izquierda: 'Cada compra fortalece una organización y mejora la vida de más personas.',
    mensaje_franja_derecha: 'Juntos hacemos comunidad',
    // Si el logo subido ya trae el texto "Huayca / Conectamos comunidades"
    // dibujado adentro, este flag permite ocultar el texto duplicado que el
    // header pinta al lado del <img>. Default true para no cambiarle el
    // comportamiento a nadie que ya tenga un logo solo-ícono.
    mostrar_texto_junto_logo: true
  },
  // El hero es un carrusel de 3 slides completos (imagen + título + subtítulo
  // + texto + botón + badge, todo junto). Solo el primero viene con el texto
  // por defecto que ya estaba escrito a mano en el HTML: los otros dos
  // arrancan vacíos, así que el frontend los filtra como "sin contenido
  // real" y el hero se muestra fijo (sin flechas/puntos) hasta que Cristian
  // cargue los otros dos desde el panel. Ver migrarHeroASlides() para la
  // conversión del shape viejo (título/imagenes sueltas) al nuevo.
  hero: {
    slides: [
      {
        imagen_url: '',
        titulo: 'Tecnología con propósito,',
        subtitulo_destacado: 'oportunidades que transforman.',
        texto_descriptivo: 'Compra productos útiles y de calidad mientras apoyas a organizaciones que construyen un mejor futuro.',
        texto_boton: 'Conoce cómo funciona',
        link_boton: '#como-funciona',
        badge_texto: 'CATÁLOGO REFERENCIAL 2026'
      },
      { imagen_url: '', titulo: '', subtitulo_destacado: '', texto_descriptivo: '', texto_boton: '', link_boton: '', badge_texto: '' },
      { imagen_url: '', titulo: '', subtitulo_destacado: '', texto_descriptivo: '', texto_boton: '', link_boton: '', badge_texto: '' }
    ]
  },
  organizaciones_cards: {
    tarjetas: [
      { titulo: 'COLEGIOS', texto: 'Más recursos para educar y crecer.', imagen_url: '', color: 'verde' },
      { titulo: 'JUNTAS DE VECINOS', texto: 'Unidos logramos más para todos.', imagen_url: '', color: 'naranjo' },
      { titulo: 'CLUBES Y DEPORTES', texto: 'Apoyamos tu pasión, impulsamos talentos.', imagen_url: '', color: 'azul' },
      { titulo: 'ORGANIZACIONES SOCIALES', texto: 'Juntos generamos impacto y bienestar.', imagen_url: '', color: 'verde' }
    ]
  },
  banner_apoya: {
    titulo: 'Apoya a tu organización favorita',
    texto: 'Al comprar en Huayca, parte de tu compra va directo a la organización que elijas.',
    boton_texto: 'Buscar organización',
    boton_link: 'organizaciones.html',
    imagen_url: ''
  },
  como_funciona: {
    pasos: [
      { numero: '01', titulo: 'Elige una organización' },
      { numero: '02', titulo: 'Selecciona productos' },
      { numero: '03', titulo: 'Comparte y compra' },
      { numero: '04', titulo: 'La organización recibe su comisión' }
    ],
    frase_destacada: 'Tú compras. Tu comunidad crece.'
  },
  footer: {
    tagline: 'Conectamos comunidades.',
    descripcion: 'Tecnología, bienestar y oportunidades que transforman comunidades.',
    redes_sociales: { instagram: '', facebook: '', tiktok: '', youtube: '' }
  }
};

// Migra la clave 'hero' vieja (título/subtítulo/texto/botón/badge fijos +
// un array de imágenes sueltas que rotaban solas) al nuevo shape de
// carrusel completo ({ slides: [...] }), donde cada slide trae su propia
// imagen y su propio texto. Corre antes de seedContenidoDefault a
// propósito: como el seed usa INSERT IGNORE, una fila 'hero' ya existente
// (shape viejo o nuevo) nunca la toca, así que la conversión in-place
// tiene que pasar acá. Idempotente: si la fila ya está en el shape nuevo
// (tiene 'slides'), no hace nada; si no hay fila todavía, tampoco (el seed
// de abajo se encarga de crearla con el default ya en shape nuevo).
async function migrarHeroASlides(connection) {
  const [rows] = await connection.query('SELECT valor FROM contenido_sitio WHERE clave = ?', ['hero']);
  if (!rows.length) return false;

  let valor;
  try {
    valor = typeof rows[0].valor === 'string' ? JSON.parse(rows[0].valor) : rows[0].valor;
  } catch (e) {
    return false; // valor corrupto: mejor no tocarlo que romper el arranque
  }
  if (!valor || Array.isArray(valor.slides)) return false; // ya migrado, o vacío

  // Las imágenes viejas podían ser tanto URLs/data-URIs reales (si Cristian
  // ya había subido fotos) como los emojis placeholder del default original
  // (⌚📍🔒...). En ambos casos se copian tal cual al imagen_url del slide:
  // el frontend ya sabe mostrar un placeholder si el valor no es una imagen
  // válida (ver esUrl en construirSlidesHeroFull, public/js/huayca.js).
  const imagenesViejas = Array.isArray(valor.imagenes) ? valor.imagenes.filter(Boolean) : [];
  const slides = [0, 1, 2].map((i) => ({
    imagen_url: imagenesViejas[i] || '',
    titulo: valor.titulo || '',
    subtitulo_destacado: valor.subtitulo_destacado || '',
    texto_descriptivo: valor.texto_descriptivo || '',
    texto_boton: valor.texto_boton || '',
    link_boton: valor.link_boton || '',
    badge_texto: valor.badge_texto || ''
  }));

  await connection.query('UPDATE contenido_sitio SET valor = ? WHERE clave = ?', [JSON.stringify({ slides }), 'hero']);
  return true;
}

async function seedContenidoDefault(connection) {
  const claves = [];
  for (const [clave, valor] of Object.entries(CONTENIDO_DEFAULT)) {
    const [result] = await connection.query(
      'INSERT IGNORE INTO contenido_sitio (clave, valor) VALUES (?, ?)',
      [clave, JSON.stringify(valor)]
    );
    if (result.affectedRows > 0) claves.push(clave);
  }
  return claves;
}

async function runMigration() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST,
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.DB_USER,
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.DB_NAME,
    multipleStatements: true
  });

  const schemaPath = path.join(__dirname, '..', '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  let resultado;
  try {
    await connection.query(sql);
    resultado = { ok: true, mensaje: 'Schema aplicado correctamente' };
  } catch (err) {
    if (err.code === 'ER_TABLE_EXISTS_ERROR') {
      // schema.sql corre como un solo batch: si la primera tabla ya existe,
      // asumimos que el schema ya estaba aplicado de una corrida anterior.
      resultado = { ok: true, mensaje: 'El schema ya estaba aplicado (se omitió)', omitido: true };
    } else {
      await connection.end();
      throw err;
    }
  }

  const columnasAgregadas = [];
  for (const m of MIGRACIONES_INCREMENTALES) {
    const agregada = await ensureColumn(connection, m.tabla, m.columna, m.definicion);
    if (agregada) columnasAgregadas.push(`${m.tabla}.${m.columna}`);
  }
  if (columnasAgregadas.length) {
    resultado.mensaje += ` (columnas agregadas: ${columnasAgregadas.join(', ')})`;
  }

  const tiposAmpliados = [];
  for (const t of TIPOS_INCREMENTALES) {
    const ampliada = await ensureColumnType(connection, t.tabla, t.columna, t.tipoEsperado, t.alterSql);
    if (ampliada) tiposAmpliados.push(`${t.tabla}.${t.columna}`);
  }
  if (tiposAmpliados.length) {
    resultado.mensaje += ` (columnas ampliadas: ${tiposAmpliados.join(', ')})`;
  }

  const tablasAgregadas = [];
  for (const t of TABLAS_INCREMENTALES) {
    const agregada = await ensureTable(connection, t.tabla, t.createSql);
    if (agregada) tablasAgregadas.push(t.tabla);
  }
  if (tablasAgregadas.length) {
    resultado.mensaje += ` (tablas agregadas: ${tablasAgregadas.join(', ')})`;
  }

  const indicesAgregados = [];
  for (const i of INDICES_INCREMENTALES) {
    const agregado = await ensureIndex(connection, i.tabla, i.indice, i.columnas);
    if (agregado) indicesAgregados.push(i.indice);
  }
  if (indicesAgregados.length) {
    resultado.mensaje += ` (índices agregados: ${indicesAgregados.join(', ')})`;
  }

  const heroMigrado = await migrarHeroASlides(connection);
  if (heroMigrado) {
    resultado.mensaje += ' (hero migrado al shape de carrusel de slides)';
  }

  const clavesSeedeadas = await seedContenidoDefault(connection);
  if (clavesSeedeadas.length) {
    resultado.mensaje += ` (contenido_sitio seedeado: ${clavesSeedeadas.join(', ')})`;
  }

  await connection.end();
  return resultado;
}

module.exports = { runMigration };
