// Uso: npm run migrate
require('dotenv').config();
const { runMigration } = require('../src/db/migrate');

runMigration()
  .then((r) => {
    console.log(r.mensaje);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error al migrar:', err.message);
    process.exit(1);
  });
