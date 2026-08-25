// ==UserScript==
// @name         Poke Idle World - Chat Translator
// @namespace    pokegrid.launcher
// @version      1.6.0
// @description  Traduce mensajes entrantes del chat y permite traducir o traducir y enviar mensajes salientes.
// @author       PokeGrid
// @match        https://poke.idleworld.online/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.mymemory.translated.net
// @connect      libretranslate.com
// @connect      *
// ==/UserScript==

(() => {
    'use strict';

    if (window.__piwChatTranslator?.version) return;

    const SCRIPT_ID = 'piw-chat-translator';
    const STORAGE_KEY = 'settings-v1';
    const VERSION = '1.6.0';
    const LANGUAGES = [
        ['auto', 'Detectar automáticamente'],
        ['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'],
        ['de', 'Alemán'], ['it', 'Italiano'], ['nl', 'Neerlandés'], ['pl', 'Polaco'],
        ['tr', 'Turco'], ['ru', 'Ruso'], ['uk', 'Ucraniano'], ['ja', 'Japonés'],
        ['ko', 'Coreano'], ['zh-CN', 'Chino simplificado'], ['zh-TW', 'Chino tradicional']
    ];
    const DEFAULTS = Object.freeze({
        enabled: true,
        showOriginal: true,
        provider: 'mymemory',
        incomingSource: 'auto',
        incomingTarget: 'es',
        outgoingSource: 'auto',
        outgoingTarget: 'en',
        libreEndpoint: 'https://libretranslate.com/translate',
        libreApiKey: '',
        myMemoryEmail: '',
        maxCharacters: 500,
        messageSelector: '',
        composerSelector: '',
        sendSelector: ''
    });

    const CHAT_ROOT_SELECTORS = [
        '.chat-box', '.chat-window', '.chat-panel', '.chat-container', '.chat-wrapper',
        '[data-chat]', '[data-testid*="chat" i]', '[id*="chat" i]', '[class*="chat-messages" i]',
        '[class*="chat-window" i]', '[class*="chat-panel" i]'
    ];
    const MESSAGE_SELECTORS = [
        '.chat-msg', '.msg-bubble', '.chat-message', '.message-item', '.message-row', '.chat-line', '.chat-row',
        '[data-message-id]', '[data-chat-message]', '[class*="chat-message" i]',
        '[class*="message-item" i]', '[class*="message-row" i]', '[class*="message-bubble" i]',
        '[class*="private-msg" i]', '[class*="friend-msg" i]', '[class*="vip-msg" i]'
    ];
    const TEXT_SELECTORS = [
        '.chat-body', '[data-message-text]', '.message-text', '.msg-text', '.chat-text', '.message-content',
        '.chat-content', '[class*="message-text" i]', '[class*="chat-text" i]'
    ];
    const COMPOSER_SELECTORS = [
        '.chat-input input', '.chat-input textarea', '.msg-input input', '.msg-input textarea',
        'textarea', '[contenteditable="true"]', 'input[type="text"]', 'input:not([type])'
    ];
    const PROTECTED_MESSAGE_CONTENT = [
        'a', 'img', 'svg', 'video', 'audio', 'button', '.chat-link', '.chat-emoji-img',
        '.chat-emoji-item', '[data-item-id]', '[data-pokemon-id]', '[data-poke-id]',
        '[contenteditable="false"]', '[role="img"]', '.chat-from', '.chat-time', '.chat-del',
        '.piw-ct-translation'
    ].join(',');

    let settings = loadSettings();
    let observer = null;
    let discoveryTimer = 0;
    let discoveryInterval = 0;
    let initialChatStateHandled = false;
    let settingsPanel = null;
    let launcherButton = null;
    let lastRootCount = 0;
    const processed = new WeakMap();
    const cache = new Map();
    const pendingTranslations = new Map();
    const knownChatRoots = new Set();
    const translationSources = new WeakMap();
    const queue = [];
    let activeRequests = 0;
    let lastRequestAt = 0;

    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
        } catch {}
        try {
            const raw = localStorage.getItem(`${SCRIPT_ID}:${key}`);
            return raw == null ? fallback : JSON.parse(raw);
        } catch { return fallback; }
    }

    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') return GM_setValue(key, value);
        } catch {}
        try { localStorage.setItem(`${SCRIPT_ID}:${key}`, JSON.stringify(value)); } catch {}
        return undefined;
    }

    function loadSettings() {
        const stored = gmGet(STORAGE_KEY, {});
        return sanitizeSettings(stored && typeof stored === 'object' ? stored : {});
    }

    function sanitizeSettings(value) {
        const result = { ...DEFAULTS, ...value };
        result.enabled = Boolean(result.enabled);
        result.showOriginal = Boolean(result.showOriginal);
        result.provider = result.provider === 'libretranslate' ? 'libretranslate' : 'mymemory';
        result.maxCharacters = Math.max(50, Math.min(2000, Number(result.maxCharacters) || 500));
        for (const key of ['incomingSource', 'incomingTarget', 'outgoingSource', 'outgoingTarget']) {
            result[key] = String(result[key] || DEFAULTS[key]).trim();
        }
        for (const key of ['libreEndpoint', 'libreApiKey', 'myMemoryEmail', 'messageSelector', 'composerSelector', 'sendSelector']) {
            result[key] = String(result[key] || '').trim().slice(0, key === 'libreApiKey' ? 500 : 1000);
        }
        return result;
    }

    function saveSettings(next) {
        settings = sanitizeSettings(next);
        gmSet(STORAGE_KEY, settings);
        cache.clear();
        document.querySelectorAll('.piw-ct-translation').forEach(node => {
            node.hidden = !settings.enabled;
            const source = translationSources.get(node);
            source?.classList.toggle('piw-ct-original-hidden', settings.enabled && !settings.showOriginal && node.dataset.canHideOriginal === 'true');
        });
        document.querySelectorAll('.piw-ct-message-action').forEach(node => { node.hidden = !settings.enabled; });
        document.querySelectorAll('.piw-ct-toolbar').forEach(node => node.remove());
        document.querySelectorAll('[data-piw-ct-composer="true"]').forEach(node => delete node.dataset.piwCtComposer);
        scheduleDiscovery(0);
    }

    function addStyles(css) {
        if (typeof GM_addStyle === 'function') return GM_addStyle(css);
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    addStyles(`
        :root {
            --piw-ct-bg: #0d1826;
            --piw-ct-panel: #132338;
            --piw-ct-panel-2: #192d45;
            --piw-ct-line: #2f4963;
            --piw-ct-cyan: #36d6ff;
            --piw-ct-gold: #ffd15a;
            --piw-ct-green: #62e78b;
            --piw-ct-text: #edf6ff;
            --piw-ct-muted: #91a8be;
        }
        .piw-ct-chat-enhanced {
            width: clamp(420px, 34vw, 560px) !important;
            height: clamp(330px, 46vh, 460px) !important;
            min-width: 380px !important;
            min-height: 300px !important;
            max-width: min(92vw, 600px) !important;
            max-height: min(68vh, 500px) !important;
            display: flex;
            flex-direction: column !important;
            overflow: hidden !important;
            resize: both;
            border: 1px solid #3c5a73 !important;
            border-radius: 9px !important;
            background: #09141f !important;
            box-shadow: 0 14px 38px #000c, inset 0 1px #ffffff10 !important;
            color: var(--piw-ct-text);
            font-family: Inter, Segoe UI, system-ui, sans-serif !important;
            box-sizing: border-box !important;
        }
        .piw-ct-chat-enhanced[hidden],
        .piw-ct-chat-enhanced[aria-hidden="true"],
        .piw-ct-chat-enhanced.minimized,
        .piw-ct-chat-enhanced.is-minimized { display: none !important; }
        .piw-ct-chat-enhanced *, .piw-ct-chat-enhanced *::before, .piw-ct-chat-enhanced *::after {
            box-sizing: border-box;
        }
        .piw-ct-chat-enhanced .chat-head {
            flex: 0 0 auto !important;
            min-height: 40px !important;
            padding: 6px 8px !important;
            border-bottom: 1px solid #314b62 !important;
            background: #122235 !important;
        }
        .piw-ct-chat-enhanced .piw-ct-message-list,
        .piw-ct-chat-enhanced .chat-list {
            flex: 1 1 auto !important;
            min-height: 150px !important;
            overflow-x: hidden !important;
            overflow-y: auto !important;
            gap: 1px !important;
            padding: 7px 8px !important;
            scrollbar-width: thin;
            scrollbar-color: #526d85 #0a1520;
            font-size: 12.5px !important;
            line-height: 1.42 !important;
        }
        .piw-ct-chat-enhanced .piw-ct-message-list::-webkit-scrollbar { width: 7px; }
        .piw-ct-chat-enhanced .piw-ct-message-list::-webkit-scrollbar-track { background: #0a1520; }
        .piw-ct-chat-enhanced .piw-ct-message-list::-webkit-scrollbar-thumb { background: #526d85; border-radius: 8px; }
        .piw-ct-chat-enhanced .chat-msg {
            position: relative !important;
            margin: 0 !important;
            padding: 3px 29px 3px 5px !important;
            border: 1px solid transparent !important;
            border-radius: 4px !important;
            font-size: 12.5px !important;
            line-height: 1.38 !important;
        }
        .piw-ct-chat-enhanced .chat-msg:hover { border-color: #263d51 !important; background: #112131 !important; }
        .piw-ct-chat-enhanced .chat-time { color: #7f93a6 !important; font-size: 10.5px !important; }
        .piw-ct-chat-enhanced .chat-from { margin-inline: 3px !important; }
        .piw-ct-chat-enhanced .chat-body { color: #e5edf5 !important; font-weight: 600 !important; }
        .piw-ct-user-button {
            display: inline-block; padding: 1px 4px; border: 1px solid transparent; border-radius: 4px;
            cursor: pointer; text-underline-offset: 2px; transition: background .12s, border-color .12s, color .12s;
        }
        .piw-ct-user-button:hover, .piw-ct-user-button:focus-visible {
            border-color: #3d708b; outline: none; background: #153047; color: #bcefff !important;
            text-decoration: underline;
        }
        .piw-ct-user-button[data-state="busy"] { cursor: wait; opacity: .65; }
        .piw-ct-private-enhanced .msg-bubble {
            position: relative !important;
            padding-right: 38px !important;
        }
        .piw-ct-private-enhanced .piw-ct-private-message {
            position: relative !important;
            min-height: 28px;
            padding-right: 38px !important;
        }
        .piw-ct-private-enhanced .piw-ct-private-message:hover .piw-ct-message-action,
        .piw-ct-private-enhanced .msg-bubble:hover .piw-ct-message-action { opacity: 1; }
        .piw-ct-private-enhanced .msg-thread { scrollbar-width: thin; scrollbar-color: #526d85 #0a1520; }
        .piw-ct-private-enhanced .piw-ct-composer-shell {
            display: grid !important;
            grid-template-columns: minmax(0, 1fr) auto !important;
            gap: 6px !important;
            padding: 7px !important;
        }
        .piw-ct-private-enhanced .piw-ct-toolbar { grid-column: 1 / -1; grid-row: 1; }
        .piw-ct-private-enhanced .piw-ct-composer-input {
            grid-column: 1; grid-row: 2; min-width: 0; width: 100%; min-height: 36px;
        }
        .piw-ct-private-enhanced .piw-ct-native-send {
            grid-column: 2; grid-row: 2; min-width: 76px; min-height: 36px;
        }
        .piw-ct-message-action {
            position: absolute; top: 2px; right: 3px; z-index: 2;
            width: 23px; height: 23px; margin: 0; padding: 0;
            display: grid; place-items: center; border: 1px solid #34536d; border-radius: 5px;
            background: #132a3d; color: #9deaff; cursor: pointer;
            opacity: .48; font: 600 11px/1 system-ui; transition: opacity .12s, border-color .12s, background .12s;
        }
        .chat-msg:hover .piw-ct-message-action,
        .piw-ct-message-action:focus-visible,
        .piw-ct-message-action[data-state="done"] { opacity: 1; }
        .piw-ct-message-action:hover { border-color: var(--piw-ct-gold); background: #263a48; }
        .piw-ct-message-action[data-state="busy"] { cursor: wait; animation: piw-ct-pulse 1s infinite alternate; }
        .piw-ct-message-action[data-state="error"] { border-color: #ff6874; color: #ffabb2; opacity: 1; }
        .piw-ct-chat-enhanced .piw-ct-tabs {
            flex: 0 0 auto !important;
            display: flex !important;
            gap: 5px !important;
            padding: 7px 8px !important;
            border-bottom: 1px solid #304b64 !important;
            background: #132338 !important;
        }
        .piw-ct-chat-enhanced .piw-ct-tabs button {
            min-width: 66px !important;
            min-height: 28px !important;
            padding: 4px 10px !important;
            border: 1px solid #35516a !important;
            border-radius: 6px !important;
            background: #172a3d !important;
            color: #aebfd0 !important;
            font: 700 12px/1 system-ui !important;
        }
        .piw-ct-chat-enhanced .piw-ct-tabs button:hover,
        .piw-ct-chat-enhanced .piw-ct-tabs button.active,
        .piw-ct-chat-enhanced .piw-ct-tabs button.on,
        .piw-ct-chat-enhanced .piw-ct-tabs button[aria-selected="true"] {
            border-color: #e2b742 !important;
            background: #4a3b18 !important;
            color: #fff1bd !important;
        }
        .piw-ct-chat-enhanced .piw-ct-composer-shell {
            flex: 0 0 auto !important;
            display: grid !important;
            grid-template-columns: minmax(0, 1fr) auto auto !important;
            gap: 6px !important;
            padding: 7px !important;
            border-top: 1px solid #2e4b64 !important;
            background: #0e1b29 !important;
            position: relative !important;
        }
        .piw-ct-chat-enhanced .piw-ct-composer-input {
            grid-column: 1 !important;
            grid-row: 2 !important;
            width: 100% !important;
            min-width: 0 !important;
            min-height: 36px !important;
            max-height: 82px !important;
            padding: 7px 9px !important;
            border: 1px solid #3a5871 !important;
            border-radius: 7px !important;
            outline: none !important;
            resize: vertical !important;
            background: #08131f !important;
            color: #f2f8ff !important;
            font: 500 13px/1.4 system-ui !important;
        }
        .piw-ct-chat-enhanced .piw-ct-composer-input:focus { border-color: var(--piw-ct-cyan) !important; }
        .piw-ct-chat-enhanced .piw-ct-native-send {
            grid-column: 3 !important;
            grid-row: 2 !important;
            min-width: 70px !important;
            min-height: 36px !important;
            padding: 7px 11px !important;
            border: 1px solid #b18a27 !important;
            border-radius: 7px !important;
            background: linear-gradient(180deg, #f7ce62, #d9a93c) !important;
            color: #17202b !important;
            font: 800 12px/1 system-ui !important;
            cursor: pointer !important;
        }
        .piw-ct-chat-enhanced .chat-emoji-btn {
            grid-column: 2 !important;
            grid-row: 2 !important;
            width: 36px !important;
            height: 36px !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 1px solid #35526c !important;
            border-radius: 7px !important;
            background: #172b3f !important;
        }
        .piw-ct-chat-enhanced .chat-emoji-panel {
            position: absolute !important;
            z-index: 25 !important;
            left: 7px !important;
            right: auto !important;
            bottom: calc(100% + 7px) !important;
            width: min(310px, calc(100% - 14px)) !important;
            max-width: 310px !important;
            max-height: 154px !important;
            margin: 0 !important;
            padding: 7px !important;
            grid-template-columns: repeat(8, minmax(25px, 1fr)) !important;
            gap: 3px !important;
            overflow-x: hidden !important;
            overflow-y: auto !important;
            border: 1px solid #44627c !important;
            border-radius: 8px !important;
            background: #0b1825f5 !important;
            box-shadow: 0 12px 30px #000c, inset 0 1px #ffffff14 !important;
            backdrop-filter: blur(5px);
        }
        .piw-ct-chat-enhanced > .chat-emoji-panel { bottom: 76px !important; }
        .piw-ct-chat-enhanced .chat-emoji-item { min-width: 27px !important; min-height: 27px !important; }
        #piw-ct-launcher, .piw-ct-settings-button {
            position: static; flex: 0 0 auto; width: 30px; height: 30px; padding: 0;
            display: grid; place-items: center; border: 1px solid #3bbfe0; border-radius: 7px;
            color: #eafdff; background: #172e43; cursor: pointer;
            box-shadow: inset 0 1px #ffffff1f; font: 700 15px/1 system-ui;
        }
        #piw-ct-launcher:hover, .piw-ct-settings-button:hover { border-color: var(--piw-ct-gold); background: #233d55; }
        #piw-ct-launcher[data-state="busy"], .piw-ct-settings-button[data-state="busy"] { animation: piw-ct-pulse 1s infinite alternate; }
        #piw-ct-launcher[data-state="error"], .piw-ct-settings-button[data-state="error"] { border-color: #ff6370; color: #ff8892; }
        @keyframes piw-ct-pulse { to { box-shadow: 0 0 18px #36d6ff99; } }

        .piw-ct-translation {
            display: flex; gap: 5px; align-items: flex-start; margin: 3px 0 0; padding: 3px 6px;
            border-left: 2px solid var(--piw-ct-cyan); border-radius: 2px;
            background: #0d2433; color: #bcefff; font: 600 11px/1.35 system-ui;
            white-space: pre-wrap; overflow-wrap: anywhere;
        }
        .piw-ct-translation::before { content: '🌐'; flex: 0 0 auto; font-size: 10px; }
        .piw-ct-translation[data-error="true"] { border-color: #ff6874; color: #ffabb2; }
        .piw-ct-original-hidden { display: none !important; }

        .piw-ct-toolbar {
            grid-column: 1 / -1; grid-row: 1;
            display: flex; align-items: center; gap: 5px; min-width: 0; padding: 5px 6px;
            margin: 0; border: 1px solid #29465f; border-radius: 7px;
            background: #102238; color: var(--piw-ct-text); font: 600 10.5px/1.2 system-ui;
        }
        .piw-ct-toolbar-top { display: flex; align-items: center; gap: 4px; min-width: 64px; }
        .piw-ct-toolbar-title { color: var(--piw-ct-cyan); font-weight: 800; white-space: nowrap; }
        .piw-ct-toolbar-route { color: var(--piw-ct-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .piw-ct-toolbar-actions { display: flex; gap: 5px; }
        .piw-ct-toolbar-actions button {
            width: auto; white-space: nowrap;
        }
        .piw-ct-toolbar button {
            min-height: 28px; padding: 4px 8px; border: 1px solid #355470; border-radius: 6px;
            background: #172b40; color: #eaf5ff; cursor: pointer; font: inherit;
        }
        .piw-ct-toolbar button:hover { border-color: var(--piw-ct-cyan); background: #203a54; }
        .piw-ct-toolbar button[data-action="send"] { border-color: #9d7c26; color: #ffe18a; }
        .piw-ct-toolbar button:disabled { opacity: .55; cursor: wait; }
        .piw-ct-toolbar-status { flex: 1 1 auto; min-width: 24px; overflow: hidden; color: var(--piw-ct-muted); text-align: right; text-overflow: ellipsis; white-space: nowrap; }

        #piw-ct-overlay {
            position: fixed; inset: 0; z-index: 2147482000; display: grid; place-items: center;
            padding: 16px; background: #020812b8; backdrop-filter: blur(3px);
        }
        #piw-ct-settings {
            width: min(720px, calc(100vw - 24px)); max-height: min(760px, calc(100vh - 24px));
            overflow: auto; color: var(--piw-ct-text); background: var(--piw-ct-bg);
            border: 1px solid #395772; border-radius: 14px; box-shadow: 0 26px 80px #000d;
            font: 500 13px/1.4 system-ui, sans-serif;
        }
        .piw-ct-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px;
            padding: 15px 17px; border-bottom: 1px solid var(--piw-ct-line); background: #102033f5; }
        .piw-ct-head h2 { margin: 0; font-size: 18px; letter-spacing: .03em; }
        .piw-ct-head small { display: block; color: var(--piw-ct-muted); font-weight: 500; }
        .piw-ct-head button { margin-left: auto; width: 34px; height: 34px; border: 1px solid #405a72;
            border-radius: 7px; background: #1b2b3c; color: white; cursor: pointer; font-size: 19px; }
        .piw-ct-body { padding: 14px 17px 18px; }
        .piw-ct-section { margin-bottom: 12px; padding: 12px; border: 1px solid #274159;
            border-radius: 9px; background: var(--piw-ct-panel); }
        .piw-ct-section h3 { margin: 0 0 10px; color: var(--piw-ct-cyan); font-size: 12px;
            text-transform: uppercase; letter-spacing: .11em; }
        .piw-ct-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
        .piw-ct-field { display: grid; gap: 4px; min-width: 0; color: #b8cadd; font-size: 11px; }
        .piw-ct-field.wide { grid-column: 1 / -1; }
        .piw-ct-field input, .piw-ct-field select {
            width: 100%; min-width: 0; height: 34px; box-sizing: border-box; padding: 6px 8px;
            border: 1px solid #35516c; border-radius: 6px; outline: none;
            background: #091522; color: #f0f7ff; font: 500 12px system-ui;
        }
        .piw-ct-field input:focus, .piw-ct-field select:focus { border-color: var(--piw-ct-cyan); }
        .piw-ct-check { display: flex; align-items: center; gap: 8px; min-height: 32px; }
        .piw-ct-check input { accent-color: var(--piw-ct-gold); }
        .piw-ct-note { margin: 8px 0 0; color: var(--piw-ct-muted); font-size: 11px; }
        .piw-ct-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
        .piw-ct-actions button { min-height: 36px; padding: 7px 13px; border: 1px solid #3b5872;
            border-radius: 7px; background: #1b3045; color: white; cursor: pointer; font-weight: 700; }
        .piw-ct-actions button.primary { border-color: #b99029; background: var(--piw-ct-gold); color: #17202a; }
        .piw-ct-api-status { flex: 1 1 220px; align-self: center; color: var(--piw-ct-muted); }
        .piw-ct-api-status.ok { color: var(--piw-ct-green); }
        .piw-ct-api-status.error { color: #ff8792; }
        @media (max-width: 600px) {
            .piw-ct-chat-enhanced {
                width: min(94vw, 480px) !important;
                height: min(58dvh, 440px) !important;
                min-width: min(330px, 94vw) !important;
                min-height: 330px !important;
                max-width: 98vw !important;
                max-height: 64dvh !important;
                resize: none;
            }
            .piw-ct-chat-enhanced .piw-ct-message-list { min-height: 140px !important; font-size: 12px !important; }
            .piw-ct-message-action { opacity: .82; }
            .piw-ct-chat-enhanced .piw-ct-composer-shell { grid-template-columns: minmax(0, 1fr) 34px 66px !important; }
            .piw-ct-chat-enhanced .piw-ct-native-send { min-width: 66px !important; padding-inline: 7px !important; }
            .piw-ct-chat-enhanced .chat-emoji-panel {
                left: 4px !important;
                width: min(286px, calc(100% - 8px)) !important;
                max-height: 142px !important;
                grid-template-columns: repeat(7, minmax(25px, 1fr)) !important;
            }
            .piw-ct-chat-enhanced .piw-ct-tabs { overflow-x: auto !important; }
            .piw-ct-chat-enhanced .piw-ct-tabs button { min-width: 66px !important; }
            #piw-ct-overlay { padding: 6px; align-items: end; }
            #piw-ct-settings { width: 100%; max-height: 92vh; border-radius: 12px 12px 0 0; }
            .piw-ct-grid { grid-template-columns: 1fr; }
            .piw-ct-field.wide { grid-column: auto; }
            .piw-ct-toolbar { flex-wrap: wrap; padding: 5px; }
            .piw-ct-toolbar-status { order: 4; flex-basis: calc(100% - 38px); text-align: left; }
        }
    `);

    function languageOptions(selected, allowAuto = true) {
        return LANGUAGES
            .filter(([code]) => allowAuto || code !== 'auto')
            .map(([code, label]) => `<option value="${escapeAttr(code)}"${code === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`)
            .join('');
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }

    function escapeAttr(value) { return escapeHtml(value); }

    function mountLauncherButton(container) {
        if (!container) return null;
        let button = container.querySelector(':scope > #piw-ct-launcher, :scope > .piw-ct-settings-button');
        if (!button) {
            button = document.createElement('button');
            if (!document.getElementById('piw-ct-launcher')) button.id = 'piw-ct-launcher';
            else button.className = 'piw-ct-settings-button';
            button.type = 'button';
            button.title = 'Configurar traductor';
            button.setAttribute('aria-label', 'Abrir configuración del traductor del chat');
            button.textContent = '⚙';
            button.addEventListener('click', openSettings);
            container.appendChild(button);
        }
        launcherButton = button;
        return button;
    }

    function openSettings() {
        settingsPanel?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'piw-ct-overlay';
        overlay.innerHTML = `
            <section id="piw-ct-settings" role="dialog" aria-modal="true" aria-label="Traductor del chat">
                <header class="piw-ct-head">
                    <div><h2>🌐 Traductor del chat</h2><small>Entrantes y salientes · v${VERSION}</small></div>
                    <button type="button" data-close aria-label="Cerrar">×</button>
                </header>
                <form class="piw-ct-body">
                    <section class="piw-ct-section">
                        <h3>Mensajes entrantes</h3>
                        <div class="piw-ct-grid">
                            <label class="piw-ct-check"><input name="enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}> Habilitar traducción manual</label>
                            <label class="piw-ct-check"><input name="showOriginal" type="checkbox" ${settings.showOriginal ? 'checked' : ''}> Conservar texto original</label>
                            <label class="piw-ct-field">Idioma original
                                <select name="incomingSource">${languageOptions(settings.incomingSource, true)}</select>
                            </label>
                            <label class="piw-ct-field">Traducir al idioma
                                <select name="incomingTarget">${languageOptions(settings.incomingTarget, false)}</select>
                            </label>
                        </div>
                    </section>
                    <section class="piw-ct-section">
                        <h3>Mensajes que escribes</h3>
                        <div class="piw-ct-grid">
                            <label class="piw-ct-field">Idioma en el que escribes
                                <select name="outgoingSource">${languageOptions(settings.outgoingSource, true)}</select>
                            </label>
                            <label class="piw-ct-field">Idioma de envío
                                <select name="outgoingTarget">${languageOptions(settings.outgoingTarget, false)}</select>
                            </label>
                        </div>
                        <p class="piw-ct-note">En mensajes recibidos, pulsa su pequeño botón 🌐 para traducir solamente el que elijas. No se realizan llamadas automáticas.</p>
                    </section>
                    <section class="piw-ct-section">
                        <h3>API de traducción</h3>
                        <div class="piw-ct-grid">
                            <label class="piw-ct-field">Proveedor
                                <select name="provider">
                                    <option value="mymemory" ${settings.provider === 'mymemory' ? 'selected' : ''}>MyMemory (sin clave)</option>
                                    <option value="libretranslate" ${settings.provider === 'libretranslate' ? 'selected' : ''}>LibreTranslate compatible</option>
                                </select>
                            </label>
                            <label class="piw-ct-field">Máximo de caracteres por mensaje
                                <input name="maxCharacters" type="number" min="50" max="2000" value="${settings.maxCharacters}">
                            </label>
                            <label class="piw-ct-field wide" data-libre>Endpoint HTTPS de LibreTranslate
                                <input name="libreEndpoint" type="url" value="${escapeAttr(settings.libreEndpoint)}" placeholder="https://servidor/translate">
                            </label>
                            <label class="piw-ct-field wide" data-libre>Clave API (si el servidor la exige)
                                <input name="libreApiKey" type="password" value="${escapeAttr(settings.libreApiKey)}" autocomplete="off">
                            </label>
                            <label class="piw-ct-field wide" data-memory>Correo opcional para ampliar la cuota identificada de MyMemory
                                <input name="myMemoryEmail" type="email" value="${escapeAttr(settings.myMemoryEmail)}" placeholder="usuario@correo.com">
                            </label>
                        </div>
                    </section>
                    <section class="piw-ct-section">
                        <h3>Detección avanzada (opcional)</h3>
                        <div class="piw-ct-grid">
                            <label class="piw-ct-field wide">Selector CSS de cada mensaje
                                <input name="messageSelector" value="${escapeAttr(settings.messageSelector)}" placeholder="Vacío = detección automática">
                            </label>
                            <label class="piw-ct-field">Selector CSS del campo de escritura
                                <input name="composerSelector" value="${escapeAttr(settings.composerSelector)}" placeholder="Vacío = automático">
                            </label>
                            <label class="piw-ct-field">Selector CSS del botón enviar
                                <input name="sendSelector" value="${escapeAttr(settings.sendSelector)}" placeholder="Vacío = automático">
                            </label>
                        </div>
                        <p class="piw-ct-note">Úsalo solamente si una futura actualización del juego cambia la estructura del chat.</p>
                    </section>
                    <div class="piw-ct-actions">
                        <span class="piw-ct-api-status">${lastRootCount ? `${lastRootCount} área(s) de chat detectada(s)` : 'Esperando que se abra el chat…'}</span>
                        <button type="button" data-test>Probar API</button>
                        <button type="button" data-rescan>Detectar chat</button>
                        <button type="submit" class="primary">Guardar</button>
                    </div>
                </form>
            </section>`;
        document.documentElement.appendChild(overlay);
        settingsPanel = overlay;
        const form = overlay.querySelector('form');
        const provider = form.elements.provider;
        const refreshProviderFields = () => {
            overlay.querySelectorAll('[data-libre]').forEach(node => { node.hidden = provider.value !== 'libretranslate'; });
            overlay.querySelectorAll('[data-memory]').forEach(node => { node.hidden = provider.value !== 'mymemory'; });
        };
        refreshProviderFields();
        provider.addEventListener('change', refreshProviderFields);
        overlay.querySelector('[data-close]').addEventListener('click', () => closeSettings());
        overlay.addEventListener('mousedown', event => { if (event.target === overlay) closeSettings(); });
        overlay.querySelector('[data-rescan]').addEventListener('click', () => {
            saveFromForm(form);
            const roots = discover(true);
            setPanelStatus(`${roots} área(s) de chat detectada(s)`, roots > 0 ? 'ok' : 'error');
        });
        overlay.querySelector('[data-test]').addEventListener('click', async event => {
            saveFromForm(form);
            const button = event.currentTarget;
            button.disabled = true;
            setPanelStatus('Probando conexión…');
            try {
                const result = await translateText('Hello world', 'en', settings.incomingTarget);
                setPanelStatus(`API operativa: ${result.text}`, 'ok');
            } catch (error) {
                setPanelStatus(`Error: ${friendlyError(error)}`, 'error');
            } finally { button.disabled = false; }
        });
        form.addEventListener('submit', event => {
            event.preventDefault();
            saveFromForm(form);
            closeSettings();
            notify('Configuración guardada.', 'ok');
        });
    }

    function closeSettings() {
        settingsPanel?.remove();
        settingsPanel = null;
    }

    function saveFromForm(form) {
        const data = new FormData(form);
        saveSettings({
            enabled: Boolean(form.elements.enabled.checked),
            showOriginal: Boolean(form.elements.showOriginal.checked),
            provider: data.get('provider'),
            incomingSource: data.get('incomingSource'), incomingTarget: data.get('incomingTarget'),
            outgoingSource: data.get('outgoingSource'), outgoingTarget: data.get('outgoingTarget'),
            libreEndpoint: data.get('libreEndpoint'), libreApiKey: data.get('libreApiKey'),
            myMemoryEmail: data.get('myMemoryEmail'), maxCharacters: data.get('maxCharacters'),
            messageSelector: data.get('messageSelector'), composerSelector: data.get('composerSelector'),
            sendSelector: data.get('sendSelector')
        });
    }

    function setPanelStatus(text, state = '') {
        const node = settingsPanel?.querySelector('.piw-ct-api-status');
        if (!node) return;
        node.textContent = text;
        node.className = `piw-ct-api-status ${state}`.trim();
    }

    function notify(message, state = '') {
        document.querySelectorAll('.piw-ct-toolbar-status').forEach(node => { node.textContent = message; });
        const settingButtons = document.querySelectorAll('#piw-ct-launcher, .piw-ct-settings-button');
        settingButtons.forEach(button => {
            button.dataset.state = state;
            button.title = `Traductor: ${message}`;
        });
        if (!settingButtons.length) return;
        clearTimeout(notify.timer);
        notify.timer = setTimeout(() => {
            document.querySelectorAll('#piw-ct-launcher, .piw-ct-settings-button').forEach(button => {
                button.dataset.state = '';
                button.title = 'Configurar traductor';
            });
        }, 3500);
    }

    function safeQuery(root, selector) {
        if (!selector) return null;
        try { return root.querySelector(selector); } catch { return null; }
    }

    function safeQueryAll(root, selector) {
        if (!selector) return [];
        try { return [...root.querySelectorAll(selector)]; } catch { return []; }
    }

    function safeMatches(node, selector) {
        if (!selector || !node?.matches) return false;
        try { return node.matches(selector); } catch { return false; }
    }

    function isElementVisible(node) {
        if (!(node instanceof HTMLElement) || !node.isConnected || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && node.getClientRects().length > 0;
    }

    function isChatOpen(root) {
        return isElementVisible(root) && !root.classList.contains('minimized') && !root.classList.contains('is-minimized');
    }

    function ensureInitialChatMinimized() {
        if (initialChatStateHandled) return false;
        const visibleFab = [...document.querySelectorAll('.chat-fab')].find(isElementVisible);
        const openChat = [...document.querySelectorAll('.chat-box')].find(isChatOpen);
        if (!openChat && visibleFab) {
            initialChatStateHandled = true;
            return false;
        }
        if (!openChat) return false;
        const minimize = safeQuery(openChat, '.chat-min, [data-action="minimize"], [aria-label*="minimiz" i], [title*="minimiz" i]');
        if (!minimize) return false;
        initialChatStateHandled = true;
        minimize.click();
        return true;
    }

    function isOurUi(node) { return node?.closest?.('#piw-ct-overlay, #piw-ct-launcher, .piw-ct-settings-button, .piw-ct-toolbar, .piw-ct-translation, .piw-ct-message-action'); }

    function normalizeUsername(value) {
        const cleaned = String(value || '')
            .replace(/\b(?:lv|level|nivel)\s*\d+\b/gi, ' ')
            .replace(/\[\s*\d+\s*\]/g, ' ')
            .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, ' ')
            .replace(/[:：]+\s*$/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,31}/u)?.[0] || '';
    }

    function decoratePublicUserButtons(root) {
        safeQueryAll(root, '.chat-from').forEach(node => {
            const username = normalizeUsername(node.textContent);
            if (!username) return;
            node.classList.add('piw-ct-user-button');
            node.setAttribute('role', 'button');
            node.tabIndex = 0;
            node.dataset.piwCtUsername = username;
            node.title = `Mensaje privado a ${username}`;
            if (node.dataset.piwCtUserBound === 'true') return;
            node.dataset.piwCtUserBound = 'true';
            const activate = event => {
                if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
                if (event.type === 'keydown') event.preventDefault();
                // El juego también escucha el clic del nombre y puede abrir directamente
                // VIP / Friends. No se detiene la propagación: primero dejamos actuar al
                // controlador nativo y luego completamos la selección o el alta.
                setTimeout(() => openPrivateConversation(node.dataset.piwCtUsername, node), 0);
            };
            node.addEventListener('click', activate);
            node.addEventListener('keydown', activate);
        });
    }

    function privateButtonDescriptor(node) {
        if (!(node instanceof Element)) return '';
        const attrs = [
            'id', 'class', 'name', 'value', 'title', 'aria-label', 'data-title', 'data-tooltip',
            'data-guide', 'data-testid', 'data-action', 'data-target', 'href'
        ];
        const own = attrs.map(name => node.getAttribute(name) || '').join(' ');
        const media = [...node.querySelectorAll('img, svg, use')].map(icon => [
            icon.getAttribute('alt'), icon.getAttribute('title'), icon.getAttribute('src'),
            icon.getAttribute('href'), icon.getAttribute('aria-label')
        ].filter(Boolean).join(' ')).join(' ');
        return `${own} ${media} ${node.textContent || ''}`.replace(/\s+/g, ' ').trim();
    }

    function findPrivateDockButton() {
        const dock = document.querySelector('.game-dock');
        const selectors = [
            '.script-private-chat-button', '#dock-btn-chat', '#dock-btn-messages', '#dock-btn-private-chat', '#dock-btn-pm',
            '[data-action*="message" i]', '[data-action*="private" i]', '[data-target*="message" i]',
            '[title*="message" i]', '[aria-label*="message" i]', '[title*="mens" i]', '[aria-label*="mens" i]'
        ];
        for (const selector of selectors) {
            const match = dock?.querySelector(selector);
            if (match) return match.closest('button, a, [role="button"]') || match;
        }
        const scope = dock || document;
        return [...scope.querySelectorAll('button, a, [role="button"]')].find(node =>
            /(?:private|privad|whisper|sussurr|friend|amig|message|mensag|mensaje)/i.test(privateButtonDescriptor(node))
        ) || null;
    }

    function fieldDescriptor(node) {
        return `${node?.placeholder || ''} ${node?.name || ''} ${node?.id || ''} ${node?.getAttribute?.('aria-label') || ''}`
            .replace(/\s+/g, ' ').trim();
    }

    function isAddByNameInput(node) {
        if (!(node instanceof HTMLInputElement) || !isElementVisible(node)) return false;
        return /add\s+by\s+name|adicionar\s+(?:por|pelo)\s+nome|agregar\s+por\s+nombre|a[ñn]adir\s+(?:por\s+)?nombre/i.test(fieldDescriptor(node));
    }

    function isPrivateComposer(node) {
        if (!(node instanceof HTMLElement) || !isElementVisible(node) || node.disabled || node.readOnly) return false;
        if (!node.matches('input, textarea, [contenteditable="true"]') || isAddByNameInput(node)) return false;
        if (node.closest('.chat-input, .chat-box') && !node.closest('.msg-input, .piw-ct-private-root')) return false;
        const descriptor = fieldDescriptor(node);
        if (/search|buscar|procurar|filter|filtro|add|adicionar|agregar|friend|amig/i.test(descriptor)) return false;
        return Boolean(node.closest('.msg-input') || /message\s+to|mensagem\s+para|mensaje\s+para|write\s+(?:a\s+)?message|escreva\s+(?:uma\s+)?mensagem|escribe\s+(?:un\s+)?mensaje/i.test(descriptor));
    }

    function privatePanelScore(node, control, depth) {
        if (!(node instanceof HTMLElement) || !isElementVisible(node) || node === document.body || node === document.documentElement) return -1;
        const descriptor = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('class') || ''} ${String(node.textContent || '').slice(0, 500)}`;
        let score = Math.max(0, 8 - depth);
        if (node.getAttribute('role') === 'dialog') score += 14;
        if (/window|modal|dialog|overlay/i.test(node.className)) score += 9;
        if (/vip|friends?|amigos?|messages?|mensag|mensajes?/i.test(descriptor)) score += 8;
        if (safeQuery(node, 'header, [class*="head" i]')) score += 4;
        if (safeQuery(node, 'button, [role="button"]')) score += 2;
        if (safeQuery(node, '.msg-list, .msg-chat, .msg-thread')) score += 5;
        if (control && node.contains(control)) score += 2;
        const rect = node.getBoundingClientRect();
        if (rect.width >= 360 && rect.height >= 220) score += 5;
        if (rect.width > innerWidth * .96 && rect.height > innerHeight * .96) score -= 8;
        return score;
    }

    function findOwningPrivatePanel(control) {
        let current = control?.parentElement || null;
        let best = null;
        let bestScore = -1;
        for (let depth = 0; current && current !== document.body && depth < 12; depth += 1, current = current.parentElement) {
            const score = privatePanelScore(current, control, depth);
            if (score > bestScore) { best = current; bestScore = score; }
        }
        return best;
    }

    function findAddUserPanel() {
        const input = [...document.querySelectorAll('input')].find(isAddByNameInput);
        return input ? findOwningPrivatePanel(input) : null;
    }

    function collectPrivatePanels() {
        const candidates = new Set();
        safeQueryAll(document, '.msg-window').filter(isElementVisible).forEach(node => candidates.add(node));
        const addPanel = findAddUserPanel();
        if (addPanel) candidates.add(addPanel);
        [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].filter(isPrivateComposer).forEach(node => {
            const panel = findOwningPrivatePanel(node);
            if (panel) candidates.add(panel);
        });
        safeQueryAll(document, '[role="dialog"], [class*="message" i][class*="window" i], [class*="friend" i][class*="window" i]').forEach(node => {
            if (!isElementVisible(node)) return;
            const descriptor = String(node.textContent || '').slice(0, 500);
            if (safeQuery(node, '.msg-list, .msg-chat, .msg-thread') || /vip|friends?\s*&\s*messages?|amigos?\s+e\s+mensagens?/i.test(descriptor)) candidates.add(node);
        });
        const panels = [...candidates].filter(node => node instanceof HTMLElement && isElementVisible(node));
        return panels.filter(panel => !panels.some(other => other !== panel && other.contains(panel) && privatePanelScore(other, null, 0) >= privatePanelScore(panel, null, 0)));
    }

    function findPrivatePanel() {
        const panels = collectPrivatePanels();
        return panels.find(panel => safeQueryAll(panel, 'input').some(isAddByNameInput)) || panels[0] || null;
    }

    function findFriendsDockButton() {
        const currentMessagesButton = findPrivateDockButton();
        const explicitSelectors = [
            '#dock-btn-friends', '#dock-btn-vip', '[data-action*="friend" i]', '[data-target*="friend" i]',
            '[data-action*="vip" i]', '[data-target*="vip" i]', '[data-guide*="friend" i]', '[data-guide*="vip" i]'
        ];
        for (const selector of explicitSelectors) {
            const match = document.querySelector(selector);
            if (match && match !== currentMessagesButton && !match.closest('.piw-ct-private-root')) return match.closest('button, a, [role="button"]') || match;
        }
        let best = null;
        let bestScore = 0;
        for (const node of document.querySelectorAll('button, a, [role="button"], [tabindex]')) {
            if (node === currentMessagesButton || node.closest('.msg-window, .piw-ct-private-root, #piw-ct-overlay')) continue;
            const descriptor = privateButtonDescriptor(node);
            let score = 0;
            if (/(?:vip|friends?|amigos?)/i.test(descriptor)) score += 12;
            if (/(?:social|contacts?|contatos?)/i.test(descriptor)) score += 7;
            if (/(?:profile|perfil|trainer|treinador)/i.test(descriptor)) score += 2;
            if (node.closest('.game-dock')) score += 3;
            if (node.matches('button, a, [role="button"]')) score += 1;
            if (score > bestScore) { best = node; bestScore = score; }
        }
        return bestScore >= 7 ? best : null;
    }

    function findPanelCloseButton(panel) {
        return [...panel.querySelectorAll('button, [role="button"]')].find(button => {
            const text = String(button.textContent || '').trim();
            const descriptor = privateButtonDescriptor(button);
            const inHeader = Boolean(button.closest('header, .ds-head, [class*="head" i]'));
            return inHeader && (/^[×✕✖x]$/i.test(text) || /close|fechar|cerrar/i.test(descriptor));
        }) || null;
    }

    async function ensureAddUserPanelOpen(currentPanel) {
        const existing = findAddUserPanel();
        if (existing) return existing;
        if (currentPanel && isElementVisible(currentPanel)) {
            const close = findPanelCloseButton(currentPanel);
            close?.click();
            if (close) await waitForCondition(() => !isElementVisible(currentPanel) ? true : null, 1500);
        }
        const friendsButton = findFriendsDockButton();
        if (!friendsButton) throw new Error('No se encontró el botón de VIP / Friends & Messages.');
        friendsButton.click();
        const panel = await waitForCondition(findAddUserPanel, 4500);
        if (!panel) throw new Error('No se pudo abrir VIP / Friends & Messages.');
        return panel;
    }

    function waitForCondition(check, timeout = 4500) {
        return new Promise(resolve => {
            const immediate = check();
            if (immediate) { resolve(immediate); return; }
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearInterval(interval);
                clearTimeout(timer);
                resolve(value || null);
            };
            const interval = setInterval(() => {
                try { const value = check(); if (value) finish(value); } catch {}
            }, 60);
            const timer = setTimeout(() => finish(null), timeout);
        });
    }

    async function ensurePrivatePanelOpen() {
        const existing = findPrivatePanel();
        if (existing) return existing;
        const dockButton = findPrivateDockButton();
        if (!dockButton) throw new Error('No se encontró el botón nativo de mensajes privados.');
        dockButton.click();
        const panel = await waitForCondition(findPrivatePanel);
        if (!panel) throw new Error('No se pudo abrir el panel de mensajes privados.');
        return panel;
    }

    function candidateUsername(node) {
        const explicit = safeQuery(node, '.msg-conv-name, [data-username], [data-user-name], [class*="friend-name" i]');
        const raw = explicit?.getAttribute('data-username') || explicit?.getAttribute('data-user-name') ||
            node.getAttribute('data-username') || node.getAttribute('data-user-name') || explicit?.textContent ||
            node.firstElementChild?.textContent || node.textContent;
        return normalizeUsername(raw);
    }

    function findPrivateUserEntry(panel, username) {
        const expected = username.toLocaleLowerCase();
        const selectors = [
            '.msg-conv', '.msg-list > button', '.msg-list > [role="button"]',
            '[data-username]', '[data-user-name]', '[class*="friend" i] button',
            '[class*="friend-row" i]', '[class*="friend-item" i]', 'button', '[role="button"]', '[tabindex]'
        ];
        const candidates = new Set(selectors.flatMap(selector => safeQueryAll(panel, selector)));
        for (const candidate of candidates) {
            if (candidateUsername(candidate).toLocaleLowerCase() === expected) {
                return candidate.closest('button, [role="button"], .msg-conv') || candidate;
            }
        }
        return null;
    }

    function findAddByNameInput(panel) {
        const inputs = [...panel.querySelectorAll('input')];
        return inputs.find(isAddByNameInput) || inputs.find(input => {
            const descriptor = `${input.placeholder || ''} ${input.name || ''} ${input.getAttribute('aria-label') || ''}`;
            return /name|nome|nombre|user|usu[aá]rio/i.test(descriptor) && !/message|mensag|mensaje|search chat/i.test(descriptor);
        }) || null;
    }

    function findAddFriendButton(panel, input) {
        const candidates = new Set();
        let current = input.parentElement;
        for (let depth = 0; current && panel.contains(current) && depth < 5; depth += 1, current = current.parentElement) {
            safeQueryAll(current, 'button, [role="button"]').forEach(button => candidates.add(button));
        }
        safeQueryAll(panel, 'button, [role="button"]').forEach(button => candidates.add(button));
        let best = null;
        let bestScore = 0;
        for (const button of candidates) {
            if (!isElementVisible(button) || button.disabled || button.closest('.piw-ct-toolbar')) continue;
            const text = String(button.textContent || '').trim();
            const descriptor = privateButtonDescriptor(button);
            let score = 0;
            if (/^\+$/.test(text)) score += 20;
            if (/add\s+friend|adicionar\s+amigo|agregar\s+amigo|a[ñn]adir\s+amigo/i.test(descriptor)) score += 15;
            if (/add|adicionar|agregar|friend|amig/i.test(descriptor)) score += 6;
            if (button.parentElement === input.parentElement) score += 8;
            if (input.parentElement?.contains(button)) score += 4;
            if (score > bestScore) { best = button; bestScore = score; }
        }
        return bestScore >= 6 ? best : null;
    }

    function privateConversationIsActive(panel, username) {
        const expected = username.toLocaleLowerCase();
        const titles = safeQueryAll(panel, '.msg-chat-head, [class*="chat-head" i], header, h1, h2, h3, strong, b');
        if (titles.some(node => normalizeUsername(node.textContent).toLocaleLowerCase() === expected)) return true;
        const composer = findPrivateComposer(panel);
        return Boolean(composer && fieldDescriptor(composer).toLocaleLowerCase().includes(expected));
    }

    async function selectPrivateUser(panel, username) {
        let entry = findPrivateUserEntry(panel, username);
        if (!entry) {
            let input = findAddByNameInput(panel);
            if (!input) {
                panel = await ensureAddUserPanelOpen(panel);
                entry = findPrivateUserEntry(panel, username);
                input = findAddByNameInput(panel);
            }
            if (entry) {
                entry.click();
                scheduleDiscovery(0);
                return;
            }
            if (!input) throw new Error(`No se encontró a ${username} ni el campo para agregarlo.`);
            writeComposer(input, username);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const addButton = findAddFriendButton(panel, input);
            if (!addButton) throw new Error('El nombre quedó escrito, pero no se encontró el botón para agregarlo.');
            addButton.click();
            const result = await waitForCondition(() => findPrivateUserEntry(panel, username) || (privateConversationIsActive(panel, username) ? true : null), 6000);
            if (result instanceof Element) entry = result;
            if (!result) throw new Error(`Se escribió ${username}, pero el juego no confirmó que fue agregado.`);
        }
        entry?.click();
        await waitForCondition(() => {
            const active = findPrivateUserEntry(panel, username);
            return privateConversationIsActive(panel, username) || active?.classList.contains('on') ? true : null;
        }, 3000);
        const composer = findPrivateComposer(panel);
        composer?.focus();
        scheduleDiscovery(0);
    }

    async function openPrivateConversation(username, sourceNode) {
        if (!username || sourceNode.dataset.state === 'busy') return;
        sourceNode.dataset.state = 'busy';
        try {
            // El clic nativo del nombre puede abrir el panel VIP correcto. Se le da
            // prioridad para no desviar al usuario a la ventana antigua "Mensagens".
            let panel = await waitForCondition(findAddUserPanel, 650);
            if (!panel) {
                const openPanel = findPrivatePanel();
                panel = await ensureAddUserPanelOpen(openPanel);
            }
            await selectPrivateUser(panel, username);
            notify(`Conversación privada con ${username}.`, 'ok');
        } catch (error) {
            notify(friendlyError(error), 'error');
        } finally {
            sourceNode.dataset.state = '';
        }
    }

    function findChatRoots() {
        const candidates = new Set();
        for (const selector of CHAT_ROOT_SELECTORS) safeQueryAll(document, selector).forEach(node => candidates.add(node));
        const customMessage = settings.messageSelector;
        if (customMessage) {
            safeQueryAll(document, customMessage).forEach(node => {
                const parent = node.parentElement;
                if (parent) candidates.add(parent.closest(CHAT_ROOT_SELECTORS.join(',')) || parent);
            });
        }
        const valid = [...candidates].filter(root => {
            if (!(root instanceof HTMLElement) || isOurUi(root)) return false;
            if (/^(BUTTON|INPUT|TEXTAREA|A)$/i.test(root.tagName)) return false;
            const hasComposer = findComposer(root);
            const hasMessage = getMessageNodes(root).length > 0;
            return Boolean(hasComposer || hasMessage);
        });
        const complete = valid.filter(root => findComposer(root) && getMessageNodes(root).length > 0);
        const selected = complete.length ? complete : valid;
        return selected.filter(root => !selected.some(other => other !== root && root.contains(other)));
    }

    function findPrivateChatRoots() {
        const panels = collectPrivatePanels();
        panels.forEach(panel => panel.classList.add('piw-ct-private-root'));
        return panels;
    }

    function findPrivateComposer(root) {
        let best = null;
        let bestScore = -1;
        for (const node of safeQueryAll(root, 'input, textarea, [contenteditable="true"]')) {
            if (!(node instanceof HTMLElement) || !isElementVisible(node) || node.disabled || node.readOnly || isAddByNameInput(node)) continue;
            if (node.closest('.chat-input') && !node.closest('.msg-input')) continue;
            const descriptor = fieldDescriptor(node);
            if (/search|buscar|procurar|filter|filtro|name|nome|nombre|friend|amig/i.test(descriptor)) continue;
            let score = 0;
            if (node.closest('.msg-input')) score += 20;
            if (/message\s+to|mensagem\s+para|mensaje\s+para/i.test(descriptor)) score += 14;
            if (/message|mensag|mensaje/i.test(descriptor)) score += 5;
            if (node.matches('textarea, [contenteditable="true"]')) score += 2;
            const scope = node.closest('form') || node.parentElement;
            if (scope && [...scope.querySelectorAll('button, input[type="submit"]')].some(button => /send|enviar|mandar/i.test(privateButtonDescriptor(button)))) score += 5;
            if (score > bestScore) { best = node; bestScore = score; }
        }
        return bestScore >= 5 ? best : null;
    }

    function findPrivateMessageList(root, composer = findPrivateComposer(root)) {
        const explicit = safeQuery(root, '.msg-thread, [data-message-list], [data-messages], [role="log"], [aria-live="polite"], [class*="message-list" i], [class*="messages-list" i], [class*="conversation-stream" i], [class*="message-thread" i]');
        if (explicit && !explicit.closest('.piw-ct-toolbar')) return explicit;
        const composerShell = composer?.closest('form, .msg-input, [class*="compose" i], [class*="input" i]') || composer?.parentElement;
        for (let sibling = composerShell?.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
            if (sibling.matches('header, [class*="head" i]')) continue;
            if (sibling.querySelector('input, textarea, [contenteditable="true"]')) continue;
            if (String(sibling.textContent || '').trim() || sibling.children.length) return sibling;
        }
        const chatArea = composer?.closest('.msg-chat, main, [class*="friend-chat" i], [class*="conversation" i]');
        if (!chatArea) return null;
        let best = null;
        let bestScore = -1;
        for (const candidate of safeQueryAll(chatArea, 'div, section, ul')) {
            if (candidate === chatArea || candidate.contains(composer) || candidate.closest('.piw-ct-toolbar')) continue;
            if (candidate.querySelector('input, textarea, [contenteditable="true"], .msg-conv')) continue;
            const text = String(candidate.textContent || '').trim();
            if (!text || !candidate.children.length) continue;
            let score = Math.min(candidate.children.length, 8);
            if (/thread|stream|messages?|mensag|chat/i.test(candidate.className)) score += 7;
            if (candidate.parentElement === chatArea) score += 3;
            if (score > bestScore) { best = candidate; bestScore = score; }
        }
        return best;
    }

    function isPotentialPrivateMessage(node) {
        if (!(node instanceof HTMLElement) || isOurUi(node) || !isElementVisible(node)) return false;
        if (node.matches('header, nav, form, input, textarea, button, .msg-conv, [role="tab"]')) return false;
        if (node.querySelector('input, textarea, [contenteditable="true"], .msg-conv, .piw-ct-toolbar')) return false;
        const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || !/[\p{L}\p{N}]/u.test(text)) return false;
        if (/^(?:select (?:a )?friend|selecione (?:um )?amigo|no messages yet|nenhuma mensagem|add by name)/i.test(text)) return false;
        return true;
    }

    function getMessageNodes(root) {
        const custom = settings.messageSelector;
        if (custom) return safeQueryAll(root, custom).filter(node => !isOurUi(node));
        const found = [];
        const seen = new Set();
        for (const selector of MESSAGE_SELECTORS) {
            for (const node of safeQueryAll(root, selector)) {
                if (!seen.has(node) && !isOurUi(node)) { seen.add(node); found.push(node); }
            }
        }
        if (found.length) return found;
        const privateRoot = root.matches('.msg-window, .piw-ct-private-root, .piw-ct-private-enhanced');
        const messageList = privateRoot
            ? findPrivateMessageList(root)
            : safeQuery(root, '.chat-list, .messages, .chat-messages, [class*="message-list" i], [class*="messages-list" i], [role="log"], [aria-live="polite"]');
        const children = messageList ? [...messageList.children].filter(node => node instanceof HTMLElement) : [];
        return privateRoot ? children.filter(isPotentialPrivateMessage) : children;
    }

    function findTextNode(message) {
        for (const selector of TEXT_SELECTORS) {
            const node = safeQuery(message, selector);
            if (node && !node.matches('input, textarea, [contenteditable="true"]')) return node;
        }
        return message;
    }

    function extractMessageText(message, textNode) {
        const pieces = [];
        const walker = document.createTreeWalker(textNode, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || parent.closest(PROTECTED_MESSAGE_CONTENT)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        while (walker.nextNode()) pieces.push(walker.currentNode.nodeValue || '');
        let text = pieces.join(' ')
            .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
            .replace(/:[a-z0-9_+\-]{2,32}:/gi, ' ')
            .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (textNode === message) text = text.replace(/^\s*[^:]{1,40}:\s+/, '');
        return text;
    }

    function shouldTranslate(text) {
        if (!settings.enabled || !text || text.length > settings.maxCharacters) return false;
        if (/^(?:https?:\/\/|www\.)\S+$/i.test(text)) return false;
        if (!/[\p{L}\p{N}]/u.test(text)) return false;
        return true;
    }

    function processMessage(message) {
        if (!(message instanceof HTMLElement) || isOurUi(message)) return;
        if (!settings.enabled) return;
        if (message.closest('.msg-window, .piw-ct-private-root, .piw-ct-private-enhanced')) message.classList.add('piw-ct-private-message');
        const textNode = findTextNode(message);
        if (!(textNode instanceof HTMLElement)) return;
        const text = extractMessageText(message, textNode);
        const signature = `${settings.provider}|${settings.incomingSource}|${settings.incomingTarget}|${text}`;
        if (processed.get(message) === signature && message.querySelector(':scope > .piw-ct-message-action')) return;
        processed.set(message, signature);
        const oldTranslation = message.querySelector(':scope > .piw-ct-translation');
        const oldAction = message.querySelector(':scope > .piw-ct-message-action');
        if (!shouldTranslate(text)) {
            oldTranslation?.remove();
            oldAction?.remove();
            return;
        }
        if (oldAction?.dataset.signature && oldAction.dataset.signature !== signature) {
            oldTranslation?.remove();
            oldAction.dataset.state = '';
        }
        const action = oldAction || document.createElement('button');
        action.type = 'button';
        action.className = 'piw-ct-message-action';
        action.title = 'Traducir este mensaje';
        action.setAttribute('aria-label', 'Traducir este mensaje');
        action.textContent = '🌐';
        action.dataset.signature = signature;
        action.hidden = false;
        if (!oldAction) {
            action.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                translateSelectedMessage(message, action);
            });
            message.appendChild(action);
        }
    }

    async function translateSelectedMessage(message, action) {
        const root = message.closest('.chat-box, .msg-window, .piw-ct-private-root, .piw-ct-chat-enhanced, .piw-ct-private-enhanced');
        if (!root || !isChatOpen(root)) {
            notify('Abre el chat para traducir mensajes.', 'error');
            return;
        }
        const textNode = findTextNode(message);
        const text = textNode instanceof HTMLElement ? extractMessageText(message, textNode) : '';
        if (!shouldTranslate(text)) return;
        const signature = `${settings.provider}|${settings.incomingSource}|${settings.incomingTarget}|${text}`;
        let translation = message.querySelector(':scope > .piw-ct-translation');
        if (translation && translation.dataset.signature === signature && translation.dataset.error !== 'true') {
            translation.hidden = !translation.hidden;
            textNode.classList.toggle(
                'piw-ct-original-hidden',
                !translation.hidden && !settings.showOriginal && translation.dataset.canHideOriginal === 'true'
            );
            action.dataset.state = translation.hidden ? '' : 'done';
            action.title = translation.hidden ? 'Mostrar traducción' : 'Ocultar traducción';
            return;
        }
        if (!translation) {
            translation = document.createElement('div');
            translation.className = 'piw-ct-translation';
            message.appendChild(translation);
        }
        const hasProtectedContent = Boolean(safeQuery(textNode, PROTECTED_MESSAGE_CONTENT));
        translation.dataset.signature = signature;
        translation.dataset.canHideOriginal = String(!hasProtectedContent);
        translationSources.set(translation, textNode);
        translation.dataset.error = 'false';
        translation.hidden = false;
        translation.textContent = 'Traduciendo…';
        action.disabled = true;
        action.dataset.state = 'busy';
        try {
            const result = await translateText(text, settings.incomingSource, settings.incomingTarget);
            if (!translation.isConnected) return;
            translation.dataset.error = 'false';
            translation.textContent = decodeEntities(result.text);
            textNode.classList.toggle('piw-ct-original-hidden', !settings.showOriginal && !hasProtectedContent);
            action.dataset.state = 'done';
            action.title = 'Ocultar traducción';
        } catch (error) {
            translation.dataset.error = 'true';
            translation.textContent = `No se pudo traducir: ${friendlyError(error)}`;
            action.dataset.state = 'error';
            action.title = 'Reintentar traducción';
            notify('Error de API', 'error');
        } finally {
            action.disabled = false;
        }
    }

    function findComposer(root) {
        if (settings.composerSelector) return safeQuery(root, settings.composerSelector);
        if (root.matches('.msg-window, .piw-ct-private-root, .piw-ct-private-enhanced')) {
            const privateComposer = findPrivateComposer(root);
            if (privateComposer) return privateComposer;
        }
        for (const selector of COMPOSER_SELECTORS) {
            const nodes = safeQueryAll(root, selector);
            const match = nodes.find(node => {
                if (isOurUi(node) || node.disabled || node.readOnly) return false;
                const hint = `${node.name || ''} ${node.id || ''} ${node.placeholder || ''} ${node.getAttribute('aria-label') || ''}`;
                return !/search|buscar|filter|filtro|add by name|adicionar por nome|agregar por nombre|friend|amig/i.test(hint);
            });
            if (match) return match;
        }
        return null;
    }

    function findSendButton(root, composer) {
        if (settings.sendSelector) return safeQuery(root, settings.sendSelector);
        const scope = composer.closest('form, .chat-input, .msg-input') || composer.parentElement || root;
        return [...scope.querySelectorAll('button, input[type="submit"]')].find(candidate => {
            if (candidate.closest('.piw-ct-toolbar') || candidate.disabled) return false;
            const label = `${candidate.textContent || ''} ${candidate.value || ''} ${candidate.title || ''} ${candidate.getAttribute('aria-label') || ''}`;
            return candidate.type === 'submit' || /send|enviar|mandar|chat/i.test(label);
        }) || null;
    }

    function findMessageList(root, messages) {
        if (root.matches('.msg-window, .piw-ct-private-root, .piw-ct-private-enhanced')) {
            const privateList = findPrivateMessageList(root, findPrivateComposer(root));
            if (privateList) return privateList;
        }
        const explicit = safeQuery(root, '.msg-thread, .chat-list, .chat-messages, .messages, [class*="message-list" i], [class*="messages-list" i], [role="log"], [aria-live="polite"]');
        if (explicit && explicit !== root) return explicit;
        if (!messages.length) return null;
        let common = messages[0].parentElement;
        while (common && common !== root && !messages.every(message => common.contains(message))) common = common.parentElement;
        return common && common !== root ? common : null;
    }

    function findTabs(root, composerShell, messageList) {
        const explicit = safeQuery(root, '.chat-tabs, [role="tablist"], .tabs');
        if (explicit && !explicit.closest('.piw-ct-toolbar')) return explicit;
        return [...root.querySelectorAll('nav, div')].find(node => {
            if (node === composerShell || node === messageList || node.closest('.piw-ct-toolbar')) return false;
            const buttons = [...node.children].filter(child => child.matches?.('button, [role="tab"]'));
            if (buttons.length < 2 || buttons.length > 6) return false;
            const labels = buttons.map(button => button.textContent || button.title || '').join(' ');
            return /world|trade|help|mundo|comerc|ayuda|global/i.test(labels);
        }) || null;
    }

    function decorateChatRoot(root, composer, messages) {
        const privateMode = root.matches('.msg-window, .piw-ct-private-root') || Boolean(safeQuery(root, '.msg-thread, .msg-chat'));
        root.classList.add(privateMode ? 'piw-ct-private-enhanced' : 'piw-ct-chat-enhanced');
        const messageList = findMessageList(root, messages);
        messageList?.classList.add('piw-ct-message-list');
        const composerShell = composer.closest('form') || composer.parentElement;
        composerShell?.classList.add('piw-ct-composer-shell');
        composer.classList.add('piw-ct-composer-input');
        findSendButton(root, composer)?.classList.add('piw-ct-native-send');
        if (!privateMode) findTabs(root, composerShell, messageList)?.classList.add('piw-ct-tabs');
    }

    function mountComposerToolbar(root) {
        const composer = findComposer(root);
        if (!composer || composer.dataset.piwCtComposer === 'true') return;
        const messages = getMessageNodes(root);
        decorateChatRoot(root, composer, messages);
        composer.dataset.piwCtComposer = 'true';
        const toolbar = document.createElement('div');
        toolbar.className = 'piw-ct-toolbar';
        toolbar.innerHTML = `
            <div class="piw-ct-toolbar-top">
                <span class="piw-ct-toolbar-title">🌐</span>
                <span class="piw-ct-toolbar-route">${escapeHtml(settings.outgoingSource)} → ${escapeHtml(settings.outgoingTarget)}</span>
            </div>
            <div class="piw-ct-toolbar-actions">
                <button type="button" data-action="translate">Traducir</button>
                <button type="button" data-action="send">Traducir + enviar</button>
            </div>
            <span class="piw-ct-toolbar-status">Listo</span>
            <span data-settings-slot></span>`;
        const anchor = composer.closest('form') || composer.parentElement;
        anchor?.insertBefore(toolbar, anchor.firstChild);
        mountLauncherButton(toolbar.querySelector('[data-settings-slot]'));
        toolbar.querySelector('[data-action="translate"]').addEventListener('click', () => translateComposer(root, composer, false, toolbar));
        toolbar.querySelector('[data-action="send"]').addEventListener('click', () => translateComposer(root, composer, true, toolbar));
    }

    function readComposer(composer) {
        return composer.isContentEditable ? String(composer.textContent || '').trim() : String(composer.value || '').trim();
    }

    function writeComposer(composer, value) {
        composer.focus();
        if (composer.isContentEditable) {
            composer.textContent = value;
        } else {
            const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(composer, value);
            else composer.value = value;
        }
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function translateComposer(root, composer, sendAfter, toolbar) {
        const text = readComposer(composer);
        const buttons = [...toolbar.querySelectorAll('button')];
        const status = toolbar.querySelector('.piw-ct-toolbar-status');
        if (!text) { status.textContent = 'Escribe un mensaje primero'; return; }
        if (text.length > settings.maxCharacters) { status.textContent = `Máximo ${settings.maxCharacters} caracteres`; return; }
        buttons.forEach(button => { button.disabled = true; });
        status.textContent = 'Traduciendo…';
        try {
            const result = await translateText(text, settings.outgoingSource, settings.outgoingTarget);
            writeComposer(composer, result.text);
            status.textContent = result.detected ? `Detectado: ${result.detected}` : 'Traducido';
            if (sendAfter) {
                await new Promise(resolve => setTimeout(resolve, 0));
                const sent = sendTranslatedMessage(root, composer);
                status.textContent = sent ? 'Enviado' : 'Traducido; envíalo con Enter';
            }
        } catch (error) {
            status.textContent = friendlyError(error);
            notify('Error de API', 'error');
        } finally { buttons.forEach(button => { button.disabled = false; }); }
    }

    function sendTranslatedMessage(root, composer) {
        const button = findSendButton(root, composer);
        if (button) { button.click(); return true; }
        const form = composer.closest('form');
        if (form?.requestSubmit) { form.requestSubmit(); return true; }
        return false;
    }

    function discover(force = false) {
        if (ensureInitialChatMinimized()) return 0;
        const roots = [...new Set([...findChatRoots(), ...findPrivateChatRoots()])].filter(isChatOpen);
        knownChatRoots.forEach(root => { if (!root.isConnected || !isChatOpen(root)) knownChatRoots.delete(root); });
        roots.forEach(root => knownChatRoots.add(root));
        lastRootCount = roots.length;
        for (const root of roots) {
            if (root.matches('.chat-box, .piw-ct-chat-enhanced')) decoratePublicUserButtons(root);
            mountComposerToolbar(root);
            const messages = getMessageNodes(root);
            const recent = force ? messages : messages.slice(-100);
            recent.forEach(message => processMessage(message));
        }
        return roots.length;
    }

    function scheduleDiscovery(delay = 80) {
        clearTimeout(discoveryTimer);
        discoveryTimer = setTimeout(() => discover(false), delay);
    }

    function mutationTouchesChat(mutation) {
        if (mutation.type === 'attributes') {
            return safeMatches(mutation.target, '.chat-box, .chat-fab') || [...knownChatRoots].some(root => root === mutation.target || root.contains(mutation.target));
        }
        if (mutation.type === 'characterData' && [...knownChatRoots].some(root => root.contains(mutation.target.parentElement))) return true;
        for (const added of mutation.addedNodes) {
            if (added.nodeType === Node.TEXT_NODE) {
                if ([...knownChatRoots].some(root => root.contains(added.parentElement))) return true;
                continue;
            }
            if (added.nodeType !== Node.ELEMENT_NODE || isOurUi(added)) continue;
            if ([...knownChatRoots].some(root => root === added || root.contains(added))) return true;
            const rootSelector = `${CHAT_ROOT_SELECTORS.join(',')}, .msg-window, [role="dialog"]`;
            if (safeMatches(added, rootSelector) || safeQuery(added, rootSelector)) return true;
            if (settings.messageSelector && (safeMatches(added, settings.messageSelector) || safeQuery(added, settings.messageSelector))) return true;
        }
        return false;
    }

    function normalizeEndpoint(value) {
        let endpoint;
        try { endpoint = new URL(value); } catch { throw new Error('El endpoint de LibreTranslate no es válido.'); }
        if (endpoint.protocol !== 'https:') throw new Error('El endpoint debe usar HTTPS.');
        return endpoint.href;
    }

    function requestJson(details) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback(value);
            };
            const timer = setTimeout(() => finish(reject, new Error('La API tardó demasiado en responder.')), 20000);
            if (typeof GM_xmlhttpRequest === 'function') {
                try {
                    const request = GM_xmlhttpRequest({
                        ...details,
                        onload: response => {
                            if (response.status < 200 || response.status >= 300) {
                                finish(reject, new Error(`API HTTP ${response.status}`));
                                return;
                            }
                            try { finish(resolve, JSON.parse(response.responseText)); }
                            catch { finish(reject, new Error('La API devolvió una respuesta inválida.')); }
                        },
                        onerror: response => finish(reject, new Error(response?.error || 'No se pudo conectar con la API.')),
                        ontimeout: () => finish(reject, new Error('La API tardó demasiado en responder.'))
                    });
                    request?.catch?.(() => {});
                } catch (error) { finish(reject, error); }
                return;
            }
            fetch(details.url, {
                method: details.method || 'GET', headers: details.headers,
                body: details.data, mode: 'cors', credentials: 'omit'
            }).then(async response => {
                if (!response.ok) throw new Error(`API HTTP ${response.status}`);
                return response.json();
            }).then(value => finish(resolve, value), error => finish(reject, error));
        });
    }

    async function callProvider(text, source, target) {
        if (settings.provider === 'libretranslate') {
            const endpoint = normalizeEndpoint(settings.libreEndpoint);
            const body = { q: text, source: source || 'auto', target, format: 'text' };
            if (settings.libreApiKey) body.api_key = settings.libreApiKey;
            const payload = await requestJson({
                method: 'POST', url: endpoint,
                headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body)
            });
            if (payload?.error) throw new Error(String(payload.error));
            if (typeof payload?.translatedText !== 'string') throw new Error('LibreTranslate no devolvió una traducción.');
            return { text: payload.translatedText, detected: payload.detectedLanguage?.language || '' };
        }
        const sourceCode = !source || source === 'auto' ? 'Autodetect' : source;
        const endpoint = new URL('https://api.mymemory.translated.net/get');
        endpoint.searchParams.set('q', text);
        endpoint.searchParams.set('langpair', `${sourceCode}|${target}`);
        endpoint.searchParams.set('mt', '1');
        if (settings.myMemoryEmail) endpoint.searchParams.set('de', settings.myMemoryEmail);
        const payload = await requestJson({ method: 'GET', url: endpoint.href });
        const status = Number(payload?.responseStatus || 0);
        if (status >= 400) throw new Error(payload?.responseDetails || `MyMemory HTTP ${status}`);
        const translated = payload?.responseData?.translatedText;
        if (typeof translated !== 'string') throw new Error('MyMemory no devolvió una traducción.');
        return { text: translated, detected: payload.responseData?.detectedLanguage || '' };
    }

    function enqueue(task) {
        return new Promise((resolve, reject) => {
            queue.push({ task, resolve, reject });
            pumpQueue();
        });
    }

    function pumpQueue() {
        while (activeRequests < 2 && queue.length) {
            const item = queue.shift();
            activeRequests += 1;
            const wait = Math.max(0, 250 - (Date.now() - lastRequestAt));
            setTimeout(async () => {
                lastRequestAt = Date.now();
                try { item.resolve(await item.task()); }
                catch (error) { item.reject(error); }
                finally { activeRequests -= 1; pumpQueue(); }
            }, wait);
        }
    }

    function remember(key, value) {
        if (cache.has(key)) cache.delete(key);
        cache.set(key, value);
        while (cache.size > 250) cache.delete(cache.keys().next().value);
    }

    function translateText(rawText, source = 'auto', target = 'es') {
        const text = String(rawText || '').trim();
        if (!text) return Promise.reject(new Error('No hay texto para traducir.'));
        if (!target || target === 'auto') return Promise.reject(new Error('Selecciona un idioma de destino.'));
        const key = `${settings.provider}|${source}|${target}|${text}`;
        if (cache.has(key)) return Promise.resolve(cache.get(key));
        if (pendingTranslations.has(key)) return pendingTranslations.get(key);
        const promise = enqueue(() => callProvider(text, source, target))
            .then(result => { remember(key, result); return result; })
            .finally(() => pendingTranslations.delete(key));
        pendingTranslations.set(key, promise);
        return promise;
    }

    function friendlyError(error) {
        const message = String(error?.message || error || 'Error desconocido');
        if (/403|api.?key|clave/i.test(message)) return 'La API requiere una clave válida.';
        if (/429|too many|limit|quota/i.test(message)) return 'Límite temporal de la API alcanzado.';
        if (/Failed to fetch|conectar|network|ENOTFOUND/i.test(message)) return 'No se pudo conectar con la API.';
        return message.slice(0, 180);
    }

    function decodeEntities(value) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = String(value || '');
        return textarea.value;
    }

    function start() {
        discover(true);
        observer = new MutationObserver(mutations => {
            if (mutations.some(mutationTouchesChat)) scheduleDiscovery();
        });
        observer.observe(document.documentElement, {
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
            subtree: true
        });
        discoveryInterval = window.setInterval(() => discover(false), 15000);
    }

    window.__piwChatTranslator = Object.freeze({
        version: VERSION,
        openSettings,
        discover: (force = true) => discover(force),
        translateText,
        getSettings: () => ({ ...settings }),
        updateSettings: value => saveSettings({ ...settings, ...value }),
        destroy: () => {
            observer?.disconnect();
            clearInterval(discoveryInterval);
            clearTimeout(discoveryTimer);
            document.querySelectorAll('#piw-ct-launcher, #piw-ct-overlay, .piw-ct-toolbar, .piw-ct-translation').forEach(node => node.remove());
        }
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
