// ==UserScript==
// @name         CUSTOM HUB GAME
// @namespace    http://tampermonkey.net/
// @version      4.0.1
// @description  Rediseño responsivo con carga optimizada, tamaños configurables, paneles plegables y Capture Bar persistente.
// @match        *://poke.idleworld.online/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /* Evita duplicar timers, observers y el interceptor de WebSocket si el
       gestor vuelve a inyectar el script dentro del mismo documento. */
    if (window.__customCardUltimateRuntimeActive) return;
    Object.defineProperty(window, '__customCardUltimateRuntimeActive', {
        value: true,
        configurable: true
    });

    let latestPokemonData = null; 
    let teamData = []; 
    let lastRenderKey = ""; 
    
    let domCache = { phudNode: null, hpFill: null, hpText: null, xpFill: null, xpText: null };
    let lastHpWidth = null, lastHpText = null, lastHpClass = null; 
    let lastXpWidth = null, lastXpText = null;
    let lastEventColor = "";
    let lastEventSyncAt = 0;
    const UI_REFRESH_MS = 250;
    const STRUCTURE_REFRESH_MS = 1000;
    const BACKGROUND_REFRESH_MS = 1500;
    const CANVAS_REFRESH_MS = 85;
    const SOCKET_QUEUE_LIMIT = 6;
    const SCRIPT_SCALE_STORAGE = 'custom-card-responsive-scales-v1';
    const SCRIPT_SCALE_OPTIONS = [60, 75, 90, 100, 110, 125, 140];
    const SCRIPT_SCALE_AREAS = Object.freeze([
        { key: 'hud', label: 'Perfil y equipo Pokémon', description: 'Cambia el panel izquierdo del jugador, los Pokémon del equipo y sus barras de HP/XP.', css: '--cc-scale-hud' },
        { key: 'dock', label: 'Dock de navegación', description: 'Cambia los botones superiores o laterales del juego y sus menús desplegables.', css: '--cc-scale-dock' },
        { key: 'battle', label: 'Card de batalla', description: 'Cambia la card del Pokémon aliado, incluyendo estadísticas, poder y barras.', css: '--cc-scale-battle' },
        { key: 'enemy', label: 'Card del enemigo', description: 'Cambia la card, sprite y barra de vida del Pokémon enemigo.', css: '--cc-scale-enemy' },
        { key: 'capture', label: 'Capture Bar', description: 'Cambia el tamaño de la barra inferior de captura, con sus balls, pociones y salvajes.', css: '--cc-scale-capture' },
        { key: 'victory', label: 'Notificación de batalla', description: 'Cambia el aviso de victoria, experiencia obtenida y drops de cada derrota.', css: '--cc-scale-victory' },
        { key: 'events', label: 'Barras de eventos', description: 'Cambia el grupo inferior de eventos activos y sus ventanas informativas.', css: '--cc-scale-events' },
        { key: 'helper', label: 'Auto-Helper', description: 'Cambia el botón y la ventana de configuración del Auto-Helper.', css: '--cc-scale-helper' }
    ]);
    const SCRIPT_SCALE_DEFAULTS = Object.freeze(Object.fromEntries(SCRIPT_SCALE_AREAS.map(area => [area.key, 100])));

    /* --------------------------------------------------------------- */
    /* CARD MODE: TEMAS, SPRITES Y EFECTOS                              */
    /* --------------------------------------------------------------- */
    /* Todo lo de la card mode se guarda en la MISMA clave que las escalas
       (SCRIPT_SCALE_STORAGE). Las funciones de carga y guardado conservan
       estas claves aunque el objeto de escalas solo conozca las suyas. */

    /* Sello de la revision del card mode. Se escribe en el panel de ajustes
       (data-cc-build) para poder confirmar que la copia cargada en el
       navegador corresponde al archivo, sin depender de la consola del
       sandbox de Tampermonkey. */
    const CARD_BUILD = '2026-10-06e';

    const CARD_THEMES = Object.freeze([
        { id: '1', name: 'Panel técnico',      desc: 'raíl + mono',     cls: 'cc-theme-1' },
        { id: '2', name: 'Bento glass',        desc: 'grid asimétrico', cls: 'cc-theme-2' },
        { id: '3', name: 'Poké-Card',          desc: 'marco TCG',       cls: 'cc-theme-3' },
        { id: '4', name: 'Arc / radial',       desc: 'anillo SVG',      cls: 'cc-theme-4' },
        { id: '5', name: 'Compacto',           desc: 'plegable',        cls: 'cc-theme-5' },
        { id: '6', name: 'Línea minimal',      desc: 'sin marco',       cls: 'cc-theme-6' },
        { id: '7', name: 'Escenario animado',  desc: 'GIF + golpe',     cls: 'cc-theme-7' }
    ]);

    /* Las 8 versiones de sprite, todas servidas por PokeAPI. Se midio su
       cobertura real sobre 33 especies: si un sprite no existe, el <img> cae
       al pixel clasico (onerror) en vez de dejar un hueco. Las dos marcadas
       `anim` son GIF animados de verdad. */
    const POKEAPI_SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
    const CARD_SPRITES = Object.freeze([
        { id: 'pixel',   name: 'Pixel clásico',         short: 'Pixel',     url: id => `${POKEAPI_SPRITE_BASE}${id}.png`,                                          px: true,  cov: '33/33' },
        { id: 'retro3',  name: 'Retro Gen-III',         short: 'Retro',     url: id => `${POKEAPI_SPRITE_BASE}versions/generation-iii/emerald/${id}.png`,      px: true,  cov: '33/33' },
        { id: 'gen9',    name: 'Gen-IX Scarlet/Violet', short: 'Gen-IX',    url: id => `${POKEAPI_SPRITE_BASE}versions/generation-ix/scarlet-violet/${id}.png`,    px: true,  cov: '33/33' },
        { id: 'home3d',  name: 'Render 3D Home',        short: 'Home 3D',   url: id => `${POKEAPI_SPRITE_BASE}other/home/${id}.png`,                             px: false, cov: '33/33' },
        { id: 'dream3d', name: 'Render 3D Dream-World', short: 'Dream 3D',  url: id => `${POKEAPI_SPRITE_BASE}other/dream-world/${id}.svg`,                      px: false, cov: '30/33' },
        { id: 'artwork', name: 'Artwork oficial',       short: 'Artwork',   url: id => `${POKEAPI_SPRITE_BASE}other/official-artwork/${id}.png`,                  px: false, cov: '33/33' },
        { id: 'ani3d',   name: 'GIF animado 3D',        short: 'GIF 3D',    url: id => `${POKEAPI_SPRITE_BASE}other/showdown/${id}.gif`,                         px: false, cov: '31/33', anim: true },
        { id: 'anipx',   name: 'GIF animado pixel',     short: 'GIF pixel', url: id => `${POKEAPI_SPRITE_BASE}versions/generation-v/black-white/animated/${id}.gif`, px: true, cov: '31/33', anim: true }
    ]);

    /* Bolas de captura: sprites del propio juego.
       _catch y _broke son tiras VERTICALES (64x5760 y 64x4224) de 60 y 44
       frames de 64x96; throw/ es una rejilla 3x3 de 32px con 9 poses de
       rotacion y estela. El juego las reproduce a 75 ms por frame; aqui van
       mas rapido porque la card es mucho mas pequena que el mapa. */
    const CAPTURE_ASSET_BASE = 'https://poke.idleworld.online/assets/effects/catch/';
    const CAPTURE_ICON_BASE = 'https://poke.idleworld.online/assets/markitems/';
    const CAPTURE_BALLS = Object.freeze([
        { id: 'idleball',      name: 'Idle Ball',     icon: 'idleball',      frames: 60, broke: 44 },
        { id: 'idleball_gold', name: 'Idle Ball Oro', icon: 'idleball_gold', frames: 60, broke: 44 },
        { id: 'pokeball',      name: 'Poké Ball',     icon: 'pokeball',      frames: 60, broke: 44 },
        { id: 'greatball',     name: 'Great Ball',    icon: 'greatball',     frames: 60, broke: 44 },
        { id: 'superball',     name: 'Super Ball',    icon: 'superball',     frames: 60, broke: 44 },
        { id: 'ultraball',     name: 'Ultra Ball',    icon: 'ultraball',     frames: 60, broke: 44 },
        { id: 'masterball',    name: 'Master Ball',   icon: 'pokeball',      frames: 43, broke: 0 }
    ]);

    const CARD_PREFS_DEFAULTS = Object.freeze({
        /* La bola NO es una preferencia: se toma de la que se lanzo de verdad,
           via catch-result.ballId. */
        theme: '3', sprite: 'dream3d',
        showPct: true, hitFx: true, glow: false, memoOpen: false
    });
    const CARD_PREF_KEYS = Object.keys(CARD_PREFS_DEFAULTS);

    const themeById = id => CARD_THEMES.find(t => t.id === id) || CARD_THEMES[0];
    const spriteById = id => CARD_SPRITES.find(s => s.id === id) || CARD_SPRITES[0];
    const ballById = id => CAPTURE_BALLS.find(b => b.id === id) || CAPTURE_BALLS[0];

    function loadCardPreferences() {
        try {
            const raw = JSON.parse(localStorage.getItem(SCRIPT_SCALE_STORAGE) || '{}') || {};
            return Object.fromEntries(CARD_PREF_KEYS.map(key => {
                const value = raw[`card_${key}`];
                if (key === 'theme') return [key, CARD_THEMES.some(t => t.id === value) ? value : CARD_PREFS_DEFAULTS.theme];
                if (key === 'sprite') return [key, CARD_SPRITES.some(s => s.id === value) ? value : CARD_PREFS_DEFAULTS.sprite];
                return [key, typeof value === 'boolean' ? value : CARD_PREFS_DEFAULTS[key]];
            }));
        } catch (_) {
            return { ...CARD_PREFS_DEFAULTS };
        }
    }

    let scriptCardPreferences = loadCardPreferences();
    let scaleResizeTimer = null;
    let captureBarManuallyHidden = false;
    /* Fuente de datos de la barra. El panel nativo se desmonta cuando no hay
       salvajes ni mensaje flash, asi que su contenido se relee en cada ciclo y
       se guarda como ultimo valor conocido. `stale` avisa de que esos numeros
       ya no son frescos en lugar de presentarlos como si lo fueran. */
    /* La barra se alimenta de tres eventos que el servidor ya empuja: balls e
       inventory dan balls y pociones, field-kill da las kills. Del panel nativo
       solo queda leer la ball seleccionada y los salvajes, porque el socket no
       manda ni nombre ni nivel de estos ultimos. */
    const captureCache = { balls: [], wilds: [], potions: [], selectedBallId: '', inventory: new Map(), stale: true };
    /* Los sprites del panel nativo son <canvas> de OutfitSprite, no <img>, asi
       que se copian una vez a data URL por nombre de Pokemon. */
    const captureSpriteCache = new Map();
    /* Kills: un contador por hunt, no una lista. La barra no crece con el numero
       de QA. `location` guarda la hunt en la que se esta contando, para poner el
       contador a cero al cambiar de hunt. */
    const captureKillStats = { total: 0, shiny: 0, location: '', lastName: '', lastSprite: '', lastShiny: false, at: 0 };
    /* Eventos del socket que interesan al script. La cola descarta TODO lo que no
       contenga alguno de estos marcadores, asi que si falta uno el evento nunca
       llega a processSocketPayload:
         - balls / inventory / field-kill: los necesita la barra de captura;
         - catch-result: es el aviso de captura del juego (trae ballId y si
           funciono). Sin el no se dispara la animacion de la Poké Ball;
         - pending: la lista de salvajes con speciesId, hp y shiny, que es de
           donde salen los datos de la card enemiga;
         - autohelper: la configuracion del Auto-Helper (se lee para saber que
           bola usa, por si se quiere mostrar). */
    const CAPTURE_SOCKET_MARKERS = ['"balls"', '"inventory"', '"field-kill"', '"catch-result"', '"pending"', '"autohelper"'];
    /* Catalogo estatico de items para nombre e icono. Solo se usa la categoria
       'heal', que son las 6 pociones de curacion (las de revive se descartan). */
    const CAPTURE_POTION_CATEGORY = 'heal';
    let captureItemCatalog = null;
    let captureItemCatalogRequest = null;

    function normalizeScalePercent(value) {
        const numeric = Number(value);
        return SCRIPT_SCALE_OPTIONS.includes(numeric) ? numeric : 100;
    }

    function loadScriptScalePreferences() {
        try {
            const stored = JSON.parse(localStorage.getItem(SCRIPT_SCALE_STORAGE) || '{}');
            return Object.fromEntries(SCRIPT_SCALE_AREAS.map(area => [area.key, normalizeScalePercent(stored?.[area.key])]));
        } catch (_) {
            return { ...SCRIPT_SCALE_DEFAULTS };
        }
    }

    /* Se relee el objeto entero de la clave y se le reponen las claves `card_*`
       antes de escribir. Si no, el guardado de una escala borraria el tema y el
       sprite elegidos, porque estas funciones solo conocen las claves de area. */
    function saveScriptScalePreferences() {
        try {
            let stored = {};
            try { stored = JSON.parse(localStorage.getItem(SCRIPT_SCALE_STORAGE) || '{}') || {}; } catch (_) {}
            CARD_PREF_KEYS.forEach(key => { stored[`card_${key}`] = scriptCardPreferences[key]; });
            localStorage.setItem(SCRIPT_SCALE_STORAGE, JSON.stringify(stored));
        } catch (_) {}
    }

    /* Preferencias de card: mismo patron de guardado que las escalas. */
    function saveCardPreferences() {
        saveScriptScalePreferences();
    }

    let scriptScalePreferences = loadScriptScalePreferences();

    function getResponsiveScale(areaKey, percent) {
        const requested = normalizeScalePercent(percent) / 100;
        const viewportWidth = Math.max(280, window.innerWidth || 1280);
        const viewportHeight = Math.max(320, window.innerHeight || 720);
        const compactDock = viewportWidth <= 600;
        const baseWidths = {
            hud: 270,
            dock: compactDock ? 255 : 500,
            battle: 480,
            enemy: 360,
            capture: 255,
            victory: 210,
            events: viewportWidth <= 700 ? 350 : 580,
            helper: 540
        };
        const baseHeights = {
            hud: 510,
            dock: compactDock ? 160 : 58,
            battle: 340,
            enemy: 235,
            capture: 320,
            victory: 500,
            events: 70,
            helper: 650
        };
        const availableWidth = areaKey === 'dock' && compactDock
            ? viewportWidth - 14
            : areaKey === 'battle' || areaKey === 'enemy'
                ? viewportWidth - 48
                : viewportWidth - 24;
        const availableHeight = areaKey === 'victory' ? viewportHeight - 90 : viewportHeight - 24;
        const responsiveMaximum = Math.min(
            availableWidth / (baseWidths[areaKey] || 500),
            availableHeight / (baseHeights[areaKey] || 650)
        );
        return Math.max(0.5, Math.min(requested, responsiveMaximum));
    }

    /* --------------------------------------------------------------- */
    /* EFECTOS DE GOLPE, DAÑO Y CAPTURA                               */
    /* --------------------------------------------------------------- */
    /* Se aplican como clases sobre la RAÍZ de la card, nunca sobre su CSS
       interno: asi el mismo efecto sirve para los 7 temas. El nodo se
       reconstruye antes de cada disparo para reiniciar la animacion. */

    function ccCardFx(card, kind) {
        if (!card) return;
        const className = kind === 'hit' ? 'cc-hit' : 'cc-hurt';
        card.classList.remove(className);
        void card.offsetWidth;
        card.classList.add(className);

        const ring = document.createElement('span');
        ring.className = `cc-fx-ring go${kind === 'hurt' ? ' red' : ''}`;
        card.appendChild(ring);
        ring.addEventListener('animationend', () => ring.remove(), { once: true });

        if (kind === 'hit') {
            const slash = document.createElement('span');
            slash.className = 'cc-fx-slash go';
            card.appendChild(slash);
            slash.addEventListener('animationend', () => slash.remove(), { once: true });
        }
        card.addEventListener('animationend', () => card.classList.remove(className), { once: true });
    }

    function ccWinFlash(card) {
        if (!card) return;
        card.classList.remove('cc-win');
        void card.offsetWidth;
        card.classList.add('cc-win');
        card.addEventListener('animationend', () => card.classList.remove('cc-win'), { once: true });
    }

    /* ---- CAPTURA ---- */
    /* El lanzamiento se dispara al pulsar una bola de la Capture Bar, que es
       el instante real en que el juego lanza. El desenlace (éxito o fallo) no
       llega hasta el evento catch-result del socket, asi que la bola vuela ya
       y se resuelve cuando el servidor responde. */

    /* Estado de la captura en curso.
       spot: coordenadas del enemigo, relativas a la capa, fijadas al lanzar.
       Es imprescindible fijarlas porque en una captura con exito la card del
       enemigo desaparece de inmediato (el juego vacia la lista de salvajes) y
       si el efecto se anclara a la card se quedaria sin pintar justo cuando
       tiene que verse. Con el punto guardado la animacion se dibuja igual,
       encima de donde estaba el Pokemon. */
    const captureState = { busy: false, ballId: null, timer: 0, resolveTimer: 0, spot: null, species: '', result: false, startedAt: 0 };

    /* Ultima posicion conocida de la card enemiga, relativa a la capa.
       Se guarda en cada refresco porque el evento catch-result llega cuando la
       captura YA se ha resuelto: en un acierto el juego borra al salvaje de la
       lista en ese mismo instante, asi que para ese caso no hay card a la que
       anclarse y el efecto se dibuja en el punto que se guardo. */
    let ccLastEnemySpot = null;

    function ccEnemySpot(enemy, layer) {
        if (!enemy || !layer) return null;
        const enemyBox = enemy.getBoundingClientRect();
        const rowBox = layer.getBoundingClientRect();
        return {
            x: enemyBox.left + enemyBox.width / 2 - rowBox.left,
            y: enemyBox.top + enemyBox.height / 2 - rowBox.top
        };
    }

    /* Id de bola del juego -> sprite de /assets/effects/catch. Estos ids son los
       que usa el propio juego y los que viajan en catch-result.ballId, asi que
       la bola que se ve en la animacion es la que se lanzo de verdad, sin
       depender de ninguna preferencia propia. */
    const CC_BALL_ID_MAP = Object.freeze({
        1: 'pokeball', 2: 'greatball', 3: 'superball', 4: 'ultraball',
        5: 'masterball', 6: 'idleball', 7: 'idleball_gold'
    });
    function ccBallForId(gameId) {
        return ballById(CC_BALL_ID_MAP[Number(gameId)] || 'pokeball');
    }

    function ccCaptureLayer() {
        const row = document.querySelector('.cbt-row');
        if (!row) return null;
        let layer = row.querySelector('.cc-capture-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'cc-capture-layer';
            row.appendChild(layer);
        }
        return layer;
    }

    function ccClearCapture() {
        const layer = ccCaptureLayer();
        if (layer) layer.innerHTML = '';
        captureState.busy = false;
        captureState.ballId = null;
        captureState.spot = null;
        captureState.species = '';
        if (captureState.timer) { clearTimeout(captureState.timer); captureState.timer = 0; }
        if (captureState.resolveTimer) { clearTimeout(captureState.resolveTimer); captureState.resolveTimer = 0; }
        const hero = document.getElementById('my-custom-poke-card');
        hero?.classList.remove('cc-recoil');
    }

    /* Se dispara con el evento catch-result, que es el unico punto donde el juego
       confirma una captura. Asi cubre tambien las capturas automaticas del
       Auto-Helper, que no pasan por ningun clic y antes no llegaban a verse. */
    function ccStartCapture(ball, speciesName) {
        if (!ball || captureState.busy) return;
        const hero = document.getElementById('my-custom-poke-card');
        const layer = ccCaptureLayer();
        if (!hero || !layer) return;

        /* Punto de destino: la card enemiga si sigue en pantalla y, si ya no,
           el ultimo sitio donde se vio. Sin ninguno de los dos no hay animacion
           que dibujar. */
        const spot = ccEnemySpot(document.getElementById('my-custom-mob-card'), layer) || ccLastEnemySpot;
        if (!spot) return;

        captureState.busy = true;
        captureState.startedAt = Date.now();
        captureState.ballId = ball.id;
        captureState.species = String(speciesName || '').trim();
        const heroBox = hero.getBoundingClientRect();
        const rowBox = layer.getBoundingClientRect();
        /* Las coordenadas van relativas a la capa, que cubre .cbt-row entero. */
        const sx = heroBox.left + heroBox.width / 2 - rowBox.left;
        const sy = heroBox.top + heroBox.height / 2 - rowBox.top;
        const ex = Math.round(spot.x);
        const ey = Math.round(spot.y);
        /* Punto de impacto guardado: sobrevive a que la card enemiga se borre. */
        captureState.spot = { x: ex, y: ey };
        const dx = Math.round(ex - sx);
        const dy = Math.round(ey - sy);

        const fly = document.createElement('div');
        fly.className = 'cc-fly';
        fly.style.left = `${sx}px`;
        fly.style.top = `${sy}px`;
        fly.style.setProperty('--dx', `${dx}px`);
        fly.style.setProperty('--dy', `${dy}px`);
        fly.style.backgroundImage = `url("${CAPTURE_ASSET_BASE}throw/${ball.id}.png")`;
        layer.appendChild(fly);

        const shadow = document.createElement('div');
        shadow.className = 'cc-shadow';
        shadow.style.left = `${sx}px`;
        shadow.style.top = `${ey + 30}px`;
        shadow.style.setProperty('--dx', `${dx}px`);
        shadow.style.setProperty('--dy', `${dy}px`);
        layer.appendChild(shadow);

        hero.classList.remove('cc-recoil');
        void hero.offsetWidth;
        hero.classList.add('cc-recoil');

        void fly.offsetWidth;
        fly.classList.add('go');
        shadow.classList.add('go');

        /* Si el servidor no responde en 6 s se limpia igual, para no dejar la
           bola colgada en el aire. */
        captureState.timer = window.setTimeout(() => ccResolveCapture(false), 6000);
    }

    /* El vuelo dura 1 s y el desenlace se aplica en cuanto llega, que es justo
       el momento en que el juego termina de resolver la captura. Si llegan
       varios resultados seguidos (el Auto-Helper va lanzando sin parar) solo
       cuenta el ultimo, para no encadenar animaciones encimadas. */
    function ccScheduleResolve(success) {
        captureState.result = !!success;
        if (captureState.resolveTimer) clearTimeout(captureState.resolveTimer);
        captureState.resolveTimer = window.setTimeout(() => ccResolveCapture(captureState.result), 1000);
    }

    function ccResolveCapture(success) {
        const layer = ccCaptureLayer();
        if (!layer || !captureState.busy) return;
        captureState.resolveTimer = 0;
        if (captureState.timer) { clearTimeout(captureState.timer); captureState.timer = 0; }
        const ball = ballById(captureState.ballId);
        const enemy = document.getElementById('my-custom-mob-card');
        const hero = document.getElementById('my-custom-poke-card');
        const species = captureState.species;

        layer.querySelectorAll('.cc-fly,.cc-shadow').forEach(node => node.remove());

        /* El punto de impacto se toma del sitio guardado al lanzar. Si la card
           enemiga sigue en pantalla se usa su caja actual, que es lo mismo. */
        const rowBox = layer.getBoundingClientRect();
        const enemyBox = enemy ? enemy.getBoundingClientRect() : null;
        const spot = enemyBox
            ? { x: enemyBox.left + enemyBox.width / 2 - rowBox.left, y: enemyBox.top + enemyBox.height / 2 - rowBox.top }
            : captureState.spot;

        /* Si la bola no tiene animacion de fallo (Master Ball), el juego la
           resuelve siempre con _catch, y aqui igual. */
        const useBroke = !success && ball.broke > 0;
        const sheet = document.createElement('div');
        sheet.className = `cc-sheet ${useBroke ? 'cc-broke' : 'cc-catch'}`;
        if (spot) {
            sheet.style.left = `${spot.x}px`;
            sheet.style.top = `${spot.y}px`;
        }
        sheet.style.backgroundImage = `url("${CAPTURE_ASSET_BASE}${ball.id}${useBroke ? '_broke' : '_catch'}.png")`;
        const frames = useBroke ? ball.broke : ball.frames;
        /* 40 ms por frame en vez de los 75 del juego: la card es mucho mas
           pequeña que el mapa y a 75 el efecto se eterniza. */
        sheet.style.animationDuration = `${frames * 40}ms`;
        layer.appendChild(sheet);

        const impact = document.createElement('div');
        impact.className = 'cc-impact go';
        if (spot) {
            impact.style.left = `${spot.x}px`;
            impact.style.top = `${spot.y}px`;
        }
        layer.appendChild(impact);
        impact.addEventListener('animationend', () => impact.remove(), { once: true });

        if (enemy) {
            enemy.classList.remove('cc-shaking');
            void enemy.offsetWidth;
            enemy.classList.add('cc-shaking');
            enemy.addEventListener('animationend', () => enemy.classList.remove('cc-shaking'), { once: true });
        }

        window.setTimeout(() => {
            sheet.remove();
            const badge = document.createElement('div');
            badge.className = `cc-cap-badge${success ? '' : ' fail'}`;
            const img = document.createElement('img');
            img.src = `${CAPTURE_ICON_BASE}${ball.icon}.png`;
            img.alt = ball.name;
            const text = document.createElement('span');
            text.textContent = success
                ? (species ? `${species} capturado` : 'Capturado')
                : (species ? `¡${species} se escapó!` : '¡Se escapó!');
            badge.appendChild(img);
            badge.appendChild(text);
            if (enemy) {
                enemy.appendChild(badge);
            } else if (spot) {
                /* Sin card enemiga la insignia se pinta en la capa, en el
                   punto donde estaba el Pokemon. */
                badge.style.left = `${spot.x}px`;
                badge.style.top = `${spot.y}px`;
                badge.classList.add('cc-floating');
                layer.appendChild(badge);
            }
            void badge.offsetWidth;
            badge.classList.add('go');

            if (success) {
                enemy?.classList.add('cc-captured');
                ccWinFlash(hero);
            }
            window.setTimeout(() => {
                if (!success) badge.remove();
                captureState.busy = false;
                captureState.ballId = null;
                captureState.spot = null;
                captureState.species = '';
            }, success ? 1800 : 1500);
        }, frames * 40 + 40);
    }

    /* --- LANZAMIENTO DE LA CARD ---
   applyHitEffects observa los porcentajes de HP ya pintados por updateLiveBars
   y updateMobCard: si el aliado sube, golpea; si el enemigo baja, recibe. Asi el
   efecto sale solo, sin depender de ningun evento que el juego no emita. */
    let ccLastHeroHp = null;
    let ccLastEnemyHp = null;

    function ccPctOf(node) {
        return node ? parseFloat(node.style.width) : null;
    }

    function applyHitEffects() {
        if (!scriptCardPreferences.hitFx) return;
        const hero = document.getElementById('my-custom-poke-card');
        const enemy = document.getElementById('my-custom-mob-card');
        if (!hero || !enemy) { ccLastHeroHp = null; ccLastEnemyHp = null; return; }

        const heroHp = ccPctOf(document.getElementById('cpc-hp-fill'));
        if (heroHp !== null && ccLastHeroHp !== null && heroHp > ccLastHeroHp + 0.01) {
            ccCardFx(hero, 'hit');
            ccCardFx(enemy, 'hurt');
        }
        if (heroHp !== null) ccLastHeroHp = heroHp;

        const enemyHp = ccPctOf(document.querySelector('#my-custom-mob-card .mob-hp-fill'));
        if (enemyHp !== null && ccLastEnemyHp !== null && enemyHp < ccLastEnemyHp - 0.01) {
            ccCardFx(enemy, 'hurt');
        }
        if (enemyHp !== null) ccLastEnemyHp = enemyHp;
    }

    /* Lanzamiento manual: al pulsar una bola de la Capture Bar. El evento del
       socket ya es el disparador principal (cubre el tiro del Auto-Helper,
       que es el que mas se usa), pero este mantiene el efecto inmediato
       cuando se lanza a mano y aun no hay nada pendiente que resolver. El
       resultado que llegue despues con catch-result se encarga del desenlace. */
    document.addEventListener('click', event => {
        const ballButton = event.target.closest?.('.cc-dock-ball');
        if (!ballButton) return;
        const name = (ballButton.getAttribute('title') || '').trim().toLowerCase();
        const match = CAPTURE_BALLS.find(ball => ball.id.includes(name.replace(/\s+/g, '')) || name.includes(ball.name.toLowerCase().split(' ')[0]));
        ccStartCapture(match || ballById('pokeball'));
    }, true);

    /* Ya NO se cancela la captura cuando la card enemiga desaparece: en una
       captura con exito el juego borra al salvaje de inmediato y cancelar
       entonces era justo lo que impedia ver la animacion. Esta comprobacion
       solo sirve como red de seguridad: si la captura se eterniza (por ejemplo
       porque el navegador ralentiza los temporizadores con la pestaña en
       segundo plano) se limpia, porque una bola colgada en el aire se queda
       flotando sobre la card para siempre. */
    function ccAbandonCaptureIfNoTarget() {
        if (!captureState.busy) return;
        /* Vuelo 1 s + desenlace ~2.4 s + insignia ~1.8 s. */
        if (Date.now() - captureState.startedAt > 8000) ccClearCapture();
    }

    

    function applyScriptScales() {
        const root = document.documentElement;
        if (!root) return;
        SCRIPT_SCALE_AREAS.forEach(area => {
            const effective = getResponsiveScale(area.key, scriptScalePreferences[area.key]);
            root.style.setProperty(area.css, effective.toFixed(3));
            const status = document.querySelector(`[data-scale-effective="${area.key}"]`);
            if (status) {
                const effectivePercent = Math.round(effective * 100);
                const requestedPercent = normalizeScalePercent(scriptScalePreferences[area.key]);
                status.textContent = effectivePercent === requestedPercent
                    ? `Aplicado: ${effectivePercent}%`
                    : `Solicitado: ${requestedPercent}% · ajuste responsivo: ${effectivePercent}%`;
            }
        });
        lastEventSyncAt = 0;
        requestAnimationFrame(() => {
            updateEventBoostBar();
            setupCaptureBarToggle();
            setupScriptScaleSettings();
            /* El panel de equipo se reescala justo aquí, con la propiedad scale.
               El ResizeObserver no se entera de eso (solo mira la caja de
               layout, que no cambia al escalar), así que sin esta llamada el
               botón se quedaba en la posición que tenía con la escala
               anterior. Se repone tras el reflow, en el mismo frame que el
               cambio, y por eso sigue al panel al mover el deslizador. */
            positionHudButtons();
        });
    }

    try { localStorage.removeItem('custom-card-capture-hidden'); } catch (_) {}
    applyScriptScales();
    window.addEventListener('resize', () => {
        clearTimeout(scaleResizeTimer);
        scaleResizeTimer = setTimeout(applyScriptScales, 100);
    }, { passive: true });
    const victoryRuntime = window.__customCardVictoryRuntime || {};
    if (!victoryRuntime.processedCards) victoryRuntime.processedCards = new WeakSet();
    if (!victoryRuntime.recentFingerprints) victoryRuntime.recentFingerprints = new Map();
    window.__customCardVictoryRuntime = victoryRuntime;

    // 1. Estilos CSS Completos
    GM_addStyle(`
        :root {
            --cc-scale-hud: 1; --cc-scale-dock: 1; --cc-scale-battle: 1; --cc-scale-enemy: 1;
            --cc-scale-capture: 1; --cc-scale-victory: 1; --cc-scale-events: 1; --cc-scale-helper: 1;
        }

        /* --------------------------------------------------- */
        /* HUD PRINCIPAL - PANEL DE EQUIPO DESLIZABLE          */
        /* --------------------------------------------------- */
        .phud.game-hud-tl {
            position: fixed !important;
            top: 15px !important;
            left: 0 !important;
            background-color: rgba(13, 19, 26, 0.85) !important;
            backdrop-filter: blur(8px) !important;
            -webkit-backdrop-filter: blur(8px) !important;
            border: 1px solid #2a3a4a !important;
            border-left: none !important;
            border-radius: 0 12px 12px 0 !important;
            padding: 12px 16px 12px 12px !important;
            box-shadow: 4px 4px 15px rgba(0,0,0,0.7) !important;
            transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
            z-index: 100 !important;
            min-width: 220px !important;
            overflow: visible !important; 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif !important;
            color: #e2e8f0 !important;
            scale: var(--cc-scale-hud) !important;
            transform-origin: left top !important;
        }
        .phud.game-hud-tl.hidden-hud { transform: translateX(-100%) !important; }

        /* --------------------------------------------------- */
        /* PANEL DE EQUIPO, marcado actual del juego            */
        /* Las reglas de abajo apuntan a .sbar/.sbar-fill/     */
        /* .sbar-txt, que es lo que usa el juego hoy. El       */
        /* rediseño anterior estaba escrito sobre .progress y  */
        /* .progress-bar, clases que ya no existen: por eso el */
        /* panel se veía a medias y el número de vida se       */
        /* solapaba con la barra (9px de alto con texto de    */
        /* 11px dentro). Solo se cambia el aspecto; el ancho   */
        /* del relleno lo sigue poniendo el juego.            */
        /* --------------------------------------------------- */
        .phud.game-hud-tl::before, .phud::before { content: none !important; display: none !important; }
        /* El [class] es a propósito: el juego impone su borde dorado con
           ".phud.game-hud-tl", que tiene exactamente la misma especificidad
           que un selector de dos clases pero aparece MÁS TARDE en la hoja, así
           que ganaba él. Un atributo más rompe el empate. */
        .phud.game-hud-tl[class] {
            background: transparent !important;
            -webkit-backdrop-filter: none !important;
            backdrop-filter: none !important;
            border: none !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            padding: 4px 10px 4px 4px !important;
        }
        /* Cabecera: nombre, nivel y lugar, en su propio recuadro de cristal y
           centrada. El logo se oculta. */
        .phud.game-hud-tl .phud-head {
            display: flex !important; align-items: center !important; justify-content: center !important;
            gap: 10px !important; border-bottom: none !important; padding-bottom: 0 !important;
            background: rgba(30, 41, 59, 0.42) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border-radius: 12px !important; padding: 7px 12px !important; margin: 0 0 8px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12) !important;
        }
        .phud.game-hud-tl .phud-emblem { display: none !important; }
        .phud.game-hud-tl .phud-trainer { text-align: center !important; }
        .phud.game-hud-tl .phud-tname { font-size: 13px !important; font-weight: 800 !important; letter-spacing: 0.4px !important; }
        .phud.game-hud-tl .phud-tloc { font-size: 11px !important; font-weight: 600 !important; color: #9fb0c2 !important; margin-top: 2px !important; }

        .phud.game-hud-tl .phud-party { margin-top: 9px !important; }
        /* El crystal vive ahora en cada Pokémon, no en el panel general. */
        .phud.game-hud-tl .phud-mon, .phud.game-hud-tl .phud-mon.active {
            display: grid !important; grid-template-columns: 48px 1fr !important;
            align-items: center !important; gap: 11px !important; width: 100% !important;
            background: rgba(30, 41, 59, 0.42) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border: none !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12) !important;
            border-radius: 12px !important; padding: 8px 10px !important; box-sizing: border-box !important;
            margin: 0 0 6px !important; text-align: left !important; cursor: pointer !important;
            transition: background-color 0.18s ease !important;
        }
        .phud.game-hud-tl .phud-mon:hover { background: rgba(38, 54, 77, 0.6) !important; }
        /* El juego pinta el sprite con un borde y un halo del color del tipo
           (--type). Aquí se quitan los dos: ese halo era el "degradado" que se
           veía detrás de cada Pokémon. */
        .phud.game-hud-tl .phud-ico {
            width: 46px !important; height: 46px !important; border-radius: 12px !important;
            background: transparent !important; border: none !important; box-shadow: none !important;
            display: grid !important; place-items: center !important;
        }
        .phud.game-hud-tl .phud-ico canvas { width: 42px !important; height: 42px !important; }
        .phud.game-hud-tl .pk-ts-type {
            position: absolute !important; right: -5px !important; bottom: -5px !important;
            width: 18px !important; height: 18px !important; border-radius: 6px !important;
            border: 1px solid rgba(148, 178, 214, 0.3) !important;
            background: rgba(15, 23, 42, 0.8) !important; padding: 1px !important;
            box-sizing: border-box !important; object-fit: contain !important; margin: 0 !important;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5) !important;
        }
        .phud.game-hud-tl .phud-name { font-size: 13px !important; font-weight: 700 !important; color: #e6edf5 !important; }
        .phud.game-hud-tl .phud-lv { font-size: 11px !important; font-weight: 700 !important; color: #fcd34d !important; }

        /* Barras: la de vida crece a 15px para que el número que el juego pinta
           dentro quepa con sombra y se lea encima del relleno. El ancho del
           relleno no se toca: lo sigue calculando el juego. */
        .phud.game-hud-tl .sbar {
            position: relative !important; overflow: hidden !important;
            border-radius: 7px !important; box-sizing: border-box !important;
            background: rgba(6, 10, 16, 0.55) !important; border: none !important;
        }
        .phud.game-hud-tl .sbar-hp { height: 15px !important; margin-top: 3px !important; }
        .phud.game-hud-tl .sbar-exp { height: 11px !important; margin-top: 4px !important; }
        .phud.game-hud-tl .sbar .sbar-fill { position: absolute !important; left: 0 !important; top: 0 !important; bottom: 0 !important; height: 100% !important; }

        /* Color plano, sin degradado. El juego ya trae un elemento .sbar-shine
           con la animación sbar-shine, que es el barrido de luz: se conserva
           y se baja la opacidad del relleno para que se note. */
        .phud.game-hud-tl .sbar-hp .sbar-fill { background-image: none !important; background-color: #22c55e !important; }
        .phud.game-hud-tl .sbar-hp.low .sbar-fill { background-color: #ef4444 !important; }
        .phud.game-hud-tl .sbar-exp .sbar-fill { background-image: none !important; background-color: #eab308 !important; }
        .phud.game-hud-tl .sbar .sbar-shine { opacity: 0.3 !important; }

        .phud.game-hud-tl .sbar-txt {
            position: absolute !important; left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            font-size: 10px !important; font-weight: 800 !important; color: #ffffff !important;
            letter-spacing: 0.2px !important; z-index: 2 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 3px rgba(0, 0, 0, 0.85) !important;
        }
        .phud.game-hud-tl .sbar-exp .sbar-txt { font-size: 8px !important; }

        /* Botón de ocultar/mostrar el panel. Igual que en el dock de
           navegación: la flecha de ocultar vive dentro del panel y, cuando
           está oculto, queda una píldora suelta que lo devuelve. Si el botón
           estuviera solo dentro del panel, se iría con él al deslizarse. */
        /* Los dos controles viven en la misma capa del panel. El de ocultar va
           DENTRO del panel, pegado a su borde derecho y centrado en vertical:
           así se desliza con él al ocultarlo y vuelve con él al mostrarlo. Y
           como el centrado lo trae el propio panel con su 50%, ningún ajuste
           de escala lo descuadra: da igual el valor que se ponga en Custom
           Card. El de mostrar es una píldora suelta en el borde izquierdo de
           la pantalla, porque dentro del panel se iría con él y no habría
           forma de recuperarlo.

           El relevo: los dos se cruzan en el mismo punto. Al terminar el
           deslizamiento el botón de ocultar queda en x≈24, justo donde está
           la píldora, porque el panel solo se desplaza su propio ancho y el
           botón vive fuera de su borde derecho, así que no llega a salir de
           pantalla. Para que no se solapen, el que sale se apaga antes de que
           el otro se encienda: un relevo, no un cruzamiento. */
        #phud-toggle-btn, #phud-show-btn {
            background: rgba(30, 41, 59, 0.55) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border: 1px solid rgba(148, 178, 214, 0.16) !important;
            color: #dbeafe !important; cursor: pointer !important;
            display: grid !important; place-items: center !important; padding: 0 !important;
            width: 28px !important; height: 40px !important; border-radius: 9px !important;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28) !important;
            /* La misma capa que el panel de equipo, no una por encima: así los
               menús que se abren tapan el botón igual que tapan el panel. */
            z-index: var(--cc-hud-btn-z, 100) !important;
            /* Ni left ni top se animan. Antes se animaban y el botón llegaba
               tarde: el panel se desliza en 0.4s y el botón en 0.25s, así que
               se quedaba a medias. Ahora su sitio lo dicta el panel. */
            /* Al ENCENDER se espera el relevo, a que el otro ya esté apagado.
               Al apagar no se espera: se retira en cuanto empieza. Por eso el
               estado apagado repite la transition sin retardo. */
            transition: background-color 0.2s ease, color 0.2s ease,
                        opacity var(--cc-hud-fade, 0.16s) ease var(--cc-hud-handoff, 0.16s),
                        visibility 0s linear var(--cc-hud-handoff, 0.16s) !important;
        }
        #phud-toggle-btn {
            position: absolute !important;
            right: var(--cc-hud-btn-offset, -52px) !important;
            /* left se anula a propósito: el botón se coloca por su borde
               derecho respecto al panel. Si quedara un left puesto, ganaría
               sobre el right y el botón se metería dentro del panel. */
            left: auto !important;
            top: 50% !important;
            transform: translateY(-50%) !important;
        }
        #phud-show-btn {
            position: fixed !important;
            left: var(--cc-hud-btn-show-x, 10px) !important;
            top: var(--cc-hud-btn-y, 50%) !important;
            transform: translateY(-50%) !important;
        }
        #phud-toggle-btn:hover, #phud-show-btn:hover { background: rgba(38, 54, 77, 0.75) !important; color: #facc15 !important; }
        #phud-toggle-btn svg, #phud-show-btn svg {
            width: 15px !important; height: 15px !important; display: block !important;
            fill: none !important; stroke: currentColor !important; stroke-width: 2.2 !important;
            stroke-linecap: round !important; stroke-linejoin: round !important;
        }
        /* Los dos estados apagados. Sin retargo al desvanecerse, y con la
           visibilidad girando al final del propio desvanecimiento para que no
           se corten a media disolución. Las dos transition llevan !important
           porque las gana la de la regla base, que también lo lleva. */
        #phud-toggle-btn.is-off {
            opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
            transition: background-color 0.2s ease, color 0.2s ease,
                        opacity var(--cc-hud-fade, 0.16s) ease 0s,
                        visibility 0s linear var(--cc-hud-fade, 0.16s) !important;
        }
        #phud-show-btn.is-hidden {
            opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
            transition: background-color 0.2s ease, color 0.2s ease,
                        opacity var(--cc-hud-fade, 0.16s) ease 0s,
                        visibility 0s linear var(--cc-hud-fade, 0.16s) !important;
        }

        /* REDISEÑO DEL PARTY POKEMON */
        .phud-party { margin-top: 10px !important; display: flex !important; flex-direction: column !important; gap: 8px !important; }
        .phud-party > div {
            border: 1px solid #334155 !important;
            border-radius: 8px !important;
            padding: 8px 12px !important;
            display: grid !important;
            grid-template-columns: 44px 1fr !important;
            align-items: center !important;
            gap: 12px !important;
            transition: transform 0.2s ease, background 0.2s ease !important;
        }
        .phud-party > div:hover { transform: translateX(4px) !important; background: rgba(26, 37, 48, 0.9) !important; }
        
        /* Contenedor circular del Avatar */
        .phud-party > div > div:first-child {
            position: relative !important; 
            width: 44px !important;
            height: 44px !important;
            background-color: rgba(13, 19, 26, 0.95) !important; 
            border-radius: 50% !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            border: 1px solid #334155 !important;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.8) !important;
        }
        
        /* El sprite del Pokémon principal */
        .phud-party img:not(.pk-ts-type) {
            width: 32px !important;
            height: 32px !important;
            object-fit: contain !important;
            image-rendering: pixelated !important;
            z-index: 2 !important; 
            filter: none !important; 
        }

        /* EL ICONO DE TIPO ESTORBOSO CONVERTIDO EN MEDALLA */
        .phud-party .pk-ts-type {
            position: absolute !important;
            bottom: -4px !important;  
            right: -4px !important;   
            width: 18px !important;   
            height: 18px !important;  
            z-index: 3 !important;    
            border-radius: 50% !important;
            border: 1px solid #60a5fa !important; 
            box-shadow: 0 2px 5px rgba(0,0,0,0.9) !important;
            object-fit: contain !important;
            margin: 0 !important;
            padding: 2px !important; 
            box-sizing: border-box !important;
        }
        
        /* Barras de HP y XP de 18px */
        .phud-party .progress { 
            background: #0f172a !important; 
            border-radius: 6px !important; 
            height: 18px !important; 
            border: 1px solid #1e293b !important; 
            overflow: hidden !important; 
            margin-top: 4px !important; 
            width: 100% !important; 
            position: relative !important;
        }
        .phud-party .progress-bar { 
            height: 100% !important;
            border-radius: 4px !important; 
            transition: width 0.2s ease, background 0.3s ease !important; 
        }
        .phud.game-hud-tl span, .phud.game-hud-tl div:not(.progress):not(.progress-bar) { 
            font-size: 11px !important; 
            font-weight: 600 !important; 
            letter-spacing: 0.3px !important; 
            text-shadow: 1px 1px 2px rgba(0,0,0,0.8) !important; 
        }
        .phud-party .progress {
            text-align: center !important;
            line-height: 18px !important; 
            font-size: 11px !important;
            font-weight: 800 !important;
            color: #ffffff !important;
            text-shadow: 1px 1px 1px #000, -1px -1px 1px #000, 0px 1px 1px #000, 0px -1px 1px #000 !important;
        }
        .phud-party .progress * {
            position: absolute !important;
            width: 100% !important;
            left: 0 !important;
            top: 0 !important;
            z-index: 3 !important;
        }

        /* --------------------------------------------------- */
        /* AUTO-HELPER (ah-head) - BOTÓN PEQUEÑO EN LA ESQUINA */
        /* --------------------------------------------------- */
        .ah-head {
            position: fixed !important; 
            top: 15px !important; 
            right: 15px !important; 
            left: auto !important; 
            bottom: auto !important; 
            background-color: #0d131a !important; 
            border: 1px solid #2a3a4a !important; 
            border-radius: 6px !important; 
            padding: 6px 12px !important; 
            height: auto !important; 
            width: max-content !important; 
            max-width: 150px !important; 
            color: #e2e8f0 !important; 
            font-family: 'Segoe UI', Tahoma, Geneva, sans-serif !important; 
            font-size: 11px !important; 
            font-weight: bold !important; 
            cursor: pointer !important; 
            z-index: 10000 !important; 
            display: flex !important; 
            align-items: center !important; 
            justify-content: center !important;
            gap: 6px !important; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.5) !important;
            transition: background 0.2s ease, border-color 0.2s ease !important; 
            text-transform: uppercase !important; 
            letter-spacing: 0.5px !important;
            scale: var(--cc-scale-helper) !important;
            transform-origin: right top !important;
        }
        .ah-head:hover { background-color: #1e3a8a !important; border-color: #60a5fa !important; color: #ffffff !important; }

        /* --------------------------------------------------- */
        /* Modal Grid Auto-Helper - Diseño Compacto */
        /* --------------------------------------------------- */
        .ah-modal { 
            position: fixed !important; 
            inset: 0 !important;
            margin: auto !important;
            transform: none !important;
            width: 500px !important; 
            height: max-content !important;
            max-width: 95vw !important; 
            max-height: 90vh !important; 
            box-sizing: border-box !important;
            background-color: #060b14 !important; 
            border: 1px solid #1c3659 !important; 
            border-radius: 12px !important; 
            padding: 18px !important; 
            box-shadow: 0 0 30px rgba(10, 25, 50, 0.9), inset 0 0 15px rgba(28, 54, 89, 0.4) !important; 
            font-family: 'Segoe UI', Tahoma, Geneva, sans-serif !important; 
            color: #e2e8f0 !important; 
            z-index: 1000 !important; 
            overflow-y: auto !important; 
            scale: var(--cc-scale-helper) !important;
            transform-origin: center !important;
        }

        .ah-modal::-webkit-scrollbar { width: 4px; }
        .ah-modal::-webkit-scrollbar-track { background: transparent; }
        .ah-modal::-webkit-scrollbar-thumb { background: #1c3659; border-radius: 4px; }

        .ah-modal > div:not(:first-child), .ah-modal .ah-content, .ah-modal > form { 
            display: grid !important; 
            grid-template-columns: 1fr 1fr !important; 
            gap: 10px !important; 
            align-items: stretch !important; 
        }
        
        .ah-modal > div:first-child { 
            display: flex !important; 
            justify-content: space-between !important; 
            align-items: center !important; 
            border-bottom: 1px solid #1c3659 !important; 
            padding-bottom: 12px !important; 
            margin-bottom: 15px !important; 
            grid-column: span 2 !important; 
            font-size: 16px !important;
            font-weight: bold !important;
            letter-spacing: 0.5px !important;
        }

        .ah-modal > div:not(:first-child) > div, .ah-modal form > div, .ah-modal .ah-content > div { 
            background: #0a1220 !important; 
            border: 1px solid #1c3659 !important; 
            border-radius: 8px !important; 
            padding: 10px !important; 
            display: flex !important; 
            flex-direction: column !important; 
            justify-content: center !important;
            gap: 8px !important; 
            box-sizing: border-box !important; 
            transition: all 0.3s ease !important; 
        }

        .ah-modal form > div:nth-last-child(1), 
        .ah-modal form > div:nth-last-child(2), 
        .ah-modal form > div:nth-last-child(3),
        .ah-modal .ah-content > div:nth-last-child(1),
        .ah-modal .ah-content > div:nth-last-child(2),
        .ah-modal .ah-content > div:nth-last-child(3) { 
            grid-column: span 2 !important; 
        }

        .ah-modal select, .ah-modal input[type="text"] { 
            background: #060b14 !important; 
            border: 1px solid #23436e !important; 
            color: #94a3b8 !important; 
            border-radius: 6px !important; 
            padding: 8px !important; 
            font-size: 11px !important; 
            width: 100% !important; 
            box-sizing: border-box !important; 
            outline: none !important; 
            transition: border-color 0.2s ease !important;
        }
        .ah-modal select:focus, .ah-modal input[type="text"]:focus { 
            border-color: #3b82f6 !important; 
            box-shadow: 0 0 5px rgba(59, 130, 246, 0.4) !important;
        }

        .ah-modal [style*="grid"], .ah-modal .ball-grid { 
            display: grid !important; 
            grid-template-columns: repeat(4, 1fr) !important; 
            gap: 8px !important; 
            background: transparent !important;
            border: none !important;
            padding: 0 !important;
            margin-top: 5px !important;
        }

        .ah-modal [style*="grid"] > div, .ah-modal .ball-grid > div {
            background: #0a1220 !important;
            border: 1px solid #1c3659 !important;
            border-radius: 6px !important;
            padding: 8px 4px !important;
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 4px !important;
            font-size: 12px !important;
            font-weight: bold !important;
        }

        .ah-modal div[style*="border-color: rgb(34, 197, 94)"], 
        .ah-modal div[style*="border-color: #22c55e"] {
            border-color: #22c55e !important; 
        }
        .ah-modal div[style*="border-color: rgb(245, 158, 11)"], 
        .ah-modal div[style*="border-color: #f59e0b"] {
            border-color: #f59e0b !important; 
            box-shadow: 0 0 8px rgba(245, 158, 11, 0.3) !important; 
        }

        /* --------------------------------------------------- */
        /* GAME DOCK - FLEXBOX AUTOAJUSTABLE, MÁXIMO 2 FILAS   */
        /* --------------------------------------------------- */
        .game-dock {
            position: fixed !important;
            top: 0 !important;
            bottom: auto !important;
            left: 0 !important;
            right: 0 !important;
            margin-left: auto !important;
            margin-right: auto !important;
            transform: none !important;
            background-color: #060b14 !important;
            border: 1px solid #1c3659 !important;
            border-top: none !important;
            border-radius: 0 0 12px 12px !important;
            padding: 6px 8px !important;
            display: flex !important;
            flex-wrap: wrap !important;
            justify-content: center !important;
            gap: 4px !important; 
            z-index: 1000 !important;
            box-shadow: 0 5px 25px rgba(0,0,0,0.8) !important;
            transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), top 0.4s, right 0.4s, left 0.4s !important;
            width: max-content !important;
            /* --cc-dock-maxw lo calcula layoutDockRows() para garantizar máximo 2 filas */
            max-width: min(98vw, var(--cc-dock-maxw, 98vw)) !important;
            overflow: visible !important;
            contain: none !important;
            scale: var(--cc-scale-dock) !important;
            transform-origin: top center !important;
        }
        .game-dock.hidden-dock {
            transform: translateY(-100%) !important; 
        }
        
        /* El juego envuelve todos los botones en .dock-scroll (y el primero
           además en .dock-poke-wrap). Los disolvemos para que cada botón sea
           un item directo del flexbox del dock y nada se quede fuera del marco. */
        .game-dock .dock-scroll, .game-dock .dock-poke-wrap { display: contents !important; }

        .game-dock > *, .game-dock .dock-btn {
            background: #0a1220 !important;
            border: 1px solid #1c3659 !important;
            border-radius: 6px !important;
            padding: 0 !important; 
            margin: 0 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: all 0.2s ease !important;
            color: #94a3b8 !important;
            text-decoration: none !important;
            width: auto !important;  
            height: auto !important; 
            min-width: 26px !important;
            min-height: 26px !important;
            max-width: 140px !important;
            max-height: 42px !important;
            flex: 0 1 auto !important;
            box-sizing: border-box !important;
            box-shadow: none !important;
            cursor: pointer !important;
            position: relative !important; 
        }
        
        .game-dock > *:hover, .game-dock .dock-btn:hover {
            background: rgba(59, 130, 246, 0.2) !important;
            border-color: #3b82f6 !important;
            transform: translateY(-2px) !important;
            z-index: 100 !important; 
        }
        
        .game-dock img {
            max-width: 14px !important; 
            max-height: 14px !important;
            width: auto !important;
            height: auto !important;
            object-fit: contain !important;
            display: block !important;
            background: transparent !important;
            filter: none !important;
            margin: 0 auto !important;
        }

        /* DOCK con glassmorphism: mismo lenguaje visual que la capture bar y la
           botonera del script de mercado, pero SIN lineas: sin borde, solo el
           brillo superior del cristal y una sombra suave. Mas translucido que la
           capture bar para que se note el fondo del juego.
           El selector lleva [class] a proposito: el juego impose su borde dorado
           con "nav.game-dock", que tiene mas especificidad que un .game-dock a
           secas, y hay que ganarle para poder quitarlo. */
        .game-dock[class]::before {
            /* El juego dibuja un marco dorado aparte con un pseudo-elemento.
               Poner border:none en el dock no lo quita: hay que anular el
               pseudo-elemento entero. */
            content: none !important;
            display: none !important;
        }
        .game-dock[class] {
            background: rgba(30, 41, 59, 0.55) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border: none !important;
            border-radius: 14px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 6px 16px rgba(0, 0, 0, 0.2) !important;
        }

        /* Botones: un gris translucido plano, igual que la botonera de mercado.
           Sin color por sprite y sin degradado, para que la barra se lea limpia. */
        .game-dock .dock-btn {
            background: rgba(15, 23, 42, 0.5) !important;
            border: 1px solid rgba(148, 178, 214, 0.14) !important;
            border-radius: 8px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12) !important;
        }
        /* Hover contenido: el juego lo subia 2px y lo ponia azul brillante, eso
           era demasiado. Aqui solo se aclara un poco y sube 1px. */
        .game-dock .dock-btn:hover {
            background: rgba(38, 54, 77, 0.62) !important;
            border-color: rgba(148, 178, 214, 0.3) !important;
            transform: translateY(-1px) !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16) !important;
        }
        /* La flecha de plegar no es un boton de accion: se queda en cristal neutro. */
        .game-dock > *:not(.dock-btn):not(.dock-scroll) {
            background: rgba(15, 23, 42, 0.45) !important;
            border: 1px solid rgba(148, 178, 214, 0.14) !important;
            border-radius: 8px !important;
        }

        /* Oculta etiquetas de texto dentro de los botones sin tocar badges,
           flechas ni el contador privado de este script. */
        .game-dock .dock-btn > span:not(.dock-badge):not(.dock-news-arrow):not(.script-private-chat-badge),
        .game-dock .dock-btn > div:not(.poke-menu):not(.script-shop-menu) {
            display: none !important; 
        }
        
        /* Un solo contador en toda la barra: el del juego (.dock-badge) y el de
           este script (.script-private-chat-badge) comparten exactamente el mismo
           diseño, para que no haya dos estilos distintos. El juego sigue
           alimentando su numero, solo cambia su aspecto. */
        .game-dock .badge, .game-dock .dock-badge, .game-dock [style*="background: red"],
        .game-dock > * > span.script-private-chat-badge {
            position: absolute !important;
            z-index: 130 !important;
            top: -6px !important; right: -6px !important;
            width: auto !important; min-width: 15px !important; max-width: 26px !important;
            height: 15px !important; min-height: 15px !important;
            box-sizing: border-box !important;
            display: grid !important; place-items: center !important;
            padding: 0 3px !important; margin: 0 !important; overflow: hidden !important;
            color: #fff !important;
            background: linear-gradient(180deg, #ff5269, #d91435) !important;
            border: 1px solid #ffc0c9 !important;
            border-radius: 999px !important;
            box-shadow: 0 0 0 1px #4b0712, 0 0 8px rgba(255, 41, 75, 0.82) !important;
            font: 900 8px/1 'Segoe UI', sans-serif !important;
            text-align: center !important;
            text-shadow: 0 1px #740012 !important;
            pointer-events: none !important;
        }
        .game-dock > *.script-private-chat-button.has-private-unread {
            border-color:#f43f5e !important;
            box-shadow:inset 0 0 0 1px rgba(244,63,94,.24),0 0 8px rgba(244,63,94,.34) !important;
        }

        /* --------------------------------------------------- */
        /* FIX Z-INDEX ABSOLUTO PARA SUBMENÚS                  */
        /* --------------------------------------------------- */
        /* Submenús (My Pokés, All Rare Pokés…): mismo cristal que el dock y que
           la capture bar, en lugar del fondo opaco con borde azul del juego. */
        .poke-menu:not(.script-shop-menu) {
            z-index: 99999 !important;
            background: rgba(30, 41, 59, 0.82) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border: 1px solid rgba(148, 178, 214, 0.18) !important;
            border-radius: 10px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 10px 25px rgba(0, 0, 0, 0.45) !important;
            width: max-content !important;
            height: auto !important;
            max-width: none !important;
            max-height: none !important;
        }
        .poke-menu:not(.script-shop-menu) .poke-menu-item {
            background: rgba(15, 23, 42, 0.45) !important;
            border: 1px solid rgba(148, 178, 214, 0.12) !important;
            border-radius: 7px !important;
            color: #dbeafe !important;
            transition: background-color 0.18s ease, border-color 0.18s ease !important;
        }
        .poke-menu:not(.script-shop-menu) .poke-menu-item:hover {
            background: rgba(38, 54, 77, 0.72) !important;
            border-color: rgba(148, 178, 214, 0.3) !important;
        }
        .poke-menu:not(.script-shop-menu)::before { background: transparent !important; }
        .script-shop-wrap { overflow:visible !important;contain:none !important;z-index:2147483645 !important; }
        .script-shop-menu {
            z-index: 2147483646 !important;
            background: rgba(30, 41, 59, 0.82) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border: 1px solid rgba(148, 178, 214, 0.18) !important;
            border-radius: 10px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 10px 25px rgba(0, 0, 0, 0.45) !important;
        }
        .script-shop-menu[hidden] { display:none !important; }

        /* Botones de ocultar/mostrar el dock. El de dentro del dock lo esconde y
           la píldora de fuera, que es un elemento aparte, lo muestra: si esta
           estuviera dentro del dock se iría con él al deslizarse y no habría
           forma de recuperarlo. SVG de flecha, no el ojo de la capture bar. */
        #dock-toggle-btn, #dock-show-btn {
            position: absolute !important;
            /* top: auto es deliberado: si quedara un top de una versión previa
               (o del juego) pondría el botón arriba y, al estar fijados top y
               bottom a la vez, ganaría el top. */
            top: auto !important;
            /* -34 y no -14: el botón mide 26 de alto, así que con -14 solo
               cuelgaría 15 px por debajo y el resto se solaparía con el dock.
               Con -34 queda entero debajo, con 8 px de separación. */
            bottom: -34px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            width: 34px !important; height: 26px !important;
            display: grid !important; place-items: center !important; padding: 0 !important;
            background: rgba(30, 41, 59, 0.72) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border: 1px solid rgba(148, 178, 214, 0.18) !important;
            border-radius: 8px !important;
            color: #dbeafe !important; cursor: pointer !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 6px 16px rgba(0, 0, 0, 0.2) !important;
            z-index: 130 !important;
            transition: background-color 0.2s ease, color 0.2s ease, transform 0.25s ease, opacity 0.2s ease !important;
        }
        #dock-toggle-btn:hover, #dock-show-btn:hover { background: rgba(38, 54, 77, 0.8) !important; color: #facc15 !important; }
        #dock-toggle-btn svg, #dock-show-btn svg {
            width: 16px !important; height: 16px !important; display: block !important;
            fill: none !important; stroke: currentColor !important; stroke-width: 2.2 !important;
            stroke-linecap: round !important; stroke-linejoin: round !important;
        }
        #dock-show-btn {
            position: fixed !important; top: 4px !important; bottom: auto !important;
            transform: translateX(-50%) translateY(-200%) !important;
            opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
        }
        #dock-show-btn.is-visible {
            transform: translateX(-50%) translateY(0) !important;
            opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
        }
        /* Al ocultar el dock, su botón de ocultar se retira con él. Sin esto se
           queda en pantalla: el dock se desliza -100% pero el botón cuelga 34px
           por debajo, así que emerge por el borde inferior y acaba encima de la
           píldora de mostrar. */
        .game-dock.hidden-dock #dock-toggle-btn {
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }

        @media (max-width: 600px) {
            .game-dock {
                top: 0 !important;
                bottom: auto !important;
                left: 0 !important;
                right: 0 !important;
                margin-left: auto !important;
                margin-right: auto !important;
                transform: none !important;
                transform-origin: top center !important;
                border-radius: 0 0 12px 12px !important;
                border: 1px solid #1c3659 !important;
                border-top: none !important;
            }
            .game-dock.hidden-dock {
                transform: translateY(-100%) !important;
            }
            /* En móvil el dock baja a una sola línea; los botones de flecha
               mantienen la posición superior para no comerse espacio abajo. */
            #dock-toggle-btn {
                bottom: -34px !important;
                left: 50% !important;
                width: 34px !important;
                height: 26px !important;
                border-radius: 8px !important;
            }
            #dock-show-btn { top: 4px !important; bottom: auto !important; }
        }

        /* --------------------------------------------------- */
        /* CARDS PRINCIPALES (Hero & Mob) - REDUCIDAS 20%      */
        /* --------------------------------------------------- */
        /* La interfaz nativa permanece visible durante la carga. Solo se
           oculta cuando su reemplazo personalizado ya fue construido. */
        body.script-custom-hero-ready .cbt-card.cbt-hero,
        body.script-custom-mob-ready .cbt-card.cbt-mob { display: none !important; }
        
/* --------------------------------------------------------------- */
        /* CARD MODE · 7 TEMAS                                             */
        /* --------------------------------------------------------------- */
        /* Base comun. --tier lo fija el script segun el rareza del Pokemon,
           igual que hacia la version anterior con el borde. No hay ningun halo
           de color ni brightness alto en ninguna regla: el blur de fondo usa
           saturate(1.2) y el brillo viene solo de un inset de 1px. */
        .custom-poke-card {
            --tier:#f59e0b; --cc-red:#ef4444;
            position:relative; margin:0 auto 8px auto; z-index:1 !important;
            box-sizing:border-box; color:#fff; font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
            font-variant-numeric:tabular-nums;
        }
        .custom-poke-card.cc-mob { --tier:#ef4444 !important; }
        #my-custom-poke-card { zoom:var(--cc-scale-battle) !important; }
        #my-custom-mob-card { zoom:var(--cc-scale-enemy) !important; }

        /* halo de color: opcional y apagado por defecto */
        body.cc-allow-glow .cc-theme-1::before,
        body.cc-allow-glow .cc-theme-3,
        body.cc-allow-glow .cc-theme-4,
        body.cc-allow-glow .cc-theme-5,
        body.cc-allow-glow .cc-theme-6::after { box-shadow:0 0 20px -6px var(--tier) !important; }

        /* ---- piezas compartidas por todos los temas ---- */
        .cc-spr { display:block; object-fit:contain; }
        .cc-spr.pixel { image-rendering:pixelated; }
        .cc-spr.anim  { animation:ccBob 1.6s ease-in-out infinite; }
        @keyframes ccBob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-3px)} }

        .cc-ic { width:1em; height:1em; flex:0 0 auto; stroke:currentColor; fill:none;
                 stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round; }

        .cc-name { font-weight:800; display:flex; align-items:center; gap:4px; line-height:1.15; }
        .cc-name .star { width:11px; height:11px; color:#ffd700; }
        .cc-sub  { color:#a8bdd6; line-height:1.4; }
        .cc-sub b { color:#e6f0fc; }
        .cc-tier { display:inline-flex; align-items:center; gap:4px; font-size:8.5px; font-weight:800;
                   letter-spacing:.12em; text-transform:uppercase; color:var(--tier); }
        .cc-types { display:flex; gap:3px; flex-wrap:wrap; }
        /* Fila de tipos para los temas que antes no la pintaban: 1, 4, 6 y 7. */
        .cc-typerow { display:flex; margin-top:5px; }
        .cc-typerow-top { margin:-2px 11px 5px; }
        .cpc-type-badge { --cpc-type-color:#445e6d; padding:2px 6px; border-radius:5px;
            border:1px solid color-mix(in srgb,var(--cpc-type-color) 76%,#0b1220);
            font-size:9px; font-weight:800; line-height:1.15; text-transform:uppercase; letter-spacing:.3px;
            color:#f8fafc; background:color-mix(in srgb,var(--cpc-type-color) 68%,#0b1220);
            text-shadow:0 1px 1px rgba(0,0,0,.75); display:inline-flex; align-items:center; gap:4px; }

        .cpc-stats-grid { display:grid; gap:4px; }
        .cpc-stat-item { display:flex; align-items:center; gap:3px; padding:4px; border-radius:7px; min-width:0; overflow:hidden; }
        .cpc-stat-item .cc-ic { width:9px; height:9px; color:#7f96ae; }
        .cpc-stat-label { font-size:7.5px; font-weight:700; letter-spacing:.02em; color:#7f96ae;
                          text-transform:uppercase; white-space:nowrap; }
        .cpc-stat-value { margin-left:auto; font-size:10px; font-weight:800; white-space:nowrap; }

        .cpc-bar-wrapper { position:relative; height:14px; border-radius:7px; overflow:hidden; }
        .cpc-bar-fill { height:100%; border-radius:7px; transition:width .12s linear, background .3s ease; }
        .cpc-bar-text { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
            font-size:9px; font-weight:800; color:#fff; letter-spacing:.1px; z-index:2; pointer-events:none;
            text-shadow:0 1px 2px rgba(0,0,0,.92),0 0 1px rgba(0,0,0,.95); }
        .cpc-hp-high { background:linear-gradient(90deg,#00bc00,#50a150 62%,#74c874); }
        .cpc-hp-med  { background:linear-gradient(90deg,#a1a100,#c9b400 62%,#e2cd2c); }
        .cpc-hp-low  { background:linear-gradient(90deg,#910f0f,#bf0a0a 62%,#e24a4a); }
        .cpc-xp-bar  { background:linear-gradient(90deg,#2b56b8,#5a8dee 62%,#8fb6f6); }
        .cc-pow { display:flex; align-items:center; gap:6px; border-radius:999px;
                  color:#86efac; font-weight:800; letter-spacing:.3px; }
        .cc-pow .cc-ic { width:12px; height:12px; }
        .cc-pow .lbl { font-size:8.5px; letter-spacing:.12em; opacity:.8; }

        /* ================================================================ */
        /* TEMA 1 · PANEL TÉCNICO                                            */
        /* ================================================================ */
        .cc-theme-1 { width:214px; border-radius:6px; overflow:hidden;
            background:linear-gradient(180deg,rgba(17,25,36,.95),rgba(11,17,26,.95));
            border:1px solid rgba(148,178,214,.20);
            box-shadow:0 10px 26px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.06); }
        .cc-theme-1::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px;
            background:var(--tier); box-shadow:inset -1px 0 0 rgba(255,255,255,.35); }
        .cc-theme-1 .cc-in { padding:10px 11px 11px 14px; }
        .cc-theme-1 .cc-head { display:flex; gap:9px; align-items:center; }
        .cc-theme-1 .cc-spr { width:44px; height:44px; flex:0 0 44px; }
        .cc-theme-1 .cc-name { font-size:14px; }
        .cc-theme-1 .cc-sub { font-size:9.5px; margin-top:3px; color:#7f96ae; }
        .cc-theme-1 .cc-tier { margin-top:4px; padding:2px 6px; border-radius:3px;
            background:color-mix(in srgb,var(--tier) 14%,transparent);
            border:1px solid color-mix(in srgb,var(--tier) 42%,transparent); }
        .cc-theme-1 .cpc-stats-grid { grid-template-columns:repeat(3,1fr); margin-top:9px;
            background:rgba(148,178,214,.14); border:1px solid rgba(148,178,214,.14); border-radius:4px; gap:1px; }
        .cc-theme-1 .cpc-stat-item { background:rgba(13,19,26,.92); border-radius:0; padding:5px 4px; }
        .cc-theme-1 .cc-pow { margin-top:8px; padding:6px 8px; border-radius:4px; background:rgba(0,188,0,.09);
            border:1px solid rgba(0,188,0,.26); font-size:13px; }
        .cc-theme-1 .cc-pow .val { margin-left:auto; }
        .cc-theme-1 .cc-bars { margin-top:7px; display:flex; flex-direction:column; gap:5px; }
        .cc-theme-1 .cpc-bar-wrapper { background:rgba(3,8,16,.8); border:1px solid rgba(148,178,214,.16);
            height:12px; border-radius:3px; }

        /* ================================================================ */
        /* TEMA 2 · BENTO GLASS                                              */
        /* ================================================================ */
        .cc-theme-2 { width:222px; padding:9px; border-radius:20px;
            background:linear-gradient(165deg,rgba(148,178,214,.17),rgba(30,41,59,.46) 48%,rgba(10,16,26,.6));
            -webkit-backdrop-filter:blur(16px) saturate(1.2); backdrop-filter:blur(16px) saturate(1.2);
            border:1px solid color-mix(in srgb,var(--tier) 70%,transparent);
            box-shadow:inset 0 1px 0 rgba(255,255,255,.2),inset 0 -2px 6px rgba(0,0,0,.4),
                       8px 8px 20px rgba(0,0,0,.5),-4px -4px 14px rgba(255,255,255,.04); }
        .cc-theme-2::before { content:""; position:absolute; inset:0; border-radius:20px; pointer-events:none;
            background:radial-gradient(110% 65% at 15% -12%,color-mix(in srgb,var(--tier) 24%,transparent),transparent 62%); }
        .cc-theme-2 .cc-grid { display:grid; grid-template-columns:1fr 1fr; gap:7px; position:relative; }
        .cc-theme-2 .cc-cell { border-radius:13px; padding:8px;
            background:linear-gradient(180deg,rgba(255,255,255,.085),rgba(255,255,255,.022));
            border:1px solid rgba(255,255,255,.10); box-shadow:inset 0 1px 0 rgba(255,255,255,.16); }
        .cc-theme-2 .cc-art { grid-column:1; grid-row:1/3; display:flex; align-items:center; justify-content:center; padding:6px; }
        .cc-theme-2 .cc-art .cc-spr { width:100%; max-width:82px; }
        .cc-theme-2 .cc-name { font-size:14px; }
        .cc-theme-2 .cc-sub { font-size:9.5px; margin-top:3px; }
        .cc-theme-2 .cc-iv { display:flex; flex-direction:column; justify-content:center; align-items:center; gap:1px; }
        .cc-theme-2 .cc-iv .k { font-size:8.5px; font-weight:800; letter-spacing:.12em; color:#8ea5bf; }
        .cc-theme-2 .cc-iv .v { font-size:17px; font-weight:800; line-height:1; color:var(--tier); }
        .cc-theme-2 .cc-iv .v small { font-size:9px; color:#7f96ae; font-weight:700; }
        .cc-theme-2 .cc-wide { grid-column:1/3; display:flex; flex-direction:column; gap:6px; }
        .cc-theme-2 .cpc-bar-wrapper { background:rgba(3,8,16,.55); border:1px solid rgba(255,255,255,.12); height:12px; }
        .cc-theme-2 .cc-pow { align-self:center; padding:5px 10px; background:rgba(74,222,128,.14);
            border:1px solid rgba(74,222,128,.28); font-size:12px; }
        .cc-theme-2 .cpc-stats-grid { grid-column:1/3; grid-template-columns:repeat(6,1fr); }
        .cc-theme-2 .cpc-stat-item { flex-direction:column; gap:2px; padding:5px 2px; }

        /* ================================================================ */
        /* TEMA 3 · POKÉ-CARD                                                */
        /* ================================================================ */
        .cc-theme-3 { width:220px; border-radius:14px; padding:5px;
            background:linear-gradient(170deg,color-mix(in srgb,var(--tier) 62%,#101826),color-mix(in srgb,var(--tier) 16%,#0b1220));
            box-shadow:0 14px 34px rgba(0,0,0,.6); }
        .cc-theme-3 .cc-in { border-radius:10px; overflow:hidden; background:linear-gradient(180deg,#131c29,#0c131d);
            border:1px solid rgba(255,255,255,.09); }
        .cc-theme-3 .cc-head { display:flex; align-items:center; gap:7px; padding:7px 9px;
            background:linear-gradient(90deg,color-mix(in srgb,var(--tier) 30%,#16202e),#141d29);
            border-bottom:1px solid rgba(0,0,0,.5); }
        .cc-theme-3 .cc-name { font-size:13.5px; }
        .cc-theme-3 .cc-lv { margin-left:auto; font-size:10px; font-weight:800; color:#dce8f7;
            background:rgba(0,0,0,.35); padding:2px 6px; border-radius:999px; border:1px solid rgba(255,255,255,.14); }
        .cc-theme-3 .cc-art { position:relative; height:112px; display:flex; align-items:center; justify-content:center;
            background:radial-gradient(90% 80% at 50% 25%,color-mix(in srgb,var(--tier) 28%,#1d2a3c),#0d141e 72%); }
        .cc-theme-3 .cc-art::after { content:""; position:absolute; inset:0; pointer-events:none;
            background:linear-gradient(115deg,transparent 38%,rgba(255,255,255,.12) 46%,rgba(255,255,255,.03) 52%,transparent 60%); }
        .cc-theme-3 .cc-art .cc-spr { width:104px; position:relative; z-index:1; }
        .cc-theme-3 .cc-ribbon { position:absolute; top:7px; left:0; z-index:2; padding:2px 12px 2px 9px;
            font-size:8px; font-weight:800; letter-spacing:.14em; text-transform:uppercase;
            color:#0b1220; background:var(--tier); clip-path:polygon(0 0,100% 0,calc(100% - 7px) 100%,0 100%); }
        .cc-theme-3 .cc-hp { display:flex; align-items:center; gap:8px; padding:8px 9px 2px; }
        .cc-theme-3 .cc-hp .k { font-size:9px; font-weight:800; letter-spacing:.1em; color:#8ea5bf; }
        .cc-theme-3 .cc-hp .cpc-bar-wrapper { flex:1; height:11px; background:rgba(3,8,16,.85);
            border:1px solid rgba(148,178,214,.2); }
        .cc-theme-3 .cc-hp .v { font-size:10.5px; font-weight:800; }
        .cc-theme-3 .cpc-stats-grid { grid-template-columns:repeat(3,1fr); margin:7px 9px 0; }
        .cc-theme-3 .cpc-stat-item { background:rgba(255,255,255,.045); border:1px solid rgba(255,255,255,.07); }
        .cc-theme-3 .cc-foot { display:flex; gap:4px; justify-content:center; padding:8px 9px 9px; flex-wrap:wrap; }

        /* ================================================================ */
        /* TEMA 4 · ARC / RADIAL                                             */
        /* ================================================================ */
        .cc-theme-4 { width:212px; padding:13px 12px 12px; border-radius:20px; text-align:center;
            background:linear-gradient(170deg,rgba(148,178,214,.16),rgba(28,38,54,.6) 50%,rgba(10,16,26,.72));
            -webkit-backdrop-filter:blur(15px) saturate(1.2); backdrop-filter:blur(15px) saturate(1.2);
            border:1px solid color-mix(in srgb,var(--tier) 65%,transparent);
            box-shadow:inset 0 1px 0 rgba(255,255,255,.2),8px 8px 22px rgba(0,0,0,.5),-4px -4px 14px rgba(255,255,255,.04); }
        .cc-theme-4 .cc-ring { position:relative; width:118px; height:118px; margin:0 auto; }
        .cc-theme-4 .cc-ring svg { position:absolute; inset:0; transform:rotate(-90deg); }
        .cc-theme-4 .cc-ring .trk { fill:none; stroke:rgba(255,255,255,.09); stroke-width:7; }
        .cc-theme-4 .cc-ring .fil { fill:none; stroke-width:7; stroke-linecap:round; stroke:var(--tier); }
        .cc-theme-4 .cc-ring .fil.cc-xp { stroke:#5a8dee; stroke-width:3; }
        .cc-theme-4 .cc-center { position:absolute; inset:0; display:flex; flex-direction:column;
            align-items:center; justify-content:center; gap:1px; }
        .cc-theme-4 .cc-center .cc-spr { width:66px; height:66px; }
        .cc-theme-4 .cc-center .pct { font-size:15px; font-weight:800; line-height:1; color:#fff;
            text-shadow:0 1px 4px rgba(0,0,0,.8); }
        .cc-theme-4 .cc-center .cap { font-size:8px; font-weight:800; letter-spacing:.14em; color:#9db3cc; }
        .cc-theme-4 .cc-name { margin-top:10px; font-size:15px; justify-content:center; }
        .cc-theme-4 .cc-sub { margin-top:3px; font-size:9.5px; }
        .cc-theme-4 .cpc-stats-grid { grid-template-columns:repeat(6,1fr); margin-top:10px; }
        .cc-theme-4 .cpc-stat-item { flex-direction:column; gap:2px; padding:5px 1px;
            background:linear-gradient(180deg,rgba(255,255,255,.085),rgba(255,255,255,.022));
            border:1px solid rgba(255,255,255,.09); }
        .cc-theme-4 .cpc-stat-label { font-size:7px; }
        .cc-theme-4 .cpc-stat-value { font-size:10px; margin:0; }
        .cc-theme-4 .cc-pow { margin-top:9px; justify-content:center; padding:6px;
            background:linear-gradient(180deg,rgba(74,222,128,.2),rgba(16,185,129,.07));
            border:1px solid rgba(74,222,128,.34); font-size:12.5px; }

        /* ================================================================ */
        /* TEMA 5 · COMPACTO PLEGABLE                                        */
        /* ================================================================ */
        .cc-theme-5 { width:220px; border-radius:14px; overflow:hidden;
            background:linear-gradient(165deg,rgba(148,178,214,.15),rgba(28,38,54,.58) 50%,rgba(10,16,26,.68));
            -webkit-backdrop-filter:blur(14px) saturate(1.2); backdrop-filter:blur(14px) saturate(1.2);
            border:1px solid color-mix(in srgb,var(--tier) 62%,transparent);
            box-shadow:inset 0 1px 0 rgba(255,255,255,.18),7px 7px 18px rgba(0,0,0,.5),-4px -4px 12px rgba(255,255,255,.04); }
        .cc-theme-5 .cc-top { display:flex; align-items:center; gap:9px; padding:9px 9px 9px 11px; }
        .cc-theme-5 .cc-spr { width:38px; height:38px; flex:0 0 38px; }
        .cc-theme-5 .cc-name { font-size:13.5px; }
        .cc-theme-5 .cc-name .dot { width:7px; height:7px; border-radius:50%; background:var(--tier); }
        .cc-theme-5 .cc-sub { margin-top:2px; display:flex; align-items:center; gap:6px; font-size:9.5px; }
        .cc-theme-5 .cc-mini { margin-top:3px; height:5px; border-radius:3px; background:rgba(3,8,16,.7);
            overflow:hidden; box-shadow:inset 0 1px 2px rgba(0,0,0,.6); }
        .cc-theme-5 .cc-mini .cc-spr { width:100%; height:100%; }
        .cc-theme-5 .cc-btn { flex:0 0 auto; width:26px; height:26px; border-radius:8px; display:flex;
            align-items:center; justify-content:center; color:#cfe0f5; background:rgba(255,255,255,.07);
            border:1px solid rgba(255,255,255,.14); cursor:pointer; transition:background .18s ease,transform .18s ease; }
        .cc-theme-5 .cc-btn:hover { background:rgba(255,255,255,.14); }
        .cc-theme-5 .cc-btn:active { transform:scale(.92); }
        .cc-theme-5 .cc-btn .cc-ic { width:13px; height:13px; transition:transform .22s cubic-bezier(.4,1.4,.5,1); }
        .cc-theme-5.open .cc-btn .cc-ic { transform:rotate(180deg); }
        .cc-theme-5 .cc-more { display:grid; grid-template-rows:0fr; opacity:0;
            transition:grid-template-rows .26s cubic-bezier(.4,0,.2,1),opacity .2s ease; }
        .cc-theme-5.open .cc-more { grid-template-rows:1fr; opacity:1; }
        .cc-theme-5 .cc-more-in { overflow:hidden; min-height:0; }
        .cc-theme-5 .cc-div { height:1px; margin:0 11px;
            background:linear-gradient(90deg,transparent,rgba(148,178,214,.28),transparent); }
        .cc-theme-5 .cc-body { padding:9px 11px 10px; }
        .cc-theme-5 .cc-brow { display:flex; align-items:center; gap:7px; margin-bottom:6px; }
        .cc-theme-5 .cc-brow .k { font-size:8.5px; font-weight:800; letter-spacing:.1em; color:#8ea5bf; width:24px; }
        .cc-theme-5 .cc-brow .cpc-bar-wrapper { flex:1; background:rgba(3,8,16,.6); border:1px solid rgba(255,255,255,.1); height:12px; }
        .cc-theme-5 .cc-brow .v { font-size:10px; font-weight:800; width:74px; text-align:right; }
        .cc-theme-5 .cpc-stats-grid { grid-template-columns:repeat(3,1fr); margin-top:8px; }
        .cc-theme-5 .cpc-stat-item { background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.022));
            border:1px solid rgba(255,255,255,.09); }

        /* ================================================================ */
        /* TEMA 6 · LÍNEA MINIMAL                                            */
        /* ================================================================ */
        .cc-theme-6 { width:232px; padding:9px 11px 11px; border-radius:14px;
            background:rgba(22,32,46,.5);
            -webkit-backdrop-filter:blur(16px) saturate(1.2); backdrop-filter:blur(16px) saturate(1.2);
            border:1px solid rgba(255,255,255,.09);
            box-shadow:inset 0 1px 0 rgba(255,255,255,.13),0 10px 24px rgba(0,0,0,.45); }
        .cc-theme-6::after { content:""; position:absolute; left:11px; right:11px; bottom:0; height:2px;
            border-radius:2px; background:linear-gradient(90deg,var(--tier),transparent); }
        .cc-theme-6 .cc-top { display:flex; align-items:center; gap:10px; }
        .cc-theme-6 .cc-ring2 { position:relative; width:46px; height:46px; flex:0 0 46px; }
        .cc-theme-6 .cc-ring2 svg { position:absolute; inset:0; transform:rotate(-90deg); }
        .cc-theme-6 .cc-ring2 .trk { fill:none; stroke:rgba(255,255,255,.10); stroke-width:2.6; }
        .cc-theme-6 .cc-ring2 .fil { fill:none; stroke:var(--tier); stroke-width:2.6; stroke-linecap:round; }
        .cc-theme-6 .cc-ring2 .cc-spr { position:absolute; inset:5px; width:36px; height:36px; }
        .cc-theme-6 .cc-name { font-size:14px; }
        .cc-theme-6 .cc-sub { margin-top:2px; font-size:9.5px; }
        .cc-theme-6 .cc-pow { flex:0 0 auto; text-align:right; }
        .cc-theme-6 .cc-pow .val { font-size:16px; font-weight:800; line-height:1; color:#eaf2fb; }
        .cc-theme-6 .cc-pow .lbl { display:flex; align-items:center; gap:3px; justify-content:flex-end;
            margin-top:2px; font-size:8px; color:#7f96ae; }
        .cc-theme-6 .cc-rows { margin-top:9px; border-top:1px solid rgba(255,255,255,.08); }
        .cc-theme-6 .cc-row { display:flex; align-items:center; gap:8px; padding:4px 0;
            border-bottom:1px solid rgba(255,255,255,.055); }
        .cc-theme-6 .cc-row:last-child { border-bottom:none; }
        .cc-theme-6 .cc-row .cc-ic { width:12px; height:12px; color:#7f96ae; }
        .cc-theme-6 .cc-row .k { flex:1; font-size:9.5px; font-weight:700; letter-spacing:.05em;
            color:#93aac4; text-transform:uppercase; }
        .cc-theme-6 .cc-row .v { font-size:11px; font-weight:800; }
        .cc-theme-6 .cc-bars { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
        .cc-theme-6 .cpc-bar-wrapper { background:rgba(3,8,16,.6); border:1px solid rgba(255,255,255,.1); height:12px; }

        /* ================================================================ */
        /* TEMA 7 · ESCENARIO ANIMADO                                        */
        /* ================================================================ */
        .cc-theme-7 { width:218px; border-radius:14px; overflow:hidden;
            background:linear-gradient(180deg,#121b27,#0b121c 72%);
            border:1px solid color-mix(in srgb,var(--tier) 60%,rgba(148,178,214,.16));
            box-shadow:0 12px 28px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.07); }
        .cc-theme-7 .cc-head { display:flex; align-items:center; gap:7px; padding:7px 9px;
            background:color-mix(in srgb,var(--tier) 16%,#141d29); border-bottom:1px solid rgba(0,0,0,.55); }
        .cc-theme-7 .cc-name { font-size:13px; }
        .cc-theme-7 .cc-tier { margin-left:auto; padding:2px 6px; border-radius:3px;
            background:color-mix(in srgb,var(--tier) 15%,transparent);
            border:1px solid color-mix(in srgb,var(--tier) 40%,transparent); }
        .cc-theme-7 .cc-stage { position:relative; height:126px; display:flex; align-items:flex-end;
            justify-content:center; overflow:hidden;
            background:radial-gradient(70% 55% at 50% 88%,color-mix(in srgb,var(--tier) 15%,transparent),transparent 70%),
                       linear-gradient(180deg,#0f1823 0%,#0a1119 100%); }
        .cc-theme-7 .cc-stage::before { content:""; position:absolute; left:8%; right:8%; bottom:12px; height:1px;
            background:linear-gradient(90deg,transparent,rgba(148,178,214,.32),transparent); }
        .cc-theme-7 .cc-floor { position:absolute; bottom:8px; left:50%; transform:translateX(-50%);
            width:96px; height:14px; border-radius:50%;
            background:radial-gradient(closest-side,rgba(0,0,0,.55),transparent 75%); }
        .cc-theme-7 .cc-stage .cc-spr { position:relative; z-index:1; width:104px; margin-bottom:10px;
            transform-origin:50% 100%; animation:ccBob 1.6s ease-in-out infinite; }
        .cc-theme-7 .cc-stage .cc-spr.static { animation:none; }
        .cc-theme-7 .cc-hud { position:absolute; left:8px; right:8px; top:8px; z-index:2;
            display:flex; align-items:center; gap:5px; }
        .cc-theme-7 .cc-hud .cpc-bar-wrapper { flex:1; height:9px; background:rgba(2,6,12,.8);
            border:1px solid rgba(148,178,214,.22); }
        .cc-theme-7 .cc-hud .v { font-size:9.5px; font-weight:800; color:#dce9f8; }
        .cc-theme-7 .cc-body { padding:8px 9px 9px; }
        .cc-theme-7 .cpc-stats-grid { grid-template-columns:repeat(3,1fr); margin-bottom:7px; }
        .cc-theme-7 .cpc-stat-item { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.07); }
        .cc-theme-7 .cc-brow { display:flex; align-items:center; gap:6px; margin-top:5px; }
        .cc-theme-7 .cc-brow .k { font-size:7.5px; font-weight:800; letter-spacing:.1em; color:#7f96ae; width:22px; }
        .cc-theme-7 .cc-brow .cpc-bar-wrapper { flex:1; height:10px; background:rgba(2,6,12,.75);
            border:1px solid rgba(148,178,214,.2); }
        .cc-theme-7 .cc-brow .v { font-size:9.5px; font-weight:800; color:#dce9f8; width:66px; text-align:right; }

        /* ---- CARD DEL ENEMIGO · una sola estructura, 7 layouts ---- */
        /* El enemigo solo tiene nombre, sprite y % de HP. El HTML es siempre el
           mismo (cc-mob-name / cc-mob-art / cc-mobbar) y lo que cambia de un
           tema a otro es solo el CSS de aqui abajo. */
        .custom-poke-card.cc-mob { position:relative; margin:0 auto; width:158px; padding:11px;
            display:flex !important; flex-direction:column; align-items:center; justify-content:center;
            gap:9px; box-sizing:border-box; text-align:center;
            background:linear-gradient(160deg,rgba(148,178,214,.15),rgba(30,41,59,.44) 52%,rgba(9,14,23,.6));
            -webkit-backdrop-filter:blur(14px) saturate(1.2); backdrop-filter:blur(14px) saturate(1.2);
            border:1px solid rgba(239,68,68,.5); color:#fff;
            box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 10px 26px rgba(0,0,0,.5); }
        .custom-poke-card.cc-mob .cc-mob-name { font-size:14px; font-weight:800; color:#ffc9c9;
            letter-spacing:.02em; text-shadow:0 1px 3px rgba(0,0,0,.8); }
        .custom-poke-card.cc-mob .cc-mob-art { position:relative; display:flex; align-items:center; justify-content:center; }
        .custom-poke-card.cc-mob .cc-mob-art .cc-spr { width:104px; height:104px; object-fit:contain; }
        .custom-poke-card.cc-mob .cc-enemy-canvas { display:flex; align-items:center; justify-content:center; }
        .custom-poke-card.cc-mob .mob-sprite-canvas { width:104px; height:104px; image-rendering:pixelated; }
        .custom-poke-card.cc-mob .cc-mobbar { display:flex; align-items:center; gap:6px; width:100%; }
        .custom-poke-card.cc-mob .cc-mobbar .k { font-size:8.5px; font-weight:800; letter-spacing:.12em;
            color:#ff8f8f; flex:0 0 auto; }
        .custom-poke-card.cc-mob .cc-mobbar .cpc-bar-wrapper { flex:1; height:13px; background:rgba(3,8,16,.55);
            border:1px solid rgba(255,255,255,.12); }
        .custom-poke-card.cc-mob .cc-mobbar .v { font-size:10.5px; font-weight:800; color:#ffd7d7; flex:0 0 auto; }
        /* anillo de HP para los temas 4 y 6 */
        .custom-poke-card.cc-mob .cc-mob-art.ringed .cc-mob-ring { position:absolute; inset:0;
            width:100%; height:100%; transform:rotate(-90deg); }
        .custom-poke-card.cc-mob .cc-mob-art.ringed .cc-mob-ring .trk { fill:none; stroke:rgba(255,255,255,.1); stroke-width:2.6; }
        .custom-poke-card.cc-mob .cc-mob-art.ringed .cc-mob-ring .fil { fill:none; stroke:#e0453f;
            stroke-width:2.6; stroke-linecap:round; }
        .custom-poke-card.cc-mob .cc-mob-art.ringed .cc-mob-art-in { position:relative; display:flex; }
        .custom-poke-card.cc-mob .cc-mob-art.ringed .cc-spr { width:72px; height:72px; }
        .custom-poke-card.cc-mob .cc-mob-art.ringed .cc-mob-pct { position:absolute; bottom:-5px; left:50%;
            transform:translateX(-50%); font-size:11px; font-weight:800; color:#ffd7d7; }

        /* tema 1: el mismo lenguaje industrial, con su raíl */
        .custom-poke-card.cc-mob.cc-theme-1 { width:160px; border-radius:6px; align-items:stretch; text-align:left;
            background:linear-gradient(180deg,rgba(17,25,36,.95),rgba(11,17,26,.95));
            border-color:rgba(148,178,214,.2); gap:7px; }
        .custom-poke-card.cc-mob.cc-theme-1::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px;
            background:var(--tier); box-shadow:inset -1px 0 0 rgba(255,255,255,.35); }
        .custom-poke-card.cc-mob.cc-theme-1 .cc-mob-name { text-align:left; padding-left:9px; }
        .custom-poke-card.cc-mob.cc-theme-1 .cc-mob-art { width:96px; height:96px; margin:2px auto 0; }
        .custom-poke-card.cc-mob.cc-theme-1 .cc-mob-art .cc-spr { width:92px; height:92px; }
        /* tema 2 */
        .custom-poke-card.cc-mob.cc-theme-2 { width:150px; border-radius:18px; }
        .custom-poke-card.cc-mob.cc-theme-2 .cc-mob-art .cc-spr { width:96px; height:96px; }
        /* tema 3: marco TCG con cabecera y arte */
        .custom-poke-card.cc-mob.cc-theme-3 { width:158px; border-radius:14px; padding:5px; gap:0;
            background:linear-gradient(170deg,rgba(220,38,38,.5),rgba(58,20,20,.72));
            border:1px solid rgba(239,68,68,.4); }
        .custom-poke-card.cc-mob.cc-theme-3 .cc-in { width:100%; border-radius:10px; overflow:hidden;
            background:linear-gradient(180deg,#1a1418,#120e12); border:1px solid rgba(255,255,255,.08); }
        .custom-poke-card.cc-mob.cc-theme-3 .cc-head { padding:7px 9px; background:linear-gradient(90deg,rgba(220,38,38,.4),#17131a);
            border-bottom:1px solid rgba(0,0,0,.5); }
        .custom-poke-card.cc-mob.cc-theme-3 .cc-mob-art { height:104px;
            background:radial-gradient(90% 80% at 50% 30%,rgba(220,38,38,.26),#140f13 72%); }
        .custom-poke-card.cc-mob.cc-theme-3 .cc-mob-art .cc-spr { width:94px; height:94px; }
        .custom-poke-card.cc-mob.cc-theme-3 .cc-hp { padding:9px; display:block; }
        .custom-poke-card.cc-mob.cc-theme-3 .cc-mobbar { margin-top:0; width:100%; }
        /* tema 4 y 5 */
        .custom-poke-card.cc-mob.cc-theme-4 { width:152px; border-radius:20px; }
        .custom-poke-card.cc-mob.cc-theme-4 .cc-mob-art { width:112px; height:112px; }
        .custom-poke-card.cc-mob.cc-theme-5 { width:186px; gap:0; align-items:stretch; text-align:left; }
        .custom-poke-card.cc-mob.cc-theme-5 .cc-mob-name { text-align:left; font-size:13px; }
        .custom-poke-card.cc-mob.cc-theme-5 .cc-mob-art { width:74px; height:74px; margin:0 auto; }
        .custom-poke-card.cc-mob.cc-theme-5 .cc-mob-art .cc-spr { width:70px; height:70px; }
        /* tema 6 */
        .custom-poke-card.cc-mob.cc-theme-6 { width:196px; border-radius:14px; gap:7px; }
        .custom-poke-card.cc-mob.cc-theme-6 .cc-mob-art { width:88px; height:88px; }
        /* tema 7: el escenario, con el sprite sobre el fondo oscuro */
        .custom-poke-card.cc-mob.cc-theme-7 { width:166px; border-radius:14px; gap:0; padding:0; align-items:stretch; }
        .custom-poke-card.cc-mob.cc-theme-7 .cc-mob-name { display:none; }
        .custom-poke-card.cc-mob.cc-theme-7 .cc-mob-art { height:112px; width:100%;
            background:radial-gradient(70% 55% at 50% 85%,rgba(220,38,38,.2),transparent 70%),#0d1218;
            border-bottom:1px solid rgba(0,0,0,.5); }
        .custom-poke-card.cc-mob.cc-theme-7 .cc-mob-art .cc-spr { width:96px; height:96px; }
        .custom-poke-card.cc-mob.cc-theme-7 .cc-mobbar { margin:9px 11px 10px; }

        /* ================================================================ */
        /* EFECTOS DE GOLPE Y DAÑO (raíz de la card, válido en los 7 temas) */
        /* ================================================================ */
        .custom-poke-card.cc-hit { animation:ccCardHit .44s cubic-bezier(.3,1.45,.5,1), ccFlashWhite .44s ease-out; }
        @keyframes ccCardHit {
            0%{transform:translateX(0) scale(1)}
            18%{transform:translateX(8px) scale(1.04)}
            40%{transform:translateX(-5px) scale(.985)}
            64%{transform:translateX(2.5px) scale(1.008)}
            100%{transform:translateX(0) scale(1)} }
        @keyframes ccFlashWhite { 0%{filter:brightness(2.6) saturate(.35)} 100%{filter:none} }
        .custom-poke-card.cc-hurt { animation:ccCardHurt .42s ease-out, ccFlashRed .42s ease-out; }
        @keyframes ccCardHurt {
            0%,100%{transform:translateX(0) rotate(0)}
            14%{transform:translateX(-7px) rotate(-.7deg)}
            32%{transform:translateX(6px) rotate(.6deg)}
            52%{transform:translateX(-4px) rotate(-.3deg)}
            72%{transform:translateX(3px)}
            88%{transform:translateX(-1.5px)} }
        @keyframes ccFlashRed {
            0%{filter:brightness(1.75) sepia(1) saturate(7) hue-rotate(-38deg)}
            60%{filter:brightness(1.25) sepia(.6) saturate(4) hue-rotate(-38deg)}
            100%{filter:none} }
        .cc-fx-ring { position:absolute; inset:0; border-radius:inherit; pointer-events:none; z-index:6;
            border:2px solid rgba(255,255,255,.9); opacity:0; }
        .cc-fx-ring.go { animation:ccRingOut .42s cubic-bezier(.2,.8,.3,1); }
        @keyframes ccRingOut { 0%{opacity:.95;transform:scale(1)} 100%{opacity:0;transform:scale(1.06)} }
        .cc-fx-ring.red { border-color:rgba(255,90,90,.95); }
        .cc-fx-slash { position:absolute; left:50%; top:8%; width:2px; height:84%; border-radius:2px;
            pointer-events:none; z-index:7; opacity:0; transform-origin:50% 50%;
            background:linear-gradient(180deg,transparent,rgba(255,255,255,.95),transparent);
            transform:translateX(-50%) rotate(-16deg); }
        .cc-fx-slash.go { animation:ccSlashOut .3s ease-out; }
        @keyframes ccSlashOut {
            0%{opacity:1;transform:translateX(-50%) rotate(-16deg) scaleY(.2)}
            100%{opacity:0;transform:translateX(-50%) rotate(-16deg) scaleY(1.15)} }

        /* ================================================================ */
        /* CAPTURA: capa sobre la fila de cards + sprites del juego         */
        /* ================================================================ */
        /* La capa se monta como hermana de las dos cards dentro de .cbt-row,
           asi que el mismo efecto sirve para los 7 temas sin tocar su CSS. */
        .cc-capture-layer { position:absolute; inset:0; pointer-events:none; z-index:40; overflow:hidden; }
        .cc-capture-layer .cc-fly { position:absolute; width:64px; height:64px; margin:-32px 0 0 -32px;
            background-repeat:no-repeat; background-size:192px 192px; background-position:0 0;
            opacity:0; image-rendering:pixelated; filter:drop-shadow(0 3px 7px rgba(0,0,0,.65));
            will-change:transform; }
        @keyframes ccBallSpin {
            0%{background-position:0 0} 12.5%{background-position:-64px 0} 25%{background-position:-128px 0}
            37.5%{background-position:-128px -64px} 50%{background-position:-128px -128px}
            62.5%{background-position:-64px -128px} 75%{background-position:0 -128px}
            87.5%{background-position:0 -64px} 100%{background-position:0 0} }
        .cc-capture-layer .cc-fly.go { animation:ccBallFly 1s linear forwards, ccBallSpin .42s steps(1,end) infinite; }
        @keyframes ccBallFly {
            0%  { opacity:0; transform:translate3d(0,0,0) scale(.66,.58); animation-timing-function:cubic-bezier(.12,.7,.3,1) }
            9%  { opacity:1; transform:translate3d(calc(var(--dx)*.05),calc(var(--dy)*.05 - 4px),0) rotate(14deg) scale(.94,1.1) }
            32% { transform:translate3d(calc(var(--dx)*.32),calc(var(--dy)*.32 - 54px),0) rotate(26deg) scale(1,1) }
            58% { transform:translate3d(calc(var(--dx)*.60),calc(var(--dy)*.60 - 62px),0) rotate(34deg) scale(1,1) }
            82% { transform:translate3d(calc(var(--dx)*.88),calc(var(--dy)*.88 - 26px),0) rotate(24deg) scale(1,.98);
                  animation-timing-function:cubic-bezier(.5,0,.85,.4) }
            93% { transform:translate3d(var(--dx),var(--dy),0) rotate(6deg) scale(1.16,.72) }
            100%{ opacity:1; transform:translate3d(var(--dx),var(--dy),0) scale(.94,.72) } }
        .cc-capture-layer .cc-shadow { position:absolute; width:52px; height:14px; margin:-7px 0 0 -26px;
            border-radius:50%; background:radial-gradient(closest-side,rgba(0,0,0,.6),transparent 78%);
            opacity:0; will-change:transform,opacity; }
        .cc-capture-layer .cc-shadow.go { animation:ccShadowFly 1s linear forwards; }
        @keyframes ccShadowFly {
            0%{opacity:0;transform:translate3d(0,0,0) scale(.45)} 10%{opacity:.55;transform:translate3d(calc(var(--dx)*.05),var(--dy),0) scale(.5)}
            32%{opacity:.18;transform:translate3d(calc(var(--dx)*.32),var(--dy),0) scale(.62)}
            58%{opacity:.22;transform:translate3d(calc(var(--dx)*.60),var(--dy),0) scale(.78)}
            82%{opacity:.45;transform:translate3d(calc(var(--dx)*.88),var(--dy),0) scale(.98)}
            100%{opacity:.62;transform:translate3d(var(--dx),var(--dy),0) scale(1.18)} }
        .cc-capture-layer .cc-sheet { position:absolute; width:64px; height:96px; margin:-48px 0 0 -32px;
            background-repeat:no-repeat; background-size:64px 5760px; opacity:0; image-rendering:pixelated; }
        .cc-capture-layer .cc-sheet.cc-catch { opacity:1; animation:ccSheet 3s steps(60) forwards; }
        .cc-capture-layer .cc-sheet.cc-broke { opacity:1; animation:ccSheetB 2.2s steps(44) forwards; }
        @keyframes ccSheet { from{background-position-y:0} to{background-position-y:-5760px} }
        @keyframes ccSheetB{ from{background-position-y:0} to{background-position-y:-4224px} }
        .cc-capture-layer .cc-impact { position:absolute; width:96px; height:96px; margin:-48px 0 0 -48px;
            border-radius:50%; border:2px solid rgba(255,255,255,.85); opacity:0; }
        .cc-capture-layer .cc-impact.go { animation:ccImpact .5s cubic-bezier(.15,.75,.3,1); }
        @keyframes ccImpact { 0%{opacity:.9;transform:scale(.32)} 70%{opacity:.35;transform:scale(1.05)} 100%{opacity:0;transform:scale(1.22)} }
        .cc-capture-layer .cc-recoil { animation:ccRecoil .34s cubic-bezier(.3,1.5,.5,1); }
        @keyframes ccRecoil { 0%{transform:none} 30%{transform:translateY(-3px) scale(.985)} 100%{transform:none} }
        .custom-poke-card.cc-captured { filter:grayscale(.9) brightness(.5); opacity:.5; }
        .custom-poke-card.cc-shaking { animation:ccShake .38s ease-out; }
        @keyframes ccShake {
            0%,100%{transform:translateX(0)} 20%{transform:translateX(-5px)}
            45%{transform:translateX(4px)} 70%{transform:translateX(-2px)} }
        .cc-cap-badge { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:12;
            display:flex; align-items:center; gap:6px; padding:5px 11px; border-radius:999px; white-space:nowrap;
            font-size:9.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:#eaf2ff;
            background:rgba(8,13,20,.88); border:1px solid rgba(140,190,255,.5);
            box-shadow:0 6px 18px rgba(0,0,0,.5); opacity:0; pointer-events:none; }
        .cc-cap-badge img { width:14px; height:14px; image-rendering:pixelated; }
        .cc-cap-badge.go { animation:ccBadgeIn .4s cubic-bezier(.3,1.5,.5,1) forwards; }
        .cc-cap-badge.fail { border-color:rgba(255,120,120,.55); color:#ffd7d7; }
        .cc-cap-badge.fail.go { animation:ccBadgeOut 1.5s ease-out forwards; }
        @keyframes ccBadgeIn {
            0%{opacity:0;transform:translate(-50%,-50%) scale(.7)} 60%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}
            100%{opacity:1;transform:translate(-50%,-50%) scale(1)} }
        @keyframes ccBadgeOut {
            0%{opacity:1;transform:translate(-50%,-50%) scale(1)} 100%{opacity:0;transform:translate(-50%,-60%) scale(.9)} }
        .custom-poke-card.cc-win::after { content:""; position:absolute; inset:-5px; border-radius:16px;
            pointer-events:none; background:rgba(125,250,176,.2); animation:ccWinFlash .9s ease-out forwards; z-index:13; }
        @keyframes ccWinFlash {
            0%{opacity:1;box-shadow:0 0 0 3px rgba(125,250,176,.6)} 100%{opacity:0;box-shadow:0 0 0 3px rgba(125,250,176,0)} }

        /* CAPTURE BAR NATIVA — el juego la monta y desmonta segun haya salvajes,
           y antes el script la forzaba visible en cada ciclo, lo que producia el
           parpadeo. Ahora queda oculta de forma permanente y solo se usa como
           fuente de datos. visibility (y no display) para que el boton .market-cta
           que el juego anade dentro siga siendo utilizable. */
        .cap-panel { visibility: hidden !important; pointer-events: none !important; }
        .cap-panel .market-cta { visibility: visible !important; pointer-events: auto !important; }

        /* BARRA DE CAPTURA PROPIA — el glassmorphism (fondo, blur, saturate y el
           brillo superior inset) replica el de la botonera del script de mercado,
           medido sobre ella. Los dos tokens de abajo miden un chip y el gap para
           poder limitar el area de balls y pociones a dos filas exactas. */
        /* El contenedor exterior solo ancla y centra con flex; el interior lleva
           el aspecto y el zoom. Motivo: con zoom, un translateX(-50%) se resuelve
           sobre el ancho SIN ampliar y la barra se descentraba. Centrar por flex
           en un contenedor sin zoom no suffer ese problema. */
        .cc-cap-dock {
            position: fixed !important; left: 0 !important; right: 0 !important; bottom: 10px !important;
            display: flex !important; justify-content: center !important; align-items: flex-end !important;
            padding: 0 8px !important; box-sizing: border-box !important;
            z-index: 2147483000 !important; pointer-events: none !important;
            transition: transform 0.25s ease !important;
            will-change: transform !important;
        }
        .cc-cap-dock-inner {
            --cc-dock-chip-h: 23px; --cc-dock-chip-gap: 5px;
            /* zoom y no scale: scale rasteriza el texto ya ampliado y por eso los
               botones + y - lo dejaban borroso. zoom vuelve a rasterizar al tamaño
               final, asi que las letras se ven nitidas a cualquier escala. */
            zoom: var(--cc-scale-capture) !important;
            display: flex !important; align-items: center !important; gap: 8px !important;
            width: max-content !important; max-width: 100% !important; box-sizing: border-box !important;
            padding: 5px 7px !important;
            background: rgba(30, 41, 59, 0.72) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            border: 1px solid rgba(148, 178, 214, 0.22) !important; border-radius: 12px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 6px 16px rgba(0, 0, 0, 0.2) !important;
            font: 11px/1.2 'Segoe UI', Tahoma, sans-serif !important; color: #dbeafe !important;
            pointer-events: auto !important;
        }
        .cc-cap-dock.is-collapsed { transform: translateY(calc(100% + 18px)) !important; }
        .cc-cap-dock-eye {
            position: fixed !important; left: 50% !important; bottom: 10px !important;
            transform: translateX(-50%) translateY(calc(100% + 18px)) !important;
            display: grid !important; place-items: center !important; padding: 0 !important;
            width: 34px !important; height: 34px !important;
            border: 1px solid rgba(148, 178, 214, 0.22) !important; border-radius: 10px !important;
            background: rgba(30, 41, 59, 0.72) !important;
            -webkit-backdrop-filter: blur(10px) saturate(1.35) !important;
            backdrop-filter: blur(10px) saturate(1.35) !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 6px 16px rgba(0, 0, 0, 0.2) !important;
            color: #dbeafe !important; cursor: pointer !important; z-index: 2147483001 !important;
            opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
            transition: transform 0.25s ease, opacity 0.2s ease, visibility 0.2s ease !important;
        }
        .cc-cap-dock-eye.is-visible {
            transform: translateX(-50%) translateY(0) !important;
            opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
        }
        .cc-cap-dock-eye:hover { color: #facc15 !important; }
        .cc-cap-dock-eye .cc-dock-eye { width: 18px !important; height: 18px !important; }
        .cc-cap-dock-eye .cc-dock-eye-closed { display: none !important; }
        .cc-cap-dock-eye.is-visible .cc-dock-eye-open { display: none !important; }
        .cc-cap-dock-eye.is-visible .cc-dock-eye-closed { display: block !important; }

        .cc-cap-dock > * { pointer-events: auto !important; }
        .cc-cap-dock.is-stale .cc-dock-supplies, .cc-cap-dock.is-stale .cc-dock-wilds { opacity: 0.4 !important; }

        .cc-dock-sec { display: flex !important; align-items: center !important; gap: 5px !important; }
        .cc-dock-chips { display: flex !important; align-items: center !important; gap: var(--cc-dock-chip-gap) !important; }
        .cc-dock-sep { flex: none !important; width: 1px !important; align-self: stretch !important; background: rgba(148, 178, 214, 0.2) !important; }
        .cc-dock-empty { color: #94a3b8 !important; font-style: italic !important; padding: 0 3px !important; white-space: nowrap !important; }

        /* Ojo de mostrar/ocultar: mismo SVG que la botonera del script de mercado. */
        .cc-dock-eye-btn {
            flex: none !important; width: 24px !important; height: 24px !important;
            display: grid !important; place-items: center !important; padding: 0 !important;
            border: 1px solid rgba(148, 178, 214, 0.22) !important; border-radius: 7px !important;
            background: rgba(15, 23, 42, 0.55) !important; color: #dbeafe !important; cursor: pointer !important;
            transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease !important;
        }
        .cc-dock-eye-btn:hover { background: rgba(38, 54, 77, 0.75) !important; color: #facc15 !important; }
        .cc-dock-eye-btn:active { transform: scale(0.92) !important; }
        .cc-dock-eye { width: 15px !important; height: 15px !important; display: block !important; fill: none !important; stroke: currentColor !important; stroke-width: 1.8 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
        .cc-dock-eye-closed { display: none !important; }
        .cc-cap-dock.is-collapsed .cc-dock-eye-open { display: none !important; }
        .cc-cap-dock.is-collapsed .cc-dock-eye-closed { display: block !important; }

        .cc-dock-scale-btn {
            flex: none !important; width: 24px !important; height: 24px !important;
            display: grid !important; place-items: center !important; padding: 0 !important;
            border: 1px solid rgba(148, 178, 214, 0.22) !important; border-radius: 7px !important;
            background: rgba(15, 23, 42, 0.55) !important; color: #dbeafe !important; cursor: pointer !important;
            font: 800 13px/1 system-ui, sans-serif !important;
            transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease !important;
        }
        .cc-dock-scale-btn:hover { background: rgba(38, 54, 77, 0.75) !important; color: #ffffff !important; }
        .cc-dock-scale-btn:active { transform: scale(0.92) !important; }
        .cc-dock-scale-btn:disabled { opacity: 0.35 !important; cursor: default !important; transform: none !important; background: rgba(15, 23, 42, 0.55) !important; color: #dbeafe !important; }

        /* Balls y pociones comparten contenedor y envuelven a dos filas como
           maximo; si aun así no cabe, la tercera fila se alcanza con scroll. */
        .cc-dock-supplies .cc-dock-chips {
            flex-wrap: wrap !important; max-width: min(40vw, 440px) !important;
            max-height: calc(var(--cc-dock-chip-h) * 2 + var(--cc-dock-chip-gap)) !important;
            overflow-y: auto !important; overflow-x: hidden !important;
        }
        .cc-dock-supplies .cc-dock-chips::-webkit-scrollbar { width: 3px !important; }
        .cc-dock-supplies .cc-dock-chips::-webkit-scrollbar-thumb { background: rgba(148, 178, 214, 0.35) !important; border-radius: 2px !important; }

        .cc-dock-chip {
            height: var(--cc-dock-chip-h) !important; box-sizing: border-box !important;
            display: flex !important; align-items: center !important; gap: 3px !important;
            padding: 3px 6px !important; border: 1px solid rgba(148, 178, 214, 0.18) !important;
            border-radius: 7px !important; background: rgba(15, 23, 42, 0.5) !important;
            color: #dbeafe !important; font: inherit !important; line-height: 1 !important;
        }
        .cc-dock-chip img { width: 15px !important; height: 15px !important; object-fit: contain !important; display: block !important; flex: none !important; }
        .cc-dock-chip-n { font-weight: 700 !important; font-variant-numeric: tabular-nums !important; }
        button.cc-dock-chip { cursor: pointer !important; transition: background-color 0.2s ease, border-color 0.2s ease !important; }
        button.cc-dock-chip:hover { background: rgba(38, 54, 77, 0.8) !important; border-color: rgba(148, 178, 214, 0.4) !important; }
        .cc-dock-chip.on { border-color: #ca8a04 !important; background: rgba(120, 87, 20, 0.42) !important; color: #fde68a !important; }
        .cc-dock-potion { cursor: default !important; color: #cbd5e1 !important; }

        .cc-dock-wilds { min-width: 0 !important; }
        .cc-dock-wilds .cc-dock-chips { max-width: min(44vw, 500px) !important; overflow-x: auto !important; overflow-y: hidden !important; }
        .cc-dock-wilds .cc-dock-chips::-webkit-scrollbar { height: 3px !important; }
        .cc-dock-wilds .cc-dock-chips::-webkit-scrollbar-thumb { background: rgba(148, 178, 214, 0.35) !important; border-radius: 2px !important; }
        .cc-dock-wild {
            flex: none !important; display: flex !important; align-items: center !important; gap: 5px !important;
            padding: 3px 6px !important; border: 1px solid rgba(148, 178, 214, 0.18) !important;
            border-radius: 7px !important; background: rgba(15, 23, 42, 0.5) !important;
        }
        .cc-dock-wild.shiny { border-color: #d4af37 !important; background: rgba(120, 87, 20, 0.42) !important; }
        .cc-dock-wild-ico { width: 22px !important; height: 22px !important; object-fit: contain !important; image-rendering: pixelated !important; flex: none !important; }
        .cc-dock-wild-txt { display: flex !important; flex-direction: column !important; line-height: 1.15 !important; }
        .cc-dock-wild-name { color: #e2e8f0 !important; font-weight: 600 !important; white-space: nowrap !important; }
        .cc-dock-wild-lv { color: #94a3b8 !important; font-size: 9px !important; }
        .cc-dock-throw {
            height: 20px !important; padding: 0 7px !important;
            border: 1px solid rgba(74, 140, 92, 0.55) !important; border-radius: 6px !important;
            background: rgba(22, 48, 29, 0.7) !important; color: #86efac !important; cursor: pointer !important;
            font: 600 10px/1 'Segoe UI', sans-serif !important; white-space: nowrap !important;
        }
        .cc-dock-throw:disabled { opacity: 0.4 !important; cursor: default !important; border-color: rgba(100, 116, 139, 0.4) !important; background: rgba(15, 23, 42, 0.5) !important; color: #64748b !important; }

        /* Contador de kills: un solo chip con el sprite del ultimo QA y el total.
           Ancho fijo para que la barra no crezca nunca con el numero de bajas. */
        .cc-dock-kill {
            height: var(--cc-dock-chip-h) !important; box-sizing: border-box !important;
            display: flex !important; align-items: center !important; gap: 3px !important;
            padding: 3px 6px !important; border-radius: 7px !important;
            background: rgba(15, 23, 42, 0.42) !important; color: #cbd5e1 !important;
            white-space: nowrap !important; cursor: help !important;
            border: 1px solid rgba(148, 178, 214, 0.18) !important;
        }
        .cc-dock-kill img { width: 15px !important; height: 15px !important; image-rendering: pixelated !important; flex: none !important; }
        .cc-dock-kill-n { font-weight: 700 !important; font-variant-numeric: tabular-nums !important; }
        .cc-dock-kill.is-new { color: #facc15 !important; border-color: rgba(250, 204, 21, 0.35) !important; }
        .cc-dock-kill.shiny { color: #fcd34d !important; border-color: rgba(212, 175, 55, 0.45) !important; }

        /* MARKET BUTTON (.market-cta) */
        .market-cta { 
            background: #ca8a04 !important; border: 1px solid #a16207 !important; border-radius: 8px !important; padding: 6px !important; margin: 8px auto 2px auto !important; cursor: pointer !important; box-shadow: 0 2px 4px rgba(0,0,0,0.4) !important; transition: all 0.2s ease !important; display: flex !important; align-items: center !important; justify-content: center !important; width: max-content !important; box-sizing: border-box !important; text-decoration: none !important; font-size: 0 !important; line-height: 0 !important;
        }
        .market-cta img { max-height: 24px !important; object-fit: contain !important; display: block !important; margin: 0 !important; }
        .market-cta:hover { background: #eab308 !important; transform: translateY(-1px) !important; box-shadow: 0 4px 8px rgba(0,0,0,0.6) !important; }

        /* --------------------------------------------------- */
        /* EVENTOS Y BOOSTS - MISMO ESTILO QUE TIPO DEL DIA    */
        /* --------------------------------------------------- */
        body.custom-bi-events-mirrored .bi-wrap {
            display: contents !important; visibility: visible !important; opacity: 1 !important;
        }
        .bi-chip.script-bi-native-source {
            position: fixed !important; bottom: 30px !important; top: auto !important;
            left: var(--script-bi-left, 50%) !important; right: auto !important; transform: none !important;
            margin: 0 !important; background-color: rgba(13, 19, 26, 0.96) !important;
            border-radius: 8px !important; padding: 5px 9px !important; min-height: 27px !important;
            color: #ffffff !important; border: 2px solid var(--script-bi-accent, #3f4c5d) !important;
            box-shadow: 0 4px 8px rgba(0,0,0,0.6) !important;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif !important;
            font-size: 10px !important; line-height: 1 !important; display: flex !important;
            align-items: center !important; justify-content: center !important; gap: 6px !important;
            flex: 0 0 auto !important; z-index: 10000 !important;
            visibility: visible !important; opacity: 1 !important; overflow: visible !important;
            pointer-events: auto !important; white-space: nowrap !important;
            contain: layout style !important; isolation: isolate !important;
            transition: border-color 0.4s ease, background-color 0.2s ease, transform 0.2s ease !important;
            scale:var(--cc-scale-events) !important;transform-origin:left bottom !important;
        }
        .bi-chip.script-bi-native-duplicate { display: none !important; }
        .bi-chip.script-bi-native-source:hover { background-color: #151f2b !important; transform: none !important; z-index: 10002 !important; }
        .bi-chip.script-bi-native-source .bi-ico { width: 15px !important; height: 15px !important; display: flex !important; align-items: center !important; justify-content: center !important; flex: 0 0 15px !important; }
        .bi-chip.script-bi-native-source .bi-ico img, .bi-chip.script-bi-native-source .bi-ico svg { max-width: 15px !important; max-height: 15px !important; object-fit: contain !important; }
        .bi-chip.script-bi-native-source .bi-time { font-weight: 700 !important; letter-spacing: 0.25px !important; color: #e2e8f0 !important; white-space: nowrap !important; }
        .bi-chip.script-bi-native-source .bi-event-pop, .bi-chip.script-bi-native-source .bi-boost-pop {
            position: absolute !important; bottom: calc(100% + 8px) !important; top: auto !important;
            left: 50% !important; right: auto !important; transform: translateX(-50%) !important;
            background-color: #0d131a !important; border: 1px solid #526174 !important;
            border-radius: 6px !important; padding: 8px !important; color: #fff !important;
            font-size: 10px !important; line-height: 1.35 !important;
            box-shadow: 0 4px 10px rgba(0,0,0,0.8) !important;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif !important;
            text-align: center !important; white-space: normal !important; word-wrap: break-word !important;
            width: max-content !important; max-width: 220px !important; z-index: 10003 !important;
            box-sizing: border-box !important; margin: 0 !important;
            display: none !important; visibility: hidden !important; opacity: 0 !important;
            pointer-events: none !important;
        }
        .bi-chip.script-bi-native-source:hover .bi-event-pop,
        .bi-chip.script-bi-native-source:hover .bi-boost-pop {
            display: block !important; visibility: visible !important; opacity: 1 !important;
        }
        .bi-chip.script-bi-native-source.script-bi-first .bi-event-pop,
        .bi-chip.script-bi-native-source.script-bi-first .bi-boost-pop { left: 0 !important; transform: none !important; }
        .bi-chip.script-bi-native-source.script-bi-last .bi-event-pop,
        .bi-chip.script-bi-native-source.script-bi-last .bi-boost-pop { left: auto !important; right: 0 !important; transform: none !important; }
        .bi-chip.script-bi-native-source .bi-event-pop::before, .bi-chip.script-bi-native-source .bi-event-pop::after,
        .bi-chip.script-bi-native-source .bi-boost-pop::before, .bi-chip.script-bi-native-source .bi-boost-pop::after { display: none !important; }
        .bi-chip.script-bi-native-source .bi-event-name, .bi-chip.script-bi-native-source .bi-boost-name { color: #f8fafc !important; font-weight: 800 !important; }
        .bi-chip.script-bi-native-source .bi-event-desc, .bi-chip.script-bi-native-source .bi-boost-desc { color: #cbd5e1 !important; }
        .bi-chip.script-bi-native-source .bi-event-until, .bi-chip.script-bi-native-source .bi-boost-until { color: #93c5fd !important; font-weight: 700 !important; }
        @media (max-width: 700px) {
            .bi-chip.script-bi-native-source { bottom: 12px !important; padding: 4px 7px !important; min-height: 24px !important; font-size: 9px !important; gap: 4px !important; }
        }

        /* --------------------------------------------------- */
        /* NOTIFICACIONES DE VICTORIA (REDUCIDAS 50%)          */
        /* --------------------------------------------------- */
        .sn-card.sn-success { display: none !important; }
        #custom-victory-toast-container {
            position: fixed !important; right: 8px !important; left: auto !important;
            top: 58px !important; bottom: auto !important; transform: none !important;
            display: flex !important; flex-direction: column !important; align-items: stretch !important;
            gap: 6px !important; width: 190px !important; max-height: calc(100vh - 130px) !important;
            overflow: hidden !important; z-index: 210 !important; pointer-events: none !important;
            scale:var(--cc-scale-victory) !important;transform-origin:right top !important;
        }
        
        .cv-toast { width: 100%; box-sizing: border-box; background-color: #0d131a; border-radius: 6px; padding: 6px; color: #ffffff; box-shadow: 0 3px 8px rgba(0,0,0,0.8); border: 1px solid #4ade80; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; animation: slideInRight 0.3s ease-out forwards; transition: opacity 0.5s ease, transform 0.5s ease; opacity: 1; pointer-events: auto; }
        .cv-toast.fading-out { opacity: 0; transform: translateY(-15px); }
        @keyframes slideInLeft { from { opacity: 0; transform: translateX(-15px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes slideInRight { from { opacity: 0; transform: translateX(15px); } to { opacity: 1; transform: translateX(0); } }
        
        .cv-container { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .cv-header { display: flex; align-items: center; gap: 5px; border-bottom: 1px solid #2a3a4a; padding-bottom: 4px; }
        .cv-sprite { width: 20px; height: 20px; object-fit: contain; image-rendering: pixelated; background: rgba(0,0,0,0.3); border-radius: 4px; padding: 1px; border: 1px solid #444; }
        
        .cv-title-box { display: flex; flex-direction: column; }
        .cv-title { font-size: 9px; font-weight: bold; color: #4ade80; }
        .cv-subtitle { font-size: 7px; color: #888; text-transform: uppercase; }
        
        .cv-section { display: flex; flex-direction: column; gap: 2px; }
        .cv-row { font-size: 8px; color: #cbd5e1; display: flex; justify-content: space-between; align-items: center; }
        .cv-val-xp { color: #60a5fa; font-weight: bold; }
        
        .cv-debuff-text { color: #ef4444; font-size: 7px; font-style: italic; text-align: right; line-height: 1.1; margin-top: 1px; }
        
        .cv-loot-grid { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
        .cv-loot-item { display: flex; align-items: center; gap: 2px; background: rgba(255,255,255,0.05); padding: 1px 3px; border-radius: 2px; border: 1px solid #334155; }
        .cv-loot-item img { width: 10px; height: 10px; }
        .cv-loot-item span { font-size: 8px; font-weight: bold; color: #a855f7; }

        /* CONFIGURACIÓN PROPIA DEL REDISEÑO: vive como pestaña dentro de la
           ventana de ajustes del juego, no como modal propio. */
        .cfg-window .cfg-body > .cc-scale-pane { display:block !important; }
        .cc-scale-pane .cc-settings-copy {
            margin:0 !important;padding:12px 4px !important;color:#94a3b8 !important;
            font-size:11px !important;line-height:1.5 !important;border-bottom:1px solid rgba(148,178,214,.14) !important;
        }
        .cc-scale-pane .cc-settings-list { display:grid !important;grid-template-columns:1fr !important;gap:8px !important;padding:12px 0 !important; }
        .cc-scale-row {
            display:grid !important;grid-template-columns:minmax(0,1fr) 96px !important;gap:10px !important;
            align-items:center !important;padding:10px 11px !important;
            border:1px solid rgba(148,178,214,.14) !important;border-radius:9px !important;
            background:rgba(15,23,42,.42) !important;
        }
        .cc-scale-row b { display:block !important;color:#e2e8f0 !important;font-size:12px !important;font-weight:700 !important; }
        .cc-scale-row p { margin:3px 0 0 !important;color:#7890a2 !important;font-size:9px !important;line-height:1.35 !important; }
        .cc-scale-control select {
            width:100% !important;min-height:32px !important;padding:5px 8px !important;
            border:1px solid rgba(148,178,214,.22) !important;border-radius:7px !important;
            background:rgba(8,13,20,.75) !important;color:#f8fafc !important;
            font:700 11px 'Segoe UI',sans-serif !important;outline:none !important;cursor:pointer !important;
        }
        .cc-scale-control select:focus { border-color:#60a5fa !important;box-shadow:0 0 0 2px #3b82f62c !important; }
        .cc-scale-pane .cc-settings-actions { display:flex !important;justify-content:flex-end !important;gap:8px !important;padding:4px 0 0 !important; }
        .cc-scale-pane .cc-settings-actions button {
            min-height:32px !important;padding:6px 13px !important;
            border:1px solid rgba(148,178,214,.22) !important;border-radius:7px !important;
            background:rgba(15,23,42,.6) !important;color:#dce8ef !important;
            font:700 10px 'Segoe UI',sans-serif !important;cursor:pointer !important;
        }
        .cc-scale-pane .cc-settings-actions button:hover { background:rgba(38,54,77,.8) !important;border-color:rgba(148,178,214,.4) !important; }

        /* --------------------------------------------------- */
        /* CARD MODE · PANEL DE AJUSTES                         */
        /* --------------------------------------------------- */
        /* El pane vive dentro de la ventana .cfg-window del juego, que mide
           470px. Todo lo de aqui esta dimensionado para ese ancho. */
        .cc-card-block { border:1px solid rgba(148,178,214,.16); border-radius:11px;
            background:rgba(15,23,42,.42); overflow:hidden; }
        .cc-card-block-h { display:flex; align-items:center; gap:8px; padding:10px 11px;
            border-bottom:1px solid rgba(148,178,214,.14); background:rgba(148,178,214,.05); }
        .cc-card-block-h .cc-ic { width:14px; height:14px; color:#c8aa6e; }
        .cc-card-block-h > span { font-size:12px; font-weight:700; color:#e2e8f0; }
        .cc-badge { margin-left:auto; font-style:normal; font-size:9px; font-weight:800; color:#9dc6ff;
            background:rgba(120,180,255,.15); border:1px solid rgba(120,180,255,.32);
            border-radius:5px; padding:2px 7px; }

        /* vista previa en vivo */
        .cc-preview { display:flex; gap:14px; align-items:flex-start; justify-content:center;
            padding:12px 10px 10px; background:radial-gradient(90% 80% at 50% 30%,rgba(24,34,50,.55),rgba(7,12,20,.95) 74%); }
        .cc-pv-box { display:flex; flex-direction:column; align-items:center; gap:5px; }
        .cc-pv-box > span { font-size:7.5px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:#64798f; }
        .cc-mini-card { zoom:.58; margin:0 !important; pointer-events:none; }
        .cc-mini-card .cc-btn { pointer-events:none; }

        /* acordeones */
        .cc-accordion { border-top:1px solid rgba(148,178,214,.12); }
        .cc-accordion > summary { list-style:none; cursor:pointer; padding:9px 11px;
            display:flex; align-items:center; gap:8px; font-size:11px; font-weight:700; color:#e2e8f0; }
        .cc-accordion > summary::-webkit-details-marker { display:none; }
        .cc-accordion > summary::before { content:""; width:0; height:0; flex:0 0 auto;
            border-left:4px solid #7f96ae; border-top:3.5px solid transparent; border-bottom:3.5px solid transparent;
            transition:transform .18s ease; }
        .cc-accordion[open] > summary::before { transform:rotate(90deg); }
        .cc-accordion > summary .cc-badge { margin-left:auto; }
        .cc-hint { margin:0 11px 8px; font-size:9px; color:#7890a2; line-height:1.4; }

        /* rejilla de temas: mini-preview real de cada card */
        .cc-theme-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; padding:0 11px 11px; }
        .cc-theme-tile { display:flex; flex-direction:column; align-items:center; gap:3px; padding:5px 3px 4px;
            border-radius:8px; cursor:pointer; background:rgba(8,13,20,.5);
            border:1px solid rgba(148,178,214,.13); transition:background .15s,border-color .15s; }
        .cc-theme-tile:hover { background:rgba(38,54,77,.7); border-color:rgba(148,178,214,.34); }
        .cc-theme-tile.on { background:rgba(120,180,255,.18); border-color:rgba(140,190,255,.6); }
        .cc-tt-art { height:46px; display:flex; align-items:flex-end; justify-content:center;
            overflow:hidden; width:100%; }
        .cc-tt-art .cc-mini-card { zoom:.26; }
        .cc-tt-label { font-size:8px; font-weight:700; color:#9fb0c4; text-align:center; line-height:1.15; }
        .cc-theme-tile.on .cc-tt-label { color:#dbe7f5; }

        /* rejilla de sprites */
        .cc-sprite-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; padding:0 11px 11px; }
        .cc-sprite-tile { position:relative; display:flex; align-items:center; gap:5px; padding:5px; min-width:0;
            border-radius:7px; cursor:pointer; background:rgba(8,13,20,.5);
            border:1px solid rgba(148,178,214,.13); transition:background .15s,border-color .15s; }
        .cc-sprite-tile:hover { background:rgba(38,54,77,.7); border-color:rgba(148,178,214,.34); }
        .cc-sprite-tile.on { background:rgba(120,180,255,.18); border-color:rgba(140,190,255,.6); }
        .cc-sprite-tile img { width:22px; height:22px; flex:0 0 22px; object-fit:contain; }
        .cc-sprite-tile span { font-size:8.5px; font-weight:700; color:#9fb0c4;
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .cc-sprite-tile.on span { color:#dbe7f5; }
        .cc-sprite-tile.is-anim::after { content:""; position:absolute; top:3px; right:4px;
            width:5px; height:5px; border-radius:50%; background:#7dfab0; }

        /* bolas */

        /* interruptores */
        .cc-toggles { padding:0 11px 11px; }
        .cc-toggle { display:flex; align-items:center; gap:9px; width:100%; padding:7px 2px; cursor:pointer;
            background:none; border:none; border-top:1px solid rgba(148,178,214,.09); text-align:left; }
        .cc-toggle:first-child { border-top:none; }
        .cc-tx { flex:1; min-width:0; }
        .cc-tx b { display:block; font-size:10.5px; font-weight:700; color:#dce8ef; line-height:1.25; }
        .cc-tx i { display:block; font-size:8.5px; font-style:normal; color:#7890a2; margin-top:1px; line-height:1.3; }
        .cc-switch { width:34px; height:18px; border-radius:10px; flex:0 0 34px; position:relative;
            background:rgba(148,178,214,.18); border:1px solid rgba(148,178,214,.22); transition:background .18s; }
        .cc-switch::after { content:""; position:absolute; top:2px; left:2px; width:12px; height:12px;
            border-radius:50%; background:#94a3b8; transition:transform .18s,background .18s; }
        .cc-toggle.on .cc-switch { background:rgba(96,165,250,.55); border-color:rgba(96,165,250,.7); }
        .cc-toggle.on .cc-switch::after { transform:translateX(16px); background:#fff; }

        @media (max-width:700px) {
            .cc-scale-pane .cc-settings-list { grid-template-columns:1fr !important; }
            .cc-theme-grid { grid-template-columns:repeat(3,1fr); }
            .cc-sprite-grid { grid-template-columns:repeat(3,1fr); }
        }
    `);

    /* --------------------------------------------------------------- */
    /* CONFIGURACIÓN: PESTAÑA DENTRO DE LOS AJUSTES DEL JUEGO          */
    /* --------------------------------------------------------------- */
    /* El botón flotante "Diseño" se sustituye por una pestaña real en la
       ventana de ajustes del juego, junto a la que ya inyecta el script de
       mercado. El juego reconstruye esa ventana al cerrarla, así que la
       pestaña se vuelve a inyectar en cada refresco. */
    const SCRIPT_TAB_KEY = 'script-cc-tab';
    const SCRIPT_TAB_HIDDEN = 'ccTabHidden';

    function ccPreviewMarkup(isMob) {
        const sample = {
            name: 'Golem', level: 324, iv: 152, power: 7047,
            stats: { hp: 728, atk: 841, def: 911, spa: 586, spd: 606, vel: 418 }
        };
        const theme = themeById(scriptCardPreferences.theme);
        const tier = getTierInfo(1.8);
        if (isMob) {
            return `<div class="cc-mini-card custom-poke-card cc-mob ${theme.cls}" style="--tier:#ef4444">
                <div class="cc-mob-name">Charizard</div>
                <div class="cc-mob-art">${ccEnemySpriteHtml('charizard', 6)}</div>
                <div class="cc-mobbar"><span class="k">HP</span>
                    <div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-hp-high" style="width:58%"></div></div>
                    ${scriptCardPreferences.showPct ? '<span class="v">58%</span>' : ''}
                </div></div>`;
        }
        const p = { ...sample, speciesId: 76, shiny: true };
        return `<div class="cc-mini-card custom-poke-card ${theme.cls} ${scriptCardPreferences.memoOpen ? 'open' : ''}" style="--tier:${tier.color}">${ccThemeMarkup(theme.id, {
            p, stats: sample.stats, tierInfo: tier, types: ['poke-xp'],
            level: sample.level, iv: sample.iv, power: sample.power, hpPct: 72
        })}</div>`;
    }

    function ccRenderPreview(container) {
        container.innerHTML = `<div class="cc-pv-box">${ccPreviewMarkup(false)}<span>Tu Pokémon</span></div>
            <div class="cc-pv-box">${ccPreviewMarkup(true)}<span>Enemigo</span></div>`;
        container.querySelectorAll('.cc-spr, .mob-sprite-canvas').forEach(node => {
            if (node.tagName !== 'IMG') return;
            const fallback = spriteById('pixel').url(node.alt && /Charizard/i.test(node.alt) ? 6 : 76);
            node.addEventListener('error', () => { node.src = fallback; }, { once: true });
        });
    }

    function buildScriptSettingsBody() {
        const wrap = document.createElement('div');
        wrap.className = 'cc-scale-pane';
        /* Sello de version. Permite comprobar desde la consola que la copia
           que se esta ejecutando es la del archivo en disco, porque con
           Tampermonkey el resincronizado del archivo no siempre es inmediato. */
        wrap.dataset.ccBuild = CARD_BUILD;
        wrap.innerHTML = `
            <p class="cc-settings-copy">Personaliza el aspecto de las cards del modo Card y ajusta el tamaño de cada parte rediseñada. Si una escala no cabe en la pantalla, el ajuste responsivo la reduce únicamente lo necesario.</p>

            <section class="cc-card-block">
                <header class="cc-card-block-h">
                    <svg class="cc-ic" viewBox="0 0 24 24"><path d="M14.5 3H21v6.5L11 19.5 4.5 13zM3 21l4-4M7 17l-2 2"/></svg>
                    <span>Card mode</span>
                    <em class="cc-badge" data-cc-theme-badge></em>
                </header>

                <div class="cc-preview" data-cc-preview></div>

                <details class="cc-accordion" open>
                    <summary>Tema de la card<em data-cc-theme-badge></em></summary>
                    <p class="cc-hint">Elige la silueta. El borde y el color siguen al tier del Pokémon.</p>
                    <div class="cc-theme-grid" data-cc-themes></div>
                </details>

                <details class="cc-accordion" open>
                    <summary>Versión de imagen<em data-cc-sprite-badge></em></summary>
                    <p class="cc-hint">Fuente del sprite. Las dos con punto verde son animadas.</p>
                    <div class="cc-sprite-grid" data-cc-sprites></div>
                </details>

                <details class="cc-accordion">
                    <summary>Opciones</summary>
                    <div class="cc-toggles" data-cc-toggles></div>
                </details>
            </section>

            <p class="cc-settings-copy" style="margin-top:14px">Tamaño de cada zona</p>
            <div class="cc-settings-list">
                ${SCRIPT_SCALE_AREAS.map(area => `
                    <label class="cc-scale-row">
                        <span><b>${area.label}</b><p>${area.description}</p></span>
                        <span class="cc-scale-control">
                            <select data-scale-key="${area.key}" aria-label="Tamaño de ${area.label}">
                                ${SCRIPT_SCALE_OPTIONS.map(value => `<option value="${value}">${value}%</option>`).join('')}
                            </select>
                        </span>
                    </label>`).join('')}
            </div>
            <footer class="cc-settings-actions"><button class="cc-settings-reset" type="button">Restablecer 100%</button></footer>`;

        /* ---------- vista previa ---------- */
        const preview = wrap.querySelector('[data-cc-preview]');
        ccRenderPreview(preview);

        /* ---------- temas ---------- */
        const themeGrid = wrap.querySelector('[data-cc-themes]');
        CARD_THEMES.forEach(theme => {
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = `cc-theme-tile${theme.id === scriptCardPreferences.theme ? ' on' : ''}`;
            tile.dataset.ccTheme = theme.id;
            tile.innerHTML = `<span class="cc-tt-art">${ccPreviewMarkup(false)}</span><span class="cc-tt-label">${theme.name}</span>`;
            tile.addEventListener('click', () => {
                scriptCardPreferences.theme = theme.id;
                saveCardPreferences();
                applyCardPreferences();
            });
            themeGrid.appendChild(tile);
        });

        /* ---------- sprites ---------- */
        const spriteGrid = wrap.querySelector('[data-cc-sprites]');
        CARD_SPRITES.forEach(source => {
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = `cc-sprite-tile${source.id === scriptCardPreferences.sprite ? ' on' : ''}`;
            tile.dataset.ccSprite = source.id;
            tile.title = `${source.name} · cobertura ${source.cov}`;
            const img = document.createElement('img');
            img.src = source.url(76);
            img.alt = source.name;
            if (source.px) img.style.imageRendering = 'pixelated';
            if (source.anim) tile.classList.add('is-anim');
            tile.appendChild(img);
            const label = document.createElement('span');
            label.textContent = source.short;
            tile.appendChild(label);
            tile.addEventListener('click', () => {
                scriptCardPreferences.sprite = source.id;
                saveCardPreferences();
                applyCardPreferences();
            });
            spriteGrid.appendChild(tile);
        });

        /* ---------- opciones ---------- */
        const togglesHost = wrap.querySelector('[data-cc-toggles]');
        [
            { key: 'showPct', label: 'Mostrar % de HP en la enemiga', desc: 'Hoy la card del enemigo no enseña la proporción de vida.' },
            { key: 'hitFx', label: 'Efecto de golpe y daño', desc: 'La card entera avanza al golpear y se sacude al recibir daño.' },
            { key: 'glow', label: 'Halo de color en el borde', desc: 'Resplandor del tier. Desactivado por defecto.' },
            { key: 'memoOpen', label: 'Recordar card desplegada', desc: 'Solo afecta al tema compacto.' }
        ].forEach(option => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `cc-toggle${scriptCardPreferences[option.key] ? ' on' : ''}`;
            row.dataset.ccToggle = option.key;
            row.innerHTML = `<span class="cc-tx"><b>${option.label}</b><i>${option.desc}</i></span><span class="cc-switch"></span>`;
            row.addEventListener('click', () => {
                scriptCardPreferences[option.key] = !scriptCardPreferences[option.key];
                saveCardPreferences();
                applyCardPreferences();
            });
            togglesHost.appendChild(row);
        });

        /* ---------- escalas (comportamiento previo) ---------- */
        wrap.querySelectorAll('[data-scale-key]').forEach(select => {
            select.value = String(scriptScalePreferences[select.dataset.scaleKey]);
            select.addEventListener('change', () => {
                scriptScalePreferences[select.dataset.scaleKey] = normalizeScalePercent(select.value);
                saveScriptScalePreferences();
                applyScriptScales();
            });
        });
        wrap.querySelector('.cc-settings-reset').addEventListener('click', () => {
            scriptScalePreferences = { ...SCRIPT_SCALE_DEFAULTS };
            wrap.querySelectorAll('[data-scale-key]').forEach(select => { select.value = '100'; });
            saveScriptScalePreferences();
            applyScriptScales();
        });

        /* ---------- badges de estado ---------- */
        const syncBadges = () => {
            wrap.querySelectorAll('[data-cc-theme-badge]').forEach(node => {
                node.textContent = themeById(scriptCardPreferences.theme).name;
            });
            wrap.querySelectorAll('[data-cc-sprite-badge]').forEach(node => {
                const s = spriteById(scriptCardPreferences.sprite);
                node.textContent = s.anim ? `${s.short} · animada` : s.short;
            });
        };
        syncBadges();
        wrap._ccSync = () => {
            syncBadges();
            wrap.querySelectorAll('[data-cc-theme]').forEach(node => node.classList.toggle('on', node.dataset.ccTheme === scriptCardPreferences.theme));
            wrap.querySelectorAll('[data-cc-sprite]').forEach(node => node.classList.toggle('on', node.dataset.ccSprite === scriptCardPreferences.sprite));
            wrap.querySelectorAll('[data-cc-toggle]').forEach(node => node.classList.toggle('on', !!scriptCardPreferences[node.dataset.ccToggle]));
            ccRenderPreview(wrap.querySelector('[data-cc-preview]'));
        };
        return wrap;
    }

    /* Aplica un cambio de card mode y refresca todo lo afectado. */
    function applyCardPreferences() {
        document.body?.classList.toggle('cc-allow-glow', !!scriptCardPreferences.glow);
        document.documentElement.dataset.ccTheme = scriptCardPreferences.theme;
        /* lastRenderKey se pone a "" para forzar la reconstruccion de ambas
           cards con el tema y el sprite nuevos. */
        lastRenderKey = '';
        const hero = document.getElementById('my-custom-poke-card');
        const enemy = document.getElementById('my-custom-mob-card');
        if (hero) hero.classList.remove('open');
        if (enemy) delete enemy.dataset.ccKey;
        renderCustomCard();
        updateMobCard();
        applyHitEffects();
        document.querySelectorAll('.cc-scale-pane').forEach(pane => { if (pane._ccSync) pane._ccSync(); });
    }

    /* El juego guarda en .cfg-body las secciones de Video y Password y solo
       alterna su visibilidad. Por eso NO se vacía con replaceChildren: eso las
       borraba y dejaba las pestañas del juego rotas para siempre. En vez de
       eso se ocultan y se restituyen al salir de la nuestra. */
    function showScriptSettingsPane(cfgWindow, body) {
        Array.from(body.children).forEach(child => {
            if (child.classList.contains('cc-scale-pane')) return;
            child.dataset.ccTabHidden = SCRIPT_TAB_HIDDEN;
            child.style.setProperty('display', 'none', 'important');
        });
        if (!body.querySelector('.cc-scale-pane')) body.appendChild(buildScriptSettingsBody());
        cfgWindow.querySelectorAll('.cfg-tab').forEach(other => other.classList.remove('on'));
        const tab = cfgWindow.querySelector(`[data-tab="${SCRIPT_TAB_KEY}"]`);
        if (tab) tab.classList.add('on');
        applyScriptScales();
    }

    function hideScriptSettingsPane(body) {
        body.querySelectorAll('.cc-scale-pane').forEach(pane => pane.remove());
        Array.from(body.children).forEach(child => {
            if (child.dataset.ccTabHidden !== SCRIPT_TAB_HIDDEN) return;
            delete child.dataset.ccTabHidden;
            child.style.removeProperty('display');
        });
    }

    function setupScriptScaleSettings() {
        if (!document.body) return;
        const cfgWindow = document.querySelector('.cfg-window');
        if (!cfgWindow || !cfgWindow.getClientRects().length) return;
        const tabs = cfgWindow.querySelector('.cfg-tabs');
        const body = cfgWindow.querySelector('.cfg-body');
        if (!tabs || !body) return;

        let tab = cfgWindow.querySelector(`[data-tab="${SCRIPT_TAB_KEY}"]`);
        if (!tab) {
            tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'cfg-tab';
            tab.dataset.tab = SCRIPT_TAB_KEY;
            tab.textContent = 'Custom Card';
            tab.addEventListener('click', () => showScriptSettingsPane(cfgWindow, body));
            tabs.appendChild(tab);

            /* Al pulsar cualquier otra pestaña se retira nuestro contenido para
               que el juego recupere el suyo. Va en fase de captura para
               ejecutarse antes que el manejador de la propia pestaña. */
            tabs.addEventListener('click', event => {
                const target = event.target.closest('.cfg-tab');
                if (!target || target.dataset.tab === SCRIPT_TAB_KEY) return;
                hideScriptSettingsPane(body);
            }, true);
        }

        /* El juego reconstruye la ventana al cerrarla: si nuestra pestaña
           seguía activa, se repone su contenido. */
        if (tab.classList.contains('on') && !body.querySelector('.cc-scale-pane')) {
            showScriptSettingsPane(cfgWindow, body);
        }
    }

    function getTierInfo(quality) {
        const q = parseFloat(quality) || 1.0;
        if (q < 1.0) return { label: 'Weak', color: '#888888' };
        if (q >= 1.0 && q < 1.1) return { label: 'Common', color: '#ffffff' };
        if (q >= 1.1 && q < 1.3) return { label: 'Uncommon', color: '#4ade80' };
        if (q >= 1.3 && q < 1.5) return { label: 'Rare', color: '#3b82f6' };
        if (q >= 1.5 && q < 1.7) return { label: 'Epic', color: '#a855f7' };
        if (q >= 1.7 && q < 2.0) return { label: 'Legendary', color: '#f59e0b' };
        if (q >= 2.0 && q < 3.0) return { label: 'Mythic', color: '#ec4899' }; 
        if (q >= 3.0 && q < 4.0) return { label: 'Ancient', color: '#ef4444' };
        if (q >= 4.0) return { label: 'Divine', color: '#06b6d4' };
        return { label: 'Unknown', color: '#ffffff' };
    }

    const TYPE_COLORS = Object.freeze({
        normal:'#94a3b8', fire:'#ef4444', fuego:'#ef4444', water:'#3b82f6', agua:'#3b82f6',
        electric:'#eab308', electrico:'#eab308', grass:'#22c55e', planta:'#22c55e', ice:'#67e8f9', hielo:'#67e8f9',
        fighting:'#f97316', lucha:'#f97316', poison:'#a855f7', veneno:'#a855f7', ground:'#a16207', tierra:'#a16207',
        flying:'#60a5fa', volador:'#60a5fa', psychic:'#ec4899', psiquico:'#ec4899', bug:'#84cc16', bicho:'#84cc16',
        rock:'#78716c', roca:'#78716c', ghost:'#8b5cf6', fantasma:'#8b5cf6', dragon:'#6366f1', dragonico:'#6366f1',
        dark:'#475569', siniestro:'#475569', steel:'#64748b', acero:'#64748b', fairy:'#f472b6', hada:'#f472b6'
    });
    function getTypeColor(type) {
        const key = String(type || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        return TYPE_COLORS[key] || '#22c55e';
    }

    /* Un tipo solo es valido si esta en el catalogo. El juego manda type1/type2
       como "ROCK" / "GROUND" en mayusculas, asi que se comparan en minuscula y
       se normalizan las alternativas que usa el propio juego. */
    function ccNormalizeType(value) {
        const key = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        return TYPE_COLORS[key] ? key : null;
    }

    /* Etiqueta visible del tipo. Se capitaliza como la manda el juego para no
       inventar una traduccion propia. */
    function ccTypeLabel(value) {
        const key = ccNormalizeType(value);
        if (!key) return null;
        const raw = String(value).trim();
        return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    }

/* --------------------------------------------------------------- */
    /* CONSTRUCCION DE LA CARD SEGUN EL TEMA ELEGIDO                      */
    /* --------------------------------------------------------------- */
    /* Todos los temas comparten los mismos "ganchos" para que updateLiveBars
       siga funcionando sin cambios: la barra de HP usa #cpc-hp-fill y
       #cpc-hp-text, y la de XP #cpc-xp-fill y #cpc-xp-text. Un tema puede
       omitir la de XP; en ese caso el ciclo la encuentra a null y no pinta. */

    function ccSpriteUrl(p) {
        return spriteById(scriptCardPreferences.sprite).url(p.speciesId);
    }

    function ccSpriteClasses(p) {
        const s = spriteById(scriptCardPreferences.sprite);
        return `cc-spr${s.px ? ' pixel' : ''}${s.anim ? ' anim' : ''}`;
    }

    /* <img> con respaldo al pixel clasico. Se fija por elemento porque el
       script puede reescribir el src al cambiar de version de sprite. */
    function ccImg(p, className) {
        const s = spriteById(scriptCardPreferences.sprite);
        const fallback = spriteById('pixel').url(p.speciesId);
        return `<img class="${className}" src="${s.url(p.speciesId)}" alt="${p.name}" data-cc-species="${p.speciesId}" onerror="this.onerror=null;this.src='${fallback}';this.className=this.className.replace(' anim','')">`;
    }

    function ccStatsGrid(stats) {
        const cells = [
            ['heart', 'HP', stats.hp], ['sword', 'Atk', stats.atk], ['shield', 'Def', stats.def],
            ['spark', 'SpA', stats.spa], ['buckler', 'SpD', stats.spd], ['wind', 'Vel', stats.vel]
        ];
        return `<div class="cpc-stats-grid">${cells.map(([icon, label, value]) =>
            `<div class="cpc-stat-item">${ccIcon(icon)}<span class="cpc-stat-label">${label}</span><span class="cpc-stat-value">${value}</span></div>`
        ).join('')}</div>`;
    }

    function ccTypesHtml(types) {
        const valid = (types || []).filter(t => ccNormalizeType(t));
        /* Sin tipos conocidos no se pinta ninguna insignia: antes serellenaba
           con un "POKE-XP" que en realidad era el nombre del evento de socket
           poke-xp fusionado por error, no un tipo del Pokemon. */
        if (valid.length === 0) return '';
        return `<div class="cc-types">${valid.map(t =>
            `<span class="cpc-type-badge" style="--cpc-type-color:${getTypeColor(t)}">${ccTypeLabel(t)}</span>`
        ).join('')}</div>`;
    }

    /* Barras con los ids que espera updateLiveBars. */
    function ccBars(withXp) {
        return `
            <div class="cpc-bar-wrapper">
                <div class="cpc-bar-fill cpc-hp-high" id="cpc-hp-fill" style="width:100%"></div>
                <div class="cpc-bar-text" id="cpc-hp-text">HP: Cargando...</div>
            </div>
            ${withXp ? `
            <div class="cpc-bar-wrapper">
                <div class="cpc-bar-fill cpc-xp-bar" id="cpc-xp-fill" style="width:0%"></div>
                <div class="cpc-bar-text" id="cpc-xp-text">XP: Cargando...</div>
            </div>` : ''}`;
    }

    /* El anillo lleva dentro el sprite y la lectura del porcentaje, asi que se
       construye entero aqui en vez de en dos trozos: el CSS posiciona
       .cc-center en absoluto sobre el circulo. */
    function ccRingSvg(pct, withXpRing, spriteHtml, pctText) {
        const C = 2 * Math.PI * 52;
        const hpOffset = C * (1 - Math.min(100, Math.max(0, pct)) / 100);
        const xpOffset = C * (1 - 0.41);
        return `<div class="cc-ring">
            <svg viewBox="0 0 118 118">
                <circle class="trk" cx="59" cy="59" r="52"></circle>
                ${withXpRing ? `<circle class="fil cc-xp" cx="59" cy="59" r="57.5" stroke-dasharray="${C}" stroke-dashoffset="${xpOffset}"></circle>` : ''}
                <circle class="fil" cx="59" cy="59" r="52" stroke-dasharray="${C}" stroke-dashoffset="${hpOffset}"></circle>
            </svg>
            <div class="cc-center">${spriteHtml}<span class="pct">${pctText}</span><span class="cap">HP</span></div>
        </div>`;
    }

    /* Igual que el anterior pero con el radio pequeño del tema 6. */
    function ccRing2Svg(pct, spriteHtml) {
        const C = 2 * Math.PI * 21.5;
        const offset = C * (1 - Math.min(100, Math.max(0, pct)) / 100);
        return `<div class="cc-ring2">
            <svg viewBox="0 0 46 46">
                <circle class="trk" cx="23" cy="23" r="21.5"></circle>
                <circle class="fil" cx="23" cy="23" r="21.5" stroke-dasharray="${C}" stroke-dashoffset="${offset}"></circle>
            </svg>
            ${spriteHtml}
        </div>`;
    }

    function ccThemeMarkup(themeId, ctx) {
        const { p, stats, tierInfo, types, level, iv, power, hpPct } = ctx;
        const name = `${p.name}${p.shiny ? ccStar() : ''}`;

        switch (themeId) {
            case '1':
                return `<div class="cc-in">
                    <div class="cc-head">
                        ${ccImg(p, ccSpriteClasses(p))}
                        <div>
                            <div class="cc-name">${name}</div>
                            <div class="cc-sub">Nv <b>${level}</b> · IV <b>${iv}</b>/192</div>
                            <div class="cc-tier">${tierInfo.label}</div>
                            <div class="cc-typerow">${ccTypesHtml(types)}</div>
                        </div>
                    </div>
                    ${ccStatsGrid(stats)}
                    <div class="cc-pow">${ccIcon('bolt')}<span class="lbl">Poder</span><span class="val">${power}</span></div>
                    <div class="cc-bars">${ccBars(true)}</div>
                </div>`;

            case '2':
                return `<div class="cc-grid">
                    <div class="cc-cell cc-art">${ccImg(p, ccSpriteClasses(p))}</div>
                    <div class="cc-cell">
                        <div class="cc-name">${name}</div>
                        <div class="cc-sub">Nv ${level} · <b>${tierInfo.label}</b></div>
                        <div style="margin-top:5px">${ccTypesHtml(types)}</div>
                    </div>
                    <div class="cc-cell cc-iv"><span class="k">IV</span><span class="v">${iv}<small>/192</small></span></div>
                    <div class="cc-cell cc-wide">${ccBars(true)}
                        <div class="cc-pow">${ccIcon('bolt')}<span class="lbl">PODER</span><span class="val" style="margin-left:auto">${power}</span></div>
                    </div>
                    ${ccStatsGrid(stats)}
                </div>`;

            case '3':
                return `<div class="cc-in">
                    <div class="cc-head"><span class="cc-name">${name}</span><span class="cc-lv">NV ${level}</span></div>
                    <div class="cc-art"><span class="cc-ribbon">${tierInfo.label}</span>${ccImg(p, ccSpriteClasses(p))}</div>
                    <div class="cc-hp"><span class="k">HP</span>
                        <div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-hp-high" id="cpc-hp-fill" style="width:100%"></div></div>
                        <span class="v cc-hp-val" id="cpc-hp-text">Cargando</span>
                    </div>
                    <div class="cc-xprow"><span class="k">EXP</span>
                        <div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-xp-bar" id="cpc-xp-fill" style="width:0%"></div></div>
                        <span class="v cc-hp-val" id="cpc-xp-text">0%</span></div>
                    <div class="cc-wide-stats">${ccStatsGrid(stats)}</div>
                    <div class="cc-foot">${ccTypesHtml(types)}
                        <span class="cpc-type-badge" style="--cpc-type-color:#22c55e">${ccIcon('bolt')} Poder ${power}</span>
                    </div>
                </div>`;

            case '4':
                return `${ccRingSvg(hpPct, true, ccImg(p, ccSpriteClasses(p)), `${Math.round(hpPct)}%`)}
                    <div class="cc-name">${name}</div>
                    <div class="cc-sub">Nv <b>${level}</b> · IV <b>${iv}</b>/192 · <b style="color:var(--tier)">${tierInfo.label}</b></div>
                    <div class="cc-typerow">${ccTypesHtml(types)}</div>
                    ${ccStatsGrid(stats)}
                    <div class="cc-pow">${ccIcon('bolt')}<span>${power}</span><span class="lbl">Poder</span></div>`;

            case '5': {
                const open = scriptCardPreferences.memoOpen ? ' open' : '';
                return `<div class="cc-top">
                        ${ccImg(p, ccSpriteClasses(p))}
                        <div style="flex:1;min-width:0">
                            <div class="cc-name">${name}<span class="dot"></span></div>
                            <div class="cc-sub">Nv <b>${level}</b> · IV <b>${iv}</b>
                                <span style="color:#7dfab0;font-weight:800">${ccIcon('bolt')}${power}</span></div>
                            <div class="cc-mini"><div class="cpc-bar-fill cpc-hp-high" id="cpc-hp-fill" style="width:100%"></div></div>
                        </div>
                        <button class="cc-btn" type="button" data-cc-toggle aria-expanded="${open ? 'true' : 'false'}" aria-label="Desplegar detalle">${ccIcon('chevron')}</button>
                    </div>
                    <div class="cc-more"><div class="cc-more-in"><div class="cc-div"></div>
                        <div class="cc-body">
                            <div class="cc-brow"><span class="k">HP</span>
                                <div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-hp-high" data-dupe style="width:100%"></div></div>
                                <span class="v" id="cpc-hp-text">Cargando</span></div>
                            <div class="cc-brow"><span class="k">EXP</span>
                                <div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-xp-bar" id="cpc-xp-fill" style="width:0%"></div></div>
                                <span class="v" id="cpc-xp-text">0%</span></div>
                            ${ccStatsGrid(stats)}
                            <div style="margin-top:8px">${ccTypesHtml(types)}</div>
                        </div>
                    </div></div>`;
            }

            case '6':
                return `<div class="cc-top">
                        ${ccRing2Svg(hpPct, ccImg(p, ccSpriteClasses(p) + ' in-ring'))}
                        <div style="flex:1;min-width:0">
                            <div class="cc-name">${name}</div>
                            <div class="cc-sub">Nv <b>${level}</b> · IV <b>${iv}</b>/192 · <b style="color:var(--tier)">${tierInfo.label}</b></div>
                            <div class="cc-typerow">${ccTypesHtml(types)}</div>
                        </div>
                        <div class="cc-pow"><div class="val">${power}</div><div class="lbl">${ccIcon('bolt')}PODER</div></div>
                    </div>
                    <div class="cc-rows">
                        ${[['heart','HP',stats.hp],['sword','Atk',stats.atk],['shield','Def',stats.def],
                           ['spark','SpA',stats.spa],['buckler','SpD',stats.spd],['wind','Vel',stats.vel]]
                            .map(([icon,label,value]) =>
                                `<div class="cc-row">${ccIcon(icon)}<span class="k">${label}</span><span class="v">${value}</span></div>`
                            ).join('')}
                    </div>
                    <div class="cc-bars">${ccBars(true)}</div>`;

            case '7':
            default:
                return `<div class="cc-head"><span class="cc-name">${name}</span><span class="cc-tier">${tierInfo.label}</span></div>
                    <div class="cc-typerow cc-typerow-top">${ccTypesHtml(types)}</div>
                    <div class="cc-stage">
                        <div class="cc-hud"><div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-hp-high" id="cpc-hp-fill" style="width:100%"></div></div><span class="v cc-hp-val" id="cpc-hp-text">Cargando</span></div>
                        <div class="cc-floor"></div>
                        ${ccImg(p, ccSpriteClasses(p))}
                    </div>
                    <div class="cc-body">
                        ${ccStatsGrid(stats)}
                        <div class="cc-brow"><span class="k">NV</span>
                            <div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-xp-bar" id="cpc-xp-fill" style="width:0%"></div></div>
                            <span class="v cc-hp-val" id="cpc-xp-text">${level}</span></div>
                        <div class="cc-brow"><span class="k">POD</span>
                            <div class="cpc-bar-wrapper"><div class="cpc-bar-fill cpc-hp-high" data-dupe style="width:82%"></div></div>
                            <span class="v">${power}</span></div>
                    </div>`;
        }
    }

    function renderCustomCard() {
        if (!latestPokemonData) return;
        const p = latestPokemonData;
        const stats = p.stats || {};

        const typeRenderKey = [p.type1, p.type2, p.types, p.type, p.elements].map(v => Array.isArray(v) ? v.join('|') : v).join('/');
        /* El tema y la version de sprite entran en la clave: si el usuario los
           cambia en el menu hay que reconstruir aunque los datos no hayan
           cambiado. */
        const currentKey = `${p.id}_${p.level}_${p.power || p.cp}_${stats.hp}_${stats.atk}_${typeRenderKey}_${scriptCardPreferences.theme}_${scriptCardPreferences.sprite}`;
        if (currentKey === lastRenderKey) return;

        const originalCard = document.querySelector('.cbt-card.cbt-hero');
        if (!originalCard) {
            document.body?.classList.remove('script-custom-hero-ready');
            return;
        }

        let customCard = document.getElementById('my-custom-poke-card');
        if (!customCard) {
            customCard = document.createElement('div');
            customCard.id = 'my-custom-poke-card';
            originalCard.parentElement.appendChild(customCard);
        }

        lastRenderKey = currentKey;
        const theme = themeById(scriptCardPreferences.theme);
        const tierInfo = getTierInfo(p.quality);
        customCard.className = `custom-poke-card ${theme.cls}`;
        customCard.style.setProperty('--tier', tierInfo.color);

        /* Tipos del Pokemon. El juego los manda como type1/type2 ("ROCK","GROUND").
           Ojo: existe un evento de socket llamado "poke-xp" que trae un campo
           `type` con el valor literal "poke-xp" y que se fusiona con el
           Pokemon en processSocketPayload. Si se leyera `p.type` primero, los
           tipos quedarian siempre como "POKE-XP" en vez de los reales, asi que
           se descartan los valores que no sean un tipo conocido y se prefieren
           type1/type2. */
        function ccCleanType(value) {
            const key = ccNormalizeType(value);
            return key ? ccTypeLabel(value) : null;
        }

        let typesArr = [];
        const declared = [p.type1, p.type2, p.types, p.type, p.elements];
        for (const value of declared) {
            if (Array.isArray(value)) {
                value.forEach(item => { const clean = ccCleanType(item); if (clean && !typesArr.includes(clean)) typesArr.push(clean); });
                continue;
            }
            const clean = ccCleanType(value);
            if (clean && !typesArr.includes(clean)) typesArr.push(clean);
        }
        /* Sin tipos conocidos se deja la lista vacia y ccTypesHtml no pinta
           ninguna insignia, en vez de Inventar un tipo. */

        const def = stats.def ?? stats.defense ?? 0;
        const spa = stats.spa ?? stats.spAtk ?? stats.sp_atk ?? stats.satk ?? "-";
        const spd = stats.spd ?? stats.spDef ?? stats.sp_def ?? stats.sdef ?? "-";
        const vel = stats.vel ?? stats.speed ?? stats.spe ?? "-";

        const level = p.level || 1;
        const iv = p.ivTotal || p.ivs_total || 0;
        const power = p.power || p.cp || 0;

        /* Anillo inicial al 100%: updateLiveBars lo corrige en el siguiente ciclo. */
        customCard.innerHTML = ccThemeMarkup(theme.id, {
            p,
            stats: { hp: stats.hp ?? stats.HP ?? 0, atk: stats.atk ?? stats.attack ?? 0, def, spa, spd, vel },
            tierInfo, types: typesArr, level, iv, power, hpPct: 100
        });

        if (theme.id === '5') bindCompactToggle(customCard);
        /* Al reconstruir la card, los ultimos valores pintados dejan de
           corresponder al DOM nuevo. Si no se limpian, updateLiveBars creera
           que ya estan al dia y no los volvera a aplicar: la barra que no
           cambia (normalmente la de EXP) se quedaria en su valor inicial. */
        if (lastRenderKey) {
            lastHpWidth = lastHpClass = lastHpText = null;
            lastXpWidth = lastXpText = null;
        }
        domCache.hpFill = document.getElementById('cpc-hp-fill');
        domCache.hpText = document.getElementById('cpc-hp-text');
        domCache.xpFill = document.getElementById('cpc-xp-fill');
        domCache.xpText = document.getElementById('cpc-xp-text');
        document.body?.classList.add('script-custom-hero-ready');
    }

    /* El chevron del tema compacto se enlaza por delegation en la card, no con
       un listener por render, para no acumular manejadores al reconstruirla. */
    function bindCompactToggle(card) {
        const btn = card.querySelector('[data-cc-toggle]');
        if (!btn || btn.dataset.ccBound === '1') return;
        btn.dataset.ccBound = '1';
        btn.addEventListener('click', () => {
            const isOpen = card.classList.toggle('open');
            btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            scriptCardPreferences.memoOpen = isOpen;
            saveCardPreferences();
        });
    }

    /* Chevrons del panel de equipo: el de dentro lo oculta y la píldora de
       fuera, que es un elemento aparte, lo muestra. Igual que en el dock. */
    const HUD_ARROW_LEFT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>';
    const HUD_ARROW_RIGHT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>';

    /* --------------------------------------------------------------- */
    /* ICONOS SVG · sustituyen a los emojis de las cards                 */
    /* --------------------------------------------------------------- */
    /* Trazo sobre currentColor: heredan el color del contenedor y no
       necesitan librerias ni fuentes de iconos. */
    const CC_ICONS = Object.freeze({
        heart:   'M12 20.5 4.9 13.4a4.6 4.6 0 0 1 0-6.5 4.6 4.6 0 0 1 6.5 0l.6.6.6-.6a4.6 4.6 0 0 1 6.5 0 4.6 4.6 0 0 1 0 6.5z',
        sword:   'M14.5 3H21v6.5L11 19.5 4.5 13zM3 21l4-4M7 17l-2 2',
        shield:  'M12 2.5 4.5 5.5V12c0 4.8 3.2 8.9 7.5 10.5 4.3-1.6 7.5-5.7 7.5-10.5V5.5z',
        spark:   'M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9zM19 3.5v3M20.5 5h-3',
        buckler: 'M12 21s7-3.4 7-9V5.4L12 3 5 5.4V12c0 5.6 7 9 7 9zM12 8v6M9 11h6',
        wind:    'M3.5 8.5h9a2.75 2.75 0 1 0-2.75-2.75M3.5 12.5h13a2.75 2.75 0 1 1-2.75 2.75M3.5 16.5h6',
        bolt:    'M13.5 2.5 4.5 14h7l-1 7.5 9-11.5h-7z',
        chevron: 'M6.5 9.5 12 15l5.5-5.5',
        cross:   'M5 5 19 19M19 5 5 19'
    });

    function ccIcon(name, className = 'cc-ic') {
        const path = CC_ICONS[name];
        if (!path) return '';
        return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"></path></svg>`;
    }

    /* La estrella de shiny va rellena, no trazada: se dibuja aparte porque el
       resto de iconos comparten estilo de linea. */
    function ccStar() {
        return '<svg class="cc-ic star" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.4l6-.8z"></path></svg>';
    }

    /* Margen de la píldora de mostrar respecto al borde izquierdo de la
       pantalla. El botón de ocultar no necesita separacion: la lleva en
       --cc-hud-btn-offset, medida hacia dentro del panel. */
    const HUD_BTN_GAP = 10;
    let hudResizeObserver = null;

    /* El botón de ocultar vive dentro del panel, así que su sitio se atualiza
       solo: hereda el desplazamiento y el centrado vertical de este, y no hay
       ningun retardo posible entre uno y otro. Aqui solo se resuelve la
       píldora de mostrar, que sí vive fuera. */
    function positionHudButtons() {
        const hud = document.querySelector('.phud.game-hud-tl');
        if (!hud) return;
        const hidden = hud.classList.contains('hidden-hud');
        const hideBtn = document.getElementById('phud-toggle-btn');
        const showBtn = document.getElementById('phud-show-btn');

        /* El de ocultar sale con el panel, pero mientras sale no debe recibir
           clics: se le corta el puntero, sin quitarle la visibilidad, para que
           no desaparezca a destello por el camino. */
        if (hideBtn) hideBtn.classList.toggle('is-off', hidden);
        if (showBtn) showBtn.classList.toggle('is-hidden', !hidden);

        /* La píldora de mostrar se alinea con la línea vertical del panel, la
           misma en la que estaba el botón de ocultar, para que al aparecer no
           dé un salto hacia abajo. El alto del panel no cambia al ocultarse
           (solo se desplaza en horizontal), así que el valor sirve igual. */
        const rect = hud.getBoundingClientRect();
        if (rect.height) {
            document.documentElement.style.setProperty(
                '--cc-hud-btn-y', `${Math.round(rect.top + rect.height / 2)}px`
            );
        }
        document.documentElement.style.setProperty('--cc-hud-btn-show-x', `${HUD_BTN_GAP}px`);

        /* Misma capa que el panel. El botón estaba en z-index 101 sobre el body,
           y los menús de ajustes y de selección (.cfg-overlay, .sel-overlay)
           viven en z-index 100, la misma cifra que el panel: por eso el botón
           se colaba por delante de ellos. Se copia la capa real del panel para
           que siga siendo su hermano y no un flotante por encima. */
        const panelZ = getComputedStyle(hud).zIndex;
        if (panelZ && panelZ !== 'auto') {
            document.documentElement.style.setProperty('--cc-hud-btn-z', panelZ);
        }
    }

    /* El botón de ocultar se mete DENTRO del panel: al ser hijo, hereda su
       desplazamiento y su centrado vertical sin ningún cálculo, así que no
       puede quedar desfasado ni al deslizarse ni al cambiar la escala.
       La píldora de mostrar se queda fuera, en la misma capa del panel y
       justo detrás de él, para que los menús la tapen igual que lo tapaban a
       él. Si el juego vuelve a montar su capa, esta la recoloca. */
    function placeHudButtonsInHudLayer() {
        const hud = document.querySelector('.phud.game-hud-tl');
        if (!hud || !hud.parentElement) return;
        const layer = hud.parentElement;
        const hideBtn = document.getElementById('phud-toggle-btn');
        const showBtn = document.getElementById('phud-show-btn');
        if (!hideBtn || !showBtn) return;

        if (hideBtn.parentElement !== hud) hud.appendChild(hideBtn);

        if (showBtn.parentElement !== layer || showBtn.previousElementSibling !== hud) {
            /* El anclaje es lo que va justo detrás del panel. Si se tomara el
               siguiente de la propia píldora, al estar al final de la capa
               sería null y insertBefore(x, null) la dejaría al final, que es
               justo lo que se quería evitar. */
            layer.insertBefore(showBtn, hud.nextElementSibling);
        }
    }

    function applyHudVisibility() {
        positionHudButtons();
    }

    function setupHudToggle() {
        const hud = document.querySelector('.phud.game-hud-tl');
        if (!hud) return;

        if (hud.dataset.scriptInitialHidden !== 'true') {
            hud.dataset.scriptInitialHidden = 'true';
            hud.classList.add('hidden-hud');
        }

        /* Se quita el logo del encabezado: el usuario pidió la cabecera sin él. */
        const emblem = hud.querySelector('.phud-emblem');
        if (emblem) emblem.style.display = 'none';

        /* El de ocultar nace dentro del panel, para que se deslice con él. El
           de mostrar nace fuera, en la misma capa, porque si compartieran sitio
           se irían los dos al esconder el panel y no habría forma de
           recuperarlo: es el mismo reparto que usa el dock. */
        let hideBtn = document.getElementById('phud-toggle-btn');
        if (!hideBtn) {
            hideBtn = document.createElement('button');
            hideBtn.id = 'phud-toggle-btn';
            hideBtn.type = 'button';
            hideBtn.title = 'Ocultar panel de equipo';
            hideBtn.setAttribute('aria-label', 'Ocultar panel de equipo');
            hideBtn.innerHTML = HUD_ARROW_LEFT;
            hideBtn.onclick = () => {
                hud.classList.add('hidden-hud');
                applyHudVisibility();
            };
            hud.appendChild(hideBtn);
        }

        let showBtn = document.getElementById('phud-show-btn');
        if (!showBtn) {
            showBtn = document.createElement('button');
            showBtn.id = 'phud-show-btn';
            showBtn.type = 'button';
            showBtn.title = 'Mostrar panel de equipo';
            showBtn.setAttribute('aria-label', 'Mostrar panel de equipo');
            showBtn.innerHTML = HUD_ARROW_RIGHT;
            showBtn.onclick = () => {
                hud.classList.remove('hidden-hud');
                applyHudVisibility();
            };
            (hud.parentElement || document.body).appendChild(showBtn);
        }

        /* Si el juego vuelve a montar su capa, el botón se queda en el árbol
           viejo y dejaría de acompañar al panel. */
        placeHudButtonsInHudLayer();

        /* El ResizeObserver solo vigila cambios reales de layout: es ciego a la
           propiedad scale, que es como el panel se reescala. Por eso el
           seguimiento de la escala va atado a applyScriptScales y no aquí. */
        if (!hudResizeObserver && typeof ResizeObserver === 'function') {
            hudResizeObserver = new ResizeObserver(() => positionHudButtons());
            hudResizeObserver.observe(hud);
        }

        positionHudButtons();
    }

    /* El panel nativo deja de forzarse visible. El juego lo monta solo cuando hay
       salvajes o un mensaje flash, y el script lo mostraba en cada ciclo: de ahi
       venia el parpadeo. Ahora unicamente se lee. */
    function findNativeCapturePanel() {
        return document.querySelector('.cap-panel:not(.script-persistent-capture)');
    }

    function captureFallbackSprite(name) {
        const clean = String(name || '').toLowerCase().replace(/[^a-z0-9\-]/g, '');
        return clean ? `https://play.pokemonshowdown.com/sprites/dex/${clean}.png` : '';
    }

    /* OutfitSprite pinta un <canvas>, no un <img>, asi que los sprites se copian
       a data URL una sola vez por nombre de Pokemon y se reutilizan. */
    function snapshotCaptureSprite(node, name) {
        const key = String(name || '').trim().toLowerCase();
        if (key && captureSpriteCache.has(key)) return captureSpriteCache.get(key);
        let url = '';
        try {
            if (node && node.tagName === 'IMG') url = node.getAttribute('src') || '';
            else if (node && node.tagName === 'CANVAS') url = node.toDataURL('image/png');
        } catch (_) {}
        if (!url) url = captureFallbackSprite(name);
        if (key) captureSpriteCache.set(key, url);
        return url;
    }

    /* ---- eventos del socket que alimentan la barra ---- */

    /* El panel nativo pinta un .cap-chip por ball con cantidad mayor que 0, en el
       mismo orden del catalogo, asi que el indice del chip activo coincide con el
       de nuestra lista y la delegacion por indice sigue siendo correcta. */
    function applyBallsEvent(data) {
        const counts = data.counts || {};
        const catalog = Array.isArray(data.catalog) ? data.catalog : [];
        captureCache.balls = catalog.map(ball => {
            const quantity = Math.max(0, Math.floor(Number(counts[String(ball.id)] ?? 0)));
            return {
                id: String(ball.id),
                name: ball.name || '',
                icon: ball.iconUrl || '',
                quantity,
                count: ball.infinite ? '∞' : quantity.toLocaleString('pt-BR')
            };
        }).filter(ball => ball.quantity > 0);
    }

    function applyInventoryEvent(data) {
        if (!Array.isArray(data.items)) return;
        captureCache.inventory = new Map(
            data.items.map(item => [String(item.itemId), Math.max(0, Math.floor(Number(item.quantity) || 0))])
        );
        refreshCapturePotions();
    }

    /* El catalogo estatico solo se descarga una vez; mientras llega, las pociones
       simplemente no se pintan todavia. */
    function loadCaptureItemCatalog() {
        if (captureItemCatalog || captureItemCatalogRequest) return;
        captureItemCatalogRequest = fetch('/game/items.json')
            .then(response => response.json())
            .then(data => {
                const catalog = new Map();
                (Array.isArray(data.items) ? data.items : []).forEach(item => {
                    if (item && item.id != null) catalog.set(String(item.id), item);
                });
                captureItemCatalog = catalog;
                refreshCapturePotions();
            })
            .catch(() => { captureItemCatalogRequest = null; });
    }

    function refreshCapturePotions() {
        if (!captureItemCatalog) { loadCaptureItemCatalog(); return; }
        const potions = [];
        captureItemCatalog.forEach(item => {
            if (item.category !== CAPTURE_POTION_CATEGORY) return;
            const quantity = captureCache.inventory.get(String(item.id)) || 0;
            if (quantity <= 0) return;
            potions.push({ id: String(item.id), name: item.name || '', icon: item.icon || '', count: quantity.toLocaleString('pt-BR') });
        });
        /* El catalogo viene ordenado por id, que ya es el orden natural de las
           pociones (Small, Great, Ultra, Hyper, Ultimate, Medicine). */
        potions.sort((a, b) => Number(a.id) - Number(b.id));
        captureCache.potions = potions;
    }

    /* El HUD (.phud-tloc) es donde el propio juego dice donde estas; de ahi se
       saca la hunt en curso para reiniciar el contador. */
    function getCaptureHuntLocation() {
        const raw = (document.querySelector('.phud-tloc')?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!raw) return '';
        return raw.replace(/^Level\s+\d+\s*[·|]\s*/i, '').trim();
    }

    function applyFieldKillEvent(data) {
        const name = String(data.speciesName || '').trim();
        if (!name) return;
        const location = getCaptureHuntLocation();
        /* Cambio de hunt: el contador vuelve a cero. field-kill solo llega
           durante una caza, asi que comparar la location basta. */
        if (location !== captureKillStats.location) {
            captureKillStats.location = location;
            captureKillStats.total = 0;
            captureKillStats.shiny = 0;
        }
        const isShiny = Boolean(data.shiny);
        captureKillStats.total += 1;
        if (isShiny) captureKillStats.shiny += 1;
        captureKillStats.lastName = name;
        captureKillStats.lastSprite = captureFallbackSprite(name);
        captureKillStats.lastShiny = isShiny;
        captureKillStats.at = Date.now();
    }

    function readCaptureSource() {
        const panel = findNativeCapturePanel();
        if (!panel) { captureCache.stale = true; return false; }

        /* El socket no dice que ball esta activa, asi que se sigue leyendo del
           panel nativo por indice, que coincide con el orden del catalogo. */
        const chips = Array.from(panel.querySelectorAll('.cap-chip'));
        const selectedIndex = chips.findIndex(chip => chip.classList.contains('on'));
        if (selectedIndex >= 0) captureCache.selectedBallId = captureCache.balls[selectedIndex]?.id || '';

        const wilds = Array.from(panel.querySelectorAll('.cap-row')).map(row => {
            const rawName = (row.querySelector('.cap-name')?.textContent || '').replace(/\s+/g, ' ').trim();
            const shiny = row.classList.contains('shiny') || rawName.startsWith('✨');
            const btn = row.querySelector('.cap-throw');
            return {
                name: rawName.replace(/^✨\s*/, '').replace(/\s+.*$/, '').trim(),
                shiny,
                level: (row.querySelector('.cap-lv')?.textContent || '').replace(/\s+/g, ' ').trim(),
                sprite: snapshotCaptureSprite(row.querySelector('.cap-ico canvas, .cap-ico img'), rawName),
                /* Se copian etiqueta y estado deshabilitado del boton nativo, con lo
                   que el cooldown de 4 s del juego se refleja solo. */
                throwLabel: (btn?.textContent || '').trim(),
                disabled: !btn || btn.disabled
            };
        });

        captureCache.wilds = wilds;
        captureCache.stale = false;
        return true;
    }

    /* Reconciliacion por indice: la barra se construye una vez y despues solo se
       parchea texto y clases, sin reescribir innerHTML en cada ciclo. El
       constructor recibe el item porque balls y pociones comparten contenedor y
       cada uno necesita su propio nodo. */
    function syncChipList(host, items, build, update) {
        while (host.children.length > items.length) host.lastElementChild.remove();
        for (let index = 0; index < items.length; index++) {
            if (!host.children[index]) host.appendChild(build(items[index], index));
            update(host.children[index], items[index], index);
        }
    }

    function setDockEmptyState(section, count, text) {
        const label = section.querySelector('.cc-dock-empty');
        if (!label) return;
        if (count > 0) { label.textContent = ''; label.style.display = 'none'; return; }
        label.textContent = text;
        label.style.display = '';
    }

    function buildBallChip() {
        const chip = document.createElement('button');
        chip.className = 'cc-dock-chip cc-dock-ball';
        chip.type = 'button';
        chip.innerHTML = '<img alt=""><span class="cc-dock-chip-n"></span>';
        return chip;
    }

    function buildPotionChip() {
        const chip = document.createElement('div');
        chip.className = 'cc-dock-chip cc-dock-potion';
        chip.innerHTML = '<img alt=""><span class="cc-dock-chip-n"></span>';
        return chip;
    }

    function buildWildChip() {
        const row = document.createElement('div');
        row.className = 'cc-dock-wild';
        row.innerHTML = '<img class="cc-dock-wild-ico" alt="">'
            + '<div class="cc-dock-wild-txt"><span class="cc-dock-wild-name"></span><span class="cc-dock-wild-lv"></span></div>'
            + '<button class="cc-dock-throw" type="button"></button>';
        return row;
    }

    /* Los botones + y - escalan la barra sobre la misma preferencia que ya usa el
       panel de ajustes, asi que ambos caminos quedan sincronizados y se guarda. */
    function stepCaptureScale(delta) {
        const options = SCRIPT_SCALE_OPTIONS;
        const index = options.indexOf(normalizeScalePercent(scriptScalePreferences.capture));
        const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
        if (next == null || next === scriptScalePreferences.capture) return;
        scriptScalePreferences.capture = next;
        saveScriptScalePreferences();
        applyScriptScales();
        updateCaptureDock();
    }

    const CAPTURE_EYE_SVG = '<svg class="cc-dock-eye" viewBox="0 0 24 24" aria-hidden="true">'
        + '<g class="cc-dock-eye-open"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="2.6"></circle></g>'
        + '<g class="cc-dock-eye-closed"><path d="M3 3l18 18"></path><path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c6.5 0 10 6 10 6a17.3 17.3 0 0 1-3.1 3.7"></path>'
        + '<path d="M6.3 6.3C3.8 8.1 2 12 2 12s3.5 6 10 6c1.1 0 2.1-.2 3-.5"></path><path d="M9.7 9.7a3.2 3.2 0 0 0 4.6 4.6"></path></g></svg>';

    function ensureCaptureDock() {
        if (!document.body) return null;
        const existing = document.getElementById('cc-cap-dock');
        if (existing) return existing;

        const dock = document.createElement('div');
        dock.id = 'cc-cap-dock';
        dock.className = 'cc-cap-dock';
        dock.setAttribute('role', 'status');
        dock.setAttribute('aria-label', 'Barra de captura');
        dock.innerHTML = '<div class="cc-cap-dock-inner">'
            + '<button class="cc-dock-eye-btn" type="button">' + CAPTURE_EYE_SVG + '</button>'
            + '<div class="cc-dock-sec cc-dock-controls">'
            + '<button class="cc-dock-scale-btn" type="button" data-step="-1" title="Reducir la barra">−</button>'
            + '<button class="cc-dock-scale-btn" type="button" data-step="1" title="Aumentar la barra">+</button></div>'
            + '<div class="cc-dock-sep"></div>'
            + '<div class="cc-dock-sec cc-dock-supplies"><div class="cc-dock-chips"></div><span class="cc-dock-empty"></span></div>'
            + '<div class="cc-dock-sep"></div>'
            + '<div class="cc-dock-sec cc-dock-wilds"><div class="cc-dock-chips"></div><span class="cc-dock-empty"></span></div>'
            + '<div class="cc-dock-sep"></div>'
            + '<div class="cc-dock-sec cc-dock-kills"><div class="cc-dock-chips"></div><span class="cc-dock-empty"></span></div>'
            + '</div>';
        document.body.appendChild(dock);

        /* Delegacion por indice: React reutiliza y reemplaza sus nodos, asi que
           guardar referencias directas al .cap-chip / .cap-throw nativos se
           quedaria obsoleto. Se resuelven en el momento del clic. El nodo
           nativo se busca entonces, y por mucho que este oculto el click
           sintetico llega a su manejador de React. */
        dock.addEventListener('click', event => {
            const scaleBtn = event.target.closest?.('.cc-dock-scale-btn');
            if (scaleBtn) { stepCaptureScale(Number(scaleBtn.dataset.step) || 0); return; }
            const ball = event.target.closest?.('.cc-dock-ball');
            if (ball) {
                const index = Array.prototype.indexOf.call(ball.parentElement.children, ball);
                const target = findNativeCapturePanel()?.querySelectorAll('.cap-chip')[index];
                if (target) target.click();
                return;
            }
            const throwBtn = event.target.closest?.('.cc-dock-throw');
            if (throwBtn && !throwBtn.disabled) {
                const row = throwBtn.closest('.cc-dock-wild');
                const index = Array.prototype.indexOf.call(row.parentElement.children, row);
                const target = findNativeCapturePanel()?.querySelectorAll('.cap-row .cap-throw')[index];
                if (target && !target.disabled) target.click();
            }
        });

        dock.querySelector('.cc-dock-eye-btn').addEventListener('click', toggleCaptureDockVisibility);
        ensureCaptureDockEyePill().addEventListener('click', toggleCaptureDockVisibility);
        return dock;
    }

    function toggleCaptureDockVisibility() {
        captureBarManuallyHidden = !captureBarManuallyHidden;
        applyCaptureDockCollapse();
    }

    /* Píldora con el ojo que queda en pantalla cuando la barra está oculta. Es un
       elemento aparte y no un trozo de la barra, porque la barra se sale completa
       por abajo y si el ojo fuera suyo se iría con ella. */
    function ensureCaptureDockEyePill() {
        let pill = document.getElementById('cc-cap-dock-eye');
        if (pill) return pill;
        pill = document.createElement('button');
        pill.id = 'cc-cap-dock-eye';
        pill.className = 'cc-cap-dock-eye';
        pill.type = 'button';
        pill.setAttribute('aria-label', 'Mostrar barra de captura');
        pill.innerHTML = CAPTURE_EYE_SVG;
        document.body.appendChild(pill);
        return pill;
    }

    function applyCaptureDockCollapse() {
        const dock = document.getElementById('cc-cap-dock');
        const hidden = captureBarManuallyHidden;
        if (dock) {
            dock.classList.toggle('is-collapsed', hidden);
            const eye = dock.querySelector('.cc-dock-eye-btn');
            if (eye) eye.title = hidden ? 'Mostrar barra de captura' : 'Ocultar barra de captura';
        }
        const pill = ensureCaptureDockEyePill();
        pill.classList.toggle('is-visible', hidden);
        pill.title = 'Mostrar barra de captura';
    }

    function updateCaptureDock() {
        const dock = ensureCaptureDock();
        if (!dock) return;
        readCaptureSource();
        /* Atenua el area de objetos y los salvajes cuando el panel nativo no esta
           montado: lo que sigue siendo del socket no se toca. */
        dock.classList.toggle('is-stale', captureCache.stale);

        /* Balls y pociones comparten el mismo contenedor y envuelven a dos filas. */
        const supplies = dock.querySelector('.cc-dock-supplies .cc-dock-chips');
        const suppliesItems = captureCache.balls
            .map(ball => ({ ...ball, kind: 'ball' }))
            .concat(captureCache.potions.map(potion => ({ ...potion, kind: 'potion' })));
        syncChipList(supplies, suppliesItems, item => item.kind === 'ball' ? buildBallChip() : buildPotionChip(), (el, item) => {
            const img = el.querySelector('img');
            if (img.getAttribute('src') !== item.icon) img.setAttribute('src', item.icon);
            el.querySelector('.cc-dock-chip-n').textContent = item.count;
            if (item.kind === 'ball') {
                el.classList.toggle('on', item.id === captureCache.selectedBallId);
                el.title = item.name || 'Ball';
            } else {
                el.title = `${item.name || 'Pocion'}${item.name ? ' — ' : ''}${item.count}`;
            }
        });
        setDockEmptyState(dock.querySelector('.cc-dock-supplies'), suppliesItems.length, 'Sin balls ni pociones');

        syncChipList(dock.querySelector('.cc-dock-wilds .cc-dock-chips'), captureCache.wilds, buildWildChip, (el, wild) => {
            const img = el.querySelector('.cc-dock-wild-ico');
            if (img.getAttribute('src') !== wild.sprite) img.setAttribute('src', wild.sprite);
            el.querySelector('.cc-dock-wild-name').textContent = wild.name;
            el.querySelector('.cc-dock-wild-lv').textContent = wild.level;
            const btn = el.querySelector('.cc-dock-throw');
            btn.textContent = wild.throwLabel || 'Lanzar';
            btn.disabled = wild.disabled;
            el.classList.toggle('shiny', wild.shiny);
        });
        setDockEmptyState(dock.querySelector('.cc-dock-wilds'), captureCache.wilds.length, 'Sin salvajes');

        /* Kills: un unico chip con el sprite del ultimo QA y el total de la hunt.
           El detalle va en el title para no ocupar ancho. */
        const killsSection = dock.querySelector('.cc-dock-kills');
        if (captureKillStats.total > 0) {
            let chip = killsSection.querySelector('.cc-dock-kill');
            if (!chip) {
                chip = document.createElement('div');
                chip.className = 'cc-dock-kill';
                chip.innerHTML = '<img alt=""><span class="cc-dock-kill-n"></span>';
                killsSection.querySelector('.cc-dock-chips').appendChild(chip);
            }
            const img = chip.querySelector('img');
            if (img.getAttribute('src') !== captureKillStats.lastSprite) img.setAttribute('src', captureKillStats.lastSprite);
            chip.querySelector('.cc-dock-kill-n').textContent = captureKillStats.total.toLocaleString('pt-BR');
            const shinyNote = captureKillStats.shiny > 0 ? ` · ${captureKillStats.shiny} shiny` : '';
            chip.title = `${captureKillStats.total} QA en esta hunt${shinyNote} · último: ${captureKillStats.lastName}`;
            chip.classList.toggle('is-new', Date.now() - captureKillStats.at < 5000);
            chip.classList.toggle('shiny', captureKillStats.shiny > 0);
        } else {
            killsSection.querySelector('.cc-dock-kill')?.remove();
        }
        setDockEmptyState(killsSection, captureKillStats.total, 'Sin kills');

        /* Los botones de escala se desactivan en los extremos del rango. */
        const scalePercent = normalizeScalePercent(scriptScalePreferences.capture);
        const scaleIndex = SCRIPT_SCALE_OPTIONS.indexOf(scalePercent);
        dock.querySelector('.cc-dock-scale-btn[data-step="-1"]').disabled = scaleIndex <= 0;
        dock.querySelector('.cc-dock-scale-btn[data-step="1"]').disabled = scaleIndex >= SCRIPT_SCALE_OPTIONS.length - 1;
        dock.querySelector('.cc-dock-controls').title = `Tamaño de la barra: ${scalePercent}%`;
    }

    /* Se conserva el nombre porque la llaman dos puntos de entrada ya existentes. */
    function setupCaptureBarToggle() {
        ensureCaptureDock();
        applyCaptureDockCollapse();
    }

    let phoneShopMenuFixAttached = false;
    function setupPhoneShopMenuFix() {
        if (phoneShopMenuFixAttached) return;
        phoneShopMenuFixAttached = true;

        const positionMenu = () => {
            const button = document.getElementById('dock-btn-shops');
            const menu = document.querySelector('.script-shop-menu');
            if (!button || !menu || menu.hidden) return;
            if (menu.parentElement !== document.body) document.body.appendChild(menu);

            const buttonRect = button.getBoundingClientRect();
            const dockRect = document.querySelector('.game-dock')?.getBoundingClientRect();
            const margin = 8;
            const menuWidth = Math.min(260, Math.max(190, window.innerWidth - margin * 2));
            const desiredHeight = Math.min(360, Math.max(130, menu.scrollHeight));
            const verticalDock = Boolean(dockRect && dockRect.height > dockRect.width && dockRect.right >= window.innerWidth - 20);
            let left;
            let top;
            let availableHeight;

            if (verticalDock) {
                left = Math.max(margin, buttonRect.left - menuWidth - margin);
                top = Math.max(margin, Math.min(window.innerHeight - desiredHeight - margin, buttonRect.top + buttonRect.height / 2 - desiredHeight / 2));
                availableHeight = window.innerHeight - top - margin;
            } else {
                left = Math.max(margin, Math.min(window.innerWidth - menuWidth - margin, buttonRect.left + buttonRect.width / 2 - menuWidth / 2));
                const below = window.innerHeight - buttonRect.bottom - margin;
                const above = buttonRect.top - margin;
                if (below >= desiredHeight || below >= above) {
                    top = buttonRect.bottom + margin;
                    availableHeight = below;
                } else {
                    availableHeight = above;
                    top = Math.max(margin, buttonRect.top - Math.min(desiredHeight, above) - margin);
                }
            }

            const important = (property, value) => menu.style.setProperty(property, value, 'important');
            important('position', 'fixed');
            important('left', `${left}px`);
            important('right', 'auto');
            important('top', `${top}px`);
            important('bottom', 'auto');
            important('width', `${menuWidth}px`);
            important('max-width', `calc(100vw - ${margin * 2}px)`);
            important('max-height', `${Math.max(100, availableHeight)}px`);
            important('height', 'auto');
            important('overflow-y', 'auto');
            important('z-index', '2147483646');
        };

        document.addEventListener('click', event => {
            const selectedMenuItem = event.target.closest?.('.script-shop-menu .poke-menu-item');
            if (selectedMenuItem) {
                const menu = selectedMenuItem.closest('.script-shop-menu');
                menu.hidden = true;
                menu.style.setProperty('display', 'none', 'important');
                requestAnimationFrame(() => menu.style.removeProperty('display'));
                return;
            }
            if (!event.target.closest?.('#dock-btn-shops')) return;
            requestAnimationFrame(() => requestAnimationFrame(positionMenu));
        }, true);
        window.addEventListener('resize', positionMenu, { passive: true });
        window.addEventListener('scroll', positionMenu, { passive: true });
    }

    let privateChatDockObserver = null;
    let privateChatObservedDock = null;
    let privateChatSyncQueued = false;
    const PRIVATE_CHAT_BUTTON_PATTERN = /(?:chat|mensag|mensaje|message|privad|private|whisper|sussurr|conversa|inbox|correio|mail|pm\b)/i;
    const PRIVATE_CHAT_BADGE_PATTERN = /(?:badge|unread|não[-_ ]?lid|nao[-_ ]?lid|no[-_ ]?le[ií]d|notif|message|mensag|count|counter|pending|new)/i;

    function getPrivateChatNodeDescriptor(node) {
        if (!(node instanceof Element)) return '';
        const attributes = ['id', 'class', 'title', 'aria-label', 'data-title', 'data-tooltip', 'data-action', 'data-target', 'href'];
        const own = attributes.map(name => node.getAttribute(name) || '').join(' ');
        const media = Array.from(node.querySelectorAll('img,svg,use')).map(icon => [
            icon.getAttribute('alt'), icon.getAttribute('title'), icon.getAttribute('src'),
            icon.getAttribute('href'), icon.getAttribute('xlink:href'), icon.getAttribute('aria-label')
        ].filter(Boolean).join(' ')).join(' ');
        return `${own} ${media} ${node.textContent || ''}`.replace(/\s+/g, ' ').trim();
    }

    function findPrivateChatDockButton(dock) {
        if (!dock) return null;
        const explicitSelectors = [
            '#dock-btn-chat', '#dock-btn-messages', '#dock-btn-private-chat', '#dock-btn-pm',
            '[data-action*="chat" i]', '[data-action*="message" i]', '[data-target*="chat" i]',
            '[title*="chat" i]', '[aria-label*="chat" i]', '[title*="mens" i]', '[aria-label*="mens" i]'
        ];
        for (const selector of explicitSelectors) {
            const match = dock.querySelector(selector);
            if (match) {
                let button = match;
                while (button.parentElement && button.parentElement !== dock) button = button.parentElement;
                return button;
            }
        }
        let best = null;
        let bestScore = 0;
        Array.from(dock.children).forEach(button => {
            if (button.id === 'dock-toggle-btn' || button.classList.contains('script-shop-menu')) return;
            const descriptor = getPrivateChatNodeDescriptor(button);
            if (!PRIVATE_CHAT_BUTTON_PATTERN.test(descriptor)) return;
            let score = 1;
            if (/(?:private|privad|whisper|sussurr|pm\b)/i.test(descriptor)) score += 4;
            if (/(?:message|mensag|mensaje|chat)/i.test(button.id + ' ' + button.className)) score += 3;
            if (button.matches('button,a,[role="button"]')) score += 1;
            if (score > bestScore) { best = button; bestScore = score; }
        });
        return best;
    }

    function normalizePrivateUnreadValue(value) {
        const text = String(value ?? '').trim();
        if (!text) return null;
        const match = text.match(/(?:^|\D)(\d{1,5})(?:\+)?(?:\D|$)/);
        if (!match) return null;
        const count = Math.max(0, Number(match[1]) || 0);
        return count > 0 ? { count, text:count > 99 ? '99+' : String(count) } : { count:0, text:'' };
    }

    function readPrivateChatUnreadState(button) {
        const buttonCountAttributes = ['data-unread', 'data-unread-count', 'data-message-count', 'data-messages', 'data-count', 'aria-label', 'title'];
        for (const attribute of buttonCountAttributes) {
            const value = button.getAttribute(attribute);
            if (value == null || (attribute === 'aria-label' || attribute === 'title') && !PRIVATE_CHAT_BADGE_PATTERN.test(value)) continue;
            const state = normalizePrivateUnreadValue(value);
            if (state) return state.count ? state : null;
        }

        const candidates = Array.from(button.querySelectorAll('span,small,b,i,em,strong,div')).filter(node => {
            if (node.classList.contains('script-private-chat-badge')) return false;
            const descriptor = [node.id, node.className, node.getAttribute('aria-label'), node.getAttribute('title')].filter(Boolean).join(' ');
            const text = (node.textContent || '').trim();
            const hasCountAttribute = node.getAttributeNames().some(name => PRIVATE_CHAT_BADGE_PATTERN.test(name));
            return PRIVATE_CHAT_BADGE_PATTERN.test(descriptor) || hasCountAttribute || /^\d{1,5}\+?$/.test(text);
        });

        let best = null;
        for (const node of candidates) {
            const inactive = node.hidden || node.getAttribute('aria-hidden') === 'true' || node.style.display === 'none'
                || /(?:^|\s)(?:hidden|is-hidden|empty|inactive)(?:\s|$)/i.test(node.className);
            if (inactive) continue;
            const values = [node.textContent, node.getAttribute('data-unread'), node.getAttribute('data-count'),
                node.getAttribute('data-message-count'), node.getAttribute('aria-label'), node.getAttribute('title')];
            let hasExplicitCount = false;
            for (const value of values) {
                const state = normalizePrivateUnreadValue(value);
                if (state) hasExplicitCount = true;
                if (state?.count && (!best || state.count > best.count)) best = state;
            }
            if (!best && !hasExplicitCount && /(?:unread|não[-_ ]?lid|nao[-_ ]?lid|no[-_ ]?le[ií]d|new|active)/i.test(node.className)) {
                best = { count:1, text:'•' };
            }
        }
        return best;
    }

    function syncPrivateChatDockBadge() {
        privateChatSyncQueued = false;
        const dock = document.querySelector('.game-dock');
        if (!dock) return;
        const chatButton = findPrivateChatDockButton(dock);
        dock.querySelectorAll('.script-private-chat-button').forEach(button => {
            if (button !== chatButton) {
                button.classList.remove('script-private-chat-button', 'has-private-unread');
                button.querySelector('.script-private-chat-badge')?.remove();
            }
        });
        if (!chatButton) {
            privateChatDockObserver?.takeRecords();
            return;
        }

        chatButton.classList.add('script-private-chat-button');
        const unread = readPrivateChatUnreadState(chatButton);
        /* El juego ya pinta su propia insignia con este mismo número, así que
           aquí no se crea una segunda: solo se marca el botón para el resalte
           rojo. Cualquierbadge de una versión anterior se retira. */
        chatButton.querySelector(':scope > .script-private-chat-badge')?.remove();
        if (!unread?.count) {
            chatButton.classList.remove('has-private-unread');
            chatButton.removeAttribute('data-script-private-unread');
            privateChatDockObserver?.takeRecords();
            return;
        }
        if (chatButton.dataset.scriptPrivateUnread !== String(unread.count)) chatButton.dataset.scriptPrivateUnread = String(unread.count);
        chatButton.classList.add('has-private-unread');
        // Descarta únicamente las mutaciones visuales creadas por este espejo para no retroalimentar el observador.
        privateChatDockObserver?.takeRecords();
    }

    function queuePrivateChatDockBadgeSync() {
        if (privateChatSyncQueued) return;
        privateChatSyncQueued = true;
        queueMicrotask(syncPrivateChatDockBadge);
    }

    function setupPrivateChatDockBadge() {
        const dock = document.querySelector('.game-dock');
        if (!dock) return;
        if (privateChatObservedDock !== dock) {
            privateChatDockObserver?.disconnect();
            privateChatObservedDock = dock;
            privateChatDockObserver = new MutationObserver(queuePrivateChatDockBadgeSync);
            privateChatDockObserver.observe(dock, {
                childList:true, subtree:true, characterData:true, attributes:true,
                attributeFilter:['class', 'style', 'hidden', 'aria-hidden', 'aria-label', 'title', 'data-unread', 'data-unread-count', 'data-message-count', 'data-messages', 'data-count']
            });
            queuePrivateChatDockBadgeSync();
        }
    }

    /* Chevrons de ocultar y mostrar el dock. Se usan dos SVGs en vez del glifo
       ▲/▼ porque el texto cambiaba de tamaño segun la fuente del sistema. */
    const DOCK_ARROW_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"></path></svg>';
    const DOCK_ARROW_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';

    function applyDockVisibility() {
        const dock = document.querySelector('.game-dock');
        if (!dock) return;
        const hidden = dock.classList.contains('hidden-dock');
        const showBtn = document.getElementById('dock-show-btn');
        if (showBtn) showBtn.classList.toggle('is-visible', hidden);
    }

    function setupDockToggle() {
        const dock = document.querySelector('.game-dock');
        if (!dock) return;

        if (dock.dataset.scriptInitialHidden !== 'true') {
            dock.dataset.scriptInitialHidden = 'true';
            dock.classList.add('hidden-dock');
        }

        let hideBtn = document.getElementById('dock-toggle-btn');
        if (!hideBtn) {
            hideBtn = document.createElement('button');
            hideBtn.id = 'dock-toggle-btn';
            hideBtn.type = 'button';
            hideBtn.title = 'Ocultar navegación';
            hideBtn.setAttribute('aria-label', 'Ocultar dock de navegación');
            hideBtn.innerHTML = DOCK_ARROW_UP;
            hideBtn.onclick = () => {
                dock.classList.add('hidden-dock');
                applyDockVisibility();
            };
            dock.appendChild(hideBtn);
        }

        /* La píldora vive fuera del dock a propósito: el dock se desliza hacia
           arriba al ocultarse y se llevaría consigo cualquier botón que
           estuviera dentro, dejándolo sin forma de volver a mostrarse. */
        let showBtn = document.getElementById('dock-show-btn');
        if (!showBtn) {
            showBtn = document.createElement('button');
            showBtn.id = 'dock-show-btn';
            showBtn.type = 'button';
            showBtn.title = 'Mostrar navegación';
            showBtn.setAttribute('aria-label', 'Mostrar dock de navegación');
            showBtn.innerHTML = DOCK_ARROW_DOWN;
            showBtn.onclick = () => {
                dock.classList.remove('hidden-dock');
                applyDockVisibility();
            };
            document.body.appendChild(showBtn);
        }

        applyDockVisibility();
    }

    /* Dock de navegación (flexbox): fija el ancho máximo del marco para que los
       botones se repartan en dos filas y ni una más. */
    function layoutDockRows() {
        const dock = document.querySelector('.game-dock');
        if (!dock) return;

        /* El juego envuelve los botones en .dock-scroll (lo disolvemos con
           display:contents); medimos sus hijos reales, no el contenedor. */
        const holder = dock.querySelector(':scope > .dock-scroll') || dock;
        const items = Array.from(holder.children).filter(el => {
            if (el.id === 'dock-toggle-btn' || el.id === 'dock-show-btn') return false;
            if (el.hidden || el.offsetWidth <= 0) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });

        const count = items.length;
        /* Con menos de dos botones medibles no hay nada que calcular. Antes se
           ponía 98vw en ese caso y eso era justo lo que estiraba la barra a una
           sola fila: ese estado transitorio ocurre mientras el juego reconstruye
           el dock, por ejemplo al pasar el ratón por encima. */
        if (count < 2) return;

        const GAP_PX = 4; // debe coincidir con el gap de .game-dock en CSS
        const perRow = Math.ceil(count / 2);

        /* Cuenta las filas reales por la posición vertical de cada botón. Es
           insensible al escalado del dock, a diferencia de los anchos. */
        const countRows = () => {
            const tops = new Set();
            items.forEach(el => tops.add(Math.round(el.getBoundingClientRect().top)));
            return tops.size;
        };
        const setMaxWidth = value => dock.style.setProperty('--cc-dock-maxw', `${Math.round(value)}px`);

        /* Si ya está en dos filas y el número de botones no ha cambiado, no se
           toca nada: así no se fuerza un reflow en cada paso del refresco. */
        const currentMax = Math.round(parseFloat(getComputedStyle(dock).maxWidth) || 0);
        if (currentMax > 0 && dock.dataset.ccDockRows === String(count) && countRows() === 2) return;

        /* Ancho analítico para ceil(count/2) botones por fila. offsetWidth es el
           ancho de layout, que es lo que necesita un max-width;
           getBoundingClientRect devolvería el ancho ya escalado por
           --cc-scale-dock y no valdría. */
        const widths = items.map(el => el.offsetWidth).sort((a, b) => b - a);
        let contentWidth = GAP_PX * Math.max(0, perRow - 1);
        for (let i = 0; i < perRow && i < widths.length; i++) contentWidth += widths[i];

        // max-width se aplica al borde exterior: sumar padding y bordes.
        const dockStyle = getComputedStyle(dock);
        const chrome = (parseFloat(dockStyle.paddingLeft) || 0) + (parseFloat(dockStyle.paddingRight) || 0)
            + (parseFloat(dockStyle.borderLeftWidth) || 0) + (parseFloat(dockStyle.borderRightWidth) || 0);
        const needed = Math.ceil(contentWidth + chrome) + 2;

        setMaxWidth(needed);
        let rows = countRows();

        /* El ancho teórico se queda corto alguna vez porque el redondeo de
           offsetWidth pierde un hueco entero. Si aún no caben en dos filas, se
           agranda un 8% por paso, con tope de tres pasos. */
        for (let step = 0; step < 3 && rows > 2; step++) {
            setMaxWidth(Math.ceil(parseFloat(getComputedStyle(dock).maxWidth) * 1.08));
            rows = countRows();
        }

        /* Si el agrandamiento acabó en una sola fila, se vuelve al ancho
           calculado: el objetivo son dos filas, no "dos o menos". */
        if (rows < 2) { setMaxWidth(needed); rows = countRows(); }

        dock.dataset.ccDockRows = String(count);
    }

    function themePartyBars() {
        const partyContainer = document.querySelector('.phud-party');
        if (!partyContainer) return;
        
        const partyNodes = partyContainer.children;
        for (let i = 0; i < partyNodes.length; i++) {
            let node = partyNodes[i];
            
            let avatarBox = node.firstElementChild; 
            if (avatarBox) {
                /* Antes se pintaba un fondo opaco detrás del sprite. Como se
                   aplicaba en línea con !important, ganaba a cualquier regla de
                   la hoja de estilos y el sprite quedaba siempre sobre un
                   rectángulo gris. Ahora se quita: el cristal lo lleva la
                   tarjeta del Pokémon, no el hueco del sprite. */
                avatarBox.style.removeProperty('background');
                avatarBox.style.removeProperty('background-color');
                avatarBox.style.removeProperty('background-image');
            }

            let matchedPoke = teamData[i]; 
            let nodeText = node.innerText.toLowerCase();
            let foundByName = teamData.find(p => p.name && nodeText.includes(p.name.toLowerCase()));
            if (foundByName) matchedPoke = foundByName;

            /* Solo se tiñen las barras de verdad. El fallback anterior era
               [style*="width"], y el <canvas> del sprite lleva "width: 40px" en
               su estilo: por eso aparecía un degradado de color detrás de cada
               Pokémon. Ahora se busca solo la barra y, si acaso, se descarta
               cualquier canvas. */
            const hpBar = node.querySelector('.sbar-hp .sbar-fill, .progress-bar')
                || Array.from(node.querySelectorAll('[style*="width"]')).find(el => el.tagName !== 'CANVAS');
            if (!hpBar) continue;

            if (matchedPoke) {
                let types = matchedPoke.types || matchedPoke.type || matchedPoke.elements;
                let t1 = Array.isArray(types) ? types[0] : (typeof types === 'string' ? types : matchedPoke.type1);
                let t2 = Array.isArray(types) ? types[1] : matchedPoke.type2;
                let color1 = getTypeColor(t1);
                let color2 = getTypeColor(t2) || color1;
                hpBar.style.background = `linear-gradient(90deg, ${color1}, ${color2})`;
            } else {
                hpBar.style.background = 'linear-gradient(90deg, #16a34a, #22c55e)';
            }
        }
    }

    function minifyMarketButtons() {
        document.querySelectorAll('.market-cta').forEach(btn => {
            btn.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    node.nodeValue = ''; 
                }
            });
        });
    }

    function updateHeroCardLive() {
        const originalCard = document.querySelector('.cbt-card.cbt-hero');
        if (!originalCard) {
            document.body?.classList.remove('script-custom-hero-ready');
            document.getElementById('my-custom-poke-card')?.remove();
            lastRenderKey = "";
            return;
        }

        let customCard = document.getElementById('my-custom-poke-card');
        
        if (latestPokemonData) {
            const originalText = originalCard.textContent;
            
            if (originalCard.dataset.lastText !== originalText) {
                originalCard.dataset.lastText = originalText;
                
                let changed = false;
                const lvlMatch = originalText.match(/(?:Lv|Nv)\.?\s*(\d+)/i);
                if (lvlMatch && latestPokemonData.level != lvlMatch[1]) {
                    latestPokemonData.level = parseInt(lvlMatch[1]);
                    changed = true;
                }
                
                if (!latestPokemonData.stats) latestPokemonData.stats = {};
                
                const parseStat = (regex, statKey) => {
                    const match = originalText.match(regex);
                    if (match) {
                        const val = match[1].replace(/,/g, '');
                        if (latestPokemonData.stats[statKey] != val) {
                            latestPokemonData.stats[statKey] = val;
                            changed = true;
                        }
                    }
                };

                parseStat(/HP\s*([\d,.]+)/i, 'hp');
                parseStat(/Atk\s*([\d,.]+)/i, 'atk');
                parseStat(/Def\s*([\d,.]+)/i, 'def');
                parseStat(/SpA\s*([\d,.]+)/i, 'spa');
                parseStat(/SpD\s*([\d,.]+)/i, 'spd');
                parseStat(/(?:Vel|Spe)\s*([\d,.]+)/i, 'vel');
                
                const pwrMatch = originalText.match(/(?:Poder|Power|CP)\s*([\d,.]+)/i); 
                if (pwrMatch) { 
                    let val = pwrMatch[1].replace(/,/g, ''); 
                    if(latestPokemonData.power != val) { 
                        latestPokemonData.power = val; 
                        latestPokemonData.cp = val; 
                        changed = true; 
                    } 
                }

                if (changed) lastRenderKey = ""; 
            }
        }

        if (!customCard || lastRenderKey === "") renderCustomCard();
    }

