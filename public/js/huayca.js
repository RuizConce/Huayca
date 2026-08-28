/* =========================================================
   HUAYCA — helpers compartidos por todas las páginas públicas
   ========================================================= */

const Huayca = (() => {
  const BASE_URL = window.location.origin;
  const ORG_KEY = 'huayca_org_activa';       // slug de la organización atribuida al link
  const ORG_DATA_KEY = 'huayca_org_activa_datos'; // cache liviana {nombre, logo_url}
  const ORG_TOKEN_KEY = 'huayca_org_token';
  const ORG_SESION_KEY = 'huayca_org_sesion';
  const SESSION_ID_KEY = 'huayca_session_id'; // ver trackEvento() más abajo

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

  // ---------- Tracking del embudo de conversión ----------
  // session_id identifica una visita (no una cuenta): se genera una vez y
  // se guarda en sessionStorage, así que sobrevive mientras el visitante
  // navega entre producto → checkout → confirmación, pero no entre visitas
  // distintas (a propósito: sessionStorage, no localStorage).
  function getSessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_ID_KEY);
      if (!id) {
        id = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(SESSION_ID_KEY, id);
      }
      return id;
    } catch (e) {
      // sessionStorage puede tirar en navegadores con storage bloqueado
      // (modo privado estricto, cookies de terceros deshabilitadas, etc.):
      // un id que no persiste entre llamadas sigue siendo mejor que romper
      // la página por esto.
      return `sin-storage-${Date.now()}`;
    }
  }

  // Dispara un evento del embudo (vista_producto / agregar_carrito /
  // inicio_checkout / compra_completada) hacia POST /api/eventos. Es
  // "fire and forget" real: no se espera ni se propaga ningún error — el
  // tracking nunca debe condicionar ni demorar el flujo de compra.
  function trackEvento(tipo, datos = {}) {
    try {
      fetch(BASE_URL + '/api/eventos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo, session_id: getSessionId(), ...datos })
      }).catch(() => { /* best-effort: una notificación que no llega no debe verse */ });
    } catch (e) { /* idem, por si fetch ni siquiera existe/está permitido */ }
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
          const original = el.innerHTML; // el ícono "H" por defecto, para volver a él si la imagen falla
          const claseOriginal = el.className;
          const img = document.createElement('img');
          img.alt = 'Huayca';
          // El onerror se engancha ANTES de asignar src, para no perder el
          // evento si la carga falla de inmediato (ej. data: URI inválido).
          img.onerror = () => {
            console.error('[Huayca] El logo configurado no se pudo cargar; se mantiene el ícono por defecto.');
            el.innerHTML = original;
            el.className = claseOriginal;
          };
          img.src = h.logo_url;
          el.innerHTML = '';
          el.appendChild(img);
          // .con-imagen deja el contenedor de 40x40 fijo y pasa a acomodar
          // la proporción real del logo (object-fit:contain) — un logo
          // horizontal tipo wordmark o uno cuadrado tipo ícono de app se
          // ven completos, sin recortarse. Ver css/huayca.css.
          el.className = claseOriginal + ' con-imagen';
        });
      }
      // Si el logo ya trae el texto "Huayca" dibujado adentro, se oculta el
      // texto que el header pinta al lado para no duplicarlo. Solo se
      // esconde con === false explícito: si el campo no vino (contenido
      // viejo, sin migrar) se sigue mostrando, igual que antes.
      document.querySelectorAll('.logo-texto').forEach((el) => {
        el.style.display = (h.mostrar_texto_junto_logo === false) ? 'none' : '';
      });
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
  // Autoplay (5.5s — un poco más lento que un carrusel de solo-imágenes,
  // porque acá hay texto que leer) + flechas + puntos + swipe táctil. Con 0
  // o 1 slide con contenido real no hay controles: se muestra fijo (ver
  // construirSlidesHeroFull). Se re-inicializa cada vez que se reconstruyen
  // los slides (init de la página con el fallback del HTML, y de nuevo
  // cuando /api/contenido trae los slides propios).
  let heroCarruselIntervalId = null;

  function iniciarCarruselHero() {
    const carrusel = document.getElementById('heroCarrusel');
    const track = document.getElementById('heroCarruselTrack');
    if (!carrusel || !track) return;

    if (heroCarruselIntervalId) {
      clearInterval(heroCarruselIntervalId);
      heroCarruselIntervalId = null;
    }

    const slides = track.querySelectorAll('.hero-slide-full');
    const total = slides.length;
    const multiple = total > 1;
    carrusel.classList.toggle('un-solo', !multiple);

    const dotsCont = document.getElementById('heroCarruselDots');
    if (dotsCont) {
      dotsCont.innerHTML = multiple
        ? Array.from({ length: total }, (_, i) => `<button type="button" data-i="${i}" aria-label="Ir al slide ${i + 1}"></button>`).join('')
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

    if (!multiple) return; // nada que autoavanzar/deslizar con 0 o 1 slide

    function reiniciarAutoplay() {
      if (heroCarruselIntervalId) clearInterval(heroCarruselIntervalId);
      heroCarruselIntervalId = setInterval(() => irA(indice + 1), 5500);
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

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Reconstruye el hero COMPLETO (imagen + eyebrow + título + subtítulo +
  // texto + botón + badge) a partir de hero.slides — cada slide es un
  // bloque independiente, no solo una imagen. Un slide "sin contenido real"
  // (todos los campos vacíos) se descarta antes de pintar: así, mientras
  // Cristian solo haya cargado el slide 1, el hero queda fijo (sin
  // flechas/puntos) en vez de mostrar 2 slides en blanco. Si terminan
  // descartándose los 3 (o vino un array vacío), no se toca nada: se deja
  // el fallback ya escrito en el HTML, siguiendo el mismo principio de
  // "nunca romper el sitio" que el resto de este módulo.
  function construirSlidesHeroFull(slides) {
    const track = document.getElementById('heroCarruselTrack');
    if (!track) return;
    const lista = (slides || []).filter((s) => s && Object.values(s).some((v) => v && String(v).trim()));
    if (!lista.length) return;

    track.innerHTML = lista.map((s) => {
      const titulo = s.titulo || '';
      const destacado = s.subtitulo_destacado || '';
      const desc = s.texto_descriptivo || '';
      const textoBoton = s.texto_boton || '';
      const linkBoton = s.link_boton || '#como-funciona';
      const badge = s.badge_texto || '';
      const img = s.imagen_url || '';
      const esUrl = /^https?:\/\//.test(img) || img.startsWith('/') || img.startsWith('data:image/');
      const visual = esUrl
        ? `<img src="${escapeHtml(img)}" alt="">`
        : `<span class="hero-slide-icono">🖼️</span>`;
      return `
        <div class="hero-slide-full">
          <div class="container">
            <div>
              <div class="hero-eyebrow">HUAYCA MARKETPLACE</div>
              <h1>${titulo ? `<span>${escapeHtml(titulo)}</span>` : ''}${titulo && destacado ? '<br>' : ''}${destacado ? `<span class="destaque cursiva">${escapeHtml(destacado)}</span>` : ''}</h1>
              ${desc ? `<p class="hero-sub">${escapeHtml(desc)}</p>` : ''}
              ${textoBoton ? `<a href="${escapeHtml(linkBoton)}" class="btn btn-navy">${escapeHtml(textoBoton)} →</a>` : ''}
            </div>
            <div class="hero-visual">
              ${badge ? `<div class="hero-tag">${escapeHtml(badge)}</div>` : ''}
              <div class="hero-visual-shape"></div>
              <div class="hero-visual-imagen">${visual}</div>
            </div>
          </div>
        </div>`;
    }).join('');

    // Si alguna foto falla al cargar, cae a un ícono en vez de dejar el
    // recuadro roto.
    track.querySelectorAll('.hero-visual-imagen img').forEach((imgEl) => {
      imgEl.onerror = () => {
        console.error('[Huayca] Una imagen del hero no se pudo cargar.');
        const span = document.createElement('span');
        span.className = 'hero-slide-icono';
        span.textContent = '🖼️';
        imgEl.replaceWith(span);
      };
    });

    iniciarCarruselHero();
  }

  // Hero, tarjetas de tipo de organización, banner "apoya a tu organización"
  // y "cómo funciona": solo existen en index.html. Se llama automáticamente
  // (ver DOMContentLoaded al final) cuando el DOM tiene #heroTitulo, así que
  // el resto de páginas no paga ningún costo ni necesita llamarla a mano.
  function aplicarContenidoHome(contenido) {
    if (!contenido) return;

    const hero = contenido.hero;
    // Solo actúa si vino en el shape nuevo ({ slides: [...] }) — un
    // contenido.hero en el shape viejo (de antes de la migración a
    // carrusel completo) no debería llegar nunca desde un backend ya
    // migrado, pero por las dudas se ignora en vez de romper el hero.
    if (hero && Array.isArray(hero.slides)) construirSlidesHeroFull(hero.slides);

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
        const original = visual.innerHTML; // el ícono 🤝 por defecto
        const img = document.createElement('img');
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;';
        img.onerror = () => {
          console.error('[Huayca] La imagen del banner no se pudo cargar; se mantiene el ícono por defecto.');
          visual.innerHTML = original;
        };
        img.src = banner.imagen_url;
        visual.innerHTML = '';
        visual.appendChild(img);
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
    cargarContenidoSitio, aplicarHeaderFooter, aplicarContenidoHome, iniciarCarruselHero,
    trackEvento
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
