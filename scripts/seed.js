// Uso: npm run seed
require('dotenv').config();
const { runSeed } = require('../src/db/seed');

runSeed()
  .then((r) => {
    if (r.admin.creado) console.log(`Admin creado: ${r.admin.email} / ${r.admin.password}`);
    else console.log(`Admin ya existía: ${r.admin.email}`);

    for (const p of r.productos) {
      console.log(p.creado ? `Producto creado: ${p.nombre} (slug: ${p.slug})` : `Producto ya existía: ${p.slug}`);
    }

    if (r.organizacion_demo.creado) {
      console.log(`Organización demo creada: ${r.organizacion_demo.email} / ${r.organizacion_demo.password} (link: /o/${r.organizacion_demo.slug})`);
    } else {
      console.log(`Organización demo ya existía: ${r.organizacion_demo.email}`);
    }

    console.log('\nSeed completo. Flujo de prueba sugerido:');
    r.siguiente_paso.forEach((paso, i) => console.log(`${i + 1}. ${paso}`));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error en seed:', err);
    process.exit(1);
  });
