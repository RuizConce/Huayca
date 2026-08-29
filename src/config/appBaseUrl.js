// APP_BASE_URL normalizada: sin barra(s) al final.
//
// BUG DE RAÍZ ENCONTRADO (pedidos HUY-000006 al 000012 nunca disparaban
// el webhook solos): en Railway, APP_BASE_URL estaba guardada con una
// barra final ("https://.../app/"). Cada lugar del código que armaba una
// URL concatenaba `${APP_BASE_URL}/algo` a mano, así que el resultado
// terminaba con doble barra ("https://.../app//api/pagos/webhook").
// Mercado Pago guardó y mandó esa URL tal cual, con la doble barra
// intacta — y Express no matchea "//api/pagos/webhook" contra la ruta
// registrada "/api/pagos/webhook", así que esas notificaciones nunca
// llegaban a tocar el handler (por eso el logging incondicional que se
// había agregado adentro del handler nunca se disparaba: la request ni
// siquiera entraba a esa función, quedaba en un 404 de Express antes).
// La misma doble barra aparecía en las back_urls (pago-resultado.html),
// que "funcionaban" solo porque los navegadores son más permisivos con
// rutas GET que el matching de rutas server-side de Express.
//
// Se normaliza UNA SOLA VEZ acá (no en cada lugar que arma una URL) para
// que sea imposible que un lugar nuevo del código repita el mismo bug:
// cualquier `${APP_BASE_URL}/lo-que-sea` a partir de este módulo ya sale
// bien formado, sin importar cómo esté escrita la variable de entorno en
// Railway (con o sin barra final, una o varias).
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

module.exports = APP_BASE_URL;
