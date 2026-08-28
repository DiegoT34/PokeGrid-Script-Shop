// ==UserScript==
// @name         Breeding Center - Breeding calculator
// @namespace    http://tampermonkey.net/
// @version      3.0.1
// @description  Asistente de crianza en español con recomendaciones ordenadas, recarga real, Hunt Analyzer e identificación de huevos
// @author       Phoslead
// @match        https://poke.idleworld.online/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const BreedingNativeWebSocket = window.WebSocket;
    const breedingNativeSocketSend = BreedingNativeWebSocket?.prototype?.send;
    let breedingGameSocket = null;
    let latestBreedingInventory = [];
    const breedingSocketWaiters = new Map();

    function handleBreedingSocketMessage(event) {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message?.type === 'inventory') latestBreedingInventory = Array.isArray(message.items) ? message.items : [];
        try { syncIncubationsFromSocketMessage(message); } catch (_) {}
        const waiters = breedingSocketWaiters.get(message?.type);
        if (!waiters?.length) return;
        breedingSocketWaiters.delete(message.type);
        waiters.forEach(resolve => resolve(message));
    }

    function trackBreedingGameSocket(socket) {
        if (!socket || !String(socket.url || '').includes('/ws')) return socket;
        breedingGameSocket = socket;
        if (!socket.__breedingCalculatorTracked) {
            try { Object.defineProperty(socket, '__breedingCalculatorTracked', { value:true }); } catch (_) {}
            socket.addEventListener('message', handleBreedingSocketMessage);
            socket.addEventListener('close', () => { if (breedingGameSocket === socket) breedingGameSocket = null; });
        }
        return socket;
    }

    if (typeof breedingNativeSocketSend === 'function') {
        BreedingNativeWebSocket.prototype.send = function(data) {
            trackBreedingGameSocket(this);
            return breedingNativeSocketSend.call(this, data);
        };
    }

    function requestBreedingSocketEvent(responseType, request, timeoutMs = 3000) {
        if (!breedingGameSocket || breedingGameSocket.readyState !== BreedingNativeWebSocket.OPEN) return Promise.resolve(null);
        return new Promise(resolve => {
            const pending = breedingSocketWaiters.get(responseType) || [];
            const finish = message => resolve(message || null);
            pending.push(finish);
            breedingSocketWaiters.set(responseType, pending);
            try { breedingGameSocket.send(JSON.stringify(request)); }
            catch (_) {
                breedingSocketWaiters.set(responseType, pending.filter(waiter => waiter !== finish));
                resolve(null);
                return;
            }
            setTimeout(() => {
                const current = breedingSocketWaiters.get(responseType) || [];
                breedingSocketWaiters.set(responseType, current.filter(waiter => waiter !== finish));
                resolve(null);
            }, timeoutMs);
        });
    }

    // Base Configuration
    const COST_PER_BREED_GOLD = 2000000;
    const PHEROMONES_PER_BREED = 9;
    const KILLS_PER_EGG = 3000;
    const MAX_QUALITY_DIFF = 0.15;
    const QUALITY_COMPARISON_EPSILON = 1e-9;
    const WILD_MAX_QUALITY = 1.80; // Cap for wild pokémon quality
    const PHEROMONE_MARKET_REFRESH_MS = 60000;
    const PHEROMONE_MARKET_RETRY_MS = 15000;
    const RECOMMENDATION_LIMIT_OPTIONS = [10, 25, 50, 100, 'all'];
    const HUNT_KILLS_STORAGE_KEY = 'breeding_calculator_hunt_kills_per_hour_v1';

    // Growth Rates: Average vs Minimum
    const GROWTH_RATES = {
        avg: { free: 0.0096, pheromones: 0.1875 },
        min: { free: 0.0050, pheromones: 0.1500 }
    };

    // Quality Tiers
    const QUALITY_TIERS = [
        { label: 'Común', min: 1.0 },
        { label: 'Poco común', min: 1.1 },
        { label: 'Raro', min: 1.3 },
        { label: 'Épico', min: 1.5 },
        { label: 'Legendario', min: 1.7 },
        { label: 'Mítico', min: 2.0 },
        { label: 'Ancestral', min: 3.0 },
        { label: 'Divino', min: 4.0 }
    ];

    // Dynamic Color Based on Quality (Q)
    function getQualityColor(qVal) {
        if (qVal < 1.0) return 'rgb(154, 166, 179)';      // Weak
        if (qVal < 1.1) return 'rgb(99, 216, 115)';       // Common
        if (qVal < 1.3) return 'rgb(127, 212, 255)';      // Uncommon
        if (qVal < 1.5) return 'rgb(176, 108, 255)';      // Rare
        if (qVal < 1.7) return 'rgb(240, 192, 64)';       // Epic
        if (qVal < 2.0) return 'rgb(255, 140, 60)';       // Legendary
        if (qVal < 3.0) return 'rgb(106, 13, 173)';       // Mythic
        if (qVal < 4.0) return 'rgb(184, 134, 11)';       // Ancient
        return 'rgb(219, 239, 255)';                       // Divine
    }

    // Helper for Tier Name by Quality
    function getTierLabelForQ(qVal) {
        for (let i = QUALITY_TIERS.length - 1; i >= 0; i--) {
            if (qVal >= QUALITY_TIERS[i].min) {
                return QUALITY_TIERS[i].label;
            }
        }
        return 'Débil';
    }

    // Dynamic Formatter for Kills
    function formatKills(kills) {
        if (kills >= 1000000) {
            return (kills / 1000000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'M ⚔️';
        }
        return (kills / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + 'k ⚔️';
    }

    // Helper for formatting Currency Tooltips
    function formatM(val) {
        return '$' + (val / 1000000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'M';
    }

    // Global Settings State
    let settings = {
        // Solo se llena con la menor oferta vigente del market; nunca desde un campo manual.
        pheromoneUnitPrice: 0,
        killsPerHour: 0,
        growthType: 'avg',
        isFolded: true,
        useStonesCost: false,
        includeSubchainCost: false, // New setting for Sub-chain Calculation
        stonePrices: {},
        expandedTierLabel: null,
        simulateParents: false,
        simParent1IV: 0,
        simParent1Q: 1.0,
        simParent1QRaw: '1',
        simParent2IV: 0,
        simParent2Q: 1.0,
        simParent2QRaw: '1'
    };
    settings.killsPerHour = Math.max(0, Number(sessionStorage.getItem(HUNT_KILLS_STORAGE_KEY)) || 0);

    let lastHuntAnalyzerReadAt = 0;
    function parseHuntDurationSeconds(value) {
        const text = String(value || '').toLocaleLowerCase();
        const hours = Number(text.match(/(\d+)\s*h/)?.[1] || 0);
        const minutes = Number(text.match(/(\d+)\s*m/)?.[1] || 0);
        const seconds = Number(text.match(/(\d+)\s*s/)?.[1] || 0);
        return hours * 3600 + minutes * 60 + seconds;
    }

    function readHuntAnalyzerKillsPerHour() {
        const analyzer = document.querySelector('.ha-window:not(.ha-compare-modal), [data-hunt-analyzer]:not(.ha-compare-modal)');
        if (!analyzer) return 0;
        const rates = analyzer.querySelector('.ha-rates');
        if (rates) {
            const spans = Array.from(rates.querySelectorAll('span:not(.ha-catch-stats)'));
            const labelled = spans.find(node => /kills?\s*\/\s*h|derrotad(?:os|as).*hora|abatid(?:os|as).*hora/i.test(node.textContent || ''));
            const source = labelled || spans[2];
            const value = Number(String(source?.textContent || '').replace(/[.,\s]/g, '').replace(/[^0-9]/g, ''));
            if (Number.isFinite(value) && value > 0) return value;
        }
        const labelledNode = Array.from(analyzer.querySelectorAll('div,span,b,small')).find(node =>
            /kills?\s*\/\s*h|derrotad(?:os|as).*hora|abatid(?:os|as).*hora/i.test(node.textContent || '')
        );
        if (labelledNode) {
            const value = Number(String(labelledNode.textContent || '').replace(/[.,\s]/g, '').replace(/[^0-9]/g, ''));
            if (Number.isFinite(value) && value > 0) return value;
        }
        const cards = analyzer.querySelectorAll('.ha-card b');
        const defeated = Number(String(cards[0]?.textContent || '').replace(/[.,\s]/g, '').replace(/[^0-9]/g, ''));
        const seconds = parseHuntDurationSeconds(cards[1]?.textContent || '');
        return defeated > 0 && seconds > 0 ? Math.round(defeated * 3600 / seconds) : 0;
    }

    function syncHuntAnalyzerKillsPerHour(force = false) {
        if (!force && Date.now() - lastHuntAnalyzerReadAt < 1000) return settings.killsPerHour;
        lastHuntAnalyzerReadAt = Date.now();
        const current = readHuntAnalyzerKillsPerHour();
        if (current > 0 && current !== settings.killsPerHour) {
            settings.killsPerHour = current;
            sessionStorage.setItem(HUNT_KILLS_STORAGE_KEY, String(current));
            lastStateSignature = '';
        }
        return settings.killsPerHour;
    }

    // 1. Custom CSS Injection
    const customStyles = `
        .brd-custom-box {
            margin-top: 12px;
            background: rgba(10, 16, 25, 0.75);
            border: 1px solid rgba(216, 184, 113, 0.3);
            border-radius: 4px;
            padding: 8px 10px;
            box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.5);
            display: flex;
            flex-direction: column;
            max-height: 460px;
        }

        .brd-custom-box .brd-custom-head {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #d8b871;
            margin-bottom: 8px;
            border-bottom: 1px solid rgba(216, 184, 113, 0.2);
            padding-bottom: 3px;
            flex-shrink: 0;
        }

        .brd-poke-info {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(216, 184, 113, 0.08);
            border: 1px solid rgba(216, 184, 113, 0.85);
            box-shadow: none;
            border-radius: 3px;
            padding: 5px 8px;
            flex-shrink: 0;
            margin-bottom: 6px;
        }

        .brd-poke-tag {
            font-weight: 700;
            color: #f4e2a8;
            font-size: 11px;
            background: rgba(216, 184, 113, 0.2);
            border: 1px solid rgba(216, 184, 113, 0.4);
            padding: 1px 6px;
            border-radius: 3px;
        }

        .brd-poke-name {
            font-weight: 700;
            color: #ffffff;
        }

        .brd-poke-stats {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .brd-stat-chip {
            font-variant-numeric: tabular-nums;
            background: linear-gradient(#242e3ce6, #0d131cf2);
            border-radius: 4px;
            padding: 2px 8px;
            font-size: 10.5px;
            font-style: normal;
            font-weight: 800;
            box-shadow: inset 0 1px #ffffff17, inset 0 -1px 3px #0006;
            border: 1px solid;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }

        .brd-stat-chip.iv {
            color: #e8c98a;
            border-color: #b99a58 #7a5c22 #4f3d17;
        }

        .brd-iv-gain-tag {
            font-size: 9px;
            font-weight: 800;
            color: #ffd700;
            background: rgba(255, 215, 0, 0.15);
            border: 1px solid rgba(255, 215, 0, 0.5);
            border-radius: 3px;
            padding: 0px 4px;
            margin-left: 3px;
            cursor: help;
        }

        .brd-iv-warn-ico {
            width: 14px;
            height: 14px;
            vertical-align: middle;
            cursor: help;
        }

        .brd-custom-content {
            display: flex;
            flex-direction: column;
            gap: 6px;
            font-size: 12px;
            color: #c8cdd0;
            overflow-y: auto;
            flex: 1;
            padding-right: 3px;
        }

        .brd-custom-content::-webkit-scrollbar {
            width: 5px;
        }
        .brd-custom-content::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.4);
            border-radius: 3px;
        }
        .brd-custom-content::-webkit-scrollbar-thumb {
            background: rgba(216, 184, 113, 0.4);
            border-radius: 3px;
            border: 1px solid rgba(10, 16, 25, 0.8);
        }
        .brd-custom-content::-webkit-scrollbar-thumb:hover {
            background: rgba(216, 184, 113, 0.7);
        }

        .brd-tiers-container {
            display: flex;
            flex-direction: column;
            gap: 3px;
        }

        .brd-tier-title {
            font-size: 10px;
            text-transform: uppercase;
            color: #d8b871;
            font-weight: 700;
            margin-bottom: 2px;
        }

        .brd-tier-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(0, 0, 0, 0.25);
            padding: 4px 6px;
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
            user-select: none;
            transition: background 0.15s ease;
        }

        .brd-tier-row:hover {
            background: rgba(216, 184, 113, 0.12);
        }

        .brd-tier-row.active {
            border: 1px solid rgba(216, 184, 113, 0.5);
            background: rgba(216, 184, 113, 0.15);
        }

        .brd-tier-label {
            font-weight: 700;
        }

        .brd-tier-target {
            color: #8c9ba5;
            font-size: 10px;
        }

        .brd-tier-right {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .brd-tier-count {
            color: #7fd4ff;
            font-weight: 700;
            display: inline-flex;
            align-items: center;
        }

        .brd-tier-kills {
            color: #a0aec0;
            font-size: 10px;
            font-weight: 600;
        }

        .brd-tier-phero {
            color: #ff8ce8;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 2px;
        }

        .brd-tier-cost {
            color: #ffd700;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 2px;
            cursor: help;
        }

        .brd-tier-cost img, .brd-tier-phero img {
            vertical-align: middle;
        }

        .brd-subtiers-wrap {
            background: rgba(0, 0, 0, 0.4);
            border: 1px solid rgba(216, 184, 113, 0.2);
            border-radius: 4px;
            padding: 6px 8px;
            margin: 2px 0 6px 0;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .brd-subtiers-head {
            font-size: 10px;
            font-weight: 700;
            color: #d8b871;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }

        .brd-subtiers-scroll {
            max-height: 120px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 3px;
            padding-right: 4px;
        }

        .brd-subtiers-scroll::-webkit-scrollbar {
            width: 4px;
        }
        .brd-subtiers-scroll::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.4);
            border-radius: 3px;
        }
        .brd-subtiers-scroll::-webkit-scrollbar-thumb {
            background: rgba(216, 184, 113, 0.4);
            border-radius: 3px;
        }

        .brd-subtier-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            padding: 3px 6px;
            border-radius: 3px;
            font-size: 10px;
        }

        .brd-subtier-step {
            color: #7fd4ff;
            font-weight: 700;
        }

        .brd-subtier-q {
            font-weight: 700;
        }

        .brd-subtier-tag {
            font-size: 9px;
            font-weight: 700;
            padding: 1px 4px;
            border-radius: 2px;
            margin-left: 4px;
        }

        .brd-subtier-tag.wild {
            color: #63d873;
            background: rgba(99, 216, 115, 0.15);
            border: 1px solid rgba(99, 216, 115, 0.4);
        }

        .brd-subtier-tag.bred {
            color: #ff8ce8;
            background: rgba(255, 140, 232, 0.15);
            border: 1px solid rgba(255, 140, 232, 0.4);
        }

        .brd-settings-wrap {
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px solid rgba(216, 184, 113, 0.2);
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .brd-settings-toggle {
            font-size: 10px;
            text-transform: uppercase;
            color: #d8b871;
            font-weight: 700;
            cursor: pointer;
            user-select: none;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            width: fit-content;
            transition: color 0.15s ease;
        }

        .brd-settings-toggle:hover {
            color: #f4e2a8;
        }

        .brd-settings-body {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding-top: 2px;
        }

        .brd-settings-body.hidden {
            display: none;
        }

        .brd-settings-row {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 10px;
            color: #8c9ba5;
            flex-wrap: wrap;
        }

        .brd-setting-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .brd-setting-item input[type="text"] {
            width: 65px;
            background: rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(216, 184, 113, 0.3);
            border-radius: 3px;
            color: #ffd700;
            font-size: 10px;
            padding: 1px 4px;
            text-align: right;
            font-weight: 700;
            outline: none;
            -moz-appearance: textfield;
        }

        .brd-setting-item input[type="text"]:disabled {
            background: rgba(0, 0, 0, 0.2);
            border-color: rgba(255, 255, 255, 0.1);
            color: #555;
            cursor: not-allowed;
        }

        .brd-setting-item input[type="text"]::-webkit-outer-spin-button,
        .brd-setting-item input[type="text"]::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        .brd-market-price {
            display: inline-flex;
            align-items: center;
            min-width: 120px;
            padding: 2px 5px;
            border: 1px solid rgba(93, 205, 176, 0.42);
            border-radius: 3px;
            background: rgba(10, 42, 36, 0.48);
            color: #8df0c8;
            font-size: 10px;
            font-weight: 800;
            white-space: nowrap;
        }

        .brd-market-price.is-loading { border-color: rgba(216, 184, 113, 0.35); color: #e3c983; }
        .brd-market-price.is-unavailable { border-color: rgba(230, 132, 95, 0.45); color: #f1a780; }
        .brd-market-refresh { min-width: 23px; padding: 1px 5px; border: 1px solid rgba(93, 205, 176, 0.5); border-radius: 3px; background: rgba(10, 42, 36, 0.48); color: #8df0c8; font-weight: 900; cursor: pointer; }
        .brd-market-refresh:hover { background: rgba(25, 78, 64, 0.72); color: #fff; }.brd-market-refresh:disabled { opacity: .55; cursor: wait; }

        .brd-checkbox-label {
            display: flex;
            align-items: center;
            gap: 4px;
            cursor: pointer;
            color: #c8cdd0;
            font-size: 10px;
            user-select: none;
        }

        .brd-radio-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .brd-radio-group label {
            display: flex;
            align-items: center;
            gap: 3px;
            cursor: pointer;
            color: #c8cdd0;
            font-size: 10px;
        }

        .brd-stones-settings-container {
            display: flex;
            flex-direction: column;
            gap: 4px;
            background: rgba(0, 0, 0, 0.2);
            padding: 4px 6px;
            border-radius: 3px;
            border: 1px dashed rgba(216, 184, 113, 0.15);
        }

        .brd-export-row {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            margin-top: 4px;
            padding-top: 4px;
            border-top: 1px dashed rgba(216, 184, 113, 0.15);
        }

        .brd-export-btn {
            background: rgba(216, 184, 113, 0.12);
            border: 1px solid rgba(216, 184, 113, 0.4);
            color: #f4e2a8;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 700;
            padding: 3px 8px;
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .brd-export-btn:hover {
            background: rgba(216, 184, 113, 0.3);
            border-color: rgba(216, 184, 113, 0.8);
            color: #ffffff;
        }

        .brd-no-poke {
            text-align: center;
            color: #8c9ba5;
            font-style: italic;
            font-size: 11px;
            padding: 6px 0;
        }
    `;

    if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(customStyles);
    } else {
        const styleEl = document.createElement('style');
        styleEl.textContent = customStyles;
        document.head.appendChild(styleEl);
    }

    const advisorStyles = `
        .brd-helper-panel { margin-top:10px; padding:10px; border:1px solid #4a6170; border-radius:8px; background:linear-gradient(145deg,#101a21,#080e12); color:#dce8ed; box-shadow:inset 0 1px #ffffff0a,0 4px 12px #0006; font:11px system-ui,sans-serif; }
        .brd-helper-panel * { box-sizing:border-box; }
        .brd-helper-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; color:#f0dfb2; font-weight:900; font-size:11px; letter-spacing:.04em; text-transform:uppercase; }
        .brd-helper-refresh { border:1px solid #4f788d; border-radius:5px; padding:4px 7px; color:#9ee8ff; background:#10242e; cursor:pointer; font:800 9px system-ui,sans-serif; }
        .brd-helper-refresh:hover { background:#173743; color:#fff; }.brd-helper-refresh:disabled { opacity:.55; cursor:wait; }
        .brd-inheritance-flow { display:grid; grid-template-columns:1fr 20px 1fr 20px 1fr; align-items:stretch; gap:5px; }
        .brd-parent-card,.brd-child-card,.brd-advisor-card { min-width:0; padding:7px; border:1px solid #3a4e5b; border-radius:7px; background:rgba(4,10,14,.7); }
        .brd-parent-card.is-keeper,.brd-child-card { border-color:#d7b85e; box-shadow:none; }
        .brd-card-role { display:block; margin-bottom:3px; color:#86a8b7; font-size:8px; font-weight:900; letter-spacing:.06em; text-transform:uppercase; }.is-keeper .brd-card-role,.brd-child-card .brd-card-role { color:#f3d681; }
        .brd-card-name { display:block; overflow:hidden; color:#f5f7f8; font-size:12px; font-weight:900; text-overflow:ellipsis; white-space:nowrap; }
        .brd-card-data { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }.brd-mini-chip { padding:2px 5px; border:1px solid #3b5968; border-radius:4px; background:#0b151b; font-size:9px; font-weight:800; }
        .brd-flow-arrow { display:grid; place-items:center; color:#6ed9ff; font-size:16px; font-weight:900; }.brd-helper-note { margin-top:8px; color:#9aaeb8; font-size:9px; line-height:1.35; }.brd-helper-warning { color:#ffc36d; }
        .brd-advisor-summary { margin-bottom:7px; padding:6px 7px; border:1px solid #326a6a; border-radius:6px; background:#0d2022; color:#a9f5d7; font-size:10px; font-weight:700; line-height:1.35; }
        .brd-advisor-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; max-height:240px; overflow:auto; padding-right:2px; }.brd-advisor-card { display:grid; grid-template-columns:34px minmax(0,1fr); gap:6px; align-items:center; }
        .brd-advisor-card.recommended { border-color:#64da93; background:linear-gradient(145deg,#10271d,#0b1414); }.brd-advisor-sprite { width:34px; height:34px; object-fit:contain; image-rendering:pixelated; }.brd-advisor-name { overflow:hidden; color:#f5f7f8; font-size:10px; font-weight:900; text-overflow:ellipsis; white-space:nowrap; }.brd-advisor-meta { margin-top:3px; color:#9db2bd; font-size:9px; }.brd-advisor-tag { display:inline-block; margin-top:4px; padding:1px 4px; border:1px solid #49bb76; border-radius:3px; color:#7ff5ac; font-size:8px; font-weight:900; }
        .brd-native-advisor-bar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:7px; margin:6px 0; padding:6px 7px; border:1px solid #356b67; border-radius:6px; background:#0d2022; color:#a9f5d7; font-size:9px; font-weight:800; line-height:1.25; }.brd-native-advisor-bar > span { min-width:180px; flex:1 1 260px; }.brd-native-advisor-actions { display:flex; align-items:center; justify-content:flex-end; gap:6px; flex:0 1 auto; }.brd-recommendation-filter { display:inline-flex; align-items:center; gap:5px; color:#9fc0cc; white-space:nowrap; }.brd-recommendation-limit { min-width:74px; height:25px; padding:2px 21px 2px 7px; border:1px solid #426879; border-radius:5px; outline:none; background:#0a171e; color:#dff7ff; font:800 9px system-ui,sans-serif; cursor:pointer; }.brd-recommendation-limit:focus-visible { border-color:#69cbe5; }.brd-native-advisor-bar .brd-helper-refresh { flex:none; }
        .brd-breed-recommended { position:relative !important; outline:2px solid #42d58a !important; outline-offset:-2px; box-shadow:inset 0 0 0 1px #07150d !important; filter:none !important; animation:none !important; transition:border-color .15s ease !important; }.brd-breed-recommended.brd-breed-best { outline:3px solid #ffd45c !important; outline-offset:-3px; box-shadow:inset 0 0 0 1px #5f4a12 !important; }.brd-breed-hidden { display:none !important; }
        .brd-no-secondary-message { margin:7px 0; padding:9px; border:1px solid #c98b56; border-radius:6px; background:#291b12; color:#ffd1a7; font-size:10px; font-weight:800; line-height:1.35; }
        .brd-egg-helper-info { display:block; margin-top:4px; padding-top:4px; border-top:1px solid #d7b85e44; color:#dfeef2; font-size:9px; font-weight:750; line-height:1.35; }.brd-egg-helper-info b { color:#f3d681; }.brd-egg-helper-info em { color:#86e7bd; font-style:normal; }
        .brd-helper-panel,.brd-native-advisor-bar { border-color:#735b2c; background:linear-gradient(145deg,#132219,#09110d); box-shadow:inset 0 1px #fff8,0 4px 12px #0007; color:#eadfbf; }
        .brd-native-advisor-bar { border-left:3px solid #c8a24d; }
        .brd-helper-refresh { color:#f2df9f; background:#1c291e; border-color:#806832; }.brd-helper-refresh:hover { color:#171006; background:#d1af58; }
        .brd-recommendation-limit { color:#f0e4c8; background:#0a120e; border-color:#65532d; }.brd-recommendation-limit:focus-visible { border-color:#d7b75f; }
        .brd-breed-recommended { outline-color:#42d58a !important; }.brd-breed-recommended.brd-breed-best { outline-color:#ffd45c !important; }
        .brd-auto-source { padding:2px 5px; color:#83d9ad; background:#0b2619; border:1px solid #38694d; border-radius:3px; font-size:8px; font-weight:850; }
        #killsPerHourInput[readonly] { color:#8de0b3; background:#07150e; border-color:#315d43; cursor:default; }
        .brd-dock-incubation-button { position:relative !important; overflow:visible !important; }
        .game-dock > * > span.brd-dock-incubation-badge { position:absolute !important; z-index:130 !important; top:-5px !important; right:-5px !important; display:grid !important; place-items:center !important; width:auto !important; min-width:17px !important; max-width:30px !important; height:17px !important; padding:0 4px !important; margin:0 !important; border:2px solid #0a1118 !important; border-radius:9px !important; background:#ffca3a !important; color:#241800 !important; font:900 10px/1 system-ui,sans-serif !important; box-shadow:0 2px 5px #0009 !important; pointer-events:none !important; }
        @media (max-width:760px) { .brd-inheritance-flow { grid-template-columns:1fr; }.brd-flow-arrow { height:14px; transform:rotate(90deg); }.brd-advisor-list { grid-template-columns:1fr; max-height:210px; } }
    `;
    const advisorStyleEl = document.createElement('style');
    advisorStyleEl.textContent = advisorStyles;
    document.head.appendChild(advisorStyleEl);

    let availablePokemon = [];
    let availablePokemonSignature = '';
    let availablePokemonVersion = 0;
    let pokemonRefreshPromise = null;
    let advisorSignature = '';
    let lastStateSignature = '';
    let recommendationLimit = 10;
    const EGG_PARENT_STORAGE_KEY = 'breeding_calculator_egg_parents_v1';
    const INCUBATION_STORAGE_KEY = 'breeding_calculator_incubations_v1';
    const eggNodeParents = new WeakMap();
    let lastSelectedParentOne = null;
    let storedEggParents = (() => {
        try { return JSON.parse(localStorage.getItem(EGG_PARENT_STORAGE_KEY) || '{}') || {}; }
        catch (_) { return {}; }
    })();
    let trackedIncubations = (() => {
        try { return JSON.parse(localStorage.getItem(INCUBATION_STORAGE_KEY) || '{}') || {}; }
        catch (_) { return {}; }
    })();
    let lastIncubationDomSyncAt = 0;
    let rememberedBreedingDockButton = null;
    let pheromoneMarketRefreshPromise = null;
    let pheromoneMarket = {
        status: 'loading',
        selected: null,
        lowestGold: null,
        lowestDiamonds: null,
        diamondGoldRate: null,
        updatedAt: 0,
        error: ''
    };

    const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));

    function getGameTokens() {
        try { return JSON.parse(sessionStorage.getItem('pokeweb:tokens') || 'null'); }
        catch (_) { return null; }
    }

    async function refreshGameAccessToken() {
        const tokens = getGameTokens();
        if (!tokens?.refreshToken) return null;
        const response = await fetch('/api/auth/refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: tokens.refreshToken })
        });
        if (!response.ok) return null;
        const refreshed = await response.json().catch(() => null);
        if (!refreshed?.accessToken) return null;
        sessionStorage.setItem('pokeweb:tokens', JSON.stringify(refreshed));
        return refreshed.accessToken;
    }

    async function gameApiRequest(url, options = {}) {
        const send = accessToken => fetch(url, {
            ...options,
            headers: {
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                ...(options.headers || {})
            }
        });
        let response = await send(getGameTokens()?.accessToken);
        if (response.status === 401) {
            const refreshedToken = await refreshGameAccessToken();
            if (refreshedToken) response = await send(refreshedToken);
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
        return payload;
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
        return /DIAM|^DD$/i.test(String(value || 'GOLD').trim()) ? 'DIAMONDS' : 'GOLD';
    }

    function getMarketEntryPrice(entry) {
        return Number(entry?.price ?? entry?.totalPrice ?? entry?.value ?? 0);
    }

    function getMarketEntryCurrency(entry) {
        const ref = entry?.item || entry?.pokemon || entry?.product || {};
        return normalizeMarketCurrency(entry?.currency || entry?.currencyType || ref.currency || ref.currencyType);
    }

    function getMarketEntryName(entry) {
        const ref = entry?.item || entry?.product || entry?.pokemon || {};
        return String(entry?.name || entry?.itemName || entry?.title || ref?.name || ref?.itemName || '');
    }

    function isPheromoneListing(entry) {
        const name = getMarketEntryName(entry);
        const ref = entry?.item || entry?.product || {};
        const image = String(entry?.image || entry?.icon || ref?.image || ref?.icon || '');
        return /pheromon|feromon/i.test(name) || /strange[_-]?pheromone/i.test(image);
    }

    function getLowestDiamondGoldRate(listings) {
        const prices = listings
            .filter(entry => !entry?.offerOnly && getMarketEntryCurrency(entry) === 'GOLD')
            .map(getMarketEntryPrice)
            .filter(price => Number.isFinite(price) && price > 0);
        return prices.length ? Math.min(...prices) : null;
    }

    function formatMarketPrice(value) {
        return Math.round(Number(value) || 0).toLocaleString();
    }

    function getPheromoneMarketDisplay() {
        if (pheromoneMarket.selected) {
            const chosen = pheromoneMarket.selected;
            const label = chosen.currency === 'DIAMONDS'
                ? `💎 ${formatMarketPrice(chosen.nativePrice)} ≈ 💲 ${formatMarketPrice(chosen.goldValue)}`
                : `💲 ${formatMarketPrice(chosen.goldValue)}`;
            const alternatives = [
                pheromoneMarket.lowestGold ? `💲 ${formatMarketPrice(pheromoneMarket.lowestGold)}` : '',
                pheromoneMarket.lowestDiamonds ? `💎 ${formatMarketPrice(pheromoneMarket.lowestDiamonds)}` : ''
            ].filter(Boolean).join(' · ');
            const time = pheromoneMarket.updatedAt
                ? new Date(pheromoneMarket.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';
            return { className: '', label, title: `Menor oferta actual: ${label}${alternatives ? ` | Ofertas: ${alternatives}` : ''}${time ? ` | Actualizado ${time}` : ''}` };
        }
        if (pheromoneMarket.status === 'unavailable') {
            return { className: 'is-unavailable', label: 'Sin ofertas en market', title: pheromoneMarket.error || 'No se encontró Strange Pheromone a la venta.' };
        }
        return { className: 'is-loading', label: 'Consultando market…', title: 'Buscando el menor precio de Strange Pheromone.' };
    }

    async function refreshPheromoneMarketPrice() {
        if (pheromoneMarketRefreshPromise) return pheromoneMarketRefreshPromise;
        pheromoneMarketRefreshPromise = (async () => {
            try {
                const nonce = Date.now();
                const options = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };
                const [marketPayload, diamondPayload] = await Promise.all([
                    gameApiRequest(`/api/game/market?category=All&_pheromone=${nonce}`, options),
                    gameApiRequest(`/api/game/market?category=Diamonds&_pheromone=${nonce}`, options)
                ]);
                const listings = getMarketListings(marketPayload).filter(entry => !entry?.offerOnly && isPheromoneListing(entry));
                const diamondRate = getLowestDiamondGoldRate(getMarketListings(diamondPayload));
                const lowestGold = listings
                    .filter(entry => getMarketEntryCurrency(entry) === 'GOLD')
                    .map(getMarketEntryPrice).filter(price => Number.isFinite(price) && price > 0)
                    .sort((a, b) => a - b)[0] || null;
                const lowestDiamonds = listings
                    .filter(entry => getMarketEntryCurrency(entry) === 'DIAMONDS')
                    .map(getMarketEntryPrice).filter(price => Number.isFinite(price) && price > 0)
                    .sort((a, b) => a - b)[0] || null;
                const choices = [];
                if (lowestGold) choices.push({ currency: 'GOLD', nativePrice: lowestGold, goldValue: lowestGold });
                if (lowestDiamonds && diamondRate) choices.push({ currency: 'DIAMONDS', nativePrice: lowestDiamonds, goldValue: lowestDiamonds * diamondRate });
                const selected = choices.sort((a, b) => a.goldValue - b.goldValue)[0] || null;
                pheromoneMarket = {
                    status: selected ? 'ready' : 'unavailable', selected, lowestGold, lowestDiamonds,
                    diamondGoldRate: diamondRate, updatedAt: Date.now(),
                    error: selected ? '' : 'No hay oferta de Strange Pheromone con un valor comparable en Pokedólares.'
                };
                if (selected) settings.pheromoneUnitPrice = selected.goldValue;
            } catch (error) {
                pheromoneMarket = {
                    ...pheromoneMarket, status: pheromoneMarket.selected ? 'ready' : 'unavailable',
                    updatedAt: Date.now(),
                    error: `No se pudo consultar el market: ${error?.message || 'error de conexión'}`
                };
            } finally {
                lastStateSignature = '';
                pheromoneMarketRefreshPromise = null;
                runCalculatorLoop();
            }
            return pheromoneMarket;
        })();
        return pheromoneMarketRefreshPromise;
    }

    function firstPokemonNumber(...values) {
        for (const value of values) {
            if (value === null || value === undefined || value === '') continue;
            const match = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
            const numeric = match ? Number(match[0]) : NaN;
            if (Number.isFinite(numeric)) return numeric;
        }
        return 0;
    }

    function normalizePokemon(pokemon) {
        const ref = pokemon?.pokemon || pokemon?.capturedPokemon || pokemon?.poke || pokemon?.creature || {};
        const stats = pokemon?.stats || ref?.stats || {};
        const speciesId = pokemon?.speciesId ?? ref?.speciesId
            ?? pokemon?.dexId ?? ref?.dexId
            ?? pokemon?.pokedexId ?? ref?.pokedexId
            ?? pokemon?.pokemonId ?? ref?.pokemonId
            ?? pokemon?.pokeId ?? ref?.pokeId ?? '';
        return {
            // `id` identifica esta captura concreta. Nunca se usa como ID de especie.
            id: pokemon?.id ?? pokemon?.capturedId ?? pokemon?.recordId ?? pokemon?.uuid ?? ref?.id ?? '',
            name: pokemon?.name || pokemon?.pokemonName || ref?.name || ref?.pokemonName || `Pokémon ${speciesId}`,
            speciesId,
            level: firstPokemonNumber(pokemon?.level, ref?.level, stats.level, 1) || 1,
            ivVal: firstPokemonNumber(
                pokemon?.ivTotal, ref?.ivTotal, pokemon?.totalIv, ref?.totalIv,
                pokemon?.ivsTotal, ref?.ivsTotal, pokemon?.iv, ref?.iv, stats.ivTotal, stats.totalIv
            ),
            qVal: firstPokemonNumber(
                pokemon?.quality, ref?.quality, pokemon?.qualityValue, ref?.qualityValue,
                pokemon?.qualityMultiplier, ref?.qualityMultiplier, pokemon?.qualityMult, ref?.qualityMult,
                pokemon?.q, ref?.q, stats.quality, stats.qualityValue
            ),
            team: Boolean(pokemon?.team ?? ref?.team),
            starter: Boolean(pokemon?.starter ?? ref?.starter),
            shiny: Boolean(pokemon?.shiny ?? ref?.shiny),
            locked: Boolean(pokemon?.locked ?? pokemon?.isLocked ?? ref?.locked ?? ref?.isLocked),
            market: Boolean(pokemon?.market ?? pokemon?.listed ?? ref?.market ?? ref?.listed)
        };
    }

    function getBreedingGameContext() {
        const roots = Array.from(document.querySelectorAll('.phud-name, .phud, [data-guide="player-hud"], #root'));
        for (const root of roots) {
            const fiberKey = Object.keys(root).find(key => key.startsWith('__reactFiber$'));
            let fiber = fiberKey ? root[fiberKey] : null;
            for (let depth = 0; fiber && depth < 80; depth += 1, fiber = fiber.return) {
                const candidates = [fiber.memoizedProps?.value, fiber.memoizedProps, fiber.memoizedState?.memoizedState];
                const context = candidates.find(value => value && typeof value.subscribe === 'function'
                    && (typeof value.requestPokes === 'function' || typeof value.requestInventory === 'function'));
                if (context) return context;
            }
        }
        return null;
    }

    function requestPokemonListFromGameContext(timeoutMs = 2600) {
        const context = getBreedingGameContext();
        if (!context || typeof context.requestPokes !== 'function') return Promise.resolve([]);
        return new Promise(resolve => {
            let settled = false; let unsubscribe = null;
            const finish = list => { if (settled) return; settled = true; clearTimeout(timeout); try { unsubscribe?.(); } catch (_) {} resolve(Array.isArray(list) ? list : []); };
            const timeout = setTimeout(() => finish([]), timeoutMs);
            try { unsubscribe = context.subscribe('pokes', message => finish(message?.list ?? message)); context.requestPokes(); } catch (_) { finish([]); }
        });
    }

    async function requestFreshPokemonList() {
        const socketMessage = await requestBreedingSocketEvent('pokes', { type:'pokes-get' }, 2800);
        const socketList = socketMessage?.list;
        if (Array.isArray(socketList) && socketList.length) return socketList;
        return requestPokemonListFromGameContext(3000);
    }

    async function refreshBreedingInventory() {
        const socketMessage = await requestBreedingSocketEvent('inventory', { type:'inv-get' }, 2600);
        if (Array.isArray(socketMessage?.items)) {
            latestBreedingInventory = socketMessage.items;
            return latestBreedingInventory;
        }
        const context = getBreedingGameContext();
        const requestInventory = context?.requestInventory || context?.requestInv || context?.requestItems;
        if (!context || typeof requestInventory !== 'function') return latestBreedingInventory;
        return new Promise(resolve => {
            let settled = false; let unsubscribe = null;
            const finish = list => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                try { unsubscribe?.(); } catch (_) {}
                if (Array.isArray(list)) latestBreedingInventory = list;
                resolve(latestBreedingInventory);
            };
            const timeout = setTimeout(() => finish([]), 2800);
            try {
                unsubscribe = context.subscribe('inventory', message => finish(message?.items ?? message));
                requestInventory.call(context);
            } catch (_) { finish([]); }
        });
    }

    async function refreshAvailablePokemon(force = false) {
        if (pokemonRefreshPromise) {
            if (!force) return pokemonRefreshPromise;
            await pokemonRefreshPromise;
        }
        pokemonRefreshPromise = requestFreshPokemonList().then(list => {
            if (list.length) {
                const normalized = list.map(normalizePokemon);
                const nextSignature = normalized.map(pokemon => [
                    pokemon.id, pokemon.speciesId, pokemon.name, pokemon.ivVal, pokemon.qVal,
                    Number(pokemon.team), Number(pokemon.starter), Number(pokemon.shiny),
                    Number(pokemon.locked), Number(pokemon.market)
                ].join(':')).join('|');
                // La API puede repetir la misma colección cada pocos segundos. Evitar
                // incrementar la versión impide volver a filtrar y repintar cientos de
                // tarjetas cuando ningún Pokémon cambió realmente.
                if (nextSignature !== availablePokemonSignature) {
                    availablePokemon = normalized;
                    availablePokemonSignature = nextSignature;
                    availablePokemonVersion += 1;
                    lastStateSignature = '';
                }
                return { pokemon:availablePokemon, refreshed:true };
            }
            return { pokemon:availablePokemon, refreshed:false };
        }).catch(() => ({ pokemon:availablePokemon, refreshed:false })).finally(() => { pokemonRefreshPromise = null; });
        return pokemonRefreshPromise;
    }

    function getInheritance(parents, mode) {
        if (!parents.length) return null;
        const sorted = [...parents].sort((a, b) => b.qVal - a.qVal || b.ivVal - a.ivVal);
        const keeper = sorted[0];
        const secondary = sorted[1] || null;
        const delta = GROWTH_RATES[settings.growthType][mode];
        return { keeper, secondary, child: { name: keeper.name, ivVal: keeper.ivVal, qVal: keeper.qVal + delta }, delta };
    }

    function getAreaByLabel(label, selectors) {
        const direct = document.querySelector(selectors);
        if (direct) return direct;
        const labels = Array.from(document.querySelectorAll('.brd-title, .brd-col-title, .brd-head, h2, h3, b, strong'));
        const found = labels.find(node => node.textContent?.trim().toLowerCase().includes(label.toLowerCase()));
        return found?.closest('.brd-col, .brd-section, .brd-panel, .brd-box') || null;
    }

    const BREEDING_UI_TRANSLATIONS = [
        [/\bBreeding Center\b/gi, 'Centro de crianza'], [/\bCentro de Cria(?:ç|c)ão\b/gi, 'Centro de crianza'],
        [/\bBreeding Pair\b/gi, 'Pareja de crianza'], [/\bPar de Cria(?:ç|c)ão\b/gi, 'Pareja de crianza'],
        [/\bYour Pok[eé]mon\s*\(Box\)/gi, 'Tus Pokémon (Caja)'], [/\bSeus Pok[eé]mon\s*\(Caixa\)/gi, 'Tus Pokémon (Caja)'],
        [/\bYour Pok[eé]mon\b/gi, 'Tus Pokémon'], [/\bSeus Pok[eé]mon\b/gi, 'Tus Pokémon'], [/\(BOX\)/g, '(CAJA)'],
        [/\bPok[eé]mon Box\b/gi, 'Caja de Pokémon'], [/\bCaixa de Pok[eé]mon\b/gi, 'Caja de Pokémon'],
        [/\bIncubator\b/gi, 'Incubadora'], [/\bMystery Egg\b/gi, 'Huevo misterioso'], [/\bOvo Misterioso\b/gi, 'Huevo misterioso'],
        [/\bFirst Parent\b/gi, 'Padre 1'], [/\bPrimeiro Pai\b/gi, 'Padre 1'],
        [/\bSecond Parent\b/gi, 'Padre 2'], [/\bSegundo Pai\b/gi, 'Padre 2'],
        [/\bParent 1\b/gi, 'Padre 1'], [/\bParent 2\b/gi, 'Padre 2'],
        [/\bSelect (?:the )?first parent\b/gi, 'Selecciona el Padre 1'], [/\bSelecione (?:o )?primeiro pai\b/gi, 'Selecciona el Padre 1'],
        [/\bSelect (?:the )?second parent\b/gi, 'Selecciona el Padre 2'], [/\bSelecione (?:o )?segundo pai\b/gi, 'Selecciona el Padre 2'],
        [/\bSelect (?:a )?Pok[eé]mon\b/gi, 'Selecciona un Pokémon'], [/\bSelecione (?:um )?Pok[eé]mon\b/gi, 'Selecciona un Pokémon'],
        [/\bSearch Pok[eé]mon\b/gi, 'Buscar Pokémon'], [/\bSearch\.\.\./gi, 'Buscar...'], [/\bBuscar Pok[eé]mon\b/gi, 'Buscar Pokémon'],
        [/\bStart Breeding\b/gi, 'Iniciar crianza'], [/\bIniciar Cria(?:ç|c)ão\b/gi, 'Iniciar crianza'],
        [/^\s*Breed\s*$/gi, 'Criar'], [/^\s*Reproduzir\s*$/gi, 'Criar'],
        [/^\s*Free\s*$/gi, 'Gratuito'], [/^\s*Gr[aá]tis\s*$/gi, 'Gratuito'],
        [/\bRequired Stones\b/gi, 'Stones necesarias'], [/\bStones Necess[aá]rias\b/gi, 'Stones necesarias'],
        [/\bDouble Stones\b/gi, 'Stones dobles'], [/\bStones Duplas\b/gi, 'Stones dobles'],
        [/\bNo eggs? incubating\b/gi, 'No hay huevos incubándose'], [/\bNenhum ovo incubando\b/gi, 'No hay huevos incubándose'],
        [/^\s*Ready\s*$/gi, 'Listo'], [/^\s*Pronto\s*$/gi, 'Listo'], [/^\s*Hatch\s*$/gi, 'Eclosionar'], [/^\s*Chocar\s*$/gi, 'Eclosionar'],
        [/\bTime Remaining\b/gi, 'Tiempo restante'], [/\bTempo Restante\b/gi, 'Tiempo restante'],
        [/\bChoose a path\b/gi, 'Elige una modalidad'], [/\bEscolha um caminho\b/gi, 'Elige una modalidad'],
        [/\bChance per breed\b/gi, 'Probabilidad por crianza'], [/\bChance por cria(?:ç|c)ão\b/gi, 'Probabilidad por crianza'],
        [/\bSuccess Chance\b/gi, 'Probabilidad de éxito'], [/\bChance de Sucesso\b/gi, 'Probabilidad de éxito'],
        [/\bBreeding Mode\b/gi, 'Modalidad de crianza'], [/\bModo de Cria(?:ç|c)ão\b/gi, 'Modalidad de crianza'],
        [/^\s*Confirm\s*$/gi, 'Confirmar'], [/^\s*Confirmar\s*$/gi, 'Confirmar'],
        [/^\s*Cancel\s*$/gi, 'Cancelar'], [/^\s*Cancelar\s*$/gi, 'Cancelar'],
        [/^\s*Close\s*$/gi, 'Cerrar'], [/^\s*Fechar\s*$/gi, 'Cerrar'],
        [/^\s*Result\s*$/gi, 'Resultado'], [/^\s*Resultado\s*$/gi, 'Resultado'],
        [/^\s*Duration\s*$/gi, 'Duración'], [/^\s*Dura(?:ç|c)ão\s*$/gi, 'Duración'],
        [/^\s*Cost\s*$/gi, 'Costo'], [/^\s*Custo\s*$/gi, 'Costo'],
        [/^\s*Available\s*$/gi, 'Disponible'], [/^\s*Dispon[ií]vel\s*$/gi, 'Disponible'],
        [/Pick another (.+?) within\s*([\d.,]+)\s*quality\s*\(incompatible pairs are dimmed\)\.?/gi, 'Elige otro $1 con una diferencia máxima de $2 de Quality (las parejas incompatibles aparecen atenuadas).'],
        [/Escolha outro (.+?) com Quality at[eé]\s*([\d.,]+)\s*menor\s*\(pares incompat[ií]veis ficam esmaecidos\)\.?/gi, 'Elige otro $1 con una diferencia máxima de $2 de Quality (las parejas incompatibles aparecen atenuadas).'],
        [/\bIncompatible pairs are dimmed\b/gi, 'Las parejas incompatibles aparecen atenuadas'],
        [/\bHighest Quality\b/gi, 'Mayor Quality'], [/\bLowest Quality\b/gi, 'Menor Quality'],
        [/\bHighest IV\b/gi, 'Mayor IV'], [/\bLowest IV\b/gi, 'Menor IV'],
        [/\bNewest first\b/gi, 'Más recientes'], [/\bOldest first\b/gi, 'Más antiguos'],
        [/\bSort by\b/gi, 'Ordenar por'], [/\bSelected parent\b/gi, 'Padre seleccionado'],
        [/\bCompatible\b/gi, 'Compatible'], [/\bIncompatible\b/gi, 'Incompatible'],
        [/\bEgg ready\b/gi, 'Huevo listo'], [/\bIncubation complete\b/gi, 'Incubación finalizada'],
        [/\bIncubating\b/gi, 'Incubando'], [/\bProgress\b/gi, 'Progreso'],
        [/\bNo Pok[eé]mon available\b/gi, 'No hay Pokémon disponibles'],
        [/\bNo compatible Pok[eé]mon\b/gi, 'No hay Pokémon compatibles'],
        [/\bSelect breeding mode\b/gi, 'Selecciona la modalidad de crianza'],
        [/\bUse Pheromones\b/gi, 'Usar Pheromones'], [/\bWithout Pheromones\b/gi, 'Sin Pheromones'],
        [/\bSearch by name\b/gi, 'Buscar por nombre'], [/\bRemove parent\b/gi, 'Quitar padre'],
        [/\bClear pair\b/gi, 'Limpiar pareja'], [/\bCurrent pair\b/gi, 'Pareja actual'],
        [/\bBreeding result\b/gi, 'Resultado de la crianza'], [/\bExpected result\b/gi, 'Resultado esperado'],
        [/\bExpected Quality\b/gi, 'Quality esperada'], [/\bInherited IV\b/gi, 'IV heredado'],
        [/\bIncubation slots?\b/gi, 'Espacios de incubación'], [/\bEmpty slot\b/gi, 'Espacio vacío'],
        [/\bOpen egg\b/gi, 'Abrir huevo'], [/\bCollect\b/gi, 'Recoger'], [/\bClaim\b/gi, 'Reclamar'],
        [/\bReady in\b/gi, 'Listo en'], [/\bBreeding fee\b/gi, 'Tarifa de crianza'],
        [/\bCost per breed\b/gi, 'Costo por crianza'], [/\bTotal cost\b/gi, 'Costo total'],
        [/\bNot enough\b/gi, 'No hay suficiente'], [/\bInsufficient\b/gi, 'Insuficiente'],
        [/^\s*Owned\s*$/gi, 'Disponibles'], [/^\s*Required\s*$/gi, 'Necesarios'],
        [/\bRemaining\b/gi, 'Restante'], [/\bCompleted\b/gi, 'Finalizado'],
        [/\bCurrent\b/gi, 'Actual'], [/\bNext\b/gi, 'Siguiente'], [/\bBack\b/gi, 'Volver']
    ];
    let lastBreedingTranslationAt = 0;
    function translateBreedingText(value) {
        return BREEDING_UI_TRANSLATIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(value || ''));
    }
    function translateBreedingInterface(pairSection, force = false) {
        if (!force && Date.now() - lastBreedingTranslationAt < 600) return;
        lastBreedingTranslationAt = Date.now();
        const root = pairSection?.closest('.brd-window, .brd-modal, [class*="breeding"][role="dialog"], [role="dialog"]')
            || pairSection?.parentElement?.parentElement || pairSection;
        if (!root) return;
        const excluded = '.brd-poke-name,.brd-parent-name,.brd-stone-name,.brd-item-name,.brd-egg-helper-info,[data-pokemon-name],[data-item-name]';
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(node => {
            if (node.parentElement?.closest(excluded)) return;
            const translated = translateBreedingText(node.nodeValue);
            if (translated !== node.nodeValue) node.nodeValue = translated;
        });
        root.querySelectorAll('input[placeholder],button[title],[title]').forEach(element => {
            for (const attribute of ['placeholder', 'title']) {
                if (!element.hasAttribute(attribute) || element.closest(excluded)) continue;
                const current = element.getAttribute(attribute);
                const translated = translateBreedingText(current);
                if (translated !== current) element.setAttribute(attribute, translated);
            }
        });
    }

    function pokemonSprite(pokemon) {
        return pokemon.speciesId ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.speciesId}.png` : '';
    }

    function parentCard(parent, role, isKeeper = false) {
        if (!parent) return `<div class="brd-parent-card"><span class="brd-card-role">${role}</span><span class="brd-card-name">Sin seleccionar</span></div>`;
        const color = getQualityColor(parent.qVal);
        return `<div class="brd-parent-card${isKeeper ? ' is-keeper' : ''}"><span class="brd-card-role">${role}</span><span class="brd-card-name">${escapeHTML(parent.name)}</span><span class="brd-card-data"><span class="brd-mini-chip">IV ${parent.ivVal}/192</span><span class="brd-mini-chip" style="color:${color};border-color:${color};">Q ${parent.qVal.toFixed(2)}</span></span></div>`;
    }

    function normalizeSpeciesName(name) {
        return String(name || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\b(?:lv|level|nivel|nv)\.?\s*\d+\b/gi, '')
            .replace(/[♀♂✨]/g, '')
            .trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function isSamePokemonSpecies(keeper, pokemon) {
        const keeperName = normalizeSpeciesName(keeper?.name);
        const candidateName = normalizeSpeciesName(pokemon?.name);
        // El nombre es la referencia más fiable entre la selección del DOM y la
        // lista `pokes`; sus IDs pueden representar la captura y no la especie.
        if (keeperName && candidateName && keeperName === candidateName) return true;
        if (keeper?.speciesId === '' || keeper?.speciesId == null
            || pokemon?.speciesId === '' || pokemon?.speciesId == null) return false;
        return String(keeper.speciesId) === String(pokemon.speciesId);
    }

    function getPokemonBoxArea(pairSection) {
        const searchInput = Array.from(document.querySelectorAll('input')).find(input => {
            const placeholder = input.getAttribute('placeholder') || '';
            return /search|buscar|pok[eé]mon/i.test(placeholder) && !input.closest('.brd-custom-box');
        });
        const searchArea = searchInput?.closest('.brd-col, .brd-section, .brd-panel, .brd-box, .brd-list');
        if (searchArea) return searchArea;
        return getAreaByLabel('your pokémon', '.brd-col-box, .brd-col-pokemon, .brd-pokemon-box')
            || getAreaByLabel('your pokemon', '.brd-col-box, .brd-col-pokemon, .brd-pokemon-box')
            || getAreaByLabel('tus pokémon', '.brd-col-box, .brd-col-pokemon, .brd-pokemon-box')
            || getAreaByLabel('seus pokémon', '.brd-col-box, .brd-col-pokemon, .brd-pokemon-box')
            || pairSection;
    }

    function getValidSecondParents(keeper) {
        return availablePokemon.filter(pokemon => {
            return isSamePokemonSpecies(keeper, pokemon)
                && !pokemon.team && !pokemon.starter && !pokemon.shiny && !pokemon.market && !pokemon.locked
                && String(pokemon.id) !== String(keeper.id)
                && !isSameVisibleCapture(keeper, pokemon)
                && isSecondParentWithinNumericLimits(keeper, pokemon);
        // El menor Quality válido ahorra material; a igualdad se prioriza el IV más alto.
        }).sort((a, b) => (a.qVal - b.qVal) || (b.ivVal - a.ivVal) || String(a.id).localeCompare(String(b.id)));
    }

    function isSameVisibleCapture(keeper, pokemon) {
        if (!keeper || !pokemon) return false;
        if (keeper.id !== '' && keeper.id != null && pokemon.id !== '' && pokemon.id != null
            && String(keeper.id) === String(pokemon.id)) return true;
        // El juego redondea Quality en la tarjeta. La captura seleccionada puede llegar
        // por API con unas decimas adicionales y parecia falsamente "menor" que ella misma.
        return isSamePokemonSpecies(keeper, pokemon)
            && Number(keeper.ivVal) === Number(pokemon.ivVal)
            && Math.abs(Number(keeper.qVal) - Number(pokemon.qVal)) < 0.001;
    }

    function isSecondParentWithinNumericLimits(keeper, pokemon) {
        const keeperQuality = Number(keeper?.qVal);
        const candidateQuality = Number(pokemon?.qVal);
        const keeperIv = Number(keeper?.ivVal);
        const candidateIv = Number(pokemon?.ivVal);
        if (![keeperQuality, candidateQuality, keeperIv, candidateIv].every(Number.isFinite)) return false;

        const qualityDifference = keeperQuality - candidateQuality;
        // Quality 2 debe ser estrictamente menor, pero como máximo 0.15 por debajo.
        const validQuality = qualityDifference > QUALITY_COMPARISON_EPSILON
            && qualityDifference <= MAX_QUALITY_DIFF + QUALITY_COMPARISON_EPSILON;
        // No existe IV mínimo: 0, 20, 79, etc. son válidos. Solo se evita superar al padre 1.
        const validIv = candidateIv >= 0 && candidateIv <= keeperIv;
        return validQuality && validIv;
    }

    function getNativePokemonCards(boxArea) {
        const candidates = Array.from(boxArea.querySelectorAll('[data-poke-id], [data-id], .brd-poke, .brd-poke-item, .brd-box-poke, .brd-select-poke, button, li'))
            .filter(node => !node.closest('.brd-native-advisor-bar') && /\bIV\s*\d+/i.test(node.innerText || ''));
        // React puede exponer a la vez la tarjeta y su botón interno. Conservar solo
        // el nodo más profundo evita contar y mostrar dos veces al mismo Pokémon.
        return candidates.filter(node => !candidates.some(other => other !== node && node.contains(other)));
    }

    function nativeCardMatchesPokemon(card, pokemon) {
        const id = getNodePokemonId(card);
        if (id && String(id) === String(pokemon.id)) return true;
        const text = card.innerText || '';
        if (!text.toLocaleLowerCase().includes(String(pokemon.name).toLocaleLowerCase())) return false;
        const iv = text.match(/\bIV\s*(\d+)/i)?.[1];
        const q = text.match(/\bQ(?:uality)?\s*[×x:]?\s*(\d+(?:[.,]\d+)?)/i)?.[1];
        return (!iv || Number(iv) === pokemon.ivVal) && (!q || Math.abs(Number(q.replace(',', '.')) - pokemon.qVal) < 0.011);
    }

    function getNodePokemonId(node) {
        if (!node || typeof node !== 'object') return '';
        const direct = node.dataset?.pokeId || node.dataset?.pokemonId || node.dataset?.capturedId || node.dataset?.id || '';
        if (typeof Element === 'undefined' || !(node instanceof Element)) return direct;
        const holder = node.matches('[data-poke-id],[data-pokemon-id],[data-captured-id],[data-id]')
            ? node : node.querySelector('[data-poke-id],[data-pokemon-id],[data-captured-id],[data-id]');
        return holder?.dataset?.pokeId || holder?.dataset?.pokemonId || holder?.dataset?.capturedId || holder?.dataset?.id || '';
    }

    function recommendationStatsKey(iv, quality) {
        return `${Number(iv)}|${Number(quality).toFixed(3)}`;
    }

    function createRecommendationLookup(eligible) {
        const byId = new Map();
        const byStats = new Map();
        const byIv = new Map();
        const byQuality = new Map();
        const addIndex = (map, key, index) => map.set(key, [...(map.get(key) || []), index]);
        eligible.forEach((pokemon, index) => {
            if (pokemon.id !== '' && pokemon.id != null) byId.set(String(pokemon.id), index);
            const statsKey = recommendationStatsKey(pokemon.ivVal, pokemon.qVal);
            addIndex(byStats, statsKey, index);
            addIndex(byIv, Number(pokemon.ivVal), index);
            const qualityKey = Number(pokemon.qVal).toFixed(3);
            addIndex(byQuality, qualityKey, index);
        });
        return { eligible, byId, byStats, byIv, byQuality };
    }

    function getNativeRecommendationIndex(card, lookup, usedIndices = new Set()) {
        const takeAvailable = indexes => (Array.isArray(indexes) ? indexes : [indexes])
            .find(index => index != null && !usedIndices.has(index));
        const id = getNodePokemonId(card);
        if (id && lookup.byId.has(String(id))) {
            const exactId = takeAvailable(lookup.byId.get(String(id)));
            if (exactId != null) return exactId;
        }
        const text = card.innerText || '';
        const species = lookup.eligible[0];
        if (!species || !text.toLocaleLowerCase().includes(String(species.name).toLocaleLowerCase())) return -1;
        const ivText = text.match(/\bIV\s*(\d+)/i)?.[1];
        const qualityText = text.match(/\bQ(?:uality)?\s*[×x:]?\s*(\d+(?:[.,]\d+)?)/i)?.[1];
        const iv = ivText == null ? null : Number(ivText);
        const quality = qualityText == null ? null : Number(qualityText.replace(',', '.'));
        if (iv != null && quality != null) {
            const exact = takeAvailable(lookup.byStats.get(recommendationStatsKey(iv, quality)) || []);
            if (exact != null) return exact;
            // Si la tarjeta expone ambos valores y esa combinacion no es elegible, es
            // incompatible. No debe aceptarse solo porque otro candidato comparta su IV.
            return -1;
        }
        if (iv != null && quality == null && lookup.byIv.has(iv)) {
            const ivMatch = takeAvailable(lookup.byIv.get(iv));
            if (ivMatch != null) return ivMatch;
        }
        if (quality != null && iv == null) {
            const qualityMatch = takeAvailable(lookup.byQuality.get(Number(quality).toFixed(3)) || []);
            if (qualityMatch != null) return qualityMatch;
        }
        // Si React todavia no monto los atributos estadisticos, asigna la siguiente
        // posicion libre de la especie. Nunca reutiliza el indice 0: hacerlo dejaba
        // visibles todas esas tarjetas y anulaba en la practica el limite Top N.
        if (nativeCardMatchesPokemon(card, lookup.eligible[0])) {
            return lookup.eligible.findIndex((_, index) => !usedIndices.has(index));
        }
        return -1;
    }

    function isNativeFirstParentCard(card, keeper) {
        const cardId = getNodePokemonId(card);
        if (cardId && keeper?.id && String(cardId) === String(keeper.id)) return true;
        const marker = card.querySelector('[data-parent-slot="1"],[data-slot="1"],[class*="parent-slot" i],[class*="pick-num" i],[class*="selected-num" i],[class*="slot-badge" i]');
        if (marker && /^\s*1\s*$/.test(marker.textContent || '')) return true;
        const stateDescriptor = `${card.className || ''} ${card.getAttribute('aria-selected') || ''}`;
        return /(?:^|\s)(?:selected-parent|parent-one|parent-1|picked-first)(?:\s|$)/i.test(stateDescriptor);
    }

    function getRecommendationLimit() {
        if (recommendationLimit === 'all') return Infinity;
        const numeric = Number(recommendationLimit);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : 10;
    }

    function recommendationLimitOptionsHTML() {
        return RECOMMENDATION_LIMIT_OPTIONS.map(value => {
            const selected = String(value) === String(recommendationLimit) ? ' selected' : '';
            const label = value === 'all' ? 'Todos' : `Top ${value}`;
            return `<option value="${value}"${selected}>${label}</option>`;
        }).join('');
    }

    function decorateNativePokemonBox(keeper, pairSection) {
        const boxArea = getPokemonBoxArea(pairSection);
        if (!boxArea) return;
        boxArea.querySelector('.brd-box-helper')?.remove();
        boxArea.querySelector('.brd-native-advisor-bar')?.remove();
        boxArea.querySelector('.brd-no-secondary-message')?.remove();
        boxArea.querySelectorAll('.brd-breed-recommended, .brd-breed-hidden').forEach(card => {
            card.classList.remove('brd-breed-recommended', 'brd-breed-best', 'brd-breed-hidden');
            card.removeAttribute('title');
            delete card.dataset.brdRecommendationIndex;
            card.style.removeProperty('order');
        });
        const nativeCards = getNativePokemonCards(boxArea);
        const searchInput = Array.from(boxArea.querySelectorAll('input')).find(input => /search|buscar|pok[eé]mon/i.test(input.getAttribute('placeholder') || ''));
        const placeAdvisorBar = bar => {
            if (searchInput) (searchInput.parentElement || searchInput).after(bar);
            else if (nativeCards[0]) nativeCards[0].before(bar); else boxArea.appendChild(bar);
        };
        const bindControls = bar => {
            bar.querySelector('.brd-helper-refresh')?.addEventListener('click', async event => {
                const button = event.currentTarget; button.disabled = true; button.textContent = 'Leyendo…';
                const refreshed = await refreshBreedingWorkspace();
                button.textContent = refreshed ? '✓ Actualizado' : '⚠ Sin respuesta';
                setTimeout(() => { if (button.isConnected) { button.disabled = false; button.textContent = '↻ Releer'; } }, 900);
            });
            bar.querySelector('.brd-recommendation-limit')?.addEventListener('change', event => {
                recommendationLimit = event.currentTarget.value === 'all' ? 'all' : Number(event.currentTarget.value) || 10;
                advisorSignature = '';
                runCalculatorLoop();
            });
        };
        if (!keeper) {
            const readyBar = document.createElement('div');
            readyBar.className = 'brd-native-advisor-bar';
            readyBar.innerHTML = `<span>Colección de crianza: <b>${availablePokemon.length || '…'}</b> Pokémon leídos. Selecciona el primer padre para filtrar compatibles.</span><button type="button" class="brd-helper-refresh">↻ Releer</button>`;
            placeAdvisorBar(readyBar);
            bindControls(readyBar);
            return;
        }

        const eligible = getValidSecondParents(keeper);
        const visibleLimit = getRecommendationLimit();
        const visibleRecommendationCount = Math.min(eligible.length, Number.isFinite(visibleLimit) ? visibleLimit : eligible.length);
        const minQ = Math.max(0, keeper.qVal - MAX_QUALITY_DIFF);
        const maxQ = Math.max(0, keeper.qVal);
        const bar = document.createElement('div');
        bar.className = 'brd-native-advisor-bar';
        bar.innerHTML = `<span>Segundo padre de <b>${escapeHTML(keeper.name)}</b>: mostrando ${visibleRecommendationCount} de ${eligible.length} válido(s) · Q ${minQ.toFixed(2)}–&lt;${maxQ.toFixed(2)} · cualquier IV hasta ${keeper.ivVal}</span><div class="brd-native-advisor-actions"><label class="brd-recommendation-filter">Mostrar <select class="brd-recommendation-limit" aria-label="Cantidad de padres recomendados">${recommendationLimitOptionsHTML()}</select></label><button type="button" class="brd-helper-refresh">↻ Releer</button></div>`;
        placeAdvisorBar(bar);
        bindControls(bar);

        const matchingCards = [];
        const recommendationLookup = createRecommendationLookup(eligible);
        const usedRecommendationIndices = new Set();
        nativeCards.forEach(card => {
            if (isNativeFirstParentCard(card, keeper)) {
                card.classList.add('brd-breed-hidden');
                return;
            }
            const index = getNativeRecommendationIndex(card, recommendationLookup, usedRecommendationIndices);
            if (index < 0 || index >= visibleLimit) {
                // Tras elegir el primer padre, la lista nativa solo conserva candidatos válidos de la misma especie.
                if (availablePokemon.length) card.classList.add('brd-breed-hidden');
                return;
            }
            usedRecommendationIndices.add(index);
            card.classList.add('brd-breed-recommended');
            if (index === 0) card.classList.add('brd-breed-best');
            card.dataset.brdRecommendationIndex = String(index);
            card.style.setProperty('order', String(index), 'important');
            matchingCards.push({ card, index });
            card.title = index === 0 ? 'Recomendado: es el Quality válido más bajo y ahorra Pokémon.' : 'Válido como segundo padre; usa la selección nativa.';
        });

        if (!eligible.length) {
            const emptyState = document.createElement('div');
            emptyState.className = 'brd-no-secondary-message';
            emptyState.textContent = `No hay padre secundario disponible para ${keeper.name}. Necesitas otro ${keeper.name} compatible, con Quality menor por un máximo de ${MAX_QUALITY_DIFF.toFixed(2)} y cualquier IV hasta ${keeper.ivVal}.`;
            bar.after(emptyState);
            return;
        }

        // Se muestra primero el de menor Quality (y luego mayor IV) dentro del rango: el
        // heredero conserva ambos valores superiores sin gastar material de más.
        const cardsByParent = new Map();
        matchingCards.forEach(entry => {
            const parent = entry.card.parentElement;
            if (!parent) return;
            const group = cardsByParent.get(parent) || [];
            group.push(entry);
            cardsByParent.set(parent, group);
        });
        cardsByParent.forEach((group, parent) => {
            const firstNativeCard = nativeCards.find(card => card.parentElement === parent);
            if (!firstNativeCard || group.length < 2) return;
            const marker = document.createComment('breeding-recommendations');
            parent.insertBefore(marker, firstNativeCard);
            const fragment = document.createDocumentFragment();
            group.sort((a, b) => a.index - b.index).forEach(entry => fragment.appendChild(entry.card));
            marker.after(fragment);
            marker.remove();
        });
    }

    async function refreshBreedingWorkspace() {
        // Solicita datos frescos al juego: Pokémon comprados/capturados, inventario
        // (incluidas Stones) y oferta vigente de feromonas.
        const [pokemonResult] = await Promise.all([
            refreshAvailablePokemon(true),
            refreshBreedingInventory(),
            refreshPheromoneMarketPrice()
        ]);
        await new Promise(resolve => setTimeout(resolve, 80));
        syncHuntAnalyzerKillsPerHour(true);
        advisorSignature = '';
        lastStateSignature = '';
        runCalculatorLoop();
        return Boolean(pokemonResult?.refreshed);
    }

    function saveTrackedIncubations() {
        try { localStorage.setItem(INCUBATION_STORAGE_KEY, JSON.stringify(trackedIncubations)); } catch (_) {}
    }

    function parseIncubationDurationSeconds(value) {
        const text = String(value || '').toLocaleLowerCase();
        const clock = text.match(/\b(\d{1,3}):(\d{2})(?::(\d{2}))?\b/);
        if (clock) {
            return clock[3]
                ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
                : Number(clock[1]) * 60 + Number(clock[2]);
        }
        const days = Number(text.match(/(\d+)\s*(?:d|d[ií]as?)/)?.[1] || 0);
        const hours = Number(text.match(/(\d+)\s*(?:h|horas?)/)?.[1] || 0);
        const minutes = Number(text.match(/(\d+)\s*(?:m|min(?:utos?)?)/)?.[1] || 0);
        const seconds = Number(text.match(/(\d+)\s*(?:s|seg(?:undos?)?)/)?.[1] || 0);
        return days * 86400 + hours * 3600 + minutes * 60 + seconds;
    }

    function normalizeIncubationTimestamp(value) {
        if (value == null || value === '') return 0;
        if (typeof value === 'number' || /^\d+$/.test(String(value))) {
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || numeric <= 0) return 0;
            return numeric < 1e12 ? numeric * 1000 : numeric;
        }
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function syncIncubationsFromSocketMessage(message) {
        const type = String(message?.type || '');
        if (!/(?:breed|egg|incubat|hatch|cria|ovo)/i.test(type)) return;
        const list = [message?.eggs, message?.incubations, message?.list, message?.data?.eggs, message?.data?.incubations]
            .find(Array.isArray);
        if (!list) return;
        const next = {};
        list.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object') return;
            const key = String(entry.id ?? entry.eggId ?? entry.incubatorId ?? entry.slot ?? `socket-${index}`);
            const status = String(entry.status || entry.state || '').toLocaleLowerCase();
            const ready = Boolean(entry.ready || entry.completed || entry.canHatch || /ready|complete|done|listo|pronto/i.test(status));
            const remaining = Number(entry.remainingSeconds ?? entry.secondsRemaining ?? entry.remaining ?? 0);
            const readyAt = ready ? Date.now() : normalizeIncubationTimestamp(
                entry.readyAt ?? entry.finishAt ?? entry.endsAt ?? entry.endTime ?? entry.completedAt
            ) || (remaining > 0 ? Date.now() + remaining * 1000 : trackedIncubations[key]?.readyAt || 0);
            next[key] = { readyAt, ready };
        });
        if (!list.length || Object.keys(next).length) {
            trackedIncubations = next;
            saveTrackedIncubations();
            syncBreedingDockBadge();
        }
    }

    function syncIncubationTracking(incubator) {
        if (!incubator) return;
        if (Date.now() - lastIncubationDomSyncAt < 900) return;
        lastIncubationDomSyncAt = Date.now();
        const previousSignature = JSON.stringify(trackedIncubations);
        const cards = getIncubatorEggCards(incubator);
        const activeKeys = new Set();
        cards.forEach((card, index) => {
            const key = getEggStableId(card) || `slot-${index}`;
            activeKeys.add(key);
            const text = card.innerText || '';
            const ready = /(?:ready|hatch|listo|eclosionar|pronto|chocar|finalizad|complet)/i.test(text);
            const remaining = parseIncubationDurationSeconds(text);
            const previous = trackedIncubations[key] || {};
            const computedReadyAt = remaining > 0 ? Date.now() + remaining * 1000 : 0;
            const keepPreviousDeadline = Number(previous.readyAt) > 0 && computedReadyAt > 0
                && Math.abs(Number(previous.readyAt) - computedReadyAt) < 2500;
            const readyAt = ready ? Date.now()
                : keepPreviousDeadline ? Number(previous.readyAt)
                : computedReadyAt > 0 ? computedReadyAt
                : previous.readyAt || 0;
            trackedIncubations[key] = { readyAt, ready };
        });
        // Cuando la Incubadora esta montada, su lista es la fuente de verdad. Esto
        // elimina el contador apenas el usuario abre un huevo ya terminado.
        if (cards.length || /no hay huevos|no eggs|nenhum ovo/i.test(incubator.innerText || '')) {
            Object.keys(trackedIncubations).forEach(key => {
                if (!activeKeys.has(key)) delete trackedIncubations[key];
            });
        }
        if (JSON.stringify(trackedIncubations) !== previousSignature) saveTrackedIncubations();
        syncBreedingDockBadge();
    }

    function getReadyIncubationCount() {
        const now = Date.now();
        return Object.values(trackedIncubations).filter(entry => entry?.ready || (Number(entry?.readyAt) > 0 && Number(entry.readyAt) <= now)).length;
    }

    function getBreedingDockDescriptor(node) {
        if (!(node instanceof Element)) return '';
        const attrs = ['id', 'class', 'title', 'aria-label', 'data-title', 'data-tooltip', 'data-action', 'data-target', 'href'];
        const own = attrs.map(name => node.getAttribute(name) || '').join(' ');
        const media = Array.from(node.querySelectorAll('img,svg,use')).map(icon => [
            icon.getAttribute('alt'), icon.getAttribute('title'), icon.getAttribute('src'),
            icon.getAttribute('href'), icon.getAttribute('xlink:href'), icon.getAttribute('aria-label')
        ].filter(Boolean).join(' ')).join(' ');
        return `${own} ${media} ${node.textContent || ''}`.replace(/\s+/g, ' ').trim();
    }

    function findBreedingDockButton() {
        const dock = document.querySelector('.game-dock');
        if (!dock) return null;
        if (rememberedBreedingDockButton?.isConnected && rememberedBreedingDockButton.parentElement === dock) {
            return rememberedBreedingDockButton;
        }
        const explicit = dock.querySelector('#dock-btn-breeding,#dock-btn-breed,[data-action*="breed" i],[data-target*="breed" i],[title*="breed" i],[aria-label*="breed" i],[title*="cria" i],[aria-label*="cria" i]');
        if (explicit) {
            let button = explicit;
            while (button.parentElement && button.parentElement !== dock) button = button.parentElement;
            return button;
        }
        return Array.from(dock.children).find(button => /(?:breed|breeding|cria|incubat|egg|ovo|daycare|nursery)/i.test(getBreedingDockDescriptor(button))) || null;
    }

    function syncBreedingDockBadge() {
        const dock = document.querySelector('.game-dock');
        if (!dock) return;
        const button = findBreedingDockButton();
        dock.querySelectorAll('.brd-dock-incubation-button').forEach(candidate => {
            if (candidate !== button) {
                candidate.classList.remove('brd-dock-incubation-button');
                candidate.querySelector(':scope > .brd-dock-incubation-badge')?.remove();
            }
        });
        if (!button) return;
        button.classList.add('brd-dock-incubation-button');
        const count = getReadyIncubationCount();
        let badge = button.querySelector(':scope > .brd-dock-incubation-badge');
        if (!count) { badge?.remove(); return; }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'brd-dock-incubation-badge';
            badge.setAttribute('aria-hidden', 'true');
            button.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.title = `${count} incubación${count === 1 ? '' : 'es'} lista${count === 1 ? '' : 's'} para abrir`;
    }

    document.addEventListener('click', event => {
        const dockButton = event.target.closest?.('.game-dock > *');
        if (!dockButton) return;
        setTimeout(() => {
            if (!document.querySelector('.brd-col-pair')) return;
            rememberedBreedingDockButton = dockButton;
            syncBreedingDockBadge();
        }, 120);
    }, true);

    function getIncubatorEggCards(incubator) {
        const candidates = Array.from(incubator.querySelectorAll('[data-egg-id], [data-incubator-id], .brd-egg, .brd-egg-card, .brd-incubator-item, button, li'))
            .filter(card => {
                if (card.closest('.brd-incubator-helper')) return false;
                if (card.matches('[data-egg-id],[data-incubator-id],.brd-egg,.brd-egg-card,.brd-incubator-item')) return true;
                const media = Array.from(card.querySelectorAll('img')).map(img => `${img.alt || ''} ${img.title || ''} ${img.src || ''}`).join(' ');
                return /egg|huevo|ovo/i.test(`${card.innerText || ''} ${media}`);
            });
        const explicitSelector = '[data-egg-id],[data-incubator-id],.brd-egg,.brd-egg-card,.brd-incubator-item';
        return candidates.filter(card => {
            const hasExplicitChild = candidates.some(other => other !== card && card.contains(other) && other.matches(explicitSelector));
            if (hasExplicitChild) return false;
            const hasExplicitParent = candidates.some(other => other !== card && other.contains(card) && other.matches(explicitSelector));
            return card.matches(explicitSelector) || !hasExplicitParent;
        });
    }

    function getEggPokemonName(card, fallbackName) {
        const dataName = card.dataset.pokemonName || card.dataset.speciesName || card.dataset.resultName || card.dataset.pokemon || '';
        if (dataName && !/mystery|egg|huevo/i.test(dataName)) return dataName;
        const explicitName = card.querySelector('.brd-egg-pokemon-name, .brd-egg-result-name, [data-pokemon-name]')?.textContent?.trim();
        return explicitName && !/mystery|egg|huevo/i.test(explicitName) ? explicitName : fallbackName;
    }

    function getEggStableId(card) {
        return String(card.dataset.eggId || card.dataset.incubatorId || card.dataset.id || card.id || '').trim();
    }

    function saveEggParent(stableId, parent) {
        if (!stableId || !parent) return;
        storedEggParents[stableId] = parent;
        const entries = Object.entries(storedEggParents).slice(-40);
        storedEggParents = Object.fromEntries(entries);
        try { localStorage.setItem(EGG_PARENT_STORAGE_KEY, JSON.stringify(storedEggParents)); } catch (_) {}
    }

    function decorateIncubatorEggs(incubator, parentOne, inheritance) {
        getIncubatorEggCards(incubator).forEach(card => {
            const stableId = getEggStableId(card);
            let eggParent = (stableId && storedEggParents[stableId]) || eggNodeParents.get(card) || null;
            if (!eggParent && (parentOne || lastSelectedParentOne)) {
                const source = parentOne || lastSelectedParentOne;
                eggParent = {
                    name:source.name || 'Pokémon', level:Number(source.level || 0),
                    ivVal:Number(source.ivVal || 0), qVal:Number(source.qVal || 0)
                };
                eggNodeParents.set(card, eggParent);
                saveEggParent(stableId, eggParent);
            }
            if (!eggParent) return;
            const childQuality = Number(inheritance?.child?.qVal || eggParent.qVal || 0);
            const color = getQualityColor(childQuality);
            const signature = JSON.stringify(eggParent);
            const existing = card.querySelector('.brd-egg-helper-info');
            if (existing?.dataset.parentSignature === signature) return;
            existing?.remove();
            const info = document.createElement('small');
            info.className = 'brd-egg-helper-info';
            info.dataset.parentSignature = signature;
            info.innerHTML = `<b>Padre 1: ${escapeHTML(eggParent.name)}</b><br><em>${eggParent.level > 0 ? `Nivel ${eggParent.level} · ` : ''}IV ${eggParent.ivVal}/192 · <span style="color:${color}">Quality ${eggParent.qVal.toFixed(4)}</span></em>`;
            card.appendChild(info);
        });
    }

    function renderBreedingAdvisor(parents, mode, pairSection) {
        const inheritance = getInheritance(parents, mode);
        const incubator = getAreaByLabel('incubator', '.brd-col-incubator, .brd-incubator') || pairSection;
        // No se añade un panel paralelo: los datos del huevo quedan en sus tarjetas
        // nativas del Incubator, y las recomendaciones dentro de la caja nativa.
        incubator.querySelector(':scope > .brd-incubator-helper')?.remove();
        decorateNativePokemonBox(inheritance?.keeper || null, pairSection);
        decorateIncubatorEggs(incubator, parents[0] || null, inheritance);
    }

    // 2. Extract Data from Breeding Pair
    function getSelectedParents() {
        const parents = [];
        const parentNodes = document.querySelectorAll('.brd-col-pair .brd-parent.filled');

        parentNodes.forEach((node) => {
            const name = node.querySelector('.brd-parent-name')?.textContent.trim() || 'Pokemon';
            const ivStr = node.querySelector('.brd-chip.iv')?.textContent.trim() || 'IV 0';
            const qStr = node.querySelector('.brd-chip.q')?.textContent.trim() || 'Q 0';
            const imageSrc = node.querySelector('img')?.src || '';
            const speciesMatch = imageSrc.match(/pokemon\/(\d+)/i);

            const ivMatch = ivStr.match(/\d+/);
            const ivVal = ivMatch ? parseInt(ivMatch[0], 10) : 0;

            const qMatch = qStr.match(/[\d.]+/);
            const qVal = qMatch ? parseFloat(qMatch[0]) : 0;

            const levelText = node.querySelector('.brd-parent-level, [class*="level"]')?.textContent || node.textContent || '';
            const levelMatch = levelText.match(/(?:Lv|Level|Nivel|Nv)\.?\s*(\d+)/i);
            parents.push({ id: getNodePokemonId(node), speciesId: speciesMatch?.[1] || '', name, level:levelMatch ? Number(levelMatch[1]) : 0, ivVal, qVal });
        });

        if (settings.simulateParents) {
            return [
                { name: parents[0]?.name || 'Sim P1', ivVal: settings.simParent1IV, qVal: settings.simParent1Q },
                { name: parents[1]?.name || 'Sim P2', ivVal: settings.simParent2IV, qVal: settings.simParent2Q }
            ];
        }

        return parents;
    }

    // 3. Detect Active Mode
    function getSelectedMode() {
        const activeOpt = document.querySelector('.brd-path-opt.on');
        if (!activeOpt) return 'free';

        const text = activeOpt.textContent.toLowerCase();
        return /pheromon|feromon/.test(text) ? 'pheromones' : 'free';
    }

    // 4. Detect Required Stones
    function getRequiredStones() {
        const stones = [];
        const stoneElements = document.querySelectorAll('.brd-stones-req .brd-stone-item');

        stoneElements.forEach(el => {
            const name = el.querySelector('.brd-stone-name')?.textContent.trim() || 'Stone';
            const qtyText = el.querySelector('b')?.textContent.trim() || '0×';
            const qtyMatch = qtyText.match(/\d+/);
            const baseQty = qtyMatch ? parseInt(qtyMatch[0], 10) : 0;

            stones.push({ name, baseQty });
        });

        return stones;
    }

    // 5. Detect Double Stones Checkbox
    function isDoubleStonesChecked() {
        const checkbox = document.querySelector('.brd-double input[type="checkbox"]');
        return checkbox ? checkbox.checked : false;
    }

    // Helper: Calculate Subchain Breeding Cost for Secondary Materials (> 1.80 Q)
    function calculateSubchainCostForBreed(currentQ, mode, avgQDelta, singleBreedStonesCost) {
        if (!settings.includeSubchainCost) return 0;

        const reqSecQ = Math.max(0, currentQ - MAX_QUALITY_DIFF);
        if (reqSecQ <= WILD_MAX_QUALITY) return 0;

        const diffToBreed = reqSecQ - WILD_MAX_QUALITY;
        const subSteps = Math.ceil(diffToBreed / avgQDelta);

        const subBaseCost = subSteps * COST_PER_BREED_GOLD;
        const subPheroCost = mode === 'pheromones' ? (subSteps * PHEROMONES_PER_BREED * settings.pheromoneUnitPrice) : 0;
        const subStonesCost = subSteps * singleBreedStonesCost;

        return subBaseCost + subPheroCost + subStonesCost;
    }

    // 6. Generate Optimized Payload for Export (Deduplicated Progressive Steps)
    function generateExportPayload() {
        const parents = getSelectedParents();
        const mode = getSelectedMode();
        const requiredStones = getRequiredStones();
        const doubleStones = isDoubleStonesChecked();

        let bestParent = parents[0] || null;
        let otherParent = parents[1] || null;

        if (parents.length > 1 && parents[1].qVal > parents[0].qVal) {
            bestParent = parents[1];
            otherParent = parents[0];
        }

        const avgQDelta = GROWTH_RATES[settings.growthType][mode];
        const stoneMultiplier = doubleStones ? 2 : 1;

        let singleBreedStonesCost = 0;
        if (settings.useStonesCost) {
            requiredStones.forEach(st => {
                const unitPrice = settings.stonePrices[st.name] || 0;
                singleBreedStonesCost += (st.baseQty * stoneMultiplier) * unitPrice;
            });
        }

        const projections = [];
        let maxBreedsNeededOverall = 0;

        if (bestParent && bestParent.qVal > 0) {
            QUALITY_TIERS.forEach(tier => {
                if (bestParent.qVal < tier.min) {
                    const diff = tier.min - bestParent.qVal;
                    const breedsNeeded = Math.ceil(diff / avgQDelta);
                    if (breedsNeeded > maxBreedsNeededOverall) {
                        maxBreedsNeededOverall = breedsNeeded;
                    }

                    const killsNeeded = breedsNeeded * KILLS_PER_EGG;
                    const hoursNeeded = settings.killsPerHour > 0 ? parseFloat((killsNeeded / settings.killsPerHour).toFixed(1)) : null;

                    const totalPheromones = breedsNeeded * PHEROMONES_PER_BREED;
                    const baseCostTotal = breedsNeeded * COST_PER_BREED_GOLD;
                    const pheroPriceAvailable = Boolean(pheromoneMarket.selected);
                    const pheroCostTotal = mode === 'pheromones' && pheroPriceAvailable ? totalPheromones * settings.pheromoneUnitPrice : 0;
                    const stonesCostTotal = breedsNeeded * singleBreedStonesCost;

                    // Calculate Subchain Costs if Enabled
                    let subchainCostTotal = 0;
                    if (settings.includeSubchainCost) {
                        let stepQ = bestParent.qVal;
                        for (let s = 0; s < breedsNeeded; s++) {
                            subchainCostTotal += calculateSubchainCostForBreed(stepQ, mode, avgQDelta, singleBreedStonesCost);
                            stepQ += avgQDelta;
                        }
                    }

                    const totalCostGold = baseCostTotal + pheroCostTotal + stonesCostTotal + subchainCostTotal;
                    const expectedIvGain = doubleStones ? Math.floor(breedsNeeded / 20) : 0;

                    projections.push({
                        tier: tier.label,
                        targetQualityMin: tier.min,
                        breedsNeeded,
                        expectedIvGain,
                        killsNeeded,
                        hoursNeeded,
                        pheromonesNeeded: mode === 'pheromones' ? totalPheromones : 0,
                        costs: {
                            baseFeeGold: baseCostTotal,
                            pheromonesGold: pheroCostTotal,
                            stonesGold: stonesCostTotal,
                            subchainSecGold: subchainCostTotal,
                            totalGold: totalCostGold
                        }
                    });
                }
            });
        }

        // Single continuous progressive sequence up to highest tier needed
        const progressiveMaterialSequence = [];
        if (bestParent && bestParent.qVal > 0 && maxBreedsNeededOverall > 0) {
            let currentQ = bestParent.qVal;
            for (let step = 1; step <= maxBreedsNeededOverall; step++) {
                const childQ = currentQ + avgQDelta;
                const minSecQ = Math.max(0, currentQ - MAX_QUALITY_DIFF);
                const maxSecQ = Math.max(0, currentQ - 0.01);
                const requiresBreeding = minSecQ > WILD_MAX_QUALITY;

                progressiveMaterialSequence.push({
                    breedStep: step,
                    minSecondaryQuality: parseFloat(minSecQ.toFixed(4)),
                    maxSecondaryQuality: parseFloat(maxSecQ.toFixed(4)),
                    childResultingQuality: parseFloat(childQ.toFixed(4)),
                    secondarySourceType: requiresBreeding ? 'Criado' : 'Salvaje',
                    targetTierReached: getTierLabelForQ(childQ)
                });

                currentQ = childQ;
            }
        }

        return {
            exportTimestamp: new Date().toISOString(),
            parents: {
                parent1: parents[0] ? { name: parents[0].name, iv: parents[0].ivVal, quality: parents[0].qVal } : null,
                parent2: parents[1] ? { name: parents[1].name, iv: parents[1].ivVal, quality: parents[1].qVal } : null,
                inheritedBestParent: bestParent ? { name: bestParent.name, iv: bestParent.ivVal, quality: bestParent.qVal } : null
            },
            settings: {
                calculationMode: mode,
                growthSystem: settings.growthType === 'avg' ? 'Promedio' : 'Mínimo',
                growthDeltaPerBreed: avgQDelta,
                pheromoneUnitPrice: settings.pheromoneUnitPrice,
                killsPerHour: settings.killsPerHour,
                useStonesCost: settings.useStonesCost,
                includeSubchainCost: settings.includeSubchainCost,
                doubleStonesActive: doubleStones,
                stonePrices: settings.stonePrices,
                requiredStones: requiredStones.map(st => ({
                    name: st.name,
                    baseQty: st.baseQty,
                    effectiveQtyPerBreed: st.baseQty * stoneMultiplier,
                    unitPrice: settings.stonePrices[st.name] || 0
                }))
            },
            projections,
            progressiveMaterialSequence
        };
    }

    // 7. Convert Payload to CSV Format (Clean & Deduplicated)
    function convertPayloadToCSV(payload) {
        let csv = '\uFEFF'; // BOM UTF-8

        csv += 'Paso de crianza,Nombre del padre,IV del padre,Quality del padre,Quality secundaria mínima,Quality secundaria máxima,Origen secundario,Quality resultante de la cría,Tier alcanzado,Modo,Sistema de crecimiento,Costo total en oro\n';

        const pName = payload.parents.inheritedBestParent ? payload.parents.inheritedBestParent.name : '';
        const pIv = payload.parents.inheritedBestParent ? payload.parents.inheritedBestParent.iv : '';
        const pQ = payload.parents.inheritedBestParent ? payload.parents.inheritedBestParent.quality : '';
        const mode = payload.settings.calculationMode;
        const growth = payload.settings.growthSystem;

        payload.progressiveMaterialSequence.forEach(s => {
            const baseCost = s.breedStep * COST_PER_BREED_GOLD;
            csv += `${s.breedStep},"${pName}",${pIv},${pQ},${s.minSecondaryQuality},${s.maxSecondaryQuality},"${s.secondarySourceType}",${s.childResultingQuality},"${s.targetTierReached}","${mode}","${growth}",${baseCost}\n`;
        });

        return csv;
    }

    // 8. Main Render Loop
    function runCalculatorLoop() {
        const pairSection = document.querySelector('.brd-col-pair');

        if (!pairSection) {
            lastStateSignature = '';
            return;
        }
        translateBreedingInterface(pairSection);
        syncHuntAnalyzerKillsPerHour();

        if (!document.querySelector('.brd-custom-box')) {
            const customBox = document.createElement('div');
            customBox.className = 'brd-custom-box';

            customBox.innerHTML = `
                <div class="brd-custom-head">CALCULADORA</div>
                <div class="brd-custom-content">
                    <div class="brd-no-poke">Selecciona Pokémon en la pareja de crianza</div>
                </div>
            `;

            pairSection.appendChild(customBox);
            lastStateSignature = '';
        }

        const parents = getSelectedParents();
        const mode = getSelectedMode();
        const requiredStones = getRequiredStones();
        const doubleStones = isDoubleStonesChecked();
        if (!settings.simulateParents && parents[0]) {
            lastSelectedParentOne = {
                name:parents[0].name, level:Number(parents[0].level || 0),
                ivVal:Number(parents[0].ivVal || 0), qVal:Number(parents[0].qVal || 0)
            };
        }
        const incubatorArea = getAreaByLabel('incubator', '.brd-col-incubator, .brd-incubator') || pairSection;
        decorateIncubatorEggs(incubatorArea, parents[0] || null, getInheritance(parents, mode));
        syncIncubationTracking(incubatorArea);

        if (!availablePokemon.length && !pokemonRefreshPromise) refreshAvailablePokemon();
        const pheromoneRefreshDelay = pheromoneMarket.selected ? PHEROMONE_MARKET_REFRESH_MS : PHEROMONE_MARKET_RETRY_MS;
        if (!pheromoneMarketRefreshPromise
            && (!pheromoneMarket.updatedAt || Date.now() - pheromoneMarket.updatedAt >= pheromoneRefreshDelay)) {
            // Lectura directa del API original del juego al abrir el panel y cada minuto.
            refreshPheromoneMarketPrice();
        }
        const nextAdvisorSignature = JSON.stringify({ parents, mode, pokemonVersion: availablePokemonVersion, growthType: settings.growthType });
        const nativeBoxArea = getPokemonBoxArea(pairSection);
        const nativeCardsNow = nativeBoxArea ? getNativePokemonCards(nativeBoxArea) : [];
        const nativeDecorationMissing = Boolean(parents.length && availablePokemon.length && nativeCardsNow.some(card =>
            !card.classList.contains('brd-breed-recommended') && !card.classList.contains('brd-breed-hidden')
        ));
        const decoratedOrder = nativeCardsNow.filter(card => card.classList.contains('brd-breed-recommended'))
            .map(card => Number(card.dataset.brdRecommendationIndex));
        const nativeOrderIncorrect = decoratedOrder.some((index, position) => position > 0 && index < decoratedOrder[position - 1]);
        if (nextAdvisorSignature !== advisorSignature
            || !nativeBoxArea?.querySelector('.brd-native-advisor-bar')
            || nativeDecorationMissing
            || nativeOrderIncorrect) {
            advisorSignature = nextAdvisorSignature;
            renderBreedingAdvisor(parents, mode, pairSection);
        }

        const currentStateSignature = JSON.stringify({ parents, mode, requiredStones, doubleStones, pokemonVersion: availablePokemonVersion, settings });

        if (currentStateSignature === lastStateSignature) return;
        lastStateSignature = currentStateSignature;

        const boxEl = document.querySelector('.brd-custom-box');
        if (!boxEl) return;

        if (parents.length === 0) {
            boxEl.innerHTML = `
                <div class="brd-custom-head">CALCULADORA</div>
                <div class="brd-custom-content">
                    <div class="brd-no-poke">Selecciona Pokémon en la pareja de crianza</div>
                </div>
            `;
            return;
        }

        // Preserve Scroll
        const contentContainerPrev = document.querySelector('.brd-custom-content');
        const prevScrollTop = contentContainerPrev ? contentContainerPrev.scrollTop : 0;

        const activeEl = document.activeElement;
        const activeId = activeEl ? activeEl.id : null;
        let cursorPosStart = 0;
        let cursorPosEnd = 0;

        if (activeEl && activeEl.tagName === 'INPUT' && activeEl.type === 'text') {
            cursorPosStart = activeEl.selectionStart;
            cursorPosEnd = activeEl.selectionEnd;
        }

        // Find Best Parent by Q
        let bestParent = parents[0];
        let otherParent = null;

        if (parents.length > 1) {
            if (parents[1].qVal > parents[0].qVal) {
                bestParent = parents[1];
                otherParent = parents[0];
            } else {
                otherParent = parents[1];
            }
        }

        // IV Warning Tooltip
        const isLosingIv = otherParent && (otherParent.ivVal >= bestParent.ivVal + 1);
        const warnIconHtml = isLosingIv
            ? `<img class="brd-iv-warn-ico" alt="Advertencia" title="¡Advertencia de pérdida de IV! El padre con mayor Quality tiene menor IV (otro padre: IV ${otherParent.ivVal})" src="/assets/topmenu/playerWarning.png">`
            : '';

        // Growth Delta
        const avgQDelta = GROWTH_RATES[settings.growthType][mode];
        const projectedQVal = bestParent.qVal + avgQDelta;
        const projectedQStr = `Q ${projectedQVal.toFixed(4)}`;

        const qColor = getQualityColor(projectedQVal);
        const modeLabel = mode === 'pheromones' ? 'MODO PHEROMONES' : 'MODO GRATUITO';
        const growthTypeLabel = settings.growthType === 'avg' ? 'PROMEDIO' : 'MÍNIMO';

        const stoneMultiplier = doubleStones ? 2 : 1;

        let singleBreedStonesCost = 0;
        if (settings.useStonesCost) {
            requiredStones.forEach(st => {
                const unitPrice = settings.stonePrices[st.name] || 0;
                singleBreedStonesCost += (st.baseQty * stoneMultiplier) * unitPrice;
            });
        }

        // Fixed Top Blocks
        let htmlBox = `
            <div class="brd-custom-head">CALCULADORA</div>
        `;

        if (settings.simulateParents) {
            htmlBox += `
            <div class="brd-settings-row" style="margin-bottom: 6px; justify-content: center; background: rgba(0, 0, 0, 0.4); padding: 4px; border-radius: 4px; border: 1px dashed rgba(216, 184, 113, 0.3);">
                <div class="brd-setting-item">
                    <span style="color: #d8b871; font-weight: bold;">P1 IV:</span>
                    <input type="text" id="simP1IvInput" value="${settings.simParent1IV}" inputmode="numeric" autocomplete="off" style="width:35px;">
                </div>
                <div class="brd-setting-item">
                    <span style="color: #d8b871; font-weight: bold;">P1 Q:</span>
                    <input type="text" id="simP1QInput" value="${settings.simParent1QRaw !== undefined ? settings.simParent1QRaw : settings.simParent1Q}" autocomplete="off" style="width:45px;">
                </div>
                <div class="brd-setting-item">
                    <span style="color: #d8b871; font-weight: bold;">P2 IV:</span>
                    <input type="text" id="simP2IvInput" value="${settings.simParent2IV}" inputmode="numeric" autocomplete="off" style="width:35px;">
                </div>
                <div class="brd-setting-item">
                    <span style="color: #d8b871; font-weight: bold;">P2 Q:</span>
                    <input type="text" id="simP2QInput" value="${settings.simParent2QRaw !== undefined ? settings.simParent2QRaw : settings.simParent2Q}" autocomplete="off" style="width:45px;">
                </div>
            </div>
            `;
        }

        htmlBox += `
            <div class="brd-poke-info">
                <span class="brd-poke-tag">Cría</span>
                <span class="brd-poke-name">${bestParent.name}</span>
                <div class="brd-poke-stats">
                    <span class="brd-stat-chip iv">${warnIconHtml}IV ${bestParent.ivVal}</span>
                    <span class="brd-stat-chip q" style="color: ${qColor}; border-color: ${qColor};" title="Quality del mejor padre (${bestParent.qVal}) + ΔQ (${avgQDelta})">${projectedQStr}</span>
                </div>
            </div>
            <div class="brd-custom-content">
        `;

        // Scrollable Tiers
        if (bestParent.qVal > 0) {
            htmlBox += `
                <div class="brd-tiers-container">
                    <div class="brd-tier-title">Crianza estimada (${modeLabel} - ${growthTypeLabel})</div>
            `;

            QUALITY_TIERS.forEach(tier => {
                if (bestParent.qVal < tier.min) {
                    const diff = tier.min - bestParent.qVal;
                    const breedsNeeded = Math.ceil(diff / avgQDelta);
                    const killsNeeded = breedsNeeded * KILLS_PER_EGG;

                    let timeStr = '';
                    if (settings.killsPerHour > 0) {
                        const hoursNeeded = (killsNeeded / settings.killsPerHour).toFixed(1);
                        timeStr = ` - ${hoursNeeded}h`;
                    }

                    // Calculate Double Stone IV Bonus Tag
                    let ivGainTagHtml = '';
                    if (doubleStones) {
                        const expectedIvGain = Math.floor(breedsNeeded / 20);
                        if (expectedIvGain >= 1) {
                            ivGainTagHtml = `<span class="brd-iv-gain-tag" title="Aumento esperado de IV con Stones dobles: +${expectedIvGain} IV durante ${breedsNeeded} crianzas (5% por crianza)">+${expectedIvGain} IV</span>`;
                        }
                    }

                    const totalPheromones = breedsNeeded * PHEROMONES_PER_BREED;
                    const baseCostTotal = breedsNeeded * COST_PER_BREED_GOLD;
                    const pheroPriceAvailable = Boolean(pheromoneMarket.selected);
                    const pheroCostTotal = mode === 'pheromones' && pheroPriceAvailable
                        ? totalPheromones * settings.pheromoneUnitPrice : 0;
                    const stonesCostTotal = breedsNeeded * singleBreedStonesCost;

                    // Calculate Subchain Costs if Enabled
                    let subchainCostTotal = 0;
                    if (settings.includeSubchainCost) {
                        let stepQ = bestParent.qVal;
                        for (let s = 0; s < breedsNeeded; s++) {
                            subchainCostTotal += calculateSubchainCostForBreed(stepQ, mode, avgQDelta, singleBreedStonesCost);
                            stepQ += avgQDelta;
                        }
                    }

                    const totalCostGold = baseCostTotal + pheroCostTotal + stonesCostTotal + subchainCostTotal;
                    const costInMillions = (totalCostGold / 1000000).toLocaleString(undefined, { maximumFractionDigits: 1 });

                    let costTooltip = `Costo base: ${formatM(baseCostTotal)}`;
                    if (mode === 'pheromones') {
                        costTooltip += pheroPriceAvailable
                            ? `\nPheromones: ${formatM(pheroCostTotal)}`
                            : '\nPheromones: sin precio disponible del market (no incluido)';
                    }
                    if (settings.useStonesCost && stonesCostTotal > 0) {
                        costTooltip += `\nStones: ${formatM(stonesCostTotal)}`;
                    }
                    if (settings.includeSubchainCost && subchainCostTotal > 0) {
                        costTooltip += `\nSubcadena secundaria (>1.80Q): ${formatM(subchainCostTotal)}`;
                    }
                    costTooltip += `\n${mode === 'pheromones' && !pheroPriceAvailable ? 'Total parcial' : 'Total'}: ${formatM(totalCostGold)}`;

                    const tierLabelColor = getQualityColor(tier.min);
                    const isExpanded = settings.expandedTierLabel === tier.label;
                    const activeRowClass = isExpanded ? 'active' : '';

                    htmlBox += `
                        <div class="brd-tier-row ${activeRowClass}" data-tierlabel="${tier.label}">
                            <span>
                                <strong class="brd-tier-label" style="color: ${tierLabelColor};">${tier.label}</strong>
                                <span class="brd-tier-target">(${tier.min.toFixed(1)}+)</span>
                            </span>
                            <div class="brd-tier-right">
                                <span class="brd-tier-count">
                                    ~${breedsNeeded.toLocaleString()} ${breedsNeeded === 1 ? 'crianza' : 'crianzas'}
                                    ${ivGainTagHtml}
                                </span>
                                <span class="brd-tier-kills" title="Derrotados necesarios en hunt (${killsNeeded.toLocaleString()})">(${formatKills(killsNeeded)}${timeStr})</span>
                                ${mode === 'pheromones' ? `
                                    <span class="brd-tier-phero" title="Total de Pheromones necesarios">
                                        <img alt="Strange Pheromone" width="13" height="13" draggable="false" src="/assets/items/strange_pheromone.png">
                                        ${totalPheromones.toLocaleString()}
                                    </span>
                                ` : ''}
                                <span class="brd-tier-cost" title="${costTooltip}">
                                    <img class="brd-cur-ico" alt="$" width="13" height="13" draggable="false" src="/assets/market/dollar.png">
                                    $${costInMillions}M
                                </span>
                            </div>
                        </div>
                    `;

                    // Material Breakdown Subsection
                    if (isExpanded) {
                        htmlBox += `
                            <div class="brd-subtiers-wrap">
                                <div class="brd-subtiers-head">Materiales paso a paso (reducción de -0.01)</div>
                                <div class="brd-subtiers-scroll">
                        `;

                        let currentQ = bestParent.qVal;
                        for (let step = 1; step <= breedsNeeded; step++) {
                            const childQ = currentQ + avgQDelta;

                            const minSecQ = Math.max(0, currentQ - MAX_QUALITY_DIFF);
                            const maxSecQ = Math.max(0, currentQ - 0.01);

                            const minSecColor = getQualityColor(minSecQ);
                            const maxSecColor = getQualityColor(maxSecQ);
                            const childColor = getQualityColor(childQ);

                            const isBredSec = minSecQ > WILD_MAX_QUALITY;
                            const secTagHtml = isBredSec 
                                ? `<span class="brd-subtier-tag bred" title="El material secundario supera el límite salvaje (1.80 Q) y debe criarse antes.">🧬 Criado (>1.80)</span>`
                                : `<span class="brd-subtier-tag wild" title="Puede capturarse directamente en estado salvaje (≤ 1.80 Q).">🎯 Salvaje</span>`;

                            htmlBox += `
                                <div class="brd-subtier-item">
                                    <span class="brd-subtier-step">Crianza #${step}</span>
                                    <span>Sec.: <strong class="brd-subtier-q" style="color: ${minSecColor};">Q ${minSecQ.toFixed(2)}</strong> a <strong class="brd-subtier-q" style="color: ${maxSecColor};">Q ${maxSecQ.toFixed(2)}</strong> ${secTagHtml}</span>
                                    <span>Cría: <strong class="brd-subtier-q" style="color: ${childColor};">Q ${childQ.toFixed(4)}</strong></span>
                                </div>
                            `;

                            currentQ = childQ;
                        }

                        htmlBox += `
                                </div>
                            </div>
                        `;
                    }
                }
            });

            htmlBox += `</div>`;
        }

        // Settings Section
        const foldArrow = settings.isFolded ? '►' : '▼';
        const bodyClass = settings.isFolded ? 'hidden' : '';

        let stonesInputsHtml = '';
        if (requiredStones.length > 0) {
            stonesInputsHtml += `<div class="brd-stones-settings-container">`;
            stonesInputsHtml += `
                <label class="brd-checkbox-label">
                    <input type="checkbox" id="useStonesCheckbox" ${settings.useStonesCost ? 'checked' : ''}>
                    <span>Calcular con Stones (${doubleStones ? '2× Doble activo' : '1× Normal'})</span>
                </label>
            `;

            requiredStones.forEach((st, idx) => {
                const currentPrice = settings.stonePrices[st.name] || '';
                const disabledAttr = settings.useStonesCost ? '' : 'disabled';
                const effectiveQty = st.baseQty * stoneMultiplier;

                stonesInputsHtml += `
                    <div class="brd-setting-item" style="justify-content: space-between;">
                        <span>$ ${st.name} (${effectiveQty}×):</span>
                        <input type="text" class="stone-price-input" data-stonename="${st.name}" id="stoneInput_${idx}" value="${currentPrice}" placeholder="0" inputmode="numeric" autocomplete="off" ${disabledAttr}>
                    </div>
                `;
            });
            stonesInputsHtml += `</div>`;
        }

        const pheromoneMarketDisplay = getPheromoneMarketDisplay();
        htmlBox += `
            <div class="brd-settings-wrap">
                <span class="brd-settings-toggle" id="settingsToggleBtn">${foldArrow} Configuración</span>
                <div class="brd-settings-body ${bodyClass}">
                    <div class="brd-settings-row">
                        <div class="brd-setting-item">
                            <span>Pheromone:</span>
                            <span class="brd-market-price ${pheromoneMarketDisplay.className}" title="${escapeHTML(pheromoneMarketDisplay.title)}">${pheromoneMarketDisplay.label}</span>
                            <button type="button" class="brd-market-refresh" id="refreshPheromoneMarketBtn" title="Actualizar precio actual del market">↻</button>
                        </div>
                        <div class="brd-setting-item">
                            <span>Derrotados/h:</span>
                            <input type="text" id="killsPerHourInput" value="${settings.killsPerHour || ''}" placeholder="Abre Hunt Analyzer" readonly title="Valor automático del Hunt Analyzer actual">
                            <small class="brd-auto-source">Automático</small>
                        </div>
                    </div>
                    ${stonesInputsHtml}
                    <div class="brd-settings-row">
                        <label class="brd-checkbox-label" title="Añade el costo de criar materiales secundarios que superen el límite salvaje de Quality 1.80">
                            <input type="checkbox" id="includeSubchainCheckbox" ${settings.includeSubchainCost ? 'checked' : ''}>
                            <span>Incluir costos de subcrianza (Sec. &gt; 1.80 Q)</span>
                        </label>
                    </div>
                    <div class="brd-settings-row">
                        <label class="brd-checkbox-label" title="Simular IV y Quality de los padres">
                            <input type="checkbox" id="simulateParentsCheckbox" ${settings.simulateParents ? 'checked' : ''}>
                            <span>Simular padres</span>
                        </label>
                    </div>
                    <div class="brd-settings-row">
                        <span>Sistema de crecimiento:</span>
                        <div class="brd-radio-group">
                            <label title="Crecimiento promedio (+0.0096 gratis / +0.1875 Pheromone)">
                                <input type="radio" name="growthRadio" value="avg" ${settings.growthType === 'avg' ? 'checked' : ''}>
                                Promedio
                            </label>
                            <label title="Crecimiento mínimo (+0.0050 gratis / +0.1500 Pheromone)">
                                <input type="radio" name="growthRadio" value="min" ${settings.growthType === 'min' ? 'checked' : ''}>
                                Mínimo
                            </label>
                        </div>
                    </div>
                    <div class="brd-export-row">
                        <button type="button" class="brd-export-btn" id="exportJsonBtn" title="Copiar todos los datos JSON al portapapeles">Exportar JSON</button>
                        <button type="button" class="brd-export-btn" id="exportCsvBtn" title="Copiar todos los datos CSV al portapapeles">Exportar CSV</button>
                    </div>
                </div>
            </div>
            </div>
        `;

        boxEl.innerHTML = htmlBox;

        // Restore Scroll
        const contentContainerNew = document.querySelector('.brd-custom-content');
        if (contentContainerNew) {
            contentContainerNew.scrollTop = prevScrollTop;
        }

        // Listeners
        const tierRows = document.querySelectorAll('.brd-tier-row');
        tierRows.forEach(row => {
            row.addEventListener('click', (e) => {
                const label = row.getAttribute('data-tierlabel');
                settings.expandedTierLabel = (settings.expandedTierLabel === label) ? null : label;
                lastStateSignature = '';
            });
        });

        const toggleBtn = document.getElementById('settingsToggleBtn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                settings.isFolded = !settings.isFolded;
                lastStateSignature = '';
            });
        }

        const useStonesCb = document.getElementById('useStonesCheckbox');
        if (useStonesCb) {
            useStonesCb.addEventListener('change', (e) => {
                settings.useStonesCost = e.target.checked;
                lastStateSignature = '';
            });
        }

        const includeSubchainCb = document.getElementById('includeSubchainCheckbox');
        if (includeSubchainCb) {
            includeSubchainCb.addEventListener('change', (e) => {
                settings.includeSubchainCost = e.target.checked;
                lastStateSignature = '';
            });
        }

        const simulateParentsCb = document.getElementById('simulateParentsCheckbox');
        if (simulateParentsCb) {
            simulateParentsCb.addEventListener('change', (e) => {
                settings.simulateParents = e.target.checked;
                lastStateSignature = '';
            });
        }

        const simP1IvInput = document.getElementById('simP1IvInput');
        if (simP1IvInput) {
            simP1IvInput.addEventListener('input', (e) => {
                let cleanVal = e.target.value.replace(/\D/g, '');
                e.target.value = cleanVal;
                settings.simParent1IV = parseInt(cleanVal, 10) || 0;
                lastStateSignature = '';
            });
        }

        const simP1QInput = document.getElementById('simP1QInput');
        if (simP1QInput) {
            simP1QInput.addEventListener('input', (e) => {
                let cleanVal = e.target.value.replace(/[^\d.]/g, '');
                if (cleanVal.split('.').length > 2) cleanVal = cleanVal.replace(/\.+$/, '');
                const parts = cleanVal.split('.');
                if (parts.length === 2 && parts[1].length > 4) {
                    cleanVal = parts[0] + '.' + parts[1].substring(0, 4);
                }
                e.target.value = cleanVal;
                settings.simParent1QRaw = cleanVal;
                settings.simParent1Q = parseFloat(cleanVal) || 0;
                lastStateSignature = '';
            });
        }

        const simP2IvInput = document.getElementById('simP2IvInput');
        if (simP2IvInput) {
            simP2IvInput.addEventListener('input', (e) => {
                let cleanVal = e.target.value.replace(/\D/g, '');
                e.target.value = cleanVal;
                settings.simParent2IV = parseInt(cleanVal, 10) || 0;
                lastStateSignature = '';
            });
        }

        const simP2QInput = document.getElementById('simP2QInput');
        if (simP2QInput) {
            simP2QInput.addEventListener('input', (e) => {
                let cleanVal = e.target.value.replace(/[^\d.]/g, '');
                if (cleanVal.split('.').length > 2) cleanVal = cleanVal.replace(/\.+$/, '');
                const parts = cleanVal.split('.');
                if (parts.length === 2 && parts[1].length > 4) {
                    cleanVal = parts[0] + '.' + parts[1].substring(0, 4);
                }
                e.target.value = cleanVal;
                settings.simParent2QRaw = cleanVal;
                settings.simParent2Q = parseFloat(cleanVal) || 0;
                lastStateSignature = '';
            });
        }

        const stoneInputs = document.querySelectorAll('.stone-price-input');
        stoneInputs.forEach(input => {
            input.addEventListener('input', (e) => {
                let cleanVal = e.target.value.replace(/\D/g, '');
                e.target.value = cleanVal;
                const stoneName = e.target.getAttribute('data-stonename');
                const val = parseInt(cleanVal, 10);
                settings.stonePrices[stoneName] = isNaN(val) ? 0 : val;
                lastStateSignature = '';
            });
        });

        const refreshPheromoneButton = document.getElementById('refreshPheromoneMarketBtn');
        if (refreshPheromoneButton) {
            refreshPheromoneButton.addEventListener('click', async event => {
                event.currentTarget.disabled = true;
                event.currentTarget.textContent = '…';
                await refreshPheromoneMarketPrice();
            });
        }

        const killsInput = document.getElementById('killsPerHourInput');
        if (killsInput) {
            killsInput.value = settings.killsPerHour > 0 ? String(settings.killsPerHour) : '';
        }

        const radios = document.querySelectorAll('input[name="growthRadio"]');
        radios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                settings.growthType = e.target.value;
                lastStateSignature = '';
            });
        });

        // Export Handlers
        const exportJsonBtn = document.getElementById('exportJsonBtn');
        if (exportJsonBtn) {
            exportJsonBtn.addEventListener('click', () => {
                const payload = generateExportPayload();
                const jsonText = JSON.stringify(payload, null, 2);
                navigator.clipboard.writeText(jsonText).then(() => {
                    exportJsonBtn.textContent = '¡Copiado!';
                    setTimeout(() => { exportJsonBtn.textContent = 'Exportar JSON'; }, 1500);
                }).catch(err => {
                    console.error('Clipboard error:', err);
                });
            });
        }

        const exportCsvBtn = document.getElementById('exportCsvBtn');
        if (exportCsvBtn) {
            exportCsvBtn.addEventListener('click', () => {
                const payload = generateExportPayload();
                const csvText = convertPayloadToCSV(payload);
                navigator.clipboard.writeText(csvText).then(() => {
                    exportCsvBtn.textContent = '¡Copiado!';
                    setTimeout(() => { exportCsvBtn.textContent = 'Exportar CSV'; }, 1500);
                }).catch(err => {
                    console.error('Clipboard error:', err);
                });
            });
        }

        // Restore Focus
        if (activeId) {
            const restoredEl = document.getElementById(activeId);
            if (restoredEl) {
                restoredEl.focus();
                try {
                    restoredEl.setSelectionRange(cursorPosStart, cursorPosEnd);
                } catch (err) {}
            }
        }
    }

    // Precarga la colección antes de elegir un padre. Si el HUD aún no terminó de
    // montar, el intervalo posterior vuelve a intentarlo sin recargar la página.
    setTimeout(() => refreshBreedingWorkspace(), 1000);
    setInterval(runCalculatorLoop, 250);
    setInterval(() => {
        if (document.querySelector('.brd-col-pair')) refreshAvailablePokemon();
    }, 5000);
    // Mantiene el costo de feromonas alineado con la oferta más barata del market.
    setInterval(() => {
        if (document.querySelector('.brd-col-pair')) refreshPheromoneMarketPrice();
    }, PHEROMONE_MARKET_REFRESH_MS);
    setInterval(syncBreedingDockBadge, 1000);
})();
