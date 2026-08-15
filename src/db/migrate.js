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

// Cambios de schema posteriores al schema.sql original, aplicados de forma
// incremental e idempotente (no rompen si ya existen).
const MIGRACIONES_INCREMENTALES = [
  { tabla: 'proveedores', columna: 'logo_url', definicion: 'logo_url VARCHAR(500) AFTER datos_bancarios' }
];

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

  await connection.end();
  return resultado;
}

module.exports = { runMigration };
