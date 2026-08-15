const jwt = require('jsonwebtoken');

function requireAuth(rolesPermitidos = []) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }
    const token = header.split(' ')[1];
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (rolesPermitidos.length && !rolesPermitidos.includes(payload.tipo)) {
        return res.status(403).json({ error: 'No autorizado para este recurso' });
      }
      req.user = payload; // { id, tipo: 'organizacion' | 'admin', ... }
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
  };
}

module.exports = { requireAuth };
