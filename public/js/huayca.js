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

  // ---------- Contenido editable del sitio (CMS liviano) ----------
  // GET /api/contenido se llama una sola vez por carga de página (memoizado
  // en esta promesa) y nunca debe tumbar el sitio: si falla, se resuelve a
  // null y los que llaman aplicarHeaderFooter/aplicarContenidoHome
  // simplemente dejan el HTML tal como está (el fallback ya escrito a mano).
  let contenidoSitioPromise = null;
  function cargarContenidoSitio() {
    if (!contenidoSitioPromise) {
      contenidoSitioPromise = apiFetch('/api/contenido').catch(() => null);
    }
    return contenidoSitioPromise;
  }

  // Franja superior, logo y footer (tagline + redes): presentes en todas las
  // páginas públicas. Cada campo se pisa solo si vino con contenido; si el
  // fetch falló o una clave/campo no vino, el HTML por defecto queda intacto.
  function aplicarHeaderFooter(contenido) {
    if (!contenido) return;

    const h = contenido.header;
    if (h) {
      const izq = document.getElementById('franjaIzq');
      const der = document.getElementById('franjaDer');
      if (izq && h.mensaje_franja_izquierda) izq.textContent = '💚 ' + h.mensaje_franja_izquierda;
      if (der && h.mensaje_franja_derecha) der.textContent = h.mensaje_franja_derecha;
      if (h.logo_url) {
        document.querySelectorAll('.logo-mark').forEach((el) => {
          el.innerHTML = `<img src="${h.logo_url}" alt="Huayca" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
        });
      }
    }

    const f = contenido.footer;
    if (f) {
      const tagline = document.getElementById('footerTagline');
      if (tagline && (f.tagline || f.descripcion)) {
        tagline.textContent = [f.tagline, f.descripcion].filter(Boolean).join(' ');
      }
      const social = document.getElementById('footerSocial');
      if (social && f.redes_sociales) {
        const ICONOS_RED = { instagram: '📷', facebook: '📘', tiktok: '🎵', youtube: '▶️' };
        social.innerHTML = Object.keys(ICONOS_RED).map((red) => {
          const url = f.redes_sociales[red];
          const icono = ICONOS_RED[red];
          return url
            ? `<a href="${url}" target="_blank" rel="noopener" style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-size:14px;">${icono}</a>`
            : `<span>${icono}</span>`;
        }).join('');
      }
    }
  }

  // ---------- Carrusel del hero ----------
  // Autoplay (4.5s) + flechas + puntos + swipe táctil. Con 0 o 1 imagen no
  // hay controles: 0 muestra un placeholder fijo, 1 muestra esa sola imagen
  // fija (ver construirSlidesHero). Se re-inicializa cada vez que se
  // reconstruyen los slides (init de la página con el fallback del HTML, y
  // de nuevo si /api/contenido trae imágenes propias).
  let heroCarruselIntervalId = null;

  function iniciarCarruselHero() {
    const carrusel = document.getElementById('heroCarrusel');
    const track = document.getElementById('heroCarruselTrack');
    if (!carrusel || !track) return;

    if (heroCarruselIntervalId) {
      clearInterval(heroCarruselIntervalId);
      heroCarruselIntervalId = null;
    }

    const slides = track.querySelectorAll('.hero-slide');
    const total = slides.length;
    const multiple = total > 1;
    carrusel.classList.toggle('un-solo', !multiple);

    const dotsCont = document.getElementById('heroCarruselDots');
    if (dotsCont) {
      dotsCont.innerHTML = multiple
        ? Array.from({ length: total }, (_, i) => `<button type="button" data-i="${i}" aria-label="Ir a la imagen ${i + 1}"></button>`).join('')
        : '';
    }

    let indice = 0;
    function irA(i) {
      indice = ((i % total) + total) % total;
      track.style.transform = `translateX(-${indice * 100}%)`;
      if (dotsCont) {
        dotsCont.querySelectorAll('button').forEach((b, idx) => b.classList.toggle('activo', idx === indice));
      }
    }
    irA(0);

    if (!multiple) return; // nada que autoavanzar/deslizar con 0 o 1 imagen

    function reiniciarAutoplay() {
      if (heroCarruselIntervalId) clearInterval(heroCarruselIntervalId);
      heroCarruselIntervalId = setInterval(() => irA(indice + 1), 4500);
    }

    const flechaIzq = document.getElementById('heroFlechaIzq');
    const flechaDer = document.getElementById('heroFlechaDer');
    if (flechaIzq) flechaIzq.onclick = () => { irA(indice - 1); reiniciarAutoplay(); };
    if (flechaDer) flechaDer.onclick = () => { irA(indice + 1); reiniciarAutoplay(); };
    if (dotsCont) {
      dotsCont.querySelectorAll('button').forEach((b) => {
        b.onclick = () => { irA(Number(b.dataset.i)); reiniciarAutoplay(); };
      });
    }

    // Swipe táctil (móvil)
    let touchStartX = null;
    track.ontouchstart = (e) => { touchStartX = e.touches[0].clientX; };
    track.ontouchend = (e) => {
      if (touchStartX === null) return;
      const delta = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(delta) > 40) irA(indice + (delta < 0 ? 1 : -1));
      touchStartX = null;
      reiniciarAutoplay();
    };

    reiniciarAutoplay();
  }

  // Reconstruye los slides a partir de hero.imagenes (mezcla emoji/texto
  // corto y URLs de imagen indistintamente) y reinicia el carrusel. Un
  // array vacío no deja el hero en blanco: muestra un placeholder limpio.
  function construirSlidesHero(imagenes) {
    const track = document.getElementById('heroCarruselTrack');
    if (!track) return;
    const lista = imagenes.filter(Boolean);
    if (!lista.length) {
      track.innerHTML = '<div class="hero-slide"><span class="hero-slide-icono">🖼️</span></div>';
    } else {
      track.innerHTML = lista.map((img) => {
        const esUrl = /^https?:\/\//.test(img) || img.startsWith('/') || img.startsWith('data:image/');
        return `<div class="hero-slide">${esUrl ? `<img src="${img}" alt="">` : `<span class="hero-slide-icono">${img}</span>`}</div>`;
      }).join('');
    }
    iniciarCarruselHero();
  }

  // Hero, tarjetas de tipo de organización, banner "apoya a tu organización"
  // y "cómo funciona": solo existen en index.html. Se llama automáticamente
  // (ver DOMContentLoaded al final) cuando el DOM tiene #heroTitulo, así que
  // el resto de páginas no paga ningún costo ni necesita llamarla a mano.
  function aplicarContenidoHome(contenido) {
    if (!contenido) return;

    const hero = contenido.hero;
    if (hero) {
      const tp = document.getElementById('heroTituloPrincipal');
      const td = document.getElementById('heroTituloDestacado');
      if (tp && hero.titulo) tp.textContent = hero.titulo;
      if (td && hero.subtitulo_destacado) td.textContent = hero.subtitulo_destacado;
      const sub = document.getElementById('heroDescripcion');
      if (sub && hero.texto_descriptivo) sub.textContent = hero.texto_descriptivo;
      const btn = document.getElementById('heroBoton');
      if (btn) {
        if (hero.texto_boton) btn.textContent = hero.texto_boton + ' →';
        if (hero.link_boton) btn.setAttribute('href', hero.link_boton);
      }
      const badge = document.getElementById('heroBadge');
      if (badge && hero.badge_texto) badge.textContent = hero.badge_texto;
      // hero.imagenes puede venir como array vacío (el admin borró todas las
      // fotos) — es una respuesta válida y distinta de "no vino el campo":
      // ahí sí hay que reemplazar el fallback por el placeholder, por eso se
      // chequea Array.isArray en vez de truthiness del length.
      if (Array.isArray(hero.imagenes)) construirSlidesHero(hero.imagenes);
    }

    const cards = contenido.organizaciones_cards && contenido.organizaciones_cards.tarjetas;
    if (Array.isArray(cards) && cards.length) {
      const COLOR_CLASE = { verde: 'c1', naranjo: 'c2', azul: 'c3' };
      cards.slice(0, 4).forEach((card, i) => {
        const el = document.querySelector(`.orgtipo-card[data-tarjeta="${i}"]`);
        if (!el) return;
        if (card.color && COLOR_CLASE[card.color]) el.className = `orgtipo-card ${COLOR_CLASE[card.color]}`;
        if (card.imagen_url) {
          el.style.backgroundImage = `linear-gradient(180deg, rgba(13,43,78,0.15), rgba(13,43,78,0.55)), url('${card.imagen_url}')`;
          el.style.backgroundSize = 'cover';
          el.style.backgroundPosition = 'center';
        }
        const b = el.querySelector('b');
        const span = el.querySelector('span:last-of-type');
        if (b && card.titulo) b.textContent = card.titulo;
        if (span && card.texto) span.textContent = card.texto;
      });
    }

    const banner = contenido.banner_apoya;
    if (banner) {
      const t = document.getElementById('bannerTitulo');
      const p = document.getElementById('bannerTexto');
      const btn = document.getElementById('bannerBoton');
      const visual = document.getElementById('bannerVisual');
      if (t && banner.titulo) t.textContent = banner.titulo;
      if (p && banner.texto) p.textContent = banner.texto;
      if (btn) {
        if (banner.boton_texto) btn.textContent = banner.boton_texto;
        if (banner.boton_link) btn.setAttribute('href', banner.boton_link);
      }
      if (visual && banner.imagen_url) {
        visual.innerHTML = `<img src="${banner.imagen_url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
      }
    }

    const cf = contenido.como_funciona;
    if (cf) {
      const lista = document.getElementById('pasosLista');
      if (lista && Array.isArray(cf.pasos) && cf.pasos.length) {
        lista.innerHTML = cf.pasos.map((paso) => {
          const num = (paso.numero || '').replace(/^0+/, '') || '•';
          return `<li><span class="num">${num}</span> ${paso.titulo || ''}</li>`;
        }).join('');
      }
      const frase = document.getElementById('fraseDestacada');
      if (frase && cf.frase_destacada) frase.textContent = cf.frase_destacada;
    }
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
    iconoProducto, inicializarHeader,
    cargarContenidoSitio, aplicarHeaderFooter, aplicarContenidoHome, iniciarCarruselHero
  };
})();

document.addEventListener('DOMContentLoaded', async () => {
  Huayca.inicializarHeader();
  // El carrusel del hero arranca ya con el fallback escrito en el HTML, sin
  // esperar la red — si /api/contenido trae fotos propias, se reconstruye.
  Huayca.iniciarCarruselHero();
  const contenido = await Huayca.cargarContenidoSitio();
  Huayca.aplicarHeaderFooter(contenido);
  if (document.getElementById('heroTitulo')) Huayca.aplicarContenidoHome(contenido);
});
