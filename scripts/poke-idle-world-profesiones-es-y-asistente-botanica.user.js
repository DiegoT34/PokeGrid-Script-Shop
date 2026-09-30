// ==UserScript==
// @name         Poke Idle World - Profesiones ES y Asistente Botánica
// @namespace    pokegrid.professions.es
// @version      1.5.0
// @description  Traduce al español el sistema de profesiones y añade un asistente de crafteo para Botánica.
// @author       DiegoT34 / PokeGrid
// @match        https://poke.idleworld.online/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const SCRIPT_ID = 'pg-professions-es';
    const STYLE_ID = `${SCRIPT_ID}-styles`;
    const PANEL_ID = `${SCRIPT_ID}-botany`;
    const POPOVER_ID = `${SCRIPT_ID}-drop-popover`;
    const TRACKER_ID = `${SCRIPT_ID}-goal-tracker`;
    const STORAGE_KEY = `${SCRIPT_ID}:craft-goal:v1`;
    const TRACKER_STATE_KEY = `${SCRIPT_ID}:goal-tracker-state:v1`;
    const TRACKER_LAYOUT_KEY = `${SCRIPT_ID}:goal-tracker-layout:v1`;
    const ITEMS_URL = '/game/items.json';
    const CREATURES_URL = '/game/creatures.json';
    const CRAFT_URL = '/api/game/professions/craft';
    const MARKET_URL = '/api/game/market?category=All';
    const DROP_REFRESH_DEBOUNCE_MS = 420;
    const MARKET_CACHE_MS = 20_000;

    const TYPE_NAMES = {
        NORMAL: 'Normal', STEEL: 'Acero', DARK: 'Siniestro', DRAGON: 'Dragón',
        GHOST: 'Fantasma', ROCK: 'Roca', BUG: 'Bicho', PSYCHIC: 'Psíquico',
        FLYING: 'Volador', GROUND: 'Tierra', POISON: 'Veneno', FIGHTING: 'Lucha',
        ICE: 'Hielo', GRASS: 'Planta', ELECTRIC: 'Eléctrico', WATER: 'Agua',
        FIRE: 'Fuego', FAIRY: 'Hada', NEUTRAL: 'Neutral', HEAL: 'Curación'
    };

    // Mismo catálogo de iconos individuales que utiliza el cliente oficial del juego.
    const POKE_ICON_IDS = {
        1:36575,2:36585,3:36595,4:36605,5:36615,6:36625,7:36634,8:36643,9:36651,10:36669,
        11:36660,12:36702,13:36696,14:36687,15:36705,16:36722,17:36713,18:36731,19:36740,20:36755,
        21:36758,22:36767,23:36776,24:36785,25:36639,26:36647,27:36601,28:36611,29:36586,30:36606,
        31:36596,32:36576,33:36626,34:36616,35:36644,36:36635,37:36674,38:36683,39:36620,40:36630,
        41:36580,42:36590,43:36717,44:36726,45:36735,46:36652,47:36661,48:36670,49:36900,50:36688,
        51:36697,52:36723,53:36714,54:36656,55:36665,56:36706,57:36759,58:36782,59:36741,60:36732,
        61:36768,62:36786,63:36691,64:36700,65:36709,66:36771,67:36780,68:36789,69:36777,70:36577,
        71:36587,72:36676,73:36685,74:36744,75:36753,76:36762,77:36597,78:36607,79:36617,80:36627,
        81:36631,82:36640,83:36636,84:36692,85:36701,86:36799,87:36653,88:36655,89:36641,90:36671,
        91:36662,92:36680,93:36689,94:36698,95:36707,96:36715,97:36724,98:36592,99:36733,100:36694,
        101:36703,102:36751,103:36760,104:36769,105:36778,106:36737,107:36648,108:36588,109:36673,110:36682,
        111:36710,112:36718,113:36598,114:36608,115:36618,116:36781,117:36738,118:36745,119:36754,120:36581,
        121:36591,122:36628,123:36637,124:36645,125:36622,126:36663,127:36621,128:36672,129:36711,130:36720,
        131:36681,132:36690,133:36699,134:36708,135:36716,136:36725,137:36734,138:36743,139:36752,140:36761,
        141:36770,142:36779,143:36788,147:36629,148:36638,149:36646,150:36609,410:15429,411:15430,416:31459,
        417:15420,428:35137,464:59715,465:59711,466:59718,467:14347,472:15503,477:59726,538:31461,539:31463,
        564:29175,565:29177,566:29155,567:29157,636:29159,637:29161,669:32133,670:32135,671:32137,674:29163,
        675:29165,681:29183,690:29171,691:29173
    };
    const SPECIAL_SPRITE_META = {
        144:{w:96,h:96,dirs:4,frames:4},145:{w:96,h:96,dirs:4,frames:4},
        146:{w:128,h:128,dirs:4,frames:4},151:{w:32,h:32,dirs:4,frames:5},
        201:{w:32,h:32,dirs:4,frames:2}
    };

    const BERRY_META = [
        ['chilan', 'NORMAL', 64831, 64809], ['babiri', 'STEEL', 64832, 64810],
        ['colbur', 'DARK', 64833, 64811], ['haban', 'DRAGON', 64834, 64812],
        ['kasib', 'GHOST', 64835, 64813], ['charti', 'ROCK', 64836, 64814],
        ['tanga', 'BUG', 64837, 64815], ['payapa', 'PSYCHIC', 64838, 64816],
        ['coba', 'FLYING', 64839, 64817], ['shuca', 'GROUND', 64840, 64818],
        ['kebia', 'POISON', 64841, 64819], ['chople', 'FIGHTING', 64842, 64820],
        ['yache', 'ICE', 64843, 64821], ['rindo', 'GRASS', 64844, 64822],
        ['wacan', 'ELECTRIC', 64845, 64823], ['passho', 'WATER', 64846, 64824],
        ['occa', 'FIRE', 64847, 64825], ['roseli', 'FAIRY', 64848, 64826],
        ['kee', 'NEUTRAL', 64849, 64830], ['rovia', 'HEAL', 64850, 44457]
    ];

    // Cantidades oficiales por una unidad. Los nombres e iconos se leen del catálogo del juego.
    const RECIPE_PARTS = {
        64809: [[73, 960], [24, 2160], [59222, 6000]],
        64810: [[97, 960], [83, 3950], [59246, 6000]],
        64811: [[137, 2670], [59235, 6000], [59237, 9000]],
        64812: [[115, 960], [37, 720], [59241, 6000]],
        64813: [[111, 4800], [137, 2040], [59232, 6000]],
        64814: [[35, 960], [128, 2280], [59239, 6000]],
        64815: [[17, 1200], [11592, 3130], [59220, 6000]],
        64816: [[89, 960], [103, 2040], [59229, 6000]],
        64817: [[38, 790], [114, 720], [59221, 6000]],
        64818: [[94, 1290], [3, 2400], [59243, 6000]],
        64819: [[125, 4000], [127, 3120], [59242, 6000]],
        64820: [[86, 2400], [105, 2640], [59224, 6000]],
        64821: [[122, 960], [116, 2400], [59233, 6000]],
        64822: [[12, 960], [99, 3120], [59217, 6000]],
        64823: [[43, 960], [42, 2760], [59226, 6000]],
        64824: [[74, 3900], [65, 720], [59219, 6000]],
        64825: [[82, 960], [54, 2760], [59218, 6000]],
        64826: [[136, 3270], [88, 2400], [59238, 6000]],
        64830: [[2, 22], [27304, 2]],
        44457: [[204, 6000], [21, 600]],
        64831: [[108, 2310], [11556, 1450]],
        64832: [[11537, 130], [11549, 1380]],
        64833: [[11550, 1460], [59249, 6550]],
        64834: [[38, 430], [37, 530]],
        64835: [[137, 1460], [11595, 850]],
        64836: [[69, 530], [11560, 580]],
        64837: [[11532, 1790], [11540, 1450]],
        64838: [[11530, 1460], [11521, 1560]],
        64839: [[11515, 3370], [11514, 1780]],
        64840: [[11534, 2920], [11552, 1460]],
        64841: [[11516, 3370], [11517, 1460]],
        64842: [[11540, 1460], [11555, 1940]],
        64843: [[11547, 2920], [11544, 1460]],
        64844: [[11529, 3800], [11510, 1990]],
        64845: [[11518, 2300], [11522, 1990]],
        64846: [[11586, 3370], [11512, 1990]],
        64847: [[11543, 1940], [11511, 1990]],
        64848: [[11520, 180], [11535, 2340]],
        64849: [[2, 11], [27304, 1]],
        64850: [[204, 3000], [21, 300]]
    };

    const BERRY_BY_ID = new Map();
    for (const [slug, type, commonId, wildId] of BERRY_META) {
        BERRY_BY_ID.set(commonId, { slug, type, variant: 'common', nodeId: slug });
        BERRY_BY_ID.set(wildId, { slug, type, variant: 'wild', nodeId: slug });
    }

    const EXACT_TRANSLATIONS = new Map(Object.entries({
        'Professions': 'Profesiones', 'Profissões': 'Profesiones',
        'COMING SOON': 'PRÓXIMAMENTE',
        'Close': 'Cerrar', 'Fechar': 'Cerrar', 'Coming soon': 'Próximamente', 'Em breve': 'Próximamente',
        'This profession is not available yet': 'Esta profesión todavía no está disponible',
        'Esta profissão ainda não está disponível': 'Esta profesión todavía no está disponible',
        'Botanist': 'Botánico', 'Botânico': 'Botánico', 'Scientist': 'Científico', 'Cientista': 'Científico',
        'Pokémon Researcher': 'Investigador Pokémon', 'Pesquisador Pokémon': 'Investigador Pokémon',
        'Prestige Trainer': 'Entrenador de Prestigio', 'Treinador de Prestígio': 'Entrenador de Prestigio',
        'Apprentice': 'Aprendiz', 'Adventurer': 'Aventurero', 'Specialist': 'Especialista',
        'Elite': 'Élite', 'Champion': 'Campeón', 'Pokémon Master': 'Maestro Pokémon',
        'Cultivator': 'Cultivador', 'Naturalist': 'Naturalista', 'Herbalist': 'Herbolario',
        'Grand Botanist': 'Gran Botánico', 'Grão-Botânico': 'Gran Botánico',
        'Different species caught': 'Especies diferentes capturadas',
        'Espécies diferentes capturadas': 'Especies diferentes capturadas',
        'Deliver Rare Pokémon Picture': 'Entregar Rare Pokémon Picture',
        'Entregar Rare Pokémon Picture': 'Entregar Rare Pokémon Picture',
        'Exclusive mechanic:': 'Mecánica exclusiva:', 'Mecânica exclusiva:': 'Mecánica exclusiva:',
        'Catch Bonus:': 'Bono de captura:', 'Bônus de Captura:': 'Bono de captura:',
        'Trainer Bonus:': 'Bono de entrenador:', 'Bônus de Treinador:': 'Bono de entrenador:',
        'Rank Up': 'Subir de rango', 'Subir de Rank': 'Subir de rango',
        'Requirements complete — rank up': 'Requisitos completos — subir de rango',
        'Requisitos completos — subir de rank': 'Requisitos completos — subir de rango',
        'Complete the requirements first': 'Completa primero los requisitos',
        'Complete os requisitos primeiro': 'Completa primero los requisitos',
        'Choose profession': 'Elegir profesión', 'Escolher profissão': 'Elegir profesión',
        'Register this profession': 'Registrar esta profesión', 'Registrar esta profissão': 'Registrar esta profesión',
        'Register this profession (applies the exclusive outfit)': 'Registrar esta profesión (aplica el atuendo exclusivo)',
        'Registrar esta profissão (aplica a outfit exclusiva)': 'Registrar esta profesión (aplica el atuendo exclusivo)',
        'Current profession': 'Profesión actual', 'Profissão atual': 'Profesión actual',
        'Cancel': 'Cancelar', 'Cancelar': 'Cancelar', 'Confirm switch': 'Confirmar cambio',
        'Confirmar troca': 'Confirmar cambio', 'Switch professions?': '¿Cambiar de profesión?',
        'Trocar de profissão?': '¿Cambiar de profesión?', 'Switch cost': 'Costo del cambio',
        'Custo da troca': 'Costo del cambio', 'Botanist Talents': 'Talentos de Botánica',
        'Talentos do Botânico': 'Talentos de Botánica', 'Trainer Talents': 'Talentos del entrenador',
        'Talentos do Treinador': 'Talentos del entrenador', 'Craft Panel': 'Panel de crafteo',
        'Painel de Crafts': 'Panel de crafteo', 'Back to the Tree': 'Volver al árbol',
        'Voltar à Árvore': 'Volver al árbol', 'Collect': 'Recoger', 'Coletar': 'Recoger',
        'Max': 'Máx.', 'Máx': 'Máx.', 'produced': 'producidas', 'produzidas': 'producidas',
        'Craft unlocked': 'Crafteo desbloqueado', 'Craft liberado': 'Crafteo desbloqueado',
        'Spend 1 point': 'Gastar 1 punto', 'Gastar 1 ponto': 'Gastar 1 punto',
        'Lasts 30 minutes': 'Dura 30 minutos', 'Dura 30 minutos': 'Dura 30 minutos',
        'Used on 1 Pokémon in your team': 'Se usa en 1 Pokémon del equipo',
        'Usada em 1 Pokémon da equipe': 'Se usa en 1 Pokémon del equipo',
        'Identical berries do not stack': 'Las berries iguales no se acumulan',
        'Berries iguais não se acumulam': 'Las berries iguales no se acumulan',
        'No talent points — rank up first': 'Sin puntos de talento — sube de rango primero',
        'Sem pontos de talento — suba de rank': 'Sin puntos de talento — sube de rango primero',
        'Only the Botanist spends these points': 'Solo el Botánico distribuye estos puntos',
        'Só o Botânico distribui estes pontos': 'Solo el Botánico distribuye estos puntos',
        'Free (uses your free swap)': 'Gratis (usa tu cambio gratuito)',
        'Grátis (usa sua troca grátis)': 'Gratis (usa tu cambio gratuito)',
        'Your progress in the current career is saved — coming back restores the rank.': 'Tu progreso en la profesión actual queda guardado; al regresar recuperarás el rango.',
        'Seu progresso na carreira atual fica salvo — voltar depois recupera o rank.': 'Tu progreso en la profesión actual queda guardado; al regresar recuperarás el rango.',
        'Cumulative bonus to the direct Pokéball catch chance at this rank': 'Bono acumulativo a la probabilidad directa de captura con Pokéball en este rango',
        'Bônus cumulativo na chance direta da Pokébola neste rank': 'Bono acumulativo a la probabilidad directa de captura con Pokéball en este rango',
        'How much stronger berries get at this rank': 'Cuánto aumenta el efecto de las berries en este rango',
        'O quanto o efeito das berries aumenta neste rank': 'Cuánto aumenta el efecto de las berries en este rango',
        'Berry that protects from Neutral-type moves': 'Berry que protege de movimientos de tipo Neutral',
        'Berry que protege dos golpes tipo Neutro': 'Berry que protege de movimientos de tipo Neutral',
        'Berry that boosts potions used on this Pokémon': 'Berry que potencia las pociones usadas en este Pokémon',
        'Berry que potencializa as poções usadas neste Pokémon': 'Berry que potencia las pociones usadas en este Pokémon',
        'Unlocks this berry in the Craft Panel': 'Desbloquea el crafteo de esta berry en el panel',
        'Libera o craft desta berry no Painel de Crafts': 'Desbloquea el crafteo de esta berry en el panel',
        '1 point': '1 punto', '1 ponto': '1 punto', 'Neutral': 'Neutral', 'Neutro': 'Neutral',
        'Healing': 'Curación', 'Cura': 'Curación', 'Reserved fruit — awaiting a new berry': 'Fruto reservado — esperando una nueva berry',
        'Fruto reservado — aguardando uma nova berry': 'Fruto reservado — esperando una nueva berry',
        'Berries crafted': 'Berries crafteadas', 'Berries craftadas': 'Berries crafteadas',
        'NORMAL': 'NORMAL', 'STEEL': 'ACERO', 'DARK': 'SINIESTRO', 'DRAGON': 'DRAGÓN',
        'GHOST': 'FANTASMA', 'ROCK': 'ROCA', 'BUG': 'BICHO', 'PSYCHIC': 'PSÍQUICO',
        'FLYING': 'VOLADOR', 'GROUND': 'TIERRA', 'POISON': 'VENENO', 'FIGHTING': 'LUCHA',
        'ICE': 'HIELO', 'GRASS': 'PLANTA', 'ELECTRIC': 'ELÉCTRICO', 'WATER': 'AGUA',
        'FIRE': 'FUEGO', 'FAIRY': 'HADA', 'HEAL': 'CURACIÓN',
        'Steel': 'Acero', 'Dark': 'Siniestro', 'Dragon': 'Dragón', 'Ghost': 'Fantasma',
        'Rock': 'Roca', 'Bug': 'Bicho', 'Psychic': 'Psíquico', 'Flying': 'Volador',
        'Ground': 'Tierra', 'Poison': 'Veneno', 'Fighting': 'Lucha', 'Ice': 'Hielo',
        'Grass': 'Planta', 'Electric': 'Eléctrico', 'Water': 'Agua', 'Fire': 'Fuego',
        'Fairy': 'Hada', 'Heal': 'Curación',
        'Rare Pokémon Picture': 'Rare Pokémon Picture', 'Fresh Herbs:': 'Fresh Herbs:', 'Wild Herbs:': 'Wild Herbs:'
    }));

    const PHRASE_REPLACEMENTS = [
        ['A specialist in gathering herbs and natural resources found on hunts. Uses that knowledge to craft special Berries that grant advantages to Pokémon during battle.', 'Especialista en recolectar hierbas y recursos naturales durante las hunts. Usa ese conocimiento para elaborar berries especiales que otorgan ventajas a los Pokémon en combate.'],
        ['Especialista em coletar ervas e recursos naturais encontrados nas hunts. Utiliza seus conhecimentos para criar Berrys especiais, capazes de conceder vantagens aos Pokémon durante os combates.', 'Especialista en recolectar hierbas y recursos naturales durante las hunts. Usa ese conocimiento para elaborar berries especiales que otorgan ventajas a los Pokémon en combate.'],
        ['Scholar of evolutions and Pokémon technology. Coming soon: missions, an exclusive outfit and unique mechanics.', 'Estudioso de las evoluciones y la tecnología Pokémon. Próximamente: misiones, un atuendo exclusivo y mecánicas propias.'],
        ['Estudioso das evoluções e das tecnologias Pokémon. Em breve: missões, outfit exclusiva e mecânicas próprias.', 'Estudioso de las evoluciones y la tecnología Pokémon. Próximamente: misiones, un atuendo exclusivo y mecánicas propias.'],
        ['Field explorer devoted to cataloguing every species. Coming soon: missions, an exclusive outfit and unique mechanics.', 'Explorador de campo dedicado a catalogar todas las especies. Próximamente: misiones, un atuendo exclusivo y mecánicas propias.'],
        ['Explorador de campo dedicado a catalogar todas as espécies. Em breve: missões, outfit exclusiva e mecânicas próprias.', 'Explorador de campo dedicado a catalogar todas las especies. Próximamente: misiones, un atuendo exclusivo y mecánicas propias.'],
        ["A renowned trainer who documents rare encounters. Uses the game's default outfit, but has an exclusive Shiny Pokémon photography mechanic.", 'Un entrenador reconocido que documenta encuentros raros. Usa el atuendo normal del juego, pero posee una mecánica exclusiva para fotografiar Pokémon Shiny.'],
        ['Um treinador de renome que documenta encontros raros. Usa a outfit padrão do jogo, mas possui uma mecânica exclusiva de fotografia de Pokémon Shiny.', 'Un entrenador reconocido que documenta encuentros raros. Usa el atuendo normal del juego, pero posee una mecánica exclusiva para fotografiar Pokémon Shiny.'],
        ['Pick a berry, check the recipe and start crafting. Units finish one by one — collect the ready ones without stopping the rest.', 'Elige una berry, revisa la receta e inicia el crafteo. Las unidades terminan una por una; puedes recoger las listas sin detener las demás.'],
        ['Escolha uma berry, confira a receita e ponha pra craftar. As unidades ficam prontas uma a uma — pode coletar as prontas sem parar o resto.', 'Elige una berry, revisa la receta e inicia el crafteo. Las unidades terminan una por una; puedes recoger las listas sin detener las demás.'],
        ["Unlock this berry's fruit in the talent tree to reveal the recipe.", 'Desbloquea el fruto de esta berry en el árbol de talentos para revelar la receta.'],
        ['Destrave o fruto desta berry na árvore de talentos pra liberar a receita.', 'Desbloquea el fruto de esta berry en el árbol de talentos para revelar la receta.'],
        ["Click a fruit to unlock that berry's craft. Spending a point is permanent.", 'Pulsa un fruto para desbloquear el crafteo de esa berry. Gastar un punto es permanente.'],
        ['Clique num fruto pra liberar o craft daquela berry. Gastar um ponto é definitivo.', 'Pulsa un fruto para desbloquear el crafteo de esa berry. Gastar un punto es permanente.'],
        ['while you hunt, bushes sprout across the hunt floor — walk near one to harvest it and collect Fresh Herbs, the Botanist’s raw material.', 'mientras cazas, aparecen arbustos en el suelo de la hunt; acércate para recolectarlos y obtener Fresh Herbs, la materia prima del Botánico.'],
        ['enquanto você caça, arbustos brotam pelo chão da hunt — passe perto para colher e recolher Fresh Herbs, a matéria-prima do Botânico.', 'mientras cazas, aparecen arbustos en el suelo de la hunt; acércate para recolectarlos y obtener Fresh Herbs, la materia prima del Botánico.'],
        ["Herbalist's Touch:", 'Toque del Herbolario:'], ['Toque de Herbalista:', 'Toque del Herbolario:'],
        ['berries used on your Pokémon go further in your hands — and the effect grows with every rank of the career.', 'las berries usadas en tus Pokémon rinden más y su efecto aumenta con cada rango de la profesión.'],
        ['berries usadas nos seus Pokémon rendem mais nas suas mãos — e o efeito cresce a cada rank da carreira.', 'las berries usadas en tus Pokémon rinden más y su efecto aumenta con cada rango de la profesión.'],
        ['whenever a Shiny Pokémon appears in your hunt, you automatically take a photograph and receive 1 Rare Pokémon Picture — the item used to rank up.', 'cada vez que aparece un Pokémon Shiny en tu hunt, tomas una fotografía automáticamente y recibes 1 Rare Pokémon Picture, el objeto usado para subir de rango.'],
        ['sempre que um Pokémon Shiny aparecer na sua hunt, você tira uma fotografia automaticamente e recebe 1 Rare Pokémon Picture — o item usado pra evoluir de rank.', 'cada vez que aparece un Pokémon Shiny en tu hunt, tomas una fotografía automáticamente y recibes 1 Rare Pokémon Picture, el objeto usado para subir de rango.'],
        ['each rank raises the DIRECT catch chance multiplier by', 'cada rango aumenta el multiplicador DIRECTO de probabilidad de captura en'],
        ['cada rank aumenta o multiplicador da chance DIRETA em', 'cada rango aumenta el multiplicador DIRECTO de probabilidad de captura en'],
        ['cumulative, starting at rank E', 'acumulativo desde el rango E'],
        ['cumulativo, começando no rank E', 'acumulativo desde el rango E'],
        ['up to', 'hasta'], ['até', 'hasta'],
        ['Work in progress — soon you’ll be able to allocate talent points here.', 'En desarrollo; próximamente podrás asignar aquí tus puntos de talento.'],
        ['Em desenvolvimento — em breve você poderá distribuir pontos de talento aqui.', 'En desarrollo; próximamente podrás asignar aquí tus puntos de talento.'],
        ['Work in progress — soon you’ll allocate points and craft berries here.', 'En desarrollo; próximamente podrás asignar puntos y craftear berries aquí.'],
        ['Em desenvolvimento — em breve você distribuirá pontos e craftará berries aqui.', 'En desarrollo; próximamente podrás asignar puntos y craftear berries aquí.']
    ];

    const DYNAMIC_RULES = [
        [/^Your profession · Rank ([A-Z]) — (.+)$/i, 'Tu profesión · Rango $1 — $2'],
        [/^Sua profissão · Rank ([A-Z]) — (.+)$/i, 'Tu profesión · Rango $1 — $2'],
        [/^Next rank — ([A-Z]) “(.+)”$/i, 'Siguiente rango — $1 «$2»'],
        [/^Próximo rank — ([A-Z]) “(.+)”$/i, 'Siguiente rango — $1 «$2»'],
        [/^Your current bonus: \+(.+)$/i, 'Tu bono actual: +$1'],
        [/^Seu bônus atual: \+(.+)$/i, 'Tu bono actual: +$1'],
        [/^You have (\d+) talent point\(s\) to spend$/i, 'Tienes $1 punto(s) de talento para gastar'],
        [/^Você tem (\d+) ponto\(s\) de talento pra gastar$/i, 'Tienes $1 punto(s) de talento para gastar'],
        [/^Talent points at Rank ([A-Z]): (\d+)$/i, 'Puntos de talento en el rango $1: $2'],
        [/^Pontos de talento no Rank ([A-Z]): (\d+)$/i, 'Puntos de talento en el rango $1: $2'],
        [/^Rank ([A-Z]) · (\d+) talent point\(s\) to spend$/i, 'Rango $1 · $2 punto(s) de talento para gastar'],
        [/^Rank ([A-Z]) · (\d+) ponto\(s\) de talento pra gastar$/i, 'Rango $1 · $2 punto(s) de talento para gastar'],
        [/^🍃\s*Rank ([A-Z]) · (\d+) talent point\(s\) to spend$/i, '🍃 Rango $1 · $2 punto(s) de talento para gastar'],
        [/^🍃\s*Rank ([A-Z]) · (\d+) ponto\(s\) de talento pra gastar$/i, '🍃 Rango $1 · $2 punto(s) de talento para gastar'],
        [/^locked until rank ([A-Z])$/i, 'bloqueado hasta el rango $1'],
        [/^trancado até o rank ([A-Z])$/i, 'bloqueado hasta el rango $1'],
        [/^Opens at rank ([A-Z])$/i, 'Se abre en el rango $1'], [/^Abre no rank ([A-Z])$/i, 'Se abre en el rango $1'],
        [/^(\d+) ready to collect$/i, '$1 lista(s) para recoger'], [/^(\d+) pronta\(s\) pra coletar$/i, '$1 lista(s) para recoger'],
        [/^(\d+) ready$/i, '$1 lista(s)'], [/^(\d+) pronta\(s\)$/i, '$1 lista(s)'],
        [/^next in (.+)$/i, 'siguiente en $1'], [/^próxima em (.+)$/i, 'siguiente en $1'],
        [/^(.+) per unit$/i, '$1 por unidad'], [/^(.+) por unidade$/i, '$1 por unidad'],
        [/^full batch: (.+)$/i, 'lote completo: $1'], [/^leva total: (.+)$/i, 'lote completo: $1'],
        [/^Craft (\d+)$/i, 'Craftear $1'], [/^Craftar (\d+)$/i, 'Craftear $1'],
        [/^Defeat Pokémon of every type \((\d+) per type\)$/i, 'Derrota Pokémon de cada tipo ($1 por tipo)'],
        [/^Derrotar Pokémon de cada tipagem \((\d+) por tipo\)$/i, 'Derrota Pokémon de cada tipo ($1 por tipo)'],
        [/^Max rank reached — (.+)!$/i, '¡Rango máximo alcanzado — $1!'],
        [/^Rank máximo atingido — (.+)!$/i, '¡Rango máximo alcanzado — $1!'],
        [/^Rank ([A-Z]) — (.+)!$/i, '¡Rango $1 — $2!'],
        [/^Balance: (.+) → (.+) 💎$/i, 'Saldo: $1 → $2 💎'], [/^Saldo: (.+) → (.+) 💎$/i, 'Saldo: $1 → $2 💎']
        ,[/^You will stop being (.+) and become (.+)\.$/i, 'Dejarás de ser $1 y pasarás a ser $2.']
        ,[/^Você vai deixar de ser (.+) e passar a ser (.+)\.$/i, 'Dejarás de ser $1 y pasarás a ser $2.']
        ,[/^Your (.+) rank ([A-Z]) is saved — if you come back, you resume from there\.$/i, 'Tu rango $2 de $1 queda guardado; si regresas, continuarás desde ahí.']
        ,[/^O seu rank ([A-Z]) de (.+) fica salvo — se voltar, você recomeça de lá\.$/i, 'Tu rango $1 de $2 queda guardado; si regresas, continuarás desde ahí.']
        ,[/^You return to (.+) at the rank ([A-Z]) you already had\.$/i, 'Regresarás a $1 con el rango $2 que ya tenías.']
        ,[/^Você volta para (.+) no rank ([A-Z]) que já tinha\.$/i, 'Regresarás a $1 con el rango $2 que ya tenías.']
        ,[/^You start as (.+) at the first rank\.$/i, 'Comenzarás como $1 en el rango inicial.']
        ,[/^Você começa em (.+) do rank inicial\.$/i, 'Comenzarás como $1 en el rango inicial.']
        ,[/^Switch profession: (.+) 💎$/i, 'Cambiar profesión: $1 💎']
        ,[/^Trocar profissão: (.+) 💎$/i, 'Cambiar profesión: $1 💎']
        ,[/^Switch profession: FREE ✨$/i, 'Cambiar profesión: GRATIS ✨']
        ,[/^Trocar profissão: GRÁTIS ✨$/i, 'Cambiar profesión: GRATIS ✨']
        ,[/^Switch profession: 1 free swap$/i, 'Cambiar profesión: 1 cambio gratis']
        ,[/^Trocar profissão: 1 troca grátis$/i, 'Cambiar profesión: 1 cambio gratis']
        ,[/^You are now (.+)!$/i, '¡Ahora eres $1!']
        ,[/^Agora você é (.+)!$/i, '¡Ahora eres $1!']
        ,[/^Berry that protects from the (.+) type \((.+)% reduction\)$/i, 'Berry que protege del tipo $1 ($2% de reducción)']
        ,[/^Berry que protege do tipo (.+) \((.+)% de redução\)$/i, 'Berry que protege del tipo $1 ($2% de reducción)']
        ,[/^Berry that protects from Neutral-type moves \((.+)% reduction\)$/i, 'Berry que protege de movimientos de tipo Neutral ($1% de reducción)']
        ,[/^Berry que protege dos golpes tipo Neutro \((.+)% de redução\)$/i, 'Berry que protege de movimientos de tipo Neutral ($1% de reducción)']
        ,[/^Berry that boosts potions used on this Pokémon \(\+(.+)% healing\)$/i, 'Berry que potencia las pociones usadas en este Pokémon (+$1% de curación)']
        ,[/^Berry que potencializa as poções usadas neste Pokémon \(\+(.+)% de cura\)$/i, 'Berry que potencia las pociones usadas en este Pokémon (+$1% de curación)']
        ,[/^Berry that protects from the (.+) type$/i, 'Berry que protege del tipo $1']
        ,[/^Berry que protege do tipo (.+)$/i, 'Berry que protege del tipo $1']
    ];

    const state = {
        items: new Map(),
        creatures: [],
        craft: null,
        craftPromise: null,
        selectedId: 64831,
        search: '',
        filter: 'all',
        goal: loadGoal(),
        dataPromise: null,
        spriteMetaPromise: null,
        spriteImagePromises: new Map(),
        dropRefreshTimer: 0,
        pendingDropSignal: false,
        lastStockSignature: '',
        trackerRendering: false,
        translateQueued: false,
        dropCache: new Map(),
        marketListings: [],
        marketPrices: new Map(),
        marketPromise: null,
        marketFetchedAt: 0,
        trackerMinimized: localStorage.getItem(TRACKER_STATE_KEY) === 'minimized',
        trackerLayout: loadTrackerLayout(),
        lastError: ''
    };

    function loadGoal() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            const berryId = Number(raw?.berryId);
            const qty = Math.max(1, Math.min(9999, Number(raw?.qty) || 1));
            if (!RECIPE_PARTS[berryId]) return null;
            const mode = raw?.mode === 'item' ? 'item' : 'recipe';
            const itemId = Number(raw?.itemId);
            if (mode === 'item' && fullRecipe(berryId).some(([id]) => id === itemId)) {
                const perCraft = fullRecipe(berryId).find(([id]) => id === itemId)?.[1] || 1;
                const craftQty = raw?.quantityMode === 'crafts' ? qty : Math.max(1, Math.ceil(qty / perCraft));
                return { mode, berryId, itemId, qty: craftQty, quantityMode: 'crafts' };
            }
            return { mode: 'recipe', berryId, qty };
        } catch {
            return null;
        }
    }

    function loadTrackerLayout() {
        try {
            const value = JSON.parse(localStorage.getItem(TRACKER_LAYOUT_KEY) || 'null');
            return value && Number.isFinite(value.left) && Number.isFinite(value.top)
                ? { left: value.left, top: value.top, width: value.width, height: value.height }
                : null;
        } catch {
            return null;
        }
    }

    function saveGoal() {
        if (state.goal) localStorage.setItem(STORAGE_KEY, JSON.stringify(state.goal));
        else localStorage.removeItem(STORAGE_KEY);
    }

    function formatNumber(value) {
        return Math.max(0, Number(value) || 0).toLocaleString('es-ES');
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[char]);
    }

    function itemIcon(item) {
        const icon = item?.icon || '';
        if (!icon) return '';
        return /^(?:https?:)?\//i.test(icon) ? icon : `/assets/items/${icon}`;
    }

    function getTokens() {
        try { return JSON.parse(sessionStorage.getItem('pokeweb:tokens') || 'null'); }
        catch { return null; }
    }

    async function refreshAccessToken() {
        const tokens = getTokens();
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

    async function apiGet(url) {
        const send = token => fetch(url, {
            credentials: 'same-origin',
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        let response = await send(getTokens()?.accessToken);
        if (response.status === 401) {
            const token = await refreshAccessToken();
            if (token) response = await send(token);
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
        return data;
    }

    async function loadData(forceCraft = false) {
        if (!state.dataPromise) {
            state.dataPromise = Promise.all([
                fetch(ITEMS_URL, { credentials: 'same-origin' }).then(r => {
                    if (!r.ok) throw new Error(`Catálogo de objetos: HTTP ${r.status}`);
                    return r.json();
                }),
                fetch(CREATURES_URL, { credentials: 'same-origin' }).then(r => {
                    if (!r.ok) throw new Error(`Pokédex: HTTP ${r.status}`);
                    return r.json();
                })
            ]).then(([itemsData, creaturesData]) => {
                state.items = new Map((itemsData.items || []).map(item => [Number(item.id), item]));
                state.creatures = creaturesData.creatures || [];
            }).catch(error => {
                state.dataPromise = null;
                throw error;
            });
        }
        await state.dataPromise;
        if (forceCraft || !state.craft) {
            if (!state.craftPromise) {
                state.craftPromise = apiGet(CRAFT_URL).then(craft => {
                    state.craft = craft;
                    state.lastError = '';
                }).catch(error => {
                    state.lastError = `No se pudieron leer tus existencias: ${error.message}`;
                }).finally(() => { state.craftPromise = null; });
            }
            await state.craftPromise;
        }
    }

    function getStock(itemId) {
        return Number(state.craft?.stock?.[itemId] ?? state.craft?.stock?.[String(itemId)] ?? 0);
    }

    function trackedItemIds() {
        return new Set(Object.keys(RECIPE_PARTS).flatMap(berryId => fullRecipe(Number(berryId)).map(([itemId]) => itemId)));
    }

    function stockSignature() {
        return Array.from(trackedItemIds()).sort((a, b) => a - b).map(itemId => `${itemId}:${getStock(itemId)}`).join('|');
    }

    function renderStockConsumers() {
        if (document.getElementById(PANEL_ID)?.classList.contains('open')) renderAssistant();
        if (state.goal) renderGoalTracker();
    }

    function syncStockFromInventory(entries) {
        if (!Array.isArray(entries)) return false;
        const quantities = new Map(entries.map(entry => [
            Number(entry?.itemId ?? entry?.id),
            Number(entry?.quantity ?? entry?.qty ?? entry?.amount) || 0
        ]).filter(([itemId]) => Number.isFinite(itemId)));
        const relevantIds = trackedItemIds();
        const previous = stockSignature();
        state.craft ||= {};
        state.craft.stock ||= {};
        for (const itemId of relevantIds) state.craft.stock[itemId] = quantities.get(itemId) || 0;
        const next = stockSignature();
        state.lastStockSignature = next;
        if (previous === next) return false;
        renderStockConsumers();
        return true;
    }

    function scheduleDropStockRefresh() {
        state.pendingDropSignal = true;
        clearTimeout(state.dropRefreshTimer);
        state.dropRefreshTimer = window.setTimeout(async () => {
            state.pendingDropSignal = false;
            if (!state.goal && !document.getElementById(PANEL_ID)?.classList.contains('open')) return;
            const previous = stockSignature();
            await loadData(true).catch(error => { state.lastError = error.message; });
            const next = stockSignature();
            state.lastStockSignature = next;
            if (previous !== next) renderStockConsumers();
        }, DROP_REFRESH_DEBOUNCE_MS);
    }

    function isDropSignalMessage(message) {
        const type = String(message?.type || '').toLocaleLowerCase('en');
        if (/inventory/.test(type)) return false;
        if (/loot|drop/.test(type)) return true;
        const payload = JSON.stringify(message || {}).toLocaleLowerCase('en');
        return /"(?:loot|loots|drop|drops|droppeditems|lootobtained)"\s*:\s*(?:\[|\{|true|[1-9])/.test(payload);
    }

    function handleGameMessage(event) {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (String(message?.type || '').toLocaleLowerCase('en') === 'inventory') {
            syncStockFromInventory(message.items || message.inventory || []);
            return;
        }
        if (isDropSignalMessage(message)) scheduleDropStockRefresh();
    }

    function installDropSignalBridge() {
        const NativeWebSocket = window.WebSocket;
        if (!NativeWebSocket || NativeWebSocket.__pgProfessionsWrapped) return;
        const tracked = new WeakSet();
        const track = (socket, url = socket?.url) => {
            if (!socket || tracked.has(socket) || !String(url || '').includes('/ws')) return socket;
            tracked.add(socket);
            socket.addEventListener('message', handleGameMessage);
            return socket;
        };
        function TrackedWebSocket(url, protocols) {
            const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
            return track(socket, url);
        }
        TrackedWebSocket.prototype = NativeWebSocket.prototype;
        Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
        Object.defineProperty(TrackedWebSocket, '__pgProfessionsWrapped', { value: true });
        window.WebSocket = TrackedWebSocket;
    }

    function detectDropMutation(records) {
        for (const record of records) {
            for (const node of record.addedNodes || []) {
                const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
                if (!element || element.closest?.(`#${PANEL_ID},#${TRACKER_ID},#${POPOVER_ID}`)) continue;
                const text = String(node.textContent || '').slice(0, 900);
                if (/loot\s+(?:obtido|obtenido|obtained)|drop(?:s)?\s+(?:obtido|obtenido|received)|bot[ií]n\s+(?:obtenido|recibido)/i.test(text)) {
                    scheduleDropStockRefresh();
                    return;
                }
            }
        }
    }

    function fullRecipe(berryId) {
        const meta = BERRY_BY_ID.get(Number(berryId));
        const herbId = meta?.variant === 'wild' ? 19356 : 19354;
        return [[herbId, 25], ...(RECIPE_PARTS[berryId] || [])];
    }

    function craftableCount(berryId) {
        const recipe = fullRecipe(berryId);
        return recipe.length ? Math.min(100, ...recipe.map(([itemId, qty]) => Math.floor(getStock(itemId) / qty))) : 0;
    }

    function isUnlocked(berryId) {
        if (!Array.isArray(state.craft?.unlocked)) return null;
        return new Set(state.craft.unlocked).has(BERRY_BY_ID.get(Number(berryId))?.nodeId);
    }

    function translateValue(value) {
        if (!value || !value.trim()) return value;
        const leading = value.match(/^\s*/)?.[0] || '';
        const trailing = value.match(/\s*$/)?.[0] || '';
        let core = value.trim();
        if (EXACT_TRANSLATIONS.has(core)) return leading + EXACT_TRANSLATIONS.get(core) + trailing;
        for (const [source, target] of PHRASE_REPLACEMENTS) core = core.split(source).join(target);
        for (const [pattern, replacement] of DYNAMIC_RULES) {
            if (pattern.test(core)) {
                core = core.replace(pattern, replacement);
                break;
            }
        }
        return leading + core + trailing;
    }

    function translateBerryDescription(value) {
        const text = String(value || '').trim();
        if (!text) return 'El juego no proporciona una descripción para esta berry.';
        const typeNames = {
            'Aço': 'Acero', 'Água': 'Agua', 'Dragão': 'Dragón', 'Elétrico': 'Eléctrico',
            'Fada': 'Hada', 'Fantasma': 'Fantasma', 'Fogo': 'Fuego', 'Gelo': 'Hielo',
            'Inseto': 'Bicho', 'Lutador': 'Lucha', 'Neutro': 'Neutral', 'Normal': 'Normal',
            'Noturno': 'Siniestro', 'Pedra': 'Roca', 'Planta': 'Planta', 'Psíquico': 'Psíquico',
            'Terra': 'Tierra', 'Veneno': 'Veneno', 'Voador': 'Volador'
        };
        const reduction = text.match(/tipo\s+(.+?)\s*\((\d+)%\s+de\s+redu/i);
        if (/^Reduz\b/i.test(text) && reduction) {
            const type = typeNames[reduction[1]] || reduction[1];
            return `Reduce ${/FORTEMENTE/i.test(text) ? 'considerablemente ' : ''}el daño recibido de ataques de tipo ${type} (${reduction[2]}% de reducción).`;
        }
        const healing = text.match(/Aumenta\s+a\s+cura[\s\S]*?\(\+(\d+)%\s+de\s+cura\)/i);
        if (healing) return `Aumenta la curación recibida de todas las pociones usadas en este Pokémon (+${healing[1]}% de curación).`;
        return translateValue(text);
    }

    function isProtectedTextNode(textNode) {
        const parent = textNode.parentElement;
        return !parent || !!parent.closest([
            `#${PANEL_ID}`, `#${POPOVER_ID}`, '[data-pg-no-translate]',
            '.bc-item-name', '.bc-ing-name', '.bc-prod-name', '.prof-photo-item',
            '.prof-inline-ico + span[data-item]', '.inv-tip-name'
        ].join(','));
    }

    function translateElement(root) {
        if (!(root instanceof Element)) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
            if (isProtectedTextNode(node)) continue;
            const translated = translateValue(node.nodeValue);
            if (translated !== node.nodeValue) node.nodeValue = translated;
        }
        for (const element of root.querySelectorAll('[title],[aria-label],[placeholder]')) {
            if (element.closest(`#${PANEL_ID},#${POPOVER_ID},[data-pg-no-translate]`)) continue;
            for (const attr of ['title', 'aria-label', 'placeholder']) {
                if (!element.hasAttribute(attr)) continue;
                const before = element.getAttribute(attr);
                const after = translateValue(before);
                if (after !== before) element.setAttribute(attr, after);
            }
        }
    }

    function professionRoots() {
        return Array.from(document.querySelectorAll('.prof-window,.talents-window,.bt-window,.prof-ask-ov'));
    }

    function scheduleProfessionEnhancement() {
        if (state.translateQueued) return;
        state.translateQueued = true;
        setTimeout(() => {
            state.translateQueued = false;
            for (const root of professionRoots()) {
                translateElement(root);
                injectAssistantButton(root);
            }
        }, 45);
    }

    function injectAssistantButton(root) {
        if (!root.classList.contains('prof-window')) return;
        const existing = root.querySelector(`.${SCRIPT_ID}-open`);
        const activeName = root.querySelector('.prof-detail .prof-hname')?.textContent?.trim() || '';
        const botanyVisible = /^(?:Botanist|Botânico|Botánico)$/i.test(activeName);
        if (!botanyVisible) {
            existing?.remove();
            return;
        }
        if (existing) return;
        const host = root.querySelector('.prof-actions') || root.querySelector('.prof-detail') || root.querySelector('.prof-body');
        if (!host) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${SCRIPT_ID}-open`;
        button.innerHTML = '<span aria-hidden="true">🌿</span><span>Asistente de Botánica</span>';
        button.title = 'Abre una vista rápida de recetas, materiales y objetivos de crafteo';
        button.addEventListener('click', openAssistant);
        host.prepend(button);
    }

    async function openAssistant() {
        let overlay = document.getElementById(PANEL_ID);
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = PANEL_ID;
            overlay.innerHTML = assistantShell();
            document.body.appendChild(overlay);
            bindAssistantEvents(overlay);
        }
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        renderLoading();
        try {
            await loadData(true);
            if (!state.selectedId || !RECIPE_PARTS[state.selectedId]) state.selectedId = Number(Object.keys(RECIPE_PARTS)[0]);
            renderAssistant();
        } catch (error) {
            state.lastError = error.message;
            renderAssistant();
        }
    }

    function closeAssistant() {
        document.getElementById(PANEL_ID)?.classList.remove('open');
        document.getElementById(PANEL_ID)?.setAttribute('aria-hidden', 'true');
        document.getElementById(POPOVER_ID)?.remove();
    }

    function assistantShell() {
        return `
            <section class="pgp-window" role="dialog" aria-modal="true" aria-label="Asistente de Botánica">
                <header class="pgp-header">
                    <div class="pgp-titlemark" aria-hidden="true">🌿</div>
                    <div><span class="pgp-eyebrow">PROFESIONES · BOTÁNICA</span><h2>Asistente de crafteo</h2></div>
                    <div class="pgp-head-actions">
                        <button type="button" class="pgp-icon-btn" data-action="refresh" title="Actualizar existencias">↻</button>
                        <button type="button" class="pgp-icon-btn" data-action="close" title="Cerrar">×</button>
                    </div>
                </header>
                <div class="pgp-toolbar">
                    <label class="pgp-search"><span>⌕</span><input type="search" placeholder="Buscar berry por nombre o tipo…" autocomplete="off"></label>
                    <select class="pgp-filter" aria-label="Filtrar recetas">
                        <option value="all">Todas las recetas</option>
                        <option value="unlocked">Desbloqueadas</option>
                        <option value="craftable">Puedo craftear ahora</option>
                        <option value="goal">Mi objetivo</option>
                    </select>
                </div>
                <div class="pgp-status" aria-live="polite"></div>
                <div class="pgp-layout">
                    <main class="pgp-catalog"><div class="pgp-card-grid"></div></main>
                    <aside class="pgp-detail"></aside>
                </div>
            </section>`;
    }

    function bindAssistantEvents(overlay) {
        overlay.addEventListener('click', event => {
            if (event.target === overlay || event.target.closest('[data-action="close"]')) return closeAssistant();
            if (event.target.closest('[data-action="refresh"]')) return refreshAssistant();
            const itemGoal = event.target.closest('[data-action="set-item-goal"]');
            if (itemGoal) {
                const itemId = Number(itemGoal.dataset.itemId);
                if (!fullRecipe(state.selectedId).some(([id]) => id === itemId)) return;
                const currentQty = state.goal?.mode === 'item' && state.goal.itemId === itemId ? state.goal.qty : 1;
                state.goal = { mode: 'item', berryId: state.selectedId, itemId, qty: Math.max(1, Math.min(9999, currentQty)), quantityMode: 'crafts' };
                saveGoal();
                renderAssistant();
                activateGoalTracker();
                return;
            }
            const card = event.target.closest('[data-berry-id]');
            if (card) {
                state.selectedId = Number(card.dataset.berryId);
                renderAssistant();
                return;
            }
            if (event.target.closest('[data-action="set-goal"]')) {
                const previousQty = state.goal?.mode === 'recipe' && state.goal.berryId === state.selectedId ? state.goal.qty : 1;
                state.goal = { mode: 'recipe', berryId: state.selectedId, qty: Math.max(1, previousQty) };
                saveGoal();
                renderAssistant();
                activateGoalTracker();
                return;
            }
            if (event.target.closest('[data-action="clear-goal"]')) {
                state.goal = null;
                saveGoal();
                renderAssistant();
                removeGoalTracker();
            }
        });
        overlay.querySelector('.pgp-search input').addEventListener('input', event => {
            state.search = event.target.value;
            renderAssistant();
        });
        overlay.querySelector('.pgp-filter').addEventListener('change', event => {
            state.filter = event.target.value;
            renderAssistant();
        });
        overlay.addEventListener('input', event => {
            if (!event.target.matches('[data-goal-qty]') || !state.goal) return;
            state.goal.qty = Math.max(1, Math.min(9999, Number(event.target.value) || 1));
            saveGoal();
            renderGoalTracker();
        });
        overlay.addEventListener('change', event => {
            if (event.target.matches('[data-goal-qty]') && state.goal) renderDetail();
        });
        overlay.addEventListener('pointerover', event => {
            const ingredient = event.target.closest('[data-ingredient-id]');
            if (ingredient) {
                if (event.relatedTarget?.closest?.('[data-ingredient-id]') === ingredient) return;
                showDropPopover(Number(ingredient.dataset.ingredientId), ingredient);
                return;
            }
            const berry = event.target.closest('[data-berry-id]');
            if (!berry || event.relatedTarget?.closest?.('[data-berry-id]') === berry) return;
            showBerryPopover(Number(berry.dataset.berryId), berry);
        });
        overlay.addEventListener('pointerout', event => {
            const source = event.target.closest('[data-ingredient-id],[data-berry-id]');
            if (!source) return;
            if (event.relatedTarget && source.contains(event.relatedTarget)) return;
            if (event.relatedTarget?.closest?.(`#${POPOVER_ID}`)) return;
            schedulePopoverClose();
        });
        overlay.addEventListener('focusin', event => {
            const ingredient = event.target.closest('[data-ingredient-id]');
            if (ingredient) return showDropPopover(Number(ingredient.dataset.ingredientId), ingredient);
            const berry = event.target.closest('[data-berry-id]');
            if (berry) showBerryPopover(Number(berry.dataset.berryId), berry);
        });
        overlay.addEventListener('focusout', event => {
            const source = event.target.closest('[data-ingredient-id],[data-berry-id]');
            if (!source || (event.relatedTarget && source.contains(event.relatedTarget))) return;
            schedulePopoverClose();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && overlay.classList.contains('open')) closeAssistant();
        });
    }

    async function refreshAssistant() {
        const button = document.querySelector(`#${PANEL_ID} [data-action="refresh"]`);
        button?.classList.add('spinning');
        await loadData(true).catch(error => { state.lastError = error.message; });
        button?.classList.remove('spinning');
        renderAssistant();
        renderGoalTracker();
    }

    function renderLoading() {
        const grid = document.querySelector(`#${PANEL_ID} .pgp-card-grid`);
        const detail = document.querySelector(`#${PANEL_ID} .pgp-detail`);
        if (grid) grid.innerHTML = '<div class="pgp-loading"><span></span>Cargando recetas y Pokédex…</div>';
        if (detail) detail.innerHTML = '<div class="pgp-empty">Leyendo tus materiales actuales…</div>';
    }

    function berryEntries() {
        const query = state.search.trim().toLocaleLowerCase('es');
        return Object.keys(RECIPE_PARTS).map(Number).map(id => {
            const item = state.items.get(id) || { id, name: `Berry #${id}`, icon: '' };
            const meta = BERRY_BY_ID.get(id);
            const count = craftableCount(id);
            const unlocked = isUnlocked(id);
            return { id, item, meta, count, unlocked };
        }).filter(entry => {
            if (query && !`${entry.item.name} ${TYPE_NAMES[entry.meta?.type] || entry.meta?.type || ''}`.toLocaleLowerCase('es').includes(query)) return false;
            if (state.filter === 'unlocked' && entry.unlocked !== true) return false;
            if (state.filter === 'craftable' && !(entry.count > 0 && entry.unlocked !== false)) return false;
            if (state.filter === 'goal' && entry.id !== state.goal?.berryId) return false;
            return true;
        });
    }

    function renderAssistant() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const entries = berryEntries();
        const unlockedCount = Object.keys(RECIPE_PARTS).map(Number).filter(id => isUnlocked(id) === true).length;
        const possibleCount = Object.keys(RECIPE_PARTS).map(Number).filter(id => craftableCount(id) > 0 && isUnlocked(id) !== false).length;
        const status = panel.querySelector('.pgp-status');
        status.innerHTML = `
            <span><b>${entries.length}</b> visibles</span>
            <span><b>${unlockedCount || '—'}</b> desbloqueadas</span>
            <span><b>${possibleCount}</b> posibles ahora</span>
            ${state.lastError ? `<span class="warn">⚠ ${escapeHtml(state.lastError)}</span>` : '<span class="live">● Datos actuales del juego</span>'}`;
        panel.querySelector('.pgp-search input').value = state.search;
        panel.querySelector('.pgp-filter').value = state.filter;
        const grid = panel.querySelector('.pgp-card-grid');
        grid.innerHTML = entries.length ? entries.map(entry => berryCard(entry)).join('') : '<div class="pgp-empty">No hay recetas que coincidan con este filtro.</div>';
        renderDetail();
    }

    function berryCard({ id, item, meta, count, unlocked }) {
        const selected = id === state.selectedId;
        const goal = id === state.goal?.berryId;
        const icon = itemIcon(item);
        let badge = `<span class="pgp-badge ready">${count} posibles</span>`;
        if (unlocked === false) badge = '<span class="pgp-badge locked">Bloqueada</span>';
        else if (!count) badge = '<span class="pgp-badge missing">Faltan materiales</span>';
        return `<button type="button" class="pgp-berry-card${selected ? ' selected' : ''}${goal ? ' goal' : ''}" data-berry-id="${id}" style="--type:${typeColor(meta?.type)}">
            <span class="pgp-berry-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="">` : '🍓'}</span>
            <span class="pgp-berry-copy" data-pg-no-translate><strong>${escapeHtml(item.name)}</strong><small>${meta?.variant === 'wild' ? 'Variante silvestre' : 'Variante común'} · ${escapeHtml(TYPE_NAMES[meta?.type] || meta?.type || '')}</small></span>
            ${badge}${goal ? '<span class="pgp-goal-dot" title="Objetivo activo">✓</span>' : ''}
        </button>`;
    }

    function renderDetail() {
        const detail = document.querySelector(`#${PANEL_ID} .pgp-detail`);
        if (!detail || !state.items.size) return;
        const berryId = Number(state.selectedId);
        const berry = state.items.get(berryId) || { name: `Berry #${berryId}` };
        const meta = BERRY_BY_ID.get(berryId);
        const recipe = fullRecipe(berryId);
        const unlocked = isUnlocked(berryId);
        const max = craftableCount(berryId);
        const isGoal = state.goal?.berryId === berryId;
        const isRecipeGoal = isGoal && state.goal.mode !== 'item';
        const isItemGoal = isGoal && state.goal.mode === 'item';
        const goalQty = isGoal ? state.goal.qty : 1;
        const rows = recipe.map(([itemId, perUnit]) => {
            const item = state.items.get(itemId) || { name: `Item #${itemId}` };
            const have = getStock(itemId);
            const trackedAlone = isItemGoal && state.goal.itemId === itemId;
            const need = perUnit * ((trackedAlone || isRecipeGoal) ? goalQty : 1);
            const enough = have >= need;
            const pct = Math.min(100, need ? (have / need) * 100 : 0);
            return `<div class="pgp-ingredient${enough ? ' enough' : ''}${trackedAlone ? ' tracked' : ''}" data-ingredient-id="${itemId}" tabindex="0" aria-label="Ver Pokémon que sueltan ${escapeHtml(item.name)}">
                <span class="pgp-ing-icon">${itemIcon(item) ? `<img src="${escapeHtml(itemIcon(item))}" alt="">` : '◆'}</span>
                <span class="pgp-ing-main" data-pg-no-translate><strong>${escapeHtml(item.name)}</strong><small>${formatNumber(perUnit)} por craft</small><i style="--progress:${pct}%"></i></span>
                <span class="pgp-ing-count"><b class="${enough ? 'ok' : 'bad'}">${formatNumber(have)}</b><small>/ ${formatNumber(need)}</small></span>
                <button type="button" class="pgp-track-one${trackedAlone ? ' active' : ''}" data-action="set-item-goal" data-item-id="${itemId}" title="Seguir solamente ${escapeHtml(item.name)}">${trackedAlone ? '✓ Individual' : 'Solo este'}</button>
            </div>`;
        }).join('');
        const goalItem = isItemGoal ? state.items.get(state.goal.itemId) : null;
        detail.innerHTML = `
            <div class="pgp-detail-head">
                <span class="pgp-detail-icon">${itemIcon(berry) ? `<img src="${escapeHtml(itemIcon(berry))}" alt="">` : '🍓'}</span>
                <div data-pg-no-translate><small>${meta?.variant === 'wild' ? 'BERRY SILVESTRE' : 'BERRY COMÚN'} · ${escapeHtml(TYPE_NAMES[meta?.type] || '')}</small><h3>${escapeHtml(berry.name)}</h3></div>
                <span class="pgp-max">Máx. <b>${max}</b></span>
            </div>
            <div class="pgp-unlock ${unlocked === false ? 'locked' : 'open'}">${unlocked === false ? '🔒 Receta bloqueada en el árbol de talentos' : unlocked === true ? '✓ Receta desbloqueada' : 'ℹ Abre el panel original una vez para verificar desbloqueos'}</div>
            <div class="pgp-section-label"><span>RECETA</span><small>Pasa el cursor sobre un ingrediente para ver sus drops</small></div>
            <div class="pgp-ingredients">${rows}</div>
            <section class="pgp-goal-box">
                <div class="pgp-goal-title"><div><small>LISTA DE OBJETIVO</small><strong>${isRecipeGoal ? 'Todos los materiales de la receta' : isItemGoal ? `Solo ${escapeHtml(goalItem?.name || `Item #${state.goal.itemId}`)}` : 'Elige cómo quieres hacer el seguimiento'}</strong></div>
                    ${isGoal ? '<button type="button" data-action="clear-goal">Quitar</button>' : '<button type="button" data-action="set-goal">Marcar</button>'}
                </div>
                <div class="pgp-goal-actions"><button type="button" class="${isRecipeGoal ? 'active' : ''}" data-action="set-goal">Todos los materiales</button><span>o pulsa <b>Solo este</b> junto al material deseado.</span></div>
                ${isGoal ? `<label class="pgp-qty">${isItemGoal ? 'Cantidad de berries que quieres calcular' : 'Cantidad de berries que quieres craftear'} <input data-goal-qty type="number" min="1" max="9999" step="1" value="${goalQty}"></label>
                    <div class="pgp-goal-progress"><span style="width:${goalProgress()}%"></span></div>
                    <p>${goalComplete() ? '✓ Ya alcanzaste este objetivo.' : isItemGoal ? 'La cantidad se multiplica por lo necesario de este material para fabricar una berry.' : 'El panel general mostrará todos los materiales necesarios para la receta.'}</p>` : '<p>Puedes seguir la receta completa o escoger un solo material; su objetivo se calculará según la cantidad de berries indicada.</p>'}
            </section>`;
    }

    function goalRows(goal = state.goal) {
        if (!goal) return [];
        if (goal.mode === 'item') {
            const itemId = Number(goal.itemId);
            const perCraft = fullRecipe(Number(goal.berryId)).find(([id]) => id === itemId)?.[1] || 1;
            return [[itemId, perCraft * Math.max(1, Number(goal.qty) || 1)]];
        }
        return fullRecipe(Number(goal.berryId)).map(([itemId, perUnit]) => [itemId, perUnit * Math.max(1, Number(goal.qty) || 1)]);
    }

    function goalComplete(goal = state.goal) {
        const rows = goalRows(goal);
        return rows.length > 0 && rows.every(([itemId, need]) => getStock(itemId) >= need);
    }

    function goalProgress(goal = state.goal) {
        const ratios = goalRows(goal).map(([itemId, need]) => Math.min(1, getStock(itemId) / need));
        const progress = Math.round((ratios.reduce((sum, value) => sum + value, 0) / Math.max(1, ratios.length)) * 100);
        return goalComplete(goal) ? 100 : Math.min(99, progress);
    }

    function droppersFor(itemId) {
        if (state.dropCache.has(itemId)) return state.dropCache.get(itemId);
        const target = state.items.get(itemId)?.name?.trim().toLocaleLowerCase('en');
        if (!target) return [];
        const rows = [];
        for (const creature of state.creatures) {
            // La Pokepedia pública muestra las especies base, no las variantes especiales con IDs internos altos.
            if (!(Number(creature.pokeId) > 0 && Number(creature.pokeId) < 10_000)) continue;
            for (const loot of creature.loot || []) {
                if (loot.name?.trim().toLocaleLowerCase('en') !== target || Number(loot.chance) <= 0) continue;
                rows.push({
                    name: creature.name,
                    pokeId: creature.pokeId,
                    chance: Number(loot.chance) / 1000,
                    min: Number(loot.minCount) || 1,
                    max: Number(loot.maxCount) || Number(loot.minCount) || 1
                });
            }
        }
        rows.sort((a, b) => b.chance - a.chance || b.max - a.max || a.name.localeCompare(b.name));
        state.dropCache.set(itemId, rows);
        return rows;
    }

    function extractMarketListings(payload, depth = 0) {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== 'object' || depth > 5) return [];
        for (const key of ['listings', 'items', 'results', 'offers', 'data']) {
            if (Array.isArray(payload[key])) return payload[key];
            const nested = extractMarketListings(payload[key], depth + 1);
            if (nested.length) return nested;
        }
        return [];
    }

    function marketEntryRefId(entry) {
        const ref = entry?.item || entry?.product || {};
        return entry?.refId ?? entry?.itemId ?? entry?.ballId ?? ref.refId ?? ref.id ?? ref.itemId ?? null;
    }

    function marketEntryPrice(entry) {
        return Number(entry?.price ?? entry?.unitPrice ?? entry?.totalPrice ?? entry?.value ?? 0);
    }

    function marketEntryCurrency(entry) {
        const ref = entry?.item || entry?.product || {};
        const value = String(entry?.currency || entry?.currencyType || ref.currency || ref.currencyType || 'GOLD').toUpperCase();
        return /DIAM|^DD$/.test(value) ? 'DIAMONDS' : 'GOLD';
    }

    function isActiveItemListing(entry) {
        const ref = entry?.item || entry?.product || {};
        const kind = String(entry?.kind || entry?.itemKind || ref.kind || '').toLowerCase();
        const pokemon = entry?.pokemon || entry?.pokemonId != null || entry?.speciesId != null || /pokemon|pokémon|creature/.test(kind);
        const inactive = entry?.bought || entry?.sold || entry?.cancelled || entry?.canceled || entry?.active === false || entry?.offerOnly;
        return !pokemon && !inactive && marketEntryPrice(entry) > 0;
    }

    async function loadMarketListings() {
        if (state.marketFetchedAt && Date.now() - state.marketFetchedAt < MARKET_CACHE_MS) return state.marketListings;
        if (!state.marketPromise) {
            state.marketPromise = apiGet(MARKET_URL).then(payload => {
                state.marketListings = extractMarketListings(payload);
                state.marketPrices = indexMarketPrices(state.marketListings);
                state.marketFetchedAt = Date.now();
                return state.marketListings;
            }).finally(() => { state.marketPromise = null; });
        }
        return state.marketPromise;
    }

    function indexMarketPrices(listings) {
        const index = new Map();
        for (const entry of listings) {
            if (!isActiveItemListing(entry)) continue;
            const refId = marketEntryRefId(entry);
            if (refId == null) continue;
            const key = String(refId);
            const current = index.get(key) || { gold: null, diamonds: null, count: 0 };
            const field = marketEntryCurrency(entry) === 'DIAMONDS' ? 'diamonds' : 'gold';
            const price = marketEntryPrice(entry);
            current[field] = current[field] == null ? price : Math.min(current[field], price);
            current.count += 1;
            index.set(key, current);
        }
        return index;
    }

    async function hydrateMarketPrice(itemId, popover) {
        const output = popover.querySelector('[data-market-price]');
        if (!output) return;
        try {
            await loadMarketListings();
            const prices = state.marketPrices.get(String(itemId)) || { gold: null, diamonds: null, count: 0 };
            if (!popover.isConnected || popover.dataset.marketItemId !== String(itemId)) return;
            if (prices.gold == null && prices.diamonds == null) {
                output.innerHTML = '<strong>Sin precio</strong><small>No hay anuncios activos para este objeto.</small>';
                output.classList.add('empty');
                return;
            }
            const values = [
                prices.gold != null ? `<b class="gold">💲 ${formatNumber(prices.gold)}</b>` : '',
                prices.diamonds != null ? `<b class="diamonds">💎 ${formatNumber(prices.diamonds)}</b>` : ''
            ].filter(Boolean).join('');
            output.innerHTML = `<span>${values}</span><small>Precio unitario más bajo · ${formatNumber(prices.count)} anuncio${prices.count === 1 ? '' : 's'}</small>`;
            output.classList.remove('empty');
        } catch {
            if (!popover.isConnected || popover.dataset.marketItemId !== String(itemId)) return;
            output.innerHTML = '<strong>No disponible</strong><small>No se pudo consultar el mercado en este momento.</small>';
            output.classList.add('empty');
        }
    }

    function getInfoPopover() {
        let popover = document.getElementById(POPOVER_ID);
        if (!popover) {
            popover = document.createElement('aside');
            popover.id = POPOVER_ID;
            popover.addEventListener('pointerenter', () => clearTimeout(showDropPopover.closeTimer));
            popover.addEventListener('pointerleave', schedulePopoverClose);
            document.body.appendChild(popover);
        }
        return popover;
    }

    function placeInfoPopover(popover, anchor, preferredWidth = 330) {
        const rect = anchor.getBoundingClientRect();
        const width = Math.min(preferredWidth, window.innerWidth - 20);
        let left = rect.right + 10;
        if (left + width > window.innerWidth - 10) left = rect.left - width - 10;
        popover.style.width = `${width}px`;
        popover.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, left))}px`;
        popover.style.top = `${Math.max(10, Math.min(window.innerHeight - Math.min(390, popover.scrollHeight || 260) - 10, rect.top))}px`;
        popover.classList.add('open');
    }

    function showBerryPopover(berryId, anchor) {
        clearTimeout(showDropPopover.closeTimer);
        const berry = state.items.get(berryId) || { name: `Berry #${berryId}`, icon: '' };
        const meta = BERRY_BY_ID.get(berryId);
        const recipe = fullRecipe(berryId);
        const unlocked = isUnlocked(berryId);
        const possible = craftableCount(berryId);
        const popover = getInfoPopover();
        delete popover.dataset.marketItemId;
        const materials = recipe.map(([itemId, amount]) => {
            const item = state.items.get(itemId) || { name: `Item #${itemId}`, icon: '' };
            return `<span class="pgp-berry-material" data-pg-no-translate>${itemIcon(item) ? `<img src="${escapeHtml(itemIcon(item))}" alt="">` : '◆'}<b>${escapeHtml(item.name)}</b><em>×${formatNumber(amount)}</em></span>`;
        }).join('');
        popover.innerHTML = `<header><span>${itemIcon(berry) ? `<img src="${escapeHtml(itemIcon(berry))}" alt="">` : '🍓'}</span><div data-pg-no-translate><small>INFORMACIÓN DE BERRY</small><strong>${escapeHtml(berry.name)}</strong></div></header>
            <div class="pgp-berry-pop-body">
                <div class="pgp-berry-pop-tags"><span style="--berry-type:${typeColor(meta?.type)}">${escapeHtml(TYPE_NAMES[meta?.type] || meta?.type || 'Especial')}</span><span>${meta?.variant === 'wild' ? 'Silvestre' : 'Común'}</span></div>
                <p class="pgp-berry-effect">${escapeHtml(translateBerryDescription(berry.description))}</p>
                <div class="pgp-berry-pop-status"><span>Puedes craftear ahora <b>${formatNumber(possible)}</b></span><span class="${unlocked === false ? 'locked' : 'ready'}">${unlocked === false ? '🔒 Receta bloqueada' : unlocked === true ? '✓ Receta desbloqueada' : 'Estado por verificar'}</span></div>
                <small class="pgp-berry-recipe-title">MATERIALES PARA 1 BERRY</small>
                <div class="pgp-berry-materials">${materials}</div>
            </div>
            <footer>Haz clic para abrir su receta completa.</footer>`;
        placeInfoPopover(popover, anchor, 330);
    }

    function showDropPopover(itemId, anchor) {
        clearTimeout(showDropPopover.closeTimer);
        const item = state.items.get(itemId) || { name: `Item #${itemId}` };
        const rows = droppersFor(itemId);
        const popover = getInfoPopover();
        popover.dataset.marketItemId = String(itemId);
        popover.innerHTML = `<header><span>${itemIcon(item) ? `<img src="${escapeHtml(itemIcon(item))}" alt="">` : '◆'}</span><div data-pg-no-translate><small>DROPS · POKÉDEX</small><strong>${escapeHtml(item.name)}</strong></div></header>
            <div class="pgp-market-price" data-market-price><span class="pgp-market-loading">Consultando mercado…</span></div>
            ${rows.length ? `<div class="pgp-drop-list">${rows.map((row, index) => `<div class="pgp-drop-row"><b>${index + 1}</b><canvas class="pgp-poke-sprite" width="42" height="42" data-poke-id="${row.pokeId}" aria-label="${escapeHtml(row.name)}"></canvas><span data-pg-no-translate>${escapeHtml(row.name)}<small>#${row.pokeId}</small></span><em>${row.min === row.max ? `×${row.min}` : `×${row.min}–${row.max}`}</em><strong>${formatChance(row.chance)}</strong></div>`).join('')}</div>` : '<p class="pgp-no-drop">La Pokédex no registra ningún Pokémon que suelte este objeto.</p>'}
            <footer>Ordenado de mayor a menor porcentaje de caída.</footer>`;
        placeInfoPopover(popover, anchor, 340);
        hydratePokemonSprites(popover);
        hydrateMarketPrice(itemId, popover);
    }

    async function loadOutfitMetadata() {
        if (state.spriteMetaPromise) return state.spriteMetaPromise;
        state.spriteMetaPromise = (async () => {
            const resources = performance.getEntriesByType('resource')
                .filter(entry => /\/_next\/static\/chunks\/.*\.js(?:\?|$)/.test(entry.name))
                .sort((a, b) => (b.decodedBodySize || b.transferSize || 0) - (a.decodedBodySize || a.transferSize || 0))
                .map(entry => entry.name);
            const scripts = Array.from(document.scripts, script => script.src).filter(Boolean);
            const candidates = [...new Set([...resources, ...scripts])].slice(0, 16);
            for (const url of candidates) {
                try {
                    const source = await fetch(url, { credentials: 'same-origin' }).then(response => response.ok ? response.text() : '');
                    if (!source.includes('796908') || !source.includes('/assets/pokemon/outfit_')) continue;
                    const moduleAt = source.indexOf('796908');
                    const jsonAt = source.indexOf("JSON.parse('", moduleAt);
                    if (jsonAt < 0) continue;
                    const jsonEnd = source.indexOf("')", jsonAt + 12);
                    if (jsonEnd < 0) continue;
                    const parsed = JSON.parse(source.slice(jsonAt + 12, jsonEnd));
                    if (parsed && Object.keys(parsed).length) return parsed;
                } catch {}
            }
            return {};
        })();
        return state.spriteMetaPromise;
    }

    function officialPokemonIconUrl(pokeId) {
        const id = Number(pokeId);
        if (id >= 152 && id <= 251 && id !== 201) return `/assets/pokeitems/gen2/${id}.png`;
        if ((id >= 252 && id <= 386) || id === 447 || id === 448) return `/assets/pokeitems/gen3/${id}.png`;
        const iconId = POKE_ICON_IDS[id];
        return iconId ? `/assets/pokeitems/${iconId}.png` : '';
    }

    function loadImageUrl(url) {
        if (state.spriteImagePromises.has(url)) return state.spriteImagePromises.get(url);
        const promise = new Promise(resolve => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = url;
        });
        state.spriteImagePromises.set(url, promise);
        return promise;
    }

    function inferSpriteMeta(image) {
        const w = Math.max(1, Math.round(image.naturalWidth / 4));
        const frameOptions = [3, 5, 4, 6].filter(frames => image.naturalHeight % frames === 0)
            .map(frames => ({ frames, h: image.naturalHeight / frames }))
            .sort((a, b) => Math.abs(a.h - w) - Math.abs(b.h - w));
        const best = frameOptions[0] || { frames: 1, h: image.naturalHeight };
        return { w, h: best.h, dirs: 4, frames: best.frames };
    }

    async function hydratePokemonSprites(root) {
        const canvases = Array.from(root.querySelectorAll('canvas[data-poke-id]'));
        if (!canvases.length) return;
        await Promise.all(canvases.map(async canvas => {
            if (!canvas.isConnected) return;
            const pokeId = Number(canvas.dataset.pokeId);
            const context = canvas.getContext('2d');
            if (!context) return;
            const directIcon = officialPokemonIconUrl(pokeId);
            if (directIcon) {
                const icon = await loadImageUrl(directIcon);
                if (icon && canvas.isConnected) {
                    const scale = Math.min(38 / icon.naturalWidth, 38 / icon.naturalHeight);
                    const drawW = Math.max(1, Math.round(icon.naturalWidth * scale));
                    const drawH = Math.max(1, Math.round(icon.naturalHeight * scale));
                    context.clearRect(0, 0, canvas.width, canvas.height);
                    context.imageSmoothingEnabled = false;
                    context.drawImage(icon, (canvas.width - drawW) / 2, (canvas.height - drawH) / 2, drawW, drawH);
                    canvas.dataset.spriteReady = 'icon';
                    return;
                }
            }
            const image = await loadImageUrl(`/assets/pokemon/outfit_${pokeId}_.png`);
            if (!image || !canvas.isConnected) return;
            const knownMeta = SPECIAL_SPRITE_META[pokeId];
            const metadata = knownMeta ? null : await loadOutfitMetadata();
            const meta = knownMeta || metadata[String(pokeId)] || inferSpriteMeta(image);
            const cols = Number(meta.cols ?? meta.dirs ?? 4) || 4;
            const dirs = Number(meta.dirs ?? 4) || 4;
            const w = Number(meta.w) || image.naturalWidth / cols;
            const h = Number(meta.h) || image.naturalHeight / (Number(meta.frames) || 1);
            const directionWidth = w * (cols / dirs);
            const sx = Math.min(Math.max(0, 2 * directionWidth), Math.max(0, image.naturalWidth - w));
            const scale = Math.min(38 / w, 38 / h);
            const drawW = Math.max(1, Math.round(w * scale));
            const drawH = Math.max(1, Math.round(h * scale));
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.imageSmoothingEnabled = false;
            context.drawImage(image, sx, 0, w, h, (canvas.width - drawW) / 2, (canvas.height - drawH) / 2, drawW, drawH);
            canvas.dataset.spriteReady = 'outfit';
        }));
    }

    function formatChance(chance) {
        if (chance >= 10) return `${chance.toFixed(1).replace('.0', '')}%`;
        if (chance >= 1) return `${chance.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
        return `${chance.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
    }

    function schedulePopoverClose() {
        clearTimeout(showDropPopover.closeTimer);
        showDropPopover.closeTimer = setTimeout(() => document.getElementById(POPOVER_ID)?.remove(), 480);
    }

    function activateGoalTracker() {
        if (!state.goal) return removeGoalTracker();
        let tracker = document.getElementById(TRACKER_ID);
        if (!tracker) {
            tracker = document.createElement('aside');
            tracker.id = TRACKER_ID;
            tracker.setAttribute('aria-live', 'polite');
            tracker.addEventListener('click', event => {
                if (event.target.closest('[data-tracker-action="toggle"]')) {
                    if (Date.now() < (tracker._pgSuppressClickUntil || 0)) return;
                    if (!state.trackerMinimized) saveTrackerLayout(tracker);
                    state.trackerMinimized = !state.trackerMinimized;
                    localStorage.setItem(TRACKER_STATE_KEY, state.trackerMinimized ? 'minimized' : 'open');
                    renderGoalTracker();
                }
            });
            document.body.appendChild(tracker);
            bindGoalTrackerInteractions(tracker);
        }
        renderGoalTracker();
        loadData(true).then(() => renderGoalTracker()).catch(() => renderGoalTracker());
    }

    function removeGoalTracker() {
        const tracker = document.getElementById(TRACKER_ID);
        tracker?._pgCleanup?.();
        tracker?.remove();
    }

    function saveTrackerLayout(tracker) {
        if (!tracker) return;
        const rect = tracker.getBoundingClientRect();
        const compact = tracker.classList.contains('minimized');
        state.trackerLayout = {
            left: Math.round(rect.left), top: Math.round(rect.top),
            width: compact ? state.trackerLayout?.width : Math.round(rect.width),
            height: compact ? state.trackerLayout?.height : Math.round(rect.height)
        };
        localStorage.setItem(TRACKER_LAYOUT_KEY, JSON.stringify(state.trackerLayout));
    }

    function applyTrackerLayout(tracker) {
        if (!tracker) return;
        const layout = state.trackerLayout;
        if (!layout) {
            tracker.style.removeProperty('left');
            tracker.style.removeProperty('top');
            tracker.style.removeProperty('right');
            tracker.style.removeProperty('bottom');
            tracker.style.removeProperty('width');
            tracker.style.removeProperty('height');
            return;
        }
        const compact = tracker.classList.contains('minimized');
        const width = compact ? 50 : Math.max(270, Math.min(Number(layout.width) || 318, window.innerWidth - 16));
        const height = compact ? 50 : Math.max(210, Math.min(Number(layout.height) || 410, window.innerHeight - 16));
        const left = Math.max(8, Math.min(Number(layout.left) || 8, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(Number(layout.top) || 8, window.innerHeight - height - 8));
        tracker.style.left = `${left}px`;
        tracker.style.top = `${top}px`;
        tracker.style.right = 'auto';
        tracker.style.bottom = 'auto';
        tracker.style.width = compact ? '' : `${width}px`;
        tracker.style.height = compact ? '' : `${height}px`;
    }

    function bindGoalTrackerInteractions(tracker) {
        let drag = null;
        let layoutReady = false;
        const onPointerMove = event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 5) drag.moved = true;
            const width = tracker.offsetWidth;
            const height = tracker.offsetHeight;
            const left = Math.max(8, Math.min(window.innerWidth - width - 8, drag.left + event.clientX - drag.x));
            const top = Math.max(8, Math.min(window.innerHeight - height - 8, drag.top + event.clientY - drag.y));
            tracker.style.left = `${left}px`;
            tracker.style.top = `${top}px`;
            tracker.style.right = 'auto';
            tracker.style.bottom = 'auto';
        };
        const stopDrag = event => {
            if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
            const openFromOrb = tracker.classList.contains('minimized') && !drag.moved && event?.type === 'pointerup';
            if (drag.moved) tracker._pgSuppressClickUntil = Date.now() + 350;
            drag = null;
            tracker.classList.remove('dragging');
            saveTrackerLayout(tracker);
            if (openFromOrb) {
                tracker._pgSuppressClickUntil = Date.now() + 350;
                state.trackerMinimized = false;
                localStorage.setItem(TRACKER_STATE_KEY, 'open');
                renderGoalTracker();
            }
        };
        tracker.addEventListener('pointerdown', event => {
            const handle = event.target.closest('header,.pgp-tracker-orb');
            if (!handle || (event.target.closest('button') && !event.target.closest('.pgp-tracker-orb'))) return;
            const rect = tracker.getBoundingClientRect();
            drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
            tracker.classList.add('dragging');
            tracker.style.left = `${rect.left}px`;
            tracker.style.top = `${rect.top}px`;
            tracker.style.right = 'auto';
            tracker.style.bottom = 'auto';
            try { tracker.setPointerCapture?.(event.pointerId); } catch {}
            // El orbe minimizado sigue siendo un botón: no cancelamos su pointerdown
            // para conservar el clic que vuelve a abrir el panel.
            if (!event.target.closest('.pgp-tracker-orb')) event.preventDefault();
        });
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stopDrag);
        window.addEventListener('pointercancel', stopDrag);
        const persistResize = () => setTimeout(() => {
            if (tracker.isConnected && tracker.classList.contains('expanded') && !tracker.classList.contains('dragging')) saveTrackerLayout(tracker);
        }, 80);
        tracker.addEventListener('pointerup', persistResize);
        const onViewportResize = () => applyTrackerLayout(tracker);
        window.addEventListener('resize', onViewportResize);
        const resizeObserver = new ResizeObserver(() => {
            if (layoutReady && !state.trackerRendering && tracker.classList.contains('expanded') && !tracker.classList.contains('dragging')) saveTrackerLayout(tracker);
        });
        resizeObserver.observe(tracker);
        requestAnimationFrame(() => { layoutReady = true; applyTrackerLayout(tracker); });
        tracker._pgCleanup = () => {
            resizeObserver.disconnect();
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', stopDrag);
            window.removeEventListener('pointercancel', stopDrag);
            tracker.removeEventListener('pointerup', persistResize);
            window.removeEventListener('resize', onViewportResize);
        };
    }

    function renderGoalTracker() {
        const tracker = document.getElementById(TRACKER_ID);
        if (!tracker || !state.goal) return;
        const berryId = Number(state.goal.berryId);
        const qty = Math.max(1, Number(state.goal.qty) || 1);
        const berry = state.items.get(berryId) || { name: `Berry #${berryId}`, icon: '' };
        const individual = state.goal.mode === 'item';
        const target = individual ? (state.items.get(Number(state.goal.itemId)) || { name: `Item #${state.goal.itemId}`, icon: '' }) : berry;
        const icon = itemIcon(target);
        const complete = goalComplete();
        const progress = goalProgress();
        state.trackerRendering = true;
        tracker.className = `${state.trackerMinimized ? 'minimized' : 'expanded'}${complete ? ' complete' : ''}`;
        if (state.trackerMinimized) {
            tracker.innerHTML = `<button type="button" class="pgp-tracker-orb" data-tracker-action="toggle" title="Abrir objetivo: ${escapeHtml(target.name)}">
                ${icon ? `<img src="${escapeHtml(icon)}" alt="">` : '🍓'}<span>${complete ? '✓' : progress + '%'}</span>
            </button>`;
            applyTrackerLayout(tracker);
            requestAnimationFrame(() => { state.trackerRendering = false; });
            return;
        }
        const rows = goalRows().map(([itemId, need]) => {
            const item = state.items.get(itemId) || { name: `Item #${itemId}`, icon: '' };
            const have = getStock(itemId);
            const remaining = Math.max(0, need - have);
            return `<div class="pgp-track-row${remaining === 0 ? ' done' : ''}">
                <span>${itemIcon(item) ? `<img src="${escapeHtml(itemIcon(item))}" alt="">` : '◆'}</span>
                <div data-pg-no-translate><strong>${escapeHtml(item.name)}</strong><small>${formatNumber(have)} / ${formatNumber(need)}</small></div>
                <em>${remaining ? `Faltan ${formatNumber(remaining)}` : 'Listo'}</em>
            </div>`;
        }).join('');
        tracker.innerHTML = `<header>
                <span class="pgp-track-berry">${icon ? `<img src="${escapeHtml(icon)}" alt="">` : '🍓'}</span>
                <div data-pg-no-translate><small>${individual ? `MATERIAL INDIVIDUAL · ×${qty} BERRY` : `OBJETIVO DE BOTÁNICA · ×${qty}`}</small><strong>${escapeHtml(target.name)}</strong></div>
                <button type="button" data-tracker-action="toggle" title="Minimizar">—</button>
            </header>
            <div class="pgp-track-progress"><span style="width:${progress}%"></span><b>${progress}%</b></div>
            <div class="pgp-track-list">${rows}</div>
            <footer>${complete ? '✓ Objetivo completado' : 'Se actualiza solamente al detectar nuevos drops'}</footer>`;
        applyTrackerLayout(tracker);
        requestAnimationFrame(() => { state.trackerRendering = false; });
    }

    function typeColor(type) {
        return ({
            NORMAL: '#a8a878', STEEL: '#8fa8bd', DARK: '#705848', DRAGON: '#6f35fc', GHOST: '#705898',
            ROCK: '#b8a038', BUG: '#a8b820', PSYCHIC: '#f85888', FLYING: '#7f9fea', GROUND: '#d7b75c',
            POISON: '#a040a0', FIGHTING: '#c03028', ICE: '#72cfd3', GRASS: '#58b957', ELECTRIC: '#f3c527',
            WATER: '#4a86e8', FIRE: '#e66738', FAIRY: '#e58ab3', NEUTRAL: '#9aa4b2', HEAL: '#4ed98a'
        })[type] || '#38c7e8';
    }

    function installStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${SCRIPT_ID}-open{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:7px 12px;border:1px solid #34c98c;border-radius:7px;background:#102a29;color:#e9fff7;font:700 12px/1 system-ui;cursor:pointer;box-shadow:none;transition:background .16s,border-color .16s,transform .16s}
            .${SCRIPT_ID}-open:hover{background:#173b36;border-color:#68e5b3;transform:translateY(-1px)}
            #${PANEL_ID}{position:fixed;inset:0;z-index:2147482500;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,16,.78);backdrop-filter:blur(5px);font-family:Inter,Segoe UI,system-ui,sans-serif;color:#eaf4ff}
            #${PANEL_ID}.open{display:flex}.pgp-window{width:min(1180px,96vw);height:min(780px,94vh);display:flex;flex-direction:column;overflow:hidden;border:1px solid #2c536c;border-radius:14px;background:#0b1724;box-shadow:0 22px 70px rgba(0,0,0,.55)}
            .pgp-header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #294052;background:#102236}.pgp-titlemark{display:grid;place-items:center;width:42px;height:42px;border:1px solid #3e7d61;border-radius:9px;background:#16352d;font-size:22px}.pgp-eyebrow{display:block;color:#64e2ae;font-size:9px;font-weight:900;letter-spacing:1.5px}.pgp-header h2{margin:2px 0 0;font-size:20px;line-height:1.15}.pgp-head-actions{display:flex;gap:8px;margin-left:auto}.pgp-icon-btn{display:grid;place-items:center;width:38px;height:38px;border:1px solid #365168;border-radius:8px;background:#172b3d;color:#eaf4ff;font-size:22px;cursor:pointer;transition:.16s}.pgp-icon-btn:hover{border-color:#58d9ee;background:#1c374d}.pgp-icon-btn.spinning{animation:pgp-spin .7s linear infinite}@keyframes pgp-spin{to{transform:rotate(360deg)}}
            .pgp-toolbar{display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid #243b4d;background:#0d1b2a}.pgp-search{display:flex;align-items:center;gap:8px;flex:1;min-width:150px;height:38px;padding:0 12px;border:1px solid #345169;border-radius:8px;background:#08131f}.pgp-search span{color:#66dff4;font-size:21px}.pgp-search input{width:100%;border:0;outline:0;background:transparent;color:#eff8ff;font:500 12px system-ui}.pgp-filter{min-width:190px;border:1px solid #345169;border-radius:8px;background:#102236;color:#eff8ff;padding:0 10px;font:700 11px system-ui}.pgp-status{display:flex;align-items:center;gap:14px;min-height:31px;padding:6px 15px;border-bottom:1px solid #203548;color:#8faabe;font-size:10px}.pgp-status b{color:#f5fbff}.pgp-status .live{margin-left:auto;color:#62dda9}.pgp-status .warn{margin-left:auto;color:#ffb46a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48%}
            .pgp-layout{display:grid;grid-template-columns:minmax(0,1fr) 380px;min-height:0;flex:1}.pgp-catalog{min-width:0;overflow:auto;padding:12px;scrollbar-width:thin;scrollbar-color:#37637a transparent}.pgp-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.pgp-berry-card{position:relative;display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:67px;padding:8px 10px;border:1px solid #29475c;border-left:3px solid var(--type);border-radius:9px;background:#102237;color:#edf6ff;text-align:left;cursor:pointer;transition:border-color .16s,background .16s,transform .16s}.pgp-berry-card:hover{background:#142c43;border-color:var(--type);transform:translateY(-1px)}.pgp-berry-card.selected{box-shadow:inset 0 0 0 1px var(--type);background:#173047}.pgp-berry-card.goal:after{content:'';position:absolute;inset:3px;border:1px dashed #ffd15c;border-radius:6px;pointer-events:none}.pgp-berry-icon{display:grid;place-items:center;width:46px;height:46px;border:1px solid #33546c;border-radius:8px;background:#091624}.pgp-berry-icon img{width:38px;height:38px;object-fit:contain;image-rendering:auto}.pgp-berry-copy{min-width:0}.pgp-berry-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.pgp-berry-copy small{display:block;margin-top:4px;color:#86a4b8;font-size:9px}.pgp-badge{justify-self:end;padding:4px 6px;border:1px solid;border-radius:5px;font-size:8px;font-weight:900;white-space:nowrap}.pgp-badge.ready{border-color:#2ea56f;background:#113829;color:#72e7a9}.pgp-badge.missing{border-color:#506578;background:#182838;color:#a9b8c5}.pgp-badge.locked{border-color:#6b4d5e;background:#2d1c27;color:#e4a7c1}.pgp-goal-dot{position:absolute;top:4px;right:4px;display:grid;place-items:center;width:15px;height:15px;border-radius:50%;background:#ffd15c;color:#18202b;font-size:9px;font-weight:900}
            .pgp-detail{overflow:auto;border-left:1px solid #294052;background:#0d1d2d;padding:13px;scrollbar-width:thin;scrollbar-color:#37637a transparent}.pgp-detail-head{display:grid;grid-template-columns:56px minmax(0,1fr) auto;align-items:center;gap:10px}.pgp-detail-icon{display:grid;place-items:center;width:54px;height:54px;border:1px solid #3d627a;border-radius:9px;background:#081522}.pgp-detail-icon img{width:46px;height:46px;object-fit:contain}.pgp-detail-head small,.pgp-section-label span,.pgp-goal-title small{color:#58d9ee;font-size:8px;font-weight:900;letter-spacing:1.1px}.pgp-detail-head h3{margin:3px 0 0;font-size:16px}.pgp-max{padding:6px 7px;border:1px solid #35536b;border-radius:6px;color:#91a8b9;font-size:9px}.pgp-max b{color:#74e7ab;font-size:14px}.pgp-unlock{margin:11px 0;padding:7px 9px;border-radius:6px;font-size:9px;font-weight:700}.pgp-unlock.open{background:#103629;color:#6ee2a7;border:1px solid #286c51}.pgp-unlock.locked{background:#321e28;color:#f1a8c3;border:1px solid #704157}.pgp-section-label{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:14px 0 7px}.pgp-section-label small{color:#7e98ab;font-size:8px}.pgp-ingredients{display:grid;gap:6px}.pgp-ingredient{display:grid;grid-template-columns:39px minmax(0,1fr) auto auto;align-items:center;gap:7px;padding:7px;border:1px solid #29475b;border-radius:7px;background:#102336;cursor:help;outline:none;transition:.15s}.pgp-ingredient:hover,.pgp-ingredient:focus{border-color:#55cce4;background:#142b40}.pgp-ingredient.enough{border-left:3px solid #36c980}.pgp-ingredient.tracked{border-color:#ffd15c;background:#292817}.pgp-ing-icon{display:grid;place-items:center;width:37px;height:37px;border-radius:6px;background:#081522}.pgp-ing-icon img{width:31px;height:31px;object-fit:contain}.pgp-ing-main{position:relative;min-width:0;padding-bottom:5px}.pgp-ing-main strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.pgp-ing-main small{display:block;color:#829caf;font-size:8px}.pgp-ing-main i{position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px;background:linear-gradient(90deg,#47d8ef var(--progress),#243d50 var(--progress))}.pgp-ing-count{text-align:right}.pgp-ing-count b{display:block;font-size:11px}.pgp-ing-count b.ok{color:#65e7a4}.pgp-ing-count b.bad{color:#ff8b86}.pgp-ing-count small{color:#90a6b6;font-size:8px}.pgp-track-one{min-width:58px;padding:5px 6px;border:1px solid #3b5b70;border-radius:5px;background:#142b3c;color:#a9c2d3;font-size:7px;font-weight:900;cursor:pointer}.pgp-track-one:hover,.pgp-track-one.active{border-color:#ffd15c;background:#3a3217;color:#ffe59b}.pgp-goal-box{margin-top:12px;padding:11px;border:1px solid #645a2c;border-radius:9px;background:#242617}.pgp-goal-title{display:flex;justify-content:space-between;align-items:center;gap:10px}.pgp-goal-title strong{display:block;margin-top:2px;font-size:11px}.pgp-goal-title button{border:1px solid #d8ad3c;border-radius:6px;background:#ffc84f;color:#202116;padding:6px 10px;font-size:9px;font-weight:900;cursor:pointer}.pgp-goal-actions{display:flex;align-items:center;gap:8px;margin-top:9px}.pgp-goal-actions button{padding:6px 8px;border:1px solid #5c613b;border-radius:6px;background:#1b2825;color:#dce6d7;font-size:8px;font-weight:900;cursor:pointer}.pgp-goal-actions button:hover,.pgp-goal-actions button.active{border-color:#ffd15c;background:#3b3318;color:#ffe79c}.pgp-goal-actions span{color:#9da48d;font-size:8px}.pgp-goal-box p{margin:8px 0 0;color:#a9ac96;font-size:9px;line-height:1.4}.pgp-qty{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;color:#d8dfc3;font-size:9px}.pgp-qty input{width:104px;height:30px;border:1px solid #7a6934;border-radius:6px;background:#111a18;color:#fff;padding:0 8px;font-weight:800}.pgp-goal-progress{height:5px;margin-top:9px;border-radius:4px;background:#3b3b26;overflow:hidden}.pgp-goal-progress span{display:block;height:100%;background:#ffd15c}.pgp-loading,.pgp-empty{grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:9px;min-height:150px;border:1px dashed #345269;border-radius:9px;color:#829caf;font-size:11px}.pgp-loading span{width:17px;height:17px;border:2px solid #315367;border-top-color:#58d9ee;border-radius:50%;animation:pgp-spin .7s linear infinite}
            #${POPOVER_ID}{position:fixed;z-index:2147483600;display:none;overflow:hidden;border:1px solid #3b6178;border-radius:10px;background:#0b1825;color:#edf7ff;box-shadow:0 16px 45px rgba(0,0,0,.58);font-family:Inter,Segoe UI,system-ui,sans-serif;pointer-events:auto}#${POPOVER_ID}.open{display:block}#${POPOVER_ID} header{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid #294255;background:#10263a}#${POPOVER_ID} header>span{display:grid;place-items:center;width:35px;height:35px;border-radius:6px;background:#081522}#${POPOVER_ID} header img{width:31px;height:31px;object-fit:contain}#${POPOVER_ID} header small{display:block;color:#56d9ef;font-size:7px;font-weight:900;letter-spacing:1px}#${POPOVER_ID} header strong{font-size:11px}.pgp-drop-list{max-height:300px;overflow:auto;padding:5px;scrollbar-width:thin}.pgp-drop-row{display:grid;grid-template-columns:19px 42px minmax(0,1fr) auto 53px;align-items:center;gap:6px;min-height:48px;padding:4px 6px;border-bottom:1px solid #1e3546;font-size:9px}.pgp-drop-row>b{display:grid;place-items:center;width:18px;height:18px;border-radius:4px;background:#183047;color:#68dff1;font-size:8px}.pgp-poke-sprite{display:block;width:42px;height:42px;border:1px solid #27475c;border-radius:6px;background:#081522;image-rendering:pixelated}.pgp-drop-row span{font-weight:750}.pgp-drop-row span small{margin-left:4px;color:#718da1;font-size:7px}.pgp-drop-row em{color:#9eb2c1;font-style:normal}.pgp-drop-row>strong{color:#6ce0a4;text-align:right}.pgp-no-drop{padding:18px 12px;color:#91a7b7;font-size:10px;line-height:1.45}#${POPOVER_ID} footer{padding:6px 9px;border-top:1px solid #294255;color:#718da1;font-size:7px;text-align:center}
            .pgp-market-price{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:37px;margin:7px 7px 2px;padding:6px 8px;border:1px solid #3d5737;border-radius:7px;background:#142718}.pgp-market-price>span:not(.pgp-market-loading){display:flex;gap:5px;flex-wrap:wrap}.pgp-market-price b{display:inline-flex;align-items:center;padding:4px 6px;border-radius:5px;font-size:10px}.pgp-market-price b.gold{border:1px solid #39764e;background:#113a27;color:#65e59c}.pgp-market-price b.diamonds{border:1px solid #2d718e;background:#102f40;color:#64d9ff}.pgp-market-price small{color:#8fa78f;font-size:7px;text-align:right}.pgp-market-price.empty strong{color:#e8c46d;font-size:10px}.pgp-market-loading{color:#9eb39e;font-size:8px}.pgp-market-loading:before{content:'◌';display:inline-block;margin-right:5px;color:#66dca4;animation:pgp-spin .8s linear infinite}
            .pgp-berry-pop-body{display:grid;gap:9px;padding:10px}.pgp-berry-pop-tags{display:flex;gap:6px}.pgp-berry-pop-tags span{padding:4px 7px;border:1px solid #3d5264;border-radius:5px;background:#152838;color:#c9dae6;font-size:8px;font-weight:850}.pgp-berry-pop-tags span:first-child{border-color:var(--berry-type);color:var(--berry-type);background:color-mix(in srgb,var(--berry-type) 12%,#102131)}.pgp-berry-effect{margin:0;padding:8px;border:1px solid #2b4659;border-radius:7px;background:#0d2030;color:#d8e6ef;font-size:10px;line-height:1.45}.pgp-berry-pop-status{display:grid;grid-template-columns:1fr auto;align-items:center;gap:7px;color:#8ba5b7;font-size:8px}.pgp-berry-pop-status b{color:#72e6aa;font-size:11px}.pgp-berry-pop-status .ready{color:#66dda3}.pgp-berry-pop-status .locked{color:#f09bb8}.pgp-berry-recipe-title{color:#58d9ee;font-size:7px;font-weight:900;letter-spacing:1px}.pgp-berry-materials{display:grid;grid-template-columns:1fr 1fr;gap:5px}.pgp-berry-material{display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:center;gap:5px;padding:5px;border:1px solid #263f50;border-radius:6px;background:#0f2130}.pgp-berry-material img{width:23px;height:23px;object-fit:contain}.pgp-berry-material b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px}.pgp-berry-material em{color:#91a9b9;font-size:7px;font-style:normal;font-weight:800}
            #${TRACKER_ID}{position:fixed;left:14px;bottom:72px;z-index:2147481800;font-family:Inter,Segoe UI,system-ui,sans-serif;color:#edf7ff}#${TRACKER_ID}.expanded{display:flex;flex-direction:column;width:min(318px,calc(100vw - 28px));min-width:min(270px,calc(100vw - 16px));min-height:210px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:hidden;resize:both;border:1px solid #3d6951;border-radius:11px;background:#0b1825;box-shadow:0 12px 38px rgba(0,0,0,.5)}#${TRACKER_ID}.expanded:after{content:'⋰';position:absolute;right:2px;bottom:0;color:#70cfa2;font-size:13px;line-height:1;pointer-events:none;opacity:.8}#${TRACKER_ID}.complete{border-color:#62e29f;box-shadow:0 0 0 1px rgba(98,226,159,.28),0 12px 38px rgba(0,0,0,.5)}#${TRACKER_ID}>header{display:grid;grid-template-columns:42px minmax(0,1fr) 29px;align-items:center;flex:0 0 auto;gap:7px;padding:8px;border-bottom:1px solid #29493a;background:#112a24;cursor:grab;touch-action:none;user-select:none}#${TRACKER_ID}.dragging>header{cursor:grabbing}#${TRACKER_ID}>header small{display:block;color:#6de3a7;font-size:7px;font-weight:900;letter-spacing:.8px}#${TRACKER_ID}>header strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}#${TRACKER_ID}>header button{display:grid;place-items:center;width:29px;height:29px;border:1px solid #365947;border-radius:6px;background:#18352d;color:#edf7ff;font-size:14px;cursor:pointer}#${TRACKER_ID}>header button:hover{background:#21483b;border-color:#65dda5}.pgp-track-berry{display:grid;place-items:center;width:40px;height:40px;border:1px solid #3d6951;border-radius:7px;background:#081612}.pgp-track-berry img{width:34px;height:34px;object-fit:contain}.pgp-track-progress{position:relative;flex:0 0 13px;height:13px;margin:8px;border-radius:5px;background:#1d3540;overflow:hidden}.pgp-track-progress span{display:block;height:100%;background:linear-gradient(90deg,#39c982,#78e9ad)}.pgp-track-progress b{position:absolute;inset:0;display:grid;place-items:center;color:#f5fff9;font-size:7px;text-shadow:0 1px 2px #000}.pgp-track-list{display:grid;align-content:start;flex:1 1 auto;gap:4px;min-height:0;overflow:auto;padding:0 8px 7px;scrollbar-width:thin}.pgp-track-row{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:7px;padding:5px;border:1px solid #253f4f;border-radius:6px;background:#0f2130}.pgp-track-row.done{border-color:#275f46;background:#102b24}.pgp-track-row>span{display:grid;place-items:center;width:31px;height:31px;border-radius:5px;background:#07131d}.pgp-track-row img{width:27px;height:27px;object-fit:contain}.pgp-track-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.pgp-track-row small{display:block;color:#7f9bad;font-size:8px}.pgp-track-row em{color:#ff9a8e;font-size:8px;font-style:normal;font-weight:800;white-space:nowrap}.pgp-track-row.done em{color:#66e3a3}#${TRACKER_ID}>footer{flex:0 0 auto;padding:6px 8px;border-top:1px solid #233d4d;color:#7896a9;font-size:7px;text-align:center}#${TRACKER_ID}.complete>footer{color:#6de3a7}.pgp-tracker-orb{position:relative;display:grid;place-items:center;width:50px;height:50px;border:1px solid #58d296;border-radius:12px;background:#102a24;box-shadow:0 8px 26px rgba(0,0,0,.45);cursor:grab;touch-action:none}.pgp-tracker-orb:active{cursor:grabbing}.pgp-tracker-orb:hover{background:#173b31;transform:translateY(-1px)}.pgp-tracker-orb img{width:39px;height:39px;object-fit:contain;pointer-events:none}.pgp-tracker-orb>span{position:absolute;right:-7px;top:-7px;min-width:23px;padding:3px;border:1px solid #446b58;border-radius:10px;background:#0b1724;color:#75e8ad;font-size:7px;font-weight:900;pointer-events:none}
            @media(max-width:850px){#${PANEL_ID}{padding:6px}.pgp-window{width:100%;height:98vh;border-radius:10px}.pgp-layout{grid-template-columns:1fr}.pgp-catalog{max-height:45vh}.pgp-detail{border-left:0;border-top:1px solid #294052}.pgp-card-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pgp-status{overflow-x:auto}.pgp-status span{white-space:nowrap}.pgp-status .warn,.pgp-status .live{margin-left:0}.pgp-detail{padding-bottom:max(13px,env(safe-area-inset-bottom))}}
            @media(max-width:560px){.pgp-header{padding:10px}.pgp-titlemark{width:36px;height:36px}.pgp-header h2{font-size:16px}.pgp-toolbar{flex-wrap:wrap}.pgp-search,.pgp-filter{width:100%;flex:1 1 100%;height:36px}.pgp-card-grid{grid-template-columns:1fr}.pgp-catalog{padding:8px}.pgp-berry-card{min-height:61px}.pgp-layout{overflow:auto}.pgp-catalog,.pgp-detail{overflow:visible;max-height:none}.pgp-window{overflow:auto}.pgp-section-label small{display:none}.pgp-ingredient{grid-template-columns:39px minmax(0,1fr) auto}.pgp-track-one{grid-column:2/4;justify-self:stretch}.pgp-goal-actions{align-items:stretch;flex-direction:column}.pgp-goal-actions span{line-height:1.4}.pgp-berry-materials{grid-template-columns:1fr}.pgp-berry-pop-status{grid-template-columns:1fr}#${TRACKER_ID}{left:8px;bottom:62px}#${TRACKER_ID}.expanded{width:min(300px,calc(100vw - 16px))}.pgp-drop-row{grid-template-columns:17px 38px minmax(0,1fr) auto}.pgp-drop-row>strong{grid-column:4}.pgp-drop-row em{display:none}.pgp-poke-sprite{width:38px;height:38px}}
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function start() {
        installStyles();
        const observer = new MutationObserver(records => {
            scheduleProfessionEnhancement();
            detectDropMutation(records);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        scheduleProfessionEnhancement();
        if (state.goal) activateGoalTracker();
    }

    installDropSignalBridge();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
