/* =========================================================
   HUAYCA — helpers compartidos por todas las páginas públicas
   ========================================================= */

const Huayca = (() => {
  const BASE_URL = window.location.origin;
  const ORG_KEY = 'huayca_org_activa';       // slug de la organización atribuida al link
  const ORG_DATA_KEY = 'huayca_org_activa_datos'; // cache liviana {nombre, logo_url}
  const ORG_TOKEN_KEY = 'huayca_org_token';
  const ORG_SESION_KEY = 'huayca_org_sesion';

  // ---------- Fetch a la API ----------
  async function apiFetch(path, options = {}) {
    const res = await fetch(BASE_URL + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* respuesta sin body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- Formato ----------
  function formatoCLP(monto) {
    const n = Number(monto) || 0;
    return '$' + n.toLocaleString('es-CL');
  }

  function formatoFecha(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ---------- Atribución de organización (link compartible) ----------
  // La atribución real la resuelve el backend en POST /api/pedidos a partir
  // del slug que se envía en ese momento. Acá solo la recordamos mientras el
  // visitante navega, para no perderla entre el catálogo, la ficha y el
  // checkout, y para mostrar el banner de "estás comprando a través de...".
  function capturarOrgDeURL() {
    const params = new URLSearchParams(window.location.search);
    const org = params.get('org');
    if (org) localStorage.setItem(ORG_KEY, org);
  }

  function getOrgActivaSlug() {
    return localStorage.getItem(ORG_KEY) || '';
  }

  function limpiarOrgActiva() {
    localStorage.removeItem(ORG_KEY);
    localStorage.removeItem(ORG_DATA_KEY);
  }

  async function getOrgActivaDatos() {
    const slug = getOrgActivaSlug();
    if (!slug) return null;
    const cache = localStorage.getItem(ORG_DATA_KEY);
    if (cache) {
      try { return JSON.parse(cache); } catch (e) { /* cache corrupta, se re-descarga abajo */ }
    }
    try {
      const org = await apiFetch('/api/organizaciones/' + encodeURIComponent(slug));
      localStorage.setItem(ORG_DATA_KEY, JSON.stringify(org));
      return org;
    } catch (e) {
      // Slug inválido o la organización ya no está aprobada: se limpia para
      // no seguir arrastrando un link roto (el backend igual trataría la
      // compra como venta directa, pero es mejor no mostrar un banner falso).
      limpiarOrgActiva();
      return null;
    }
  }

  // Pinta el banner "estás comprando a través de..." dentro del elemento con
  // el id dado, si hay una organización activa válida. Si no hay, lo oculta.
  async function pintarBannerOrg(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return null;
    const org = await getOrgActivaDatos();
    if (!org) { el.classList.add('hidden'); return null; }
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="logo-org">${org.logo_url ? `<img src="${org.logo_url}" alt="${org.nombre}">` : '🤝'}</div>
      <p>Estás comprando a través de <b>${org.nombre}</b> — tu compra la ayuda directamente.</p>
    `;
    return org;
  }

  // ---------- Sesión de organización (dashboard) ----------
  function guardarSesionOrg(token, organizacion) {
    localStorage.setItem(ORG_TOKEN_KEY, token);
    localStorage.setItem(ORG_SESION_KEY, JSON.stringify(organizacion));
  }
  function getTokenOrg() { return localStorage.getItem(ORG_TOKEN_KEY) || ''; }
  function getSesionOrg() {
    try { return JSON.parse(localStorage.getItem(ORG_SESION_KEY)); } catch (e) { return null; }
  }
  function cerrarSesionOrg() {
    localStorage.removeItem(ORG_TOKEN_KEY);
    localStorage.removeItem(ORG_SESION_KEY);
  }

  // ---------- Ícono placeholder de producto ----------
  // No hay fotos reales todavía: usamos un ícono limpio según palabras clave
  // del nombre/categoría en vez de fotos de stock genéricas.
  const ICONOS = [
    { match: /gps|rastre|satelital/i, icono: '📍' },
    { match: /alarma|seguridad|camara|cámara/i, icono: '🔒' },
    { match: /reloj|smartwatch/i, icono: '⌚' },
    { match: /enchufe|foco|luz|led/i, icono: '💡' },
    { match: /salud|medic/i, icono: '🩺' },
    { match: /hogar/i, icono: '🏠' },
    { match: /educaci|escolar/i, icono: '🎓' },
    { match: /movilidad|auto|vehic/i, icono: '🚗' }
  ];
  function iconoProducto(producto) {
    const texto = `${producto?.nombre || ''} ${producto?.categoria_nombre || ''}`;
    const encontrado = ICONOS.find((i) => i.match.test(texto));
    return encontrado ? encontrado.icono : '📦';
  }

  // ---------- Header: buscador + menú móvil ----------
  function inicializarHeader() {
    const form = document.getElementById('buscadorHeaderForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = document.getElementById('buscadorHeaderInput').value.trim();
        window.location.href = 'catalogo.html' + (q ? '?q=' + encodeURIComponent(q) : '');
      });
    }
    const toggle = document.getElementById('menuToggle');
    const cats = document.querySelector('.categorias-bar .container');
    if (toggle && cats) {
      toggle.addEventListener('click', () => cats.classList.toggle('hidden'));
    }

    // Estado de sesión de organización en el ícono "Apoya a organizaciones"
    const accionOrg = document.getElementById('navAccionOrg');
    if (accionOrg && getTokenOrg()) {
      accionOrg.href = 'organizacion-dashboard.html';
      const txt = accionOrg.querySelector('small');
      if (txt) txt.textContent = 'Mi organización';
    }
  }

  // Se ejecuta en cuanto se carga el script en cualquier página
  capturarOrgDeURL();

  return {
    BASE_URL, apiFetch, formatoCLP, formatoFecha,
    getOrgActivaSlug, getOrgActivaDatos, limpiarOrgActiva, pintarBannerOrg,
    guardarSesionOrg, getTokenOrg, getSesionOrg, cerrarSesionOrg,
    iconoProducto, inicializarHeader
  };
})();

document.addEventListener('DOMContentLoaded', () => Huayca.inicializarHeader());
