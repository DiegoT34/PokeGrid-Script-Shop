// ==UserScript==
// @name         PokeIdle Combat Log 1.16 (Colorful Moves)
// @namespace    http://tampermonkey.net/
// @version      1.16.0
// @author       Phoslead (UI Mod)
// @description  Combat Log minimalista con fijación, registros top-down y colores dinámicos para los movimientos.
// @match        https://poke.idleworld.online/play
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // BASE DE DATOS COMPLETA EXTRAÍDA DE LA POKÉDEX
    const POKEDEX = {
        1: "Bulbasaur", 2: "Ivysaur", 3: "Venusaur", 4: "Charmander", 5: "Charmeleon", 6: "Charizard", 7: "Squirtle", 8: "Wartortle", 9: "Blastoise", 10: "Caterpie",
        11: "Metapod", 12: "Butterfree", 13: "Weedle", 14: "Kakuna", 15: "Beedrill", 16: "Pidgey", 17: "Pidgeotto", 18: "Pidgeot", 19: "Rattata", 20: "Raticate",
        21: "Spearow", 22: "Fearow", 23: "Ekans", 24: "Arbok", 25: "Pikachu", 26: "Raichu", 27: "Sandshrew", 28: "Sandslash", 29: "Nidoran Female", 30: "Nidorina",
        31: "Nidoqueen", 32: "Nidoran Male", 33: "Nidorino", 34: "Nidoking", 35: "Clefairy", 36: "Clefable", 37: "Vulpix", 38: "Ninetales", 39: "Jigglypuff", 40: "Wigglytuff",
        41: "Zubat", 42: "Golbat", 43: "Oddish", 44: "Gloom", 45: "Vileplume", 46: "Paras", 47: "Parasect", 48: "Venonat", 49: "Venomoth", 50: "Diglett",
        51: "Dugtrio", 52: "Meowth", 53: "Persian", 54: "Psyduck", 55: "Golduck", 56: "Mankey", 57: "Primeape", 58: "Growlithe", 59: "Arcanine", 60: "Poliwag",
        61: "Poliwhirl", 62: "Poliwrath", 63: "Abra", 64: "Kadabra", 65: "Alakazam", 66: "Machop", 67: "Machoke", 68: "Machamp", 69: "Bellsprout", 70: "Weepinbell",
        71: "Victreebel", 72: "Tentacool", 73: "Tentacruel", 74: "Geodude", 75: "Graveler", 76: "Golem", 77: "Ponyta", 78: "Rapidash", 79: "Slowpoke", 80: "Slowbro",
        81: "Magnemite", 82: "Magneton", 83: "Farfetchd", 84: "Doduo", 85: "Dodrio", 86: "Seel", 87: "Dewgong", 88: "Grimer", 89: "Muk", 90: "Shellder",
        91: "Cloyster", 92: "Gastly", 93: "Haunter", 94: "Gengar", 95: "Onix", 96: "Drowzee", 97: "Hypno", 98: "Krabby", 99: "Kingler", 100: "Voltorb",
        101: "Electrode", 102: "Exeggcute", 103: "Exeggutor", 104: "Cubone", 105: "Marowak", 106: "Hitmonlee", 107: "Hitmonchan", 108: "Lickitung", 109: "Koffing", 110: "Weezing",
        111: "Rhyhorn", 112: "Rhydon", 113: "Chansey", 114: "Tangela", 115: "Kangaskhan", 116: "Horsea", 117: "Seadra", 118: "Goldeen", 119: "Seaking", 120: "Staryu",
        121: "Starmie", 122: "Mr. Mime", 123: "Scyther", 124: "Jynx", 125: "Electabuzz", 126: "Magmar", 127: "Pinsir", 128: "Tauros", 129: "Magikarp", 130: "Gyarados",
        131: "Lapras", 132: "Ditto", 133: "Eevee", 134: "Vaporeon", 135: "Jolteon", 136: "Flareon", 137: "Porygon", 138: "Omanyte", 139: "Omastar", 140: "Kabuto",
        141: "Kabutops", 142: "Aerodactyl", 143: "Snorlax", 144: "Articuno", 145: "Zapdos", 146: "Moltres", 147: "Dratini", 148: "Dragonair", 149: "Dragonite", 150: "Mewtwo",
        151: "Mew", 152: "Chikorita", 153: "Bayleef", 154: "Meganium", 155: "Cyndaquil", 156: "Quilava", 157: "Typhlosion", 158: "Totodile", 159: "Croconaw", 160: "Feraligatr",
        161: "Sentret", 162: "Furret", 163: "Hoothoot", 164: "Noctowl", 165: "Ledyba", 166: "Ledian", 167: "Spinarak", 168: "Ariados", 169: "Crobat", 170: "Chinchou",
        171: "Lanturn", 172: "Pichu", 173: "Cleffa", 174: "Igglybuff", 175: "Togepi", 176: "Togetic", 177: "Natu", 178: "Xatu", 179: "Mareep", 180: "Flaaffy",
        181: "Ampharos", 182: "Bellossom", 183: "Marill", 184: "Azumarill", 185: "Sudowoodo", 186: "Politoed", 187: "Hoppip", 188: "Skiploom", 189: "Jumpluff", 190: "Aipom",
        191: "Sunkern", 192: "Sunflora", 193: "Yanma", 194: "Wooper", 195: "Quagsire", 196: "Espeon", 197: "Umbreon", 198: "Murkrow", 199: "Slowking", 200: "Misdreavus",
        201: "Unown", 202: "Wobbuffet", 203: "Girafarig", 204: "Pineco", 205: "Forretress", 206: "Dunsparce", 207: "Gligar", 208: "Steelix", 209: "Snubbull", 210: "Granbull",
        211: "Qwilfish", 212: "Scizor", 213: "Shuckle", 214: "Heracross", 215: "Sneasel", 216: "Teddiursa", 217: "Ursaring", 218: "Slugma", 219: "Magcargo", 220: "Swinub",
        221: "Piloswine", 222: "Corsola", 223: "Remoraid", 224: "Octillery", 225: "Delibird", 226: "Mantine", 227: "Skarmory", 228: "Houndour", 229: "Houndoom", 230: "Kingdra",
        231: "Phanpy", 232: "Donphan", 233: "Porygon2", 234: "Stantler", 235: "Smeargle", 236: "Tyrogue", 237: "Hitmontop", 238: "Smoochum", 239: "Elekid", 240: "Magby",
        241: "Miltank", 242: "Blissey", 243: "Raikou", 244: "Entei", 245: "Suicune", 246: "Larvitar", 247: "Pupitar", 248: "Tyranitar", 249: "Lugia", 250: "Ho-oh",
        251: "Celebi", 252: "Treecko", 253: "Grovyle", 254: "Sceptile", 255: "Torchic", 256: "Combusken", 257: "Blaziken", 258: "Mudkip", 259: "Marshtomp", 260: "Swampert",
        261: "Poochyena", 262: "Mightyena", 270: "Lotad", 271: "Lombre", 272: "Ludicolo", 273: "Seedot", 274: "Nuzleaf", 275: "Shiftry", 276: "Taillow", 277: "Swellow",
        278: "Wingull", 279: "Pelipper", 280: "Ralts", 281: "Kirlia", 282: "Gardevoir", 287: "Slakoth", 288: "Vigoroth", 293: "Whismur", 294: "Loudred", 295: "Exploud",
        296: "Makuhita", 302: "Sableye", 303: "Mawile", 304: "Aron", 305: "Lairon", 306: "Aggron", 307: "Meditite", 308: "Medicham", 309: "Electrike", 310: "Manectric",
        322: "Numel", 323: "Camerupt", 324: "Torkoal", 325: "Spoink", 326: "Grumpig", 328: "Trapinch", 329: "Vibrava", 330: "Flygon", 332: "Cacturne", 333: "Swablu",
        334: "Altaria", 335: "Zangoose", 336: "Seviper", 341: "Corphish", 342: "Crawdaunt", 343: "Baltoy", 344: "Claydol", 354: "Banette", 355: "Duskull", 356: "Dusclops",
        357: "Tropius", 359: "Absol", 361: "Snorunt", 362: "Glalie", 363: "Spheal", 364: "Sealeo", 365: "Walrein", 371: "Bagon", 372: "Shelgon", 374: "Beldum",
        375: "Metang", 447: "Riolu", 448: "Lucario"
    };

    function saveLocal(key, value) {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue(key, value);
        } else {
            try { localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : value); } catch (e) { }
        }
    }

    function loadLocal(key, def) {
        if (typeof GM_getValue !== 'undefined') {
            return GM_getValue(key, def);
        } else {
            try { 
                let val = localStorage.getItem(key);
                if (val === null) return def;
                try { return JSON.parse(val); } catch(e) { return val === 'true' ? true : (val === 'false' ? false : val); }
            } catch (e) { return def; }
        }
    }

    // FUNCIÓN: Genera un color único y estético basado en el nombre del movimiento
    function getMoveColor(moveName) {
        if (!moveName) return '#94a3b8'; // Color fallback (gris azulado)
        let hash = 0;
        for (let i = 0; i < moveName.length; i++) {
            hash = moveName.charCodeAt(i) + ((hash << 5) - hash);
        }
        // Retorna un color HSL pastel brillante (Alta saturación, alta luminosidad)
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 85%, 72%)`;
    }

    let currentLang = loadLocal('pokeidle_cl_lang', 'ES');
    let isPinned = loadLocal('pokeidle_cl_pinned', false);
    
    const i18n = {
        ES: { copy: 'Copiar', copied: 'Copiado', export: 'Guardar', exported: 'Guardado', reset: 'Reset', active: 'Activo', dealt: 'infligió', taken: 'recibió', levelUp: 'subió a nivel', noPokemon: 'Buscando Pokémon...', noDamage: 'Aún sin daño.', waiting: 'Esperando combate...' },
        EN: { copy: 'Copy', copied: 'Copied', export: 'Save', exported: 'Saved', reset: 'Reset', active: 'Active', dealt: 'dealt', taken: 'taken', levelUp: 'leveled up to', noPokemon: 'Scanning Pokémon...', noDamage: 'No damage yet.', waiting: 'Waiting for combat...' },
        BR: { copy: 'Copiar', copied: 'Copiado', export: 'Salvar', exported: 'Salvo', reset: 'Reset', active: 'Ativo', dealt: 'causou', taken: 'recebeu', levelUp: 'subiu ao nível', noPokemon: 'Buscando Pokémon...', noDamage: 'Sem dano ainda.', waiting: 'Aguardando combate...' }
    };
    let t = i18n[currentLang] || i18n['ES'];

    function changeLanguage(lang) {
        if (!i18n[lang]) return;
        currentLang = lang;
        saveLocal('pokeidle_cl_lang', lang);
        t = i18n[currentLang];

        const copyBtn = document.getElementById('cl-copy-json');
        if (copyBtn) copyBtn.innerHTML = `📋 ${t.copy}`;
        const exportBtn = document.getElementById('cl-export-json');
        if (exportBtn) exportBtn.innerHTML = `💾 ${t.export}`;
        const resetBtn = document.getElementById('cl-reset-stats');
        if (resetBtn) resetBtn.innerHTML = `♻️ ${t.reset}`;
        const langToggle = document.getElementById('cl-lang-toggle');
        if (langToggle) langToggle.innerHTML = `🌐 Lng`;

        updateStatsUI();
    }

    function resolvePokemonName(id, speciesId) {
        if (speciesId && POKEDEX[speciesId]) return POKEDEX[speciesId];
        return pokemonNameMap[id] || `Pokémon #${speciesId || '?'}`;
    }

    const pokemonNameMap = {};
    const pokemonDetailsMap = {};
    let activePokeId = 'default';
    let playerTeamIds = [];
    const pokeStats = {};
    let totalDealtAll = 0;
    let totalTakenAll = 0;
    let sessionStartTime = null;
    let timerInterval = null;
    let sessionStarted = false;
    let expandedPokeId = null;
    let currentHunt = 'Unknown';

    function getFormattedTimerTime() {
        if (!sessionStarted || !sessionStartTime) return "+00:00:00";
        const elapsedMs = Date.now() - sessionStartTime;
        const totalSeconds = Math.floor(elapsedMs / 1000);
        const hrs = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
        const mins = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
        const secs = String(totalSeconds % 60).padStart(2, '0');
        return `+${hrs}:${mins}:${secs}`;
    }

    function registerActiveCombatPoke(id, speciesId) {
        if (!id || id === 'default') return null;
        const details = pokemonDetailsMap[id] || {};
        const name = resolvePokemonName(id, speciesId || details.speciesId);

        if (!pokeStats[id]) {
            pokeStats[id] = {
                name: name, level: details.level || '?', quality: details.quality || 'Normal', stats: details.stats || null,
                dealt: 0, taken: 0, dealtHitsCount: 0, takenHitsCount: 0, history: []
            };
        } else {
            if (name && (pokeStats[id].name === 'Pokémon Activo' || pokeStats[id].name.startsWith('Pokémon #'))) {
                pokeStats[id].name = name;
            }
            if (details.level) pokeStats[id].level = details.level;
            if (details.quality) pokeStats[id].quality = details.quality;
            if (details.stats) pokeStats[id].stats = details.stats;
        }
        return pokeStats[id];
    }

    function startSessionTimer() {
        sessionStartTime = Date.now();
        sessionStarted = true;
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            const timerEl = document.getElementById('cl-session-timer');
            if (!timerEl) return;
            const elapsedMs = Date.now() - sessionStartTime;
            const totalSeconds = Math.floor(elapsedMs / 1000);
            const hrs = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
            const mins = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
            const secs = String(totalSeconds % 60).padStart(2, '0');
            timerEl.textContent = `${hrs}:${mins}:${secs}`;
        }, 1000);
    }

    function stopSessionTimer() {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = null;
    }

    function resetSessionTimer() {
        stopSessionTimer();
        sessionStartTime = null;
        sessionStarted = false;
        const timerEl = document.getElementById('cl-session-timer');
        if (timerEl) timerEl.textContent = '00:00:00';
    }

    function resetAllCombatData(reason = 'Estadísticas reiniciadas.') {
        totalDealtAll = 0;
        totalTakenAll = 0;
        for (const key in pokeStats) delete pokeStats[key];
        resetSessionTimer();
        updateStatsUI();
    }

    function buildExportDataObject() {
        return {
            hunt: currentHunt,
            sessionDurationSeconds: sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0,
            exportedAt: new Date().toISOString(),
            summary: { totalDamageDealt: totalDealtAll, totalDamageTaken: totalTakenAll },
            pokemons: Object.keys(pokeStats).map(id => {
                const p = pokeStats[id];
                return {
                    id: id, name: p.name, level: p.level, quality: p.quality, stats: p.stats,
                    totalDealt: p.dealt, totalTaken: p.taken, dealtHitsCount: p.dealtHitsCount,
                    avgDealtPerHit: p.dealtHitsCount > 0 ? Math.round(p.dealt / p.dealtHitsCount) : 0,
                    history: p.history
                };
            })
        };
    }

    function createCombatLogUI() {
        if (document.getElementById('combat-log-hud')) return;

        const style = document.createElement('style');
        style.textContent = `
            #combat-log-hud {
                position: fixed; bottom: 20px; right: 20px; width: 300px; max-height: 420px;
                background: rgba(15, 15, 20, 0.85); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px;
                color: #e2e8f0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                font-size: 11px; z-index: 999999; box-shadow: 0 10px 25px rgba(0,0,0,0.6);
                display: flex; flex-direction: column; overflow: hidden; user-select: none;
            }
            .cl-header {
                background: rgba(0, 0, 0, 0.4); padding: 8px 12px; font-weight: 600; font-size: 11px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05); display: flex;
                justify-content: space-between; align-items: center; 
            }
            .cl-header-title { display: flex; align-items: center; gap: 8px; }
            .cl-header-controls { display: flex; align-items: center; gap: 4px; }
            .cl-icon-btn { cursor: pointer; font-size: 10px; transition: 0.2s; padding: 2px; border-radius: 4px;}
            .cl-icon-btn:hover { background: rgba(255,255,255,0.1); }
            
            .cl-actions { display: flex; gap: 4px; align-items: center; }
            .cl-btn {
                background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
                color: #cbd5e1; padding: 3px 6px; border-radius: 6px; cursor: pointer;
                font-size: 9px; font-weight: 600; transition: 0.2s; display: flex; align-items: center; gap: 4px;
            }
            .cl-btn:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }
            .cl-stats-header {
                padding: 10px 12px; font-weight: bold; background: transparent;
                display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.03);
            }
            .cl-row {
                padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.02);
                transition: background 0.15s; background: transparent;
            }
            .cl-row:hover { background: rgba(255, 255, 255, 0.03); }
            .cl-row.active { background: rgba(96, 165, 250, 0.08); border-left: 2px solid #60a5fa; padding-left: 10px; }
            .cl-row-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
            .cl-row-bottom { display: flex; gap: 12px; font-size: 10px; padding-left: 14px; }
            .cl-history {
                background: rgba(0, 0, 0, 0.3); padding: 8px 12px; max-height: 160px; overflow-y: auto;
                font-family: 'Consolas', monospace; font-size: 9px; border-bottom: 1px solid rgba(255,255,255,0.02);
            }
            .cl-history-item { display: flex; gap: 6px; align-items: baseline; margin: 3px 0; }
            
            #combat-log-hud ::-webkit-scrollbar { width: 4px; }
            #combat-log-hud ::-webkit-scrollbar-track { background: transparent; }
            #combat-log-hud ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
            #combat-log-hud ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
        `;
        document.head.appendChild(style);

        const hud = document.createElement('div');
        hud.id = 'combat-log-hud';
        
        // Cargar posiciones guardadas
        const savedLeft = loadLocal('pokeidle_cl_left', null);
        const savedTop = loadLocal('pokeidle_cl_top', null);
        if (savedLeft !== null && savedTop !== null) {
            hud.style.left = savedLeft;
            hud.style.top = savedTop;
            hud.style.bottom = 'auto';
            hud.style.right = 'auto';
        }

        hud.innerHTML = `
            <div class="cl-header" id="cl-header" style="cursor: ${isPinned ? 'default' : 'move'};">
                <div class="cl-header-title">
                    <div class="cl-header-controls">
                        <span class="cl-icon-btn" id="cl-minimize-btn" title="Minimizar">➖</span>
                        <span class="cl-icon-btn" id="cl-pin-btn" title="Fijar Panel" style="opacity: ${isPinned ? '1' : '0.5'};">${isPinned ? '📌' : '📍'}</span>
                    </div>
                    <span style="letter-spacing: 0.5px; color: #fff;">⚔️ COMBAT LOG</span>
                </div>
                <div class="cl-actions" id="cl-actions-container">
                    <div style="position: relative;">
                        <button class="cl-btn" id="cl-lang-toggle">🌐 Lng</button>
                        <div id="cl-lang-menu" style="display: none; position: absolute; top: 120%; right: 0; background: #1a1a24; border: 1px solid #444; border-radius: 6px; padding: 4px; z-index: 10; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                            <div class="cl-lang-option" data-lang="ES" style="cursor: pointer; padding: 4px 8px; font-size: 9px; border-radius: 4px;">Español</div>
                            <div class="cl-lang-option" data-lang="EN" style="cursor: pointer; padding: 4px 8px; font-size: 9px; border-radius: 4px;">English</div>
                            <div class="cl-lang-option" data-lang="BR" style="cursor: pointer; padding: 4px 8px; font-size: 9px; border-radius: 4px;">Português</div>
                        </div>
                    </div>
                    <button class="cl-btn" id="cl-copy-json" title="Copiar JSON">📋 ${t.copy}</button>
                    <button class="cl-btn" id="cl-export-json" title="Descargar JSON">💾 ${t.export}</button>
                    <button class="cl-btn" id="cl-reset-stats" title="Resetear" style="color: #fbbf24;">♻️ ${t.reset}</button>
                </div>
            </div>

            <div id="combat-stats-panel" style="flex-grow: 1; display: flex; flex-direction: column; overflow: hidden;">
                <div class="cl-stats-header">
                    <div>
                        <span style="color: #94a3b8; margin-right: 4px;">⏱️</span>
                        <span id="cl-session-timer" style="color: #60a5fa; font-family: monospace;">00:00:00</span> 
                        <span id="cl-current-hunt" style="color: #fbbf24; font-size: 9px; margin-left: 4px; opacity: 0.8;">(${currentHunt})</span>
                    </div>
                    <div style="font-size: 10px;">
                        <span style="color: #4ade80;">⚔️ <span id="stat-total-dealt">0</span></span>
                        <span style="color: #475569; margin: 0 4px;">|</span>
                        <span style="color: #f87171;">💥 <span id="stat-total-taken">0</span></span>
                    </div>
                </div>
                <div id="stats-individual-list" style="overflow-y: auto; flex-grow: 1; padding-bottom: 4px;">
                    <div style="color: #64748b; font-style: italic; padding: 12px; text-align: center;">${t.waiting}</div>
                </div>
            </div>
        `;

        document.body.appendChild(hud);

        // Language Menu
        const langToggle = document.getElementById('cl-lang-toggle');
        const langMenu = document.getElementById('cl-lang-menu');
        if (langToggle && langMenu) {
            langToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                langMenu.style.display = langMenu.style.display === 'none' ? 'block' : 'none';
            });
            document.querySelectorAll('.cl-lang-option').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    changeLanguage(e.target.getAttribute('data-lang'));
                    langMenu.style.display = 'none';
                });
                opt.addEventListener('mouseenter', e => e.target.style.background = 'rgba(255,255,255,0.1)');
                opt.addEventListener('mouseleave', e => e.target.style.background = 'transparent');
            });
            document.addEventListener('click', (e) => {
                if (!langMenu.contains(e.target) && e.target !== langToggle) langMenu.style.display = 'none';
            });
        }

        makeElementDraggable(hud, document.getElementById('cl-header'));

        // Botones 
        document.getElementById('cl-pin-btn').addEventListener('click', (e) => {
            isPinned = !isPinned;
            saveLocal('pokeidle_cl_pinned', isPinned);
            e.target.textContent = isPinned ? '📌' : '📍';
            e.target.style.opacity = isPinned ? '1' : '0.5';
            document.getElementById('cl-header').style.cursor = isPinned ? 'default' : 'move';
            
            if(isPinned) {
                 saveLocal('pokeidle_cl_left', hud.style.left || (hud.offsetLeft + 'px'));
                 saveLocal('pokeidle_cl_top', hud.style.top || (hud.offsetTop + 'px'));
            }
        });

        document.getElementById('cl-export-json').addEventListener('click', () => {
            const data = JSON.stringify(buildExportDataObject(), null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pokeidle_combat_${currentHunt}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            const btn = document.getElementById('cl-export-json');
            btn.innerHTML = `✅ ${t.exported}`;
            btn.style.color = '#4ade80';
            setTimeout(() => { btn.innerHTML = `💾 ${t.export}`; btn.style.color = ''; }, 2000);
        });

        document.getElementById('cl-reset-stats').addEventListener('click', () => resetAllCombatData('Manual reset'));

        document.getElementById('cl-minimize-btn').addEventListener('click', (e) => {
            const panel = document.getElementById('combat-stats-panel');
            const actions = document.getElementById('cl-actions-container');
            if (panel.style.display === 'none') {
                panel.style.display = 'flex';
                if (actions) actions.style.display = 'flex';
                hud.style.width = '300px';
                e.target.textContent = '➖';
            } else {
                panel.style.display = 'none';
                if (actions) actions.style.display = 'none';
                hud.style.width = '160px';
                e.target.textContent = '➕';
            }
        });

        document.getElementById('cl-copy-json').addEventListener('click', () => {
            navigator.clipboard.writeText(JSON.stringify(buildExportDataObject(), null, 2)).then(() => {
                const btn = document.getElementById('cl-copy-json');
                btn.innerHTML = `✅ ${t.copied}`;
                btn.style.color = '#4ade80';
                setTimeout(() => { btn.innerHTML = `📋 ${t.copy}`; btn.style.color = ''; }, 2000);
            });
        });
    }

    function makeElementDraggable(elmnt, dragHandler) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        dragHandler.onmousedown = (e) => {
            if(isPinned) return; 
            if(e.target.tagName === 'BUTTON' || e.target.id === 'cl-minimize-btn' || e.target.id === 'cl-pin-btn') return;
            
            e.preventDefault();
            pos3 = e.clientX; pos4 = e.clientY;
            
            document.onmouseup = () => { 
                document.onmouseup = null; 
                document.onmousemove = null; 
                saveLocal('pokeidle_cl_left', elmnt.style.left);
                saveLocal('pokeidle_cl_top', elmnt.style.top);
            };
            
            document.onmousemove = (e) => {
                e.preventDefault();
                pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
                pos3 = e.clientX; pos4 = e.clientY;
                
                let newTop = elmnt.offsetTop - pos2;
                let newLeft = elmnt.offsetLeft - pos1;
                const maxLeft = window.innerWidth - elmnt.offsetWidth;
                const maxTop = window.innerHeight - elmnt.offsetHeight;
                
                if (newLeft < 0) newLeft = 0; if (newTop < 0) newTop = 0;
                if (newLeft > maxLeft) newLeft = maxLeft; if (newTop > maxTop) newTop = maxTop;
                
                elmnt.style.top = newTop + "px"; elmnt.style.left = newLeft + "px";
                elmnt.style.bottom = 'auto'; elmnt.style.right = 'auto';
            };
        };
    }

    function updateStatsUI() {
        const totalDealtEl = document.getElementById('stat-total-dealt');
        const totalTakenEl = document.getElementById('stat-total-taken');
        const listEl = document.getElementById('stats-individual-list');
        if (!totalDealtEl || !listEl) return;

        totalDealtEl.textContent = totalDealtAll.toLocaleString();
        totalTakenEl.textContent = totalTakenAll.toLocaleString();

        const historyContainer = document.getElementById('expanded-history-container');
        let savedScrollTop = null, isAtTop = false;
        
        if (historyContainer) {
            savedScrollTop = historyContainer.scrollTop;
            isAtTop = savedScrollTop < 15; 
        }

        let html = '';
        for (const id in pokeStats) {
            const poke = pokeStats[id];
            const isActive = id === activePokeId;
            const isExpanded = id === expandedPokeId;
            const avgDealt = poke.dealtHitsCount > 0 ? Math.round(poke.dealt / poke.dealtHitsCount) : 0;

            html += `
                <div>
                    <div class="cl-row poke-row-toggle ${isActive ? 'active' : ''}" data-poke-id="${id}">
                        <div class="cl-row-top">
                            <div style="display: flex; gap: 6px; align-items: center;">
                                <span style="color: #475569; font-size: 8px; width: 8px;">${isExpanded ? '▼' : '▶'}</span>
                                <span style="color: ${isActive ? '#fff' : '#e2e8f0'}; font-weight: 600;">${poke.name}</span>
                                ${poke.level !== '?' ? `<span style="background: rgba(251, 191, 36, 0.15); color: #fbbf24; font-size: 9px; padding: 1px 4px; border-radius: 4px;">Lv.${poke.level}</span>` : ''}
                                ${isActive ? `<span style="border: 1px solid #60a5fa; color: #60a5fa; font-size: 8px; padding: 0 4px; border-radius: 4px; text-transform: uppercase;">${t.active}</span>` : ''}
                            </div>
                            <div style="font-size: 9px; color: #64748b;">
                                Avg: <span style="color: #4ade80;">${avgDealt.toLocaleString()}</span>
                            </div>
                        </div>
                        <div class="cl-row-bottom">
                            <span style="color: #4ade80;">⚔️ ${poke.dealt.toLocaleString()}</span>
                            <span style="color: #f87171;">💥 ${poke.taken.toLocaleString()}</span>
                        </div>
                    </div>

                    ${isExpanded ? `
                        <div class="cl-history" id="expanded-history-container">
                            ${poke.stats ? `
                                <div style="display: flex; justify-content: space-between; background: rgba(255,255,255,0.04); padding: 4px; border-radius: 4px; margin-bottom: 6px; color: #cbd5e1; font-size: 8px;">
                                    ${Object.entries(poke.stats).map(([k, v]) => `<span><b style="color:#94a3b8;">${k.toUpperCase()}</b> ${v}</span>`).join('')}
                                </div>
                            ` : ''}
                            
                            ${poke.history.length === 0 ? `<div style="color: #64748b; font-style: italic;">${t.noDamage}</div>` : 
                                poke.history.slice(-60).reverse().map(h => {
                                    if (h.type === 'level_up') {
                                        return `<div class="cl-history-item" style="background: rgba(251, 191, 36, 0.1); padding: 2px 4px; border-radius: 4px;">
                                            <span style="color: #94a3b8;">[${h.timerTime}]</span>
                                            <span style="color: #fbbf24;">⬆️ ${t.levelUp} <b style="color:#fff;">${h.newLevel}</b></span>
                                        </div>`;
                                    }
                                    const isDealt = h.type === 'dealt';
                                    const moveColor = getMoveColor(h.move); // Color generado dinámicamente

                                    return `<div class="cl-history-item">
                                        <span style="color: #64748b;">[${h.timerTime}]</span>
                                        <span style="color: ${isDealt ? '#4ade80' : '#f87171'}; width: 55px;">${isDealt ? '⚔️' : '💥'} ${h.amount.toLocaleString()}</span>
                                        <span style="color: ${moveColor}; font-size: 9px; font-weight: 500; opacity: 0.9;">(${h.move})</span>
                                    </div>`;
                                }).join('')
                            }
                        </div>
                    ` : ''}
                </div>
            `;
        }

        listEl.innerHTML = html || `<div style="color: #64748b; font-style: italic; padding: 12px; text-align: center;">${t.noPokemon}</div>`;

        const newHistoryContainer = document.getElementById('expanded-history-container');
        if (newHistoryContainer && savedScrollTop !== null) {
            newHistoryContainer.scrollTop = isAtTop ? 0 : savedScrollTop;
        }

        document.querySelectorAll('.poke-row-toggle').forEach(row => {
            row.addEventListener('click', (e) => {
                const targetId = e.currentTarget.getAttribute('data-poke-id');
                expandedPokeId = expandedPokeId === targetId ? null : targetId;
                updateStatsUI();
            });
        });
    }

    const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const OriginalWebSocket = targetWindow.WebSocket;

    targetWindow.WebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
            const ws = new target(...args);
            const originalSend = ws.send;
            
            ws.send = function (data) {
                try {
                    if (typeof data === 'string') {
                        const outPacket = JSON.parse(data);
                        if (outPacket.type === 'enter-hunt') {
                            currentHunt = outPacket.slug || 'Unknown';
                            const huntEl = document.getElementById('cl-current-hunt');
                            if (huntEl) huntEl.textContent = `(${currentHunt})`;
                            resetAllCombatData(`Nueva cacería iniciada (${currentHunt}).`);
                        }
                        if (outPacket.type === 'leave-hunt') stopSessionTimer();
                        if (outPacket.type === 'poke-summon' && outPacket.pokeId) {
                            activePokeId = outPacket.pokeId;
                            registerActiveCombatPoke(activePokeId);
                            updateStatsUI();
                        }
                    }
                } catch (e) { }
                return originalSend.apply(this, arguments);
            };

            ws.addEventListener('open', () => setTimeout(createCombatLogUI, 1000));

            ws.addEventListener('message', (event) => {
                try {
                    if (typeof event.data !== 'string') return;
                    const packet = JSON.parse(event.data);

                    if (packet.type === 'enter-hunt') {
                        currentHunt = packet.slug || 'Unknown';
                        const huntEl = document.getElementById('cl-current-hunt');
                        if (huntEl) huntEl.textContent = `(${currentHunt})`;
                        resetAllCombatData(`Confirmación de cacería (${currentHunt}).`);
                    }

                    if (packet.type === 'pokes' && Array.isArray(packet.list)) {
                        playerTeamIds = [];
                        packet.list.forEach(poke => {
                            if (poke.id) {
                                playerTeamIds.push(poke.id);
                                pokemonNameMap[poke.id] = resolvePokemonName(poke.id, poke.speciesId) || poke.name;
                                pokemonDetailsMap[poke.id] = { speciesId: poke.speciesId, level: poke.level, quality: poke.quality, stats: poke.stats || null };
                            }
                        });
                        if (activePokeId === 'default' && packet.list.length > 0) activePokeId = packet.list[0].id;
                    }

                    if (packet.type === 'poke-xp' && packet.id && packet.level) {
                        if (pokemonDetailsMap[packet.id]) pokemonDetailsMap[packet.id].level = packet.level;
                        const currentPoke = pokeStats[packet.id];
                        if (currentPoke) {
                            if (currentPoke.level !== '?' && packet.level > currentPoke.level) {
                                currentPoke.history.push({ timerTime: getFormattedTimerTime(), type: 'level_up', oldLevel: currentPoke.level, newLevel: packet.level });
                                currentPoke.level = packet.level;
                                updateStatsUI();
                            } else {
                                currentPoke.level = packet.level;
                            }
                        }
                    }

                    if (packet.type === 'field' && ((packet.hits && packet.hits.length > 0) || packet.bossCinematic !== undefined)) {
                        if (!sessionStarted) startSessionTimer();
                        let newActiveId = activePokeId;

                        if (packet.bossActiveIdx !== undefined && typeof packet.bossActiveIdx === 'number') {
                            if (playerTeamIds.length > packet.bossActiveIdx) newActiveId = playerTeamIds[packet.bossActiveIdx];
                        } else if (packet.heroName) {
                            for (const id in pokemonNameMap) {
                                if (pokemonNameMap[id] === packet.heroName) {
                                    newActiveId = id;
                                    const details = pokemonDetailsMap[id];
                                    if (details && details.stats && details.stats.hp === packet.heroMaxHp) break;
                                }
                            }
                        }

                        if (activePokeId === 'default' && newActiveId !== 'default') activePokeId = newActiveId;
                        const currentPoke = registerActiveCombatPoke(activePokeId);
                        const timerTimeStr = getFormattedTimerTime();

                        if (currentPoke) {
                            (packet.hits || []).forEach(hit => {
                                if (hit.slot === -1) {
                                    currentPoke.taken += hit.amount; currentPoke.takenHitsCount++; totalTakenAll += hit.amount;
                                    currentPoke.history.push({ timerTime: timerTimeStr, type: 'taken', move: hit.move, moveType: hit.type, amount: hit.amount });
                                } else {
                                    currentPoke.dealt += hit.amount; currentPoke.dealtHitsCount++; totalDealtAll += hit.amount;
                                    currentPoke.history.push({ timerTime: timerTimeStr, type: 'dealt', move: hit.move, moveType: hit.type, amount: hit.amount, eff: hit.eff });
                                }
                            });

                            if (packet.bossCinematic) {
                                const cinematicDmg = Number(packet.bossCinematicDmg) || 0;
                                if (cinematicDmg > 0) {
                                    currentPoke.taken += cinematicDmg; currentPoke.takenHitsCount++; totalTakenAll += cinematicDmg;
                                    currentPoke.history.push({ timerTime: timerTimeStr, type: 'taken', move: packet.bossCinematic, moveType: 'BOSS', amount: cinematicDmg });
                                }
                            }
                        }
                        if (newActiveId && newActiveId !== activePokeId) activePokeId = newActiveId;
                        updateStatsUI();
                    }
                } catch (err) { }
            });
            return ws;
        }
    });
})();