const express = require('express');
const router = express.Router();
const db = require('../config/db');

// POST /api/codigos-descuento/validar  Body: { codigo, producto_id }
// Público, sin auth — el checkout lo llama apenas el cliente escribe un
// código y clickea "Aplicar". Nunca devuelve el desglose interno del
// producto (comisiones, precio_proveedor_promo, etc.): solo si el código
// sirve para ESE producto y, si sirve, el precio_final_promo a mostrar —
// mismo nivel de privacidad que ya tiene el resto del catálogo público.
// No bloquea nada por sí solo: un código inválido/inactivo responde
// valido:false con un mensaje, y el checkout sigue su curso normal sin el
// descuento (la compra en sí no depende de este endpoint, POST /api/pedidos
// vuelve a validar todo del lado del servidor antes de congelar montos).
router.post('/validar', async (req, res) => {
  try {
    const { producto_id } = req.body;
    const codigo = (req.body.codigo || '').trim().toUpperCase();
    if (!codigo || !producto_id) {
      return res.status(400).json({ valido: false, error: 'Faltan codigo y/o producto_id' });
    }

    const [codigos] = await db.query('SELECT activo FROM codigos_descuento WHERE codigo = ?', [codigo]);
    if (!codigos.length || !codigos[0].activo) {
      return res.json({ valido: false, error: 'Ese código no existe o ya no está activo.' });
    }

    const [productos] = await db.query(
      `SELECT acepta_codigo_descuento, precio_final_promo FROM productos
       WHERE id = ? AND estado = 'activo'`,
      [producto_id]
    );
    if (!productos.length) {
      return res.json({ valido: false, error: 'Producto no disponible.' });
    }
    const producto = productos[0];
    if (!producto.acepta_codigo_descuento) {
      return res.json({ valido: false, error: 'Este producto no acepta códigos de descuento.' });
    }
    if (producto.precio_final_promo == null) {
      // acepta_codigo_descuento=true pero el desglose promo quedó
      // incompleto (algún campo _promo en null) — no debería pasar si el
      // admin llenó el formulario entero, pero se cubre por las dudas.
      return res.json({ valido: false, error: 'Este producto todavía no tiene un precio con descuento configurado.' });
    }

    res.json({ valido: true, precio_final_promo: producto.precio_final_promo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valido: false, error: 'Error al validar el código' });
  }
});

module.exports = router;
