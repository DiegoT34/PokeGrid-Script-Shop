// ==UserScript==
// @name         PokeIdle Exact IV Scanner (Pro Suite) 56.0
// @namespace    http://tampermonkey.net/
// @version      56.5.0
// @description  CALCULATOR iVS PRO. Sincronización automática del Pokémon equipado, lectura por hover y resaltado de IV 32 perfecto.
// @match        *://poke.idleworld.online/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.ocr.space
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    let currentPokeData = null;
    let isPanelOpen = false;
    let baseStatsCache = JSON.parse(localStorage.getItem('pokeidle_basestats_cache') || '{}');
    
    // Configuración por defecto
    let defaultCfg = { hotkey:"i", btnSize:12, btnLeft:"20px", btnTop:"", btnBottom:"20px", showBtn: true, lang: "es", theme: "neon" };
    let config = JSON.parse(localStorage.getItem('pokeidle_iv_config')) || {};
    config = { ...defaultCfg, ...config }; 
    
    let domScanTimeout = null;
    let tooltipScanTimeout = null;
    let cardHoverTimeout = null;
    let lastTooltipText = "";
    let lastHoveredPokemonCard = null;
    let allKnownPokemon = new Set(); 
    let lastEquippedPoke = null; 

    // --- DICCIONARIO MULTILENGUAJE ---
    const i18n = {
        es: {
            title: "CALC iVS PRO", tabCalc: "Panel", tabMarket: "Market", tabConfig: "Config",
            pokeLabel: "Pokémon (Escribe/Clic):", level: "Nivel:", mult: "Mult (Q):",
            waiting: "Esperando datos...", fillStats: "Rellena los stats para evaluar", ivTotal: "POTENCIAL", effTotal: "Eficiencia total", 
            classif: "CLASIFICACIÓN", indIv: "IVs", perfByStat: "Desempeño individual", power: "PODER",
            btnImg: "📷 Subir Img", btnEquip: "🎒 Equipado", statusStart: "Escanea stats o sube captura",
            marketTitle: "🛒 Auto Market",
            marketDesc1: "Escáner <b style='color:var(--accent);'>ACTIVO</b>.<br><br>Pasa el cursor por la mochila o haz clic en stats.",
            marketDesc2: "Los datos se cargarán en segundo plano. Abre el panel manualmente cuando quieras consultarlos.",
            cfgHotkey: "Tecla rápida (Alt+Letra):", cfgBtnSize: "Tamaño botón (px):", cfgShowBtn: "Mostrar botón flotante",
            cfgLang: "Idioma:", cfgTheme: "Tema visual:", btnReset: "🔄 Restaurar posición", btnSave: "Guardar", saved: "✅ ¡Guardado!",
            msgCloudPrep: "☁️ Nube...", msgCloudAnal: "☁️ Analizando...", msgCloudOk: "✅ ¡Ok!", msgCloudFail: "⚠️ Fallo.",
            msgEquipOk: "✅ ¡Cargado!", msgEquipFail: "⚠️ Abre la mochila.", msgMktOk: "✅ ¡Ok!", msgMktFail: "⚠️ Sin datos.", msgNoDB: "Sin DB",
            ivFraco: "Fraco", descFraco: "Genética deficiente.",
            ivMediano: "Medio", descMediano: "Potencial promedio.",
            ivBom: "Bueno", descBom: "Fuerte, sobre la media.",
            ivMuitoBom: "Muy bueno", descMuitoBom: "Excelente genética.",
            ivExcelente: "Ótimo", descExcelente: "Stats sobresalientes.",
            ivExcepcional: "Perfeito", descExcepcional: "¡Genética Perfecta!",
            qFraca: "Deficiente", qComum: "Común", qIncomum: "Poco Común", qRara: "Rara", qEpica: "Épica", qLendaria: "Legendaria", qMitica: "Mítica", qAncia: "Anciana", qDivina: "Divina"
        },
        en: {
            title: "CALC iVS PRO", tabCalc: "Panel", tabMarket: "Market", tabConfig: "Config",
            pokeLabel: "Pokémon (Type/Click):", level: "Level:", mult: "Mult (Q):",
            waiting: "Waiting for data...", fillStats: "Fill stats to evaluate", ivTotal: "POTENTIAL", effTotal: "Total efficiency", 
            classif: "CLASSIFICATION", indIv: "IVs", perfByStat: "Individual performance", power: "POWER",
            btnImg: "📷 Upload Img", btnEquip: "🎒 Equipped", statusStart: "Scan stats or upload screenshot",
            marketTitle: "🛒 Auto Market",
            marketDesc1: "Scanner <b style='color:var(--accent);'>ACTIVE</b>.<br><br>Hover bag or click stats.",
            marketDesc2: "Data loads silently. Open the panel manually whenever you want to review it.",
            cfgHotkey: "Hotkey (Alt+Letter):", cfgBtnSize: "Button size (px):", cfgShowBtn: "Show floating button",
            cfgLang: "Language:", cfgTheme: "Theme:", btnReset: "🔄 Reset position", btnSave: "Save", saved: "✅ Saved!",
            msgCloudPrep: "☁️ Cloud...", msgCloudAnal: "☁️ Analyzing...", msgCloudOk: "✅ Done!", msgCloudFail: "⚠️ Failed.",
            msgEquipOk: "✅ Loaded!", msgEquipFail: "⚠️ Open bag.", msgMktOk: "✅ Extracted!", msgMktFail: "⚠️ No data.", msgNoDB: "No DB",
            ivFraco: "Poor", descFraco: "Poor genetics.",
            ivMediano: "Average", descMediano: "Average potential.",
            ivBom: "Good", descBom: "Strong, above average.",
            ivMuitoBom: "Very Good", descMuitoBom: "Excellent genetics.",
            ivExcelente: "Great", descExcelente: "Outstanding stats.",
            ivExcepcional: "Perfect", descExcepcional: "Perfect Genetics!",
            qFraca: "Poor", qComum: "Common", qIncomum: "Uncommon", qRara: "Rare", qEpica: "Epic", qLendaria: "Legendary", qMitica: "Mythical", qAncia: "Ancient", qDivina: "Divine"
        },
        pt: {
            title: "CALC iVS PRO", tabCalc: "Painel", tabMarket: "Mercado", tabConfig: "Config",
            pokeLabel: "Pokémon (Digite/Clique):", level: "Nível:", mult: "Mult (Q):",
            waiting: "Aguardando dados...", fillStats: "Preencha os status para avaliar", ivTotal: "POTENCIAL", effTotal: "Eficiência total", 
            classif: "CLASSIFICAÇÃO", indIv: "IVs", perfByStat: "Desempenho individual", power: "PODER",
            btnImg: "📷 Enviar Img", btnEquip: "🎒 Equipado", statusStart: "Escaneie status ou envie print",
            marketTitle: "🛒 Auto Market",
            marketDesc1: "Scanner <b style='color:var(--accent);'>ATIVO</b>.<br><br>Passe o mouse na mochila ou clique nos stats.",
            marketDesc2: "Os dados serão carregados em segundo plano. Abra o painel manualmente quando quiser consultá-los.",
            cfgHotkey: "Atalho (Alt+Letra):", cfgBtnSize: "Tamanho botão (px):", cfgShowBtn: "Mostrar botão",
            cfgLang: "Idioma:", cfgTheme: "Tema:", btnReset: "🔄 Restaurar pos", btnSave: "Salvar", saved: "✅ Salvo!",
            msgCloudPrep: "☁️ Nuvem...", msgCloudAnal: "☁️ Analisando...", msgCloudOk: "✅ Ok!", msgCloudFail: "⚠️ Falha.",
            msgEquipOk: "✅ Carregado!", msgEquipFail: "⚠️ Abra a mochila.", msgMktOk: "✅ Extraído!", msgMktFail: "⚠️ Sem dados.", msgNoDB: "Sem DB",
            ivFraco: "Fraco", descFraco: "Genética deficiente.",
            ivMediano: "Médio", descMediano: "Potencial médio.",
            ivBom: "Bom", descBom: "Forte, acima da média.",
            ivMuitoBom: "Muito Bom", descMuitoBom: "Excelente genética.",
            ivExcelente: "Ótimo", descExcelente: "Status excepcionais.",
            ivExcepcional: "Perfeito", descExcepcional: "Genética Perfeita!",
            qFraca: "Fraca", qComum: "Comum", qIncomum: "Incomum", qRara: "Rara", qEpica: "Épica", qLendaria: "Lendária", qMitica: "Mítica", qAncia: "Anciã", qDivina: "Divina"
        }
    };
    
    let t = i18n[config.lang] || i18n.es; 
    const levelOneRecommendation = {
        es: 'Para mayor precisión, recomendado subir poke a level 15 mínimo.',
        en: 'For better accuracy, level the Pokémon to at least 15.',
        pt: 'Para maior precisão, recomenda-se subir o Pokémon ao nível 15 no mínimo.'
    };
    
    // --- COLORES FIJOS POR STAT ---
    const statTheme = { 
        hp: { color: '#ff4d79', icon: '❤️' }, atk: { color: '#ffb84d', icon: '⚔️' }, 
        def: { color: '#4da6ff', icon: '🛡️' }, spa: { color: '#d966ff', icon: '✨' }, 
        spd: { color: '#4dffb8', icon: '🔰' }, vel: { color: '#ffe64d', icon: '💨' } 
    };

    function getLevenshteinDistance(a, b) {
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) { matrix[i][j] = matrix[i - 1][j - 1]; } 
                else { matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)); }
            }
        }
        return matrix[b.length][a.length];
    }

    async function fetchAllPokemonNames() {
        try {
            let cached = localStorage.getItem('pokeidle_all_names');
            if (cached) { JSON.parse(cached).forEach(n => allKnownPokemon.add(n)); populateDatalist(); return; }
            const res = await fetch('https://pokeapi.co/api/v2/pokemon?limit=1300');
            const data = await res.json();
            const names = data.results.map(p => p.name.toLowerCase());
            localStorage.setItem('pokeidle_all_names', JSON.stringify(names));
            names.forEach(n => allKnownPokemon.add(n));
            populateDatalist();
        } catch (e) {}
    }

    let nativeGameDB = JSON.parse(localStorage.getItem('pokeidle_native_db') || '{}');
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        try {
            const clone = response.clone();
            clone.json().then(data => {
                let pokesArray = Array.isArray(data) ? data : (data.pokemon || data.pokes || data.list);
                if (Array.isArray(pokesArray) && pokesArray.length > 0 && pokesArray[0].stats) {
                    let updated = false;
                    pokesArray.forEach(p => {
                        if (p.id || p.speciesId || p.name) {
                            let key = p.name || p.speciesId || p.id;
                            nativeGameDB[key] = p.stats || p.baseStats;
                            if(typeof key === 'string' && isNaN(key)) { allKnownPokemon.add(key.toLowerCase()); updated = true; }
                        }
                    });
                    syncEquippedPokemon(pokesArray);
                    localStorage.setItem('pokeidle_native_db', JSON.stringify(nativeGameDB));
                    if(updated) populateDatalist();
                }
            }).catch(() => {});
        } catch (e) {}
        return response;
    };
    Object.keys(nativeGameDB).filter(k => isNaN(k)).forEach(k => allKnownPokemon.add(k.toLowerCase()));
    fetchAllPokemonNames();

    async function fetchBaseStats(identifier) {
        if (!identifier) return null;
        let idStr = identifier.toString().toLowerCase();
        if (baseStatsCache[idStr]) return baseStatsCache[idStr];
        try {
            const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${idStr}`);
            if (!response.ok) throw new Error('No encontrado');
            const data = await response.json();
            const stats = { id: data.id, hp: data.stats.find(s => s.stat.name === 'hp').base_stat, atk: data.stats.find(s => s.stat.name === 'attack').base_stat, def: data.stats.find(s => s.stat.name === 'defense').base_stat, spa: data.stats.find(s => s.stat.name === 'special-attack').base_stat, spd: data.stats.find(s => s.stat.name === 'special-defense').base_stat, vel: data.stats.find(s => s.stat.name === 'speed').base_stat };
            baseStatsCache[idStr] = stats; baseStatsCache[data.id] = stats;
            localStorage.setItem('pokeidle_basestats_cache', JSON.stringify(baseStatsCache)); return stats;
        } catch (error) { return null; }
    }

    // --- CSS ---
    GM_addStyle(`
        :root { --font-main: 'Segoe UI', system-ui, sans-serif; }
        
        #iv-calc-panel.theme-neon { --bg-color: #090e14; --card-bg: #121822; --card-border: #1d2733; --text-color: #f1f5f9; --text-muted: #64748b; --input-bg: rgba(0,0,0,0.4); --input-border: #1d2733; --header-bg: #090e14; --tab-bg: #090e14; --tab-active: #121822; --accent: #4dffb8; --glow: 0 0 8px; }
        #iv-calc-panel.theme-default { --bg-color: rgba(15, 23, 42, 0.95); --card-bg: rgba(30, 41, 59, 0.8); --card-border: #334155; --text-color: #f8fafc; --text-muted: #94a3b8; --input-bg: #0f172a; --input-border: #334155; --header-bg: #0f172a; --tab-bg: #0f172a; --tab-active: #1e293b; --accent: #38bdf8; --glow: none; }
        #iv-calc-panel.theme-dark { --bg-color: rgba(0, 0, 0, 0.95); --card-bg: #0a0a0a; --card-border: #262626; --text-color: #e5e5e5; --text-muted: #737373; --input-bg: #000; --input-border: #262626; --header-bg: #000; --tab-bg: #000; --tab-active: #0a0a0a; --accent: #a3a3a3; --glow: none; }
        #iv-calc-panel.theme-light { --bg-color: rgba(248, 250, 252, 0.95); --card-bg: #ffffff; --card-border: #cbd5e1; --text-color: #0f172a; --text-muted: #64748b; --input-bg: #f1f5f9; --input-border: #94a3b8; --header-bg: #e2e8f0; --tab-bg: #cbd5e1; --tab-active: #ffffff; --accent: #2563eb; --glow: none; }
        #iv-calc-panel.theme-pokedex { --bg-color: rgba(220, 10, 45, 0.95); --card-bg: #f8f8f8; --card-border: #111111; --text-color: #111111; --text-muted: #555555; --input-bg: #ffffff; --input-border: #111111; --header-bg: #9e0720; --tab-bg: #9e0720; --tab-active: #f8f8f8; --accent: #dc0a2d; --glow: none; }
        
        .theme-light .stat-icon, .theme-pokedex .stat-icon { text-shadow: none !important; border-color: var(--card-border) !important; background: var(--input-bg) !important; }
        .theme-light .stat-bar-fill, .theme-pokedex .stat-bar-fill { box-shadow: none !important; }
        .theme-light .iv-donut-chart, .theme-pokedex .iv-donut-chart { box-shadow: 0 2px 4px rgba(0,0,0,0.1) !important; }
        .theme-light .iv-header, .theme-pokedex .iv-header { color: #fff; }
        .theme-pokedex .iv-tab { color: #ffb3b3; }
        .theme-pokedex .iv-tab.active { color: #dc0a2d; }
        .theme-light .iv-result, .theme-pokedex .iv-result { text-shadow: none !important; font-weight: 800 !important; }
        
        #iv-calc-toggle-btn { position: fixed; background: rgba(18, 24, 34, 0.9); border: 1px solid var(--accent, #4dffb8); color: var(--accent, #4dffb8); padding: 8px 12px; border-radius: 6px; font-family: monospace; font-weight: bold; cursor: pointer; z-index: 999999; box-shadow: 0 4px 6px rgba(0,0,0,0.4); transition: all 0.2s; user-select: none; }
        #iv-calc-toggle-btn:hover { background: var(--accent, #4dffb8); color: #000; }
        
        #iv-calc-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 420px; background: var(--bg-color); border: 1px solid var(--card-border); border-radius: 8px; color: var(--text-color); font-family: var(--font-main); z-index: 1000000; box-shadow: 0 10px 30px rgba(0,0,0,0.8); display: none; flex-direction: column; overflow: hidden; backdrop-filter: blur(5px); }
        
        .iv-header { background: var(--header-bg); padding: 6px 10px; font-weight: 800; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--card-border); cursor: move; font-size: 11px; }
        .iv-tabs { display: flex; background: var(--tab-bg); border-bottom: 1px solid var(--card-border); }
        .iv-tab { flex: 1; padding: 4px; text-align: center; cursor: pointer; font-size: 9px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; transition: all 0.2s; }
        .iv-tab:hover { color: var(--text-color); }
        .iv-tab.active { color: var(--accent); background: var(--tab-active); border-bottom: 2px solid var(--accent); }
        .iv-body { padding: 8px; max-height: 500px; overflow-y: auto; overflow-x: hidden; background: var(--bg-color); }
        .iv-close { cursor: pointer; color: #ff4d79; font-weight: bold; font-size: 12px; padding: 0 5px; }
        
        .iv-top-section { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .iv-sprite-box { position: relative; width: 48px; height: 48px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 4px; display: flex; justify-content: center; align-items: center; cursor: help; }
        .iv-sprite-box img { max-width: 90%; max-height: 90%; image-rendering: pixelated; }
        
        #iv-base-stats-hover { position: absolute; top: 110%; left: 0; background: rgba(0,0,0,0.95); border: 1px solid var(--accent); color: #fff; padding: 8px; border-radius: 6px; font-size: 9px; z-index: 100; display: none; flex-direction: column; gap: 4px; pointer-events: none; box-shadow: 0 4px 10px rgba(0,0,0,0.8); min-width: 90px; }
        .iv-sprite-box:hover #iv-base-stats-hover { display: flex; }
        
        .iv-poke-search { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        .iv-search-input { background: var(--input-bg); border: 1px solid var(--input-border); color: var(--accent); padding: 4px 6px; border-radius: 4px; font-weight: 800; font-size: 11px; width: 100%; box-sizing: border-box; }
        .iv-search-input:focus { outline: none; border-color: var(--accent); }
        
        .iv-meta-info { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; background: var(--card-bg); padding: 4px 8px; border-radius: 4px; border: 1px solid var(--card-border); margin-bottom: 6px; font-size: 9px; font-weight: bold; color: var(--text-muted); text-transform: uppercase; }
        
        /* AQUÍ AUMENTÉ EL ANCHO DE LOS INPUTS DE NIVEL Y MULTIPLICADOR (de 40px a 60px) */
        .iv-meta-input { width: 60px; background: var(--input-bg); border: 1px solid var(--input-border); color: var(--text-color); text-align: center; border-radius: 3px; padding: 1px 3px; font-weight: bold; margin-left: 4px; font-family: monospace; font-size: 10px; }
        .iv-level-recommendation { display: none; flex: 1 0 100%; margin-top: 4px; padding-top: 4px; border-top: 1px solid #fbbf2444; color: #fbbf24; font-size: 8px; font-weight: 800; line-height: 1.2; text-transform: none; }
        .iv-level-recommendation.visible { display: block; }
        
        #q-tag { font-size: 7px; padding: 2px 4px; border-radius: 3px; margin-left: 6px; font-weight: 900; }

        /* DASHBOARD */
        .iv-total-dashboard { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 10px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 8px; }
        .iv-donut-wrapper { display: flex; gap: 10px; align-items: center; }
        .iv-donut-chart { width: 56px; height: 56px; border-radius: 50%; background: conic-gradient(var(--accent) 0%, var(--card-border) 0%); display: flex; justify-content: center; align-items: center; position: relative; transition: background 0.5s; }
        .iv-donut-inner { width: 44px; height: 44px; background: var(--card-bg); border-radius: 50%; display: flex; flex-direction: column; justify-content: center; align-items: center; color: var(--text-color); }
        #iv-donut-val { font-size: 14px; font-weight: 900; line-height: 1; font-family: 'Montserrat', sans-serif; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
        
        .iv-donut-info { display: flex; flex-direction: column; justify-content: center; }
        .iv-donut-label { font-size: 7px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 2px; font-weight: bold; }
        .iv-donut-title { font-size: 15px; font-weight: 900; color: var(--accent); margin-bottom: 2px; line-height: 1; }
        .iv-donut-desc { font-size: 8px; color: var(--text-muted); line-height: 1.1; }

        .iv-total-badge-container { margin-left: auto; align-self: center; }
        .iv-total-badge { background: var(--input-bg); border: 1px solid var(--accent); color: var(--accent); padding: 4px 8px; border-radius: 8px; font-weight: 900; font-size: 12px; font-family: monospace; white-space: nowrap; }

        .iv-eff-row { display: flex; justify-content: space-between; font-size: 8px; color: var(--text-muted); margin-bottom: 3px; text-transform: uppercase; font-weight: bold; }
        .iv-progress-bg { height: 4px; background: var(--card-border); border-radius: 2px; overflow: hidden; }
        .iv-progress-fill { height: 100%; width: 0%; background: var(--accent); border-radius: 2px; transition: width 0.5s, background-color 0.5s; }

        /* GRID INDIVIDUAL Y PODER */
        .iv-grid-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 4px; }
        .iv-grid-title { font-weight: 900; font-size: 11px; margin-bottom: 1px; }
        .iv-grid-subtitle { font-size: 8px; color: var(--text-muted); }
        
        /* CÁLCULO DE PODER EN EL HEADER */
        .iv-power-badge-container { display: flex; align-items: center; justify-content: flex-end; }
        .iv-power-badge { background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text-color); padding: 2px 8px; border-radius: 6px; font-weight: 900; font-size: 11px; font-family: monospace; letter-spacing: 0.5px; }

        .iv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
        .iv-stat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; transition: border-color 0.2s, box-shadow 0.2s, background 0.2s; }
        /* Un IV mostrado como 32.0 recibe una marca propia, independiente del color de cada stat. */
        .iv-stat-card.iv-perfect { border-color: #b8ff5c !important; background: linear-gradient(135deg, color-mix(in srgb, #b8ff5c 13%, var(--card-bg)), var(--card-bg) 72%); box-shadow: 0 0 0 1px #b8ff5c66, 0 0 13px #b8ff5c44; }
        .iv-stat-card.iv-perfect .iv-result { color: #d7ff9e; text-shadow: 0 0 7px #b8ff5c88; }
        
        .stat-top { display: flex; justify-content: space-between; align-items: center; }
        .stat-label-group { display: flex; gap: 4px; align-items: center; }
        .stat-icon { background: rgba(255,255,255,0.03); width: 16px; height: 16px; display: flex; justify-content: center; align-items: center; border-radius: 3px; font-size: 9px; border: 1px solid rgba(255,255,255,0.05); }
        
        .stat-name-input { display: flex; flex-direction: column; gap: 1px; }
        .stat-lbl { font-weight: 900; font-size: 10px; line-height: 1; }
        
        .iv-input { width: 70px; background: var(--input-bg); border: 1px solid var(--input-border); color: var(--text-muted); border-radius: 3px; padding: 2px 4px; font-size: 10px; font-family: monospace; font-weight: bold; }
        .iv-input:focus { color: var(--text-color); outline: none; border-color: var(--accent); }
        
        .stat-res-wrap { display: flex; align-items: baseline; gap: 1px; }
        .iv-result { font-weight: 900; font-size: 13px; color: var(--text-color); line-height: 1; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
        .stat-max { font-size: 8px; color: var(--text-muted); opacity: 0.6; }

        .stat-bar-bg { height: 3px; background: rgba(0,0,0,0.2); border-radius: 2px; margin: 1px 0; }
        .stat-bar-fill { height: 100%; width: 0%; border-radius: 2px; transition: width 0.4s; }

        .stat-bottom { display: flex; justify-content: space-between; align-items: center; }
        .stat-pill { font-size: 7px; font-weight: 900; padding: 1px 4px; border-radius: 3px; border: 1px solid transparent; }
        .stat-pct { font-size: 8px; color: var(--text-muted); font-family: monospace; }

        .iv-ocr-section { display: flex; gap: 6px; margin-top: 4px; }
        .iv-btn-ocr { flex: 1; background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text-muted); padding: 4px; border-radius: 4px; font-size: 9px; font-weight: 800; text-transform: uppercase; cursor: pointer; transition: 0.2s; }
        .iv-btn-ocr:hover { color: var(--text-color); border-color: var(--accent); }
        #iv-ocr-status { font-size: 8px; color: var(--accent); margin-top: 4px; text-align: center; font-weight: bold; min-height: 10px; }
        
        .iv-settings-group { margin-bottom: 6px; display: flex; flex-direction: column; gap: 2px; }
        .iv-settings-group label { font-size: 9px; color: var(--text-muted); font-weight: 800; text-transform: uppercase; }
        .iv-settings-input { background: var(--input-bg); border: 1px solid var(--input-border); color: var(--text-color); padding: 4px 6px; border-radius: 3px; font-size: 10px; outline: none; }
        .iv-btn-save { background: var(--accent); color: #000; border: none; padding: 6px; border-radius: 4px; font-weight: 900; text-transform: uppercase; cursor: pointer; width: 100%; margin-top: 4px; }
    `);

    function applyLanguage() {
        t = i18n[config.lang] || i18n.es;
        const toggleBtn = document.getElementById('iv-calc-toggle-btn');
        if(toggleBtn) toggleBtn.innerText = `🧬 ${t.title} (Alt+${config.hotkey.toUpperCase()})`;
        
        const setTxt = (id, txt) => { const el = document.getElementById(id); if(el) el.innerHTML = txt; };
        setTxt('txt-title', `🧬 ${t.title}`); setTxt('lbl-poke', t.pokeLabel); setTxt('lbl-level', t.level); setTxt('lbl-mult', t.mult);
        setTxt('lbl-total-title', t.ivTotal); setTxt('lbl-eff-title', t.effTotal); setTxt('lbl-classif', t.classif);
        setTxt('lbl-ind-iv', t.indIv); setTxt('lbl-perf-stat', t.perfByStat); setTxt('lbl-power-title', t.power);
        
        setTxt('iv-btn-ocr', t.btnImg); 
        setTxt('mkt-title', t.marketTitle); setTxt('mkt-desc1', t.marketDesc1); setTxt('mkt-desc2', t.marketDesc2);
        setTxt('lbl-lang', t.cfgLang); setTxt('lbl-theme', t.cfgTheme); setTxt('lbl-hotkey', t.cfgHotkey); setTxt('lbl-btnsize', t.cfgBtnSize);
        setTxt('lbl-showbtn-text', t.cfgShowBtn); setTxt('btn-reset-pos', t.btnReset); setTxt('btn-save-config', t.btnSave);
        
        ['calc','market','config'].forEach(tab => { const el = document.querySelector(`.iv-tab[data-tab="${tab}"]`); if(el) el.innerText = t['tab' + tab.charAt(0).toUpperCase() + tab.slice(1)]; });
    }

    function initUI() {
        if (document.getElementById('iv-calc-panel')) return;
        const btn = document.createElement('button');
        btn.id = 'iv-calc-toggle-btn'; btn.innerText = `🧬 ${t.title} (Alt+${config.hotkey.toUpperCase()})`; btn.style.fontSize = `${config.btnSize}px`;
        btn.style.left = config.btnLeft; if(config.btnTop) btn.style.top = config.btnTop; if(config.btnBottom) btn.style.bottom = config.btnBottom;
        btn.style.display = config.showBtn ? 'block' : 'none'; document.body.appendChild(btn);

        const panel = document.createElement('div');
        panel.id = 'iv-calc-panel'; panel.className = `theme-${config.theme}`;
        
        const gridHtml = ['hp','atk','def','spa','spd','vel'].map(sid => {
            const s = statTheme[sid]; const name = sid === 'spa' ? 'SpA' : (sid === 'spd' ? 'SpD' : sid.charAt(0).toUpperCase() + sid.slice(1));
            return `
            <div class="iv-stat-card" data-stat-id="${sid}">
                <div class="stat-top">
                    <div class="stat-label-group">
                        <span class="stat-icon" style="color:${s.color}; text-shadow:var(--glow) ${s.color}; border-color:${s.color}44;">${s.icon}</span>
                        <div class="stat-name-input">
                            <span class="stat-lbl">${name}</span>
                            <input type="number" class="iv-input stat-input" data-stat="${sid}" placeholder="0">
                        </div>
                    </div>
                    <div class="stat-res-wrap"><span class="iv-result" id="res-iv-${sid}">0.0</span><span class="stat-max">/32</span></div>
                </div>
                <div class="stat-bar-bg"><div class="stat-bar-fill" id="bar-iv-${sid}" style="background-color:${s.color}; box-shadow:var(--glow) ${s.color};"></div></div>
                <div class="stat-bottom"><span class="stat-pill" id="pill-iv-${sid}">-</span><span class="stat-pct" id="pct-iv-${sid}">0%</span></div>
            </div>`;
        }).join('');

        panel.innerHTML = `
            <div class="iv-header" id="iv-header-drag"><span id="txt-title">🧬 ${t.title}</span><span class="iv-close" id="iv-close-btn">✖</span></div>
            <div class="iv-tabs"><div class="iv-tab active" data-tab="calc">${t.tabCalc}</div><div class="iv-tab" data-tab="market">${t.tabMarket}</div><div class="iv-tab" data-tab="config">${t.tabConfig}</div></div>
            <div class="iv-body">
                <div id="tab-calc">
                    <datalist id="poke-db-list"></datalist>
                    <div class="iv-top-section">
                        <div class="iv-sprite-box" id="iv-sprite-box">
                            <img id="iv-sprite" src="" style="display:none;">
                            <div id="iv-base-stats-hover"></div>
                        </div>
                        <div class="iv-poke-search">
                            <label id="lbl-poke" style="font-size:8px; color:var(--text-muted); font-weight:800;">${t.pokeLabel}</label>
                            <input type="text" id="iv-search-input" class="iv-search-input" list="poke-db-list" autocomplete="off">
                        </div>
                    </div>
                    
                    <div class="iv-meta-info">
                        <div style="display:flex; align-items:center;"><span id="lbl-level">${t.level}</span> <input type="number" id="meta-level" class="iv-meta-input" value="1"></div>
                        <div style="display:flex; align-items:center;"><span id="lbl-mult">${t.mult}</span> <input type="number" step="0.01" id="meta-quality" class="iv-meta-input" value="1.0"><span id="q-tag">COMUM</span></div>
                        <div id="iv-level-recommendation" class="iv-level-recommendation" role="status"></div>
                    </div>

                    <div class="iv-total-dashboard">
                        <div class="iv-donut-wrapper">
                            <div class="iv-donut-chart" id="iv-donut-chart">
                                <div class="iv-donut-inner">
                                    <span id="iv-donut-val">0%</span>
                                    <span style="font-size:5px; font-weight:800; color:var(--text-muted);" id="lbl-total-title">${t.ivTotal}</span>
                                </div>
                            </div>
                            <div class="iv-donut-info">
                                <div class="iv-donut-label" id="lbl-classif">${t.classif}</div>
                                <div class="iv-donut-title" id="iv-donut-title">-</div>
                                <div class="iv-donut-desc" id="iv-donut-desc">${t.waiting}</div>
                            </div>
                            <div class="iv-total-badge-container">
                                <div class="iv-total-badge" id="iv-total-calc-badge">0.0 / 192</div>
                            </div>
                        </div>
                        <div>
                            <div class="iv-eff-row"><span id="lbl-eff-title">${t.effTotal}</span><span id="iv-eff-val" style="color:var(--text-color);">0%</span></div>
                            <div class="iv-progress-bg"><div id="iv-progress-fill" class="iv-progress-fill"></div></div>
                        </div>
                    </div>
                    
                    <div class="iv-grid-header">
                        <div>
                            <div class="iv-grid-title" id="lbl-ind-iv">${t.indIv}</div>
                            <div class="iv-grid-subtitle" id="lbl-perf-stat">${t.perfByStat}</div>
                        </div>
                        <div class="iv-power-badge-container">
                            <span id="lbl-power-title" style="font-size: 8px; color: var(--text-muted); text-transform: uppercase; font-weight: bold; margin-right: 6px;">${t.power}</span>
                            <div class="iv-power-badge" id="iv-total-power">0</div>
                        </div>
                    </div>
                    
                    <div class="iv-grid" id="iv-manual-grid">${gridHtml}</div>

                    <div class="iv-ocr-section">
                        <input type="file" id="iv-ocr-file" accept="image/*" style="display:none;">
                        <button class="iv-btn-ocr" id="iv-btn-ocr">${t.btnImg}</button>
                    </div>
                    <div id="iv-ocr-status">${t.statusStart}</div>
                </div>
                
                <div id="tab-market" style="display:none;">
                    <div style="background: rgba(77, 255, 184, 0.1); border: 1px solid var(--accent); padding: 8px; border-radius: 6px; margin-bottom: 8px; text-align: center;">
                        <p id="mkt-title" style="margin: 0 0 6px 0; color: var(--accent); font-weight: 900; font-size: 11px;">${t.marketTitle}</p>
                        <p id="mkt-desc1" style="margin: 0; font-size: 9px; line-height: 1.3; color: var(--text-color);">${t.marketDesc1}</p>
                    </div>
                    <div style="font-size: 8px; color: var(--text-muted); text-align: center; font-weight: bold;" id="mkt-desc2">${t.marketDesc2}</div>
                </div>
                
                <div id="tab-config" style="display:none;">
                    <div class="iv-settings-group"><label id="lbl-lang">${t.cfgLang}</label><select id="cfg-lang" class="iv-settings-input"><option value="es" ${config.lang === 'es' ? 'selected' : ''}>Español</option><option value="en" ${config.lang === 'en' ? 'selected' : ''}>English</option><option value="pt" ${config.lang === 'pt' ? 'selected' : ''}>Português</option></select></div>
                    <div class="iv-settings-group">
                        <label id="lbl-theme">${t.cfgTheme}</label>
                        <select id="cfg-theme" class="iv-settings-input">
                            <option value="neon" ${config.theme === 'neon' ? 'selected' : ''}>Neon Cyberpunk (Moderno)</option>
                            <option value="default" ${config.theme === 'default' ? 'selected' : ''}>Default (Azul Clásico)</option>
                            <option value="dark" ${config.theme === 'dark' ? 'selected' : ''}>Dark (Negro Minimalista)</option>
                            <option value="light" ${config.theme === 'light' ? 'selected' : ''}>Light (Claro)</option>
                            <option value="pokedex" ${config.theme === 'pokedex' ? 'selected' : ''}>Pokédex (Rojo/Blanco)</option>
                        </select>
                    </div>
                    <div class="iv-settings-group"><label id="lbl-hotkey">${t.cfgHotkey}</label><input type="text" id="cfg-hotkey" class="iv-settings-input" maxlength="1" value="${config.hotkey}"></div>
                    <div class="iv-settings-group"><label id="lbl-btnsize">${t.cfgBtnSize}</label><input type="number" id="cfg-btnsize" class="iv-settings-input" value="${config.btnSize}"></div>
                    <div class="iv-settings-group" style="flex-direction:row; align-items:center; margin: 6px 0;"><input type="checkbox" id="cfg-showbtn" ${config.showBtn ? 'checked' : ''}><label id="lbl-showbtn-text" style="margin:0 0 0 4px; cursor:pointer;">${t.cfgShowBtn}</label></div>
                    <div class="iv-settings-group"><button id="btn-reset-pos" class="iv-settings-input" style="cursor:pointer; background:var(--card-bg);">${t.btnReset}</button></div>
                    <button class="iv-btn-save" id="btn-save-config">${t.btnSave}</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        document.getElementById('iv-close-btn').addEventListener('click', togglePanel);
        document.addEventListener('keydown', (e) => { if (e.altKey && e.key.toLowerCase() === config.hotkey.toLowerCase()) { e.preventDefault(); togglePanel(); } });

        document.querySelectorAll('.iv-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelectorAll('.iv-tab').forEach(x => x.classList.remove('active')); e.target.classList.add('active');
                const targetTab = e.target.getAttribute('data-tab');
                document.getElementById('tab-calc').style.display = targetTab === 'calc' ? 'block' : 'none';
                document.getElementById('tab-market').style.display = targetTab === 'market' ? 'block' : 'none';
                document.getElementById('tab-config').style.display = targetTab === 'config' ? 'block' : 'none';
            });
        });

        document.getElementById('btn-save-config').addEventListener('click', () => {
            config.hotkey = document.getElementById('cfg-hotkey').value || 'i';
            config.btnSize = parseInt(document.getElementById('cfg-btnsize').value) || 12;
            config.showBtn = document.getElementById('cfg-showbtn').checked;
            config.lang = document.getElementById('cfg-lang').value;
            config.theme = document.getElementById('cfg-theme').value;
            localStorage.setItem('pokeidle_iv_config', JSON.stringify(config));
            
            panel.className = `theme-${config.theme}`; btn.style.display = config.showBtn ? 'block' : 'none'; btn.style.fontSize = `${config.btnSize}px`;
            applyLanguage(); calculateIVs();
            const saveBtn = document.getElementById('btn-save-config'); saveBtn.innerText = t.saved;
            setTimeout(() => { saveBtn.innerText = t.btnSave; }, 1200);
        });
        
        document.getElementById('btn-reset-pos').addEventListener('click', () => { config.btnLeft = '20px'; config.btnBottom = '20px'; config.btnTop = ''; localStorage.setItem('pokeidle_iv_config', JSON.stringify(config)); btn.style.left = config.btnLeft; btn.style.bottom = config.btnBottom; btn.style.top = ''; });
        document.querySelectorAll('.stat-input').forEach(input => input.addEventListener('input', calculateIVs));
        document.getElementById('meta-level').addEventListener('input', calculateIVs);
        document.getElementById('meta-quality').addEventListener('input', calculateIVs);
        
        document.getElementById('iv-search-input').addEventListener('input', (e) => { currentPokeData = { name: e.target.value, level: document.getElementById('meta-level').value, quality: document.getElementById('meta-quality').value }; loadSpriteAndCalculate(); });
        document.getElementById('iv-btn-ocr').addEventListener('click', () => document.getElementById('iv-ocr-file').click());
        document.getElementById('iv-ocr-file').addEventListener('change', handleImageUpload);
        document.addEventListener('paste', handlePaste);
        
        makeDraggable(panel, document.getElementById('iv-header-drag'));
        makeDraggableBtn(btn); populateDatalist(); updateQualityTag(1.0);
        applyLanguage();
    }

    function updateQualityTag(qVal) {
        const tagEl = document.getElementById('q-tag'); if (!tagEl) return;
        let text = "", color = "", bg = "";
        if (qVal < 1.0) { text = t.qFraca; color = "#f87171"; bg = "rgba(248,113,113,0.15)"; }
        else if (qVal < 1.1) { text = t.qComum; color = "#94a3b8"; bg = "rgba(148,163,184,0.15)"; }
        else if (qVal < 1.3) { text = t.qIncomum; color = "#4ade80"; bg = "rgba(74,222,128,0.15)"; }
        else if (qVal < 1.5) { text = t.qRara; color = "#38bdf8"; bg = "rgba(56,189,248,0.15)"; }
        else if (qVal < 1.7) { text = t.qEpica; color = "#c084fc"; bg = "rgba(192,132,252,0.15)"; }
        else if (qVal < 2.0) { text = t.qLendaria; color = "#fbbf24"; bg = "rgba(251,191,36,0.15)"; }
        else if (qVal < 3.0) { text = t.qMitica; color = "#f43f5e"; bg = "rgba(244,63,94,0.15)"; }
        else if (qVal < 4.0) { text = t.qAncia; color = "#fdba74"; bg = "rgba(253,186,114,0.15)"; }
        else { text = t.qDivina; color = "#ffffff"; bg = "rgba(255,255,255,0.2)"; }
        tagEl.innerText = text.toUpperCase(); tagEl.style.color = color; tagEl.style.backgroundColor = bg; tagEl.style.border = `1px solid ${color}44`;
    }

    function populateDatalist() {
        const list = document.getElementById('poke-db-list'); if(!list) return;
        list.innerHTML = ''; Array.from(allKnownPokemon).sort().forEach(n => { list.appendChild(new Option(n.charAt(0).toUpperCase() + n.slice(1))); });
    }

    function togglePanel() {
        isPanelOpen = !isPanelOpen; document.getElementById('iv-calc-panel').style.display = isPanelOpen ? 'flex' : 'none';
        if (isPanelOpen && lastEquippedPoke) { currentPokeData = lastEquippedPoke; loadSpriteAndCalculate(); }
    }

    function getPrimaryEquippedPokemon(pokemonList) {
        if (!Array.isArray(pokemonList)) return null;
        const team = pokemonList.filter(pokemon => pokemon && Boolean(pokemon.team));
        if (!team.length) return null;
        // El juego identifica al líder; como respaldo elegimos el primer slot del equipo.
        return team.find(pokemon => pokemon.leader === true)
            || team.sort((a, b) => Number(a.slot ?? a.teamSlot ?? a.position ?? 999) - Number(b.slot ?? b.teamSlot ?? b.position ?? 999))[0];
    }

    function getPokemonIdentity(pokemon) {
        if (!pokemon) return '';
        return String(pokemon.id ?? pokemon.capturedId ?? pokemon.pokeId ?? `${pokemon.name || pokemon.speciesId || ''}|${pokemon.slot ?? pokemon.teamSlot ?? ''}`);
    }

    function syncEquippedPokemon(pokemonList) {
        const equipped = getPrimaryEquippedPokemon(pokemonList);
        if (!equipped) return;
        const hasChanged = getPokemonIdentity(equipped) !== getPokemonIdentity(lastEquippedPoke);
        lastEquippedPoke = equipped;
        if (!hasChanged) return;

        currentPokeData = equipped;
        if (!isPanelOpen) return;
        loadSpriteAndCalculate();
        const statusEl = document.getElementById('iv-ocr-status');
        if (statusEl) {
            statusEl.innerText = t.msgEquipOk;
            statusEl.style.color = 'var(--accent)';
            setTimeout(() => {
                if (statusEl.innerText === t.msgEquipOk) statusEl.innerText = t.statusStart;
            }, 2500);
        }
    }

    function makeDraggable(el, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        handle.onmousedown = (e) => { e.preventDefault(); pos3 = e.clientX; pos4 = e.clientY; document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; }; document.onmousemove = (e) => { e.preventDefault(); pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY; pos3 = e.clientX; pos4 = e.clientY; el.style.top = (el.offsetTop - pos2) + "px"; el.style.left = (el.offsetLeft - pos1) + "px"; }; };
    }
    
    function makeDraggableBtn(btn) {
        let posX = 0, posY = 0;
        btn.onmousedown = (e) => { 
            e.preventDefault(); posX = e.clientX; posY = e.clientY; 
            document.onmouseup = (muEvent) => { 
                document.onmouseup = null; document.onmousemove = null; 
                if (Math.abs(muEvent.clientX - posX) < 5 && Math.abs(muEvent.clientY - posY) < 5) togglePanel(); 
                else { config.btnLeft = btn.style.left; config.btnTop = btn.style.top; config.btnBottom = ''; localStorage.setItem('pokeidle_iv_config', JSON.stringify(config)); }
            }; 
            document.onmousemove = (mmEvent) => { mmEvent.preventDefault(); btn.style.top = (btn.offsetTop - (posY - mmEvent.clientY)) + "px"; btn.style.left = (btn.offsetLeft - (posX - mmEvent.clientX)) + "px"; btn.style.bottom = "auto"; posX = mmEvent.clientX; posY = mmEvent.clientY; }; 
        };
    }

    function calculateExactIV(statType, S, B, L, Q) {
        S = parseFloat(S); B = parseFloat(B); L = parseFloat(L); Q = parseFloat(Q);
        if (isNaN(S) || isNaN(B) || isNaN(L) || isNaN(Q) || Q <= 0) return '?';
        let F = (L / 100) * Math.pow(Q, (statType === 'hp' || statType === 'vel') ? 0.95 : 0.80);
        if (F === 0) return '?';
        let exactIv = ((S / F) - B) / 2;
        let displayIv = parseFloat(exactIv.toFixed(1));
        const displayValue = Math.max(0, Math.min(32, displayIv));
        // La señal visual sigue el valor que ve el usuario: todo 32.0 mostrado es perfecto.
        return { displayValue, isPerfect: displayValue === 32 };
    }

    function updateLevelRecommendation(level) {
        const recommendationEl = document.getElementById('iv-level-recommendation');
        if (!recommendationEl) return;
        const isLevelOne = Number(level) === 1;
        recommendationEl.classList.toggle('visible', isLevelOne);
        recommendationEl.innerText = isLevelOne ? (levelOneRecommendation[config.lang] || levelOneRecommendation.es) : '';
    }

    async function loadSpriteAndCalculate() {
        const p = currentPokeData; if (!p || !p.name) return;
        let formattedName = p.name.charAt(0).toUpperCase() + p.name.slice(1);
        const nameInput = document.getElementById('iv-search-input'); if (nameInput && nameInput.value.toLowerCase() !== formattedName.toLowerCase()) { nameInput.value = formattedName; }

        let exactLevel = (p.stats && p.stats.level !== undefined) ? p.stats.level : (p.level !== undefined ? p.level : (p.lvl !== undefined ? p.lvl : null));
        if (exactLevel !== null && exactLevel !== undefined) document.getElementById('meta-level').value = exactLevel;

        let exactQuality = (p.stats && p.stats.quality !== undefined) ? p.stats.quality : (p.stats && p.stats.q !== undefined) ? p.stats.q : (p.quality !== undefined ? p.quality : (p.q !== undefined ? p.q : (p.multiplier !== undefined ? p.multiplier : (p.mult !== undefined ? p.mult : (p.tier !== undefined ? p.tier : null)))));
        if (exactQuality !== null && exactQuality !== undefined) document.getElementById('meta-quality').value = exactQuality;
        
        let bases = await fetchBaseStats(p.speciesId || p.name);
        const spriteImg = document.getElementById('iv-sprite');
        if (bases && bases.id) { spriteImg.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${bases.id}.png`; spriteImg.style.display = 'block'; } 
        else { spriteImg.style.display = 'none'; }

        if (p.stats) {
            const statMap = { 'hp': ['hp'], 'atk': ['attack', 'atk'], 'def': ['defense', 'def'], 'spa': ['spAtk', 'special-attack', 'spa'], 'spd': ['spDef', 'special-defense', 'spd'], 'vel': ['speed', 'vel'] };
            ['hp', 'atk', 'def', 'spa', 'spd', 'vel'].forEach(s => {
                const input = document.querySelector(`.stat-input[data-stat="${s}"]`);
                if (input) { let val = ''; for (let key of statMap[s]) { if (p.stats[key] !== undefined) { val = p.stats[key]; break; } } input.value = val; }
            });
        }
        await calculateIVs();
    }

    async function calculateIVs() {
        let level = document.getElementById('meta-level').value;
        let quality = document.getElementById('meta-quality').value;
        let qVal = parseFloat(quality) || 1; updateQualityTag(qVal);
        updateLevelRecommendation(level);

        let name = document.getElementById('iv-search-input').value;
        let bases = await fetchBaseStats(name);
        
        if (!bases) {
            document.querySelectorAll('.iv-stat-card.iv-perfect').forEach(card => card.classList.remove('iv-perfect'));
            updateProgressBar(0, true);
            return;
        }

        const hoverBox = document.getElementById('iv-base-stats-hover');
        if (hoverBox) {
            let totalBase = bases.hp + bases.atk + bases.def + bases.spa + bases.spd + bases.vel;
            hoverBox.innerHTML = `
                <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:#ff4d79; font-weight:bold;">HP</span><span>${bases.hp}</span></div>
                <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:#ffb84d; font-weight:bold;">ATK</span><span>${bases.atk}</span></div>
                <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:#4da6ff; font-weight:bold;">DEF</span><span>${bases.def}</span></div>
                <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:#d966ff; font-weight:bold;">SPA</span><span>${bases.spa}</span></div>
                <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:#4dffb8; font-weight:bold;">SPD</span><span>${bases.spd}</span></div>
                <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:#ffe64d; font-weight:bold;">VEL</span><span>${bases.vel}</span></div>
                <hr style="border-top:1px solid var(--card-border); margin:2px 0; width:100%;">
                <div style="display:flex; justify-content:space-between; gap:12px; font-weight:900; color:var(--accent);"><span>TOTAL</span><span>${totalBase}</span></div>
            `;
        }
        
        let sumIVProb = 0; 
        let isTotalValid = true;
        let totalStatsInserted = 0; 

        ['hp', 'atk', 'def', 'spa', 'spd', 'vel'].forEach(stat => {
            const input = document.querySelector(`.stat-input[data-stat="${stat}"]`);
            const resultSpan = document.getElementById(`res-iv-${stat}`);
            const pill = document.getElementById(`pill-iv-${stat}`);
            const bar = document.getElementById(`bar-iv-${stat}`);
            const pctText = document.getElementById(`pct-iv-${stat}`);
            const statCard = input ? input.closest('.iv-stat-card') : null;
            
            if (input && input.value !== '') {
                let rawStatVal = parseFloat(input.value);
                if(!isNaN(rawStatVal)) totalStatsInserted += rawStatVal;

                let ivData = calculateExactIV(stat, input.value, bases[stat], level, quality);
                if (ivData !== '?') {
                    statCard?.classList.toggle('iv-perfect', ivData.isPerfect);
                    if (ivData.isPerfect) statCard?.setAttribute('title', 'IV perfecto: 32.0');
                    else statCard?.removeAttribute('title');
                    sumIVProb += ivData.displayValue;
                    resultSpan.innerText = ivData.displayValue.toFixed(1);
                    
                    let percent = (ivData.displayValue / 32) * 100;
                    bar.style.width = percent + '%';
                    pctText.innerText = Math.round(percent) + '%';
                    
                    let pColor = '#f87171'; let pText = t.ivFraco.toUpperCase();
                    if (percent >= 45 && percent < 60) { pColor = '#ffb84d'; pText = t.ivMediano.toUpperCase(); } 
                    else if (percent >= 60 && percent < 90) { pColor = '#4da6ff'; pText = t.ivBom.toUpperCase(); } 
                    else if (percent >= 90 && percent < 100) { pColor = '#4dffb8'; pText = t.ivExcelente.toUpperCase(); } 
                    else if (percent === 100) { pColor = '#00ffff'; pText = t.ivExcepcional.toUpperCase(); } 
                    
                    pill.style.color = pColor; pill.style.backgroundColor = pColor + '22'; pill.style.borderColor = pColor + '55'; pill.innerText = pText;

                } else { 
                    resultSpan.innerText = '0.0'; isTotalValid = false; 
                    statCard?.classList.remove('iv-perfect'); statCard?.removeAttribute('title');
                    bar.style.width = '0%'; pctText.innerText = '0%';
                    pill.style.color = 'var(--text-muted)'; pill.style.backgroundColor = 'transparent'; pill.style.borderColor = 'transparent'; pill.innerText = '-';
                }
            } else { 
                resultSpan.innerText = '0.0'; isTotalValid = false; 
                statCard?.classList.remove('iv-perfect'); statCard?.removeAttribute('title');
                bar.style.width = '0%'; pctText.innerText = '0%';
                pill.style.color = 'var(--text-muted)'; pill.style.backgroundColor = 'transparent'; pill.style.borderColor = 'transparent'; pill.innerText = '-';
            }
        });

        let powerCalc = totalStatsInserted * qVal;
        document.getElementById('iv-total-power').innerText = Math.round(powerCalc).toLocaleString();
        
        if (isTotalValid) {
            sumIVProb = Math.max(0, Math.min(192, sumIVProb));
            let totalBadge = document.getElementById('iv-total-calc-badge');
            totalBadge.innerText = sumIVProb.toFixed(1) + ' / 192';
            updateProgressBar(sumIVProb);
        } else {
            document.getElementById('iv-total-calc-badge').innerText = "0.0 / 192";
            updateProgressBar(0, true);
        }
    }

    function updateProgressBar(total, isInvalid = false) {
        let percent = (total / 192) * 100;
        let pctStr = isInvalid ? "0%" : percent.toFixed(1) + "%";

        document.getElementById('iv-eff-val').innerText = pctStr;
        document.getElementById('iv-donut-val').innerText = isInvalid ? "0%" : Math.round(percent) + "%";

        const donutChart = document.getElementById('iv-donut-chart');
        let color = '#4da6ff'; let title = "-"; let desc = t.waiting;

        if (!isInvalid) {
            if (percent < 42.0) { color = '#ff4d79'; title = t.ivFraco; desc = t.descFraco; }
            else if (percent < 58.0) { color = '#ffb84d'; title = t.ivMediano; desc = t.descMediano; }
            else if (percent < 75.0) { color = '#4da6ff'; title = t.ivBom; desc = t.descBom; } 
            else if (percent < 88.0) { color = '#4dffb8'; title = t.ivMuitoBom; desc = t.descMuitoBom; }
            else if (percent < 98.0) { color = '#00ffff'; title = t.ivExcelente; desc = t.descExcelente; }
            else { color = '#d966ff'; title = t.ivExcepcional; desc = t.descExcepcional; }
        } else { color = 'var(--text-muted)'; desc = t.fillStats; }

        donutChart.style.background = `conic-gradient(${color} ${isInvalid ? 0 : percent}%, rgba(128,128,128,0.1) ${isInvalid ? 0 : percent}%)`;
        if (config.theme === 'neon' && !isInvalid) { donutChart.style.boxShadow = `0 0 15px ${color}44`; } else { donutChart.style.boxShadow = 'none'; }
        
        let titleEl = document.getElementById('iv-donut-title');
        titleEl.innerText = title; titleEl.style.color = color; 
        if (config.theme === 'neon' && !isInvalid) { titleEl.style.textShadow = `0 2px 5px ${color}66`; } else { titleEl.style.textShadow = 'none'; }
        
        document.getElementById('iv-donut-desc').innerText = desc;
        
        let effFill = document.getElementById('iv-progress-fill');
        effFill.style.backgroundColor = color; effFill.style.width = isInvalid ? '0%' : `${percent}%`;
        if (config.theme === 'neon' && !isInvalid) { effFill.style.boxShadow = `0 0 8px ${color}88`; } else { effFill.style.boxShadow = 'none'; }
        
        let totalBadge = document.getElementById('iv-total-calc-badge');
        totalBadge.style.color = color; totalBadge.style.borderColor = color; totalBadge.style.backgroundColor = color + '11';
    }

    async function parseExtractedText(text) {
        if (text.includes("Scanner IVs") || text.includes("CALCULATOR") || text.includes("Dashboard")) return false;
        let updated = false;
        const cleanText = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');

        const regexMap = [
            { stat: 'hp', regex: /(?:HP|Vida)\s*[:.-]?\s*([\d,.]+)/i },
            // El lookbehind evita que "SP.ATK" y "SP.DEF" sobrescriban ATK y DEF.
            { stat: 'atk', regex: /(?<!Sp\.)\b(?:Atk|Attack|Ataque)\b\s*[:.-]?\s*([\d,.]+)/i },
            { stat: 'def', regex: /(?<!Sp\.)\b(?:Def|Defense|Defensa)\b\s*[:.-]?\s*([\d,.]+)/i },
            { stat: 'spa', regex: /(?:SpA|Sp\.\s*Atk|Sp\.Atk|Sp Atk|Spc\.?\s*Atk|Sp\.\s*Ataque)\s*[:.-]?\s*([\d,.]+)/i }
        ];

        for (const item of regexMap) {
            const match = cleanText.match(item.regex);
            if (match && match[1]) {
                const input = document.querySelector(`.stat-input[data-stat="${item.stat}"]`);
                let cleanValue = match[1].replace(/[,.]/g, ''); 
                if (input && input.value !== cleanValue) { input.value = cleanValue; updated = true; }
            }
        }

        let spdMatch = cleanText.match(/SpD\s*[:.-]?\s*([\d,.]+)/) || cleanText.match(/(?:Sp\.\s*Def|Sp\.Def|Sp Def|Spc\.?\s*Def|Sp\.\s*Defensa)\s*[:.-]?\s*([\d,.]+)/i); 
        if (spdMatch && spdMatch[1]) {
            const input = document.querySelector('.stat-input[data-stat="spd"]'); let cleanValue = spdMatch[1].replace(/[,.]/g, '');
            if (input && input.value !== cleanValue) { input.value = cleanValue; updated = true; }
        }

        let velMatch = cleanText.match(/(?:Spd|SPD|Spe|SPE)\s*[:.-]?\s*([\d,.]+)/) || cleanText.match(/(?:Vel|Speed|Velocidad)\s*[:.-]?\s*([\d,.]+)/i); 
        if (velMatch && velMatch[1]) {
            const input = document.querySelector('.stat-input[data-stat="vel"]'); let cleanValue = velMatch[1].replace(/[,.]/g, '');
            if (input && input.value !== cleanValue) { input.value = cleanValue; updated = true; }
        }

        // El tooltip nativo .inv-tip usa distintas variantes según el idioma/versión: Lv, Lv., Lvl, Lvl., Nv y Nivel.
        // Se exige el límite de palabra para no confundir textos como "leveling" ni valores de otros campos.
        const levelMatch = cleanText.match(/\b(?:lvl?|n[vv]|n[ií]vel|level)\.?\s*[:.\-–—=]?\s*([\d,.]+)/i);
        if (levelMatch && levelMatch[1]) {
            const lvlInput = document.getElementById('meta-level'); let cleanLvl = levelMatch[1].replace(/[,.]/g, '');
            if (lvlInput.value !== cleanLvl) { lvlInput.value = cleanLvl; updated = true; }
        }

        const qualityMatch = cleanText.match(/(?:x|×|\*|X|Q\s*:?)\s*(\d+[\.,]\d{1,2})/i);
        if (qualityMatch && qualityMatch[1]) {
            const qInput = document.getElementById('meta-quality'); let qVal = qualityMatch[1].replace(',', '.'); 
            if (qInput.value !== qVal) { qInput.value = qVal; updated = true; }
        }

        const dbKeys = Array.from(allKnownPokemon);
        const words = cleanText.replace(/[^a-zA-Z\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
        let bestMatch = null; let minDistance = Infinity;
        for (let word of words) {
            let w = word.toLowerCase();
            for (let key of dbKeys) {
                let k = key.toLowerCase();
                if (w === k) { bestMatch = key; minDistance = 0; break; }
                let dist = getLevenshteinDistance(w, k);
                if (dist < minDistance && dist <= Math.floor(k.length / 4)) { minDistance = dist; bestMatch = key; }
            }
            if (minDistance === 0) break;
        }

        if (bestMatch) {
            const nameInput = document.getElementById('iv-search-input');
            let formattedName = bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1);
            if (nameInput.value !== formattedName) { nameInput.value = formattedName; updated = true; }
        }

        if (updated) {
            await calculateIVs(); 
            if (bestMatch) {
                let bases = await fetchBaseStats(bestMatch);
                if (bases && bases.id) {
                    const spriteImg = document.getElementById('iv-sprite');
                    spriteImg.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${bases.id}.png`;
                    spriteImg.style.display = 'block';
                }
            }
        }
        return updated;
    }

    function getCompatiblePokemonCard(target) {
        return target?.closest?.([
            // Better Market and More: Depósito personal, Box y Depósito familiar.
            '.depot-entry.depot-pokemon-entry',
            // Better Market and More: ventana "Vender Pokémon" de Sell items and Pokémon.
            '.hunt-sell-row.npc-pokemon-row',
            // Better Market and More: tarjetas de Pokémon para publicar en el mercado.
            '.market-sell-row.market-pokemon-listing'
        ].join(', '));
    }

    async function readCompatiblePokemonCard(card) {
        const cardText = card?.innerText?.trim();
        // Los seis stats son necesarios: así no se abre el panel al pasar por una tarjeta de objeto.
        if (!cardText || !/\bHP\s*[:.-]?\s*\d+/i.test(cardText) || !/\b(?:ATK|Atk|Attack|Ataque)\s*[:.-]?\s*\d+/i.test(cardText)) return;

        // El hover solo sincroniza los datos. La visibilidad del panel sigue
        // dependiendo exclusivamente del botón flotante o de la tecla rápida.
        const calcTab = document.querySelector('.iv-tab[data-tab="calc"]');
        if (calcTab && !calcTab.classList.contains('active')) calcTab.click();

        const statusEl = document.getElementById('iv-ocr-status');
        if (statusEl) { statusEl.innerText = '🖱️ Leyendo tarjeta...'; statusEl.style.color = 'var(--accent)'; }
        const updated = await parseExtractedText(cardText);
        if (!statusEl) return;
        statusEl.innerText = updated ? '✅ Tarjeta cargada' : '⚠️ Tarjeta sin cambios';
        statusEl.style.color = updated ? '#4dffb8' : '#ffb84d';
        setTimeout(() => {
            if (statusEl.innerText.includes('Tarjeta')) {
                statusEl.innerText = t.statusStart;
                statusEl.style.color = 'var(--accent)';
            }
        }, 2500);
    }

    // Lectura por hover de las tarjetas creadas por Better Market and More, sin modificar ese userscript.
    document.addEventListener('pointerover', (e) => {
        const card = getCompatiblePokemonCard(e.target);
        if (!card || card === lastHoveredPokemonCard) return;
        lastHoveredPokemonCard = card;
        clearTimeout(cardHoverTimeout);
        cardHoverTimeout = setTimeout(() => readCompatiblePokemonCard(card), 180);
    });

    document.addEventListener('pointerout', (e) => {
        const card = getCompatiblePokemonCard(e.target);
        if (!card || card.contains(e.relatedTarget)) return;
        if (card === lastHoveredPokemonCard) {
            clearTimeout(cardHoverTimeout);
            lastHoveredPokemonCard = null;
        }
    });

    document.addEventListener('click', (e) => {
        if(!isPanelOpen) return;
        let marketCard = e.target.closest('.mkt2-card, .mkt2-card-info');
        if (marketCard) {
            let infoDiv = marketCard.classList.contains('mkt2-card-info') ? marketCard : marketCard.querySelector('.mkt2-card-info');
            let textSource = infoDiv ? infoDiv.innerText : marketCard.innerText;
            if (textSource) {
                let visualTarget = marketCard.closest('.mkt2-card') || marketCard;
                let origOutline = visualTarget.style.outline;
                visualTarget.style.outline = '2px solid var(--accent)';
                setTimeout(() => visualTarget.style.outline = origOutline, 500);

                const calcTab = document.querySelector('.iv-tab[data-tab="calc"]'); if (calcTab) calcTab.click();
                const statusEl = document.getElementById('iv-ocr-status'); if (statusEl) { statusEl.innerText = '🛒 Local...'; }

                clearTimeout(domScanTimeout);
                domScanTimeout = setTimeout(async () => { 
                    let updated = await parseExtractedText(textSource); 
                    if (statusEl) {
                        if (updated) { statusEl.innerText = t.msgMktOk; statusEl.style.color = '#4dffb8'; } 
                        else { statusEl.innerText = t.msgMktFail; statusEl.style.color = '#ffb84d'; }
                        setTimeout(() => { statusEl.innerText = t.statusStart; statusEl.style.color = 'var(--accent)'; }, 4000);
                    }
                }, 150); return;
            }
        }

        let target = e.target.closest('div, li, tr');
        if (target && target.innerText && target.innerText.length < 1000) {
            if (/HP\s*[:.-]?\s*\d+/i.test(target.innerText) && /(?:Atk|Attack)\s*[:.-]?\s*\d+/i.test(target.innerText)) {
                let visualTarget = target; let origOutline = visualTarget.style.outline;
                visualTarget.style.outline = '2px solid var(--accent)';
                setTimeout(() => visualTarget.style.outline = origOutline, 500);
                const calcTab = document.querySelector('.iv-tab[data-tab="calc"]'); if (calcTab) calcTab.click();
                const statusEl = document.getElementById('iv-ocr-status'); if (statusEl) { statusEl.innerText = '🌐 Global...'; }

                clearTimeout(domScanTimeout);
                domScanTimeout = setTimeout(async () => {
                    let updated = await parseExtractedText(target.innerText);
                    if (statusEl) {
                        if (updated) { statusEl.innerText = t.msgMktOk; statusEl.style.color = '#4dffb8'; }
                        else { statusEl.innerText = t.msgMktFail; statusEl.style.color = '#ffb84d'; }
                        setTimeout(() => { statusEl.innerText = t.statusStart; statusEl.style.color = 'var(--accent)'; }, 4000);
                    }
                }, 150);
            }
        }
    });

    const tooltipObserver = new MutationObserver((mutations) => {
        if (!isPanelOpen || document.getElementById('tab-calc').style.display === 'none') return;
        const tip = document.querySelector('.inv-tip');
        if (tip) {
            const currentText = tip.innerText;
            if (currentText && currentText !== lastTooltipText && currentText.length > 20) {
                if (/HP\s*[:.-]?\s*\d+/i.test(currentText) && /Atk\s*[:.-]?\s*\d+/i.test(currentText)) {
                    lastTooltipText = currentText; clearTimeout(tooltipScanTimeout);
                    tooltipScanTimeout = setTimeout(async () => {
                        const statusEl = document.getElementById('iv-ocr-status'); if (statusEl) { statusEl.innerText = '🔍 Evaluando...'; }
                        let updated = await parseExtractedText(currentText);
                        if (statusEl) {
                            if (updated) { statusEl.innerText = '✅ ¡Extraído!'; statusEl.style.color = '#4dffb8'; } 
                            else { statusEl.innerText = '⚠️ Repetido.'; statusEl.style.color = '#ffb84d'; }
                            setTimeout(() => { if(statusEl.innerText.includes('Extraído') || statusEl.innerText.includes('Repetido')) { statusEl.innerText = t.statusStart; statusEl.style.color = 'var(--accent)'; } }, 3000);
                        }
                    }, 200);
                }
            }
        } else { lastTooltipText = ""; }
    });

    function handlePaste(e) {
        if (!isPanelOpen || document.getElementById('tab-calc').style.display === 'none') return;
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let index in items) { if (items[index].kind === 'file') processCloudOCR(items[index].getAsFile()); }
    }
    function handleImageUpload(e) { if (e.target.files[0]) processCloudOCR(e.target.files[0]); }

    function processCloudOCR(imageBlob) {
        const statusEl = document.getElementById('iv-ocr-status'); statusEl.innerText = t.msgCloudPrep;
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
                const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
                const jpegBase64 = canvas.toDataURL('image/jpeg', 0.9);
                statusEl.innerText = t.msgCloudAnal;
                GM_xmlhttpRequest({
                    method: "POST", url: "https://api.ocr.space/parse/image",
                    headers: { "apikey": "helloworld", "Content-Type": "application/x-www-form-urlencoded" },
                    data: "base64Image=" + encodeURIComponent(jpegBase64) + "&language=eng&isOverlayRequired=false&scale=true&OCREngine=2",
                    onload: async function(response) {
                        try {
                            const json = JSON.parse(response.responseText);
                            if (json.IsErroredOnProcessing || !json.ParsedResults || json.ParsedResults.length === 0) { throw new Error("Unreadable"); }
                            const text = json.ParsedResults[0].ParsedText;
                            const updated = await parseExtractedText(text);
                            if (updated) { statusEl.innerText = t.msgCloudOk; statusEl.style.color = '#4dffb8'; } 
                            else { statusEl.innerText = t.msgCloudFail; statusEl.style.color = '#ffb84d'; }
                            setTimeout(() => { statusEl.innerText = t.statusStart; statusEl.style.color = 'var(--accent)'; }, 7000);
                        } catch (err) { statusEl.innerText = `❌ Error API`; statusEl.style.color = '#ff4d79'; }
                    },
                    onerror: function() { statusEl.innerText = '❌ Error Red'; statusEl.style.color = '#ff4d79'; }
                });
            }; img.src = event.target.result;
        }; reader.readAsDataURL(imageBlob);
    }

    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
            const ws = new target(...args);
            ws.addEventListener('message', function(event) {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "pokes" && Array.isArray(data.list) && data.list.length > 0) syncEquippedPokemon(data.list);
                    if (data.type === "wild_encounter" || data.wild_pokemon) { currentPokeData = data.wild_pokemon || data.pokemon; if (isPanelOpen) loadSpriteAndCalculate(); }
                } catch (e) {}
            }); return ws;
        }
    });

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => { initUI(); tooltipObserver.observe(document.body, { childList: true, subtree: true, characterData: true }); }); } 
    else { initUI(); tooltipObserver.observe(document.body, { childList: true, subtree: true, characterData: true }); }
})();
