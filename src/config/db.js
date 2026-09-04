const mysql = require('mysql2/promise');

// Railway inyecta estas variables automáticamente al conectar
// el plugin de MySQL al servicio. En local, usa tu .env
const pool = mysql.createPool({
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Sin esto, una columna DATE (ej. productos.destacado_hasta, la única
  // que hay en todo el schema) vuelve del driver como un JS Date a
  // medianoche LOCAL — al pasar por JSON.stringify() se convierte a ISO en
  // UTC, y en cualquier servidor con timezone detrás de UTC eso corre la
  // fecha un día para atrás. Acotado a 'DATE' a propósito: no toca cómo se
  // devuelven las columnas TIMESTAMP (created_at, updated_at, etc.), que
  // el resto del código ya asume que llegan como Date/ISO.
  dateStrings: ['DATE']
});

module.exports = pool;
