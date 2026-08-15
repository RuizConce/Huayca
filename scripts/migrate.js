// Corre schema.sql contra la base conectada (variables MYSQLHOST/MYSQLUSER/...
// que inyecta Railway, o DB_HOST/DB_USER/... en local). Pensado para correrse
// una vez sobre una base vacía.
//
// Uso:
//   npm run migrate
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST,
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.DB_USER,
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.DB_NAME,
    multipleStatements: true
  });

  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log(`Conectado a ${connection.config.host}:${connection.config.port}/${connection.config.database}`);
  console.log('Ejecutando schema.sql...');

  try {
    await connection.query(sql);
    console.log('Schema aplicado correctamente.');
  } catch (err) {
    if (err.code === 'ER_TABLE_EXISTS_ERROR') {
      console.warn(
        'Alguna tabla ya existía y el script se detuvo ahí (schema.sql corre como un solo batch).\n' +
        'Si quieres recrear todo desde cero, vacía la base primero. Si solo faltan tablas nuevas,\n' +
        'copia manualmente los CREATE TABLE que falten desde schema.sql.'
      );
    } else {
      throw err;
    }
  }

  await connection.end();
}

main().catch((err) => {
  console.error('Error al migrar:', err.message);
  process.exit(1);
});