/* --------------------------------------------------------------- */
    /* CARD DEL ENEMIGO                                                 */
    /* --------------------------------------------------------------- */
/* Datos de los salvajes tomados del evento `pending` del socket, que trae
       speciesId, nombre, shiny, hp/maxHp y exp/maxExp. Se leen de ahi y no del
       DOM porque:
         - el nombre que pinta el juego puede traer un subnombre de variante
           ("Deoxys Attack", "Rotom Wash", formas regionales...) que no existe
           en PokeAPI, y con el nombre completo la busqueda del sprite siempre
           fallaba; con el speciesId se busca sin adivinar nada;
         - los numeros de vida llegan ya calculados y no hay que rasparlos.
       El speciesId solo se puede pedir al socket: la card nativa del juego
       escribe unicamente el nombre. Si por lo que sea no llegara, se recurre a
       PokeAPI con el nombre limpio y se cachea por especie. */

    const ccSpeciesCache = new Map();
    const ccWildState = { list: [], stamp: 0, identity: '' };

    function applyPendingEvent(data) {
        const list = Array.isArray(data?.list) ? data.list : [];
        ccWildState.list = list;
        ccWildState.stamp = Date.now();
        /* Solo se fuerza el repintado cuando cambia QUE Pokemon es, no en cada
           evento: pending tambien llega con los golpes de vida y rehacer el
           innerHTML en cada golpeeria el efecto de captura en curso. */
        const identity = list.map(entry =>
            `${entry.speciesId ?? '?'}:${entry.shiny ? 1 : 0}:${entry.slot ?? entry.id ?? '?'}`).join(',');
        if (identity !== ccWildState.identity) {
            ccWildState.identity = identity;
            const enemy = document.getElementById('my-custom-mob-card');
            if (enemy) delete enemy.dataset.ccKey;
        }
    }

    /* Quita acentos, signos y el nivel del final para poder comparar nombres.
       El nivel se va aqui y no en el llamante porque el nombre aparece con
       formato distinto en cada sitio: la card nativa lo pinta al final
       ("Enraged Typhlosion Nv 50") y el socket lo manda sin el. */
    function ccFoldName(value) {
        return String(value || '')
            .replace(/\s+(?:lv|nv)\.?\s*\d+\s*$/i, ' ')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/gi, ' ')
            .trim().toLowerCase();
    }

    /* El salvaje que esta mostrando nuestra card. El juego dibuja las cards en
       el mismo orden que la lista del socket, asi que la primera de la lista es
       la que corresponde a la primera card nativa. Si el socket trae nombre se
       usa para confirmar que es la misma. */
    function ccCurrentWild() {
        const list = ccWildState.list;
        if (!list || list.length === 0) return null;
        const shown = ccFoldName(document.querySelector('.cbt-card.cbt-mob .cbt-cardname')?.textContent);
        if (shown) {
            const match = list.find(entry => ccFoldName(entry.name) === shown);
            if (match) return match;
            /* El nombre pintado puede traer el marcador de shiny delante; en
               ese caso se busca como subcadena. */
            const inside = list.find(entry => ccFoldName(entry.name) && shown.includes(ccFoldName(entry.name)));
            if (inside) return inside;
        }
        return list[0];
    }

    /* El juego anade subnombres a la especie (formas alternativas, variantes
       regionales, marcas). Se generan varias opciones de busqueda, de la mas
       concreta a la mas simple, para que PokeAPI acierte aunque el nombre sea
       compuesto. Solo se usa cuando el socket no trae speciesId. */
    function ccSpeciesNameCandidates(rawName) {
        const base = String(rawName || '').trim();
        if (!base) return [];
        const candidates = new Set([base]);

        /* Quita el nivel del final. */
        const noLevel = base.replace(/\s+(?:lv|nv)\.?\s*\d+\s*$/i, '').trim();
        if (noLevel) candidates.add(noLevel);

        /* Marcador de shiny o icono delante del nombre. */
        const noMarker = base.replace(/^[^A-Za-z0-9]+/, '').trim();
        if (noMarker) candidates.add(noMarker);

        /* Separadores: "Giratina-Origin", "Unown | B", "Deoxys . Attack". */
        const cut = noLevel.split(/\s*[-\u2013\u2014|.\u00b7\u2022]\s*/)[0].trim();
        if (cut) candidates.add(cut);

        /* Sufijos de forma alternativa que PokeAPI no tiene. */
        const forms = /\s+(?:origin|altered|sky|ground|plant|ice|shadow|hero|sun|moon|primal|mega|gmax|gigantamax|eternamax|hisuian|paldean|alolan|galarian|hisui|black|white|blade)\b.*$/i;
        /* Y prefijos: "Alolan Raichu" -> "Raichu", "Mega Gengar" -> "Gengar". */
        const prefixes = /^(?:mega|gmax|gigantamax|eternamax|primal|origin|altered|hisuian|paldean|alolan|galarian|hisui|black|white|blade|sky|shadow|hero)\s+/i;
        for (const name of [noLevel, noMarker, cut]) {
            const stripped = name.replace(forms, '').trim();
            if (stripped && stripped.length > 2) candidates.add(stripped);
            const unprefixed = name.replace(prefixes, '').trim();
            if (unprefixed && unprefixed.length > 2) candidates.add(unprefixed);
        }

        /* Primeras palabras: "Deoxys Attack" -> "Deoxys Attack" y "Deoxys". */
        const words = noLevel.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
            candidates.add(words.slice(0, 2).join(' '));
            if (words[0].length > 3) candidates.add(words[0]);
            /* Red de seguridad para los modificadores de mapa que se inventen
               mas adelante: "Enraged Typhlosion" -> "Typhlosion", quitando la
               primera palabra o la ultima, sin lista cerrada de prefijos. */
            const sinPrimera = words.slice(1).join(' ');
            const sinUltima = words.slice(0, -1).join(' ');
            if (sinPrimera.length > 2) candidates.add(sinPrimera);
            if (sinUltima.length > 2) candidates.add(sinUltima);
            words.forEach(word => { if (word.length > 3) candidates.add(word); });
        }

        return [...candidates].filter(name => name.length > 1);
    }

    /* --------------------------------------------------------------- */
    /* CATALOGO DE CRIATURAS DEL JUEGO                                 */
    /* --------------------------------------------------------------- */
    /* El juego publica /game/creatures.json con las 647 especies que usa. Es
       la fuente exacta para saber que Pokemon se esta mostrando, y clave para
       el problema de los subnombres de mapa:

         10522  "Enraged Typhlosion"  captureBase: 157  looktype: 323
          157  "Typhlosion"                            looktype: 323

       La variante tiene su propio pokeId (10522, que no existe en PokeAPI) pero
       declara `captureBase` con el id de la especie base, que es justo el que
       necesitan las URLs de sprite. Y ese pokeId coincide con el id de la
       pokedex de PokeAPI, asi que sirve directamente para construir la imagen.

       Gracias a esto el subnombre lo resuelve el propio juego: no hay que
       adivinar qué palabra es el nombre original ni depender de la red. */

    let ccCreatureIndex = null;
    let ccCreatureRequest = null;

    function ccLoadCreatures() {
        if (ccCreatureIndex) return Promise.resolve(ccCreatureIndex);
        if (ccCreatureRequest) return ccCreatureRequest;
        ccCreatureRequest = fetch('/game/creatures.json')
            .then(response => (response.ok ? response.json() : null))
            .then(data => {
                const list = Array.isArray(data?.creatures) ? data.creatures : [];
                const index = new Map();
                list.forEach(entry => {
                    const key = ccFoldName(entry.name);
                    if (key && !index.has(key)) index.set(key, entry);
                });
                ccCreatureIndex = index;
                return index;
            })
            .catch(() => { ccCreatureIndex = new Map(); return ccCreatureIndex; });
        return ccCreatureRequest;
    }

    /* Id de especie (el de la pokedex) a partir del nombre que pinta el juego.
       Devuelve null si el catalogo no lo tiene. */
    function ccSpeciesIdFromCatalog(name) {
        if (!ccCreatureIndex) return null;
        const entry = ccCreatureIndex.get(ccFoldName(name));
        if (!entry) return null;
        /* captureBase es la especie base de las variantes de mapa. */
        const base = Number(entry.captureBase);
        if (Number.isFinite(base) && base > 0) return base;
        const id = Number(entry.pokeId);
        return Number.isFinite(id) && id > 0 ? id : null;
    }

    /* Tipo y rareza del enemigo, que el catalogo tambien trae. */
    function ccCreatureTypes(name) {
        const entry = ccCreatureIndex?.get(ccFoldName(name));
        if (!entry) return [];
        return [entry.type1, entry.type2].filter(Boolean).map(ccTypeLabel).filter(Boolean);
    }

    /* Se pide al arrancar para que el catalogo este listo antes de que aparezca
       el primer salvaje: son 647 filas, el juego ya lo descarga para sus
       propios sprites, asi que suele salir de la cache de red. */
    ccLoadCreatures();

    function ccResolveSpeciesAny(name) {
        /* Primero el catalogo del juego: es exacto y no necesita red. */
        return ccLoadCreatures()
            .then(() => ccSpeciesIdFromCatalog(name))
            .then(id => {
                if (id) return id;
                /* Si el nombre no esta tal cual, se prueban las variantes
                   depuradas (nivel, marcador de shiny, prefijos y sufijos de
                   forma) contra el catalogo, y solo como ultimo recurso se
                   pregunta a PokeAPI. */
                const candidates = ccSpeciesNameCandidates(name);
                for (const candidate of candidates) {
                    const found = ccSpeciesIdFromCatalog(candidate);
                    if (found) return found;
                }
                return candidates.reduce((chain, candidate) =>
                    chain.then(res => res || ccResolveSpecies(candidate)), Promise.resolve(null));
            });
    }

    function ccResolveSpecies(name) {
        const key = String(name || '').trim().toLowerCase();
        if (!key) return Promise.resolve(null);
        if (ccSpeciesCache.has(key)) return Promise.resolve(ccSpeciesCache.get(key));
        return fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(key)}`)
            .then(response => (response.ok ? response.json() : null))
            .then(data => {
                const id = data && data.id ? data.id : null;
                ccSpeciesCache.set(key, id);
                return id;
            })
            .catch(() => { ccSpeciesCache.set(key, null); return null; });
    }

    /* Sprite del enemigo. Si ya se conoce la especie se usan las 8 versiones
       elegidas en el menu; si no, se copia el canvas del juego. */
    function ccEnemySpriteHtml(name, speciesId) {
        if (speciesId) {
            const source = spriteById(scriptCardPreferences.sprite);
            const fallback = spriteById('pixel').url(speciesId);
            return `<img class="cc-spr cc-enemy-spr${source.px ? ' pixel' : ''}${source.anim ? ' anim' : ''}" src="${source.url(speciesId)}" alt="${name}" onerror="this.onerror=null;this.src='${fallback}';this.className=this.className.replace(' anim','')">`;
        }
        return `<div class="cc-enemy-canvas"><canvas class="mob-sprite-canvas" width="64" height="64"></canvas></div>`;
    }

    /* El enemigo tiene una sola estructura para los 7 temas: cc-mob-name, cc-mob-art
       y cc-mobbar. Solo los temas 4 y 6 envuelven el sprite en un anillo. */
    function ccEnemyRingSvg(hpPct) {
        const C = 2 * Math.PI * 21.5;
        const offset = C * (1 - Math.min(100, Math.max(0, hpPct)) / 100);
        return `<svg class="cc-mob-ring" viewBox="0 0 46 46">
            <circle class="trk" cx="23" cy="23" r="21.5"></circle>
            <circle class="fil" cx="23" cy="23" r="21.5" stroke-dasharray="${C}" stroke-dashoffset="${offset}"></circle>
        </svg>`;
    }

    function ccEnemyMarkup(themeId, name, speciesId, hpPct) {
        const sprite = ccEnemySpriteHtml(name, speciesId);
        const showPct = scriptCardPreferences.showPct;
        const bar = `<div class="cc-mobbar">
            <span class="k">HP</span>
            <div class="cpc-bar-wrapper"><div class="cpc-bar-fill mob-hp-fill cpc-hp-high" style="width:100%"></div></div>
            ${showPct ? `<span class="v">${Math.round(hpPct)}%</span>` : ''}
        </div>`;
        const ring = (themeId === '4' || themeId === '6')
            ? `<div class="cc-mob-art ringed">${ccEnemyRingSvg(hpPct)}
                 <div class="cc-mob-art-in">${sprite}</div>
                 <span class="cc-mob-pct">${Math.round(hpPct)}%</span></div>`
            : `<div class="cc-mob-art">${sprite}</div>`;
        if (themeId === '3') {
            return `<div class="cc-in">
                <div class="cc-head"><div class="cc-mob-name">${name}</div></div>
                ${ring}
                <div class="cc-hp">${bar}</div>
            </div>`;
        }
        return `<div class="cc-mob-name">${name}</div>${ring}${bar}`;
    }

    function updateMobCard() {
        const mobCard = document.querySelector('.cbt-card.cbt-mob');
        let customMobCard = document.getElementById('my-custom-mob-card');

        if (!mobCard) {
            if (customMobCard) customMobCard.remove();
            /* El ultimo punto guardado se limpia cuando ya no hay salvajes,
               salvo que haya una captura en vuelo: en un acierto el Pokemon
               desaparece justo al resolverse y el efecto aun lo necesita. */
            if (!captureState.busy) ccLastEnemySpot = null;
            document.body?.classList.remove('script-custom-mob-ready');
            return;
        }

        if (!customMobCard) {
            customMobCard = document.createElement('div');
            customMobCard.id = 'my-custom-mob-card';
            mobCard.parentElement.appendChild(customMobCard);
        }

        const theme = themeById(scriptCardPreferences.theme);
        customMobCard.className = `custom-poke-card cc-mob ${theme.cls}`;

        /* ---- fuente de verdad: el socket y el catalogo del juego ---- */
        /* El evento pending trae speciesId, hp/maxHp y shiny. Si no hay nada
           pendiente (lo normal, porque la lista se vacia en cuanto el
           Auto-Helper lanza) se trabaja con el nombre que pinta la card
           nativa y se resuelve la especie contra /game/creatures.json, que
           conoce las variantes de mapa y su `captureBase`. */
        const wild = ccCurrentWild();
        const nameEl = mobCard.querySelector('.cbt-cardname');
        const rawName = nameEl ? nameEl.textContent.trim() : '';
        /* El nombre que se muestra sigue siendo el del juego (con su shiny y
           su subnombre), pero el sprite se busca por id de especie. */
        const name = (rawName.match(/(.*?)\s+(Lv\.?|Nv\.?)\s*\d+/i)?.[1] || rawName).trim();
        const nameKey = ccFoldName(name);

        /* El id cacheado solo se reutiliza si es del mismo Pokemon: si no,
           al aparecer un salvaje distinto se estaria pintando el sprite del
           anterior. */
        const cachedName = customMobCard.dataset.ccSpeciesName || '';
        if (cachedName && cachedName !== nameKey) {
            delete customMobCard.dataset.ccSpecies;
            delete customMobCard.dataset.ccSpeciesName;
        }

        let speciesId = wild?.speciesId ? Number(wild.speciesId) || null : null;
        if (!speciesId) {
            /* El catalogo ya descargado resuelve en el acto, sin parpadeo del
               sprite de reserva. */
            speciesId = ccSpeciesIdFromCatalog(name) || null;
            if (!speciesId) {
                const cached = Number(customMobCard.dataset.ccSpecies);
                speciesId = Number.isFinite(cached) && cached > 0 ? cached : null;
            }
        }

        /* ---- vida: la del socket si esta, si no la de la barra nativa ---- */
        let hpPct = null;
        if (wild && Number(wild.maxHp) > 0) {
            hpPct = (Number(wild.hp) / Number(wild.maxHp)) * 100;
        }
        if (hpPct === null) {
            const hpTrackEl = mobCard.querySelector('.cbt-bar-track');
            const hpText = mobCard.querySelector('.cbt-bar-lbl')?.textContent?.trim() || '';
            const barChild = hpTrackEl?.querySelector('[style*="width"]');
            if (barChild) {
                hpPct = parseFloat(barChild.style.width) || 100;
            } else {
                const m = hpText.match(/([0-9.,]+)[kMBT]?\s*\/\s*([0-9.,]+)[kMBT]?/i);
                hpPct = m ? (parseFloat(m[1].replace(/,/g, '')) / parseFloat(m[2].replace(/,/g, ''))) * 100 : 100;
            }
        }
        hpPct = Math.max(0, Math.min(100, isFinite(hpPct) ? hpPct : 100));

        /* ---- reconstruccion: solo si cambian los datos que la sostienen ---- */
        const markupKey = `${name}|${theme.id}|${scriptCardPreferences.sprite}|${speciesId}|${scriptCardPreferences.showPct}`;
        if (customMobCard.dataset.ccKey !== markupKey) {
            customMobCard.dataset.ccKey = markupKey;
            customMobCard.innerHTML = ccEnemyMarkup(theme.id, name, speciesId, hpPct);
            /* Plan B: sin speciesId del socket ni del catalogo, se resuelve por
               nombre limpio (el catalogo puede tardar en estar descargado). */
            if (!speciesId && name) {
                ccResolveSpeciesAny(name).then(id => {
                    if (!id || !customMobCard.isConnected) return;
                    if (customMobCard.dataset.ccSpecies === String(id)) return;
                    customMobCard.dataset.ccSpecies = String(id);
                    customMobCard.dataset.ccSpeciesName = nameKey;
                    customMobCard.dataset.ccKey = '';
                    updateMobCard();
                });
            }
        }

        /* ---- refresco barato: HP cada ciclo ---- */
        /* Se guarda donde esta el enemigo para que la animacion de captura
           pueda dibujarse aunque la card ya se haya borrado. */
        ccLastEnemySpot = ccEnemySpot(customMobCard, ccCaptureLayer());

        const hpFill = customMobCard.querySelector('.mob-hp-fill');
        if (hpFill) {
            hpFill.style.width = hpPct + '%';
            const hpClass = hpPct <= 20 ? 'cpc-hp-low' : hpPct <= 50 ? 'cpc-hp-med' : 'cpc-hp-high';
            hpFill.className = `cpc-bar-fill mob-hp-fill ${hpClass}`;
        }
        const pctEl = customMobCard.querySelector('.cc-mob-pct');
        if (pctEl) pctEl.textContent = `${Math.round(hpPct)}%`;
        const pctText = customMobCard.querySelector('.cc-mobbar .v');
        if (pctText && scriptCardPreferences.showPct) pctText.textContent = `${Math.round(hpPct)}%`;

        /* Copia del canvas del juego: solo tiene sentido si la card lo usa,
           es decir cuando no se pudo resolver la especie. La copia es visual y
           no necesita ir a 60 FPS: el ciclo de refresco ya la repinta. */
        if (!speciesId) {
            const sourceCanvas = mobCard.querySelector('.cbt-sprite canvas');
            const targetCanvas = customMobCard.querySelector('.mob-sprite-canvas');
            if (sourceCanvas && targetCanvas) {
                if (targetCanvas.width !== sourceCanvas.width) targetCanvas.width = sourceCanvas.width;
                if (targetCanvas.height !== sourceCanvas.height) targetCanvas.height = sourceCanvas.height;
                const ctx = targetCanvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
                    try { ctx.drawImage(sourceCanvas, 0, 0); } catch (_) {}
                }
            }
        }

        document.body?.classList.add('script-custom-mob-ready');
    }

    /* El canvas solo se usa de reserva, cuando no se pudo resolver la especie del
       enemigo y no se puede usar un <img> de PokeAPI. La copia visual la hace
       ahora updateMobCard en su propio ciclo, asi que este temporizador ya no
       seDedica a repintarlo: se queda solo para mantener la vida del script
       durante la carga inicial. */
    let canvasCopyTimer = 0;
    function copyMobCanvas() {
        canvasCopyTimer = 0;
        scheduleCanvasCopy();
    }
    function scheduleCanvasCopy() {
        if (canvasCopyTimer) return;
        const delay = document.visibilityState === 'hidden' ? BACKGROUND_REFRESH_MS : CANVAS_REFRESH_MS;
        canvasCopyTimer = window.setTimeout(() => requestAnimationFrame(copyMobCanvas), delay);
    }
    scheduleCanvasCopy();

    /* Actualizaciones visuales adaptativas. Las tareas estructurales ya no se
       repiten veinte veces por segundo y las pestañas ocultas casi no trabajan. */
    let uiRefreshTimer = 0;
    let lastStructureRefreshAt = 0;
    function safelyRefresh(callback) {
        try { callback(); } catch (e) {}
    }
    function runUiRefresh() {
        uiRefreshTimer = 0;
        if (!document.body) {
            scheduleUiRefresh(UI_REFRESH_MS);
            return;
        }
        if (document.visibilityState === 'hidden') {
            scheduleUiRefresh(BACKGROUND_REFRESH_MS);
            return;
        }

        safelyRefresh(updateHeroCardLive);
        safelyRefresh(updateLiveBars);
        safelyRefresh(updateMobCard);
        safelyRefresh(applyHitEffects);
        safelyRefresh(ccAbandonCaptureIfNoTarget);
        safelyRefresh(updateEventBoostBar);
        safelyRefresh(themePartyBars);
        /* La barra va en el ciclo rapido, no en el de estructura: las cantidades
           de balls bajan en cuanto se lanza una y tiene que notarse al momento. */
        safelyRefresh(updateCaptureDock);

        const now = Date.now();
        if (now - lastStructureRefreshAt >= STRUCTURE_REFRESH_MS) {
            lastStructureRefreshAt = now;
            safelyRefresh(setupCaptureBarToggle);
            safelyRefresh(setupHudToggle);
            safelyRefresh(setupDockToggle);
            safelyRefresh(layoutDockRows);
            safelyRefresh(setupPrivateChatDockBadge);
            safelyRefresh(setupScriptScaleSettings);
            safelyRefresh(setupPhoneShopMenuFix);
            safelyRefresh(minifyMarketButtons);
        }
        scheduleUiRefresh(UI_REFRESH_MS);
    }
    function scheduleUiRefresh(delay = UI_REFRESH_MS) {
        if (uiRefreshTimer) return;
        uiRefreshTimer = window.setTimeout(runUiRefresh, delay);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') {
            if (uiRefreshTimer) window.clearTimeout(uiRefreshTimer);
            uiRefreshTimer = 0;
            scheduleUiRefresh(0);
        }
    }, { passive: true });
    scheduleUiRefresh(0);

    /* El listener del script nunca debe ejecutarse delante del manejador del
       juego. Se encolan solo mensajes relevantes y se procesan en tiempo idle. */
    const socketPayloadQueue = [];
    let socketQueueScheduled = false;
    let pokemonRenderScheduled = false;

    function schedulePokemonRender() {
        if (pokemonRenderScheduled) return;
        pokemonRenderScheduled = true;
        window.setTimeout(() => {
            pokemonRenderScheduled = false;
            renderCustomCard();
        }, 0);
    }

    function processSocketPayload(rawPayload) {
        try {
            const data = JSON.parse(rawPayload);
            let shouldRender = false;

            /* Eventos de la barra de captura. Son tipos propios, asi que no pueden
               solaparse con la actualizacion del Pokemon y se resuelven aqui. */
            if (data.type === 'balls') { applyBallsEvent(data); return; }
            if (data.type === 'inventory') { applyInventoryEvent(data); return; }
            if (data.type === 'field-kill') { applyFieldKillEvent(data); return; }
            /* Desenlace de la captura. Es el unico evento que confirma que se lanzo una
               bola, y trae la bola concreta (ballId) y si funciono. Cubre por
               igual el tiro manual y el automatico del Auto-Helper, que antes
               no llegaba a verse por no pasar por ningun clic. */
            if (data.type === 'catch-result') {
                /* data.ballId es el id del juego (1..7) y speciesName el nombre
                   tal cual lo publica el servidor, con sus variantes. La bola es
                   la que se lanzo de verdad y el nombre solo se usa para la
                   insignia final. */
                ccStartCapture(ccBallForId(data.ballId), data.speciesName);
                ccScheduleResolve(!!data.success);
                return;
            }
            if (data.type === 'pending') { applyPendingEvent(data); return; }

            if (data.type === "pokes" && Array.isArray(data.list) && data.list.length > 0) {
                teamData = data.list.filter(p => p.team === true);
                const equippedPokemon = teamData[0];
                if (equippedPokemon) {
                    latestPokemonData = equippedPokemon;
                    shouldRender = true;
                }
            } else if (latestPokemonData) {
                let updateObj = null;
                if (data.id === latestPokemonData.id) updateObj = data;
                else if (data.pokemon && data.pokemon.id === latestPokemonData.id) updateObj = data.pokemon;
                else if (data.hero && data.hero.id === latestPokemonData.id) updateObj = data.hero;
                if (updateObj) {
                    latestPokemonData = { ...latestPokemonData, ...updateObj };
                    if (updateObj.stats) latestPokemonData.stats = { ...latestPokemonData.stats, ...updateObj.stats };
                    shouldRender = true;
                }
            }
            if (shouldRender) schedulePokemonRender();
        } catch (e) {}
    }

    function drainSocketQueue(deadline) {
        socketQueueScheduled = false;
        let processed = 0;
        while (socketPayloadQueue.length && processed < 2) {
            if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 3) break;
            processSocketPayload(socketPayloadQueue.shift());
            processed += 1;
        }
        if (socketPayloadQueue.length) scheduleSocketDrain();
    }

    function scheduleSocketDrain() {
        if (socketQueueScheduled) return;
        socketQueueScheduled = true;
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(drainSocketQueue, { timeout: 180 });
        } else {
            window.setTimeout(() => drainSocketQueue(null), 24);
        }
    }

    function enqueueSocketPayload(rawPayload) {
        if (typeof rawPayload !== 'string' || !rawPayload) return;
        const hasTeamSnapshot = rawPayload.includes('"pokes"');
        /* La barra de captura necesita balls, inventory y field-kill, que el juego
           ya recibia pero este script descartaba al filtrar la cola. Son tres
           busquedas de subcadena sobre el mismo texto: coste despreciable. */
        const hasCaptureData = CAPTURE_SOCKET_MARKERS.some(marker => rawPayload.includes(marker));
        const currentId = latestPokemonData?.id;
        const mayUpdateCurrent = currentId != null && rawPayload.includes(String(currentId));
        if (!hasTeamSnapshot && !hasCaptureData && !mayUpdateCurrent) return;
        if (socketPayloadQueue.length >= SOCKET_QUEUE_LIMIT) socketPayloadQueue.shift();
        socketPayloadQueue.push(rawPayload);
        scheduleSocketDrain();
    }

    /* El script declara @grant GM_addStyle, asi que Tampermonkey lo ejecuta en su
       sandbox: `window` ahi es una ventana distinta a la de la pagina. Asignar el
       Proxy sobre `window.WebSocket` solo tocaba el sandbox, el socket del juego
       nunca se interceptaba y por eso no llegaba ningun evento (balls, inventory,
       field-kill). Hay que instalarlo sobre unsafeWindow, que si es la ventana real
       de la pagina. En gestores sin unsafeWindow se cae al window del sandbox. */
    const socketHostWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const NativeWebSocket = socketHostWindow.WebSocket;
    let captureGameSocket = null;
    socketHostWindow.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
            const ws = Reflect.construct(target, args);
            captureGameSocket = ws;
            ws.addEventListener('message', event => enqueueSocketPayload(event.data), { passive: true });
            /* Se pide una foto fresca de balls e inventario al abrir la conexion:
               si no, la barra tarda hasta la siguiente push del servidor. */
            ws.addEventListener('open', () => {
                requestCaptureSnapshot();
            }, { once: true, passive: true });
            return ws;
        }
    });

    function requestCaptureSnapshot() {
        if (!captureGameSocket || captureGameSocket.readyState !== 1) return;
        try {
            captureGameSocket.send(JSON.stringify({ type: 'inv-get' }));
            captureGameSocket.send(JSON.stringify({ type: 'balls-get' }));
        } catch (_) {}
    }

    /* Vida y EXP del equipo. Hay dos fuentes y se usan en este orden:

       1) El socket. El evento pokes trae hp y maxHp ya calculados para el
          Pokemon equipado, y poke-xp trae el xp acumulado. Es la fuente
          correcta y no depende de nada pintado en pantalla.
       2) El panel .phud-mon, que el juego usa como atajo y ademas es lo unico
          que trae el porcentaje de EXP. Se lee con textContent y no con
          innerText porque en Card mode el panel no esta renderizado y
          innerText devolveria "" en un elemento oculto, que es lo que dejaba
          las barras en "Cargando...".

       Se recorren todas las copias de .phud-mon porque el juego monta mas de
       una y la primera no siempre es la del Pokemon equipado. */
    function ccReadPhudText() {
        const panels = document.querySelectorAll('.phud-mon');
        for (const panel of panels) {
            const text = panel.textContent || '';
            if (/\d\s*\/\s*\d/.test(text)) return text;
        }
        return panels[0]?.textContent || '';
    }

    function ccReadSocketBars() {
        const p = latestPokemonData;
        if (!p) return { hp: null, maxHp: null, hpPct: null, xp: null };
        const hp = Number(p.hp);
        const maxHp = Number(p.maxHp);
        const ok = Number.isFinite(hp) && Number.isFinite(maxHp) && maxHp > 0;
        return { hp: ok ? hp : null, maxHp: ok ? maxHp : null, hpPct: ok ? (hp / maxHp) * 100 : null, xp: Number(p.xp) || null };
    }

    function updateLiveBars() {
        domCache.phudNode = document.querySelector('.phud-mon');

        const socketBars = ccReadSocketBars();
        let text = ccReadPhudText();

        /* El panel concatena sus trozos sin separadores y queda
           "GolemNv.4324296/11520": el nivel va pegado a la vida. Si se busca
           "numero/numero" a pelo se leen los digitos del nivel delante y sale
           un 4324296/11520 que no existe. Como el nivel se sabe exacto, se
           inserta un espacio despues antes de interpretar nada. */
        const level = Number(latestPokemonData?.level);
        if (Number.isFinite(level) && level > 0) {
            text = text.replace(new RegExp('((?:Lv|Nv)\\.?\\s*' + level + ')(?=\\d)', 'gi'), '$1 ');
        }

        const matchHP = text.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?[kMBT]?)\s*\/\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?[kMBT]?)/i);
        const matchXP = text.match(/EXP\s*([0-9]+(?:\.[0-9]+)?)\s*%/) || text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);

        let hpPercent = 100, xpPercent = 0, hpText = "", xpText = "";

        if (matchXP) { xpText = matchXP[0].trim(); xpPercent = parseFloat(matchXP[1]) || 0; }
        if (matchHP) {
            hpText = matchHP[0].trim();
            const cur = parseFloat(matchHP[1].replace(/,/g, '').replace(/[kMBT]/ig, ''));
            const max = parseFloat(matchHP[2].replace(/,/g, '').replace(/[kMBT]/ig, ''));
            if (!isNaN(cur) && !isNaN(max) && max > 0) hpPercent = (cur / max) * 100;
        }
        /* El socket manda en el HP: trae hp y maxHp ya calculados y no depende
           de que el panel este visible, asi que el texto tambien sale de ahi y
           cifra y barra no pueden contradecirse. */
        if (socketBars.hpPct !== null) {
            hpPercent = socketBars.hpPct;
            hpText = `${Math.round(socketBars.hp)}/${Math.round(socketBars.maxHp)}`;
        } else if (!matchHP) {
            hpPercent = 100;
            hpText = "";
        }
        /* Sin lectura del panel, el xp acumulado del socket evita el 0% falso.
           El porcentaje exacto solo lo publica el panel, asi que sin el se deja
           la barra en 0 en vez de inventar un numero. */
        if (!matchXP && socketBars.xp !== null && xpPercent === 0) {
            xpText = `${socketBars.xp.toLocaleString('pt-BR')} XP`;
        }

        hpPercent = Math.min(100, Math.max(0, hpPercent || 0));
        xpPercent = Math.min(100, Math.max(0, xpPercent));
        let currentHpClass = 'cpc-hp-high';
        if (hpPercent <= 20) currentHpClass = 'cpc-hp-low';
        else if (hpPercent <= 50) currentHpClass = 'cpc-hp-med';

        const newHpWidth = `${hpPercent}%`;
        const newXpWidth = `${xpPercent}%`;
        /* El prefijo "HP:" solo hace falta cuando el texto va DENTRO de la
           barra. Los temas que ya rotulan la barra al lado (3 y 7) reciben solo
           las cifras, para no repetir la etiqueta dos veces. */
        const bareHp = !!domCache.hpText?.classList?.contains('cc-hp-val');
        const bareXp = !!domCache.xpText?.classList?.contains('cc-hp-val');
        const newHpText = bareHp
            ? (hpText || Math.round(hpPercent) + '%')
            : `HP: ${hpText || Math.round(hpPercent) + '%'}`;
        const newXpText = bareXp
            ? (xpText || xpPercent.toFixed(1) + '%')
            : `XP: ${xpText || xpPercent.toFixed(1) + '%'}`;

        if (lastHpWidth !== newHpWidth && domCache.hpFill) { domCache.hpFill.style.width = newHpWidth; lastHpWidth = newHpWidth; }
        if (lastHpClass !== currentHpClass && domCache.hpFill) { domCache.hpFill.className = `cpc-bar-fill ${currentHpClass}`; lastHpClass = currentHpClass; }
        if (lastHpText !== newHpText && domCache.hpText) { domCache.hpText.textContent = newHpText; lastHpText = newHpText; }
        if (lastXpWidth !== newXpWidth && domCache.xpFill) { domCache.xpFill.style.width = newXpWidth; lastXpWidth = newXpWidth; }
        if (lastXpText !== newXpText && domCache.xpText) { domCache.xpText.textContent = newXpText; lastXpText = newXpText; }
    }

    function getEventChipAccent(chip) {
        const content = `${chip.className} ${chip.textContent || ''} ${chip.innerHTML}`.toLowerCase();
        if (content.includes('fire')) return '#ef4444';
        if (content.includes('water')) return '#3b82f6';
        if (content.includes('grass')) return '#22c55e';
        if (content.includes('electric') || content.includes('lightning')) return '#eab308';
        if (content.includes('ice')) return '#06b6d4';
        if (content.includes('fighting')) return '#991b1b';
        if (content.includes('poison')) return '#a855f7';
        if (content.includes('ground')) return '#d97706';
        if (content.includes('flying')) return '#7dd3fc';
        if (content.includes('psychic')) return '#ec4899';
        if (content.includes('bug')) return '#84cc16';
        if (content.includes('rock')) return '#78716c';
        if (content.includes('ghost')) return '#6366f1';
        if (content.includes('dragon')) return '#4f46e5';
        if (content.includes('dark')) return '#475569';
        if (content.includes('steel')) return '#9ca3af';
        if (content.includes('fairy')) return '#f472b6';
        if (content.includes('normal')) return '#a3a3a3';
        if (content.includes('shiny') || content.includes('star')) return '#facc15';
        if (content.includes('capture') || content.includes('ball')) return '#a855f7';
        if (content.includes('drop') || content.includes('loot')) return '#f59e0b';
        return chip.classList.contains('event') ? '#64748b' : '#526174';
    }

    function collectActiveEventChips() {
        const found = [];
        const seen = new Set();
        const addChip = (chip) => {
            if (!chip || seen.has(chip)) return;
            seen.add(chip);
            found.push(chip);
        };

        /* El juego coloca el tipo del día y los boosts activos como chips
           dentro de uno o más `.bi-wrap`. También cubrimos eventos sueltos
           y boosts que incluyan su panel `.bi-boost-pop`. */
        document.querySelectorAll('.bi-wrap').forEach((wrap) => {
            wrap.querySelectorAll('.bi-chip').forEach(addChip);
        });
        document.querySelectorAll('.bi-chip.event').forEach(addChip);
        document.querySelectorAll('.bi-chip').forEach((chip) => {
            if (chip.querySelector('.bi-boost-pop, .bi-event-pop')) addChip(chip);
        });

        return found;
    }

    function getEventChipIdentity(chip) {
        const icon = chip.querySelector('.bi-ico');
        const time = chip.querySelector('.bi-time')?.textContent?.trim() || '';
        const classes = Array.from(chip.classList)
            .filter((name) => !name.startsWith('script-bi-'))
            .sort()
            .join('.');
        const iconKey = icon
            ? `${icon.className}|${icon.innerHTML.replace(/\s+/g, '')}`
            : '';
        return `${classes}|${iconKey}|${time}`;
    }

    function updateEventBoostBar() {
        const now = Date.now();
        if (now - lastEventSyncAt < 250) return;
        lastEventSyncAt = now;

        const candidates = collectActiveEventChips();
        const candidateSet = new Set(candidates);

        document.querySelectorAll('.script-bi-native-source, .script-bi-native-duplicate').forEach((chip) => {
            if (!candidateSet.has(chip)) {
                chip.classList.remove('script-bi-native-source', 'script-bi-native-duplicate', 'script-bi-first', 'script-bi-last');
                chip.style.removeProperty('left');
                chip.style.removeProperty('--script-bi-accent');
            }
        });

        const identities = new Set();
        const eventChips = [];
        candidates.forEach((chip) => {
            chip.classList.remove('script-bi-first', 'script-bi-last');
            const identity = getEventChipIdentity(chip);
            if (identities.has(identity)) {
                chip.classList.remove('script-bi-native-source');
                chip.classList.add('script-bi-native-duplicate');
                chip.style.removeProperty('left');
                return;
            }
            identities.add(identity);
            chip.classList.remove('script-bi-native-duplicate');
            chip.classList.add('script-bi-native-source');
            eventChips.push(chip);
        });

        const obsoleteMirror = document.getElementById('custom-bi-event-group');
        if (obsoleteMirror) obsoleteMirror.remove();

        if (!eventChips.length) {
            document.body.classList.remove('custom-bi-events-mirrored');
            lastEventColor = '';
            return;
        }

        document.body.classList.add('custom-bi-events-mirrored');
        eventChips.forEach((chip) => {
            chip.style.setProperty('--script-bi-accent', getEventChipAccent(chip));
        });

        /* Los chips nativos conservan sus listeners de hover. Solo calculamos
           su posición visual para formar una fila centrada sin reparentarlos. */
        const hoverActive = eventChips.some((chip) => chip.matches(':hover'));
        const layoutReady = eventChips.every((chip) => Boolean(chip.style.getPropertyValue('left')));
        if (!hoverActive || !layoutReady) {
            const gap = window.innerWidth <= 700 ? 3 : 5;
            /* offsetWidth no incluye el popup absoluto ni transformaciones de hover. */
            const widths = eventChips.map((chip) => chip.getBoundingClientRect().width);
            const totalWidth = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
            let left = Math.max(6, (window.innerWidth - totalWidth) / 2);
            eventChips.forEach((chip, index) => {
                chip.classList.toggle('script-bi-first', index === 0);
                chip.classList.toggle('script-bi-last', index === eventChips.length - 1);
                const nextLeft = `${Math.round(left)}px`;
                if (chip.style.getPropertyValue('left') !== nextLeft) {
                    chip.style.setProperty('left', nextLeft, 'important');
                }
                left += widths[index] + gap;
            });
        }

        const firstEvent = eventChips.find((chip) => chip.classList.contains('event'));
        lastEventColor = firstEvent ? getEventChipAccent(firstEvent) : '';
    }

    function getVictoryFingerprint(card) {
        const text = (card.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const assets = Array.from(card.querySelectorAll('img'))
            .map((img) => `${img.getAttribute('src') || ''}|${img.getAttribute('alt') || ''}|${img.getAttribute('title') || ''}`)
            .join('|');
        const raw = `${text}|${assets}`;
        let hash = 2166136261;
        for (let index = 0; index < raw.length; index++) {
            hash ^= raw.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `victory-${(hash >>> 0).toString(36)}`;
    }

    function processVictoryToast(card) {
        if (!card || victoryRuntime.processedCards.has(card)) return;
        victoryRuntime.processedCards.add(card);

        const now = Date.now();
        const fingerprint = getVictoryFingerprint(card);
        victoryRuntime.recentFingerprints.forEach((timestamp, key) => {
            if (now - timestamp > 5000) victoryRuntime.recentFingerprints.delete(key);
        });
        const previousTimestamp = victoryRuntime.recentFingerprints.get(fingerprint) || 0;
        if (now - previousTimestamp < 2000) return;
        victoryRuntime.recentFingerprints.set(fingerprint, now);

        let container = document.getElementById('custom-victory-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'custom-victory-toast-container';
            document.body.appendChild(container);
        }
        if (container.querySelector(`[data-victory-fingerprint="${fingerprint}"]`)) return;

        let pokeName = "Unknown";
        const allSnTexts = card.querySelectorAll('.sn-text');
        
        for (let t of allSnTexts) {
            if (!t.querySelector('.sn-xpline')) {
                let text = (t.innerText || t.textContent || '').trim().replace(/!/g, ''); 
                if (text.toLowerCase().endsWith(' defeated')) pokeName = text.substring(0, text.length - 9).trim();
                else if (text.toLowerCase().startsWith('derrotaste a ')) pokeName = text.substring(13).replace(/salvaje|wild/ig, '').trim();
                else if (text.toLowerCase().endsWith(' foi derrotado')) pokeName = text.substring(0, text.length - 14).trim();
                else {
                    let match = text.match(/(?:derrotaste|derrotou|defeated)\s+(?:a\s+|um\s+|uma\s+|wild\s+|salvaje\s+|selvagem\s+)?(.+)/i) || text.match(/^(.+?)\s+defeated/i);
                    if (match && match[1]) pokeName = match[1].trim();
                }
                pokeName = pokeName.replace(/^wild\s+/i, '').replace(/^salvaje\s+/i, '').trim();
                break; 
            }
        }

        let xpLinesHTML = "";
        let globalDebuffHTML = "";
        const xpLines = card.querySelectorAll('.sn-xpline');
        
        xpLines.forEach(line => {
            let baseSpan = line.querySelector('.sn-xp:not(.boost-xp):not(.vip):not(.debuff):not(.total)');
            let boostSpan = line.querySelector('.sn-xp.boost-xp');
            let vipSpan = line.querySelector('.sn-xp.vip');
            let debuffSpan = line.querySelector('.sn-xp.debuff');
            let totalSpan = line.querySelector('.sn-xp.total');

            let baseText = baseSpan ? baseSpan.innerText.trim() : "";
            
            if (baseText) {
                let isTrainer = baseText.toLowerCase().includes('trainer');
                let label = isTrainer ? "Trainer XP" : "Pokémon XP";
                let icon = isTrainer ? "👤" : "🐾";
                
                let detailMods = [];
                if (boostSpan) detailMods.push(`<span style="color:#f59e0b">🔥 ${boostSpan.innerText.replace(/[^0-9.,+]/g, '')}</span>`);
                if (vipSpan) detailMods.push(`<span style="color:#3b82f6">💎 ${vipSpan.innerText.replace(/[^0-9.,+]/g, '')}</span>`);
                if (debuffSpan && baseText) detailMods.push(`<span style="color:#ef4444">🔻 ${debuffSpan.innerText.replace(/[^0-9.,\-]/g, '')}</span>`);
                
                let detailsHtml = detailMods.length > 0 ? `<div style="font-size: 7px; display:flex; gap: 4px; justify-content: flex-end; margin-top: 2px;">${detailMods.join('')}</div>` : '';
                let finalVal = totalSpan ? totalSpan.innerText.replace(/=|total/ig, '').trim() : baseText.replace(/[^0-9.,+]/g, '');

                xpLinesHTML += `
                    <div style="margin-bottom: 4px;">
                        <div class="cv-row">
                            <span>${icon} ${label}:</span>
                            <span class="cv-val-xp">${finalVal}</span>
                        </div>
                        ${detailsHtml}
                    </div>
                `;
            } else if (debuffSpan && !baseText) {
                globalDebuffHTML += `<div class="cv-debuff-text">⚠️ ${debuffSpan.innerText.trim()}</div>`;
            }
        });

        let lootItemsHTML = "";
        const lootItems = card.querySelectorAll('.sn-loot-item');
        lootItems.forEach(item => {
            let imgSrc = item.querySelector('.sn-loot-ico')?.src || "";
            let qty = item.querySelector('.sn-loot-qty')?.innerText.trim() || "";
            let title = item.title || "";
            lootItemsHTML += `
                <div class="cv-loot-item" title="${title}">
                    <img src="${imgSrc}">
                    <span>${qty}</span>
                </div>
            `;
        });

        let spriteName = pokeName.toLowerCase().replace(/[^a-z0-9\-]/g, '');
        let spriteUrl = `https://play.pokemonshowdown.com/sprites/dex/${spriteName}.png`;
        
        let customToast = document.createElement('div');
        customToast.className = 'cv-toast';
        customToast.dataset.victoryFingerprint = fingerprint;
        customToast.innerHTML = `
            <div class="cv-container">
                <div class="cv-header">
                    <img src="${spriteUrl}" onerror="this.src='https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png'" class="cv-sprite">
                    <div class="cv-title-box">
                        <span class="cv-title">¡Victoria!</span>
                        <span class="cv-subtitle">${pokeName}</span>
                    </div>
                </div>
                ${xpLinesHTML ? `<div class="cv-section">${xpLinesHTML}</div>` : ''}
                ${globalDebuffHTML ? `<div class="cv-section">${globalDebuffHTML}</div>` : ''}
                ${lootItemsHTML ? `<div class="cv-section" style="margin-top: 4px;"><div class="cv-subtitle" style="font-size: 7px; margin-bottom: 2px;">Loot Obtenido:</div><div class="cv-loot-grid">${lootItemsHTML}</div></div>` : ''}
            </div>
        `;

        container.appendChild(customToast);

        setTimeout(() => { customToast.classList.add('fading-out'); }, 1500);
        setTimeout(() => { customToast.remove(); }, 2000);
    }

    const pendingVictoryRoots = new Set();
    let victoryScanScheduled = false;
    function flushVictoryRoots() {
        victoryScanScheduled = false;
        const roots = Array.from(pendingVictoryRoots);
        pendingVictoryRoots.clear();
        roots.forEach(node => {
            if (!node || node.nodeType !== 1) return;
            if (node.classList.contains('sn-card') && node.classList.contains('sn-success')) {
                processVictoryToast(node);
                return;
            }
            node.querySelectorAll('.sn-card.sn-success').forEach(card => processVictoryToast(card));
        });
    }
    const toastObserver = new MutationObserver((mutations) => {
        mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) pendingVictoryRoots.add(node);
        }));
        if (pendingVictoryRoots.size && !victoryScanScheduled) {
            victoryScanScheduled = true;
            window.setTimeout(flushVictoryRoots, 0);
        }
    });

    const startVictoryObserver = () => {
        if (victoryRuntime.observer) victoryRuntime.observer.disconnect();
        victoryRuntime.observer = toastObserver;
        toastObserver.observe(document.body, { childList: true, subtree: true });
    };

    if (document.body) startVictoryObserver();
    else window.addEventListener('DOMContentLoaded', startVictoryObserver, { once: true });

})();
