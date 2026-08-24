// ==UserScript==
// @name         Poke Idle World - Custom Card Ultimate v3.91 (Carga optimizada)
// @namespace    http://tampermonkey.net/
// @version      3.91.0
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
        { key: 'capture', label: 'Capture Bar', description: 'Cambia el panel de captura persistente y su botón para ocultarlo o mostrarlo.', css: '--cc-scale-capture' },
        { key: 'victory', label: 'Notificación de batalla', description: 'Cambia el aviso de victoria, experiencia obtenida y drops de cada derrota.', css: '--cc-scale-victory' },
        { key: 'events', label: 'Barras de eventos', description: 'Cambia el grupo inferior de eventos activos y sus ventanas informativas.', css: '--cc-scale-events' },
        { key: 'helper', label: 'Auto-Helper', description: 'Cambia el botón y la ventana de configuración del Auto-Helper.', css: '--cc-scale-helper' }
    ]);
    const SCRIPT_SCALE_DEFAULTS = Object.freeze(Object.fromEntries(SCRIPT_SCALE_AREAS.map(area => [area.key, 100])));
    let scriptScalePreferences = loadScriptScalePreferences();
    let scaleResizeTimer = null;
    let captureBarManuallyHidden = false;
    let lastCaptureBarMarkup = '';
    let lastCaptureBarSyncAt = 0;

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

    function saveScriptScalePreferences() {
        try { localStorage.setItem(SCRIPT_SCALE_STORAGE, JSON.stringify(scriptScalePreferences)); } catch (_) {}
    }

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

        #phud-toggle-btn {
            position: absolute !important;
            right: -30px !important;
            top: 20px !important;
            width: 30px !important;
            height: 48px !important;
            background-color: rgba(13, 19, 26, 0.95) !important;
            border: 1px solid #2a3a4a !important;
            border-left: none !important;
            border-radius: 0 8px 8px 0 !important;
            color: #60a5fa !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: pointer !important;
            box-shadow: 4px 0px 8px rgba(0,0,0,0.5) !important;
            z-index: 101 !important;
            font-size: 14px !important;
            transition: background 0.2s ease, color 0.2s ease !important;
        }
        #phud-toggle-btn:hover { background-color: #1e3a8a !important; color: #ffffff !important; }

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
        /* GAME DOCK - ULTRA COMPACTO Y RESPONSIVO             */
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
            display: grid !important;
            grid-template-columns: repeat(15, 26px) !important; 
            justify-content: center !important;
            gap: 4px !important; 
            z-index: 1000 !important;
            box-shadow: 0 5px 25px rgba(0,0,0,0.8) !important;
            transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), top 0.4s, right 0.4s, left 0.4s !important;
            width: max-content !important;
            max-width: 98vw !important;
            overflow: visible !important;
            contain: none !important;
            scale: var(--cc-scale-dock) !important;
            transform-origin: top center !important;
        }
        .game-dock.hidden-dock {
            transform: translateY(-100%) !important; 
        }
        
        .game-dock > * {
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
            width: 26px !important;  
            height: 26px !important; 
            min-width: 26px !important;
            min-height: 26px !important;
            max-width: 26px !important;
            max-height: 26px !important;
            box-sizing: border-box !important;
            box-shadow: none !important;
            cursor: pointer !important;
            position: relative !important; 
        }
        
        .game-dock > *:hover {
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

        .game-dock > * > span, .game-dock > * > div:not(.poke-menu):not(.script-shop-menu) {
            display: none !important; 
        }
        
        .game-dock .badge, .game-dock [style*="background: red"] {
            display: block !important;
            position: absolute !important;
            top: -3px !important;
            right: -3px !important;
            font-size: 8px !important;
            padding: 1px 3px !important;
        }
        .game-dock > * > span.script-private-chat-badge {
            position:absolute !important;
            z-index:130 !important;
            top:-6px !important;
            right:-6px !important;
            width:auto !important;
            min-width:15px !important;
            max-width:26px !important;
            height:15px !important;
            min-height:15px !important;
            box-sizing:border-box !important;
            display:grid !important;
            place-items:center !important;
            padding:0 3px !important;
            margin:0 !important;
            overflow:hidden !important;
            color:#fff !important;
            background:linear-gradient(180deg,#ff5269,#d91435) !important;
            border:1px solid #ffc0c9 !important;
            border-radius:999px !important;
            box-shadow:0 0 0 1px #4b0712,0 0 8px rgba(255,41,75,.82) !important;
            font:900 8px/1 'Segoe UI',sans-serif !important;
            text-align:center !important;
            text-shadow:0 1px #740012 !important;
            pointer-events:none !important;
        }
        .game-dock > *.script-private-chat-button.has-private-unread {
            border-color:#f43f5e !important;
            box-shadow:inset 0 0 0 1px rgba(244,63,94,.24),0 0 8px rgba(244,63,94,.34) !important;
        }

        /* --------------------------------------------------- */
        /* FIX Z-INDEX ABSOLUTO PARA SUBMENÚS                  */
        /* --------------------------------------------------- */
        .poke-menu:not(.script-shop-menu) {
            z-index: 99999 !important; 
            background-color: #0a1220 !important; 
            border: 1px solid #3b82f6 !important;
            border-radius: 8px !important;
            box-shadow: 0 10px 25px rgba(0,0,0,0.9) !important;
            width: max-content !important; 
            height: auto !important;
            max-width: none !important;
            max-height: none !important;
        }
        .script-shop-wrap { overflow:visible !important;contain:none !important;z-index:2147483645 !important; }
        .script-shop-menu { z-index:2147483646 !important;background-color:#0a1220 !important;border:1px solid #3b82f6 !important;border-radius:8px !important;box-shadow:0 10px 25px rgba(0,0,0,.9) !important; }
        .script-shop-menu[hidden] { display:none !important; }

        #dock-toggle-btn {
            position: absolute !important;
            bottom: -18px !important; 
            left: 50% !important;
            transform: translateX(-50%) !important;
            width: 50px !important;
            height: 18px !important;
            background-color: #060b14 !important;
            border: 1px solid #1c3659 !important;
            border-top: none !important;
            border-radius: 0 0 12px 12px !important;
            color: #3b82f6 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: pointer !important;
            font-size: 10px !important;
            transition: all 0.2s ease !important;
            box-shadow: 0 4px 8px rgba(0,0,0,0.5) !important;
        }
        #dock-toggle-btn::after { content: '▲'; }
        .hidden-dock #dock-toggle-btn::after { content: '▼'; }
        #dock-toggle-btn:hover { background-color: #1e3a8a !important; color: #ffffff !important; }

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
                grid-template-columns: repeat(8, 26px) !important;
                border-radius: 0 0 12px 12px !important;
                border: 1px solid #1c3659 !important;
                border-top: none !important;
            }
            .game-dock.hidden-dock {
                transform: translateY(-100%) !important;
            }
            #dock-toggle-btn {
                bottom: -18px !important;
                left: 50% !important;
                top: auto !important;
                transform: translateX(-50%) !important;
                width: 50px !important;
                height: 18px !important;
                border-radius: 0 0 12px 12px !important;
                border: 1px solid #1c3659 !important;
                border-top: none !important;
            }
            #dock-toggle-btn::after { content: '▲' !important; }
            .hidden-dock #dock-toggle-btn::after { content: '▼' !important; }
        }

        /* --------------------------------------------------- */
        /* CARDS PRINCIPALES (Hero & Mob) - REDUCIDAS 20%      */
        /* --------------------------------------------------- */
        /* La interfaz nativa permanece visible durante la carga. Solo se
           oculta cuando su reemplazo personalizado ya fue construido. */
        body.script-custom-hero-ready .cbt-card.cbt-hero,
        body.script-custom-mob-ready .cbt-card.cbt-mob { display: none !important; }
        
        .custom-poke-card { background-color: #0d131a; border-radius: 12px; padding: 10px; width: 208px; color: #ffffff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; box-shadow: 0 4px 8px rgba(0,0,0,0.5); border: 2px solid #444; position: relative; margin: 0 auto 8px auto; z-index: 1 !important; }
        #my-custom-poke-card { zoom: var(--cc-scale-battle) !important; box-sizing: border-box !important; }
        #my-custom-mob-card { zoom: var(--cc-scale-enemy) !important; }
        
        .custom-mob-card { border-color: #ef4444 !important; display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: space-between !important; padding: 12px !important; width: 144px !important; height: 200px !important; text-align: center !important; box-sizing: border-box; }
        
        .mob-name { font-size: 14px; font-weight: bold; color: #ef4444; margin: 0; width: 100%; letter-spacing: 0.5px; }
        .mob-sprite-container { display: flex; justify-content: center; align-items: center; width: 100%; flex-grow: 1; margin: 8px 0; }
        
        .mob-sprite-canvas, .mob-sprite-img { width: 104px !important; height: 104px !important; image-rendering: pixelated !important; object-fit: contain !important; }
        .mob-bars { width: 100%; }

        .cpc-header { display: flex; align-items: flex-start; gap: 8px; }
        .cpc-sprite { width: 56px; height: 56px; image-rendering: pixelated; }
        .cpc-info { flex-grow: 1; text-align: left; }
        .cpc-title { font-size: 14px; font-weight: bold; margin: 0 0 2px 0; display: flex; align-items: center; gap: 4px; }
        .cpc-shiny-icon { color: #ffd700; font-size: 12px; }
        .cpc-subtitle { font-size: 10px; color: #aaa; margin-bottom: 4px; }
        .cpc-types { display: flex; gap: 3px; margin-bottom: 3px; flex-wrap: wrap; }
        .cpc-type-badge { padding: 2px 5px; border-radius: 8px; font-size: 9px; font-weight: bold; text-transform: uppercase; background: #445e6d; }
        
        .cpc-stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 8px 0; font-size: 10px; }
        .cpc-stat-item { display: flex; justify-content: space-between; background: rgba(255,255,255,0.05); padding: 3px 5px; border-radius: 4px; }
        .cpc-stat-label { color: #888; }
        .cpc-stat-value { font-weight: bold; }
        
        .cpc-power-bar { background-color: #1a2530; border-radius: 6px; padding: 4px; text-align: center; font-weight: bold; color: #4ade80; font-size: 12px; border: 1px solid #2a3a4a; margin-top: 4px;}
        
        .cpc-bars-container { display: flex; flex-direction: column; gap: 6px; margin: 8px auto 0 auto; width: 90%; }
        .cpc-bar-wrapper { background: #1a2530; border-radius: 6px; height: 14px; position: relative; overflow: hidden; border: 1px solid #2a3a4a; box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); }
        .cpc-bar-fill { height: 100%; transition: width 0.1s linear, background 0.3s ease; }
        .cpc-hp-high { background: linear-gradient(90deg, #16a34a, #22c55e); } 
        .cpc-hp-med  { background: linear-gradient(90deg, #ca8a04, #eab308); } 
        .cpc-hp-low  { background: linear-gradient(90deg, #dc2626, #ef4444); } 
        .cpc-xp-bar  { background: linear-gradient(90deg, #d97706, #f59e0b); } 
        .cpc-bar-text { position: absolute; width: 100%; text-align: center; font-size: 9px; line-height: 14px; font-weight: bold; color: #fff; text-shadow: 1px 1px 2px #000, -1px -1px 2px #000; top: 0; left: 0; z-index: 2; pointer-events: none; }

        /* CAPTURE BAR (.cap-panel) */
        .cap-panel { position: fixed !important; bottom: 15px !important; right: 15px !important; display:block !important; visibility:visible !important; background-color: #0d131a !important; border-radius: 8px !important; padding: 10px !important; border: 1px solid #2a3a4a !important; width: 230px !important; box-sizing: border-box !important; box-shadow: 0 4px 12px rgba(0,0,0,0.8) !important; text-align: center !important; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif !important; z-index: 10 !important; max-height: min(300px, calc(100vh - 30px)) !important; overflow-y: auto !important; overflow-x: hidden !important; transition: transform 0.28s ease, opacity 0.2s ease !important; will-change: transform !important; scale:var(--cc-scale-capture) !important;transform-origin:right bottom !important; }
        .cap-panel.script-cap-hidden { transform: translateX(calc(100% + 16px)) !important; opacity: 0.15 !important; pointer-events: none !important; }
        .cap-panel::-webkit-scrollbar { width: 4px !important; }
        .cap-panel::-webkit-scrollbar-track { background: #0d131a !important; }
        .cap-panel::-webkit-scrollbar-thumb { background: #445e6d !important; border-radius: 2px !important; }
        .cap-panel div { font-size: 11px !important; color: #cbd5e1 !important; margin-bottom: 2px !important; }
        .cap-panel .progress, .cap-panel > div:last-child:not(.market-cta) { background: #1a2530 !important; border-radius: 4px !important; height: 8px !important; border: 1px solid #334155 !important; margin-top: 4px !important; overflow: hidden !important; position: relative !important; }
        .cap-panel .progress-bar, .cap-panel [style*="width"] { background: linear-gradient(90deg, #a855f7, #d946ef) !important; height: 100% !important; transition: width 0.1s linear !important; }
        #cap-panel-toggle-btn {
            position: fixed !important; width: 28px !important; height: 42px !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            padding: 0 !important; margin: 0 !important; border: 1px solid #526174 !important;
            border-right: 0 !important; border-radius: 8px 0 0 8px !important;
            background: #0d131a !important; color: #f8fafc !important;
            box-shadow: -3px 3px 8px rgba(0,0,0,0.55) !important;
            font: 900 14px/1 'Segoe UI', sans-serif !important; cursor: pointer !important;
            z-index: 211 !important; transition: right 0.28s ease, background 0.2s ease !important;
            scale:var(--cc-scale-capture) !important;transform-origin:right center !important;
        }
        #cap-panel-toggle-btn:hover { background: #1d2b3a !important; color: #facc15 !important; }
        #cap-panel-toggle-btn.is-hidden { border-color: #ca8a04 !important; }

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

        /* CONFIGURACIÓN PROPIA DEL REDISEÑO */
        #custom-card-settings-btn {
            position:fixed !important;top:15px !important;right:178px !important;z-index:10000 !important;
            min-height:32px !important;padding:6px 11px !important;border:1px solid #334b60 !important;border-radius:7px !important;
            background:#0d131a !important;color:#dbeafe !important;box-shadow:0 4px 12px #0009 !important;
            font:800 11px/1 'Segoe UI',sans-serif !important;letter-spacing:.03em !important;cursor:pointer !important;
        }
        #custom-card-settings-btn:hover { border-color:#60a5fa !important;background:#152334 !important;color:#fff !important; }
        #custom-card-settings-backdrop {
            position:fixed !important;inset:0 !important;z-index:1000001 !important;display:grid !important;place-items:center !important;
            padding:12px !important;background:rgba(2,6,11,.88) !important;box-sizing:border-box !important;
        }
        #custom-card-settings-backdrop[hidden] { display:none !important; }
        #custom-card-settings-panel {
            width:min(620px,calc(100vw - 24px)) !important;max-height:min(760px,calc(100vh - 24px)) !important;overflow:auto !important;
            border:1px solid #35516a !important;border-radius:14px !important;background:linear-gradient(155deg,#142333,#08111b 70%) !important;
            color:#e5eef5 !important;box-shadow:0 18px 55px #000d,inset 0 1px #ffffff0d !important;font-family:'Segoe UI',sans-serif !important;
        }
        #custom-card-settings-panel::-webkit-scrollbar { width:7px !important; }
        #custom-card-settings-panel::-webkit-scrollbar-thumb { background:#38536a !important;border-radius:8px !important; }
        .cc-settings-head { position:sticky !important;top:0 !important;z-index:2 !important;display:flex !important;align-items:center !important;gap:12px !important;padding:16px 18px !important;background:#0c1722 !important;border-bottom:1px solid #2a4356 !important; }
        .cc-settings-head > div { flex:1 !important;min-width:0 !important; }
        .cc-settings-kicker { display:block !important;color:#60a5fa !important;font-size:9px !important;font-weight:900 !important;letter-spacing:.14em !important;text-transform:uppercase !important; }
        .cc-settings-head h2 { margin:3px 0 0 !important;font-size:20px !important;color:#f8fafc !important; }
        .cc-settings-close { width:34px !important;height:34px !important;border:1px solid #3a5264 !important;border-radius:7px !important;background:#142330 !important;color:#e2e8f0 !important;font-size:20px !important;cursor:pointer !important; }
        .cc-settings-copy { margin:0 !important;padding:13px 18px !important;color:#91a5b5 !important;font-size:11px !important;line-height:1.5 !important;border-bottom:1px solid #213746 !important; }
        .cc-settings-tab { margin:12px 18px 0 !important;display:inline-flex !important;padding:7px 12px !important;border:1px solid #3b82f6 !important;border-bottom-color:#60a5fa !important;border-radius:7px 7px 0 0 !important;background:#16304b !important;color:#bfdbfe !important;font-size:10px !important;font-weight:900 !important;letter-spacing:.08em !important;text-transform:uppercase !important; }
        .cc-settings-list { display:grid !important;grid-template-columns:repeat(2,minmax(0,1fr)) !important;gap:9px !important;padding:12px 18px 16px !important; }
        .cc-scale-row { display:grid !important;grid-template-columns:minmax(0,1fr) 102px !important;gap:10px !important;align-items:center !important;padding:11px !important;border:1px solid #294255 !important;border-radius:9px !important;background:#0d1a25 !important; }
        .cc-scale-row b { display:block !important;color:#eef6fb !important;font-size:12px !important; }
        .cc-scale-row p { margin:3px 0 0 !important;color:#7890a2 !important;font-size:9px !important;line-height:1.35 !important; }
        .cc-scale-control select { width:100% !important;min-height:34px !important;padding:5px 8px !important;border:1px solid #37566d !important;border-radius:7px !important;background:#07111a !important;color:#f8fafc !important;font:800 11px 'Segoe UI',sans-serif !important;outline:none !important; }
        .cc-scale-control select:focus { border-color:#60a5fa !important;box-shadow:0 0 0 2px #3b82f62c !important; }
        .cc-scale-effective { display:block !important;margin-top:4px !important;color:#5f829a !important;font-size:8px !important;text-align:center !important; }
        .cc-settings-actions { position:sticky !important;bottom:0 !important;display:flex !important;justify-content:flex-end !important;gap:8px !important;padding:12px 18px !important;background:#0b1620f2 !important;border-top:1px solid #294255 !important; }
        .cc-settings-actions button { min-height:34px !important;padding:6px 13px !important;border:1px solid #3a5366 !important;border-radius:7px !important;background:#132330 !important;color:#dce8ef !important;font:800 10px 'Segoe UI',sans-serif !important;cursor:pointer !important; }
        .cc-settings-actions .primary { border-color:#ca8a04 !important;background:linear-gradient(#f7ce65,#dca934) !important;color:#201703 !important; }
        .script-persistent-capture .script-capture-placeholder { display:grid !important;gap:5px !important;place-items:center !important;padding:5px !important; }
        .script-persistent-capture .script-capture-placeholder b { color:#f8fafc !important;font-size:13px !important; }
        .script-persistent-capture .script-capture-placeholder small { color:#7f96a6 !important;font-size:9px !important;line-height:1.35 !important; }
        @media (max-width:700px) {
            #custom-card-settings-btn { padding:6px 8px !important; }
            .cc-settings-list { grid-template-columns:1fr !important; }
        }
    `);

    function closeScriptScaleSettings() {
        const backdrop = document.getElementById('custom-card-settings-backdrop');
        if (backdrop) backdrop.hidden = true;
    }

    function positionScriptSettingsButton(button) {
        if (!button) return;
        const helperButton = document.querySelector('.ah-head');
        let top = 15;
        let right = 15;
        if (helperButton && helperButton.getClientRects().length && getComputedStyle(helperButton).display !== 'none') {
            const helperRect = helperButton.getBoundingClientRect();
            const buttonHeight = button.getBoundingClientRect().height || 32;
            top = Math.max(8, Math.min(window.innerHeight - buttonHeight - 8, helperRect.bottom + 16));
            right = Math.max(8, window.innerWidth - helperRect.right);
        }
        button.style.setProperty('top', `${Math.round(top)}px`, 'important');
        button.style.setProperty('right', `${Math.round(right)}px`, 'important');
    }

    function setupScriptScaleSettings() {
        if (!document.body) return;
        let button = document.getElementById('custom-card-settings-btn');
        if (!button) {
            button = document.createElement('button');
            button.id = 'custom-card-settings-btn';
            button.type = 'button';
            button.textContent = '⚙ Diseño';
            button.title = 'Configurar tamaños del rediseño';
            document.body.appendChild(button);
        }
        positionScriptSettingsButton(button);

        let backdrop = document.getElementById('custom-card-settings-backdrop');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.id = 'custom-card-settings-backdrop';
            backdrop.hidden = true;
            backdrop.innerHTML = `
                <section id="custom-card-settings-panel" role="dialog" aria-modal="true" aria-labelledby="cc-settings-title">
                    <header class="cc-settings-head">
                        <div><span class="cc-settings-kicker">Custom Card Ultimate</span><h2 id="cc-settings-title">Configuración visual</h2></div>
                        <button class="cc-settings-close" type="button" title="Cerrar" aria-label="Cerrar">×</button>
                    </header>
                    <p class="cc-settings-copy">Elige un porcentaje independiente para cada parte rediseñada. Si una escala no cabe en la pantalla, el ajuste responsivo la reduce únicamente lo necesario para evitar cortes y solapamientos.</p>
                    <span class="cc-settings-tab">Tamaños por área</span>
                    <div class="cc-settings-list">
                        ${SCRIPT_SCALE_AREAS.map(area => `
                            <label class="cc-scale-row">
                                <span><b>${area.label}</b><p>${area.description}</p></span>
                                <span class="cc-scale-control">
                                    <select data-scale-key="${area.key}" aria-label="Tamaño de ${area.label}">
                                        ${SCRIPT_SCALE_OPTIONS.map(value => `<option value="${value}">${value}%</option>`).join('')}
                                    </select>
                                    <small class="cc-scale-effective" data-scale-effective="${area.key}"></small>
                                </span>
                            </label>`).join('')}
                    </div>
                    <footer class="cc-settings-actions"><button class="cc-settings-reset" type="button">Restablecer 100%</button><button class="cc-settings-done primary" type="button">Listo</button></footer>
                </section>`;
            document.body.appendChild(backdrop);

            backdrop.querySelectorAll('[data-scale-key]').forEach(select => {
                select.value = String(scriptScalePreferences[select.dataset.scaleKey]);
                select.addEventListener('change', () => {
                    scriptScalePreferences[select.dataset.scaleKey] = normalizeScalePercent(select.value);
                    saveScriptScalePreferences();
                    applyScriptScales();
                });
            });
            backdrop.querySelector('.cc-settings-close').addEventListener('click', closeScriptScaleSettings);
            backdrop.querySelector('.cc-settings-done').addEventListener('click', closeScriptScaleSettings);
            backdrop.querySelector('.cc-settings-reset').addEventListener('click', () => {
                scriptScalePreferences = { ...SCRIPT_SCALE_DEFAULTS };
                backdrop.querySelectorAll('[data-scale-key]').forEach(select => { select.value = '100'; });
                saveScriptScalePreferences();
                applyScriptScales();
            });
            backdrop.addEventListener('click', event => {
                if (event.target === backdrop) closeScriptScaleSettings();
            });
        }

        if (!button.dataset.settingsBound) {
            button.dataset.settingsBound = 'true';
            button.addEventListener('click', () => {
                backdrop.hidden = false;
                backdrop.querySelectorAll('[data-scale-key]').forEach(select => {
                    select.value = String(scriptScalePreferences[select.dataset.scaleKey]);
                });
                applyScriptScales();
                backdrop.querySelector('.cc-settings-close')?.focus();
            });
        }
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeScriptScaleSettings();
    });

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

    function renderCustomCard() {
        if (!latestPokemonData) return;
        const p = latestPokemonData;
        const stats = p.stats || {};
        const hp = stats.hp ?? stats.HP ?? 0;
        const atk = stats.atk ?? stats.attack ?? 0;
        
        const currentKey = `${p.id}_${p.level}_${p.power || p.cp}_${hp}_${atk}`;
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
            customCard.className = 'custom-poke-card';
            originalCard.parentElement.appendChild(customCard);
        }

        lastRenderKey = currentKey;
        const tierInfo = getTierInfo(p.quality);
        customCard.style.borderColor = tierInfo.color;

        let typesRaw = p.types || p.type || p.elements;
        let typesArr = Array.isArray(typesRaw) ? typesRaw : (typeof typesRaw === 'string' ? [typesRaw] : []);
        if (typesArr.length === 0 && p.type1) { typesArr.push(p.type1); if (p.type2) typesArr.push(p.type2); }
        if (typesArr.length === 0) typesArr = ["???"]; 
        const typesHtml = typesArr.map(t => `<span class="cpc-type-badge">${t}</span>`).join('');

        const def = stats.def ?? stats.defense ?? 0;
        const spa = stats.spa ?? stats.spAtk ?? stats.sp_atk ?? stats.satk ?? "-";
        const spd = stats.spd ?? stats.spDef ?? stats.sp_def ?? stats.sdef ?? "-";
        const vel = stats.vel ?? stats.speed ?? stats.spe ?? "-";

        customCard.innerHTML = `
            <div class="cpc-header">
                <img src="${p.spriteUrl || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${p.speciesId}.png`}" alt="${p.name}" class="cpc-sprite">
                <div class="cpc-info">
                    <h3 class="cpc-title">${p.name} ${p.shiny ? `<span class="cpc-shiny-icon">✨</span>` : ''}</h3>
                    <div class="cpc-subtitle">Nv ${p.level || 1} • IV <b>${p.ivTotal || p.ivs_total || 0}</b>/192 • <span style="color:${tierInfo.color}; font-weight:bold;">${tierInfo.label}</span></div>
                    <div class="cpc-types">${typesHtml}</div>
                </div>
            </div>
            <div class="cpc-stats-grid">
                <div class="cpc-stat-item"><span class="cpc-stat-label">HP</span><span class="cpc-stat-value">${hp}</span></div>
                <div class="cpc-stat-item"><span class="cpc-stat-label">Atk</span><span class="cpc-stat-value">${atk}</span></div>
                <div class="cpc-stat-item"><span class="cpc-stat-label">Def</span><span class="cpc-stat-value">${def}</span></div>
                <div class="cpc-stat-item"><span class="cpc-stat-label">SpA</span><span class="cpc-stat-value">${spa}</span></div>
                <div class="cpc-stat-item"><span class="cpc-stat-label">SpD</span><span class="cpc-stat-value">${spd}</span></div>
                <div class="cpc-stat-item"><span class="cpc-stat-label">Vel</span><span class="cpc-stat-value">${vel}</span></div>
            </div>
            <div class="cpc-power-bar">💪 Poder ${p.power || p.cp || 0}</div>
            <div class="cpc-bars-container">
                <div class="cpc-bar-wrapper">
                    <div class="cpc-bar-fill cpc-hp-high" id="cpc-hp-fill" style="width: 100%"></div>
                    <div class="cpc-bar-text" id="cpc-hp-text">HP: Cargando...</div>
                </div>
                <div class="cpc-bar-wrapper">
                    <div class="cpc-bar-fill cpc-xp-bar" id="cpc-xp-fill" style="width: 0%"></div>
                    <div class="cpc-bar-text" id="cpc-xp-text">XP: Cargando...</div>
                </div>
            </div>
        `;
        
        domCache.hpFill = document.getElementById('cpc-hp-fill');
        domCache.hpText = document.getElementById('cpc-hp-text');
        domCache.xpFill = document.getElementById('cpc-xp-fill');
        domCache.xpText = document.getElementById('cpc-xp-text');
        document.body?.classList.add('script-custom-hero-ready');
    }

    function setupHudToggle() {
        const hud = document.querySelector('.phud.game-hud-tl');
        if (!hud) return;

        if (hud.dataset.scriptInitialHidden !== 'true') {
            hud.dataset.scriptInitialHidden = 'true';
            hud.classList.add('hidden-hud');
        }
        if (!document.getElementById('phud-toggle-btn')) {
            const btn = document.createElement('div');
            btn.id = 'phud-toggle-btn';
            btn.title = "Ocultar / Mostrar Info del Jugador";
            btn.onclick = () => {
                hud.classList.toggle('hidden-hud');
                btn.innerHTML = hud.classList.contains('hidden-hud') ? '▶' : '◀';
            };
            hud.appendChild(btn);
        }
        const button = document.getElementById('phud-toggle-btn');
        if (button) button.innerHTML = hud.classList.contains('hidden-hud') ? '▶' : '◀';
    }

    function ensurePersistentCaptureBar() {
        if (!document.body) return null;
        const nativePanel = document.querySelector('.cap-panel:not(.script-persistent-capture)');
        const placeholder = document.querySelector('.cap-panel.script-persistent-capture');

        if (nativePanel) {
            placeholder?.remove();
            nativePanel.hidden = false;
            nativePanel.removeAttribute('hidden');
            nativePanel.classList.remove('invisible-check');
            nativePanel.classList.toggle('script-cap-hidden', captureBarManuallyHidden);
            const now = Date.now();
            if (now - lastCaptureBarSyncAt >= 250) {
                lastCaptureBarSyncAt = now;
                lastCaptureBarMarkup = nativePanel.innerHTML;
            }
            return nativePanel;
        }

        if (placeholder) {
            placeholder.classList.toggle('script-cap-hidden', captureBarManuallyHidden);
            return placeholder;
        }

        const persistentPanel = document.createElement('aside');
        persistentPanel.className = 'cap-panel script-persistent-capture';
        persistentPanel.setAttribute('aria-label', 'Capture Bar');
        persistentPanel.innerHTML = lastCaptureBarMarkup || `
            <div class="script-capture-placeholder">
                <b>🎯 Capture</b>
                <small>Sin Pokémon salvaje detectado. El panel permanecerá disponible durante toda la sesión.</small>
            </div>`;
        persistentPanel.classList.toggle('script-cap-hidden', captureBarManuallyHidden);
        document.body.appendChild(persistentPanel);
        return persistentPanel;
    }

    function setupCaptureBarToggle() {
        const panel = ensurePersistentCaptureBar();
        let button = document.getElementById('cap-panel-toggle-btn');

        if (!panel) {
            if (button) button.remove();
            return;
        }

        if (!button) {
            button = document.createElement('button');
            button.id = 'cap-panel-toggle-btn';
            button.type = 'button';
            button.setAttribute('aria-controls', 'capture-bar');
            button.onclick = () => {
                const currentPanel = ensurePersistentCaptureBar();
                if (!currentPanel) return;
                captureBarManuallyHidden = !currentPanel.classList.contains('script-cap-hidden');
                currentPanel.classList.toggle('script-cap-hidden', captureBarManuallyHidden);
                setupCaptureBarToggle();
            };
            document.body.appendChild(button);
        }

        const hidden = panel.classList.contains('script-cap-hidden');
        const rect = panel.getBoundingClientRect();
        const top = Math.max(8, Math.min(window.innerHeight - 50, rect.top + (rect.height / 2) - 21));
        button.textContent = hidden ? '◀' : '▶';
        button.title = hidden ? 'Mostrar Capture Bar' : 'Ocultar Capture Bar';
        button.setAttribute('aria-expanded', hidden ? 'false' : 'true');
        button.classList.toggle('is-hidden', hidden);
        button.style.right = hidden ? '0px' : `${Math.max(0, Math.round(window.innerWidth - rect.left))}px`;
        button.style.top = `${Math.round(top)}px`;
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
        let badge = chatButton.querySelector(':scope > .script-private-chat-badge');
        if (!unread?.count) {
            badge?.remove();
            chatButton.classList.remove('has-private-unread');
            chatButton.removeAttribute('data-script-private-unread');
            privateChatDockObserver?.takeRecords();
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'script-private-chat-badge';
            badge.setAttribute('aria-hidden', 'true');
            chatButton.appendChild(badge);
        }
        if (badge.textContent !== unread.text) badge.textContent = unread.text;
        const badgeTitle = `${unread.count} mensaje${unread.count === 1 ? '' : 's'} privado${unread.count === 1 ? '' : 's'} sin leer`;
        if (badge.title !== badgeTitle) badge.title = badgeTitle;
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

    function setupDockToggle() {
        const dock = document.querySelector('.game-dock');
        if (!dock) return;

        if (dock.dataset.scriptInitialHidden !== 'true') {
            dock.dataset.scriptInitialHidden = 'true';
            dock.classList.add('hidden-dock');
        }
        if (!document.getElementById('dock-toggle-btn')) {
            const btn = document.createElement('div');
            btn.id = 'dock-toggle-btn';
            btn.title = "Ocultar / Mostrar Navegación";
            btn.onclick = () => {
                dock.classList.toggle('hidden-dock');
            };
            dock.appendChild(btn);
        }
    }

    function themePartyBars() {
        const partyContainer = document.querySelector('.phud-party');
        if (!partyContainer) return;
        
        const partyNodes = partyContainer.children;
        for (let i = 0; i < partyNodes.length; i++) {
            let node = partyNodes[i];
            
            let avatarBox = node.firstElementChild; 
            if (avatarBox) {
                avatarBox.style.setProperty('background', '#1e293b', 'important');
                avatarBox.style.setProperty('background-color', '#1e293b', 'important');
                avatarBox.style.setProperty('background-image', 'none', 'important');
            }

            let matchedPoke = teamData[i]; 
            let nodeText = node.innerText.toLowerCase();
            let foundByName = teamData.find(p => p.name && nodeText.includes(p.name.toLowerCase()));
            if (foundByName) matchedPoke = foundByName;

            if (matchedPoke) {
                let types = matchedPoke.types || matchedPoke.type || matchedPoke.elements;
                let t1 = Array.isArray(types) ? types[0] : (typeof types === 'string' ? types : matchedPoke.type1);
                let t2 = Array.isArray(types) ? types[1] : matchedPoke.type2;
                
                let color1 = getTypeColor(t1);
                let color2 = getTypeColor(t2) || color1;
                
                let hpBar = node.querySelector('.progress-bar') || node.querySelector('[style*="width"]');
                if (hpBar) hpBar.style.background = `linear-gradient(90deg, ${color1}, ${color2})`;
            } else {
                let hpBar = node.querySelector('.progress-bar') || node.querySelector('[style*="width"]');
                if (hpBar) hpBar.style.background = 'linear-gradient(90deg, #16a34a, #22c55e)';
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

    function updateMobCard() {
        const mobCard = document.querySelector('.cbt-card.cbt-mob');
        let customMobCard = document.getElementById('my-custom-mob-card');

        if (!mobCard) {
            if (customMobCard) customMobCard.remove();
            document.body?.classList.remove('script-custom-mob-ready');
            return;
        }

        if (!customMobCard) {
            customMobCard = document.createElement('div');
            customMobCard.id = 'my-custom-mob-card';
            customMobCard.className = 'custom-poke-card custom-mob-card';
            mobCard.parentElement.appendChild(customMobCard);

            customMobCard.innerHTML = `
                <div class="mob-name">Enemigo</div>
                <div class="mob-sprite-container">
                    <canvas class="mob-sprite-canvas" width="64" height="64"></canvas>
                    <img class="mob-sprite-img" src="" style="display:none;">
                </div>
                <div class="mob-bars">
                    <div class="cpc-bar-wrapper">
                        <div class="cpc-bar-fill cpc-hp-high mob-hp-fill" style="width: 100%"></div>
                        <div class="cpc-bar-text mob-hp-text">HP: ...</div>
                    </div>
                </div>
            `;
        }

        const nameEl = mobCard.querySelector('.cbt-cardname');
        const spriteContainerEl = mobCard.querySelector('.cbt-sprite');
        const hpLblEl = mobCard.querySelector('.cbt-bar-lbl');
        const hpTrackEl = mobCard.querySelector('.cbt-bar-track');

        if (nameEl) {
            let fullText = nameEl.textContent.trim();
            if (fullText !== customMobCard.dataset.lastName) {
                let match = fullText.match(/(.*?)\s+(Lv\.?|Nv\.?)\s*\d+/i);
                customMobCard.querySelector('.mob-name').textContent = match ? match[1].trim() : fullText;
                customMobCard.dataset.lastName = fullText;
            }
        }

        if (spriteContainerEl) {
            const originalCanvas = spriteContainerEl.querySelector('canvas');
            const customCanvas = customMobCard.querySelector('.mob-sprite-canvas');
            const customImg = customMobCard.querySelector('.mob-sprite-img');

            if (originalCanvas) {
                customCanvas.style.display = 'block';
                customImg.style.display = 'none';
            } else {
                customCanvas.style.display = 'none';
                customImg.style.display = 'block';

                let src = "";
                let imgInner = spriteContainerEl.querySelector('img');
                if (imgInner) src = imgInner.src;
                else if (spriteContainerEl.tagName.toLowerCase() === 'img') src = spriteContainerEl.src;
                
                if (src && customImg.src !== src) customImg.src = src;
            }
        }

        let hpPct = 100;
        let hpText = "HP: ...";
        
        if (hpLblEl) hpText = hpLblEl.textContent.trim();
        
        if (hpTrackEl) {
            let barChild = hpTrackEl.querySelector('[style*="width"]');
            if (barChild) {
                hpPct = parseFloat(barChild.style.width) || 100;
            } else if (hpText) {
                let m = hpText.match(/([0-9.,]+)[kMBT]?\s*\/\s*([0-9.,]+)[kMBT]?/i);
                if (m) {
                    let c = parseFloat(m[1].replace(/,/g, ''));
                    let t = parseFloat(m[2].replace(/,/g, ''));
                    if (t > 0) hpPct = (c/t)*100;
                }
            }
        }

        hpPct = Math.max(0, Math.min(100, hpPct));
        
        let hpFill = customMobCard.querySelector('.mob-hp-fill');
        let hpTextEl = customMobCard.querySelector('.mob-hp-text');

        if (hpFill) {
            hpFill.style.width = hpPct + '%';
            let hpClass = 'cpc-hp-high';
            if (hpPct <= 20) hpClass = 'cpc-hp-low';
            else if (hpPct <= 50) hpClass = 'cpc-hp-med';
            hpFill.className = `cpc-bar-fill mob-hp-fill ${hpClass}`;
        }
        if (hpTextEl && hpText) hpTextEl.textContent = hpText;
        document.body?.classList.add('script-custom-mob-ready');
    }

    /* El canvas solo necesita una copia visual ocasional. El ciclo anterior
       consultaba el DOM y redibujaba a 60 FPS en cada cuenta. */
    let canvasCopyTimer = 0;
    function copyMobCanvas() {
        canvasCopyTimer = 0;
        if (document.visibilityState !== 'hidden') {
            const originalCanvas = document.querySelector('.cbt-card.cbt-mob canvas');
            const customCanvas = document.querySelector('.mob-sprite-canvas');

            if (originalCanvas && customCanvas && customCanvas.style.display !== 'none') {
                if (customCanvas.width !== originalCanvas.width) customCanvas.width = originalCanvas.width;
                if (customCanvas.height !== originalCanvas.height) customCanvas.height = originalCanvas.height;

                const ctx = customCanvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, customCanvas.width, customCanvas.height);
                    ctx.drawImage(originalCanvas, 0, 0);
                }
            }
        }
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
        safelyRefresh(updateEventBoostBar);
        safelyRefresh(themePartyBars);

        const now = Date.now();
        if (now - lastStructureRefreshAt >= STRUCTURE_REFRESH_MS) {
            lastStructureRefreshAt = now;
            safelyRefresh(setupCaptureBarToggle);
            safelyRefresh(setupHudToggle);
            safelyRefresh(setupDockToggle);
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
        const currentId = latestPokemonData?.id;
        const mayUpdateCurrent = currentId != null && rawPayload.includes(String(currentId));
        if (!hasTeamSnapshot && !mayUpdateCurrent) return;
        if (socketPayloadQueue.length >= SOCKET_QUEUE_LIMIT) socketPayloadQueue.shift();
        socketPayloadQueue.push(rawPayload);
        scheduleSocketDrain();
    }

    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
            const ws = Reflect.construct(target, args);
            ws.addEventListener('message', event => enqueueSocketPayload(event.data), { passive: true });
            return ws;
        }
    });

    function updateLiveBars() {
        if (!domCache.phudNode || !domCache.phudNode.isConnected) {
            domCache.phudNode = document.querySelector('.phud-mon');
            if (!domCache.phudNode) return;
        }

        const text = domCache.phudNode.innerText || "";
        const matchHP = text.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?[kMBT]?)\s*\/\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?[kMBT]?)/i);
        const matchXP = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);

        let hpPercent = 100, xpPercent = 0, hpText = "", xpText = "";

        if (matchXP) { xpText = matchXP[0].trim(); xpPercent = parseFloat(matchXP[1]) || 0; }
        if (matchHP) {
            hpText = matchHP[0].trim();
            const cur = parseFloat(matchHP[1].replace(/,/g, '').replace(/[kMBT]/ig, ''));
            const max = parseFloat(matchHP[2].replace(/,/g, '').replace(/[kMBT]/ig, ''));
            if (!isNaN(cur) && !isNaN(max) && max > 0) hpPercent = (cur / max) * 100;
        }

        hpPercent = Math.min(100, Math.max(0, hpPercent));
        xpPercent = Math.min(100, Math.max(0, xpPercent));
        let currentHpClass = 'cpc-hp-high';
        if (hpPercent <= 20) currentHpClass = 'cpc-hp-low';
        else if (hpPercent <= 50) currentHpClass = 'cpc-hp-med';

        const newHpWidth = `${hpPercent}%`;
        const newXpWidth = `${xpPercent}%`;
        const newHpText = `HP: ${hpText || Math.round(hpPercent) + '%'}`;
        const newXpText = `XP: ${xpText || xpPercent.toFixed(1) + '%'}`;

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
