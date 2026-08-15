// Aplica schema.sql contra la base conectada. Se usa tanto desde
// scripts/migrate.js (CLI) como desde el arranque del server y desde
// GET /api/bootstrap/migrate (para poder correrlo desde el navegador
// cuando no hay acceso a una terminal ni a Railway CLI).
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

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

  try {
    await connection.query(sql);
    return { ok: true, mensaje: 'Schema aplicado correctamente' };
  } catch (err) {
    if (err.code === 'ER_TABLE_EXISTS_ERROR') {
      // schema.sql corre como un solo batch: si la primera tabla ya existe,
      // asumimos que el schema ya estaba aplicado de una corrida anterior.
      return { ok: true, mensaje: 'El schema ya estaba aplicado (se omitió)', omitido: true };
    }
    throw err;
  } finally {
    await connection.end();
  }
}

module.exports = { runMigration };
