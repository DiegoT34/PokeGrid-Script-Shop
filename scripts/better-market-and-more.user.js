// ==UserScript==
// @name         Better Market and More
// @namespace    http://tampermonkey.net/
// @version      10.8.0
// @description  Mercado Global rediseñado, con cards Pokémon compactas, tipos visibles y Exact IV Scanner completo.
// @match        https://poke.idleworld.online/play
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const NativeWebSocket = window.WebSocket;
    const nativeWebSocketSend = NativeWebSocket.prototype.send;
    let gameSocket = null;
    let latestInventory = null;
    let latestPokemon = null;
    let latestFamily = null;
    let latestAutohelper = null;
    const gameEventWaiters = new Map();
    const trackedGameSockets = new WeakSet();
    let lastSocketMessageAt = Date.now();
    let lastHuntSocketActivityAt = Date.now();
    let lastAutoReconnectAt = 0;
    let autoReconnectInProgress = false;
    let lastCaptureBarSignature = '';
    let autoReconnectWasInHunt = false;
    let lastAnalyzerXp = null;
    let lastAnalyzerXpChangeAt = Date.now();
    function isInHuntContext() {
        if (document.querySelector('[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon')) return true;
        const location = getCurrentHuntLocation?.() || currentHuntSnapshot?.locName || '';
        if (location && !isCityName(location)) return true;
        const analyzer = document.querySelector('.ha-window:not(.ha-compare-modal)');
        return Boolean(analyzer && !isCityName(getLastHunt()));
    }

    function isHuntProgressMessage(message) {
        const type = String(message?.type || '').toLowerCase();
        if (/chat|family|friend|ranking|pong|ping|inventory|pokes-get/.test(type)) return false;
        if (/exp|xp|defeat|kill|loot|drop|capture|catch|damage|attack/.test(type)) return true;
        const payload = JSON.stringify(message).toLowerCase();
        return /"(?:expgained|xpgain|xp|experience|defeated|killed|damage|loot|drops?|reward)"\s*:\s*(?:[1-9]\d*|true|\[|\{)/.test(payload);
    }
    function handleGameSocketMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        lastSocketMessageAt = Date.now();
        if (isInHuntContext() && isHuntProgressMessage(message)) {
            lastHuntSocketActivityAt = Date.now();
        }
        if (message?.type === 'inventory') {
            latestInventory = message.items || [];
        }
        if (message?.type === 'family') latestFamily = message;
        if (message?.type === 'autohelper') latestAutohelper = message;
        if (message?.type === 'pokes') {
            latestPokemon = message.list || [];
            if (updateCachedLeaderPokemon(latestPokemon)) {
                lastMapRenderSignature = '';
                setTimeout(buildSimpleList, 0);
            }
            setTimeout(enhanceCaptureLog, 0);
        }
        const waiters = gameEventWaiters.get(message?.type);
        if (waiters) {
            gameEventWaiters.delete(message.type);
            waiters.forEach(resolve => resolve(message));
        }
    }

    function trackGameSocket(socket, url = socket?.url) {
        if (!socket || !String(url || '').includes('/ws')) return socket;
        gameSocket = socket;
        if (trackedGameSockets.has(socket)) return socket;
        trackedGameSockets.add(socket);
        socket.addEventListener('message', handleGameSocketMessage);
        socket.addEventListener('close', () => {
            if (gameSocket === socket) gameSocket = null;
        });
        return socket;
    }

    function TrackedWebSocket(url, protocols) {
        const socket = protocols === undefined
            ? new NativeWebSocket(url)
            : new NativeWebSocket(url, protocols);
        return trackGameSocket(socket, url);
    }
    TrackedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
    window.WebSocket = TrackedWebSocket;
    NativeWebSocket.prototype.send = function(data) {
        trackGameSocket(this);
        return nativeWebSocketSend.call(this, data);
    };

    function sendGameMessage(message) {
        if (!gameSocket || gameSocket.readyState !== NativeWebSocket.OPEN) return false;
        gameSocket.send(JSON.stringify(message));
        return true;
    }

    async function waitForGameSocket(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (gameSocket?.readyState === NativeWebSocket.OPEN) return true;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return gameSocket?.readyState === NativeWebSocket.OPEN;
    }

    setInterval(async () => {
        const captureBar = document.querySelector('[data-guide="capture-bar"]');
        const inHunt = isInHuntContext();
        if (!inHunt) { autoReconnectWasInHunt = false; return; }
        if (!autoReconnectWasInHunt) {
            autoReconnectWasInHunt = true;
            lastHuntSocketActivityAt = Date.now();
            return;
        }
        if (!isAutoReconnectActive() || autoReconnectInProgress) return;
        const now = Date.now();
        const connectionLost = !gameSocket || gameSocket.readyState !== NativeWebSocket.OPEN;
        const captureBarSignature = captureBar?.innerHTML || '';
        if (!connectionLost && captureBar && captureBarSignature !== lastCaptureBarSignature) {
            lastCaptureBarSignature = captureBarSignature;
            lastHuntSocketActivityAt = now;
        }
        const staleFor = now - lastHuntSocketActivityAt;
        if (staleFor < 30000 || now - lastAutoReconnectAt < 60000) return;
        lastAutoReconnectAt = now;
        autoReconnectInProgress = true;
        try {
            const previousHunt = getCurrentHuntNameForReconnect();
            if (!previousHunt) throw new Error('A hunt atual não pôde ser identificada.');
            showScriptNotice(`Hunt sem resposta. Indo a Cerulean por 10 segundos antes de voltar para ${previousHunt}…`, { title: 'Auto-reconnect' });
            const reachedCerulean = await teleportToCeruleanForReconnect();
            if (!reachedCerulean) throw new Error('Cerulean não foi localizada no mapa.');
            await new Promise(resolve => setTimeout(resolve, 10000));
            await teleportToTarget(previousHunt);
            lastHuntSocketActivityAt = Date.now();
            showScriptNotice(`Retornando para ${previousHunt}.`, { title: 'Auto-reconnect' });
        } catch (error) {
            console.warn('Falha no auto-reconnect da hunt:', error);
            showScriptNotice(`Não foi possível concluir o auto-reconnect: ${error.message}`, { title: 'Auto-reconnect', isError: true });
            setTimeout(() => location.reload(), 1500);
        } finally {
            autoReconnectInProgress = false;
        }
    }, 5000);

    async function requestFreshGameEvent(type, requestType, { timeoutMs = 3500, attempts = 2 } = {}) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const result = await requestGameEvent(type, requestType, null, timeoutMs);
            if (type === 'family') {
                if (result && !Array.isArray(result) && result.type === 'family') return result;
            } else if (Array.isArray(result)) {
                return result;
            }
        }
        return type === 'family' ? null : [];
    }

    function requestGameEvent(type, requestType, cachedValue, timeoutMs = 2500) {
        if (cachedValue) return Promise.resolve(cachedValue);
        return new Promise(resolve => {
            const waiters = gameEventWaiters.get(type) || [];
            const waiter = message => resolve(
                type === 'inventory' ? message.items || []
                    : type === 'family' ? message
                        : message.list || []
            );
            waiters.push(waiter);
            gameEventWaiters.set(type, waiters);
            const request = typeof requestType === 'string' ? { type: requestType } : requestType;
            if (!sendGameMessage(request)) {
                gameEventWaiters.set(type, waiters.filter(item => item !== waiter));
                resolve([]);
                return;
            }
            setTimeout(() => {
                const pending = gameEventWaiters.get(type) || [];
                gameEventWaiters.set(type, pending.filter(item => item !== waiter));
                resolve([]);
            }, timeoutMs);
        });
    }

    const STORAGE_FAVS = 'hunts_favoritas_v1';
    const STORAGE_LAST_HUNT = 'ultima_hunt_v1';
    const STORAGE_SCRIPT_ACTIVE = 'script_mapa_ativo_v1';
    const STORAGE_CHAT_ACTIVE = 'script_chat_ativo_v1';
    const STORAGE_NAV_MODE = 'script_nav_tp_mode_v1';
    const STORAGE_DROP_MODE = 'script_drop_mode_v1'; // 'hover', 'icon', 'off'
    const STORAGE_SELL_CONFIRM = 'script_sell_confirm_items_v1';
    const STORAGE_SELL_LOCKS = 'script_sell_locks_v1';
    const STORAGE_NATIVE_ITEM_LOCKS = 'script_native_item_locks_v1';
    const STORAGE_DEX_FAST_TRAVEL = 'script_dex_fast_travel_v1';
    const STORAGE_GUARD_LEGENDARY = 'script_guard_legendary_v1';
    const STORAGE_GUARD_SELL_LOCK = 'script_guard_sell_lock_v1';
    const STORAGE_HA_COMPACT = 'script_ha_compact_v1';
    const STORAGE_HA_DROPS = 'script_ha_drops_v1';
    const STORAGE_DEX_FILTER = 'script_dex_filter_v1';
    const STORAGE_DEX_SORT_VALUE = 'script_dex_sort_value_v1';
    const STORAGE_CAUGHT_POKEMON = 'script_caught_pokemon_v1';
    const STORAGE_HUNT_MARKET = 'script_hunt_market_v1';
    const STORAGE_HUNT_BULK_BUY = 'script_hunt_bulk_buy_v1';
    const STORAGE_HUNT_SELL = 'script_hunt_sell_v1';
    const STORAGE_MARK_ENHANCEMENTS = 'script_mark_enhancements_v1';
    const STORAGE_MAP_FILTERS = 'script_map_filters_v1';
    const STORAGE_HA_HISTORY = 'script_ha_history_v1';
    // Limpieza definitiva de los datos pertenecientes al historial retirado.
    try {
        localStorage.removeItem('script_market_price_history_v1');
        localStorage.removeItem('script_market_price_collector_lease_v1');
        sessionStorage.removeItem('script_market_price_collector_tab_v1');
    } catch (_) { /* El resto del script no depende de este almacenamiento. */ }
    const STORAGE_PRIMARY_FAVORITE = 'script_primary_favorite_v1';
    const STORAGE_GAME_FONT = 'script_game_font_v1';
    const STORAGE_AUTO_RECONNECT = 'script_auto_reconnect_v1';
    const STORAGE_CUSTOM_SCROLLBARS = 'script_custom_scrollbars_v1';
    const STORAGE_UNIFIED_FONTS = 'script_unified_fonts_v1';
    const STORAGE_COMPARE_WINDOW = 'script_compare_window_v1';
    const STORAGE_MARK_QUICK_BUY = 'script_mark_quick_buy_v1';
    const STORAGE_MARK_QUALITY_PICKER = 'script_mark_quality_picker_v1';
    const STORAGE_CUSTOM_FONT = 'script_custom_font_v1';
    const STORAGE_CUSTOM_FONT_NAME = 'script_custom_font_name_v1';
    const CUSTOM_FONT_FAMILY = 'PIW Uploaded Font';
    const STORAGE_WINDOW_SCALES = 'script_window_scales_v1';
    const WINDOW_SCALE_OPTIONS = [60, 75, 90, 100, 110, 125, 140];
    const SCRIPT_WINDOW_SCALE_AREAS = Object.freeze([
        { key:'market', label:'Mercado Global y calculadora IV', description:'Redimensiona el Market completo, sus pestañas, cards y el panel lateral de Exact IV.', selector:'.market-iv-stage', baseWidth:1024, baseHeight:608 },
        { key:'map', label:'Mapa y zonas de caza', description:'Redimensiona el mapa rediseñado, filtros, ciudades y cards de hunts.', selector:'.map-window', baseWidth:980, baseHeight:790 },
        { key:'shops', label:'Tiendas y Mark', description:'Redimensiona las tiendas de Poké Balls, curas y las ventanas Mark modificadas.', selector:'.script-portable-ball-window,.ball-window,.mk-window:not(.script-market-window)', baseWidth:820, baseHeight:680 },
        { key:'depot', label:'Depósito', description:'Redimensiona el depósito personal y familiar, sus pestañas, cards y listas.', selector:'.script-portable-depot-window,.dep-window', baseWidth:1040, baseHeight:790 },
        { key:'sell', label:'Venta y confirmaciones', description:'Redimensiona Sell Items and Pokémon, ventas NPC y diálogos de confirmación.', selector:'.script-npc-sell-window,.script-dialog-modal,.sell-confirm-modal:not(.script-portable-depot-window):not(.script-npc-sell-window):not(.ha-compare-modal)', baseWidth:820, baseHeight:680 },
        { key:'settings', label:'Configuración del script', description:'Redimensiona la ventana de configuraciones completa, incluida esta pestaña.', selector:'.cfg-window', baseWidth:920, baseHeight:780 },
        { key:'analyzer', label:'Hunt Analyzer', description:'Redimensiona el panel principal del Hunt Analyzer y todos sus datos.', selector:'.ha-window:not(.ha-compare-modal)', baseWidth:620, baseHeight:760 },
        { key:'comparison', label:'Comparación de hunts', description:'Redimensiona la ventana comparativa, tabla, posiciones y resumen.', selector:'.ha-compare-modal', baseWidth:760, baseHeight:620 },
        { key:'inventory', label:'Inventario', description:'Redimensiona la ventana de inventario y las mejoras visuales aplicadas.', selector:'.inv-window', baseWidth:820, baseHeight:700 },
        { key:'pokedex', label:'Pokédex', description:'Redimensiona Pokédex, filtros, cards y controles de viaje rápido.', selector:'.dex-window', baseWidth:900, baseHeight:720 },
        { key:'pokemon', label:'Perfil, Pokémon y crianza', description:'Redimensiona perfiles, detalle Pokémon y ventanas de breeding modificadas.', selector:'.prof-window,.poke-window,.breed-window', baseWidth:720, baseHeight:680 },
        { key:'general', label:'Otras ventanas rediseñadas', description:'Redimensiona las demás ventanas generales y diálogos que reciben la capa visual.', selector:'.win-window:not(.map-window):not(.cfg-window):not(.mk-window):not(.ball-window):not(.ha-window):not(.inv-window):not(.dex-window):not(.dep-window):not(.prof-window):not(.poke-window):not(.breed-window),.npc-dialog', baseWidth:760, baseHeight:680 }
    ]);
    const DEFAULT_WINDOW_SCALES = Object.freeze(Object.fromEntries(SCRIPT_WINDOW_SCALE_AREAS.map(area => [area.key, 100])));
    let scriptWindowScales = loadWindowScalePreferences();
    let windowScaleResizeTimer = null;
    const scriptWindowOriginalInlineStyles = new WeakMap();
    const scriptWindowResizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(entries => entries.forEach(entry => updateBetterWindowLayoutMode(entry.target, entry.contentRect.width)))
        : null;

    function normalizeWindowScale(value) {
        const numeric = Number(value);
        return WINDOW_SCALE_OPTIONS.includes(numeric) ? numeric : 100;
    }

    function loadWindowScalePreferences() {
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_WINDOW_SCALES) || '{}');
            return Object.fromEntries(SCRIPT_WINDOW_SCALE_AREAS.map(area => [area.key, normalizeWindowScale(stored?.[area.key])]));
        } catch (_) {
            return { ...DEFAULT_WINDOW_SCALES };
        }
    }

    function saveWindowScalePreferences() {
        try { localStorage.setItem(STORAGE_WINDOW_SCALES, JSON.stringify(scriptWindowScales)); } catch (_) {}
    }

    function updateBetterWindowLayoutMode(element, measuredWidth) {
        if (!(element instanceof Element)) return;
        const width = Math.max(0, Number(measuredWidth) || element.getBoundingClientRect().width || 0);
        const viewportWidth = Math.max(280, window.innerWidth || 1280);
        const areaKey = element.dataset.scriptWindowScaleArea;
        const requestedPercent = normalizeWindowScale(scriptWindowScales[areaKey]);
        const mode = viewportWidth <= 640
            ? 'mobile'
            : viewportWidth <= 900 || (viewportWidth > 900 && requestedPercent < 100 && width <= 900)
                ? 'compact'
                : 'wide';
        ['mobile', 'compact', 'wide'].forEach(name => element.classList.toggle(`script-window-layout-${name}`, name === mode));
        element.dataset.scriptWindowLayout = mode;
    }

    function rememberBetterWindowInlineStyles(element) {
        if (scriptWindowOriginalInlineStyles.has(element)) return;
        const properties = ['width', 'height', 'max-width', 'max-height', 'scale', 'zoom', '--script-window-scale'];
        scriptWindowOriginalInlineStyles.set(element, Object.fromEntries(properties.map(property => [property, {
            value:element.style.getPropertyValue(property),
            priority:element.style.getPropertyPriority(property)
        }])));
    }

    function restoreBetterWindowInlineStyles(element) {
        const original = scriptWindowOriginalInlineStyles.get(element);
        if (!original) return;
        Object.entries(original).forEach(([property, state]) => {
            if (state.value) element.style.setProperty(property, state.value, state.priority || '');
            else element.style.removeProperty(property);
        });
    }

    function rememberBetterWindowNaturalSize(element, area) {
        if (element.dataset.scriptWindowBaseWidth && element.dataset.scriptWindowBaseHeight) return;
        const rect = element.getBoundingClientRect();
        const width = rect.width > 80 ? rect.width : area.baseWidth;
        const height = rect.height > 80 ? rect.height : area.baseHeight;
        element.dataset.scriptWindowBaseWidth = String(Math.round(width));
        element.dataset.scriptWindowBaseHeight = String(Math.round(height));
    }

    function applyBetterWindowScales() {
        const viewportWidth = Math.max(280, window.innerWidth || 1280);
        const viewportHeight = Math.max(320, window.innerHeight || 720);
        const viewportPadding = viewportWidth <= 640 ? 8 : viewportWidth <= 900 ? 16 : 28;
        const availableWidth = Math.max(272, viewportWidth - viewportPadding);
        const availableHeight = Math.max(312, viewportHeight - viewportPadding);

        SCRIPT_WINDOW_SCALE_AREAS.forEach(area => {
            const requestedPercent = normalizeWindowScale(scriptWindowScales[area.key]);
            const requested = requestedPercent / 100;
            let smallestApplied = requestedPercent;
            let matched = false;

            document.querySelectorAll(area.selector).forEach(element => {
                matched = true;
                rememberBetterWindowInlineStyles(element);
                rememberBetterWindowNaturalSize(element, area);
                element.classList.add('script-scalable-window');
                element.dataset.scriptWindowScaleArea = area.key;

                // 100% significa exactamente el tamaño y layout original de PC del propio juego/script.
                if (requestedPercent === 100) {
                    if (element.dataset.scriptWindowCustomSized === 'true') restoreBetterWindowInlineStyles(element);
                    delete element.dataset.scriptWindowCustomSized;
                    delete element.dataset.scriptWindowSizeSignature;
                    delete element.dataset.scriptWindowTargetWidth;
                    delete element.dataset.scriptWindowTargetHeight;
                    element.dataset.scriptWindowEffectiveScale = '1.000';
                    updateBetterWindowLayoutMode(element, element.getBoundingClientRect().width);
                    if (scriptWindowResizeObserver && element.dataset.scriptWindowResizeObserved !== 'true') {
                        scriptWindowResizeObserver.observe(element);
                        element.dataset.scriptWindowResizeObserved = 'true';
                    }
                    return;
                }

                let baseWidth = Number(element.dataset.scriptWindowBaseWidth) || area.baseWidth;
                const baseHeight = Number(element.dataset.scriptWindowBaseHeight) || area.baseHeight;

                // Al abrir Exact IV el escenario crece con píxeles reales; en móvil la calculadora se superpone.
                if (area.key === 'market' && element.closest('.script-market-backdrop')?.classList.contains('market-iv-open') && viewportWidth > 900) {
                    const calculator = element.querySelector('.market-iv-calculator');
                    baseWidth += Math.max(300, calculator?.getBoundingClientRect().width || 340) + 14;
                }

                const desiredWidth = Math.round(baseWidth * requested);
                const desiredHeight = Math.round(baseHeight * requested);
                const targetWidth = Math.max(272, Math.min(desiredWidth, availableWidth));
                const targetHeight = Math.max(312, Math.min(desiredHeight, availableHeight));
                const effective = Math.min(targetWidth / Math.max(1, baseWidth), targetHeight / Math.max(1, baseHeight));
                const signature = `${requestedPercent}:${targetWidth}x${targetHeight}:${viewportWidth}x${viewportHeight}`;

                element.dataset.scriptWindowEffectiveScale = effective.toFixed(3);
                element.dataset.scriptWindowTargetWidth = String(targetWidth);
                element.dataset.scriptWindowTargetHeight = String(targetHeight);
                if (element.dataset.scriptWindowSizeSignature !== signature) {
                    element.style.removeProperty('--script-window-scale');
                    element.style.removeProperty('scale');
                    element.style.removeProperty('zoom');
                    element.style.setProperty('width', `${targetWidth}px`, 'important');
                    element.style.setProperty('height', `${targetHeight}px`, 'important');
                    element.style.setProperty('max-width', `${availableWidth}px`, 'important');
                    element.style.setProperty('max-height', `${availableHeight}px`, 'important');
                    element.dataset.scriptWindowCustomSized = 'true';
                    element.dataset.scriptWindowSizeSignature = signature;
                }
                updateBetterWindowLayoutMode(element, targetWidth);
                if (scriptWindowResizeObserver && element.dataset.scriptWindowResizeObserved !== 'true') {
                    scriptWindowResizeObserver.observe(element);
                    element.dataset.scriptWindowResizeObserved = 'true';
                }
                smallestApplied = Math.min(smallestApplied, Math.round(effective * 100));
            });

            document.querySelectorAll(`[data-window-scale-status="${area.key}"]`).forEach(status => {
                status.textContent = !matched || smallestApplied === requestedPercent
                    ? requestedPercent === 100 ? 'Original: 100% · nítido' : `Aplicado: ${requestedPercent}% · nítido`
                    : `Solicitado: ${requestedPercent}% · autoajuste: ${smallestApplied}%`;
            });
        });
    }

    window.addEventListener('resize', () => {
        clearTimeout(windowScaleResizeTimer);
        windowScaleResizeTimer = setTimeout(applyBetterWindowScales, 100);
    }, { passive:true });

    const GAME_FONT_OPTIONS = {
        barlow: 'Barlow, "Barlow Fallback", system-ui, sans-serif',
        verdana: 'Verdana, Geneva, sans-serif',
        arial: 'Arial, Helvetica, sans-serif',
        system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        cinzel: 'Cinzel, "Cinzel Fallback", serif'
    };

    function getGameFont() { return localStorage.getItem(STORAGE_GAME_FONT) || 'barlow'; }
    function getCustomFont() { return localStorage.getItem(STORAGE_CUSTOM_FONT) || ''; }
    function openCustomFontDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('piw-qol-assets', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('assets');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function storeCustomFontFile(buffer) {
        const database = await openCustomFontDatabase();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction('assets', 'readwrite');
            transaction.objectStore('assets').put(buffer, 'custom-font');
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
    }
    async function loadStoredCustomFont() {
        try {
            const database = await openCustomFontDatabase();
            const buffer = await new Promise((resolve, reject) => {
                const request = database.transaction('assets').objectStore('assets').get('custom-font');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            database.close();
            if (!buffer) return false;
            const face = new FontFace(CUSTOM_FONT_FAMILY, buffer);
            await face.load();
            document.fonts.add(face);
            if (getGameFont() === 'custom') applyGameFont('custom');
            return true;
        } catch (error) {
            console.warn('Não foi possível carregar a fonte personalizada:', error);
            return false;
        }
    }
    function applyGameFont(value = getGameFont()) {
        const key = value === 'custom' || GAME_FONT_OPTIONS[value] ? value : 'barlow';
        localStorage.setItem(STORAGE_GAME_FONT, key);
        const custom = getCustomFont().replace(/[;{}]/g, '').trim();
        document.documentElement.style.setProperty('--piw-game-font', key === 'custom' && custom ? custom : GAME_FONT_OPTIONS[key === 'custom' ? 'barlow' : key]);
    }
    function isAutoReconnectActive() { return localStorage.getItem(STORAGE_AUTO_RECONNECT) === 'true'; }
    const preferenceEnabled = key => localStorage.getItem(key) !== 'false';
    function applyVisualPreferences() {
        document.documentElement.classList.toggle('script-custom-scrollbars', preferenceEnabled(STORAGE_CUSTOM_SCROLLBARS));
        document.documentElement.classList.toggle('script-unified-fonts', preferenceEnabled(STORAGE_UNIFIED_FONTS));
    }

    let isRendering = false;
    let cachedTrainerLevel = null;
    let trainerLevelPromise = null;
    let lastMapRenderSignature = '';
    let cachedLeaderPokemonName = '';
    let cachedLeaderPokemonTypes = [];
    const globalCreatureApiData = new Map();
    const globalItemApiData = new Map();
    const globalHuntMarkerData = new Map();
    // Esta caché se inicializa antes que la tabla de aliases de Pokémon. Se usa una
    // normalización autónoma para no acceder a una constante todavía no creada y
    // evitar que el userscript se interrumpa durante el arranque.
    const globalCaughtPokemonNames = new Set(loadCaughtPokemonCache().map(value => String(value || '')
        .toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean));
    const globalCaughtPokemonIds = new Set();
    let mapMarkersLoadPromise = null;
    let itemDataLoadPromise = null;
    let mapSearchRenderTimer = 0;

    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[char]);
    }

    function getGameLanguage() {
        const scriptLanguage = localStorage.getItem('script_language_v1');
        if (['es', 'pt', 'en'].includes(scriptLanguage)) return scriptLanguage;
        const candidates = [
            localStorage.getItem('i18nextLng'),
            localStorage.getItem('pokeweb:language'),
            localStorage.getItem('language'),
            localStorage.getItem('locale'),
            document.documentElement.lang,
            navigator.language
        ].filter(Boolean);
        const detected = candidates
            .map(value => String(value).replace(/^["']|["']$/g, ''))
            .find(value => /^(?:es|pt|en)(?:-|_|$)/i.test(value));
        if (/^pt(?:-|_|$)/i.test(detected || '')) return 'pt';
        if (/^es(?:-|_|$)/i.test(detected || '')) return 'es';
        return 'en';
    }

    const SCRIPT_I18N = {
        es: {
            scriptMods: 'Better Market', modSettings: 'Better Market and More',
            enabled: 'Activado', disabled: 'Desactivado', simplifiedMap: 'Mapa simplificado',
            simplifiedMapDesc: 'Activa la lista limpia o restaura el mapa gráfico original.',
            dropsPreview: 'Vista previa de drops', dropsPreviewDesc: 'Elige cómo mostrar los objetos en la lista del mapa.',
            hidden: 'Oculto', icon: 'Icono (?)', navAction: 'Acción del botón de teletransporte',
            navActionDesc: 'Define la acción del botón de teletransporte del juego.', favorite: 'Favorita', last: 'Última', none: 'Desactivado',
            chatInterface: 'Interfaz del chat', chatInterfaceDesc: 'Muestra u oculta la ventana del chat.',
            show: 'Mostrar', hide: 'Ocultar', dexFastTravelDesc: 'Muestra Fast Travel en la Pokédex.',
            enableDexFastTravel: 'Activar ⚡ Fast Travel en la Pokédex', selectAllGuards: 'Protecciones de Seleccionar todo',
            selectAllGuardsDesc: 'Protecciones aplicadas al seleccionar todos los elementos.',
            protectLegendary: 'Desmarcar Pokémon legendarios', protectLocked: 'Desmarcar objetos bloqueados',
            sellConfirmation: 'Confirmación para objetos',
            huntFeatures: 'Funciones de hunts', huntFeaturesDesc: 'Elige las mejoras disponibles durante una hunt.',
            marketHud: 'HUD del Mercado Global', marketHudDesc: 'Consulta anuncios sin salir de la hunt.',
            bulkBuy: 'Compras +1.000/+10.000', bulkBuyDesc: 'Añade cantidades grandes a la tienda de Poké Balls.',
            huntSell: 'Venta durante hunts', huntSellDesc: 'Permite vender objetos y Pokémon desde la tienda de hunt.',
            cityMark: 'Mejoras del Mark', cityMarkDesc: 'Cantidades, bloqueos y confirmaciones en la tienda.',
            bestHunt: 'Comprobar mejor hunt', globalMarket: 'Mercado Global', items: 'Objetos', pokemon: 'Pokémon', refresh: 'Actualizar',
            shops: 'Tiendas', ballShop: 'Tienda de Poké Balls', sellItems: 'Vender objetos y Pokémon',
            search: 'Buscar...', loading: 'Cargando anuncios…', noListings: 'No se encontraron anuncios.',
            showing: 'Mostrando', of: 'de', loadMore: 'Cargar más', inStock: 'en inventario', buy: 'Comprar', offerOnly: 'Oferta',
            ivTotal: 'IV total', showOffers: 'Mostrar ofertas', all: 'Todos', stones: 'Stones', pokeBalls: 'Poké Balls', diamonds: 'Diamantes', currency: 'Moneda', gold: 'Dólar',
            recent: 'Más recientes', lowestPrice: 'Precio más bajo', highestPrice: 'Precio más alto', highestIv: 'Mayor IV', highestPower: 'Mayor poder', highestLevel: 'Mayor nivel', highestQuality: 'Mayor Quality',
            shinyOnly: 'Solo shiny', minIv: 'IV mín.', maxIv: 'IV máx.', minLevel: 'Nivel mín.', maxLevel: 'Nivel máx.', minQuality: 'Quality mín.', maxQuality: 'Quality máx.', allTypes: 'Todos los tipos',
            purchaseDone: 'Compra completada.', purchaseFailed: 'No se pudo completar la compra.', loadFailed: 'No se pudo cargar el mercado.', seller: 'Vendedor', quantity: 'Cantidad', price: 'Precio',
            selectItems: 'Seleccionar objetos ▾', protectedItems: 'Objetos protegidos. Busca para añadir más.', noProtected: 'Sin objetos protegidos', noItemFound: 'No se encontraron objetos'
        },
        pt: {
            scriptMods: 'Mods do Script', modSettings: 'Configurações do Mod',
            enabled: 'Ligado', disabled: 'Desligado', simplifiedMap: 'Mapa simplificado',
            simplifiedMapDesc: 'Ativa a lista limpa ou restaura o mapa gráfico nativo.',
            dropsPreview: 'Visualização dos drops', dropsPreviewDesc: 'Escolha como ver os itens na lista do mapa.',
            hidden: 'Oculto', icon: 'Ícone (?)', navAction: 'Ação do botão de teleporte',
            navActionDesc: 'Define a ação do botão de teleporte na barra do jogo.', favorite: 'Favorita', last: 'Última', none: 'Desativado',
            chatInterface: 'Interface do chat', chatInterfaceDesc: 'Exibe ou oculta a janela de chat.',
            show: 'Exibir', hide: 'Ocultar', dexFastTravelDesc: 'Exibe o Fast Travel na Pokédex.',
            enableDexFastTravel: 'Habilitar ⚡ Fast Travel na Pokédex', selectAllGuards: 'Proteções do Selecionar tudo',
            selectAllGuardsDesc: 'Proteções aplicadas ao selecionar tudo nas abas.',
            protectLegendary: 'Desmarcar Pokémon lendários (aba Pokémon)', protectLocked: 'Desmarcar itens com cadeado (aba Loja)',
            sellConfirmation: 'Itens com confirmação de venda',
            huntFeatures: 'Recursos da Hunt', huntFeaturesDesc: 'Escolha quais melhorias aparecem enquanto estiver em uma hunt.',
            marketHud: 'HUD do Mercado Global', marketHudDesc: 'Consulta anúncios sem precisar sair da hunt.',
            bulkBuy: 'Compras +1.000/+10.000', bulkBuyDesc: 'Adiciona quantidades grandes à loja de Poké Bolas.',
            huntSell: 'Venda na Hunt', huntSellDesc: 'Permite vender itens e Pokémon pela loja da hunt.',
            cityMark: 'Melhorias do Mark', cityMarkDesc: 'Quantidades, cadeados e confirmações na loja da cidade.',
            bestHunt: 'Verificar melhor hunt',
            globalMarket: 'Mercado Global', items: 'Itens', pokemon: 'Pokémon', refresh: 'Atualizar',
            shops: 'Lojas', ballShop: 'Loja de Poké Bolas', sellItems: 'Vender itens e Pokémon',
            search: 'Buscar...', loading: 'Carregando anúncios…', noListings: 'Nenhum anúncio encontrado.',
            showing: 'Exibindo', of: 'de', loadMore: 'Carregar mais',
            inStock: 'em estoque',
            buy: 'Comprar', offerOnly: 'Oferta', ivTotal: 'IV total', showOffers: 'Mostrar ofertas',
            all: 'Todos', stones: 'Stones', pokeBalls: 'Poké Balls', diamonds: 'Diamonds', currency: 'Moeda', gold: 'Dólar',
            recent: 'Mais recentes', lowestPrice: 'Menor preço', highestPrice: 'Maior preço',
            highestIv: 'Maior IV', highestPower: 'Maior poder', highestLevel: 'Maior nível', highestQuality: 'Maior qualidade',
            shinyOnly: 'Somente shiny', minIv: 'IV mín.', maxIv: 'IV máx.', minLevel: 'Nível mín.', maxLevel: 'Nível máx.', minQuality: 'Qual. mín.', maxQuality: 'Qual. máx.', allTypes: 'Todos os tipos',
            purchaseDone: 'Compra concluída.', purchaseFailed: 'Não foi possível concluir a compra.',
            loadFailed: 'Não foi possível carregar o mercado.', seller: 'Vendedor', quantity: 'Quantidade',
            price: 'Preço', selectItems: 'Selecionar itens ▾', protectedItems: 'Itens protegidos. Busque ao lado para adicionar.',
            noProtected: 'Nenhum item protegido', noItemFound: 'Nenhum item encontrado'
        },
        en: {
            scriptMods: 'Script Mods', modSettings: 'Mod Settings',
            enabled: 'Enabled', disabled: 'Disabled', simplifiedMap: 'Simplified Map',
            simplifiedMapDesc: 'Enables the clean list or restores the native graphical map.',
            dropsPreview: 'Drops Preview', dropsPreviewDesc: 'Choose how items appear in the map list.',
            hidden: 'Hidden', icon: 'Icon (?)', navAction: 'Teleport Button Action',
            navActionDesc: 'Defines the teleport button action in the game dock.', favorite: 'Favorite', last: 'Last', none: 'Disabled',
            chatInterface: 'Chat Interface', chatInterfaceDesc: 'Shows or hides the chat window.',
            show: 'Show', hide: 'Hide', dexFastTravelDesc: 'Shows the Fast Travel option in the Pokédex.',
            enableDexFastTravel: 'Enable ⚡ Fast Travel in the Pokédex', selectAllGuards: 'Select All Guards',
            selectAllGuardsDesc: 'Protections applied when using Select All in tabs.',
            protectLegendary: 'Deselect legendary Pokémon (Pokémon tab)', protectLocked: 'Deselect locked items (Shop tab)',
            sellConfirmation: 'Sell Confirmation Items',
            huntFeatures: 'Hunt Features', huntFeaturesDesc: 'Choose which enhancements are available while inside a hunt.',
            marketHud: 'Global Market HUD', marketHudDesc: 'Browse listings without leaving the hunt.',
            bulkBuy: '+1,000/+10,000 purchases', bulkBuyDesc: 'Adds large quantities to the Poké Ball shop.',
            huntSell: 'Hunt Selling', huntSellDesc: 'Sell items and Pokémon from the hunt shop.',
            cityMark: 'Mark Enhancements', cityMarkDesc: 'Quantities, locks and confirmations in the city shop.',
            bestHunt: 'Check best hunt',
            globalMarket: 'Global Market', items: 'Items', pokemon: 'Pokémon', refresh: 'Refresh',
            shops: 'Shops', ballShop: 'Poké Ball Shop', sellItems: 'Sell items and Pokémon',
            search: 'Search...', loading: 'Loading listings…', noListings: 'No listings found.',
            showing: 'Showing', of: 'of', loadMore: 'Load more',
            inStock: 'in stock',
            buy: 'Buy', offerOnly: 'Offer', ivTotal: 'Total IV', showOffers: 'Show offers',
            all: 'All', stones: 'Stones', pokeBalls: 'Poké Balls', diamonds: 'Diamonds', currency: 'Currency', gold: 'Dollar',
            recent: 'Most recent', lowestPrice: 'Lowest price', highestPrice: 'Highest price',
            highestIv: 'Highest IV', highestPower: 'Highest power', highestLevel: 'Highest level', highestQuality: 'Highest quality',
            shinyOnly: 'Shiny only', minIv: 'Min IV', maxIv: 'Max IV', minLevel: 'Min level', maxLevel: 'Max level', minQuality: 'Min quality', maxQuality: 'Max quality', allTypes: 'All types',
            purchaseDone: 'Purchase completed.', purchaseFailed: 'Could not complete the purchase.',
            loadFailed: 'Could not load the market.', seller: 'Seller', quantity: 'Quantity',
            price: 'Price', selectItems: 'Select items ▾', protectedItems: 'Protected items. Search to add more.',
            noProtected: 'No protected items', noItemFound: 'No item found'
        }
    };
    const SCRIPT_SETTINGS_I18N = {
        es: {
            settingsSubtitle: 'Personaliza el mercado, las tiendas, el mapa y las protecciones desde un solo lugar.', language: 'Idioma del script', languageDesc: 'Automático utiliza el idioma configurado en el juego.', automatic: 'Automático (juego)',
            appearance: 'Apariencia y fuentes', mapNavigation: 'Mapa y navegación', interface: 'Interfaz', huntsShops: 'Hunts, tiendas y Mark', protectionsSales: 'Protecciones y ventas', otherFeatures: 'Otras funciones',
            gameFont: 'Fuente del juego', gameFontDesc: 'Aplica la misma familia tipográfica a las ventanas y controles.', originalFont: 'Barlow (original)', systemFont: 'Fuente del sistema', customFont: 'Personalizada', openFont: 'Abrir archivo de fuente…', noFile: 'Ningún archivo seleccionado',
            autoReconnect: 'Reconexión automática de hunt', autoReconnectDesc: 'Va a Cerulean, espera 10 segundos y regresa cuando la hunt queda sin actividad.',
            unifiedFonts: 'Fuente unificada', unifiedFontsDesc: 'Aplica la fuente elegida a las ventanas y controles del juego.', scrollbars: 'Barras de desplazamiento minimalistas', scrollbarsDesc: 'Sustituye las barras blancas por un estilo oscuro y discreto.',
            compareHunts: 'Comparación de hunts', compareHuntsDesc: 'Muestra la ventana móvil y redimensionable de comparación.', quickMark: 'Compras rápidas en Mark', quickMarkDesc: 'Muestra 1, 10, 100, 1.000 y 10.000 en cada producto.',
            qualityPicker: 'Selector de Quality del Mark', qualityPickerDesc: 'Agrupa los tiers en un selector múltiple.',
            fontExample: 'Ej.: "Trebuchet MS", sans-serif'
        },
        pt: {
            settingsSubtitle: 'Personalize o mercado, lojas, mapa e proteções em um só lugar.', language: 'Idioma do script', languageDesc: 'Automático usa o idioma configurado no jogo.', automatic: 'Automático (jogo)',
            appearance: 'Aparência e fontes', mapNavigation: 'Mapa e navegação', interface: 'Interface', huntsShops: 'Hunts, lojas e Mark', protectionsSales: 'Proteções e vendas', otherFeatures: 'Outros recursos',
            gameFont: 'Fonte do jogo', gameFontDesc: 'Aplica a mesma família tipográfica às janelas e controles.', originalFont: 'Barlow (original)', systemFont: 'Fonte do sistema', customFont: 'Personalizada', openFont: 'Abrir arquivo de fonte…', noFile: 'Nenhum arquivo selecionado',
            autoReconnect: 'Auto-reconnect da hunt', autoReconnectDesc: 'Vai a Cerulean, aguarda 10 segundos e retorna quando a hunt fica sem atividade.', unifiedFonts: 'Fonte unificada', unifiedFontsDesc: 'Aplica a fonte escolhida às janelas e controles do jogo.',
            scrollbars: 'Scrollbars minimalistas', scrollbarsDesc: 'Substitui as barras brancas por um estilo escuro e discreto.', compareHunts: 'Comparação de hunts', compareHuntsDesc: 'Exibe a janela móvel e redimensionável de comparação.',
            quickMark: 'Compras rápidas no Mark', quickMarkDesc: 'Mostra 1, 10, 100, 1.000 e 10.000 em cada produto.', qualityPicker: 'Seletor de Quality do Mark', qualityPickerDesc: 'Agrupa os tiers em um seletor múltiplo.',
            fontExample: 'Ex.: "Trebuchet MS", sans-serif'
        },
        en: {
            settingsSubtitle: 'Customize the market, shops, map, and protections in one place.', language: 'Script language', languageDesc: 'Automatic follows the language configured in the game.', automatic: 'Automatic (game)',
            appearance: 'Appearance and fonts', mapNavigation: 'Map and navigation', interface: 'Interface', huntsShops: 'Hunts, shops, and Mark', protectionsSales: 'Protections and sales', otherFeatures: 'Other features',
            gameFont: 'Game font', gameFontDesc: 'Applies the same font family to windows and controls.', originalFont: 'Barlow (original)', systemFont: 'System font', customFont: 'Custom', openFont: 'Open font file…', noFile: 'No file selected',
            autoReconnect: 'Hunt auto-reconnect', autoReconnectDesc: 'Travels to Cerulean, waits 10 seconds, and returns when the hunt becomes inactive.', unifiedFonts: 'Unified font', unifiedFontsDesc: 'Applies the chosen font to game windows and controls.',
            scrollbars: 'Minimal scrollbars', scrollbarsDesc: 'Replaces white scrollbars with a discreet dark style.', compareHunts: 'Hunt comparison', compareHuntsDesc: 'Shows the movable and resizable comparison window.',
            quickMark: 'Quick Mark purchases', quickMarkDesc: 'Shows 1, 10, 100, 1,000, and 10,000 on every product.', qualityPicker: 'Mark Quality selector', qualityPickerDesc: 'Groups Quality tiers into a multi-select control.',
            fontExample: 'E.g. "Trebuchet MS", sans-serif'
        }
    };
    const SCRIPT_EXTRA_I18N = {
        es: { buyTab:'Comprar', sellTab:'Vender', cards:'Cartas', list:'Lista', selectedToSell:'SELECCIONADO PARA VENDER', closeSelection:'Cerrar selección', amount:'Cantidad', unitPrice:'Precio unitario', enterPrice:'Introduce el precio', advertise:'Anunciar', availableUnits:'unidades disponibles', individualSelection:'Selección individual', selectedPokemon:'1 Pokémon', lowestUnitPrice:'Precio unitario más bajo:', comparedAds:'anuncio(s) comparado(s)', useSuggested:'Usar precio sugerido', checkingPrice:'Consultando el precio más bajo de', noActiveAds:'Sin anuncios activos; el precio queda a tu criterio.', ballAndHealing:'Poké Balls y Cura', balls:'Poké Balls', potionsRevives:'Pociones y Revivir', healingConsumable:'CURA / CONSUMIBLE', sellNpcItems:'Vender objetos', sellNpcPokemon:'Vender Pokémon', markAll:'Marcar todo', unmarkAll:'Desmarcar todo', cancel:'Cancelar', sell:'Vender', currentBalance:'Saldo actual', selectedSale:'Venta seleccionada', mapCities:'Ciudades', mapHunts:'Zonas de caza', mapFilters:'Explorar el mapa', mapFiltersDesc:'Busca y combina filtros para encontrar el mejor destino.', mapSearch:'Buscar zona, Pokémon o drop...', mapOrder:'Orden', mapType:'Tipo', mapLevel:'Nivel Pokémon', mapLevelMin:'Mín.', mapLevelMax:'Máx.', mapAccess:'Acceso y ventaja', mapClear:'Limpiar', mapCaptured:'Capturados', mapMissing:'No capturados', mapTravel:'Viajar', mapGo:'Ir', mapCity:'CIUDAD', mapHunt:'ZONA DE CAZA', mapTransport:'NPC de transporte', mapOpenAccess:'Acceso disponible', mapResults:'destinos encontrados', mapValue:'Valor', mapExperience:'Experiencia' },
        pt: { buyTab:'Comprar', sellTab:'Vender', cards:'Cartas', list:'Lista', selectedToSell:'SELECIONADO PARA VENDER', closeSelection:'Fechar seleção', amount:'Quantidade', unitPrice:'Preço unitário', enterPrice:'Digite o preço', advertise:'Anunciar', availableUnits:'unidades disponíveis', individualSelection:'Seleção individual', selectedPokemon:'1 Pokémon', lowestUnitPrice:'Menor preço unitário:', comparedAds:'anúncio(s) comparado(s)', useSuggested:'Usar preço sugerido', checkingPrice:'Consultando o menor preço de', noActiveAds:'Sem anúncios ativos; defina o preço livremente.', ballAndHealing:'Poké Bolas e Cura', balls:'Poké Bolas', potionsRevives:'Poções e Revives', healingConsumable:'CURA / CONSUMÍVEL', sellNpcItems:'Vender itens', sellNpcPokemon:'Vender Pokémon', markAll:'Marcar tudo', unmarkAll:'Desmarcar tudo', cancel:'Cancelar', sell:'Vender', currentBalance:'Saldo atual', selectedSale:'Venda selecionada', mapCities:'Cidades', mapHunts:'Hunts', mapFilters:'Explorar o mapa', mapFiltersDesc:'Busque e combine filtros para encontrar o melhor destino.', mapSearch:'Buscar hunt, Pokémon ou drop...', mapOrder:'Ordem', mapType:'Tipo', mapLevel:'Nível Pokémon', mapLevelMin:'Mín.', mapLevelMax:'Máx.', mapAccess:'Acesso e vantagem', mapClear:'Limpar', mapCaptured:'Capturados', mapMissing:'Não capturados', mapTravel:'Viajar', mapGo:'Ir', mapCity:'CIDADE', mapHunt:'HUNT', mapTransport:'NPC de transporte', mapOpenAccess:'Acesso disponível', mapResults:'destinos encontrados', mapValue:'Valor', mapExperience:'Experiência' },
        en: { buyTab:'Buy', sellTab:'Sell', cards:'Cards', list:'List', selectedToSell:'SELECTED TO SELL', closeSelection:'Close selection', amount:'Quantity', unitPrice:'Unit price', enterPrice:'Enter a price', advertise:'List item', availableUnits:'units available', individualSelection:'Individual selection', selectedPokemon:'1 Pokémon', lowestUnitPrice:'Lowest unit price:', comparedAds:'listing(s) compared', useSuggested:'Use suggested price', checkingPrice:'Checking the lowest price for', noActiveAds:'No active listings; choose your own price.', ballAndHealing:'Poké Balls and Healing', balls:'Poké Balls', potionsRevives:'Potions and Revives', healingConsumable:'HEALING / CONSUMABLE', sellNpcItems:'Sell items', sellNpcPokemon:'Sell Pokémon', markAll:'Select all', unmarkAll:'Clear all', cancel:'Cancel', sell:'Sell', currentBalance:'Current balance', selectedSale:'Selected sale', mapCities:'Cities', mapHunts:'Hunting areas', mapFilters:'Explore the map', mapFiltersDesc:'Search and combine filters to find the best destination.', mapSearch:'Search area, Pokémon, or drop...', mapOrder:'Order', mapType:'Type', mapLevel:'Pokémon level', mapLevelMin:'Min.', mapLevelMax:'Max.', mapAccess:'Access and advantage', mapClear:'Clear', mapCaptured:'Captured', mapMissing:'Not captured', mapTravel:'Travel', mapGo:'Go', mapCity:'CITY', mapHunt:'HUNTING AREA', mapTransport:'Transport NPC', mapOpenAccess:'Access available', mapResults:'destinations found', mapValue:'Value', mapExperience:'Experience' }
    };
    Object.assign(SCRIPT_EXTRA_I18N.es, { mapFavorites:'Favoritos', mapAdvantage:'Ventaja', mapNeutral:'Neutral', mapDisadvantage:'Desventaja', mapLocked:'Bloqueados', mapNotFavorites:'No favoritos', mapLast:'Última zona', mapHere:'AQUÍ', mapRequires:'Requiere nivel', mapYourLevel:'tu nivel' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { mapFavorites:'Favoritos', mapAdvantage:'Vantagem', mapNeutral:'Neutra', mapDisadvantage:'Desvantagem', mapLocked:'Bloqueadas', mapNotFavorites:'Não favoritas', mapLast:'Última hunt', mapHere:'AQUI', mapRequires:'Requer nível', mapYourLevel:'seu nível' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { mapFavorites:'Favorites', mapAdvantage:'Advantage', mapNeutral:'Neutral', mapDisadvantage:'Disadvantage', mapLocked:'Locked', mapNotFavorites:'Not favorites', mapLast:'Last area', mapHere:'HERE', mapRequires:'Requires level', mapYourLevel:'your level' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { depotItems:'Objetos', depotPokemon:'Pokémon', depotFamilyItems:'Familia: objetos', depotFamilyPokemon:'Familia: Pokémon', depotSubtitle:'Almacenamiento personal y familiar', depotBag:'Mochila', depotTeam:'Equipo', depotBox:'Box', depotFamily:'Depósito familiar', depotYourBag:'Tu mochila', depotYourPokemon:'Tus Pokémon · equipo y Box', depotSearchPokemon:'Buscar Pokémon por nombre', depotClear:'Limpiar', depotStore:'Guardar', depotDeposit:'Depositar', depotWithdraw:'Retirar', depotItemKind:'OBJETO', depotPokemonKind:'POKÉMON', depotAvailable:'disponibles', depotEmpty:'No hay contenido disponible' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { depotItems:'Itens', depotPokemon:'Pokémon', depotFamilyItems:'Família: itens', depotFamilyPokemon:'Família: Pokémon', depotSubtitle:'Armazenamento pessoal e familiar', depotBag:'Mochila', depotTeam:'Equipe', depotBox:'Box', depotFamily:'Depósito da família', depotYourBag:'Sua mochila', depotYourPokemon:'Seus Pokémon · equipe e Box', depotSearchPokemon:'Buscar Pokémon pelo nome', depotClear:'Limpar', depotStore:'Guardar', depotDeposit:'Depositar', depotWithdraw:'Retirar', depotItemKind:'ITEM', depotPokemonKind:'POKÉMON', depotAvailable:'disponíveis', depotEmpty:'Nenhum conteúdo disponível' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { depotItems:'Items', depotPokemon:'Pokémon', depotFamilyItems:'Family: items', depotFamilyPokemon:'Family: Pokémon', depotSubtitle:'Personal and family storage', depotBag:'Bag', depotTeam:'Team', depotBox:'Box', depotFamily:'Family depot', depotYourBag:'Your bag', depotYourPokemon:'Your Pokémon · team and Box', depotSearchPokemon:'Search Pokémon by name', depotClear:'Clear', depotStore:'Store', depotDeposit:'Deposit', depotWithdraw:'Withdraw', depotItemKind:'ITEM', depotPokemonKind:'POKÉMON', depotAvailable:'available', depotEmpty:'No content available' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { depotTierFilter:'Tiers de Quality visibles', depotAllTiers:'Todos', depotNoTiers:'Ninguno' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { depotTierFilter:'Tiers de Quality visíveis', depotAllTiers:'Todos', depotNoTiers:'Nenhum' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { depotTierFilter:'Visible Quality tiers', depotAllTiers:'All', depotNoTiers:'None' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { marketRequests:'Solicitudes', marketHistory:'Historial', requestCreate:'Crear solicitud', requestItem:'Objeto solicitado', requestChoose:'Selecciona un objeto', requestQty:'Cantidad', requestPrice:'Precio por unidad', requestCustody:'Importe en custodia', requestFee:'Comisión', requestTotal:'Total requerido', myRequests:'Mis solicitudes', openRequests:'Solicitudes abiertas', cancelRequest:'Cancelar', sellToRequest:'Vender', noRequests:'No hay solicitudes abiertas.', historyEmpty:'Todavía no hay operaciones en el historial.', historyBought:'Compraste', historySold:'Vendiste', perUnit:'c/u', offerTag:'oferta', requestCreated:'Solicitud creada.', requestCanceled:'Solicitud cancelada.', requestSold:'Venta completada.', requestConfirm:'Confirmar solicitud', requestSellConfirm:'Confirmar venta a solicitud' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { marketRequests:'Pedidos', marketHistory:'Histórico', requestCreate:'Criar pedido', requestItem:'Item solicitado', requestChoose:'Selecione um item', requestQty:'Quantidade', requestPrice:'Preço por unidade', requestCustody:'Valor em custódia', requestFee:'Taxa', requestTotal:'Total necessário', myRequests:'Meus pedidos', openRequests:'Pedidos abertos', cancelRequest:'Cancelar', sellToRequest:'Vender', noRequests:'Não há pedidos abertos.', historyEmpty:'Ainda não há operações no histórico.', historyBought:'Você comprou', historySold:'Você vendeu', perUnit:'un', offerTag:'oferta', requestCreated:'Pedido criado.', requestCanceled:'Pedido cancelado.', requestSold:'Venda concluída.', requestConfirm:'Confirmar pedido', requestSellConfirm:'Confirmar venda ao pedido' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { marketRequests:'Requests', marketHistory:'History', requestCreate:'Create request', requestItem:'Requested item', requestChoose:'Choose an item', requestQty:'Quantity', requestPrice:'Unit price', requestCustody:'Amount in custody', requestFee:'Fee', requestTotal:'Required total', myRequests:'My requests', openRequests:'Open requests', cancelRequest:'Cancel', sellToRequest:'Sell', noRequests:'No open requests.', historyEmpty:'There are no transactions in your history yet.', historyBought:'Bought', historySold:'Sold', perUnit:'each', offerTag:'offer', requestCreated:'Request created.', requestCanceled:'Request cancelled.', requestSold:'Sale completed.', requestConfirm:'Confirm request', requestSellConfirm:'Confirm request sale' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { requestFilters:'Filtrar solicitudes', requestSearchFilter:'Buscar solicitudes...', requestMostQuantity:'Mayor cantidad', clearFilters:'Limpiar filtros' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { requestFilters:'Filtrar pedidos', requestSearchFilter:'Buscar pedidos...', requestMostQuantity:'Maior quantidade', clearFilters:'Limpar filtros' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { requestFilters:'Filter requests', requestSearchFilter:'Search requests...', requestMostQuantity:'Highest quantity', clearFilters:'Clear filters' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { historyJustNow:'hace unos segundos' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { historyJustNow:'há alguns segundos' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { historyJustNow:'a few seconds ago' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { itemRarity:'Rareza', allRarities:'Todas las rarezas', rarityCommon:'Común', rarityUncommon:'Poco común', rarityRare:'Raro', rarityEpic:'Épico', rarityLegendary:'Legendario', rarityMythic:'Mítico', rarityAncient:'Ancestral', rarityDivine:'Divino' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { itemRarity:'Raridade', allRarities:'Todas as raridades', rarityCommon:'Comum', rarityUncommon:'Incomum', rarityRare:'Raro', rarityEpic:'Épico', rarityLegendary:'Lendário', rarityMythic:'Mítico', rarityAncient:'Ancião', rarityDivine:'Divino' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { itemRarity:'Rarity', allRarities:'All rarities', rarityCommon:'Common', rarityUncommon:'Uncommon', rarityRare:'Rare', rarityEpic:'Epic', rarityLegendary:'Legendary', rarityMythic:'Mythic', rarityAncient:'Ancient', rarityDivine:'Divine' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { marketConversion:'Conversión' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { marketConversion:'Conversão' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { marketConversion:'Conversion' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { marketMyListings:'Mis anuncios', marketMyListingsEmpty:'No tienes anuncios publicados que coincidan con los filtros.', marketCancelListing:'Retirar anuncio', marketCancelListingConfirm:'¿Retirar este anuncio del mercado?', marketListingCanceled:'Anuncio retirado correctamente.' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { marketMyListings:'Meus anúncios', marketMyListingsEmpty:'Você não possui anúncios publicados que correspondam aos filtros.', marketCancelListing:'Retirar anúncio', marketCancelListingConfirm:'Retirar este anúncio do mercado?', marketListingCanceled:'Anúncio retirado com sucesso.' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { marketMyListings:'My Listings', marketMyListingsEmpty:'You have no published listings matching the filters.', marketCancelListing:'Cancel listing', marketCancelListingConfirm:'Cancel this market listing?', marketListingCanceled:'Listing cancelled successfully.' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { pokemonEstimatedPrice:'Precio estimado:', similarPokemon:'Pokémon similares', pokemonCompareDetails:'misma especie · Quality, IV y nivel cercanos', checkingPokemonPrice:'Buscando Pokémon similares a', noSimilarPokemon:'No hay Pokémon similares publicados; el precio queda a tu criterio.', viewSimilar:'Ver similares', similarWindowTitle:'Pokémon usados para la comparación', comparedWith:'Comparando con', bestSimilarMatch:'MÁS PARECIDO' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { pokemonEstimatedPrice:'Preço estimado:', similarPokemon:'Pokémon similares', pokemonCompareDetails:'mesma espécie · Quality, IV e nível próximos', checkingPokemonPrice:'Buscando Pokémon similares a', noSimilarPokemon:'Não há Pokémon similares anunciados; defina o preço livremente.', viewSimilar:'Ver similares', similarWindowTitle:'Pokémon usados na comparação', comparedWith:'Comparando com', bestSimilarMatch:'MAIS PARECIDO' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { pokemonEstimatedPrice:'Estimated price:', similarPokemon:'similar Pokémon', pokemonCompareDetails:'same species · similar Quality, IV, and level', checkingPokemonPrice:'Finding Pokémon similar to', noSimilarPokemon:'No similar Pokémon are listed; choose your own price.', viewSimilar:'View similar', similarWindowTitle:'Pokémon used for comparison', comparedWith:'Comparing against', bestSimilarMatch:'CLOSEST MATCH' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { marketFavorites:'Favoritos', addMarketFavorite:'Añadir a favoritos', removeMarketFavorite:'Quitar de favoritos', marketFeatured:'Destacados', addMarketFeatured:'Destacar Pokémon', removeMarketFeatured:'Quitar de destacados', featuredUnavailable:'Anuncio ya no disponible', featuredEmpty:'No has destacado ningún Pokémon todavía.', marketAlerts:'Alertas', alertCreate:'Crear alerta', alertName:'Pokémon (opcional)', alertNamePlaceholder:'Ej. Charizard', alertPriceMin:'Precio mín.', alertPriceMax:'Precio máx.', alertActiveRules:'Alertas activas', alertAutoBuy:'Compra automática', alertCopyFilters:'Copiar filtros', alertPasteFilters:'Pegar filtros', alertFiltersCopied:'Filtros copiados al portapapeles.', alertFiltersPasted:'Filtros pegados. Ajusta el Pokémon si lo deseas.', alertFiltersInvalid:'No se encontraron filtros de alerta válidos en el portapapeles.', alertExport:'Exportar', alertImport:'Importar', alertExported:'Alertas exportadas y listas para importar.', alertImported:'Alertas importadas: {count}.', alertImportInvalid:'No se encontraron alertas válidas para importar.', alertNoRules:'Crea una alerta para recibir avisos de nuevos Pokémon publicados.', alertNoMatches:'No hay alertas disponibles para comprar.', alertNewListing:'Nuevo Pokémon en alerta', alertAutoBought:'Compra automática completada', alertRemove:'Eliminar alerta', alertAnyPokemon:'Cualquier Pokémon', alertSaved:'Alerta creada. Solo avisará de anuncios publicados a partir de ahora.', telegram:'Telegram', telegramSettings:'Conexión de Telegram', telegramToken:'Token del bot', telegramChatId:'Chat ID', telegramEnabled:'Enviar alertas a Telegram', telegramSave:'Guardar conexión', telegramTest:'Probar conexión', telegramSaved:'Conexión de Telegram guardada.', telegramTestMessage:'Telegram conectado correctamente.', telegramBuy:'Comprar', telegramBought:'Compra completada desde Telegram.', telegramUnavailable:'Este anuncio ya no está disponible.', marketSaleFinished:'Venta finalizada' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { marketFavorites:'Favoritos', addMarketFavorite:'Adicionar aos favoritos', removeMarketFavorite:'Remover dos favoritos', marketFeatured:'Destaques', addMarketFeatured:'Destacar Pokémon', removeMarketFeatured:'Remover dos destaques', featuredUnavailable:'Anúncio não está mais disponível', featuredEmpty:'Você ainda não destacou nenhum Pokémon.', marketAlerts:'Alertas', alertCreate:'Criar alerta', alertName:'Pokémon (opcional)', alertNamePlaceholder:'Ex. Charizard', alertPriceMin:'Preço mín.', alertPriceMax:'Preço máx.', alertActiveRules:'Alertas ativas', alertAutoBuy:'Compra automática', alertNoRules:'Crie um alerta para receber avisos de novos Pokémon anunciados.', alertNoMatches:'Não há alertas disponíveis para comprar.', alertNewListing:'Novo Pokémon no alerta', alertAutoBought:'Compra automática concluída', alertRemove:'Excluir alerta', alertAnyPokemon:'Qualquer Pokémon', alertSaved:'Alerta criada. Ela só avisará sobre anúncios publicados a partir de agora.', telegram:'Telegram', telegramSettings:'Conexão do Telegram', telegramToken:'Token do bot', telegramChatId:'Chat ID', telegramEnabled:'Enviar alertas ao Telegram', telegramSave:'Salvar conexão', telegramTest:'Testar conexão', telegramSaved:'Conexão do Telegram salva.', telegramTestMessage:'Telegram conectado corretamente.', telegramBuy:'Comprar', telegramBought:'Compra concluída pelo Telegram.', telegramUnavailable:'Este anúncio não está mais disponível.', marketSaleFinished:'Venda concluída' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { marketFavorites:'Favorites', addMarketFavorite:'Add to favorites', removeMarketFavorite:'Remove from favorites', marketFeatured:'Featured', addMarketFeatured:'Feature Pokémon', removeMarketFeatured:'Remove from featured', featuredUnavailable:'Listing is no longer available', featuredEmpty:'You have not featured any Pokémon yet.', marketAlerts:'Alerts', alertCreate:'Create alert', alertName:'Pokémon (optional)', alertNamePlaceholder:'E.g. Charizard', alertPriceMin:'Min. price', alertPriceMax:'Max. price', alertActiveRules:'Active alerts', alertAutoBuy:'Automatic purchase', alertNoRules:'Create an alert to receive notices of newly listed Pokémon.', alertNoMatches:'There are no alerts available to buy.', alertNewListing:'New Pokémon alert', alertAutoBought:'Automatic purchase completed', alertRemove:'Delete alert', alertAnyPokemon:'Any Pokémon', alertSaved:'Alert created. It will only notify you of listings published from now on.', telegram:'Telegram', telegramSettings:'Telegram connection', telegramToken:'Bot token', telegramChatId:'Chat ID', telegramEnabled:'Send alerts to Telegram', telegramSave:'Save connection', telegramTest:'Test connection', telegramSaved:'Telegram connection saved.', telegramTestMessage:'Telegram connected successfully.', telegramBuy:'Buy', telegramBought:'Purchase completed from Telegram.', telegramUnavailable:'This listing is no longer available.', marketSaleFinished:'Sale completed' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { marketAdvancedFilters:'Filtros avanzados', marketFavoritesPrevious:'Favoritos anteriores', marketFavoritesNext:'Siguientes favoritos' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { marketAdvancedFilters:'Filtros avançados', marketFavoritesPrevious:'Favoritos anteriores', marketFavoritesNext:'Próximos favoritos' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { marketAdvancedFilters:'Advanced filters', marketFavoritesPrevious:'Previous favorites', marketFavoritesNext:'Next favorites' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { lockPokemon:'Bloquear Pokémon', unlockPokemon:'Desbloquear Pokémon', unlockBeforeListing:'Desbloquea este Pokémon antes de anunciarlo.' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { lockPokemon:'Bloquear Pokémon', unlockPokemon:'Desbloquear Pokémon', unlockBeforeListing:'Desbloqueie este Pokémon antes de anunciá-lo.' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { lockPokemon:'Lock Pokémon', unlockPokemon:'Unlock Pokémon', unlockBeforeListing:'Unlock this Pokémon before listing it.' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { saleGrossTotal:'Total bruto', listingFee:'Fee de publicación', saleNetProfit:'Ganancia neta', feeExempt:'Exento' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { saleGrossTotal:'Total bruto', listingFee:'Taxa de anúncio', saleNetProfit:'Ganho líquido', feeExempt:'Isento' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { saleGrossTotal:'Gross total', listingFee:'Listing fee', saleNetProfit:'Net profit', feeExempt:'Exempt' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { mapShowFilters:'Mostrar filtros', mapHideFilters:'Ocultar filtros', depotLockVisible:'Bloquear visibles', depotUnlockVisible:'Desbloquear visibles', depotVisibleLocked:'Elementos visibles actualizados' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { mapShowFilters:'Mostrar filtros', mapHideFilters:'Ocultar filtros', depotLockVisible:'Bloquear visíveis', depotUnlockVisible:'Desbloquear visíveis', depotVisibleLocked:'Elementos visíveis atualizados' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { mapShowFilters:'Show filters', mapHideFilters:'Hide filters', depotLockVisible:'Lock visible', depotUnlockVisible:'Unlock visible', depotVisibleLocked:'Visible entries updated' });
    Object.assign(SCRIPT_EXTRA_I18N.es, { depotMoveVisible:'Transferir visibles', depotMoveAllShort:'Todo', depotMoveVisibleConfirm:'¿Transferir todos los elementos visibles de este lado?', depotVisibleMoved:'Elementos visibles transferidos', depotNothingMovable:'No hay elementos visibles que se puedan transferir', depotFamilyFrozen:'El depósito familiar está congelado', depotMoveLimit:'Se alcanzó el límite diario de movimientos familiares' });
    Object.assign(SCRIPT_EXTRA_I18N.pt, { depotMoveVisible:'Transferir visíveis', depotMoveAllShort:'Tudo', depotMoveVisibleConfirm:'Transferir todos os elementos visíveis deste lado?', depotVisibleMoved:'Elementos visíveis transferidos', depotNothingMovable:'Não há elementos visíveis que possam ser transferidos', depotFamilyFrozen:'O depósito da família está congelado', depotMoveLimit:'O limite diário de movimentos familiares foi atingido' });
    Object.assign(SCRIPT_EXTRA_I18N.en, { depotMoveVisible:'Move visible', depotMoveAllShort:'All', depotMoveVisibleConfirm:'Move every visible entry from this side?', depotVisibleMoved:'Visible entries moved', depotNothingMovable:'There are no visible entries that can be moved', depotFamilyFrozen:'The family depot is frozen', depotMoveLimit:'The daily family movement limit has been reached' });
    function tr(key) {
        const language = getGameLanguage();
        return SCRIPT_I18N[language]?.[key] || SCRIPT_SETTINGS_I18N[language]?.[key]
            || SCRIPT_EXTRA_I18N[language]?.[key] || SCRIPT_I18N.en[key]
            || SCRIPT_SETTINGS_I18N.en[key] || SCRIPT_EXTRA_I18N.en[key] || key;
    }

    function readStoredJSON(key, fallback) {
        const stored = localStorage.getItem(key);
        if (!stored) return fallback;
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : fallback;
        } catch (error) {
            console.warn(`Falha ao ler a configuração "${key}". O valor padrão será usado.`, error);
            return fallback;
        }
    }

    const STORAGE_MARKET_FAVORITES = 'script_market_favorites_v1';
    const STORAGE_MARKET_FEATURED_POKEMON = 'script_market_featured_pokemon_v1';
    const STORAGE_MARKET_ALERTS = 'script_market_alerts_v1';
    const STORAGE_MARKET_ALERTS_SEEN = 'script_market_alerts_seen_v1';
    const STORAGE_MARKET_ALERT_INBOX = 'script_market_alert_inbox_v1';
    const STORAGE_MARKET_ALERT_AUTO_BUY = 'script_market_alert_auto_buy_v1';
    const STORAGE_MARKET_ITEM_ALERTS = 'script_market_item_alerts_v1';
    const STORAGE_MARKET_ITEM_ALERTS_SEEN = 'script_market_item_alerts_seen_v1';
    const STORAGE_MARKET_ITEM_ALERT_INBOX = 'script_market_item_alert_inbox_v1';
    const STORAGE_MARKET_ITEM_ALERT_AUTO_BUY = 'script_market_item_alert_auto_buy_v1';
    const STORAGE_MARKET_ITEM_ALERT_AUTO_STATUS = 'script_market_item_alert_auto_status_v1';
    const STORAGE_MARKET_ALERT_CLIPBOARD = 'script_market_alert_clipboard_v1';
    const STORAGE_MARKET_ALERT_EXPORT = 'script_market_alert_export_v1';
    const STORAGE_MARKET_TELEGRAM = 'script_market_telegram_v1';
    const STORAGE_MARKET_TELEGRAM_OFFSET = 'script_market_telegram_offset_v1';
    const STORAGE_MARKET_TELEGRAM_DELIVERED = 'script_market_telegram_delivered_v1';
    const STORAGE_MARKET_SALES_SEEN = 'script_market_sales_seen_v1';
    const STORAGE_MARKET_SALES_UNREAD = 'script_market_sales_unread_v1';
    // Alertas fue retirada en 10.1.0. Esta bandera mantiene inerte el código de
    // compatibilidad que aún comparte utilidades con el resto del mercado.
    const MARKET_ALERTS_REMOVED = true;
    let marketSaleMonitorBusy = false;
    let marketSaleMonitorReady = false;
    let marketSaleMonitorInterval = null;
    const marketTelegramDeliveryBusy = new Set();
    let marketSaleToastBusy = false;
    const marketSaleToastQueue = [];
    let marketUnifiedMonitorBusy = false;
    let marketUnifiedPollPending = false;
    let marketAlertBackoffUntil = 0;
    const MAX_MARKET_ALERT_HTTP_READS = 8;
    let marketAlertHttpReadsInFlight = 0;
    let marketAlertPollPokemonFirst = true;
    let lastPokemonMarketReadCompletedAt = 0;
    let lastItemMarketReadCompletedAt = 0;
    let marketAlertMonitorReady = false;
    let marketItemAlertMonitorReady = false;
    let marketAlertToastBusy = false;
    const marketAlertToastQueue = [];

    function getMarketFavorites() {
        return readStoredJSON(STORAGE_MARKET_FAVORITES, []).filter(entry => entry?.key && entry?.name);
    }

    function marketFavoriteKey(entry) {
        const kind = getMarketEntryKind(entry) || String(entry?.kind || 'item').toLowerCase();
        const refId = getMarketEntryRefId(entry);
        return refId == null ? '' : `${kind}:${refId}`;
    }

    function setMarketFavorite(entry, enabled) {
        const key = marketFavoriteKey(entry);
        if (!key) return;
        const favorites = getMarketFavorites().filter(favorite => favorite.key !== key);
        if (enabled) {
            const ref = entry?.item || entry?.product || {};
            const name = entry?.name || entry?.title || entry?.itemName || ref.name || ref.title || `#${getMarketEntryRefId(entry)}`;
            favorites.push({
                key,
                kind: getMarketEntryKind(entry) || 'item',
                refId: getMarketEntryRefId(entry),
                name,
                icon: getMarketEntryImage(entry) || '',
                category: getListingCategoryForFavorite(entry)
            });
        }
        localStorage.setItem(STORAGE_MARKET_FAVORITES, JSON.stringify(favorites.slice(-40)));
    }

    function getListingCategoryForFavorite(entry) {
        const kind = getMarketEntryKind(entry);
        if (kind === 'ball') return 'Poke Balls';
        if (/stone/.test(kind) || /stone/i.test(entry?.name || entry?.itemName || '')) return 'Stones';
        return 'Items';
    }

    function getMarketItemAlertPollCategory(alerts) {
        const categories = new Set();
        for (const alert of Array.isArray(alerts) ? alerts : []) {
            const alertName = String(alert?.name || '').trim().toLowerCase();
            // Una regla sin nombre debe poder encontrar cualquier objeto.
            if (!alertName) return 'All';
            let itemData = globalItemApiData.get(alertName);
            if (!itemData) {
                for (const item of new Set(globalItemApiData.values())) {
                    const itemName = String(item?.name || item?.title || '').trim().toLowerCase();
                    if (itemName && (itemName === alertName || itemName.includes(alertName) || alertName.includes(itemName))) {
                        itemData = item;
                        break;
                    }
                }
            }
            const kind = String(itemData?.kind || itemData?.itemKind || '').trim().toLowerCase();
            const category = String(itemData?.category || '').trim().toLowerCase();
            if (/diamond/.test(kind) || /diamond/.test(category) || /diamond/.test(alertName)) categories.add('Diamonds');
            else if (/^(ball|pokeball|poke-ball|poke_ball)$/.test(kind) || /ball/.test(category)) categories.add('Poke Balls');
            else if (/stone/.test(kind) || /stone/.test(category) || /stone\b/.test(alertName)) categories.add('Stones');
            else if (itemData) categories.add('Items');
            else return 'All';
            if (categories.size > 1) return 'All';
        }
        return categories.values().next().value || 'All';
    }

    // Los favoritos de objetos se agrupan por objeto. En cambio, un destacado debe
    // identificar el anuncio exacto: dos Pokémon de la misma especie pueden tener
    // IV, nivel, precio y vendedor distintos.
    function marketFeaturedPokemonKey(entry) {
        const listingId = getMarketListingId(entry);
        return listingId == null || listingId === '' ? '' : `pokemon:${listingId}`;
    }

    function getMarketListingId(entry) {
        return entry?._scriptMarketListingId ?? entry?.id ?? entry?.listingId ?? entry?.marketId
            ?? (Array.isArray(entry?.ids) ? entry.ids[0] : null);
    }

    function getMarketListingIds(entry) {
        const ids = Array.isArray(entry?.ids) ? entry.ids.filter(id => id != null && id !== '') : [];
        const primary = entry?.id ?? entry?.listingId ?? entry?.marketId;
        if (primary != null && primary !== '') ids.unshift(primary);
        const seen = new Set();
        return ids.filter(id => {
            const key = String(id);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function isMarketPokemonListing(entry) {
        const kind = getMarketEntryKind(entry);
        return kind === 'pokemon' || kind === 'poke' || Boolean(entry?.pokemon)
            || entry?.speciesId != null || entry?.pokemonId != null;
    }

    function getMarketFeaturedPokemon() {
        return readStoredJSON(STORAGE_MARKET_FEATURED_POKEMON, [])
            .filter(entry => entry?.key && entry?.listing && isMarketPokemonListing(entry.listing));
    }

    function setMarketFeaturedPokemon(entry, enabled) {
        const key = marketFeaturedPokemonKey(entry);
        if (!key) return;
        const featured = getMarketFeaturedPokemon().filter(item => item.key !== key);
        if (enabled) {
            // El anuncio completo permite mantener su card como referencia incluso
            // cuando otro jugador ya lo compró. La siguiente carga confirma si aún
            // está disponible para comprar.
            featured.push({ key, selectedAt:Date.now(), listing:JSON.parse(JSON.stringify(entry)) });
        }
        localStorage.setItem(STORAGE_MARKET_FEATURED_POKEMON, JSON.stringify(featured.slice(-200)));
    }

    function getFeaturedPokemonListings(liveListings) {
        const liveByKey = new Map((Array.isArray(liveListings) ? liveListings : [])
            .filter(isMarketPokemonListing)
            .map(entry => [marketFeaturedPokemonKey(entry), entry])
            .filter(([key]) => Boolean(key)));
        return getMarketFeaturedPokemon().map(featured => {
            const live = liveByKey.get(featured.key);
            const listing = live || featured.listing;
            return { ...listing, _scriptFeaturedKey:featured.key, _scriptFeaturedAvailable:Boolean(live) };
        });
    }

    function getMarketAlerts() {
        if (MARKET_ALERTS_REMOVED) return [];
        return readStoredJSON(STORAGE_MARKET_ALERTS, [])
            .filter(alert => alert?.id && Array.isArray(alert.tiers))
            .map(alert => {
                const { qualityMin: _legacyQualityMin, qualityMax: _legacyQualityMax, ...withoutLegacyQuality } = alert;
                return {
                    ...withoutLegacyQuality,
                    tiers: alert.tiers
                        .map(tier => MARKET_QUALITY_TIER_DEFINITIONS.find(definition => definition.id === normalizeMarketTier(tier))?.label)
                        .filter(Boolean)
                };
            });
    }

    function saveMarketAlerts(alerts) {
        localStorage.setItem(STORAGE_MARKET_ALERTS, JSON.stringify(alerts.slice(-50)));
    }

    let marketAlertSeenCacheText = null;
    let marketAlertSeenCache = null;
    function getMarketAlertSeenKeys() {
        const stored = localStorage.getItem(STORAGE_MARKET_ALERTS_SEEN) || '[]';
        if (!marketAlertSeenCache || stored !== marketAlertSeenCacheText) {
            let parsed = [];
            try { parsed = JSON.parse(stored); } catch {}
            marketAlertSeenCache = new Set((Array.isArray(parsed) ? parsed : []).filter(Boolean));
            marketAlertSeenCacheText = stored;
        }
        return marketAlertSeenCache;
    }

    function saveMarketAlertSeenKeys(keys) {
        const values = [...keys].slice(-2000);
        const stored = JSON.stringify(values);
        marketAlertSeenCache = new Set(values);
        marketAlertSeenCacheText = stored;
        localStorage.setItem(STORAGE_MARKET_ALERTS_SEEN, stored);
    }

    function getMarketAlertInbox() {
        return readStoredJSON(STORAGE_MARKET_ALERT_INBOX, []).filter(entry => entry?.key && entry?.listing);
    }

    function saveMarketAlertInbox(entries) {
        localStorage.setItem(STORAGE_MARKET_ALERT_INBOX, JSON.stringify(entries.slice(-200)));
        updateMarketAlertBadges();
    }

    function marketAlertInboxKey(entry) {
        const listingId = getMarketListingId(entry);
        return listingId == null || listingId === '' ? '' : `pokemon:${listingId}`;
    }

    function addMarketAlertInboxEntry(alert, entry, account = null) {
        const key = marketAlertInboxKey(entry);
        if (!key) return;
        const inbox = getMarketAlertInbox().filter(item => item.key !== key);
        inbox.push({ key, alertId:alert.id, receivedAt:Date.now(), account, listing:JSON.parse(JSON.stringify(entry)) });
        saveMarketAlertInbox(inbox);
    }

    function removeMarketAlertInboxEntry(entry) {
        const key = typeof entry === 'string' ? entry : marketAlertInboxKey(entry);
        if (!key) return;
        saveMarketAlertInbox(getMarketAlertInbox().filter(item => item.key !== key));
    }

    function getAvailableMarketAlertInbox(liveListings) {
        const liveByKey = new Map((Array.isArray(liveListings) ? liveListings : [])
            .filter(entry => getMarketEntryKind(entry) === 'pokemon')
            .map(entry => [marketAlertInboxKey(entry), entry])
            .filter(([key]) => Boolean(key)));
        return getMarketAlertInbox().flatMap(record => {
            const listing = liveByKey.get(record.key);
            return listing ? [{ ...listing, _scriptAlertInboxKey:record.key, _scriptAlertKind:'pokemon', _scriptAlertAccount:record.account }] : [];
        });
    }

    function syncMarketAlertInbox(liveListings) {
        const liveKeys = new Set((Array.isArray(liveListings) ? liveListings : [])
            .filter(isMarketPokemonListing)
            .map(marketAlertInboxKey).filter(Boolean));
        const inbox = getMarketAlertInbox();
        const available = inbox.filter(record => liveKeys.has(record.key));
        if (available.length !== inbox.length) saveMarketAlertInbox(available);
        else updateMarketAlertBadges();
        return available;
    }

    function isMarketAlertAutoBuyEnabled() {
        return localStorage.getItem(STORAGE_MARKET_ALERT_AUTO_BUY) === 'true';
    }

    function getMarketItemAlerts() {
        if (MARKET_ALERTS_REMOVED) return [];
        return readStoredJSON(STORAGE_MARKET_ITEM_ALERTS, []).filter(alert => alert?.id);
    }

    function saveMarketItemAlerts(alerts) {
        localStorage.setItem(STORAGE_MARKET_ITEM_ALERTS, JSON.stringify(alerts.slice(-50)));
    }

    let marketItemAlertSeenCacheText = null;
    let marketItemAlertSeenCache = null;
    function getMarketItemAlertSeenKeys() {
        const stored = localStorage.getItem(STORAGE_MARKET_ITEM_ALERTS_SEEN) || '[]';
        if (!marketItemAlertSeenCache || stored !== marketItemAlertSeenCacheText) {
            let parsed = [];
            try { parsed = JSON.parse(stored); } catch {}
            marketItemAlertSeenCache = new Set((Array.isArray(parsed) ? parsed : []).filter(Boolean));
            marketItemAlertSeenCacheText = stored;
        }
        return marketItemAlertSeenCache;
    }

    function saveMarketItemAlertSeenKeys(keys) {
        const values = [...keys].slice(-2000);
        const stored = JSON.stringify(values);
        marketItemAlertSeenCache = new Set(values);
        marketItemAlertSeenCacheText = stored;
        localStorage.setItem(STORAGE_MARKET_ITEM_ALERTS_SEEN, stored);
    }

    function getMarketItemAlertInbox() {
        return readStoredJSON(STORAGE_MARKET_ITEM_ALERT_INBOX, []).filter(entry => entry?.key && entry?.listing);
    }

    function saveMarketItemAlertInbox(entries) {
        localStorage.setItem(STORAGE_MARKET_ITEM_ALERT_INBOX, JSON.stringify(entries.slice(-200)));
        updateMarketAlertBadges();
    }

    function marketItemAlertInboxKey(entry) {
        const listingId = getMarketListingId(entry);
        return listingId == null || listingId === '' ? '' : `item:${listingId}`;
    }

    function addMarketItemAlertInboxEntry(alert, entry, account = null) {
        const key = marketItemAlertInboxKey(entry);
        if (!key) return;
        const inbox = getMarketItemAlertInbox().filter(item => item.key !== key);
        inbox.push({ key, alertId:alert.id, receivedAt:Date.now(), account, listing:JSON.parse(JSON.stringify(entry)) });
        saveMarketItemAlertInbox(inbox);
    }

    function removeMarketItemAlertInboxEntry(entry) {
        const key = typeof entry === 'string' ? entry : marketItemAlertInboxKey(entry);
        if (key) saveMarketItemAlertInbox(getMarketItemAlertInbox().filter(item => item.key !== key));
    }

    function getAvailableMarketItemAlertInbox(liveListings) {
        const liveByKey = new Map((Array.isArray(liveListings) ? liveListings : [])
            .filter(entry => !isMarketPokemonListing(entry))
            .flatMap(entry => getMarketListingIds(entry).map(id => [`item:${id}`, { ...entry, _scriptMarketListingId:id }])));
        return getMarketItemAlertInbox().flatMap(record => {
            const listing = liveByKey.get(record.key);
            return listing ? [{ ...listing, _scriptAlertInboxKey:record.key, _scriptAlertKind:'item', _scriptAlertAccount:record.account }] : [];
        });
    }

    function syncMarketItemAlertInbox(liveListings) {
        const liveKeys = new Set((Array.isArray(liveListings) ? liveListings : [])
            .filter(entry => !isMarketPokemonListing(entry))
            .flatMap(entry => getMarketListingIds(entry).map(id => `item:${id}`)));
        const inbox = getMarketItemAlertInbox();
        const available = inbox.filter(record => liveKeys.has(record.key));
        if (available.length !== inbox.length) saveMarketItemAlertInbox(available);
        else updateMarketAlertBadges();
        return available;
    }

    function isMarketItemAlertAutoBuyEnabled() {
        return localStorage.getItem(STORAGE_MARKET_ITEM_ALERT_AUTO_BUY) === 'true';
    }

    function getMarketItemAlertAutoBuyStatus() {
        return readStoredJSON(STORAGE_MARKET_ITEM_ALERT_AUTO_STATUS, null);
    }

    function setMarketItemAlertAutoBuyStatus(state, message = '') {
        const status = { state, message:String(message || ''), at:Date.now() };
        localStorage.setItem(STORAGE_MARKET_ITEM_ALERT_AUTO_STATUS, JSON.stringify(status));
        document.querySelectorAll('.market-item-auto-status').forEach(element => {
            const time = new Date(status.at).toLocaleTimeString(getGameLanguage() === 'es' ? 'es-VE' : 'en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
            element.textContent = `Auto objetos: ${state}${status.message ? ` · ${status.message}` : ''} · ${time}`;
            element.dataset.state = state;
        });
        return status;
    }

    function getMarketTelegramSettings() {
        try {
            const settings = JSON.parse(localStorage.getItem(STORAGE_MARKET_TELEGRAM) || '{}');
            return {
                enabled:Boolean(settings?.enabled),
                token:String(settings?.token || '').trim(),
                chatId:String(settings?.chatId || '').trim()
            };
        } catch {
            return { enabled:false, token:'', chatId:'' };
        }
    }

    function saveMarketTelegramSettings(settings) {
        localStorage.setItem(STORAGE_MARKET_TELEGRAM, JSON.stringify({
            enabled:Boolean(settings?.enabled), token:String(settings?.token || '').trim(), chatId:String(settings?.chatId || '').trim()
        }));
    }

    function isTelegramConfigured() {
        const settings = getMarketTelegramSettings();
        return settings.enabled && settings.token && settings.chatId;
    }

    function getMarketTelegramDeliveredKeys() {
        return new Set(readStoredJSON(STORAGE_MARKET_TELEGRAM_DELIVERED, []).filter(Boolean));
    }

    function markMarketTelegramDelivered(key) {
        const delivered = getMarketTelegramDeliveredKeys();
        delivered.add(key);
        localStorage.setItem(STORAGE_MARKET_TELEGRAM_DELIVERED, JSON.stringify([...delivered].slice(-1000)));
    }

    async function telegramApiRequest(method, payload = {}) {
        const settings = getMarketTelegramSettings();
        if (!settings.enabled || !settings.token || !settings.chatId) throw new Error('Telegram no está configurado.');
        const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(settings.token)}/${method}`, {
            method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${response.status}`);
        return data.result;
    }

    function getMarketListingSeller(entry) {
        const ref = entry?.pokemon || entry?.listing || {};
        const candidates = [
            entry?.sellerName, entry?.seller?.name, entry?.seller?.username, entry?.seller,
            entry?.ownerName, entry?.owner?.name, entry?.owner, entry?.user?.name, entry?.user?.username,
            entry?.character?.name, ref?.sellerName, ref?.seller?.name
        ];
        return candidates.map(value => typeof value === 'string' ? value.trim() : '')
            .find(Boolean) || '—';
    }

    async function getCurrentMarketAlertAccount() {
        try {
            const payload = await gameApiRequest('/api/characters/me');
            const character = payload?.character || payload || {};
            return {
                name:String(character.name || character.username || character.playerName || '').trim() || '—',
                gold:Math.max(0, Number(character.gold || 0)),
                diamonds:Math.max(0, Number(character.diamonds || 0))
            };
        } catch {
            return { name:'—', gold:0, diamonds:0 };
        }
    }

    async function getCurrentMarketAlertPlayerName() {
        return (await getCurrentMarketAlertAccount()).name;
    }

    function formatMarketAlertAccount(account) {
        const data = account || {};
        const alertLocale = getGameLanguage() === 'pt' ? 'pt-BR' : getGameLanguage() === 'es' ? 'es-VE' : 'en-US';
        return `👤 ${data.name || '—'} · 💲 ${Math.max(0, Number(data.gold || 0)).toLocaleString(alertLocale)} · 💎 ${Math.max(0, Number(data.diamonds || 0)).toLocaleString(alertLocale)}`;
    }

    function getTelegramPokemonCaption(entry, title, account = null, detail = '') {
        const ref = entry?.pokemon || {};
        const name = entry?.name || entry?.pokemonName || ref.name || '—';
        const price = getMarketEntryPrice(entry);
        const currency = getMarketEntryCurrency(entry);
        const icon = currency === 'DIAMONDS' ? '💎' : '💲';
        const quality = Number(entry?.quality ?? ref.quality);
        const tier = getMarketPokemonQualityTheme(quality)?.label || '—';
        const iv = entry?.ivTotal ?? ref.ivTotal ?? entry?.iv ?? ref.iv ?? '—';
        const level = entry?.level ?? ref.level ?? '—';
        const power = entry?.power ?? ref.power;
        const seller = getMarketListingSeller(entry);
        const shiny = Boolean(entry?.shiny ?? ref.shiny);
        const types = [entry?.type1 ?? ref.type1, entry?.type2 ?? ref.type2].filter(Boolean).join(' · ') || '—';
        const telegramLocale = getGameLanguage() === 'pt' ? 'pt-BR' : getGameLanguage() === 'es' ? 'es-VE' : 'en-US';
        return `<b>${escapeHTML(title)}</b>\n<b>${shiny ? '✨ ' : ''}${escapeHTML(name)}</b>\n${icon} <b>${Number(price || 0).toLocaleString(telegramLocale, { maximumFractionDigits:2 })}</b>\n⭐ Tier: ${escapeHTML(tier)} · Q: ${Number.isFinite(quality) ? quality.toFixed(2) : '—'}\n🧬 IV: ${escapeHTML(iv)}/192 · Lv. ${escapeHTML(level)}${power != null ? ` · Poder: ${escapeHTML(power)}` : ''}\n🏷️ ${escapeHTML(types)}\n👤 Vendedor: ${escapeHTML(seller)}${detail ? `\n<b>Motivo:</b> ${escapeHTML(detail)}` : ''}\n<b>Cuenta compradora:</b> ${escapeHTML(formatMarketAlertAccount(account))}`;
    }

    function getPokeApiSpriteUrl(entry) {
        const ref = entry?.pokemon || {};
        const speciesId = Number(entry?.speciesId ?? entry?.pokemonId ?? ref.speciesId ?? ref.pokemonId ?? ref.id);
        if (Number.isInteger(speciesId) && speciesId > 0) {
            const shiny = Boolean(entry?.shiny ?? ref.shiny);
            return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shiny ? 'shiny/' : ''}${speciesId}.png`;
        }
        return getMarketEntryImage(entry);
    }

    function getTelegramItemCaption(entry, title, account = null, detail = '') {
        const ref = entry?.item || entry?.product || {};
        const name = entry?.name || entry?.title || entry?.itemName || ref.name || ref.title || '—';
        const price = getMarketEntryPrice(entry);
        const currency = getMarketEntryCurrency(entry);
        const icon = currency === 'DIAMONDS' ? '💎' : '💲';
        const quantity = Math.max(1, Number(entry.quantity ?? entry.qty ?? entry.amount ?? 1) || 1);
        const seller = getMarketListingSeller(entry);
        const telegramLocale = getGameLanguage() === 'pt' ? 'pt-BR' : getGameLanguage() === 'es' ? 'es-VE' : 'en-US';
        return `<b>${escapeHTML(title)}</b>\n<b>📦 ${escapeHTML(name)}</b>\n${icon} <b>${Number(price || 0).toLocaleString(telegramLocale, { maximumFractionDigits:2 })}</b> · ${quantity.toLocaleString(telegramLocale)}× disponible\n👤 Vendedor: ${escapeHTML(seller)}${detail ? `\n<b>Motivo:</b> ${escapeHTML(detail)}` : ''}\n<b>Cuenta compradora:</b> ${escapeHTML(formatMarketAlertAccount(account))}`;
    }

    async function sendMarketAlertToTelegram(entry, { automatic = false, title = '', account = null, kind = '', detail = '' } = {}) {
        if (!isTelegramConfigured()) return;
        const settings = getMarketTelegramSettings();
        const isItem = kind === 'item' || !isMarketPokemonListing(entry);
        const caption = isItem
            ? getTelegramItemCaption(entry, title || (automatic ? 'Objeto comprado' : 'Nuevo objeto en alerta'), account, detail)
            : getTelegramPokemonCaption(entry, title || (automatic ? tr('alertAutoBought') : tr('alertNewListing')), account, detail);
        const listingId = getMarketListingId(entry);
        const replyMarkup = automatic ? undefined : {
            inline_keyboard:[[{ text:`🛒 ${tr('telegramBuy')}`, callback_data:`mbuy:${isItem ? 'item' : 'pokemon'}:${String(listingId)}` }]]
        };
        const image = isItem ? getMarketEntryImage(entry) : getPokeApiSpriteUrl(entry);
        const payload = { chat_id:settings.chatId, caption, parse_mode:'HTML', reply_markup:replyMarkup };
        try {
            if (image) {
                await telegramApiRequest('sendPhoto', { ...payload, photo:new URL(image, location.origin).href });
                return;
            }
        } catch (error) {
            console.warn('Telegram: no se pudo enviar el sprite; se enviará el aviso sin imagen.', error);
        }
        await telegramApiRequest('sendMessage', { chat_id:settings.chatId, text:caption, parse_mode:'HTML', reply_markup:replyMarkup });
    }

    async function sendMarketAlertToTelegramOnce(entry, eventType, options = {}) {
        const listingKey = options.kind === 'item' || !isMarketPokemonListing(entry) ? marketItemAlertInboxKey(entry) : marketAlertInboxKey(entry);
        const deliveryKey = `${eventType}:${listingKey}`;
        if (!isTelegramConfigured() || !listingKey || marketTelegramDeliveryBusy.has(deliveryKey) || getMarketTelegramDeliveredKeys().has(deliveryKey)) return false;
        marketTelegramDeliveryBusy.add(deliveryKey);
        try {
            await sendMarketAlertToTelegram(entry, options);
            markMarketTelegramDelivered(deliveryKey);
            return true;
        } finally {
            marketTelegramDeliveryBusy.delete(deliveryKey);
        }
    }

    async function pollMarketTelegramCallbacks() {
        if (MARKET_ALERTS_REMOVED) return;
        if (!isTelegramConfigured() || document.hidden) return;
        try {
            const offset = Math.max(0, Number(localStorage.getItem(STORAGE_MARKET_TELEGRAM_OFFSET)) || 0);
            const updates = await telegramApiRequest('getUpdates', { offset, timeout:0, allowed_updates:['callback_query'] });
            let nextOffset = offset;
            for (const update of updates || []) {
                nextOffset = Math.max(nextOffset, Number(update.update_id || 0) + 1);
                const query = update.callback_query;
                if (!query?.data?.startsWith('mbuy:')) continue;
                const settings = getMarketTelegramSettings();
                if (String(query.message?.chat?.id || '') !== settings.chatId) {
                    await telegramApiRequest('answerCallbackQuery', { callback_query_id:query.id, text:'Chat no autorizado.', show_alert:true });
                    continue;
                }
                const callbackParts = query.data.split(':');
                const kind = callbackParts.length >= 3 ? callbackParts[1] : 'pokemon';
                const listingId = callbackParts.length >= 3 ? callbackParts.slice(2).join(':') : query.data.slice(5);
                try {
                    const payload = await gameApiRequest(`/api/game/market?category=${kind === 'item' ? 'All' : 'Pokemon'}`);
                    const listing = getMarketListings(payload).find(entry => String(getMarketListingId(entry)) === listingId);
                    const inboxRecord = kind === 'item'
                        ? getMarketItemAlertInbox().find(record => record.key === `item:${listingId}`)
                        : getMarketAlertInbox().find(record => record.key === `pokemon:${listingId}`);
                    if (!listing || !inboxRecord) throw new Error(tr('telegramUnavailable'));
                    if (kind === 'item') await buyMarketItemAlert(listing); else await buyMarketAlertPokemon(listing);
                    await telegramApiRequest('answerCallbackQuery', { callback_query_id:query.id, text:tr('telegramBought') });
                    await sendMarketAlertToTelegramOnce(listing, `${kind}-telegram-bought`, { automatic:true, title:kind === 'item' ? 'Objeto comprado' : tr('telegramBought'), kind, account:inboxRecord.account });
                    await telegramApiRequest('editMessageReplyMarkup', { chat_id:settings.chatId, message_id:query.message?.message_id, reply_markup:{ inline_keyboard:[] } }).catch(() => null);
                } catch (error) {
                    await telegramApiRequest('answerCallbackQuery', { callback_query_id:query.id, text:error.message || tr('telegramUnavailable'), show_alert:true });
                }
            }
            if (nextOffset > offset) localStorage.setItem(STORAGE_MARKET_TELEGRAM_OFFSET, String(nextOffset));
        } catch (error) {
            console.debug('Telegram: consulta de botones aplazada.', error?.message || error);
        }
    }

    function updateMarketAlertBadges() {
        if (MARKET_ALERTS_REMOVED) {
            document.querySelectorAll('.market-alert-dock-badge,.market-alert-toast').forEach(element => element.remove());
            return;
        }
        const count = getMarketAlertInbox().length + getMarketItemAlertInbox().length;
        const dockButton = document.getElementById('dock-btn-shops');
        if (dockButton) {
            let badge = dockButton.querySelector('.market-alert-dock-badge');
            if (!count) badge?.remove();
            else {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'market-alert-dock-badge';
                    dockButton.appendChild(badge);
                }
                badge.textContent = count > 99 ? '99+' : String(count);
                badge.title = `${count} ${tr('marketAlerts')}`;
            }
        }
        document.querySelectorAll('.script-market-window .market-alert-tab-count').forEach(badge => {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.hidden = !count;
        });
    }

    function marketAlertListingKey(alert, entry) {
        const listingId = getMarketListingId(entry);
        return listingId == null || listingId === '' ? '' : `${alert.id}:${listingId}`;
    }

    function marketAlertMatchesListing(alert, entry) {
        if (!alert || !isMarketPokemonListing(entry)) return false;
        if (entry?.offerOnly || entry?.isOffer || entry?.buyNow === false) return false;
        const ref = entry?.pokemon || {};
        const name = String(entry?.name || entry?.pokemonName || ref.name || '').trim().toLocaleLowerCase();
        const expectedName = String(alert.name || '').trim().toLocaleLowerCase();
        if (expectedName && !name.includes(expectedName)) return false;
        const currency = String(alert.currency || 'ALL').toUpperCase();
        if (currency !== 'ALL' && getMarketEntryCurrency(entry) !== currency) return false;
        const price = getMarketEntryPrice(entry);
        if (alert.priceMin !== '' && price < Number(alert.priceMin)) return false;
        if (alert.priceMax !== '' && price > Number(alert.priceMax)) return false;
        const iv = Number(entry?.ivTotal ?? ref.ivTotal ?? entry?.iv ?? ref.iv ?? -1);
        const level = Number(entry?.level ?? ref.level ?? -1);
        const quality = getMarketPokemonQualityValue(entry);
        if (alert.shiny && !(entry?.shiny ?? ref.shiny)) return false;
        if (alert.ivMin !== '' && iv < Number(alert.ivMin)) return false;
        if (alert.ivMax !== '' && iv > Number(alert.ivMax)) return false;
        if (alert.levelMin !== '' && level < Number(alert.levelMin)) return false;
        if (alert.levelMax !== '' && level > Number(alert.levelMax)) return false;
        // El tier permitido se determina exclusivamente por quality y la tabla
        // oficial. Los campos qualityMin/qualityMax de alertas antiguas se
        // ignoran para evitar que contradigan la selección de tiers.
        const qualityTier = getMarketQualityTierDefinition(quality);
        const allowedTierIds = getMarketAlertTierIds(alert);
        if (allowedTierIds.length && (!qualityTier || !allowedTierIds.includes(qualityTier.id))) return false;
        if (alert.type && entry?.type1 !== alert.type && entry?.type2 !== alert.type && ref.type1 !== alert.type && ref.type2 !== alert.type) return false;
        return true;
    }

    function marketItemAlertMatchesListing(alert, entry) {
        if (!alert || isMarketPokemonListing(entry)) return false;
        if (entry?.offerOnly || entry?.isOffer || entry?.buyNow === false) return false;
        const ref = entry?.item || entry?.product || {};
        const name = String(entry?.name || entry?.title || entry?.itemName || ref.name || ref.title || '').trim().toLocaleLowerCase();
        const expectedName = String(alert.name || '').trim().toLocaleLowerCase();
        if (expectedName && !name.includes(expectedName)) return false;
        const currency = String(alert.currency || 'ALL').toUpperCase();
        if (currency !== 'ALL' && getMarketEntryCurrency(entry) !== currency) return false;
        const price = getMarketEntryPrice(entry);
        if (alert.priceMin !== '' && price < Number(alert.priceMin)) return false;
        if (alert.priceMax !== '' && price > Number(alert.priceMax)) return false;
        const quantity = Math.max(1, Number(entry.quantity ?? entry.qty ?? entry.amount ?? 1) || 1);
        return alert.quantityMin === '' || quantity >= Number(alert.quantityMin);
    }

    function queueMarketAlertToast({ alert, entry, title = tr('alertNewListing') }) {
        marketAlertToastQueue.push({ alert, entry, title });
        if (marketAlertToastBusy) return;
        const showNext = () => {
            const match = marketAlertToastQueue.shift();
            if (!match) {
                marketAlertToastBusy = false;
                return;
            }
            marketAlertToastBusy = true;
            const ref = match.entry?.pokemon || match.entry?.item || match.entry?.product || {};
            const name = match.entry?.name || match.entry?.pokemonName || match.entry?.itemName || ref.name || '—';
            const seller = getMarketListingSeller(match.entry);
            const price = Math.max(0, Number(getMarketEntryPrice(match.entry)) || 0);
            const currency = getMarketEntryCurrency(match.entry);
            const icon = currency === 'DIAMONDS' ? '💎' : '💲';
            const alertLocale = getGameLanguage() === 'pt' ? 'pt-BR' : getGameLanguage() === 'es' ? 'es-VE' : 'en-US';
            const toast = document.createElement('div');
            toast.className = 'market-alert-toast';
            toast.innerHTML = `<span>◆</span><b>${escapeHTML(match.title)}</b><small>${escapeHTML(name)} · ${icon} ${price.toLocaleString(alertLocale, { maximumFractionDigits:0 })} · 👤 ${escapeHTML(seller)}<br>${escapeHTML(formatMarketAlertAccount(match.account))}</small>`;
            document.body.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('show'));
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => { toast.remove(); showNext(); }, 180);
            }, 4200);
        };
        showNext();
    }

    function ensureMarketPurchaseSucceeded(result) {
        const payload = result?.data && typeof result.data === 'object' ? result.data : result;
        if (payload?.success === false || payload?.ok === false || payload?.error || result?.success === false || result?.ok === false || result?.error) {
            throw new Error(payload?.message || payload?.error || result?.message || result?.error || 'El servidor no confirmó la compra.');
        }
        return result;
    }

    async function executeImmediateMarketPurchase(action, listing = null) {
        const startedAt = performance.now();
        const detectedAt = Number(listing?._scriptMarketDetectedAt);
        const dispatchDelayMs = Number.isFinite(detectedAt) ? Math.max(0, Math.round(startedAt - detectedAt)) : null;
        try {
            const result = await gameApiRequest('/api/game/market/action', {
                method:'POST', body:JSON.stringify(action), priority:'high'
            });
            return ensureMarketPurchaseSucceeded(result);
        } catch (error) {
            error.purchaseLatencyMs = Math.max(0, Math.round(performance.now() - startedAt));
            error.purchaseDispatchDelayMs = dispatchDelayMs;
            error.marketSource = listing?._scriptMarketSource || 'HTTP';
            error.marketReadLatencyMs = Number.isFinite(listing?._scriptMarketReadLatencyMs)
                ? Math.max(0, Math.round(listing._scriptMarketReadLatencyMs)) : null;
            error.marketReadCadenceMs = Number.isFinite(listing?._scriptMarketReadCadenceMs)
                ? Math.max(0, Math.round(listing._scriptMarketReadCadenceMs)) : null;
            throw error;
        }
    }

    async function buyMarketAlertPokemon(entry) {
        const price = getMarketEntryPrice(entry);
        if (!(price > 0)) throw new Error('El anuncio no tiene un precio de compra válido.');
        const listingId = getMarketListingId(entry);
        if (listingId == null || listingId === '') throw new Error('El anuncio del Pokémon no tiene un identificador válido.');
        await executeImmediateMarketPurchase({ action:'buy', id:listingId, quantity:1 }, entry);
        removeMarketAlertInboxEntry(entry);
        setMarketFeaturedPokemon(entry, false);
    }

    async function buyMarketItemAlert(entry, quantity = 1) {
        const listingId = getMarketListingId(entry);
        if (listingId == null) throw new Error('El anuncio del objeto no tiene un identificador válido.');
        // Este anuncio procede de la lectura sin caché del mismo ciclo. Comprar con
        // ese snapshot evita una segunda petición GET que daba ventaja a otros usuarios.
        const price = getMarketEntryPrice(entry);
        const currency = getMarketEntryCurrency(entry);
        if (!(price > 0)) throw new Error('El anuncio no tiene un precio de compra válido.');
        const available = Math.max(1, Number(entry.quantity ?? entry.qty ?? entry.amount ?? 1) || 1);
        const buyQuantity = Math.max(1, Math.min(available, Number(quantity) || 1));
        // El servidor valida el saldo en la misma operación de compra. Evitamos una
        // consulta previa de personaje para no añadir otra vuelta de red crítica.
        const kind = entry?.kind ?? getMarketEntryKind(entry);
        const refId = entry?.refId ?? getMarketEntryRefId(entry);
        if (!kind || refId == null) throw new Error('El anuncio del objeto no contiene los datos necesarios para comprarlo.');
        const purchaseIds = [listingId, ...getMarketListingIds(entry).filter(id => String(id) !== String(listingId))];
        await executeImmediateMarketPurchase({
            action:'buy-stack', kind, refId, price:entry?.price ?? price,
            currency:entry?.currency ?? currency, quantity:buyQuantity,
            ids:purchaseIds.slice(0, buyQuantity)
        }, entry);
        removeMarketItemAlertInboxEntry(entry);
        return entry;
    }

    function seedMarketAlertFromListings(alert, listings) {
        const seen = getMarketAlertSeenKeys();
        (Array.isArray(listings) ? listings : []).filter(entry => marketAlertMatchesListing(alert, entry)).forEach(entry => {
            const key = marketAlertListingKey(alert, entry);
            if (key) seen.add(key);
        });
        saveMarketAlertSeenKeys(seen);
    }

    function marketItemAlertListingKey(alert, entry) {
        const listingId = getMarketListingId(entry);
        return listingId == null || listingId === '' ? '' : `${alert.id}:${listingId}`;
    }

    function seedMarketItemAlertFromListings(alert, listings) {
        const seen = getMarketItemAlertSeenKeys();
        (Array.isArray(listings) ? listings : []).filter(entry => marketItemAlertMatchesListing(alert, entry)).forEach(entry => {
            getMarketListingIds(entry).forEach(id => seen.add(`${alert.id}:${id}`));
        });
        saveMarketItemAlertSeenKeys(seen);
    }

    async function pollUnifiedMarketAlerts(forceNetworkRead = false) {
        if (MARKET_ALERTS_REMOVED) return;
        if (Date.now() < marketAlertBackoffUntil) return;
        if (marketUnifiedMonitorBusy) {
            // Un anuncio puede llegar por socket mientras el GET anterior está
            // en vuelo. Conservamos esa señal y repetimos al terminar.
            if (forceNetworkRead) marketUnifiedPollPending = true;
            return;
        }
        const hasPokemonAlerts = getMarketAlerts().length > 0;
        const hasItemAlerts = getMarketItemAlerts().length > 0;
        if (!hasPokemonAlerts && !hasItemAlerts) return;
        marketUnifiedMonitorBusy = true;
        try {
            // Cada monitor consulta directamente la categoría oficial que le
            // corresponde. Evitamos descargar y procesar el mercado completo
            // antes de poder iniciar una compra urgente.
            const scans = [];
            if (hasPokemonAlerts && hasItemAlerts) {
                if (marketAlertPollPokemonFirst) {
                    scans.push(pollMarketAlerts(null, forceNetworkRead), pollMarketItemAlerts(null, forceNetworkRead));
                } else {
                    scans.push(pollMarketItemAlerts(null, forceNetworkRead), pollMarketAlerts(null, forceNetworkRead));
                }
                marketAlertPollPokemonFirst = !marketAlertPollPokemonFirst;
            } else if (hasPokemonAlerts) scans.push(pollMarketAlerts(null, forceNetworkRead));
            else if (hasItemAlerts) scans.push(pollMarketItemAlerts(null, forceNetworkRead));
            // No esperamos aquí cada GET: el endpoint oficial puede tardar más
            // de dos segundos. El ciclo de 250 ms mantiene una tubería rodante
            // y el contador compartido limita la concurrencia total.
            scans.forEach(scan => void scan.catch(error => console.debug('Lectura paralela del mercado aplazada.', error?.message || error)));
        } catch (error) {
            console.warn('Monitor unificado del mercado: lectura aplazada.', error?.message || error);
            if (Number(error?.status) === 429) {
                marketAlertBackoffUntil = Date.now() + 1500;
            }
        } finally {
            marketUnifiedMonitorBusy = false;
            if (marketUnifiedPollPending) {
                marketUnifiedPollPending = false;
                queueMicrotask(() => void pollUnifiedMarketAlerts(true));
            }
        }
    }

    async function pollMarketAlerts(listings, forceNetworkRead = false) {
        if (MARKET_ALERTS_REMOVED) return;
        const alerts = getMarketAlerts();
        if (!alerts.length) return;
        const hasDirectListings = Array.isArray(listings) && listings.some(isMarketPokemonListing);
        if (!hasDirectListings && marketAlertHttpReadsInFlight >= MAX_MARKET_ALERT_HTTP_READS) return;
        const ownsHttpSlot = !hasDirectListings;
        if (ownsHttpSlot) marketAlertHttpReadsInFlight++;
        try {
            const marketReadStartedAt = performance.now();
            const marketListings = hasDirectListings
                ? listings
                : getMarketListings(await gameApiRequest('/api/game/market?category=Pokemon', { priority:'high' }));
            const httpDetectedAt = hasDirectListings ? null : performance.now();
            const marketReadLatencyMs = hasDirectListings ? null : httpDetectedAt - marketReadStartedAt;
            const marketReadCadenceMs = hasDirectListings || !lastPokemonMarketReadCompletedAt ? null : httpDetectedAt - lastPokemonMarketReadCompletedAt;
            if (!hasDirectListings) lastPokemonMarketReadCompletedAt = httpDetectedAt;
            const pokemonListings = marketListings.filter(isMarketPokemonListing);
            const seen = getMarketAlertSeenKeys();
            const autoBuyEnabled = isMarketAlertAutoBuyEnabled();
            const purchaseTasks = [];
            const launchAutoBuy = match => {
                if (!autoBuyEnabled) return;
                purchaseTasks.push((async () => {
                    try {
                        await buyMarketAlertPokemon(match.entry);
                        void getCurrentMarketAlertAccount().then(account => {
                            queueMarketAlertToast({ ...match, account, title:tr('alertAutoBought') });
                            return sendMarketAlertToTelegramOnce(match.entry, 'auto-bought', { automatic:true, account });
                        }).catch(error => console.debug('Telegram: aviso automático no enviado.', error?.message || error));
                    } catch (error) {
                        console.warn('Compra automática de Pokémon no completada; se conserva la alerta manual.', error?.message || error);
                        const failureDetail = `${String(error?.message || error || 'Sin detalle')} · ${error?.marketSource || 'HTTP'}${Number.isFinite(error?.marketReadLatencyMs) ? ` GET ${error.marketReadLatencyMs} ms` : ''}${Number.isFinite(error?.marketReadCadenceMs) ? ` · ritmo ${error.marketReadCadenceMs} ms` : ''}${Number.isFinite(error?.purchaseDispatchDelayMs) ? ` · despacho ${error.purchaseDispatchDelayMs} ms` : ''}${Number.isFinite(error?.purchaseLatencyMs) ? ` · POST ${error.purchaseLatencyMs} ms` : ''}`.slice(0, 210);
                        void getCurrentMarketAlertAccount().then(account => {
                            addMarketAlertInboxEntry(match.alert, match.entry, account);
                            queueMarketAlertToast({ ...match, account, title:'Compra automática de Pokémon fallida' });
                            return sendMarketAlertToTelegramOnce(match.entry, 'auto-buy-failed', { account, title:'Compra automática no completada', detail:failureDetail });
                        }).catch(telegramError => console.debug('Telegram: alerta de compra fallida no enviada.', telegramError?.message || telegramError));
                    }
                })());
            };
            const freshKeys = [];
            const freshByListing = new Map();
            for (const alert of alerts) {
                for (const entry of pokemonListings) {
                    if (!marketAlertMatchesListing(alert, entry)) continue;
                    const key = marketAlertListingKey(alert, entry);
                    if (!key || seen.has(key)) continue;
                    freshKeys.push(key);
                    const detectedEntry = httpDetectedAt == null ? entry : {
                        ...entry, _scriptMarketSource:'HTTP', _scriptMarketDetectedAt:httpDetectedAt,
                        _scriptMarketReadLatencyMs:marketReadLatencyMs,
                        _scriptMarketReadCadenceMs:marketReadCadenceMs
                    };
                    const listingKey = marketAlertInboxKey(detectedEntry);
                    if (listingKey && !freshByListing.has(listingKey)) {
                        const match = { alert, entry:detectedEntry, key };
                        freshByListing.set(listingKey, match);
                        launchAutoBuy(match);
                    }
                }
            }
            // Las reglas ya se inicializan con seedMarketAlertFromListings al
            // crearlas. No descartamos el primer resultado después de recargar:
            // podría ser un anuncio nuevo publicado antes del primer tick.
            marketAlertMonitorReady = true;
            const freshListings = [...freshByListing.values()];
            const persistSeenMatches = () => {
                freshKeys.forEach(key => seen.add(key));
                if (freshKeys.length) saveMarketAlertSeenKeys(seen);
            };
            if (autoBuyEnabled) {
                // Los fetch de compra ya están iniciados cuando persistimos.
                if (freshListings.length) console.info(`[Better Market] ${freshListings.length} Pokémon nuevo(s) detectado(s); compra automática activa.`);
                persistSeenMatches();
                syncMarketAlertInbox(pokemonListings);
                await Promise.allSettled(purchaseTasks);
            } else {
                if (freshListings.length) console.info(`[Better Market] ${freshListings.length} Pokémon nuevo(s) detectado(s); compra automática desactivada.`);
                persistSeenMatches();
                syncMarketAlertInbox(pokemonListings);
                const accountPromise = freshListings.length ? getCurrentMarketAlertAccount() : Promise.resolve(null);
                freshListings.slice().reverse().forEach(match => {
                    void accountPromise.then(account => {
                        addMarketAlertInboxEntry(match.alert, match.entry, account);
                        queueMarketAlertToast({ ...match, account });
                        void sendMarketAlertToTelegramOnce(match.entry, 'published', { account }).catch(error => console.debug('Telegram: alerta no enviada.', error?.message || error));
                    });
                });
            }
        } catch (error) {
            console.warn('Monitor de alertas de Pokémon: lectura aplazada.', error?.message || error);
            if (Number(error?.status) === 429) marketAlertBackoffUntil = Date.now() + 1500;
        } finally {
            if (ownsHttpSlot) marketAlertHttpReadsInFlight = Math.max(0, marketAlertHttpReadsInFlight - 1);
        }
    }

    async function pollMarketItemAlerts(listings, forceNetworkRead = false) {
        if (MARKET_ALERTS_REMOVED) return;
        const alerts = getMarketItemAlerts();
        // En launchers con varias cuentas, las vistas no enfocadas pueden marcarse
        // como ocultas aunque sigan activas. Las alertas de objetos deben vigilarse
        // igualmente para que la compra automática no dependa del foco.
        if (!alerts.length) return;
        const hasDirectListings = Array.isArray(listings) && listings.some(entry => !isMarketPokemonListing(entry));
        if (!hasDirectListings && marketAlertHttpReadsInFlight >= MAX_MARKET_ALERT_HTTP_READS) return;
        const ownsHttpSlot = !hasDirectListings;
        if (ownsHttpSlot) marketAlertHttpReadsInFlight++;
        try {
            const pollCategory = getMarketItemAlertPollCategory(alerts);
            const marketReadStartedAt = performance.now();
            const marketListings = hasDirectListings
                ? listings
                : getMarketListings(await gameApiRequest(`/api/game/market?category=${encodeURIComponent(pollCategory)}`, { priority:'high' }));
            const httpDetectedAt = hasDirectListings ? null : performance.now();
            const marketReadLatencyMs = hasDirectListings ? null : httpDetectedAt - marketReadStartedAt;
            const marketReadCadenceMs = hasDirectListings || !lastItemMarketReadCompletedAt ? null : httpDetectedAt - lastItemMarketReadCompletedAt;
            if (!hasDirectListings) lastItemMarketReadCompletedAt = httpDetectedAt;
            const itemListings = marketListings
                .filter(entry => !isMarketPokemonListing(entry));
            const seen = getMarketItemAlertSeenKeys();
            const autoBuyEnabled = isMarketItemAlertAutoBuyEnabled();
            const purchaseTasks = [];
            const launchAutoBuy = match => {
                if (!autoBuyEnabled) return;
                purchaseTasks.push((async () => {
                    try {
                        const itemName = match.entry?.name || match.entry?.itemName || match.entry?.item?.name || 'objeto';
                        const purchaseRequest = buyMarketItemAlert(match.entry);
                        setMarketItemAlertAutoBuyStatus('intentando compra', itemName);
                        const purchasedEntry = await purchaseRequest;
                        setMarketItemAlertAutoBuyStatus('compra confirmada', itemName);
                        void getCurrentMarketAlertAccount().then(account => {
                            queueMarketAlertToast({ ...match, entry:purchasedEntry, account, title:'Compra automática de objeto completada' });
                            return sendMarketAlertToTelegramOnce(purchasedEntry, 'item-auto-bought', { automatic:true, account, kind:'item', title:'Objeto comprado' });
                        }).catch(error => console.debug('Telegram: aviso automático de objeto no enviado.', error?.message || error));
                    } catch (error) {
                        console.warn('Compra automática de objeto no completada; se conserva la alerta manual.', error?.message || error);
                        const failureDetail = `${String(error?.message || error || 'Sin detalle')} · ${error?.marketSource || 'HTTP'}${Number.isFinite(error?.marketReadLatencyMs) ? ` GET ${error.marketReadLatencyMs} ms` : ''}${Number.isFinite(error?.marketReadCadenceMs) ? ` · ritmo ${error.marketReadCadenceMs} ms` : ''}${Number.isFinite(error?.purchaseDispatchDelayMs) ? ` · despacho ${error.purchaseDispatchDelayMs} ms` : ''}${Number.isFinite(error?.purchaseLatencyMs) ? ` · POST ${error.purchaseLatencyMs} ms` : ''}`.slice(0, 210);
                        setMarketItemAlertAutoBuyStatus('falló', failureDetail.slice(0, 120));
                        if (!/saldo insuficiente|ya no está disponible|não está mais disponível|no longer available|not available/i.test(String(error?.message || ''))) {
                            seen.delete(match.key);
                            saveMarketItemAlertSeenKeys(seen);
                        }
                        void getCurrentMarketAlertAccount().then(account => {
                            addMarketItemAlertInboxEntry(match.alert, match.entry, account);
                            queueMarketAlertToast({ ...match, account, title:'Compra automática de objeto fallida' });
                            return sendMarketAlertToTelegramOnce(match.entry, 'item-auto-buy-failed', {
                                account, kind:'item', title:'Compra automática no completada', detail:failureDetail
                            });
                        }).catch(telegramError => console.debug('Telegram: alerta de objeto no enviada.', telegramError?.message || telegramError));
                    }
                })());
            };
            const freshKeys = [];
            const freshByListing = new Map();
            for (const alert of alerts) {
                for (const entry of itemListings) {
                    if (!marketItemAlertMatchesListing(alert, entry)) continue;
                    for (const listingId of getMarketListingIds(entry)) {
                        const key = `${alert.id}:${listingId}`;
                        if (seen.has(key)) continue;
                        freshKeys.push(key);
                        const listingKey = `item:${listingId}`;
                        if (!freshByListing.has(listingKey)) {
                            const match = {
                                alert,
                                entry:{
                                    ...entry,
                                    _scriptMarketListingId:listingId,
                                    _scriptMarketSource:entry?._scriptMarketSource || 'HTTP',
                                    _scriptMarketDetectedAt:entry?._scriptMarketDetectedAt ?? httpDetectedAt,
                                    _scriptMarketReadLatencyMs:entry?._scriptMarketReadLatencyMs ?? marketReadLatencyMs,
                                    _scriptMarketReadCadenceMs:entry?._scriptMarketReadCadenceMs ?? marketReadCadenceMs
                                },
                                key
                            };
                            freshByListing.set(listingKey, match);
                            // El POST comienza aquí, sin esperar a que termine el
                            // recorrido del resto del snapshot del mercado.
                            launchAutoBuy(match);
                        }
                    }
                }
            }
            // Igual que en Pokémon: el alta/edición de la regla ya sembró los
            // anuncios existentes. El primer escaneo real debe poder comprar.
            marketItemAlertMonitorReady = true;
            const freshListings = [...freshByListing.values()];
            const persistSeenMatches = () => {
                freshKeys.forEach(key => seen.add(key));
                if (freshKeys.length) saveMarketItemAlertSeenKeys(seen);
            };
            if (autoBuyEnabled) {
                if (freshListings.length) console.info(`[Better Market] ${freshListings.length} objeto(s) nuevo(s) detectado(s); compra automática activa.`);
                persistSeenMatches();
                syncMarketItemAlertInbox(itemListings);
                await Promise.allSettled(purchaseTasks);
            } else {
                if (freshListings.length) console.info(`[Better Market] ${freshListings.length} objeto(s) nuevo(s) detectado(s); compra automática desactivada.`);
                persistSeenMatches();
                syncMarketItemAlertInbox(itemListings);
                const accountPromise = freshListings.length ? getCurrentMarketAlertAccount() : Promise.resolve(null);
                freshListings.slice().reverse().forEach(match => {
                    void accountPromise.then(account => {
                        addMarketItemAlertInboxEntry(match.alert, match.entry, account);
                        queueMarketAlertToast({ ...match, account, title:'Nuevo objeto en alerta' });
                        return sendMarketAlertToTelegramOnce(match.entry, 'item-published', { account, kind:'item', title:'Nuevo objeto en alerta' });
                    }).catch(telegramError => console.debug('Telegram: alerta de objeto no enviada.', telegramError?.message || telegramError));
                });
            }
        } catch (error) {
            console.warn('Monitor de alertas de objetos: lectura aplazada.', error?.message || error);
            if (Number(error?.status) === 429) marketAlertBackoffUntil = Date.now() + 1500;
        } finally {
            if (ownsHttpSlot) marketAlertHttpReadsInFlight = Math.max(0, marketAlertHttpReadsInFlight - 1);
        }
    }

    function updateMarketSaleDockBadge() {
        const button = document.getElementById('dock-btn-shops');
        if (!button) return;
        let badge = button.querySelector('.market-sale-dock-badge');
        const count = Math.max(0, Number(localStorage.getItem(STORAGE_MARKET_SALES_UNREAD)) || 0);
        if (!count) {
            badge?.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'market-sale-dock-badge';
            button.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.title = `${count} ${tr('marketSaleFinished')}`;
    }

    function markMarketSalesRead() {
        localStorage.setItem(STORAGE_MARKET_SALES_UNREAD, '0');
        updateMarketSaleDockBadge();
    }

    function queueMarketSaleToast(entry) {
        marketSaleToastQueue.push(entry);
        if (marketSaleToastBusy) return;
        const showNext = () => {
            const sale = marketSaleToastQueue.shift();
            if (!sale) {
                marketSaleToastBusy = false;
                return;
            }
            marketSaleToastBusy = true;
            const name = sale.name || sale.itemName || sale.pokemonName || '—';
            const quantity = Math.max(1, Number(sale.amount ?? sale.quantity ?? 1) || 1);
            const currency = normalizeMarketCurrency(sale.currency);
            const icon = currency === 'DIAMONDS' ? '💎' : '💲';
            const saleLocale = getGameLanguage() === 'pt' ? 'pt-BR' : getGameLanguage() === 'es' ? 'es-VE' : 'en-US';
            const salePrice = Math.max(0, Number(sale.price) || 0).toLocaleString(saleLocale, { maximumFractionDigits: 0 });
            const toast = document.createElement('div');
            toast.className = 'market-sale-toast';
            toast.innerHTML = `<span>✓</span><b>${escapeHTML(tr('marketSaleFinished'))}</b><small>${quantity.toLocaleString(saleLocale)}× ${escapeHTML(name)} · ${icon} ${salePrice}</small>`;
            document.body.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('show'));
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => { toast.remove(); showNext(); }, 180);
            }, 2000);
        };
        showNext();
    }

    function marketHistoryEntryKey(entry) {
        return String(entry?.id ?? [entry?.at, entry?.kind || entry?.type, entry?.refId ?? entry?.itemId ?? entry?.speciesId, entry?.name || entry?.itemName || entry?.pokemonName, entry?.amount ?? entry?.quantity, entry?.price, entry?.currency, Boolean(entry?.bought)].join('|'));
    }

    async function pollCompletedMarketSales() {
        if (marketSaleMonitorBusy || document.hidden) return;
        marketSaleMonitorBusy = true;
        try {
            const payload = await gameApiRequest('/api/game/market?category=All');
            const sold = (Array.isArray(payload?.history) ? payload.history : []).filter(entry => !Boolean(entry.bought));
            const currentKeys = sold.map(marketHistoryEntryKey);
            const seen = new Set(readStoredJSON(STORAGE_MARKET_SALES_SEEN, []));
            if (!marketSaleMonitorReady && seen.size === 0) {
                localStorage.setItem(STORAGE_MARKET_SALES_SEEN, JSON.stringify(currentKeys.slice(0, 200)));
                marketSaleMonitorReady = true;
                updateMarketSaleDockBadge();
                return;
            }
            marketSaleMonitorReady = true;
            const newSales = sold.filter(entry => !seen.has(marketHistoryEntryKey(entry)));
            if (newSales.length) {
                newSales.slice().reverse().forEach(queueMarketSaleToast);
                const unread = Math.max(0, Number(localStorage.getItem(STORAGE_MARKET_SALES_UNREAD)) || 0) + newSales.length;
                localStorage.setItem(STORAGE_MARKET_SALES_UNREAD, String(unread));
                updateMarketSaleDockBadge();
            }
            localStorage.setItem(STORAGE_MARKET_SALES_SEEN, JSON.stringify([...new Set([...currentKeys, ...seen])].slice(0, 200)));
        } catch {
            // El jugador puede no haber iniciado sesión todavía; se reintentará.
        } finally {
            marketSaleMonitorBusy = false;
        }
    }

    function getMapFilters() {
        const fallback = {
            sort: '',
            type: '',
            access: 'all',
            captured: '',
            levelMin: '',
            levelMax: ''
        };
        return fallback;
    }

    function setMapFilters(filters) {
        localStorage.removeItem(STORAGE_MAP_FILTERS);
    }

    function simplifyNativeMapControls(mapWindow) {
        if (!mapWindow) return;
        const typeNames = new Set([
            'aço', 'água', 'dragão', 'elétrico', 'fada', 'fantasma', 'fogo', 'gelo',
            'inseto', 'lutador', 'normal', 'pedra', 'planta', 'psíquico', 'sombrio',
            'terra', 'veneno', 'voador',
            'steel', 'water', 'dragon', 'electric', 'fairy', 'ghost', 'fire', 'ice',
            'bug', 'fighting', 'rock', 'grass', 'psychic', 'dark', 'ground', 'poison', 'flying'
        ]);
        const normalize = value => String(value || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        const normalizedTypes = new Set([...typeNames].map(normalize));
        const candidates = Array.from(mapWindow.querySelectorAll('div, section, nav'))
            .map(element => ({
                element,
                matches: Array.from(element.children).filter(child =>
                    normalizedTypes.has(normalize(child.textContent.replace(/[^\p{L}]/gu, '')))
                ).length
            }))
            .filter(candidate => candidate.matches >= 8)
            .sort((a, b) => a.element.getBoundingClientRect().height - b.element.getBoundingClientRect().height);
        candidates[0]?.element.classList.add('script-hidden-native-types');

        // La búsqueda y los niveles nativos se integran en nuestro panel avanzado.
        // Ocultamos únicamente su fila compacta para no afectar las pestañas de regiones.
        const nativeSearch = mapWindow.querySelector('.map-filter-q');
        if (nativeSearch && !nativeSearch.closest('#custom-hunts-filter-bar')) {
            let row = nativeSearch.parentElement;
            for (let depth = 0; row && row !== mapWindow && depth < 3; depth++, row = row.parentElement) {
                const rect = row.getBoundingClientRect();
                if (row.querySelectorAll('input').length >= 2 && rect.height > 0 && rect.height <= 90) {
                    row.classList.add('script-hidden-native-map-filter');
                    break;
                }
            }
            if (!mapWindow.querySelector('.script-hidden-native-map-filter')) {
                nativeSearch.classList.add('script-hidden-native-map-control');
                Array.from(nativeSearch.parentElement?.children || []).forEach(element => {
                    if (element.matches?.('input[type="number"]')) element.classList.add('script-hidden-native-map-control');
                });
            }
        }
    }

    function readTrainerLevelFromDOM() {
        const candidates = [
            document.querySelector('.phud-tlevel'),
            document.querySelector('.phud-level'),
            document.querySelector('[data-guide="player-level"]')
        ].filter(Boolean);
        for (const element of candidates) {
            const match = element.textContent.match(/\d+/);
            if (match) return Number(match[0]);
        }
        return null;
    }

    function loadTrainerLevel(force = false) {
        const domLevel = readTrainerLevelFromDOM();
        if (domLevel) cachedTrainerLevel = domLevel;
        if (!force && (cachedTrainerLevel !== null || trainerLevelPromise)) {
            return trainerLevelPromise || Promise.resolve(cachedTrainerLevel);
        }
        trainerLevelPromise = gameApiRequest('/api/characters/me')
            .then(payload => {
                cachedTrainerLevel = Number(payload?.character?.level ?? payload?.level) || readTrainerLevelFromDOM() || 1;
                return cachedTrainerLevel;
            })
            .catch(() => {
                cachedTrainerLevel = readTrainerLevelFromDOM() || 1;
                return cachedTrainerLevel;
            })
            .finally(() => { trainerLevelPromise = null; });
        return trainerLevelPromise;
    }

    function hasPiwToolsStats(pokemon) {
        return Boolean(pokemon?.stats) && ['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed']
            .every(stat => Number.isFinite(Number(pokemon.stats[stat])));
    }

    function requestPokemonTeamFromGameContext(timeoutMs = 1800) {
        const hudElement = document.querySelector('.phud-name') || document.querySelector('.phud');
        if (!hudElement) return Promise.resolve([]);
        const fiberKey = Object.keys(hudElement).find(key => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? hudElement[fiberKey] : null;
        let gameContext = null;
        for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
            const value = fiber.memoizedProps?.value;
            if (value && typeof value.subscribe === 'function' && typeof value.requestPokes === 'function') {
                gameContext = value;
                break;
            }
        }
        if (!gameContext) return Promise.resolve([]);

        return new Promise(resolve => {
            let settled = false;
            let unsubscribe = null;
            const finish = list => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                try { unsubscribe?.(); } catch {}
                resolve(Array.isArray(list) ? list : []);
            };
            const timeout = setTimeout(() => finish([]), timeoutMs);
            unsubscribe = gameContext.subscribe('pokes', message => finish(message?.list));
            gameContext.requestPokes();
        });
    }

    function getGameContextFromDOM() {
        const hudElement = document.querySelector('.phud-name') || document.querySelector('.phud');
        const fiberKey = hudElement && Object.keys(hudElement).find(key => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? hudElement[fiberKey] : null;
        for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
            const value = fiber.memoizedProps?.value;
            if (value && typeof value.subscribe === 'function') return value;
        }
        return null;
    }

    async function toggleNativeLock(kind, entry, desiredLocked = null, refreshPokemon = true) {
        const context = getGameContextFromDOM();
        const nextLocked = desiredLocked == null ? !isNativeLocked(entry) : Boolean(desiredLocked);
        if (kind === 'item') {
            const itemId = Number(entry?.itemId ?? entry?.id);
            if (!Number.isFinite(itemId)) throw new Error('O item não possui um identificador válido.');
            await gameApiRequest('/api/game/item/lock', {
                method: 'POST',
                body: JSON.stringify({ itemId, locked: nextLocked })
            });
            entry.locked = nextLocked;
            entry.isLocked = nextLocked;
            setNativeItemLock(entry.name, nextLocked);
            return nextLocked;
        }
        if (kind === 'pokemon') {
            // O endpoint nativo recebe o identificador do Pokémon em `id`.
            // Os aliases abaixo mantêm compatibilidade com dados antigos do Depot,
            // mas o `entry.id` usado atualmente pelo jogo sempre tem prioridade.
            const pokemonIds = [];
            const addPokemonId = value => {
                if (value == null || value === '') return;
                if (!pokemonIds.some(candidate => String(candidate) === String(value))) pokemonIds.push(value);
            };
            addPokemonId(entry?.id);
            addPokemonId(entry?.pokemon?.id);
            addPokemonId(entry?.poke?.id);
            addPokemonId(entry?.capturedPokemon?.id);
            addPokemonId(entry?.capturedId);
            addPokemonId(entry?.pokeId);

            const id = pokemonIds[0];
            if (id == null || id === '') throw new Error('O Pokémon não possui um identificador válido.');
            let result;
            let confirmedId = id;
            let lastError;
            for (const candidateId of pokemonIds) {
                try {
                    result = await gameApiRequest('/api/game/pokemon/lock', {
                        method: 'POST',
                        body: JSON.stringify({ id: candidateId, locked: nextLocked })
                    });
                    confirmedId = candidateId;
                    lastError = null;
                    break;
                } catch (error) {
                    lastError = error;
                }
            }
            if (lastError) throw lastError;
            const confirmedLocked = Boolean(result?.pokemon?.locked ?? result?.locked ?? nextLocked);
            entry.locked = confirmedLocked;
            entry.isLocked = confirmedLocked;
            entry.protected = confirmedLocked;
            entry.sellLocked = confirmedLocked;
            if (Array.isArray(latestPokemon)) {
                const cached = latestPokemon.find(pokemon => [
                    pokemon?.id,
                    pokemon?.pokemon?.id,
                    pokemon?.poke?.id,
                    pokemon?.capturedPokemon?.id,
                    pokemon?.capturedId,
                    pokemon?.pokeId
                ].some(candidate => candidate != null && String(candidate) === String(confirmedId)));
                if (cached) {
                    cached.locked = confirmedLocked;
                    cached.isLocked = confirmedLocked;
                    cached.protected = confirmedLocked;
                    cached.sellLocked = confirmedLocked;
                }
            }
            if (refreshPokemon) sendGameMessage({ type: 'pokes-get' });
            return confirmedLocked;
        }
        const candidates = kind === 'pokemon'
            ? ['togglePokeLock', 'togglePokemonLock', 'setPokeLocked', 'lockPoke']
            : [];
        const method = candidates.find(name => typeof context?.[name] === 'function');
        if (method) {
            await context[method](entry?.id ?? entry?.capturedId ?? entry?.pokeId, nextLocked);
        } else {
            const fallbackId = entry?.id ?? entry?.capturedId ?? entry?.pokeId ?? entry?.itemId;
            const sent = sendGameMessage({ type: kind === 'pokemon' ? 'poke-lock' : 'item-lock', [kind === 'pokemon' ? 'pokeId' : 'itemId']: fallbackId, locked: nextLocked });
            if (!sent) throw new Error('A ação nativa de cadeado não está disponível.');
        }
        entry.locked = nextLocked;
        return nextLocked;
    }
    function isNativeLocked(entry) {
        return [entry?.locked, entry?.isLocked, entry?.protected, entry?.sellLocked, entry?.lock, entry?.is_locked]
            .some(value => value === true || value === 1 || /^(?:true|1|locked)$/i.test(String(value ?? '')));
    }


    function parseGameNumber(value) {
        const text = String(value ?? '').trim().toLowerCase();
        const abbreviated = text.match(/(-?\d+(?:[.,]\d+)?)\s*([kmb])\b/);
        if (abbreviated) {
            const number = Number(abbreviated[1].replace(',', '.'));
            const multipliers = { k: 1e3, m: 1e6, b: 1e9 };
            return Number.isFinite(number) ? Math.round(number * multipliers[abbreviated[2]]) : 0;
        }
        const digits = text.replace(/[^0-9-]/g, '');
        const parsed = parseInt(digits, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function refreshDexEnhancements() {
        const dexWindow = document.querySelector('.dex-window');
        if (!dexWindow) return;
        const controls = dexWindow.querySelector('.dex-script-controls');
        if (controls) controls.remove();
        injectDexEnhancements();
    }

    // URLs oficiais do jogo
    const POKEMON_TYPES_JSON_URL = 'https://poke.idleworld.online/game/creatures.json';
    const ITEMS_JSON_URL = 'https://poke.idleworld.online/game/items.json';
    const MAP_MARKERS_API_URL = '/api/game/map-markers';
    const POKEMON_ITEM_ICONS = {1:36575,2:36585,3:36595,4:36605,5:36615,6:36625,7:36634,8:36643,9:36651,10:36669,11:36660,12:36702,13:36696,14:36687,15:36705,16:36722,17:36713,18:36731,19:36740,20:36755,21:36758,22:36767,23:36776,24:36785,25:36639,26:36647,27:36601,28:36611,29:36586,30:36606,31:36596,32:36576,33:36626,34:36616,35:36644,36:36635,37:36674,38:36683,39:36620,40:36630,41:36580,42:36590,43:36717,44:36726,45:36735,46:36652,47:36661,48:36670,49:36900,50:36688,51:36697,52:36723,53:36714,54:36656,55:36665,56:36706,57:36759,58:36782,59:36741,60:36732,61:36768,62:36786,63:36691,64:36700,65:36709,66:36771,67:36780,68:36789,69:36777,70:36577,71:36587,72:36676,73:36685,74:36744,75:36753,76:36762,77:36597,78:36607,79:36617,80:36627,81:36631,82:36640,83:36636,84:36692,85:36701,86:36799,87:36653,88:36655,89:36641,90:36671,91:36662,92:36680,93:36689,94:36698,95:36707,96:36715,97:36724,98:36592,99:36733,100:36694,101:36703,102:36751,103:36760,104:36769,105:36778,106:36737,107:36648,108:36588,109:36673,110:36682,111:36710,112:36718,113:36598,114:36608,115:36618,116:36781,117:36738,118:36745,119:36754,120:36581,121:36591,122:36628,123:36637,124:36645,125:36622,126:36663,127:36621,128:36672,129:36711,130:36720,131:36681,132:36690,133:36699,134:36708,135:36716,136:36725,137:36734,138:36743,139:36752,140:36761,141:36770,142:36779,143:36788,147:36629,148:36638,149:36646,150:36609};

    function getPokemonIconUrl(speciesId) {
        const id = Number(speciesId);
        if (id >= 152 && id <= 251 && id !== 201) return `/assets/pokeitems/gen2/${id}.png`;
        if ((id >= 252 && id <= 386) || id === 447 || id === 448) return `/assets/pokeitems/gen3/${id}.png`;
        return POKEMON_ITEM_ICONS[id] ? `/assets/pokeitems/${POKEMON_ITEM_ICONS[id]}.png` : '';
    }

    function updateCachedLeaderPokemon(pokemonList) {
        const leader = pokemonList.find(pokemon => pokemon.leader)
            || pokemonList.filter(pokemon => pokemon.team).sort((a, b) => Number(a.slot ?? 99) - Number(b.slot ?? 99))[0];
        if (!leader) return false;
        const name = normalizePokemonName(leader.name || leader.pokemonName || '');
        const explicitTypes = [leader.type1, leader.type2, ...(Array.isArray(leader.types) ? leader.types : [])]
            .filter(Boolean).map(type => String(type).toLowerCase());
        const types = explicitTypes.length ? [...new Set(explicitTypes)] : (POKEMON_TYPES[name] || []);
        const changed = name !== cachedLeaderPokemonName || JSON.stringify(types) !== JSON.stringify(cachedLeaderPokemonTypes);
        cachedLeaderPokemonName = name;
        cachedLeaderPokemonTypes = types;
        return changed;
    }

    async function refreshActivePokemonForMap() {
        let pokemonList = await requestPokemonTeamFromGameContext(2200);
        if (!pokemonList.length) pokemonList = Array.isArray(latestPokemon) ? latestPokemon : [];
        return updateCachedLeaderPokemon(pokemonList);
    }

    function normalizeGameItemIcon(icon) {
        if (!icon) return '';
        if (/^(https?:)?\//.test(icon)) return icon;
        return `/assets/items/${String(icon).replace(/^\/+/, '')}`;
    }

    function getMarkerName(marker) {
        return String(
            marker?.name || marker?.title || marker?.huntName || marker?.pokemonName ||
            marker?.creatureName || marker?.pokemon?.name || marker?.creature?.name || ''
        ).trim();
    }

    function getMarkerSlug(marker) {
        return String(marker?.slug || marker?.huntSlug || marker?.hunt?.slug || '').trim();
    }

    function indexHuntMarkers(payload) {
        globalHuntMarkerData.clear();
        const markers = [];
        const visited = new WeakSet();
        const collect = value => {
            if (!value || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            if (Array.isArray(value)) {
                value.forEach(collect);
                return;
            }
            const name = getMarkerName(value);
            const slug = getMarkerSlug(value);
            const looksLikeMarker = Boolean(name && (slug || value.area || value.region || value.looktype
                || value.pokemon || value.creature || value.speciesId || value.pokeId || value.hunt));
            if (looksLikeMarker) markers.push(value);
            Object.values(value).forEach(collect);
        };
        collect(payload);
        markers.forEach(marker => {
            if (!marker || typeof marker !== 'object') return;
            const name = getMarkerName(marker);
            const slug = getMarkerSlug(marker);
            if (name) globalHuntMarkerData.set(getCleanHuntName(name), marker);
            if (slug) globalHuntMarkerData.set(slug.toLowerCase(), marker);
        });
    }

    function loadMapMarkersData(force = false) {
        if (!force && mapMarkersLoadPromise) return mapMarkersLoadPromise;
        mapMarkersLoadPromise = fetch(MAP_MARKERS_API_URL, { credentials: 'same-origin' })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(payload => {
                indexHuntMarkers(payload);
                refreshDexEnhancements();
                lastMapRenderSignature = '';
                buildSimpleList();
                return globalHuntMarkerData;
            })
            .catch(error => {
                console.warn('⚠️ Falha ao carregar os marcadores do mapa; usando o DOM como fallback.', error);
                return globalHuntMarkerData;
            });
        return mapMarkersLoadPromise;
    }

    // --- TABELA COMPACTA DE TIPOS POKÉMON ---
    const TYPE_CHART = {
        normal: { rock: 0.5, ghost: 0, steel: 0.5 },
        fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
        water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
        electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
        grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
        ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
        fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2 },
        poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0 },
        ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
        flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
        psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
        bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5 },
        rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
        ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
        dragon: { dragon: 2, steel: 0.5 },
        dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5 },
        steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
        fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
    };

    const BASE_POKEMON_TYPES = {
        "magneton": ["electric", "steel"], "charizard": ["fire", "flying"], "blastoise": ["water"],
        "venusaur": ["grass", "poison"], "pikachu": ["electric"], "alakazam": ["psychic"],
        "gengar": ["ghost", "poison"], "dragonite": ["dragon", "flying"], "gyarados": ["water", "flying"],
        "arcanine": ["fire"], "scyther": ["bug", "flying"], "golem": ["rock", "ground"],
        "snorlax": ["normal"], "lapras": ["water", "ice"], "machamp": ["fighting"],
        "pinsir": ["bug"], "eevee": ["normal"], "vaporeon": ["water"], "jolteon": ["electric"], "flareon": ["fire"]
    };

    let POKEMON_TYPES = { ...BASE_POKEMON_TYPES };

    // Carregamento de Criaturas da API
    async function loadExternalPokemonData() {
        try {
            const response = await fetch(POKEMON_TYPES_JSON_URL);
            if (response.ok) {
                const data = await response.json();
                const creaturesList = Array.isArray(data) ? data : (data.creatures || []);
                if (creaturesList.length > 0) {
                    const fetchedTypes = {};
                    creaturesList.forEach(poke => {
                        const pokeName = normalizePokemonName(poke.name || '');
                        const t1 = poke.type1 || poke.type_1;
                        const t2 = poke.type2 || poke.type_2;
                        if (pokeName && t1) {
                            const types = [t1.toLowerCase().trim()];
                            if (t2) types.push(t2.toLowerCase().trim());
                            fetchedTypes[pokeName] = types;
                        }
                        globalCreatureApiData.set(pokeName, poke);
                        const apiAliases = [poke.slug, poke.key, poke.apiName, poke.displayName].filter(Boolean);
                        apiAliases.forEach(alias => globalCreatureApiData.set(normalizePokemonName(alias), poke));
                    });
                    POKEMON_TYPES = { ...BASE_POKEMON_TYPES, ...fetchedTypes };
                    buildSimpleList();
                    refreshDexEnhancements();
                    loadCaughtPokedexData();
                }
            }
        } catch (e) {
            console.warn("⚠️ Falha ao carregar creatures.json", e);
        }
    }

    // Carregamento de Itens da API (para buscar os ícones botânicos/oficiais)
    async function loadExternalItemData() {
        try {
            const response = await fetch(ITEMS_JSON_URL);
            if (response.ok) {
                const data = await response.json();
                const itemsList = Array.isArray(data) ? data : (data.items || Object.values(data));
                itemsList.forEach(item => {
                    if (!item) return;
                    const itemName = (item.name || item.title || '').toLowerCase().trim();
                    const itemId = String(item.id || item.key || '').toLowerCase().trim();

                    if (itemName) globalItemApiData.set(itemName, item);
                    if (itemId) globalItemApiData.set(itemId, item);
                });
                buildSimpleList();
                refreshDexEnhancements();
            }
        } catch (e) {
            console.warn("⚠️ Falha ao carregar items.json", e);
        }
    }

    loadExternalPokemonData();
    itemDataLoadPromise = loadExternalItemData();
    loadMapMarkersData();

    function applyOutlandModifier(baseMultiplier) {
        if (baseMultiplier === 1.5) return 1.75;
        if (baseMultiplier === 2.0) return 2.50;
        if (baseMultiplier >= 4.0) return 5.50;
        if (baseMultiplier === 0.5) return 0.33;
        return baseMultiplier;
    }

    function getOffensiveMultiplier(attackerTypes, defenderTypes) {
        let bestMult = null;
        attackerTypes.forEach(attType => {
            let mult = 1.0;
            defenderTypes.forEach(defType => {
                const chart = TYPE_CHART[attType];
                if (chart && chart[defType] !== undefined) {
                    mult *= chart[defType];
                }
            });
            if (bestMult === null || mult > bestMult) {
                bestMult = mult;
            }
        });
        return applyOutlandModifier(bestMult !== null ? bestMult : 1.0);
    }

    const POKEMON_NAME_ALIASES = {
        nidoranfe: 'nidoran-f', 'nidoran female': 'nidoran-f', 'nidoran♀': 'nidoran-f',
        nidoranma: 'nidoran-m', 'nidoran male': 'nidoran-m', 'nidoran♂': 'nidoran-m',
        farfetchd: "farfetch'd", 'farfetch’d': "farfetch'd"
    };
    const TYPE_COLORS = {
        normal:'#a0aec0', fire:'#f56565', water:'#4299e1', electric:'#ecc94b', grass:'#48bb78',
        ice:'#76e4f7', fighting:'#c05640', poison:'#9f7aea', ground:'#b7791f', flying:'#90cdf4',
        psychic:'#ed64a6', bug:'#9ae640', rock:'#a67c52', ghost:'#6b46c1', dragon:'#805ad5',
        dark:'#4a5568', steel:'#cbd5e0', fairy:'#fbb6ce'
    };

    function normalizePokemonName(name) {
        const normalized = String(name || '').toLowerCase().normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
        return POKEMON_NAME_ALIASES[normalized] || normalized;
    }

    function getCleanHuntName(huntName) {
        if (!huntName) return '';
        return normalizePokemonName(huntName
            .replace(/\[.*?\]/g, '')
            .replace(/\(.*\)/g, '')
            .trim());
    }

    function getDefenderTypes(huntName) {
        const cleanName = getCleanHuntName(huntName);
        if (POKEMON_TYPES[cleanName]) return POKEMON_TYPES[cleanName];

        const words = cleanName.split(/\s+/);
        for (let i = words.length - 1; i >= 0; i--) {
            const subName = words.slice(i).join(' ');
            if (POKEMON_TYPES[subName]) return POKEMON_TYPES[subName];
            if (POKEMON_TYPES[words[i]]) return POKEMON_TYPES[words[i]];
        }
        return [];
    }

    // --- PROCESSAMENTO DE DROPS COM ÍCONES REAIS DO ITEMS.JSON ---
    function resolveItemIcon(itemName) {
        const cleanKey = itemName.toLowerCase().trim();
        let itemObj = globalItemApiData.get(cleanKey);

        if (!itemObj) {
            // Tenta buscar por correspondência parcial
            for (const [key, val] of globalItemApiData.entries()) {
                if (cleanKey.includes(key) || key.includes(cleanKey)) {
                    itemObj = val;
                    break;
                }
            }
        }

        if (itemObj) {
            const imgPath = itemObj.image || itemObj.icon || itemObj.sprite || itemObj.img || '';
            if (imgPath) {
                // Se o caminho for relativo, constrói a URL correta com base no domínio
                const fullImgUrl = imgPath.startsWith('http') ? imgPath : `https://poke.idleworld.online/${imgPath.startsWith('/') ? imgPath.slice(1) : imgPath}`;
                return `<img src="${escapeHTML(fullImgUrl)}" style="width:20px; height:20px; vertical-align:middle; margin-right:8px; object-fit:contain;" />`;
            }
        }

        // Fallback visual caso o item não tenha imagem mapeada
        return `<span style="display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; background:#12202a; border:1px solid #273f52; border-radius:4px; margin-right:8px; font-size:10px; color:#48bb78;">🌿</span>`;
    }

    function parseDropsHTML(rawDrops) {
        if (!rawDrops) return '';

        if (Array.isArray(rawDrops)) {
            return rawDrops.map(d => {
                let itemName = 'Item';
                let customImgHTML = '';

                if (typeof d === 'object' && d !== null) {
                    itemName = d.name || d.item || d.label || d.title || 'Item';
                    const directImg = d.image || d.icon || d.sprite || d.img || '';
                    if (directImg) {
                        const fullUrl = directImg.startsWith('http') ? directImg : `https://poke.idleworld.online/${directImg.startsWith('/') ? directImg.slice(1) : directImg}`;
                        customImgHTML = `<img src="${escapeHTML(fullUrl)}" style="width:20px; height:20px; vertical-align:middle; margin-right:8px; object-fit:contain;" />`;
                    }
                } else {
                    itemName = String(d);
                }

                const iconHTML = customImgHTML || resolveItemIcon(itemName);
                const itemData = globalItemApiData.get(String(itemName).toLowerCase().trim()) || d || {};
                const rarity = String(itemData.rarity || itemData.tier || '').toLowerCase();
                const rawChance = Number(d?.chance ?? d?.dropChance ?? d?.dropRate ?? d?.rate ?? d?.probability ?? itemData.dropChance ?? itemData.chance);
                const chancePercent = Number.isFinite(rawChance) ? (rawChance <= 1 ? rawChance * 100 : rawChance) : null;
                const chanceRarity = chancePercent === null ? 'common' : chancePercent <= .1 ? 'legendary'
                    : chancePercent <= 1 ? 'epic' : chancePercent <= 5 ? 'rare' : chancePercent <= 20 ? 'uncommon' : 'common';
                const resolvedRarity = rarity || chanceRarity;
                const rarityColor = resolvedRarity.includes('legend') ? '#f6c453'
                    : resolvedRarity.includes('epic') ? '#d6a2ff'
                        : resolvedRarity.includes('rare') ? '#63b3ed'
                            : resolvedRarity.includes('uncommon') ? '#68d391' : '#a0aec0';

                return `
                    <div style="display:flex; align-items:center; margin-bottom:6px; font-size:13px; color:#cbd5e0; background:rgba(20,34,45,0.6); padding:4px 8px; border-radius:4px; border:1px solid #1a2d3a;">
                        ${iconHTML}
                        <span style="font-weight:800; color:${rarityColor} !important;">${escapeHTML(itemName)}</span>
                    </div>
                `;
            }).join('');
        }

        if (typeof rawDrops === 'string') {
            return `<div style="font-size:13px; color:#cbd5e0;">${escapeHTML(rawDrops)}</div>`;
        }

        return '';
    }

    function extractHuntDetailsFromJSON(name, marker) {
        const cleanName = getCleanHuntName(name);
        let priceVal = 0;
        let experience = 0;
        let dropsHTML = '';

        if (globalCreatureApiData.has(cleanName)) {
            const pokeObj = globalCreatureApiData.get(cleanName);
            const possiblePriceKeys = ['sellValue', 'priceNpc', 'sell', 'sellsFor', 'price', 'value', 'gold', 'money', 'cost', 'reward'];

            for (const key of possiblePriceKeys) {
                if (pokeObj[key] !== undefined && pokeObj[key] !== null && pokeObj[key] !== '') {
                    const parsed = parseGameNumber(pokeObj[key]);
                    if (parsed > 0) {
                        priceVal = parsed;
                        break;
                    }
                }
            }

            if (pokeObj.experience !== undefined) {
                experience = parseInt(pokeObj.experience, 10) || 0;
            } else if (pokeObj.exp !== undefined) {
                experience = parseInt(pokeObj.exp, 10) || 0;
            }

            const rawDrops = pokeObj.drops || pokeObj.drop || pokeObj.loot || pokeObj.items;
            dropsHTML = parseDropsHTML(rawDrops);
        }

        if ((priceVal === 0 || !dropsHTML) && marker) {
            marker.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            const mapTip = document.querySelector('.map-tip');
            if (mapTip) {
                if (priceVal === 0) {
                    const sellEl = mapTip.querySelector('.map-tip-sell b') || mapTip.querySelector('.map-tip-sell');
                    if (sellEl) {
                        const parsedDom = parseGameNumber(sellEl.textContent);
                        if (parsedDom > 0) priceVal = parsedDom;
                    }
                }
                if (!dropsHTML) {
                    const dropsEl = mapTip.querySelector('.map-tip-drops');
                    if (dropsEl) {
                        dropsHTML = `<div style="font-size:13px; color:#cbd5e0; padding:4px;">${dropsEl.innerHTML}</div>`;
                    }
                }
            }
            marker.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        }

        let sellsFor = priceVal > 0 ? `$ ${priceVal.toLocaleString('en-US')}` : 'Indisponível';
        if (cleanName === 'aerodactyl') sellsFor = 'Não pode ser vendido';
        const expText = experience > 0 ? `${experience.toLocaleString('en-US')} XP` : '';
        return { sellsFor, numericPrice: priceVal, dropsHTML, experience, expText };
    }

    // --- ESTILOS VISUAIS (ESTÉTICA BOTÂNICA E LIMPA) ---
    const style = document.createElement('style');
    style.id = 'simplifier-dynamic-styles';
    style.innerHTML = `
        :root { --piw-game-font: Barlow, "Barlow Fallback", system-ui, sans-serif; }
        .script-scalable-window {
            text-rendering:geometricPrecision;
            -webkit-font-smoothing:antialiased;
        }
        html.script-unified-fonts,
        html.script-unified-fonts body,
        html.script-unified-fonts body * {
            font-family: var(--piw-game-font) !important;
        }
        html.script-custom-scrollbars * {
            scrollbar-width: thin;
            scrollbar-color: rgba(200, 170, 110, .48) transparent;
        }
        html.script-custom-scrollbars *::-webkit-scrollbar { width: 7px; height: 7px; }
        html.script-custom-scrollbars *::-webkit-scrollbar-track { background: transparent; }
        html.script-custom-scrollbars *::-webkit-scrollbar-corner { background: transparent; }
        html.script-custom-scrollbars *::-webkit-scrollbar-thumb {
            background: rgba(200, 170, 110, .34);
            border: 2px solid transparent;
            background-clip: padding-box;
            border-radius: 999px;
        }
        html.script-custom-scrollbars *::-webkit-scrollbar-thumb:hover { background: rgba(230, 205, 142, .58); background-clip: padding-box; }
        .promo-overlay { display: none !important; }
        #dock-btn-quick-tp, #dock-btn-shops, #dock-btn-depot {
            background: transparent;
            border: 0;
            box-shadow: none;
            display: inline-flex; align-items: center; justify-content: center;
        }
        #dock-btn-quick-tp[hidden] { display: none !important; }
        #dock-btn-quick-tp { color: #ffcc00; font-size: 16px; font-weight: bold; }
        #dock-btn-shops { color: #9ae6b4; font-size: 15px; }
        #dock-btn-depot { color: #90cdf4; font-size: 15px; }
        .script-shop-wrap .poke-menu[hidden] { display: none !important; }
        @media (max-width: 720px) {
            #custom-hunts-filter-bar { grid-template-columns: 1fr !important; }
            .script-shop-menu { box-sizing:border-box !important;z-index:2147483646 !important;width:min(260px,calc(100vw - 12px)) !important;max-width:calc(100vw - 12px) !important;max-height:min(360px,calc(100dvh - 16px)) !important;padding:6px !important;overflow-y:auto !important;background:#081017 !important;border:1px solid #8a682d !important;border-radius:9px !important;box-shadow:0 14px 36px #000f,inset 0 1px #ffffff0b !important; }
            .script-shop-menu[hidden] { display:none !important; }
            .script-shop-menu .poke-menu-item { box-sizing:border-box;width:100%;min-height:42px;padding:9px 11px !important;color:#e9dfca !important;background:#101b22 !important;border:1px solid #29404d !important;border-radius:6px !important;text-align:left;font-size:11px !important;touch-action:manipulation; }
            .script-shop-menu .poke-menu-item + .poke-menu-item { margin-top:5px; }
            .script-shop-menu .poke-menu-item:active { color:#171006 !important;background:linear-gradient(#e2c77f,#b58b39) !important;border-color:#806126 !important; }
        }

        .win-window, .cfg-window, .mk-window, .ball-window, .ha-window, .inv-window, .dex-window,
        .dep-window, .prof-window, .breed-window, .poke-window, .sell-confirm-modal,
        .cap-panel, .chat-box, .npc-dialog, .script-market-window {
            border-radius: 10px !important;
        }
        nav.game-dock, .phud.game-hud-tl, .phud.game-hud.t1 {
            border-radius: 10px !important;
            border: 2px solid rgb(120, 90, 40) !important;
            border-image: none !important;
            background-clip: padding-box !important;
        }
        nav.game-dock::before, .phud.game-hud-tl::before, .phud.game-hud.t1::before {
            border-radius: 7px !important;
        }
        .cfg-window.script-mods-open {
            width: min(900px, 94vw) !important;
            max-width: 94vw !important;
        }
        .cfg-mods-content .script-mods-grid {
            padding: 14px;
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
            background: #0c161f;
            border-radius: 10px;
        }
        .cfg-mods-content .script-mods-title,
        .cfg-mods-content .script-mods-wide { grid-column: 1 / -1; }
        .cfg-mods-content .cfg-row {
            min-width: 0;
            padding: 12px !important;
            border-radius: 8px !important;
        }
        .cfg-mods-content .cfg-label span { display: block; margin-top: 4px; line-height: 1.35; }
        .script-mod-category { grid-column:1/-1;display:block;min-width:0;border:1px solid #23394a;border-radius:10px;background:#0a141c;overflow:visible; }
        .script-mod-category > h3 { margin:0;padding:10px 12px;display:flex;align-items:center;gap:8px;color:#d9c38c;font-size:14px;background:#101e28;border-bottom:1px solid #23394a; }
        .script-mod-category-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:10px;align-items:stretch; }
        .cfg-window.script-mods-open { width:min(920px,94vw) !important;height:min(780px,92vh) !important;max-width:94vw !important;max-height:92vh !important; }
        .cfg-window.script-mods-open .cfg-body { min-height:0;overflow:hidden !important; }
        .cfg-mods-content { width:100%;height:100%;min-width:0;overflow:auto;box-sizing:border-box; }
        .script-mod-category-grid > .cfg-row { box-sizing:border-box;width:100%;min-width:0;height:100%;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:6px; }
        .script-mod-category-grid > label.cfg-row { flex-direction:row;align-items:flex-start !important;justify-content:flex-start;gap:10px !important; }
        .script-mod-category-grid > label.cfg-row > input[type="checkbox"] { flex:0 0 auto;width:18px;height:18px;margin:1px 0 0;accent-color:#c8a24e; }
        .script-mod-category-grid > label.cfg-row > .cfg-label { flex:1;min-width:0;margin:0; }
        .script-mod-category-grid .cfg-seg { width:100%;align-items:stretch; }
        .script-mod-category-grid .cfg-seg-btn { min-width:0;white-space:normal;line-height:1.2; }
        .script-mod-category-grid > .cfg-row.script-mods-wide { grid-column:1/-1; }
        .script-mod-category-grid > .cfg-row:only-child { grid-column:1/-1; }
        .script-mod-category-grid input:not([type="checkbox"]):not([type="radio"]),
        .script-mod-category-grid select { box-sizing:border-box;max-width:100%; }
        .cfg-font-file-row { display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px; }
        .cfg-font-file-name { min-width:0;flex:1;color:#91a4b2;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .script-window-scale-settings { display:block !important; }
        .script-window-scale-head { display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px; }
        .script-window-scale-head b { display:block;color:#e7edf2;font-size:14px; }
        .script-window-scale-head span { display:block;margin-top:3px;color:#849aa9;font-size:10px;line-height:1.4; }
        .script-window-scale-reset { flex:none;min-height:30px;padding:5px 10px;background:#101b23;color:#cad7de;border:1px solid #3a4e5a;border-radius:7px;font-size:9px;font-weight:900;cursor:pointer; }
        .script-window-scale-reset:hover { color:#f1dfb5;border-color:#a47d34; }
        .script-window-scale-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px; }
        .script-window-scale-row { display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:8px;align-items:center;padding:9px;background:#09141c;border:1px solid #263b49;border-radius:8px; }
        .script-window-scale-row b { display:block;color:#dce7ed;font-size:10px; }
        .script-window-scale-row p { margin:3px 0 0;color:#718897;font-size:8px;line-height:1.35; }
        .script-window-scale-control select { width:100%;min-height:31px;padding:4px 7px;background:#061018;color:#eef5f8;border:1px solid #355267;border-radius:6px;font-size:10px;font-weight:900;outline:none; }
        .script-window-scale-control select:focus { border-color:#c4a04c;box-shadow:0 0 0 2px #c4a04c25; }
        .script-window-scale-status { display:block;margin-top:3px;color:#668296;font-size:7px;line-height:1.2;text-align:center; }
        @media (max-width:720px) { .script-window-scale-grid{grid-template-columns:1fr}.script-window-scale-row{grid-template-columns:minmax(0,1fr) 88px} }
        @media (max-width: 720px) {
            .cfg-mods-content .script-mods-grid { grid-template-columns: 1fr; }
            .cfg-mods-content .script-mods-title,
            .cfg-mods-content .script-mods-wide { grid-column: auto; }
            .script-mod-category { grid-column:auto; }
            .script-mod-category-grid { grid-template-columns:1fr; }
            .script-mod-category-grid > .cfg-row.script-mods-wide { grid-column:auto; }
        }
        .cfg-window.script-mods-open { background:linear-gradient(145deg,#0d141a,#070b0f) !important;border:2px solid #785a28 !important;box-shadow:0 18px 55px #000d,inset 0 0 0 1px #d5b36612 !important; }
        .cfg-window.script-mods-open .cfg-tabs { background:#090e12;border-bottom:1px solid #604a25; }
        .cfg-window.script-mods-open .cfg-tab-mods.on { color:#171006 !important;background:linear-gradient(#e2c77f,#b58b39) !important;border-color:#806126 !important; }
        .cfg-mods-content .script-mods-grid { background:linear-gradient(#090f14,#060a0d);gap:10px;padding:12px; }
        .cfg-mods-content .script-mods-title { display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 14px !important;margin:0 !important;background:linear-gradient(135deg,#15232c,#0a1116);border:1px solid #5c4826 !important;border-left:4px solid #d0a84e !important;border-radius:9px;box-shadow:0 5px 16px #0008; }
        .script-settings-brand { display:flex;align-items:center;gap:11px;min-width:0; }
        .script-settings-logo { display:flex;align-items:center;justify-content:center;width:39px;height:39px;flex:none;background:radial-gradient(circle,#3a2e18,#11100b);border:1px solid #94702d;border-radius:9px;font-size:20px;box-shadow:inset 0 0 12px #0008; }
        .script-settings-brand b { display:block;color:#f0e4c9;font-size:17px; }
        .script-settings-brand small { display:block;max-width:510px;margin-top:3px;color:#829aaa;font-size:10px;line-height:1.35; }
        .script-language-control { display:grid;grid-template-columns:auto minmax(135px,auto);align-items:center;gap:3px 8px;flex:none;color:#b9c9d2;font-size:10px;font-weight:800; }
        .script-language-control select { min-height:30px;background:#071017 !important;border-color:#725a2b !important;color:#eee2c8 !important; }
        .script-language-control small { grid-column:1/-1;color:#627986;font-size:8px;font-weight:500;text-align:right; }
        .cfg-mods-content .script-mod-category { border-color:#293e4b;background:linear-gradient(145deg,#0e181f,#090f14);box-shadow:0 4px 13px #0006; }
        .cfg-mods-content .script-mod-category > h3 { min-height:37px;box-sizing:border-box;padding:9px 11px;background:linear-gradient(90deg,#17242c,#0b1217);border-bottom-color:#554525;color:#e9ddc4;font-size:12px;letter-spacing:.025em; }
        .cfg-mods-content .script-mod-category > h3 span { display:flex;align-items:center;justify-content:center;width:24px;height:24px;background:#090e12;border:1px solid #4c432e;border-radius:6px; }
        .cfg-mods-content .script-mod-category-grid { gap:8px;padding:9px; }
        .cfg-mods-content .script-mod-category-grid > .cfg-row { min-height:69px;padding:10px !important;background:linear-gradient(145deg,#121d24,#0b1318) !important;border:1px solid #263b47 !important;border-radius:8px !important;transition:border-color .15s,background .15s,transform .15s; }
        .cfg-mods-content .script-mod-category-grid > .cfg-row:hover { border-color:#735b2d !important;background:linear-gradient(145deg,#17252e,#0d161c) !important;transform:translateY(-1px); }
        .cfg-mods-content .cfg-label b { color:#eee3cd !important;font-size:12px !important; }
        .cfg-mods-content .cfg-label span,.cfg-mods-content .cfg-label small { color:#7f96a5 !important;font-size:9px !important; }
        .cfg-mods-content input[type="checkbox"] { appearance:none;width:34px !important;height:18px !important;border:1px solid #3d5260;border-radius:999px;background:#070d11;position:relative;cursor:pointer;transition:.18s; }
        .cfg-mods-content input[type="checkbox"]::after { content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#71818b;transition:.18s; }
        .cfg-mods-content input[type="checkbox"]:checked { background:#6c5626;border-color:#c39b43;box-shadow:0 0 8px #c39b4333; }
        .cfg-mods-content input[type="checkbox"]:checked::after { left:18px;background:#f0d684; }
        .cfg-mods-content .cfg-seg { padding:2px;background:#070c10;border:1px solid #253843;border-radius:7px; }
        .cfg-mods-content .cfg-seg-btn { min-height:27px;background:transparent;color:#899eab;border:1px solid transparent;border-radius:5px;cursor:pointer; }
        .cfg-mods-content .cfg-seg-btn.on { color:#171006;background:linear-gradient(#dec377,#ad8334);border-color:#806126;box-shadow:inset 0 1px #fff5; }
        @media (max-width:720px) {
            .cfg-mods-content .script-mods-title { align-items:stretch;flex-direction:column; }
            .script-language-control { grid-template-columns:1fr; }
            .script-language-control small { grid-column:auto;text-align:left; }
        }

        .hunt-drop-tooltip {
            position: absolute; background: #0c161f; border: 1px solid #233e52;
            border-radius: 8px; padding: 10px 14px; z-index: 9999; font-size: 13px;
            color: #e2e8f0; pointer-events: none; box-shadow: 0 8px 20px rgba(0,0,0,0.8);
            min-width: 180px; max-width: 280px;
        }
        .drop-icon-btn {
            background: #14222d; border: 1px solid #2b4c66; color: #48bb78;
            border-radius: 50%; width: 24px; height: 24px; font-size: 12px;
            display: inline-flex; align-items: center; justify-content: center;
            cursor: pointer; margin-left: 8px; font-weight: bold; transition: all 0.2s;
        }
        .drop-icon-btn:hover { background: #1c3040; border-color: #48bb78; }

        .map-window {
            display: flex !important;
            flex-direction: column !important;
            width: 820px !important;
            max-width: 95vw !important;
            height: min(680px, 92vh) !important;
            background: #0b141c !important;
            color: #fff !important;
            border: 1px solid #6f5526 !important;
            border-radius: 14px !important;
            overflow: hidden !important;
            box-shadow: 0 18px 55px rgba(0,0,0,.72) !important;
        }
        .map-window > *:first-child,
        .map-window .map-head,
        .map-window .map-header { border-radius: 13px 13px 0 0 !important; }
        .map-window .map-body {
            flex: 1 !important;
            width: 100% !important;
            height: 100% !important;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            background: #0b141c !important;
            padding: 0 12px 12px !important;
            overflow: hidden !important;
        }
        .map-window .script-hidden-native-types {
            display: none !important;
        }
        .map-window .script-hidden-native-map-filter,
        .map-window .script-hidden-native-map-control {
            display: none !important;
        }
        .map-window .map-area {
            border-radius: 9px !important;
            overflow: hidden !important;
        }
        .map-window .script-city-area {
            min-width: 80px !important;
            min-height: 46px !important;
            padding: 8px 16px !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: #111c25 !important;
            color: #e2e8f0 !important;
            border: 1px solid #263746 !important;
            border-radius: 10px !important;
            font: 800 12px var(--piw-game-font) !important;
            cursor: pointer !important;
        }
        .map-window .script-city-area.on {
            color: #f6c453 !important;
            border-color: #9f7b35 !important;
            background: #1b211f !important;
        }
        .map-window .map-filter-q,
        .map-window input[type="number"],
        .map-window select {
            border-radius: 8px !important;
            border-color: #263d4e !important;
            background: #0d1a24 !important;
        }
        #custom-hunts-filter-bar {
            background: #101d27 !important;
            border: 1px solid #203544 !important;
            border-radius: 11px !important;
            padding: 9px !important;
            margin: 8px 0 !important;
        }
        #custom-hunts-filter-bar select {
            min-height: 34px;
            border-radius: 8px !important;
            box-shadow: none !important;
        }
        #simple-hunts-container .script-type-badge { color:#fff !important; border:1px solid rgba(255,255,255,.22) !important; font-weight:900 !important; text-shadow:0 1px 2px rgba(0,0,0,.7) !important; }
        #simple-hunts-container .script-type-normal{background:#718096!important}.script-type-fire{background:#e53e3e!important}.script-type-water{background:#3182ce!important}
        #simple-hunts-container .script-type-electric{background:#d69e2e!important;color:#161b22!important}.script-type-grass{background:#38a169!important}.script-type-ice{background:#38b2ac!important}
        #simple-hunts-container .script-type-fighting{background:#c05621!important}.script-type-poison{background:#805ad5!important}.script-type-ground{background:#975a16!important}
        #simple-hunts-container .script-type-flying{background:#63b3ed!important}.script-type-psychic{background:#d53f8c!important}.script-type-bug{background:#68a819!important}
        #simple-hunts-container .script-type-rock{background:#8b6b3f!important}.script-type-ghost{background:#553c9a!important}.script-type-dragon{background:#6b46c1!important}
        #simple-hunts-container .script-type-dark{background:#2d3748!important}.script-type-steel{background:#a0aec0!important;color:#161b22!important}.script-type-fairy{background:#ed64a6!important}
        #simple-hunts-container .script-effectiveness { font-size:12px!important;font-weight:950!important;padding:4px 9px!important;border-radius:999px!important;border:1px solid currentColor!important; }
        #simple-hunts-container .script-effectiveness.great { color:#9cffb2!important;background:#123d25!important;box-shadow:0 0 9px rgba(72,187,120,.55)!important; }
        #simple-hunts-container .script-effectiveness.neutral { color:#cbd5e0!important;background:#293746!important; }
        #simple-hunts-container .script-effectiveness.bad { color:#ff9b9b!important;background:#481d24!important;box-shadow:0 0 8px rgba(245,101,101,.4)!important; }
        #simple-hunts-container {
            flex: 1 !important;
            max-height: none !important;
            min-height: 0 !important;
            padding: 4px 5px 4px 2px !important;
            margin-top: 0 !important;
            background: transparent !important;
            border: 0 !important;
            border-radius: 12px !important;
            scrollbar-color: #315269 transparent;
        }
        #simple-hunts-container > div {
            border-radius: 10px !important;
            margin-bottom: 7px !important;
            box-shadow: inset 0 0 0 1px rgba(85,125,151,.12);
            transition: background .15s ease, transform .15s ease, opacity .15s ease;
        }
        #simple-hunts-container > div:hover {
            background-color: #172a37 !important;
            transform: translateX(2px);
        }
        #simple-hunts-container > div > div:first-child {
            border-radius: 50% !important;
        }
        #simple-hunts-container [style*="text-transform: uppercase"] {
            background: transparent !important;
            border: 1px solid #304657;
            color: #8fa6b8 !important;
            padding: 1px 4px !important;
            opacity: .85;
        }

        /* Mapa mejorado: filtros agrupados y destinos en tarjetas */
        .map-window { width:min(980px,96vw) !important;height:min(790px,94vh) !important;background:linear-gradient(145deg,#0c141a,#060a0d) !important;border:2px solid #785a28 !important; }
        .map-window .map-body { padding:0 12px 12px !important;background:linear-gradient(#0a1116,#070c10) !important; }
        .map-window .script-city-area { min-width:112px !important;min-height:38px !important;padding:7px 14px !important;background:linear-gradient(#18242b,#0d151a) !important;border-color:#4d452e !important;color:#d7e2e8 !important; }
        .map-window .script-city-area.on { color:#171006 !important;background:linear-gradient(#e1c578,#ae8435) !important;border-color:#e3c268 !important;box-shadow:0 0 12px #d5aa4938 !important; }
        #custom-hunts-filter-bar { display:block !important;margin:8px 0 7px !important;padding:10px !important;background:linear-gradient(145deg,#111d24,#091116) !important;border:1px solid #384533 !important;border-left:3px solid #c89e43 !important;border-radius:10px !important;box-shadow:0 5px 15px #0007; }
        .script-map-filter-head { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid #263a45; }
        .script-map-filter-head-actions { display:flex;align-items:center;justify-content:flex-end;gap:8px; }
        .script-map-filter-toggle { min-height:27px;padding:4px 9px;background:#101920;border:1px solid #4d4938;border-radius:6px;color:#d8c79f;font:800 9px var(--piw-game-font);cursor:pointer;white-space:nowrap; }
        .script-map-filter-toggle:hover { color:#fff0c9;border-color:#a47e34;background:#19232a; }
        .script-map-filter-content { display:block; }
        #custom-hunts-filter-bar.collapsed { padding-bottom:7px !important; }
        #custom-hunts-filter-bar.collapsed .script-map-filter-head { margin-bottom:0;padding-bottom:0;border-bottom:0; }
        #custom-hunts-filter-bar.collapsed .script-map-filter-content { display:none; }
        .script-map-filter-title { display:flex;align-items:center;gap:8px;min-width:0; }
        .script-map-filter-title > span { display:grid;place-items:center;width:29px;height:29px;flex:none;background:#071017;border:1px solid #65522c;border-radius:7px;font-size:15px; }
        .script-map-filter-title b { display:block;color:#eee1c6;font-size:12px; }
        .script-map-filter-title small { display:block;margin-top:2px;color:#718a99;font-size:9px; }
        .script-map-result-count { color:#d8bb71;font-size:9px;font-weight:800;white-space:nowrap; }
        .script-map-filter-grid { display:grid;grid-template-columns:minmax(180px,1.35fr) repeat(4,minmax(108px,1fr)) auto;gap:7px;align-items:end; }
        .script-map-field { display:flex;flex-direction:column;gap:4px;min-width:0;color:#6f8999;font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase; }
        .script-map-field input,.script-map-field select { box-sizing:border-box;width:100%;min-height:34px !important;padding:6px 9px !important;background:#071017 !important;border:1px solid #2d4655 !important;border-radius:7px !important;color:#dce7ec !important;font:600 11px var(--piw-game-font) !important;outline:none; }
        .script-map-field input:focus,.script-map-field select:focus { border-color:#b58b39 !important;box-shadow:0 0 0 2px #b58b3926 !important; }
        .script-map-level-range { display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:5px; }
        .script-map-level-range input { min-width:0;appearance:textfield; }
        .script-map-level-range input::-webkit-inner-spin-button,.script-map-level-range input::-webkit-outer-spin-button { appearance:none;margin:0; }
        .script-map-filter-actions { display:flex;gap:6px;align-items:center; }
        #reset-hunts-filters { min-height:34px;padding:6px 10px;border-radius:7px;font:800 10px var(--piw-game-font);cursor:pointer;white-space:nowrap; }
        #reset-hunts-filters { background:#101920;color:#91a6b3;border:1px solid #354a56; }
        #reset-hunts-filters:hover { color:#f2dfb4;border-color:#8a6a2f;background:#192128; }
        #custom-hunts-capture-bar { display:flex;align-items:center;gap:6px;margin:8px 0 0 !important;padding:8px 0 0 !important;border-top:1px solid #263943 !important; }
        #custom-hunts-capture-bar::before { content:"CAPTURA";margin-right:3px;color:#607b8b;font-size:8px;font-weight:900;letter-spacing:.1em; }
        #custom-hunts-capture-bar .dex-fbtn { min-height:26px;padding:4px 9px;background:#081016;color:#8499a6;border:1px solid #2b414e;border-radius:999px;font-size:9px;font-weight:800;cursor:pointer; }
        #custom-hunts-capture-bar .dex-fbtn.on { color:#10150d;background:linear-gradient(#9ed976,#69ad4d);border-color:#aee689;box-shadow:0 0 8px #7bc45e35; }
        #simple-hunts-container.script-map-card-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:9px;padding:3px 5px 4px 2px !important; }
        #simple-hunts-container.script-map-card-grid > .script-map-card { --card-accent:#38596b;position:relative;box-sizing:border-box;display:grid !important;grid-template-columns:68px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:132px;margin:0 !important;padding:11px !important;background:linear-gradient(145deg,color-mix(in srgb,var(--card-accent) 13%,#101a20),#080e12 72%) !important;border:1px solid color-mix(in srgb,var(--card-accent) 64%,#253a46);border-left:3px solid var(--card-accent) !important;border-radius:10px !important;color:#dce6eb;cursor:pointer;overflow:hidden;box-shadow:inset 0 1px #ffffff08,0 4px 12px #0007;transition:border-color .16s,transform .16s,box-shadow .16s !important; }
        #simple-hunts-container.script-map-card-grid > .script-map-card::after { content:"";position:absolute;inset:-55% auto -55% -35%;width:24%;background:linear-gradient(100deg,transparent,#ffffff12,transparent);transform:skewX(-18deg);transition:left .45s ease;pointer-events:none; }
        #simple-hunts-container.script-map-card-grid > .script-map-card:hover { transform:translateY(-2px) !important;border-color:color-mix(in srgb,var(--card-accent) 82%,#d9bd73) !important;box-shadow:inset 0 1px #ffffff10,0 7px 18px #000a !important; }
        #simple-hunts-container.script-map-card-grid > .script-map-card:hover::after { left:125%; }
        .script-map-card.is-here { --card-accent:#49bd72 !important; }
        .script-map-card.is-favorite { --card-accent:#d1a646 !important; }
        .script-map-card.is-locked { --card-accent:#c4545f !important;opacity:.76;cursor:not-allowed !important; }
        .script-map-card.is-city { --card-accent:#d29e3e !important;min-height:145px !important; }
        #simple-hunts-container .script-map-card-art { width:64px !important;height:64px !important;min-width:64px !important;display:flex;align-items:center;justify-content:center;margin:0 !important;background:radial-gradient(circle,#1e3440,#071016 72%) !important;border:1px solid color-mix(in srgb,var(--card-accent) 55%,#294553);border-radius:10px !important;overflow:hidden;box-shadow:inset 0 0 13px #0009; }
        .script-map-card-art > div:not(.script-city-npc-sprite) { transform:scale(1.18);image-rendering:pixelated; }
        .script-city-npc-sprite { width:64px;height:64px;background-repeat:no-repeat;image-rendering:pixelated;filter:drop-shadow(0 4px 4px #000b); }
        .script-city-npc-fallback { color:#d8b35d;font-size:27px; }
        .script-map-card-info { min-width:0;margin:0 !important;align-self:stretch;display:flex;flex-direction:column;justify-content:center; }
        .script-map-kind { color:var(--card-accent);font-size:8px;font-weight:950;letter-spacing:.11em;text-transform:uppercase; }
        .script-map-card-title { display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:3px 0 5px;color:#f1e6cd;font-size:14px;font-weight:950;line-height:1.15; }
        .script-map-level { padding:2px 6px;background:#15252e;border:1px solid #304957;border-radius:999px;color:#a9bfca;font-size:9px;font-weight:850; }
        .script-map-badges { display:flex;align-items:center;gap:4px;flex-wrap:wrap; }
        .script-map-meta { display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px;padding-top:6px;border-top:1px solid #263842;color:#7691a0;font-size:9px; }
        .script-map-meta strong { color:#d7e1e6;font-size:10px; }
        .script-map-meta .map-value { color:#67d98b; }.script-map-meta .map-xp { color:#eea653; }
        .script-map-city-copy { color:#7f98a7;font-size:10px;line-height:1.4; }
        .script-map-city-copy strong { color:#6ed990; }
        .script-map-card-actions { align-self:stretch;display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:7px; }
        .script-map-fav { background:transparent;border:0;color:#526a77;font-size:20px;cursor:pointer;padding:0 3px; }.script-map-fav.on{color:#f1c85f;}
        .script-map-travel { min-width:54px;min-height:28px;padding:5px 9px;background:linear-gradient(#d8b85f,#a97d2d);border:1px solid #d9bb69;border-radius:7px;color:#181106;font:900 10px var(--piw-game-font);cursor:pointer;box-shadow:0 2px 5px #0008; }
        .script-map-travel:hover { filter:brightness(1.12); }.script-map-card.is-locked .script-map-travel{background:#151c20;border-color:#495861;color:#84939a;}
        @media (max-width:760px) { .script-map-filter-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.script-map-field:first-child{grid-column:1/-1;}.script-map-filter-actions{grid-column:1/-1;}#simple-hunts-container.script-map-card-grid{grid-template-columns:1fr;} }

        .mod-disabled {
            opacity: 0.35 !important;
            pointer-events: none !important;
            filter: grayscale(100%);
        }

        .mk-lock-sell { font-size: 14px; background: none; border: none; cursor: pointer; margin-left: 6px; padding: 2px; }
        .mk-lock-sell:hover { opacity: 0.8; }
        .mk-srow-head.locked { opacity: 0.6; }
        .mk-bulk-controls { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }
        .mk-bulk-btn { background: #14222d; color: #63b3ed; border: 1px solid #273f52; border-radius: 4px; padding: 3px 7px; font-size: 11px; font-weight: bold; cursor: pointer; }
        .mk-bulk-btn:hover { background: #1a365d; border-color: #3182ce; color: #fff; }
        .hunt-sell-list { max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
        .hunt-sell-row { display: grid; grid-template-columns: auto 1fr 80px; align-items: center; gap: 8px; background: #14222d; border: 1px solid #1a2d3a; border-radius: 5px; padding: 7px 9px; }
        .hunt-sell-row[hidden] { display: none !important; }
        .hunt-sell-row input[type="number"] { width: 100%; box-sizing: border-box; background: #0c161f; color: #e2e8f0; border: 1px solid #273f52; border-radius: 4px; padding: 5px; }
        .hunt-sell-row.protected { opacity: 0.45; }
        .hunt-sell-backdrop { background:rgba(0,0,0,.72) !important;backdrop-filter:blur(2px); }
        .hunt-sell-backdrop .script-npc-sell-window { display:flex;flex-direction:column;max-height:90vh;background:linear-gradient(145deg,#0d141a,#070b0f) !important;border:2px solid #785a28 !important;border-radius:11px !important;box-shadow:0 18px 55px #000d,inset 0 0 0 1px #d5b36612 !important;overflow:hidden; }
        .hunt-sell-backdrop .script-npc-sell-window .sell-confirm-title { flex:none;min-height:52px;padding:10px 14px !important;background:linear-gradient(180deg,#151c22,#0b1116) !important;border-bottom:1px solid #745725 !important;box-shadow:0 3px 12px #0008; }
        .hunt-sell-backdrop .script-npc-sell-window .sell-confirm-body { display:flex;flex-direction:column;min-height:0;padding:12px !important; }
        .hunt-sell-backdrop .hunt-sell-close { color:#a9b7c1 !important;transition:color .15s,transform .15s; }
        .hunt-sell-backdrop .hunt-sell-close:hover { color:#f2d892 !important;transform:scale(1.08); }
        .hunt-sell-backdrop .hunt-pokemon-open,.hunt-sell-backdrop .hunt-items-open { min-height:29px;padding:5px 11px !important;background:linear-gradient(#29333a,#151d22) !important;border-color:#65532e !important;color:#eadfc8 !important; }
        .hunt-sell-backdrop .hunt-sell-status { flex:none;margin-bottom:9px;padding:8px 12px !important;background:#071017;border:1px solid #28404e;border-radius:8px;color:#86a2b4 !important;font-size:12px;text-align:left !important; }
        .hunt-sell-backdrop .hunt-sell-list { flex:1;min-height:0;max-height:none;margin:0;padding:2px 4px 8px 2px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:8px;overflow-y:auto; }
        .hunt-sell-backdrop .hunt-sell-row { position:relative;box-sizing:border-box;display:grid !important;grid-template-columns:auto 52px minmax(0,1fr) 88px 34px !important;gap:9px !important;align-items:center;min-height:86px;padding:9px 10px !important;background:linear-gradient(145deg,#101b22,#091116) !important;border:1px solid #263d4b !important;border-radius:9px !important;color:#dfe8ed;box-shadow:inset 0 1px #ffffff08,0 3px 9px #0006;cursor:pointer;overflow:hidden;transition:border-color .15s,background .15s,transform .15s; }
        .hunt-sell-backdrop .hunt-sell-row:hover { background:linear-gradient(145deg,#14242e,#0c151b) !important;border-color:#8b6b31 !important;transform:translateY(-1px); }
        .hunt-sell-backdrop .hunt-sell-row:has(input[type="checkbox"]:checked) { border-color:#d2aa50 !important;box-shadow:inset 3px 0 #d2aa50,0 4px 12px #0008; }
        .hunt-sell-backdrop .hunt-sell-row[hidden] { display:none !important; }
        .hunt-sell-backdrop .hunt-sell-art { width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,#1b303d,#080e13 72%);border:1px solid #294554;border-radius:8px;overflow:hidden; }
        .hunt-sell-backdrop .hunt-sell-art img { width:88%;height:88%;object-fit:contain;filter:drop-shadow(0 3px 4px #000b); }
        .hunt-sell-backdrop .hunt-sell-info { min-width:0; }
        .hunt-sell-backdrop .hunt-sell-kind { display:block;color:#68899d;font-size:8px;font-weight:850;letter-spacing:.09em;text-transform:uppercase;margin-bottom:3px; }
        .hunt-sell-backdrop .hunt-sell-name { display:block;color:#f0e5cb;font-size:13px;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .hunt-sell-backdrop .hunt-sell-meta { display:block;color:#7fa0b2;font-size:10px;margin-top:4px;line-height:1.3; }
        .hunt-sell-backdrop .hunt-sell-price { color:#65d887;font-size:12px;font-weight:900;white-space:nowrap; }
        .hunt-sell-backdrop .hunt-sell-row input[type="number"] { min-height:30px;background:#071017 !important;border-color:#334957 !important;color:#e4edf2 !important; }
        .hunt-sell-backdrop .mk-lock { width:30px;height:30px;padding:3px !important;background:#090f13 !important;border:1px solid #354550 !important;border-radius:6px; }
        .hunt-sell-backdrop .sell-confirm-footer { flex:none;display:grid !important;grid-template-columns:1fr 1.25fr 1fr;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid #26343d; }
        .hunt-sell-backdrop .sell-confirm-footer[style*="display:none"] { display:none !important; }
        .hunt-sell-backdrop .sell-confirm-footer button { min-height:36px; }
        .hunt-pokemon-filters { flex:none;padding:9px !important;background:linear-gradient(145deg,#101a21,#0a1116);border:1px solid #263945;border-radius:8px; }
        .hunt-quality-tiers { flex:1 0 100%;display:flex;flex-wrap:wrap;gap:5px;padding-top:3px; }
        .hunt-quality-tier { padding:3px 8px;border:1px solid var(--tier-color);border-radius:999px;background:#070c10;color:var(--tier-color);font-size:9px;font-weight:900;cursor:pointer;opacity:.42; }
        .hunt-quality-tier.on { opacity:1;background:color-mix(in srgb,var(--tier-color) 14%,#070c10);box-shadow:0 0 8px color-mix(in srgb,var(--tier-color) 28%,transparent); }
        .hunt-quality-tier-shortcut { padding:3px 8px;border:1px solid #42535d;border-radius:5px;background:#10191f;color:#afc0c8;font-size:9px;font-weight:900;cursor:pointer; }
        .hunt-quality-tier-shortcut:hover { color:#f1dfb7;border-color:#9b7939; }
        .hunt-sell-backdrop .npc-pokemon-row { grid-template-columns:auto 58px minmax(0,1fr) 92px 34px !important;min-height:112px; }
        .hunt-sell-backdrop .npc-pokemon-row .hunt-sell-art { width:54px;height:54px;border-color:color-mix(in srgb,var(--tier-color) 55%,#294554); }
        .hunt-sell-backdrop .npc-pokemon-row { border-color:color-mix(in srgb,var(--tier-color) 52%,#263d4b) !important;background:linear-gradient(145deg,color-mix(in srgb,var(--tier-color) 10%,#101b22),#091116 75%) !important; }
        .hunt-sell-backdrop .npc-pokemon-row .hunt-sell-kind { color:var(--tier-color); }
        .hunt-sell-backdrop .npc-pokemon-row .market-stats { margin-top:5px; }
        @media (max-width:800px) {
            .hunt-sell-backdrop .hunt-sell-list { grid-template-columns:1fr; }
        }

        .sell-confirm-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 10150; display: flex; align-items: center; justify-content: center; }
        .sell-confirm-modal { background: #0c161f; border: 1px solid #273f52; border-radius: 8px; padding: 0; color: #e2e8f0; width: 320px; box-shadow: 0 12px 32px rgba(0,0,0,0.8); overflow: hidden; }
        .sell-confirm-title { background: #14222d; border-bottom: 1px solid #273f52; padding: 12px 16px; font-size: 15px; font-weight: bold; color: #63b3ed; display: flex; align-items: center; gap: 8px; }
        .sell-confirm-body { padding: 16px; }
        .sell-confirm-body p { color: #a0aec0; font-size: 13px; margin: 0 0 10px 0; }
        .sell-confirm-items { background: #14222d; border: 1px solid #1a2d3a; border-radius: 6px; padding: 8px 12px; margin-bottom: 16px; max-height: 100px; overflow-y: auto; }
        .sell-confirm-items div { color: #ffcc00; font-weight: bold; font-size: 13px; padding: 2px 0; }
        .sell-confirm-footer { display: flex; gap: 8px; }
        .sell-confirm-btn { flex: 1; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 13px; transition: background 0.15s; }
        .sell-confirm-btn.yes { background: #48bb78; color: #fff; }
        .sell-confirm-btn.yes:hover { background: #38a169; }
        .sell-confirm-btn.no { background: #2b4c66; color: #e2e8f0; border: 1px solid #273f52; }
        .sell-confirm-btn.no:hover { background: #3182ce; }
        .script-dialog-backdrop { background:rgba(1,5,9,.76) !important;backdrop-filter:blur(4px) !important;padding:12px;animation:script-dialog-fade .16s ease-out; }
        .script-dialog-modal { width:min(500px,94vw) !important;background:linear-gradient(150deg,#111b23,#080e13 72%) !important;border:1px solid #8f6c2d !important;border-radius:12px !important;box-shadow:0 22px 65px #000e,0 0 0 1px #d4ad5722,inset 0 1px #fff1 !important;overflow:hidden;animation:script-dialog-rise .18s ease-out; }
        .script-dialog-modal .sell-confirm-title { min-height:54px;padding:10px 13px !important;display:flex;align-items:center;gap:10px;background:linear-gradient(90deg,#131d24,#0a1116) !important;border-bottom:1px solid #58451f !important;font-size:15px !important; }
        .script-dialog-title-icon { flex:none;width:31px;height:31px;display:grid;place-items:center;background:radial-gradient(circle,#263b47,#0b151b 72%);border:1px solid #5c7988;border-radius:8px;box-shadow:inset 0 1px #ffffff12;font-size:16px; }
        .script-dialog-title-text { min-width:0;display:grid;gap:2px; }
        .script-dialog-title-text b { color:#f1e5ca;font-size:14px; }
        .script-dialog-title-text small { color:#6f8998;font-size:8px;font-weight:850;letter-spacing:.08em;text-transform:uppercase; }
        .script-dialog-modal .sell-confirm-body { padding:13px !important; }
        .script-dialog-lead { margin:0 0 10px;padding:10px 11px;color:#d6e1e7;background:#0c171e;border:1px solid #263d49;border-radius:8px;font-size:11px;line-height:1.45; }
        .script-dialog-summary { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-bottom:12px; }
        .script-dialog-summary-row { min-width:0;padding:8px;background:#091319;border:1px solid #263d49;border-radius:8px;box-shadow:inset 0 1px #ffffff07; }
        .script-dialog-summary-row span { display:block;color:#758d9c;font-size:7px;font-weight:900;letter-spacing:.06em;text-transform:uppercase; }
        .script-dialog-summary-row b { display:block;margin-top:4px;color:#dce9ee;font-size:11px;line-height:1.25;overflow-wrap:anywhere; }
        .script-dialog-summary-row:nth-child(1) { border-color:#285a70; }.script-dialog-summary-row:nth-child(1) b{color:#70d4f3}
        .script-dialog-summary-row:nth-child(2) { border-color:#695126; }.script-dialog-summary-row:nth-child(2) b{color:#efbc5f}
        .script-dialog-summary-row:nth-child(3) { border-color:#276443; }.script-dialog-summary-row:nth-child(3) b{color:#6ee29a}
        .script-dialog-modal .sell-confirm-items { max-height:180px;margin-bottom:12px;padding:9px 11px;background:#091319;border-color:#263d49;border-radius:8px; }
        .script-dialog-modal .sell-confirm-footer { display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:9px;padding-top:11px;border-top:1px solid #26343d; }
        .script-dialog-modal .sell-confirm-btn { min-height:38px;padding:8px 12px;border-radius:8px;font-family:var(--piw-game-font);font-size:11px;font-weight:900;box-shadow:0 3px 9px #0008; }
        .script-dialog-modal .sell-confirm-btn.no { color:#cbd6dc;background:linear-gradient(#19242c,#10181e);border:1px solid #3a4b56; }
        .script-dialog-modal .sell-confirm-btn.no:hover { color:#fff;background:linear-gradient(#24333d,#17232b);border-color:#657985; }
        .script-dialog-modal .sell-confirm-btn:disabled { filter:grayscale(.7);opacity:.48;cursor:not-allowed; }
        .script-dialog-notice.is-error { border-color:#963b47 !important;box-shadow:0 22px 65px #000e,0 0 18px #e33b4b25 !important; }
        @keyframes script-dialog-fade { from{opacity:0}to{opacity:1} }
        @keyframes script-dialog-rise { from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none} }
        @media (max-width:520px) { .script-dialog-summary{grid-template-columns:1fr}.script-dialog-modal .sell-confirm-footer{grid-template-columns:1fr}.script-dialog-modal .sell-confirm-btn.yes{order:1}.script-dialog-modal .sell-confirm-btn.no{order:2} }

        /* Native game window theme for every window created by the extension. */
        .sell-confirm-backdrop, .script-market-backdrop, .portable-ball-backdrop {
            background: rgba(0, 0, 0, .62) !important;
            backdrop-filter: blur(1px);
        }
        .sell-confirm-modal, .script-market-window, .script-portable-ball-window, .ha-compare-modal {
            background: linear-gradient(rgba(16, 24, 35, .99), rgba(9, 14, 21, .99)) !important;
            color: rgb(233, 226, 208) !important;
            border: 2px solid rgb(120, 90, 40) !important;
            border-radius: 10px !important;
            box-shadow: 0 12px 40px rgba(0, 0, 0, .7) !important;
            font-family: var(--piw-game-font) !important;
        }
        .sell-confirm-title,
        .script-market-window .cfg-title,
        .script-portable-ball-window .ball-head,
        .ha-compare-modal .ha-title {
            min-height: 47px;
            box-sizing: border-box;
            padding: 12px 14px 8px !important;
            background: transparent !important;
            border-bottom: 1px solid rgba(200, 170, 110, .16) !important;
            color: rgb(240, 230, 210) !important;
            font-family: var(--piw-game-font) !important;
            font-size: 17px !important;
            font-weight: 700 !important;
        }
        .sell-confirm-body { background: transparent !important; color: rgb(233, 226, 208) !important; }
        .sell-confirm-body p { color: rgb(174, 181, 188) !important; }
        .sell-confirm-modal input, .sell-confirm-modal select,
        .script-market-window input, .script-market-window select,
        .script-portable-ball-window input, .script-portable-ball-window select,
        .ha-compare-modal input, .ha-compare-modal select {
            box-sizing: border-box;
            min-height: 28px;
            background: rgba(8, 15, 22, .8) !important;
            color: rgb(230, 237, 243) !important;
            border: 1px solid rgb(58, 74, 92) !important;
            border-radius: 6px !important;
            padding: 5px 8px !important;
            font: 400 12px var(--piw-game-font) !important;
            outline: none;
        }
        .sell-confirm-modal input:focus, .sell-confirm-modal select:focus,
        .script-market-window input:focus, .script-market-window select:focus,
        .script-portable-ball-window input:focus, .script-portable-ball-window select:focus {
            border-color: rgb(200, 162, 78) !important;
            box-shadow: 0 0 0 2px rgba(200, 162, 78, .15) !important;
        }
        .sell-confirm-btn.yes, .portable-depot-clear-filters,
        .script-market-window .market-refresh, .script-portable-ball-window .mk-buy-btn {
            background: linear-gradient(rgb(230, 205, 142), rgb(200, 162, 78)) !important;
            color: rgb(26, 18, 6) !important;
            border: 1px solid rgb(106, 82, 35) !important;
            border-radius: 8px !important;
            font-weight: 800 !important;
        }
        .sell-confirm-btn.yes:hover, .portable-depot-clear-filters:hover,
        .script-market-window .market-refresh:hover, .script-portable-ball-window .mk-buy-btn:hover {
            filter: brightness(1.08);
        }
        .script-market-window .market-tab.on { background: linear-gradient(#d8b86b,#9c762f) !important; color:#171006 !important; }
        #dock-btn-shops { position:relative; }
        .market-sale-dock-badge { position:absolute;right:0;top:0;z-index:10;min-width:13px;height:13px;box-sizing:border-box;display:grid;place-items:center;padding:0 2px;color:#fff;background:linear-gradient(#ff5269,#d91435);border:1px solid #ffc0c9;border-radius:999px;box-shadow:0 0 0 1px #4b0712,0 0 7px #ff294bcc;text-shadow:0 1px #740012;font-size:7px;font-weight:1000;line-height:1;pointer-events:none; }
        .market-alert-dock-badge { position:absolute;right:-3px;top:13px;z-index:11;min-width:13px;height:13px;box-sizing:border-box;display:grid;place-items:center;padding:0 2px;color:#e7fbff;background:linear-gradient(#46d8ff,#1285cf);border:1px solid #b5f5ff;border-radius:999px;box-shadow:0 0 0 1px #073c69,0 0 7px #24c8ffcc;text-shadow:0 1px #07507e;font-size:7px;font-weight:1000;line-height:1;pointer-events:none; }
        .market-sale-toast { position:fixed;left:50%;top:18px;z-index:2147483647;max-width:min(520px,92vw);display:grid;grid-template-columns:23px auto;grid-template-areas:"icon title" "icon meta";column-gap:8px;padding:8px 14px;color:#dfffea;background:linear-gradient(90deg,#092117f2,#0b171df2);border:1px solid #3ed47a;border-radius:7px;box-shadow:0 8px 24px #000b,0 0 14px #31d87640;opacity:0;transform:translate(-50%,-16px);transition:opacity .18s,transform .18s;pointer-events:none; }
        .market-sale-toast.show { opacity:1;transform:translate(-50%,0); }
        .market-sale-toast > span { grid-area:icon;align-self:center;display:grid;place-items:center;width:22px;height:22px;color:#06150c;background:#53e18a;border-radius:50%;font-weight:1000; }
        .market-sale-toast > b { grid-area:title;color:#75efa3;font-size:11px; }
        .market-sale-toast > small { grid-area:meta;color:#c4d8df;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .market-alert-toast { position:fixed;left:50%;top:72px;z-index:2147483647;max-width:min(520px,92vw);display:grid;grid-template-columns:23px auto;grid-template-areas:"icon title" "icon meta";column-gap:8px;padding:8px 14px;color:#e4f8ff;background:linear-gradient(90deg,#082532f2,#0b171df2);border:1px solid #46c4e8;border-radius:7px;box-shadow:0 8px 24px #000b,0 0 14px #32c8f040;opacity:0;transform:translate(-50%,-16px);transition:opacity .18s,transform .18s;pointer-events:none; }
        .market-alert-toast.show { opacity:1;transform:translate(-50%,0); }
        .market-alert-toast > span { grid-area:icon;align-self:center;display:grid;place-items:center;width:22px;height:22px;color:#06202a;background:#63d9fa;border-radius:50%;font-weight:1000; }
        .market-alert-toast > b { grid-area:title;color:#8feaff;font-size:11px; }
        .market-alert-toast > small { grid-area:meta;color:#c4d8df;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .market-alert-controls { position:relative;display:none;margin:8px 12px 0;padding:10px;background:linear-gradient(145deg,#101a21,#0a1116);border:1px solid #2b5364;border-radius:8px;box-shadow:inset 0 1px #ffffff08,0 3px 10px #0005; }
        .market-alert-controls.visible { display:block;z-index:100; }
        .market-alert-heading { display:flex;align-items:center;justify-content:space-between;gap:7px;margin-bottom:8px;color:#9ceaff;font-size:11px;font-weight:900;text-transform:uppercase; }
        .market-alert-rules-toggle { display:flex;align-items:center;gap:5px;padding:5px 7px;color:#bdefff;background:#0a2029;border:1px solid #36798e;border-radius:5px;cursor:pointer;font-size:9px;font-weight:900;text-transform:uppercase; }
        .market-alert-paste { padding:5px 7px;color:#d7f8ff;background:#12313c;border:1px solid #4ba7ba;border-radius:5px;cursor:pointer;font-size:9px;font-weight:900;text-transform:uppercase; }
        .market-telegram-toggle { padding:5px 7px;color:#bdefff;background:#163a61;border:1px solid #3d8fd0;border-radius:5px;cursor:pointer;font-size:9px;font-weight:900;text-transform:uppercase; }
        .market-alert-rules-count { min-width:16px;padding:1px 4px;color:#09202a;background:#69dffb;border-radius:999px;text-align:center;font-size:9px; }
        .market-alert-auto-buy { display:flex;align-items:center;gap:5px;padding:4px 7px;color:#9ceaff;background:#0a2029;border:1px solid #36798e;border-radius:5px;font-size:9px;font-weight:900;text-transform:uppercase;cursor:pointer; }
        .market-alert-auto-buy input { accent-color:#4ed6fb; }
        .market-alert-form { display:flex;gap:6px;flex-wrap:wrap;align-items:center; }
        .market-alert-kind-tabs,.market-alert-rules-tabs { display:flex;align-items:center;gap:4px; }
        .market-alert-kind-tab,.market-alert-rules-tab { padding:4px 7px;color:#8fa9b7;background:#0b1820;border:1px solid #2b5061;border-radius:5px;cursor:pointer;font-size:9px;font-weight:900;text-transform:uppercase; }
        .market-alert-kind-tab.on,.market-alert-rules-tab.on { color:#fff0a6;background:#312713;border-color:#d0a83f; }
        .market-alert-item-form[hidden],.market-alert-pokemon-form[hidden] { display:none !important; }
        .market-alert-form input,.market-alert-form select { min-height:31px;box-sizing:border-box;color:#e2e8f0;background:#071018;border:1px solid #2b5061;border-radius:5px;padding:6px 8px; }
        .market-alert-form input[type="search"] { flex:1;min-width:150px; }
        .market-alert-form input[type="number"] { width:82px; }
        .market-alert-form label { display:flex;align-items:center;gap:5px;color:#a9c7d9;font-size:11px;white-space:nowrap; }
        .market-alert-tiers { display:flex !important;align-items:center;gap:5px;flex-wrap:wrap;margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid #203946; }
        .market-alert-tiers .market-sell-tier-buttons { flex:1 1 430px; }
        .market-alert-price-field { display:grid !important;gap:2px !important;align-items:start !important; }
        .market-alert-price-field small { min-height:11px;color:#79c9a0;font-size:8px;font-weight:800;line-height:11px;text-align:center;white-space:nowrap; }
        .script-market-window { position:relative; }
        .market-alert-rules-panel { position:absolute;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;background:rgba(1,6,11,.84);backdrop-filter:blur(5px); }
        .market-alert-rules-panel[hidden] { display:none !important; }
        .market-alert-rules-dialog { width:min(860px,100%);max-width:100%;max-height:calc(100% - 2px);display:flex;flex-direction:column;overflow:hidden;background:linear-gradient(145deg,#101d27,#071017 72%);border:1px solid #4b9db7;border-radius:15px;box-shadow:0 24px 80px #000e,0 0 0 1px #8beaff1c,inset 0 1px #ffffff12;animation:market-alert-dialog-in .2s ease-out; }
        @keyframes market-alert-dialog-in { from { opacity:0;transform:translateY(12px) scale(.97); } to { opacity:1;transform:none; } }
        .market-alert-rules-panel-head { display:flex;align-items:center;gap:12px;justify-content:space-between;padding:17px 20px 14px;margin:0;color:#dff8ff;font-size:13px;text-transform:uppercase;background:linear-gradient(180deg,#152a35,#0c1820);border-bottom:1px solid #285267; }
        .market-alert-rules-panel-head > b { display:flex;align-items:center;gap:8px;letter-spacing:.06em; }
        .market-alert-rules-panel-head > b::before { content:'🔔';font-size:17px;filter:drop-shadow(0 0 7px #5bdcff99); }
        .market-alert-rules-actions { display:flex;align-items:center;gap:5px; }
        .market-alert-export,.market-alert-import { padding:4px 6px;color:#bdefff;background:#102a36;border:1px solid #39768a;border-radius:5px;cursor:pointer;font-size:8px;font-weight:900;text-transform:uppercase; }
        .market-alert-transfer-panel { position:absolute;z-index:1004;top:42px;right:9px;width:min(520px,calc(100% - 18px));display:grid;gap:7px;padding:10px;background:#0a151c;border:1px solid #4ba7ba;border-radius:8px;box-shadow:0 15px 32px #000c; }
        .market-alert-transfer-panel[hidden] { display:none !important; }
        .market-alert-transfer-title { color:#9ceaff;font-size:10px;font-weight:900;text-transform:uppercase; }
        .market-alert-transfer-help { color:#a9c7d9;font-size:10px;line-height:1.35; }
        .market-alert-transfer-data { width:100%;height:130px;box-sizing:border-box;resize:vertical;color:#e7f6ff;background:#071018;border:1px solid #2b5061;border-radius:5px;padding:7px;font:10px/1.35 monospace; }
        .market-alert-transfer-actions { display:flex;justify-content:flex-end;gap:6px; }
        .market-alert-rules-close { width:32px;height:32px;padding:0;color:#cce8f1;background:#162630;border:1px solid #406573;border-radius:8px;cursor:pointer;font-size:19px;line-height:1;transition:.15s; }
        .market-alert-rules-close:hover { color:#fff;background:#284555;border-color:#83dff6;transform:scale(1.04); }
        .market-alert-clear-all { padding:7px 10px;color:#ffbec8;background:#2b151d;border:1px solid #9b4654;border-radius:7px;cursor:pointer;font-size:9px;font-weight:900;text-transform:uppercase; }
        .market-alert-clear-all:hover { color:#fff;background:#51232d;border-color:#ff8292; }
        .market-telegram-panel { position:absolute;z-index:1002;top:42px;right:9px;width:min(420px,calc(100% - 18px));display:grid;gap:8px;padding:10px;background:#0a151c;border:1px solid #3d8fd0;border-radius:8px;box-shadow:0 15px 32px #000c; }
        .market-telegram-panel[hidden],.market-alert-rules-panel[hidden] { display:none !important; }
        .market-telegram-panel > label { display:grid;gap:3px;color:#9ccce8;font-size:9px;font-weight:900;text-transform:uppercase; }
        .market-telegram-panel input[type="text"],.market-telegram-panel input[type="password"] { width:100%;min-height:31px;box-sizing:border-box;color:#e7f6ff;background:#071018;border:1px solid #2b5061;border-radius:5px;padding:6px 8px; }
        .market-telegram-panel .market-telegram-enabled { display:flex;align-items:center;gap:5px;color:#bdefff;text-transform:none;cursor:pointer; }
        .market-telegram-panel > div:last-child { display:flex;gap:6px;justify-content:flex-end; }
        .market-alert-rules { display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-content:start;gap:11px;min-height:0;overflow-y:auto;padding:18px 20px 22px;scrollbar-width:thin;scrollbar-color:#397b91 #081219; }
        .market-alert-rules > small { grid-column:1/-1;padding:42px 20px;text-align:center; }
        .market-alert-rules > small::before { content:'🔕';display:block;margin-bottom:8px;font-size:28px;opacity:.8; }
        .market-alert-rule-heading { grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;color:#83dff6;font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase; }
        .market-alert-rule { position:relative;display:grid;grid-template-columns:42px minmax(0,1fr);grid-template-rows:auto auto;gap:10px;padding:13px 13px 11px;background:linear-gradient(145deg,#122430,#09131a);border:1px solid #2e5d70;border-radius:11px;box-shadow:0 6px 16px #0006,inset 0 1px #ffffff0a;transition:.16s; }
        .market-alert-rule:hover { border-color:#62cce8;transform:translateY(-2px);box-shadow:0 10px 23px #0009,0 0 0 1px #62cce822; }
        .market-alert-rule > .market-alert-rule-icon { display:grid;place-items:center;width:42px;height:42px;grid-row:1 / span 2;color:#07151c;background:linear-gradient(145deg,#70e7ff,#2ba8d1);border:1px solid #a8f1ff;border-radius:11px;font-size:20px;box-shadow:0 0 14px #36cbed55; }
        .market-alert-rule > .market-alert-rule-content { min-width:0;display:grid;gap:4px; }
        .market-alert-rule b { color:#f0fbff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .market-alert-rule small { color:#a8c3ce;font-size:9px;line-height:1.45; }
        .market-alert-rule .market-alert-rule-tags { display:flex;flex-wrap:wrap;gap:4px;margin-top:2px; }
        .market-alert-rule .market-alert-tag { padding:3px 6px;color:#bfefff;background:#0b202b;border:1px solid #2e6579;border-radius:999px;font-size:8px;font-weight:900; }
        .market-alert-rule .market-alert-tag.is-auto { color:#a6f5bc;background:#0d2b20;border-color:#3fae72; }
        .market-alert-rule .market-alert-actions { grid-column:1/-1;display:flex;justify-content:flex-end;gap:6px;padding-top:9px;border-top:1px solid #234351; }
        .market-alert-edit,.market-alert-remove,.market-alert-copy { width:auto;min-width:30px;height:28px;padding:0 9px;color:#bfefff;background:#102c3a;border:1px solid #397e98;border-radius:6px;cursor:pointer;font-size:10px;font-weight:900;transition:.15s; }
        .market-alert-edit:hover,.market-alert-copy:hover { color:#fff;background:#1b5268;border-color:#78e2ff; }
        .market-alert-remove { color:#ffbec8;background:#2b151d;border-color:#9b4654; }
        .market-alert-remove:hover { color:#fff;background:#602633;border-color:#ff8292; }
        .market-favorites-bar { display:none;align-items:center;gap:7px;margin:7px 12px 0;padding:7px 9px;background:#0b151c;border:1px solid #263d49;border-radius:8px;overflow-x:auto;flex:none; }
        .market-favorites-bar.has-favorites { display:flex; }
        .market-favorites-label { flex:none;color:#f2c65c;font-size:9px;font-weight:900;text-transform:uppercase; }
        .market-favorite-chip { flex:none;display:flex;align-items:center;gap:5px;max-width:180px;padding:4px 8px;color:#d9e7ed;background:#101e27;border:1px solid #425d6c;border-radius:999px;cursor:pointer;font-size:9px;font-weight:800; }
        .market-favorite-chip:hover,.market-favorite-chip.on { color:#fff0a6;border-color:#d0a83f;background:#282113; }
        .market-favorite-chip img { width:20px;height:20px;object-fit:contain; }
        .market-favorite-toggle { position:absolute !important;right:7px;top:7px;z-index:3 !important;width:25px;height:25px;padding:0 !important;display:grid;place-items:center;color:#738996 !important;background:#091218e8 !important;border:1px solid #314754 !important;border-radius:50% !important;cursor:pointer;font-size:14px !important; }
        .market-favorite-toggle.on { color:#ffd84c !important;border-color:#c69c22 !important;box-shadow:0 0 9px #ffd83b59; }
        .market-featured-toggle { position:absolute !important;right:7px;top:7px;z-index:3 !important;width:27px;height:27px;padding:0 !important;display:grid;place-items:center;color:#738996 !important;background:#091218e8 !important;border:1px solid #314754 !important;border-radius:50% !important;cursor:pointer;font-size:14px !important; }
        .market-featured-toggle.on { color:#8fe8ff !important;border-color:#3fa8c5 !important;background:#0c2630 !important;box-shadow:0 0 9px #53d8ff59; }
        .market-featured-unavailable { opacity:.62;filter:saturate(.55); }
        .market-featured-unavailable::before { background:#a65a62 !important; }
        .market-sell-controls input, .market-sell-controls select { background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 8px;min-width:88px; }
        .market-sell-controls .market-sell-search { flex:1;min-width:180px; }
        .market-sell-controls .market-sell-qty { width:76px; }
        .market-sell-controls .market-sell-price { width:140px; }
        .market-sell-quality-tiers { display:none;align-items:center;gap:6px;margin:6px 12px 0;padding:7px 9px;background:linear-gradient(145deg,#0d171e,#081016);border:1px solid #263d49;border-radius:8px;flex-wrap:wrap; }
        .market-sell-quality-tiers.visible { display:flex; }
        .market-sell-tier-label { flex:none;color:#7894a4;font-size:8px;font-weight:900;letter-spacing:.07em;text-transform:uppercase; }
        .market-sell-tier-actions { display:flex;gap:4px;margin-right:2px; }
        .market-sell-tier-action { padding:3px 7px;color:#a9bac4;background:#0a1319;border:1px solid #344a57;border-radius:5px;cursor:pointer;font-size:8px;font-weight:850; }
        .market-sell-tier-action:hover { color:#f1dfb7;border-color:#9b7939; }
        .market-sell-tier-buttons { min-width:0;display:flex;align-items:center;gap:5px;flex-wrap:wrap; }
        .market-sell-tier-btn { --sell-tier:#64748b;padding:3px 8px;color:#657884;background:#070d12;border:1px solid #2b3d47;border-radius:999px;cursor:pointer;font-size:8px;font-weight:900;opacity:.4;transition:opacity .15s,border-color .15s,box-shadow .15s,background .15s; }
        .market-sell-tier-btn.on { color:var(--sell-tier);background:color-mix(in srgb,var(--sell-tier) 12%,#070d12);border-color:var(--sell-tier);box-shadow:0 0 7px color-mix(in srgb,var(--sell-tier) 28%,transparent);opacity:1; }
        .market-sell-editor { position:relative;margin:9px 12px 0;padding:12px;display:grid;grid-template-columns:82px minmax(260px,1fr) minmax(470px,1.45fr);grid-template-areas:"art info form";gap:15px;align-items:center;background:linear-gradient(145deg,#111c24,#080f14);border:1px solid #294150;border-radius:10px;box-shadow:0 8px 22px #0008,inset 0 0 22px #ffffff05; }
        .market-sell-editor[hidden] { display:none !important; }
        .market-sell-editor.market-pokemon-quality { border-color:var(--market-tier-color) !important;background:linear-gradient(145deg,color-mix(in srgb,var(--market-tier-color) 15%,#101a21),#080f14 72%) !important; }
        .market-sell-editor-art { grid-area:art;width:78px;height:78px;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,#1b303d,#080e13 72%);border:1px solid #294554;border-radius:10px;overflow:hidden; }
        .market-sell-editor-art img { width:90%;height:90%;object-fit:contain;filter:drop-shadow(0 4px 5px #000b); }
        .market-sell-editor-art span { font-size:30px; }
        .market-sell-editor-info { grid-area:info;min-width:0; }
        .market-sell-editor-name { display:block;color:#f1e6cb;font-size:16px;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .market-sell-editor-meta { display:block;color:#a98cdb;font-size:11px;margin-top:4px; }
        .market-sell-editor-form { grid-area:form;display:grid;grid-template-columns:minmax(88px,.7fr) minmax(125px,.9fr) minmax(155px,1.2fr) minmax(98px,auto);grid-template-areas:"qty currency price submit" "summary summary summary summary";gap:8px;align-items:start;padding:8px 8px 7px;background:#070d1299;border:1px solid #1c303c;border-radius:8px; }
        .market-sell-field { display:grid;gap:4px;color:#6e8798;font-size:9px;font-weight:850;letter-spacing:.06em;text-transform:uppercase; }
        .market-sell-field[hidden] { display:none !important; }
        .market-sell-qty-field { grid-area:qty; }
        .market-sell-currency-field { grid-area:currency; }
        .market-sell-price-field { grid-area:price; }
        .market-sell-field input,.market-sell-field select { width:100% !important;min-width:0 !important; }
        .market-sell-editor .market-sell-conversion { display:block;min-height:12px;color:#65c7f0;font-size:10px;line-height:12px;letter-spacing:0;text-transform:none; }
        .market-sell-editor-form .market-sell-submit { grid-area:submit;align-self:start;height:30px;margin-top:13px;padding:5px 10px !important;white-space:nowrap; }
        .market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-columns:minmax(130px,.9fr) minmax(175px,1.25fr) minmax(98px,auto);grid-template-areas:"currency price submit" "summary summary summary"; }
        .market-sell-financial-summary { grid-area:summary;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding-top:7px;border-top:1px solid #1c303c; }
        .market-sell-finance-box { min-width:0;padding:5px 7px;background:#0a151c;border:1px solid #233b48;border-radius:6px; }
        .market-sell-finance-box small { display:block;color:#718b9b;font-size:7px;font-weight:900;letter-spacing:.06em;text-transform:uppercase; }
        .market-sell-finance-box b { display:block;margin-top:2px;color:#dce8ed;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .market-sell-finance-box.fee b { color:#f1bd62; }.market-sell-finance-box.net b{color:#69e49a}.market-sell-finance-box.gross b{color:#6dcbed}
        .market-sell-editor-close { position:absolute;right:7px;top:5px;width:24px;height:24px;padding:0 !important;border:0 !important;background:transparent !important;color:#718b9c !important;font-size:17px;cursor:pointer; }
        .market-sell-editor-close:hover { color:#f0dfbd !important; }
        .market-sell-editor-lock { position:absolute;right:34px;top:5px;width:25px;height:25px;padding:0 !important;display:grid;place-items:center;background:#091319 !important;color:#8fa4af !important;border:1px solid #304955 !important;border-radius:6px !important;cursor:pointer;font-size:14px !important; }
        .market-sell-editor-lock.locked { color:#ffd35d !important;border-color:#b98a28 !important;box-shadow:0 0 8px #ffca3b45; }
        .market-sell-card-lock { position:absolute !important;right:7px;top:7px;z-index:4 !important;width:27px;height:27px;display:grid;place-items:center;padding:0 !important;background:#071118e8;color:#8fa4af;border:1px solid #304955;border-radius:7px;cursor:pointer;font-size:14px; }
        .market-sell-card-lock.locked { color:#ffd35d;border-color:#b98a28;box-shadow:0 0 8px #ffca3b45; }
        .market-sell-reference-content { display:flex;align-items:center;justify-content:space-between;gap:12px; }
        .market-sell-reference-content > span { min-width:0;flex:1; }
        .market-sell-reference-actions { display:flex;align-items:center;gap:7px;flex:none; }
        .script-market-window .market-view-similar { padding:5px 11px !important;color:#bdeaff !important;background:linear-gradient(#17384a,#102735) !important;border:1px solid #2d718f !important;border-radius:6px !important;font-size:10px !important;font-weight:900 !important;white-space:nowrap;box-shadow:0 2px 8px #0006; }
        .script-market-window .market-view-similar:hover { color:#e4f7ff !important;background:linear-gradient(#20506a,#16384b) !important;border-color:#4b9cbc !important; }
        .script-market-window .market-use-suggested { flex:none;padding:5px 11px !important;color:#071008 !important;background:linear-gradient(#7ce59c,#42b96b) !important;border:1px solid #2b874c !important;border-radius:6px !important;font-size:10px !important;font-weight:900 !important;white-space:nowrap;box-shadow:0 2px 8px #0006; }
        .script-market-window .market-use-suggested:hover { color:#071008 !important;background:linear-gradient(#91efad,#4dcc78) !important;border-color:#3da05e !important; }
        .market-similar-backdrop { position:fixed;inset:0;z-index:10120;display:flex;align-items:center;justify-content:center;padding:16px;background:#02060ad9;backdrop-filter:blur(3px); }
        .market-similar-modal { width:min(940px,94vw);height:min(690px,90vh);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;background:linear-gradient(145deg,#0d171f,#070d12);border:1px solid #3b6176;border-radius:11px;box-shadow:0 18px 55px #000d,inset 0 1px #ffffff0c;color:#dce7ed; }
        .market-similar-head { display:flex;align-items:center;gap:10px;padding:11px 13px;background:#081017;border-bottom:1px solid #263d4a; }
        .market-similar-head b { color:#f1e4c7;font-size:14px; }
        .market-similar-head small { color:#7895a6;font-size:10px; }
        .market-similar-close { margin-left:auto;border:0;background:transparent;color:#8ba2b0;font-size:21px;cursor:pointer; }
        .market-similar-close:hover { color:#fff; }
        .market-similar-target { margin:10px 12px 0;padding:8px 10px;color:#9fc8dc;background:#0b1922;border:1px solid #244353;border-radius:7px;font-size:11px; }
        .market-similar-grid { min-height:0;flex:1;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:minmax(158px,auto);align-content:start;gap:9px;padding:11px 12px 13px;scrollbar-width:thin;scrollbar-color:#47758a #091118; }
        .market-similar-grid::-webkit-scrollbar { width:8px; }
        .market-similar-grid::-webkit-scrollbar-track { background:#091118;border-radius:8px; }
        .market-similar-grid::-webkit-scrollbar-thumb { background:#47758a;border:2px solid #091118;border-radius:8px; }
        .market-similar-card { --similar-tier:#3b6176;position:relative;min-height:158px;box-sizing:border-box;display:grid;grid-template-columns:56px minmax(0,1fr);grid-template-rows:minmax(94px,1fr) auto;gap:9px;padding:11px 10px 10px;background:linear-gradient(145deg,color-mix(in srgb,var(--similar-tier) 11%,#0b151c),#080f14 72%);border:1px solid var(--similar-tier);border-radius:9px;overflow:hidden; }
        .market-similar-card.best-match { border:2px solid #35e7ff;box-shadow:0 0 0 1px #0c91aa,0 0 18px #20dfff73,inset 0 0 20px #17cbe916;background:linear-gradient(145deg,color-mix(in srgb,var(--similar-tier) 15%,#0c2028),#071116 72%); }
        .market-similar-best { position:absolute;right:7px;top:6px;padding:2px 6px;color:#041116;background:linear-gradient(90deg,#6cf3ff,#38d9a2);border:1px solid #a9fbff;border-radius:999px;box-shadow:0 0 10px #41e9ff80;font-size:7px;font-weight:1000;letter-spacing:.06em; }
        .market-similar-art { width:54px;height:54px;display:flex;align-items:center;justify-content:center;background:#061018;border:1px solid color-mix(in srgb,var(--similar-tier) 65%,#28404d);border-radius:8px; }
        .market-similar-art img { width:48px;height:48px;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 3px 4px #000b); }
        .market-similar-info { min-width:0; }
        .market-similar-name { display:flex;align-items:center;gap:6px;color:#f1e6cb;font-weight:900;font-size:12px; }
        .market-similar-tier { color:var(--similar-tier);font-size:8px;text-transform:uppercase; }
        .market-similar-meta,.market-similar-delta { display:block;margin-top:3px;color:#a98cdb;font-size:9px; }
        .market-similar-delta { color:#76b9d8; }
        .market-similar-price { grid-column:1/-1;align-self:end;min-height:22px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:1px;padding-top:7px;border-top:1px solid #21333e;color:#74e59b;font-size:12px;font-weight:900; }
        .market-similar-price small { color:#71c9ec;font-size:9px;font-weight:700; }
        @media (max-width:900px) {
            .market-sell-editor { grid-template-columns:72px minmax(0,1fr);grid-template-areas:"art info" "form form"; }
            .market-sell-editor-art { width:68px;height:68px; }
            .market-similar-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        }
        @media (max-width:620px) {
            .market-sell-reference-content { align-items:stretch;flex-direction:column; }
            .market-sell-reference-actions { width:100%; }
            .market-sell-reference-actions > button { flex:1; }
            .market-similar-backdrop { padding:7px; }
            .market-similar-modal { width:98vw;height:92vh;max-height:92vh; }
            .market-similar-grid { grid-template-columns:1fr;padding:8px; }
            .market-sell-editor-form,.market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-columns:1fr 1fr;grid-template-areas:"qty currency" "price price" "submit submit" "summary summary"; }
            .market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-areas:"currency currency" "price price" "submit submit" "summary summary"; }
            .market-sell-financial-summary { grid-template-columns:1fr; }
            .market-sell-editor-form .market-sell-submit { width:100%; }
        }
        .script-market-window { background:linear-gradient(145deg,#080d12,#0b1219 55%,#060a0e) !important; }
        .script-market-window .mk-head { background:#070c11 !important;border-bottom-color:#1c2b36 !important; }
        .script-market-tabs,.market-buy-controls,.market-sell-controls,.market-pokemon-filters { background:#0a1118; }
        .market-view-toggle { display:flex;gap:4px;margin-left:auto; }
        .market-view-btn { min-width:78px;padding:5px 8px !important;font-size:11px !important; }
        .market-view-btn.on { color:#ffe4a3 !important;background:#2b2416 !important;border-color:#a88138 !important;box-shadow:inset 0 0 0 1px #5f4a20; }
        .script-market-window .market-status { color:#71899a !important;background:#070c11;border-top:1px solid #12202a; }
        .script-market-window .market-list { min-height:0;flex:1;align-content:start;background:#070c11; }
        .script-market-window .market-list.market-view-cards { grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:12px !important; }
        .script-market-window .market-list.market-view-list { grid-template-columns:1fr;gap:6px !important; }
        .market-buy-row,.market-sell-row { box-sizing:border-box;width:100%;position:relative;background:linear-gradient(145deg,#0d171f,#0a1117);color:#dce6ed;border:1px solid #1b303e;border-radius:9px;padding:10px;transition:border-color .15s,background .15s,transform .15s;overflow:hidden; }
        .market-buy-row::before,.market-sell-row::before { content:"";position:absolute;inset:0 auto 0 0;width:3px;background:#314e60; }
        .market-buy-row:hover,.market-sell-row:hover { background:linear-gradient(145deg,#12212c,#0c161e);border-color:#42647a; }
        .market-buy-row::after,.market-sell-row::after { content:"";position:absolute;z-index:0;top:-45%;left:-75%;width:38%;height:190%;pointer-events:none;background:linear-gradient(105deg,transparent,rgba(255,255,255,.09),transparent);transform:skewX(-18deg);transition:left .55s ease; }
        .market-buy-row:hover::after,.market-sell-row:hover::after { left:135%; }
        .market-buy-row > *,.market-sell-row > * { position:relative;z-index:1; }
        .market-pokemon-quality { border-color:color-mix(in srgb,var(--market-tier-color) 62%,#152732) !important;background:linear-gradient(145deg,color-mix(in srgb,var(--market-tier-color) 13%,#0b141b),#080f15 72%) !important;box-shadow:inset 0 0 24px color-mix(in srgb,var(--market-tier-color) 7%,transparent); }
        .market-pokemon-quality::before { background:var(--market-tier-color) !important;box-shadow:0 0 10px var(--market-tier-color); }
        .market-pokemon-quality:hover { border-color:var(--market-tier-color) !important;background:linear-gradient(145deg,color-mix(in srgb,var(--market-tier-color) 20%,#0c161d),#0a1218 74%) !important;box-shadow:0 5px 18px #0008,inset 0 0 28px color-mix(in srgb,var(--market-tier-color) 11%,transparent);transform:translateY(-1px); }
        .market-pokemon-quality .market-art { border-color:color-mix(in srgb,var(--market-tier-color) 55%,#203846);box-shadow:inset 0 0 16px color-mix(in srgb,var(--market-tier-color) 12%,transparent); }
        .market-pokemon-quality .market-kind-label { color:var(--market-tier-color); }
        .market-item-rarity { border-color:color-mix(in srgb,var(--market-item-color) 58%,#152732) !important;background:linear-gradient(145deg,color-mix(in srgb,var(--market-item-color) 11%,#0b141b),#080f15 74%) !important;box-shadow:inset 0 0 22px color-mix(in srgb,var(--market-item-color) 6%,transparent); }
        .market-item-rarity::before { background:var(--market-item-color) !important;box-shadow:0 0 8px var(--market-item-color); }
        .market-item-rarity:hover { border-color:var(--market-item-color) !important;background:linear-gradient(145deg,color-mix(in srgb,var(--market-item-color) 18%,#0c161d),#0a1218 75%) !important; }
        .market-item-rarity .market-art { border-color:color-mix(in srgb,var(--market-item-color) 50%,#203846); }
        .market-item-rarity .market-kind-label { color:var(--market-item-color); }
        .market-item-rarity-badge { display:inline-flex;align-items:center;margin-top:5px;padding:2px 7px;border:1px solid var(--market-item-color);border-radius:999px;color:var(--market-item-color);background:#060b0f99;font-size:9px;font-weight:900;letter-spacing:.06em;text-transform:uppercase; }
        .market-quality-tier { display:inline-flex;align-items:center;margin-top:5px;padding:2px 7px;border:1px solid var(--market-tier-color);border-radius:999px;color:var(--market-tier-color);background:#060b0f99;font-size:9px;font-weight:900;letter-spacing:.06em;text-transform:uppercase; }
        .market-quality-tier[hidden],.market-stats[hidden] { display:none !important; }
        .market-sell-row { cursor:pointer;text-align:left;font-family:inherit; }
        .market-sell-row.on { border-color:#c39b43;background:linear-gradient(145deg,#201c12,#101820);box-shadow:0 0 0 1px #6d5424,inset 0 0 18px #c39b4312; }
        .market-sell-row.on::before { background:#e2b955; }
        .market-art { grid-area:art;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,#172936,#0a1117 70%);border:1px solid #203846;border-radius:8px;overflow:hidden;flex:none; }
        .market-art img { width:88%;height:88%;object-fit:contain;image-rendering:auto;filter:drop-shadow(0 3px 4px #000a); }
        .market-art span { font-size:25px;opacity:.7; }
        .market-main { grid-area:main;min-width:0; }
        .market-item-name { display:block;color:#f0e5cb;font-size:14px;font-weight:850;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .market-kind-label { display:block;color:#617d8f;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-bottom:3px; }
        .market-meta { display:block;color:#b49ae6;font-size:11px;margin-top:4px;line-height:1.35; }
        .market-stats { display:flex;flex-wrap:wrap;gap:3px 5px;margin-top:5px;line-height:1.2; }
        .market-pokemon-listing .market-main { position:relative;padding-right:84px;align-self:start; }
        .market-pokemon-listing .market-quality-tier { position:absolute;top:0;right:36px;margin:0;max-width:78px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .market-pokemon-listing > .market-card-stats { grid-area:stats;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px 7px;width:100%;box-sizing:border-box;margin:0;padding:7px 8px;background:#060c1099;border:1px solid #213540;border-radius:7px; }
        .market-pokemon-listing > .market-card-stats .market-stat { min-width:0;justify-content:space-between;padding:3px 5px; }
        .market-stat { display:inline-flex;align-items:center;gap:3px;padding:2px 5px;border:1px solid currentColor;border-radius:4px;background:#050a0e99;font-size:9px;font-weight:850;white-space:nowrap; }
        .market-stat b { color:#e8f0f5;font-size:9px; }
        .market-stat-hp { color:#42d47d; }
        .market-stat-atk { color:#ff6b5f; }
        .market-stat-def { color:#4da3ff; }
        .market-stat-spatk { color:#d77aff; }
        .market-stat-spdef { color:#36d6c5; }
        .market-stat-speed { color:#f4c84a; }
        .market-quantity { grid-area:quantity;color:#658397;font-size:10px;text-transform:uppercase;letter-spacing:.04em; }
        .market-quantity b { display:block;color:#65d6a3;font-size:13px;letter-spacing:0;text-transform:none;margin-top:2px; }
        .market-price { grid-area:price;color:#f0c762;font-size:14px;font-weight:850;line-height:1.2; }
        .market-price small { display:block;color:#67bfe9;font-size:10px;font-weight:650;margin-top:3px; }
        .market-actions { grid-area:actions;display:flex;min-height:38px;align-items:center;justify-content:flex-end;gap:6px;white-space:nowrap; }
        .market-buy-footer { grid-area:footer;display:grid;grid-template-columns:minmax(64px,.55fr) minmax(108px,1fr) auto;grid-template-rows:minmax(31px,1fr) minmax(31px,1fr);grid-template-areas:"footerQty footerPrice footerActions" "footerQty footerConversion footerActions";align-items:stretch;gap:6px 10px;min-width:0;min-height:82px;padding-top:11px;border-top:1px solid #20313b; }
        .market-buy-footer .market-data-box { box-sizing:border-box;min-width:0;display:flex;flex-direction:column;justify-content:center;padding:4px 6px;border:1px solid #29404d;border-radius:6px;background:#071017;box-shadow:inset 0 1px #ffffff08; }
        .market-buy-footer .market-data-label { display:block;margin:0 0 3px;color:#617c8c;font-size:6.5px;font-weight:900;letter-spacing:.06em;line-height:1;text-transform:uppercase;white-space:nowrap; }
        .market-buy-footer .market-quantity { grid-area:footerQty;color:#6ee7b7;border-color:#245a4c;background:#071713; }
        .market-buy-footer .market-quantity b { color:#6ee7b7;font-size:13px; }
        .market-buy-footer .market-price { grid-area:footerPrice;color:#f4c84a;border-color:#695821;background:#171305;font-size:11px; }
        .market-buy-footer .market-price b { color:#f4c84a;white-space:nowrap; }
        .market-buy-footer .market-conversion { grid-area:footerConversion;color:#67c8f1;border-color:#24536a;background:#07151c;font-size:9px;font-weight:800; }
        .market-buy-footer .market-conversion b { color:#67c8f1;white-space:nowrap; }
        .market-buy-footer .market-actions { grid-area:footerActions;align-self:center;min-height:34px;padding:0 !important;border:0 !important;justify-self:end; }
        .market-pokemon-listing .market-buy-footer { grid-template-columns:minmax(150px,1fr) auto;grid-template-areas:"footerPrice footerActions" "footerConversion footerActions"; }
        .market-view-cards .market-buy-row { display:grid;grid-template-columns:66px minmax(0,1fr);grid-template-rows:minmax(82px,auto) minmax(38px,auto) minmax(42px,auto);grid-template-areas:"art main" "quantity price" "actions actions";gap:10px 11px;align-items:center;height:auto !important;min-height:225px !important;padding:12px 11px 13px !important; }
        .market-view-cards .market-buy-row.market-listing-row { grid-template-rows:minmax(112px,1fr) minmax(82px,auto);grid-template-areas:"art main" "footer footer";min-height:255px !important; }
        .market-view-cards .market-buy-row.market-pokemon-listing { grid-template-rows:minmax(76px,auto) auto minmax(82px,auto);grid-template-areas:"art main" "stats stats" "footer footer";min-height:275px !important; }
        .market-listing-row { container-type:inline-size; }
        @container (max-width:370px) {
            .market-buy-footer,.market-pokemon-listing .market-buy-footer { grid-template-columns:minmax(64px,.55fr) minmax(0,1fr);grid-template-rows:auto auto auto;grid-template-areas:"footerQty footerPrice" "footerQty footerConversion" "footerActions footerActions"; }
            .market-pokemon-listing .market-buy-footer { grid-template-areas:"footerPrice footerPrice" "footerConversion footerConversion" "footerActions footerActions"; }
            .market-buy-footer .market-actions { justify-self:stretch;justify-content:stretch; }
            .market-buy-footer .market-actions input { flex:1;width:auto !important;min-width:0; }
            .market-buy-footer .market-actions button { flex:1; }
        }
        .market-view-cards .market-sell-row { display:grid;grid-template-columns:64px minmax(0,1fr);grid-template-rows:minmax(92px,auto) minmax(42px,auto);grid-template-areas:"art main" "quantity quantity";gap:11px;align-items:center;height:auto !important;min-height:170px !important;padding:12px 11px 13px !important; }
        .market-sell-row.market-pokemon-listing .market-main { padding-right:112px; }
        .market-sell-row.market-pokemon-listing .market-quality-tier { right:34px; }
        .market-view-cards .market-sell-row.market-pokemon-listing { grid-template-rows:minmax(76px,auto) auto;grid-template-areas:"art main" "stats stats";min-height:188px !important; }
        .market-view-cards .market-art { width:64px;height:64px; }
        .market-view-cards .market-buy-row .market-actions { border-top:1px solid #182a35;padding-top:8px; }
        .market-view-list .market-buy-row { display:grid;grid-template-columns:64px minmax(260px,1fr) 105px 165px minmax(145px,auto);grid-template-areas:"art main quantity price actions";gap:14px;align-items:center;height:auto !important;min-height:104px !important;padding:12px 14px !important; }
        .market-view-list .market-buy-row.market-listing-row { grid-template-columns:64px minmax(260px,1fr) minmax(360px,.9fr);grid-template-areas:"art main footer"; }
        .market-view-list .market-buy-row.market-pokemon-listing { min-height:132px !important; }
        .market-view-list .market-sell-row { display:grid;grid-template-columns:64px minmax(260px,1fr) 145px;grid-template-areas:"art main quantity";gap:14px;align-items:center;height:auto !important;min-height:100px !important;padding:12px 14px !important; }
        .market-view-list .market-art { width:58px;height:58px; }
        .market-view-list .market-main { padding-right:8px; }
        .market-view-list .market-stats { max-width:520px; }
        @media (min-width:1101px) {
            .market-view-list .market-buy-row.market-pokemon-listing { grid-template-columns:64px minmax(190px,.72fr) minmax(290px,1.08fr) minmax(330px,.95fr);grid-template-rows:auto;grid-template-areas:"art main stats footer";gap:12px;align-items:center;padding:11px 13px !important; }
            .market-view-list .market-pokemon-listing > .market-card-stats { align-self:center;grid-template-columns:repeat(3,minmax(0,1fr));max-width:none;padding:8px; }
            .market-view-list .market-pokemon-listing .market-main { align-self:center;padding-right:82px; }
            .market-view-list .market-pokemon-listing .market-buy-footer { align-self:stretch;min-height:82px;padding:0 0 0 12px;border-top:0;border-left:1px solid #20313b; }
            .market-view-list .market-pokemon-listing .market-actions { min-width:130px; }
            .market-view-list .market-pokemon-listing .market-actions > button { width:100%; }
            .market-view-list .market-sell-row.market-pokemon-listing { grid-template-columns:64px minmax(240px,.85fr) minmax(330px,1.15fr);grid-template-areas:"art main stats";gap:12px;min-height:112px !important; }
            .market-view-list .market-sell-row.market-pokemon-listing .market-main { padding-right:112px; }
        }
        @media (max-width:1100px) {
            .market-view-list .market-buy-row { grid-template-columns:58px minmax(0,1fr) minmax(145px,auto);grid-template-areas:"art main price" "quantity quantity actions"; }
            .market-view-list .market-buy-row.market-listing-row { grid-template-columns:58px minmax(0,1fr);grid-template-areas:"art main" "footer footer"; }
            .market-view-list .market-buy-row.market-pokemon-listing { grid-template-rows:auto auto auto;grid-template-areas:"art main" "stats stats" "footer footer"; }
            .market-view-list .market-pokemon-listing .market-buy-footer { width:100%; }
            .market-view-list .market-sell-row { grid-template-columns:58px minmax(0,1fr);grid-template-areas:"art main" "quantity quantity"; }
            .market-view-list .market-sell-row.market-pokemon-listing { grid-template-rows:auto auto;grid-template-areas:"art main" "stats stats"; }
        }
        @media (max-width:760px) {
            .script-market-window .market-list.market-view-cards { grid-template-columns:1fr; }
            .market-view-list .market-buy-row { grid-template-columns:48px minmax(0,1fr) auto;grid-template-areas:"art main price" "quantity quantity actions"; }
            .market-buy-footer { grid-template-columns:minmax(58px,.65fr) minmax(0,1fr);grid-template-rows:auto auto auto;grid-template-areas:"footerQty footerPrice" "footerQty footerConversion" "footerActions footerActions"; }
            .market-buy-footer .market-actions { justify-content:stretch;justify-self:stretch; }
            .market-buy-footer .market-actions .market-buy { flex:1; }
            .market-view-list .market-sell-row { grid-template-columns:48px minmax(0,1fr);grid-template-areas:"art main" "quantity quantity"; }
            .market-view-list .market-sell-row.market-pokemon-listing { grid-template-areas:"art main" "stats stats"; }
            .market-view-btn { min-width:36px; }
            .market-view-btn .market-view-text { display:none; }
        }
        /* Global Market aligned with the Poké Ball Shop / Sell Items windows. */
        .script-market-backdrop { background:rgba(0,0,0,.72) !important;backdrop-filter:blur(2px); }
        .script-market-window { border:2px solid #785a28 !important;border-radius:11px !important;box-shadow:0 18px 55px #000d,inset 0 0 0 1px #d5b36612 !important;overflow:hidden; }
        .script-market-window .mk-head { min-height:50px;padding:10px 14px !important;background:linear-gradient(180deg,#151c22,#0b1116) !important;border-bottom:1px solid #745725 !important;box-shadow:0 3px 12px #0008; }
        .script-market-window .mk-head > b { color:#f0e6ce !important;font-size:16px;letter-spacing:.015em;text-shadow:0 1px 2px #000; }
        .script-market-window .market-head-primary { flex:1;min-width:0;display:flex;align-items:center;gap:14px; }
        .script-market-window .market-head-primary > b { flex:none;color:#f0e6ce;font-size:16px;letter-spacing:.015em;text-shadow:0 1px 2px #000;white-space:nowrap; }
        .script-market-window .market-player-balance { display:flex;align-items:center;gap:6px;min-width:0;padding-left:13px;border-left:1px solid #3d4650; }
        .script-market-window .market-balance-label { color:#607b8d;font-size:8px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap; }
        .script-market-window .market-balance-pill { display:inline-flex;align-items:center;gap:5px;min-height:25px;box-sizing:border-box;padding:4px 8px;background:#071017;border:1px solid #2b414d;border-radius:7px;color:#dce6eb;font-size:11px;font-weight:900;white-space:nowrap;box-shadow:inset 0 1px #ffffff08; }
        .script-market-window .market-balance-pill.gold { border-color:#655326;color:#79df93; }
        .script-market-window .market-balance-pill.diamonds { border-color:#28546a;color:#84dcfa; }
        .script-market-window .market-balance-icon { font-size:12px;filter:drop-shadow(0 1px 2px #000); }
        .script-market-window .market-exchange-rate { padding:4px 9px;color:#83d8f5 !important;background:#07141b;border:1px solid #244657;border-radius:999px;font-weight:800; }
        .script-market-window .market-close { color:#a9b7c1 !important;font-size:20px !important;transition:color .15s,transform .15s; }
        .script-market-window .market-close:hover { color:#f2d892 !important;transform:scale(1.08); }
        .script-market-tabs { min-height:42px;box-sizing:border-box;align-items:center;padding:7px 12px !important;background:#0b1218 !important;border-bottom:1px solid #1d2b35;box-shadow:inset 0 -1px #0007; }
        .script-market-window .market-tab { min-width:94px;min-height:29px;padding:5px 12px !important;font-size:11px !important; }
        .script-market-window .market-tab.on { background:linear-gradient(#e2c77f,#b58b39) !important;border-color:#806126 !important;box-shadow:0 2px 7px #0008,inset 0 1px #fff6 !important; }
        .script-market-window .market-view-toggle { padding:2px;background:#070c10;border:1px solid #25343e;border-radius:8px; }
        .script-market-window .market-view-btn { min-height:25px;border-color:transparent !important; }
        .script-market-window .market-buy-controls,.script-market-window .market-sell-controls,.script-market-window .market-pokemon-filters { box-sizing:border-box;margin:8px 12px 0;padding:9px !important;background:linear-gradient(145deg,#101a21,#0a1116) !important;border:1px solid #263945;border-radius:8px;box-shadow:inset 0 1px #ffffff08,0 3px 10px #0005; }
        .script-market-window .market-pokemon-filters { margin-top:6px; }
        .script-market-window input,.script-market-window select { min-height:30px !important;background:#071017 !important;border-color:#334957 !important;color:#dce7ed !important; }
        .script-market-window input::placeholder { color:#657887 !important; }
        .script-market-window input[type="checkbox"] { min-height:0 !important;accent-color:#c6a14d; }
        .script-market-window .market-sell-editor { background:linear-gradient(145deg,#121d24,#090f14) !important;border-color:#4a3c24;box-shadow:0 7px 20px #0009,inset 0 1px #e4c5760b; }
        .script-market-window .market-sell-editor-form { background:#070d12;border-color:#2d3f49;box-shadow:inset 0 1px 5px #0008; }
        .script-market-window .market-sell-reference { background:linear-gradient(90deg,#101b22,#0a1217) !important;border-color:#315063 !important;box-shadow:inset 3px 0 #4b94b8,0 3px 10px #0005; }
        .script-market-window .market-status { min-height:27px;box-sizing:border-box;margin-top:6px;padding:6px 13px !important;background:#080d11 !important;border-top:1px solid #1c2932;border-bottom:1px solid #111b22;color:#7894a5 !important; }
        .script-market-window .market-list { padding:8px 12px 12px !important;background:linear-gradient(#080d11,#060a0d) !important; }
        .script-market-window .market-buy,.script-market-window .market-sell-submit { min-height:31px;background:linear-gradient(#d9bd72,#ad8334) !important;color:#160f05 !important;border:1px solid #78591f !important;box-shadow:0 2px 6px #0008,inset 0 1px #fff5;font-weight:900 !important; }
        .script-market-window .market-buy:hover,.script-market-window .market-sell-submit:hover { background:linear-gradient(#ead18b,#c0953e) !important;color:#120c04 !important; }
        .script-market-window .market-buy:disabled,.script-market-window .market-sell-submit:disabled { filter:grayscale(.65);opacity:.48;cursor:not-allowed; }
        .script-market-window .market-cancel-listing { min-height:32px;padding:6px 10px !important;background:linear-gradient(#3a2024,#241317) !important;border:1px solid #743541 !important;color:#ffabab !important;font-weight:900 !important;white-space:nowrap; }
        .script-market-window .market-cancel-listing:hover { background:linear-gradient(#542a31,#35191f) !important;border-color:#a84a59 !important;color:#ffd0d0 !important; }
        .market-tab-count { display:inline-grid;place-items:center;min-width:17px;height:17px;margin-left:4px;padding:0 3px;border-radius:999px;background:#071017;border:1px solid #496172;color:#9fdcf4;font-size:8px;font-weight:900; }
        .market-alert-tab-count { display:inline-grid;place-items:center;min-width:17px;height:17px;margin-left:4px;padding:0 3px;border-radius:999px;background:linear-gradient(#46d8ff,#1285cf);border:1px solid #b5f5ff;color:#e7fbff;font-size:8px;font-weight:900;text-shadow:0 1px #07507e; }
        .script-market-window .market-tab img { width:15px;height:15px;object-fit:contain;vertical-align:-3px;margin-right:3px;filter:drop-shadow(0 1px 2px #000); }
        .script-market-tabs { flex-wrap:wrap; }
        .market-request-controls { box-sizing:border-box;margin:8px 12px 0;padding:10px;background:linear-gradient(145deg,#111d24,#080f14);border:1px solid #4a3c24;border-left:3px solid #c89e43;border-radius:9px;box-shadow:0 5px 15px #0007; }
        .market-request-heading { display:flex;align-items:center;gap:8px;margin-bottom:9px;padding-bottom:7px;border-bottom:1px solid #293b45;color:#eee1c5;font-size:12px;font-weight:900; }
        .market-request-heading img { width:20px;height:20px;object-fit:contain; }
        .market-request-form { display:grid;grid-template-columns:minmax(210px,1.5fr) minmax(100px,.55fr) minmax(130px,.7fr) auto;gap:8px;align-items:end; }
        .market-request-field { display:flex;flex-direction:column;gap:4px;min-width:0;color:#718a99;font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase; }
        .market-request-field input,.market-request-field select { box-sizing:border-box;width:100%;min-height:33px;padding:6px 8px;background:#071017;border:1px solid #304854;border-radius:7px;color:#dce6eb;font:650 10px var(--piw-game-font);outline:none; }
        .market-request-field input:focus,.market-request-field select:focus { border-color:#aa8235;box-shadow:0 0 0 2px #aa823523; }
        .market-request-combobox { position:relative;min-width:0; }
        .market-request-search-wrap { position:relative;display:flex;align-items:center; }
        .market-request-search-wrap .market-request-search { padding-left:40px !important;padding-right:28px !important; }
        .market-request-selected-art { position:absolute;left:7px;width:27px;height:27px;display:grid;place-items:center;border-radius:5px;background:#0d1a22;border:1px solid #294351;pointer-events:none;overflow:hidden; }
        .market-request-selected-art img { width:24px;height:24px;object-fit:contain;image-rendering:pixelated; }
        .market-request-clear { position:absolute;right:5px;width:23px;height:23px;padding:0;border:0;background:transparent;color:#6f8795;font:900 15px/1 sans-serif;cursor:pointer; }
        .market-request-clear:hover { color:#efc76d; }
        .market-request-options { position:absolute;left:0;right:0;top:calc(100% + 5px);z-index:100;display:grid;gap:3px;max-height:260px;padding:5px;overflow:auto;background:#071017;border:1px solid #8b692c;border-radius:8px;box-shadow:0 14px 30px #000d; }
        .market-request-options[hidden] { display:none !important; }
        .market-request-option { width:100%;min-height:43px;display:grid;grid-template-columns:36px minmax(0,1fr) auto;align-items:center;gap:8px;padding:4px 7px;border:1px solid transparent;border-radius:6px;background:#0d171e;color:#dce7ed;text-align:left;cursor:pointer;font:750 10px var(--piw-game-font); }
        .market-request-option:hover,.market-request-option.on { border-color:#806126;background:linear-gradient(90deg,#172730,#111a20);color:#f3d98c; }
        .market-request-option img { width:32px;height:32px;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 2px 3px #000); }
        .market-request-option small { color:#688392;font-size:8px;text-transform:uppercase; }
        .market-request-no-results { padding:14px;text-align:center;color:#6f8795;font-size:9px; }
        .market-request-submit { min-height:33px;padding:6px 12px !important;background:linear-gradient(#d9bd72,#ad8334) !important;border-color:#8c6826 !important;color:#171006 !important;font-weight:900 !important; }
        .market-request-summary { grid-column:1/-1;display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 9px;background:#070d11;border:1px solid #253b47;border-radius:7px;color:#7893a3;font-size:9px; }
        .market-request-summary strong { color:#73dc94;font-size:10px; }.market-request-summary .request-total{color:#f0c762;}
        .market-request-list-filters { display:grid;grid-template-columns:minmax(110px,.6fr) minmax(120px,.65fr) minmax(120px,.65fr) minmax(210px,1.5fr) auto;gap:7px;align-items:center;margin-top:9px;padding-top:9px;border-top:1px solid #293b45; }
        .market-request-list-filters::before { content:attr(data-label);grid-column:1/-1;color:#718a99;font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase; }
        .market-request-list-filters input,.market-request-list-filters select { box-sizing:border-box;width:100%;min-width:0;min-height:31px;padding:5px 8px;background:#071017;border:1px solid #304854;border-radius:7px;color:#dce6eb;font:650 10px var(--piw-game-font);outline:none; }
        .market-request-filter-clear { min-height:31px;padding:5px 9px !important;white-space:nowrap; }
        .market-section-title { grid-column:1/-1;display:flex;align-items:center;gap:7px;min-height:35px;padding:7px 10px;background:linear-gradient(90deg,#172229,#0a1115);border:1px solid #4c3e24;border-left:3px solid #c69b42;border-radius:7px;color:#eadcc0;font-size:11px;font-weight:900; }
        .market-section-title span { color:#d5a94b; }.market-section-title small{margin-left:auto;color:#708a99;font-size:9px;}
        .market-request-row::before { background:#c59a41 !important; }.market-history-row.bought::before{background:#4bbd75 !important}.market-history-row.sold::before{background:#d49d42 !important}
        .market-request-row .market-actions,.market-history-row .market-actions { border-top:1px solid #182a35;padding-top:8px; }
        .market-request-cancel { color:#ff9b9b !important;border-color:#743541 !important;background:#241318 !important; }
        .market-request-empty { grid-column:1/-1;display:grid;place-items:center;min-height:110px;padding:20px;background:#080e12;border:1px dashed #263d48;border-radius:8px;color:#657e8c;font-size:10px; }
        .market-history-state { display:inline-flex;align-items:center;gap:5px;color:#8ca2ae;font-size:9px;font-weight:850; }.market-history-state.bought{color:#72da94}.market-history-state.sold{color:#e0b45e}
        .market-history-relative { color:#6bc9ee;font-weight:800; }
        @media (max-width:780px) { .market-request-form{grid-template-columns:1fr 1fr}.market-request-field:first-of-type{grid-column:1/-1}.market-request-submit{grid-column:1/-1}.market-request-list-filters{grid-template-columns:1fr 1fr}.market-request-filter-search,.market-request-filter-clear{grid-column:1/-1}.script-market-window .market-tab{min-width:auto!important}.script-market-window .market-tab img{margin-right:0}.script-market-window .market-tab-label{display:none} }
        @media (max-width:760px) { .script-market-window .market-balance-label{display:none}.script-market-window .market-head-primary{gap:7px}.script-market-window .market-player-balance{gap:4px;padding-left:7px}.script-market-window .market-balance-pill{padding:4px 6px}.script-market-window .market-exchange-rate{display:none} }
        .script-quality-multiselect { position:relative;display:inline-block;z-index:8; }
        .script-quality-toggle { min-width:170px;text-align:left; }
        .script-quality-dropdown { position:absolute;min-width:190px;padding:7px;background:#101b24;border:1px solid #7a5a27;border-radius:6px;box-shadow:0 8px 22px #000b;display:grid;gap:3px;z-index:100000;pointer-events:auto; }
        .script-quality-option { display:flex;gap:7px;align-items:center;width:100%;padding:4px 5px;border-radius:4px;background:transparent;color:#e8dfcc;cursor:pointer;box-sizing:border-box;user-select:none;pointer-events:auto; }
        .script-quality-option:hover { background:#ffffff12; }
        .script-quality-option input { flex:0 0 auto;margin:0;accent-color:#3182ce;pointer-events:auto; }
        .script-mark-row-buy { display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto; }
        .script-mark-row-buy .mk-bulk-btn { min-width:38px;padding:5px 7px;font-size:11px; }
        .sell-confirm-btn.no, .mk-bulk-btn, .dex-fbtn {
            background: rgba(255, 255, 255, .035) !important;
            color: rgb(233, 226, 208) !important;
            border: 1px solid rgba(200, 170, 110, .24) !important;
            border-radius: 8px !important;
        }
        .mk-bulk-btn.active, .mk-bulk-btn:hover, .dex-fbtn.on, .dex-fbtn:hover {
            background: rgba(200, 170, 110, .16) !important;
            color: rgb(240, 230, 210) !important;
            border-color: rgba(230, 205, 142, .45) !important;
        }
        .portable-depot-family-tabs { display: inline-flex; gap: 6px; }
        .portable-depot-backdrop .sell-confirm-title { gap: 6px; }
        .portable-depot-backdrop .depot-tab {
            min-height: 34px;
            padding: 7px 8px !important;
            border-radius: 8px 8px 0 0 !important;
            font: 700 12.5px Barlow, "Barlow Fallback", sans-serif !important;
        }
        .portable-depot-backdrop .depot-tab.active {
            background: rgba(200, 170, 110, .16) !important;
            color: rgb(240, 230, 210) !important;
        }
        .portable-depot-content section,
        .hunt-sell-row, .market-row, .market-listing, .primary-favorite-list > * {
            background: transparent !important;
            border-color: rgba(255, 255, 255, .05) !important;
            border-radius: 8px !important;
        }
        .portable-depot-content section button,
        .hunt-sell-row, .market-row, .market-listing {
            background: rgba(255, 255, 255, .02) !important;
            color: rgb(233, 226, 208) !important;
            border: 1px solid rgba(255, 255, 255, .05) !important;
            border-radius: 8px !important;
        }
        .portable-depot-content section button:hover,
        .hunt-sell-row:hover, .market-row:hover, .market-listing:hover {
            background: rgba(200, 170, 110, .08) !important;
            border-color: rgba(200, 170, 110, .24) !important;
        }
        .portable-depot-poke-filters {
            flex-basis: 100%;
            display: grid;
            grid-template-columns: minmax(190px, 2fr) repeat(4, minmax(82px, 1fr)) auto;
            gap: 6px;
            padding: 9px;
            background: rgba(255, 255, 255, .02);
            border: 1px solid rgba(255, 255, 255, .05);
            border-radius: 8px;
        }
        .portable-depot-clear-filters { min-height: 28px; padding: 5px 10px; cursor: pointer; }
        /* Depot completo: estilo de tarjetas coherente con Market y tiendas */
        .portable-depot-backdrop { background:rgba(0,0,0,.74) !important;backdrop-filter:blur(2px); }
        .portable-depot-backdrop .script-portable-depot-window { display:flex;flex-direction:column;width:min(1040px,96vw) !important;height:min(790px,92vh);max-width:96vw !important;max-height:92vh;background:linear-gradient(145deg,#0c1319,#060a0d) !important;border:2px solid #785a28 !important;border-radius:11px !important;box-shadow:0 18px 55px #000d,inset 0 0 0 1px #d5b36612 !important;overflow:hidden; }
        .portable-depot-backdrop .depot-head { flex:none;display:flex;align-items:center;gap:12px;min-height:60px;padding:9px 13px !important;background:linear-gradient(180deg,#151c22,#0b1116) !important;border-bottom:1px solid #745725 !important;box-shadow:0 3px 12px #0008; }
        .portable-depot-brand { display:flex;align-items:center;gap:9px;min-width:178px; }
        .portable-depot-brand-icon { display:grid;place-items:center;width:34px;height:34px;background:radial-gradient(circle,#3c301a,#0c0d0b);border:1px solid #806329;border-radius:8px;font-size:18px;box-shadow:inset 0 0 10px #0008; }
        .portable-depot-brand b { display:block;color:#f0e5cc;font-size:16px;line-height:1.1;text-shadow:0 1px 2px #000; }
        .portable-depot-brand small { display:block;margin-top:3px;color:#718897;font-size:8px;white-space:nowrap; }
        .portable-depot-tabs { flex:1;display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:0; }
        .portable-depot-family-tabs { display:contents !important; }
        .portable-depot-view-toggle { flex:none;display:flex;align-items:center;gap:2px;padding:2px;background:#070c10;border:1px solid #2c3d47;border-radius:7px; }
        .portable-depot-view-btn { min-height:27px;padding:4px 7px !important;border-color:transparent !important;font-size:9px !important;white-space:nowrap; }
        .portable-depot-view-btn.on { color:#171006 !important;background:linear-gradient(#dec377,#ad8334) !important;border-color:#806126 !important; }
        .portable-depot-backdrop .depot-tab { min-height:32px;padding:6px 10px !important;background:linear-gradient(#202930,#11181d) !important;border:1px solid #4a4637 !important;border-radius:7px !important;color:#b8c7cf !important;font:800 10px var(--piw-game-font) !important;white-space:nowrap;box-shadow:inset 0 1px #ffffff0c; }
        .portable-depot-backdrop .depot-tab:hover { color:#eee1c5 !important;border-color:#8b6b2e !important;background:linear-gradient(#29343c,#161f25) !important; }
        .portable-depot-backdrop .depot-tab.active { color:#171006 !important;background:linear-gradient(#e2c77f,#b58b39) !important;border-color:#d3ad55 !important;box-shadow:0 2px 7px #0008,inset 0 1px #fff6 !important; }
        .portable-depot-close { flex:none;color:#a9b7c1 !important;transition:color .15s,transform .15s; }.portable-depot-close:hover{color:#f2d892 !important;transform:scale(1.08)}
        .portable-depot-backdrop .sell-confirm-body { flex:1;min-height:0;display:flex;flex-direction:column;padding:11px 12px 12px !important;background:linear-gradient(#080e12,#060a0d);overflow:hidden; }
        .portable-depot-status { margin:auto;color:#7894a5 !important;text-align:center;font-size:12px; }
        .portable-depot-content { flex:1;min-height:0;display:grid !important;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:minmax(0,1fr);gap:10px !important;overflow:hidden; }
        .portable-depot-content.has-filters,.portable-depot-content.has-family-header { grid-template-rows:auto minmax(0,1fr); }
        .portable-depot-content.has-filters.has-family-header { grid-template-rows:auto auto minmax(0,1fr); }
        .portable-depot-content > .portable-depot-column { min-width:0 !important;max-height:none !important;height:100%;box-sizing:border-box;padding:0 8px 8px !important;background:linear-gradient(145deg,#0e181f,#080f13) !important;border:1px solid #293e49 !important;border-radius:9px !important;overflow:auto !important;scrollbar-color:#6b5429 transparent;box-shadow:inset 0 1px #ffffff07,0 4px 11px #0006; }
        .depot-column-head { position:sticky;z-index:3;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:43px;margin:0 -8px 8px !important;padding:8px 11px;background:linear-gradient(90deg,#19242a,#0e1519);border-bottom:1px solid #574624;color:#eee2ca !important;font-size:12px !important;box-shadow:0 3px 8px #0008; }
        .depot-column-title { min-width:0;display:flex;align-items:center;gap:7px; }
        .depot-column-title b { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .depot-column-head small { display:inline-flex;align-items:center;justify-content:center;min-width:25px;padding:3px 6px;background:#080e12;border:1px solid #3b4c55;border-radius:999px;color:#8eabb9;font-size:9px; }
        .depot-column-actions { flex:none;display:flex;align-items:center;gap:4px; }
        .portable-depot-side-action { min-height:27px;padding:4px 7px;background:linear-gradient(#21303a,#11191f);border:1px solid #4e503f;border-radius:6px;color:#b9d7e6;font:850 8px var(--piw-game-font);white-space:nowrap;cursor:pointer; }
        .portable-depot-side-action[data-action="move"] { color:#73d7ff;border-color:#315d70; }
        .portable-depot-side-action[data-mode="unlock"] { color:#ffc29f;border-color:#754a37; }
        .portable-depot-side-action:disabled { opacity:.4;cursor:wait; }
        .portable-depot-empty { display:grid;place-items:center;min-height:150px;padding:20px;color:#647d8b;text-align:center;font-size:10px; }
        .portable-depot-content .depot-entry { --depot-accent:#42677a;position:relative;display:grid !important;grid-template-columns:54px minmax(0,1fr) auto auto;align-items:center;gap:9px;width:100%;min-height:79px;box-sizing:border-box;margin:0 0 7px !important;padding:8px 9px !important;background:linear-gradient(145deg,color-mix(in srgb,var(--depot-accent) 10%,#111c22),#080f13 74%) !important;border:1px solid color-mix(in srgb,var(--depot-accent) 48%,#263a45) !important;border-left:3px solid var(--depot-accent) !important;border-radius:8px !important;color:#dfe8ed !important;text-align:left;cursor:pointer;overflow:hidden;box-shadow:inset 0 1px #ffffff07,0 3px 8px #0005;transition:border-color .15s,transform .15s,background .15s; }
        .portable-depot-content .depot-entry::after { content:"";position:absolute;inset:-50% auto -50% -35%;width:18%;background:linear-gradient(100deg,transparent,#ffffff10,transparent);transform:skewX(-18deg);transition:left .42s;pointer-events:none; }
        .portable-depot-content .depot-entry:hover { border-color:color-mix(in srgb,var(--depot-accent) 75%,#d3b66c) !important;transform:translateY(-1px);background:linear-gradient(145deg,color-mix(in srgb,var(--depot-accent) 15%,#14242b),#0a1217 74%) !important; }
        .portable-depot-content .depot-entry:hover::after { left:125%; }
        .depot-entry-art { position:relative;z-index:1;display:flex;align-items:center;justify-content:center;width:50px;height:50px;background:radial-gradient(circle,#1b303b,#070d11 73%);border:1px solid color-mix(in srgb,var(--depot-accent) 50%,#294450);border-radius:8px;overflow:hidden; }
        .depot-entry-art img { width:43px !important;height:43px !important;object-fit:contain;filter:drop-shadow(0 3px 4px #000b); }.depot-pokemon-entry .depot-entry-art img{image-rendering:pixelated;}
        .depot-entry-info { position:relative;z-index:1;display:block;min-width:0 !important; }
        .depot-entry-kind { display:block;margin-bottom:3px;color:var(--depot-accent);font-size:8px;font-weight:950;letter-spacing:.1em;text-transform:uppercase; }
        .depot-entry-name { display:block;color:#f0e5cb;font-size:12px;font-weight:900;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .depot-entry-meta { display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:5px;color:#7894a4;font-size:9px;line-height:1.25; }
        .depot-entry-meta .quantity { color:#63d49a;font-weight:850; }.depot-entry-meta .quality{color:var(--depot-accent);font-weight:900;}
        .depot-entry .market-stats { display:flex;gap:3px;flex-wrap:wrap;margin-top:5px; }.depot-entry .market-stat{font-size:7px!important;padding:2px 3px!important;}
        .depot-entry-lock { position:relative;z-index:2;display:grid;place-items:center;width:29px;height:29px;padding:0 !important;background:#080e12;border:1px solid #354852;border-radius:6px;font-size:14px !important;cursor:pointer; }
        .depot-entry-action { position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;min-width:67px;min-height:29px;padding:5px 8px;background:linear-gradient(#23303a,#111a20);border:1px solid #4f4a36;border-radius:6px;color:#7bd4ff !important;font-size:9px !important;font-weight:900 !important;white-space:nowrap; }
        .depot-entry:hover .depot-entry-action { color:#171006 !important;background:linear-gradient(#dfc176,#b48937);border-color:#ac8332; }
        .depot-pokemon-entry { --depot-accent:var(--depot-tier,#6b8795) !important;min-height:100px !important; }
        .portable-depot-content.depot-view-list .depot-entry { grid-template-columns:42px minmax(0,1fr) auto auto;min-height:61px !important;padding:5px 7px !important;gap:7px; }
        .portable-depot-content.depot-view-list .depot-entry-art { width:38px;height:38px;border-radius:7px; }
        .portable-depot-content.depot-view-list .depot-entry-art img { width:33px !important;height:33px !important; }
        .portable-depot-content.depot-view-list .depot-entry-kind { display:none; }
        .portable-depot-content.depot-view-list .depot-entry-name { font-size:11px; }
        .portable-depot-content.depot-view-list .depot-entry-meta { margin-top:3px;font-size:8px; }
        .portable-depot-content.depot-view-list .depot-entry .market-stats { display:none; }
        .portable-depot-content.depot-view-list .depot-entry-action { min-width:58px;min-height:25px;padding:3px 6px;font-size:8px !important; }
        .portable-depot-content.depot-view-list .depot-entry-lock { width:25px;height:25px;font-size:12px !important; }
        .portable-depot-poke-filters { grid-column:1/-1;display:grid;grid-template-columns:minmax(190px,2fr) repeat(4,minmax(82px,1fr)) auto;gap:7px;padding:9px !important;background:linear-gradient(145deg,#101a21,#090f14) !important;border:1px solid #354334 !important;border-left:3px solid #ba9140 !important;border-radius:8px !important;box-shadow:0 3px 10px #0006; }
        .portable-depot-poke-filters input { box-sizing:border-box;width:100%;min-height:32px;padding:6px 8px;background:#071017;border:1px solid #304854;border-radius:6px;color:#dce6eb;font:600 10px var(--piw-game-font);outline:none; }.portable-depot-poke-filters input:focus{border-color:#aa8235;box-shadow:0 0 0 2px #aa823523;}
        .portable-depot-clear-filters { min-height:32px !important;padding:5px 10px !important;background:#151e23 !important;border-color:#5e5135 !important;color:#e4d9c3 !important;font:800 9px var(--piw-game-font); }
        .portable-depot-tier-filters { grid-column:1/-1;display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding-top:7px;border-top:1px solid #263a43; }
        .portable-depot-tier-label { margin-right:3px;color:#7892a1;font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase; }
        .portable-depot-tier-btn { padding:3px 7px;border:1px solid var(--tier-color);border-radius:999px;background:#070c10;color:var(--tier-color);font:900 8px var(--piw-game-font);cursor:pointer;opacity:.36;transition:opacity .15s,background .15s,box-shadow .15s; }
        .portable-depot-tier-btn.on { opacity:1;background:color-mix(in srgb,var(--tier-color) 14%,#070c10);box-shadow:0 0 7px color-mix(in srgb,var(--tier-color) 25%,transparent); }
        .portable-depot-tier-shortcut { padding:3px 7px;background:#10181d;border:1px solid #3b4d56;border-radius:5px;color:#9cafb9;font:800 8px var(--piw-game-font);cursor:pointer; }
        .portable-depot-family-header { grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px !important;background:linear-gradient(90deg,#18232a,#0b1216) !important;border:1px solid #594725 !important;border-left:3px solid #c49a42 !important;border-radius:8px !important;color:#b7c9d2 !important;font-size:10px !important;box-shadow:0 3px 9px #0006; }
        .portable-depot-family-header strong{color:#f0e0bd;font-size:12px}.portable-depot-family-header span{color:#7fa1b1}
        @media (max-width:800px) { .portable-depot-backdrop .script-portable-depot-window{height:min(840px,95vh)}.portable-depot-backdrop .depot-head{align-items:stretch;flex-wrap:wrap}.portable-depot-brand{flex:1}.portable-depot-tabs{order:3;flex-basis:100%;justify-content:flex-start;overflow-x:auto}.portable-depot-content{grid-template-columns:1fr;grid-template-rows:auto;overflow-y:auto}.portable-depot-content>.portable-depot-column{min-height:270px;height:auto}.portable-depot-poke-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.portable-depot-poke-filters input:first-child{grid-column:1/-1}.portable-depot-clear-filters{grid-column:1/-1}.depot-column-head{align-items:flex-start;flex-wrap:wrap}.depot-column-actions{width:100%}.portable-depot-side-action{flex:1} }
        .portable-shop-heading {
            margin: 8px 0 0;
            padding: 7px 3px 5px;
            color: rgb(240, 230, 210);
            border-bottom: 1px solid rgba(200, 170, 110, .2);
            font: 700 14px Cinzel, "Cinzel Fallback", serif;
        }
        .portable-ball-backdrop { background:rgba(0,0,0,.72) !important;backdrop-filter:blur(2px); }
        .script-portable-ball-window { border:2px solid #785a28 !important;border-radius:11px !important;background:linear-gradient(145deg,#0c1319,#070b0f) !important;box-shadow:0 18px 55px #000d,inset 0 0 0 1px #d5b36612 !important;overflow:hidden; }
        .script-portable-ball-window .ball-head { min-height:52px;padding:10px 14px !important;background:linear-gradient(180deg,#151c22,#0b1116) !important;border-bottom:1px solid #745725 !important;box-shadow:0 3px 12px #0008; }
        .script-portable-ball-window .ball-head > b { color:#f0e6ce !important;font-size:16px;font-weight:850;letter-spacing:.015em;text-shadow:0 1px 2px #000; }
        .script-portable-ball-window .ball-gold { padding:5px 10px;color:#72e69b !important;background:#07120c;border:1px solid #6b5420;border-radius:7px;font-size:12px;font-weight:900;box-shadow:inset 0 0 8px #0008; }
        .script-portable-ball-window .hunt-sell-open { min-height:29px;padding:5px 10px !important;background:linear-gradient(#2a3238,#171e23) !important;border-color:#5f5131 !important;color:#e9dfca !important; }
        .script-portable-ball-window .portable-ball-close { color:#a9b7c1 !important;font-size:20px !important;transition:color .15s,transform .15s; }
        .script-portable-ball-window .portable-ball-close:hover { color:#f2d892 !important;transform:scale(1.08); }
        .script-portable-ball-window .portable-ball-status { min-height:0;padding:7px 14px !important;color:#7894a5 !important;background:#080d11;border-bottom:1px solid #17242c; }
        .script-portable-ball-window .portable-ball-status:empty { display:none; }
        .script-portable-ball-window .portable-ball-list { grid-template-columns:repeat(2,minmax(0,1fr));gap:10px !important;padding:11px 12px 14px !important;background:linear-gradient(#080d11,#060a0d); }
        .script-portable-ball-window .portable-shop-heading { grid-column:1/-1;display:flex;align-items:center;gap:8px;margin:8px 0 0;padding:8px 10px;color:#eadcbf;background:linear-gradient(90deg,#171d20,#0a0f13);border:1px solid #4b3d23;border-left:3px solid #c39b43;border-radius:7px;font:800 13px var(--piw-game-font);letter-spacing:.025em;box-shadow:0 3px 9px #0006; }
        .script-portable-ball-window .ball-row { display:grid !important;position:relative;grid-template-columns:68px minmax(0,1fr) !important;grid-template-rows:minmax(72px,auto) minmax(42px,auto);grid-template-areas:"visual info" "actions actions" !important;gap:12px !important;align-items:center !important;height:auto !important;min-height:175px !important;padding:14px 12px !important;background:linear-gradient(145deg,#101b22,#0a1116) !important;border:1px solid #263d4b !important;border-radius:9px !important;box-shadow:inset 0 1px #ffffff08,0 4px 12px #0006;transition:border-color .15s,transform .15s,background .15s;overflow:hidden; }
        .script-portable-ball-window .ball-row:hover { border-color:#9b7934 !important;background:linear-gradient(145deg,#14242e,#0c151b) !important;transform:translateY(-1px); }
        .script-portable-ball-window .ball-row::after { content:"";position:absolute;z-index:0;top:-50%;left:-70%;width:34%;height:200%;pointer-events:none;background:linear-gradient(105deg,transparent,#ffffff0d,transparent);transform:skewX(-18deg);transition:left .55s ease; }
        .script-portable-ball-window .ball-row:hover::after { left:135%; }
        .script-portable-ball-window .ball-row > * { position:relative;z-index:1; }
        .script-portable-ball-window .portable-ball-info { display:contents !important; }
        .script-portable-ball-window .portable-ball-visual { grid-area:visual;width:64px;height:64px;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,#1b303d,#080e13 72%);border:1px solid #294554;border-radius:9px; }
        .script-portable-ball-window .portable-ball-visual img { width:52px !important;height:52px !important;object-fit:contain;filter:drop-shadow(0 3px 4px #000b); }
        .script-portable-ball-window .portable-ball-details { grid-area:info;min-width:0; }
        .script-portable-ball-window .portable-ball-kind { display:block;color:#68899d;font-size:9px;font-weight:850;letter-spacing:.09em;text-transform:uppercase;margin-bottom:3px; }
        .script-portable-ball-window .portable-ball-name { display:block;color:#f0e5cb !important;font-size:14px;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .script-portable-ball-window .portable-ball-meta { display:flex;flex-wrap:wrap;gap:4px 7px;margin-top:5px;font-size:10px; }
        .script-portable-ball-window .portable-ball-owned { color:#65d6a3; }
        .script-portable-ball-window .portable-ball-price { color:#f0c762; }
        .script-portable-ball-window .ball-actions { grid-area:actions;display:grid !important;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px !important;min-height:40px;padding-top:11px;border-top:1px solid #1c303b; }
        .script-portable-ball-window .ball-buy { min-width:0;min-height:34px;padding:6px 4px;background:linear-gradient(#202c34,#121a20);color:#e9ddc5;border:1px solid #735a28;border-radius:6px;font:850 10px var(--piw-game-font);cursor:pointer;box-shadow:inset 0 1px #ffffff0d,0 2px 5px #0006; }
        .script-portable-ball-window .ball-buy:hover { color:#181006;background:linear-gradient(#e1c478,#b78c39);border-color:#9b742c; }
        .script-portable-ball-window .ball-buy:disabled { opacity:.45;filter:grayscale(.7);cursor:wait; }
        @media (max-width:760px) {
            .script-portable-ball-window .portable-ball-list { grid-template-columns:1fr; }
            .script-portable-ball-window .ball-row { min-height:165px !important; }
        }
        @media (max-width: 760px) {
            .portable-depot-poke-filters { grid-template-columns: 1fr 1fr; }
            .portable-depot-poke-filters input:first-child { grid-column: 1 / -1; }
        }

        .dex-script-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 10px; border-top: 1px solid #1a2d3a; }
        .dex-fbtn { padding: 4px 10px; border: 1px solid #273f52; background: #0c161f; color: #a0aec0; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
        .dex-fbtn:hover { border-color: #3182ce; color: #e2e8f0; }
        .dex-fbtn.on { background: #3182ce; color: #fff; border-color: #3182ce; }

        .hunt-capture-badge {
            display: inline-block; width: 13px; height: 13px; min-width: 13px; border-radius: 50%;
            border: 1px solid #1a1a1a; position: relative; flex-shrink: 0;
            background: linear-gradient(to bottom, #e53e3e 0%, #e53e3e 46%, #1a1a1a 46%, #1a1a1a 54%, #f7fafc 54%, #f7fafc 100%);
        }
        .hunt-capture-badge::after {
            content: ''; position: absolute; top: 50%; left: 50%; width: 4px; height: 4px;
            background: #f7fafc; border: 1px solid #1a1a1a; border-radius: 50%; transform: translate(-50%, -50%);
        }
        .hunt-capture-badge.not-caught { filter: grayscale(1) brightness(0.65); opacity: 0.5; }
        .dex-ft-label { display: flex; align-items: center; gap: 4px; color: #a0aec0; font-size: 12px; cursor: pointer; margin-left: auto; }
        .dex-ft-label input { cursor: pointer; }
        .dex-cell.dex-hidden { display: none !important; }

        /* Hunt Analyzer Compact Mode */
        .ha-window.ha-compact {
            width: 320px; min-width: 300px; max-width: 90vw;
            min-height: 360px; max-height: 90vh;
            box-sizing: border-box !important; resize: both !important;
            overflow: auto !important; border-radius: 12px !important;
        }
        .ha-window:not(.ha-compare-modal) { opacity: 1 !important; }
        .ha-window.ha-compact .ha-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 4px !important; }
        .ha-window.ha-compact .ha-card { padding: 4px 8px !important; flex-direction: row !important; align-items: center !important; justify-content: flex-start !important; gap: 8px !important; }
        .ha-window.ha-compact .ha-card small { display: none !important; }
        .ha-window.ha-compact .ha-card-ico { font-size: 16px !important; margin: 0 !important; }
        .ha-window.ha-compact .ha-card b { font-size: 14px !important; }
        .ha-window.ha-compact .ha-balance { font-size: 14px !important; padding: 4px !important; flex-direction: row !important; justify-content: space-between !important; }
        .ha-window.ha-compact .ha-balance span { display: none !important; }
        .ha-window.ha-compact .ha-balance::before { content: 'Balance'; font-weight: bold; }
        .ha-window.ha-compact .ha-rates { display: flex !important; flex-direction: column !important; align-items: stretch !important; gap: 4px !important; padding: 4px !important; font-size: 11px !important; }
        .ha-window.ha-compact .ha-rates span { width: 100% !important; text-align: center !important; margin: 0 !important; }
        .ha-window.ha-compact .ha-drops-head, .ha-window.ha-compact .ha-note { display: none !important; }
        .ha-window.ha-compact .ha-clog-btn { display: none !important; }
        .ha-window.ha-compact .ha-drops { display: none !important; }
        .ha-window.ha-compact .ha-drops.show-drops {
            display: flex !important; max-height: none !important; min-height: 80px !important;
            overflow-y: auto !important; padding: 6px !important; flex: 1 1 auto !important;
            border-radius: 8px !important;
        }
        
        /* Hunt Analyzer Custom UI */
        .ha-script-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin: 0; padding: 8px; border-bottom: 1px solid #1b3040; }
        .ha-sbtn { background: #1a2d3a; color: #a0aec0; border: 1px solid #273f52; border-radius: 6px; padding: 6px 4px; font-size: 11px; cursor: pointer; transition: all 0.15s ease; text-align: center; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 4px; }
        .ha-sbtn:hover { background: #3182ce; color: #fff; border-color: #3182ce; }
        .ha-catch-stats { display: block; width: 100%; text-align: center; margin-top: 4px; }
        .ha-catch-stats.hidden { display: none !important; }
        .ha-rates { flex-wrap: wrap !important; }

        /* Compare Modal */
        .ha-compare-backdrop { position: fixed; inset: 0; z-index: 10100; pointer-events: none; }
        .ha-compare-modal {
            pointer-events: auto; position: fixed !important; left: 50%; top: 50%;
            transform: translate(-50%, -50%); width: min(580px, 92vw);
            min-width: 360px; min-height: 420px; max-width: 94vw; max-height: 90vh;
            overflow: auto !important; resize: both; border-radius: 14px !important;
            border: 1px solid #315269 !important; background: #0b151e !important;
            box-shadow: 0 20px 55px rgba(0,0,0,.82) !important; padding-bottom: 12px;
        }
        .ha-compare-modal .ha-title { position: sticky; top: 0; z-index: 2; background: #12222e; padding: 11px 13px; }
        .ha-compare-modal .ha-title { display: flex !important; align-items: center; gap: 8px; }
        .ha-compare-modal .ha-title > span { flex: 1 1 auto; min-width: 0; }
        .ha-compare-modal .ha-x {
            position: static !important; inset: auto !important; flex: 0 0 auto;
            width: 30px !important; height: 30px !important; margin: 0 !important;
        }
        .ha-compare-table { width: 100%; min-width: 500px; border-collapse: separate; border-spacing: 0 5px; font-size: 13px; }
        .ha-compare-table th { text-align: center; padding: 8px; color: #91a7b8; font-weight: 600; }
        .ha-compare-table td { padding: 9px; background:#101f2a; text-align: center; font-weight: bold; }
        .ha-compare-table td:first-child { border-radius: 7px 0 0 7px; }
        .ha-compare-table td:last-child { border-radius: 0 7px 7px 0; }
        .ha-compare-table tr:nth-child(even) { background-color: transparent; }
        .ha-compare-table td:first-child { text-align: left; font-weight: normal; color: #a0aec0; }
        .ha-compare-winner { color: #48bb78 !important; }
        .ha-compare-loser { color: #f56565 !important; }
        .ha-compare-modal .ha-title { cursor: grab; user-select: none; }
        .ha-compare-modal .ha-title:active { cursor: grabbing; }
        .ha-compare-backdrop {
            pointer-events: none !important;
            display: block !important;
            padding: 0 !important;
            background: transparent !important;
            backdrop-filter: none !important;
        }
        .ha-compare-modal {
            position: fixed !important;
            left: 50% !important; top: 50% !important; right: auto !important; bottom: auto !important;
            width: min(760px, 94vw);
            max-width: 94vw !important;
            max-height: 88vh !important;
            resize: both !important;
            overflow: auto !important;
            transform: translate(-50%, -50%);
        }
        .ha-compare-modal .ha-title { position: sticky !important; padding-right: 52px !important; }
        .ha-compare-modal .ha-x { position:absolute !important;right:10px !important;top:8px !important;left:auto !important;bottom:auto !important;z-index:4; }
        .ha-compare-modal > div:nth-child(2) { padding: 14px !important; }
        .ha-compare-table { width:100% !important; min-width: 440px !important; border-spacing: 0 7px !important; }
        .ha-compare-table th { background: transparent !important; color: #c7b98f !important; font-size: 12px; }
        .ha-compare-table td { background: rgba(255,255,255,.025) !important; border-top: 1px solid rgba(255,255,255,.04); border-bottom: 1px solid rgba(255,255,255,.04); }
        .ha-history-list > div { background: rgba(255,255,255,.025) !important; border: 1px solid rgba(255,255,255,.05); border-radius: 8px !important; }
        @media (max-width: 640px) {
            .ha-compare-modal > div:nth-child(2) { overflow-x: auto; }
            .ha-compare-table { min-width: 520px !important; }
        }

        /* Inventário não bloqueante e redimensionável */
        .script-inventory-backdrop {
            background: transparent !important; backdrop-filter: none !important;
            pointer-events: none !important;
        }
        .script-inventory-backdrop .inv-window, .inv-window.script-resizable-inventory {
            pointer-events: auto !important; resize: both !important; overflow: auto !important;
            min-width: 260px !important; min-height: 250px !important;
            max-width: 98vw !important; max-height: 95vh !important;
            border-radius: 12px !important;
        }
        .inv-window.script-resizable-inventory .inv-grid,
        .inv-window.script-resizable-inventory .inv-items,
        .inv-window.script-resizable-inventory .inv-slots {
            width: auto !important; max-width: 100% !important; min-width: 0 !important;
            box-sizing: border-box !important;
            display: grid !important;
            grid-template-columns: repeat(auto-fill, 42px) !important;
            grid-auto-rows: 42px !important;
            justify-content: start !important; align-content: start !important;
            gap: 6px !important; padding: 8px 12px !important;
            overflow: auto !important;
        }
        .inv-window.script-resizable-inventory .inv-slot {
            width: 42px !important; height: 42px !important;
            min-width: 42px !important; max-width: 42px !important;
            min-height: 42px !important; max-height: 42px !important;
            aspect-ratio: auto !important; justify-self: start !important;
        }
        .script-capture-log-window { border-radius: 14px !important; overflow: hidden !important; }
        .script-capture-log-window .script-quality-badge {
            display: inline-block !important; margin: 0 !important; padding: 0 !important;
            white-space: nowrap !important; border: 0 !important; border-radius: 0 !important;
            background: transparent !important; font-size: inherit !important; font-weight: 800 !important;
        }
        /* Densidad del Market en píxeles CSS reales: nunca rasterizar la ventana con zoom. */
        @media (min-width:1101px) {
            .script-market-window {
                width:1180px !important;
                max-width:none !important;
                height:min(720px,110vh) !important;
                max-height:none !important;
                zoom:1 !important;
            }
        }

        /* Responsive layout shared by every script window. */
        @media (max-width: 900px) {
            .script-market-backdrop,.portable-ball-backdrop,.portable-depot-backdrop,.hunt-sell-backdrop,
            .sell-confirm-backdrop { box-sizing:border-box;padding:8px !important; }
            .script-market-window { width:min(860px,97vw) !important;max-width:97vw !important;height:min(780px,94vh) !important;max-height:94vh !important; }
            .script-market-window .market-list.market-view-cards { grid-template-columns:repeat(2,minmax(0,1fr));gap:10px !important; }
            .script-market-window .market-buy-controls { align-items:stretch; }
            .script-market-window .market-search { order:4;flex-basis:100% !important; }
            .market-sell-editor { grid-template-columns:72px minmax(0,1fr);grid-template-areas:"art info" "form form"; }
            .market-sell-editor-form,.market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"qty currency" "price price" "submit submit" "summary summary"; }
            .market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-areas:"currency currency" "price price" "submit submit" "summary summary"; }
            .market-sell-editor-form .market-sell-submit { width:100%; }
            .hunt-sell-backdrop .hunt-sell-list { grid-template-columns:1fr; }
            .map-window { width:97vw !important;max-width:97vw !important;height:94vh !important;max-height:94vh !important; }
            .script-map-filter-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
            .script-map-field:first-child { grid-column:1/-1; }
            .script-map-filter-actions { grid-column:1/-1; }
            #simple-hunts-container.script-map-card-grid { grid-template-columns:1fr; }
            .script-portable-ball-window { width:min(820px,97vw) !important;max-width:97vw !important;max-height:94vh !important; }
            .portable-depot-backdrop .script-portable-depot-window { width:97vw !important;max-width:97vw !important;height:94vh !important;max-height:94vh !important; }
            .hunt-sell-backdrop .script-npc-sell-window { width:min(820px,97vw) !important;max-width:97vw !important;max-height:94vh !important; }
            .cfg-window.script-mods-open { width:97vw !important;max-width:97vw !important;height:94vh !important;max-height:94vh !important; }
        }

        @media (max-width: 640px) {
            .script-market-backdrop,.portable-ball-backdrop,.portable-depot-backdrop,.hunt-sell-backdrop,
            .sell-confirm-backdrop { padding:4px !important;align-items:center !important; }
            .script-market-window,.script-portable-ball-window,.portable-depot-backdrop .script-portable-depot-window,
            .hunt-sell-backdrop .script-npc-sell-window,.cfg-window.script-mods-open {
                width:calc(100vw - 8px) !important;max-width:calc(100vw - 8px) !important;
                height:calc(100dvh - 8px) !important;max-height:calc(100dvh - 8px) !important;border-radius:8px !important;
            }
            .script-market-window .mk-head { min-height:auto;padding:8px !important;flex-wrap:wrap;gap:6px !important; }
            .script-market-window .market-head-primary { flex-basis:calc(100% - 34px);flex-wrap:wrap;gap:6px; }
            .script-market-window .market-head-primary > b { font-size:14px; }
            .script-market-window .market-player-balance { order:2;flex-basis:100%;padding:5px 0 0;border-left:0;border-top:1px solid #293943; }
            .script-market-window .market-refresh { margin-left:auto; }
            .script-market-tabs { display:grid !important;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px !important;padding:6px !important; }
            .script-market-window .market-tab { min-width:0 !important;width:100%;padding:5px 3px !important; }
            .script-market-window .market-tab-label { display:none; }
            .script-market-window .market-view-toggle { grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr; }
            .script-market-window .market-view-text { display:inline !important; }
            .script-market-window .market-buy-controls,.script-market-window .market-sell-controls,.script-market-window .market-pokemon-filters { margin:5px 6px 0;padding:6px !important;gap:5px !important; }
            .script-market-window .market-category,.script-market-window .market-sort,.script-market-window .market-item-rarity-filter { flex:1 1 calc(50% - 5px);min-width:0; }
            .script-market-window .market-search { flex-basis:100% !important;min-width:100% !important; }
            .script-market-window .market-list.market-view-cards,.script-market-window .market-list.market-view-list { grid-template-columns:1fr;gap:8px !important;padding:7px !important; }
            .market-view-cards .market-buy-row.market-listing-row,.market-view-list .market-buy-row.market-listing-row { grid-template-columns:56px minmax(0,1fr);grid-template-rows:auto auto;grid-template-areas:"art main" "footer footer";min-height:0 !important;padding:10px !important; }
            .market-view-cards .market-buy-row.market-pokemon-listing,.market-view-list .market-buy-row.market-pokemon-listing { grid-template-rows:auto auto auto;grid-template-areas:"art main" "stats stats" "footer footer"; }
            .market-pokemon-listing .market-main { padding-right:76px; }
            .market-pokemon-listing > .market-card-stats { gap:4px;padding:6px; }
            .market-view-cards .market-art,.market-view-list .market-art { width:54px;height:54px; }
            .market-buy-footer,.market-pokemon-listing .market-buy-footer { grid-template-columns:minmax(62px,.55fr) minmax(0,1fr);grid-template-rows:auto auto auto;grid-template-areas:"footerQty footerPrice" "footerQty footerConversion" "footerActions footerActions";min-height:0; }
            .market-pokemon-listing .market-buy-footer { grid-template-areas:"footerPrice footerPrice" "footerConversion footerConversion" "footerActions footerActions"; }
            .market-buy-footer .market-actions { justify-self:stretch;justify-content:stretch; }
            .market-buy-footer .market-actions input { flex:1;min-width:0;width:auto !important; }
            .market-buy-footer .market-actions .market-buy { flex:1; }
            .market-sell-editor { margin:6px;padding:8px;grid-template-columns:58px minmax(0,1fr);gap:8px; }
            .market-sell-editor-art { width:56px;height:56px; }
            .market-sell-editor-form,.market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-columns:1fr;grid-template-areas:"qty" "currency" "price" "submit" "summary"; }
            .market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-areas:"currency" "price" "submit" "summary"; }
            .market-request-controls { margin:6px;padding:8px; }
            .market-request-form { grid-template-columns:1fr; }
            .market-request-field:first-of-type,.market-request-submit,.market-request-summary { grid-column:1; }
            .market-request-options { max-height:42vh; }
            .market-view-cards .market-request-row,.market-view-cards .market-history-row { min-height:210px !important; }

            .map-window { width:calc(100vw - 8px) !important;max-width:calc(100vw - 8px) !important;height:calc(100dvh - 8px) !important;max-height:calc(100dvh - 8px) !important; }
            .map-window .map-body { padding:0 6px 7px !important; }
            .script-map-filter-grid { grid-template-columns:1fr; }
            .script-map-field,.script-map-field:first-child,.script-map-filter-actions { grid-column:1; }
            .script-map-filter-actions button { width:100%; }
            #simple-hunts-container.script-map-card-grid > .script-map-card { grid-template-columns:54px minmax(0,1fr);min-height:118px;padding:8px !important; }
            #simple-hunts-container .script-map-card-art { width:50px !important;height:50px !important;min-width:50px !important; }
            #simple-hunts-container .script-map-card-actions { grid-column:1/-1;justify-content:stretch; }

            .portable-depot-backdrop .depot-head,.script-portable-ball-window .ball-head,.hunt-sell-backdrop .sell-confirm-title { flex-wrap:wrap;gap:6px; }
            .portable-depot-tabs { order:3;flex-basis:100%;overflow-x:auto;justify-content:flex-start;scrollbar-width:none; }
            .portable-depot-content { display:block !important;overflow-y:auto !important; }
            .portable-depot-content > .portable-depot-column { height:auto !important;min-height:240px;margin-bottom:8px; }
            .portable-depot-content .depot-entry,.portable-depot-content.depot-view-list .depot-entry { grid-template-columns:42px minmax(0,1fr) auto;gap:6px; }
            .portable-depot-content .depot-entry-action { grid-column:2/-1;width:100%; }
            .portable-depot-poke-filters { grid-template-columns:1fr !important; }
            .portable-depot-poke-filters > * { grid-column:1 !important; }
            .script-portable-ball-window .ball-head > b { flex-basis:100%; }
            .script-portable-ball-window .portable-ball-list { grid-template-columns:1fr;padding:7px !important; }
            .script-portable-ball-window .ball-row { min-height:0 !important;padding:10px !important; }
            .script-portable-ball-window .ball-actions { grid-template-columns:repeat(3,minmax(0,1fr)); }

            .hunt-sell-backdrop .script-npc-sell-window .sell-confirm-body { padding:7px !important; }
            .hunt-sell-backdrop .hunt-sell-row,.hunt-sell-backdrop .npc-pokemon-row { grid-template-columns:auto 44px minmax(0,1fr) 31px !important;min-height:94px;gap:6px !important;padding:7px !important; }
            .hunt-sell-backdrop .hunt-sell-art,.hunt-sell-backdrop .npc-pokemon-row .hunt-sell-art { width:42px;height:42px; }
            .hunt-sell-backdrop .hunt-sell-row input[type="number"] { grid-column:2/4;width:100%; }
            .hunt-sell-backdrop .sell-confirm-footer { grid-template-columns:1fr;gap:5px; }

            .cfg-window.script-mods-open .cfg-tabs { overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none; }
            .cfg-window.script-mods-open .cfg-tab { flex:none; }
            .cfg-mods-content .script-mods-grid,.script-mod-category-grid { grid-template-columns:1fr !important;padding:7px !important;gap:7px !important; }
            .script-settings-brand,.script-language-control { width:100%; }
            .cfg-seg { flex-wrap:wrap; }
            .cfg-seg-btn { min-height:36px; }

            .sell-confirm-modal:not(.script-npc-sell-window):not(.script-portable-depot-window) { width:calc(100vw - 16px) !important;max-width:calc(100vw - 16px) !important;max-height:calc(100dvh - 16px);overflow:auto; }
            .ha-compare-modal { left:4px !important;top:4px !important;width:calc(100vw - 8px) !important;max-width:calc(100vw - 8px) !important;max-height:calc(100dvh - 8px) !important; }
            .ha-compare-modal > div:nth-child(2) { overflow:auto !important;padding:8px !important; }
            .inv-window.script-resizable-inventory { left:4px !important;top:4px !important;width:calc(100vw - 8px) !important;max-width:calc(100vw - 8px) !important;height:auto;max-height:calc(100dvh - 8px) !important;resize:none !important; }
        }
        /* Hover unificado y liviano: sin reflejos móviles ni animaciones continuas. */
        .market-buy-row::after,.market-sell-row::after,
        #simple-hunts-container.script-map-card-grid > .script-map-card::after,
        .portable-depot-content .depot-entry::after,
        .script-portable-ball-window .ball-row::after { display:none !important; }
        .market-buy-row,.market-sell-row,.market-request-row,.market-history-row,
        .market-similar-card,#simple-hunts-container.script-map-card-grid > .script-map-card,
        .hunt-sell-backdrop .hunt-sell-row,.portable-depot-content .depot-entry,
        .script-portable-ball-window .ball-row,
        .cfg-mods-content .script-mod-category-grid > .cfg-row,
        .ha-window .ha-card,.market-row,.market-listing {
            --script-hover-glow:rgba(87,190,231,.20);
            transition:transform .12s ease-out,box-shadow .12s ease-out,border-color .12s ease-out !important;
            transform-origin:center;
        }
        .market-pokemon-quality { --script-hover-glow:color-mix(in srgb,var(--market-tier-color) 28%,transparent); }
        .market-item-rarity { --script-hover-glow:color-mix(in srgb,var(--market-item-color) 26%,transparent); }
        .market-similar-card { --script-hover-glow:color-mix(in srgb,var(--similar-tier) 27%,transparent); }
        #simple-hunts-container.script-map-card-grid > .script-map-card { --script-hover-glow:color-mix(in srgb,var(--card-accent) 26%,transparent); }
        .portable-depot-content .depot-entry { --script-hover-glow:color-mix(in srgb,var(--depot-accent) 25%,transparent); }
        @media (hover:hover) and (pointer:fine) {
            .market-buy-row:hover,.market-sell-row:hover,.market-request-row:hover,.market-history-row:hover,
            .market-similar-card:hover,#simple-hunts-container.script-map-card-grid > .script-map-card:hover,
            .hunt-sell-backdrop .hunt-sell-row:hover,.portable-depot-content .depot-entry:hover,
            .script-portable-ball-window .ball-row:hover,
            .cfg-mods-content .script-mod-category-grid > .cfg-row:hover,
            .ha-window .ha-card:hover,.market-row:hover,.market-listing:hover {
                transform:scale(1.008) !important;
                box-shadow:0 6px 16px rgba(0,0,0,.48),0 0 11px var(--script-hover-glow) !important;
            }
            .script-market-window button:not(:disabled),.script-portable-ball-window button:not(:disabled),
            .portable-depot-backdrop button:not(:disabled),.hunt-sell-backdrop button:not(:disabled),
            .map-window button:not(:disabled),.cfg-window button:not(:disabled),
            .ha-window button:not(:disabled),.dex-script-controls button:not(:disabled) {
                transition:transform .1s ease-out,box-shadow .1s ease-out,border-color .1s ease-out,color .1s ease-out,background-color .1s ease-out !important;
            }
            .script-market-window button:not(:disabled):hover,.script-portable-ball-window button:not(:disabled):hover,
            .portable-depot-backdrop button:not(:disabled):hover,.hunt-sell-backdrop button:not(:disabled):hover,
            .map-window button:not(:disabled):hover,.cfg-window button:not(:disabled):hover,
            .ha-window button:not(:disabled):hover,.dex-script-controls button:not(:disabled):hover {
                transform:scale(1.025) !important;
                box-shadow:0 2px 7px rgba(0,0,0,.45),0 0 7px rgba(224,190,103,.18);
            }
        }
        @media (hover:none), (prefers-reduced-motion:reduce) {
            .script-market-backdrop,.portable-ball-backdrop,.portable-depot-backdrop,.hunt-sell-backdrop { backdrop-filter:none !important; }
            .market-buy-row,.market-sell-row,.market-request-row,.market-history-row,.market-similar-card,
            .script-map-card,.ball-row,.depot-entry,.hunt-sell-row,
            .cfg-mods-content .script-mod-category-grid > .cfg-row,
            .ha-window .ha-card,.market-row,.market-listing,
            .script-market-window button,.script-portable-ball-window button,
            .portable-depot-backdrop button,.hunt-sell-backdrop button,
            .map-window button,.cfg-window button,.ha-window button,.dex-script-controls button {
                transition:none !important;transform:none !important;
            }
            .market-buy-row::after,.market-sell-row::after,.script-map-card::after,.ball-row::after,.depot-entry::after { display:none !important; }
        }
        /* Market Global 10.1: superficies planas, esquinas rectas y color semántico sobrio. */
        .market-alert-controls[hidden] { display:none !important; }
        .script-market-window .market-list.market-view-cards { gap:8px !important; }
        .script-market-window .market-list.market-view-list { gap:3px !important; }
        .script-market-window .market-buy-row,
        .script-market-window .market-sell-row,
        .script-market-window .market-request-row,
        .script-market-window .market-history-row {
            background:#101820 !important;
            border:1px solid #2a3a44 !important;
            border-radius:0 !important;
            box-shadow:none !important;
            transform:none !important;
            transition:background-color .12s ease,border-color .12s ease !important;
        }
        .script-market-window .market-buy-row:hover,
        .script-market-window .market-sell-row:hover,
        .script-market-window .market-request-row:hover,
        .script-market-window .market-history-row:hover {
            background:#142029 !important;
            border-color:#47606d !important;
            box-shadow:none !important;
            transform:none !important;
        }
        .script-market-window .market-pokemon-quality {
            background:color-mix(in srgb,var(--market-tier-color) 7%,#101820) !important;
            border-color:color-mix(in srgb,var(--market-tier-color) 54%,#2a3a44) !important;
            box-shadow:none !important;
        }
        .script-market-window .market-pokemon-quality:hover {
            background:color-mix(in srgb,var(--market-tier-color) 11%,#142029) !important;
            border-color:color-mix(in srgb,var(--market-tier-color) 72%,#47606d) !important;
            box-shadow:none !important;
            transform:none !important;
        }
        .script-market-window .market-pokemon-quality::before {
            background:var(--market-tier-color) !important;
            box-shadow:none !important;
        }
        .script-market-window .market-item-rarity {
            background:color-mix(in srgb,var(--market-item-color) 7%,#101820) !important;
            border-color:color-mix(in srgb,var(--market-item-color) 52%,#2a3a44) !important;
            box-shadow:none !important;
        }
        .script-market-window .market-item-rarity:hover {
            background:color-mix(in srgb,var(--market-item-color) 11%,#142029) !important;
            border-color:color-mix(in srgb,var(--market-item-color) 70%,#47606d) !important;
            box-shadow:none !important;
            transform:none !important;
        }
        .script-market-window .market-item-rarity::before {
            background:var(--market-item-color) !important;
            box-shadow:none !important;
        }
        .script-market-window .market-art {
            background:#0a1218 !important;
            border-radius:0 !important;
            box-shadow:none !important;
        }
        .script-market-window .market-art img { filter:none !important; }
        .script-market-window .market-quality-tier,
        .script-market-window .market-item-rarity-badge {
            border-radius:2px !important;
            background:#0a1218 !important;
            box-shadow:none !important;
            text-shadow:none !important;
        }
        .script-market-window .market-pokemon-listing > .market-card-stats,
        .script-market-window .market-stat,
        .script-market-window .market-buy-footer .market-data-box {
            border-radius:0 !important;
            background:#0b1319 !important;
            box-shadow:none !important;
        }
        .script-market-window .market-buy-footer .market-quantity { background:#0c1715 !important; }
        .script-market-window .market-buy-footer .market-price { background:#171507 !important; }
        .script-market-window .market-buy-footer .market-conversion { background:#0a151b !important; }
        .script-market-window .market-favorite-toggle,
        .script-market-window .market-featured-toggle,
        .script-market-window .market-tab-count {
            border-radius:0 !important;
            box-shadow:none !important;
        }
        .script-market-window .market-buy,
        .script-market-window .market-sell-submit,
        .script-market-window .market-cancel-listing,
        .script-market-window .market-request-submit,
        .script-market-window .market-view-btn {
            border-radius:0 !important;
            box-shadow:none !important;
            transform:none !important;
        }
        .script-market-window .market-buy,
        .script-market-window .market-sell-submit,
        .script-market-window .market-request-submit {
            background:#b58b3e !important;
            border-color:#75591f !important;
        }
        .script-market-window .market-buy:hover,
        .script-market-window .market-sell-submit:hover,
        .script-market-window .market-request-submit:hover {
            background:#c39a4b !important;
            box-shadow:none !important;
            transform:none !important;
        }
        .script-market-window .market-sell-row.on {
            background:#191812 !important;
            border-color:#a78338 !important;
            box-shadow:none !important;
        }
        /* Calculadora IV nativa: un único escenario centra y distribuye Market + calculadora. */
        .script-market-backdrop {
            --market-iv-width:clamp(286px,28vw,340px);
            --market-iv-gap:10px;
            --market-stage-closed:min(1180px,calc(100vw - 32px));
            --market-stage-open:min(calc(1180px + var(--market-iv-width) + var(--market-iv-gap)),calc(100vw - 32px));
        }
        .market-iv-stage {
            position:relative;
            width:var(--market-stage-closed);
            height:min(720px,88vh);
            min-width:0;
            display:block;
            transition:width .32s cubic-bezier(.22,.8,.25,1),left .32s cubic-bezier(.22,.8,.25,1);
        }
        .script-market-backdrop.market-iv-open > .market-iv-stage { left:0; width:var(--market-stage-open); }
        .market-iv-stage > .script-market-window {
            position:relative;
            z-index:2;
            box-sizing:border-box;
            width:100% !important;
            max-width:none !important;
            height:100% !important;
            max-height:none !important;
            zoom:1 !important;
            transition:width .32s cubic-bezier(.22,.8,.25,1);
            will-change:auto;
        }
        .script-market-backdrop.market-iv-open > .market-iv-stage > .script-market-window {
            width:calc(100% - var(--market-iv-width) - var(--market-iv-gap)) !important;
        }
        .market-iv-calculator {
            position:absolute;
            z-index:1;
            top:0;
            right:0;
            width:var(--market-iv-width);
            height:100%;
            box-sizing:border-box;
            display:flex;
            flex-direction:column;
            overflow:hidden;
            color:#dce7ed;
            background:#0b141b;
            border:1px solid #365162;
            border-radius:0;
            box-shadow:0 16px 45px rgba(0,0,0,.72);
            opacity:0;
            visibility:hidden;
            pointer-events:none;
            transform:translateX(calc((var(--market-iv-width) + var(--market-iv-gap)) * -1)) scale(.975);
            transform-origin:left center;
            transition:transform .32s cubic-bezier(.2,.84,.26,1),opacity .18s ease,visibility 0s linear .32s;
        }
        .script-market-backdrop.market-iv-open > .market-iv-stage > .market-iv-calculator {
            opacity:1;
            visibility:visible;
            pointer-events:auto;
            transform:none;
            transition-delay:0s;
        }
        .market-iv-head { min-height:46px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;border-bottom:1px solid #29404d;background:#101c24; }
        .market-iv-head > div { display:grid;gap:1px; }
        .market-iv-head small,.market-iv-inputs small,.market-iv-name-field small,.market-iv-power-box small { color:#7ea1b4;font-size:8px;font-weight:900;letter-spacing:.12em; }
        .market-iv-head b { color:#f0d287;font-size:13px; }
        .market-iv-close { width:28px;height:28px;padding:0;color:#d7e1e7;background:#15232c;border:1px solid #3b5260;border-radius:0;font-size:18px;line-height:1; }
        .market-iv-close:hover { color:#fff;background:#263946;border-color:#6c8796; }
        .market-iv-scroll { min-height:0;overflow:auto;padding:8px;scrollbar-width:thin;scrollbar-color:#405b69 #0b141b; }
        .market-iv-identity { display:grid;grid-template-columns:46px minmax(0,1fr) 28px;align-items:center;gap:7px;padding-bottom:7px;border-bottom:1px solid #20333f; }
        .market-iv-sprite { width:44px;height:44px;display:grid;place-items:center;background:#091017;border:1px solid #324955; }
        .market-iv-sprite img { display:block;max-width:40px;max-height:40px;image-rendering:auto; }
        .market-iv-sprite span { color:#78c7e8;font-size:20px; }
        .market-iv-name-field { min-width:0;display:grid;gap:3px; }
        .market-iv-calculator input { box-sizing:border-box;width:100%;min-width:0;height:27px;padding:4px 6px;color:#e7eef2;background:#091218;border:1px solid #304855;border-radius:0;font:inherit;outline:none; }
        .market-iv-calculator input:focus { border-color:#d0a952;background:#0d1920; }
        .market-iv-name-field input { height:30px;font-size:13px;font-weight:900; }
        .market-iv-reload { width:28px;height:28px;padding:0;color:#f0d287;background:#171b17;border:1px solid #6c5729;border-radius:0;font-weight:900; }
        .market-iv-inputs { display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px; }
        .market-iv-inputs label { display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:5px;padding:4px 5px;background:#0e1920;border:1px solid #263d49; }
        .market-iv-inputs input { text-align:right;font-weight:900; }
        .market-iv-quality-tag { max-width:58px;padding:2px 3px;overflow:hidden;color:var(--iv-quality-color);background:color-mix(in srgb,var(--iv-quality-color) 12%,#0a1319);border:1px solid color-mix(in srgb,var(--iv-quality-color) 42%,#263d49);font-size:6px;font-weight:900;text-overflow:ellipsis;white-space:nowrap; }
        .market-iv-level-warning { margin:6px 0 0;padding:5px 6px;color:#edc878;background:#211b0d;border-left:3px solid #c89d3d;font-size:9px;line-height:1.3; }
        .market-iv-summary { display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;gap:8px;margin-top:7px;padding:7px;background:#0e1920;border:1px solid #263d49; }
        .market-iv-ring { --iv-progress:0deg;width:82px;height:82px;display:grid;place-items:center;border-radius:50%;background:conic-gradient(#778895 var(--iv-progress),#172731 0); }
        .market-iv-ring::before { content:"";grid-area:1/1;width:64px;height:64px;border-radius:50%;background:#0c151c;border:1px solid #253b47; }
        .market-iv-ring[data-tone="average"],.market-iv-ring[data-tone="very-good"] { background:conic-gradient(#d1a23e var(--iv-progress),#172731 0); }
        .market-iv-ring[data-tone="good"] { background:conic-gradient(#49a9d7 var(--iv-progress),#172731 0); }
        .market-iv-ring[data-tone="great"] { background:conic-gradient(#45bd72 var(--iv-progress),#172731 0); }
        .market-iv-ring[data-tone="perfect"] { background:conic-gradient(#52d6df var(--iv-progress),#172731 0); }
        .market-iv-ring > div { position:relative;z-index:1;grid-area:1/1;display:grid;gap:2px;text-align:center; }
        .market-iv-ring b { color:#f2d68d;font-size:12px; }
        .market-iv-ring small { color:#91a9b6;font-size:7px; }
        .market-iv-power-box { align-self:stretch;display:flex;flex-direction:column;justify-content:center;gap:3px;padding-left:8px;border-left:1px solid #2b414d; }
        .market-iv-power-box b { color:#68c8ef;font-size:20px;line-height:1; }
        .market-iv-power-box span { color:#728d9b;font-size:9px; }
        .market-iv-table-head { display:grid;grid-template-columns:48px 1fr 1fr;gap:5px;margin-top:7px;padding:0 5px 3px;color:#698391;font-size:7px;font-weight:900;letter-spacing:.09em; }
        .market-iv-stat-list { display:grid;gap:3px; }
        .market-iv-stat-row { display:grid;grid-template-columns:48px 1fr 1fr;gap:3px 5px;align-items:center;padding:5px;background:#0e1920;border:1px solid #263d49; }
        .market-iv-stat-row > b { color:#b9ccd5;font-size:10px; }
        .market-iv-stat-row input { height:24px;text-align:right;font-size:10px;font-weight:800; }
        .market-iv-stat-row > small { grid-column:1/3;color:#829aa7;font-size:8px;font-weight:800; }
        .market-iv-stat-row > small[data-tone="average"],.market-iv-stat-row > small[data-tone="very-good"] { color:#e0b34f; }
        .market-iv-stat-row > small[data-tone="good"] { color:#55b8e7; }
        .market-iv-stat-row > small[data-tone="great"] { color:#55ca7e; }
        .market-iv-stat-row > small[data-tone="perfect"] { color:#61dce4; }
        .market-iv-bar { height:4px;background:#1b2b34;overflow:hidden; }
        .market-iv-bar i { display:block;width:0;height:100%;background:#778895;transition:width .15s ease; }
        .market-iv-bar i[data-tone="average"],.market-iv-bar i[data-tone="very-good"] { background:#d1a23e; }
        .market-iv-bar i[data-tone="good"] { background:#49a9d7; }
        .market-iv-bar i[data-tone="great"] { background:#45bd72; }
        .market-iv-bar i[data-tone="perfect"] { background:#52d6df; }
        .market-iv-source { margin:6px 0 0;padding:5px 6px;color:#6f8b99;background:#091218;border-left:2px solid #385462;font-size:8px;line-height:1.3; }
        .market-iv-source[data-state="ready"] { color:#78b994;border-left-color:#3d9b65; }
        .market-iv-source[data-state="error"] { color:#d69386;border-left-color:#b95849; }
        .script-market-window .market-pokemon-listing.market-iv-trigger { cursor:pointer; }
        .script-market-window .market-pokemon-listing.market-iv-trigger:focus-visible { outline:2px solid #efc45f;outline-offset:-2px; }
        .script-market-window .market-pokemon-listing.market-iv-active { border-color:#e0b650 !important;background:#1a1b16 !important; }
        @media (max-width:900px) {
            .script-market-backdrop { --market-iv-width:min(340px,calc(100vw - 16px));--market-stage-closed:calc(100vw - 16px);--market-stage-open:calc(100vw - 16px);padding:8px !important; }
            .market-iv-stage { height:calc(100dvh - 16px); }
            .script-market-backdrop.market-iv-open > .market-iv-stage > .script-market-window { width:100% !important;opacity:.22;pointer-events:none; }
            .script-market-backdrop.market-iv-open > .market-iv-stage > .market-iv-calculator { right:0;z-index:3;box-shadow:-16px 0 40px rgba(0,0,0,.8); }
        }
        @media (prefers-reduced-motion:reduce) {
            .market-iv-stage,.market-iv-stage > .script-market-window,.market-iv-calculator,.market-iv-bar i { transition:none !important; }
        }

        /* Market Global 10.4: sistema visual completo inspirado en la interfaz navy premium. */
        .script-market-backdrop {
            --market-navy-950:#050c16;
            --market-navy-900:#081321;
            --market-navy-850:#0b1828;
            --market-navy-800:#0f1d2e;
            --market-navy-750:#14243a;
            --market-navy-700:#192b42;
            --market-line:#263b54;
            --market-line-strong:#334c68;
            --market-copy:#f2f6fb;
            --market-muted:#90a3b9;
            --market-blue:#55bfff;
            --market-yellow:#f7c858;
            --market-yellow-deep:#d9a937;
            --market-green:#66ee91;
            --market-danger:#f08089;
            --market-iv-width:clamp(320px,21vw,374px);
            --market-iv-gap:14px;
            --market-stage-closed:min(1024px,calc(100vw - 56px));
            --market-stage-open:min(calc(1024px + var(--market-iv-width) + var(--market-iv-gap)),calc(100vw - 56px));
            background:radial-gradient(circle at 50% 15%,rgba(25,54,86,.34),transparent 48%),rgba(2,8,16,.78) !important;
            backdrop-filter:blur(5px);
            padding:28px !important;
            font-family:Inter,"Segoe UI",Arial,sans-serif !important;
        }
        .market-iv-stage { height:min(608px,calc(100dvh - 56px)); }
        .market-iv-stage > .script-market-window {
            display:flex !important;
            flex-direction:column !important;
            color:var(--market-copy) !important;
            background:
                radial-gradient(circle at 18% 0,rgba(49,82,119,.16),transparent 36%),
                linear-gradient(145deg,#0c1828 0%,#091523 58%,#08121e 100%) !important;
            border:1px solid var(--market-line-strong) !important;
            border-radius:20px !important;
            box-shadow:0 26px 80px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.035) !important;
            overflow:hidden;
        }
        .script-market-window::before {
            content:"";position:absolute;inset:0;z-index:0;pointer-events:none;border-radius:inherit;
            background:linear-gradient(125deg,rgba(93,145,202,.035),transparent 30% 76%,rgba(36,84,128,.035));
        }
        .script-market-window > * { position:relative;z-index:1; }
        .script-market-window .mk-head {
            min-height:72px;box-sizing:border-box;display:flex !important;align-items:center !important;padding:14px 26px !important;gap:14px !important;
            background:linear-gradient(100deg,rgba(24,42,65,.94),rgba(14,27,44,.9)) !important;
            border-bottom:1px solid var(--market-line) !important;
            box-shadow:inset 0 -1px rgba(0,0,0,.32) !important;
        }
        .script-market-window .market-head-primary { flex:1;min-width:0;display:flex;align-items:center;gap:16px; }
        .script-market-window .market-head-primary > b {
            display:flex;align-items:center;gap:10px;color:#f4f7fb !important;font-size:20px !important;font-weight:780 !important;letter-spacing:-.02em;white-space:nowrap;
        }
        .script-market-window .market-player-balance { gap:0;padding-left:16px;border-left:1px solid var(--market-line); }
        .script-market-window .market-balance-label {
            min-height:34px;display:flex;align-items:center;padding:0 12px;color:#8296ad !important;background:rgba(7,18,31,.42);font-size:9px !important;letter-spacing:.08em;
        }
        .script-market-window .market-balance-pill {
            min-height:34px;box-sizing:border-box;margin-left:0;padding:0 12px !important;background:#081524 !important;border:1px solid #2c435d !important;border-radius:0 !important;font-size:13px !important;
        }
        .script-market-window .market-balance-pill.gold { color:var(--market-green) !important;border-radius:0 8px 8px 0 !important; }
        .script-market-window .market-balance-pill.diamonds { margin-left:9px;border-radius:8px !important;color:#d8e9f8 !important; }
        .script-market-window .market-exchange-rate {
            min-height:34px;box-sizing:border-box;display:flex;align-items:center;padding:0 13px !important;color:#dbe9f5 !important;background:#081524 !important;border:1px solid #2c435d !important;border-radius:9px !important;font-size:12px !important;
        }
        .script-market-window .market-refresh {
            min-height:40px;padding:0 17px !important;color:#15120a !important;background:linear-gradient(180deg,#ffd875,#efba4d) !important;border:1px solid #ffd775 !important;border-radius:10px !important;box-shadow:0 5px 15px rgba(219,162,47,.2),inset 0 1px rgba(255,255,255,.42) !important;font-size:11px !important;font-weight:900 !important;
        }
        .script-market-window .market-refresh:hover { background:linear-gradient(180deg,#ffe397,#f7c95f) !important;transform:translateY(-1px); }
        .script-market-window .market-close {
            width:34px;height:34px;display:grid;place-items:center;margin-left:0 !important;padding:0 !important;color:#91a3b7 !important;background:transparent !important;border:0 !important;border-radius:8px !important;font-size:25px !important;font-weight:300 !important;
        }
        .script-market-window .market-close:hover { color:#fff !important;background:#24364c !important;transform:none !important; }

        .script-market-tabs {
            min-height:74px;box-sizing:border-box;display:flex;align-items:center;gap:14px !important;padding:16px 28px !important;background:rgba(7,17,29,.28) !important;border-bottom:1px solid rgba(39,59,82,.62) !important;box-shadow:none !important;
        }
        .script-market-window .market-tab {
            min-width:138px;min-height:50px;padding:0 18px !important;display:inline-flex;align-items:center;justify-content:center;gap:8px;color:#eff4fa !important;background:linear-gradient(180deg,#1b2c43,#15253a) !important;border:1px solid #2d435d !important;border-radius:13px !important;box-shadow:inset 0 1px rgba(255,255,255,.035) !important;font-size:13px !important;font-weight:750 !important;
        }
        .script-market-window .market-tab:hover { color:#fff !important;background:linear-gradient(180deg,#223650,#192b42) !important;border-color:#3d5874 !important;transform:translateY(-1px); }
        .script-market-window .market-tab.on {
            color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border-color:#ffdc82 !important;box-shadow:0 7px 20px rgba(225,169,52,.17),inset 0 1px rgba(255,255,255,.5) !important;
        }
        .script-market-window .market-tab img { width:18px;height:18px;margin:0 !important;filter:none !important; }
        .script-market-window .market-tab-count { min-width:22px;min-height:22px;display:inline-grid;place-items:center;padding:0 5px;border:1px solid currentColor !important;border-radius:6px !important;background:rgba(5,13,23,.3) !important;font-size:10px; }
        .script-market-window .market-view-toggle {
            min-height:50px;box-sizing:border-box;display:flex;margin-left:auto;padding:5px !important;gap:4px;background:#0a1726 !important;border:1px solid #2a4059 !important;border-radius:13px !important;
        }
        .script-market-window .market-view-btn {
            min-width:98px;min-height:38px;padding:0 15px !important;color:#dbe5ee !important;background:transparent !important;border:0 !important;border-radius:9px !important;font-size:12px !important;font-weight:800 !important;
        }
        .script-market-window .market-view-btn.on { color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;box-shadow:0 4px 12px rgba(218,159,42,.15) !important; }

        .script-market-window .market-favorites-bar {
            min-height:58px;box-sizing:border-box;margin:14px 28px 0;padding:11px 17px;gap:16px;background:rgba(8,20,34,.62);border:1px solid #2a4058;border-radius:14px;box-shadow:inset 0 1px rgba(255,255,255,.025);
        }
        .script-market-window .market-favorites-label { color:var(--market-yellow);font-size:10px;letter-spacing:.04em; }
        .script-market-window .market-favorites-list { gap:10px !important; }
        .script-market-window .market-favorites-list { min-width:0;display:flex !important;align-items:center; }
        .script-market-window .market-favorite-chip {
            min-height:36px;box-sizing:border-box;max-width:220px;padding:5px 13px;color:#dce6f0;background:#14243a;border:1px solid #304862;border-radius:999px;box-shadow:inset 0 1px rgba(255,255,255,.035);font-size:10px;
        }
        .script-market-window .market-favorite-chip:hover,.script-market-window .market-favorite-chip.on { color:#fff;border-color:#6386a7;background:#1b304a; }
        .script-market-window .market-favorite-chip img { width:24px;height:24px; }

        .script-market-window .market-buy-controls,
        .script-market-window .market-sell-controls,
        .script-market-window .market-pokemon-filters {
            box-sizing:border-box;margin:12px 28px 0;padding:9px !important;gap:9px !important;background:rgba(9,22,37,.76) !important;border:1px solid #2a4058 !important;border-radius:14px !important;box-shadow:inset 0 1px rgba(255,255,255,.025) !important;
        }
        .script-market-window .market-pokemon-filters { margin-top:9px; }
        .script-market-window input,.script-market-window select {
            min-height:42px !important;box-sizing:border-box;padding:0 13px !important;color:#edf3f8 !important;background:#0a1727 !important;border:1px solid #304761 !important;border-radius:10px !important;box-shadow:inset 0 1px 3px rgba(0,0,0,.26) !important;font-family:inherit !important;font-size:12px !important;
        }
        .script-market-window select { padding-right:30px !important; }
        .script-market-window input:hover,.script-market-window select:hover { border-color:#48637f !important; }
        .script-market-window input:focus,.script-market-window select:focus { border-color:#68b9e7 !important;box-shadow:0 0 0 3px rgba(73,166,218,.12) !important;outline:0 !important; }
        .script-market-window input::placeholder { color:#71869d !important; }
        .script-market-window input[type="checkbox"] {
            width:22px !important;height:22px !important;min-height:22px !important;margin:0;appearance:none;background:#0d1b2b !important;border:1px solid #38516d !important;border-radius:5px !important;box-shadow:none !important;cursor:pointer;
        }
        .script-market-window input[type="checkbox"]:checked { background:var(--market-yellow) !important;border-color:#ffdb78 !important;box-shadow:inset 0 0 0 4px var(--market-yellow) !important; }
        .script-market-window input[type="checkbox"]:checked::after { content:"✓";display:grid;place-items:center;height:100%;color:#17130a;font-size:15px;font-weight:1000; }
        .script-market-window .market-buy-controls > label,.script-market-window .market-pokemon-filters > label { min-height:42px;padding:0 5px !important;color:#d4dee8 !important;font-size:12px !important; }
        .script-market-window .market-search { min-width:260px !important; }
        .script-market-window .market-sell-quality-tiers {
            margin:9px 28px 0;padding:9px 13px;gap:8px;background:rgba(9,22,37,.62);border:1px solid #293f57;border-radius:12px;
        }
        .script-market-window .market-sell-tier-label { color:#7f95ac;font-size:8px; }
        .script-market-window .market-sell-tier-action,.script-market-window .market-sell-tier-btn { min-height:27px;padding:0 10px;border-radius:7px;box-shadow:none; }

        .script-market-window .market-status {
            min-height:38px;box-sizing:border-box;margin:6px 28px 0;padding:9px 1px !important;color:#aebdca !important;background:transparent !important;border:0 !important;font-size:12px !important;
        }
        .script-market-window .market-list {
            min-height:0;flex:1;display:grid !important;align-content:start;overflow:auto;padding:0 28px 22px !important;gap:14px !important;background:transparent !important;scrollbar-width:thin;scrollbar-color:#3c5874 #091421;
        }
        .script-market-window .market-list::-webkit-scrollbar,.market-iv-scroll::-webkit-scrollbar { width:9px;height:9px; }
        .script-market-window .market-list::-webkit-scrollbar-track,.market-iv-scroll::-webkit-scrollbar-track { background:#091421;border-radius:9px; }
        .script-market-window .market-list::-webkit-scrollbar-thumb,.market-iv-scroll::-webkit-scrollbar-thumb { background:#3b5773;border:2px solid #091421;border-radius:9px; }
        .script-market-window .market-list.market-view-cards { grid-template-columns:repeat(3,minmax(0,1fr));gap:14px !important; }
        .script-market-window .market-list.market-view-list { grid-template-columns:1fr;gap:8px !important; }

        .script-market-window .market-buy-row,
        .script-market-window .market-sell-row,
        .script-market-window .market-request-row,
        .script-market-window .market-history-row {
            color:var(--market-copy) !important;background:linear-gradient(145deg,#17283d,#122238) !important;border:1px solid #2c425c !important;border-radius:13px !important;box-shadow:0 8px 22px rgba(0,0,0,.17),inset 0 1px rgba(255,255,255,.035) !important;overflow:hidden;transform:none !important;transition:background .16s ease,border-color .16s ease,transform .16s ease !important;
        }
        .script-market-window .market-buy-row::after,.script-market-window .market-sell-row::after { display:none !important; }
        .script-market-window .market-buy-row::before,.script-market-window .market-sell-row::before { width:3px;box-shadow:none !important; }
        .script-market-window .market-buy-row:hover,
        .script-market-window .market-sell-row:hover,
        .script-market-window .market-request-row:hover,
        .script-market-window .market-history-row:hover {
            color:var(--market-copy) !important;background:linear-gradient(145deg,#1c3049,#16283f) !important;border-color:#42617f !important;box-shadow:0 12px 28px rgba(0,0,0,.23),inset 0 1px rgba(255,255,255,.05) !important;transform:translateY(-1px) !important;
        }
        .script-market-window .market-pokemon-quality {
            background:linear-gradient(145deg,color-mix(in srgb,var(--market-tier-color) 7%,#17283d),#122238 70%) !important;border-color:color-mix(in srgb,var(--market-tier-color) 50%,#2c425c) !important;box-shadow:0 8px 22px rgba(0,0,0,.17),inset 0 2px color-mix(in srgb,var(--market-tier-color) 42%,transparent) !important;
        }
        .script-market-window .market-pokemon-quality:hover { background:linear-gradient(145deg,color-mix(in srgb,var(--market-tier-color) 11%,#1c3049),#16283f 72%) !important;border-color:color-mix(in srgb,var(--market-tier-color) 68%,#42617f) !important; }
        .script-market-window .market-item-rarity {
            background:linear-gradient(145deg,color-mix(in srgb,var(--market-item-color) 7%,#17283d),#122238 70%) !important;border-color:color-mix(in srgb,var(--market-item-color) 48%,#2c425c) !important;box-shadow:0 8px 22px rgba(0,0,0,.17),inset 0 2px color-mix(in srgb,var(--market-item-color) 40%,transparent) !important;
        }
        .script-market-window .market-item-rarity:hover { background:linear-gradient(145deg,color-mix(in srgb,var(--market-item-color) 11%,#1c3049),#16283f 72%) !important;border-color:color-mix(in srgb,var(--market-item-color) 66%,#42617f) !important; }
        .script-market-window .market-pokemon-quality::before,.script-market-window .market-item-rarity::before { top:0;right:0;bottom:auto;width:auto;height:3px;box-shadow:none !important; }
        .script-market-window .market-art {
            background:linear-gradient(145deg,#0a1625,#0c1a2b) !important;border:1px solid #29425d !important;border-radius:9px !important;box-shadow:inset 0 1px rgba(255,255,255,.025) !important;
        }
        .script-market-window .market-art img { filter:drop-shadow(0 5px 7px rgba(0,0,0,.38)) !important; }
        .script-market-window .market-kind-label { color:var(--market-blue);font-size:9px;letter-spacing:.18em;margin-bottom:6px; }
        .script-market-window .market-item-name { color:#f5f7fb;font-size:16px;font-weight:780; }
        .script-market-window .market-meta { color:#a9bad0;font-size:10px; }
        .script-market-window .market-quality-tier,.script-market-window .market-item-rarity-badge {
            min-height:20px;box-sizing:border-box;padding:3px 8px;border-radius:5px !important;background:rgba(7,17,29,.62) !important;box-shadow:none !important;text-shadow:none !important;font-size:8px;
        }
        .script-market-window .market-favorite-toggle,.script-market-window .market-featured-toggle,.script-market-window .market-sell-card-lock {
            width:31px;height:31px;right:10px;top:10px;color:#91a3b7 !important;background:transparent !important;border:0 !important;border-radius:7px !important;box-shadow:none !important;font-size:20px !important;
        }
        .script-market-window .market-favorite-toggle:hover,.script-market-window .market-featured-toggle:hover { color:#fff !important;background:#20364f !important; }
        .script-market-window .market-favorite-toggle.on { color:var(--market-yellow) !important; }
        .script-market-window .market-featured-toggle.on { color:var(--market-blue) !important; }
        .script-market-window .market-pokemon-listing > .market-card-stats {
            gap:5px 7px;padding:8px;background:rgba(7,17,29,.48) !important;border:1px solid #29415a !important;border-radius:8px !important;box-shadow:none !important;
        }
        .script-market-window .market-stat { min-height:19px;box-sizing:border-box;border-radius:4px !important;background:#0a1727 !important;box-shadow:none !important; }
        .script-market-window .market-buy-footer { gap:8px;padding-top:10px;border-top:1px solid #2a4058; }
        .script-market-window .market-buy-footer .market-data-box {
            min-height:57px;padding:8px 11px;background:rgba(8,20,34,.62) !important;border:1px solid #2a425c !important;border-radius:8px !important;box-shadow:none !important;
        }
        .script-market-window .market-buy-footer .market-quantity,.script-market-window .market-buy-footer .market-price,.script-market-window .market-buy-footer .market-conversion { background:rgba(8,20,34,.62) !important;border-color:#2a425c !important; }
        .script-market-window .market-buy-footer .market-data-label { color:#8ca0b7;font-size:7px;letter-spacing:.05em; }
        .script-market-window .market-buy-footer .market-quantity b { color:var(--market-green);font-size:14px; }
        .script-market-window .market-buy-footer .market-price b { color:#eef4f8;font-size:12px; }
        .script-market-window .market-buy-footer .market-conversion b { color:#d8e9f5;font-size:10px; }
        .script-market-window .market-actions input { min-width:74px; }
        .script-market-window .market-view-cards .market-buy-footer {
            grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:minmax(57px,auto) 42px;
            grid-template-areas:"footerQty footerPrice footerConversion" "footerActions footerActions footerActions";
        }
        .script-market-window .market-view-cards .market-pokemon-listing .market-buy-footer {
            min-height:126px;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:minmax(58px,auto) minmax(48px,auto);grid-template-areas:"footerPrice footerConversion" "footerActions footerActions";
        }
        .script-market-window .market-view-cards .market-buy-row.market-pokemon-listing {
            min-height:350px !important;grid-template-rows:minmax(86px,auto) minmax(76px,auto) minmax(126px,auto) !important;
        }
        .script-market-window .market-view-cards .market-buy-footer .market-actions { width:100%;justify-self:stretch;justify-content:stretch; }
        .script-market-window .market-view-cards .market-buy-footer .market-actions input { flex:1;min-width:0;width:auto !important; }
        .script-market-window .market-view-cards .market-buy-footer .market-actions button { flex:1.15; }
        .script-market-window .market-view-cards .market-pokemon-listing .market-buy-footer .market-actions {
            grid-area:footerActions !important;align-self:end !important;margin-top:3px;padding-top:8px !important;border-top:1px solid #2a4058 !important;
        }
        .script-market-window .market-view-cards .market-pokemon-listing .market-buy-footer .market-buy { min-height:46px; }

        /* Cards Pokémon compactas: conservan stats, precio, conversión, acciones, tier y tipos sin escalado borroso. */
        .script-market-window .market-pokemon-listing { font-size:9px; }
        .script-market-window .market-pokemon-listing .market-main { padding-right:76px; }
        .script-market-window .market-pokemon-listing .market-kind-label { margin-bottom:3px;font-size:7px;line-height:1.1;letter-spacing:.13em; }
        .script-market-window .market-pokemon-listing .market-item-name { font-size:13px;line-height:1.14; }
        .script-market-window .market-pokemon-listing .market-meta { margin-top:2px;font-size:8px;line-height:1.2; }
        .script-market-window .market-pokemon-listing .market-quality-tier { right:38px;min-height:17px;padding:2px 5px;font-size:6.5px;line-height:1.1; }
        .script-market-window .market-pokemon-types { display:flex;flex-wrap:wrap;gap:3px;margin-top:4px; }
        .script-market-window .market-pokemon-type {
            --market-type-color:#91a3b7;display:inline-flex;align-items:center;min-height:15px;box-sizing:border-box;padding:1px 5px;color:#f4f7fb;background:color-mix(in srgb,var(--market-type-color) 24%,#0a1727);border:1px solid color-mix(in srgb,var(--market-type-color) 72%,#29415a);border-radius:4px;font-size:6.5px;font-weight:900;line-height:1;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;
        }
        .script-market-window .market-pokemon-type[data-pokemon-type="normal"] { --market-type-color:#a8a77a; }
        .script-market-window .market-pokemon-type[data-pokemon-type="fire"] { --market-type-color:#ee8130; }
        .script-market-window .market-pokemon-type[data-pokemon-type="water"] { --market-type-color:#6390f0; }
        .script-market-window .market-pokemon-type[data-pokemon-type="electric"] { --market-type-color:#f7d02c; }
        .script-market-window .market-pokemon-type[data-pokemon-type="grass"] { --market-type-color:#7ac74c; }
        .script-market-window .market-pokemon-type[data-pokemon-type="ice"] { --market-type-color:#96d9d6; }
        .script-market-window .market-pokemon-type[data-pokemon-type="fighting"] { --market-type-color:#c22e28; }
        .script-market-window .market-pokemon-type[data-pokemon-type="poison"] { --market-type-color:#a33ea1; }
        .script-market-window .market-pokemon-type[data-pokemon-type="ground"] { --market-type-color:#e2bf65; }
        .script-market-window .market-pokemon-type[data-pokemon-type="flying"] { --market-type-color:#a98ff3; }
        .script-market-window .market-pokemon-type[data-pokemon-type="psychic"] { --market-type-color:#f95587; }
        .script-market-window .market-pokemon-type[data-pokemon-type="bug"] { --market-type-color:#a6b91a; }
        .script-market-window .market-pokemon-type[data-pokemon-type="rock"] { --market-type-color:#b6a136; }
        .script-market-window .market-pokemon-type[data-pokemon-type="ghost"] { --market-type-color:#735797; }
        .script-market-window .market-pokemon-type[data-pokemon-type="dragon"] { --market-type-color:#6f35fc; }
        .script-market-window .market-pokemon-type[data-pokemon-type="dark"] { --market-type-color:#705746; }
        .script-market-window .market-pokemon-type[data-pokemon-type="steel"] { --market-type-color:#b7b7ce; }
        .script-market-window .market-pokemon-type[data-pokemon-type="fairy"] { --market-type-color:#d685ad; }
        .script-market-window .market-pokemon-listing > .market-card-stats { gap:3px 5px;padding:5px 6px; }
        .script-market-window .market-pokemon-listing > .market-card-stats .market-stat { min-height:15px;padding:2px 4px;font-size:7px;line-height:1; }
        .script-market-window .market-pokemon-listing > .market-card-stats .market-stat b { font-size:7.5px; }
        .script-market-window .market-pokemon-listing .market-buy-footer { gap:5px;padding-top:7px; }
        .script-market-window .market-pokemon-listing .market-buy-footer .market-data-box { min-height:45px;padding:5px 7px; }
        .script-market-window .market-pokemon-listing .market-buy-footer .market-data-label { margin-bottom:2px;font-size:6px; }
        .script-market-window .market-pokemon-listing .market-buy-footer .market-price b { font-size:10px; }
        .script-market-window .market-pokemon-listing .market-buy-footer .market-conversion b { font-size:8.5px; }
        .script-market-window .market-view-cards .market-buy-row.market-pokemon-listing {
            min-height:270px !important;padding:9px !important;gap:7px 8px;grid-template-columns:56px minmax(0,1fr);grid-template-rows:minmax(66px,auto) minmax(53px,auto) minmax(101px,auto) !important;
        }
        .script-market-window .market-view-cards .market-buy-row.market-pokemon-listing .market-art { width:54px;height:54px; }
        .script-market-window .market-view-cards .market-pokemon-listing .market-buy-footer { min-height:101px;grid-template-rows:minmax(45px,auto) minmax(39px,auto); }
        .script-market-window .market-view-cards .market-pokemon-listing .market-buy-footer .market-actions { margin-top:1px;padding-top:5px !important; }
        .script-market-window .market-view-cards .market-pokemon-listing .market-buy-footer .market-buy { min-height:38px;font-size:10px; }
        .script-market-window .market-view-cards .market-sell-row.market-pokemon-listing {
            min-height:150px !important;padding:9px !important;gap:7px 8px;grid-template-columns:56px minmax(0,1fr);grid-template-rows:minmax(64px,auto) auto;
        }
        .script-market-window .market-view-cards .market-sell-row.market-pokemon-listing .market-art { width:54px;height:54px; }
        .script-market-window .market-view-list .market-buy-row.market-pokemon-listing { min-height:108px !important; }
        .script-market-window .market-view-list .market-sell-row.market-pokemon-listing { min-height:98px !important; }

        /* Cards de objetos: identidad, banda de datos y compra en tres niveles claros. */
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) {
            min-height:224px !important;padding:12px !important;grid-template-columns:62px minmax(0,1fr) !important;grid-template-rows:minmax(78px,auto) minmax(112px,auto) !important;grid-template-areas:"art main" "footer footer" !important;gap:9px 11px !important;align-items:center !important;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-art {
            width:60px;height:60px;align-self:center;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-main {
            align-self:center;padding-right:34px;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-buy-footer {
            min-height:112px !important;display:grid !important;grid-template-columns:repeat(3,minmax(0,1fr)) !important;grid-template-rows:minmax(58px,auto) 42px !important;grid-template-areas:"footerQty footerPrice footerConversion" "footerActions footerActions footerActions" !important;align-items:stretch !important;gap:8px !important;padding-top:10px !important;border-top:1px solid #2a4058 !important;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-data-box {
            min-width:0;min-height:58px !important;justify-content:center;padding:7px 9px !important;overflow:hidden;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-data-box b {
            display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-actions {
            grid-area:footerActions !important;width:100%;min-height:42px !important;display:grid !important;grid-template-columns:minmax(76px,.75fr) minmax(132px,1.25fr);align-items:stretch !important;gap:8px !important;padding:0 !important;border:0 !important;justify-self:stretch !important;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-actions input {
            width:100% !important;min-width:0 !important;height:42px !important;
        }
        .script-market-window .market-view-cards .market-buy-row.market-listing-row:not(.market-pokemon-listing) .market-actions .market-buy {
            width:100%;min-height:42px;padding-inline:12px !important;
        }
        .script-market-window .market-buy,.script-market-window .market-sell-submit,.script-market-window .market-request-submit {
            min-height:42px;padding:0 18px !important;color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border:1px solid #ffdb7c !important;border-radius:8px !important;box-shadow:0 5px 14px rgba(220,163,43,.15),inset 0 1px rgba(255,255,255,.42) !important;font-weight:900 !important;
        }
        .script-market-window .market-buy:hover,.script-market-window .market-sell-submit:hover,.script-market-window .market-request-submit:hover { color:#17130a !important;background:linear-gradient(180deg,#ffe294,#f5c65b) !important;box-shadow:0 7px 18px rgba(220,163,43,.2) !important;transform:translateY(-1px) !important; }
        .script-market-window .market-cancel-listing,.script-market-window .market-request-cancel {
            min-height:40px;border-radius:8px !important;background:#281924 !important;border:1px solid #734051 !important;color:#ffb2ba !important;box-shadow:none !important;
        }
        .script-market-window .market-sell-row.on,.script-market-window .market-pokemon-listing.market-iv-active { background:linear-gradient(145deg,#243047,#18263b) !important;border-color:var(--market-yellow) !important;box-shadow:inset 0 2px rgba(247,200,88,.45) !important; }

        .script-market-backdrop.market-iv-open .script-market-tabs { gap:6px !important;padding:12px !important; }
        .script-market-backdrop.market-iv-open .script-market-window .market-tab { min-width:82px;min-height:42px;padding:0 9px !important;font-size:10px !important; }
        .script-market-backdrop.market-iv-open .script-market-window .market-view-toggle { min-height:42px; }
        .script-market-backdrop.market-iv-open .script-market-window .market-view-btn { min-width:72px;min-height:32px;padding:0 9px !important;font-size:10px !important; }

        .script-market-window .market-sell-editor,.script-market-window .market-request-controls {
            margin:11px 28px 0;padding:15px;background:linear-gradient(145deg,#17283d,#101f32) !important;border:1px solid #314963 !important;border-radius:14px !important;box-shadow:0 10px 26px rgba(0,0,0,.2),inset 0 1px rgba(255,255,255,.035) !important;
        }
        .script-market-window .market-sell-editor-art,.script-market-window .market-request-selected-art { background:#0a1727;border-color:#2e4862;border-radius:9px; }
        .script-market-window .market-sell-editor-name { color:#f5f7fb;font-size:17px; }
        .script-market-window .market-sell-editor-form { padding:10px;background:rgba(7,17,29,.56) !important;border:1px solid #2a4058 !important;border-radius:10px !important;box-shadow:none !important; }
        .script-market-window .market-sell-finance-box { padding:8px 10px;background:#0b1929;border-color:#2a425c;border-radius:7px; }
        .script-market-window .market-sell-editor-close,.script-market-window .market-sell-editor-lock { border-radius:7px !important; }
        .script-market-window .market-sell-reference { margin:9px 28px 0 !important;padding:11px 13px !important;background:#0d2133 !important;border:1px solid #31516b !important;border-left:3px solid var(--market-blue) !important;border-radius:10px !important;box-shadow:none !important; }
        .script-market-window .market-request-heading { padding-bottom:11px;border-bottom-color:#30475f;color:#f2f5f9;font-size:14px; }
        .script-market-window .market-request-form { gap:10px; }
        .script-market-window .market-request-field { color:#8ca0b7;font-size:8px; }
        .script-market-window .market-request-options { background:#0a1727;border-color:#496680;border-radius:10px;box-shadow:0 16px 35px rgba(0,0,0,.55); }
        .script-market-window .market-request-option { background:#12243a;border-radius:8px;font-family:inherit; }
        .script-market-window .market-request-option:hover,.script-market-window .market-request-option.on { color:#fff;background:#1a314b;border-color:#4c7597; }
        .script-market-window .market-request-summary { background:#0a1727;border-color:#2d455f;border-radius:8px; }
        .script-market-window .market-request-list-filters { border-top-color:#30475f; }
        .script-market-window .market-request-empty { background:#0a1727;border-color:#38516b;border-radius:11px;color:#90a3b9; }

        .market-iv-calculator {
            color:var(--market-copy);background:radial-gradient(circle at 30% 0,rgba(54,91,132,.18),transparent 35%),linear-gradient(150deg,#0e1c2d,#091522 72%) !important;border:1px solid var(--market-line-strong) !important;border-radius:20px !important;box-shadow:0 26px 70px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.035) !important;
        }
        .market-iv-head { min-height:72px;padding:14px 17px;background:linear-gradient(100deg,#1a2d46,#122238) !important;border-bottom:1px solid var(--market-line) !important; }
        .market-iv-head small,.market-iv-inputs small,.market-iv-name-field small,.market-iv-power-box small { color:#7fa0ba;font-size:8px;letter-spacing:.14em; }
        .market-iv-head b { color:var(--market-yellow);font-size:15px; }
        .market-iv-close,.market-iv-reload { border-radius:8px !important; }
        .market-iv-close { width:34px;height:34px;color:#a7b8c8;background:#172940;border:1px solid #36516d;font-size:21px; }
        .market-iv-close:hover { color:#fff;background:#233b57;border-color:#527290; }
        .market-iv-scroll { padding:13px;scrollbar-color:#3c5874 #091421; }
        .market-iv-identity { grid-template-columns:54px minmax(0,1fr) 34px;gap:9px;padding:0 0 12px;border-bottom:1px solid #2a4058; }
        .market-iv-sprite { width:52px;height:52px;background:#0a1727;border:1px solid #304a65;border-radius:9px; }
        .market-iv-sprite img { max-width:48px;max-height:48px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4)); }
        .market-iv-calculator input { height:36px !important;padding:0 9px !important;color:#f1f5f9;background:#091725;border:1px solid #304a65;border-radius:8px !important;box-shadow:inset 0 2px 4px rgba(0,0,0,.22); }
        .market-iv-calculator input:focus { border-color:#59b6e7;background:#0c1b2b;box-shadow:0 0 0 3px rgba(71,171,224,.12); }
        .market-iv-name-field input { height:40px !important;font-size:13px !important; }
        .market-iv-reload { width:34px;height:34px;color:#19140a;background:var(--market-yellow);border:1px solid #ffda76;font-size:15px; }
        .market-iv-inputs { gap:9px;margin-top:10px; }
        .market-iv-inputs label { grid-template-columns:auto minmax(0,1fr);gap:6px;padding:8px;background:#102136;border:1px solid #2d455f;border-radius:9px; }
        .market-iv-quality-tag { grid-column:1/-1;max-width:none;text-align:center;border-radius:4px; }
        .market-iv-level-warning { margin-top:9px;padding:8px 9px;background:#2b2413;border:1px solid #6f5725;border-left:3px solid var(--market-yellow);border-radius:7px;color:#f3d68e; }
        .market-iv-summary { grid-template-columns:105px minmax(0,1fr);gap:11px;margin-top:10px;padding:11px;background:#102136;border:1px solid #2d455f;border-radius:11px; }
        .market-iv-ring { width:92px;height:92px;box-shadow:0 0 0 1px #263e57; }
        .market-iv-ring::before { width:72px;height:72px;background:#0b1929;border-color:#2c445e; }
        .market-iv-ring b { color:#f6d677;font-size:13px; }
        .market-iv-power-box { padding-left:12px;border-left-color:#304963; }
        .market-iv-power-box b { color:var(--market-blue);font-size:24px; }
        .market-iv-power-box span { color:#8298ae; }
        .market-iv-table-head { margin-top:11px;color:#7890a7; }
        .market-iv-stat-list { gap:6px; }
        .market-iv-stat-row { gap:5px 7px;padding:8px;background:#102136;border:1px solid #2d455f;border-radius:9px; }
        .market-iv-stat-row > b { color:#dce6ef;font-size:10px; }
        .market-iv-stat-row input { height:31px !important;font-size:10px !important; }
        .market-iv-bar { height:5px;background:#1c3044;border-radius:4px; }
        .market-iv-bar i { border-radius:4px; }
        .market-iv-source { margin-top:9px;padding:8px 9px;background:#0a1727;border:1px solid #29435d;border-left:3px solid #3e647f;border-radius:7px;color:#8298ae; }
        .market-iv-source[data-state="ready"] { background:#0d211d;border-color:#295645;border-left-color:#4bb879;color:#82cca1; }
        .market-iv-source[data-state="error"] { background:#251719;border-color:#66383d;border-left-color:#db6e75;color:#e5a2a6; }

        .market-view-list .market-buy-row,.market-view-list .market-sell-row,.market-view-list .market-request-row,.market-view-list .market-history-row { border-radius:10px !important; }
        .market-view-list .market-art { width:62px;height:62px;border-radius:8px !important; }
        .market-view-list .market-buy-footer .market-data-box { min-height:48px; }

        @media (max-width:1280px) {
            .script-market-window .market-list.market-view-cards { grid-template-columns:repeat(2,minmax(0,1fr)); }
            .script-market-window .market-tab { min-width:112px;padding:0 12px !important; }
            .script-market-tabs { gap:8px !important;padding-inline:18px !important; }
            .script-market-window .market-favorites-bar,.script-market-window .market-buy-controls,.script-market-window .market-sell-controls,.script-market-window .market-pokemon-filters,.script-market-window .market-sell-quality-tiers,.script-market-window .market-status,.script-market-window .market-sell-editor,.script-market-window .market-request-controls,.script-market-window .market-sell-reference { margin-left:18px !important;margin-right:18px !important; }
            .script-market-window .market-list { padding-left:18px !important;padding-right:18px !important; }
        }
        @media (max-width:900px) {
            .script-market-backdrop { --market-iv-width:min(374px,calc(100vw - 20px));--market-stage-closed:calc(100vw - 20px);--market-stage-open:calc(100vw - 20px);padding:10px !important;backdrop-filter:none; }
            .market-iv-stage { height:calc(100dvh - 20px); }
            .market-iv-calculator { border-radius:16px !important; }
            .script-market-window .mk-head { min-height:62px;padding:10px 13px !important; }
            .script-market-window .market-head-primary > b { font-size:16px !important; }
            .script-market-window .market-player-balance { padding-left:8px; }
            .script-market-window .market-balance-label { display:none; }
            .script-market-window .market-exchange-rate { display:none; }
            .script-market-tabs { min-height:auto;display:grid !important;grid-template-columns:repeat(3,minmax(0,1fr));padding:9px !important;gap:6px !important; }
            .script-market-window .market-tab { width:100%;min-width:0;min-height:40px;padding:0 7px !important;border-radius:9px !important; }
            .script-market-window .market-view-toggle { grid-column:1/-1;min-height:43px; }
            .script-market-window .market-view-btn { flex:1;min-height:33px; }
            .script-market-window .market-favorites-bar,.script-market-window .market-buy-controls,.script-market-window .market-sell-controls,.script-market-window .market-pokemon-filters,.script-market-window .market-sell-quality-tiers,.script-market-window .market-status,.script-market-window .market-sell-editor,.script-market-window .market-request-controls,.script-market-window .market-sell-reference { margin-left:9px !important;margin-right:9px !important; }
            .script-market-window .market-list { padding-left:9px !important;padding-right:9px !important; }
            .script-market-window .market-list.market-view-cards { grid-template-columns:1fr; }
            .script-market-window .market-search { min-width:100% !important; }
        }
        @media (max-width:560px) {
            .script-market-window .market-head-primary { flex-wrap:wrap; }
            .script-market-window .market-player-balance { flex-basis:100%;padding:5px 0 0;border-left:0;border-top:1px solid var(--market-line); }
            .script-market-window .market-refresh { min-height:34px;padding:0 10px !important; }
            .script-market-window .market-tab-label { display:none; }
            .script-market-window .market-tab { min-height:36px; }
            .script-market-window .market-favorites-bar { padding:8px 10px; }
            .script-market-window .market-buy-controls,.script-market-window .market-sell-controls,.script-market-window .market-pokemon-filters { padding:7px !important; }
            .market-iv-summary { grid-template-columns:90px minmax(0,1fr); }
            .market-iv-ring { width:78px;height:78px; }
            .market-iv-ring::before { width:60px;height:60px; }
        }

        /* Market Global 10.5: densidad al 80%, filtros plegables y favoritos por flechas. */
        .script-market-window .mk-head { min-height:60px;padding:10px 16px !important;gap:10px !important; }
        .script-market-window .market-head-primary { gap:10px; }
        .script-market-window .market-head-primary > b { font-size:17px !important; }
        .script-market-window .market-player-balance { padding-left:10px; }
        .script-market-window .market-balance-label,.script-market-window .market-balance-pill,.script-market-window .market-exchange-rate { min-height:31px; }
        .script-market-window .market-refresh { min-height:36px;padding-inline:12px !important; }
        .script-market-tabs { min-height:54px;flex-wrap:nowrap;gap:6px !important;padding:8px 14px !important;overflow:visible; }
        .script-market-window .market-tab { flex:1 1 auto;min-width:70px;min-height:38px;padding:0 8px !important;border-radius:9px !important;font-size:9px !important;gap:5px; }
        .script-market-window .market-tab img { width:14px;height:14px; }
        .script-market-window .market-tab-count { min-width:18px;min-height:18px;font-size:8px; }
        .script-market-window .market-filters-toggle {
            flex:none;min-width:116px;min-height:38px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 10px !important;color:#dce7f1 !important;background:#16273c !important;border:1px solid #304862 !important;border-radius:9px !important;box-shadow:inset 0 1px rgba(255,255,255,.035) !important;font:800 9px Inter,"Segoe UI",sans-serif !important;white-space:nowrap;cursor:pointer;
        }
        .script-market-window .market-filters-toggle:hover,.script-market-window .market-filters-toggle.on { color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border-color:#ffdb7c !important; }
        .script-market-window .market-filters-toggle[hidden] { display:none !important; }
        .market-filters-chevron { display:inline-block;font-size:12px;transition:transform .16s ease; }
        .market-filters-toggle.on .market-filters-chevron { transform:rotate(180deg); }
        .script-market-window .market-view-toggle { flex:none;min-height:38px;padding:3px !important;border-radius:9px !important; }
        .script-market-window .market-view-btn { min-width:61px;min-height:30px;padding:0 8px !important;border-radius:6px !important;font-size:9px !important; }

        .script-market-window .market-favorites-bar { min-height:46px;margin:8px 14px 0;padding:6px 9px;gap:7px;border-radius:10px;overflow:hidden; }
        .script-market-window .market-favorites-label { flex:none;font-size:8px; }
        .script-market-window .market-favorites-list { flex:1;min-width:0;gap:7px !important;overflow-x:auto;overflow-y:hidden;scroll-behavior:smooth;scrollbar-width:none;overscroll-behavior-x:contain; }
        .script-market-window .market-favorites-list::-webkit-scrollbar { display:none; }
        .script-market-window .market-favorite-chip { min-height:30px;max-width:170px;padding:3px 9px;font-size:8px; }
        .script-market-window .market-favorite-chip img { width:20px;height:20px; }
        .script-market-window .market-favorites-scroll {
            flex:none;width:29px;height:29px;display:grid;place-items:center;padding:0 !important;color:#e7eef5;background:#172a40;border:1px solid #35506d;border-radius:7px;font:800 22px/1 sans-serif;cursor:pointer;
        }
        .script-market-window .market-favorites-scroll:hover:not(:disabled) { color:#17130a;background:var(--market-yellow);border-color:#ffdb7c; }
        .script-market-window .market-favorites-scroll:disabled { opacity:.3;cursor:default; }

        .script-market-backdrop:not(.market-filters-open) .market-buy-controls,
        .script-market-backdrop:not(.market-filters-open) .market-pokemon-filters,
        .script-market-backdrop:not(.market-filters-open) .market-sell-controls,
        .script-market-backdrop:not(.market-filters-open) .market-sell-quality-tiers,
        .script-market-backdrop:not(.market-filters-open) .market-request-list-filters { display:none !important; }
        .script-market-backdrop.market-filters-open .market-buy-controls,
        .script-market-backdrop.market-filters-open .market-sell-controls,
        .script-market-backdrop.market-filters-open .market-pokemon-filters { margin:7px 14px 0;padding:7px !important;gap:6px !important;border-radius:10px !important; }
        .script-market-backdrop.market-filters-open .market-sell-quality-tiers { margin:6px 14px 0;padding:6px 9px;border-radius:9px; }
        .script-market-backdrop.market-filters-open .market-buy-controls input,
        .script-market-backdrop.market-filters-open .market-buy-controls select,
        .script-market-backdrop.market-filters-open .market-sell-controls input,
        .script-market-backdrop.market-filters-open .market-sell-controls select,
        .script-market-backdrop.market-filters-open .market-pokemon-filters input,
        .script-market-backdrop.market-filters-open .market-pokemon-filters select { min-height:34px !important;font-size:9px !important; }
        .script-market-window .market-request-controls { margin:7px 14px 0;padding:10px;border-radius:10px !important; }
        .script-market-window .market-request-list-filters { margin-top:7px;padding-top:7px; }
        .script-market-window .market-status { min-height:28px;margin:3px 14px 0;padding:6px 1px !important;font-size:10px !important; }
        .script-market-window .market-list { padding:0 14px 14px !important;gap:10px !important; }
        .script-market-window .market-list.market-view-cards { grid-template-columns:repeat(3,minmax(0,1fr));gap:10px !important; }
        .script-market-window .market-sell-editor { margin:7px 14px 0;padding:10px;border-radius:10px !important; }
        .script-market-window .market-sell-reference { margin:6px 14px 0 !important; }
        .script-market-backdrop.market-iv-open .script-market-tabs { gap:4px !important;padding:7px 10px !important; }
        .script-market-backdrop.market-iv-open .script-market-window .market-tab { min-width:60px;min-height:36px;padding-inline:6px !important;font-size:8px !important; }
        .script-market-backdrop.market-iv-open .script-market-window .market-filters-toggle { min-width:102px;min-height:36px;font-size:8px !important; }
        .script-market-backdrop.market-iv-open .script-market-window .market-view-btn { min-width:54px; }

        /* Categorías fuera del marco: el selector permanece como controlador lógico oculto. */
        .script-market-window .market-category { display:none !important; }
        /* El desplazamiento por layout evita rasterizar todo el Market como una textura borrosa
           cuando el zoom del webview usa una escala fraccionaria (90%, 80%, etc.). */
        .script-market-backdrop:not(.market-iv-open) > .market-iv-stage { left:26px;transform:none; }
        .script-market-window,.market-iv-calculator {
            -webkit-font-smoothing:antialiased;
            text-rendering:geometricPrecision;
            transform-style:flat;
        }
        .script-market-window .market-art img,
        .script-market-window .market-tab img,
        .script-market-window .market-favorite-chip img,
        .script-market-window .market-category-sprite,
        .market-iv-calculator .market-iv-sprite img { image-rendering:pixelated !important; }
        .market-category-rail {
            position:absolute;z-index:7;top:70px;left:auto;right:calc(100% + 8px);width:44px;display:grid;gap:6px;padding:0;overflow:visible;transition:opacity .18s ease,transform .18s ease;
        }
        .market-category-rail[hidden] { display:none !important; }
        .market-category-rail-btn {
            width:44px;height:42px;box-sizing:border-box;display:flex;align-items:center;justify-content:flex-start;padding:0 !important;overflow:hidden;color:#dce7f1;background:linear-gradient(145deg,#17283d,#112137);border:1px solid #304862;border-radius:9px;box-shadow:0 6px 16px rgba(0,0,0,.25),inset 0 1px rgba(255,255,255,.035);font:800 10px Inter,"Segoe UI",sans-serif;white-space:nowrap;cursor:pointer;transform:translateX(0);transform-origin:right center;transition:width .2s cubic-bezier(.22,.8,.25,1),transform .2s cubic-bezier(.22,.8,.25,1),background .15s,border-color .15s;
        }
        .market-category-rail-btn:hover,.market-category-rail-btn:focus-visible { width:136px;transform:translateX(-4px);color:#fff;background:linear-gradient(145deg,#20364f,#172a42);border-color:#527392;outline:0; }
        .market-category-rail-btn.on { color:#17130a;background:linear-gradient(180deg,#ffd778,#efba4c);border-color:#ffdb7c;box-shadow:0 7px 18px rgba(220,163,43,.2); }
        .market-category-rail-icon { flex:0 0 42px;width:42px;display:grid;place-items:center;font-size:16px; }
        .market-category-rail-icon .market-category-sprite { width:28px;height:28px;display:block;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 3px 4px rgba(0,0,0,.55)); }
        .market-category-rail-icon[data-sprite-role="pokemon"] .market-category-sprite { width:32px;height:32px; }
        .market-category-all-grid { width:17px;height:17px;display:grid;grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(2,1fr);gap:2px; }
        .market-category-all-grid i { display:block;background:currentColor;border:1px solid color-mix(in srgb,currentColor 58%,#17283d);border-radius:1px;box-shadow:inset 0 1px rgba(255,255,255,.24); }
        .market-category-stone-fallback { color:#b6c9dc;font-size:17px;transform:rotate(45deg); }
        .market-category-ball-fallback { width:18px;height:18px;display:block;border:2px solid #dbe8f3;border-radius:50%;background:linear-gradient(#ef4444 0 45%,#111827 45% 55%,#f8fafc 55%);box-shadow:0 2px 4px #0008; }
        .market-category-sprite.is-swapping { animation:market-category-sprite-swap .34s ease; }
        @keyframes market-category-sprite-swap { 0%{opacity:.2;transform:scale(.72) rotate(-8deg)}65%{opacity:1;transform:scale(1.1) rotate(3deg)}100%{opacity:1;transform:none} }
        .market-category-rail-label { min-width:82px;padding-right:10px;overflow:hidden;text-overflow:ellipsis;text-align:left; }
        .script-market-backdrop.market-iv-open .market-category-rail { opacity:0;pointer-events:none;transform:translateX(-10px); }

        /* Capa visual compartida: tienda de Poké Balls, pociones y curas. */
        .portable-ball-backdrop { background:radial-gradient(circle at 50% 15%,rgba(25,54,86,.28),transparent 48%),rgba(2,8,16,.8) !important;backdrop-filter:blur(5px); }
        .script-portable-ball-window { color:#f2f6fb;background:radial-gradient(circle at 18% 0,rgba(49,82,119,.14),transparent 36%),linear-gradient(145deg,#0c1828,#08131f 70%) !important;border:1px solid #334c68 !important;border-radius:18px !important;box-shadow:0 26px 80px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.035) !important; }
        .script-portable-ball-window .ball-head { display:flex;align-items:center;gap:8px;min-height:64px;padding:11px 17px !important;background:linear-gradient(100deg,#1a2d46,#122238) !important;border-bottom:1px solid #29415a !important;box-shadow:none; }
        .script-portable-ball-window .ball-head > b { flex:1 1 auto;min-width:0;color:#f4f7fb !important;font-size:17px;text-shadow:none; }
        .script-portable-ball-window .ball-gold { flex:0 0 auto;min-height:34px;box-sizing:border-box;display:flex;align-items:center;padding:0 12px;color:#66ee91 !important;background:#081524;border:1px solid #2c435d;border-radius:8px;box-shadow:none;font-size:12px;white-space:nowrap; }
        .script-portable-ball-window .portable-ball-close { flex:0 0 32px;width:32px;height:32px;display:grid;place-items:center;padding:0 !important;color:#a7b8c8 !important;background:transparent !important;border:1px solid #36516d !important;border-radius:7px !important; }
        .script-portable-ball-window .portable-ball-close:hover { color:#fff !important;background:#233b57 !important;transform:none; }
        .script-portable-ball-window .portable-ball-status { padding:8px 14px !important;color:#91a6ba !important;background:#0a1929;border-bottom:1px solid #29415a; }
        .script-portable-ball-window .portable-ball-list { flex:1 1 auto;min-height:0;display:grid;overflow-y:auto;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px !important;padding:11px 12px 14px !important;background:transparent !important;scrollbar-width:thin;scrollbar-color:#3b5773 #091421; }
        .script-portable-ball-window .portable-ball-list::-webkit-scrollbar { width:9px; }.script-portable-ball-window .portable-ball-list::-webkit-scrollbar-track{background:#091421;border-radius:9px}.script-portable-ball-window .portable-ball-list::-webkit-scrollbar-thumb{background:#3b5773;border:2px solid #091421;border-radius:9px}
        .script-portable-ball-window .portable-shop-heading { padding:9px 11px;color:#f2f6fb;background:linear-gradient(90deg,#1a2d46,#13243a);border:1px solid #304963;border-left:3px solid #f2c354;border-radius:9px;box-shadow:none; }
        .script-portable-ball-window .ball-row { min-height:175px !important;padding:13px 12px !important;background:linear-gradient(145deg,#17283d,#112137) !important;border:1px solid #2d445e !important;border-radius:11px !important;box-shadow:0 7px 18px rgba(0,0,0,.17),inset 0 1px rgba(255,255,255,.035) !important; }
        .script-portable-ball-window .ball-row::after { display:none !important; }
        .script-portable-ball-window .ball-row:hover { background:linear-gradient(145deg,#1d314a,#16283f) !important;border-color:#486985 !important;transform:translateY(-1px); }
        .script-portable-ball-window .portable-ball-visual { background:#0a1727;border-color:#304a65;border-radius:9px; }
        .script-portable-ball-window .portable-ball-kind { color:#55bfff; }.script-portable-ball-window .portable-ball-name{color:#f4f7fb!important}.script-portable-ball-window .portable-ball-owned{color:#66ee91}.script-portable-ball-window .portable-ball-price{color:#f7c858}
        .script-portable-ball-window .ball-actions { border-top-color:#2a4058; }
        .script-portable-ball-window .ball-buy { min-height:36px;color:#dfeaf3;background:#172a40;border:1px solid #35516d;border-radius:7px;box-shadow:none; }
        .script-portable-ball-window .ball-buy:hover { color:#17130a;background:linear-gradient(180deg,#ffd778,#efba4c);border-color:#ffdb7c; }

        /* Capa visual compartida: ventas NPC de objetos y Pokémon. */
        .hunt-sell-backdrop { background:radial-gradient(circle at 50% 15%,rgba(25,54,86,.28),transparent 48%),rgba(2,8,16,.8) !important;backdrop-filter:blur(5px); }
        .hunt-sell-backdrop .script-npc-sell-window {
            color:#f2f6fb;background:radial-gradient(circle at 18% 0,rgba(49,82,119,.14),transparent 36%),linear-gradient(145deg,#0c1828,#08131f 70%) !important;border:1px solid #334c68 !important;border-radius:18px !important;box-shadow:0 26px 80px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.035) !important;
        }
        .hunt-sell-backdrop .script-npc-sell-window .sell-confirm-title { min-height:64px;padding:11px 17px !important;color:#f4f7fb;background:linear-gradient(100deg,#1a2d46,#122238) !important;border-bottom:1px solid #29415a !important;box-shadow:none;font-size:16px;font-weight:800; }
        .hunt-sell-backdrop .hunt-pokemon-open,.hunt-sell-backdrop .hunt-items-open { min-height:36px;padding:0 13px !important;color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border:1px solid #ffdb7c !important;border-radius:9px !important;box-shadow:0 5px 14px rgba(220,163,43,.15) !important; }
        .hunt-sell-backdrop .hunt-sell-close { width:32px;height:32px;display:grid;place-items:center;padding:0 !important;color:#a7b8c8 !important;background:transparent !important;border:1px solid #36516d !important;border-radius:7px !important; }
        .hunt-sell-backdrop .script-npc-sell-window .sell-confirm-body { padding:12px !important;background:transparent !important; }
        .hunt-sell-backdrop .hunt-pokemon-filters { padding:9px;margin-bottom:9px !important;background:#0b1a2b;border:1px solid #2d455f;border-radius:10px; }
        .hunt-sell-backdrop .hunt-pokemon-filters input,.hunt-sell-backdrop .hunt-pokemon-filters select,.hunt-sell-backdrop .hunt-sell-row input[type="number"] { min-height:36px !important;color:#edf3f8 !important;background:#091725 !important;border:1px solid #304a65 !important;border-radius:8px !important;box-shadow:inset 0 1px 3px rgba(0,0,0,.25) !important; }
        .hunt-sell-backdrop .hunt-quality-tiers { flex-basis:100%;padding-top:7px;border-top:1px solid #2d455f; }
        .hunt-sell-backdrop .hunt-quality-tier,.hunt-sell-backdrop .hunt-quality-tier-shortcut { border-radius:6px !important;box-shadow:none !important; }
        .hunt-sell-backdrop .hunt-sell-status { padding:8px 11px !important;color:#a8b8c8 !important;background:#0a1929;border:1px solid #2a435d;border-radius:9px; }
        .hunt-sell-backdrop .hunt-sell-list { gap:9px;padding:2px 5px 9px 2px;scrollbar-width:thin;scrollbar-color:#3b5773 #091421; }
        .hunt-sell-backdrop .hunt-sell-row { background:linear-gradient(145deg,#17283d,#112137) !important;border:1px solid #2d445e !important;border-radius:11px !important;box-shadow:0 7px 18px rgba(0,0,0,.17),inset 0 1px rgba(255,255,255,.035) !important; }
        .hunt-sell-backdrop .hunt-sell-row:hover { background:linear-gradient(145deg,#1d314a,#16283f) !important;border-color:#486985 !important;transform:translateY(-1px); }
        .hunt-sell-backdrop .hunt-sell-row:has(input[type="checkbox"]:checked) { border-color:#f3c657 !important;box-shadow:inset 3px 0 #f3c657,0 8px 20px rgba(0,0,0,.22) !important; }
        .hunt-sell-backdrop .hunt-sell-art { background:#0a1727;border-color:#304a65;border-radius:8px; }
        .hunt-sell-backdrop .hunt-sell-kind { color:#55bfff; }.hunt-sell-backdrop .hunt-sell-name{color:#f4f7fb}.hunt-sell-backdrop .hunt-sell-meta{color:#8fa5ba}
        .hunt-sell-backdrop .sell-confirm-footer { border-top-color:#2a4058; }
        .hunt-sell-backdrop .sell-confirm-footer button { min-height:40px;border-radius:8px !important; }
        .hunt-sell-backdrop .sell-confirm-footer button:not(.yes):not(.no) { color:#dfeaf3 !important;background:#17283d !important;border:1px solid #35516d !important; }
        .hunt-sell-backdrop .sell-confirm-footer .yes { color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border-color:#ffdb7c !important; }
        .hunt-sell-backdrop .sell-confirm-footer .no { color:#c8d5df !important;background:#17283d !important;border-color:#344f6b !important; }

        /* Capa visual compartida: Depot. */
        .portable-depot-backdrop { background:radial-gradient(circle at 50% 15%,rgba(25,54,86,.28),transparent 48%),rgba(2,8,16,.8) !important;backdrop-filter:blur(5px); }
        .portable-depot-backdrop .script-portable-depot-window { color:#f2f6fb;background:radial-gradient(circle at 18% 0,rgba(49,82,119,.14),transparent 36%),linear-gradient(145deg,#0c1828,#08131f 70%) !important;border:1px solid #334c68 !important;border-radius:18px !important;box-shadow:0 26px 80px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.035) !important; }
        .portable-depot-backdrop .depot-head { min-height:68px;padding:10px 15px !important;background:linear-gradient(100deg,#1a2d46,#122238) !important;border-bottom:1px solid #29415a !important;box-shadow:none; }
        .portable-depot-brand-icon { background:#0a1727;border-color:#36516d;border-radius:9px;box-shadow:none; }
        .portable-depot-brand b { color:#f4f7fb;font-size:17px;text-shadow:none; }.portable-depot-brand small{color:#8199af}
        .portable-depot-backdrop .depot-tab { min-height:38px;padding:0 12px !important;color:#e5edf4 !important;background:#17283d !important;border:1px solid #304862 !important;border-radius:9px !important;box-shadow:inset 0 1px rgba(255,255,255,.035) !important; }
        .portable-depot-backdrop .depot-tab:hover { color:#fff !important;background:#1e334c !important;border-color:#476783 !important; }
        .portable-depot-backdrop .depot-tab.active { color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border-color:#ffdb7c !important;box-shadow:0 5px 14px rgba(220,163,43,.15) !important; }
        .portable-depot-view-toggle { min-height:38px;padding:3px;background:#0a1727;border-color:#304862;border-radius:9px; }
        .portable-depot-view-btn { min-height:30px;border-radius:6px !important; }.portable-depot-view-btn.on{background:linear-gradient(180deg,#ffd778,#efba4c)!important;border-color:#ffdb7c!important}
        .portable-depot-close { width:32px;height:32px;display:grid;place-items:center;padding:0 !important;color:#a7b8c8 !important;background:transparent !important;border:1px solid #36516d !important;border-radius:7px !important; }
        .portable-depot-backdrop .sell-confirm-body { padding:11px !important;background:transparent !important; }
        .portable-depot-content { gap:10px !important; }
        .portable-depot-content > .portable-depot-column { background:linear-gradient(145deg,#122238,#0d1b2d) !important;border:1px solid #2e465f !important;border-radius:11px !important;box-shadow:0 7px 18px rgba(0,0,0,.16),inset 0 1px rgba(255,255,255,.03) !important;scrollbar-color:#3b5773 transparent; }
        .depot-column-head { background:linear-gradient(90deg,#1a2d46,#13243a);border-bottom-color:#304963;color:#f2f6fb !important;box-shadow:0 3px 9px rgba(0,0,0,.25); }
        .portable-depot-content .depot-entry { background:linear-gradient(145deg,color-mix(in srgb,var(--depot-accent) 8%,#17283d),#112137 74%) !important;border-color:color-mix(in srgb,var(--depot-accent) 48%,#2d445e) !important;border-radius:9px !important;box-shadow:0 5px 14px rgba(0,0,0,.15),inset 0 1px rgba(255,255,255,.03) !important; }
        .portable-depot-content .depot-entry:hover { background:linear-gradient(145deg,color-mix(in srgb,var(--depot-accent) 13%,#1d314a),#16283f 74%) !important;border-color:color-mix(in srgb,var(--depot-accent) 72%,#486985) !important; }
        .depot-entry-art { background:#0a1727;border-radius:8px; }.depot-entry-name{color:#f4f7fb}.depot-entry-meta{color:#8ba2b7}
        .depot-entry-action,.portable-depot-side-action { color:#dfeaf3 !important;background:#172a40;border-color:#35516d;border-radius:7px; }
        .depot-entry:hover .depot-entry-action { color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c);border-color:#ffdb7c; }
        .portable-depot-poke-filters,.portable-depot-family-header { background:#0b1a2b !important;border:1px solid #2d455f !important;border-left:3px solid #f0bd4e !important;border-radius:9px !important;box-shadow:none !important; }
        .portable-depot-poke-filters input { background:#091725;border-color:#304a65;border-radius:7px; }

        /* Capa visual compartida: configuración del script. */
        .cfg-window.script-mods-open { min-height:0;display:flex !important;flex-direction:column !important;color:#f2f6fb;background:radial-gradient(circle at 18% 0,rgba(49,82,119,.14),transparent 36%),linear-gradient(145deg,#0c1828,#08131f 70%) !important;border:1px solid #334c68 !important;border-radius:18px !important;box-shadow:0 26px 80px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.035) !important;overflow:hidden; }
        .cfg-window.script-mods-open .cfg-tabs { flex:0 0 auto;min-height:52px;padding:7px 10px;background:linear-gradient(100deg,#1a2d46,#122238) !important;border-bottom:1px solid #29415a !important; }
        .cfg-window.script-mods-open .cfg-tab { min-height:36px;padding:0 12px !important;color:#dfe8f0 !important;background:#17283d !important;border:1px solid #304862 !important;border-radius:8px !important; }
        .cfg-window.script-mods-open .cfg-tab.on,.cfg-window.script-mods-open .cfg-tab-mods.on { color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border-color:#ffdb7c !important;box-shadow:0 5px 14px rgba(220,163,43,.14) !important; }
        .cfg-window.script-mods-open .cfg-body { background:#08131f !important; }
        .cfg-window.script-mods-open .cfg-body { flex:1 1 0 !important;min-height:0 !important;height:0 !important;display:flex !important;flex-direction:column;overflow:hidden !important; }
        .cfg-window.script-mods-open .cfg-mods-content { flex:1 1 0;min-height:0;max-height:100%;width:100%;height:100% !important;box-sizing:border-box;overflow-x:hidden !important;overflow-y:scroll !important;overscroll-behavior:contain;touch-action:pan-y;scrollbar-gutter:stable;scrollbar-width:auto;scrollbar-color:#527392 #091421;outline:none; }
        .cfg-window.script-mods-open .cfg-mods-content::-webkit-scrollbar { width:12px; }.cfg-window.script-mods-open .cfg-mods-content::-webkit-scrollbar-track{background:#091421;border-left:1px solid #1e3349}.cfg-window.script-mods-open .cfg-mods-content::-webkit-scrollbar-thumb{min-height:38px;background:#527392;border:2px solid #091421;border-radius:9px}.cfg-window.script-mods-open .cfg-mods-content::-webkit-scrollbar-thumb:hover{background:#6a8cab}
        .cfg-mods-content .script-mods-grid { min-height:max-content;padding:11px;gap:10px;background:transparent; }
        .cfg-mods-content .script-mods-title { padding:12px 14px !important;background:linear-gradient(135deg,#172b43,#102036);border:1px solid #304963 !important;border-left:4px solid #f2c354 !important;border-radius:11px;box-shadow:0 7px 18px rgba(0,0,0,.18); }
        .script-settings-logo { background:#0a1727;border-color:#395673;border-radius:9px;box-shadow:none; }.script-settings-brand b{color:#f4f7fb}.script-settings-brand small{color:#88a0b6}
        .script-language-control select,.cfg-mods-content input:not([type="checkbox"]),.cfg-mods-content select { color:#edf3f8 !important;background:#091725 !important;border:1px solid #304a65 !important;border-radius:8px !important; }
        .cfg-mods-content .script-mod-category { background:linear-gradient(145deg,#122238,#0d1b2d);border:1px solid #2e465f;border-radius:11px;box-shadow:0 7px 18px rgba(0,0,0,.16);overflow:hidden; }
        .cfg-mods-content .script-mod-category > h3 { background:linear-gradient(90deg,#1a2d46,#13243a);border-bottom-color:#304963;color:#f2f6fb; }
        .cfg-mods-content .script-mod-category > h3 span { background:#0a1727;border-color:#36516d; }
        .cfg-mods-content .script-mod-category-grid > .cfg-row { background:linear-gradient(145deg,#17283d,#112137) !important;border:1px solid #2d445e !important;border-radius:9px !important;box-shadow:inset 0 1px rgba(255,255,255,.025); }
        .cfg-mods-content .script-mod-category-grid > .cfg-row:hover { background:linear-gradient(145deg,#1d314a,#16283f) !important;border-color:#486985 !important;transform:translateY(-1px); }
        .cfg-mods-content .cfg-label { min-width:0;display:flex;flex-direction:column;gap:3px; }
        .cfg-mods-content .cfg-label b { display:block;color:#f1f5f9 !important; }.cfg-mods-content .cfg-label span,.cfg-mods-content .cfg-label small{display:block;color:#8da4b9!important}
        .cfg-mods-content input[type="checkbox"] { background:#091725;border-color:#36516d; }.cfg-mods-content input[type="checkbox"]:checked{background:#dbaa3d;border-color:#ffdb7c;box-shadow:0 0 0 3px rgba(247,200,88,.1)}.cfg-mods-content input[type="checkbox"]:checked::after{background:#fff3cc}
        .cfg-mods-content .cfg-seg { background:#0a1727;border-color:#304862;border-radius:8px; }
        .cfg-mods-content .cfg-seg-btn { border-radius:6px; }.cfg-mods-content .cfg-seg-btn.on{color:#17130a;background:linear-gradient(180deg,#ffd778,#efba4c);border-color:#ffdb7c;box-shadow:none}

        /* Capa visual compartida: mapa simplificado y selector de hunts. */
        .map-window { color:#f2f6fb !important;background:radial-gradient(circle at 18% 0,rgba(49,82,119,.14),transparent 36%),linear-gradient(145deg,#0c1828,#08131f 70%) !important;border:1px solid #334c68 !important;border-radius:18px !important;box-shadow:0 26px 80px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.035) !important;overflow:hidden !important; }
        .map-window > :first-child:not(.map-body),.map-window .map-head,.map-window .map-header { min-height:58px;box-sizing:border-box;padding:10px 15px !important;color:#f4f7fb !important;background:linear-gradient(100deg,#1a2d46,#122238) !important;border-bottom:1px solid #29415a !important;border-radius:17px 17px 0 0 !important;box-shadow:none !important; }
        .map-window .cfg-x,.map-window .map-close { width:32px;height:32px;display:grid;place-items:center;padding:0 !important;color:#a7b8c8 !important;background:transparent !important;border:1px solid #36516d !important;border-radius:7px !important; }
        .map-window .cfg-x:hover,.map-window .map-close:hover { color:#fff !important;background:#233b57 !important;border-color:#527392 !important; }
        .map-window .map-body { min-height:0;padding:0 12px 12px !important;background:#08131f !important; }
        .map-window .script-city-area { min-width:112px !important;min-height:38px !important;padding:7px 14px !important;color:#dfe8f0 !important;background:#17283d !important;border:1px solid #304862 !important;border-radius:8px !important;box-shadow:none !important; }
        .map-window .script-city-area:hover { color:#fff !important;background:#20364f !important;border-color:#527392 !important; }
        .map-window .script-city-area.on { color:#17130a !important;background:linear-gradient(180deg,#ffd778,#efba4c) !important;border-color:#ffdb7c !important;box-shadow:0 5px 14px rgba(220,163,43,.14) !important; }
        #custom-hunts-filter-bar { margin:8px 0 9px !important;padding:11px !important;background:linear-gradient(145deg,#17283d,#112137) !important;border:1px solid #2d445e !important;border-left:4px solid #f2c354 !important;border-radius:11px !important;box-shadow:0 7px 18px rgba(0,0,0,.17) !important; }
        .script-map-filter-head { border-bottom-color:#2d455f; }
        .script-map-filter-title > span { background:#0a1727;border-color:#36516d;border-radius:8px; }
        .script-map-filter-title b { color:#f3f7fb; }.script-map-filter-title small{color:#8da4b9}.script-map-result-count{color:#f7c858}
        .script-map-filter-toggle,#reset-hunts-filters { color:#dfe8f0;background:#172a40;border:1px solid #35516d;border-radius:7px;box-shadow:none; }
        .script-map-filter-toggle:hover,#reset-hunts-filters:hover { color:#17130a;background:linear-gradient(180deg,#ffd778,#efba4c);border-color:#ffdb7c; }
        .script-map-field { color:#7f9ab2; }
        .script-map-field input,.script-map-field select,.map-window .map-filter-q,.map-window input[type="number"],.map-window select { color:#edf3f8 !important;background:#091725 !important;border:1px solid #304a65 !important;border-radius:8px !important;box-shadow:none !important; }
        .script-map-field input:focus,.script-map-field select:focus,.map-window .map-filter-q:focus { border-color:#f2c354 !important;box-shadow:0 0 0 3px rgba(247,200,88,.1) !important; }
        #custom-hunts-capture-bar { border-top-color:#2d455f !important; }
        #custom-hunts-capture-bar .dex-fbtn { color:#b7c7d5;background:#0a1727;border-color:#304a65;border-radius:8px; }
        #custom-hunts-capture-bar .dex-fbtn.on { color:#17130a;background:linear-gradient(180deg,#ffd778,#efba4c);border-color:#ffdb7c;box-shadow:none; }
        #simple-hunts-container.script-map-card-grid > .script-map-card { background:linear-gradient(145deg,color-mix(in srgb,var(--card-accent) 9%,#17283d),#112137 76%) !important;border-color:color-mix(in srgb,var(--card-accent) 48%,#2d445e) !important;border-radius:11px !important;box-shadow:0 7px 18px rgba(0,0,0,.17),inset 0 1px rgba(255,255,255,.035) !important; }
        #simple-hunts-container.script-map-card-grid > .script-map-card::after { display:none !important; }
        #simple-hunts-container.script-map-card-grid > .script-map-card:hover { background:linear-gradient(145deg,color-mix(in srgb,var(--card-accent) 12%,#1d314a),#16283f 76%) !important;border-color:color-mix(in srgb,var(--card-accent) 68%,#486985) !important;transform:translateY(-1px) !important;box-shadow:0 9px 22px rgba(0,0,0,.2) !important; }
        #simple-hunts-container .script-map-card-art { background:#0a1727 !important;border-color:color-mix(in srgb,var(--card-accent) 48%,#304a65) !important;border-radius:9px !important;box-shadow:inset 0 1px rgba(255,255,255,.025) !important; }
        .script-map-card-title { color:#f4f7fb; }.script-map-level{color:#b8c9d8;background:#0b1a2a;border-color:#36516d;border-radius:6px}.script-map-meta{border-top-color:#2b425a;color:#8da4b9}.script-map-city-copy{color:#8da4b9}
        .script-map-travel { min-height:32px;color:#17130a;background:linear-gradient(180deg,#ffd778,#efba4c);border:1px solid #ffdb7c;border-radius:7px;box-shadow:none; }
        .script-map-travel:hover { background:linear-gradient(180deg,#ffe294,#f5c65b);filter:none; }
        #simple-hunts-container { scrollbar-width:thin;scrollbar-color:#527392 #091421; }
        #simple-hunts-container::-webkit-scrollbar { width:10px; }#simple-hunts-container::-webkit-scrollbar-track{background:#091421}#simple-hunts-container::-webkit-scrollbar-thumb{background:#527392;border:2px solid #091421;border-radius:9px}

        @media (max-width:1100px) {
            .script-market-tabs { flex-wrap:wrap; }
            .script-market-window .market-tab { min-width:62px; }
            .script-market-window .market-filters-toggle { order:2;flex:1; }
            .script-market-window .market-view-toggle { order:2;flex:1; }
        }
        @media (max-width:1150px) {
            .script-market-backdrop:not(.market-iv-open) > .market-iv-stage { left:0;transform:none; }
            .market-category-rail { left:6px;right:auto;top:126px; }
        }
        @media (max-width:900px) {
            .script-market-window .market-list.market-view-cards { grid-template-columns:1fr !important; }
            .script-market-window .market-favorites-bar { margin-inline:9px; }
            .script-market-window .market-filters-toggle { grid-column:1/-1;order:0; }
            .market-category-rail { top:174px;left:4px;right:auto; }
            .script-portable-ball-window .portable-ball-list { grid-template-columns:1fr !important; }
        }

        /* Responsividad por ancho real de cada ventana. Funciona también al cambiar su preset en escritorio. */
        .script-scalable-window[data-script-window-custom-sized="true"],
        .script-scalable-window[data-script-window-custom-sized="true"] *,
        .script-window-layout-mobile,.script-window-layout-mobile *,
        .script-window-layout-compact,.script-window-layout-compact * { box-sizing:border-box; }
        .script-scalable-window img,.script-scalable-window canvas { max-width:100%; }
        .script-scalable-window input,.script-scalable-window select,.script-scalable-window textarea,
        .script-scalable-window button { min-width:0;max-width:100%; }

        .market-iv-stage.script-window-layout-compact .script-market-tabs { flex-wrap:wrap; }
        .market-iv-stage.script-window-layout-compact .script-market-window .market-list.market-view-cards { grid-template-columns:repeat(2,minmax(0,1fr)) !important; }
        .market-iv-stage.script-window-layout-compact .script-market-window .market-search { order:4;flex-basis:100% !important;min-width:100% !important; }
        .market-iv-stage.script-window-layout-compact .market-sell-editor { grid-template-columns:72px minmax(0,1fr);grid-template-areas:"art info" "form form"; }
        .market-iv-stage.script-window-layout-compact .market-sell-editor-form,
        .market-iv-stage.script-window-layout-compact .market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"qty currency" "price price" "submit submit" "summary summary"; }
        .market-iv-stage.script-window-layout-compact .market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-areas:"currency currency" "price price" "submit submit" "summary summary"; }
        .script-market-backdrop.market-iv-open > .market-iv-stage.script-window-layout-compact > .script-market-window { width:100% !important;opacity:.2;pointer-events:none; }
        .market-iv-stage.script-window-layout-compact > .market-iv-calculator { right:0;z-index:3;max-width:min(374px,100%);box-shadow:-16px 0 40px rgba(0,0,0,.8); }

        .map-window.script-window-layout-compact .script-map-filter-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .map-window.script-window-layout-compact .script-map-field:first-child,
        .map-window.script-window-layout-compact .script-map-filter-actions { grid-column:1/-1; }
        .map-window.script-window-layout-compact #simple-hunts-container.script-map-card-grid { grid-template-columns:1fr; }
        .script-portable-ball-window.script-window-layout-compact .portable-ball-list { grid-template-columns:1fr !important; }
        .script-portable-depot-window.script-window-layout-compact .portable-depot-content { grid-template-columns:1fr;overflow-y:auto !important; }
        .script-portable-depot-window.script-window-layout-compact .portable-depot-content > .portable-depot-column { min-height:260px;height:auto !important; }
        .script-npc-sell-window.script-window-layout-compact .hunt-sell-list { grid-template-columns:1fr !important; }
        .cfg-window.script-window-layout-compact .script-mods-grid,
        .cfg-window.script-window-layout-compact .script-mod-category-grid { grid-template-columns:1fr !important; }
        .cfg-window.script-window-layout-compact .script-mod-category,
        .cfg-window.script-window-layout-compact .script-mods-wide { grid-column:auto !important; }
        .ha-window.script-window-layout-compact:not(.ha-compare-modal) .ha-grid { grid-template-columns:repeat(2,minmax(0,1fr)) !important; }
        .ha-compare-modal.script-window-layout-compact > div:nth-child(2) { overflow:auto !important; }
        .inv-window.script-window-layout-compact .inv-grid,
        .inv-window.script-window-layout-compact .inv-items,
        .inv-window.script-window-layout-compact .inv-slots { grid-template-columns:repeat(auto-fill,minmax(42px,1fr)) !important; }
        .dex-window.script-window-layout-compact .dex-script-controls { align-items:stretch; }
        .dex-window.script-window-layout-compact .dex-script-controls .dex-fbtn { flex:1 1 calc(33.333% - 6px); }

        .market-iv-stage.script-window-layout-mobile > .script-market-window { border-radius:8px !important; }
        .market-iv-stage.script-window-layout-mobile .script-market-window .mk-head { min-height:auto;padding:8px !important;flex-wrap:wrap;gap:6px !important; }
        .market-iv-stage.script-window-layout-mobile .market-head-primary { flex-basis:calc(100% - 34px);flex-wrap:wrap;gap:6px; }
        .market-iv-stage.script-window-layout-mobile .market-head-primary > b { font-size:14px !important; }
        .market-iv-stage.script-window-layout-mobile .market-player-balance { order:2;flex-basis:100%;padding:5px 0 0;border-left:0;border-top:1px solid var(--market-line); }
        .market-iv-stage.script-window-layout-mobile .market-exchange-rate { display:none; }
        .market-iv-stage.script-window-layout-mobile .script-market-tabs { display:grid !important;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px !important;padding:6px !important; }
        .market-iv-stage.script-window-layout-mobile .market-tab { min-width:0 !important;width:100%;padding:5px 3px !important; }
        .market-iv-stage.script-window-layout-mobile .market-tab-label { display:none; }
        .market-iv-stage.script-window-layout-mobile .market-view-toggle { grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr; }
        .market-iv-stage.script-window-layout-mobile .market-buy-controls,
        .market-iv-stage.script-window-layout-mobile .market-sell-controls,
        .market-iv-stage.script-window-layout-mobile .market-pokemon-filters { margin:5px 6px 0 !important;padding:6px !important;gap:5px !important; }
        .market-iv-stage.script-window-layout-mobile .market-category,
        .market-iv-stage.script-window-layout-mobile .market-sort,
        .market-iv-stage.script-window-layout-mobile .market-item-rarity-filter { flex:1 1 calc(50% - 5px);min-width:0; }
        .market-iv-stage.script-window-layout-mobile .market-search { flex-basis:100% !important;min-width:100% !important; }
        .market-iv-stage.script-window-layout-mobile .market-list.market-view-cards,
        .market-iv-stage.script-window-layout-mobile .market-list.market-view-list { grid-template-columns:1fr !important;gap:8px !important;padding:7px 7px 58px !important; }
        .market-iv-stage.script-window-layout-mobile .market-buy-row.market-listing-row { grid-template-columns:56px minmax(0,1fr);grid-template-rows:auto auto;grid-template-areas:"art main" "footer footer";min-height:0 !important;padding:9px !important; }
        .market-iv-stage.script-window-layout-mobile .market-buy-row.market-pokemon-listing { grid-template-rows:auto auto auto;grid-template-areas:"art main" "stats stats" "footer footer"; }
        .market-iv-stage.script-window-layout-mobile .market-pokemon-listing .market-main { padding-right:72px; }
        .market-iv-stage.script-window-layout-mobile .market-buy-footer { grid-template-columns:minmax(62px,.55fr) minmax(0,1fr);grid-template-areas:"footerQty footerPrice" "footerQty footerConversion" "footerActions footerActions"; }
        .market-iv-stage.script-window-layout-mobile .market-pokemon-listing .market-buy-footer { grid-template-areas:"footerPrice footerPrice" "footerConversion footerConversion" "footerActions footerActions"; }
        .market-iv-stage.script-window-layout-mobile .market-buy-footer .market-actions { justify-self:stretch;justify-content:stretch; }
        .market-iv-stage.script-window-layout-mobile .market-buy-footer .market-actions input,
        .market-iv-stage.script-window-layout-mobile .market-buy-footer .market-actions .market-buy { flex:1;min-width:0;width:auto !important; }
        .market-iv-stage.script-window-layout-mobile .market-sell-editor { margin:6px;padding:8px;grid-template-columns:58px minmax(0,1fr);grid-template-areas:"art info" "form form"; }
        .market-iv-stage.script-window-layout-mobile .market-sell-editor-form,
        .market-iv-stage.script-window-layout-mobile .market-sell-editor.is-pokemon .market-sell-editor-form { grid-template-columns:1fr;grid-template-areas:"qty" "currency" "price" "submit" "summary"; }
        .market-iv-stage.script-window-layout-mobile .market-request-form { grid-template-columns:1fr; }
        .market-iv-stage.script-window-layout-mobile .market-request-field:first-of-type,
        .market-iv-stage.script-window-layout-mobile .market-request-submit,
        .market-iv-stage.script-window-layout-mobile .market-request-summary { grid-column:1; }
        .script-market-backdrop.market-iv-open > .market-iv-stage.script-window-layout-mobile > .script-market-window { width:100% !important;opacity:.16;pointer-events:none; }
        .market-iv-stage.script-window-layout-mobile > .market-iv-calculator { width:100% !important;max-width:100% !important;right:0;z-index:4;border-radius:8px !important;transform:none !important;transition:none !important; }
        .script-market-backdrop.market-iv-open > .market-iv-stage.script-window-layout-mobile > .market-iv-calculator { opacity:1 !important;visibility:visible !important; }

        .map-window.script-window-layout-mobile .map-body { padding:0 6px 7px !important; }
        .map-window.script-window-layout-mobile .script-map-filter-grid { grid-template-columns:1fr; }
        .map-window.script-window-layout-mobile .script-map-field,
        .map-window.script-window-layout-mobile .script-map-field:first-child,
        .map-window.script-window-layout-mobile .script-map-filter-actions { grid-column:1; }
        .map-window.script-window-layout-mobile .script-map-filter-actions button { width:100%; }
        .map-window.script-window-layout-mobile #simple-hunts-container.script-map-card-grid > .script-map-card { grid-template-columns:54px minmax(0,1fr);min-height:118px;padding:8px !important; }
        .map-window.script-window-layout-mobile #simple-hunts-container .script-map-card-actions { grid-column:1/-1;justify-content:stretch; }

        .script-portable-depot-window.script-window-layout-mobile .depot-head,
        .script-portable-ball-window.script-window-layout-mobile .ball-head,
        .script-npc-sell-window.script-window-layout-mobile .sell-confirm-title { flex-wrap:wrap;gap:6px; }
        .script-portable-depot-window.script-window-layout-mobile .portable-depot-tabs { order:3;flex-basis:100%;overflow-x:auto;justify-content:flex-start;scrollbar-width:none; }
        .script-portable-depot-window.script-window-layout-mobile .portable-depot-content { display:block !important;overflow-y:auto !important; }
        .script-portable-depot-window.script-window-layout-mobile .portable-depot-content > .portable-depot-column { height:auto !important;min-height:220px;margin-bottom:8px; }
        .script-portable-depot-window.script-window-layout-mobile .depot-entry { grid-template-columns:42px minmax(0,1fr) auto !important;gap:6px; }
        .script-portable-depot-window.script-window-layout-mobile .depot-entry-action { grid-column:2/-1;width:100%; }
        .script-portable-depot-window.script-window-layout-mobile .portable-depot-poke-filters { grid-template-columns:1fr !important; }
        .script-portable-depot-window.script-window-layout-mobile .portable-depot-poke-filters > * { grid-column:1 !important; }
        .script-portable-ball-window.script-window-layout-mobile .ball-head > b { flex-basis:100%; }
        .script-portable-ball-window.script-window-layout-mobile .portable-ball-list { grid-template-columns:1fr !important;padding:7px !important; }
        .script-portable-ball-window.script-window-layout-mobile .ball-row { min-height:0 !important;padding:10px !important; }
        .script-portable-ball-window.script-window-layout-mobile .ball-actions { grid-template-columns:repeat(3,minmax(0,1fr)); }
        .script-npc-sell-window.script-window-layout-mobile .sell-confirm-body { padding:7px !important; }
        .script-npc-sell-window.script-window-layout-mobile .hunt-sell-row,
        .script-npc-sell-window.script-window-layout-mobile .npc-pokemon-row { grid-template-columns:auto 44px minmax(0,1fr) 31px !important;min-height:94px;gap:6px !important;padding:7px !important; }
        .script-npc-sell-window.script-window-layout-mobile .hunt-sell-row input[type="number"] { grid-column:2/4;width:100%; }
        .script-npc-sell-window.script-window-layout-mobile .sell-confirm-footer { grid-template-columns:1fr;gap:5px; }

        .cfg-window.script-window-layout-mobile .cfg-tabs { overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none; }
        .cfg-window.script-window-layout-mobile .cfg-tab { flex:none; }
        .cfg-window.script-window-layout-mobile .script-mods-grid,
        .cfg-window.script-window-layout-mobile .script-mod-category-grid,
        .cfg-window.script-window-layout-mobile .script-window-scale-grid { grid-template-columns:1fr !important;padding:7px !important;gap:7px !important; }
        .cfg-window.script-window-layout-mobile .script-window-scale-row { grid-template-columns:minmax(0,1fr) 86px; }
        .cfg-window.script-window-layout-mobile .script-settings-brand,
        .cfg-window.script-window-layout-mobile .script-language-control { width:100%; }
        .cfg-window.script-window-layout-mobile .cfg-seg { flex-wrap:wrap; }
        .cfg-window.script-window-layout-mobile .cfg-seg-btn { min-height:36px; }

        .ha-window.script-window-layout-mobile:not(.ha-compare-modal) { min-width:0 !important;overflow:auto !important; }
        .ha-window.script-window-layout-mobile:not(.ha-compare-modal) .ha-title,
        .ha-window.script-window-layout-mobile:not(.ha-compare-modal) .ha-rates { flex-wrap:wrap !important; }
        .ha-window.script-window-layout-mobile:not(.ha-compare-modal) .ha-grid { grid-template-columns:1fr !important; }
        .ha-window.script-window-layout-mobile:not(.ha-compare-modal) .ha-script-actions { grid-template-columns:1fr; }
        .ha-compare-modal.script-window-layout-mobile { min-width:0 !important;resize:none !important;overflow:auto !important; }
        .ha-compare-modal.script-window-layout-mobile > div:nth-child(2) { overflow:auto !important;padding:8px !important; }
        .ha-compare-modal.script-window-layout-mobile .ha-compare-table { min-width:520px !important; }
        .inv-window.script-window-layout-mobile { min-width:0 !important;resize:none !important;overflow:auto !important; }
        .inv-window.script-window-layout-mobile .inv-grid,
        .inv-window.script-window-layout-mobile .inv-items,
        .inv-window.script-window-layout-mobile .inv-slots { grid-template-columns:repeat(auto-fill,42px) !important;justify-content:center !important;padding:7px !important; }
        .dex-window.script-window-layout-mobile { min-width:0 !important;overflow:auto !important; }
        .dex-window.script-window-layout-mobile .dex-script-controls { align-items:stretch;padding:6px !important; }
        .dex-window.script-window-layout-mobile .dex-script-controls .dex-fbtn { flex:1 1 calc(50% - 6px);min-height:38px; }
        .prof-window.script-window-layout-mobile,.poke-window.script-window-layout-mobile,
        .breed-window.script-window-layout-mobile,.win-window.script-window-layout-mobile,
        .npc-dialog.script-window-layout-mobile { min-width:0 !important;overflow:auto !important; }
        .script-window-layout-mobile .win-head,.script-window-layout-mobile .prof-head,
        .script-window-layout-mobile .poke-head,.script-window-layout-mobile .breed-head,
        .script-window-layout-mobile .win-actions { flex-wrap:wrap !important; }

        @media (max-width:640px) {
            .script-quality-dropdown { position:fixed !important;left:6px !important;right:6px !important;top:64px !important;width:auto !important;min-width:0 !important;max-height:calc(100dvh - 72px);overflow:auto; }
            .script-market-backdrop:has(> .market-iv-stage.script-window-layout-mobile) .market-category-rail { position:fixed !important;left:50% !important;right:auto !important;top:auto !important;bottom:max(5px,env(safe-area-inset-bottom)) !important;width:min(282px,calc(100vw - 10px)) !important;height:44px;display:flex !important;flex-direction:row;gap:4px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;transform:translateX(-50%) !important; }
            .script-market-backdrop:has(> .market-iv-stage.script-window-layout-mobile) .market-category-rail::-webkit-scrollbar { display:none; }
            .script-market-backdrop:has(> .market-iv-stage.script-window-layout-mobile) .market-category-rail-btn,
            .script-market-backdrop:has(> .market-iv-stage.script-window-layout-mobile) .market-category-rail-btn:hover { flex:0 0 42px;width:42px !important;transform:none !important; }
            .script-market-backdrop:has(> .market-iv-stage.script-window-layout-mobile) .market-category-rail-label { display:none; }
            .script-market-backdrop.market-iv-open:has(> .market-iv-stage.script-window-layout-mobile) .market-category-rail { display:none !important; }
            .script-shop-menu { left:max(6px,min(var(--script-shop-left,6px),calc(100vw - 266px))) !important;right:auto !important; }
        }
        @media (prefers-reduced-motion:reduce) {
            .script-market-window * { scroll-behavior:auto !important; }
            .market-category-rail,.market-category-rail-btn { transition:none !important; }
        }
    `;
    function appendStyleWhenReady(styleElement) {
        if (document.head) document.head.appendChild(styleElement);
        else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(styleElement), { once: true });
    }
    appendStyleWhenReady(style);

    applyGameFont();
    applyVisualPreferences();
    loadStoredCustomFont();

    const styleMapMod = document.createElement('style');
    styleMapMod.id = 'simplifier-map-override';
    styleMapMod.innerHTML = `
        .map-viewport, .map-img, .map-zoom { display: none !important; }
        .map-body { width: 100% !important; max-width: 100% !important; padding: 0 !important; background: transparent !important; }
        .hunt-marker { opacity: 0 !important; position: absolute !important; pointer-events: none !important; }
    `;

    function isScriptMapActive() { return localStorage.getItem(STORAGE_SCRIPT_ACTIVE) !== 'false'; }
    function setScriptMapActive(state) { localStorage.setItem(STORAGE_SCRIPT_ACTIVE, state ? 'true' : 'false'); applyMapScriptState(); }

    function isChatActive() { return localStorage.getItem(STORAGE_CHAT_ACTIVE) === 'true'; }
    function setChatActive(state) { localStorage.setItem(STORAGE_CHAT_ACTIVE, state ? 'true' : 'false'); applyChatState(); }

    function getNavTpMode() {
        const mode = localStorage.getItem(STORAGE_NAV_MODE) || 'off';
        if (mode === 'fav') {
            localStorage.setItem(STORAGE_NAV_MODE, 'off');
            return 'off';
        }
        return ['last', 'off'].includes(mode) ? mode : 'off';
    }
    function setNavTpMode(mode) { localStorage.setItem(STORAGE_NAV_MODE, mode); updateNavButtonAppearance(); }

    function getDropMode() { return localStorage.getItem(STORAGE_DROP_MODE) || 'icon'; }
    function setDropMode(mode) { localStorage.setItem(STORAGE_DROP_MODE, mode); buildSimpleList(); }

    function getSellConfirmItems() {
        const items = readStoredJSON(STORAGE_SELL_CONFIRM, ['Strange Pheromone', 'Rare Pokémon Picture']);
        return [...new Set([...items, 'Bronze Boss Token', 'Boss Bronze Token'])];
    }
    function setSellConfirmItems(items) {
        localStorage.setItem(STORAGE_SELL_CONFIRM, JSON.stringify(items));
    }

    function getSellLocks() {
        return readStoredJSON(STORAGE_SELL_LOCKS, []);
    }
    function addSellLock(itemName) {
        const locks = getSellLocks();
        if (!locks.includes(itemName)) { locks.push(itemName); localStorage.setItem(STORAGE_SELL_LOCKS, JSON.stringify(locks)); }
    }
    function removeSellLock(itemName) {
        const locks = getSellLocks().filter(n => n !== itemName);
        localStorage.setItem(STORAGE_SELL_LOCKS, JSON.stringify(locks));
    }
    function getNativeItemLocks() { return readStoredJSON(STORAGE_NATIVE_ITEM_LOCKS, []); }
    function setNativeItemLock(itemName, locked) {
        const normalized = String(itemName || '').trim();
        let locks = getNativeItemLocks().filter(name => name !== normalized);
        if (locked && normalized) locks.push(normalized);
        localStorage.setItem(STORAGE_NATIVE_ITEM_LOCKS, JSON.stringify(locks));
    }
    function getItemProtectionReason(entry) {
        const name = String(entry?.name || '').trim().toLowerCase();
        if (isNativeLocked(entry) || getNativeItemLocks().some(item => String(item).trim().toLowerCase() === name)) return 'cadeado nativo do Mark de Cerulean';
        if (getSellLocks().some(item => String(item).trim().toLowerCase() === name)) return 'proteção de venda das configurações do PIW-QOL';
        return '';
    }
    async function togglePortableItemProtection(entry, desiredLocked = null) {
        const normalizedName = String(entry?.name || '').trim().toLowerCase();
        const hasLegacyProtection = getSellLocks().some(item => String(item).trim().toLowerCase() === normalizedName);
        const hasNativeProtection = isNativeLocked(entry)
            || getNativeItemLocks().some(item => String(item).trim().toLowerCase() === normalizedName);
        const shouldLock = desiredLocked == null ? !(hasLegacyProtection || hasNativeProtection) : Boolean(desiredLocked);
        if (!shouldLock && hasLegacyProtection) removeSellLock(entry.name);
        if (!shouldLock && hasNativeProtection) {
            entry.locked = true;
            return toggleNativeLock('item', entry, false);
        }
        if (shouldLock && (hasLegacyProtection || hasNativeProtection)) return true;
        if (!shouldLock) return false;
        return toggleNativeLock('item', entry, true);
    }


    function isDexFastTravelActive() { return localStorage.getItem(STORAGE_DEX_FAST_TRAVEL) === 'true'; }
    function setDexFastTravel(val) { localStorage.setItem(STORAGE_DEX_FAST_TRAVEL, val ? 'true' : 'false'); }

    function isGuardLegendaryActive() { return localStorage.getItem(STORAGE_GUARD_LEGENDARY) !== 'false'; }
    function setGuardLegendary(val) { localStorage.setItem(STORAGE_GUARD_LEGENDARY, val ? 'true' : 'false'); }

    function isGuardSellLockActive() { return localStorage.getItem(STORAGE_GUARD_SELL_LOCK) !== 'false'; }
    function setGuardSellLock(val) { localStorage.setItem(STORAGE_GUARD_SELL_LOCK, val ? 'true' : 'false'); }

    function isHaCompact() { return localStorage.getItem(STORAGE_HA_COMPACT) === 'true'; }
    function setHaCompact(val) { localStorage.setItem(STORAGE_HA_COMPACT, val ? 'true' : 'false'); }
    function isHaDropsVisible() { return localStorage.getItem(STORAGE_HA_DROPS) === 'true'; }
    function setHaDropsVisible(val) { localStorage.setItem(STORAGE_HA_DROPS, val ? 'true' : 'false'); }
    function getDexFilter() { return localStorage.getItem(STORAGE_DEX_FILTER) || 'all'; }
    function setDexFilter(val) { localStorage.setItem(STORAGE_DEX_FILTER, val); }
    function isDexSortedByValue() { return localStorage.getItem(STORAGE_DEX_SORT_VALUE) === 'true'; }
    function setDexSortedByValue(val) { localStorage.setItem(STORAGE_DEX_SORT_VALUE, val ? 'true' : 'false'); }
    function loadCaughtPokemonCache() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_CAUGHT_POKEMON) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    function saveCaughtPokemonCache() {
        localStorage.setItem(STORAGE_CAUGHT_POKEMON, JSON.stringify([...globalCaughtPokemonNames]));
    }
    // A API /api/game/pokedex é a fonte confiável do status "capturado" (por pokeId);
    // o resultado fica em cache (nomes) para que o filtro/badge do mapa funcionem sem depender da Pokédex estar aberta.
    let caughtPokedexPromise = null;
    function loadCaughtPokedexData(force = false) {
        if (!force && caughtPokedexPromise) return caughtPokedexPromise;
        caughtPokedexPromise = gameApiRequest('/api/game/pokedex')
            .then(payload => {
                const species = Array.isArray(payload) ? payload
                    : (Array.isArray(payload?.species) ? payload.species
                        : (Array.isArray(payload?.pokedex) ? payload.pokedex
                            : (Array.isArray(payload?.data) ? payload.data : [])));
                const isCaughtSpecies = speciesEntry => Boolean(
                    speciesEntry?.caught ?? speciesEntry?.captured ?? speciesEntry?.owned
                    ?? (Number(speciesEntry?.count ?? speciesEntry?.captures ?? 0) > 0)
                );
                const caughtIds = new Set(species.filter(isCaughtSpecies).map(s => Number(
                    s.speciesId ?? s.pokeId ?? s.pokemonId ?? s.id
                )).filter(Number.isFinite));
                const previousCaughtIds = [...globalCaughtPokemonIds].sort((a, b) => a - b).join(',');
                globalCaughtPokemonIds.clear();
                caughtIds.forEach(id => { if (Number.isFinite(id)) globalCaughtPokemonIds.add(id); });
                const idsChanged = previousCaughtIds !== [...globalCaughtPokemonIds].sort((a, b) => a - b).join(',');
                let changed = false;
                species.filter(isCaughtSpecies).forEach(entry => {
                    const name = normalizePokemonName(entry?.name ?? entry?.pokemonName ?? entry?.pokemon?.name ?? '');
                    if (name && !globalCaughtPokemonNames.has(name)) {
                        globalCaughtPokemonNames.add(name);
                        changed = true;
                    }
                });
                for (const [name, poke] of globalCreatureApiData.entries()) {
                    const pokeId = Number(poke?.speciesId ?? poke?.pokeId ?? poke?.id);
                    if (Number.isFinite(pokeId) && caughtIds.has(pokeId) && !globalCaughtPokemonNames.has(name)) {
                        globalCaughtPokemonNames.add(name);
                        changed = true;
                    }
                }
                if (changed || idsChanged) {
                    if (changed) saveCaughtPokemonCache();
                    lastMapRenderSignature = '';
                    buildSimpleList();
                }
            })
            .catch(error => console.warn('⚠️ Falha ao carregar status de captura da Pokédex.', error))
            .finally(() => { caughtPokedexPromise = null; });
        return caughtPokedexPromise;
    }

    function getMarkerSpeciesId(marker, huntName = '') {
        const direct = marker?.speciesId ?? marker?.pokeId ?? marker?.pokemonId
            ?? marker?.pokemon?.speciesId ?? marker?.pokemon?.pokeId ?? marker?.pokemon?.id
            ?? marker?.creature?.speciesId ?? marker?.creature?.pokeId ?? marker?.creature?.id;
        const directId = Number(direct);
        if (Number.isFinite(directId)) return directId;
        const creature = globalCreatureApiData.get(getCleanHuntName(huntName || getMarkerName(marker)));
        const catalogId = Number(creature?.pokeId ?? creature?.speciesId ?? creature?.id);
        return Number.isFinite(catalogId) ? catalogId : null;
    }

    function isCaughtHunt(marker, huntName) {
        const speciesId = getMarkerSpeciesId(marker, huntName);
        if (speciesId != null && globalCaughtPokemonIds.has(speciesId)) return true;
        const cleanName = getCleanHuntName(huntName || getMarkerName(marker));
        if (globalCaughtPokemonNames.has(cleanName)) return true;
        const words = cleanName.split(/\s+/);
        for (let index = 0; index < words.length; index++) {
            if (globalCaughtPokemonNames.has(words.slice(index).join(' '))) return true;
        }
        return false;
    }
    function isHuntMarketActive() { return localStorage.getItem(STORAGE_HUNT_MARKET) !== 'false'; }
    function setHuntMarketActive(val) { localStorage.setItem(STORAGE_HUNT_MARKET, val ? 'true' : 'false'); }
    function isHuntBulkBuyActive() { return localStorage.getItem(STORAGE_HUNT_BULK_BUY) !== 'false'; }
    function setHuntBulkBuyActive(val) { localStorage.setItem(STORAGE_HUNT_BULK_BUY, val ? 'true' : 'false'); }
    function isHuntSellActive() { return localStorage.getItem(STORAGE_HUNT_SELL) !== 'false'; }
    function setHuntSellActive(val) { localStorage.setItem(STORAGE_HUNT_SELL, val ? 'true' : 'false'); }
    function isMarkEnhancementsActive() { return localStorage.getItem(STORAGE_MARK_ENHANCEMENTS) !== 'false'; }
    function setMarkEnhancementsActive(val) { localStorage.setItem(STORAGE_MARK_ENHANCEMENTS, val ? 'true' : 'false'); }

    function applyMapScriptState() {
        const active = isScriptMapActive();
        const existingContainer = document.getElementById('simple-hunts-container');
        if (active) {
            if (!document.getElementById('simplifier-map-override')) document.head.appendChild(styleMapMod);
            if (existingContainer) existingContainer.style.display = 'block';
            buildSimpleList();
        } else {
            if (document.getElementById('simplifier-map-override')) styleMapMod.remove();
            if (existingContainer) existingContainer.style.display = 'none';
        }
    }

    function applyChatState() {
        const active = isChatActive();
        const chatFab = document.querySelector('.chat-fab');
        const chatBox = document.querySelector('.chat-box');
        if (chatFab) chatFab.style.display = active ? '' : 'none';
        if (chatBox) chatBox.style.display = active ? '' : 'none';
    }

    function getFavorites() {
        return readStoredJSON(STORAGE_FAVS, []);
    }

    function toggleFavorite(huntName) {
        let favs = getFavorites();
        if (favs.includes(huntName)) {
            favs = favs.filter(name => name !== huntName);
            if (localStorage.getItem(STORAGE_PRIMARY_FAVORITE) === huntName) {
                localStorage.removeItem(STORAGE_PRIMARY_FAVORITE);
            }
        }
        else favs.push(huntName);
        localStorage.setItem(STORAGE_FAVS, JSON.stringify(favs));
        lastMapRenderSignature = '';
        updateNavButtonAppearance();
        buildSimpleList();
    }

    function getPrimaryFavorite() {
        const favorite = localStorage.getItem(STORAGE_PRIMARY_FAVORITE);
        return getFavorites().includes(favorite) ? favorite : null;
    }

    function showPrimaryFavoriteSelector({ teleportAfterSelection = true } = {}) {
        const favorites = getFavorites();
        if (!favorites.length) return showScriptNotice('Você não possui nenhuma hunt favorita.');
        document.querySelector('.primary-favorite-backdrop')?.remove();

        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop primary-favorite-backdrop';
        const modal = document.createElement('div');
        modal.className = 'sell-confirm-modal';
        modal.style.width = 'min(420px,92vw)';
        modal.innerHTML = `
            <div class="sell-confirm-title">
                <span>⭐ Escolher hunt principal</span>
                <button class="primary-favorite-close" type="button" style="margin-left:auto;background:none;border:0;color:#a0aec0;font-size:20px;cursor:pointer;">×</button>
            </div>
            <div class="sell-confirm-body">
                <p>Esta será usada sempre que você clicar no teleporte de favorita. Clique com o botão direito na estrela da barra para trocar depois.</p>
                <div class="primary-favorite-list" style="display:grid;gap:7px;"></div>
            </div>
        `;
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        modal.querySelector('.primary-favorite-close').addEventListener('click', close);
        const selected = getPrimaryFavorite();
        const list = modal.querySelector('.primary-favorite-list');
        favorites.forEach(name => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sell-confirm-btn';
            button.style.cssText = 'display:flex;justify-content:space-between;background:#14222d;color:#e2e8f0;border:1px solid #273f52;';
            button.innerHTML = `<span>${escapeHTML(name)}</span><span>${name === selected ? 'Principal ✓' : 'Selecionar'}</span>`;
            button.addEventListener('click', () => {
                localStorage.setItem(STORAGE_PRIMARY_FAVORITE, name);
                close();
                updateNavButtonAppearance();
                if (teleportAfterSelection) teleportToTarget(name);
            });
            list.appendChild(button);
        });
    }

    const CITY_NAMES = /\b(?:cerulean(?: city)?|pewter(?: city)?|lavender(?: town)?|viridian(?: city)?|cassino|casino)\b/i;
    function isCityName(name) { return CITY_NAMES.test(String(name || '').replace(/\[[^\]]*]/g, ' ').trim()); }
    function isCityMarker(marker, name) {
        const metadata = `${marker?.className || ''} ${marker?.dataset?.type || ''} ${marker?.dataset?.tag || ''} ${marker?.dataset?.category || ''}`;
        return isCityName(name) || /\b(?:city|cidade|town)\b/i.test(metadata);
    }
    function getCityDisplayName(name) {
        if (/pewter|lavender/i.test(name)) return 'Lavender (Pewter)';
        if (/viridian/i.test(name)) return 'Viridian';
        if (/cassino|casino/i.test(name)) return 'Cassino';
        return 'Cerulean';
    }
    function getCityIconStyle(name) {
        const badge = /cerulean/i.test(name) ? '💧' : /pewter|lavender/i.test(name) ? '🪨' : /viridian/i.test(name) ? '🌿' : '🎰';
        return `--city-badge:"${badge}";width:38px;height:38px;`;
    }
    const cityNpcSpriteCache = new Map();
    function loadCityNpcSpriteData(looktype = 1309) {
        const numericLooktype = Number(looktype) || 1309;
        if (cityNpcSpriteCache.has(numericLooktype)) return cityNpcSpriteCache.get(numericLooktype);
        const request = fetch('/game/asset-packs/outfits-index.json?v=2', { credentials: 'same-origin' })
            .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
            .then(index => {
                const outfit = index?.outfits?.[String(numericLooktype)];
                if (!outfit?.manifest) throw new Error(`Outfit ${numericLooktype} no disponible`);
                const manifestUrl = String(outfit.manifest).replace(/^\/assets-packs/, '/game/asset-packs');
                return fetch(manifestUrl, { credentials: 'same-origin' }).then(response =>
                    response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))
                );
            })
            .then(manifest => {
                const category = Object.values(manifest?.categories || {})[0];
                const page = category?.pages?.[0];
                const asset = Object.entries(manifest?.assets || {}).find(([key]) => /\/1_1_1_1\.png$/i.test(key))
                    || Object.entries(manifest?.assets || {}).find(([key]) => !/_template\.png$/i.test(key));
                const frame = asset?.[1]?.frames?.[0];
                if (!page?.image || !frame) throw new Error('Sprite NPC incompleto');
                return {
                    image: String(page.image).replace(/^\/assets-packs/, '/game/asset-packs'),
                    x: Number(frame.x) || 0, y: Number(frame.y) || 0,
                    width: Number(frame.w) || Number(asset[1].width) || 64,
                    height: Number(frame.h) || Number(asset[1].height) || 64
                };
            });
        cityNpcSpriteCache.set(numericLooktype, request);
        return request;
    }
    function mountCityNpcSprite(container, looktype = 1309) {
        const fallback = document.createElement('span');
        fallback.className = 'script-city-npc-fallback';
        fallback.textContent = '🧭';
        container.appendChild(fallback);
        loadCityNpcSpriteData(looktype).then(sprite => {
            if (!container.isConnected) return;
            const npc = document.createElement('div');
            npc.className = 'script-city-npc-sprite';
            npc.style.cssText = `width:${sprite.width}px;height:${sprite.height}px;background-image:url("${sprite.image}");background-position:-${sprite.x}px -${sprite.y}px;`;
            container.replaceChildren(npc);
        }).catch(error => console.warn('No se pudo cargar el sprite oficial del NPC de ciudad.', error));
    }
    function saveLastHunt(huntName) {
        if (huntName && huntName !== 'Sem Nome' && !isCityName(huntName)) localStorage.setItem(STORAGE_LAST_HUNT, huntName);
    }
    function getLastHunt() { return localStorage.getItem(STORAGE_LAST_HUNT) || null; }

    function getCurrentHuntNameForReconnect() {
        const currentMarkerName = document.querySelector('.hunt-marker.here .hunt-name')?.textContent?.trim();
        return currentMarkerName || getLastHunt();
    }

    async function teleportToCeruleanForReconnect() {
        await loadMapMarkersData();
        const waitForHuntExit = async () => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                if (!document.querySelector('[data-guide="capture-bar"]')) return true;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return !document.querySelector('[data-guide="capture-bar"]');
        };
        const mapButton = document.querySelector('button[data-guide="dock-map"]');
        let mapWindow = document.querySelector('.map-window');
        if (!mapWindow?.getClientRects().length) {
            mapButton?.click();
            mapWindow = await waitForElement('.map-window', 1500);
        }
        if (!mapWindow) return false;

        const directMarker = Array.from(mapWindow.querySelectorAll('[data-guide]')).find(element =>
            /cerulean/i.test(element.dataset.guide || '')
        );
        const labeledMarker = Array.from(mapWindow.querySelectorAll('button, [role="button"], .map-city, .map-marker, .hunt-marker')).find(element =>
            /^(?:cerulean|cerulean city)$/i.test(element.textContent.trim())
        );
        const mappedEntry = Array.from(globalHuntMarkerData.entries()).find(([key, marker]) =>
            /cerulean/i.test(key) || /cerulean/i.test(getMarkerName(marker)) || /cerulean/i.test(getMarkerSlug(marker))
        );

        const target = directMarker || labeledMarker;
        if (target) {
            target.click();
            if (await waitForHuntExit()) return true;
        }
        if (mappedEntry) {
            await teleportToTarget(getMarkerName(mappedEntry[1]) || mappedEntry[0]);
            return waitForHuntExit();
        }
        return false;
    }

    function getActivePokemonName() {
        const nameEl = document.querySelector('.phud-name');
        if (cachedLeaderPokemonName) return cachedLeaderPokemonName;
        const text = normalizePokemonName(nameEl?.textContent || '');
        return Object.keys(POKEMON_TYPES).sort((a, b) => b.length - a.length).find(name => text.includes(name)) || text;
    }

    function findMappedHunt(huntName) {
        return globalHuntMarkerData.get(getCleanHuntName(huntName)) || null;
    }

    function clickMappedHunt(huntName) {
        const mappedHunt = findMappedHunt(huntName);
        const slug = getMarkerSlug(mappedHunt);
        if (!slug) return false;

        const guide = `hunt-${slug}`;
        const marker = Array.from(document.querySelectorAll('[data-guide]'))
            .find(element => element.dataset.guide === guide);
        if (!marker) return false;

        marker.click();
        return true;
    }

    async function teleportToTarget(huntName) {
        hideDropTooltip();
        if (!huntName) {
            showScriptNotice('Nenhuma hunt definida.');
            return;
        }

        await loadMapMarkersData();

        const mapBtn = document.querySelector('button[data-guide="dock-map"]');
        let mapWindow = document.querySelector('.map-window');

        const mapIsVisible = mapWindow && getComputedStyle(mapWindow).display !== 'none';
        if (!mapIsVisible) {
            if (mapBtn) mapBtn.click();
            mapWindow = await waitForElement('.map-window', 1200);
        }

        mapWindow = mapWindow || document.querySelector('.map-window');
        if (!mapWindow) {
            showScriptNotice('O mapa não abriu.', { isError: true });
            return;
        }

        // Caminho direto confirmado pelo mapa da API: [data-guide="hunt-<slug>"].
        if (clickMappedHunt(huntName)) return;

        // Compatibilidade com versões do jogo nas quais o marcador da área ainda
        // não foi montado no DOM.
        let allTabs = Array.from(mapWindow.querySelectorAll('.map-area:not(.locked)'));
        if (allTabs.length === 0) {
            const found = await tryFindMarkerAsync(huntName, 20, 100);
            if (!found) showScriptNotice(`Hunt "${huntName}" não foi localizada.`, { isError: true });
            return;
        }

        const activeTab = mapWindow.querySelector('.map-area.on');
        if (activeTab) {
            const found = await tryFindMarkerAsync(huntName, 10, 100);
            if (found) return;
        }

        for (const tab of allTabs) {
            if (tab === activeTab) continue;

            tab.click();
            const found = await tryFindMarkerAsync(huntName, 20, 100);
            if (found) return;
        }

        showScriptNotice(`Hunt "${huntName}" não foi localizada em nenhuma área.`, { isError: true });
    }

    function waitForElement(selector, timeoutMs) {
        const existing = document.querySelector(selector);
        if (existing) return Promise.resolve(existing);
        return new Promise(resolve => {
            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);
                if (!element) return;
                observer.disconnect();
                clearTimeout(timeout);
                resolve(element);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            const timeout = setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeoutMs);
        });
    }

    function tryFindMarkerAsync(huntName, maxAttempts, intervalMs) {
        return new Promise(resolve => {
            let attempts = 0;
            const interval = setInterval(() => {
                if (clickMappedHunt(huntName)) {
                    clearInterval(interval);
                    resolve(true);
                    return;
                }

                const markers = Array.from(document.querySelectorAll('.hunt-marker'));
                const targetMarker = markers.find(m => {
                    const nameEl = m.querySelector('.hunt-name');
                    return nameEl && nameEl.textContent.trim().toLowerCase() === huntName.toLowerCase();
                });

                if (targetMarker) {
                    clearInterval(interval);
                    targetMarker.click();
                    resolve(true);
                } else {
                    attempts++;
                    if (attempts >= maxAttempts) {
                        clearInterval(interval);
                        resolve(false);
                    }
                }
            }, intervalMs);
        });
    }

    function teleportToFavorite() {
        const favs = getFavorites();
        if (favs.length === 0) return showScriptNotice('Você não possui nenhuma hunt favorita.');
        if (favs.length === 1) {
            localStorage.setItem(STORAGE_PRIMARY_FAVORITE, favs[0]);
            return teleportToTarget(favs[0]);
        }
        const primary = getPrimaryFavorite();
        if (!primary) return showPrimaryFavoriteSelector();
        teleportToTarget(primary);
    }

    function teleportToLastHunt() {
        const last = getLastHunt();
        if (!last) return showScriptNotice('Nenhuma última hunt registrada ainda.');
        teleportToTarget(last);
    }

    function handleNavQuickTP() {
        const mode = getNavTpMode();
        if (mode === 'last') teleportToLastHunt();
    }

    function updateNavButtonAppearance() {
        const tpBtn = document.getElementById('dock-btn-quick-tp');
        if (!tpBtn) return;
        const mode = getNavTpMode();
        tpBtn.hidden = mode === 'off';
        if (mode === 'off') return;
        tpBtn.innerHTML = '↺';
        tpBtn.title = 'Teleportar para Última Hunt';
    }

    function injectQuickTPButton() {
        const gameDock = document.querySelector('nav.game-dock');
        if (gameDock) {
            const mapBtn = gameDock.querySelector('button[data-guide="dock-map"]');
            let tpBtn = document.getElementById('dock-btn-quick-tp');
            if (!tpBtn) {
                tpBtn = document.createElement('button');
                tpBtn.id = 'dock-btn-quick-tp';
                tpBtn.className = 'dock-btn';
                tpBtn.type = 'button';
                tpBtn.addEventListener('click', handleNavQuickTP);
                if (mapBtn && mapBtn.nextSibling) gameDock.insertBefore(tpBtn, mapBtn.nextSibling);
                else gameDock.appendChild(tpBtn);
            }
            updateNavButtonAppearance();

            if (!document.getElementById('dock-btn-shops')) {
                const shopWrap = document.createElement('span');
                shopWrap.className = 'dock-poke-wrap script-shop-wrap';
                const shopsButton = document.createElement('button');
                shopsButton.id = 'dock-btn-shops';
                shopsButton.className = 'dock-btn';
                shopsButton.type = 'button';
                shopsButton.textContent = '🏪';
                shopsButton.title = tr('shops');

                const menu = document.createElement('div');
                menu.className = 'poke-menu script-shop-menu';
                menu.setAttribute('role', 'menu');
                menu.hidden = true;
                const positionShopMenu = () => {
                    if (menu.hidden) return;
                    const phoneMode = window.matchMedia('(max-width: 720px)').matches;
                    if (!phoneMode) {
                        if (menu.parentElement !== shopWrap) shopWrap.appendChild(menu);
                        menu.style.removeProperty('position');
                        menu.style.removeProperty('left');
                        menu.style.removeProperty('right');
                        menu.style.removeProperty('top');
                        menu.style.removeProperty('bottom');
                        menu.style.removeProperty('width');
                        menu.style.removeProperty('max-height');
                        menu.style.removeProperty('z-index');
                        return;
                    }
                    if (menu.parentElement !== document.body) document.body.appendChild(menu);
                    const rect = shopsButton.getBoundingClientRect();
                    const margin = 6;
                    const width = Math.min(260, Math.max(180, window.innerWidth - margin * 2));
                    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, rect.left + rect.width / 2 - width / 2));
                    const spaceAbove = Math.max(0, rect.top - margin * 2);
                    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - margin * 2);
                    const desiredHeight = Math.min(360, Math.max(120, menu.scrollHeight));
                    const openBelow = spaceBelow >= desiredHeight || spaceBelow >= spaceAbove;
                    menu.style.position = 'fixed';
                    menu.style.left = `${left}px`;
                    menu.style.right = 'auto';
                    menu.style.width = `${width}px`;
                    menu.style.zIndex = '2147483646';
                    menu.style.maxHeight = `${Math.max(90, (openBelow ? spaceBelow : spaceAbove) - margin)}px`;
                    if (openBelow) {
                        menu.style.top = `${Math.min(window.innerHeight - margin, rect.bottom + margin)}px`;
                        menu.style.bottom = 'auto';
                    } else {
                        menu.style.top = 'auto';
                        menu.style.bottom = `${Math.min(window.innerHeight - margin, window.innerHeight - rect.top + margin)}px`;
                    }
                };
                const rebuildMenu = () => {
                    menu.innerHTML = '';
                    const addItem = (label, handler) => {
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = 'poke-menu-item';
                        item.setAttribute('role', 'menuitem');
                        item.textContent = label;
                        item.addEventListener('click', event => {
                            event.stopPropagation();
                            menu.hidden = true;
                            handler();
                        });
                        menu.appendChild(item);
                    };
                    addItem(`🌐 ${tr('globalMarket')}`, showGlobalMarketWindow);
                    addItem(`🔴 ${tr('ballShop')}`, showPortableBallShop);
                    addItem(`💰 ${tr('sellItems')}`, showHuntSellWindow);
                };
                shopsButton.addEventListener('click', event => {
                    event.stopPropagation();
                    const willOpen = menu.hidden;
                    document.querySelectorAll('.script-shop-menu').forEach(other => { other.hidden = true; });
                    if (willOpen) {
                        rebuildMenu();
                        menu.hidden = false;
                        requestAnimationFrame(positionShopMenu);
                        return;
                    }
                    menu.hidden = !willOpen;
                });
                document.addEventListener('click', event => {
                    if (!shopWrap.contains(event.target) && !menu.contains(event.target)) menu.hidden = true;
                });
                window.addEventListener('resize', positionShopMenu, { passive: true });
                window.addEventListener('scroll', positionShopMenu, { passive: true });
                shopWrap.append(shopsButton, menu);
                tpBtn.after(shopWrap);
            }

            if (!document.getElementById('dock-btn-depot')) {
                const depotButton = document.createElement('button');
                depotButton.id = 'dock-btn-depot';
                depotButton.className = 'dock-btn';
                depotButton.type = 'button';
                depotButton.textContent = '📦';
                depotButton.title = 'Depot';
                depotButton.addEventListener('click', showPortableDepot);
                document.getElementById('dock-btn-shops')?.closest('.script-shop-wrap')?.after(depotButton);
            }
            updateMarketSaleDockBadge();
        }
    }

    let configDropdownCloseHandler = null;

    function injectConfigTab() {
        const cfgWindow = document.querySelector('.cfg-window');
        if (!cfgWindow || cfgWindow.querySelector('.cfg-tab-mods')) return;

        const cfgTabs = cfgWindow.querySelector('.cfg-tabs');
        const cfgBody = cfgWindow.querySelector('.cfg-body');
        if (!cfgTabs || !cfgBody) return;

        const modsTab = document.createElement('button');
        modsTab.className = 'cfg-tab cfg-tab-mods';
        modsTab.type = 'button';
        modsTab.textContent = tr('scriptMods');

        let originalContent = cfgBody.querySelector('.cfg-original-content');
        if (!originalContent) {
            originalContent = document.createElement('div');
            originalContent.className = 'cfg-original-content';
            while (cfgBody.firstChild) originalContent.appendChild(cfgBody.firstChild);
            cfgBody.appendChild(originalContent);
        }

        let modsContent = cfgBody.querySelector('.cfg-mods-content');
        if (!modsContent) {
            modsContent = document.createElement('div');
            modsContent.className = 'cfg-mods-content';
            modsContent.style.display = 'none';
            cfgBody.appendChild(modsContent);
        }
        modsContent.tabIndex = 0;
        modsContent.setAttribute('role', 'region');
        modsContent.setAttribute('aria-label', tr('modSettings'));

        cfgTabs.appendChild(modsTab);

        function updateModsUI() {
            const mapActive = isScriptMapActive();
            const chatActiveState = isChatActive();
            const dropMode = getDropMode();
            const navMode = getNavTpMode();
            const sellConfirmItems = getSellConfirmItems();

            modsContent.innerHTML = `
                <div class="script-mods-grid">
                    <div class="script-mods-title">
                        <div class="script-settings-brand"><span class="script-settings-logo">⚙️</span><span><b>${tr('modSettings')}</b><small>${tr('settingsSubtitle')}</small></span></div>
                        <label class="script-language-control"><span>${tr('language')}</span><select class="cfg-script-language"><option value="auto">${tr('automatic')}</option><option value="es">Español</option><option value="pt">Português</option><option value="en">English</option></select><small>${tr('languageDesc')}</small></label>
                    </div>

                    <div class="cfg-row script-mods-wide" style="background:#14222d;padding:10px;border-radius:6px;border:1px solid #1a2d3a;margin:0;">
                        <div class="cfg-label" style="margin-bottom:7px;">
                            <b style="color:#e2e8f0;font-size:14px;">${tr('gameFont')}</b>
                            <span style="color:#a0aec0;font-size:11px;">${tr('gameFontDesc')}</span>
                        </div>
                        <select class="cfg-game-font" style="width:100%;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:6px;padding:7px;">
                            <option value="barlow">${tr('originalFont')}</option>
                            <option value="verdana">Verdana</option>
                            <option value="arial">Arial</option>
                            <option value="system">${tr('systemFont')}</option>
                            <option value="cinzel">Cinzel</option>
                            <option value="custom">${tr('customFont')}</option>
                        </select>
                        <input class="cfg-custom-font" type="text" placeholder='${tr('fontExample')}' style="width:100%;margin-top:7px;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:6px;padding:7px;">
                        <div class="cfg-font-file-row">
                            <input class="cfg-custom-font-file" type="file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" hidden>
                            <button class="cfg-seg-btn cfg-choose-font-file" type="button">${tr('openFont')}</button>
                            <span class="cfg-font-file-name">${escapeHTML(localStorage.getItem(STORAGE_CUSTOM_FONT_NAME) || tr('noFile'))}</span>
                        </div>
                    </div>

                    <label class="cfg-row script-mods-wide" style="background:#14222d;padding:10px;border-radius:6px;border:1px solid #1a2d3a;margin:0;display:flex;align-items:center;gap:9px;">
                        <input class="cfg-auto-reconnect" type="checkbox">
                        <span class="cfg-label"><b style="color:#e2e8f0;font-size:14px;">${tr('autoReconnect')}</b><span style="color:#a0aec0;font-size:11px;">${tr('autoReconnectDesc')}</span></span>
                    </label>
                    ${[
                        ['cfg-unified-fonts', STORAGE_UNIFIED_FONTS, tr('unifiedFonts'), tr('unifiedFontsDesc')],
                        ['cfg-custom-scrollbars', STORAGE_CUSTOM_SCROLLBARS, tr('scrollbars'), tr('scrollbarsDesc')],
                        ['cfg-compare-window', STORAGE_COMPARE_WINDOW, tr('compareHunts'), tr('compareHuntsDesc')],
                        ['cfg-mark-quick-buy', STORAGE_MARK_QUICK_BUY, tr('quickMark'), tr('quickMarkDesc')],
                        ['cfg-mark-quality-picker', STORAGE_MARK_QUALITY_PICKER, tr('qualityPicker'), tr('qualityPickerDesc')]
                    ].map(([className, key, title, description]) => `
                        <label class="cfg-row" style="background:#14222d;padding:10px;border-radius:6px;border:1px solid #1a2d3a;margin:0;display:flex;align-items:center;gap:9px;">
                            <input class="${className}" data-pref-key="${key}" type="checkbox" ${preferenceEnabled(key) ? 'checked' : ''}>
                            <span class="cfg-label"><b style="color:#e2e8f0;font-size:14px;">${title}</b><span style="color:#a0aec0;font-size:11px;">${description}</span></span>
                        </label>`).join('')}
                    
                    <div class="cfg-row" style="background: #14222d; padding: 10px; border-radius: 6px; border: 1px solid #1a2d3a; margin: 0;">
                        <div class="cfg-label" style="margin-bottom: 6px;">
                            <b style="color: #e2e8f0; font-size: 14px;">${tr('simplifiedMap')}</b>
                            <span style="color: #a0aec0; font-size: 11px;">${tr('simplifiedMapDesc')}</span>
                        </div>
                        <div class="cfg-seg" style="display: flex; gap: 4px;">
                            <button class="cfg-seg-btn ${mapActive ? 'on' : ''} btn-map-on" type="button" style="flex:1;">${tr('enabled')}</button>
                            <button class="cfg-seg-btn ${!mapActive ? 'on' : ''} btn-map-off" type="button" style="flex:1;">${tr('disabled')}</button>
                        </div>
                    </div>

                    <div class="cfg-row ${!mapActive ? 'mod-disabled' : ''}" id="sub-map-feature-row" style="background: #14222d; padding: 10px; border-radius: 6px; border: 1px solid #1a2d3a; margin: 0;">
                        <div class="cfg-label" style="margin-bottom: 6px;">
                            <b style="color: #e2e8f0; font-size: 14px;">${tr('dropsPreview')}</b>
                            <span style="color: #a0aec0; font-size: 11px;">${tr('dropsPreviewDesc')}</span>
                        </div>
                        <div class="cfg-seg" style="display: flex; gap: 4px;">
                            <button class="cfg-seg-btn ${dropMode === 'hover' ? 'on' : ''} btn-drop-hover" type="button" style="flex:1;">Hover</button>
                            <button class="cfg-seg-btn ${dropMode === 'icon' ? 'on' : ''} btn-drop-icon" type="button" style="flex:1;">${tr('icon')}</button>
                            <button class="cfg-seg-btn ${dropMode === 'off' ? 'on' : ''} btn-drop-off" type="button" style="flex:1;">${tr('hidden')}</button>
                        </div>
                    </div>

                    <div class="cfg-row" style="background: #14222d; padding: 10px; border-radius: 6px; border: 1px solid #1a2d3a; margin: 0;">
                        <div class="cfg-label" style="margin-bottom: 6px;">
                            <b style="color: #e2e8f0; font-size: 14px;">${tr('navAction')}</b>
                            <span style="color: #a0aec0; font-size: 11px;">${tr('navActionDesc')}</span>
                        </div>
                        <div class="cfg-seg" style="display: flex; gap: 4px;">
                            <button class="cfg-seg-btn ${navMode === 'last' ? 'on' : ''} btn-nav-last" type="button" style="flex:1;">↺ ${tr('last')}</button>
                            <button class="cfg-seg-btn ${navMode === 'off' ? 'on' : ''} btn-nav-off" type="button" style="flex:1;">${tr('none')}</button>
                        </div>
                    </div>

                    <div class="cfg-row" style="background: #14222d; padding: 10px; border-radius: 6px; border: 1px solid #1a2d3a; margin: 0;">
                        <div class="cfg-label" style="margin-bottom: 6px;">
                            <b style="color: #e2e8f0; font-size: 14px;">${tr('chatInterface')}</b>
                            <span style="color: #a0aec0; font-size: 11px;">${tr('chatInterfaceDesc')}</span>
                        </div>
                        <div class="cfg-seg" style="display: flex; gap: 4px;">
                            <button class="cfg-seg-btn ${chatActiveState ? 'on' : ''} btn-chat-on" type="button" style="flex:1;">${tr('show')}</button>
                            <button class="cfg-seg-btn ${!chatActiveState ? 'on' : ''} btn-chat-off" type="button" style="flex:1;">${tr('hide')}</button>
                        </div>
                    </div>

                    <div class="cfg-row" style="background: #14222d; padding: 10px; border-radius: 6px; border: 1px solid #1a2d3a; margin: 0;">
                        <div class="cfg-label" style="margin-bottom: 6px;">
                            <b style="color: #e2e8f0; font-size: 14px;">Pokédex Fast Travel</b>
                            <span style="color: #a0aec0; font-size: 11px;">${tr('dexFastTravelDesc')}</span>
                        </div>
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 4px 0;">
                            <input type="checkbox" class="btn-dex-ft" ${isDexFastTravelActive() ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer; accent-color:#3182ce;">
                            <span style="color:#a0aec0; font-size:12px;">${tr('enableDexFastTravel')}</span>
                        </label>
                    </div>

                    <div class="cfg-row" style="background: #14222d; padding: 10px; border-radius: 6px; border: 1px solid #1a2d3a; margin: 0;">
                        <div class="cfg-label" style="margin-bottom: 6px;">
                            <b style="color: #e2e8f0; font-size: 14px;">${tr('selectAllGuards')}</b>
                            <span style="color: #a0aec0; font-size: 11px;">${tr('selectAllGuardsDesc')}</span>
                        </div>
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 4px 0;">
                            <input type="checkbox" class="btn-guard-leg" ${isGuardLegendaryActive() ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer; accent-color:#3182ce;">
                            <span style="color:#a0aec0; font-size:12px;">${tr('protectLegendary')}</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 4px 0;">
                            <input type="checkbox" class="btn-guard-lock" ${isGuardSellLockActive() ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer; accent-color:#3182ce;">
                            <span style="color:#a0aec0; font-size:12px;">${tr('protectLocked')}</span>
                        </label>
                    </div>

                    <div class="cfg-row script-mods-wide" style="background:#14222d;padding:10px;border-radius:6px;border:1px solid #1a2d3a;margin:0;">
                        <div class="cfg-label" style="margin-bottom:8px;">
                            <b style="color:#e2e8f0;font-size:14px;">${tr('huntFeatures')}</b>
                            <span style="color:#a0aec0;font-size:11px;">${tr('huntFeaturesDesc')}</span>
                        </div>
                        ${[
                            ['btn-hunt-market', isHuntMarketActive(), tr('marketHud'), tr('marketHudDesc')],
                            ['btn-hunt-bulk', isHuntBulkBuyActive(), tr('bulkBuy'), tr('bulkBuyDesc')],
                            ['btn-hunt-sell', isHuntSellActive(), tr('huntSell'), tr('huntSellDesc')],
                            ['btn-mark-enhancements', isMarkEnhancementsActive(), tr('cityMark'), tr('cityMarkDesc')]
                        ].map(([className, checked, title, description]) => `
                            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:5px 0;">
                                <input type="checkbox" class="${className}" ${checked ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;accent-color:#3182ce;">
                                <span><b style="display:block;color:#e2e8f0;font-size:12px;">${title}</b><small style="color:#a0aec0;">${description}</small></span>
                            </label>`).join('')}
                    </div>

                    <div class="cfg-row script-mods-wide script-window-scale-settings" style="background:#14222d;padding:10px;border-radius:6px;border:1px solid #1a2d3a;margin:0;">
                        <div class="script-window-scale-head">
                            <div><b>Tamaño de ventanas</b><span>100% conserva exactamente las dimensiones y el layout original de PC. Los demás tamaños usan dimensiones CSS nítidas; compacto y móvil se activan según la pantalla real.</span></div>
                            <button class="script-window-scale-reset" type="button">Restablecer 100%</button>
                        </div>
                        <div class="script-window-scale-grid">
                            ${SCRIPT_WINDOW_SCALE_AREAS.map(area => `
                                <label class="script-window-scale-row">
                                    <span><b>${escapeHTML(area.label)}</b><p>${escapeHTML(area.description)}</p></span>
                                    <span class="script-window-scale-control">
                                        <select data-window-scale-key="${area.key}" aria-label="Tamaño de ${escapeHTML(area.label)}">
                                            ${WINDOW_SCALE_OPTIONS.map(value => `<option value="${value}" ${normalizeWindowScale(scriptWindowScales[area.key]) === value ? 'selected' : ''}>${value}%</option>`).join('')}
                                        </select>
                                        <small class="script-window-scale-status" data-window-scale-status="${area.key}"></small>
                                    </span>
                                </label>`).join('')}
                        </div>
                    </div>

                    <div class="cfg-row script-mods-wide" style="background: #14222d; padding: 10px; border-radius: 6px; border: 1px solid #1a2d3a; margin: 0; display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap;">
                        <div class="cfg-label" style="flex:1;">
                            <b style="color: #e2e8f0; font-size: 14px;">${tr('sellConfirmation')}</b>
                            <span style="color: #a0aec0; font-size: 11px; display:block; margin-top:4px;">${tr('protectedItems')}</span>
                        </div>
                        
                        <div id="cfg-sell-selected-list" style="flex:1; display:flex; flex-direction:column; gap:4px; max-height:120px; overflow-y:auto; padding-right:4px;">
                        </div>
                        
                        <div style="flex:1; position:relative; min-width:180px;">
                            <button type="button" id="cfg-sell-dd-btn" style="width:100%; text-align:left; background:#0c161f; color:#e2e8f0; border:1px solid #273f52; padding:6px 10px; border-radius:4px; cursor:pointer;">${tr('selectItems')}</button>
                            <div id="cfg-sell-dropdown-menu" style="display:none; position:absolute; top:100%; right:0; width:100%; background:#14222d; border:1px solid #273f52; border-radius:4px; z-index:10; box-shadow:0 4px 6px rgba(0,0,0,0.3); margin-top:4px; padding:6px; box-sizing:border-box;">
                                <input type="text" id="cfg-sell-search" placeholder="${tr('search')}" style="width:100%; box-sizing:border-box; background:#0c161f; color:#e2e8f0; border:1px solid #273f52; border-radius:4px; padding:6px; outline:none; margin-bottom:6px;">
                                <div id="cfg-sell-dropdown" style="max-height:150px; overflow-y:auto;">
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            const modsGrid = modsContent.querySelector('.script-mods-grid');
            const assignedRows = new Set();
            const addCategory = (icon, title, selectors) => {
                const rows = selectors.flatMap(selector => Array.from(modsGrid.querySelectorAll(selector)).map(element => element.closest('.cfg-row')))
                    .filter(row => row && !assignedRows.has(row));
                if (!rows.length) return;
                const section = document.createElement('section');
                section.className = 'script-mod-category';
                section.innerHTML = `<h3><span>${icon}</span>${title}</h3><div class="script-mod-category-grid"></div>`;
                const sectionGrid = section.querySelector('.script-mod-category-grid');
                rows.forEach(row => { assignedRows.add(row); sectionGrid.appendChild(row); });
                modsGrid.appendChild(section);
            };
            addCategory('↔️', 'Tamaño de ventanas', ['.script-window-scale-settings']);
            addCategory('🎨', tr('appearance'), ['.cfg-game-font', '.cfg-unified-fonts', '.cfg-custom-scrollbars']);
            addCategory('🗺️', tr('mapNavigation'), ['.btn-map-on', '#sub-map-feature-row', '.btn-nav-last', '.btn-dex-ft']);
            addCategory('🪟', tr('interface'), ['.btn-chat-on']);
            addCategory('⚔️', tr('huntsShops'), ['.cfg-auto-reconnect', '.cfg-compare-window', '.cfg-mark-quick-buy', '.cfg-mark-quality-picker', '.btn-hunt-market']);
            addCategory('🛡️', tr('protectionsSales'), ['.btn-guard-leg', '#cfg-sell-dd-btn']);
            const remaining = Array.from(modsGrid.children).filter(element => element.classList.contains('cfg-row'));
            if (remaining.length) {
                const section = document.createElement('section');
                section.className = 'script-mod-category';
                section.innerHTML = `<h3><span>⚙️</span>${tr('otherFeatures')}</h3><div class="script-mod-category-grid"></div>`;
                remaining.forEach(row => section.querySelector('.script-mod-category-grid').appendChild(row));
                modsGrid.appendChild(section);
            }

            const languageSelect = modsContent.querySelector('.cfg-script-language');
            languageSelect.value = localStorage.getItem('script_language_v1') || 'auto';
            languageSelect.addEventListener('change', event => {
                if (event.target.value === 'auto') localStorage.removeItem('script_language_v1');
                else localStorage.setItem('script_language_v1', event.target.value);
                modsTab.textContent = tr('scriptMods');
                updateModsUI();
            });

            modsContent.querySelector('.cfg-game-font').value = getGameFont();
            modsContent.querySelector('.cfg-game-font').addEventListener('change', event => applyGameFont(event.target.value));
            modsContent.querySelector('.cfg-custom-font').value = getCustomFont();
            modsContent.querySelector('.cfg-custom-font').addEventListener('input', event => {
                localStorage.setItem(STORAGE_CUSTOM_FONT, event.target.value.replace(/[;{}]/g, ''));
                if (modsContent.querySelector('.cfg-game-font').value === 'custom') applyGameFont('custom');
            });
            const customFontFile = modsContent.querySelector('.cfg-custom-font-file');
            modsContent.querySelector('.cfg-choose-font-file').addEventListener('click', () => customFontFile.click());
            customFontFile.addEventListener('change', async () => {
                const file = customFontFile.files?.[0];
                if (!file) return;
                const extension = file.name.split('.').pop()?.toLowerCase();
                if (!['woff', 'woff2', 'ttf', 'otf'].includes(extension)) {
                    showScriptNotice('Escolha um arquivo .woff, .woff2, .ttf ou .otf.', { title: 'Fonte inválida', isError: true });
                    return;
                }
                try {
                    const buffer = await file.arrayBuffer();
                    const face = new FontFace(CUSTOM_FONT_FAMILY, buffer);
                    await face.load();
                    document.fonts.add(face);
                    await storeCustomFontFile(buffer);
                    localStorage.setItem(STORAGE_CUSTOM_FONT, `"${CUSTOM_FONT_FAMILY}", sans-serif`);
                    localStorage.setItem(STORAGE_CUSTOM_FONT_NAME, file.name);
                    modsContent.querySelector('.cfg-custom-font').value = `"${CUSTOM_FONT_FAMILY}", sans-serif`;
                    modsContent.querySelector('.cfg-game-font').value = 'custom';
                    modsContent.querySelector('.cfg-font-file-name').textContent = file.name;
                    applyGameFont('custom');
                    showScriptNotice(`Fonte “${file.name}” aplicada e salva.`, { title: 'Fonte personalizada' });
                } catch (error) {
                    showScriptNotice(`Não foi possível carregar a fonte: ${error.message}`, { title: 'Erro na fonte', isError: true });
                }
            });
            modsContent.querySelector('.cfg-auto-reconnect').checked = isAutoReconnectActive();
            modsContent.querySelector('.cfg-auto-reconnect').addEventListener('change', event => {
                localStorage.setItem(STORAGE_AUTO_RECONNECT, String(event.target.checked));
                if (event.target.checked) {
                    lastHuntSocketActivityAt = Date.now();
                    lastCaptureBarSignature = document.querySelector('[data-guide="capture-bar"]')?.innerHTML || '';
                }
            });
            modsContent.querySelectorAll('[data-pref-key]').forEach(control => control.addEventListener('change', event => {
                localStorage.setItem(event.target.dataset.prefKey, String(event.target.checked));
                applyVisualPreferences();
                if (event.target.dataset.prefKey === STORAGE_COMPARE_WINDOW) {
                    document.querySelector('.ha-script-actions')?.remove();
                    trackHuntAnalyzer();
                    if (!event.target.checked) document.querySelector('.ha-compare-backdrop')?.remove();
                }
                const mkWindow = findNativeMarkWindow();
                if (mkWindow) {
                    if (!preferenceEnabled(STORAGE_MARK_QUICK_BUY)) {
                        mkWindow.querySelectorAll('.script-mark-row-buy').forEach(node => node.remove());
                        mkWindow.querySelectorAll('button.mk-buy').forEach(button => button.style.removeProperty('display'));
                        mkWindow.querySelector('.mk-qtybar')?.style.removeProperty('display');
                    }
                    if (!preferenceEnabled(STORAGE_MARK_QUALITY_PICKER)) {
                        mkWindow.querySelector('.script-quality-multiselect')?.remove();
                        mkWindow.querySelector('.script-quality-dropdown')?.remove();
                        markQualityMenuOpen = false;
                        mkWindow.querySelectorAll('[data-script-quality-native]').forEach(button => {
                            button.style.removeProperty('display');
                            delete button.dataset.scriptQualityNative;
                        });
                    }
                    injectShopEnhancements();
                }
            }));

            modsContent.querySelectorAll('[data-window-scale-key]').forEach(select => select.addEventListener('change', event => {
                scriptWindowScales[event.target.dataset.windowScaleKey] = normalizeWindowScale(event.target.value);
                saveWindowScalePreferences();
                applyBetterWindowScales();
            }));
            modsContent.querySelector('.script-window-scale-reset')?.addEventListener('click', () => {
                scriptWindowScales = { ...DEFAULT_WINDOW_SCALES };
                saveWindowScalePreferences();
                modsContent.querySelectorAll('[data-window-scale-key]').forEach(select => { select.value = '100'; });
                applyBetterWindowScales();
            });
            applyBetterWindowScales();


            modsContent.querySelector('.btn-drop-hover').addEventListener('click', () => { setDropMode('hover'); updateModsUI(); });
            modsContent.querySelector('.btn-drop-icon').addEventListener('click', () => { setDropMode('icon'); updateModsUI(); });
            modsContent.querySelector('.btn-drop-off').addEventListener('click', () => { setDropMode('off'); updateModsUI(); });

            modsContent.querySelector('.btn-map-on').addEventListener('click', () => {
                setScriptMapActive(true);
                document.getElementById('sub-map-feature-row').classList.remove('mod-disabled');
                updateModsUI();
            });
            modsContent.querySelector('.btn-map-off').addEventListener('click', () => {
                setScriptMapActive(false);
                document.getElementById('sub-map-feature-row').classList.add('mod-disabled');
                updateModsUI();
            });

            modsContent.querySelector('.btn-chat-on').addEventListener('click', () => { setChatActive(true); updateModsUI(); });
            modsContent.querySelector('.btn-chat-off').addEventListener('click', () => { setChatActive(false); updateModsUI(); });

            modsContent.querySelector('.btn-nav-last').addEventListener('click', () => { setNavTpMode('last'); updateModsUI(); });
            modsContent.querySelector('.btn-nav-off').addEventListener('click', () => { setNavTpMode('off'); updateModsUI(); });

            modsContent.querySelector('.btn-dex-ft').addEventListener('change', (e) => {
                setDexFastTravel(e.target.checked);
            });
            
            modsContent.querySelector('.btn-guard-leg').addEventListener('change', (e) => {
                setGuardLegendary(e.target.checked);
            });
            modsContent.querySelector('.btn-guard-lock').addEventListener('change', (e) => {
                setGuardSellLock(e.target.checked);
            });
            modsContent.querySelector('.btn-hunt-market').addEventListener('change', e => {
                setHuntMarketActive(e.target.checked);
                injectHuntShopLauncher();
                if (!e.target.checked) document.querySelector('.script-market-backdrop')?.remove();
            });
            modsContent.querySelector('.btn-hunt-bulk').addEventListener('change', e => {
                setHuntBulkBuyActive(e.target.checked);
                const ballWindow = document.querySelector('.ball-window');
                if (ballWindow) injectHuntBallEnhancements(ballWindow);
            });
            modsContent.querySelector('.btn-hunt-sell').addEventListener('change', e => {
                setHuntSellActive(e.target.checked);
                injectHuntShopLauncher();
                const ballWindow = document.querySelector('.ball-window');
                if (ballWindow) injectHuntBallEnhancements(ballWindow);
            });
            modsContent.querySelector('.btn-mark-enhancements').addEventListener('change', e => setMarkEnhancementsActive(e.target.checked));

            const selectedListEl = modsContent.querySelector('#cfg-sell-selected-list');
            const ddBtn = modsContent.querySelector('#cfg-sell-dd-btn');
            const ddMenu = modsContent.querySelector('#cfg-sell-dropdown-menu');
            const searchInputEl = modsContent.querySelector('#cfg-sell-search');
            const dropdownEl = modsContent.querySelector('#cfg-sell-dropdown');

            ddBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ddMenu.style.display = ddMenu.style.display === 'none' ? 'block' : 'none';
                if (ddMenu.style.display === 'block') {
                    renderDropdown();
                    searchInputEl.focus();
                }
            });

            if (configDropdownCloseHandler) {
                document.removeEventListener('click', configDropdownCloseHandler);
            }
            configDropdownCloseHandler = (e) => {
                if (!ddMenu.contains(e.target) && e.target !== ddBtn) {
                    ddMenu.style.display = 'none';
                }
            };
            document.addEventListener('click', configDropdownCloseHandler);

            let uniqueItems = null;

            function initUniqueItems() {
                if (uniqueItems) return;
                uniqueItems = [];
                const seenNames = new Set();
                for (const item of globalItemApiData.values()) {
                    const name = item.name || item.title;
                    if (name && !seenNames.has(name)) {
                        seenNames.add(name);
                        uniqueItems.push(item);
                    }
                }
                uniqueItems.sort((a, b) => (a.name || a.title).localeCompare(b.name || b.title));
            }

            function renderSelected() {
                const items = getSellConfirmItems();
                selectedListEl.innerHTML = '';
                if (items.length === 0) {
                    selectedListEl.innerHTML = `<span style="color:#718096; font-size:12px; margin:auto;">${tr('noProtected')}</span>`;
                } else {
                    items.forEach(itemName => {
                        const iconHTML = resolveItemIcon(itemName);
                        const tag = document.createElement('div');
                        tag.style = 'display:flex; justify-content:space-between; align-items:center; background:#1a2d3a; border:1px solid #2b4c66; padding:4px 8px; border-radius:4px; font-size:12px;';
                        
                        const leftDiv = document.createElement('div');
                        leftDiv.style = 'display:flex; align-items:center; gap:6px; color:#e2e8f0;';
                        leftDiv.innerHTML = `${iconHTML} <span>${itemName}</span>`;
                        
                        const rmBtn = document.createElement('span');
                        rmBtn.innerHTML = '×';
                        rmBtn.style = 'cursor:pointer; color:#f56565; font-weight:bold; font-size:14px;';
                        rmBtn.addEventListener('click', () => {
                            setSellConfirmItems(items.filter(i => i !== itemName));
                            renderSelected();
                            if (ddMenu.style.display === 'block') renderDropdown();
                        });
                        
                        tag.appendChild(leftDiv);
                        tag.appendChild(rmBtn);
                        selectedListEl.appendChild(tag);
                    });
                }
            }

            function renderDropdown() {
                initUniqueItems();
                const query = searchInputEl.value.toLowerCase().trim();
                const selectedItems = getSellConfirmItems();
                dropdownEl.innerHTML = '';
                
                const filtered = query ? uniqueItems.filter(item => (item.name || item.title).toLowerCase().includes(query)) : uniqueItems;
                const toShow = filtered.slice(0, 50);

                if (toShow.length === 0) {
                    dropdownEl.innerHTML = `<div style="padding:6px; color:#718096; font-size:12px; text-align:center;">${tr('noItemFound')}</div>`;
                    return;
                }
                
                toShow.forEach(item => {
                    const itemName = item.name || item.title;
                    const isChecked = selectedItems.includes(itemName);
                    const iconHTML = resolveItemIcon(itemName);
                    
                    const row = document.createElement('label');
                    row.style = 'display:flex; align-items:center; padding:6px 10px; cursor:pointer; border-bottom:1px solid #1a2d3a; font-size:13px;';
                    row.addEventListener('mouseenter', () => row.style.background = '#14222d');
                    row.addEventListener('mouseleave', () => row.style.background = 'transparent');
                    
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = isChecked;
                    cb.style.marginRight = '8px';
                    cb.addEventListener('change', () => {
                        let current = getSellConfirmItems();
                        if (cb.checked && !current.includes(itemName)) current.push(itemName);
                        else if (!cb.checked) current = current.filter(i => i !== itemName);
                        setSellConfirmItems(current);
                        renderSelected();
                    });
                    
                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = itemName;
                    nameSpan.style.color = '#e2e8f0';
                    
                    row.appendChild(cb);
                    row.insertAdjacentHTML('beforeend', iconHTML);
                    row.appendChild(nameSpan);
                    dropdownEl.appendChild(row);
                });
            }

            searchInputEl.addEventListener('input', renderDropdown);
            renderSelected();
        }

        const tabsList = Array.from(cfgTabs.querySelectorAll('.cfg-tab'));
        tabsList.forEach(tab => {
            tab.addEventListener('click', () => {
                tabsList.forEach(t => t.classList.remove('on'));
                tab.classList.add('on');
                if (tab.classList.contains('cfg-tab-mods')) {
                    cfgWindow.classList.add('script-mods-open');
                    originalContent.style.display = 'none';
                    modsContent.style.display = 'block';
                    updateModsUI();
                    requestAnimationFrame(() => modsContent.focus({ preventScroll:true }));
                } else {
                    cfgWindow.classList.remove('script-mods-open');
                    modsContent.style.display = 'none';
                    originalContent.style.display = 'block';
                }
            });
        });
    }

    function buildSimpleList() {
        if (!isScriptMapActive() || isRendering) return;
        isRendering = true;

        try {
            const mapWindow = document.querySelector('.map-window');
            const mapBody = document.querySelector('.map-body');

            if (!mapWindow || !mapBody) { isRendering = false; return; }
            if (mapWindow.classList.contains('invisible-check') || !mapWindow.getClientRects().length) {
                mapWindow.dataset.scriptMapWasOpen = 'false';
                isRendering = false;
                return;
            }
            const openedNow = mapWindow.dataset.scriptMapWasOpen !== 'true';
            mapWindow.dataset.scriptMapWasOpen = 'true';
            simplifyNativeMapControls(mapWindow);

            let viewTabs = document.getElementById('script-map-view-tabs');
            if (!viewTabs) {
                viewTabs = document.createElement('div');
                viewTabs.id = 'script-map-view-tabs';
                viewTabs.style = 'display:contents;';
                viewTabs.innerHTML = `<button type="button" data-view="cities" class="map-area script-city-area">🏙️ ${tr('mapCities')}</button>`;
                viewTabs.addEventListener('click', event => {
                    const button = event.target.closest('[data-view]');
                    if (!button) return;
                    mapWindow.dataset.scriptMapView = button.dataset.view;
                    lastMapRenderSignature = '';
                    buildSimpleList();
                });
                const nativeAreas = mapWindow.querySelectorAll('.map-area');
                const nativeAreaParent = nativeAreas[0]?.parentElement;
                (nativeAreaParent || mapBody).appendChild(viewTabs);
                nativeAreas.forEach(area => area.addEventListener('click', () => {
                    mapWindow.dataset.scriptMapView = 'hunts';
                    lastMapRenderSignature = '';
                    buildSimpleList();
                }));
            }
            const viewMode = mapWindow.dataset.scriptMapView || 'hunts';
            viewTabs.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('on', button.dataset.view === viewMode));

            let customFilterBar = document.getElementById('custom-hunts-filter-bar');
            if (!customFilterBar) {
                const savedFilters = getMapFilters();
                customFilterBar = document.createElement('div');
                customFilterBar.id = 'custom-hunts-filter-bar';
                const filtersCollapsed = localStorage.getItem('script_map_filters_collapsed_v1') === 'true';
                customFilterBar.classList.toggle('collapsed', filtersCollapsed);
                customFilterBar.innerHTML = `
                    <div class="script-map-filter-head">
                        <div class="script-map-filter-title"><span>🗺️</span><div><b>${tr('mapFilters')}</b><small>${tr('mapFiltersDesc')}</small></div></div>
                        <div class="script-map-filter-head-actions"><span class="script-map-result-count"></span><button class="script-map-filter-toggle" type="button" aria-expanded="${filtersCollapsed ? 'false' : 'true'}">${filtersCollapsed ? `⌄ ${tr('mapShowFilters')}` : `⌃ ${tr('mapHideFilters')}`}</button></div>
                    </div>
                    <div class="script-map-filter-content">
                        <div class="script-map-filter-grid">
                            <label class="script-map-field"><span>⌕ ${tr('search')}</span><input id="script-map-search" type="search" placeholder="${tr('mapSearch')}"></label>
                            <label class="script-map-field"><span>↕ ${tr('mapOrder')}</span><select id="sort-hunts-select" title="${tr('mapOrder')}">
                                <option value="">${tr('recent')}</option><option value="price_desc">${tr('highestPrice')}</option><option value="price_asc">${tr('lowestPrice')}</option><option value="eff_desc">⚡ ${tr('mapAccess')}</option><option value="xp_desc">XP</option>
                            </select></label>
                            <label class="script-map-field"><span>◆ ${tr('mapType')}</span><select id="filter-hunts-type"><option value="">${tr('allTypes')}</option></select></label>
                            <label class="script-map-field"><span>◈ ${tr('mapLevel')}</span><span class="script-map-level-range">
                                <input id="filter-hunts-level-min" type="number" min="1" step="1" inputmode="numeric" placeholder="${tr('mapLevelMin')}" aria-label="${tr('mapLevel')} ${tr('mapLevelMin')}">
                                <input id="filter-hunts-level-max" type="number" min="1" step="1" inputmode="numeric" placeholder="${tr('mapLevelMax')}" aria-label="${tr('mapLevel')} ${tr('mapLevelMax')}">
                            </span></label>
                            <label class="script-map-field"><span>🔓 ${tr('mapAccess')}</span><select id="filter-hunts-access">
                                <option value="all">${tr('all')}</option><option value="accessible">✓ ${tr('mapOpenAccess')}</option><option value="favorites">★ ${tr('mapFavorites')}</option><option value="advantage">⚡ ${tr('mapAdvantage')}</option><option value="neutral">1x ${tr('mapNeutral')}</option><option value="disadvantage">↓ ${tr('mapDisadvantage')}</option><option value="locked">🔒 ${tr('mapLocked')}</option><option value="not_favorites">☆ ${tr('mapNotFavorites')}</option>
                            </select></label>
                            <div class="script-map-filter-actions"><button id="reset-hunts-filters" type="button">↺ ${tr('mapClear')}</button></div>
                        </div>
                    </div>
                `;
                mapBody.appendChild(customFilterBar);

                const sortSelect = customFilterBar.querySelector('#sort-hunts-select');
                const typeSelect = customFilterBar.querySelector('#filter-hunts-type');
                const accessSelect = customFilterBar.querySelector('#filter-hunts-access');
                const mapSearch = customFilterBar.querySelector('#script-map-search');
                const levelMinInput = customFilterBar.querySelector('#filter-hunts-level-min');
                const levelMaxInput = customFilterBar.querySelector('#filter-hunts-level-max');
                sortSelect.value = savedFilters.sort || '';
                accessSelect.value = savedFilters.access || 'all';
                levelMinInput.value = savedFilters.levelMin || '';
                levelMaxInput.value = savedFilters.levelMax || '';
                const scheduleMapRender = () => {
                    clearTimeout(mapSearchRenderTimer);
                    mapSearchRenderTimer = setTimeout(() => {
                        lastMapRenderSignature = '';
                        isRendering = false;
                        buildSimpleList();
                    }, 140);
                };
                mapSearch.addEventListener('input', scheduleMapRender);
                levelMinInput.addEventListener('input', scheduleMapRender);
                levelMaxInput.addEventListener('input', scheduleMapRender);
                customFilterBar.querySelector('.script-map-filter-toggle').addEventListener('click', event => {
                    const collapsed = !customFilterBar.classList.contains('collapsed');
                    customFilterBar.classList.toggle('collapsed', collapsed);
                    localStorage.setItem('script_map_filters_collapsed_v1', collapsed ? 'true' : 'false');
                    event.currentTarget.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                    event.currentTarget.textContent = collapsed ? `⌄ ${tr('mapShowFilters')}` : `⌃ ${tr('mapHideFilters')}`;
                });
                customFilterBar.querySelector('#reset-hunts-filters').addEventListener('click', () => {
                    sortSelect.value = '';
                    typeSelect.value = '';
                    accessSelect.value = 'all';
                    mapSearch.value = '';
                    levelMinInput.value = '';
                    levelMaxInput.value = '';
                    const capture = document.getElementById('custom-hunts-capture-bar');
                    if (capture) {
                        capture.dataset.active = '';
                        capture.querySelectorAll('.dex-fbtn').forEach(button => button.classList.remove('on'));
                    }
                    lastMapRenderSignature = '';
                    isRendering = false;
                    buildSimpleList();
                });
                customFilterBar.addEventListener('change', () => {
                    setMapFilters({ ...getMapFilters(), sort: sortSelect.value, type: typeSelect.value, access: accessSelect.value, levelMin: levelMinInput.value, levelMax: levelMaxInput.value });
                    lastMapRenderSignature = '';
                    isRendering = false;
                    buildSimpleList();
                });
            }

            let captureFilterBar = document.getElementById('custom-hunts-capture-bar');
            if (!captureFilterBar) {
                const savedFilters = getMapFilters();
                captureFilterBar = document.createElement('div');
                captureFilterBar.id = 'custom-hunts-capture-bar';
                captureFilterBar.className = 'dex-script-controls';
                captureFilterBar.style = 'margin-top: 4px; border-top: none; padding: 0;';
                captureFilterBar.innerHTML = `
                    <button class="dex-fbtn" data-captured="yes" type="button">✓ ${tr('mapCaptured')}</button>
                    <button class="dex-fbtn" data-captured="no" type="button">✗ ${tr('mapMissing')}</button>
                `;
                (customFilterBar.querySelector('.script-map-filter-content') || customFilterBar).appendChild(captureFilterBar);

                captureFilterBar.dataset.active = savedFilters.captured || '';
                captureFilterBar.querySelectorAll('.dex-fbtn').forEach(btn => {
                    btn.classList.toggle('on', btn.dataset.captured === captureFilterBar.dataset.active);
                });

                captureFilterBar.addEventListener('click', (e) => {
                    const btn = e.target.closest('.dex-fbtn');
                    if (!btn) return;
                    const clicked = btn.dataset.captured;
                    captureFilterBar.dataset.active = captureFilterBar.dataset.active === clicked ? '' : clicked;
                    captureFilterBar.querySelectorAll('.dex-fbtn').forEach(b => {
                        b.classList.toggle('on', b.dataset.captured === captureFilterBar.dataset.active);
                    });
                    setMapFilters({ ...getMapFilters(), captured: captureFilterBar.dataset.active });
                    lastMapRenderSignature = '';
                    isRendering = false;
                    buildSimpleList();
                });
            }
            customFilterBar.style.display = viewMode === 'cities' ? 'none' : 'block';
            captureFilterBar.style.display = viewMode === 'cities' ? 'none' : '';
            if (openedNow) {
                customFilterBar.querySelector('#sort-hunts-select').value = '';
                customFilterBar.querySelector('#filter-hunts-type').value = '';
                customFilterBar.querySelector('#filter-hunts-access').value = 'all';
                customFilterBar.querySelector('#script-map-search').value = '';
                customFilterBar.querySelector('#filter-hunts-level-min').value = '';
                customFilterBar.querySelector('#filter-hunts-level-max').value = '';
                captureFilterBar.dataset.active = '';
                captureFilterBar.querySelectorAll('.dex-fbtn').forEach(button => button.classList.remove('on'));
                loadCaughtPokedexData(true);
            }

            let simpleContainer = document.getElementById('simple-hunts-container');
            if (!simpleContainer) {
                simpleContainer = document.createElement('div');
                simpleContainer.id = 'simple-hunts-container';
                simpleContainer.style = `
                    width: 100%; max-height: 480px; overflow-y: auto; background: #0d161d;
                    border: 1px solid #1a2d3a; border-radius: 6px; padding: 12px;
                    box-sizing: border-box; font-family: sans-serif; margin-top: 6px;
                `;
                mapBody.appendChild(simpleContainer);
            }

            const searchInput = customFilterBar.querySelector('#script-map-search') || document.querySelector('.map-filter-q');
            const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

            const markers = Array.from(document.querySelectorAll('.hunt-marker'));
            const favorites = getFavorites();
            const activePkmn = getActivePokemonName();
            const activePkmnTypes = cachedLeaderPokemonTypes.length ? cachedLeaderPokemonTypes : (POKEMON_TYPES[activePkmn] || []);
            const domTrainerLevel = readTrainerLevelFromDOM();
            if (openedNow) {
                mapWindow.dataset.scriptLeaderRefreshedAt = String(Date.now());
                mapWindow.dataset.scriptLeaderRefresh = 'pending';
                refreshActivePokemonForMap().then(changed => {
                    delete mapWindow.dataset.scriptLeaderRefresh;
                    if (changed) {
                        lastMapRenderSignature = '';
                        buildSimpleList();
                    }
                }).catch(() => { delete mapWindow.dataset.scriptLeaderRefresh; });
            }
            if (openedNow) {
                mapWindow.dataset.scriptLevelRefreshedAt = String(Date.now());
                mapWindow.dataset.scriptLevelRefresh = 'pending';
                loadTrainerLevel(true).then(() => {
                    delete mapWindow.dataset.scriptLevelRefresh;
                    lastMapRenderSignature = '';
                    buildSimpleList();
                });
            }
            if (cachedTrainerLevel === null && domTrainerLevel === null) {
                simpleContainer.innerHTML = `<div style="color:#718096;text-align:center;padding:20px;">${tr('loading')}</div>`;
                loadTrainerLevel().then(() => {
                    lastMapRenderSignature = '';
                    buildSimpleList();
                });
                return;
            }
            if (domTrainerLevel) cachedTrainerLevel = domTrainerLevel;
            const trainerLevel = cachedTrainerLevel || domTrainerLevel;
            const accessibleOption = document.querySelector('#filter-hunts-access option[value="accessible"]');
            if (accessibleOption) accessibleOption.textContent = `✓ ${tr('mapOpenAccess')} (${tr('mapYourLevel')}: ${trainerLevel})`;

            let huntDataList = [];

            markers.forEach(marker => {
                const nameEl = marker.querySelector('.hunt-name');
                const lvlEl = marker.querySelector('.hunt-lvl');
                const iconDiv = marker.querySelector('.hunt-circle div[style*="background-image"]');

                const name = nameEl ? nameEl.textContent.trim() : 'Sem Nome';
                const lvlText = lvlEl ? lvlEl.textContent.trim() : 'Nv 1';
                const requiredLevel = parseInt(lvlText.replace(/\D/g, ''), 10) || 1;
                const city = isCityMarker(marker, name);
                const canAccess = city || trainerLevel >= requiredLevel;
                const isHere = marker.classList.contains('here');

                if (isHere && !city) saveLastHunt(name);

                const details = extractHuntDetailsFromJSON(name, marker);
                const mappedMarker = findMappedHunt(name);
                const defenderTypes = getDefenderTypes(name);
                const effectiveness = getOffensiveMultiplier(activePkmnTypes, defenderTypes);
                const xpEfficiency = (details.experience && effectiveness) ? details.experience / effectiveness : Infinity;
                const isCaught = isCaughtHunt(mappedMarker, name);

                huntDataList.push({
                    name, displayName: city ? getCityDisplayName(name) : name, city, lvlText, requiredLevel, canAccess, isHere, isCaught,
                    sellsFor: details.sellsFor,
                    numericPrice: details.numericPrice,
                    dropsHTML: details.dropsHTML,
                    experience: details.experience,
                    expText: details.expText,
                    effectiveness,
                    defenderTypes,
                    iconStyle: iconDiv ? (iconDiv.getAttribute('style') || '') : (city ? getCityIconStyle(name) : ''),
                    looktype: Number(mappedMarker?.looktype) || (city ? 1309 : 0),
                    area: String(mappedMarker?.area || marker.dataset?.area || 'kanto'),
                    originalElement: marker,
                    xpEfficiency
                });
            });

            // As regiões Orre/Outland desmontam os marcadores de Kanto; cidades vêm do catálogo global.
            for (const markerData of new Set(globalHuntMarkerData.values())) {
                const name = getMarkerName(markerData);
                if (!name || !isCityMarker(markerData, name)
                    || huntDataList.some(entry => getCleanHuntName(entry.name) === getCleanHuntName(name))) continue;
                huntDataList.push({
                    name, displayName: getCityDisplayName(name), city: true, lvlText: '', requiredLevel: 1,
                    canAccess: true, isHere: false, isCaught: false, sellsFor: 'Indisponível', numericPrice: 0,
                    dropsHTML: '', experience: 0, expText: '', effectiveness: 1, defenderTypes: [],
                    iconStyle: getCityIconStyle(name), looktype: Number(markerData.looktype) || 1309,
                    area: String(markerData.area || 'kanto'), originalElement: null, xpEfficiency: Infinity
                });
            }

            // Favoritos e última hunt podem pertencer a uma região que o jogo desmontou do DOM.
            [...new Set([...favorites, getLastHunt()].filter(Boolean))].forEach(name => {
                if (huntDataList.some(hunt => getCleanHuntName(hunt.name) === getCleanHuntName(name)) || isCityName(name)) return;
                const markerData = findMappedHunt(name);
                if (!markerData) return;
                const requiredLevel = Number(markerData.level ?? markerData.requiredLevel ?? markerData.minLevel ?? 1) || 1;
                const defenderTypes = getDefenderTypes(name);
                const effectiveness = getOffensiveMultiplier(activePkmnTypes, defenderTypes);
                const details = extractHuntDetailsFromJSON(name, null);
                huntDataList.push({
                    name, displayName: name, city: false, lvlText: `Nv ${requiredLevel}`, requiredLevel,
                    canAccess: trainerLevel >= requiredLevel, isHere: false,
                    isCaught: isCaughtHunt(markerData, name),
                    sellsFor: details.sellsFor, numericPrice: details.numericPrice, dropsHTML: details.dropsHTML,
                    experience: details.experience, expText: details.expText, effectiveness, defenderTypes,
                    iconStyle: '', looktype: Number(markerData.looktype) || 0, area: String(markerData.area || ''), originalElement: null,
                    xpEfficiency: details.experience && effectiveness ? details.experience / effectiveness : Infinity
                });
            });

            if (query) {
                huntDataList = huntDataList.filter(hunt =>
                    hunt.name.toLowerCase().includes(query) ||
                    String(hunt.dropsHTML || '').replace(/<[^>]+>/g, ' ').toLowerCase().includes(query)
                );
            }

            const levelMin = Math.max(0, Number(document.getElementById('filter-hunts-level-min')?.value) || 0);
            const levelMax = Math.max(0, Number(document.getElementById('filter-hunts-level-max')?.value) || 0);
            if (levelMin) huntDataList = huntDataList.filter(hunt => hunt.city || hunt.requiredLevel >= levelMin);
            if (levelMax) huntDataList = huntDataList.filter(hunt => hunt.city || hunt.requiredLevel <= levelMax);

            const typeSelect = document.getElementById('filter-hunts-type');
            const savedType = typeSelect?.value || getMapFilters().type || '';
            const availableTypes = [...new Set(
                huntDataList.filter(hunt => hunt.canAccess).flatMap(hunt => hunt.defenderTypes)
            )].sort();
            if (typeSelect) {
                typeSelect.replaceChildren(new Option('Todos os tipos', ''));
                availableTypes.forEach(type => typeSelect.add(new Option(type.toUpperCase(), type)));
                typeSelect.value = availableTypes.includes(savedType) ? savedType : '';
            }

            const selectedType = typeSelect?.value || '';
            const accessFilter = document.getElementById('filter-hunts-access')?.value || 'all';
            if (selectedType) {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.defenderTypes.includes(selectedType));
            }
            if (accessFilter === 'accessible') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess);
            } else if (accessFilter === 'favorites') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && favorites.includes(hunt.name));
            } else if (accessFilter === 'advantage') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.effectiveness > 1);
            } else if (accessFilter === 'neutral') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.effectiveness === 1);
            } else if (accessFilter === 'disadvantage') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.effectiveness < 1);
            } else if (accessFilter === 'locked') {
                huntDataList = huntDataList.filter(hunt => !hunt.canAccess);
            } else if (accessFilter === 'not_favorites') {
                huntDataList = huntDataList.filter(hunt => !favorites.includes(hunt.name));
            }

            const capturedFilter = document.getElementById('custom-hunts-capture-bar')?.dataset.active || '';
            if (capturedFilter === 'yes') {
                huntDataList = huntDataList.filter(hunt => hunt.city || hunt.isCaught);
            } else if (capturedFilter === 'no') {
                huntDataList = huntDataList.filter(hunt => hunt.city || !hunt.isCaught);
            }
            huntDataList = huntDataList.filter(hunt => viewMode === 'cities' ? hunt.city : !hunt.city);
            const resultCounter = customFilterBar.querySelector('.script-map-result-count');
            if (resultCounter) resultCounter.textContent = `${huntDataList.length} ${tr('mapResults')}`;

            const sortVal = document.getElementById('sort-hunts-select')?.value || '';
            huntDataList.sort((a, b) => {
                const aFav = favorites.includes(a.name);
                const bFav = favorites.includes(b.name);
                if (aFav && !bFav) return -1;
                if (!aFav && bFav) return 1;

                if (sortVal === 'price_desc') return b.numericPrice - a.numericPrice;
                if (sortVal === 'price_asc') return a.numericPrice - b.numericPrice;
                if (sortVal === 'eff_desc') {
                    if (b.effectiveness !== a.effectiveness) return b.effectiveness - a.effectiveness;
                    const lvlA = parseInt(a.lvlText.replace(/\D/g, '')) || 0;
                    const lvlB = parseInt(b.lvlText.replace(/\D/g, '')) || 0;
                    return lvlB - lvlA;
                }
                if (sortVal === 'xp_desc') {
                    if (b.experience !== a.experience) return b.experience - a.experience;
                    return b.effectiveness - a.effectiveness;
                }
                return a.name.localeCompare(b.name);
            });

            const lastHunt = getLastHunt();
            if (viewMode === 'hunts' && lastHunt) {
                const lastIndex = huntDataList.findIndex(hunt => getCleanHuntName(hunt.name) === getCleanHuntName(lastHunt));
                if (lastIndex > 0) huntDataList.unshift(huntDataList.splice(lastIndex, 1)[0]);
            }

            const renderSignature = JSON.stringify({
                query, sortVal, selectedType, levelMin, levelMax, accessFilter, capturedFilter, trainerLevel, favorites, viewMode, lastHunt,
                rows: huntDataList.map(hunt => [
                    hunt.name, hunt.lvlText, hunt.canAccess, hunt.isHere, hunt.isCaught,
                    hunt.numericPrice, hunt.experience, hunt.effectiveness
                ])
            });
            if (renderSignature === lastMapRenderSignature && simpleContainer.childElementCount) return;
            lastMapRenderSignature = renderSignature;
            simpleContainer.innerHTML = '';
            simpleContainer.className = `script-map-card-grid script-map-view-${viewMode}`;

            if (huntDataList.length === 0) {
                simpleContainer.innerHTML = `<div style="color: #718096; text-align: center; padding: 20px;">${tr('noListings')}</div>`;
                isRendering = false;
                return;
            }

            const dropMode = getDropMode();

            huntDataList.forEach(hunt => {
                const isFav = favorites.includes(hunt.name);
                const isLast = viewMode === 'hunts' && getCleanHuntName(hunt.name) === getCleanHuntName(lastHunt);
                const row = document.createElement('div');
                row.className = `script-map-card ${hunt.city ? 'is-city' : 'is-hunt'}${hunt.isHere ? ' is-here' : ''}${isFav ? ' is-favorite' : ''}${!hunt.canAccess ? ' is-locked' : ''}`;

                const spriteContainer = document.createElement('div');
                spriteContainer.className = 'script-map-card-art';

                if (hunt.city) {
                    mountCityNpcSprite(spriteContainer, hunt.looktype || 1309);
                } else if (hunt.iconStyle) {
                    const sprite = document.createElement('div');
                    sprite.style = hunt.iconStyle;
                    spriteContainer.appendChild(sprite);
                }

                const typeBadgesHTML = hunt.defenderTypes.map(t => 
                    `<span class="script-type-badge script-type-${t}" style="font-size:10px;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px;">${t}</span>`
                ).join(' ');

                const infoDiv = document.createElement('div');
                infoDiv.className = 'script-map-card-info';
                infoDiv.innerHTML = `
                    <span class="script-map-kind">${hunt.city ? tr('mapCity') : tr('mapHunt')}</span>
                    <div class="script-map-card-title">
                        ${hunt.city ? '' : `<span class="hunt-capture-badge${hunt.isCaught ? '' : ' not-caught'}" title="${hunt.isCaught ? 'Já capturado' : 'Ainda não capturado'}"></span>`}
                        ${isLast ? '<span style="color:#f6c453">◆</span>' : ''}<span>${escapeHTML(hunt.displayName)}</span>
                        ${hunt.city ? '' : `<span class="script-map-level">${hunt.lvlText}</span>`}
                    </div>
                    ${hunt.city ? `<div class="script-map-city-copy"><strong>✓ ${tr('mapOpenAccess')}</strong><br>${tr('mapTransport')} · ${escapeHTML(String(hunt.area || 'Kanto').toUpperCase())}</div>` : `<div class="script-map-badges">
                        ${hunt.city ? '' : `<span class="script-effectiveness ${hunt.effectiveness > 1 ? 'great' : hunt.effectiveness < 1 ? 'bad' : 'neutral'}">
                            ${hunt.effectiveness > 1 ? `⚡ ${hunt.effectiveness}x` : `${hunt.effectiveness}x`}
                        </span>`}
                        ${hunt.city ? '' : typeBadgesHTML}
                        ${hunt.isHere ? `<span style="font-size:9px;color:#6ee092;font-weight:900;">● ${tr('mapHere')}</span>` : ''}
                        ${!hunt.canAccess ? `<span style="font-size:9px;color:#ff8b8b;background:#3b2026;border:1px solid #71313c;padding:2px 6px;border-radius:4px;">🔒 ${tr('mapRequires')} ${hunt.requiredLevel}</span>` : ''}
                    </div>
                    <div class="script-map-meta">
                        ${hunt.sellsFor !== 'Indisponível' ? `<span>${tr('mapValue')} <strong class="map-value">${hunt.sellsFor}</strong></span>` : ''}
                        ${hunt.expText ? `<span>${tr('mapExperience')} <strong class="map-xp">${hunt.expText}</strong></span>` : ''}
                    </div>`}
                `;

                if (dropMode === 'hover' && hunt.dropsHTML) {
                    row.addEventListener('mouseenter', (e) => showDropTooltip(e, hunt.dropsHTML));
                    row.addEventListener('mouseleave', hideDropTooltip);
                }

                row.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    hideDropTooltip();
                    if (!hunt.canAccess) {
                        showScriptNotice(`Esta hunt exige nível ${hunt.requiredLevel}. Seu nível atual é ${trainerLevel}.`, {
                            title: 'Hunt bloqueada'
                        });
                        return;
                    }
                    saveLastHunt(hunt.name);
                    teleportToTarget(hunt.name);
                });

                const actionContainer = document.createElement('div');
                actionContainer.className = 'script-map-card-actions';
                actionContainer.style = 'display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;';

                if (dropMode === 'icon' && hunt.dropsHTML) {
                    const iconBtn = document.createElement('button');
                    iconBtn.type = 'button';
                    iconBtn.className = 'drop-icon-btn';
                    iconBtn.innerHTML = '?';
                    iconBtn.addEventListener('mouseenter', (e) => showDropTooltip(e, hunt.dropsHTML));
                    iconBtn.addEventListener('mouseleave', hideDropTooltip);
                    actionContainer.appendChild(iconBtn);
                }

                const favBtn = document.createElement('button');
                favBtn.type = 'button';
                favBtn.className = `script-map-fav${isFav ? ' on' : ''}`;
                favBtn.innerHTML = isFav ? '★' : '☆';
                favBtn.style = `
                    background: none; border: none; color: ${isFav ? '#f6c453' : '#4a5568'};
                    font-size: 20px; cursor: pointer; padding: 4px 8px; outline: none;
                `;
                favBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFavorite(hunt.name);
                });

                actionContainer.appendChild(favBtn);

                const travelBtn = document.createElement('button');
                travelBtn.type = 'button';
                travelBtn.className = 'script-map-travel';
                travelBtn.textContent = hunt.canAccess ? (hunt.city ? tr('mapTravel') : tr('mapGo')) : '🔒';
                travelBtn.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!hunt.canAccess) return;
                    saveLastHunt(hunt.name);
                    teleportToTarget(hunt.name);
                });
                actionContainer.appendChild(travelBtn);

                row.appendChild(spriteContainer);
                row.appendChild(infoDiv);
                row.appendChild(actionContainer);
                simpleContainer.appendChild(row);
            });

        } catch (e) {
            console.error("Erro no Simplificador de Mapa: ", e);
        } finally {
            isRendering = false;
        }
    }

    let activeTooltip = null;
    function showDropTooltip(e, dropsHTML) {
        hideDropTooltip();
        activeTooltip = document.createElement('div');
        activeTooltip.className = 'hunt-drop-tooltip';
        activeTooltip.innerHTML = `<div style="font-weight:bold; color:#48bb78; margin-bottom:8px; border-bottom:1px solid #1a2d3a; padding-bottom:4px; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Drops da Hunt:</div><div>${dropsHTML}</div>`;
        document.body.appendChild(activeTooltip);

        const rect = e.target.getBoundingClientRect();
        activeTooltip.style.top = `${rect.bottom + window.scrollY + 6}px`;
        activeTooltip.style.left = `${rect.left + window.scrollX}px`;
    }

    function hideDropTooltip() {
        if (activeTooltip) {
            activeTooltip.remove();
            activeTooltip = null;
        }
    }

    let renderTimeout = null;

    function getScriptDialogIcon(title, fallback = '❔') {
        const normalized = String(title || '').toLowerCase();
        if (/an[uú]ncio|announce|publica|market/.test(normalized)) return '🏷️';
        if (/venda|venta|sell/.test(normalized)) return '💰';
        if (/compra|buy|purchase/.test(normalized)) return '🛒';
        if (/solicitud|pedido|request/.test(normalized)) return '📥';
        if (/retirar|cancel|remove/.test(normalized)) return '↩️';
        if (/erro|error|falha|inválid/.test(normalized)) return '⚠️';
        return fallback;
    }

    function formatScriptDialogMessage(message) {
        const lines = String(message || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!lines.length) return '';
        const lead = `<div class="script-dialog-lead">${escapeHTML(lines[0])}</div>`;
        const details = lines.slice(1).map(line => {
            const separator = line.indexOf(':');
            if (separator < 0) return `<div class="script-dialog-summary-row"><b>${escapeHTML(line)}</b></div>`;
            return `<div class="script-dialog-summary-row"><span>${escapeHTML(line.slice(0, separator))}</span><b>${escapeHTML(line.slice(separator + 1).trim())}</b></div>`;
        }).join('');
        return `${lead}${details ? `<div class="script-dialog-summary">${details}</div>` : ''}`;
    }

    function showSellConfirm(itemNames, callback) {
        if (!itemNames || itemNames.length === 0) return callback(true);
        
        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop script-dialog-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal script-dialog-modal">
                <div class="sell-confirm-title"><span class="script-dialog-title-icon">💰</span><span class="script-dialog-title-text"><b>Confirmar Venda</b><small>ITENS PROTEGIDOS</small></span></div>
                <div class="sell-confirm-body">
                    <p>Você está prestes a vender os seguintes itens de alto valor:</p>
                    <div class="sell-confirm-items">
                        ${itemNames.map(n => `<div>• ${escapeHTML(n)}</div>`).join('')}
                    </div>
                    <div class="sell-confirm-footer">
                        <button class="sell-confirm-btn yes" type="button">✅ Confirmar Venda</button>
                        <button class="sell-confirm-btn no" type="button">❌ Cancelar</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        
        backdrop.querySelector('.yes').addEventListener('click', () => {
            backdrop.remove();
            callback(true);
        });
        backdrop.querySelector('.no').addEventListener('click', () => {
            backdrop.remove();
            callback(false);
        });
    }

    function getPokemonRarity(row) {
        const span = row.querySelector('.mk-meta span');
        if (!span) return null;
        return span.textContent.trim().toLowerCase();
    }

    function getGameTokens() {
        try {
            return JSON.parse(sessionStorage.getItem('pokeweb:tokens') || 'null');
        } catch {
            return null;
        }
    }

    async function refreshGameAccessToken() {
        const tokens = getGameTokens();
        if (!tokens?.refreshToken) return null;
        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: tokens.refreshToken })
        });
        if (!response.ok) return null;
        const refreshed = await response.json();
        if (!refreshed?.accessToken) return null;
        sessionStorage.setItem('pokeweb:tokens', JSON.stringify(refreshed));
        return refreshed.accessToken;
    }

    async function gameApiRequest(url, options = {}) {
        const send = accessToken => fetch(url, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                ...(options.headers || {})
            }
        });

        let response = await send(getGameTokens()?.accessToken);
        if (response.status === 401) {
            const refreshedToken = await refreshGameAccessToken();
            if (refreshedToken) response = await send(refreshedToken);
        }

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(result?.message || `HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return result;
    }

    async function readSellableInventoryFromDOM() {
        if (itemDataLoadPromise) await itemDataLoadPromise;
        const findVisibleInventory = () => Array.from(document.querySelectorAll('.inv-window')).find(windowElement => {
            const style = getComputedStyle(windowElement);
            const rect = windowElement.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        }) || null;

        let inventoryWindow = findVisibleInventory();
        const openedByScript = !inventoryWindow;
        if (!inventoryWindow) {
            document.querySelector('[data-guide="dock-inventory"]')?.click();
            for (let attempt = 0; attempt < 15 && !inventoryWindow; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                inventoryWindow = findVisibleInventory();
            }
        }
        if (!inventoryWindow) throw new Error('Inventário não abriu.');

        const payload = await fetch(ITEMS_JSON_URL).then(response => response.json());
        const items = Array.isArray(payload) ? payload : (payload.items || []);
        const catalogById = new Map(items.map(item => [String(item.id), item]));

        const entries = Array.from(inventoryWindow.querySelectorAll('.inv-slot[data-guide^="inv-item-"]'))
            .map(slot => {
                const itemId = slot.dataset.guide.replace('inv-item-', '');
                const name = slot.querySelector('.inv-ico')?.alt?.trim() || '';
                const qty = parseInt(slot.querySelector('.inv-qty')?.textContent, 10) || 0;
                const catalogItem = catalogById.get(String(itemId));
                return {
                    itemId,
                    name,
                    qty,
                    category: String(catalogItem?.category || '').toLowerCase(),
                    npcPrice: parseGameNumber(catalogItem?.npcPrice)
                };
            })
            .filter(item => item.itemId && item.name && item.qty > 0 && item.npcPrice > 0)
            .filter(item => !['heal', 'revive', 'stone'].includes(item.category));

        if (openedByScript) inventoryWindow.querySelector('.cfg-x')?.click();
        return entries;
    }

    function sellItemsThroughShop(items) {
        return gameApiRequest('/api/game/shop/sell', {
            method: 'POST',
            body: JSON.stringify({ items })
        });
    }

    function showPurchaseConfirm({ name, quantity, unitPrice, currentGold, currentBalance, currency = 'GOLD' }, callback) {
        const total = quantity * unitPrice;
        const balance = Number(currentBalance ?? currentGold ?? 0);
        const currencyIcon = String(currency).toUpperCase() === 'DIAMONDS' ? '💎' : '💲';
        const locale = getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US';
        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop script-dialog-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal script-dialog-modal">
                <div class="sell-confirm-title"><span class="script-dialog-title-icon">🛒</span><span class="script-dialog-title-text"><b>Confirmar compra</b><small>RESUMO DA COMPRA</small></span></div>
                <div class="sell-confirm-body">
                    <p><b>${quantity.toLocaleString(locale)}× ${escapeHTML(name)}</b></p>
                    <div class="sell-confirm-items">
                        <div>Preço unitário: ${currencyIcon}${unitPrice.toLocaleString(locale)}</div>
                        <div>Total: ${currencyIcon}${total.toLocaleString(locale)}</div>
                        <div>Saldo após compra: ${currencyIcon}${Math.max(0, balance - total).toLocaleString(locale)}</div>
                    </div>
                    <div class="sell-confirm-footer">
                        <button class="sell-confirm-btn yes" type="button" ${total > balance ? 'disabled' : ''}>Confirmar</button>
                        <button class="sell-confirm-btn no" type="button">Cancelar</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.querySelector('.yes').addEventListener('click', () => {
            backdrop.remove();
            callback(true);
        });
        backdrop.querySelector('.no').addEventListener('click', () => {
            backdrop.remove();
            callback(false);
        });
    }

    function showScriptNotice(message, { title = 'Aviso', isError = false } = {}) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'sell-confirm-backdrop script-notice-backdrop script-dialog-backdrop';
            backdrop.innerHTML = `
                <div class="sell-confirm-modal script-dialog-modal script-dialog-notice${isError ? ' is-error' : ''}" style="width:min(420px,92vw);">
                    <div class="sell-confirm-title"><span class="script-dialog-title-icon">${isError ? '⚠️' : 'ℹ️'}</span><span class="script-dialog-title-text"><b>${escapeHTML(title)}</b><small>${isError ? 'ERROR' : 'INFO'}</small></span></div>
                    <div class="sell-confirm-body">
                        <p style="margin:0 0 14px;color:${isError ? '#feb2b2' : '#e2e8f0'};">${escapeHTML(message)}</p>
                        <div class="sell-confirm-footer">
                            <button class="sell-confirm-btn yes script-notice-ok" type="button">OK</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.querySelector('.script-notice-ok').addEventListener('click', () => {
                backdrop.remove();
                resolve();
            });
        });
    }

    function showScriptConfirm(message, { title = 'Confirmar', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' } = {}) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'sell-confirm-backdrop script-confirm-backdrop script-dialog-backdrop';
            const icon = getScriptDialogIcon(title);
            const confirmSubtitle = getGameLanguage() === 'pt' ? 'CONFIRMAÇÃO' : getGameLanguage() === 'es' ? 'CONFIRMACIÓN' : 'CONFIRMATION';
            backdrop.innerHTML = `
                <div class="sell-confirm-modal script-dialog-modal script-dialog-confirm" style="width:min(500px,94vw);">
                    <div class="sell-confirm-title"><span class="script-dialog-title-icon">${icon}</span><span class="script-dialog-title-text"><b>${escapeHTML(title)}</b><small>${confirmSubtitle}</small></span></div>
                    <div class="sell-confirm-body">
                        ${formatScriptDialogMessage(message)}
                        <div class="sell-confirm-footer">
                            <button class="sell-confirm-btn yes script-confirm-yes" type="button">${escapeHTML(confirmLabel)}</button>
                            <button class="sell-confirm-btn no script-confirm-no" type="button">${escapeHTML(cancelLabel)}</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.querySelector('.script-confirm-yes').addEventListener('click', () => {
                backdrop.remove();
                resolve(true);
            });
            backdrop.querySelector('.script-confirm-no').addEventListener('click', () => {
                backdrop.remove();
                resolve(false);
            });
        });
    }

    function showScriptQuantityPrompt(message, maximum) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'sell-confirm-backdrop script-quantity-backdrop script-dialog-backdrop';
            backdrop.innerHTML = `<div class="sell-confirm-modal script-dialog-modal" style="width:min(380px,92vw);">
                <div class="sell-confirm-title" style="padding:13px 16px;"><span class="script-dialog-title-icon">📦</span><span class="script-dialog-title-text"><b>Quantidade</b><small>SELECIONE O TOTAL</small></span></div><div class="sell-confirm-body" style="display:grid;gap:12px;padding:16px;">
                <label style="display:grid;gap:7px;color:#aebdca;font-size:13px;"><span>${escapeHTML(message)}</span>
                <input class="script-quantity-input" type="number" min="1" max="${maximum}" value="${maximum}" style="width:100%;height:40px;box-sizing:border-box;background:#0c161f;color:#f1f5f9;border:1px solid #9f7b35;border-radius:7px;padding:8px 11px;font:700 14px var(--piw-game-font);outline:none;"></label>
                <div class="sell-confirm-footer" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0;padding:0;"><button class="sell-confirm-btn yes" type="button" style="width:100%;min-height:38px;">Confirmar</button><button class="sell-confirm-btn no" type="button" style="width:100%;min-height:38px;">Cancelar</button></div>
                </div></div>`;
            document.body.appendChild(backdrop);
            const finish = value => { backdrop.remove(); resolve(value); };
            backdrop.querySelector('.yes').addEventListener('click', () => {
                const value = Math.floor(Number(backdrop.querySelector('input').value));
                finish(Number.isFinite(value) && value >= 1 ? Math.min(maximum, value) : null);
            });
            backdrop.querySelector('.no').addEventListener('click', () => finish(null));
            backdrop.querySelector('input').focus();
        });
    }

    function showWindowMessage(windowElement, message, isError = false) {
        let messageElement = windowElement.querySelector('.script-window-message');
        if (!messageElement) {
            messageElement = document.createElement('div');
            messageElement.className = 'script-window-message';
            messageElement.style.cssText = 'padding:7px 12px;text-align:center;font-size:12px;font-weight:bold;';
            windowElement.appendChild(messageElement);
        }
        messageElement.style.color = isError ? '#f56565' : '#48bb78';
        messageElement.textContent = message;
        clearTimeout(messageElement._hideTimer);
        messageElement._hideTimer = setTimeout(() => messageElement.remove(), 3500);
    }

    async function showPortableDepot() {
        document.querySelector('.portable-depot-backdrop')?.remove();

        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop portable-depot-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal script-portable-depot-window">
                <div class="sell-confirm-title depot-head">
                    <div class="portable-depot-brand"><span class="portable-depot-brand-icon">📦</span><span><b>Depot</b><small>${tr('depotSubtitle')}</small></span></div>
                    <div class="portable-depot-tabs">
                    <button class="mk-bulk-btn depot-tab active" data-tab="items" type="button">🎒 ${tr('depotItems')}</button>
                    <button class="mk-bulk-btn depot-tab" data-tab="pokemon" type="button">◉ ${tr('depotPokemon')}</button>
                    <span class="portable-depot-family-tabs"></span>
                    </div>
                    <div class="portable-depot-view-toggle" aria-label="Vista del Depot">
                        <button class="mk-bulk-btn portable-depot-view-btn" data-view="cards" type="button">▦ ${tr('cards')}</button>
                        <button class="mk-bulk-btn portable-depot-view-btn" data-view="list" type="button">☷ ${tr('list')}</button>
                    </div>
                    <button class="portable-depot-close" type="button" style="background:none;border:0;color:#a0aec0;font-size:20px;cursor:pointer;">×</button>
                </div>
                <div class="sell-confirm-body">
                    <div class="portable-depot-status" style="color:#a0aec0;text-align:center;padding:16px;">${tr('loading')}</div>
                    <div class="portable-depot-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.querySelector('.portable-depot-close').addEventListener('click', close);
        backdrop.addEventListener('click', event => {
            if (event.target === backdrop) close();
        });

        const status = backdrop.querySelector('.portable-depot-status');
        const content = backdrop.querySelector('.portable-depot-content');
        const familyTabs = backdrop.querySelector('.portable-depot-family-tabs');
        let activeTab = 'items';
        let depotData = null;
        let pokes = [];
        let inventory = [];
        let familyData = null;
        let busy = false;
        const depotPokeFilters = { name: '', ivMin: '', ivMax: '', qualityMin: '', qualityMax: '' };
        const familyPokeFilters = { name: '', ivMin: '', ivMax: '', qualityMin: '', qualityMax: '' };
        const depotQualityTiers = [
            { label:'Fraca', color:'#64748b' }, { label:'Comum', color:'#35d05b' },
            { label:'Incomum', color:'#38bdf8' }, { label:'Rara', color:'#a855f7' },
            { label:'Épica', color:'#facc15' }, { label:'Lendária', color:'#f97316' },
            { label:'Mítica', color:'#d946ef' }, { label:'Anciã', color:'#d5a800' },
            { label:'Divina', color:'#e2e8f0' }
        ];
        const depotVisibleTiers = new Set(depotQualityTiers.map(tier => tier.label));
        const familyVisibleTiers = new Set(depotQualityTiers.map(tier => tier.label));
        const depotViewButtons = Array.from(backdrop.querySelectorAll('.portable-depot-view-btn'));
        let depotView = localStorage.getItem('script_depot_view_v1') === 'list' ? 'list' : 'cards';
        const applyDepotView = view => {
            depotView = view === 'list' ? 'list' : 'cards';
            content.classList.toggle('depot-view-list', depotView === 'list');
            content.classList.toggle('depot-view-cards', depotView === 'cards');
            depotViewButtons.forEach(button => button.classList.toggle('on', button.dataset.view === depotView));
            localStorage.setItem('script_depot_view_v1', depotView);
        };
        depotViewButtons.forEach(button => button.addEventListener('click', () => applyDepotView(button.dataset.view)));
        applyDepotView(depotView);

        const familyAction = async payload => {
            if (busy || !familyData?.family) return;
            const family = familyData.family;
            if (family.frozen || family.movesUsed >= family.movesCap) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), family.frozen
                    ? 'O depósito da família está congelado.'
                    : 'O limite diário de movimentos foi atingido.', true);
                return;
            }
            busy = true;
            try {
                latestFamily = null;
                const previousFamilyData = familyData;
                const response = await requestGameEvent('family', { type: 'family-action', ...payload }, null, 5000);
                if (!response?.family) {
                    familyData = previousFamilyData;
                    throw new Error(response?.message || response?.error || 'O servidor recusou esta transferência.');
                }
                familyData = response;
                if (payload.action === 'item') {
                    latestInventory = null;
                    inventory = await requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 2500, attempts: 2 });
                } else {
                    latestPokemon = null;
                    pokes = await requestGameEvent('pokes', 'pokes-get', null, 2500);
                }
                render();
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message || 'Não foi possível mover.', true);
                const refreshed = await requestFreshGameEvent('family', 'family-get', { timeoutMs: 3500, attempts: 1 }).catch(() => null);
                if (refreshed?.family) familyData = refreshed;
                render();
            } finally {
                busy = false;
            }
        };

        const uniqueDepotEntries = (entries, kind) => {
            const unique = new Map();
            entries.forEach(entry => {
                const id = kind === 'pokemon'
                    ? (entry?.id ?? entry?.capturedId ?? entry?.pokeId)
                    : (entry?.itemId ?? entry?.id ?? entry?.name);
                if (id != null) unique.set(String(id), entry);
            });
            return [...unique.values()];
        };
        const isDepotEntryProtected = (entry, kind) => kind === 'pokemon'
            ? isNativeLocked(entry)
            : Boolean(getItemProtectionReason(entry));

        const bulkLockDepotSide = async (entries, kind, button) => {
            if (busy) return;
            const targets = uniqueDepotEntries(entries, kind);
            if (!targets.length) return;
            const shouldLock = !targets.every(entry => isDepotEntryProtected(entry, kind));
            const pending = targets.filter(entry => isDepotEntryProtected(entry, kind) !== shouldLock);
            busy = true;
            button.disabled = true;
            let failures = 0;
            for (let offset = 0; offset < pending.length; offset += 5) {
                await Promise.all(pending.slice(offset, offset + 5).map(async entry => {
                    try {
                        if (kind === 'pokemon') await toggleNativeLock('pokemon', entry, shouldLock, false);
                        else await togglePortableItemProtection(entry, shouldLock);
                    } catch (error) {
                        failures++;
                        console.warn('No se pudo actualizar un candado del lado visible del Depot.', error);
                    }
                }));
            }
            if (kind === 'pokemon') {
                latestPokemon = null;
                pokes = await requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs:2500, attempts:1 }).catch(() => pokes);
                if (activeTab === 'family-pokemon') {
                    const refreshedFamily = await requestFreshGameEvent('family', 'family-get', { timeoutMs:3000, attempts:1 }).catch(() => null);
                    if (refreshedFamily?.family) familyData = refreshedFamily;
                }
            }
            busy = false;
            render();
            showWindowMessage(backdrop.querySelector('.sell-confirm-modal'),
                `${tr('depotVisibleLocked')}: ${pending.length - failures}/${pending.length}.`, failures > 0);
        };

        const bulkMoveDepotSide = async (entries, direction, kind, familyScope, button) => {
            if (busy) return;
            if (familyScope && familyData?.family?.frozen) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), tr('depotFamilyFrozen'), true);
                return;
            }
            const allVisible = uniqueDepotEntries(entries, kind);
            let movable = allVisible.filter(entry => !isDepotEntryProtected(entry, kind));
            if (familyScope) {
                const remaining = Math.max(0, Number(familyData?.family?.movesCap || 0) - Number(familyData?.family?.movesUsed || 0));
                if (!remaining) {
                    showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), tr('depotMoveLimit'), true);
                    return;
                }
                movable = movable.slice(0, remaining);
            }
            if (!movable.length) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), tr('depotNothingMovable'), true);
                return;
            }
            const confirmed = await showScriptConfirm(
                `${tr('depotMoveVisibleConfirm')} (${movable.length})`,
                { title:'Depot' }
            );
            if (!confirmed) return;
            busy = true;
            button.disabled = true;
            let completed = 0;
            let failures = 0;
            try {
                if (familyScope) {
                    for (const entry of movable) {
                        try {
                            latestFamily = null;
                            const payload = kind === 'item'
                                ? { type:'family-action', action:'item', dir:direction, itemId:entry.itemId ?? entry.id, quantity:Math.max(1, Math.floor(Number(entry.quantity) || 1)) }
                                : { type:'family-action', action:'poke', dir:direction, capturedId:entry.id };
                            const response = await requestGameEvent('family', payload, null, 5000);
                            if (!response?.family) throw new Error(response?.message || response?.error || 'Transferencia rechazada.');
                            familyData = response;
                            completed++;
                        } catch (error) {
                            failures++;
                            console.warn('No se pudo completar una transferencia familiar visible.', error);
                        }
                    }
                    if (kind === 'item') {
                        latestInventory = null;
                        inventory = await requestFreshGameEvent('inventory', 'inv-get', { timeoutMs:3000, attempts:2 }).catch(() => inventory);
                    } else {
                        latestPokemon = null;
                        pokes = await requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs:3000, attempts:2 }).catch(() => pokes);
                    }
                } else if (kind === 'item') {
                    for (const entry of movable) {
                        try {
                            depotData = await gameApiRequest('/api/game/depot/move', {
                                method:'POST', body:JSON.stringify({ itemId:entry.id ?? entry.itemId, dir:direction })
                            });
                            completed++;
                        } catch (error) {
                            failures++;
                            console.warn('No se pudo mover un objeto visible del Depot.', error);
                        }
                    }
                } else {
                    movable.forEach((entry, index) => setTimeout(() => sendGameMessage({
                        type:direction === 'store' ? 'poke-store' : 'poke-withdraw', pokeId:entry.id
                    }), index * 110));
                    await new Promise(resolve => setTimeout(resolve, Math.max(500, movable.length * 110 + 350)));
                    latestPokemon = null;
                    pokes = await requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs:3000, attempts:2 });
                    completed = movable.filter(entry => {
                        const updated = pokes.find(poke => String(poke.id) === String(entry.id));
                        return updated && (direction === 'store' ? !updated.team : Boolean(updated.team));
                    }).length;
                    failures += movable.length - completed;
                }
            } catch (error) {
                failures++;
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message || 'No se pudo completar la transferencia.', true);
            } finally {
                busy = false;
                render();
            }
            showWindowMessage(backdrop.querySelector('.sell-confirm-modal'),
                `${tr('depotVisibleMoved')}: ${completed}/${movable.length}.`, failures > 0);
        };

        const makeDepotColumnHeading = (title, entries, direction, kind, familyScope = false) => {
            const heading = document.createElement('div');
            heading.className = 'depot-column-head';
            heading.innerHTML = `<span class="depot-column-title"><b>${escapeHTML(title)}</b><small>${entries.length.toLocaleString()}</small></span>`;
            const actions = document.createElement('span');
            actions.className = 'depot-column-actions';
            const move = document.createElement('button');
            move.type = 'button';
            move.className = 'portable-depot-side-action';
            move.dataset.action = 'move';
            move.title = tr('depotMoveVisible');
            move.textContent = direction === 'store' || direction === 'deposit' ? `⇥ ${tr('depotMoveAllShort')}` : `⇤ ${tr('depotMoveAllShort')}`;
            move.disabled = !entries.length;
            move.addEventListener('click', () => bulkMoveDepotSide(entries, direction, kind, familyScope, move));
            const lock = document.createElement('button');
            lock.type = 'button';
            lock.className = 'portable-depot-side-action';
            const allLocked = entries.length > 0 && entries.every(entry => isDepotEntryProtected(entry, kind));
            lock.dataset.mode = allLocked ? 'unlock' : 'lock';
            lock.title = allLocked ? tr('depotUnlockVisible') : tr('depotLockVisible');
            lock.textContent = `${allLocked ? '🔓' : '🔒'} ${entries.length}`;
            lock.disabled = !entries.length;
            lock.addEventListener('click', () => bulkLockDepotSide(entries, kind, lock));
            actions.append(move, lock);
            heading.appendChild(actions);
            return heading;
        };

        const makeFamilyColumn = (title, entries, direction, kind) => {
            const column = document.createElement('section');
            column.className = 'portable-depot-column';
            column.style.cssText = 'flex:1;min-width:260px;background:#0d1822;border:1px solid #243545;border-radius:10px;padding:10px;max-height:52vh;overflow:auto;';
            const heading = makeDepotColumnHeading(title, entries, direction, kind, true);
            column.appendChild(heading);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'portable-depot-empty';
                empty.style.cssText = 'color:#7f91a3;text-align:center;padding:28px 8px;';
                empty.textContent = tr('depotEmpty');
                column.appendChild(empty);
                return column;
            }
            entries.forEach(entry => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = `depot-entry ${kind === 'pokemon' ? 'depot-pokemon-entry' : 'depot-item-entry'}`;
                row.style.cssText = 'display:flex;width:100%;align-items:center;gap:9px;background:#13222f;color:#e7edf4;border:1px solid #263b4c;border-radius:8px;padding:8px;margin:0 0 7px;cursor:pointer;text-align:left;';
                if (kind === 'pokemon') {
                    const theme = getMarketPokemonQualityTheme(entry.quality);
                    if (theme) row.style.setProperty('--depot-tier', theme.color);
                }
                const icon = document.createElement('img');
                icon.src = kind === 'item' ? normalizeGameItemIcon(entry.icon) : getPokemonIconUrl(entry.speciesId);
                icon.alt = entry.name || '';
                icon.style.cssText = `width:34px;height:34px;object-fit:contain;${kind === 'pokemon' ? 'image-rendering:pixelated;' : ''}flex:none;`;
                icon.onerror = () => { icon.style.visibility = 'hidden'; };
                const art = document.createElement('span');
                art.className = 'depot-entry-art';
                art.appendChild(icon);
                const label = document.createElement('span');
                label.className = 'depot-entry-info';
                label.style.cssText = 'min-width:0;flex:1;font-weight:700;';
                const entryName = entry.name || (kind === 'item' ? `Item #${entry.itemId}` : entry.speciesId);
                const qualityTheme = kind === 'pokemon' ? getMarketPokemonQualityTheme(entry.quality) : null;
                label.innerHTML = kind === 'item'
                    ? `<small class="depot-entry-kind">${tr('depotItemKind')}</small><b class="depot-entry-name">${escapeHTML(entryName)}</b><small class="depot-entry-meta"><span class="quantity">📦 ${Number(entry.quantity || 0).toLocaleString()} ${tr('depotAvailable')}</span></small>`
                    : `<small class="depot-entry-kind">${tr('depotPokemonKind')}${qualityTheme ? ` · ${escapeHTML(qualityTheme.label)}` : ''}</small><b class="depot-entry-name">${escapeHTML(entryName)}</b><small class="depot-entry-meta"><span>Nv ${Number(entry.level || 0)}</span><span>IV ${Number(entry.ivTotal || 0)}/192</span><span class="quality">Q ${Number(entry.quality || 0).toFixed(2)}</span>${direction === 'deposit' ? `<span>${entry.team ? tr('depotTeam') : tr('depotBox')}</span>` : ''}</small><small class="market-stats">${getMarketPokemonStatsHTML(entry.stats || entry)}</small>`;
                const action = document.createElement('span');
                action.className = 'depot-entry-action';
                action.style.cssText = 'color:#64c8ff;font-size:12px;font-weight:800;';
                action.textContent = direction === 'deposit' ? `${tr('depotDeposit')} →` : `← ${tr('depotWithdraw')}`;
                row.append(art, label);
                if (kind === 'pokemon') {
                    const lock = document.createElement('span');
                    lock.className = 'depot-entry-lock';
                    lock.textContent = isNativeLocked(entry) ? '🔒' : '🔓';
                    lock.title = 'Proteger/desproteger Pokémon';
                    lock.style.cssText = 'padding:5px;font-size:16px;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await toggleNativeLock('pokemon', entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                } else {
                    const reason = getItemProtectionReason(entry);
                    const lock = document.createElement('span');
                    lock.className = 'depot-entry-lock';
                    lock.textContent = reason ? '🔒' : '🔓';
                    lock.title = reason ? `Bloqueado por: ${reason}. Clique para desbloquear.` : 'Clique para bloquear pelo cadeado nativo do Mark';
                    lock.setAttribute('role', 'button'); lock.tabIndex = 0;
                    lock.style.cssText = 'padding:5px;font-size:16px;cursor:pointer;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await togglePortableItemProtection(entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                }
                row.appendChild(action);
                row.addEventListener('click', async () => {
                    if (kind === 'item') {
                        const protectionReason = getItemProtectionReason(entry);
                        if (protectionReason) {
                            showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), `❌ Este item está TRAVADO (${protectionReason}). Destrave-o para depositá-lo.`, true);
                            return;
                        }
                        const available = Math.max(1, Math.floor(Number(entry.quantity) || 1));
                        const quantity = await showScriptQuantityPrompt(`Quantidade de ${entry.name || `Item #${entry.itemId}`}:`, available);
                        if (!quantity) return;
                        familyAction({ action: 'item', dir: direction, itemId: entry.itemId ?? entry.id, quantity });
                    } else {
                        if (isNativeLocked(entry)) {
                            showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), 'Desbloqueie este Pokémon antes de transferi-lo.', true);
                            return;
                        }
                        const confirmed = await showScriptConfirm(
                            `${direction === 'deposit' ? 'Depositar' : 'Retirar'} ${entry.name || 'este Pokémon'} no depósito da família?`,
                            { title: 'Depósito da família' }
                        );
                        if (confirmed) familyAction({ action: 'poke', dir: direction, capturedId: entry.id });
                    }
                });
                column.appendChild(row);
            });
            return column;
        };

        const renderFamilyHeader = () => {
            const family = familyData?.family;
            if (!family) return;
            const header = document.createElement('div');
            header.className = 'portable-depot-family-header';
            header.style.cssText = 'flex-basis:100%;display:flex;justify-content:space-between;gap:12px;padding:9px 12px;background:#13222f;border:1px solid #263b4c;border-radius:8px;color:#cbd5e0;font-size:12px;';
            header.innerHTML = `<strong>${escapeHTML(family.name)}</strong><span>${Number(family.movesUsed || 0)}/${Number(family.movesCap || 0)} movimentos hoje${family.frozen ? ' · congelado' : ''}</span>`;
            content.appendChild(header);
        };

        const filterDepotPokemon = (entries, filters, visibleTiers = null) => entries.filter(entry => {
            const name = String(entry.name || '').toLocaleLowerCase();
            const query = filters.name.trim().toLocaleLowerCase();
            const iv = Number(entry.ivTotal || 0);
            const quality = Number(entry.quality || 0);
            const decimal = value => Number(String(value).replace(',', '.'));
            if (query && !name.includes(query)) return false;
            if (filters.ivMin !== '' && iv < Number(filters.ivMin)) return false;
            if (filters.ivMax !== '' && iv > Number(filters.ivMax)) return false;
            if (filters.qualityMin !== '' && quality < decimal(filters.qualityMin)) return false;
            if (filters.qualityMax !== '' && quality > decimal(filters.qualityMax)) return false;
            if (visibleTiers) {
                const tier = getMarketPokemonQualityTheme(quality)?.label || 'Fraca';
                if (!visibleTiers.has(tier)) return false;
            }
            return true;
        });

        const makeDepotPokemonFilters = filters => {
            const controls = document.createElement('div');
            const visibleTiers = filters === familyPokeFilters ? familyVisibleTiers : depotVisibleTiers;
            controls.className = 'portable-depot-poke-filters';
            controls.innerHTML = `
                <input type="text" data-filter="name" placeholder="${tr('depotSearchPokemon')}">
                <input type="number" data-filter="ivMin" min="0" max="192" placeholder="IV mín.">
                <input type="number" data-filter="ivMax" min="0" max="192" placeholder="IV máx.">
                <input type="text" inputmode="decimal" data-filter="qualityMin" placeholder="Qual. mín. (0,00)">
                <input type="text" inputmode="decimal" data-filter="qualityMax" placeholder="Qual. máx. (0,00)">
                <button type="button" class="portable-depot-clear-filters">↺ ${tr('depotClear')}</button>
                <div class="portable-depot-tier-filters">
                    <span class="portable-depot-tier-label">${tr('depotTierFilter')}</span>
                    ${depotQualityTiers.map(tier => `<button type="button" class="portable-depot-tier-btn${visibleTiers.has(tier.label) ? ' on' : ''}" data-tier="${escapeHTML(tier.label)}" style="--tier-color:${tier.color}">${escapeHTML(tier.label)}</button>`).join('')}
                    <button type="button" class="portable-depot-tier-shortcut" data-tier-action="all">✓ ${tr('depotAllTiers')}</button>
                    <button type="button" class="portable-depot-tier-shortcut" data-tier-action="none">× ${tr('depotNoTiers')}</button>
                </div>`;
            controls.querySelectorAll('[data-filter]').forEach(input => {
                input.value = filters[input.dataset.filter];
                input.addEventListener('input', () => {
                    filters[input.dataset.filter] = input.value;
                    render();
                    const replacement = content.querySelector(`[data-filter="${input.dataset.filter}"]`);
                    replacement?.focus();
                    replacement?.setSelectionRange?.(replacement.value.length, replacement.value.length);
                });
            });
            controls.querySelector('.portable-depot-clear-filters').addEventListener('click', () => {
                Object.keys(filters).forEach(key => { filters[key] = ''; });
                depotQualityTiers.forEach(tier => visibleTiers.add(tier.label));
                render();
            });
            controls.querySelectorAll('.portable-depot-tier-btn').forEach(button => button.addEventListener('click', () => {
                const tier = button.dataset.tier;
                if (visibleTiers.has(tier)) visibleTiers.delete(tier);
                else visibleTiers.add(tier);
                render();
            }));
            controls.querySelector('[data-tier-action="all"]')?.addEventListener('click', () => {
                depotQualityTiers.forEach(tier => visibleTiers.add(tier.label));
                render();
            });
            controls.querySelector('[data-tier-action="none"]')?.addEventListener('click', () => {
                visibleTiers.clear();
                render();
            });
            return controls;
        };

        const makeColumn = (title, entries, direction, emptyText, isPokemon = false) => {
            const column = document.createElement('section');
            column.className = 'portable-depot-column';
            column.style.cssText = 'flex:1;min-width:260px;background:#0d1822;border:1px solid #243545;border-radius:10px;padding:10px;max-height:58vh;overflow:auto;';
            const heading = makeDepotColumnHeading(title, entries, direction, isPokemon ? 'pokemon' : 'item', false);
            column.appendChild(heading);

            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'portable-depot-empty';
                empty.style.cssText = 'color:#7f91a3;text-align:center;padding:28px 8px;';
                empty.textContent = emptyText;
                column.appendChild(empty);
                return column;
            }

            entries.forEach(entry => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = `depot-entry ${isPokemon ? 'depot-pokemon-entry' : 'depot-item-entry'}`;
                row.style.cssText = 'display:flex;width:100%;align-items:center;gap:9px;background:#13222f;color:#e7edf4;border:1px solid #263b4c;border-radius:8px;padding:8px;margin:0 0 7px;cursor:pointer;text-align:left;';
                if (isPokemon) {
                    const theme = getMarketPokemonQualityTheme(entry.quality);
                    if (theme) row.style.setProperty('--depot-tier', theme.color);
                }
                const image = document.createElement('img');
                if (isPokemon) {
                    image.src = getPokemonIconUrl(entry.speciesId);
                    image.alt = entry.name || '';
                    image.style.cssText = 'width:34px;height:34px;object-fit:contain;image-rendering:pixelated;flex:none;';
                    image.onerror = () => { image.style.visibility = 'hidden'; };
                } else {
                    image.src = normalizeGameItemIcon(entry.icon);
                    image.alt = entry.name || '';
                    image.style.cssText = 'width:34px;height:34px;object-fit:contain;flex:none;';
                    image.onerror = () => { image.style.visibility = 'hidden'; };
                }
                const art = document.createElement('span');
                art.className = 'depot-entry-art';
                art.appendChild(image);
                const label = document.createElement('span');
                label.className = 'depot-entry-info';
                label.style.cssText = 'min-width:0;flex:1;font-weight:700;';
                const entryName = entry.name || entry.pokeId || `Item #${entry.id}`;
                const qualityTheme = isPokemon ? getMarketPokemonQualityTheme(entry.quality) : null;
                label.innerHTML = isPokemon
                    ? `<small class="depot-entry-kind">${tr('depotPokemonKind')}${qualityTheme ? ` · ${escapeHTML(qualityTheme.label)}` : ''}</small><b class="depot-entry-name">${escapeHTML(entryName)}</b><small class="depot-entry-meta"><span>Nv ${Number(entry.level || 0)}</span><span>IV ${Number(entry.ivTotal || 0)}/192</span><span class="quality">Q ${Number(entry.quality || 0).toFixed(2)}</span></small><small class="market-stats">${getMarketPokemonStatsHTML(entry.stats || entry)}</small>`
                    : `<small class="depot-entry-kind">${tr('depotItemKind')}</small><b class="depot-entry-name">${escapeHTML(entryName)}</b><small class="depot-entry-meta"><span class="quantity">📦 ${Number(entry.quantity || 0).toLocaleString()} ${tr('depotAvailable')}</span></small>`;
                const action = document.createElement('span');
                action.className = 'depot-entry-action';
                action.style.cssText = 'color:#64c8ff;font-size:12px;font-weight:800;';
                action.textContent = direction === 'store' ? `${tr('depotStore')} →` : `← ${tr('depotWithdraw')}`;
                row.append(art, label);
                if (isPokemon) {
                    const lock = document.createElement('span');
                    lock.className = 'depot-entry-lock';
                    lock.textContent = isNativeLocked(entry) ? '🔒' : '🔓';
                    lock.title = 'Proteger/desproteger Pokémon';
                    lock.style.cssText = 'padding:5px;font-size:16px;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await toggleNativeLock('pokemon', entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                } else {
                    const reason = getItemProtectionReason(entry);
                    const lock = document.createElement('span');
                    lock.className = 'depot-entry-lock';
                    lock.textContent = reason ? '🔒' : '🔓';
                    lock.title = reason ? `Bloqueado por: ${reason}. Clique para desbloquear.` : 'Clique para bloquear pelo cadeado nativo do Mark';
                    lock.setAttribute('role', 'button'); lock.tabIndex = 0;
                    lock.style.cssText = 'padding:5px;font-size:16px;cursor:pointer;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await togglePortableItemProtection(entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                }
                row.appendChild(action);
                row.addEventListener('click', async () => {
                    if (busy) return;
                    busy = true;
                    row.disabled = true;
                    try {
                        if (isPokemon) {
                            sendGameMessage({ type: direction === 'store' ? 'poke-store' : 'poke-withdraw', pokeId: entry.id });
                            latestPokemon = null;
                            await new Promise(resolve => setTimeout(resolve, 350));
                            pokes = await requestGameEvent('pokes', 'pokes-get', latestPokemon);
                        } else {
                            const protectionReason = getItemProtectionReason(entry);
                            if (protectionReason) throw new Error(`❌ Este item está TRAVADO (${protectionReason}). Destrave-o para depositá-lo.`);
                            depotData = await gameApiRequest('/api/game/depot/move', {
                                method: 'POST',
                                body: JSON.stringify({ itemId: entry.id, dir: direction })
                            });
                        }
                        render();
                    } catch (error) {
                        showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message || 'Não foi possível mover.', true);
                    } finally {
                        busy = false;
                    }
                });
                column.appendChild(row);
            });
            return column;
        };

        const render = () => {
            const previousContentScroll = content.scrollTop;
            const previousColumnScrolls = Array.from(content.querySelectorAll('section')).map(section => section.scrollTop);
            content.innerHTML = '';
            content.style.cssText = '';
            content.classList.toggle('has-filters', activeTab === 'pokemon' || activeTab === 'family-pokemon');
            content.classList.toggle('has-family-header', activeTab === 'family-items' || activeTab === 'family-pokemon');
            if (activeTab === 'items') {
                const bag = depotData?.inventory || [];
                const stored = depotData?.depot || [];
                content.append(
                    makeColumn(tr('depotBag'), bag, 'store', 'A mochila está vazia.'),
                    makeColumn(`Depot · ${depotData?.depot?.length || 0}/${depotData?.maxSlots || 0}`, stored, 'withdraw', 'O Depot está vazio.')
                );
            } else if (activeTab === 'pokemon') {
                content.appendChild(makeDepotPokemonFilters(depotPokeFilters));
                const team = filterDepotPokemon(pokes.filter(poke => poke.team && !String(poke.id).startsWith('team-')), depotPokeFilters, depotVisibleTiers);
                const box = filterDepotPokemon(pokes.filter(poke => !poke.team), depotPokeFilters, depotVisibleTiers);
                content.append(
                    makeColumn(tr('depotTeam'), team, 'store', 'Nenhum Pokémon na equipe.', true),
                    makeColumn(tr('depotBox'), box, 'withdraw', 'Nenhum Pokémon no Box.', true)
                );
            } else if (activeTab === 'family-items') {
                renderFamilyHeader();
                const inventoryById = new Map((depotData?.inventory || []).map(item => [String(item.id), item]));
                const bag = inventory.filter(item => Number(item.quantity) > 0).map(item => ({
                    ...item,
                    id: item.itemId,
                    name: inventoryById.get(String(item.itemId))?.name || globalItemApiData.get(String(item.itemId))?.name || `Item #${item.itemId}`,
                    icon: inventoryById.get(String(item.itemId))?.icon || globalItemApiData.get(String(item.itemId))?.icon || ''
                }));
                content.append(
                    makeFamilyColumn(tr('depotYourBag'), bag, 'deposit', 'item'),
                    makeFamilyColumn(tr('depotFamily'), familyData?.depot?.items || [], 'withdraw', 'item')
                );
            } else if (activeTab === 'family-pokemon') {
                renderFamilyHeader();
                content.appendChild(makeDepotPokemonFilters(familyPokeFilters));
                const owned = filterDepotPokemon(pokes.filter(poke => !String(poke.id).startsWith('team-')), familyPokeFilters, familyVisibleTiers);
                const stored = filterDepotPokemon(familyData?.depot?.pokes || [], familyPokeFilters, familyVisibleTiers);
                content.append(
                    makeFamilyColumn(tr('depotYourPokemon'), owned, 'deposit', 'pokemon'),
                    makeFamilyColumn(tr('depotFamily'), stored, 'withdraw', 'pokemon')
                );
            }
            requestAnimationFrame(() => {
                content.scrollTop = previousContentScroll;
                content.querySelectorAll('section').forEach((section, index) => {
                    section.scrollTop = previousColumnScrolls[index] || 0;
                });
            });
        };

        const bindTab = tab => {
            tab.addEventListener('click', () => {
                activeTab = tab.dataset.tab;
                backdrop.querySelectorAll('.depot-tab').forEach(button => button.classList.toggle('active', button === tab));
                render();
            });
        };

        const configureFamilyTabs = () => {
            familyTabs.innerHTML = '';
            if (familyData?.family) {
                familyTabs.innerHTML = `
                    <button class="mk-bulk-btn depot-tab" data-tab="family-items" type="button">👥 ${tr('depotFamilyItems')}</button>
                    <button class="mk-bulk-btn depot-tab" data-tab="family-pokemon" type="button">👥 ${tr('depotFamilyPokemon')}</button>`;
                familyTabs.querySelectorAll('.depot-tab').forEach(bindTab);
                return;
            }
            const info = document.createElement('button');
            info.type = 'button';
            info.className = 'mk-bulk-btn';
            const familyConfirmed = familyData?.type === 'family';
            info.textContent = familyConfirmed ? 'Sem família' : 'Família indisponível';
            info.title = familyConfirmed
                ? 'As abas familiares aparecem somente para membros de uma família.'
                : 'Não foi possível consultar a família pelo WebSocket.';
            info.addEventListener('click', async () => {
                if (familyConfirmed) {
                    await showScriptNotice(
                        'As abas familiares não aparecem porque esta conta não pertence a nenhuma família.',
                        { title: 'Depósito da família' }
                    );
                    return;
                }
                await showScriptNotice(
                    'A conexão do jogo não respondeu à consulta familiar. Feche e abra o Depot para tentar novamente.',
                    { title: 'Família indisponível', isError: true }
                );
            });
            familyTabs.appendChild(info);
        };

        backdrop.querySelectorAll('.depot-tab').forEach(bindTab);

        try {
            const socketReady = await waitForGameSocket(5000);
            [depotData, pokes, inventory, familyData] = await Promise.all([
                gameApiRequest('/api/game/depot'),
                socketReady ? requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs: 3500, attempts: 2 }) : Promise.resolve([]),
                socketReady ? requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3000, attempts: 2 }) : Promise.resolve([]),
                socketReady ? requestFreshGameEvent('family', 'family-get', { timeoutMs: 3500, attempts: 2 }) : Promise.resolve(null)
            ]);
            configureFamilyTabs();
            status.remove();
            if (!socketReady) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), 'WebSocket indisponível: Pokémon e família não puderam ser carregados.', true);
            }
            render();
        } catch (error) {
            status.textContent = 'Não foi possível abrir o Depot.';
            status.style.color = '#f56565';
            console.error('Falha ao abrir Depot portátil:', error);
        }
    }

    async function showHuntSellWindow() {
        document.querySelector('.hunt-sell-backdrop')?.remove();

        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop hunt-sell-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal script-npc-sell-window script-npc-item-sell" style="width:min(900px,96vw);max-width:96vw;">
                <div class="sell-confirm-title">
                    <span>🛒 ${tr('sellNpcItems')}</span>
                    <button class="hunt-pokemon-open mk-bulk-btn" type="button" style="margin-left:auto;">🐾 Pokémon</button>
                    <button class="hunt-sell-close" type="button" style="margin-left:auto;background:none;border:0;color:#a0aec0;font-size:20px;cursor:pointer;">×</button>
                </div>
                <div class="sell-confirm-body">
                    <div class="hunt-sell-status" style="color:#a0aec0;text-align:center;padding:16px;">Carregando inventário...</div>
                    <div class="hunt-sell-list"></div>
                    <div class="sell-confirm-footer" style="display:none;">
                        <button class="sell-confirm-btn hunt-sell-select-all" type="button">${tr('markAll')}</button>
                        <button class="sell-confirm-btn yes hunt-sell-submit" type="button">${tr('sell')}</button>
                        <button class="sell-confirm-btn no hunt-sell-cancel" type="button">${tr('cancel')}</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.querySelector('.hunt-sell-close').addEventListener('click', close);
        backdrop.querySelector('.hunt-sell-cancel').addEventListener('click', close);
        backdrop.querySelector('.hunt-pokemon-open').addEventListener('click', () => {
            close();
            showHuntPokemonSellWindow();
        });

        const status = backdrop.querySelector('.hunt-sell-status');
        const list = backdrop.querySelector('.hunt-sell-list');
        const footer = backdrop.querySelector('.sell-confirm-footer');
        const submit = backdrop.querySelector('.hunt-sell-submit');
        const selectAll = backdrop.querySelector('.hunt-sell-select-all');

        try {
            const [inventory, shopData] = await Promise.all([
                gameSocket
                    ? requestGameEvent('inventory', 'inv-get', latestInventory).then(async entries => {
                        if (!entries.length) return readSellableInventoryFromDOM();
                        const payload = await fetch(ITEMS_JSON_URL).then(response => response.json());
                        const catalogItems = Array.isArray(payload) ? payload : (payload.items || []);
                        const catalog = new Map(catalogItems.map(item => [String(item.id), item]));
                        return entries.map(entry => {
                            const catalogItem = catalog.get(String(entry.itemId));
                            return {
                                itemId: String(entry.itemId),
                                name: catalogItem?.name || `Item ${entry.itemId}`,
                                qty: Number(entry.quantity) || 0,
                                category: String(catalogItem?.category || '').toLowerCase(),
                                npcPrice: Number(catalogItem?.npcPrice) || 0,
                                icon: normalizeGameItemIcon(catalogItem?.icon || catalogItem?.image || ''),
                                locked: isNativeLocked(entry)
                            };
                        }).filter(item => item.qty > 0 && item.npcPrice > 0)
                            .filter(item => !['heal', 'revive', 'stone'].includes(item.category));
                    })
                    : readSellableInventoryFromDOM(),
                gameApiRequest('/api/game/shop')
            ]);
            if (inventory.length === 0) {
                status.textContent = 'Nenhum item vendável foi encontrado no inventário.';
                return;
            }

            status.style.display = 'none';
            footer.style.display = 'flex';
            inventory.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
                const protectionReason = getItemProtectionReason(item);
                const isProtected = Boolean(protectionReason);
                const row = document.createElement('label');
                row.className = `hunt-sell-row${isProtected ? ' protected' : ''}`;

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.disabled = isProtected;
                checkbox.dataset.itemId = item.itemId;
                checkbox.dataset.itemName = item.name;
                checkbox.dataset.unitPrice = String(item.npcPrice);

                const name = document.createElement('span');
                name.className = 'hunt-sell-info';
                name.innerHTML = `<small class="hunt-sell-kind">OBJETO NPC</small><b class="hunt-sell-name">${escapeHTML(item.name)}</b><small class="hunt-sell-meta"><span class="npc-item-stock">📦 ${item.qty.toLocaleString('pt-BR')} disponibles</span> · <span class="hunt-sell-price">💲 ${item.npcPrice.toLocaleString('pt-BR')} c/u</span></small>`;

                const art = document.createElement('span');
                art.className = 'hunt-sell-art';
                art.innerHTML = item.icon ? `<img src="${escapeHTML(item.icon)}" alt="${escapeHTML(item.name)}">` : '<span>📦</span>';
                art.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: '📦' }));
                }, { once: true });

                const quantity = document.createElement('input');
                quantity.type = 'number';
                quantity.min = '1';
                quantity.max = String(item.qty);
                quantity.value = String(item.qty);
                quantity.disabled = isProtected;

                const lock = document.createElement('span');
                lock.textContent = isProtected ? '🔒' : '🔓';
                lock.title = protectionReason ? `Bloqueado por: ${protectionReason}. Clique para desbloquear.` : 'Clique para bloquear pelo cadeado nativo do Mark';
                lock.setAttribute('role', 'button'); lock.tabIndex = 0;
                lock.style.cssText = 'cursor:pointer;font-size:16px;padding:4px;';
                lock.addEventListener('click', async event => {
                    event.preventDefault(); event.stopPropagation();
                    try {
                        const locked = await togglePortableItemProtection(item);
                        lock.textContent = locked ? '🔒' : '🔓';
                        checkbox.disabled = locked;
                        quantity.disabled = locked;
                        if (locked) checkbox.checked = false;
                        updateSaleSummary();
                    } catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                });
                row.append(checkbox, art, name, quantity, lock);
                list.appendChild(row);
            });

            const updateSaleSummary = () => {
                let total = 0;
                list.querySelectorAll('.hunt-sell-row').forEach(row => {
                    const checkbox = row.querySelector('input[type="checkbox"]');
                    const quantity = row.querySelector('input[type="number"]');
                    if (checkbox.checked) {
                        total += (parseInt(quantity.value, 10) || 0) * (Number(checkbox.dataset.unitPrice) || 0);
                    }
                });
                status.textContent = `Saldo atual: 💲${Number(shopData.gold || 0).toLocaleString('pt-BR')} · Venda selecionada: 💲${total.toLocaleString('pt-BR')}`;
                status.style.display = '';
                const eligible = Array.from(list.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
                selectAll.textContent = eligible.length > 0 && eligible.every(checkbox => checkbox.checked)
                    ? tr('unmarkAll')
                    : tr('markAll');
            };
            selectAll.addEventListener('click', () => {
                const eligible = Array.from(list.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
                const shouldSelect = eligible.some(checkbox => !checkbox.checked);
                eligible.forEach(checkbox => { checkbox.checked = shouldSelect; });
                updateSaleSummary();
            });
            list.addEventListener('input', updateSaleSummary);
            list.addEventListener('change', updateSaleSummary);
            updateSaleSummary();

            submit.addEventListener('click', () => {
                const selectedRows = Array.from(list.querySelectorAll('.hunt-sell-row')).flatMap(row => {
                    const checkbox = row.querySelector('input[type="checkbox"]');
                    const quantity = row.querySelector('input[type="number"]');
                    if (!checkbox.checked) return [];
                    const qty = Math.min(parseInt(quantity.value, 10) || 0, parseInt(quantity.max, 10) || 0);
                    return qty > 0 ? [{
                        itemId: checkbox.dataset.itemId,
                        name: checkbox.dataset.itemName,
                        qty
                    }] : [];
                });

                if (selectedRows.length === 0) {
                    status.textContent = 'Selecione pelo menos um item.';
                    status.style.display = '';
                    return;
                }

                const executeSale = async () => {
                    submit.disabled = true;
                    submit.textContent = 'Vendendo...';
                    try {
                        const result = await sellItemsThroughShop(selectedRows.map(({ itemId, qty }) => ({ itemId, qty })));
                        latestInventory = null;
                        shopData.gold = Number(result.gold ?? shopData.gold ?? 0);
                        selectedRows.forEach(soldItem => {
                            const checkbox = Array.from(list.querySelectorAll('input[type="checkbox"]'))
                                .find(input => String(input.dataset.itemId) === String(soldItem.itemId));
                            const row = checkbox?.closest('.hunt-sell-row');
                            const quantity = row?.querySelector('input[type="number"]');
                            if (!row || !checkbox || !quantity) return;
                            const remaining = Math.max(0, Number(quantity.max || 0) - soldItem.qty);
                            if (remaining === 0) {
                                row.remove();
                                return;
                            }
                            quantity.max = String(remaining);
                            quantity.value = String(remaining);
                            checkbox.checked = false;
                            row.querySelector('.npc-item-stock').textContent = `📦 ${remaining.toLocaleString('pt-BR')} disponibles`;
                        });
                        updateSaleSummary();
                        showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), `Venda concluída: +💲${Number(result.goldGained || 0).toLocaleString('pt-BR')}`);
                        submit.disabled = false;
                        submit.textContent = 'Vender';
                    } catch (error) {
                        console.error('Falha ao vender itens no Mark:', error);
                        status.textContent = 'Não foi possível concluir a venda. Tente novamente.';
                        status.style.display = '';
                        submit.disabled = false;
                        submit.textContent = 'Vender';
                    }
                };

                const confirmationNames = new Set(getSellConfirmItems().map(name => name.toLowerCase()));
                const selectedToConfirm = selectedRows
                    .filter(item => confirmationNames.has(item.name.toLowerCase()))
                    .map(item => item.name);
                if (selectedToConfirm.length > 0) {
                    showSellConfirm(selectedToConfirm, confirmed => {
                        if (confirmed) executeSale();
                    });
                } else {
                    executeSale();
                }
            });
        } catch (error) {
            console.error('Falha ao carregar o inventário do Mark:', error);
            status.textContent = 'Não foi possível carregar os itens para venda.';
        }
    }

    async function showHuntPokemonSellWindow() {
        document.querySelector('.hunt-sell-backdrop')?.remove();
        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop hunt-sell-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal script-npc-sell-window script-npc-pokemon-sell" style="width:min(980px,96vw);max-width:96vw;">
                <div class="sell-confirm-title">
                    <span>🐾 ${tr('sellNpcPokemon')}</span>
                    <button class="hunt-items-open mk-bulk-btn" type="button" style="margin-left:auto;">🎒 Itens</button>
                    <button class="hunt-sell-close" type="button" style="margin-left:auto;background:none;border:0;color:#a0aec0;font-size:20px;cursor:pointer;">×</button>
                </div>
                <div class="sell-confirm-body">
                    <div class="hunt-pokemon-filters" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
                        <input class="hunt-pokemon-search" type="search" placeholder="Buscar Pokémon..." style="min-width:140px;flex:1;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 8px;">
                        <select class="hunt-pokemon-shiny-filter" style="background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                            <option value="">Todos</option>
                            <option value="shiny">✨ Shiny</option>
                            <option value="normal">Normais</option>
                        </select>
                        <input class="hunt-pokemon-iv-min-filter" type="number" min="0" max="192" placeholder="IV mín." style="width:72px;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                        <input class="hunt-pokemon-iv-max-filter" type="number" min="0" max="192" placeholder="IV máx." style="width:72px;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                        <input class="hunt-pokemon-quality-min-filter" type="number" min="0" step="0.01" placeholder="Qual. mín." style="width:82px;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                        <input class="hunt-pokemon-quality-max-filter" type="number" min="0" step="0.01" placeholder="Qual. máx." style="width:82px;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                        <div class="hunt-quality-tiers" aria-label="Filtrar tiers de Quality">
                            <button class="hunt-quality-tier-shortcut hunt-quality-tier-all" type="button">✓ ${tr('depotAllTiers')}</button>
                            <button class="hunt-quality-tier-shortcut hunt-quality-tier-none" type="button">× ${tr('depotNoTiers')}</button>
                            <button class="hunt-quality-tier on" data-tier="Fraca" style="--tier-color:#64748b" type="button">Fraca</button>
                            <button class="hunt-quality-tier on" data-tier="Comum" style="--tier-color:#35d05b" type="button">Comum</button>
                            <button class="hunt-quality-tier on" data-tier="Incomum" style="--tier-color:#38bdf8" type="button">Incomum</button>
                            <button class="hunt-quality-tier on" data-tier="Rara" style="--tier-color:#a855f7" type="button">Rara</button>
                            <button class="hunt-quality-tier on" data-tier="Épica" style="--tier-color:#facc15" type="button">Épica</button>
                            <button class="hunt-quality-tier on" data-tier="Lendária" style="--tier-color:#f97316" type="button">Lendária</button>
                            <button class="hunt-quality-tier on" data-tier="Mítica" style="--tier-color:#d946ef" type="button">Mítica</button>
                            <button class="hunt-quality-tier on" data-tier="Anciã" style="--tier-color:#d5a800" type="button">Anciã</button>
                            <button class="hunt-quality-tier on" data-tier="Divina" style="--tier-color:#e2e8f0" type="button">Divina</button>
                        </div>
                    </div>
                    <div class="hunt-sell-status" style="color:#a0aec0;text-align:center;padding:8px;">Carregando Pokémon...</div>
                    <div class="hunt-sell-list"></div>
                    <div class="sell-confirm-footer" style="display:none;">
                        <button class="sell-confirm-btn hunt-pokemon-select-all" type="button">${tr('markAll')}</button>
                        <button class="sell-confirm-btn yes hunt-pokemon-submit" type="button">${tr('sellNpcPokemon')}</button>
                        <button class="sell-confirm-btn no hunt-sell-cancel" type="button">${tr('cancel')}</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.querySelector('.hunt-sell-close').addEventListener('click', close);
        backdrop.querySelector('.hunt-sell-cancel').addEventListener('click', close);
        backdrop.querySelector('.hunt-items-open').addEventListener('click', () => {
            close();
            showHuntSellWindow();
        });

        const status = backdrop.querySelector('.hunt-sell-status');
        const list = backdrop.querySelector('.hunt-sell-list');
        const footer = backdrop.querySelector('.sell-confirm-footer');
        const submit = backdrop.querySelector('.hunt-pokemon-submit');
        const pokeSearch = backdrop.querySelector('.hunt-pokemon-search');
        const shinyFilter = backdrop.querySelector('.hunt-pokemon-shiny-filter');
        const ivMinFilter = backdrop.querySelector('.hunt-pokemon-iv-min-filter');
        const ivMaxFilter = backdrop.querySelector('.hunt-pokemon-iv-max-filter');
        const qualityMinFilter = backdrop.querySelector('.hunt-pokemon-quality-min-filter');
        const qualityMaxFilter = backdrop.querySelector('.hunt-pokemon-quality-max-filter');
        const tierButtons = Array.from(backdrop.querySelectorAll('.hunt-quality-tier'));
        const allTiersButton = backdrop.querySelector('.hunt-quality-tier-all');
        const noTiersButton = backdrop.querySelector('.hunt-quality-tier-none');
        const selectAll = backdrop.querySelector('.hunt-pokemon-select-all');

        try {
            const [pokemon, shopData] = await Promise.all([
                (async () => {
                    const contextPokemon = await requestPokemonTeamFromGameContext(2200);
                    if (contextPokemon.length) return contextPokemon;
                    return requestGameEvent('pokes', 'pokes-get', latestPokemon);
                })(),
                gameApiRequest('/api/game/shop')
            ]);
            const sellable = pokemon.filter(poke => !poke.team && !poke.starter && Number(poke.sellValue) > 0);
            if (!sellable.length) {
                status.textContent = 'Nenhum Pokémon vendável foi encontrado.';
                return;
            }

            footer.style.display = 'flex';
            sellable.forEach(poke => {
                const protectedPoke = Boolean(isNativeLocked(poke) || poke.shiny || poke.market || poke.listed);
                const row = document.createElement('label');
                row.className = `hunt-sell-row npc-pokemon-row${protectedPoke ? ' protected' : ''}`;
                row.dataset.searchName = String(poke.name || '').toLocaleLowerCase();
                row.dataset.shiny = poke.shiny ? 'true' : 'false';
                row.dataset.iv = String(Number(poke.ivTotal) || 0);
                row.dataset.quality = String(Number(poke.quality) || 0);
                const qualityTheme = getMarketPokemonQualityTheme(poke.quality) || { label: 'Fraca', color: '#64748b' };
                row.dataset.tier = qualityTheme.label;
                row.style.setProperty('--tier-color', qualityTheme.color);

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.disabled = protectedPoke;
                checkbox.dataset.pokeId = String(poke.id);
                checkbox.dataset.value = String(poke.sellValue || 0);

                const name = document.createElement('span');
                name.className = 'hunt-sell-info';
                const flags = [
                    poke.shiny ? '✨' : '',
                    isNativeLocked(poke) ? '🔒' : '',
                    (poke.market || poke.listed) ? '🏷️' : ''
                ].filter(Boolean).join(' ');
                const quality = formatPokemonQuality(poke.quality) || 'Qualidade —';
                const pokeName = poke.name || `Pokémon ${poke.speciesId}`;
                const statsHTML = getMarketPokemonStatsHTML(poke.stats);
                name.innerHTML = `<small class="hunt-sell-kind">${qualityTheme.label}${poke.shiny ? ' · ✨ SHINY' : ''}</small><b class="hunt-sell-name">${escapeHTML(pokeName)} ${escapeHTML(flags)}</b><small class="hunt-sell-meta">Nivel ${Number(poke.level || 1)} · IV ${poke.ivTotal ?? '—'}/192 · ${escapeHTML(quality)}</small>${statsHTML ? `<small class="market-stats">${statsHTML}</small>` : ''}`;

                const art = document.createElement('span');
                art.className = 'hunt-sell-art';
                const sprite = getPokemonIconUrl(poke.speciesId);
                art.innerHTML = sprite ? `<img src="${escapeHTML(sprite)}" alt="${escapeHTML(pokeName)}">` : '<span>◉</span>';
                art.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: '◉' }));
                }, { once: true });

                const value = document.createElement('strong');
                value.textContent = `💲${Number(poke.sellValue).toLocaleString('pt-BR')}`;
                const lock = document.createElement('button');
                lock.type = 'button';
                lock.className = 'mk-lock';
                lock.textContent = isNativeLocked(poke) ? '🔒' : '🔓';
                lock.title = 'Usar o cadeado nativo deste Pokémon';
                lock.addEventListener('click', async event => {
                    event.preventDefault(); event.stopPropagation();
                    try {
                        const locked = await toggleNativeLock('pokemon', poke);
                        lock.textContent = locked ? '🔒' : '🔓';
                        checkbox.disabled = locked || poke.shiny || poke.market || poke.listed;
                        if (locked) checkbox.checked = false;
                        row.classList.toggle('protected', locked || poke.shiny || poke.market || poke.listed);
                        lock.title = locked ? 'Desbloquear este Pokémon' : 'Bloquear este Pokémon';
                        updateSummary();
                    } catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                });
                row.append(checkbox, art, name, value, lock);
                list.appendChild(row);
            });

            const updateSummary = () => {
                const total = Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
                    .reduce((sum, checkbox) => sum + Number(checkbox.dataset.value || 0), 0);
                const visibleRows = Array.from(list.querySelectorAll('.hunt-sell-row:not([hidden])'));
                const selectable = visibleRows
                    .map(row => row.querySelector('input[type="checkbox"]'))
                    .filter(checkbox => checkbox && !checkbox.disabled);
                const allVisibleSelected = selectable.length > 0 && selectable.every(checkbox => checkbox.checked);
                selectAll.textContent = allVisibleSelected ? tr('unmarkAll') : tr('markAll');
                status.textContent = `${visibleRows.length.toLocaleString('pt-BR')} Pokémon exibido(s) · Saldo: 💲${Number(shopData.gold || 0).toLocaleString('pt-BR')} · Selecionado: 💲${total.toLocaleString('pt-BR')}`;
            };
            const applyPokemonFilters = () => {
                const query = pokeSearch.value.trim().toLocaleLowerCase();
                const minIv = ivMinFilter.value === '' ? null : Number(ivMinFilter.value);
                const maxIv = ivMaxFilter.value === '' ? null : Number(ivMaxFilter.value);
                const minQuality = qualityMinFilter.value === '' ? null : Number(qualityMinFilter.value);
                const maxQuality = qualityMaxFilter.value === '' ? null : Number(qualityMaxFilter.value);
                const selectedTiers = new Set(tierButtons.filter(button => button.classList.contains('on')).map(button => button.dataset.tier));
                list.querySelectorAll('.hunt-sell-row').forEach(row => {
                    const shinyMatches = !shinyFilter.value
                        || (shinyFilter.value === 'shiny' && row.dataset.shiny === 'true')
                        || (shinyFilter.value === 'normal' && row.dataset.shiny !== 'true');
                    const show = (!query || row.dataset.searchName.includes(query))
                        && shinyMatches
                        && (minIv === null || Number(row.dataset.iv) >= minIv)
                        && (maxIv === null || Number(row.dataset.iv) <= maxIv)
                        && (minQuality === null || Number(row.dataset.quality) >= minQuality)
                        && (maxQuality === null || Number(row.dataset.quality) <= maxQuality)
                        && selectedTiers.has(row.dataset.tier);
                    row.hidden = !show;
                    if (!show) row.querySelector('input[type="checkbox"]').checked = false;
                });
                updateSummary();
            };
            list.addEventListener('change', updateSummary);
            [pokeSearch, shinyFilter, ivMinFilter, ivMaxFilter, qualityMinFilter, qualityMaxFilter].forEach(control => {
                control.addEventListener('input', applyPokemonFilters);
            });
            tierButtons.forEach(button => button.addEventListener('click', () => {
                button.classList.toggle('on');
                applyPokemonFilters();
            }));
            allTiersButton.addEventListener('click', () => {
                tierButtons.forEach(button => button.classList.add('on'));
                applyPokemonFilters();
            });
            noTiersButton.addEventListener('click', () => {
                tierButtons.forEach(button => button.classList.remove('on'));
                applyPokemonFilters();
            });
            selectAll.addEventListener('click', () => {
                const selectable = Array.from(list.querySelectorAll('.hunt-sell-row:not([hidden]) input[type="checkbox"]:not(:disabled)'));
                const shouldSelect = selectable.some(checkbox => !checkbox.checked);
                selectable.forEach(checkbox => { checkbox.checked = shouldSelect; });
                updateSummary();
            });
            updateSummary();
            applyPokemonFilters();

            submit.addEventListener('click', async () => {
                const pokeIds = Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
                    .map(checkbox => checkbox.dataset.pokeId);
                if (!pokeIds.length) return showScriptNotice('Selecione pelo menos um Pokémon.');
                if (!await showScriptConfirm(`Vender ${pokeIds.length} Pokémon selecionado(s)?`, { title: 'Confirmar venda', confirmLabel: 'Vender' })) return;
                submit.disabled = true;
                try {
                    const result = await gameApiRequest('/api/game/pokemon/sell', {
                        method: 'POST',
                        body: JSON.stringify({ pokeIds })
                    });
                    latestPokemon = null;
                    shopData.gold = Number(result.gold ?? shopData.gold ?? 0);
                    list.querySelectorAll('input[type="checkbox"]:checked').forEach(checkbox => checkbox.closest('.hunt-sell-row')?.remove());
                    applyPokemonFilters();
                    if (!list.querySelector('.hunt-sell-row')) footer.style.display = 'none';
                    showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), `Venda concluída: +💲${Number(result.goldGained || 0).toLocaleString('pt-BR')}`);
                    submit.disabled = false;
                    sendGameMessage({ type: 'pokes-get' });
                } catch (error) {
                    showScriptNotice(`Não foi possível concluir a venda: ${error.message}`, { title: 'Erro na venda', isError: true });
                    submit.disabled = false;
                }
            });
        } catch (error) {
            console.error('Falha ao carregar os Pokémon:', error);
            status.textContent = 'Não foi possível carregar os Pokémon.';
        }
    }

    function getMarketListings(payload) {
        if (Array.isArray(payload)) return payload;
        for (const key of ['listings', 'items', 'results', 'offers', 'data']) {
            if (Array.isArray(payload?.[key])) return payload[key];
            if (payload?.[key] && payload[key] !== payload) {
                const nested = getMarketListings(payload[key]);
                if (nested.length) return nested;
            }
        }
        return [];
    }

    function normalizeMarketCurrency(value) {
        const currency = String(value || 'GOLD').trim().toUpperCase();
        return /DIAM|^DD$/.test(currency) ? 'DIAMONDS' : 'GOLD';
    }

    function getMarketEntryPrice(entry) {
        return Number(entry?.price ?? entry?.totalPrice ?? entry?.value ?? 0);
    }

    function getMarketEntryCurrency(entry) {
        const ref = entry?.item || entry?.pokemon || entry?.product || {};
        return normalizeMarketCurrency(entry?.currency || entry?.currencyType || ref.currency || ref.currencyType);
    }

    function getLowestDiamondPdPrice(listings) {
        const prices = listings
            .filter(entry => getMarketEntryCurrency(entry) === 'GOLD')
            .map(getMarketEntryPrice)
            .filter(price => Number.isFinite(price) && price > 0);
        return prices.length ? Math.min(...prices) : null;
    }

    function getMarketEntryRefId(entry) {
        const ref = entry?.item || entry?.product || {};
        return entry?.refId ?? entry?.itemId ?? entry?.ballId ?? ref.refId ?? ref.id ?? ref.itemId ?? null;
    }

    function getMarketEntryKind(entry) {
        const ref = entry?.item || entry?.product || {};
        return String(entry?.kind || entry?.itemKind || ref.kind || '').trim().toLowerCase();
    }

    function isMarketPokemonEntry(entry) {
        const ref = entry?.pokemon || entry?.item || entry?.product || {};
        const kind = getMarketEntryKind(entry);
        if (/^(pokemon|pokémon|poke|creature)$/.test(kind)) return true;
        return Boolean(entry?.pokemon
            || entry?.pokemonId != null
            || entry?.speciesId != null
            || ref?.pokemonId != null
            || ref?.speciesId != null
            || ((entry?.ivTotal ?? ref?.ivTotal ?? entry?.iv ?? ref?.iv) != null && (entry?.stats || ref?.stats)));
    }

    function getMarketEntryImage(entry) {
        const ref = entry?.pokemon || entry?.item || entry?.product || {};
        const speciesId = entry?.speciesId ?? ref.speciesId;
        if (speciesId != null) {
            const pokemonIcon = getPokemonIconUrl(speciesId);
            if (pokemonIcon) return pokemonIcon;
        }
        const directIcon = entry?._scriptMarketIcon || entry?.iconUrl || entry?.imageUrl || entry?.icon || entry?.image || entry?.sprite
            || ref.iconUrl || ref.imageUrl || ref.icon || ref.image || ref.sprite;
        if (directIcon) {
            const iconPath = String(directIcon);
            if (/^assets\//i.test(iconPath)) return `/${iconPath}`;
            return normalizeGameItemIcon(iconPath);
        }
        const itemId = getMarketEntryRefId(entry);
        const name = entry?.name || entry?.title || entry?.itemName || ref.name || ref.title || '';
        const itemData = globalItemApiData.get(String(itemId)) || globalItemApiData.get(String(name).toLowerCase().trim());
        return normalizeGameItemIcon(itemData?.icon || itemData?.image || itemData?.sprite || '');
    }

    const MARKET_QUALITY_TIER_DEFINITIONS = Object.freeze([
        { id:'weak', label:'Fraca', min:0, max:1.0, color:'#64748b', aliases:['fraca','fragil','debil','weak','poor'] },
        { id:'common', label:'Comum', min:1.0, max:1.1, color:'#35d05b', aliases:['comum','comun','common'] },
        { id:'uncommon', label:'Incomum', min:1.1, max:1.3, color:'#38bdf8', aliases:['incomum','incomun','poco comun','uncommon'] },
        { id:'rare', label:'Rara', min:1.3, max:1.5, color:'#a855f7', aliases:['rara','raro','rare'] },
        { id:'epic', label:'Épica', min:1.5, max:1.7, color:'#facc15', aliases:['epica','epico','epic'] },
        { id:'legendary', label:'Lendária', min:1.7, max:2.0, color:'#f97316', aliases:['lendaria','lendario','legendaria','legendario','legendary'] },
        { id:'mythic', label:'Mítica', min:2.0, max:3.0, color:'#d946ef', aliases:['mitica','mitico','mythic'] },
        { id:'ancient', label:'Anciã', min:3.0, max:4.0, color:'#d5a800', aliases:['ancia','anciaa','ancestral','antigua','antiguo','ancient'] },
        { id:'divine', label:'Divina', min:4.0, max:Infinity, color:'#e2e8f0', aliases:['divina','divino','divine'] }
    ]);

    function normalizeMarketTier(value) {
        const normalized = String(value ?? '')
            .trim()
            .toLocaleLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9 ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return MARKET_QUALITY_TIER_DEFINITIONS.find(definition =>
            definition.id === normalized || definition.label.toLocaleLowerCase() === normalized || definition.aliases.includes(normalized)
        )?.id || '';
    }

    function getMarketQualityTierDefinition(value) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const quality = Number(value);
        if (!Number.isFinite(quality) || quality < 0) return null;
        return MARKET_QUALITY_TIER_DEFINITIONS.find(definition =>
            quality >= definition.min && (quality < definition.max || definition.max === Infinity)
        ) || null;
    }

    function getMarketPokemonQualityValue(entry) {
        const ref = entry?.pokemon || {};
        const candidates = [
            entry?.quality,
            ref?.quality,
            entry?.qualityValue,
            ref?.qualityValue,
            entry?.qualityMultiplier,
            ref?.qualityMultiplier,
            entry?.qualityMult,
            ref?.qualityMult,
            entry?.rarityMultiplier,
            ref?.rarityMultiplier,
            entry?.multiplier,
            ref?.multiplier
        ];

        for (const candidate of candidates) {
            const quality = Number(candidate);
            if (Number.isFinite(quality) && quality >= 0) return quality;
            const match = String(candidate ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
            const parsed = match ? Number(match[0]) : NaN;
            if (Number.isFinite(parsed) && parsed >= 0) return parsed;
        }

        return null;
    }

    function getMarketAlertTierIds(alert) {
        if (!Array.isArray(alert?.tiers)) return [];
        return [...new Set(alert.tiers.map(normalizeMarketTier).filter(Boolean))];
    }

    function getMarketPokemonQualityTheme(multiplier) {
        const definition = getMarketQualityTierDefinition(multiplier);
        return definition
            ? { id:definition.id, label:definition.label, color:definition.color }
            : null;
    }

    function getMarketItemRarityTheme(entry) {
        const ref = entry?.item || entry?.product || {};
        const itemId = getMarketEntryRefId(entry);
        const name = entry?.name || entry?.title || entry?.itemName || ref.name || ref.title || '';
        const catalogItem = globalItemApiData.get(String(itemId)) || globalItemApiData.get(String(name).toLowerCase().trim()) || {};
        const explicit = String(entry?.rarity ?? entry?.tier ?? ref.rarity ?? ref.tier ?? catalogItem.rarity ?? catalogItem.tier ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        const rareFlag = entry?.rare ?? ref.rare ?? catalogItem.rare;
        const themes = [
            { key:'divine', aliases:['divine','divino','divina'], color:'#e2e8f0', labelKey:'rarityDivine' },
            { key:'ancient', aliases:['ancient','ancestral','ancia','anciao'], color:'#d5a800', labelKey:'rarityAncient' },
            { key:'mythic', aliases:['mythic','mythical','mitico','mitica'], color:'#d946ef', labelKey:'rarityMythic' },
            { key:'legendary', aliases:['legendary','legendario','legendaria','lendario','lendaria'], color:'#f97316', labelKey:'rarityLegendary' },
            { key:'epic', aliases:['epic','epico','epica'], color:'#a855f7', labelKey:'rarityEpic' },
            { key:'rare', aliases:['rare','raro','rara'], color:'#38bdf8', labelKey:'rarityRare' },
            { key:'uncommon', aliases:['uncommon','incomum','poco comun'], color:'#35d05b', labelKey:'rarityUncommon' },
            { key:'common', aliases:['common','comum','comun'], color:'#94a3b8', labelKey:'rarityCommon' }
        ];
        const matched = themes.find(theme => theme.aliases.some(alias => explicit.includes(alias)))
            || themes.find(theme => theme.key === (rareFlag === true ? 'rare' : 'common'));
        return { ...matched, label: tr(matched.labelKey) };
    }

    function getMarketPokemonStatsHTML(stats) {
        const values = stats || {};
        return [
            ['HP', values.hp, 'hp'],
            ['ATK', values.atk, 'atk'],
            ['DEF', values.def, 'def'],
            ['SP.ATK', values.spAtk ?? values.spatk, 'spatk'],
            ['SP.DEF', values.spDef ?? values.spdef, 'spdef'],
            ['SPD', values.speed ?? values.spd, 'speed']
        ].filter(([, value]) => value != null && Number.isFinite(Number(value)))
            .map(([label, value, type]) => `<span class="market-stat market-stat-${type}">${label} <b>${escapeHTML(value)}</b></span>`)
            .join('');
    }

    const MARKET_POKEMON_TYPE_ALIASES = Object.freeze({
        normal:'normal', fire:'fire', fuego:'fire', water:'water', agua:'water', electric:'electric', electrico:'electric', eletrico:'electric',
        grass:'grass', planta:'grass', ice:'ice', hielo:'ice', gelo:'ice', fighting:'fighting', lucha:'fighting', lutador:'fighting',
        poison:'poison', veneno:'poison', ground:'ground', tierra:'ground', solo:'ground', flying:'flying', volador:'flying', voador:'flying',
        psychic:'psychic', psiquico:'psychic', psiquica:'psychic', bug:'bug', bicho:'bug', inseto:'bug', rock:'rock', roca:'rock', pedra:'rock',
        ghost:'ghost', fantasma:'ghost', dragon:'dragon', dark:'dark', siniestro:'dark', sombrio:'dark', steel:'steel', acero:'steel', aco:'steel',
        fairy:'fairy', hada:'fairy', fada:'fairy'
    });

    function normalizeMarketPokemonType(value) {
        const raw = typeof value === 'object' && value
            ? (value.type?.name ?? value.name ?? value.type ?? value.label ?? '')
            : value;
        const normalized = String(raw || '').trim().toLocaleLowerCase().normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]+/g, '');
        return MARKET_POKEMON_TYPE_ALIASES[normalized] || normalized;
    }

    function getMarketPokemonTypes(entry) {
        const ref = entry?.pokemon || entry?.item || entry?.product || {};
        const directTypes = [
            ...(Array.isArray(entry?.types) ? entry.types : []), entry?.type1, entry?.type2, entry?.type_1, entry?.type_2,
            ...(Array.isArray(ref?.types) ? ref.types : []), ref?.type1, ref?.type2, ref?.type_1, ref?.type_2
        ].filter(Boolean);
        const rawName = entry?.name || entry?.pokemonName || entry?.title || ref?.name || ref?.pokemonName || ref?.title || '';
        const cleanName = normalizePokemonName(cleanMarketIvPokemonName(rawName));
        let catalogCreature = null;
        if (!directTypes.length) {
            catalogCreature = cleanName ? globalCreatureApiData.get(cleanName) : null;
            const speciesId = Number(entry?.speciesId ?? entry?.pokeId ?? entry?.pokemonId ?? ref?.speciesId ?? ref?.pokeId ?? ref?.pokemonId);
            if (!catalogCreature && Number.isFinite(speciesId)) {
                catalogCreature = [...new Set(globalCreatureApiData.values())].find(creature =>
                    Number(creature?.speciesId ?? creature?.pokeId ?? creature?.pokemonId ?? creature?.id) === speciesId) || null;
            }
        }
        const fallbackTypes = directTypes.length ? [] : [
            ...(Array.isArray(catalogCreature?.types) ? catalogCreature.types : []), catalogCreature?.type1, catalogCreature?.type2,
            catalogCreature?.type_1, catalogCreature?.type_2, ...(POKEMON_TYPES[cleanName] || [])
        ].filter(Boolean);
        const seen = new Set();
        return [...directTypes, ...fallbackTypes].reduce((types, value) => {
            const key = normalizeMarketPokemonType(value);
            if (!key || seen.has(key) || types.length >= 2) return types;
            seen.add(key);
            const raw = typeof value === 'object' && value
                ? (value.type?.name ?? value.name ?? value.type ?? value.label ?? key)
                : value;
            types.push({ key, label:String(raw || key).trim() });
            return types;
        }, []);
    }

    function getMarketPokemonTypesHTML(entry) {
        const types = getMarketPokemonTypes(entry);
        if (!types.length) return '';
        return `<span class="market-pokemon-types" aria-label="Tipos: ${escapeHTML(types.map(type => type.label).join(', '))}">${types
            .map(type => `<span class="market-pokemon-type" data-pokemon-type="${escapeHTML(type.key)}">${escapeHTML(type.label)}</span>`)
            .join('')}</span>`;
    }

    const STORAGE_MARKET_IV_BASE_STATS = 'script_market_iv_base_stats_v1';
    const marketIvBaseStatsRequests = new Map();
    let marketIvBaseStatsCache = {};
    try {
        const storedMarketIvStats = JSON.parse(localStorage.getItem(STORAGE_MARKET_IV_BASE_STATS) || '{}');
        if (storedMarketIvStats && typeof storedMarketIvStats === 'object' && !Array.isArray(storedMarketIvStats)) {
            marketIvBaseStatsCache = storedMarketIvStats;
        }
    } catch (_) {
        marketIvBaseStatsCache = {};
    }

    const MARKET_IV_STAT_DEFINITIONS = Object.freeze([
        { key:'hp', label:'HP', formulaType:'hp', currentKeys:['hp','health'] },
        { key:'atk', label:'ATK', formulaType:'atk', currentKeys:['atk','attack'] },
        { key:'def', label:'DEF', formulaType:'def', currentKeys:['def','defense'] },
        { key:'spa', label:'SP.ATK', formulaType:'spa', currentKeys:['spAtk','spatk','specialAttack','special_attack'] },
        { key:'spd', label:'SP.DEF', formulaType:'spd', currentKeys:['spDef','spdef','specialDefense','special_defense'] },
        { key:'vel', label:'VEL', formulaType:'vel', currentKeys:['speed','vel','spd'] }
    ]);

    // Catálogo oficial integrado: [pokeId,nombre,HP,ATK,DEF,SP.ATK,SP.DEF,VEL].
    // Evita depender de red, CSP o del orden de carga de creatures.json.
    const MARKET_IV_BUILTIN_BASE_STATS = Object.freeze([
        [1,"Bulbasaur",45,49,49,65,65,45],
        [2,"Ivysaur",60,62,63,80,80,60],
        [3,"Venusaur",80,82,83,100,100,80],
        [4,"Charmander",39,52,43,60,50,65],
        [5,"Charmeleon",58,64,58,80,65,80],
        [6,"Charizard",78,84,78,109,85,100],
        [7,"Squirtle",44,48,65,50,64,43],
        [8,"Wartortle",59,63,80,65,80,58],
        [9,"Blastoise",79,83,100,85,105,78],
        [10,"Caterpie",45,30,35,20,20,45],
        [11,"Metapod",50,20,55,25,25,30],
        [12,"Butterfree",60,45,50,90,80,70],
        [13,"Weedle",40,35,30,20,20,50],
        [14,"Kakuna",45,25,50,25,25,35],
        [15,"Beedrill",65,90,40,45,80,75],
        [16,"Pidgey",40,45,40,35,35,56],
        [17,"Pidgeotto",63,60,55,50,50,71],
        [18,"Pidgeot",83,80,75,70,70,101],
        [19,"Rattata",30,56,35,25,35,72],
        [20,"Raticate",55,81,60,50,70,97],
        [21,"Spearow",40,60,30,31,31,70],
        [22,"Fearow",65,90,65,61,61,100],
        [23,"Ekans",35,60,44,40,54,55],
        [24,"Arbok",60,95,69,65,79,80],
        [25,"Pikachu",35,55,40,50,50,90],
        [26,"Raichu",60,90,55,90,80,110],
        [27,"Sandshrew",50,75,85,20,30,40],
        [28,"Sandslash",75,100,110,45,55,65],
        [29,"Nidoran Female",55,47,52,40,40,41],
        [30,"Nidorina",70,62,67,55,55,56],
        [31,"Nidoqueen",90,92,87,75,85,76],
        [32,"Nidoran Male",46,57,40,40,40,50],
        [33,"Nidorino",61,72,57,55,55,65],
        [34,"Nidoking",81,102,77,85,75,85],
        [35,"Clefairy",70,45,48,60,65,35],
        [36,"Clefable",95,70,73,95,90,60],
        [37,"Vulpix",38,41,40,50,65,65],
        [38,"Ninetales",73,76,75,81,100,100],
        [39,"Jigglypuff",115,45,20,45,25,20],
        [40,"Wigglytuff",140,70,45,85,50,45],
        [41,"Zubat",40,45,35,30,40,55],
        [42,"Golbat",75,80,70,65,75,90],
        [43,"Oddish",45,50,55,75,65,30],
        [44,"Gloom",60,65,70,85,75,40],
        [45,"Vileplume",75,80,85,110,90,50],
        [46,"Paras",35,70,55,45,55,25],
        [47,"Parasect",60,95,80,60,80,30],
        [48,"Venonat",60,55,50,40,55,45],
        [49,"Venomoth",70,65,60,90,75,90],
        [50,"Diglett",10,55,25,35,45,95],
        [51,"Dugtrio",35,100,50,50,70,120],
        [52,"Meowth",40,45,35,40,40,90],
        [53,"Persian",65,70,60,65,65,115],
        [54,"Psyduck",50,52,48,65,50,55],
        [55,"Golduck",80,82,78,95,80,85],
        [56,"Mankey",40,80,35,35,45,70],
        [57,"Primeape",65,105,60,60,70,95],
        [58,"Growlithe",55,70,45,70,50,60],
        [59,"Arcanine",90,110,80,100,80,95],
        [60,"Poliwag",40,50,40,40,40,90],
        [61,"Poliwhirl",65,65,65,50,50,90],
        [62,"Poliwrath",90,95,95,70,90,70],
        [63,"Abra",25,20,15,105,55,90],
        [64,"Kadabra",40,35,30,120,70,105],
        [65,"Alakazam",55,50,45,135,95,120],
        [66,"Machop",70,80,50,35,35,35],
        [67,"Machoke",80,100,70,50,60,45],
        [68,"Machamp",90,130,80,65,85,55],
        [69,"Bellsprout",50,75,35,70,30,40],
        [70,"Weepinbell",65,90,50,85,45,55],
        [71,"Victreebel",80,105,65,100,70,70],
        [72,"Tentacool",40,40,35,50,100,70],
        [73,"Tentacruel",80,70,65,80,120,100],
        [74,"Geodude",40,80,100,30,30,20],
        [75,"Graveler",55,95,115,45,45,35],
        [76,"Golem",80,120,130,55,65,45],
        [77,"Ponyta",50,85,55,65,65,90],
        [78,"Rapidash",65,100,70,80,80,105],
        [79,"Slowpoke",90,65,65,40,40,15],
        [80,"Slowbro",95,75,110,100,80,30],
        [81,"Magnemite",25,35,70,95,55,45],
        [82,"Magneton",50,60,95,120,70,70],
        [83,"Farfetchd",52,90,55,58,62,60],
        [84,"Doduo",35,85,45,35,35,75],
        [85,"Dodrio",60,110,70,60,60,110],
        [86,"Seel",65,45,55,45,70,45],
        [87,"Dewgong",90,70,80,70,95,70],
        [88,"Grimer",80,80,50,40,50,25],
        [89,"Muk",105,105,75,65,100,50],
        [90,"Shellder",30,65,100,45,25,40],
        [91,"Cloyster",50,95,180,85,45,70],
        [92,"Gastly",30,35,30,100,35,80],
        [93,"Haunter",45,50,45,115,55,95],
        [94,"Gengar",60,65,60,130,75,110],
        [95,"Onix",35,45,160,30,45,70],
        [96,"Drowzee",60,48,45,43,90,42],
        [97,"Hypno",85,73,70,73,115,67],
        [98,"Krabby",30,105,90,25,25,50],
        [99,"Kingler",55,130,115,50,50,75],
        [100,"Voltorb",40,30,50,55,55,100],
        [101,"Electrode",60,50,70,80,80,150],
        [102,"Exeggcute",60,40,80,60,45,40],
        [103,"Exeggutor",95,95,85,125,75,55],
        [104,"Cubone",50,50,95,40,50,35],
        [105,"Marowak",60,80,110,50,80,45],
        [106,"Hitmonlee",50,120,53,35,110,87],
        [107,"Hitmonchan",50,105,79,35,110,76],
        [108,"Lickitung",90,55,75,60,75,30],
        [109,"Koffing",40,65,95,60,45,35],
        [110,"Weezing",65,90,120,85,70,60],
        [111,"Rhyhorn",80,85,95,30,30,25],
        [112,"Rhydon",105,130,120,45,45,40],
        [113,"Chansey",250,5,5,35,105,50],
        [114,"Tangela",65,55,115,100,40,60],
        [115,"Kangaskhan",105,95,80,40,80,90],
        [116,"Horsea",30,40,70,70,25,60],
        [117,"Seadra",55,65,95,95,45,85],
        [118,"Goldeen",45,67,60,35,50,63],
        [119,"Seaking",80,92,65,65,80,68],
        [120,"Staryu",30,45,55,70,55,85],
        [121,"Starmie",60,75,85,100,85,115],
        [122,"Mr. Mime",40,45,65,100,120,90],
        [123,"Scyther",70,110,80,55,80,105],
        [124,"Jynx",65,50,35,115,95,95],
        [125,"Electabuzz",65,83,57,95,85,105],
        [126,"Magmar",65,95,57,100,85,93],
        [127,"Pinsir",65,125,100,55,70,85],
        [128,"Tauros",75,100,95,40,70,110],
        [129,"Magikarp",20,10,55,15,20,80],
        [130,"Gyarados",95,125,79,60,100,81],
        [131,"Lapras",130,85,80,85,95,60],
        [132,"Ditto",48,48,48,48,48,48],
        [133,"Eevee",55,55,50,45,65,55],
        [134,"Vaporeon",130,65,60,110,95,65],
        [135,"Jolteon",65,65,60,110,95,130],
        [136,"Flareon",65,130,60,95,110,65],
        [137,"Porygon",65,60,70,85,75,40],
        [138,"Omanyte",35,40,100,90,55,35],
        [139,"Omastar",70,60,125,115,70,55],
        [140,"Kabuto",30,80,90,55,45,55],
        [141,"Kabutops",60,115,105,65,70,80],
        [142,"Aerodactyl",80,105,65,60,75,130],
        [143,"Snorlax",160,110,65,65,110,30],
        [144,"Articuno",90,85,100,95,125,85],
        [145,"Zapdos",90,90,85,125,90,100],
        [146,"Moltres",90,100,90,125,85,90],
        [147,"Dratini",41,64,45,50,50,50],
        [148,"Dragonair",61,84,65,70,70,70],
        [149,"Dragonite",91,134,95,100,100,80],
        [150,"Mewtwo",106,110,90,154,90,130],
        [151,"Mew",100,100,100,100,100,100],
        [152,"Chikorita",45,49,65,49,65,45],
        [153,"Bayleef",60,62,80,63,80,60],
        [154,"Meganium",80,82,100,83,100,80],
        [155,"Cyndaquil",39,52,43,60,50,65],
        [156,"Quilava",58,64,58,80,65,80],
        [157,"Typhlosion",78,84,78,109,85,100],
        [158,"Totodile",50,65,64,44,48,43],
        [159,"Croconaw",65,80,80,59,63,58],
        [160,"Feraligatr",85,105,100,79,83,78],
        [161,"Sentret",35,46,34,35,45,20],
        [162,"Furret",85,76,64,45,55,90],
        [163,"Hoothoot",60,30,30,36,56,50],
        [164,"Noctowl",100,50,50,86,96,70],
        [165,"Ledyba",40,20,30,40,80,55],
        [166,"Ledian",55,35,50,55,110,85],
        [167,"Spinarak",40,60,40,40,40,30],
        [168,"Ariados",70,90,70,60,70,40],
        [169,"Crobat",85,90,80,70,80,130],
        [170,"Chinchou",75,38,38,56,56,67],
        [171,"Lanturn",125,58,58,76,76,67],
        [172,"Pichu",20,40,15,35,35,60],
        [173,"Cleffa",50,25,28,45,55,15],
        [174,"Igglybuff",90,30,15,40,20,15],
        [175,"Togepi",35,20,65,40,65,20],
        [176,"Togetic",55,40,85,80,105,40],
        [177,"Natu",40,50,45,70,45,70],
        [178,"Xatu",65,75,70,95,70,95],
        [179,"Mareep",55,40,40,65,45,35],
        [180,"Flaaffy",70,55,55,80,60,45],
        [181,"Ampharos",90,75,85,115,90,55],
        [182,"Bellossom",75,80,95,90,100,50],
        [183,"Marill",70,20,50,20,50,40],
        [184,"Azumarill",100,50,80,60,80,50],
        [185,"Sudowoodo",70,100,115,30,65,30],
        [186,"Politoed",90,75,75,90,100,70],
        [187,"Hoppip",35,35,40,35,55,50],
        [188,"Skiploom",55,45,50,45,65,80],
        [189,"Jumpluff",75,55,70,55,95,110],
        [190,"Aipom",55,70,55,40,55,85],
        [191,"Sunkern",30,30,30,30,30,30],
        [192,"Sunflora",75,75,55,105,85,30],
        [193,"Yanma",65,65,45,75,45,95],
        [194,"Wooper",55,45,45,25,25,15],
        [195,"Quagsire",95,85,85,65,65,35],
        [196,"Espeon",65,65,60,130,95,110],
        [197,"Umbreon",95,65,110,60,130,65],
        [198,"Murkrow",60,85,42,85,42,91],
        [199,"Slowking",95,75,80,100,110,30],
        [200,"Misdreavus",60,60,60,85,85,85],
        [201,"Unown",48,72,48,72,48,48],
        [202,"Wobbuffet",190,33,58,33,58,33],
        [203,"Girafarig",70,80,65,90,65,85],
        [204,"Pineco",50,65,90,35,35,15],
        [205,"Forretress",75,90,140,60,60,40],
        [206,"Dunsparce",100,70,70,65,65,45],
        [207,"Gligar",65,75,105,35,65,85],
        [208,"Steelix",75,85,200,55,65,30],
        [209,"Snubbull",60,80,50,40,40,30],
        [210,"Granbull",90,120,75,60,60,45],
        [211,"Qwilfish",65,95,85,55,55,85],
        [212,"Scizor",70,130,100,55,80,65],
        [213,"Shuckle",20,10,230,10,230,5],
        [214,"Heracross",80,125,75,40,95,85],
        [215,"Sneasel",55,95,55,35,75,115],
        [216,"Teddiursa",60,80,50,50,50,40],
        [217,"Ursaring",90,130,75,75,75,55],
        [218,"Slugma",40,40,40,70,40,20],
        [219,"Magcargo",60,50,120,90,80,30],
        [220,"Swinub",50,50,40,30,30,50],
        [221,"Piloswine",100,100,80,60,60,50],
        [222,"Corsola",65,55,95,65,95,35],
        [223,"Remoraid",35,65,35,65,35,65],
        [224,"Octillery",75,105,75,105,75,45],
        [225,"Delibird",45,55,45,65,45,75],
        [226,"Mantine",85,40,70,80,140,70],
        [227,"Skarmory",65,80,140,40,70,70],
        [228,"Houndour",45,60,30,80,50,65],
        [229,"Houndoom",75,90,50,110,80,95],
        [230,"Kingdra",75,95,95,95,95,85],
        [231,"Phanpy",90,60,60,40,40,40],
        [232,"Donphan",90,120,120,60,60,50],
        [233,"Porygon2",85,80,90,105,95,60],
        [234,"Stantler",73,95,62,85,65,85],
        [235,"Smeargle",55,20,35,20,45,75],
        [236,"Tyrogue",35,35,35,35,35,35],
        [237,"Hitmontop",50,95,95,35,110,70],
        [238,"Smoochum",45,30,15,85,65,65],
        [239,"Elekid",45,63,37,65,55,95],
        [240,"Magby",45,75,37,70,55,83],
        [241,"Miltank",95,80,105,40,70,100],
        [242,"Blissey",255,10,10,75,135,55],
        [243,"Raikou",90,85,75,115,100,115],
        [244,"Entei",115,115,85,90,75,100],
        [245,"Suicune",100,75,115,90,115,85],
        [246,"Larvitar",50,64,50,45,50,41],
        [247,"Pupitar",70,84,70,65,70,51],
        [248,"Tyranitar",100,134,110,95,100,61],
        [249,"Lugia",106,90,130,90,154,110],
        [250,"Ho-oh",106,130,90,110,154,90],
        [251,"Celebi",100,100,100,100,100,100],
        [252,"Treecko",40,45,35,65,55,70],
        [253,"Grovyle",50,65,45,85,65,95],
        [254,"Sceptile",70,85,65,105,85,120],
        [255,"Torchic",45,60,40,70,50,45],
        [256,"Combusken",60,85,60,85,60,55],
        [257,"Blaziken",80,120,70,110,70,80],
        [258,"Mudkip",50,70,50,50,50,40],
        [259,"Marshtomp",70,85,70,60,70,50],
        [260,"Swampert",100,110,90,85,90,60],
        [261,"Poochyena",35,55,35,30,30,35],
        [262,"Mightyena",70,90,70,60,60,70],
        [270,"Lotad",40,30,30,40,50,30],
        [271,"Lombre",60,50,50,60,70,50],
        [272,"Ludicolo",80,70,70,90,100,70],
        [273,"Seedot",40,40,50,30,30,30],
        [274,"Nuzleaf",70,70,40,60,40,60],
        [275,"Shiftry",90,100,60,90,60,80],
        [276,"Taillow",40,55,30,30,30,85],
        [277,"Swellow",60,85,60,75,50,125],
        [278,"Wingull",40,30,30,55,30,85],
        [279,"Pelipper",60,50,100,95,70,65],
        [280,"Ralts",28,25,25,45,35,40],
        [281,"Kirlia",38,35,35,65,55,50],
        [282,"Gardevoir",68,65,65,125,115,80],
        [287,"Slakoth",60,60,60,35,35,30],
        [288,"Vigoroth",80,80,80,55,55,90],
        [289,"Slaking",150,160,100,95,65,100],
        [293,"Whismur",64,51,23,51,23,28],
        [294,"Loudred",84,71,43,71,43,48],
        [295,"Exploud",104,91,63,91,73,68],
        [296,"Makuhita",72,60,30,20,30,25],
        [302,"Sableye",50,75,75,65,65,50],
        [303,"Mawile",50,85,85,55,55,50],
        [304,"Aron",50,70,100,40,40,30],
        [305,"Lairon",60,90,140,50,50,40],
        [306,"Aggron",70,110,180,60,60,50],
        [307,"Meditite",30,40,55,40,55,60],
        [308,"Medicham",60,60,75,60,75,80],
        [309,"Electrike",40,45,40,65,40,65],
        [310,"Manectric",70,75,60,105,60,105],
        [322,"Numel",60,60,40,65,45,35],
        [323,"Camerupt",70,100,70,105,75,40],
        [324,"Torkoal",70,85,140,85,70,20],
        [325,"Spoink",60,25,35,70,80,60],
        [326,"Grumpig",80,45,65,90,110,80],
        [328,"Trapinch",45,100,45,45,45,10],
        [329,"Vibrava",50,70,50,50,50,70],
        [330,"Flygon",80,100,80,80,80,100],
        [332,"Cacturne",70,115,60,115,60,55],
        [333,"Swablu",45,40,60,40,75,50],
        [334,"Altaria",75,70,90,70,105,80],
        [335,"Zangoose",73,115,60,60,60,90],
        [336,"Seviper",73,100,60,100,60,65],
        [341,"Corphish",43,80,65,50,35,35],
        [342,"Crawdaunt",63,120,85,90,55,55],
        [343,"Baltoy",40,40,55,40,70,55],
        [344,"Claydol",60,70,105,70,120,75],
        [349,"Feebas",20,15,20,10,55,80],
        [350,"Milotic",95,60,79,100,125,81],
        [354,"Banette",64,115,65,83,63,65],
        [355,"Duskull",20,40,90,30,90,25],
        [356,"Dusclops",40,70,130,60,130,25],
        [357,"Tropius",99,68,83,72,87,51],
        [359,"Absol",65,130,60,75,60,75],
        [361,"Snorunt",50,50,50,50,50,50],
        [362,"Glalie",80,80,80,80,80,80],
        [363,"Spheal",70,40,50,55,50,25],
        [364,"Sealeo",90,60,70,75,70,45],
        [365,"Walrein",110,80,90,95,90,65],
        [371,"Bagon",45,75,60,40,30,50],
        [372,"Shelgon",65,95,100,60,50,50],
        [373,"Salamence",95,135,80,110,80,100],
        [374,"Beldum",40,55,80,35,60,30],
        [375,"Metang",60,75,100,55,80,50],
        [376,"Metagross",80,135,130,95,90,70],
        [410,"Shieldon",30,42,118,42,88,30],
        [411,"Bastiodon",60,52,168,47,138,30],
        [416,"Vespiquen",70,80,102,80,102,40],
        [417,"Pachirisu",60,45,70,45,90,95],
        [428,"Lopunny",65,76,84,54,96,105],
        [447,"Riolu",40,70,40,35,40,60],
        [448,"Lucario",70,110,70,115,70,90],
        [464,"Rhyperior",115,140,130,55,55,40],
        [465,"Tangrowth",100,100,125,110,50,50],
        [466,"Electivire",75,123,67,95,85,95],
        [467,"Magmortar",75,95,67,125,95,83],
        [472,"Gliscor",75,95,125,45,75,95],
        [477,"Dusknoir",45,100,135,65,135,45],
        [538,"Throh",120,100,85,30,85,45],
        [539,"Sawk",75,125,75,30,75,85],
        [564,"Tirtouga",54,78,103,53,45,22],
        [565,"Carracosta",74,108,133,83,65,32],
        [566,"Archen",55,112,45,74,45,70],
        [567,"Archeops",75,140,65,112,65,110],
        [636,"Larvesta",55,85,55,50,55,60],
        [637,"Volcarona",85,60,65,135,105,100],
        [669,"Flabebe",44,38,39,61,79,42],
        [670,"Floette",54,45,47,75,98,52],
        [671,"Florges",78,65,68,112,154,75],
        [674,"Pancham",67,82,62,46,48,43],
        [675,"Pangoro",95,124,78,69,71,58],
        [681,"Aegislash",60,50,140,50,140,60],
        [690,"Skrelp",50,60,60,60,60,30],
        [691,"Dragalge",65,75,90,97,123,44],
        [10001,"Blastoise",79,83,100,85,105,78],
        [10501,"Brave Blastoise",79,83,100,85,105,78],
        [10502,"Tribal Feraligatr",85,105,100,79,83,78],
        [10503,"Ancient Meganium",80,82,100,83,100,80],
        [10504,"Brave Venusaur",80,82,83,100,100,80],
        [10505,"War Heracross",80,125,75,40,95,85],
        [10506,"Furious Scyther",70,110,80,55,80,105],
        [10507,"Enigmatic Girafarig",70,80,65,90,65,85],
        [10508,"Charged Raichu",60,90,55,90,80,110],
        [10509,"Furious Ampharos",90,75,85,115,90,55],
        [10510,"Magnetic Electabuzz",65,83,57,95,85,105],
        [10511,"Ancient Dragonair",61,84,65,70,70,70],
        [10512,"Evil Cloyster",50,95,180,85,45,70],
        [10513,"Freezing Dewgong",90,70,80,70,95,70],
        [10514,"Psy Jynx",65,50,35,115,95,95],
        [10515,"Heavy Piloswine",100,100,80,60,60,50],
        [10516,"Milch-Miltank",95,80,105,40,70,100],
        [10517,"Roll Donphan",90,120,120,60,60,50],
        [10518,"Furious Sandslash",75,100,110,45,55,65],
        [10519,"Hard Golem",80,120,130,55,65,45],
        [10520,"Brute Rhydon",105,130,120,45,45,40],
        [10521,"Brave Charizard",78,84,78,109,85,100],
        [10522,"Enraged Typhlosion",78,84,78,109,85,100],
        [10523,"Brave Nidoking",81,102,77,85,75,85],
        [10524,"Brave Nidoqueen",90,92,87,75,85,76],
        [10525,"Dark Crobat",85,90,80,70,80,130],
        [10526,"Trickmaster Gengar",60,65,60,130,75,110],
        [10527,"Banshee Misdreavus",60,60,60,85,85,85],
        [10528,"Taekwondo Hitmonchan",50,105,79,35,110,76],
        [10529,"Taekwondo Hitmonlee",50,120,53,35,110,87],
        [10530,"Taekwondo Hitmontop",50,95,95,35,110,70],
        [10531,"Brave Arcanine",90,110,80,100,80,95],
        [10532,"Furious Magmar",65,95,57,100,85,93],
        [10533,"Ancient Pupitar",70,84,70,65,70,51],
        [10534,"Brave Steelix",75,85,200,55,65,30],
        [10535,"Furious Wigglytuff",140,70,45,85,50,45],
        [10536,"Ancient Xatu",65,75,70,95,70,95],
        [10537,"Brave Alakazam",55,50,45,135,95,120],
        [10538,"Ancient Hypno",85,73,70,73,115,67],
        [10539,"Furious Gyarados",95,125,79,60,100,81],
        [10540,"Brave Mantine",85,40,70,80,140,70],
        [10541,"Ancient Pinsir",65,125,100,55,70,85],
        [10542,"Brave Clefable",95,70,73,95,90,60],
        [10543,"Ancient Granbull",90,120,75,60,60,45],
        [10544,"Furious Skarmory",65,80,140,40,70,70],
        [10545,"Brave Noctowl",100,50,50,86,96,70],
        [10546,"Furious Pidgeot",83,80,75,70,70,101],
        [10547,"Ancient Marowak",60,80,110,50,80,45],
        [13252,"Treecko",53,45,35,65,55,70],
        [13253,"Grovyle",57,65,45,85,65,95],
        [13254,"Sceptile",63,85,65,105,85,120],
        [13255,"Torchic",55,60,40,70,50,45],
        [13256,"Combusken",60,85,60,85,60,55],
        [13257,"Blaziken",65,120,70,110,70,80],
        [13258,"Mudkip",57,70,50,50,50,40],
        [13259,"Marshtomp",70,85,70,60,70,50],
        [13260,"Swampert",78,110,90,85,90,60],
        [13261,"Poochyena",51,55,35,30,30,35],
        [13262,"Mightyena",63,90,70,60,60,70],
        [13270,"Lotad",53,30,30,40,50,30],
        [13271,"Lombre",60,50,50,60,70,50],
        [13272,"Ludicolo",65,70,70,90,100,70],
        [13273,"Seedot",53,40,50,30,30,30],
        [13274,"Nuzleaf",70,70,40,60,40,60],
        [13275,"Shiftry",75,100,60,90,60,80],
        [13276,"Taillow",53,55,30,30,30,85],
        [13277,"Swellow",60,85,60,75,50,125],
        [13278,"Wingull",59,30,30,55,30,85],
        [13279,"Pelipper",67,50,100,95,70,65],
        [13280,"Ralts",48,25,25,45,35,40],
        [13281,"Kirlia",52,35,35,65,55,50],
        [13282,"Gardevoir",62,65,65,125,115,80],
        [13287,"Slakoth",60,60,60,35,35,30],
        [13288,"Vigoroth",65,80,80,55,55,90],
        [13293,"Whismur",61,51,23,51,23,28],
        [13294,"Loudred",66,71,43,71,43,48],
        [13295,"Exploud",71,91,63,91,73,68],
        [13296,"Makuhita",63,60,30,20,30,25],
        [13302,"Sableye",57,75,75,65,65,50],
        [13303,"Mawile",57,85,85,55,55,50],
        [13304,"Aron",63,70,100,40,40,30],
        [13305,"Lairon",67,90,140,50,50,40],
        [13306,"Aggron",70,110,180,60,60,50],
        [13307,"Meditite",49,40,55,40,55,60],
        [13308,"Medicham",60,60,75,60,75,80],
        [13309,"Electrike",53,45,40,65,40,65],
        [13310,"Manectric",63,75,60,105,60,105],
        [13322,"Numel",67,60,40,65,45,35],
        [13323,"Camerupt",70,100,70,105,75,40],
        [13324,"Torkoal",63,85,140,85,70,20],
        [13325,"Spoink",60,25,35,70,80,60],
        [13326,"Grumpig",65,45,65,90,110,80],
        [13328,"Trapinch",55,100,45,45,45,10],
        [13329,"Vibrava",63,70,50,50,50,70],
        [13330,"Flygon",73,100,80,80,80,100],
        [13332,"Cacturne",70,115,60,115,60,55],
        [13333,"Swablu",55,40,60,40,75,50],
        [13334,"Altaria",71,70,90,70,105,80],
        [13335,"Zangoose",64,115,60,60,60,90],
        [13336,"Seviper",64,100,60,100,60,65],
        [13341,"Corphish",54,80,65,50,35,35],
        [13342,"Crawdaunt",61,120,85,90,55,55],
        [13343,"Baltoy",53,40,55,40,70,55],
        [13344,"Claydol",60,70,105,70,120,75],
        [13354,"Banette",61,115,65,83,63,65],
        [13355,"Duskull",43,40,90,30,90,25],
        [13356,"Dusclops",53,70,130,60,130,25],
        [13357,"Tropius",78,68,83,72,87,51],
        [13359,"Absol",61,130,60,75,60,75],
        [13361,"Snorunt",57,50,50,50,50,50],
        [13362,"Glalie",65,80,80,80,80,80],
        [13363,"Spheal",63,40,50,55,50,25],
        [13364,"Sealeo",68,60,70,75,70,45],
        [13365,"Walrein",72,80,90,95,90,65],
        [13371,"Bagon",55,75,60,40,30,50],
        [13372,"Shelgon",61,95,100,60,50,50],
        [13374,"Beldum",53,55,80,35,60,30],
        [13375,"Metang",60,75,100,55,80,50],
        [13447,"Riolu",53,70,40,35,40,60],
        [13448,"Lucario",63,110,70,115,70,90],
        [14009,"Mega Blastoise",79,103,120,135,115,78],
        [14065,"Mega Alakazam",55,50,65,175,105,150],
        [14282,"Mega Gardevoir",68,85,65,165,135,100],
        [14302,"Mega Sableye",50,85,125,85,115,20],
        [14334,"Mega Altaria",75,110,110,110,105,80],
        [14351,"Castform Fire",70,70,70,70,70,70],
        [14448,"Mega Lucario",70,145,88,140,70,112]
    ]);

    function getFirstFiniteNumber(source, keys, fallback = 0) {
        for (const key of keys) {
            const value = Number(source?.[key]);
            if (Number.isFinite(value)) return value;
        }
        return fallback;
    }

    function calculateMarketExactIv(statType, currentStat, baseStat, level, quality) {
        const S = Number(currentStat);
        const B = Number(baseStat);
        const L = Number(level);
        const Q = Number(quality);
        if (![S, B, L, Q].every(Number.isFinite) || L <= 0 || Q <= 0) return null;
        const factor = (L / 100) * Math.pow(Q, statType === 'hp' || statType === 'vel' ? 0.95 : 0.80);
        if (!Number.isFinite(factor) || factor <= 0) return null;
        const exactIv = ((S / factor) - B) / 2;
        return Math.max(0, Math.min(32, Number(exactIv.toFixed(1))));
    }

    function getMarketIvClassification(percent) {
        const value = Number(percent) || 0;
        if (value < 42) return { label:'Débil', tone:'poor' };
        if (value < 58) return { label:'Promedio', tone:'average' };
        if (value < 75) return { label:'Bueno', tone:'good' };
        if (value < 88) return { label:'Muy bueno', tone:'very-good' };
        if (value < 98) return { label:'Excelente', tone:'great' };
        return { label:'Perfecto', tone:'perfect' };
    }

    function getMarketIvStatClassification(percent) {
        const value = Number(percent) || 0;
        if (value < 45) return { label:'Débil', tone:'poor' };
        if (value < 60) return { label:'Promedio', tone:'average' };
        if (value < 90) return { label:'Bueno', tone:'good' };
        if (value < 100) return { label:'Excelente', tone:'great' };
        return { label:'Perfecto', tone:'perfect' };
    }

    function getMarketIvQualityTag(quality) {
        const value = Number(quality) || 0;
        if (value < 1) return { label:'DEFICIENTE', color:'#f87171' };
        if (value < 1.1) return { label:'COMÚN', color:'#94a3b8' };
        if (value < 1.3) return { label:'POCO COMÚN', color:'#4ade80' };
        if (value < 1.5) return { label:'RARA', color:'#38bdf8' };
        if (value < 1.7) return { label:'ÉPICA', color:'#c084fc' };
        if (value < 2) return { label:'LEGENDARIA', color:'#fbbf24' };
        if (value < 3) return { label:'MÍTICA', color:'#f43f5e' };
        if (value < 4) return { label:'ANCIANA', color:'#fdba74' };
        return { label:'DIVINA', color:'#ffffff' };
    }

    function normalizeMarketIvBaseStats(raw) {
        const source = raw?.baseStats || raw?.base_stats || raw?.stats || raw || {};
        const normalized = {
            hp:getFirstFiniteNumber(source, ['hp','baseHp','base_hp','health']),
            atk:getFirstFiniteNumber(source, ['attack','atk','baseAtk','baseAttack','base_atk','base_attack']),
            def:getFirstFiniteNumber(source, ['defense','def','baseDef','baseDefense','base_def','base_defense']),
            spa:getFirstFiniteNumber(source, ['specialAttack','spAtk','spatk','special_attack','baseSpAtk','baseSpecialAttack','base_sp_atk','base_sp_attack']),
            spd:getFirstFiniteNumber(source, ['specialDefense','spDef','spdef','special_defense','baseSpDef','baseSpecialDefense','base_sp_def','base_sp_defense']),
            vel:getFirstFiniteNumber(source, ['speed','vel','baseSpeed','base_speed'])
        };
        return Object.values(normalized).every(value => Number.isFinite(value) && value > 0) ? normalized : null;
    }

    function cleanMarketIvPokemonName(value) {
        const rawName = String(value || '').trim();
        if (!rawName) return '';
        const cleaned = rawName
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\([^)]*\)/g, ' ')
            .replace(/\s*(?:[·|—–-]\s*)?\b(?:lv(?:l)?|level|nivel|n[ií]vel|nv)\.?\s*[:#=-]?\s*\d+\b.*$/i, ' ')
            .replace(/\s*[·|]\s*(?:iv|q|quality|calidad).*$/i, ' ')
            .replace(/^(?:shiny|ancient|shadow)\s+/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        const normalized = normalizePokemonName(cleaned || rawName);
        const catalogCreature = globalCreatureApiData.get(normalized);
        return String(catalogCreature?.name || cleaned || rawName).trim();
    }

    function getMarketIvPokemonData(entry) {
        const ref = entry?.pokemon || entry?.item || entry?.product || {};
        const stats = entry?.stats || ref?.stats || {};
        const rawName = String(entry?.name || entry?.pokemonName || entry?.title || ref?.name || ref?.title || 'Pokémon').trim();
        const name = cleanMarketIvPokemonName(rawName) || rawName;
        return {
            name,
            rawName,
            speciesId:entry?.speciesId ?? entry?.pokeId ?? ref?.speciesId ?? ref?.pokeId ?? entry?.pokemonId ?? ref?.pokemonId,
            level:Math.max(1, getFirstFiniteNumber(stats, ['level','lvl'], getFirstFiniteNumber(entry, ['level','lvl'], getFirstFiniteNumber(ref, ['level','lvl'], 1)))),
            quality:Math.max(0.01, getFirstFiniteNumber(stats, ['quality','q'], getFirstFiniteNumber(entry, ['quality','q','multiplier','mult'], getFirstFiniteNumber(ref, ['quality','q','multiplier','mult'], 1)))),
            ivTotal:entry?.ivTotal ?? ref?.ivTotal ?? entry?.iv ?? ref?.iv,
            sprite:getMarketEntryImage(entry),
            embeddedBaseStats:normalizeMarketIvBaseStats(entry?.baseStats || entry?.base_stats || ref?.baseStats || ref?.base_stats || null),
            current:Object.fromEntries(MARKET_IV_STAT_DEFINITIONS.map(stat => [stat.key, getFirstFiniteNumber(stats, stat.currentKeys, null)]))
        };
    }

    function getMarketIvCacheKeys(data) {
        const numericId = Number(data?.speciesId);
        const cleanName = normalizePokemonName(cleanMarketIvPokemonName(data?.name));
        return [...new Set([
            Number.isInteger(numericId) && numericId > 0 ? `id:${numericId}` : '',
            cleanName ? `name:${cleanName}` : ''
        ].filter(Boolean))];
    }

    function getMarketIvCacheKey(data) {
        return getMarketIvCacheKeys(data)[0] || 'name:unknown';
    }

    function findMarketIvBuiltinBaseStats(data) {
        const numericId = Number(data?.speciesId);
        let row = Number.isFinite(numericId)
            ? MARKET_IV_BUILTIN_BASE_STATS.find(candidate => candidate[0] === numericId)
            : null;
        if (!row) {
            const cleanName = normalizePokemonName(cleanMarketIvPokemonName(data?.name));
            // Se recorre desde el final porque el catálogo oficial puede contener
            // variantes actuales con el mismo nombre y un pokeId más reciente.
            for (let index = MARKET_IV_BUILTIN_BASE_STATS.length - 1; index >= 0; index -= 1) {
                if (normalizePokemonName(MARKET_IV_BUILTIN_BASE_STATS[index][1]) === cleanName) {
                    row = MARKET_IV_BUILTIN_BASE_STATS[index];
                    break;
                }
            }
        }
        if (!row) return null;
        return {
            id:row[0], name:row[1],
            stats:{ hp:row[2], atk:row[3], def:row[4], spa:row[5], spd:row[6], vel:row[7] }
        };
    }

    function saveMarketIvBaseStats(data, stats) {
        getMarketIvCacheKeys(data).forEach(key => { marketIvBaseStatsCache[key] = stats; });
        const compactEntries = Object.entries(marketIvBaseStatsCache).slice(-160);
        marketIvBaseStatsCache = Object.fromEntries(compactEntries);
        try { localStorage.setItem(STORAGE_MARKET_IV_BASE_STATS, JSON.stringify(marketIvBaseStatsCache)); }
        catch (_) { /* La calculadora sigue funcionando aunque el almacenamiento esté lleno. */ }
    }

    function getLegacyMarketIvBaseStats(data) {
        try {
            const legacyCache = JSON.parse(localStorage.getItem('pokeidle_basestats_cache') || '{}');
            if (!legacyCache || typeof legacyCache !== 'object') return null;
            const candidates = [data?.speciesId, data?.name, normalizePokemonName(data?.name)]
                .filter(value => value != null && String(value).trim());
            for (const candidate of candidates) {
                const stats = normalizeMarketIvBaseStats(legacyCache[String(candidate)] || legacyCache[String(candidate).toLowerCase()]);
                if (stats) return stats;
            }
        } catch (_) { /* La caché del userscript original es opcional. */ }
        return null;
    }

    function findMarketIvCatalogCreature(data) {
        const cleanName = normalizePokemonName(cleanMarketIvPokemonName(data?.name));
        let creature = cleanName ? globalCreatureApiData.get(cleanName) : null;
        if (!creature && data?.speciesId != null) {
            const speciesId = Number(data.speciesId);
            creature = [...new Set(globalCreatureApiData.values())].find(candidate =>
                Number(candidate?.speciesId ?? candidate?.pokemonId ?? candidate?.pokeId ?? candidate?.id) === speciesId);
        }
        return creature || null;
    }

    function getMarketIvPokeApiIdentifier(data, creature) {
        const numericId = Number(creature?.pokeId ?? creature?.speciesId ?? creature?.pokemonId ?? data?.speciesId);
        if (Number.isInteger(numericId) && numericId > 0 && numericId <= 2000) return String(numericId);
        const normalized = normalizePokemonName(cleanMarketIvPokemonName(data?.name));
        const aliases = {
            'mr mime':'mr-mime', 'mime jr':'mime-jr', 'nidoran female':'nidoran-f', 'nidoran male':'nidoran-m',
            'ho oh':'ho-oh', 'porygon z':'porygon-z', 'type null':'type-null', 'jangmo o':'jangmo-o',
            'hakamo o':'hakamo-o', 'kommo o':'kommo-o', 'tapu koko':'tapu-koko', 'tapu lele':'tapu-lele',
            'tapu bulu':'tapu-bulu', 'tapu fini':'tapu-fini'
        };
        return aliases[normalized] || normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    async function loadMarketIvBaseStats(data) {
        const keys = getMarketIvCacheKeys(data);
        const key = keys[0] || getMarketIvCacheKey(data);
        const embedded = normalizeMarketIvBaseStats(data?.embeddedBaseStats);
        if (embedded) {
            saveMarketIvBaseStats(data, embedded);
            return { stats:embedded, source:'Datos de la publicación' };
        }
        const builtIn = findMarketIvBuiltinBaseStats(data);
        if (builtIn) {
            const integratedData = { ...data, speciesId:data?.speciesId ?? builtIn.id, name:builtIn.name || data?.name };
            saveMarketIvBaseStats(integratedData, builtIn.stats);
            return { stats:builtIn.stats, source:'Catálogo IV integrado del juego' };
        }
        for (const cacheKey of keys) {
            const cached = normalizeMarketIvBaseStats(marketIvBaseStatsCache[cacheKey]);
            if (cached) return { stats:cached, source:'Caché local' };
        }
        const legacy = getLegacyMarketIvBaseStats(data);
        if (legacy) {
            saveMarketIvBaseStats(data, legacy);
            return { stats:legacy, source:'Caché Exact IV Scanner' };
        }
        if (marketIvBaseStatsRequests.has(key)) return marketIvBaseStatsRequests.get(key);
        const request = (async () => {
            let creature = findMarketIvCatalogCreature(data);
            let catalogStats = normalizeMarketIvBaseStats(creature);
            if (!catalogStats) {
                await loadExternalPokemonData();
                creature = findMarketIvCatalogCreature(data);
                catalogStats = normalizeMarketIvBaseStats(creature);
            }
            if (catalogStats) {
                const catalogData = { ...data, speciesId:data?.speciesId ?? creature?.pokeId ?? creature?.speciesId ?? creature?.id };
                saveMarketIvBaseStats(catalogData, catalogStats);
                return { stats:catalogStats, source:'Catálogo oficial del juego' };
            }
            const apiIdentifier = getMarketIvPokeApiIdentifier(data, creature);
            if (!apiIdentifier) throw new Error('No se pudo identificar el Pokémon.');
            const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(apiIdentifier)}`);
            if (!response.ok) throw new Error(`PokeAPI respondió ${response.status}.`);
            const payload = await response.json();
            const pokeApiStats = {};
            (payload.stats || []).forEach(stat => { pokeApiStats[stat?.stat?.name] = Number(stat?.base_stat); });
            const stats = normalizeMarketIvBaseStats({
                hp:pokeApiStats.hp,
                attack:pokeApiStats.attack,
                defense:pokeApiStats.defense,
                specialAttack:pokeApiStats['special-attack'],
                specialDefense:pokeApiStats['special-defense'],
                speed:pokeApiStats.speed
            });
            if (!stats) throw new Error('La respuesta no contiene todas las estadísticas base.');
            saveMarketIvBaseStats(data, stats);
            return { stats, source:'PokeAPI · guardado en caché' };
        })().finally(() => marketIvBaseStatsRequests.delete(key));
        marketIvBaseStatsRequests.set(key, request);
        return request;
    }

    function updateMarketIvCalculator(panel) {
        if (!panel) return;
        const level = Math.max(1, Number(panel.querySelector('[data-iv-field="level"]')?.value) || 1);
        const quality = Math.max(0.01, Number(panel.querySelector('[data-iv-field="quality"]')?.value) || 1);
        let totalIv = 0;
        let completeStats = 0;
        let currentTotal = 0;
        MARKET_IV_STAT_DEFINITIONS.forEach(stat => {
            const currentInput = panel.querySelector(`[data-iv-current="${stat.key}"]`);
            const hasCurrent = currentInput?.value.trim() !== '';
            const current = Number(currentInput?.value) || 0;
            const base = Number(panel.querySelector(`[data-iv-base="${stat.key}"]`)?.value) || 0;
            const iv = base > 0 && hasCurrent ? calculateMarketExactIv(stat.formulaType, current, base, level, quality) : null;
            const output = panel.querySelector(`[data-iv-output="${stat.key}"]`);
            const fill = panel.querySelector(`[data-iv-fill="${stat.key}"]`);
            currentTotal += current;
            if (iv != null) {
                totalIv += iv;
                completeStats += 1;
                const percent = Math.max(0, Math.min(100, (iv / 32) * 100));
                const rating = getMarketIvStatClassification(percent);
                output.textContent = `${iv.toFixed(1)} / 32 · ${rating.label}`;
                output.dataset.tone = rating.tone;
                fill.style.width = `${percent}%`;
                fill.dataset.tone = rating.tone;
            } else {
                output.textContent = 'Base pendiente';
                output.dataset.tone = '';
                fill.style.width = '0%';
                fill.dataset.tone = '';
            }
        });
        const exactIvTotal = completeStats === MARKET_IV_STAT_DEFINITIONS.length ? Math.max(0, Math.min(192, totalIv)) : null;
        const ivPercent = exactIvTotal == null ? 0 : (exactIvTotal / 192) * 100;
        const rating = getMarketIvClassification(ivPercent);
        panel.querySelector('.market-iv-total').textContent = exactIvTotal == null ? '— / 192' : `${exactIvTotal.toFixed(1)} / 192`;
        panel.querySelector('.market-iv-percent').textContent = exactIvTotal == null ? 'Esperando base' : `${ivPercent.toFixed(1)}% · ${rating.label}`;
        panel.querySelector('.market-iv-ring').style.setProperty('--iv-progress', `${ivPercent * 3.6}deg`);
        panel.querySelector('.market-iv-ring').dataset.tone = exactIvTotal == null ? '' : rating.tone;
        panel.querySelector('.market-iv-power').textContent = Math.round(currentTotal * quality).toLocaleString();
        panel.querySelector('.market-iv-level-warning').hidden = level > 1;
        const qualityTag = getMarketIvQualityTag(quality);
        const qualityTagElement = panel.querySelector('.market-iv-quality-tag');
        qualityTagElement.textContent = qualityTag.label;
        qualityTagElement.style.setProperty('--iv-quality-color', qualityTag.color);
    }

    function ensureMarketIvStage(backdrop) {
        let stage = backdrop.querySelector('.market-iv-stage');
        if (stage) return stage;
        const marketWindow = backdrop.querySelector('.script-market-window');
        if (!marketWindow) return backdrop;
        stage = document.createElement('div');
        stage.className = 'market-iv-stage';
        marketWindow.before(stage);
        stage.appendChild(marketWindow);
        return stage;
    }

    function ensureMarketIvCalculator(backdrop) {
        let panel = backdrop.querySelector('.market-iv-calculator');
        if (panel) return panel;
        panel = document.createElement('aside');
        panel.className = 'market-iv-calculator';
        panel.setAttribute('aria-hidden', 'true');
        panel.setAttribute('aria-label', 'Calculadora IV');
        panel.innerHTML = `
            <header class="market-iv-head">
                <div><small>ANÁLISIS NATIVO</small><b>Calculadora IV</b></div>
                <button class="market-iv-close" type="button" aria-label="Cerrar calculadora">×</button>
            </header>
            <div class="market-iv-scroll">
                <section class="market-iv-identity">
                    <div class="market-iv-sprite"><span>◉</span></div>
                    <label class="market-iv-name-field"><small>POKÉMON</small><input data-iv-field="name" type="text" autocomplete="off"></label>
                    <button class="market-iv-reload" type="button" title="Volver a consultar las estadísticas base">↻</button>
                </section>
                <section class="market-iv-inputs">
                    <label><small>NIVEL</small><input data-iv-field="level" type="number" min="1" step="1"></label>
                    <label><small>CALIDAD</small><input data-iv-field="quality" type="number" min="0.01" step="0.01"><span class="market-iv-quality-tag"></span></label>
                </section>
                <p class="market-iv-level-warning" hidden>En nivel 1 el redondeo del juego reduce la precisión. Se recomienda comprobar desde nivel 15.</p>
                <section class="market-iv-summary">
                    <div class="market-iv-ring" data-tone=""><div><b class="market-iv-total">— / 192</b><small class="market-iv-percent">Esperando base</small></div></div>
                    <div class="market-iv-power-box"><small>PODER ESTIMADO</small><b class="market-iv-power">0</b><span>Σ stats × calidad</span></div>
                </section>
                <div class="market-iv-table-head"><span>STAT</span><span>ACTUAL</span><span>BASE</span></div>
                <section class="market-iv-stat-list">
                    ${MARKET_IV_STAT_DEFINITIONS.map(stat => `
                        <article class="market-iv-stat-row">
                            <b>${stat.label}</b>
                            <input data-iv-current="${stat.key}" type="number" min="0" step="1" aria-label="${stat.label} actual">
                            <input data-iv-base="${stat.key}" type="number" min="1" step="1" aria-label="${stat.label} base">
                            <small data-iv-output="${stat.key}">Base pendiente</small>
                            <span class="market-iv-bar"><i data-iv-fill="${stat.key}"></i></span>
                        </article>`).join('')}
                </section>
                <p class="market-iv-source">Selecciona una card Pokémon para analizarla.</p>
            </div>`;
        ensureMarketIvStage(backdrop).appendChild(panel);
        const close = () => {
            backdrop.classList.remove('market-iv-open');
            panel.classList.remove('is-open');
            panel.setAttribute('aria-hidden', 'true');
            backdrop.querySelectorAll('.market-iv-active').forEach(row => row.classList.remove('market-iv-active'));
            if (typeof applyBetterWindowScales === 'function') requestAnimationFrame(applyBetterWindowScales);
        };
        panel._closeMarketIv = close;
        panel.querySelector('.market-iv-close').addEventListener('click', close);
        panel.querySelectorAll('input[type="number"]').forEach(input => input.addEventListener('input', () => updateMarketIvCalculator(panel)));
        const reload = () => openMarketIvCalculator(backdrop, panel._marketIvEntry, { force:true });
        panel.querySelector('.market-iv-reload').addEventListener('click', reload);
        panel.querySelector('[data-iv-field="name"]').addEventListener('change', () => openMarketIvCalculator(backdrop, panel._marketIvEntry, { force:true, useName:true }));
        return panel;
    }

    async function openMarketIvCalculator(backdrop, entry, options = {}) {
        if (!entry) return;
        const panel = ensureMarketIvCalculator(backdrop);
        const data = getMarketIvPokemonData(entry);
        const requestToken = (panel._marketIvRequestToken || 0) + 1;
        panel._marketIvRequestToken = requestToken;
        panel._marketIvEntry = entry;
        backdrop.classList.add('market-iv-open');
        panel.classList.add('is-open');
        panel.setAttribute('aria-hidden', 'false');
        if (typeof applyBetterWindowScales === 'function') requestAnimationFrame(applyBetterWindowScales);
        backdrop.querySelectorAll('.market-iv-active').forEach(row => row.classList.remove('market-iv-active'));
        const nameField = panel.querySelector('[data-iv-field="name"]');
        if (!options.force) nameField.value = data.name;
        const lookupData = { ...data, name:nameField.value.trim() || data.name };
        if (options.useName) lookupData.speciesId = null;
        panel.querySelector('[data-iv-field="level"]').value = String(data.level);
        panel.querySelector('[data-iv-field="quality"]').value = String(data.quality);
        MARKET_IV_STAT_DEFINITIONS.forEach(stat => {
            panel.querySelector(`[data-iv-current="${stat.key}"]`).value = data.current[stat.key] == null ? '' : String(data.current[stat.key]);
            panel.querySelector(`[data-iv-base="${stat.key}"]`).value = '';
        });
        const sprite = panel.querySelector('.market-iv-sprite');
        sprite.innerHTML = data.sprite ? `<img src="${escapeHTML(data.sprite)}" alt="${escapeHTML(data.name)}">` : '<span>◉</span>';
        sprite.querySelector('img')?.addEventListener('error', event => event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent:'◉' })), { once:true });
        const source = panel.querySelector('.market-iv-source');
        source.textContent = 'Consultando estadísticas base…';
        source.dataset.state = 'loading';
        updateMarketIvCalculator(panel);
        try {
            if (options.force) getMarketIvCacheKeys(lookupData).forEach(key => { delete marketIvBaseStatsCache[key]; });
            const result = await loadMarketIvBaseStats(lookupData);
            if (panel._marketIvRequestToken !== requestToken || !panel.isConnected) return;
            MARKET_IV_STAT_DEFINITIONS.forEach(stat => {
                panel.querySelector(`[data-iv-base="${stat.key}"]`).value = String(result.stats[stat.key]);
            });
            source.textContent = `${result.source} · Fórmula Exact IV Scanner`;
            source.dataset.state = 'ready';
            updateMarketIvCalculator(panel);
        } catch (error) {
            if (panel._marketIvRequestToken !== requestToken || !panel.isConnected) return;
            source.textContent = `No se obtuvo la base: ${error.message} Puedes introducirla manualmente.`;
            source.dataset.state = 'error';
            updateMarketIvCalculator(panel);
        }
    }

    function showGlobalMarketWindow() {
        markMarketSalesRead();
        const previousMarketBackdrop = document.querySelector('.script-market-backdrop');
        if (previousMarketBackdrop?._marketCategoryIconTimer) clearInterval(previousMarketBackdrop._marketCategoryIconTimer);
        previousMarketBackdrop?.remove();
        const backdrop = document.createElement('div');
        backdrop.className = 'script-market-backdrop';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div class="mk-window script-market-window" style="width:min(1180px,94vw);max-width:94vw;height:min(720px,88vh);display:flex;flex-direction:column;background:#0c161f;border:1px solid #2b4c66;border-radius:10px;box-shadow:0 16px 50px rgba(0,0,0,.75);">
                <div class="mk-head" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1a2d3a;">
                    <div class="market-head-primary">
                        <b>🌐 ${tr('globalMarket')}</b>
                        <div class="market-player-balance" title="${tr('currentBalance')}">
                            <span class="market-balance-label">${tr('currentBalance')}</span>
                            <span class="market-balance-pill gold"><span class="market-balance-icon">💲</span><span class="market-balance-gold">—</span></span>
                            <span class="market-balance-pill diamonds"><span class="market-balance-icon">💎</span><span class="market-balance-diamonds">—</span></span>
                        </div>
                    </div>
                    <span class="market-exchange-rate" style="color:#90cdf4;font-size:12px;white-space:nowrap;"></span>
                    <button class="mk-bulk-btn market-refresh" type="button">↻ ${tr('refresh')}</button>
                    <button class="cfg-x market-close" type="button" aria-label="Close">×</button>
                </div>
                <div class="script-market-tabs" style="display:flex;gap:6px;padding:10px 12px 0;">
                    <button class="mk-bulk-btn market-tab on" data-mode="buy" type="button"><img src="/assets/market/tab_buy.png" alt=""><span class="market-tab-label">${tr('buyTab')}</span></button>
                    <button class="mk-bulk-btn market-tab market-featured-tab" data-mode="featured" type="button"><span aria-hidden="true">◆</span><span class="market-tab-label">${tr('marketFeatured')}</span></button>
                    <button class="mk-bulk-btn market-tab" data-mode="sell" type="button"><img src="/assets/market/tab_sell.png" alt=""><span class="market-tab-label">${tr('sellTab')}</span></button>
                    <button class="mk-bulk-btn market-tab market-mine-tab" data-mode="mine" type="button"><img src="/assets/market/tab_mine.png" alt=""><span class="market-tab-label">${tr('marketMyListings')}</span><span class="market-tab-count">0</span></button>
                    <button class="mk-bulk-btn market-tab" data-mode="requests" type="button"><img src="/assets/market/tab_requests.png" alt=""><span class="market-tab-label">${tr('marketRequests')}</span></button>
                    <button class="mk-bulk-btn market-tab" data-mode="history" type="button"><img src="/assets/market/tab_history.png" alt=""><span class="market-tab-label">${tr('marketHistory')}</span></button>
                    <button class="mk-bulk-btn market-filters-toggle" type="button" aria-expanded="false"><span aria-hidden="true">⚙</span><span class="market-filters-toggle-label">${tr('marketAdvancedFilters')}</span><span class="market-filters-chevron" aria-hidden="true">⌄</span></button>
                    <div class="market-view-toggle" aria-label="Vista del mercado">
                        <button class="mk-bulk-btn market-view-btn" data-view="cards" type="button">▦ <span class="market-view-text">${tr('cards')}</span></button>
                        <button class="mk-bulk-btn market-view-btn" data-view="list" type="button">☷ <span class="market-view-text">${tr('list')}</span></button>
                    </div>
                </div>
                <div class="market-favorites-bar"><span class="market-favorites-label">★ ${tr('marketFavorites')}</span><button class="market-favorites-scroll market-favorites-prev" type="button" aria-label="${tr('marketFavoritesPrevious')}">‹</button><div class="market-favorites-list" style="display:flex;gap:6px;"></div><button class="market-favorites-scroll market-favorites-next" type="button" aria-label="${tr('marketFavoritesNext')}">›</button></div>
                <div class="market-alert-controls" hidden inert aria-hidden="true">
                    <!-- Alertas retiradas en 10.1.0: se conserva el texto legado
                         dentro de un comentario para compatibilidad de mantenimiento,
                         pero el navegador no crea ningún control ni panel en el DOM.
                    <div class="market-alert-heading"><span>🔔 ${tr('alertCreate')} <small class="market-alert-account-context">👤 —</small><small class="market-item-auto-status"></small></span><span style="display:flex;align-items:center;gap:5px;"><span class="market-alert-kind-tabs"><button class="market-alert-kind-tab on" data-alert-kind="pokemon" type="button">Pokémon</button><button class="market-alert-kind-tab" data-alert-kind="item" type="button">Objetos</button></span><label class="market-alert-auto-buy"><input class="market-alert-auto-buy-input" type="checkbox"> Auto. Pokémon</label><label class="market-alert-auto-buy"><input class="market-item-alert-auto-buy-input" type="checkbox"> Auto. objetos</label><button class="market-alert-paste" type="button">📋 ${tr('alertPasteFilters')}</button><button class="market-telegram-toggle" type="button">✈ ${tr('telegram')}</button><button class="market-alert-rules-toggle" type="button">📋 ${tr('alertActiveRules')} <b class="market-alert-rules-count">0</b></button></span></div>
                    <div class="market-alert-tiers"><span class="market-sell-tier-label">${tr('depotTierFilter')}</span><span class="market-sell-tier-actions"><button class="market-sell-tier-action market-alert-tier-all" type="button">${tr('depotAllTiers')}</button><button class="market-sell-tier-action market-alert-tier-none" type="button">${tr('depotNoTiers')}</button></span><span class="market-sell-tier-buttons market-alert-tier-buttons"></span></div>
                    <div class="market-alert-form market-alert-pokemon-form">
                        <input class="market-alert-name" type="search" list="market-alert-pokemon-names" autocomplete="off" placeholder="${tr('alertNamePlaceholder')}" title="${tr('alertName')}">
                        <datalist id="market-alert-pokemon-names"></datalist>
                        <select class="market-alert-currency" title="Moneda"><option value="ALL">${tr('all')}</option><option value="GOLD">💲 ${tr('gold')}</option><option value="DIAMONDS">💎 ${tr('diamonds')}</option></select>
                        <label class="market-alert-price-field"><input class="market-alert-price-min" type="number" min="0" step="0.01" placeholder="${tr('alertPriceMin')}"><small class="market-alert-price-min-display">—</small></label>
                        <label class="market-alert-price-field"><input class="market-alert-price-max" type="number" min="0" step="0.01" placeholder="${tr('alertPriceMax')}"><small class="market-alert-price-max-display">—</small></label>
                        <label><input class="market-alert-shiny" type="checkbox"> ${tr('shinyOnly')}</label>
                        <input class="market-alert-iv-min" type="number" min="0" max="192" placeholder="${tr('minIv')}">
                        <input class="market-alert-iv-max" type="number" min="0" max="192" placeholder="${tr('maxIv')}">
                        <input class="market-alert-level-min" type="number" min="1" placeholder="${tr('minLevel')}">
                        <input class="market-alert-level-max" type="number" min="1" placeholder="${tr('maxLevel')}">
                        <select class="market-alert-type"><option value="">${tr('allTypes')}</option></select>
                        <button class="mk-bulk-btn market-alert-create" type="button">🔔 ${tr('alertCreate')}</button><button class="mk-bulk-btn market-alert-edit-cancel" type="button" hidden>Cancelar</button>
                    </div>
                    <div class="market-alert-form market-alert-item-form" hidden>
                        <input class="market-item-alert-name" type="search" list="market-alert-item-names" autocomplete="off" placeholder="Ej. Ultra Ball" title="Nombre del objeto (opcional)"><datalist id="market-alert-item-names"></datalist>
                        <select class="market-item-alert-currency" title="Moneda"><option value="ALL">${tr('all')}</option><option value="GOLD">💲 ${tr('gold')}</option><option value="DIAMONDS">💎 ${tr('diamonds')}</option></select>
                        <label class="market-alert-price-field"><input class="market-item-alert-price-min" type="number" min="0" step="0.01" placeholder="Precio mín."><small class="market-item-alert-price-min-display">—</small></label>
                        <label class="market-alert-price-field"><input class="market-item-alert-price-max" type="number" min="0" step="0.01" placeholder="Precio máx."><small class="market-item-alert-price-max-display">—</small></label>
                        <input class="market-item-alert-quantity-min" type="number" min="1" placeholder="Cantidad mín.">
                        <button class="mk-bulk-btn market-item-alert-create" type="button">🔔 Crear alerta de objeto</button><button class="mk-bulk-btn market-item-alert-edit-cancel" type="button" hidden>Cancelar</button>
                    </div>
                    <section class="market-alert-rules-panel" hidden><div class="market-alert-rules-dialog" role="dialog" aria-modal="true" aria-label="Alertas activas"><div class="market-alert-rules-panel-head"><b>${tr('alertActiveRules')}</b><span class="market-alert-rules-actions"><span class="market-alert-rules-tabs"><button class="market-alert-rules-tab on" data-alert-rule-kind="pokemon" type="button">Pokémon</button><button class="market-alert-rules-tab" data-alert-rule-kind="item" type="button">Objetos</button></span><button class="market-alert-clear-all" type="button">🗑 Eliminar todas</button><button class="market-alert-export" type="button">⇩ ${tr('alertExport')}</button><button class="market-alert-import" type="button">⇧ ${tr('alertImport')}</button><button class="market-alert-rules-close" type="button" aria-label="Close">×</button></span></div><div class="market-alert-rules"></div></div></section>
                    <section class="market-alert-transfer-panel" hidden><div class="market-alert-rules-panel-head"><b class="market-alert-transfer-title"></b><button class="market-alert-transfer-close" type="button" aria-label="Close">×</button></div><small class="market-alert-transfer-help"></small><textarea class="market-alert-transfer-data" spellcheck="false"></textarea><div class="market-alert-transfer-actions"><button class="mk-bulk-btn market-alert-transfer-confirm" type="button"></button><button class="mk-bulk-btn market-alert-transfer-close" type="button">Cerrar</button></div></section>
                    <section class="market-telegram-panel" hidden><div class="market-alert-rules-panel-head"><b>✈ ${tr('telegramSettings')}</b><button class="market-telegram-close" type="button" aria-label="Close">×</button></div><label><span>${tr('telegramToken')}</span><input class="market-telegram-token" type="password" autocomplete="new-password" spellcheck="false"></label><label><span>${tr('telegramChatId')}</span><input class="market-telegram-chat-id" type="text" inputmode="numeric" autocomplete="off" spellcheck="false"></label><label class="market-telegram-enabled"><input class="market-telegram-enabled-input" type="checkbox"> ${tr('telegramEnabled')}</label><div><button class="mk-bulk-btn market-telegram-save" type="button">${tr('telegramSave')}</button><button class="mk-bulk-btn market-telegram-test" type="button">${tr('telegramTest')}</button></div></section>
                    -->
                </div>
                <div class="market-buy-controls" style="display:flex;gap:6px;padding:10px 12px 0;flex-wrap:wrap;">
                    <select class="market-category" style="background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 9px;">
                        <option value="All">${tr('all')}</option>
                        <option value="Items" selected>${tr('items')}</option>
                        <option value="Stones">${tr('stones')}</option>
                        <option value="Poke Balls">${tr('pokeBalls')}</option>
                        <option value="Diamonds">${tr('diamonds')}</option>
                        <option value="Pokemon">${tr('pokemon')}</option>
                    </select>
                    <select class="market-sort" style="background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 9px;">
                        <option value="recent">${tr('recent')}</option>
                        <option value="price-asc">${tr('lowestPrice')}</option>
                        <option value="price-desc">${tr('highestPrice')}</option>
                        <option value="iv-desc">${tr('highestIv')}</option>
                        <option value="power-desc">${tr('highestPower')}</option>
                        <option value="level-desc">${tr('highestLevel')}</option>
                        <option value="quality-desc">${tr('highestQuality')}</option>
                    </select>
                    <select class="market-item-rarity-filter" title="${tr('itemRarity')}" style="background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 9px;"><option value="">${tr('allRarities')}</option></select>
                    <input class="market-search" type="search" placeholder="${tr('search')}" style="flex:1;min-width:180px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 9px;">
                    <label style="display:flex;align-items:center;gap:5px;color:#a0aec0;font-size:12px;"><input class="market-show-gold" type="checkbox" checked> 💲 ${tr('gold')}</label>
                    <label style="display:flex;align-items:center;gap:5px;color:#a0aec0;font-size:12px;"><input class="market-show-diamonds" type="checkbox" checked> 💎 ${tr('diamonds')}</label>
                </div>
                <div class="market-pokemon-filters" style="display:none;gap:6px;padding:7px 12px 0;flex-wrap:wrap;">
                    <label style="display:flex;align-items:center;gap:5px;color:#a0aec0;font-size:12px;"><input class="market-shiny-only" type="checkbox"> ${tr('shinyOnly')}</label>
                    <input class="market-iv-min" type="number" min="0" max="192" placeholder="${tr('minIv')}" style="width:72px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-iv-max" type="number" min="0" max="192" placeholder="${tr('maxIv')}" style="width:72px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-level-min" type="number" min="1" placeholder="${tr('minLevel')}" style="width:82px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-level-max" type="number" min="1" placeholder="${tr('maxLevel')}" style="width:82px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-quality-min" type="number" min="0" step="0.01" placeholder="${tr('minQuality')}" style="width:88px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-quality-max" type="number" min="0" step="0.01" placeholder="${tr('maxQuality')}" style="width:88px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <select class="market-type" style="min-width:130px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;"><option value="">${tr('allTypes')}</option></select>
                </div>
                <div class="market-sell-quality-tiers market-buy-quality-tiers">
                    <span class="market-sell-tier-label">${tr('depotTierFilter')}</span>
                    <span class="market-sell-tier-actions"><button class="market-sell-tier-action market-buy-tier-all" type="button">${tr('depotAllTiers')}</button><button class="market-sell-tier-action market-buy-tier-none" type="button">${tr('depotNoTiers')}</button></span>
                    <span class="market-sell-tier-buttons market-buy-tier-buttons"></span>
                </div>
                <div class="market-sell-controls" style="display:none;padding:10px 12px 0;gap:7px;flex-wrap:wrap;">
                    <select class="market-sell-kind"><option value="item">Itens</option><option value="pokemon">Pokémon</option></select>
                    <input class="market-sell-search" type="search" placeholder="Buscar para vender...">
                    <input class="market-sell-iv-min" type="number" min="0" max="192" placeholder="IV mín.">
                    <input class="market-sell-quality-min" type="number" min="0" step="0.01" placeholder="Qualidade mín.">
                    <select class="market-sell-type"><option value="">Todos os tipos</option></select>
                </div>
                <div class="market-sell-quality-tiers market-sell-only-quality-tiers">
                    <span class="market-sell-tier-label">${tr('depotTierFilter')}</span>
                    <span class="market-sell-tier-actions"><button class="market-sell-tier-action market-sell-tier-all" type="button">${tr('depotAllTiers')}</button><button class="market-sell-tier-action market-sell-tier-none" type="button">${tr('depotNoTiers')}</button></span>
                    <span class="market-sell-tier-buttons market-sell-only-tier-buttons"></span>
                </div>
                <div class="market-sell-quality-tiers market-mine-quality-tiers">
                    <span class="market-sell-tier-label">${tr('depotTierFilter')}</span>
                    <span class="market-sell-tier-actions"><button class="market-sell-tier-action market-mine-tier-all" type="button">${tr('depotAllTiers')}</button><button class="market-sell-tier-action market-mine-tier-none" type="button">${tr('depotNoTiers')}</button></span>
                    <span class="market-sell-tier-buttons market-mine-tier-buttons"></span>
                </div>
                <div class="market-sell-editor" hidden>
                    <button class="market-sell-editor-close" type="button" aria-label="${tr('closeSelection')}">×</button>
                    <button class="market-sell-editor-lock" type="button" hidden>🔓</button>
                    <div class="market-sell-editor-art"><span>◉</span></div>
                    <div class="market-sell-editor-info">
                        <small class="market-kind-label">${tr('selectedToSell')}</small>
                        <b class="market-sell-editor-name">—</b>
                        <small class="market-sell-editor-meta"></small>
                        <small class="market-sell-editor-stats market-stats"></small>
                        <small class="market-sell-editor-tier market-quality-tier" hidden></small>
                    </div>
                    <div class="market-sell-editor-form">
                        <label class="market-sell-field market-sell-qty-field"><span>📦 ${tr('amount')}</span><input class="market-sell-qty" type="number" min="1" value="1"></label>
                        <label class="market-sell-field market-sell-currency-field"><span>💰 Moneda</span><select class="market-sell-currency"><option value="GOLD">💲 Dólar</option><option value="DIAMONDS">💎 Diamantes</option></select></label>
                        <label class="market-sell-field market-sell-price-field"><span>🏷️ ${tr('unitPrice')}</span><input class="market-sell-price" type="number" min="1" placeholder="${tr('enterPrice')}"><small class="market-sell-conversion"></small></label>
                        <button class="mk-bulk-btn market-sell-submit" type="button" disabled>📣 ${tr('advertise')}</button>
                        <div class="market-sell-financial-summary">
                            <div class="market-sell-finance-box gross"><small>${tr('saleGrossTotal')}</small><b class="market-sell-gross">—</b></div>
                            <div class="market-sell-finance-box fee"><small>${tr('listingFee')}</small><b class="market-sell-fee">—</b></div>
                            <div class="market-sell-finance-box net"><small>${tr('saleNetProfit')}</small><b class="market-sell-net">—</b></div>
                        </div>
                    </div>
                </div>
                <div class="market-sell-reference" style="display:none;margin:7px 12px 0;padding:8px 10px;background:#101d27;border:1px solid #27445a;border-radius:6px;color:#a9c7d9;font-size:12px;"></div>
                <div class="market-request-controls" style="display:none;">
                    <div class="market-request-heading"><img src="/assets/market/tab_requests.png" alt=""><span>${tr('requestCreate')}</span></div>
                    <div class="market-request-form">
                        <label class="market-request-field"><span>${tr('requestItem')}</span><div class="market-request-combobox"><input class="market-request-item" type="hidden"><div class="market-request-search-wrap"><span class="market-request-selected-art">🔎</span><input class="market-request-search" type="text" autocomplete="off" placeholder="${tr('requestChoose')}"><button class="market-request-clear" type="button" title="${tr('requestChoose')}">×</button></div><div class="market-request-options" hidden></div></div></label>
                        <label class="market-request-field"><span>${tr('requestQty')}</span><input class="market-request-qty" type="number" min="1" max="100" value="1"></label>
                        <label class="market-request-field"><span>${tr('requestPrice')}</span><input class="market-request-price" type="number" min="1" value="1"></label>
                        <button class="mk-bulk-btn market-request-submit" type="button" disabled>📥 ${tr('requestCreate')}</button>
                        <div class="market-request-summary"></div>
                    </div>
                    <div class="market-request-list-filters" data-label="${tr('requestFilters')}">
                        <select class="market-request-filter-category"><option value="All">${tr('all')}</option><option value="Items">${tr('items')}</option><option value="Stones">${tr('stones')}</option><option value="Poke Balls">${tr('pokeBalls')}</option><option value="Diamonds">${tr('diamonds')}</option></select>
                        <select class="market-request-filter-sort"><option value="recent">${tr('recent')}</option><option value="price-asc">${tr('lowestPrice')}</option><option value="price-desc">${tr('highestPrice')}</option><option value="quantity-desc">${tr('requestMostQuantity')}</option></select>
                        <select class="market-request-filter-rarity"><option value="">${tr('allRarities')}</option><option value="common">${tr('rarityCommon')}</option><option value="uncommon">${tr('rarityUncommon')}</option><option value="rare">${tr('rarityRare')}</option><option value="epic">${tr('rarityEpic')}</option><option value="legendary">${tr('rarityLegendary')}</option><option value="mythic">${tr('rarityMythic')}</option><option value="ancient">${tr('rarityAncient')}</option><option value="divine">${tr('rarityDivine')}</option></select>
                        <input class="market-request-filter-search" type="search" placeholder="${tr('requestSearchFilter')}">
                        <button class="mk-bulk-btn market-request-filter-clear" type="button">↺ ${tr('clearFilters')}</button>
                    </div>
                </div>
                <div class="market-status" style="padding:7px 12px;color:#a0aec0;font-size:12px;"></div>
                <div class="market-list" style="padding:0 12px 12px;overflow:auto;display:grid;gap:7px;"></div>
            </div>`;
        document.body.appendChild(backdrop);
        ensureMarketIvStage(backdrop);
        const marketStage = backdrop.querySelector('.market-iv-stage');
        const categoryRail = document.createElement('nav');
        categoryRail.className = 'market-category-rail';
        categoryRail.setAttribute('aria-label', tr('items'));
        const voltorbSprite = getPokemonIconUrl(100);
        categoryRail.innerHTML = [
            ['All', '<span class="market-category-all-grid"><i></i><i></i><i></i><i></i></span>', tr('all'), 'all'],
            ['Items', '<img class="market-category-sprite" src="/assets/market/tab_sell.png" alt="">', tr('items'), 'items'],
            ['Stones', '<span class="market-category-stone-fallback">◆</span>', tr('stones'), 'stones'],
            ['Poke Balls', '<span class="market-category-ball-fallback"></span>', tr('pokeBalls'), 'balls'],
            ['Diamonds', '<img class="market-category-sprite" src="/assets/market/diamonds.png" alt="">', tr('diamonds'), 'diamonds'],
            ['Pokemon', `<img class="market-category-sprite" src="${escapeHTML(voltorbSprite)}" alt="Voltorb">`, tr('pokemon'), 'pokemon']
        ].map(([value, icon, label, role]) => `<button class="market-category-rail-btn" data-category="${value}" type="button" title="${escapeHTML(label)}"><span class="market-category-rail-icon" data-sprite-role="${role}" aria-hidden="true">${icon}</span><span class="market-category-rail-label">${escapeHTML(label)}</span></button>`).join('');
        marketStage?.appendChild(categoryRail);
        let categoryIconRotationTimer = null;
        const stopCategoryIconRotation = () => {
            if (categoryIconRotationTimer) clearInterval(categoryIconRotationTimer);
            categoryIconRotationTimer = null;
            backdrop._marketCategoryIconTimer = null;
        };
        const categorySpritePools = { stones:[], balls:[] };
        const categorySpriteIndexes = { stones:-1, balls:-1 };
        const normalizeCategorySprite = entry => {
            const rawIcon = entry?.iconUrl || entry?.imageUrl || entry?.icon || entry?.image || entry?.sprite || entry?.img || '';
            if (!rawIcon) return '';
            const icon = String(rawIcon);
            if (/^(?:https?:)?\//i.test(icon)) return icon;
            if (/^assets\//i.test(icon)) return `/${icon}`;
            return normalizeGameItemIcon(icon);
        };
        const rotateCategorySprite = role => {
            const pool = categorySpritePools[role];
            const host = categoryRail.querySelector(`[data-sprite-role="${role}"]`);
            if (!host || !pool.length) return;
            let nextIndex = Math.floor(Math.random() * pool.length);
            if (pool.length > 1 && nextIndex === categorySpriteIndexes[role]) nextIndex = (nextIndex + 1) % pool.length;
            categorySpriteIndexes[role] = nextIndex;
            let sprite = host.querySelector('.market-category-sprite');
            if (!sprite) {
                sprite = document.createElement('img');
                sprite.className = 'market-category-sprite';
                sprite.alt = '';
                host.replaceChildren(sprite);
            }
            sprite.src = pool[nextIndex];
            sprite.classList.remove('is-swapping');
            void sprite.offsetWidth;
            sprite.classList.add('is-swapping');
        };
        const hydrateCategorySprites = async () => {
            const [shopData, ballData] = await Promise.all([
                loadMarkCatalog().catch(() => ({})),
                loadBallCatalog().catch(() => ({})),
                Promise.resolve(itemDataLoadPromise).catch(() => null)
            ]);
            if (!backdrop.isConnected) return;
            const knownItems = [...new Set(globalItemApiData.values())];
            const shopItems = Array.isArray(shopData?.items) ? shopData.items : [];
            const stoneEntries = [...shopItems, ...knownItems].filter(item => {
                const category = String(item?.category || item?.kind || item?.type || '').toLowerCase();
                const name = String(item?.name || item?.title || '').toLowerCase();
                return category === 'stone' || /\bstone\b/.test(name);
            });
            const ballCatalog = Array.isArray(ballData?.catalog)
                ? ballData.catalog
                : Array.isArray(ballData?.catalog?.balls) ? ballData.catalog.balls
                    : Array.isArray(ballData?.balls) ? ballData.balls : Array.isArray(ballData) ? ballData : [];
            const shopBalls = Array.isArray(shopData?.balls) ? shopData.balls : [];
            categorySpritePools.stones = [...new Set(stoneEntries.map(normalizeCategorySprite).filter(Boolean))];
            categorySpritePools.balls = [...new Set([...shopBalls, ...ballCatalog].map(normalizeCategorySprite).filter(Boolean))];
            rotateCategorySprite('stones');
            rotateCategorySprite('balls');
            if (categorySpritePools.stones.length > 1 || categorySpritePools.balls.length > 1) {
                categoryIconRotationTimer = setInterval(() => {
                    if (!backdrop.isConnected) {
                        stopCategoryIconRotation();
                        return;
                    }
                    if (document.hidden || categoryRail.hidden) return;
                    rotateCategorySprite('stones');
                    rotateCategorySprite('balls');
                }, 2600);
                backdrop._marketCategoryIconTimer = categoryIconRotationTimer;
            }
        };
        void hydrateCategorySprites();
        // El panel de alertas vive dentro del Mercado para que su centro y su
        // área de desplazamiento respeten exactamente los límites de la ventana.
        const marketWindow = backdrop.querySelector('.script-market-window');
        const marketAlertRulesOverlay = backdrop.querySelector('.market-alert-rules-panel');
        if (marketWindow && marketAlertRulesOverlay) marketWindow.appendChild(marketAlertRulesOverlay);

        let activeCategory = 'Items';
        let marketMode = 'buy';
        let currentListings = [];
        let currentMyListings = [];
        let currentMarketPayload = null;
        let requestCatalogCache = [];
        let sellEntries = [];
        let selectedSellEntry = null;
        let renderLimit = 100;
        let diamondPdRate = null;
        let sellReferenceRequestId = 0;
        let activeMarketFavoriteKey = '';
        let featuredFilterState = null;
        let regularMarketFilterState = null;
        let loadedRequestCategory = 'All';
        const sellQualityTierDefinitions = [
            { label:'Fraca', color:'#64748b' }, { label:'Comum', color:'#35d05b' },
            { label:'Incomum', color:'#38bdf8' }, { label:'Rara', color:'#a855f7' },
            { label:'Épica', color:'#facc15' }, { label:'Lendária', color:'#f97316' },
            { label:'Mítica', color:'#d946ef' }, { label:'Anciã', color:'#d5a800' },
            { label:'Divina', color:'#e2e8f0' }
        ];
        const buyVisibleQualityTiers = new Set(sellQualityTierDefinitions.map(tier => tier.label));
        const sellVisibleQualityTiers = new Set(sellQualityTierDefinitions.map(tier => tier.label));
        const mineVisibleQualityTiers = new Set(sellQualityTierDefinitions.map(tier => tier.label));
        const alertVisibleQualityTiers = new Set(sellQualityTierDefinitions.map(tier => tier.label));
        const list = backdrop.querySelector('.market-list');
        const status = backdrop.querySelector('.market-status');
        const exchangeRate = backdrop.querySelector('.market-exchange-rate');
        const balanceGold = backdrop.querySelector('.market-balance-gold');
        const balanceDiamonds = backdrop.querySelector('.market-balance-diamonds');
        const search = backdrop.querySelector('.market-search');
        const categorySelect = backdrop.querySelector('.market-category');
        const sortSelect = backdrop.querySelector('.market-sort');
        const itemRarityFilter = backdrop.querySelector('.market-item-rarity-filter');
        const showGold = backdrop.querySelector('.market-show-gold');
        const showDiamonds = backdrop.querySelector('.market-show-diamonds');
        const pokemonFilters = backdrop.querySelector('.market-pokemon-filters');
        const shinyOnly = backdrop.querySelector('.market-shiny-only');
        const ivMin = backdrop.querySelector('.market-iv-min');
        const ivMax = backdrop.querySelector('.market-iv-max');
        const levelMin = backdrop.querySelector('.market-level-min');
        const levelMax = backdrop.querySelector('.market-level-max');
        const qualityMin = backdrop.querySelector('.market-quality-min');
        const qualityMax = backdrop.querySelector('.market-quality-max');
        const typeSelect = backdrop.querySelector('.market-type');
        const buyQualityTiers = backdrop.querySelector('.market-buy-quality-tiers');
        const buyQualityTierButtons = backdrop.querySelector('.market-buy-tier-buttons');
        const buyControls = backdrop.querySelector('.market-buy-controls');
        const favoritesBar = backdrop.querySelector('.market-favorites-bar');
        const favoritesList = backdrop.querySelector('.market-favorites-list');
        const favoriteScrollPrev = backdrop.querySelector('.market-favorites-prev');
        const favoriteScrollNext = backdrop.querySelector('.market-favorites-next');
        const filtersToggle = backdrop.querySelector('.market-filters-toggle');
        const alertControls = backdrop.querySelector('.market-alert-controls');
        const alertAccountContext = backdrop.querySelector('.market-alert-account-context');
        const itemAlertAutoStatus = backdrop.querySelector('.market-item-auto-status');
        const alertName = backdrop.querySelector('.market-alert-name');
        const alertCurrency = backdrop.querySelector('.market-alert-currency');
        const alertPriceMin = backdrop.querySelector('.market-alert-price-min');
        const alertPriceMax = backdrop.querySelector('.market-alert-price-max');
        const alertPriceMinDisplay = backdrop.querySelector('.market-alert-price-min-display');
        const alertPriceMaxDisplay = backdrop.querySelector('.market-alert-price-max-display');
        const alertShiny = backdrop.querySelector('.market-alert-shiny');
        const alertIvMin = backdrop.querySelector('.market-alert-iv-min');
        const alertIvMax = backdrop.querySelector('.market-alert-iv-max');
        const alertLevelMin = backdrop.querySelector('.market-alert-level-min');
        const alertLevelMax = backdrop.querySelector('.market-alert-level-max');
        const alertType = backdrop.querySelector('.market-alert-type');
        const alertCreate = backdrop.querySelector('.market-alert-create');
        const alertEditCancel = backdrop.querySelector('.market-alert-edit-cancel');
        const alertPokemonForm = backdrop.querySelector('.market-alert-pokemon-form');
        const alertItemForm = backdrop.querySelector('.market-alert-item-form');
        const alertKindTabs = [...backdrop.querySelectorAll('.market-alert-kind-tab')];
        const itemAlertName = backdrop.querySelector('.market-item-alert-name');
        const itemAlertCurrency = backdrop.querySelector('.market-item-alert-currency');
        const itemAlertPriceMin = backdrop.querySelector('.market-item-alert-price-min');
        const itemAlertPriceMax = backdrop.querySelector('.market-item-alert-price-max');
        const itemAlertPriceMinDisplay = backdrop.querySelector('.market-item-alert-price-min-display');
        const itemAlertPriceMaxDisplay = backdrop.querySelector('.market-item-alert-price-max-display');
        const itemAlertQuantityMin = backdrop.querySelector('.market-item-alert-quantity-min');
        const itemAlertCreate = backdrop.querySelector('.market-item-alert-create');
        const itemAlertEditCancel = backdrop.querySelector('.market-item-alert-edit-cancel');
        const itemAlertNames = backdrop.querySelector('#market-alert-item-names');
        const alertTierButtons = backdrop.querySelector('.market-alert-tier-buttons');
        const alertRules = backdrop.querySelector('.market-alert-rules');
        const alertAutoBuy = backdrop.querySelector('.market-alert-auto-buy-input');
        const itemAlertAutoBuy = backdrop.querySelector('.market-item-alert-auto-buy-input');
        const alertPaste = backdrop.querySelector('.market-alert-paste');
        let marketAlertClipboardCache = String(localStorage.getItem(STORAGE_MARKET_ALERT_CLIPBOARD) || '');
        const alertRulesToggle = backdrop.querySelector('.market-alert-rules-toggle');
        const alertRulesCount = backdrop.querySelector('.market-alert-rules-count');
        const alertRulesPanel = backdrop.querySelector('.market-alert-rules-panel');
        const alertRulesClose = backdrop.querySelector('.market-alert-rules-close');
        const alertClearAll = backdrop.querySelector('.market-alert-clear-all');
        const alertRulesTabs = [...backdrop.querySelectorAll('.market-alert-rules-tab')];
        const alertExport = backdrop.querySelector('.market-alert-export');
        const alertImport = backdrop.querySelector('.market-alert-import');
        let marketAlertExportCache = String(localStorage.getItem(STORAGE_MARKET_ALERT_EXPORT) || '');
        const alertTransferPanel = backdrop.querySelector('.market-alert-transfer-panel');
        const alertTransferTitle = backdrop.querySelector('.market-alert-transfer-title');
        const alertTransferHelp = backdrop.querySelector('.market-alert-transfer-help');
        const alertTransferData = backdrop.querySelector('.market-alert-transfer-data');
        const alertTransferConfirm = backdrop.querySelector('.market-alert-transfer-confirm');
        let marketAlertTransferMode = '';
        const alertPokemonNames = backdrop.querySelector('#market-alert-pokemon-names');
        const telegramToggle = backdrop.querySelector('.market-telegram-toggle');
        const telegramPanel = backdrop.querySelector('.market-telegram-panel');
        const telegramClose = backdrop.querySelector('.market-telegram-close');
        const telegramToken = backdrop.querySelector('.market-telegram-token');
        const telegramChatId = backdrop.querySelector('.market-telegram-chat-id');
        const telegramEnabled = backdrop.querySelector('.market-telegram-enabled-input');
        const telegramSave = backdrop.querySelector('.market-telegram-save');
        const telegramTest = backdrop.querySelector('.market-telegram-test');
        const telegramSettings = getMarketTelegramSettings();
        let alertCreationKind = 'pokemon';
        let alertRulesKind = 'pokemon';
        let editingMarketAlert = null;
        if (!MARKET_ALERTS_REMOVED) {
            itemAlertAutoBuy.checked = isMarketItemAlertAutoBuyEnabled();
            const storedItemAutoStatus = getMarketItemAlertAutoBuyStatus();
            if (storedItemAutoStatus) {
                const time = new Date(storedItemAutoStatus.at).toLocaleTimeString(getGameLanguage() === 'es' ? 'es-VE' : 'en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
                itemAlertAutoStatus.textContent = `Auto objetos: ${storedItemAutoStatus.state}${storedItemAutoStatus.message ? ` · ${storedItemAutoStatus.message}` : ''} · ${time}`;
            } else {
                itemAlertAutoStatus.textContent = `Auto objetos: ${itemAlertAutoBuy.checked ? 'activa' : 'desactivada'}`;
            }
            telegramToken.value = telegramSettings.token;
            telegramChatId.value = telegramSettings.chatId;
            telegramEnabled.checked = telegramSettings.enabled;
            alertAutoBuy.checked = isMarketAlertAutoBuyEnabled();
        }
        const sellControls = backdrop.querySelector('.market-sell-controls');
        const sellKind = backdrop.querySelector('.market-sell-kind');
        const sellSearch = backdrop.querySelector('.market-sell-search');
        const sellIvMin = backdrop.querySelector('.market-sell-iv-min');
        const sellQualityMin = backdrop.querySelector('.market-sell-quality-min');
        const sellType = backdrop.querySelector('.market-sell-type');
        const sellQualityTiers = backdrop.querySelector('.market-sell-only-quality-tiers');
        const sellQualityTierButtons = backdrop.querySelector('.market-sell-only-tier-buttons');
        const mineQualityTiers = backdrop.querySelector('.market-mine-quality-tiers');
        const mineQualityTierButtons = backdrop.querySelector('.market-mine-tier-buttons');
        const sellCurrency = backdrop.querySelector('.market-sell-currency');
        const sellQty = backdrop.querySelector('.market-sell-qty');
        const sellPrice = backdrop.querySelector('.market-sell-price');
        const sellConversion = backdrop.querySelector('.market-sell-conversion');
        const sellGross = backdrop.querySelector('.market-sell-gross');
        const sellFee = backdrop.querySelector('.market-sell-fee');
        const sellNet = backdrop.querySelector('.market-sell-net');
        const sellReference = backdrop.querySelector('.market-sell-reference');
        const sellSubmit = backdrop.querySelector('.market-sell-submit');
        const sellEditor = backdrop.querySelector('.market-sell-editor');
        const sellEditorArt = backdrop.querySelector('.market-sell-editor-art');
        const sellEditorName = backdrop.querySelector('.market-sell-editor-name');
        const sellEditorMeta = backdrop.querySelector('.market-sell-editor-meta');
        const sellEditorStats = backdrop.querySelector('.market-sell-editor-stats');
        const sellEditorTier = backdrop.querySelector('.market-sell-editor-tier');
        const sellEditorLock = backdrop.querySelector('.market-sell-editor-lock');
        const sellQtyField = backdrop.querySelector('.market-sell-qty-field');
        const requestControls = backdrop.querySelector('.market-request-controls');
        const requestItem = backdrop.querySelector('.market-request-item');
        const requestSearch = backdrop.querySelector('.market-request-search');
        const requestOptions = backdrop.querySelector('.market-request-options');
        const requestSelectedArt = backdrop.querySelector('.market-request-selected-art');
        const requestClear = backdrop.querySelector('.market-request-clear');
        const requestCombobox = backdrop.querySelector('.market-request-combobox');
        const requestQty = backdrop.querySelector('.market-request-qty');
        const requestPrice = backdrop.querySelector('.market-request-price');
        const requestSummary = backdrop.querySelector('.market-request-summary');
        const requestSubmit = backdrop.querySelector('.market-request-submit');
        const requestFilterCategory = backdrop.querySelector('.market-request-filter-category');
        const requestFilterSort = backdrop.querySelector('.market-request-filter-sort');
        const requestFilterRarity = backdrop.querySelector('.market-request-filter-rarity');
        const requestFilterSearch = backdrop.querySelector('.market-request-filter-search');
        const requestFilterClear = backdrop.querySelector('.market-request-filter-clear');
        const marketViewToggle = backdrop.querySelector('.market-view-toggle');
        const viewButtons = Array.from(backdrop.querySelectorAll('.market-view-btn'));
        const close = () => {
            stopCategoryIconRotation();
            backdrop.remove();
        };
        const bindMarketIvCard = (row, entry) => {
            if (!row || !entry) return;
            row.classList.add('market-iv-trigger');
            if (row.tagName !== 'BUTTON') {
                row.tabIndex = 0;
                row.setAttribute('role', 'button');
            }
            row.setAttribute('aria-label', `${row.querySelector('.market-item-name')?.textContent || 'Pokémon'} · abrir calculadora IV`);
            const activate = event => {
                const interactiveTarget = event.target.closest('button,input,select,textarea,a,[role="button"]');
                if (interactiveTarget && interactiveTarget !== row) return;
                if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
                if (event.type === 'keydown') event.preventDefault();
                openMarketIvCalculator(backdrop, entry);
                row.classList.add('market-iv-active');
            };
            row.addEventListener('click', activate);
            row.addEventListener('keydown', activate);
        };

        const legacyMarketView = localStorage.getItem('script_market_view_v1') === 'list' ? 'list' : 'cards';
        let storedMarketViews = {};
        try { storedMarketViews = JSON.parse(localStorage.getItem('script_market_views_v2') || '{}') || {}; }
        catch (_) { storedMarketViews = {}; }
        const marketViews = Object.fromEntries(['buy', 'featured', 'sell', 'mine', 'requests', 'history', 'prices']
            .map(mode => [mode, storedMarketViews[mode] === 'list' ? 'list' : storedMarketViews[mode] === 'cards' ? 'cards' : legacyMarketView]));
        let marketView = marketViews[marketMode];
        const applyMarketView = (view, mode = marketMode) => {
            const normalizedView = view === 'list' ? 'list' : 'cards';
            marketViews[mode] = normalizedView;
            localStorage.setItem('script_market_views_v2', JSON.stringify(marketViews));
            if (mode !== marketMode) return;
            marketView = normalizedView;
            list.classList.toggle('market-view-cards', marketView === 'cards');
            list.classList.toggle('market-view-list', marketView === 'list');
            viewButtons.forEach(button => button.classList.toggle('on', button.dataset.view === marketView));
        };
        applyMarketView(marketViews[marketMode]);

        const captureMarketFilterState = () => ({
            activeCategory,
            activeMarketFavoriteKey,
            category:categorySelect.value,
            sort:sortSelect.value,
            rarity:itemRarityFilter.value,
            search:search.value,
            gold:showGold.checked,
            diamonds:showDiamonds.checked,
            shiny:shinyOnly.checked,
            ivMin:ivMin.value,
            ivMax:ivMax.value,
            levelMin:levelMin.value,
            levelMax:levelMax.value,
            qualityMin:qualityMin.value,
            qualityMax:qualityMax.value,
            type:typeSelect.value,
            tiers:[...buyVisibleQualityTiers]
        });
        const restoreMarketFilterState = state => {
            if (!state) return;
            activeCategory = state.activeCategory || state.category || 'Items';
            activeMarketFavoriteKey = state.activeMarketFavoriteKey || '';
            categorySelect.value = state.category || activeCategory;
            sortSelect.value = state.sort || 'recent';
            itemRarityFilter.dataset.marketSelectedRarity = state.rarity || '';
            itemRarityFilter.value = state.rarity || '';
            search.value = state.search || '';
            showGold.checked = state.gold !== false;
            showDiamonds.checked = state.diamonds !== false;
            shinyOnly.checked = Boolean(state.shiny);
            ivMin.value = state.ivMin || '';
            ivMax.value = state.ivMax || '';
            levelMin.value = state.levelMin || '';
            levelMax.value = state.levelMax || '';
            qualityMin.value = state.qualityMin || '';
            qualityMax.value = state.qualityMax || '';
            typeSelect.dataset.marketSelectedType = state.type || '';
            typeSelect.value = state.type || '';
            buyVisibleQualityTiers.clear();
            (state.tiers || sellQualityTierDefinitions.map(tier => tier.label)).forEach(tier => buyVisibleQualityTiers.add(tier));
            renderBuyQualityTierButtons();
        };
        const activateFeaturedFilters = () => {
            regularMarketFilterState = captureMarketFilterState();
            if (!featuredFilterState) {
                featuredFilterState = {
                    ...captureMarketFilterState(), activeCategory:'Pokemon', activeMarketFavoriteKey:'', category:'Pokemon',
                    sort:'recent', rarity:'', search:'', gold:true, diamonds:true, shiny:false,
                    ivMin:'', ivMax:'', levelMin:'', levelMax:'', qualityMin:'', qualityMax:'', type:'',
                    tiers:sellQualityTierDefinitions.map(tier => tier.label)
                };
            }
            restoreMarketFilterState(featuredFilterState);
            activeCategory = 'Pokemon';
            activeMarketFavoriteKey = '';
            categorySelect.value = 'Pokemon';
            categorySelect.disabled = true;
        };
        const deactivateFeaturedFilters = () => {
            featuredFilterState = captureMarketFilterState();
            categorySelect.disabled = false;
            restoreMarketFilterState(regularMarketFilterState);
            regularMarketFilterState = null;
        };

        const locale = () => getGameLanguage() === 'pt' ? 'pt-BR' : getGameLanguage() === 'es' ? 'es-VE' : 'en-US';
        const formatMarketValue = (value, currency) => Number(value).toLocaleString(locale(), {
            maximumFractionDigits: 0
        });
        const updateAlertPriceDisplays = () => {
            const currency = alertCurrency.value;
            const icon = currency === 'GOLD' ? '💲' : currency === 'DIAMONDS' ? '💎' : '💰';
            [[alertPriceMin, alertPriceMinDisplay], [alertPriceMax, alertPriceMaxDisplay]].forEach(([input, display]) => {
                const value = Number(input.value);
                display.textContent = input.value === '' || !Number.isFinite(value)
                    ? '—'
                    : `${icon} ${value.toLocaleString(locale(), { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
            });
        };
        const updateItemAlertPriceDisplays = () => {
            const icon = itemAlertCurrency.value === 'GOLD' ? '💲' : itemAlertCurrency.value === 'DIAMONDS' ? '💎' : '💰';
            [[itemAlertPriceMin, itemAlertPriceMinDisplay], [itemAlertPriceMax, itemAlertPriceMaxDisplay]].forEach(([input, display]) => {
                const value = Number(input.value);
                display.textContent = input.value === '' || !Number.isFinite(value) ? '—' : `${icon} ${value.toLocaleString(locale(), { maximumFractionDigits:2 })}`;
            });
        };
        const setAlertCreationKind = kind => {
            alertCreationKind = kind === 'item' ? 'item' : 'pokemon';
            alertPokemonForm.hidden = alertCreationKind !== 'pokemon';
            alertItemForm.hidden = alertCreationKind !== 'item';
            backdrop.querySelector('.market-alert-tiers').hidden = alertCreationKind !== 'pokemon';
            alertKindTabs.forEach(tab => tab.classList.toggle('on', tab.dataset.alertKind === alertCreationKind));
            if (alertCreationKind === 'item') refreshMarketItemAlertNames();
        };
        const refreshMarketItemAlertNames = async () => {
            if (itemAlertNames.dataset.loaded) return;
            try {
                const payload = await fetch(ITEMS_JSON_URL).then(response => response.json());
                const names = [...new Set((payload.items || []).map(item => String(item.name || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
                itemAlertNames.innerHTML = names.map(name => `<option value="${escapeHTML(name)}"></option>`).join('');
                itemAlertNames.dataset.loaded = 'true';
            } catch { /* La alerta de objeto puede usarse escribiendo el nombre manualmente. */ }
        };
        const updateMarketCategoryRail = () => {
            categoryRail.hidden = !['buy', 'mine'].includes(marketMode);
            categoryRail.querySelectorAll('.market-category-rail-btn').forEach(button => {
                const active = button.dataset.category === activeCategory;
                button.classList.toggle('on', active);
                button.setAttribute('aria-pressed', String(active));
            });
        };
        categoryRail.querySelectorAll('.market-category-rail-btn').forEach(button => button.addEventListener('click', () => {
            const category = button.dataset.category;
            if (!category || categorySelect.value === category) return;
            categorySelect.value = category;
            categorySelect.dispatchEvent(new Event('change', { bubbles:true }));
        }));
        const setMarketFiltersOpen = open => {
            const enabled = Boolean(open);
            backdrop.classList.toggle('market-filters-open', enabled);
            filtersToggle.setAttribute('aria-expanded', String(enabled));
            filtersToggle.classList.toggle('on', enabled);
        };
        const updateMarketFavoriteArrows = () => {
            const maximum = Math.max(0, favoritesList.scrollWidth - favoritesList.clientWidth);
            favoriteScrollPrev.disabled = favoritesList.scrollLeft <= 1;
            favoriteScrollNext.disabled = favoritesList.scrollLeft >= maximum - 1;
        };
        const scrollMarketFavorites = direction => {
            const distance = Math.max(180, Math.floor(favoritesList.clientWidth * .72));
            favoritesList.scrollBy({ left:direction * distance, behavior:'smooth' });
        };
        const renderMarketFavorites = () => {
            updateMarketCategoryRail();
            const favorites = getMarketFavorites();
            favoritesBar.classList.toggle('has-favorites', favorites.length > 0 && marketMode === 'buy');
            favoritesList.innerHTML = '';
            favorites.forEach(favorite => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = `market-favorite-chip${activeMarketFavoriteKey === favorite.key ? ' on' : ''}`;
                chip.title = `${favorite.name} · ${tr('lowestPrice')}`;
                chip.innerHTML = `${favorite.icon ? `<img src="${escapeHTML(favorite.icon)}" alt="">` : '<span>📦</span>'}<span>${escapeHTML(favorite.name)}</span>`;
                chip.querySelector('img')?.addEventListener('error', event => { event.currentTarget.style.display = 'none'; }, { once: true });
                chip.addEventListener('click', () => {
                    marketMode = 'buy';
                    if (activeMarketFavoriteKey === favorite.key) {
                        activeMarketFavoriteKey = '';
                        activeCategory = 'Items';
                        categorySelect.value = 'Items';
                        sortSelect.value = 'recent';
                        itemRarityFilter.value = '';
                        search.value = '';
                        showGold.checked = true;
                        showDiamonds.checked = true;
                        shinyOnly.checked = false;
                        [ivMin, ivMax, levelMin, levelMax, qualityMin, qualityMax].forEach(control => { control.value = ''; });
                        typeSelect.value = '';
                        renderLimit = 100;
                        renderMarketFavorites();
                        load();
                        return;
                    }
                    activeMarketFavoriteKey = favorite.key;
                    activeCategory = favorite.category || 'Items';
                    categorySelect.value = activeCategory;
                    sortSelect.value = 'price-asc';
                    search.value = favorite.name;
                    renderLimit = 100;
                    renderMarketFavorites();
                    load();
                });
                favoritesList.appendChild(chip);
            });
            requestAnimationFrame(() => {
                favoritesList.querySelector('.market-favorite-chip.on')?.scrollIntoView({ block:'nearest', inline:'nearest' });
                updateMarketFavoriteArrows();
            });
        };
        filtersToggle.addEventListener('click', () => setMarketFiltersOpen(!backdrop.classList.contains('market-filters-open')));
        favoriteScrollPrev.addEventListener('click', () => scrollMarketFavorites(-1));
        favoriteScrollNext.addEventListener('click', () => scrollMarketFavorites(1));
        favoritesList.addEventListener('scroll', updateMarketFavoriteArrows, { passive:true });
        const renderSellQualityTierButtons = () => {
            sellQualityTierButtons.innerHTML = '';
            sellQualityTierDefinitions.forEach(tier => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `market-sell-tier-btn${sellVisibleQualityTiers.has(tier.label) ? ' on' : ''}`;
                button.style.setProperty('--sell-tier', tier.color);
                button.textContent = tier.label;
                button.addEventListener('click', () => {
                    if (sellVisibleQualityTiers.has(tier.label)) sellVisibleQualityTiers.delete(tier.label);
                    else sellVisibleQualityTiers.add(tier.label);
                    selectedSellEntry = null;
                    sellEditor.hidden = true;
                    clearSellReference();
                    sellSubmit.disabled = true;
                    renderSellQualityTierButtons();
                    renderSell();
                });
                sellQualityTierButtons.appendChild(button);
            });
        };
        const renderBuyQualityTierButtons = () => {
            buyQualityTierButtons.innerHTML = '';
            sellQualityTierDefinitions.forEach(tier => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `market-sell-tier-btn${buyVisibleQualityTiers.has(tier.label) ? ' on' : ''}`;
                button.style.setProperty('--sell-tier', tier.color);
                button.textContent = tier.label;
                button.addEventListener('click', () => {
                    if (buyVisibleQualityTiers.has(tier.label)) buyVisibleQualityTiers.delete(tier.label);
                    else buyVisibleQualityTiers.add(tier.label);
                    renderBuyQualityTierButtons();
                    if ((marketMode === 'buy' || marketMode === 'featured') && activeCategory === 'Pokemon') render();
                });
                buyQualityTierButtons.appendChild(button);
            });
        };
        const renderMineQualityTierButtons = () => {
            mineQualityTierButtons.innerHTML = '';
            sellQualityTierDefinitions.forEach(tier => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `market-sell-tier-btn${mineVisibleQualityTiers.has(tier.label) ? ' on' : ''}`;
                button.style.setProperty('--sell-tier', tier.color);
                button.textContent = tier.label;
                button.addEventListener('click', () => {
                    if (mineVisibleQualityTiers.has(tier.label)) mineVisibleQualityTiers.delete(tier.label);
                    else mineVisibleQualityTiers.add(tier.label);
                    renderMineQualityTierButtons();
                    if (marketMode === 'mine') renderMyListings();
                });
                mineQualityTierButtons.appendChild(button);
            });
        };
        const renderAlertTierButtons = () => {
            alertTierButtons.innerHTML = '';
            sellQualityTierDefinitions.forEach(tier => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `market-sell-tier-btn${alertVisibleQualityTiers.has(tier.label) ? ' on' : ''}`;
                button.style.setProperty('--sell-tier', tier.color);
                button.textContent = tier.label;
                button.addEventListener('click', () => {
                    if (alertVisibleQualityTiers.has(tier.label)) alertVisibleQualityTiers.delete(tier.label);
                    else alertVisibleQualityTiers.add(tier.label);
                    renderAlertTierButtons();
                });
                alertTierButtons.appendChild(button);
            });
        };
        const refreshAlertPokemonNames = () => {
            const names = new Set();
            globalCreatureApiData.forEach(creature => {
                const name = String(creature?.name || creature?.displayName || '').trim();
                if (name) names.add(name);
            });
            Object.keys(POKEMON_TYPES).forEach(name => {
                if (name) names.add(name.replace(/\b\w/g, letter => letter.toUpperCase()));
            });
            alertPokemonNames.innerHTML = [...names]
                .sort((a, b) => a.localeCompare(b, locale(), { sensitivity:'base' }))
                .map(name => `<option value="${escapeHTML(name)}"></option>`).join('');
        };
        const describeMarketAlert = alert => {
            const details = [];
            if (alert.shiny) details.push('✨');
            if (alert.ivMin !== '' || alert.ivMax !== '') details.push(`IV ${alert.ivMin || '0'}–${alert.ivMax || '192'}`);
            if (alert.levelMin !== '' || alert.levelMax !== '') details.push(`Lv. ${alert.levelMin || '1'}–${alert.levelMax || '∞'}`);
            if (alert.priceMin !== '' || alert.priceMax !== '') details.push(`${alert.currency === 'DIAMONDS' ? '💎' : alert.currency === 'GOLD' ? '💲' : '💰'} ${alert.priceMin || '0'}–${alert.priceMax || '∞'}`);
            if (alert.type) details.push(alert.type);
            if (alert.tiers.length && alert.tiers.length < sellQualityTierDefinitions.length) details.push(alert.tiers.join(', '));
            return details.join(' · ') || tr('all');
        };
        const marketAlertFilterData = alert => ({
            name:alert.name || '', currency:alert.currency || 'ALL', priceMin:alert.priceMin ?? '', priceMax:alert.priceMax ?? '',
            shiny:Boolean(alert.shiny), ivMin:alert.ivMin ?? '', ivMax:alert.ivMax ?? '', levelMin:alert.levelMin ?? '', levelMax:alert.levelMax ?? '',
            type:alert.type || '', tiers:Array.isArray(alert.tiers) ? alert.tiers.map(tier => MARKET_QUALITY_TIER_DEFINITIONS.find(definition => definition.id === normalizeMarketTier(tier))?.label || tier).filter(Boolean) : []
        });
        const serializeMarketAlertFilters = alert => `PIW-MARKET-ALERT-V1:${JSON.stringify(marketAlertFilterData(alert))}`;
        const parseMarketAlertFilters = value => {
            const text = String(value || '').trim();
            if (!text) return null;
            const serialized = text.startsWith('PIW-MARKET-ALERT-V1:')
                ? text.slice('PIW-MARKET-ALERT-V1:'.length)
                : text;
            try {
                const filters = JSON.parse(serialized);
                if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
                return {
                    name: filters.name || '',
                    currency: ['ALL', 'GOLD', 'DIAMONDS'].includes(filters.currency) ? filters.currency : 'ALL',
                    priceMin: filters.priceMin ?? '', priceMax: filters.priceMax ?? '', shiny: Boolean(filters.shiny),
                    ivMin: filters.ivMin ?? '', ivMax: filters.ivMax ?? '', levelMin: filters.levelMin ?? '', levelMax: filters.levelMax ?? '',
                    type: filters.type || '',
                    tiers: Array.isArray(filters.tiers) ? filters.tiers.map(tier => MARKET_QUALITY_TIER_DEFINITIONS.find(definition => definition.id === normalizeMarketTier(tier))?.label || tier).filter(Boolean) : sellQualityTierDefinitions.map(definition => definition.label)
                };
            } catch (_) {
                return null;
            }
        };
        const copyMarketAlertFilters = async text => {
            // El portapapeles puede estar bloqueado en el contexto del userscript.
            // Conservamos una copia en memoria y otra persistente para que el botón
            // "Pegar filtros" siempre funcione dentro del mercado.
            marketAlertClipboardCache = text;
            try { localStorage.setItem(STORAGE_MARKET_ALERT_CLIPBOARD, text); } catch (_) { /* La copia en memoria sigue disponible. */ }
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {
                const helper = document.createElement('textarea');
                helper.value = text;
                helper.setAttribute('readonly', '');
                helper.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
                document.body.appendChild(helper);
                helper.select();
                const copied = Boolean(document.execCommand?.('copy'));
                helper.remove();
                if (copied) return true;
                // Aunque Electron bloquee el portapapeles, la copia interna ya se
                // guardó arriba y permite pegar estos filtros en esta cuenta.
                return true;
            }
        };
        const readMarketAlertFilters = async () => {
            try {
                return (await navigator.clipboard.readText()).trim();
            } catch (_) {
                return '';
            }
        };
        const marketItemAlertFilterData = alert => ({
            name:alert.name || '', currency:alert.currency || 'ALL', priceMin:alert.priceMin ?? '', priceMax:alert.priceMax ?? '', quantityMin:alert.quantityMin ?? ''
        });
        const serializeMarketAlertExport = alerts => `PIW-MARKET-ALERTS-V1:${JSON.stringify({ version:2, alerts:alerts.map(marketAlertFilterData), itemAlerts:getMarketItemAlerts().map(marketItemAlertFilterData) })}`;
        const parseMarketAlertExport = value => {
            const text = String(value || '').trim();
            if (!text) return [];
            const serialized = text.startsWith('PIW-MARKET-ALERTS-V1:')
                ? text.slice('PIW-MARKET-ALERTS-V1:'.length)
                : text;
            try {
                const data = JSON.parse(serialized);
                const alerts = Array.isArray(data) ? data : data?.alerts;
                return Array.isArray(alerts) ? alerts.map(alert => parseMarketAlertFilters(JSON.stringify(alert))).filter(Boolean) : [];
            } catch (_) {
                return [];
            }
        };
        const parseMarketItemAlertExport = value => {
            const text = String(value || '').trim();
            const serialized = text.startsWith('PIW-MARKET-ALERTS-V1:') ? text.slice('PIW-MARKET-ALERTS-V1:'.length) : text;
            try {
                const data = JSON.parse(serialized);
                return (Array.isArray(data?.itemAlerts) ? data.itemAlerts : []).filter(alert => alert && typeof alert === 'object').map(alert => ({
                    name:String(alert.name || ''), currency:['ALL', 'GOLD', 'DIAMONDS'].includes(alert.currency) ? alert.currency : 'ALL',
                    priceMin:alert.priceMin ?? '', priceMax:alert.priceMax ?? '', quantityMin:alert.quantityMin ?? ''
                }));
            } catch { return []; }
        };
        const copyMarketAlertExport = async text => {
            marketAlertExportCache = text;
            try { localStorage.setItem(STORAGE_MARKET_ALERT_EXPORT, text); } catch (_) { /* La copia en memoria sigue disponible. */ }
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {
                const helper = document.createElement('textarea');
                helper.value = text;
                helper.setAttribute('readonly', '');
                helper.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
                document.body.appendChild(helper);
                helper.select();
                const copied = Boolean(document.execCommand?.('copy'));
                helper.remove();
                if (copied) return true;
                return false;
            }
        };
        const applyMarketAlertFilters = filters => {
            if (!filters || typeof filters !== 'object' || !Array.isArray(filters.tiers)) throw new Error(tr('alertFiltersInvalid'));
            alertName.value = String(filters.name || '');
            alertCurrency.value = ['ALL', 'GOLD', 'DIAMONDS'].includes(filters.currency) ? filters.currency : 'ALL';
            alertPriceMin.value = filters.priceMin ?? '';
            alertPriceMax.value = filters.priceMax ?? '';
            alertShiny.checked = Boolean(filters.shiny);
            alertIvMin.value = filters.ivMin ?? '';
            alertIvMax.value = filters.ivMax ?? '';
            alertLevelMin.value = filters.levelMin ?? '';
            alertLevelMax.value = filters.levelMax ?? '';
            alertType.value = filters.type || '';
            alertVisibleQualityTiers.clear();
            filters.tiers.filter(tier => sellQualityTierDefinitions.some(definition => definition.label === tier)).forEach(tier => alertVisibleQualityTiers.add(tier));
            renderAlertTierButtons();
            updateAlertPriceDisplays();
        };
        const marketAlertSignature = alert => JSON.stringify({
            ...marketAlertFilterData(alert),
            tiers:[...(Array.isArray(alert.tiers) ? alert.tiers : [])].sort()
        });
        const newMarketAlertId = () => typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const resetMarketAlertEditor = () => {
            editingMarketAlert = null;
            alertName.value = '';
            alertCurrency.value = 'ALL';
            [alertPriceMin, alertPriceMax, alertIvMin, alertIvMax, alertLevelMin, alertLevelMax].forEach(input => { input.value = ''; });
            alertShiny.checked = false;
            alertType.value = '';
            alertVisibleQualityTiers.clear();
            sellQualityTierDefinitions.forEach(tier => alertVisibleQualityTiers.add(tier.label));
            renderAlertTierButtons();
            updateAlertPriceDisplays();
            itemAlertName.value = '';
            itemAlertCurrency.value = 'ALL';
            [itemAlertPriceMin, itemAlertPriceMax, itemAlertQuantityMin].forEach(input => { input.value = ''; });
            updateItemAlertPriceDisplays();
            alertCreate.textContent = `🔔 ${tr('alertCreate')}`;
            itemAlertCreate.textContent = '🔔 Crear alerta de objeto';
            alertEditCancel.hidden = true;
            itemAlertEditCancel.hidden = true;
        };
        const loadMarketAlertForEdit = (alert, itemMode) => {
            editingMarketAlert = { id:alert.id, kind:itemMode ? 'item' : 'pokemon' };
            setAlertCreationKind(itemMode ? 'item' : 'pokemon');
            alertRulesPanel.hidden = true;
            if (itemMode) {
                itemAlertName.value = alert.name || '';
                itemAlertCurrency.value = ['ALL', 'GOLD', 'DIAMONDS'].includes(alert.currency) ? alert.currency : 'ALL';
                itemAlertPriceMin.value = alert.priceMin ?? '';
                itemAlertPriceMax.value = alert.priceMax ?? '';
                itemAlertQuantityMin.value = alert.quantityMin ?? '';
                updateItemAlertPriceDisplays();
                itemAlertCreate.textContent = '💾 Guardar cambios';
                itemAlertEditCancel.hidden = false;
                itemAlertName.focus();
            } else {
                alertName.value = alert.name || '';
                alertCurrency.value = ['ALL', 'GOLD', 'DIAMONDS'].includes(alert.currency) ? alert.currency : 'ALL';
                alertPriceMin.value = alert.priceMin ?? '';
                alertPriceMax.value = alert.priceMax ?? '';
                alertShiny.checked = Boolean(alert.shiny);
                alertIvMin.value = alert.ivMin ?? '';
                alertIvMax.value = alert.ivMax ?? '';
                alertLevelMin.value = alert.levelMin ?? '';
                alertLevelMax.value = alert.levelMax ?? '';
                alertType.value = alert.type || '';
                alertVisibleQualityTiers.clear();
                const tierValues = Array.isArray(alert.tiers) ? alert.tiers : [];
                (tierValues.length ? tierValues : sellQualityTierDefinitions.map(tier => tier.label)).forEach(tier => {
                    const definition = MARKET_QUALITY_TIER_DEFINITIONS.find(item => item.id === normalizeMarketTier(tier));
                    if (definition) alertVisibleQualityTiers.add(definition.label);
                });
                renderAlertTierButtons();
                updateAlertPriceDisplays();
                alertCreate.textContent = '💾 Guardar cambios';
                alertEditCancel.hidden = false;
                alertName.focus();
            }
        };
        const removeMarketAlert = (alert, itemMode) => {
            const save = itemMode ? saveMarketItemAlerts : saveMarketAlerts;
            const get = itemMode ? getMarketItemAlerts : getMarketAlerts;
            const getSeen = itemMode ? getMarketItemAlertSeenKeys : getMarketAlertSeenKeys;
            const saveSeen = itemMode ? saveMarketItemAlertSeenKeys : saveMarketAlertSeenKeys;
            save(get().filter(item => item.id !== alert.id));
            const seen = getSeen();
            [...seen].filter(key => key.startsWith(`${alert.id}:`)).forEach(key => seen.delete(key));
            saveSeen(seen);
            if (editingMarketAlert?.id === alert.id) resetMarketAlertEditor();
            renderAlertRules();
            if (marketMode === 'alerts') render();
        };
        const clearAllMarketAlerts = () => {
            const total = getMarketAlerts().length + getMarketItemAlerts().length;
            if (!total) return;
            if (!window.confirm('¿Eliminar todas las alertas activas de Pokémon y objetos?')) return;
            saveMarketAlerts([]);
            saveMarketItemAlerts([]);
            saveMarketAlertSeenKeys(new Set());
            saveMarketItemAlertSeenKeys(new Set());
            saveMarketAlertInbox([]);
            saveMarketItemAlertInbox([]);
            resetMarketAlertEditor();
            renderAlertRules();
            if (marketMode === 'alerts') render();
            showWindowMessage(backdrop.querySelector('.script-market-window'), 'Todas las alertas fueron eliminadas.');
        };
        const renderAlertRules = () => {
            const itemMode = alertRulesKind === 'item';
            const alerts = itemMode ? getMarketItemAlerts() : getMarketAlerts();
            alertRules.innerHTML = '';
            const totalRules = getMarketAlerts().length + getMarketItemAlerts().length;
            alertRulesCount.textContent = totalRules > 99 ? '99+' : String(totalRules);
            alertRulesTabs.forEach(tab => tab.classList.toggle('on', tab.dataset.alertRuleKind === alertRulesKind));
            if (!alerts.length) {
                alertRules.innerHTML = `<small style="color:#8fa9b7;font-size:10px;">${escapeHTML(tr('alertNoRules'))}</small>`;
                return;
            }
            const heading = document.createElement('div');
            heading.className = 'market-alert-rule-heading';
            heading.innerHTML = `<span>${itemMode ? '📦 Alertas de objetos' : '🔔 Alertas de Pokémon'}</span><span>${alerts.length}</span>`;
            alertRules.appendChild(heading);
            alerts.slice().reverse().forEach(alert => {
                const rule = document.createElement('div');
                rule.className = 'market-alert-rule';
                const name = alert.name || (itemMode ? 'Cualquier objeto' : tr('alertAnyPokemon'));
                const icon = itemMode ? '📦' : '🔔';
                const details = itemMode
                    ? `${alert.currency === 'DIAMONDS' ? '💎' : alert.currency === 'GOLD' ? '💲' : '💰'} ${alert.priceMin || '0'}–${alert.priceMax || '∞'}${alert.quantityMin !== '' && alert.quantityMin != null ? ` · ${alert.quantityMin}+ unidades` : ''}`
                    : describeMarketAlert(alert);
                const tierIds = itemMode ? [] : getMarketAlertTierIds(alert);
                const tierTags = tierIds.length
                    ? tierIds.map(id => MARKET_QUALITY_TIER_DEFINITIONS.find(definition => definition.id === id)?.label).filter(Boolean)
                    : (itemMode ? [] : ['Todos los tiers']);
                const autoEnabled = itemMode ? isMarketItemAlertAutoBuyEnabled() : isMarketAlertAutoBuyEnabled();
                const tags = [...tierTags, ...(autoEnabled ? ['⚡ Compra automática'] : [])];
                rule.innerHTML = `<span class="market-alert-rule-icon">${icon}</span><div class="market-alert-rule-content"><b title="${escapeHTML(name)}">${escapeHTML(name)}</b><small>${escapeHTML(details)}</small><span class="market-alert-rule-tags">${tags.map(tag => `<span class="market-alert-tag${tag.startsWith('⚡') ? ' is-auto' : ''}">${escapeHTML(tag)}</span>`).join('')}</span></div>`;
                const actions = document.createElement('div');
                actions.className = 'market-alert-actions';
                const edit = document.createElement('button');
                edit.type = 'button'; edit.className = 'market-alert-edit'; edit.textContent = '✎ Editar'; edit.title = 'Editar alerta';
                edit.addEventListener('click', () => loadMarketAlertForEdit(alert, itemMode));
                const copy = document.createElement('button');
                copy.type = 'button'; copy.className = 'market-alert-copy'; copy.textContent = '⧉ Copiar'; copy.title = tr('alertCopyFilters'); copy.hidden = itemMode;
                copy.addEventListener('click', async () => {
                    try {
                        const copied = await copyMarketAlertFilters(serializeMarketAlertFilters(alert));
                        showWindowMessage(backdrop.querySelector('.script-market-window'), copied ? tr('alertFiltersCopied') : 'Copia manualmente los datos mostrados.');
                    } catch (error) {
                        showWindowMessage(backdrop.querySelector('.script-market-window'), error.message || tr('alertFiltersInvalid'), true);
                    }
                });
                const remove = document.createElement('button');
                remove.type = 'button'; remove.className = 'market-alert-remove'; remove.textContent = '🗑 Eliminar'; remove.title = tr('alertRemove');
                remove.addEventListener('click', () => removeMarketAlert(alert, itemMode));
                actions.append(edit, copy, remove);
                rule.appendChild(actions);
                alertRules.appendChild(rule);
            });
        };
        const updateMarketBalance = async characterPayload => {
            try {
                const payload = characterPayload || await gameApiRequest('/api/characters/me');
                const character = payload?.character || payload || {};
                const gold = Math.max(0, Number(character.gold ?? payload?.gold ?? 0) || 0);
                const diamonds = Math.max(0, Math.floor(Number(character.diamonds ?? payload?.diamonds ?? 0) || 0));
                balanceGold.textContent = formatMarketValue(gold, 'GOLD');
                balanceDiamonds.textContent = formatMarketValue(diamonds, 'DIAMONDS');
                if (alertAccountContext) {
                    const account = { name:character.name || character.username || character.playerName || '—', gold, diamonds };
                    alertAccountContext.textContent = formatMarketAlertAccount(account);
                }
                balanceGold.closest('.market-balance-pill')?.setAttribute('title', `${tr('gold')}: ${formatMarketValue(gold, 'GOLD')}`);
                balanceDiamonds.closest('.market-balance-pill')?.setAttribute('title', `${tr('diamonds')}: ${formatMarketValue(diamonds, 'DIAMONDS')}`);
            } catch (error) {
                console.warn('No se pudo actualizar el balance del Mercado Global.', error);
                balanceGold.textContent = '—';
                balanceDiamonds.textContent = '—';
            }
        };
        const getConvertedMarketPrice = (price, currency) => {
            if (!(diamondPdRate > 0) || !(price >= 0)) return null;
            return currency === 'DIAMONDS'
                ? { value: price * diamondPdRate, currency: 'GOLD', icon: '💲' }
                : { value: price / diamondPdRate, currency: 'DIAMONDS', icon: '💎' };
        };
        const marketPriceInPd = entry => {
            const price = getMarketEntryPrice(entry);
            return getMarketEntryCurrency(entry) === 'DIAMONDS' && diamondPdRate > 0
                ? price * diamondPdRate
                : price;
        };
        const updateExchangeRate = () => {
            exchangeRate.textContent = diamondPdRate > 0
                ? `💎 1 ≈ 💲 ${formatMarketValue(diamondPdRate, 'GOLD')}`
                : '💎 ↔ 💲 indisponível';
            const price = Number(sellPrice.value);
            const converted = getConvertedMarketPrice(price, normalizeMarketCurrency(sellCurrency.value));
            sellConversion.textContent = converted && price > 0
                ? `≈ ${converted.icon} ${formatMarketValue(converted.value, converted.currency)}`
                : '';
        };
        const getSellFinancials = (entry = selectedSellEntry) => {
            if (!entry) return null;
            const price = Math.max(0, Math.floor(Number(sellPrice.value) || 0));
            const quantity = entry.kind === 'pokemon'
                ? 1
                : Math.max(1, Math.min(Number(entry.quantity) || 1, Math.floor(Number(sellQty.value) || 1)));
            const currency = normalizeMarketCurrency(sellCurrency.value);
            const gross = price * quantity;
            const vipRate = latestAutohelper?.isVip ? 0.02 : 0.03;
            const isDiamondItem = Boolean(entry.isDiamond || entry.marketKind === 'diamonds');
            let fee = 0;
            let feeRate = 0;
            if (entry.kind === 'pokemon' && currency === 'DIAMONDS' && price > 0) {
                feeRate = 0.01;
                fee = Math.max(1, Math.ceil(gross * feeRate));
            } else if (!isDiamondItem && currency === 'GOLD' && gross > 0) {
                feeRate = vipRate;
                fee = Math.min(1000000, Math.floor(gross * feeRate));
            }
            return { price, quantity, currency, gross, fee, feeRate, net: Math.max(0, gross - fee) };
        };
        const updateSellFinancialSummary = () => {
            const values = getSellFinancials();
            if (!values || values.price < 1) {
                sellGross.textContent = '—';
                sellFee.textContent = '—';
                sellNet.textContent = '—';
                return;
            }
            const icon = values.currency === 'DIAMONDS' ? '💎' : '💲';
            sellGross.textContent = `${icon} ${formatMarketValue(values.gross, values.currency)}`;
            sellFee.textContent = values.fee > 0
                ? `${icon} ${formatMarketValue(values.fee, values.currency)} · ${Math.round(values.feeRate * 100)}%`
                : `✓ ${tr('feeExempt')}`;
            sellNet.textContent = `${icon} ${formatMarketValue(values.net, values.currency)}`;
        };

        const getRequestCatalog = (payload = currentMarketPayload) => {
            const catalog = payload?.catalog || {};
            const normalizeCatalogGroup = (value, fallbackKind) => {
                if (!value) return [];
                let entries;
                if (Array.isArray(value)) entries = value;
                else if (typeof value === 'object' && ('id' in value || 'refId' in value || 'name' in value || 'kind' in value)) entries = [value];
                else if (typeof value === 'object') entries = Object.values(value);
                else entries = [];
                return entries.filter(entry => entry && typeof entry === 'object').map(entry => ({
                    ...entry,
                    kind: entry.kind || entry.type || fallbackKind,
                    refId: entry.refId ?? entry.id,
                    name: entry.name || entry.title || `#${entry.refId ?? entry.id}`
                }));
            };
            const entries = [
                ...normalizeCatalogGroup(catalog.items, 'item'),
                ...normalizeCatalogGroup(catalog.balls, 'ball'),
                ...normalizeCatalogGroup(catalog.diamonds, 'diamond')
            ]
                .filter(entry => entry.refId != null);
            if (entries.length) {
                const merged = new Map(requestCatalogCache.map(entry => [`${entry.kind}:${entry.refId}`, entry]));
                entries.forEach(entry => merged.set(`${entry.kind}:${entry.refId}`, entry));
                requestCatalogCache = [...merged.values()];
            }
            return requestCatalogCache.length ? requestCatalogCache : entries;
        };

        const requestKey = entry => `${entry.kind}:${entry.refId}`;
        const getRequestCatalogImage = entry => getMarketEntryImage(entry) || (entry.kind === 'diamond' ? '/assets/market/diamonds.png' : '');
        const getRequestFee = (amount, price) => Math.min(1000000, Math.floor(amount * price * (latestAutohelper?.isVip ? 0.02 : 0.03)));
        const readRequestForm = () => {
            const amount = Math.max(1, Math.min(100, Math.floor(Number(requestQty.value) || 1)));
            const price = Math.max(1, Math.floor(Number(requestPrice.value) || 1));
            requestQty.value = String(amount);
            requestPrice.value = String(price);
            const custody = amount * price;
            const fee = getRequestFee(amount, price);
            return { amount, price, custody, fee, total: custody + fee };
        };
        const updateRequestForm = () => {
            const values = readRequestForm();
            requestSubmit.disabled = !requestItem.value;
            requestSummary.innerHTML = `
                <span>${tr('requestCustody')}: <strong>💲 ${formatMarketValue(values.custody, 'GOLD')}</strong></span>
                <span>${tr('requestFee')}: <strong>💲 ${formatMarketValue(values.fee, 'GOLD')}</strong></span>
                <span class="request-total">${tr('requestTotal')}: <strong>💲 ${formatMarketValue(values.total, 'GOLD')}</strong></span>`;
        };
        const selectRequestCatalogEntry = entry => {
            requestItem.value = entry ? requestKey(entry) : '';
            requestSearch.value = entry?.name || '';
            const image = entry ? getRequestCatalogImage(entry) : '';
            requestSelectedArt.innerHTML = image ? `<img src="${escapeHTML(image)}" alt="">` : (entry?.kind === 'diamond' ? '💎' : '🔎');
            requestSelectedArt.querySelector('img')?.addEventListener('error', event => {
                event.currentTarget.replaceWith(document.createTextNode(entry?.kind === 'diamond' ? '💎' : '📦'));
            }, { once: true });
            requestOptions.hidden = true;
            updateRequestForm();
        };
        const renderRequestCatalogOptions = queryValue => {
            const query = String(queryValue || '').trim().toLocaleLowerCase(locale());
            const catalog = getRequestCatalog();
            const filtered = catalog.filter(entry => !query || entry.name.toLocaleLowerCase(locale()).includes(query)).slice(0, 100);
            requestOptions.innerHTML = '';
            if (!filtered.length) {
                requestOptions.innerHTML = `<div class="market-request-no-results">${tr('noListings')}</div>`;
                requestOptions.hidden = false;
                return;
            }
            filtered.forEach(entry => {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = `market-request-option${requestItem.value === requestKey(entry) ? ' on' : ''}`;
                const image = getRequestCatalogImage(entry);
                const fallback = entry.kind === 'diamond' ? '💎' : '📦';
                option.innerHTML = `${image ? `<img src="${escapeHTML(image)}" alt="">` : `<span>${fallback}</span>`}<b>${escapeHTML(entry.name)}</b><small>${escapeHTML(entry.kind)}</small>`;
                option.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: fallback }));
                }, { once: true });
                option.addEventListener('mousedown', event => event.preventDefault());
                option.addEventListener('click', () => selectRequestCatalogEntry(entry));
                requestOptions.appendChild(option);
            });
            requestOptions.hidden = false;
        };
        const populateRequestCatalog = () => {
            const catalog = getRequestCatalog();
            const selected = catalog.find(entry => requestKey(entry) === requestItem.value);
            if (selected) selectRequestCatalogEntry(selected);
            else if (requestItem.value) selectRequestCatalogEntry(null);
            updateRequestForm();
        };
        const appendMarketSection = (label, count, icon) => {
            const heading = document.createElement('div');
            heading.className = 'market-section-title';
            heading.innerHTML = `<span>${icon}</span>${escapeHTML(label)}<small>${Number(count).toLocaleString(locale())}</small>`;
            list.appendChild(heading);
        };
        const getRequestDisplay = entry => {
            const ref = entry.item || entry.product || {};
            return {
                name: entry.name || entry.itemName || ref.name || ref.title || `#${entry.refId ?? entry.id}`,
                amount: Math.max(1, Number(entry.amount ?? entry.quantity ?? 1) || 1),
                price: Math.max(0, Number(entry.price ?? 0) || 0),
                image: getMarketEntryImage(entry)
            };
        };
        const createRequestRow = (entry, owned) => {
            const display = getRequestDisplay(entry);
            const row = document.createElement('div');
            row.className = 'market-buy-row market-request-row';
            row.innerHTML = `
                <div class="market-art">${display.image ? `<img src="${escapeHTML(display.image)}" alt="${escapeHTML(display.name)}">` : '<span>📦</span>'}</div>
                <div class="market-main"><small class="market-kind-label">${owned ? tr('myRequests') : tr('openRequests')}</small><b class="market-item-name">${escapeHTML(display.name)}</b><small class="market-meta">${tr('perUnit')}</small></div>
                <div class="market-quantity">${tr('quantity')}<b>${display.amount.toLocaleString(locale())}</b></div>
                <div class="market-price">💲 ${formatMarketValue(display.price, 'GOLD')}</div>`;
            row.querySelector('img')?.addEventListener('error', event => {
                event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: '📦' }));
            }, { once: true });
            const actions = document.createElement('div');
            actions.className = 'market-actions';
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = `mk-bulk-btn ${owned ? 'market-request-cancel' : 'market-buy'}`;
            actionButton.textContent = owned ? tr('cancelRequest') : tr('sellToRequest');
            actionButton.addEventListener('click', async () => {
                if (owned) {
                    if (!await showScriptConfirm(`${tr('cancelRequest')}: ${display.name}?`, { title: tr('marketRequests'), confirmLabel: tr('cancelRequest') })) return;
                    actionButton.disabled = true;
                    try {
                        await gameApiRequest('/api/game/market/action', { method: 'POST', body: JSON.stringify({ action: 'request-cancel', id: entry.id }) });
                        showWindowMessage(backdrop.querySelector('.script-market-window'), tr('requestCanceled'));
                        await load();
                    } catch (error) {
                        showWindowMessage(backdrop.querySelector('.script-market-window'), error.message, true);
                        actionButton.disabled = false;
                    }
                    return;
                }
                const quantityValue = await showScriptQuantityPrompt(`${display.name} · 💲 ${formatMarketValue(display.price, 'GOLD')} ${tr('perUnit')}`, display.amount);
                if (quantityValue == null) return;
                const quantity = Math.max(1, Math.min(display.amount, Math.floor(Number(quantityValue) || 1)));
                const total = quantity * display.price;
                if (!await showScriptConfirm(`${tr('requestSellConfirm')}\n${quantity}× ${display.name} = 💲 ${formatMarketValue(total, 'GOLD')}`, { title: tr('sellToRequest'), confirmLabel: tr('sellToRequest') })) return;
                actionButton.disabled = true;
                try {
                    await gameApiRequest('/api/game/market/action', { method: 'POST', body: JSON.stringify({ action: 'request-sell', id: entry.id, quantity }) });
                    showWindowMessage(backdrop.querySelector('.script-market-window'), tr('requestSold'));
                    await updateMarketBalance();
                    await load();
                } catch (error) {
                    showWindowMessage(backdrop.querySelector('.script-market-window'), error.message, true);
                    actionButton.disabled = false;
                }
            });
            actions.appendChild(actionButton);
            row.appendChild(actions);
            return row;
        };
        const filterRequests = entries => {
            const query = requestFilterSearch.value.trim().toLocaleLowerCase(locale());
            let filtered = entries.filter(entry => {
                const ref = entry.item || entry.product || {};
                const name = entry.name || entry.itemName || entry.title || ref.name || ref.title || '';
                if (query && !String(name).toLocaleLowerCase(locale()).includes(query)) return false;
                const category = getListingCategory(entry);
                if (requestFilterCategory.value !== 'All' && loadedRequestCategory === 'All' && category !== requestFilterCategory.value) return false;
                if (requestFilterRarity.value && !['Pokemon', 'Diamonds'].includes(category)
                    && getMarketItemRarityTheme(entry).key !== requestFilterRarity.value) return false;
                return true;
            });
            const sorters = {
                'price-asc': (a, b) => getMarketEntryPrice(a) - getMarketEntryPrice(b),
                'price-desc': (a, b) => getMarketEntryPrice(b) - getMarketEntryPrice(a),
                'quantity-desc': (a, b) => Number(b.amount ?? b.quantity ?? 1) - Number(a.amount ?? a.quantity ?? 1)
            };
            if (sorters[requestFilterSort.value]) filtered = [...filtered].sort(sorters[requestFilterSort.value]);
            return filtered;
        };
        const renderRequests = () => {
            list.innerHTML = '';
            const allMine = Array.isArray(currentMarketPayload?.myRequests) ? currentMarketPayload.myRequests : [];
            const mineIds = new Set(allMine.map(entry => String(entry.id)));
            const allOpen = (Array.isArray(currentMarketPayload?.requests) ? currentMarketPayload.requests : [])
                .filter(entry => !mineIds.has(String(entry.id)));
            const mine = filterRequests(allMine);
            const open = filterRequests(allOpen);
            if (mine.length) {
                appendMarketSection(tr('myRequests'), mine.length, '📌');
                mine.forEach(entry => list.appendChild(createRequestRow(entry, true)));
            }
            appendMarketSection(tr('openRequests'), open.length, '📥');
            if (open.length) open.forEach(entry => list.appendChild(createRequestRow(entry, false)));
            else {
                const empty = document.createElement('div');
                empty.className = 'market-request-empty';
                empty.textContent = tr('noRequests');
                list.appendChild(empty);
            }
            status.textContent = `${mine.length.toLocaleString(locale())}/${allMine.length.toLocaleString(locale())} ${tr('myRequests')} · ${open.length.toLocaleString(locale())}/${allOpen.length.toLocaleString(locale())} ${tr('openRequests')}`;
        };
        const getMarketHistoryDate = entry => {
            const value = entry.at ?? entry.soldAt ?? entry.completedAt ?? entry.createdAt ?? entry.updatedAt ?? entry.date ?? entry.timestamp;
            if (value == null || value === '') return null;
            const numeric = Number(value);
            const date = Number.isFinite(numeric)
                ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
                : new Date(value);
            return Number.isNaN(date.getTime()) ? null : date;
        };
        const formatMarketRelativeTime = date => {
            if (!date) return '';
            const elapsedSeconds = Math.round((date.getTime() - Date.now()) / 1000);
            const absolute = Math.abs(elapsedSeconds);
            if (absolute < 45) return tr('historyJustNow');
            const ranges = [
                ['year', 31536000], ['month', 2592000], ['week', 604800],
                ['day', 86400], ['hour', 3600], ['minute', 60]
            ];
            const [unit, seconds] = ranges.find(([, size]) => absolute >= size) || ['second', 1];
            return new Intl.RelativeTimeFormat(locale(), { numeric:'always' }).format(Math.round(elapsedSeconds / seconds), unit);
        };
        const renderHistory = () => {
            list.innerHTML = '';
            const history = Array.isArray(currentMarketPayload?.history) ? currentMarketPayload.history : [];
            appendMarketSection(tr('marketHistory'), history.length, '📜');
            if (!history.length) {
                const empty = document.createElement('div');
                empty.className = 'market-request-empty';
                empty.textContent = tr('historyEmpty');
                list.appendChild(empty);
                status.textContent = tr('historyEmpty');
                return;
            }
            history.forEach(entry => {
                const bought = Boolean(entry.bought);
                const amount = Math.max(1, Number(entry.amount ?? entry.quantity ?? 1) || 1);
                const price = Math.max(0, Number(entry.price ?? 0) || 0);
                const currency = normalizeMarketCurrency(entry.currency);
                const currencyIcon = currency === 'DIAMONDS' ? '💎' : '💲';
                const row = document.createElement('div');
                row.className = `market-buy-row market-history-row ${bought ? 'bought' : 'sold'}`;
                const date = getMarketHistoryDate(entry);
                const dateText = date ? date.toLocaleString(locale()) : '—';
                const relativeTime = formatMarketRelativeTime(date);
                const historyName = entry.name || entry.itemName || entry.pokemonName || `#${entry.id || ''}`;
                const normalizedName = String(historyName).toLocaleLowerCase(locale()).trim();
                const kind = String(entry.kind || entry.type || '').toLowerCase();
                const catalogMatch = getRequestCatalog().find(candidate => candidate.name.toLocaleLowerCase(locale()).trim() === normalizedName);
                const listingMatch = currentListings.find(candidate => {
                    const ref = candidate.item || candidate.pokemon || candidate.product || {};
                    const candidateName = candidate.name || candidate.itemName || candidate.pokemonName || ref.name || ref.title || '';
                    return candidateName.toLocaleLowerCase(locale()).trim() === normalizedName;
                });
                const cleanPokemonHistoryName = String(historyName).replace(/^shiny\s+/i, '').replace(/\s+(?:lv\.?|level)\s*\d+.*$/i, '').trim();
                const creature = globalCreatureApiData.get(normalizePokemonName(cleanPokemonHistoryName));
                const creatureId = creature?.speciesId ?? creature?.id ?? creature?.number ?? creature?.dexId;
                const looksLikePokemon = /pokemon|pokémon|creature/.test(kind) || Boolean(entry.pokemon || entry.speciesId || entry.pokemonId || creature);
                const historyImage = getMarketEntryImage(entry)
                    || (looksLikePokemon ? getPokemonIconUrl(entry.speciesId ?? entry.pokemonId ?? creatureId) : '')
                    || (catalogMatch ? getRequestCatalogImage(catalogMatch) : '')
                    || (listingMatch ? getMarketEntryImage(listingMatch) : '')
                    || getMarketEntryImage({ name: historyName, refId: entry.refId ?? entry.itemId, kind });
                const fallback = looksLikePokemon ? '◉' : '📦';
                row.innerHTML = `
                    <div class="market-art">${historyImage ? `<img src="${escapeHTML(historyImage)}" alt="${escapeHTML(historyName)}">` : `<span>${fallback}</span>`}</div>
                    <div class="market-main"><small class="market-history-state ${bought ? 'bought' : 'sold'}">${bought ? tr('historyBought') : tr('historySold')}${entry.offer ? ` · ${tr('offerTag')}` : ''}</small><b class="market-item-name">${escapeHTML(historyName)}</b><small class="market-meta">${escapeHTML(dateText)}${relativeTime ? ` · <span class="market-history-relative">${escapeHTML(relativeTime)}</span>` : ''}</small></div>
                    <div class="market-quantity">${tr('quantity')}<b>${amount.toLocaleString(locale())}</b></div>
                    <div class="market-price">${currencyIcon} ${formatMarketValue(price, currency)}<small>${tr('perUnit')}</small></div>
                    <div class="market-actions"></div>`;
                row.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: fallback }));
                }, { once: true });
                list.appendChild(row);
            });
            status.textContent = `${history.length.toLocaleString(locale())} ${tr('marketHistory')}`;
        };

        const getListingCategory = entry => {
            const ref = entry?.item || entry?.pokemon || entry?.product || {};
            const kind = getMarketEntryKind(entry);
            if (kind === 'pokemon' || entry?.speciesId != null || ref?.speciesId != null || entry?.pokemon) return 'Pokemon';
            if (/diamond/.test(kind)) return 'Diamonds';
            if (kind === 'ball' || kind === 'pokeball' || kind === 'poke-ball' || kind === 'poke_ball') return 'Poke Balls';
            const itemId = getMarketEntryRefId(entry);
            const name = entry?.name || entry?.itemName || ref?.name || '';
            const itemData = globalItemApiData.get(String(itemId)) || globalItemApiData.get(String(name).toLowerCase().trim()) || {};
            const itemCategory = String(entry?.category || ref?.category || itemData.category || '').toLowerCase();
            if (kind === 'stone' || itemCategory === 'stone') return 'Stones';
            return 'Items';
        };

        const renderMyListings = () => {
            const query = search.value.trim().toLocaleLowerCase(locale());
            let filtered = currentMyListings.filter(entry => {
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || '';
                if (query && !String(name).toLocaleLowerCase(locale()).includes(query)) return false;
                if (activeCategory !== 'All' && getListingCategory(entry) !== activeCategory) return false;
                const currency = getMarketEntryCurrency(entry);
                if (currency === 'GOLD' && !showGold.checked) return false;
                if (currency === 'DIAMONDS' && !showDiamonds.checked) return false;
                const isPokemon = getListingCategory(entry) === 'Pokemon';
                if (!isPokemon && itemRarityFilter.value && getMarketItemRarityTheme(entry).key !== itemRarityFilter.value) return false;
                if (isPokemon) {
                    const iv = Number(entry.ivTotal ?? ref.ivTotal ?? entry.iv ?? ref.iv ?? -1);
                    const level = Number(entry.level ?? ref.level ?? -1);
                    const quality = Number(entry.quality ?? ref.quality ?? -1);
                    const tier = getMarketPokemonQualityTheme(quality)?.label || 'Fraca';
                    if (!mineVisibleQualityTiers.has(tier)) return false;
                    if (shinyOnly.checked && !(entry.shiny ?? ref.shiny)) return false;
                    if (ivMin.value !== '' && iv < Number(ivMin.value)) return false;
                    if (ivMax.value !== '' && iv > Number(ivMax.value)) return false;
                    if (levelMin.value !== '' && level < Number(levelMin.value)) return false;
                    if (levelMax.value !== '' && level > Number(levelMax.value)) return false;
                    if (qualityMin.value !== '' && quality < Number(qualityMin.value)) return false;
                    if (qualityMax.value !== '' && quality > Number(qualityMax.value)) return false;
                    if (typeSelect.value && entry.type1 !== typeSelect.value && entry.type2 !== typeSelect.value && ref.type1 !== typeSelect.value && ref.type2 !== typeSelect.value) return false;
                }
                return true;
            });
            const sorters = {
                'price-asc': (a, b) => marketPriceInPd(a) - marketPriceInPd(b),
                'price-desc': (a, b) => marketPriceInPd(b) - marketPriceInPd(a),
                'iv-desc': (a, b) => Number(b.ivTotal ?? b.pokemon?.ivTotal ?? -1) - Number(a.ivTotal ?? a.pokemon?.ivTotal ?? -1),
                'power-desc': (a, b) => Number(b.power ?? b.pokemon?.power ?? -1) - Number(a.power ?? a.pokemon?.power ?? -1),
                'level-desc': (a, b) => Number(b.level ?? b.pokemon?.level ?? -1) - Number(a.level ?? a.pokemon?.level ?? -1),
                'quality-desc': (a, b) => Number(b.quality ?? b.pokemon?.quality ?? -1) - Number(a.quality ?? a.pokemon?.quality ?? -1)
            };
            if (sorters[sortSelect.value]) filtered = [...filtered].sort(sorters[sortSelect.value]);
            const visible = filtered.slice(0, renderLimit);
            list.innerHTML = '';
            status.textContent = filtered.length
                ? `${tr('showing')} ${visible.length.toLocaleString(locale())} ${tr('of')} ${filtered.length.toLocaleString(locale())} · ${tr('marketMyListings')}`
                : tr('marketMyListingsEmpty');
            visible.forEach(entry => {
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || '—';
                const category = getListingCategory(entry);
                const isPokemon = category === 'Pokemon';
                const price = getMarketEntryPrice(entry);
                const quantity = Number(entry.quantity ?? entry.qty ?? entry.amount ?? 1);
                const currency = getMarketEntryCurrency(entry);
                const currencyIcon = currency === 'DIAMONDS' ? '💎' : '💲';
                const converted = getConvertedMarketPrice(price, currency);
                const conversionText = converted ? `≈ ${converted.icon} ${formatMarketValue(converted.value, converted.currency)}` : '—';
                const quality = entry.quality ?? ref.quality;
                const ivTotal = entry.ivTotal ?? ref.ivTotal ?? entry.iv ?? ref.iv;
                const stats = entry.stats || ref.stats || {};
                const qualityTheme = isPokemon ? getMarketPokemonQualityTheme(quality) : null;
                const itemTheme = !isPokemon && category !== 'Diamonds' ? getMarketItemRarityTheme(entry) : null;
                const row = document.createElement('div');
                row.className = `market-buy-row market-listing-row market-own-listing${isPokemon ? ' market-pokemon-listing' : ''}`;
                if (qualityTheme) {
                    row.classList.add('market-pokemon-quality');
                    row.style.setProperty('--market-tier-color', qualityTheme.color);
                }
                if (itemTheme) {
                    row.classList.add('market-item-rarity');
                    row.style.setProperty('--market-item-color', itemTheme.color);
                }
                const image = getMarketEntryImage(entry);
                const fallbackIcon = isPokemon ? '◉' : category === 'Diamonds' ? '💎' : '📦';
                const kindLabel = isPokemon ? 'POKÉMON' : category === 'Poke Balls' ? 'POKÉ BALL' : category === 'Diamonds' ? 'MONEDA' : category === 'Stones' ? 'STONE' : 'OBJETO / DROP';
                const details = isPokemon ? [ivTotal != null ? `${tr('ivTotal')}: ${ivTotal}/192` : '', quality != null ? `Q: ${Number(quality).toFixed(2)}` : ''].filter(Boolean).join(' · ') : '';
                const statsHTML = isPokemon ? getMarketPokemonStatsHTML(stats) : '';
                const typesHTML = isPokemon ? getMarketPokemonTypesHTML(entry) : '';
                const badge = qualityTheme ? `<small class="market-quality-tier">${qualityTheme.label}</small>` : itemTheme ? `<small class="market-item-rarity-badge">${escapeHTML(itemTheme.label)}</small>` : '';
                row.innerHTML = `
                    <div class="market-art">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(name)}">` : `<span>${fallbackIcon}</span>`}</div>
                    <div class="market-main"><small class="market-kind-label">${kindLabel} · ${tr('marketMyListings')}</small><b class="market-item-name">${escapeHTML(name)}</b>${details ? `<small class="market-meta">${escapeHTML(details)}</small>` : ''}${typesHTML}${badge}</div>
                    ${statsHTML ? `<small class="market-stats market-card-stats">${statsHTML}</small>` : ''}
                    <div class="market-buy-footer">
                        ${isPokemon ? '' : `<div class="market-quantity market-data-box"><small class="market-data-label">${tr('quantity')}</small><b>${quantity.toLocaleString(locale())}</b></div>`}
                        <div class="market-price market-data-box"><small class="market-data-label">${tr('unitPrice')}</small><b>${currencyIcon} ${formatMarketValue(price, currency)}</b></div>
                        <div class="market-conversion market-data-box"><small class="market-data-label">${tr('marketConversion')}</small><b>${conversionText}</b></div>
                    </div>`;
                row.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: fallbackIcon }));
                }, { once: true });
                const cancelButton = document.createElement('button');
                cancelButton.type = 'button';
                cancelButton.className = 'mk-bulk-btn market-cancel-listing';
                cancelButton.textContent = tr('marketCancelListing');
                cancelButton.addEventListener('click', async () => {
                    if (!await showScriptConfirm(`${tr('marketCancelListingConfirm')}\n${name}`, { title: tr('marketMyListings'), confirmLabel: tr('marketCancelListing') })) return;
                    cancelButton.disabled = true;
                    try {
                        await gameApiRequest('/api/game/market/action', { method: 'POST', body: JSON.stringify({ action: 'cancel', id: entry.id }) });
                        showWindowMessage(backdrop.querySelector('.script-market-window'), tr('marketListingCanceled'));
                        await load();
                    } catch (error) {
                        showWindowMessage(backdrop.querySelector('.script-market-window'), error.message, true);
                        cancelButton.disabled = false;
                    }
                });
                const actions = document.createElement('div');
                actions.className = 'market-actions';
                actions.appendChild(cancelButton);
                row.querySelector('.market-buy-footer').appendChild(actions);
                if (isPokemon) bindMarketIvCard(row, entry);
                list.appendChild(row);
            });
            if (visible.length < filtered.length) {
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'mk-bulk-btn';
                more.style.cssText = 'margin:5px auto;padding:8px 18px;';
                more.textContent = `${tr('loadMore')} (+${Math.min(100, filtered.length - visible.length)})`;
                more.addEventListener('click', () => { renderLimit += 100; renderMyListings(); });
                list.appendChild(more);
            }
        };

        const clearSellReference = () => {
            sellReferenceRequestId += 1;
            sellReference.style.display = 'none';
            sellReference.textContent = '';
        };

        const closeSellEditor = () => {
            selectedSellEntry = null;
            sellEditor.hidden = true;
            sellEditor.classList.remove('market-pokemon-quality', 'is-pokemon');
            sellEditor.style.removeProperty('--market-tier-color');
            sellCurrency.disabled = false;
            sellSubmit.disabled = true;
            clearSellReference();
            renderSell();
        };

        const showSellEditor = entry => {
            const isPokemon = entry?.kind === 'pokemon';
            const isDiamond = Boolean(entry?.isDiamond || entry?.marketKind === 'diamonds');
            const image = entry?.icon || getMarketEntryImage(entry);
            const qualityTheme = isPokemon ? getMarketPokemonQualityTheme(entry.quality) : null;
            const meta = isPokemon
                ? `Nivel ${entry.level ?? 1} · IV ${entry.ivTotal ?? 0}/192 · Quality ×${Number(entry.quality || 0).toFixed(2)}${entry.shiny ? ' · ✨ Shiny' : ''}`
                : `${Number(entry.quantity || 0).toLocaleString(locale())} ${tr('availableUnits')}`;
            sellEditor.hidden = false;
            sellEditorName.textContent = entry.name;
            sellEditorMeta.textContent = meta;
            sellEditorArt.innerHTML = image
                ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(entry.name)}">`
                : `<span>${isPokemon ? '◉' : '📦'}</span>`;
            sellEditorArt.querySelector('img')?.addEventListener('error', event => {
                event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: isPokemon ? '◉' : '📦' }));
            }, { once: true });
            sellEditorStats.innerHTML = isPokemon ? getMarketPokemonStatsHTML(entry.stats) : '';
            sellEditorStats.hidden = !sellEditorStats.innerHTML;
            const pokemonLocked = isPokemon && isNativeLocked(entry);
            sellEditorLock.hidden = !isPokemon;
            sellEditorLock.textContent = pokemonLocked ? '🔒' : '🔓';
            sellEditorLock.classList.toggle('locked', pokemonLocked);
            sellEditorLock.title = pokemonLocked ? tr('unlockPokemon') : tr('lockPokemon');
            sellQtyField.hidden = isPokemon;
            sellEditor.classList.toggle('is-pokemon', isPokemon);
            sellQty.max = String(entry.quantity || 1);
            sellQty.value = String(Math.min(Number(sellQty.value) || 1, entry.quantity || 1));
            // Los diamantes son un artículo comerciable, pero el mercado nativo
            // solamente permite anunciarlos a cambio de Poké Dólares.
            if (isDiamond) sellCurrency.value = 'GOLD';
            sellCurrency.disabled = isDiamond;
            sellEditorTier.hidden = !qualityTheme;
            sellEditorTier.textContent = qualityTheme?.label || '';
            sellEditor.classList.toggle('market-pokemon-quality', Boolean(qualityTheme));
            if (qualityTheme) sellEditor.style.setProperty('--market-tier-color', qualityTheme.color);
            else sellEditor.style.removeProperty('--market-tier-color');
            sellSubmit.disabled = pokemonLocked || !(Number(sellPrice.value) >= 1);
            updateExchangeRate();
            updateSellFinancialSummary();
        };

        const showSimilarPokemonWindow = (sourceEntry, matches) => {
            backdrop.querySelector('.market-similar-backdrop')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'market-similar-backdrop';
            const sourceQuality = Number(sourceEntry.quality) || 0;
            const sourceIv = Number(sourceEntry.ivTotal) || 0;
            const sourceLevel = Number(sourceEntry.level) || 1;
            const sourceTheme = getMarketPokemonQualityTheme(sourceQuality);
            overlay.innerHTML = `
                <section class="market-similar-modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(tr('similarWindowTitle'))}">
                    <header class="market-similar-head">
                        <span>🔎</span>
                        <div><b>${escapeHTML(tr('similarWindowTitle'))}</b><small>${matches.length.toLocaleString(locale())} ${escapeHTML(tr('similarPokemon'))}</small></div>
                        <button class="market-similar-close" type="button" aria-label="Close">×</button>
                    </header>
                    <div class="market-similar-target"><b>${escapeHTML(tr('comparedWith'))}:</b> ${escapeHTML(sourceEntry.name)} · Nv ${sourceLevel.toLocaleString(locale())} · IV ${sourceIv}/192 · Q ×${sourceQuality.toFixed(2)}${sourceTheme ? ` · ${escapeHTML(sourceTheme.label)}` : ''}</div>
                    <div class="market-similar-grid"></div>
                </section>`;
            const grid = overlay.querySelector('.market-similar-grid');
            matches.forEach((match, index) => {
                const listing = match.listing;
                const ref = listing?.pokemon || listing?.product || {};
                const name = listing?.name || listing?.pokemonName || ref.name || sourceEntry.name;
                const level = Number(listing?.level ?? ref.level) || 1;
                const iv = Number(listing?.ivTotal ?? ref.ivTotal) || 0;
                const quality = Number(listing?.quality ?? ref.quality) || 0;
                const theme = getMarketPokemonQualityTheme(quality) || { label: '—', color: '#3b6176' };
                const image = getMarketEntryImage(listing) || getPokemonIconUrl(listing?.speciesId ?? ref.speciesId ?? sourceEntry.speciesId);
                const currency = getMarketEntryCurrency(listing);
                const price = getMarketEntryPrice(listing);
                const icon = currency === 'DIAMONDS' ? '💎' : '💲';
                const converted = currency === 'DIAMONDS'
                    ? `≈ 💲 ${formatMarketValue(match.pdPrice, 'GOLD')}`
                    : diamondPdRate > 0
                        ? `≈ 💎 ${formatMarketValue(price / diamondPdRate, 'DIAMONDS')}`
                        : '';
                const stats = getMarketPokemonStatsHTML(listing?.stats || ref.stats || listing);
                const card = document.createElement('article');
                card.className = `market-similar-card${index === 0 ? ' best-match' : ''}`;
                card.style.setProperty('--similar-tier', theme.color);
                card.innerHTML = `
                    ${index === 0 ? `<span class="market-similar-best">★ ${escapeHTML(tr('bestSimilarMatch'))}</span>` : ''}
                    <div class="market-similar-art">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(name)}">` : '<span>◉</span>'}</div>
                    <div class="market-similar-info">
                        <span class="market-similar-name">${escapeHTML(name)} <small class="market-similar-tier">${escapeHTML(theme.label)}</small></span>
                        <small class="market-similar-meta">Nv ${level.toLocaleString(locale())} · IV ${iv}/192 · Q ×${quality.toFixed(2)}</small>
                        <small class="market-similar-delta">Δ Nivel ${Math.abs(level - sourceLevel).toLocaleString(locale())} · Δ IV ${Math.abs(iv - sourceIv)} · Δ Q ${Math.abs(quality - sourceQuality).toFixed(2)}</small>
                        ${stats ? `<small class="market-stats">${stats}</small>` : ''}
                    </div>
                    <div class="market-similar-price"><span>${icon} ${formatMarketValue(price, currency)}</span><small>${converted}</small></div>`;
                card.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: '◉' }));
                }, { once: true });
                grid.appendChild(card);
            });
            const close = () => {
                document.removeEventListener('keydown', onKeyDown);
                overlay.remove();
            };
            const onKeyDown = event => { if (event.key === 'Escape') close(); };
            overlay.querySelector('.market-similar-close').addEventListener('click', close);
            overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
            document.addEventListener('keydown', onKeyDown);
            backdrop.appendChild(overlay);
        };

        const compareSelectedSellItem = async entry => {
            if (!entry) {
                clearSellReference();
                return;
            }
            const isPokemon = entry.kind === 'pokemon';
            const requestId = ++sellReferenceRequestId;
            sellReference.style.display = 'block';
            sellReference.textContent = `${isPokemon ? tr('checkingPokemonPrice') : tr('checkingPrice')} ${entry.name}...`;
            try {
                const [marketPayload, diamondPayload] = await Promise.all([
                    gameApiRequest(`/api/game/market?category=${isPokemon ? 'Pokemon' : 'All'}`),
                    gameApiRequest('/api/game/market?category=Diamonds').catch(() => null)
                ]);
                if (requestId !== sellReferenceRequestId || selectedSellEntry !== entry) return;
                if (diamondPayload) {
                    diamondPdRate = getLowestDiamondPdPrice(getMarketListings(diamondPayload));
                    updateExchangeRate();
                }
                if (isPokemon) {
                    const normalizePokemonName = value => String(value || '')
                        .toLocaleLowerCase()
                        .normalize('NFKD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .replace(/\s+lv\.?\s*\d+.*$/i, '')
                        .trim();
                    const targetName = normalizePokemonName(entry.name);
                    const targetSpecies = entry.speciesId;
                    const targetQuality = Number(entry.quality) || 0;
                    const targetIv = Number(entry.ivTotal) || 0;
                    const targetLevel = Number(entry.level) || 1;
                    const sameSpecies = getMarketListings(marketPayload)
                        .filter(listing => {
                            const ref = listing?.pokemon || listing?.product || {};
                            const listedSpecies = listing?.speciesId ?? ref.speciesId;
                            const listedName = normalizePokemonName(listing?.name || listing?.pokemonName || ref.name);
                            const identityMatches = targetSpecies != null && listedSpecies != null
                                ? String(listedSpecies) === String(targetSpecies)
                                : Boolean(targetName && listedName === targetName);
                            return identityMatches
                                && Boolean(listing?.shiny ?? ref.shiny) === Boolean(entry.shiny)
                                && getMarketEntryPrice(listing) > 0
                                && !listing.offerOnly;
                        })
                        .map(listing => {
                            const ref = listing?.pokemon || listing?.product || {};
                            const quality = Number(listing?.quality ?? ref.quality) || 0;
                            const iv = Number(listing?.ivTotal ?? ref.ivTotal) || 0;
                            const level = Number(listing?.level ?? ref.level) || 1;
                            const qualityDelta = Math.abs(quality - targetQuality);
                            const ivDelta = Math.abs(iv - targetIv);
                            const levelDelta = Math.abs(level - targetLevel);
                            const score = qualityDelta / 0.05 * 4
                                + ivDelta / 8 * 2
                                + levelDelta / Math.max(5, targetLevel * 0.08);
                            return { listing, qualityDelta, ivDelta, levelDelta, score };
                        })
                        .sort((a, b) => a.score - b.score);
                    const closeMatches = sameSpecies.filter(match =>
                        match.qualityDelta <= 0.35
                        && match.ivDelta <= 45
                        && match.levelDelta <= Math.max(15, targetLevel * 0.25)
                    );
                    const comparable = (closeMatches.length >= 3 ? closeMatches : sameSpecies).slice(0, 24);
                    const priced = comparable
                        .map(match => {
                            const currency = getMarketEntryCurrency(match.listing);
                            const price = getMarketEntryPrice(match.listing);
                            const pdPrice = currency === 'DIAMONDS'
                                ? (diamondPdRate > 0 ? price * diamondPdRate : Number.NaN)
                                : price;
                            return { ...match, pdPrice };
                        })
                        .filter(match => Number.isFinite(match.pdPrice) && match.pdPrice > 0)
                        .sort((a, b) => a.score - b.score || a.pdPrice - b.pdPrice);
                    if (!priced.length) {
                        sellReference.textContent = `${entry.name}: ${tr('noSimilarPokemon')}`;
                        return;
                    }
                    const sortedPrices = priced.map(match => match.pdPrice).sort((a, b) => a - b);
                    const middle = Math.floor(sortedPrices.length / 2);
                    const estimatedPrice = Math.max(1, Math.floor(sortedPrices.length % 2
                        ? sortedPrices[middle]
                        : (sortedPrices[middle - 1] + sortedPrices[middle]) / 2));
                    const estimatedDd = getConvertedMarketPrice(estimatedPrice, 'GOLD');
                    const conversionText = estimatedDd
                        ? ` (≈ ${estimatedDd.icon} ${formatMarketValue(estimatedDd.value, estimatedDd.currency)})`
                        : '';
                    sellReference.innerHTML = `
                        <div class="market-sell-reference-content">
                            <span><b style="color:#e2e8f0;">${tr('pokemonEstimatedPrice')}</b> 💲 ${formatMarketValue(estimatedPrice, 'GOLD')}${conversionText} <span style="color:#718b9c;">· ${priced.length.toLocaleString(locale())} ${tr('similarPokemon')} · ${tr('pokemonCompareDetails')}</span></span>
                            <div class="market-sell-reference-actions">
                                <button class="mk-bulk-btn market-view-similar" type="button">🔎 ${tr('viewSimilar')}</button>
                                <button class="mk-bulk-btn market-use-suggested" type="button">${tr('useSuggested')}</button>
                            </div>
                        </div>`;
                    sellReference.querySelector('.market-view-similar').addEventListener('click', () => {
                        if (selectedSellEntry !== entry) return;
                        showSimilarPokemonWindow(entry, priced);
                    });
                    sellReference.querySelector('.market-use-suggested').addEventListener('click', () => {
                        if (selectedSellEntry !== entry) return;
                        sellCurrency.value = 'GOLD';
                        sellPrice.value = String(estimatedPrice);
                        sellCurrency.dispatchEvent(new Event('change', { bubbles: true }));
                        sellPrice.dispatchEvent(new Event('input', { bubbles: true }));
                        sellPrice.focus();
                    });
                    return;
                }
                const comparisonPayload = (entry.isDiamond || entry.marketKind === 'diamonds') && diamondPayload
                    ? diamondPayload
                    : marketPayload;
                const targetRefId = String(entry.refId);
                const targetKind = String(entry.marketKind || '').toLowerCase();
                const matches = getMarketListings(comparisonPayload).filter(listing => {
                    if (String(getMarketEntryRefId(listing)) !== targetRefId) return false;
                    const listingKind = getMarketEntryKind(listing);
                    return !targetKind || !listingKind || listingKind === targetKind;
                }).filter(listing => getMarketEntryPrice(listing) > 0 && !listing.offerOnly);
                if (!matches.length) {
                    sellReference.textContent = `${entry.name}: ${tr('noActiveAds')}`;
                    return;
                }
                const lowest = [...matches].sort((a, b) => marketPriceInPd(a) - marketPriceInPd(b))[0];
                const price = getMarketEntryPrice(lowest);
                const currency = getMarketEntryCurrency(lowest);
                const icon = currency === 'DIAMONDS' ? '💎' : '💲';
                const converted = getConvertedMarketPrice(price, currency);
                const conversionText = converted
                    ? ` (≈ ${converted.icon} ${formatMarketValue(converted.value, converted.currency)})`
                    : '';
                sellReference.innerHTML = `
                    <div class="market-sell-reference-content">
                        <span><b style="color:#e2e8f0;">${tr('lowestUnitPrice')}</b> ${icon} ${formatMarketValue(price, currency)}${conversionText} <span style="color:#718b9c;">· ${matches.length.toLocaleString(locale())} ${tr('comparedAds')}</span></span>
                        <button class="mk-bulk-btn market-use-suggested" type="button">${tr('useSuggested')}</button>
                    </div>`;
                sellReference.querySelector('.market-use-suggested').addEventListener('click', () => {
                    if (selectedSellEntry !== entry) return;
                    sellCurrency.value = currency;
                    sellPrice.value = String(Math.max(1, Math.floor(price)));
                    sellCurrency.dispatchEvent(new Event('change', { bubbles: true }));
                    sellPrice.dispatchEvent(new Event('input', { bubbles: true }));
                    sellPrice.focus();
                });
            } catch (error) {
                if (requestId !== sellReferenceRequestId || selectedSellEntry !== entry) return;
                sellReference.textContent = `No se pudo consultar el precio actual de ${entry.name}.`;
            }
        };

        const renderSell = () => {
            if (marketMode !== 'sell') {
                sellQualityTiers.classList.remove('visible');
                return;
            }
            const query = sellSearch.value.trim().toLocaleLowerCase();
            const isPokemon = sellKind.value === 'pokemon';
            sellIvMin.style.display = isPokemon ? '' : 'none';
            sellQualityMin.style.display = isPokemon ? '' : 'none';
            sellType.style.display = isPokemon ? '' : 'none';
            sellQty.style.display = isPokemon ? 'none' : '';
            sellQualityTiers.classList.toggle('visible', marketMode === 'sell' && isPokemon);
            const filtered = sellEntries.filter(entry => entry.kind === sellKind.value)
                .filter(entry => !query || entry.name.toLocaleLowerCase().includes(query))
                .filter(entry => !isPokemon || sellVisibleQualityTiers.has(getMarketPokemonQualityTheme(entry.quality)?.label || 'Fraca'))
                .filter(entry => !isPokemon || sellIvMin.value === '' || Number(entry.ivTotal) >= Number(sellIvMin.value))
                .filter(entry => !isPokemon || sellQualityMin.value === '' || Number(entry.quality) >= Number(sellQualityMin.value))
                .filter(entry => !isPokemon || !sellType.value || entry.type1 === sellType.value || entry.type2 === sellType.value)
                .sort((a, b) => isPokemon
                    ? Number(b.ivTotal) - Number(a.ivTotal) || Number(b.quality) - Number(a.quality) || Number(b.level) - Number(a.level)
                    : a.name.localeCompare(b.name, 'pt-BR'));
            list.innerHTML = '';
            status.textContent = `${filtered.length} disponível(is) para anunciar`;
            filtered.forEach(entry => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = `market-sell-row${isPokemon ? ' market-pokemon-listing' : ''}${selectedSellEntry === entry ? ' on' : ''}`;
                const qualityTheme = isPokemon ? getMarketPokemonQualityTheme(entry.quality) : null;
                const isDiamond = Boolean(entry.isDiamond || entry.marketKind === 'diamonds');
                const itemTheme = !isPokemon && !isDiamond ? getMarketItemRarityTheme(entry) : null;
                if (qualityTheme) {
                    row.classList.add('market-pokemon-quality');
                    row.style.setProperty('--market-tier-color', qualityTheme.color);
                }
                if (itemTheme) {
                    row.classList.add('market-item-rarity');
                    row.style.setProperty('--market-item-color', itemTheme.color);
                }
                const details = isPokemon
                    ? `Nv ${entry.level ?? 1} · IV ${entry.ivTotal ?? 0}/192 · ${formatPokemonQuality(entry.quality) || 'Qualidade —'}${entry.shiny ? ' · ✨ Shiny' : ''}`
                    : `${Number(entry.quantity || 0).toLocaleString('pt-BR')} na mochila`;
                const image = entry.icon || getMarketEntryImage(entry);
                const kindLabel = isPokemon ? 'POKÉMON' : isDiamond ? 'MONEDA / OBJETO' : (entry.marketKind === 'ball' ? 'POKÉ BALL' : 'OBJETO / DROP');
                const tierBadge = qualityTheme ? `<small class="market-quality-tier">${qualityTheme.label}</small>` : '';
                const itemRarityBadge = itemTheme ? `<small class="market-item-rarity-badge">${escapeHTML(itemTheme.label)}</small>` : '';
                const statsHTML = isPokemon ? getMarketPokemonStatsHTML(entry.stats) : '';
                const typesHTML = isPokemon ? getMarketPokemonTypesHTML(entry) : '';
                row.innerHTML = `
                    <div class="market-art">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(entry.name)}">` : `<span>${isPokemon ? '◉' : isDiamond ? '💎' : '📦'}</span>`}</div>
                    <div class="market-main"><small class="market-kind-label">${kindLabel}</small><b class="market-item-name">${escapeHTML(entry.name)}</b><small class="market-meta">${escapeHTML(details)}</small>${typesHTML}${tierBadge}${itemRarityBadge}</div>
                    ${statsHTML ? `<small class="market-stats market-card-stats">${statsHTML}</small>` : ''}
                    ${isPokemon ? '' : `<div class="market-quantity">${tr('amount')}<b>${Number(entry.quantity || 0).toLocaleString(locale())} ${tr('availableUnits')}</b></div>`}`;
                row.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: isPokemon ? '◉' : isDiamond ? '💎' : '📦' }));
                }, { once: true });
                if (isPokemon) {
                    const locked = isNativeLocked(entry);
                    const lockButton = document.createElement('span');
                    lockButton.className = `market-sell-card-lock${locked ? ' locked' : ''}`;
                    lockButton.setAttribute('role', 'button');
                    lockButton.tabIndex = 0;
                    lockButton.textContent = locked ? '🔒' : '🔓';
                    lockButton.title = locked ? tr('unlockPokemon') : tr('lockPokemon');
                    const toggleLock = async event => {
                        event.preventDefault();
                        event.stopPropagation();
                        try {
                            await toggleNativeLock('pokemon', entry);
                            renderSell();
                            if (selectedSellEntry === entry) showSellEditor(entry);
                        } catch (error) {
                            showWindowMessage(backdrop.querySelector('.script-market-window'), error.message, true);
                        }
                    };
                    lockButton.addEventListener('click', toggleLock);
                    lockButton.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') toggleLock(event);
                    });
                    row.appendChild(lockButton);
                }
                row.addEventListener('click', () => {
                    selectedSellEntry = entry;
                    renderSell();
                    showSellEditor(entry);
                    compareSelectedSellItem(entry);
                    if (isPokemon) {
                        openMarketIvCalculator(backdrop, entry);
                        list.querySelector('.market-sell-row.on')?.classList.add('market-iv-active');
                    }
                });
                list.appendChild(row);
            });
        };

        const loadSell = async () => {
            status.textContent = tr('loading');
            try {
                const [inventory, pokemon, itemPayload, ballPayload, characterPayload, diamondPayload] = await Promise.all([
                    requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3500, attempts: 2 }),
                    requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs: 3500, attempts: 2 }),
                    fetch(ITEMS_JSON_URL).then(response => response.json()),
                    loadBallCatalog().catch(() => ({ catalog: [], counts: {} })),
                    gameApiRequest('/api/characters/me').catch(() => null),
                    gameApiRequest('/api/game/diamonds').catch(() => null)
                ]);
                if (marketMode !== 'sell') return;
                if (characterPayload) updateMarketBalance(characterPayload);
                const itemMap = new Map((itemPayload.items || []).map(item => [String(item.id), item]));
                sellEntries = inventory.filter(entry => Number(entry.quantity) > 0).map(entry => {
                    const item = itemMap.get(String(entry.itemId)) || {};
                    return { kind: 'item', marketKind: 'item', refId: Number(entry.itemId), name: item.name || `Item ${entry.itemId}`, icon: normalizeGameItemIcon(item.icon), quantity: Number(entry.quantity), rarity: item.rarity || item.tier, rare: item.rare };
                });
                const balls = Array.isArray(ballPayload.catalog) ? ballPayload.catalog : (ballPayload.catalog?.balls || []);
                balls.forEach(ball => {
                    const quantity = Number(ballPayload.counts?.[String(ball.id)] || 0);
                    if (quantity > 0) sellEntries.push({ kind: 'item', marketKind: 'ball', refId: Number(ball.id), name: ball.name, icon: ball.iconUrl || normalizeGameItemIcon(ball.icon), quantity, rarity: ball.rarity || ball.tier, rare: ball.rare });
                });
                const diamondQuantity = Math.max(0, Math.floor(Number(diamondPayload?.diamonds ?? characterPayload?.character?.diamonds ?? 0) || 0));
                if (diamondQuantity > 0) sellEntries.push({
                    kind: 'item',
                    marketKind: 'diamonds',
                    refId: 0,
                    name: tr('diamonds'),
                    icon: '/assets/topmenu/icon_store.png',
                    quantity: diamondQuantity,
                    isDiamond: true
                });
                pokemon.filter(poke => !poke.starter && !poke.market && !poke.listed).forEach(poke => sellEntries.push({
                    ...poke, kind: 'pokemon', name: poke.name || `Pokémon ${poke.speciesId}`, icon: getPokemonIconUrl(poke.speciesId), quantity: 1
                }));
                const types = [...new Set(pokemon.flatMap(poke => [poke.type1, poke.type2]).filter(Boolean))].sort();
                sellType.innerHTML = `<option value="">Todos os tipos</option>${types.map(type => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join('')}`;
                selectedSellEntry = null;
                sellEditor.hidden = true;
                clearSellReference();
                sellSubmit.disabled = true;
                renderSell();
            } catch (error) {
                status.textContent = `Não foi possível carregar seus itens e Pokémon: ${error.message}`;
            }
        };

        const render = () => {
            const query = search.value.trim().toLocaleLowerCase();
            const rarityFilterActive = activeCategory !== 'Pokemon' && activeCategory !== 'Diamonds';
            const alertMode = marketMode === 'alerts';
            const sourceListings = alertMode
                ? [...getAvailableMarketAlertInbox(currentListings), ...getAvailableMarketItemAlertInbox(currentListings)]
                : marketMode === 'featured'
                ? getFeaturedPokemonListings(currentListings)
                : currentListings;
            let filtered = sourceListings.filter(entry => {
                if (alertMode) return true;
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || '';
                if (activeMarketFavoriteKey && marketFavoriteKey(entry) !== activeMarketFavoriteKey) return false;
                if (query && !String(name).toLocaleLowerCase().includes(query)) return false;
                const entryCurrency = normalizeMarketCurrency(entry.currency || entry.currencyType || ref.currency || ref.currencyType);
                if (entryCurrency === 'GOLD' && !showGold.checked) return false;
                if (entryCurrency === 'DIAMONDS' && !showDiamonds.checked) return false;
                if (rarityFilterActive && itemRarityFilter.value && getMarketItemRarityTheme(entry).key !== itemRarityFilter.value) return false;
                if (activeCategory === 'Pokemon') {
                    const iv = Number(entry.ivTotal ?? -1);
                    const level = Number(entry.level ?? -1);
                    const quality = Number(entry.quality ?? -1);
                    const tier = getMarketPokemonQualityTheme(quality)?.label || 'Fraca';
                    if (!buyVisibleQualityTiers.has(tier)) return false;
                    if (shinyOnly.checked && !entry.shiny) return false;
                    if (ivMin.value !== '' && iv < Number(ivMin.value)) return false;
                    if (ivMax.value !== '' && iv > Number(ivMax.value)) return false;
                    if (levelMin.value !== '' && level < Number(levelMin.value)) return false;
                    if (levelMax.value !== '' && level > Number(levelMax.value)) return false;
                    if (qualityMin.value !== '' && quality < Number(qualityMin.value)) return false;
                    if (qualityMax.value !== '' && quality > Number(qualityMax.value)) return false;
                    if (typeSelect.value && entry.type1 !== typeSelect.value && entry.type2 !== typeSelect.value) return false;
                }
                return true;
            });
            const sorters = {
                'price-asc': (a, b) => marketPriceInPd(a) - marketPriceInPd(b),
                'price-desc': (a, b) => marketPriceInPd(b) - marketPriceInPd(a),
                'iv-desc': (a, b) => Number(b.ivTotal ?? -1) - Number(a.ivTotal ?? -1),
                'power-desc': (a, b) => Number(b.power ?? -1) - Number(a.power ?? -1),
                'level-desc': (a, b) => Number(b.level ?? -1) - Number(a.level ?? -1),
                'quality-desc': (a, b) => Number(b.quality ?? -1) - Number(a.quality ?? -1)
            };
            if (!alertMode && sorters[sortSelect.value]) filtered = [...filtered].sort(sorters[sortSelect.value]);
            const visible = filtered.slice(0, renderLimit);
            list.innerHTML = '';
            const categoryLabel = alertMode ? tr('marketAlerts') : marketMode === 'featured'
                ? tr('marketFeatured')
                : (categorySelect.options[categorySelect.selectedIndex]?.text || activeCategory);
            status.textContent = filtered.length
                ? `${tr('showing')} ${visible.length.toLocaleString()} ${tr('of')} ${filtered.length.toLocaleString()} ${categoryLabel}`
                : alertMode ? tr('alertNoMatches')
                    : marketMode === 'featured' && !getMarketFeaturedPokemon().length ? tr('featuredEmpty') : tr('noListings');
            visible.forEach(entry => {
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || '—';
                const price = getMarketEntryPrice(entry);
                const quantity = Number(entry.quantity ?? entry.qty ?? entry.amount ?? 1);
                const quality = entry.quality ?? ref.quality;
                const ivTotal = entry.ivTotal ?? ref.ivTotal ?? entry.iv ?? ref.iv;
                const stats = entry.stats || ref.stats || {};
                const entryKind = getMarketEntryKind(entry);
                const isPokemonListing = isMarketPokemonEntry(entry);
                const isItemListing = !isPokemonListing && entryKind !== 'diamond';
                const statsHTML = isPokemonListing ? getMarketPokemonStatsHTML(stats) : '';
                const row = document.createElement('div');
                row.className = `market-buy-row market-listing-row${isPokemonListing ? ' market-pokemon-listing' : ''}`;
                if (marketMode === 'featured' && !entry._scriptFeaturedAvailable) row.classList.add('market-featured-unavailable');
                const qualityTheme = isPokemonListing ? getMarketPokemonQualityTheme(quality) : null;
                const itemTheme = isItemListing ? getMarketItemRarityTheme(entry) : null;
                if (qualityTheme) {
                    row.classList.add('market-pokemon-quality');
                    row.style.setProperty('--market-tier-color', qualityTheme.color);
                }
                if (itemTheme) {
                    row.classList.add('market-item-rarity');
                    row.style.setProperty('--market-item-color', itemTheme.color);
                }
                const details = [
                    ivTotal != null ? `${tr('ivTotal')}: ${ivTotal}/192` : '',
                    quality != null ? `Q: ${Number(quality).toFixed(2)}` : ''
                ].filter(Boolean).join(' · ');
                const alertAccount = alertMode && entry._scriptAlertAccount ? formatMarketAlertAccount(entry._scriptAlertAccount) : '';
                const offerOnly = Boolean(entry.offerOnly || price <= 0);
                const currency = getMarketEntryCurrency(entry);
                const currencyIcon = currency === 'DIAMONDS' ? '💎' : '💲';
                const converted = getConvertedMarketPrice(price, currency);
                const conversionText = converted
                    ? `≈ ${converted.icon} ${formatMarketValue(converted.value, converted.currency)}`
                    : '—';
                const image = getMarketEntryImage(entry);
                const kindLabel = isPokemonListing ? 'POKÉMON'
                    : entryKind === 'ball' ? 'POKÉ BALL'
                    : entryKind === 'diamond' ? 'MONEDA'
                    : activeCategory === 'Stones' ? 'STONE'
                    : 'OBJETO / DROP';
                const fallbackIcon = isPokemonListing ? '◉' : entryKind === 'diamond' ? '💎' : '📦';
                const tierBadge = qualityTheme ? `<small class="market-quality-tier">${qualityTheme.label}</small>` : '';
                const itemRarityBadge = itemTheme ? `<small class="market-item-rarity-badge">${escapeHTML(itemTheme.label)}</small>` : '';
                const typesHTML = isPokemonListing ? getMarketPokemonTypesHTML(entry) : '';
                row.innerHTML = `
                    <div class="market-art">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(name)}">` : `<span>${fallbackIcon}</span>`}</div>
                    <div class="market-main"><small class="market-kind-label">${kindLabel}</small><b class="market-item-name">${escapeHTML(name)}</b>${details ? `<small class="market-meta">${escapeHTML(details)}</small>` : ''}${alertAccount ? `<small class="market-meta market-alert-account">${escapeHTML(alertAccount)}</small>` : ''}${typesHTML}${tierBadge}${itemRarityBadge}</div>
                    ${statsHTML ? `<small class="market-stats market-card-stats">${statsHTML}</small>` : ''}
                    <div class="market-buy-footer">
                        ${isPokemonListing ? '' : `<div class="market-quantity market-data-box"><small class="market-data-label">${tr('quantity')}</small><b>${quantity.toLocaleString(locale())}</b></div>`}
                        <div class="market-price market-data-box"><small class="market-data-label">${tr('unitPrice')}</small><b>${offerOnly ? tr('offerOnly') : `${currencyIcon} ${formatMarketValue(price, currency)}`}</b></div>
                        <div class="market-conversion market-data-box"><small class="market-data-label">${tr('marketConversion')}</small><b>${offerOnly ? '—' : conversionText}</b></div>
                    </div>`;
                row.querySelector('img')?.addEventListener('error', event => {
                    event.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: fallbackIcon }));
                }, { once: true });
                if (isPokemonListing) bindMarketIvCard(row, entry);
                if (isItemListing) {
                    const favoriteKey = marketFavoriteKey(entry);
                    const favoriteButton = document.createElement('button');
                    favoriteButton.type = 'button';
                    favoriteButton.className = `market-favorite-toggle${getMarketFavorites().some(favorite => favorite.key === favoriteKey) ? ' on' : ''}`;
                    favoriteButton.textContent = '★';
                    favoriteButton.title = favoriteButton.classList.contains('on') ? tr('removeMarketFavorite') : tr('addMarketFavorite');
                    favoriteButton.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();
                        const enable = !favoriteButton.classList.contains('on');
                        setMarketFavorite(entry, enable);
                        if (!enable && activeMarketFavoriteKey === favoriteKey) activeMarketFavoriteKey = '';
                        renderMarketFavorites();
                        render();
                    });
                    row.appendChild(favoriteButton);
                }
                if (isPokemonListing) {
                    const featuredKey = marketFeaturedPokemonKey(entry);
                    const featuredButton = document.createElement('button');
                    featuredButton.type = 'button';
                    featuredButton.className = `market-featured-toggle${getMarketFeaturedPokemon().some(featured => featured.key === featuredKey) ? ' on' : ''}`;
                    featuredButton.textContent = '◆';
                    featuredButton.title = featuredButton.classList.contains('on') ? tr('removeMarketFeatured') : tr('addMarketFeatured');
                    featuredButton.setAttribute('aria-label', featuredButton.title);
                    featuredButton.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMarketFeaturedPokemon(entry, !featuredButton.classList.contains('on'));
                        render();
                    });
                    row.appendChild(featuredButton);
                }
                const buyButton = document.createElement('button');
                const quantityInput = document.createElement('input');
                quantityInput.type = 'number';
                quantityInput.min = '1';
                quantityInput.max = String(Math.max(1, quantity));
                quantityInput.value = '1';
                quantityInput.title = 'Quantidade a comprar';
                quantityInput.style.cssText = 'width:72px;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;';
                quantityInput.hidden = isPokemonListing || quantity <= 1;
                buyButton.type = 'button';
                buyButton.className = 'mk-bulk-btn market-buy';
                buyButton.textContent = tr('buy');
                buyButton.style.cssText = 'width:auto;min-width:76px;min-height:32px;padding:6px 12px;grid-column:auto;';
                const listingUnavailable = marketMode === 'featured' && !entry._scriptFeaturedAvailable;
                buyButton.disabled = offerOnly || listingUnavailable;
                if (listingUnavailable) {
                    buyButton.textContent = tr('featuredUnavailable');
                    buyButton.title = tr('featuredUnavailable');
                }
                buyButton.addEventListener('click', async () => {
                    buyButton.disabled = true;
                    try {
                        const buyQuantity = isPokemonListing ? 1 : Math.max(1, Math.min(quantity, parseInt(quantityInput.value, 10) || 1));
                        const characterData = await gameApiRequest('/api/characters/me');
                        const currentBalance = currency === 'DIAMONDS'
                            ? Number(characterData.character?.diamonds || 0)
                            : Number(characterData.character?.gold || 0);
                        const confirmed = await new Promise(resolve => showPurchaseConfirm({
                            name,
                            quantity: buyQuantity,
                            unitPrice: price,
                            currentBalance,
                            currency
                        }, resolve));
                        if (!confirmed) {
                            buyButton.disabled = false;
                            return;
                        }
                        const marketAction = isPokemonListing
                            ? { action: 'buy', id: entry.id, quantity: 1 }
                            : {
                                action: 'buy-stack',
                                kind: entry.kind,
                                refId: entry.refId,
                                price: entry.price,
                                currency: entry.currency,
                                quantity: buyQuantity,
                                ids: (entry.ids ?? [entry.id]).slice(0, buyQuantity)
                            };
                        await gameApiRequest('/api/game/market/action', {
                            method: 'POST',
                            body: JSON.stringify(marketAction)
                        });
                        if (quantity <= buyQuantity || isPokemonListing) {
                            currentListings = currentListings.filter(item => item !== entry);
                        } else {
                            entry.quantity = quantity - buyQuantity;
                        }
                        if (isPokemonListing) {
                            setMarketFeaturedPokemon(entry, false);
                            removeMarketAlertInboxEntry(entry);
                        } else if (entry._scriptAlertKind === 'item') {
                            removeMarketItemAlertInboxEntry(entry);
                        }
                        render();
                        await updateMarketBalance();
                        showWindowMessage(backdrop.querySelector('.script-market-window'), tr('purchaseDone'));
                    } catch (error) {
                        showWindowMessage(backdrop.querySelector('.script-market-window'), `${tr('purchaseFailed')} ${error.message}`, true);
                        buyButton.disabled = false;
                    }
                });
                const buyActions = document.createElement('div');
                buyActions.className = 'market-actions';
                buyActions.append(quantityInput, buyButton);
                row.querySelector('.market-buy-footer').appendChild(buyActions);
                list.appendChild(row);
            });
            if (visible.length < filtered.length) {
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'mk-bulk-btn';
                more.style.cssText = 'margin:5px auto;padding:8px 18px;';
                more.textContent = `${tr('loadMore')} (+${Math.min(100, filtered.length - visible.length)})`;
                more.addEventListener('click', () => {
                    renderLimit += 100;
                    render();
                });
                list.appendChild(more);
            }
        };

        const load = async () => {
            status.textContent = tr('loading');
            list.innerHTML = '';
            try {
                const requestedCategory = marketMode === 'requests'
                    ? (requestFilterCategory.value || 'All')
                    : marketMode === 'history' || marketMode === 'mine' ? 'All'
                        : marketMode === 'featured' ? 'Pokemon' : marketMode === 'alerts' ? 'All' : activeCategory;
                const categoryRequest = gameApiRequest(`/api/game/market?category=${encodeURIComponent(requestedCategory)}`);
                const diamondRequest = requestedCategory === 'Diamonds'
                    ? categoryRequest
                    : gameApiRequest('/api/game/market?category=Diamonds').catch(() => null);
                const ballVisualRequest = loadBallCatalog().catch(() => null);
                const characterRequest = gameApiRequest('/api/characters/me').catch(() => null);
                const [payload, diamondPayload, ballVisualPayload, characterPayload] = await Promise.all([categoryRequest, diamondRequest, ballVisualRequest, characterRequest]);
                currentMarketPayload = payload;
                if (marketMode === 'requests') loadedRequestCategory = requestedCategory;
                if (characterPayload) updateMarketBalance(characterPayload);
                if (itemDataLoadPromise) await itemDataLoadPromise;
                currentListings = getMarketListings(payload);
                currentMyListings = Array.isArray(payload?.mine) ? payload.mine : [];
                if (marketMode === 'alerts') {
                    syncMarketAlertInbox(currentListings);
                    syncMarketItemAlertInbox(currentListings);
                }
                backdrop.querySelector('.market-tab-count').textContent = currentMyListings.length.toLocaleString(locale());
                const ballCatalog = Array.isArray(ballVisualPayload?.catalog)
                    ? ballVisualPayload.catalog
                    : (ballVisualPayload?.catalog?.balls || []);
                const ballIcons = new Map(ballCatalog.map(ball => [String(ball.id), ball.iconUrl || normalizeGameItemIcon(ball.icon)]));
                [...currentListings, ...currentMyListings,
                    ...(Array.isArray(payload?.requests) ? payload.requests : []),
                    ...(Array.isArray(payload?.myRequests) ? payload.myRequests : [])].forEach(entry => {
                    if (getMarketEntryKind(entry) !== 'ball') return;
                    const ballIcon = ballIcons.get(String(getMarketEntryRefId(entry)));
                    if (ballIcon) entry._scriptMarketIcon = ballIcon;
                });
                const diamondListings = diamondPayload ? getMarketListings(diamondPayload) : [];
                diamondPdRate = getLowestDiamondPdPrice(diamondListings);
                updateExchangeRate();
                const filterSource = marketMode === 'mine' ? currentMyListings
                    : marketMode === 'featured' ? getFeaturedPokemonListings(currentListings) : currentListings;
                const selectedType = typeSelect.dataset.marketSelectedType ?? typeSelect.value;
                delete typeSelect.dataset.marketSelectedType;
                const types = [...new Set(filterSource.flatMap(entry => {
                    const ref = entry.pokemon || entry.item || entry.product || {};
                    return [entry.type1, entry.type2, ref.type1, ref.type2];
                }).filter(Boolean))].sort();
                typeSelect.innerHTML = `<option value="">${tr('allTypes')}</option>${types.map(type => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join('')}`;
                if (types.includes(selectedType)) typeSelect.value = selectedType;
                const selectedRarity = itemRarityFilter.dataset.marketSelectedRarity ?? itemRarityFilter.value;
                delete itemRarityFilter.dataset.marketSelectedRarity;
                const rarityThemes = [...new Map(filterSource
                    .filter(entry => marketMode === 'mine'
                        ? !['Pokemon', 'Diamonds'].includes(getListingCategory(entry))
                        : getMarketEntryKind(entry) !== 'pokemon' && getMarketEntryKind(entry) !== 'diamond')
                    .map(entry => getMarketItemRarityTheme(entry)).map(theme => [theme.key, theme])).values()];
                itemRarityFilter.innerHTML = `<option value="">${tr('allRarities')}</option>${rarityThemes.map(theme => `<option value="${theme.key}">${escapeHTML(theme.label)}</option>`).join('')}`;
                if (rarityThemes.some(theme => theme.key === selectedRarity)) itemRarityFilter.value = selectedRarity;
                itemRarityFilter.style.display = (marketMode === 'buy' || marketMode === 'mine') && activeCategory !== 'Pokemon' && activeCategory !== 'Diamonds' ? '' : 'none';
                pokemonFilters.style.display = (marketMode === 'buy' || marketMode === 'mine' || marketMode === 'featured') && activeCategory === 'Pokemon' ? 'flex' : 'none';
                buyQualityTiers.classList.toggle('visible', (marketMode === 'buy' || marketMode === 'featured') && activeCategory === 'Pokemon');
                mineQualityTiers.classList.toggle('visible', marketMode === 'mine' && (activeCategory === 'All' || activeCategory === 'Pokemon'));
                renderLimit = 100;
                populateRequestCatalog();
                if (marketMode === 'requests') renderRequests();
                else if (marketMode === 'history') renderHistory();
                else if (marketMode === 'mine') renderMyListings();
                else if (marketMode === 'alerts') { renderAlertRules(); render(); }
                else render();
            } catch (error) {
                console.warn('Falha ao carregar o mercado global:', error);
                status.textContent = `${tr('loadFailed')} ${error.message || ''}`.trim();
            }
        };
        backdrop.querySelector('.market-close').addEventListener('click', close);
        backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
        backdrop.querySelector('.market-sell-editor-close').addEventListener('click', closeSellEditor);
        sellEditorLock.addEventListener('click', async () => {
            const entry = selectedSellEntry;
            if (!entry || entry.kind !== 'pokemon') return;
            sellEditorLock.disabled = true;
            try {
                await toggleNativeLock('pokemon', entry);
                renderSell();
                showSellEditor(entry);
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message, true);
            } finally {
                sellEditorLock.disabled = false;
            }
        });
        viewButtons.forEach(button => button.addEventListener('click', () => applyMarketView(button.dataset.view, marketMode)));
        backdrop.querySelector('.market-refresh').addEventListener('click', () => marketMode === 'sell' ? loadSell() : load());
        backdrop.querySelectorAll('.market-tab').forEach(tab => tab.addEventListener('click', () => {
            const nextMarketMode = tab.dataset.mode;
            if (marketMode === 'featured' && nextMarketMode !== 'featured') deactivateFeaturedFilters();
            if (marketMode !== 'featured' && nextMarketMode === 'featured') activateFeaturedFilters();
            marketMode = nextMarketMode;
            setMarketFiltersOpen(false);
            filtersToggle.hidden = marketMode === 'history';
            applyMarketView(marketViews[marketMode], marketMode);
            if (marketMode === 'mine' && categorySelect.value !== 'All') {
                activeCategory = 'All';
                categorySelect.value = 'All';
                itemRarityFilter.value = '';
            }
            backdrop.querySelectorAll('.market-tab').forEach(button => button.classList.toggle('on', button === tab));
            buyControls.style.display = marketMode === 'buy' || marketMode === 'mine' || marketMode === 'featured' ? 'flex' : 'none';
            alertControls.classList.toggle('visible', marketMode === 'alerts');
            itemRarityFilter.style.display = (marketMode === 'buy' || marketMode === 'mine') && activeCategory !== 'Pokemon' && activeCategory !== 'Diamonds' ? '' : 'none';
            pokemonFilters.style.display = (marketMode === 'buy' || marketMode === 'mine' || marketMode === 'featured') && activeCategory === 'Pokemon' ? 'flex' : 'none';
            sellControls.style.display = marketMode === 'sell' ? 'flex' : 'none';
            sellQualityTiers.classList.toggle('visible', marketMode === 'sell' && sellKind.value === 'pokemon');
            buyQualityTiers.classList.toggle('visible', (marketMode === 'buy' || marketMode === 'featured') && activeCategory === 'Pokemon');
            mineQualityTiers.classList.toggle('visible', marketMode === 'mine' && (activeCategory === 'All' || activeCategory === 'Pokemon'));
            requestControls.style.display = marketMode === 'requests' ? 'block' : 'none';
            renderMarketFavorites();
            if (marketMode === 'alerts') renderAlertRules();
            if (marketMode !== 'sell') {
                sellEditor.hidden = true;
                sellReference.style.display = 'none';
            }
            if (marketMode === 'sell') loadSell(); else load();
        }));
        [requestQty, requestPrice].forEach(control => control.addEventListener('input', updateRequestForm));
        requestSearch.addEventListener('focus', () => renderRequestCatalogOptions(requestSearch.value));
        requestSearch.addEventListener('click', () => renderRequestCatalogOptions(requestSearch.value));
        requestSearch.addEventListener('input', () => {
            requestItem.value = '';
            requestSelectedArt.textContent = '🔎';
            updateRequestForm();
            renderRequestCatalogOptions(requestSearch.value);
        });
        requestSearch.addEventListener('keydown', event => {
            if (event.key === 'Escape') requestOptions.hidden = true;
            if (event.key === 'Enter') {
                const firstOption = requestOptions.querySelector('.market-request-option');
                if (firstOption) {
                    event.preventDefault();
                    firstOption.click();
                }
            }
        });
        requestClear.addEventListener('click', () => {
            selectRequestCatalogEntry(null);
            requestSearch.focus();
            renderRequestCatalogOptions('');
        });
        requestFilterCategory.addEventListener('change', () => {
            if (marketMode === 'requests') load();
        });
        [requestFilterSort, requestFilterRarity, requestFilterSearch].forEach(control => {
            control.addEventListener('input', () => {
                if (marketMode === 'requests') renderRequests();
            });
        });
        requestFilterClear.addEventListener('click', () => {
            requestFilterCategory.value = 'All';
            requestFilterSort.value = 'recent';
            requestFilterRarity.value = '';
            requestFilterSearch.value = '';
            if (marketMode === 'requests') load();
        });
        backdrop.addEventListener('mousedown', event => {
            if (!requestCombobox.contains(event.target)) requestOptions.hidden = true;
        });
        requestSubmit.addEventListener('click', async () => {
            const catalog = getRequestCatalog();
            const entry = catalog.find(candidate => requestKey(candidate) === requestItem.value);
            if (!entry) return;
            const values = readRequestForm();
            const confirmation = `${tr('requestConfirm')}\n${values.amount}× ${entry.name}\n${tr('requestCustody')}: 💲 ${formatMarketValue(values.custody, 'GOLD')}\n${tr('requestFee')}: 💲 ${formatMarketValue(values.fee, 'GOLD')}\n${tr('requestTotal')}: 💲 ${formatMarketValue(values.total, 'GOLD')}`;
            if (!await showScriptConfirm(confirmation, { title: tr('requestCreate'), confirmLabel: tr('requestCreate') })) return;
            requestSubmit.disabled = true;
            try {
                await gameApiRequest('/api/game/market/action', {
                    method: 'POST',
                    body: JSON.stringify({ action: 'request-create', kind: entry.kind, refId: entry.refId, amount: values.amount, price: values.price })
                });
                selectRequestCatalogEntry(null);
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('requestCreated'));
                await updateMarketBalance();
                await load();
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message, true);
                updateRequestForm();
            }
        });
        backdrop.querySelector('.market-sell-tier-all').addEventListener('click', () => {
            if (marketMode !== 'sell') return;
            sellQualityTierDefinitions.forEach(tier => sellVisibleQualityTiers.add(tier.label));
            renderSellQualityTierButtons();
            renderSell();
        });
        backdrop.querySelector('.market-buy-tier-all').addEventListener('click', () => {
            if (!['buy', 'featured'].includes(marketMode) || activeCategory !== 'Pokemon') return;
            sellQualityTierDefinitions.forEach(tier => buyVisibleQualityTiers.add(tier.label));
            renderBuyQualityTierButtons();
            render();
        });
        backdrop.querySelector('.market-buy-tier-none').addEventListener('click', () => {
            if (!['buy', 'featured'].includes(marketMode) || activeCategory !== 'Pokemon') return;
            buyVisibleQualityTiers.clear();
            renderBuyQualityTierButtons();
            render();
        });
        // Compatibilidad inerte: no se registran acciones, compras automáticas,
        // Telegram ni editores asociados a la antigua pestaña de Alertas.
        if (!MARKET_ALERTS_REMOVED) {
        backdrop.querySelector('.market-alert-tier-all').addEventListener('click', () => {
            sellQualityTierDefinitions.forEach(tier => alertVisibleQualityTiers.add(tier.label));
            renderAlertTierButtons();
        });
        backdrop.querySelector('.market-alert-tier-none').addEventListener('click', () => {
            alertVisibleQualityTiers.clear();
            renderAlertTierButtons();
        });
        alertRulesToggle.addEventListener('click', () => {
            telegramPanel.hidden = true;
            alertTransferPanel.hidden = true;
            alertRulesPanel.hidden = !alertRulesPanel.hidden;
            if (!alertRulesPanel.hidden) renderAlertRules();
        });
        alertRulesClose.addEventListener('click', () => { alertRulesPanel.hidden = true; });
        alertClearAll.addEventListener('click', clearAllMarketAlerts);
        alertEditCancel.addEventListener('click', resetMarketAlertEditor);
        itemAlertEditCancel.addEventListener('click', resetMarketAlertEditor);
        alertRulesPanel.addEventListener('click', event => {
            if (event.target === alertRulesPanel) alertRulesPanel.hidden = true;
        });
        const closeAlertTransfer = () => { alertTransferPanel.hidden = true; };
        alertTransferPanel.querySelectorAll('.market-alert-transfer-close').forEach(button => button.addEventListener('click', closeAlertTransfer));
        const openAlertTransfer = (mode, value = '') => {
            marketAlertTransferMode = mode;
            const exporting = mode === 'export';
            alertTransferTitle.textContent = exporting ? 'Exportar alertas' : 'Importar alertas';
            alertTransferHelp.textContent = exporting
                ? 'Selecciona todos los datos y usa Ctrl+C. Luego podrás pegarlos con Ctrl+V en otra cuenta.'
                : 'Pega aquí los datos exportados desde otra cuenta y confirma la importación.';
            alertTransferData.readOnly = exporting;
            alertTransferData.value = value;
            alertTransferConfirm.textContent = exporting ? 'Copiar datos' : tr('alertImport');
            alertTransferPanel.hidden = false;
            requestAnimationFrame(() => {
                alertTransferData.focus();
                if (exporting) alertTransferData.select();
            });
        };
        const importMarketAlerts = (imported, importedItems = []) => {
            if (!imported?.length && !importedItems?.length) throw new Error(tr('alertImportInvalid'));
            const existing = getMarketAlerts();
            const known = new Set(existing.map(marketAlertSignature));
            const additions = (imported || []).filter(filters => {
                const signature = marketAlertSignature(filters);
                if (known.has(signature)) return false;
                known.add(signature);
                return true;
            }).slice(0, Math.max(0, 50 - existing.length)).map(filters => ({
                ...filters,
                id:newMarketAlertId(),
                createdAt:Date.now()
            }));
            if (additions.length) saveMarketAlerts([...existing, ...additions]);
            additions.forEach(alert => seedMarketAlertFromListings(alert, currentListings));
            const existingItems = getMarketItemAlerts();
            const knownItems = new Set(existingItems.map(marketItemAlertFilterData).map(data => JSON.stringify(data)));
            const itemAdditions = (importedItems || []).filter(filters => {
                const signature = JSON.stringify(marketItemAlertFilterData(filters));
                if (knownItems.has(signature)) return false;
                knownItems.add(signature);
                return true;
            }).slice(0, Math.max(0, 50 - existingItems.length)).map(filters => ({ ...filters, id:newMarketAlertId(), createdAt:Date.now() }));
            if (itemAdditions.length) saveMarketItemAlerts([...existingItems, ...itemAdditions]);
            itemAdditions.forEach(alert => seedMarketItemAlertFromListings(alert, currentListings));
            if (!additions.length && !itemAdditions.length) throw new Error(tr('alertImportInvalid'));
            renderAlertRules();
            if (marketMode === 'alerts') render();
            return additions.length + itemAdditions.length;
        };
        alertExport.addEventListener('click', async () => {
            const alerts = getMarketAlerts();
            if (!alerts.length && !getMarketItemAlerts().length) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('alertNoRules'), true);
                return;
            }
            try {
                const exportData = serializeMarketAlertExport(alerts);
                await copyMarketAlertExport(exportData);
                openAlertTransfer('export', exportData);
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('alertExported'));
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message || tr('alertImportInvalid'), true);
            }
        });
        alertImport.addEventListener('click', async () => {
            try {
                const clipboardText = await readMarketAlertFilters();
                openAlertTransfer('import', parseMarketAlertExport(clipboardText).length || parseMarketItemAlertExport(clipboardText).length ? clipboardText : '');
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message || tr('alertImportInvalid'), true);
            }
        });
        alertTransferConfirm.addEventListener('click', async () => {
            if (marketAlertTransferMode === 'export') {
                try {
                    await copyMarketAlertExport(alertTransferData.value);
                    alertTransferData.focus();
                    alertTransferData.select();
                    showWindowMessage(backdrop.querySelector('.script-market-window'), tr('alertExported'));
                } catch (error) {
                    showWindowMessage(backdrop.querySelector('.script-market-window'), error.message || tr('alertImportInvalid'), true);
                }
                return;
            }
            try {
                const count = importMarketAlerts(parseMarketAlertExport(alertTransferData.value), parseMarketItemAlertExport(alertTransferData.value));
                closeAlertTransfer();
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('alertImported').replace('{count}', String(count)));
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message || tr('alertImportInvalid'), true);
            }
        });
        alertPaste.addEventListener('click', async () => {
            try {
                const clipboardText = await readMarketAlertFilters();
                const savedText = String(localStorage.getItem(STORAGE_MARKET_ALERT_CLIPBOARD) || '');
                let filters = [marketAlertClipboardCache, savedText, clipboardText]
                    .map(parseMarketAlertFilters)
                    .find(Boolean);
                if (!filters) throw new Error(tr('alertFiltersInvalid'));
                applyMarketAlertFilters(filters);
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('alertFiltersPasted'));
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('alertFiltersInvalid'), true);
            }
        });
        telegramToggle.addEventListener('click', () => {
            alertRulesPanel.hidden = true;
            const opening = telegramPanel.hidden || telegramPanel.style.display === 'none';
            telegramPanel.hidden = !opening;
            telegramPanel.style.display = opening ? 'grid' : 'none';
        });
        const closeTelegramPanel = () => {
            telegramPanel.hidden = true;
            telegramPanel.style.display = 'none';
        };
        telegramClose.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            closeTelegramPanel();
        });
        telegramClose.addEventListener('pointerdown', event => {
            event.preventDefault();
            event.stopPropagation();
            closeTelegramPanel();
        });
        const persistTelegramSettings = () => {
            const settings = { enabled:telegramEnabled.checked, token:telegramToken.value, chatId:telegramChatId.value };
            saveMarketTelegramSettings(settings);
            return settings;
        };
        telegramSave.addEventListener('click', () => {
            persistTelegramSettings();
            closeTelegramPanel();
            showWindowMessage(backdrop.querySelector('.script-market-window'), tr('telegramSaved'));
        });
        telegramTest.addEventListener('click', async () => {
            const settings = persistTelegramSettings();
            if (!settings.enabled || !settings.token || !settings.chatId) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), 'Activa Telegram e introduce el token y Chat ID.', true);
                return;
            }
            telegramTest.disabled = true;
            try {
                const playerName = await getCurrentMarketAlertPlayerName();
                await telegramApiRequest('sendMessage', { chat_id:settings.chatId, text:`✅ ${tr('telegramTestMessage')}\n👤 Cuenta de juego: ${playerName}` });
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('telegramTestMessage'));
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message, true);
            } finally {
                telegramTest.disabled = false;
            }
        });
        backdrop.addEventListener('click', event => {
            if (event.target.closest('.market-telegram-close')) {
                event.preventDefault();
                event.stopPropagation();
                closeTelegramPanel();
            }
        });
        backdrop.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const ivCalculator = backdrop.querySelector('.market-iv-calculator.is-open');
            if (ivCalculator) {
                event.preventDefault();
                event.stopPropagation();
                ivCalculator._closeMarketIv?.();
            } else if (!telegramPanel.hidden) closeTelegramPanel();
            else if (!alertRulesPanel.hidden) alertRulesPanel.hidden = true;
        });
        alertKindTabs.forEach(tab => tab.addEventListener('click', () => {
            const nextKind = tab.dataset.alertKind === 'item' ? 'item' : 'pokemon';
            if (editingMarketAlert && editingMarketAlert.kind !== nextKind) resetMarketAlertEditor();
            setAlertCreationKind(nextKind);
        }));
        alertRulesTabs.forEach(tab => tab.addEventListener('click', () => {
            alertRulesKind = tab.dataset.alertRuleKind === 'item' ? 'item' : 'pokemon';
            renderAlertRules();
        }));
        alertName.addEventListener('focus', refreshAlertPokemonNames);
        itemAlertName.addEventListener('focus', refreshMarketItemAlertNames);
        [alertPriceMin, alertPriceMax].forEach(input => input.addEventListener('input', updateAlertPriceDisplays));
        alertCurrency.addEventListener('change', updateAlertPriceDisplays);
        [itemAlertPriceMin, itemAlertPriceMax].forEach(input => input.addEventListener('input', updateItemAlertPriceDisplays));
        itemAlertCurrency.addEventListener('change', updateItemAlertPriceDisplays);
        alertAutoBuy.addEventListener('change', () => {
            localStorage.setItem(STORAGE_MARKET_ALERT_AUTO_BUY, String(alertAutoBuy.checked));
        });
        itemAlertAutoBuy.addEventListener('change', () => {
            localStorage.setItem(STORAGE_MARKET_ITEM_ALERT_AUTO_BUY, String(itemAlertAutoBuy.checked));
            setMarketItemAlertAutoBuyStatus(itemAlertAutoBuy.checked ? 'activa' : 'desactivada');
        });
        itemAlertCreate.addEventListener('click', async () => {
            const readValue = input => input.value === '' ? '' : Math.max(0, Number(input.value));
            const editing = editingMarketAlert?.kind === 'item' ? editingMarketAlert : null;
            const alert = {
                id:editing?.id || newMarketAlertId(), createdAt:editing ? (getMarketItemAlerts().find(item => item.id === editing.id)?.createdAt || Date.now()) : Date.now(), name:itemAlertName.value.trim(), currency:itemAlertCurrency.value,
                priceMin:readValue(itemAlertPriceMin), priceMax:readValue(itemAlertPriceMax), quantityMin:readValue(itemAlertQuantityMin)
            };
            if (alert.priceMin !== '' && alert.priceMax !== '' && alert.priceMin > alert.priceMax) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), 'El precio mínimo no puede ser mayor que el máximo.', true);
                return;
            }
            itemAlertCreate.disabled = true;
            try {
                const listings = getMarketListings(await gameApiRequest('/api/game/market?category=All'));
                const existing = getMarketItemAlerts();
                saveMarketItemAlerts(editing
                    ? existing.map(item => item.id === alert.id ? alert : item)
                    : [...existing, alert]);
                if (editing) {
                    const seen = getMarketItemAlertSeenKeys();
                    [...seen].filter(key => key.startsWith(`${alert.id}:`)).forEach(key => seen.delete(key));
                    saveMarketItemAlertSeenKeys(seen);
                }
                seedMarketItemAlertFromListings(alert, listings);
                marketItemAlertMonitorReady = true;
                resetMarketAlertEditor();
                renderAlertRules();
                showWindowMessage(backdrop.querySelector('.script-market-window'), editing ? 'Alerta de objeto actualizada.' : 'Alerta de objeto creada.');
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message || tr('loadFailed'), true);
            } finally {
                itemAlertCreate.disabled = false;
            }
        });
        alertCreate.addEventListener('click', async () => {
            const readValue = input => input.value === '' ? '' : Math.max(0, Number(input.value));
            const editing = editingMarketAlert?.kind === 'pokemon' ? editingMarketAlert : null;
            const alert = {
                id:editing?.id || newMarketAlertId(),
                createdAt:editing ? (getMarketAlerts().find(item => item.id === editing.id)?.createdAt || Date.now()) : Date.now(),
                name:alertName.value.trim(),
                currency:alertCurrency.value,
                priceMin:readValue(alertPriceMin), priceMax:readValue(alertPriceMax),
                shiny:alertShiny.checked,
                ivMin:readValue(alertIvMin), ivMax:readValue(alertIvMax),
                levelMin:readValue(alertLevelMin), levelMax:readValue(alertLevelMax),
                type:alertType.value,
                tiers:[...alertVisibleQualityTiers]
                    .map(tier => MARKET_QUALITY_TIER_DEFINITIONS.find(definition => definition.id === normalizeMarketTier(tier))?.label)
                    .filter(Boolean)
            };
            const invalidRange = (alert.priceMin !== '' && alert.priceMax !== '' && alert.priceMin > alert.priceMax)
                || (alert.ivMin !== '' && alert.ivMax !== '' && alert.ivMin > alert.ivMax)
                || (alert.levelMin !== '' && alert.levelMax !== '' && alert.levelMin > alert.levelMax);
            if (invalidRange) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), 'El valor mínimo no puede ser mayor que el máximo.', true);
                return;
            }
            alertCreate.disabled = true;
            try {
                const payload = await gameApiRequest('/api/game/market?category=Pokemon');
                const liveListings = getMarketListings(payload);
                const existing = getMarketAlerts();
                saveMarketAlerts(editing
                    ? existing.map(item => item.id === alert.id ? alert : item)
                    : [...existing, alert]);
                if (editing) {
                    const seen = getMarketAlertSeenKeys();
                    [...seen].filter(key => key.startsWith(`${alert.id}:`)).forEach(key => seen.delete(key));
                    saveMarketAlertSeenKeys(seen);
                }
                seedMarketAlertFromListings(alert, liveListings);
                marketAlertMonitorReady = true;
                currentListings = liveListings;
                resetMarketAlertEditor();
                renderAlertRules();
                render();
                showWindowMessage(backdrop.querySelector('.script-market-window'), editing ? 'Alerta actualizada.' : tr('alertSaved'));
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), error.message || tr('loadFailed'), true);
            } finally {
                alertCreate.disabled = false;
            }
        });
        }
        backdrop.querySelector('.market-sell-tier-none').addEventListener('click', () => {
            if (marketMode !== 'sell') return;
            sellVisibleQualityTiers.clear();
            selectedSellEntry = null;
            sellEditor.hidden = true;
            clearSellReference();
            sellSubmit.disabled = true;
            renderSellQualityTierButtons();
            renderSell();
        });
        backdrop.querySelector('.market-mine-tier-all').addEventListener('click', () => {
            if (marketMode !== 'mine') return;
            sellQualityTierDefinitions.forEach(tier => mineVisibleQualityTiers.add(tier.label));
            renderMineQualityTierButtons();
            renderMyListings();
        });
        backdrop.querySelector('.market-mine-tier-none').addEventListener('click', () => {
            if (marketMode !== 'mine') return;
            mineVisibleQualityTiers.clear();
            renderMineQualityTierButtons();
            renderMyListings();
        });
        [sellKind, sellSearch, sellIvMin, sellQualityMin, sellType].forEach(control => control.addEventListener('input', () => {
            selectedSellEntry = null;
            sellEditor.hidden = true;
            clearSellReference();
            sellSubmit.disabled = true;
            renderSell();
        }));
        sellPrice.addEventListener('input', () => {
            sellSubmit.disabled = !selectedSellEntry
                || (selectedSellEntry.kind === 'pokemon' && isNativeLocked(selectedSellEntry))
                || !(Number(sellPrice.value) >= 1);
            updateExchangeRate();
            updateSellFinancialSummary();
        });
        sellQty.addEventListener('input', updateSellFinancialSummary);
        sellCurrency.addEventListener('change', () => {
            updateExchangeRate();
            updateSellFinancialSummary();
        });
        sellSubmit.addEventListener('click', async () => {
            const entry = selectedSellEntry;
            const price = Math.floor(Number(sellPrice.value));
            if (!entry || price < 1) return;
            if (entry.kind === 'pokemon' && isNativeLocked(entry)) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), tr('unlockBeforeListing'), true);
                return;
            }
            const quantity = entry.kind === 'pokemon' ? 1 : Math.max(1, Math.min(entry.quantity, Math.floor(Number(sellQty.value) || 1)));
            const financials = getSellFinancials(entry);
            const currencyIcon = financials.currency === 'DIAMONDS' ? '💎' : '💲';
            const message = `Anunciar ${quantity}× ${entry.name} por ${price.toLocaleString('pt-BR')} ${sellCurrency.value === 'DIAMONDS' ? 'diamante(s)' : 'dólar(es)'}?\n${tr('saleGrossTotal')}: ${currencyIcon} ${formatMarketValue(financials.gross, financials.currency)}\n${tr('listingFee')}: ${currencyIcon} ${formatMarketValue(financials.fee, financials.currency)}\n${tr('saleNetProfit')}: ${currencyIcon} ${formatMarketValue(financials.net, financials.currency)}`;
            if (!await showScriptConfirm(message, { title: 'Confirmar anúncio', confirmLabel: 'Anunciar' })) return;
            sellSubmit.disabled = true;
            try {
                const action = entry.kind === 'pokemon'
                    ? { action: 'sell-pokemon', capturedId: entry.id, price, currency: sellCurrency.value }
                    : { action: 'sell', kind: entry.marketKind, refId: entry.refId, quantity, price, currency: sellCurrency.value };
                await gameApiRequest('/api/game/market/action', { method: 'POST', body: JSON.stringify(action) });
                await updateMarketBalance();
                showWindowMessage(backdrop.querySelector('.script-market-window'), `Anúncio criado: ${entry.name}`);
                await loadSell();
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), `Falha ao anunciar: ${error.message}`, true);
                sellSubmit.disabled = false;
            }
        });
        categorySelect.addEventListener('change', () => {
            activeMarketFavoriteKey = '';
            activeCategory = categorySelect.value;
            updateMarketCategoryRail();
            itemRarityFilter.value = '';
            renderLimit = 100;
            if (activeCategory !== 'Pokemon' && ['iv-desc', 'power-desc', 'level-desc', 'quality-desc'].includes(sortSelect.value)) {
                sortSelect.value = 'recent';
            }
            load();
        });
        search.addEventListener('input', () => {
            if (!activeMarketFavoriteKey) return;
            activeMarketFavoriteKey = '';
            renderMarketFavorites();
        });
        [search, sortSelect, itemRarityFilter, showGold, showDiamonds, shinyOnly, ivMin, ivMax, levelMin, levelMax, qualityMin, qualityMax, typeSelect].forEach(control => control.addEventListener('input', () => {
            renderLimit = 100;
            if (marketMode === 'mine') renderMyListings();
            else render();
        }));
        renderMarketFavorites();
        renderBuyQualityTierButtons();
        renderSellQualityTierButtons();
        renderMineQualityTierButtons();
        load();
    }

    function injectHuntShopLauncher() {
        const captureBar = document.querySelector('[data-guide="capture-bar"]');
        if (!captureBar) return;
        // El acceso portátil al Mercado Global ya no forma parte del Capture Bar.
        // También limpia botones creados por una versión anterior sin tocar otros
        // enlaces o controles nativos de captura.
        captureBar.querySelectorAll('.script-open-global-market').forEach(button => button.remove());
    }

    let ballCatalogPromise = null;

    function loadBallCatalog() {
        if (!ballCatalogPromise) {
            ballCatalogPromise = gameApiRequest('/api/game/balls').catch(error => {
                ballCatalogPromise = null;
                throw error;
            });
        }
        return ballCatalogPromise;
    }

    async function showPortableBallShop() {
        document.querySelector('.portable-ball-backdrop')?.remove();
        const backdrop = document.createElement('div');
        backdrop.className = 'portable-ball-backdrop';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div class="ball-window script-portable-ball-window" style="width:min(900px,96vw);max-height:90vh;display:flex;flex-direction:column;background:#0c161f;border:1px solid #2b4c66;border-radius:10px;box-shadow:0 16px 50px rgba(0,0,0,.75);">
                <div class="ball-head" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1a2d3a;">
                    <b style="flex:1;color:#e2e8f0;">🔴 ${tr('ballAndHealing')}</b>
                    <span class="ball-gold" style="color:#f6c453;"></span>
                    <button class="cfg-x portable-ball-close" type="button" aria-label="Close">×</button>
                </div>
                <div class="portable-ball-status" style="padding:8px 12px;color:#a0aec0;font-size:12px;">${tr('loading')}</div>
                <div class="portable-ball-list" style="padding:0 12px 12px;overflow:auto;display:grid;gap:7px;"></div>
            </div>`;
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        backdrop.querySelector('.portable-ball-close').addEventListener('click', close);
        backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });

        const status = backdrop.querySelector('.portable-ball-status');
        const list = backdrop.querySelector('.portable-ball-list');
        try {
            ballCatalogPromise = null;
            markCatalogPromise = null;
            const [shopData, ballsData, inventory] = await Promise.all([
                loadMarkCatalog(),
                loadBallCatalog(),
                requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3000, attempts: 2 })
            ]);
            const locale = getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US';
            const blockedBalls = new Set(['idle ball', 'master ball']);
            const balls = (Array.isArray(shopData.balls) ? shopData.balls : [])
                .filter(ball => !blockedBalls.has(String(ball.name || '').trim().toLocaleLowerCase()));
            const consumables = (Array.isArray(shopData.items) ? shopData.items : [])
                .filter(item => ['heal', 'revive'].includes(String(item.category || '').toLocaleLowerCase()) || /potion|revive/i.test(String(item.name || '')));
            const itemCounts = new Map(inventory.map(item => [String(item.itemId), Number(item.quantity) || 0]));
            const data = { gold: Number(shopData.gold ?? ballsData.gold ?? 0) };
            backdrop.querySelector('.ball-gold').textContent = `💲 ${data.gold.toLocaleString(locale)}`;
            status.textContent = '';

            const addHeading = (label, icon) => {
                const heading = document.createElement('div');
                heading.className = 'portable-shop-heading';
                heading.innerHTML = `<span>${icon}</span><span>${escapeHTML(label)}</span>`;
                list.appendChild(heading);
            };

            const renderProduct = (product, kind) => {
                const row = document.createElement('div');
                row.className = `ball-row ball-row-${kind}`;
                row.style.cssText = 'display:grid;grid-template-columns:minmax(150px,1fr) auto;gap:12px;align-items:center;background:#14222d;border:1px solid #1f3545;border-radius:7px;padding:9px 11px;';
                const info = document.createElement('div');
                info.className = 'portable-ball-info';
                info.style.cssText = 'display:grid;grid-template-columns:36px 1fr;gap:9px;align-items:center;';
                const visual = document.createElement('div');
                visual.className = 'portable-ball-visual';
                const icon = document.createElement('img');
                icon.src = normalizeGameItemIcon(product.icon || product.iconUrl);
                icon.alt = product.name || '';
                icon.style.cssText = 'width:34px;height:34px;object-fit:contain;';
                icon.onerror = () => { icon.style.visibility = 'hidden'; };
                const details = document.createElement('div');
                details.className = 'portable-ball-details';
                const initialCount = kind === 'ball'
                    ? Number(ballsData.counts?.[String(product.id)] || 0)
                    : Number(itemCounts.get(String(product.id)) || 0);
                row.dataset.ownedCount = String(initialCount);
                details.innerHTML = `<small class="portable-ball-kind">${kind === 'ball' ? 'POKÉ BALL' : tr('healingConsumable')}</small><b class="portable-ball-name">${escapeHTML(product.name)}</b><small class="portable-ball-meta"><span class="portable-ball-owned">📦 ${initialCount.toLocaleString(locale)}× ${tr('inStock')}</span><span class="portable-ball-price">💲 ${Number(product.priceGold || 0).toLocaleString(locale)}</span></small>`;
                visual.appendChild(icon);
                info.append(visual, details);
                const actions = document.createElement('div');
                actions.className = 'ball-actions';
                actions.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;';
                [1, 10, 100, 1000, 10000].forEach(quantity => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'ball-buy';
                    button.textContent = `+${quantity.toLocaleString(getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US')}`;
                    button.addEventListener('click', async () => {
                        button.disabled = true;
                        try {
                            const confirmed = await new Promise(resolve => showPurchaseConfirm({
                                name: product.name,
                                quantity,
                                unitPrice: Number(product.priceGold) || 0,
                                currentGold: Number(data.gold) || 0
                            }, resolve));
                            if (!confirmed) return;
                            const result = await buyFromMarkShop(product, kind, quantity);
                            data.gold = Number(result.gold ?? data.gold);
                            const serverCount = kind === 'ball'
                                ? result.counts?.[String(product.id)]
                                : result.inventory?.find?.(item => String(item.itemId) === String(product.id))?.quantity;
                            const currentCount = Number(row.dataset.ownedCount || 0);
                            const count = Number(serverCount ?? (currentCount + quantity));
                            row.dataset.ownedCount = String(count);
                            info.querySelector('.portable-ball-owned').textContent = `📦 ${count.toLocaleString(locale)}× ${tr('inStock')}`;
                            backdrop.querySelector('.ball-gold').textContent = `💲 ${data.gold.toLocaleString(locale)}`;
                            showWindowMessage(backdrop.querySelector('.script-portable-ball-window'), tr('purchaseDone'));
                        } catch (error) {
                            showWindowMessage(backdrop.querySelector('.script-portable-ball-window'), `${tr('purchaseFailed')} ${error.message}`, true);
                        } finally {
                            button.disabled = false;
                        }
                    });
                    actions.appendChild(button);
                });
                row.append(info, actions);
                list.appendChild(row);
            };

            addHeading(tr('balls'), '🔴');
            balls.forEach(ball => renderProduct(ball, 'ball'));
            addHeading(tr('potionsRevives'), '🧪');
            consumables.forEach(item => renderProduct(item, 'item'));
        } catch (error) {
            status.textContent = `${tr('loadFailed')} ${error.message || ''}`.trim();
        }
    }

    function injectHuntBallEnhancements(ballWindow) {
        if (!ballWindow) return;

        const header = ballWindow.querySelector('.ball-head');
        if (!isHuntSellActive()) header?.querySelector('.hunt-sell-open')?.remove();
        if (header && isHuntSellActive() && !header.querySelector('.hunt-sell-open')) {
            const sellButton = document.createElement('button');
            sellButton.type = 'button';
            sellButton.className = 'mk-bulk-btn hunt-sell-open';
            sellButton.textContent = '💰 Vender itens';
            sellButton.addEventListener('click', async () => {
                ballWindow.querySelector('.cfg-x')?.click();
                await new Promise(resolve => setTimeout(resolve, 100));
                showHuntSellWindow();
            });
            header.querySelector('.cfg-x')?.before(sellButton);
        }

        if (!isHuntBulkBuyActive()) {
            ballWindow.querySelectorAll('.script-hunt-bulk').forEach(button => button.remove());
            ballWindow.querySelectorAll('.ball-actions').forEach(actions => delete actions.dataset.bulkEnhanced);
            return;
        }
        ballWindow.querySelectorAll('.ball-row').forEach(row => {
            const actions = row.querySelector('.ball-actions');
            const ballName = row.querySelector('.ball-name')?.textContent?.trim();
            if (!actions || !ballName || !actions.querySelector('.ball-buy') || actions.dataset.bulkEnhanced) return;

            [1000, 10000].forEach(quantity => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ball-buy script-hunt-bulk';
                button.textContent = `+${quantity.toLocaleString('pt-BR')}`;
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        const data = await loadBallCatalog();
                        const ball = data.catalog?.find(item => item.name === ballName);
                        if (!ball?.id) throw new Error('Poké Bola não encontrada no catálogo.');
                        const confirmed = await new Promise(resolve => showPurchaseConfirm({
                            name: ballName,
                            quantity,
                            unitPrice: Number(ball.priceGold) || 0,
                            currentGold: Number(data.gold) || 0
                        }, resolve));
                        if (!confirmed) return;
                        const result = await gameApiRequest('/api/game/balls/buy', {
                            method: 'POST',
                            body: JSON.stringify({ ballId: ball.id, qty: quantity })
                        });
                        const owned = row.querySelector('.ball-own');
                        const count = result.counts?.[String(ball.id)];
                        if (owned && count !== undefined) owned.textContent = `${Number(count).toLocaleString('pt-BR')}× em estoque`;
                        const gold = ballWindow.querySelector('.ball-gold');
                        if (gold && result.gold !== undefined) gold.textContent = `💲 ${Number(result.gold).toLocaleString('pt-BR')}`;
                        ballCatalogPromise = null;
                        showWindowMessage(ballWindow, `Compra concluída: ${quantity.toLocaleString('pt-BR')}× ${ballName}`);
                    } catch (error) {
                        console.error('Falha ao comprar Poké Bolas:', error);
                        showWindowMessage(ballWindow, `Não foi possível concluir a compra: ${error.message}`, true);
                    } finally {
                        button.disabled = false;
                    }
                });
                actions.appendChild(button);
            });
            actions.dataset.bulkEnhanced = 'true';
        });
    }

    let markCatalogPromise = null;

    function loadMarkCatalog() {
        if (!markCatalogPromise) {
            markCatalogPromise = gameApiRequest('/api/game/shop').catch(error => {
                markCatalogPromise = null;
                throw error;
            });
        }
        return markCatalogPromise;
    }

    async function buyFromMarkShop(product, kind, quantity) {
        const requestedQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
        let remaining = requestedQuantity;
        let result = null;
        while (remaining > 0) {
            const batchQuantity = Math.min(1000, remaining);
            const payload = kind === 'ball'
                ? { ballId: product.id, qty: batchQuantity }
                : { itemId: product.id, qty: batchQuantity };
            result = await gameApiRequest('/api/game/shop/buy', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            remaining -= batchQuantity;
        }
        return result || {};
    }

    function setNativeInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, String(value));
        else input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let markQualityMenuOpen = false;

    function findNativeMarkWindow() {
        return Array.from(document.querySelectorAll('.mk-window')).find(windowElement => {
            if (windowElement.classList.contains('script-market-window') || windowElement.closest('.script-market-backdrop')) return false;
            const title = windowElement.querySelector('.ball-head, .mk-head')?.textContent || '';
            return /(?:Loja\s+do\s+Mark|Mark(?:'s)?\s+Shop)/i.test(title);
        }) || null;
    }

    function isMarkQualitySelected(button) {
        return button.classList.contains('on')
            || button.classList.contains('active')
            || button.getAttribute('aria-pressed') === 'true'
            || button.dataset.active === 'true'
            || button.querySelector('input[type="checkbox"]')?.checked === true;
    }

    function injectMarkQualityMultiSelect(mkWindow) {
        if (!preferenceEnabled(STORAGE_MARK_QUALITY_PICKER)) return;
        const qualityPattern = /^(?:fraca|comum|incomum|rara|épica|epica|lendária|lendaria|mítica|mitica|anciã|ancia|divina|poor|common|uncommon|rare|epic|legendary|mythic|ancient|divine)$/i;
        const qualityButtons = Array.from(mkWindow.querySelectorAll('button:not(.script-quality-toggle)'))
            .filter(button => qualityPattern.test(button.textContent.trim()));
        if (qualityButtons.length < 3) return;
        const parent = qualityButtons[0].parentElement;
        const siblings = qualityButtons.filter(button => button.parentElement === parent);
        if (siblings.length < 3 || parent.querySelector('.script-quality-multiselect')) return;
        mkWindow.querySelectorAll('.script-quality-dropdown').forEach(dropdown => dropdown.remove());
        siblings.forEach(button => { button.style.display = 'none'; button.dataset.scriptQualityNative = 'true'; });

        const picker = document.createElement('div');
        picker.className = 'script-quality-multiselect';
        picker.innerHTML = '<button class="mk-bulk-btn script-quality-toggle" type="button" aria-haspopup="true" aria-expanded="false">Qualidades: todas ▾</button>';
        const toggle = picker.querySelector('.script-quality-toggle');

        const updateLabel = (dropdown = mkWindow.querySelector('.script-quality-dropdown')) => {
            const selectedCount = dropdown
                ? dropdown.querySelectorAll('input[type="checkbox"]:checked').length
                : siblings.filter(isMarkQualitySelected).length;
            toggle.textContent = selectedCount ? `Qualidades: ${selectedCount} selecionada(s) ▾` : 'Qualidades: todas ▾';
        };

        const closeDropdown = () => {
            mkWindow.querySelector('.script-quality-dropdown')?.remove();
            markQualityMenuOpen = false;
            toggle.setAttribute('aria-expanded', 'false');
        };

        const openDropdown = () => {
            mkWindow.querySelector('.script-quality-dropdown')?.remove();
            const dropdown = document.createElement('div');
            dropdown.className = 'script-quality-dropdown';
            dropdown.setAttribute('role', 'menu');
            siblings.forEach(button => {
                const labelText = button.textContent.trim();
                const option = document.createElement('label');
                option.className = 'script-quality-option';
                option.innerHTML = `<input type="checkbox" data-label="${escapeHTML(labelText)}"> <span>${escapeHTML(labelText)}</span>`;
                const checkbox = option.querySelector('input');
                checkbox.checked = isMarkQualitySelected(button);
                checkbox.addEventListener('change', event => {
                    event.stopPropagation();
                    markQualityMenuOpen = true;
                    updateLabel(dropdown);
                    button.click();
                    [50, 150, 300].forEach(delay => setTimeout(() => {
                        if (!picker.isConnected || siblings.some(nativeButton => !nativeButton.isConnected)) {
                            picker.remove();
                            mkWindow.querySelector('.script-quality-dropdown')?.remove();
                            injectMarkQualityMultiSelect(mkWindow);
                            return;
                        }
                        const currentDropdown = mkWindow.querySelector('.script-quality-dropdown');
                        if (currentDropdown) updateLabel(currentDropdown);
                        else if (picker.isConnected && markQualityMenuOpen) openDropdown();
                    }, delay));
                });
                dropdown.appendChild(option);
            });
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type => dropdown.addEventListener(type, event => event.stopPropagation()));
            mkWindow.appendChild(dropdown);
            const toggleRect = toggle.getBoundingClientRect();
            const windowRect = mkWindow.getBoundingClientRect();
            const desiredLeft = toggleRect.left - windowRect.left;
            const maxLeft = Math.max(8, windowRect.width - dropdown.offsetWidth - 8);
            dropdown.style.left = `${Math.max(8, Math.min(desiredLeft, maxLeft))}px`;
            dropdown.style.top = `${toggleRect.bottom - windowRect.top + 4}px`;
            markQualityMenuOpen = true;
            toggle.setAttribute('aria-expanded', 'true');
            updateLabel(dropdown);
        };

        toggle.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (mkWindow.querySelector('.script-quality-dropdown')) closeDropdown();
            else openDropdown();
        });

        const outside = event => {
            if (!picker.isConnected) return document.removeEventListener('pointerdown', outside, true);
            const dropdown = mkWindow.querySelector('.script-quality-dropdown');
            if (!picker.contains(event.target) && !dropdown?.contains(event.target)) closeDropdown();
        };
        document.addEventListener('pointerdown', outside, true);
        parent.appendChild(picker);
        updateLabel();
        if (markQualityMenuOpen) requestAnimationFrame(openDropdown);
    }

    function legacyInjectMarkBuyQuantities(mkWindow) {
        const quantityBar = mkWindow.querySelector('.mk-qtybar');
        const quantityInput = quantityBar?.querySelector('input.mk-qty');
        if (!quantityBar || !quantityInput) return;
        Array.from(quantityBar.children).forEach(child => {
            if (!child.classList.contains('script-mark-qty-presets')) child.style.display = 'none';
        });
        quantityBar.style.justifyContent = 'center';
        if (quantityBar.querySelector('.script-mark-qty-presets')) return;

        const presets = document.createElement('span');
        presets.className = 'script-mark-qty-presets';
        presets.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;width:100%;';
        [1, 10, 100, 1000, 10000].forEach(quantity => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mk-bulk-btn';
            button.textContent = quantity.toLocaleString('pt-BR');
            button.addEventListener('click', () => {
                mkWindow.dataset.scriptBuyQty = String(quantity);
                setNativeInputValue(quantityInput, quantity);
                presets.querySelectorAll('button').forEach(item => item.classList.toggle('on', item === button));
            });
            presets.appendChild(button);
        });
        quantityInput.addEventListener('input', () => delete mkWindow.dataset.scriptBuyQty);
        quantityBar.appendChild(presets);

        if (!mkWindow.dataset.scriptBuyIntercepted) {
            mkWindow.addEventListener('click', async event => {
                const buyButton = event.target.closest('button.mk-buy');
                const quantity = parseInt(mkWindow.dataset.scriptBuyQty, 10);
                if (!buyButton || !quantity) return;
                event.preventDefault();
                event.stopImmediatePropagation();

                const row = buyButton.closest('.mk-row');
                const name = row?.querySelector('.mk-name')?.textContent?.trim();
                if (!name) return;
                buyButton.disabled = true;
                try {
                    const [catalog, characterData] = await Promise.all([
                        loadMarkCatalog(),
                        gameApiRequest('/api/characters/me').catch(() => null)
                    ]);
                    const ball = catalog.balls?.find(item => item.name === name);
                    const item = catalog.items?.find(entry => entry.name === name);
                    const product = ball || item;
                    if (!product) throw new Error('Produto não encontrado.');
                    const displayedGold = parseGameNumber(mkWindow.querySelector('.mk-gold')?.textContent);
                    const currentGold = Math.max(
                        0,
                        Number(characterData?.character?.gold || 0),
                        Number(characterData?.gold || 0),
                        Number(displayedGold || 0),
                        Number(catalog.gold || 0)
                    );
                    const confirmed = await new Promise(resolve => showPurchaseConfirm({
                        name,
                        quantity,
                        unitPrice: Number(product.priceGold) || 0,
                        currentGold
                    }, resolve));
                    if (!confirmed) return;
                    const result = await buyFromMarkShop(product, ball ? 'ball' : 'item', quantity);
                    const gold = mkWindow.querySelector('.mk-gold');
                    if (gold && result.gold !== undefined) gold.textContent = `💲 ${Number(result.gold).toLocaleString('pt-BR')}`;
                    markCatalogPromise = null;
                    showWindowMessage(mkWindow, `Compra concluída: ${quantity.toLocaleString('pt-BR')}× ${name}`);
                    setTimeout(() => {
                        const currentInput = mkWindow.querySelector('.mk-qty');
                        if (currentInput) setNativeInputValue(currentInput, quantity);
                        mkWindow.dataset.scriptBuyQty = String(quantity);
                    }, 0);
                } catch (error) {
                    showWindowMessage(mkWindow, `Não foi possível concluir a compra: ${error.message}`, true);
                } finally {
                    buyButton.disabled = false;
                }
            }, true);
            mkWindow.dataset.scriptBuyIntercepted = 'true';
        }
    }

    async function injectMarkBuyQuantities(mkWindow) {
        if (!preferenceEnabled(STORAGE_MARK_QUICK_BUY)) return;
        const quantityBar = mkWindow.querySelector('.mk-qtybar');
        if (quantityBar) quantityBar.style.display = 'none';
        const buyTab = Array.from(mkWindow.querySelectorAll('.mk-tab')).some(tab => tab.classList.contains('on') && /Comprar|Buy/i.test(tab.textContent));
        const rows = Array.from(mkWindow.querySelectorAll('.mk-row')).filter(row => row.querySelector('.mk-name'));
        if (!buyTab || !rows.length) return;
        let catalog;
        try { catalog = await loadMarkCatalog(); } catch { return; }
        rows.forEach(row => {
            if (row.querySelector('.script-mark-row-buy')) return;
            const name = row.querySelector('.mk-name')?.textContent?.trim();
            const ball = catalog.balls?.find(product => product.name === name);
            const item = catalog.items?.find(product => product.name === name);
            const product = ball || item;
            if (!product) return;
            row.querySelector('button.mk-buy')?.style.setProperty('display', 'none');
            const actions = document.createElement('div');
            actions.className = 'script-mark-row-buy';
            [1, 10, 100, 1000, 10000].forEach(quantity => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'mk-bulk-btn';
                button.textContent = quantity.toLocaleString('pt-BR');
                button.title = `Comprar ${quantity.toLocaleString('pt-BR')}× ${name}`;
                button.addEventListener('click', async event => {
                    event.preventDefault(); event.stopPropagation();
                    button.disabled = true;
                    try {
                        const currentGold = Math.max(0, parseGameNumber(mkWindow.querySelector('.mk-gold')?.textContent), Number(catalog.gold || 0));
                        const confirmed = await new Promise(resolve => showPurchaseConfirm({ name, quantity, unitPrice: Number(product.priceGold) || 0, currentGold }, resolve));
                        if (!confirmed) return;
                        const result = await buyFromMarkShop(product, ball ? 'ball' : 'item', quantity);
                        const gold = mkWindow.querySelector('.mk-gold');
                        if (gold && result.gold !== undefined) gold.textContent = `💲 ${Number(result.gold).toLocaleString('pt-BR')}`;
                        const owned = row.querySelector('.script-owned-qty');
                        if (owned) {
                            const serverCount = ball ? result.counts?.[String(product.id)] : result.inventory?.find?.(entry => String(entry.itemId) === String(product.id))?.quantity;
                            const current = parseGameNumber(owned.textContent);
                            owned.textContent = `${Number(serverCount ?? current + quantity).toLocaleString('pt-BR')}× ${tr('inStock')}`;
                        }
                        latestInventory = null; markCatalogPromise = null; ballCatalogPromise = null;
                        const confirmedStock = ball
                            ? Number((await loadBallCatalog()).counts?.[String(product.id)])
                            : Number((await requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3500, attempts: 2 }))
                                .find(entry => String(entry.itemId) === String(product.id))?.quantity || 0);
                        const currentOwned = row.querySelector('.script-owned-qty');
                        if (currentOwned && Number.isFinite(confirmedStock)) {
                            currentOwned.textContent = `${confirmedStock.toLocaleString('pt-BR')}× ${tr('inStock')}`;
                        }
                        showWindowMessage(mkWindow, `Compra concluída: ${quantity.toLocaleString('pt-BR')}× ${name}`);
                    } catch (error) {
                        showWindowMessage(mkWindow, `Não foi possível concluir a compra: ${error.message}`, true);
                    } finally { button.disabled = false; }
                });
                actions.appendChild(button);
            });
            (row.querySelector('.mk-actions') || row).appendChild(actions);
        });
    }

    async function injectMarkOwnedQuantities(mkWindow) {
        const buyTab = Array.from(mkWindow.querySelectorAll('.mk-tab'))
            .some(tab => tab.classList.contains('on') && /Comprar|Buy/i.test(tab.textContent));
        if (!buyTab || !mkWindow.querySelector('.mk-row') || mkWindow.dataset.scriptOwnedLoading === 'true') return;
        mkWindow.dataset.scriptOwnedLoading = 'true';

        let shouldRetry = false;
        try {
            let [inventory, ballsData, shopData] = await Promise.all([
                requestGameEvent('inventory', 'inv-get', latestInventory),
                loadBallCatalog(),
                loadMarkCatalog()
            ]);
            const inventoryAvailable = inventory.length > 0;
            shouldRetry = !inventoryAvailable;
            const itemCounts = new Map(inventory.map(entry => [String(entry.itemId), Number(entry.quantity) || 0]));

            mkWindow.querySelectorAll('.mk-row').forEach(row => {
                const name = row.querySelector('.mk-name')?.textContent?.trim();
                const info = row.querySelector('.mk-info');
                if (!name || !info) return;
                const ball = shopData.balls?.find(item => item.name === name);
                const item = shopData.items?.find(entry => entry.name === name);
                if (!ball && item && !inventoryAvailable) {
                    info.querySelector('.script-owned-qty')?.remove();
                    return;
                }
                const quantity = ball
                    ? Number(ballsData.counts?.[String(ball.id)] || 0)
                    : Number(itemCounts.get(String(item?.id)) || 0);

                let owned = info.querySelector('.script-owned-qty');
                if (!owned) {
                    owned = document.createElement('div');
                    owned.className = 'mk-meta script-owned-qty';
                    info.appendChild(owned);
                }
                const quantityText = `${quantity.toLocaleString(getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US')}× ${tr('inStock')}`;
                if (owned.textContent !== quantityText) owned.textContent = quantityText;
            });
            if (inventoryAvailable) delete mkWindow.dataset.scriptOwnedRetries;
        } catch (error) {
            console.warn('Falha ao carregar quantidades do Mark:', error);
            shouldRetry = true;
        } finally {
            delete mkWindow.dataset.scriptOwnedLoading;
            if (shouldRetry && mkWindow.isConnected) {
                const retries = Number(mkWindow.dataset.scriptOwnedRetries || 0);
                if (retries < 5) {
                    mkWindow.dataset.scriptOwnedRetries = String(retries + 1);
                    setTimeout(() => injectMarkOwnedQuantities(mkWindow), 800);
                }
            }
        }
    }

    function showMarkModSettings(mkWindow) {
        const activateMarkSettings = () => {
            injectConfigTab();
            const configWindow = document.querySelector('.cfg-window');
            const modsTab = configWindow?.querySelector('.cfg-tab-mods');
            if (!modsTab || !configWindow.getClientRects().length) return false;
            modsTab.click();
            requestAnimationFrame(() => {
                const markSetting = configWindow.querySelector('.cfg-mark-quick-buy, .cfg-mark-quality-picker, .btn-mark-enhancements');
                const section = markSetting?.closest('.script-mod-category') || markSetting?.closest('.cfg-row');
                section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
            return true;
        };
        const settingsButton = Array.from(document.querySelectorAll('button')).find(button => {
            if (button.closest('.mk-window, .cfg-window') || button.classList.contains('script-mark-settings')) return false;
            const accessibleText = `${button.textContent || ''} ${button.title || ''} ${button.getAttribute('aria-label') || ''}`.trim();
            return /configura|settings|ajustes|prefer[eê]ncias/i.test(accessibleText)
                || /^⚙(?:️)?$/.test(accessibleText)
                || button.matches('[class*="setting" i], [class*="config" i], [class*="gear" i]');
        });
        const closeButton = mkWindow.querySelector('.ball-head .cfg-x:not(.script-mark-settings), .mk-head .cfg-x:not(.script-mark-settings)');
        closeButton?.click();
        setTimeout(() => {
            const configWindow = document.querySelector('.cfg-window');
            if (!configWindow?.getClientRects().length) {
                settingsButton?.click();
                setTimeout(() => {
                    const menuItem = Array.from(document.querySelectorAll('button, .sel-item')).find(element => {
                        if (!element.getClientRects().length || element === settingsButton || element.closest('.cfg-window, .mk-window')) return false;
                        return /^(?:Configurações|Settings)$/i.test(element.textContent.trim());
                    });
                    menuItem?.click();
                }, 100);
            }
            let attempts = 0;
            const waitForSettings = setInterval(() => {
                attempts += 1;
                if (activateMarkSettings() || attempts >= 40) {
                    clearInterval(waitForSettings);
                    if (attempts >= 40) showScriptNotice('NÃ£o foi possÃ­vel abrir as configuraÃ§Ãµes do Mark.', { title: 'ConfiguraÃ§Ãµes', isError: true });
                }
            }, 50);
        }, 80);
    }

    function injectMarkSettingsButton(mkWindow) {
        const header = mkWindow.querySelector('.ball-head, .mk-head');
        if (!header || header.querySelector('.script-mark-settings')) return;
        const settingsButton = document.createElement('button');
        settingsButton.type = 'button';
        settingsButton.className = 'cfg-x script-mark-settings';
        settingsButton.textContent = '⚙️';
        settingsButton.title = 'ConfiguraÃ§Ãµes do Mark';
        settingsButton.setAttribute('aria-label', 'Abrir configuraÃ§Ãµes do Mark');
        settingsButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            showMarkModSettings(mkWindow);
        });
        const closeButton = header.querySelector('.cfg-x');
        if (closeButton) closeButton.before(settingsButton);
        else header.appendChild(settingsButton);
    }

    function injectShopEnhancements() {
        document.querySelectorAll('.script-market-window .script-mark-settings').forEach(button => button.remove());
        const mkWindow = findNativeMarkWindow();
        if (!mkWindow) return;

        injectMarkBuyQuantities(mkWindow);
        injectMarkOwnedQuantities(mkWindow);
        injectMarkQualityMultiSelect(mkWindow);
        injectMarkSettingsButton(mkWindow);
        
        // A proteção/lock de itens agora é nativa do jogo; não duplicar controles no Mark.
        const isSellTab = !!Array.from(mkWindow.querySelectorAll('.mk-tab'))
            .find(t => t.classList.contains('on') && /\b(?:Sell|Vender)\b/i.test(t.textContent));
        if (isSellTab) {
            mkWindow.querySelectorAll('.mk-srow-head').forEach(row => {
                const itemName = row.querySelector('.mk-name')?.textContent?.trim();
                const nativeLock = row.querySelector('.mk-lock, [class*="lock" i][role="button"], button[aria-label*="lock" i]');
                if (!itemName || !nativeLock) return;
                const lockText = `${nativeLock.textContent || ''} ${nativeLock.title || ''} ${nativeLock.getAttribute('aria-label') || ''}`;
                const locked = row.classList.contains('locked') || nativeLock.classList.contains('on')
                    || /🔒|unlock|destravar|desbloquear/i.test(lockText);
                setNativeItemLock(itemName, locked);
            });
            // Intercept Sell CTA via event delegation on the sellbar
            const sellBar = mkWindow.querySelector('.mk-sellbar');
            if (sellBar && !sellBar.dataset.sellIntercepted) {
                let sellConfirmed = false;
                sellBar.addEventListener('click', (e) => {
                    const sellBtn = e.target.closest('button.mk-sell');
                    if (!sellBtn || sellBtn.disabled) return;
                    
                    // If we already confirmed, let it through
                    if (sellConfirmed) {
                        sellConfirmed = false;
                        return;
                    }
                    
                    const confirmList = getSellConfirmItems();
                    const selectedToConfirm = [];
                    mkWindow.querySelectorAll('.mk-srow-head').forEach(row => {
                        const cb = row.querySelector('input.mk-check');
                        if (cb && cb.checked) {
                            const nameEl = row.querySelector('.mk-name');
                            const itemName = nameEl ? nameEl.textContent.trim() : '';
                            if (confirmList.includes(itemName)) {
                                selectedToConfirm.push(itemName);
                            }
                        }
                    });
                    
                    if (selectedToConfirm.length > 0) {
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        showSellConfirm(selectedToConfirm, (confirmed) => {
                            if (confirmed) {
                                sellConfirmed = true;
                                sellBtn.click();
                            }
                        });
                    }
                }, true); // capture phase – runs before React's handler
                sellBar.dataset.sellIntercepted = 'true';
            }
        }
        
        const isPokeTab = !!Array.from(mkWindow.querySelectorAll('.mk-tab')).find(t => t.classList.contains('on') && t.textContent.includes('Pokémon'));
        if (isPokeTab) {
            const selectAllBtn = mkWindow.querySelector('button.mk-selall');
            if (selectAllBtn && !selectAllBtn.dataset.intercepted) {
                selectAllBtn.addEventListener('click', () => {
                    if (!isGuardLegendaryActive()) return;
                    let ticks = 0;
                    const interval = setInterval(() => {
                        mkWindow.querySelectorAll('.mk-srow-head').forEach(row => {
                            const rarity = getPokemonRarity(row);
                            const forbidden = ['lendária', 'mítica', 'divina'];
                            if (rarity && forbidden.some(r => rarity.includes(r))) {
                                const cb = row.querySelector('input.mk-check');
                                if (cb && cb.checked) cb.click();
                            }
                        });
                        ticks++;
                        if (ticks > 5) clearInterval(interval);
                    }, 20);
                });
                selectAllBtn.dataset.intercepted = 'true';
            }
        }
    }

    function injectDexEnhancements() {
        const dexWindow = document.querySelector('.dex-window');
        if (!dexWindow) return;

        const grid = dexWindow.querySelector('.dex-grid');
        if (!grid) {
            const stale = dexWindow.querySelector('.dex-script-controls');
            if (stale) stale.remove();
            return;
        }

        if (dexWindow.querySelector('.dex-script-controls')) {
            return;
        }
        loadCaughtPokedexData(true);

        const dexControls = dexWindow.querySelector('.dex-controls');
        if (!dexControls) return;

        const ftEnabled = isDexFastTravelActive();

        // A API de marcadores é a fonte confiável para saber quais criaturas
        // possuem hunt. O catálogo de criaturas permanece como fallback.
        const huntableNames = new Set();
        if (globalHuntMarkerData.size > 0) {
            for (const marker of new Set(globalHuntMarkerData.values())) {
                const name = getMarkerName(marker);
                if (name) huntableNames.add(getCleanHuntName(name));
            }
        } else {
            for (const [name, data] of globalCreatureApiData.entries()) {
                if (data.hunts?.length || data.hunt || data.area || data.map || data.location || data.slug) {
                    huntableNames.add(name);
                }
            }
        }

        // Mark cells that have no hunt with a red X badge
        grid.querySelectorAll('.dex-cell').forEach(cell => {
            if (cell.querySelector('.dex-no-hunt-badge')) return;
            const nameEl = cell.querySelector('.dex-cell-name');
            if (!nameEl) return;
            const pokeName = nameEl.textContent.trim().toLowerCase();
            const hasData = globalCreatureApiData.has(pokeName);
            // Only mark if we have loaded data and the pokemon has no hunt
            if (hasData && huntableNames.size > 0 && !huntableNames.has(pokeName)) {
                const badge = document.createElement('span');
                badge.className = 'dex-no-hunt-badge';
                badge.textContent = '✕';
                badge.title = 'Sem hunt disponível';
                badge.style.cssText = 'position:absolute;top:2px;right:2px;background:#e53e3e;color:#fff;border-radius:50%;width:14px;height:14px;font-size:9px;display:flex;align-items:center;justify-content:center;line-height:1;font-weight:bold;pointer-events:none;';
                cell.style.position = 'relative';
                cell.appendChild(badge);
            }
        });

        const bar = document.createElement('div');
        bar.className = 'dex-script-controls';
        // Filtros e ordenação já são fornecidos pela Pokédex nativa.
        bar.innerHTML = ftEnabled ? '<label class="dex-ft-label"><input type="checkbox" class="dex-ft-check"> ⚡ Fast Travel</label>' : '';
        dexControls.after(bar);

        const filterBtns = bar.querySelectorAll('.dex-fbtn[data-filter]');
        const sortBtn = bar.querySelector('.dex-fbtn[data-filter="sort-value"]');

        // Restore persisted state
        let currentFilter = 'all';
        let sortedByValue = false;
        let originalOrder = null;

        function applyFilter() {
            const cells = grid.querySelectorAll('.dex-cell');
            cells.forEach(cell => {
                const isCaught = cell.classList.contains('caught');
                const isClaimable = cell.classList.contains('claimable');
                if (currentFilter === 'all') {
                    cell.classList.remove('dex-hidden');
                } else if (currentFilter === 'caught') {
                    cell.classList.toggle('dex-hidden', !isCaught);
                } else if (currentFilter === 'notcaught') {
                    cell.classList.toggle('dex-hidden', isCaught);
                } else if (currentFilter === 'claimable') {
                    cell.classList.toggle('dex-hidden', !isClaimable);
                }
            });
        }

        function getPokeValue(name) {
            const cleanName = name.toLowerCase().trim();
            const noHunt = huntableNames.size > 0 && !huntableNames.has(cleanName);
            if (globalCreatureApiData.has(cleanName)) {
                const pokeObj = globalCreatureApiData.get(cleanName);
                const possiblePriceKeys = ['sellValue', 'priceNpc', 'sell', 'sellsFor', 'price', 'value', 'gold', 'money', 'cost', 'reward'];
                for (const key of possiblePriceKeys) {
                    if (pokeObj[key] !== undefined && pokeObj[key] !== null && pokeObj[key] !== '') {
                        const parsed = parseGameNumber(pokeObj[key]);
                        if (parsed > 0) return noHunt ? 99999999 : parsed;
                    }
                }
            }
            return 999999;
        }

        function sortByValue() {
            if (!originalOrder) originalOrder = Array.from(grid.children);
            const cells = Array.from(grid.querySelectorAll('.dex-cell'));
            cells.sort((a, b) => {
                const nameA = a.querySelector('.dex-cell-name')?.textContent || '';
                const nameB = b.querySelector('.dex-cell-name')?.textContent || '';
                return getPokeValue(nameA) - getPokeValue(nameB);
            });
            cells.forEach(c => grid.appendChild(c));
            sortedByValue = true;
            setDexSortedByValue(true);
        }

        function restoreOrder() {
            if (originalOrder) {
                originalOrder.forEach(c => grid.appendChild(c));
                sortedByValue = false;
                setDexSortedByValue(false);
            }
        }

        // Apply persisted sort
        if (sortedByValue) sortByValue();

        // Apply persisted filter and update button states
        filterBtns.forEach(b => b.classList.remove('on'));
        const activeBtn = bar.querySelector(`.dex-fbtn[data-filter="${currentFilter}"]`);
        if (activeBtn) activeBtn.classList.add('on');
        if (currentFilter === 'notcaught' && sortBtn) sortBtn.style.display = '';
        applyFilter();

        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const filter = btn.dataset.filter;
                if (filter === 'sort-value') {
                    if (sortedByValue) {
                        restoreOrder();
                        btn.classList.remove('on');
                    } else {
                        sortByValue();
                        btn.classList.add('on');
                    }
                    applyFilter();
                    return;
                }
                currentFilter = filter;
                setDexFilter(filter);
                filterBtns.forEach(b => {
                    if (b.dataset.filter !== 'sort-value') b.classList.remove('on');
                });
                btn.classList.add('on');

                if (filter === 'notcaught') {
                    sortBtn.style.display = '';
                } else {
                    sortBtn.style.display = 'none';
                    if (sortedByValue) {
                        restoreOrder();
                        sortBtn.classList.remove('on');
                    }
                }
                applyFilter();
            });
        });

        // Fast Travel: intercept clicks on dex-cell
        const ftCheck = bar.querySelector('.dex-ft-check');
        if (ftCheck && !grid.dataset.fastTravelIntercepted) {
            grid.addEventListener('click', (e) => {
                const currentFtCheck = dexWindow.querySelector('.dex-ft-check');
                if (!currentFtCheck?.checked) return;
                const cell = e.target.closest('.dex-cell');
                if (!cell) return;
                e.stopPropagation();
                e.preventDefault();
                const pokeName = cell.querySelector('.dex-cell-name')?.textContent?.trim();
                if (!pokeName) return;
                teleportToTarget(pokeName);
            }, true);
            grid.dataset.fastTravelIntercepted = 'true';
        }
    }

    let lastHuntSnapshot = null;
    let currentHuntSnapshot = null;
    let lastCatchTimestamp = null;
    let ballsAtLastCatch = 0;
    let capturesCount = 0;
    let lastHuntStartTime = null;
    let currentHuntStartTime = Date.now();
    let huntHistory = readStoredJSON(STORAGE_HA_HISTORY, []);
    if (!Array.isArray(huntHistory)) huntHistory = [];

    function parseHuntDuration(text) {
        const value = String(text || '');
        if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim())) {
            return value.trim().split(':').map(Number).reduce((total, part) => (total * 60) + part, 0);
        }
        const hours = Number(value.match(/(\d+)\s*h/)?.[1] || 0);
        const minutes = Number(value.match(/(\d+)\s*m/)?.[1] || 0);
        const seconds = Number(value.match(/(\d+)\s*s/)?.[1] || 0);
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    function getCurrentHuntLocation() {
        const location = document.querySelector('.phud-tloc')?.textContent?.trim() || '';
        const parts = location.split(/[·•]/).map(part => part.trim()).filter(Boolean);
        return parts.at(-1) || location || '';
    }

    function saveHuntSession(snapshot, startedAt) {
        if (!snapshot || Date.now() - startedAt < 3000 || (!snapshot.defeated && !snapshot.xpGained && !snapshot.balance)) return false;
        huntHistory.unshift({ ...snapshot, startedAt, endedAt: Date.now() });
        huntHistory = huntHistory.slice(0, 20);
        localStorage.setItem(STORAGE_HA_HISTORY, JSON.stringify(huntHistory));
        return true;
    }

    function formatNumber(num) {
        return new Intl.NumberFormat('pt-BR').format(num);
    }

    // A qualidade é o multiplicador numérico oficial retornado pelo jogo.
    // As faixas e cores seguem a apresentação do JustPokédex para que o valor
    // seja legível sem perder a precisão do multiplicador.
    function getPokemonQualityInfo(multiplier) {
        const value = Number(multiplier);
        if (!Number.isFinite(value)) return null;
        if (value < 1.0) return { label: 'Fraca', color: '#9e9e9e' };
        if (value < 1.1) return { label: 'Comum', color: '#a8a8a8' };
        if (value < 1.3) return { label: 'Incomum', color: '#5ed7b9' };
        if (value < 1.5) return { label: 'Rara', color: '#69b7ff' };
        if (value < 1.7) return { label: 'Épica', color: '#d985ff' };
        if (value < 2.0) return { label: 'Lendária', color: '#f1c644' };
        if (value < 3.0) return { label: 'Mítica', color: '#ff6680' };
        if (value < 4.0) return { label: 'Anciã', color: '#ff9800' };
        return { label: 'Divina', color: '#00bcd4' };
    }

    function formatPokemonQuality(multiplier) {
        const info = getPokemonQualityInfo(multiplier);
        const value = Number(multiplier);
        return info ? `${info.label} ×${value.toFixed(2)}` : null;
    }

    function getCaptureIvTotal(capture, row) {
        const directValues = [capture?.ivTotal, capture?.totalIv, capture?.iv, capture?.growth];
        for (const candidate of directValues) {
            if (Number.isFinite(Number(candidate))) return Number(candidate);
            if (candidate && typeof candidate === 'object') {
                const total = Object.values(candidate).reduce((sum, value) => sum + (Number(value) || 0), 0);
                if (total > 0) return total;
            }
        }

        const ivText = row?.textContent?.match(/\bIV\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:\/\s*192)?/i)?.[1];
        return ivText ? Number(ivText.replace(',', '.')) : null;
    }

    let huntAnalyzerRenderRefreshPending = false;
    function refreshHuntAnalyzerGameRender() {
        if (huntAnalyzerRenderRefreshPending || document.hidden) return;
        if (!document.querySelector('.ha-window:not(.ha-compare-modal)')) return;
        huntAnalyzerRenderRefreshPending = true;
        setTimeout(() => {
            try {
                const event = new Event('visibilitychange');
                Object.defineProperty(event, 'piwQolRenderRefresh', { value: true });
                document.dispatchEvent(event);
            } finally {
                huntAnalyzerRenderRefreshPending = false;
            }
        }, 80);
    }

    document.addEventListener('visibilitychange', event => {
        if (!event.piwQolRenderRefresh && !document.hidden) refreshHuntAnalyzerGameRender();
    });
    window.addEventListener('focus', refreshHuntAnalyzerGameRender);

    function showCompareModal() {
        const curr = currentHuntSnapshot || { defeated: 0, timeText: '0s', balance: 0, balHour: 0, xpHour: 0, killsHour: 0, xpGained: 0, locName: 'Nenhuma' };
        const last = lastHuntSnapshot || huntHistory[0] || { defeated: 0, timeText: '0s', balance: 0, balHour: 0, xpHour: 0, killsHour: 0, xpGained: 0, locName: 'Nenhuma' };

        const cmp = (a, b) => {
            if (a > b) return ['ha-compare-winner', 'ha-compare-loser'];
            if (b > a) return ['ha-compare-loser', 'ha-compare-winner'];
            return ['', ''];
        };

        const formatTitle = (ts, loc) => {
            let res = loc ? loc : 'Hunt';
            if (ts) {
                const d = new Date(ts);
                res += ` (${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')})`;
            }
            return res;
        };
        const lastTitle = formatTitle(lastHuntStartTime || last.startedAt, last.locName);
        const currTitle = formatTitle(currentHuntStartTime, curr.locName);

        const [balLast, balCurr] = cmp(last.balance, curr.balance);
        const [balhLast, balhCurr] = cmp(last.balHour, curr.balHour);
        const [xpLast, xpCurr] = cmp(last.xpHour, curr.xpHour);
        const [killsLast, killsCurr] = cmp(last.killsHour, curr.killsHour);
        const [xpgLast, xpgCurr] = cmp(last.xpGained, curr.xpGained);

        const formatBal = (val) => val < 0 ? `-$${formatNumber(Math.abs(val))}` : `$${formatNumber(val)}`;

        const backdrop = document.createElement('div');
        backdrop.className = 'ha-compare-backdrop';
        backdrop.innerHTML = `
            <div class="ha-window ha-compare-modal" style="position: relative; box-shadow: 0 12px 32px rgba(0,0,0,0.8);">
                <div class="ha-title">
                    <span>⚖️ Comparação de Hunts</span>
                    <button class="ha-x ha-compare-close" aria-label="Close" type="button">×</button>
                </div>
                <div style="padding: 12px;">
                    <table class="ha-compare-table">
                        <tr><th>Métrica</th><th>${escapeHTML(lastTitle)}</th><th>${escapeHTML(currTitle)}</th></tr>
                        <tr><td>💰 Balance Total</td><td class="${balLast}">${formatBal(last.balance)}</td><td class="${balCurr}">${formatBal(curr.balance)}</td></tr>
                        <tr><td>📉 Balance/h</td><td class="${balhLast}">${formatBal(last.balHour)}</td><td class="${balhCurr}">${formatBal(curr.balHour)}</td></tr>
                        <tr><td>🌟 XP Gained</td><td class="${xpgLast}">${formatNumber(last.xpGained)}</td><td class="${xpgCurr}">${formatNumber(curr.xpGained)}</td></tr>
                        <tr><td>✨ XP/h</td><td class="${xpLast}">${formatNumber(last.xpHour)}</td><td class="${xpCurr}">${formatNumber(curr.xpHour)}</td></tr>
                        <tr><td>⚔️ Kills/h</td><td class="${killsLast}">${formatNumber(last.killsHour)}</td><td class="${killsCurr}">${formatNumber(curr.killsHour)}</td></tr>
                        <tr><td>⏱️ Tempo</td><td>${last.timeText}</td><td>${curr.timeText}</td></tr>
                        <tr><td>💀 Defeated</td><td>${last.defeated}</td><td>${curr.defeated}</td></tr>
                    </table>
                    <div style="margin-top:12px;border-top:1px solid #263b4c;padding-top:10px;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <b style="color:#dce7f1;flex:1;">Histórico recente</b>
                            <button class="ha-sbtn ha-history-clear" type="button">Limpar histórico</button>
                        </div>
                        <div class="ha-history-list" style="display:grid;gap:6px;margin-top:8px;max-height:150px;overflow:auto;">
                            ${huntHistory.length ? huntHistory.slice(0, 10).map(session => `
                                <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;background:#101d27;border-radius:6px;padding:7px 9px;color:#aebdca;font-size:12px;">
                                    <span>${escapeHTML(session.locName || 'Hunt')}</span>
                                    <span>${formatBal(session.balance || 0)}</span>
                                    <span>${formatNumber(session.xpGained || 0)} XP</span>
                                </div>
                            `).join('') : '<span style="color:#718096;font-size:12px;">Nenhuma sessão concluída ainda.</span>'}
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        backdrop.querySelector('.ha-history-clear').addEventListener('click', async () => {
            if (!await showScriptConfirm('Apagar todo o histórico salvo do Hunt Analyzer?', {
                title: 'Limpar histórico',
                confirmLabel: 'Apagar'
            })) return;
            huntHistory = [];
            lastHuntSnapshot = null;
            localStorage.removeItem(STORAGE_HA_HISTORY);
            backdrop.querySelector('.ha-history-list').innerHTML = '<span style="color:#718096;font-size:12px;">Nenhuma sessão concluída ainda.</span>';
        });

        // Arraste por ponteiro: funciona com mouse e telas sensíveis ao toque.
        let isDragging = false, startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
        const modal = backdrop.querySelector('.ha-compare-modal');
        const titleBar = modal.querySelector('.ha-title');
        
        titleBar.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const rect = modal.getBoundingClientRect();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = rect.left;
            initialTop = rect.top;
            modal.style.setProperty('left', `${rect.left}px`, 'important');
            modal.style.setProperty('top', `${rect.top}px`, 'important');
            modal.style.transform = 'none';
            titleBar.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        });
        const handlePointerMove = e => {
            if (!isDragging) return;
            const maxLeft = Math.max(0, window.innerWidth - modal.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - modal.offsetHeight);
            modal.style.setProperty('left', `${Math.min(maxLeft, Math.max(0, initialLeft + e.clientX - startX))}px`, 'important');
            modal.style.setProperty('top', `${Math.min(maxTop, Math.max(0, initialTop + e.clientY - startY))}px`, 'important');
        };
        const handlePointerUp = () => { isDragging = false; };
        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerUp);

        backdrop.querySelector('.ha-compare-close').addEventListener('click', () => {
            document.removeEventListener('pointermove', handlePointerMove);
            document.removeEventListener('pointerup', handlePointerUp);
            backdrop.remove();
        });
    }

    function trackHuntAnalyzer() {
        const haWindow = document.querySelector('.ha-window:not(.ha-compare-modal)');
        if (!haWindow) return;
        refreshHuntAnalyzerGameRender();

        const getCardVal = (idx) => {
            const card = haWindow.querySelectorAll('.ha-card b')[idx];
            return card ? parseInt(card.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;
        };
        const defeated = getCardVal(0);
        const timeText = haWindow.querySelectorAll('.ha-card b')[1]?.textContent || '0s';
        const xpGained = getCardVal(2);
        if (lastAnalyzerXp === null || xpGained !== lastAnalyzerXp) {
            lastAnalyzerXp = xpGained;
            lastAnalyzerXpChangeAt = Date.now();
        }
        
        const balanceNode = haWindow.querySelector('.ha-balance b');
        let balance = 0;
        if (balanceNode) {
            balance = parseInt(balanceNode.textContent.replace(/−/g, '-').replace(/[.]/g, '').replace(/[^0-9-]/g, ''), 10) || 0;
        }

        const catchCard = haWindow.querySelector('.ha-catch b');
        const currentCatch = catchCard ? parseInt(catchCard.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;
        
        let currentBalls = 0;
        const supplyCard = haWindow.querySelector('.ha-supply small');
        if (supplyCard) {
            const match = supplyCard.textContent.match(/(\d+)\s+balls/);
            if (match) currentBalls = parseInt(match[1], 10);
        }

        const locName = getCurrentHuntLocation() || currentHuntSnapshot?.locName || '';
        const durationSeconds = parseHuntDuration(timeText);
        const locationChanged = Boolean(
            currentHuntSnapshot?.locName && locName && currentHuntSnapshot.locName !== locName
        );
        const countersReset = Boolean(
            currentHuntSnapshot && (
                defeated < currentHuntSnapshot.defeated ||
                durationSeconds < (currentHuntSnapshot.durationSeconds || 0)
            )
        );
        const isReset = locationChanged || countersReset;
        
        if (isReset) {
            const completedSnapshot = { ...currentHuntSnapshot };
            if (saveHuntSession(completedSnapshot, currentHuntStartTime)) {
                lastHuntSnapshot = completedSnapshot;
            }
            capturesCount = 0;
            lastCatchTimestamp = null;
            ballsAtLastCatch = 0;
            lastHuntStartTime = currentHuntStartTime;
            currentHuntStartTime = Date.now();
        }

        if (!currentHuntSnapshot || isReset) {
            capturesCount = currentCatch;
        } else if (currentCatch > capturesCount) {
            capturesCount = currentCatch;
            lastCatchTimestamp = Date.now();
            ballsAtLastCatch = currentBalls;
        }

        const ratesNode = haWindow.querySelector('.ha-rates');
        let balHour = 0, xpHour = 0, killsHour = 0;
        if (ratesNode) {
            const spans = ratesNode.querySelectorAll('span:not(.ha-catch-stats)');
            if (spans[0]) balHour = parseInt(spans[0].textContent.replace(/−/g, '-').replace(/[.]/g, '').replace(/[^0-9-]/g, ''), 10) || 0;
            if (spans[1]) xpHour = parseInt(spans[1].textContent.replace(/[.]/g, '').replace(/[^0-9]/g, ''), 10) || 0;
            if (spans[2]) killsHour = parseInt(spans[2].textContent.replace(/[.]/g, '').replace(/[^0-9]/g, ''), 10) || 0;

            let catchStats = ratesNode.querySelector('.ha-catch-stats');
            if (!catchStats) {
                catchStats = document.createElement('span');
                catchStats.className = 'ha-rate ha-catch-stats';
                ratesNode.appendChild(catchStats);
            }
            if (lastCatchTimestamp) {
                const diffMs = Date.now() - lastCatchTimestamp;
                const diffM = Math.floor(diffMs / 60000);
                const timeStr = diffM > 0 ? `há ${diffM}m` : 'agora';
                const dateStr = new Date(lastCatchTimestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const ballsSpent = Math.max(0, ballsAtLastCatch - currentBalls);
                const newText = `🔴 Último catch: ${dateStr} (${timeStr}) • ${ballsSpent} balls`;
                if (catchStats.textContent !== newText) {
                    catchStats.textContent = newText;
                }
                catchStats.classList.remove('hidden');
            } else {
                const newText = `🔴 Nenhum catch nesta hunt`;
                if (catchStats.textContent !== newText) {
                    catchStats.textContent = newText;
                }
                catchStats.classList.remove('hidden');
            }
        }

        const snapshot = { defeated, timeText, durationSeconds, balance, balHour, xpHour, killsHour, xpGained, locName };
        currentHuntSnapshot = snapshot;

        const oldToggle = haWindow.querySelector('.ha-title .ha-btn-toggle-view');
        if (oldToggle) oldToggle.remove();

        // Apply persisted compact state on first injection
        if (!haWindow.dataset.haInitialized) {
            if (isHaCompact()) haWindow.classList.add('ha-compact');
            haWindow.dataset.haInitialized = 'true';
        }

        // Apply persisted drops visibility
        const drops = haWindow.querySelector('.ha-drops');
        if (drops && !haWindow.dataset.haDropsInit) {
            if (isHaDropsVisible()) drops.classList.add('show-drops');
            haWindow.dataset.haDropsInit = 'true';
        }

        let actionArea = haWindow.querySelector('.ha-script-actions');
        let isNewActionArea = false;
        if (!actionArea) {
            actionArea = document.createElement('div');
            actionArea.className = 'ha-script-actions';
            isNewActionArea = true;

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'ha-sbtn btn-toggle-view';
            toggleBtn.innerHTML = haWindow.classList.contains('ha-compact') ? '⤢ Expandir' : '⤡ Reduzir';
            toggleBtn.type = 'button';
            toggleBtn.addEventListener('click', () => {
                const isCompact = haWindow.classList.toggle('ha-compact');
                toggleBtn.innerHTML = isCompact ? '⤢ Expandir' : '⤡ Reduzir';
                setHaCompact(isCompact);
            });

            const dropBtn = document.createElement('button');
            dropBtn.className = 'ha-sbtn btn-show-drops';
            dropBtn.innerHTML = '📦 Drops';
            dropBtn.type = 'button';
            dropBtn.addEventListener('click', () => {
                const dropsEl = haWindow.querySelector('.ha-drops');
                if (dropsEl) {
                    const visible = dropsEl.classList.toggle('show-drops');
                    setHaDropsVisible(visible);
                }
            });

            const compareBtn = document.createElement('button');
            compareBtn.className = 'ha-sbtn btn-compare';
            compareBtn.innerHTML = '⚖️ Comparar';
            compareBtn.type = 'button';
            compareBtn.addEventListener('click', showCompareModal);

            actionArea.appendChild(toggleBtn);
            actionArea.appendChild(dropBtn);
            if (preferenceEnabled(STORAGE_COMPARE_WINDOW)) actionArea.appendChild(compareBtn);
        }
        if (!preferenceEnabled(STORAGE_COMPARE_WINDOW)) actionArea.querySelector('.btn-compare')?.remove();

        // O título nativo fica sempre no topo e as ações imediatamente abaixo.
        const haTitle = haWindow.querySelector(':scope > .ha-title, :scope > h3, :scope > .ha-head, :scope > .ha-header')
            || haWindow.querySelector('.ha-title, h3, .ha-head, .ha-header');
        if (haTitle) {
            if (haTitle.nextElementSibling !== actionArea) haTitle.after(actionArea);
        } else if (isNewActionArea) {
            haWindow.prepend(actionArea);
        }
    }

    function enhanceInventoryWindow() {
        const inventoryWindow = document.querySelector('.inv-window');
        if (!inventoryWindow) return;
        inventoryWindow.classList.add('script-resizable-inventory');

        const namedBackdrop = inventoryWindow.closest(
            '.win-backdrop, .modal-backdrop, .window-backdrop, .overlay, [class*="backdrop"]'
        );
        if (namedBackdrop && namedBackdrop !== inventoryWindow) {
            namedBackdrop.classList.add('script-inventory-backdrop');
            return;
        }

        let ancestor = inventoryWindow.parentElement;
        while (ancestor && ancestor !== document.body) {
            const style = getComputedStyle(ancestor);
            const rect = ancestor.getBoundingClientRect();
            if (style.position === 'fixed' && rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8) {
                ancestor.classList.add('script-inventory-backdrop');
                break;
            }
            ancestor = ancestor.parentElement;
        }
    }

    function findCaptureLogWindow() {
        const nativeWindow = document.querySelector('.clog-window');
        if (nativeWindow) return nativeWindow;
        const titlePattern = /(?:log\s*de\s*capturas|capture\s*log)/i;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let titleNode = null;
        while (walker.nextNode()) {
            if (titlePattern.test(walker.currentNode.nodeValue || '')) {
                titleNode = walker.currentNode;
                break;
            }
        }
        if (!titleNode) return null;

        const tooBig = el => el.classList.contains('game-root') || el.querySelector('.game-canvas-host, .game-dock');

        let element = titleNode.parentElement;
        while (element && element !== document.body) {
            if (tooBig(element)) return null;
            const text = element.textContent || '';
            if (/\bIV\s*:?\s*\d+\s*\/\s*\d+/i.test(text) && element.querySelector('button')) return element;
            element = element.parentElement;
        }
        const fallback = titleNode.parentElement?.closest('.win-window, .prof-window, [role="dialog"]') || null;
        return fallback && !tooBig(fallback) ? fallback : null;
    }

    let captureLogEnhancementPromise = null;
    async function enhanceCaptureLog() {
        const captureWindow = findCaptureLogWindow();
        if (!captureWindow) return;
        captureWindow.classList.add('script-capture-log-window');
        const rows = Array.from(captureWindow.querySelectorAll('.clog-row'));
        if (!rows.length || rows.every(row => row.dataset.scriptQualityLoaded === 'true')) return;
        if (captureLogEnhancementPromise) return captureLogEnhancementPromise;

        const activeTab = captureWindow.querySelector('.clog-tab.on')?.textContent?.toLowerCase() || '';
        const filter = /shiny/.test(activeTab) ? 'shiny' : /norma/.test(activeTab) ? 'normal' : 'all';
        captureLogEnhancementPromise = gameApiRequest(`/api/game/capture-log?filter=${filter}`)
            .then(payload => {
                const captures = Array.isArray(payload?.rows) ? payload.rows : [];
                Array.from(captureWindow.querySelectorAll('.clog-row')).forEach((row, index) => {
                    const capture = captures[index];
                    const level = row.querySelector('.clog-lvl');
                    const quality = Number(capture?.quality);
                    const qualityInfo = getPokemonQualityInfo(quality);
                    if (!level || !qualityInfo) return;
                    const ivTotal = getCaptureIvTotal(capture, row);
                    const ivText = Number.isFinite(ivTotal) ? ` IV ${ivTotal}/192` : '';
                    level.textContent = `${formatPokemonQuality(quality)}${ivText}`;
                    level.style.color = qualityInfo.color;
                    level.title = `Qualidade: ${formatPokemonQuality(quality)}`;
                    level.classList.add('script-quality-badge');
                    const meta = row.querySelector('.clog-meta');
                    if (meta?.innerText?.length) meta.innerHTML = '';
                    row.dataset.scriptQualityLoaded = 'true';
                });
            })
            .catch(error => console.error('Falha ao carregar a qualidade do Log de Capturas:', error))
            .finally(() => { captureLogEnhancementPromise = null; });
        return captureLogEnhancementPromise;
    }

    let domCheckTimeout = null;
    const observer = new MutationObserver(() => {
        if (domCheckTimeout) return;
        domCheckTimeout = setTimeout(() => {
            domCheckTimeout = null;
            
            injectQuickTPButton();
            if (document.querySelector('.cfg-window')) injectConfigTab();
            applyChatState();
            injectHuntShopLauncher();
            if (findNativeMarkWindow() && isMarkEnhancementsActive()) injectShopEnhancements();
            if (document.querySelector('.ball-window')) injectHuntBallEnhancements(document.querySelector('.ball-window'));
            if (document.querySelector('.dex-window')) injectDexEnhancements();
            if (document.querySelector('.ha-window:not(.ha-compare-modal)')) trackHuntAnalyzer();
            if (document.querySelector('.inv-window')) enhanceInventoryWindow();
            enhanceCaptureLog();
            applyBetterWindowScales();

            const mapWindow = document.querySelector('.map-window');
            if (mapWindow) {
                if (renderTimeout) clearTimeout(renderTimeout);
                renderTimeout = setTimeout(buildSimpleList, 200);
            }
        }, 150);
    });

    function initializeDOMEnhancements() {
        applyMapScriptState();
        observer.observe(document.body, { childList: true, subtree: true });
        applyBetterWindowScales();
        updateMarketSaleDockBadge();
        document.querySelectorAll('.market-alert-dock-badge,.market-alert-toast').forEach(element => element.remove());
        if (!marketSaleMonitorInterval) {
            setTimeout(pollCompletedMarketSales, 3500);
            marketSaleMonitorInterval = setInterval(pollCompletedMarketSales, 15000);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeDOMEnhancements, { once: true });
    } else {
        initializeDOMEnhancements();
    }
})();
