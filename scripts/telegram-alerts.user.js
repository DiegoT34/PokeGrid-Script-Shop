// ==UserScript==
// @name         PokeGrid Telegram Alerts
// @namespace    pokegrid.telegram-alerts
// @version      1.14.0
// @description  Alertas de juego y consultas bajo demanda del Market mediante comandos y botones interactivos de Telegram.
// @author       PokeGrid
// @match        https://poke.idleworld.online/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.telegram.org
// @connect      poke.idleworld.online
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG_KEY = 'telegramConfigV1';
  const CONFIG_REFRESH_MS = 10_000;
  const DROP_SCAN_MS = 2_000;
  const SEEN_STORAGE_KEY = 'pokegrid:telegram-alerts:seen:v1';
  const SEEN_MAX_AGE = 24 * 60 * 60_000;
  const SCRIPT_BOOT_TIME = Date.now();
  const GAME_ORIGIN = 'https://poke.idleworld.online';
  const GAME_ASSET_ROOT = `${GAME_ORIGIN}/game/asset-packs`;
  const GAME_MARKET_URL = '/api/game/market?category=All';
  const TELEGRAM_COMMAND_POLL_MS = 2_750;
  const TELEGRAM_COMMAND_LEASE_MS = 30_000;
  const TELEGRAM_COMMAND_LEASE_KEY = 'pokegrid:telegram-alerts:command-host:v1';
  const TELEGRAM_COMMAND_OFFSET_PREFIX = 'pokegrid:telegram-alerts:update-offset:v1:';
  const TELEGRAM_MARKET_FAVORITES_KEY = 'pokegrid:telegram-alerts:market-favorites:v1';
  const account = GM.info?.script?.account || { index: -1, label: 'Cuenta' };
  const accountLabel = String(account.label || `Cuenta ${Number(account.index) + 1}`);
  const imageCache = new Map();
  const looktypeCache = new Map();
  let creatureCatalogPromise = null;
  let itemCatalogPromise = null;
  let outfitIndexPromise = null;
  const seenEvents = loadSeenEvents();
  const huntDropTotals = new Map();
  const recentCaptureRoutes = new Map();
  const recentDropRoutes = new Map();
  const currentStock = {
    balls: new Map(),
    potions: new Map()
  };
  const socketStock = {
    balls: new Map(),
    potions: new Map()
  };
  let stockSocketRequestAt = 0;
  const backgroundStockCache = {
    balls: new Map(),
    potions: new Map(),
    scannedAt: 0
  };
  let backgroundStockScanScheduled = false;
  let config = defaults();
  let panel = null;
  let statusElement = null;
  let deliveryQueue = Promise.resolve();
  let telegramCommandPollBusy = false;
  let telegramCommandToken = '';
  let telegramCommandOffset = 0;
  let telegramCommandsRegisteredFor = '';
  const telegramPendingMarketSearch = new Set();
  let telegramMarketFavorites = null;
  let telegramMarketFavoritesPromise = null;
  const telegramCommandInstanceId = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;

  // === NUEVO: Control para no repetir la alerta de stock en cada ciclo ===
  const lowStockNotified = new Map(); 
  const lowStockPending = new Set();

  const AVAILABLE_TIERS = [
    { id: 'weak', label: 'Débil', color: '#668b99' },
    { id: 'common', label: 'Común', color: '#91dfff' },
    { id: 'uncommon', label: 'Incomún', color: '#35d99a' },
    { id: 'rare', label: 'Raro', color: '#3182ce' },
    { id: 'epic', label: 'Épico', color: '#9f7aea' },
    { id: 'legendary', label: 'Legendario', color: '#ed8936' },
    { id: 'mythic', label: 'Mítico', color: '#e53e3e' },
    { id: 'ancient', label: 'Ancestral', color: '#d69e2e' },
    { id: 'divine', label: 'Divino', color: '#38b2ac' }
  ];

  function defaults() {
    return {
      token: '',
      accountName: '',
      recipientsList: [{ label: '', chatId: '' }],
      alerts: {
        filteredCaptures: false,
        legendaryCaptures: true,
        shinyCaptures: true,
        shinyDefeats: true,
        drops: false
      },
      capture: {
        minIv: 0,
        minLevel: 0,
        tiers: '',
        pokemon: ''
      },
      drops: {
        names: '',
        minQuantity: 1
      },
      // === NUEVO: Valores por defecto para el sistema de stock ===
      stock: {
        enabled: false,
        ballRules: [],
        potionsEnabled: false,
        potionRules: []
      },
      ui: {
        hideButton: false,
        buttonSize: 38,
        position: 'bottom-right',
        shortcut: 'Alt+T'
      }
    };
  }

  function normalizeConfig(value) {
    const base = defaults();
    const source = value && typeof value === 'object' ? value : {};
    
    let recipientsList = [];
    if (Array.isArray(source.recipientsList)) {
      recipientsList = source.recipientsList.map(r => ({
        label: String(r?.label || '').trim(),
        chatId: String(r?.chatId || '').trim()
      }));
    } else if (typeof source.recipientsText === 'string' && source.recipientsText.trim()) {
      for (const line of source.recipientsText.split(/\r?\n/)) {
        const text = line.trim();
        if (!text || text.startsWith('#')) continue;
        const parts = text.split('|').map((part) => part.trim());
        const chatId = String(parts.length > 1 ? parts.at(-1) : parts[0]).trim();
        const label = parts.length > 1 ? parts.slice(0, -1).join(' | ') : '';
        recipientsList.push({ label, chatId });
      }
    }
    if (!recipientsList.length) recipientsList = [{ label: '', chatId: '' }];

    return {
      token: String(source.token || '').trim(),
      accountName: String(source.accountName || '').trim(),
      recipientsList,
      alerts: {
        filteredCaptures: source.alerts?.filteredCaptures === true,
        legendaryCaptures: source.alerts?.legendaryCaptures !== false,
        shinyCaptures: source.alerts?.shinyCaptures !== false,
        shinyDefeats: source.alerts?.shinyDefeats !== false,
        drops: source.alerts?.drops === true
      },
      capture: {
        minIv: clampNumber(source.capture?.minIv, 0, 192, base.capture.minIv),
        minLevel: clampNumber(source.capture?.minLevel, 0, 9999, base.capture.minLevel),
        tiers: String(source.capture?.tiers || ''),
        pokemon: String(source.capture?.pokemon || '')
      },
      drops: {
        names: String(source.drops?.names || ''),
        minQuantity: clampNumber(source.drops?.minQuantity, 1, 999999, base.drops.minQuantity)
      },
      // === NUEVO: Normalización de configuración de stock ===
      stock: {
        enabled: source.stock?.enabled === true,
        ballRules: normalizeStockRules(
          source.stock?.ballRules,
          source.stock?.balls,
          source.stock?.threshold
        ),
        potionsEnabled:
          source.stock?.potionsEnabled === true,
        potionRules: normalizeStockRules(
          source.stock?.potionRules,
          source.stock?.potions,
          source.stock?.potionThreshold
        )
      },
      ui: {
        hideButton: source.ui?.hideButton === true,
        buttonSize: clampNumber(source.ui?.buttonSize, 20, 100, base.ui.buttonSize),
        position: ['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(source.ui?.position) ? source.ui.position : base.ui.position,
        shortcut: typeof source.ui?.shortcut === 'string' ? source.ui.shortcut : base.ui.shortcut
      }
    };
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  }

  function normalizeStockRules(
    rules,
    legacyNames = '',
    legacyThreshold = 10
  ) {
    const normalizedRules = new Map();
    const add = (name, threshold) => {
      const cleanName = clean(name);

      if (!cleanName) return;

      normalizedRules.set(
        normalized(cleanName),
        {
          name: cleanName,
          threshold: clampNumber(
            threshold,
            0,
            999999,
            10
          )
        }
      );
    };

    String(legacyNames || '')
      .split(/[\n,;]+/)
      .map(clean)
      .filter(Boolean)
      .forEach((name) =>
        add(name, legacyThreshold)
      );

    if (Array.isArray(rules)) {
      rules.forEach((rule) =>
        add(rule?.name, rule?.threshold)
      );
    }

    return [...normalizedRules.values()];
  }

  function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function normalized(value) {
    return clean(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function formatTime12h(dateInput) {
    const date = dateInput ? new Date(dateInput) : new Date();
    if (isNaN(date.getTime())) {
      return new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    }
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  }

  function invalidPokemonName(value) {
    const name = normalized(value)
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return new Set([
      'you',
      'your',
      'voce',
      'tu',
      'usted',
      'ustedes',
      'player',
      'jogador',
      'jugador',
      'pokemon',
      'shiny',
      'it',
      'he',
      'she',
      'ele',
      'ela'
    ]).has(name);
  }

  function loadSeenEvents() {
    try {
      const rows = JSON.parse(
        localStorage.getItem(SEEN_STORAGE_KEY) || '[]'
      );

      const cutoff = Date.now() - SEEN_MAX_AGE;

      return new Map(
        (Array.isArray(rows) ? rows : [])
          .filter(
            (row) =>
              Array.isArray(row) &&
              typeof row[0] === 'string' &&
              Number(row[1]) >= cutoff
          )
          .slice(-500)
      );
    } catch {
      return new Map();
    }
  }

  function saveSeenEvents() {
    try {
      const cutoff = Date.now() - SEEN_MAX_AGE;

      const rows = [...seenEvents]
        .filter(([, timestamp]) => timestamp >= cutoff)
        .slice(-500);

      localStorage.setItem(
        SEEN_STORAGE_KEY,
        JSON.stringify(rows)
      );
    } catch {}
  }

  function listFrom(value) {
    return String(value || '')
      .split(/[\n,;]+/)
      .map(normalized)
      .filter(Boolean);
  }

  function firstNumber(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    const match = clean(value)
      .replace(',', '.')
      .match(/-?[0-9]+(?:[.][0-9]+)?/);

    const parsed = match ? Number(match[0]) : NaN;

    return Number.isFinite(parsed) ? parsed : null;
  }

  function canonicalTier(value) {
    const source = normalized(value).replace(/[^a-z0-9 ]/g, ' ');

    const aliases = [
      ['divine', ['divine', 'divino', 'divina']],
      ['ancient', ['ancient', 'ancestral', 'antiguo', 'antigua']],
      ['mythic', ['mythic', 'mitico', 'mitica']],
      ['legendary', ['legendary', 'legendario', 'legendaria']],
      ['epic', ['epic', 'epico', 'epica']],
      ['rare', ['rare', 'raro', 'rara']],
      ['uncommon', ['uncommon', 'poco comun']],
      ['common', ['common', 'comun']],
      ['weak', ['weak', 'debil']]
    ];

    return (
      aliases.find(([, values]) =>
        values.some((alias) =>
          (` ${source} `).includes(` ${alias} `)
        )
      )?.[0] || source.trim()
    );
  }

  const KNOWN_TIERS = new Set([
    'weak',
    'common',
    'uncommon',
    'rare',
    'epic',
    'legendary',
    'mythic',
    'ancient',
    'divine'
  ]);

  function knownTier(value) {
    const tier = canonicalTier(value);
    return KNOWN_TIERS.has(tier) ? tier : '';
  }

  function tierFromQuality(value) {
    const quality = firstNumber(value);

    if (quality === null || quality <= 0) return '';
    if (quality >= 4.0) return 'divine';
    if (quality >= 3.0) return 'ancient';
    if (quality >= 2.0) return 'mythic';
    if (quality >= 1.7) return 'legendary';
    if (quality >= 1.5) return 'epic';
    if (quality >= 1.3) return 'rare';
    if (quality >= 1.1) return 'uncommon';
    if (quality >= 1.0) return 'common';

    return 'weak';
  }

  function displayTier(tier) {
    return {
      weak: 'DÉBIL',
      common: 'COMÚN',
      uncommon: 'INCOMÚN',
      rare: 'RARO',
      epic: 'ÉPICO',
      legendary: 'LEGENDARIO',
      mythic: 'MÍTICO',
      ancient: 'ANCESTRAL',
      divine: 'DIVINO'
    }[tier] || '';
  }

  function captureRowQuality(row) {
    const meta = clean(
      row.querySelector('.clog-meta')?.textContent ||
      row.textContent
    );

    const match = meta.match(
      /x\s*([0-9]+(?:[.,][0-9]+)?)/i
    );

    if (match) {
      const val = firstNumber(match[1]);
      if (val !== null) return val;
    }

    return null;
  }

  // ============================================================
  // RESOLUCIÓN DE LA POKÉ BALL REAL
  // ============================================================

  function isGenericBallName(value) {
    const name = normalized(value)
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return (
      !name ||
      new Set([
        'ball',
        'poke ball',
        'pokeball',
        'poké ball',
        'capture ball',
        'unknown ball',
        'bola',
        'pokebola',
        'poke bola'
      ]).has(name)
    );
  }

  function ballLikeText(value) {
    const name = normalized(value)
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return (
      /(^| )ball( |$)/.test(name) ||
      /pokeball/.test(name) ||
      /poke ball/.test(name)
    );
  }

  function extractBallEvidence(
    value,
    depth = 0,
    evidence = null,
    seen = null
  ) {
    evidence ||= {
      names: [],
      ids: [],
      icons: []
    };

    seen ||= new WeakSet();

    if (value == null || depth > 6) {
      return evidence;
    }

    if (typeof value !== 'object') {
      return evidence;
    }

    if (seen.has(value)) {
      return evidence;
    }

    seen.add(value);

    const addName = (candidate) => {
      const text = clean(candidate);

      if (
        text &&
        !evidence.names.some(
          (v) => normalized(v) === normalized(text)
        )
      ) {
        evidence.names.push(text);
      }
    };

    const addId = (candidate) => {
      const id = Number(candidate);

      if (
        Number.isFinite(id) &&
        id > 0 &&
        !evidence.ids.includes(id)
      ) {
        evidence.ids.push(id);
      }
    };

    const addIcon = (candidate) => {
      const text = clean(candidate);

      if (
        text &&
        !evidence.icons.includes(text)
      ) {
        evidence.icons.push(text);
      }
    };

    for (
      const [key, child]
      of Object.entries(value).slice(0, 120)
    ) {
      const keyNorm = normalized(key)
        .replace(/[^a-z0-9]/g, '');

      const isBallKey =
        /ball|pokeball|pokebola/.test(keyNorm);

      const isUsedItemKey =
        /^(useditem|useditemid|captureitem|captureitemid|itemused|itemusedid|throwitem|throwitemid)$/
          .test(keyNorm);

      if (isBallKey || isUsedItemKey) {
        if (typeof child === 'string') {
          if (
            /icon|image|sprite|src|url/.test(keyNorm)
          ) {
            addIcon(child);
          } else {
            addName(child);
          }
        } else if (typeof child === 'number') {
          addId(child);
        } else if (
          child &&
          typeof child === 'object'
        ) {
          addName(
            child.name ||
            child.displayName ||
            child.itemName ||
            child.label ||
            child.title
          );

          addId(
            child.id ??
            child.itemId ??
            child.ballId ??
            child.pokeBallId ??
            child.pokeballId
          );

          addIcon(
            child.icon ||
            child.iconUrl ||
            child.image ||
            child.sprite ||
            child.src
          );
        }
      }

      if (
        child &&
        typeof child === 'object'
      ) {
        extractBallEvidence(
          child,
          depth + 1,
          evidence,
          seen
        );
      }
    }

    return evidence;
  }

  function basenameHint(value) {
    const source = clean(value)
      .toLowerCase()
      .split('?')[0]
      .split('#')[0];

    return (
      source
        .split('/')
        .at(-1)
        ?.replace(/\.[a-z0-9]+$/i, '') ||
      source
    );
  }

  async function ballNameFromEvidence(evidence) {
    if (!evidence) return '';

    for (const value of evidence.names || []) {
      if (
        ballLikeText(value) &&
        !isGenericBallName(value)
      ) {
        return clean(value);
      }
    }

    let items = [];

    try {
      items = await itemCatalog();
    } catch {}

    if (!items.length) {
      return '';
    }

    const balls = items.filter(
      (item) => ballLikeText(item?.name)
    );

    if (!balls.length) {
      return '';
    }

    for (const id of evidence.ids || []) {
      const item = balls.find(
        (row) =>
          Number(row.id ?? row.itemId) ===
          Number(id)
      );

      if (item?.name) {
        return clean(item.name);
      }
    }

    for (const value of evidence.names || []) {
      const n = normalized(value);

      const exact = balls.find(
        (row) => normalized(row.name) === n
      );

      if (exact?.name) {
        return clean(exact.name);
      }

      if (!isGenericBallName(value)) {
        const partial = balls.find((row) =>
          n.includes(normalized(row.name)) ||
          normalized(row.name).includes(n)
        );

        if (partial?.name) {
          return clean(partial.name);
        }
      }
    }

    const iconHints = (
      evidence.icons || []
    )
      .map(basenameHint)
      .filter(Boolean);

    for (const item of balls) {
      const itemIcon = clean(
        item.iconUrl ||
        item.icon ||
        item.image ||
        item.sprite
      );

      const itemHint = basenameHint(itemIcon);

      if (
        itemHint &&
        iconHints.some(
          (hint) =>
            hint === itemHint ||
            hint.includes(itemHint) ||
            itemHint.includes(hint)
        )
      ) {
        return clean(item.name);
      }
    }

    return '';
  }

  function captureRowsMatching(capture) {
    const targetName =
      canonicalPokemonName(capture?.name);

    const targetIv =
      firstNumber(
        capture?.iv ??
        capture?.meta
      );

    const targetLevel =
      firstNumber(capture?.level);

    return [
      ...document.querySelectorAll('.clog-row')
    ].filter((row) => {
      const rowName =
        canonicalPokemonName(
          row.querySelector('.clog-name')
            ?.textContent ||
          row.textContent
        );

      const sameName =
        !targetName ||
        !rowName ||
        ` ${rowName} `.includes(
          ` ${targetName} `
        ) ||
        ` ${targetName} `.includes(
          ` ${rowName} `
        );

      if (!sameName) {
        return false;
      }

      const meta = clean(
        row.querySelector('.clog-meta')
          ?.textContent ||
        row.textContent
      );

      const rowIv = firstNumber(
        meta.match(
          /iv[^0-9]*([0-9]+)/i
        )?.[1]
      );

      const rowLevel = firstNumber(
        row.querySelector('.clog-lvl')
          ?.textContent
      );

      if (
        targetIv !== null &&
        rowIv !== null &&
        targetIv !== rowIv
      ) {
        return false;
      }

      if (
        targetLevel !== null &&
        rowLevel !== null &&
        targetLevel !== rowLevel
      ) {
        return false;
      }

      return true;
    });
  }

  async function ballNameFromRow(row) {
    if (!row) {
      return '';
    }

    const evidence = {
      names: [],
      ids: [],
      icons: []
    };

    const nodes = [
      row,
      ...row.querySelectorAll('*')
    ].slice(0, 180);

    for (const node of nodes) {
      const ds = node.dataset || {};

      for (
        const [key, value]
        of Object.entries(ds)
      ) {
        if (
          /ball|pokeball|pokebola/i.test(key)
        ) {
          if (/id/i.test(key)) {
            evidence.ids.push(Number(value));
          } else {
            evidence.names.push(value);
          }
        }

        if (/itemId/i.test(key)) {
          evidence.ids.push(Number(value));
        }
      }

      for (
        const attr of [
          'alt',
          'title',
          'aria-label',
          'data-item-name',
          'data-ball-name'
        ]
      ) {
        const value =
          node.getAttribute?.(attr);

        if (value) {
          evidence.names.push(value);
        }
      }

      const src =
        node.getAttribute?.('src');

      if (src) {
        evidence.icons.push(src);
      }

      const style =
        node.getAttribute?.('style');

      if (
        style &&
        /url\(/i.test(style)
      ) {
        evidence.icons.push(style);
      }
    }

    const visibleBall = clean(
      row.querySelector(
        '.clog-ball, .capture-ball, [data-ball-name]'
      )?.textContent
    );

    if (visibleBall) {
      evidence.names.unshift(visibleBall);
    }

    let resolved =
      await ballNameFromEvidence(evidence);

    if (resolved) {
      return resolved;
    }

    let items = [];

    try {
      items = await itemCatalog();
    } catch {}

    const html =
      normalized(row.innerHTML);

    for (const item of items) {
      if (!ballLikeText(item?.name)) {
        continue;
      }

      const itemName =
        normalized(item.name);

      const iconHint =
        basenameHint(
          item.iconUrl ||
          item.icon ||
          item.image ||
          item.sprite
        );

      if (
        (itemName &&
          html.includes(itemName)) ||
        (iconHint &&
          html.includes(
            normalized(iconHint)
          ))
      ) {
        return clean(item.name);
      }
    }

    return '';
  }

  function matchingCaptureRecords(
    capture,
    payload
  ) {
    const targetName =
      canonicalPokemonName(capture?.name);

    const targetIv =
      firstNumber(
        capture?.iv ??
        capture?.meta
      );

    const targetLevel =
      firstNumber(capture?.level);

    return captureRecords(payload)
      .filter((record) => {
        const name =
          canonicalPokemonName(
            record.pokemonName ||
            record.pokeName ||
            record.speciesName ||
            record.displayName ||
            record.pokemon?.name ||
            record.species?.name ||
            record.name
          );

        const sameName =
          !targetName ||
          !name ||
          ` ${name} `.includes(
            ` ${targetName} `
          ) ||
          ` ${targetName} `.includes(
            ` ${name} `
          );

        if (!sameName) {
          return false;
        }

        const iv = firstNumber(
          record.ivTotal ??
          record.totalIv ??
          record.iv ??
          record.ivs
        );

        const level =
          firstNumber(
            record.level ??
            record.pokemon?.level
          );

        if (
          targetIv !== null &&
          iv !== null &&
          targetIv !== iv
        ) {
          return false;
        }

        if (
          targetLevel !== null &&
          level !== null &&
          targetLevel !== level
        ) {
          return false;
        }

        return true;
      });
  }

  async function ballNameFromCapturePayload(
    capture,
    payload
  ) {
    for (
      const record
      of matchingCaptureRecords(
        capture,
        payload
      )
    ) {
      const resolved =
        await ballNameFromEvidence(
          extractBallEvidence(record)
        );

      if (resolved) {
        return resolved;
      }
    }

    return '';
  }

  async function resolveCaptureBall(capture) {
    const directEvidence =
      extractBallEvidence(
        capture || {}
      );

    const direct =
      await ballNameFromEvidence(
        directEvidence
      );

    if (direct) {
      return direct;
    }

    if (
      capture?._captureRow instanceof Element
    ) {
      const fromOwnRow =
        await ballNameFromRow(
          capture._captureRow
        );

      if (fromOwnRow) {
        return fromOwnRow;
      }
    }

    for (
      let attempt = 0;
      attempt < 7;
      attempt += 1
    ) {
      for (
        const row
        of captureRowsMatching(capture)
      ) {
        const fromRow =
          await ballNameFromRow(row);

        if (fromRow) {
          return fromRow;
        }
      }

      if (attempt < 6) {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 160)
        );
      }
    }

    let payload =
      window.__pokeGridCaptureLogPayload;

    let fromPayload =
      await ballNameFromCapturePayload(
        capture,
        payload
      );

    if (fromPayload) {
      return fromPayload;
    }

    for (
      let attempt = 0;
      attempt < 3;
      attempt += 1
    ) {
      try {
        const response = await fetch(
          '/api/game/capture-log?filter=all',
          {
            credentials: 'include',
            cache: 'no-store'
          }
        );

        if (response.ok) {
          payload =
            await response.json();

          window.__pokeGridCaptureLogPayload =
            payload;

          window.__pokeGridCaptureLogPayloadAt =
            Date.now();

          fromPayload =
            await ballNameFromCapturePayload(
              capture,
              payload
            );

          if (fromPayload) {
            return fromPayload;
          }
        }
      } catch {}

      if (attempt < 2) {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 300)
        );
      }
    }

    const fallback = clean(
      capture?.ballName ||
      capture?.pokeBallName ||
      capture?.usedBallName ||
      capture?.ball ||
      capture?.pokeBall
    );

    return isGenericBallName(fallback)
      ? ''
      : fallback;
  }

  // ============================================================
  // NÚMERO DE CAPTURA
  // ============================================================

  function directCaptureNumber(capture) {
    const candidates = [
      capture?.captureNumber,
      capture?.captureNo,
      capture?.captureNum,
      capture?.logNumber,
      capture?.logNo,
      capture?.entryNumber,
      capture?.sequenceNumber,
      capture?.sequence,
      capture?.captureIndex,
      capture?.logIndex,
      capture?.captureId
    ];

    for (const value of candidates) {
      const parsed = Number(
        String(value ?? '')
          .replace(/[^0-9]/g, '')
      );

      if (
        Number.isFinite(parsed) &&
        parsed > 0
      ) {
        return parsed;
      }
    }

    const id =
      Number(capture?.id);

    return (
      Number.isFinite(id) &&
      id > 0
    )
      ? id
      : null;
  }

  function captureNumberFromRow(row) {
    if (!row) {
      return null;
    }

    const candidates = [
      row.dataset?.captureNumber,
      row.dataset?.captureId,
      row.dataset?.logNumber,

      row.querySelector(
        '[data-capture-number]'
      )?.dataset?.captureNumber,

      row.querySelector(
        '.clog-number, .clog-index, .clog-id, .capture-number'
      )?.textContent
    ];

    for (const value of candidates) {
      const parsed =
        firstNumber(value);

      if (
        parsed !== null &&
        parsed > 0
      ) {
        return Math.trunc(parsed);
      }
    }

    const explicit =
      clean(row.textContent)
        .match(/#\s*([0-9]+)/);

    return explicit
      ? Number(explicit[1])
      : null;
  }

  function captureNumberFromPayload(
    capture,
    payload
  ) {
    for (
      const record
      of matchingCaptureRecords(
        capture,
        payload
      )
    ) {
      const value =
        directCaptureNumber(record);

      if (value) {
        return value;
      }
    }

    return null;
  }

  async function resolveCaptureNumber(capture) {
    const direct =
      directCaptureNumber(capture);

    if (direct) {
      return direct;
    }

    if (
      capture?._captureRow instanceof Element
    ) {
      const own =
        captureNumberFromRow(
          capture._captureRow
        );

      if (own) {
        return own;
      }
    }

    for (
      const row
      of captureRowsMatching(capture)
    ) {
      const value =
        captureNumberFromRow(row);

      if (value) {
        return value;
      }
    }

    let payload =
      window.__pokeGridCaptureLogPayload;

    let value =
      captureNumberFromPayload(
        capture,
        payload
      );

    if (value) {
      return value;
    }

    try {
      const response = await fetch(
        '/api/game/capture-log?filter=all',
        {
          credentials: 'include',
          cache: 'no-store'
        }
      );

      if (response.ok) {
        payload =
          await response.json();

        window.__pokeGridCaptureLogPayload =
          payload;

        window.__pokeGridCaptureLogPayloadAt =
          Date.now();

        value =
          captureNumberFromPayload(
            capture,
            payload
          );
      }
    } catch {}

    return value || null;
  }

  // ============================================================
  // TIER / QUALITY
  // ============================================================

  function captureRowTier(capture) {
    const targetName =
      canonicalPokemonName(capture.name);

    const targetIv =
      firstNumber(
        capture.iv ??
        capture.meta
      );

    const targetLevel =
      firstNumber(capture.level);

    const rows = [
      ...document.querySelectorAll('.clog-row')
    ];

    for (const row of rows) {
      const rowName =
        canonicalPokemonName(
          row.querySelector('.clog-name')
            ?.textContent ||
          row.textContent
        );

      const sameName =
        ` ${rowName} `.includes(
          ` ${targetName} `
        ) ||
        ` ${targetName} `.includes(
          ` ${rowName} `
        );

      if (
        targetName &&
        rowName &&
        !sameName
      ) {
        continue;
      }

      const meta = clean(
        row.querySelector('.clog-meta')
          ?.textContent ||
        row.textContent
      );

      const rowIv =
        firstNumber(
          meta.match(
            /iv[^0-9]*([0-9]+)/i
          )?.[1]
        );

      const rowLevel =
        firstNumber(
          row.querySelector('.clog-lvl')
            ?.textContent
        );

      if (
        targetIv !== null &&
        rowIv !== null &&
        targetIv !== rowIv
      ) {
        continue;
      }

      if (
        targetLevel !== null &&
        rowLevel !== null &&
        targetLevel !== rowLevel
      ) {
        continue;
      }

      const tier =
        knownTier(meta);

      if (tier) {
        return tier;
      }

      const qualityVal =
        captureRowQuality(row);

      const qualityTier =
        qualityVal !== null
          ? tierFromQuality(qualityVal)
          : '';

      if (qualityTier) {
        return qualityTier;
      }
    }

    return '';
  }

  function extractCaptureQuality(capture) {
    const direct = firstNumber(
      capture.qualityValue ??
      capture.qualityMultiplier ??
      capture.qualityMult ??
      capture.rarityMultiplier ??
      capture.multiplier ??
      capture.quality
    );

    if (direct !== null) {
      return direct;
    }

    const metaMatch =
      clean(capture.meta || '')
        .match(
          /x\s*([0-9]+(?:[.,][0-9]+)?)/i
        );

    if (metaMatch) {
      const val =
        firstNumber(metaMatch[1]);

      if (val !== null) {
        return val;
      }
    }

    return null;
  }

  function captureRecords(payload) {
    const records = [];
    const seen = new WeakSet();

    const visit = (
      value,
      depth = 0
    ) => {
      if (
        !value ||
        typeof value !== 'object' ||
        depth > 7 ||
        seen.has(value)
      ) {
        return;
      }

      seen.add(value);

      if (!Array.isArray(value)) {
        const name = clean(
          value.pokemonName ||
          value.pokeName ||
          value.speciesName ||
          value.displayName ||
          value.pokemon?.name ||
          value.species?.name ||
          value.name
        );

        if (
          name &&
          (
            value.iv != null ||
            value.ivs != null ||
            value.ivTotal != null ||
            value.totalIv != null ||
            value.quality != null ||
            value.qualityValue != null ||
            value.qualityMultiplier != null ||
            value.qualityMult != null ||
            value.rarityMultiplier != null ||
            value.multiplier != null ||
            value.tier ||
            value.rarity
          )
        ) {
          records.push(value);
        }
      }

      Object.values(value)
        .slice(0, 150)
        .forEach(
          (child) =>
            visit(
              child,
              depth + 1
            )
        );
    };

    visit(payload);

    return records;
  }

  function captureRecordTier(
    capture,
    payload
  ) {
    const targetName =
      canonicalPokemonName(capture.name);

    const targetIv =
      firstNumber(
        capture.iv ??
        capture.meta
      );

    const targetLevel =
      firstNumber(capture.level);

    const candidates =
      captureRecords(payload)
        .filter((record) => {
          const name =
            canonicalPokemonName(
              record.pokemonName ||
              record.pokeName ||
              record.speciesName ||
              record.displayName ||
              record.pokemon?.name ||
              record.species?.name ||
              record.name
            );

          const sameName =
            ` ${name} `.includes(
              ` ${targetName} `
            ) ||
            ` ${targetName} `.includes(
              ` ${name} `
            );

          if (
            targetName &&
            name &&
            !sameName
          ) {
            return false;
          }

          const iv =
            firstNumber(
              record.ivTotal ??
              record.totalIv ??
              record.iv
            );

          const level =
            firstNumber(
              record.level ??
              record.pokemon?.level
            );

          if (
            targetIv !== null &&
            iv !== null &&
            targetIv !== iv
          ) {
            return false;
          }

          if (
            targetLevel !== null &&
            level !== null &&
            targetLevel !== level
          ) {
            return false;
          }

          return true;
        });

    for (const record of candidates) {
      const explicit =
        knownTier(
          `${record.qualityName || ''} ${record.rarity || ''} ${record.tier || ''}`
        );

      if (explicit) {
        return explicit;
      }

      const qVal =
        firstNumber(
          record.qualityValue ??
          record.qualityMultiplier ??
          record.qualityMult ??
          record.rarityMultiplier ??
          record.multiplier ??
          record.quality
        );

      const qualityTier =
        qVal !== null
          ? tierFromQuality(qVal)
          : '';

      if (qualityTier) {
        return qualityTier;
      }
    }

    return '';
  }

  async function resolveCaptureTier(capture) {
    const explicit =
      knownTier(
        `${capture.tier || ''} ${capture.quality || ''} ${capture.meta || ''}`
      );

    if (explicit) {
      return explicit;
    }

    const qVal =
      extractCaptureQuality(capture);

    const qualityTier =
      qVal !== null
        ? tierFromQuality(qVal)
        : '';

    if (qualityTier) {
      return qualityTier;
    }

    for (
      let attempt = 0;
      attempt < 8;
      attempt += 1
    ) {
      const rowTier =
        captureRowTier(capture);

      if (rowTier) {
        return rowTier;
      }

      if (attempt < 7) {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 180)
        );
      }
    }

    let payload =
      window.__pokeGridCaptureLogPayload;

    for (
      let attempt = 0;
      attempt < 4;
      attempt += 1
    ) {
      const cachedTier =
        captureRecordTier(
          capture,
          payload
        );

      if (cachedTier) {
        return cachedTier;
      }

      try {
        const response = await fetch(
          '/api/game/capture-log?filter=all',
          {
            credentials: 'include',
            cache: 'no-store'
          }
        );

        if (response.ok) {
          payload =
            await response.json();

          window.__pokeGridCaptureLogPayload =
            payload;

          window.__pokeGridCaptureLogPayloadAt =
            Date.now();

          const apiTier =
            captureRecordTier(
              capture,
              payload
            );

          if (apiTier) {
            return apiTier;
          }
        }
      } catch {}

      if (attempt < 3) {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 350)
        );
      }
    }

    return '';
  }

  function canonicalPokemonName(value) {
    return normalized(value)
      .replace(/[♀♂]/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ============================================================
  // CONFIG / PANEL
  // ============================================================

  function parseRecipients() {
    const rows = [];

    const container =
      panel?.querySelector(
        '#pgtg-recipients-container'
      );

    if (!container) {
      return config.recipientsList
        .filter(
          (r) =>
            /^-?\d{4,25}$/.test(r.chatId)
        );
    }

    container
      .querySelectorAll(
        '.pgtg-recipient-row'
      )
      .forEach((row) => {
        const label = clean(
          row.querySelector(
            '.pgtg-rec-label'
          ).value
        );

        const chatId = clean(
          row.querySelector(
            '.pgtg-rec-id'
          ).value
        );

        if (
          /^-?\d{4,25}$/.test(chatId)
        ) {
          rows.push({
            label: label || chatId,
            chatId
          });
        }
      });

    return rows;
  }

  function hasCredentials() {
    return (
      /^\d+:[A-Za-z0-9_-]{20,}$/
        .test(config.token) &&
      parseRecipients().length > 0
    );
  }

  function setStatus(
    text,
    kind = ''
  ) {
    if (!statusElement) {
      return;
    }

    statusElement.textContent = text;
    statusElement.dataset.kind = kind;
  }

  async function loadConfig(
    updateForm = false
  ) {
    try {
      let rawData = null;

      if (
        typeof GM_getValue !== 'undefined'
      ) {
        rawData =
          await GM_getValue(
            CONFIG_KEY,
            null
          );
      } else if (
        typeof GM !== 'undefined' &&
        GM.getValue
      ) {
        rawData =
          await GM.getValue(
            CONFIG_KEY,
            null
          );
      }

      if (!rawData) {
        const localData =
          localStorage.getItem(
            CONFIG_KEY
          );

        if (localData) {
          try {
            rawData =
              JSON.parse(localData);
          } catch {}
        }
      }

      config =
        normalizeConfig(rawData);

      if (
        updateForm &&
        panel
      ) {
        writeConfigToForm();
      }

      updateButtonState();
      applyUIConfig();
      pollTelegramBotCommands();
    } catch (error) {
      setStatus(
        `No se pudo leer la configuración guardada: ${error.message}`,
        'error'
      );
    }
  }

  function applyUIConfig() {
    const btn =
      document.getElementById(
        'pokegrid-telegram-button'
      );

    if (!btn) {
      return;
    }

    btn.style.display =
      config.ui.hideButton
        ? 'none'
        : 'grid';

    const size =
      config.ui.buttonSize || 38;

    btn.style.width =
      `${size}px`;

    btn.style.height =
      `${size}px`;

    btn.style.top = 'auto';
    btn.style.bottom = 'auto';
    btn.style.left = 'auto';
    btn.style.right = 'auto';

    if (
      config.ui.position ===
      'bottom-right'
    ) {
      btn.style.bottom = '12px';
      btn.style.right = '58px';
    } else if (
      config.ui.position ===
      'bottom-left'
    ) {
      btn.style.bottom = '12px';
      btn.style.left = '12px';
    } else if (
      config.ui.position ===
      'top-right'
    ) {
      btn.style.top = '12px';
      btn.style.right = '12px';
    } else if (
      config.ui.position ===
      'top-left'
    ) {
      btn.style.top = '12px';
      btn.style.left = '12px';
    }
  }

  function renderRecipientsList(list) {
    const container =
      panel.querySelector(
        '#pgtg-recipients-container'
      );

    if (!container) {
      return;
    }

    container.innerHTML = '';

    const items =
      list.length
        ? list
        : [{
            label: '',
            chatId: ''
          }];

    items.forEach((item) => {
      const row =
        document.createElement('div');

      row.className =
        'pgtg-recipient-row';

      row.innerHTML = `
        <input class="pgtg-input pg-rec-label pgtg-rec-label" type="text" placeholder="Nombre / Alias (Ej: Grupo)" value="${escapeHtml(item.label)}">
        <input class="pgtg-input pg-rec-id pgtg-rec-id" type="text" placeholder="Chat ID (Ej: -100...)" value="${escapeHtml(item.chatId)}">
        <button class="pgtg-row-del" type="button" title="Eliminar destinatario">&times;</button>
      `;

      row.querySelector(
        '.pgtg-row-del'
      ).addEventListener(
        'click',
        () => {
          row.remove();

          if (
            !container.querySelectorAll(
              '.pgtg-recipient-row'
            ).length
          ) {
            addRowRecipient();
          }
        }
      );

      container.appendChild(row);
    });
  }

  function addRowRecipient(
    label = '',
    chatId = ''
  ) {
    const container =
      panel.querySelector(
        '#pgtg-recipients-container'
      );

    if (!container) {
      return;
    }

    const row =
      document.createElement('div');

    row.className =
      'pgtg-recipient-row';

    row.innerHTML = `
      <input class="pgtg-input pg-rec-label pgtg-rec-label" type="text" placeholder="Nombre / Alias (Ej: Grupo)" value="${escapeHtml(label)}">
      <input class="pgtg-input pg-rec-id pgtg-rec-id" type="text" placeholder="Chat ID (Ej: -100...)" value="${escapeHtml(chatId)}">
      <button class="pgtg-row-del" type="button" title="Eliminar destinatario">&times;</button>
    `;

    row.querySelector(
      '.pgtg-row-del'
    ).addEventListener(
      'click',
      () => {
        row.remove();

        if (
          !container.querySelectorAll(
            '.pgtg-recipient-row'
          ).length
        ) {
          addRowRecipient();
        }
      }
    );

    container.appendChild(row);
  }

  function isShinyCardItem(item) {
    const name =
      normalized(item?.name);

    const meta =
      normalized(
        `${item?.name || ''} ${item?.type || ''} ${item?.category || ''} ${item?.group || ''}`
      );

    return (
      name.includes('shiny') &&
      (
        name.includes('card') ||
        meta.includes('card')
      )
    );
  }

  async function populateItemsCatalogUI() {
    const listContainer =
      panel.querySelector(
        '#pgtg-items-select-list'
      );

    if (!listContainer) {
      return;
    }

    listContainer.innerHTML =
      '<div style="padding: 10px; color: #668b99; text-align: center; font-size: 10px;">Cargando ítems...</div>';

    let items = [];

    try {
      items = await itemCatalog();
    } catch {}

    if (!items.length) {
      listContainer.innerHTML =
        '<div style="padding: 10px; color: #ff8a9d; text-align: center; font-size: 10px;">No se pudo cargar el catálogo.</div>';

      return;
    }

    items.sort(
      (a, b) =>
        clean(a.name)
          .localeCompare(clean(b.name))
    );

    const renderList = (
      filterText = ''
    ) => {
      listContainer.innerHTML = '';

      const selectedNames =
        listFrom(
          field('dropNames').value
        );

      const query =
        normalized(filterText);

      const filtered =
        items.filter((item) => {
          const name =
            clean(item.name);

          if (!name) {
            return false;
          }

          if (
            query &&
            !normalized(name)
              .includes(query)
          ) {
            return false;
          }

          return true;
        });

      if (!filtered.length) {
        listContainer.innerHTML =
          '<div style="padding: 10px; color: #668b99; text-align: center; font-size: 10px;">No se encontraron ítems.</div>';

        return;
      }

      filtered.forEach((item) => {
        const name =
          clean(item.name);

        const isChecked =
          selectedNames.includes(
            normalized(name)
          );

        const iconUrl =
          clean(
            item.iconUrl ||
            item.icon ||
            item.image
          );

        const resolvedIcon =
          iconUrl
            ? (
                iconUrl.startsWith('http')
                  ? iconUrl
                  : `${GAME_ORIGIN}${iconUrl}`
              )
            : '';

        const row =
          document.createElement('label');

        row.className =
          'pgtg-item-row';

        row.innerHTML = `
          <input
            type="checkbox"
            class="pgtg-item-chk"
            data-item-name="${escapeHtml(name)}"
            ${isChecked ? 'checked' : ''}
          >
          ${
            resolvedIcon
              ? `<img src="${escapeHtml(resolvedIcon)}" class="pgtg-item-icon" crossorigin="anonymous" onerror="this.style.display='none'">`
              : '<span class="pgtg-item-icon-ph">📦</span>'
          }
          <span class="pgtg-item-name">${escapeHtml(name)}</span>
        `;

        row.querySelector(
          '.pgtg-item-chk'
        ).addEventListener(
          'change',
          (e) => {
            const current =
              listFrom(
                field('dropNames').value
              );

            const itemNameNorm =
              normalized(name);

            let updated = [];

            if (e.target.checked) {
              updated = [
                ...new Set([
                  ...current,
                  name
                ])
              ];
            } else {
              updated =
                current.filter(
                  (n) =>
                    n !== itemNameNorm
                );
            }

            field('dropNames').value =
              updated.join(', ');
          }
        );

        listContainer.appendChild(row);
      });
    };

    const searchInput =
      panel.querySelector(
        '#pgtg-items-search'
      );

    const shinyCardsButton =
      panel.querySelector(
        '#pgtg-select-shiny-cards'
      );

    const shinyCards =
      items.filter(isShinyCardItem);

    if (shinyCardsButton) {
      shinyCardsButton.textContent =
        `✨ Seleccionar todas las Shiny Cards (${shinyCards.length})`;

      shinyCardsButton.disabled =
        shinyCards.length === 0;

      shinyCardsButton.onclick =
        () => {
          const selected =
            new Map();

          String(
            field('dropNames').value || ''
          )
            .split(/[\n,;]+/)
            .map(clean)
            .filter(Boolean)
            .forEach((name) =>
              selected.set(
                normalized(name),
                name
              )
            );

          shinyCards.forEach(
            (item) => {
              const name =
                clean(item.name);

              if (name) {
                selected.set(
                  normalized(name),
                  name
                );
              }
            }
          );

          field('dropNames').value =
            [...selected.values()]
              .join(', ');

          renderList(
            searchInput?.value || ''
          );

          setStatus(
            `${shinyCards.length} Shiny Cards seleccionadas en el filtro de drops.`,
            'ok'
          );
        };
    }

    renderList();

    if (searchInput) {
      searchInput.oninput =
        (e) =>
          renderList(e.target.value);
    }
  }

  function updateItemsCatalogCheckboxes() {
    const currentNames =
      listFrom(
        field('dropNames').value
      );

    panel.querySelectorAll(
      '.pgtg-item-chk'
    ).forEach((chk) => {
      const val =
        normalized(
          chk.dataset.itemName
        );

      chk.checked =
        currentNames.includes(val);
    });
  }

  function stockQuantity(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
    }

    const text = clean(value);
    const match =
      text.match(/(?:x|×)\s*([0-9][0-9.,]*)/i) ||
      text.match(/\(([0-9][0-9.,]*)\)/) ||
      text.match(/([0-9][0-9.,]*)\s*(?:disponibles?|available|en stock)/i) ||
      text.match(/([0-9][0-9.,]*)/);

    if (!match) return null;

    const parsed = Number(
      match[1].replace(/[^0-9]/g, '')
    );

    return Number.isFinite(parsed) ? parsed : null;
  }

  function cleanStockName(value) {
    return clean(value)
      .replace(/^(?:seleccionar?|usar|use|choose)\s+/i, '')
      .replace(/\s*[—–-]\s*(?:double[- ]click|doble\s+clic|duplo\s+clique).*$/i, '')
      .replace(/\s*\((?:x|×)?\s*[0-9][0-9.,]*\)\s*$/i, '')
      .replace(/\s*(?:x|×|:)\s*[0-9][0-9.,]*.*$/i, '')
      .replace(/\s*\([0-9][0-9.,]*\)\s*$/i, '')
      .replace(/\s*[-–:]?\s*[0-9][0-9.,]*\s*(?:disponibles?|available|en stock)\s*$/i, '')
      .replace(/\s+-\s+[0-9][0-9.,]*\s*$/i, '')
      .trim();
  }

  function stockAssetInfo(element) {
    const image =
      element?.matches?.('img')
        ? element
        : element?.querySelector?.('img');
    const style = element
      ? getComputedStyle(element)
      : null;
    const background =
      style?.backgroundImage
        ?.match(/url\(["']?([^"')]+)/i)
        ?.[1] || '';
    const icon = clean(
      image?.currentSrc ||
      image?.src ||
      background
    );
    let assetName = '';

    if (icon) {
      try {
        assetName = decodeURIComponent(
          icon.split(/[?#]/)[0]
            .split('/')
            .at(-1)
            .replace(/\.[a-z0-9]+$/i, '')
            .replace(/^(?:icon|item|ball|potion)[-_]+/i, '')
            .replace(/[-_]+/g, ' ')
        );
        assetName = assetName
          .replace(/pok[eé]?ball/ig, 'Poke Ball')
          .replace(/([a-z])ball\b/ig, '$1 Ball')
          .replace(/\b[a-z]/g, (letter) =>
            letter.toUpperCase()
          );
      } catch {}
    }

    return {
      icon,
      assetName: cleanStockName(assetName)
    };
  }

  function stockNameFromElement(
    element,
    iconElement = null
  ) {
    const iconImage =
      iconElement?.querySelector?.('img') ||
      (iconElement?.matches?.('img') ? iconElement : null);
    const candidates = [
      element?.dataset?.ballName,
      element?.dataset?.potionName,
      element?.dataset?.itemName,
      element?.dataset?.name,
      element?.getAttribute?.('title'),
      element?.getAttribute?.('aria-label'),
      iconElement?.dataset?.ballName,
      iconElement?.dataset?.potionName,
      iconElement?.dataset?.itemName,
      iconElement?.getAttribute?.('title'),
      iconElement?.getAttribute?.('aria-label'),
      iconElement?.getAttribute?.('alt'),
      iconImage?.getAttribute?.('alt'),
      iconImage?.getAttribute?.('title'),
      element?.textContent
    ];

    for (const candidate of candidates) {
      const name = cleanStockName(candidate);
      if (name && /[a-záéíóú]/i.test(name)) {
        return name;
      }
    }

    return stockAssetInfo(
      iconElement || element
    ).assetName;
  }

  function stockTypeFromText(value) {
    const text = normalized(value)
      .replace(/[^a-z0-9 ]/g, ' ');

    if (
      /(^| )(?:pokeball|poke ball|ball|balls)( |$)/
        .test(text)
    ) {
      return 'ball';
    }

    if (
      /(^| )(?:potion|potions|pocao|pocoes|pocion|pociones)( |$)/
        .test(text)
    ) {
      return 'potion';
    }

    return '';
  }

  function addBackgroundStockItem(
    target,
    type,
    name,
    quantity,
    icon = ''
  ) {
    const cleanName = cleanStockName(name);
    const cleanQuantity = stockQuantity(quantity);

    if (
      !type ||
      !cleanName ||
      !/[a-z]/i.test(normalized(cleanName)) ||
      cleanQuantity === null
    ) {
      return;
    }

    const map = type === 'ball'
      ? target.balls
      : target.potions;
    const key = normalized(cleanName);
    const previous = map.get(key);

    map.set(key, {
      name: previous?.name || cleanName,
      quantity: cleanQuantity,
      icon: previous?.icon || clean(icon)
    });
  }

  function extractStockFromState(
    value,
    path,
    target,
    seen,
    depth = 0,
    budget = null
  ) {
    if (
      value == null ||
      depth > 8 ||
      budget.count > 20_000
    ) {
      return;
    }

    budget.count += 1;

    if (
      typeof value !== 'object' ||
      value instanceof Node
    ) {
      return;
    }

    if (seen.has(value)) return;
    seen.add(value);

    if (!Array.isArray(value)) {
      const nestedItem =
        value.item ||
        value.ball ||
        value.pokeball ||
        value.pokeBall ||
        value.potion;
      const name = clean(
        value.ballName ||
        value.pokeballName ||
        value.pokeBallName ||
        value.potionName ||
        value.itemName ||
        value.displayName ||
        value.label ||
        value.name ||
        nestedItem?.displayName ||
        nestedItem?.label ||
        nestedItem?.name
      );
      const shopLikePath =
        /shop|market|catalog|listing|offer|price/
          .test(normalized(path));
      const quantity =
        value.inventoryQuantity ??
        value.owned ??
        value.quantity ??
        value.qty ??
        value.count ??
        value.amount ??
        value.available ??
        (
          shopLikePath
            ? undefined
            : value.stock
        ) ??
        value.total;
      const type = stockTypeFromText(
        `${path} ${value.type || ''} ${value.category || ''} ${value.kind || ''} ${name}`
      );

      addBackgroundStockItem(
        target,
        type,
        name,
        quantity,
        value.icon ||
        value.iconUrl ||
        value.image ||
        nestedItem?.icon ||
        nestedItem?.iconUrl ||
        nestedItem?.image
      );
    }

    Object.entries(value)
      .slice(0, 120)
      .forEach(([key, child]) => {
        const childPath = path
          ? `${path}.${key}`
          : key;

        if (
          typeof child === 'number' ||
          typeof child === 'string'
        ) {
          const type = stockTypeFromText(
            `${path} ${key}`
          );
          const reservedKey = /^(?:quantity|qty|count|amount|stock|owned|inventoryquantity|available|total|id|itemid|ballid|potionid|name|label|type|category|kind|price|cost|icon|iconurl|image)$/
            .test(normalized(key).replace(/[^a-z0-9]/g, ''));

          if (type && !reservedKey) {
            addBackgroundStockItem(
              target,
              type,
              key,
              child
            );
          }
          return;
        }

        extractStockFromState(
          child,
          childPath,
          target,
          seen,
          depth + 1,
          budget
        );
      });
  }

  function readBackgroundStock(force = false) {
    if (
      !force &&
      Date.now() - backgroundStockCache.scannedAt < 1_500
    ) {
      return backgroundStockCache;
    }

    const target = {
      balls: new Map(),
      potions: new Map()
    };
    const seen = new WeakSet();
    const budget = { count: 0 };
    const inspect = (value, path) =>
      extractStockFromState(
        value,
        path,
        target,
        seen,
        0,
        budget
      );
    const roots = [
      document.querySelector('.game-root'),
      document.querySelector('#root'),
      document.body
    ].filter(Boolean);

    for (const root of roots) {
      const elements = [
        root,
        ...root.querySelectorAll('*')
      ].slice(0, 1200);

      for (const element of elements) {
        const reactKeys = Object.keys(element)
          .filter((key) =>
            /^__react(?:Fiber|Container|Props)/
              .test(key)
          );

        for (const reactKey of reactKeys) {
          if (reactKey.startsWith('__reactProps')) {
            inspect(
              element[reactKey],
              'react.props'
            );
          }

          let fiber = element[reactKey]?.current ||
            element[reactKey];

          for (
            let level = 0;
            fiber && level < 25;
            level += 1,
            fiber = fiber.return
          ) {
            inspect(
              fiber.memoizedProps,
              'react.memoizedProps'
            );
            inspect(
              fiber.memoizedState,
              'react.memoizedState'
            );
            inspect(
              fiber.dependencies?.firstContext
                ?.context?._currentValue,
              'react.context'
            );
            inspect(
              fiber.dependencies?.firstContext
                ?.context?._currentValue2,
              'react.context2'
            );
          }
        }

        if (budget.count > 20_000) break;
      }

      if (budget.count > 20_000) break;
    }

    if (
      target.balls.size ||
      !backgroundStockCache.balls.size
    ) {
      backgroundStockCache.balls = target.balls;
    }

    if (
      target.potions.size ||
      !backgroundStockCache.potions.size
    ) {
      backgroundStockCache.potions = target.potions;
    }
    backgroundStockCache.scannedAt = Date.now();

    return backgroundStockCache;
  }

  function scheduleBackgroundStockScan() {
    if (
      backgroundStockScanScheduled ||
      Date.now() - backgroundStockCache.scannedAt < 1_500
    ) {
      return;
    }

    backgroundStockScanScheduled = true;

    const run = () => {
      try {
        readBackgroundStock(true);
      } catch (error) {
        console.warn(
          '[PokeGrid Telegram] No se pudo leer el inventario interno; se mantiene la última lectura.',
          error
        );
      } finally {
        backgroundStockScanScheduled = false;
      }

      checkConsumableStock(false);
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 800 });
    } else {
      window.setTimeout(run, 0);
    }
  }

  function inventorySlotData(slot) {
    const namedElement = slot.querySelector(
      '[data-item-name], [data-ball-name], [data-name], .inv-name, .inv-slot-name, .item-name'
    );
    const iconElement = slot.querySelector(
      '.inv-ico, .inv-icon, .inv-slot-icon, .item-icon, img'
    );
    const iconImage =
      iconElement?.matches?.('img')
        ? iconElement
        : iconElement?.querySelector?.('img');
    const candidates = [
      slot.dataset?.itemName,
      slot.dataset?.ballName,
      slot.dataset?.name,
      namedElement?.dataset?.itemName,
      namedElement?.dataset?.ballName,
      namedElement?.dataset?.name,
      namedElement?.getAttribute?.('title'),
      namedElement?.getAttribute?.('aria-label'),
      namedElement?.textContent,
      iconElement?.getAttribute?.('title'),
      iconElement?.getAttribute?.('aria-label'),
      iconElement?.getAttribute?.('alt'),
      iconImage?.getAttribute?.('title'),
      iconImage?.getAttribute?.('alt'),
      slot.getAttribute('title'),
      slot.getAttribute('aria-label')
    ];
    let name = '';

    for (const candidate of candidates) {
      const cleaned = cleanStockName(candidate);

      if (cleaned && /[a-záéíóú]/i.test(cleaned)) {
        name = cleaned;
        break;
      }
    }

    const asset = stockAssetInfo(
      iconElement || slot
    );

    if (!name) {
      name = asset.assetName;
    }

    const quantityElement = slot.querySelector(
      '[data-quantity], [data-qty], [data-count], [data-stock], .inv-qty, .inv-count, .inv-slot-qty, .inv-slot-count, .inv-slot-n, .item-qty, .item-count'
    );
    const quantity = stockQuantity(
      slot.dataset?.quantity ??
      slot.dataset?.qty ??
      slot.dataset?.count ??
      slot.dataset?.stock ??
      quantityElement?.dataset?.quantity ??
      quantityElement?.dataset?.qty ??
      quantityElement?.dataset?.count ??
      quantityElement?.dataset?.stock ??
      quantityElement?.textContent ??
      slot.textContent
    );

    return {
      name: cleanStockName(name),
      quantity,
      icon: asset.icon
    };
  }

  function readBallStock() {
    const result = new Map(
      socketStock.balls
    );

    document.querySelectorAll(
      '.inv-slot.inv-ball'
    ).forEach((slot) => {
      const item = inventorySlotData(slot);

      if (!item.name || item.quantity === null) return;

      result.set(normalized(item.name), item);
    });

    return result;
  }

  function readPotionStock() {
    const result = new Map(
      socketStock.potions
    );

    document.querySelectorAll(
      '.inv-slot.inv-usable'
    ).forEach((slot) => {
      const item = inventorySlotData(slot);

      if (
        !item.name ||
        item.quantity === null ||
        !normalized(item.name).includes('potion')
      ) {
        return;
      }

      result.set(normalized(item.name), item);
    });

    return result;
  }

  function readStockRulesFromForm(
    type,
    includeUnchecked = false
  ) {
    if (!panel) return [];

    return [
      ...panel.querySelectorAll(
        `.pgtg-stock-rule[data-stock-type="${type}"]`
      )
    ]
      .filter((row) =>
        includeUnchecked ||
        row.querySelector('[data-stock-check]')
          ?.checked
      )
      .map((row) => ({
        name: row.dataset.stockName,
        threshold: clampNumber(
          row.querySelector('[data-stock-threshold]')
            ?.value,
          0,
          999999,
          10
        ),
        checked: row.querySelector('[data-stock-check]')
          ?.checked === true
      }))
      .filter((rule) => rule.name);
  }

  function renderStockRuleList(
    type,
    detected,
    configuredRules,
    force = false
  ) {
    const list = panel?.querySelector(
      type === 'ball'
        ? '#pgtg-balls-select-list'
        : '#pgtg-potions-select-list'
    );

    if (!list) return;

    const previousRules = readStockRulesFromForm(
      type,
      true
    );
    const rules = new Map();

    configuredRules.forEach((rule) =>
      rules.set(normalized(rule.name), {
        ...rule,
        checked: true
      })
    );
    previousRules.forEach((rule) =>
      rules.set(normalized(rule.name), rule)
    );

    const candidates = new Map();
    rules.forEach((rule, key) =>
      candidates.set(key, {
        name: rule.name,
        quantity: detected.get(key)?.quantity ?? null,
        icon: detected.get(key)?.icon || ''
      })
    );
    detected.forEach((item, key) =>
      candidates.set(key, item)
    );

    const signature = [...candidates]
      .map(([key]) => key)
      .sort()
      .join('|');

    if (
      !force &&
      list.dataset.signature === signature
    ) {
      list.querySelectorAll('.pgtg-stock-rule')
        .forEach((row) => {
          const item = detected.get(
            normalized(row.dataset.stockName)
          );
          const current = row.querySelector(
            '[data-stock-current]'
          );
          if (current) {
            current.textContent = item
              ? `Actual: ${item.quantity}`
              : 'No detectado';
            current.classList.toggle(
              'is-missing',
              !item
            );
          }
        });
      return;
    }

    list.dataset.signature = signature;
    list.innerHTML = '';

    if (!candidates.size) {
      list.innerHTML =
        `<div class="pgtg-list-message">No se detectaron ${type === 'ball' ? 'Poké Balls' : 'pociones'}.</div>`;
      return;
    }

    [...candidates.values()]
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      .forEach((item) => {
        const key = normalized(item.name);
        const rule = rules.get(key);
        const row = document.createElement('div');
        row.className = 'pgtg-stock-rule';
        row.dataset.stockType = type;
        row.dataset.stockName = item.name;
        row.innerHTML = `
          <input
            type="checkbox"
            data-stock-check
            ${rule?.checked ? 'checked' : ''}
          >
          ${
            item.icon
              ? `<img src="${escapeHtml(item.icon)}" class="pgtg-item-icon" onerror="this.style.display='none'">`
              : `<span class="pgtg-item-icon-ph">${type === 'ball' ? '⚪' : '🧪'}</span>`
          }
          <span class="pgtg-stock-copy">
            <b>${escapeHtml(item.name)}</b>
            <small data-stock-current class="${item.quantity === null ? 'is-missing' : ''}">
              ${item.quantity === null ? 'No detectado' : `Actual: ${item.quantity}`}
            </small>
          </span>
          <label class="pgtg-stock-limit">
            <span>Alertar en</span>
            <input
              type="number"
              min="0"
              max="999999"
              data-stock-threshold
              value="${rule?.threshold ?? 10}"
            >
          </label>
        `;
        list.appendChild(row);
      });
  }

  function filterStockRows(type, query) {
    const normalizedQuery = normalized(query);
    const listId = type === 'ball'
      ? '#pgtg-balls-select-list'
      : '#pgtg-potions-select-list';

    panel?.querySelectorAll(
      `${listId} .pgtg-stock-rule`
    ).forEach((row) => {
      row.hidden = Boolean(
        normalizedQuery &&
        !normalized(row.dataset.stockName)
          .includes(normalizedQuery)
      );
    });
  }

  function setAllStockRules(type, checked) {
    const listId = type === 'ball'
      ? '#pgtg-balls-select-list'
      : '#pgtg-potions-select-list';

    panel?.querySelectorAll(
      `${listId} [data-stock-check]`
    ).forEach((checkbox) => {
      checkbox.checked = checked;
    });
  }

  function refreshStockConfigurationUI(force = false) {
    currentStock.balls = readBallStock();
    currentStock.potions = readPotionStock();

    if (!panel) return;

    renderStockRuleList(
      'ball',
      currentStock.balls,
      config.stock.ballRules,
      force
    );
    renderStockRuleList(
      'potion',
      currentStock.potions,
      config.stock.potionRules,
      force
    );

  }

  async function populateStockBallsCatalogUI() {
    refreshStockConfigurationUI(true);
  }

  function updateStockBallsCatalogCheckboxes() {
    refreshStockConfigurationUI(false);
  }

  async function populatePokemonCatalogUI() {
    const listContainer =
      panel.querySelector(
        '#pgtg-pokemon-select-list'
      );

    if (!listContainer) {
      return;
    }

    listContainer.innerHTML =
      '<div style="padding: 10px; color: #668b99; text-align: center; font-size: 10px;">Cargando Pokémon...</div>';

    let creatures = [];

    try {
      creatures =
        await creatureCatalog();
    } catch {}

    if (!creatures.length) {
      listContainer.innerHTML =
        '<div style="padding: 10px; color: #ff8a9d; text-align: center; font-size: 10px;">No se pudo cargar el catálogo.</div>';

      return;
    }

    creatures.sort(
      (a, b) =>
        clean(a.name)
          .localeCompare(clean(b.name))
    );

    const renderList = (
      filterText = ''
    ) => {
      listContainer.innerHTML = '';

      const selectedNames =
        listFrom(
          field('pokemon').value
        );

      const query =
        normalized(filterText);

      const filtered =
        creatures.filter((c) => {
          const name =
            clean(c.name);

          if (!name) {
            return false;
          }

          if (
            query &&
            !normalized(name)
              .includes(query)
          ) {
            return false;
          }

          return true;
        });

      if (!filtered.length) {
        listContainer.innerHTML =
          '<div style="padding: 10px; color: #668b99; text-align: center; font-size: 10px;">No se encontraron Pokémon.</div>';

        return;
      }

      filtered.forEach((c) => {
        const name =
          clean(c.name);

        const isChecked =
          selectedNames.includes(
            normalized(name)
          );

        const row =
          document.createElement('label');

        row.className =
          'pgtg-item-row';

        row.innerHTML = `
          <input
            type="checkbox"
            class="pgtg-poke-chk"
            data-poke-name="${escapeHtml(name)}"
            ${isChecked ? 'checked' : ''}
          >
          <span class="pgtg-item-icon-ph">🐾</span>
          <span class="pgtg-item-name">${escapeHtml(name)}</span>
        `;

        row.querySelector(
          '.pgtg-poke-chk'
        ).addEventListener(
          'change',
          (e) => {
            const current =
              listFrom(
                field('pokemon').value
              );

            const pokeNameNorm =
              normalized(name);

            let updated = [];

            if (e.target.checked) {
              updated = [
                ...new Set([
                  ...current,
                  name
                ])
              ];
            } else {
              updated =
                current.filter(
                  (n) =>
                    n !== pokeNameNorm
                );
            }

            field('pokemon').value =
              updated.join(', ');

            syncTierAndPokemonUI();
          }
        );

        listContainer.appendChild(row);
      });
    };

    renderList();

    const searchInput =
      panel.querySelector(
        '#pgtg-pokemon-search'
      );

    if (searchInput) {
      searchInput.oninput =
        (e) =>
          renderList(e.target.value);
    }
  }

  function updatePokemonCatalogCheckboxes() {
    const currentNames =
      listFrom(
        field('pokemon').value
      );

    panel.querySelectorAll(
      '.pgtg-poke-chk'
    ).forEach((chk) => {
      const val =
        normalized(
          chk.dataset.pokeName
        );

      chk.checked =
        currentNames.includes(val);
    });
  }

  function syncTierAndPokemonUI() {
    const tiersVal =
      field('tiers').value.trim();

    const pokemonVal =
      field('pokemon').value.trim();

    const configured =
      Number(
        field('minIv').value
      ) > 0 ||
      Number(
        field('minLevel').value
      ) > 0 ||
      Boolean(tiersVal) ||
      Boolean(pokemonVal);

    panel.querySelector(
      '.pgtg-filter-card'
    )?.classList.toggle(
      'is-enabled',
      configured
    );

    field(
      'filteredCaptures'
    ).checked =
      configured ||
      field('filteredCaptures').checked;

    const selectedTiers =
      listFrom(tiersVal);

    panel.querySelectorAll(
      '.pgtg-tier-chip'
    ).forEach((chip) => {
      const tId =
        chip.dataset.tierId;

      chip.classList.toggle(
        'is-active',
        selectedTiers.includes(tId)
      );
    });

    updatePokemonCatalogCheckboxes();
  }

  async function saveConfigFromForm() {
    const recipientsList = [];

    panel.querySelectorAll(
      '.pgtg-recipient-row'
    ).forEach((row) => {
      recipientsList.push({
        label: clean(
          row.querySelector(
            '.pgtg-rec-label'
          ).value
        ),

        chatId: clean(
          row.querySelector(
            '.pgtg-rec-id'
          ).value
        )
      });
    });

    const next =
      normalizeConfig({
        token:
          field('token').value,

        accountName:
          field('accountName').value,

        recipientsList,

        alerts: {
          filteredCaptures:
            field(
              'filteredCaptures'
            ).checked,

          legendaryCaptures:
            field(
              'legendaryCaptures'
            ).checked,

          shinyCaptures:
            field(
              'shinyCaptures'
            ).checked,

          shinyDefeats:
            field(
              'shinyDefeats'
            ).checked,

          drops:
            field('drops').checked
        },

        capture: {
          minIv:
            field('minIv').value,

          minLevel:
            field('minLevel').value,

          tiers:
            field('tiers').value,

          pokemon:
            field('pokemon').value
        },

        drops: {
          names:
            field('dropNames').value,

          minQuantity:
            field(
              'dropMinQuantity'
            ).value
        },

        // === NUEVO: Obteniendo los datos del formulario de stock ===
        stock: {
          enabled: field('stockEnabled').checked,
          ballRules:
            readStockRulesFromForm('ball'),
          potionsEnabled:
            field('potionsStockEnabled').checked,
          potionRules:
            readStockRulesFromForm('potion')
        },

        ui: {
          hideButton:
            field('hideButton').checked,

          buttonSize:
            field('buttonSize').value,

          position:
            field(
              'buttonPosition'
            ).value,

          shortcut:
            field('shortcut').value
        }
      });

    if (
      next.token &&
      !/^\d+:[A-Za-z0-9_-]{20,}$/
        .test(next.token)
    ) {
      setStatus(
        'El token no tiene el formato entregado por BotFather.',
        'error'
      );

      return false;
    }

    if (
      parseRecipients().length === 0 &&
      recipientsList.some(
        (r) => r.chatId
      )
    ) {
      setStatus(
        'Hay Chat IDs inválidos. Deben ser números de entre 4 y 25 dígitos.',
        'error'
      );

      return false;
    }

    try {
      if (
        typeof GM_setValue !==
        'undefined'
      ) {
        await GM_setValue(
          CONFIG_KEY,
          next
        );
      } else if (
        typeof GM !== 'undefined' &&
        GM.setValue
      ) {
        await GM.setValue(
          CONFIG_KEY,
          next
        );
      }

      localStorage.setItem(
        CONFIG_KEY,
        JSON.stringify(next)
      );

      config = next;

      updateButtonState();
      applyUIConfig();

      setStatus(
        'Configuración guardada en el navegador.',
        'ok'
      );

      return true;
    } catch (error) {
      setStatus(
        `No se pudo guardar: ${error.message}`,
        'error'
      );

      return false;
    }
  }

  function field(name) {
    return panel.querySelector(
      `[data-tg-field="${name}"]`
    );
  }

  function writeConfigToForm() {
    field('token').value =
      config.token;

    field('accountName').value =
      config.accountName;

    renderRecipientsList(
      config.recipientsList
    );

    field(
      'filteredCaptures'
    ).checked =
      config.alerts.filteredCaptures;

    field(
      'legendaryCaptures'
    ).checked =
      config.alerts.legendaryCaptures;

    field(
      'shinyCaptures'
    ).checked =
      config.alerts.shinyCaptures;

    field(
      'shinyDefeats'
    ).checked =
      config.alerts.shinyDefeats;

    field('drops').checked =
      config.alerts.drops;

    field('minIv').value =
      String(config.capture.minIv);

    field('minLevel').value =
      String(config.capture.minLevel);

    field('tiers').value =
      config.capture.tiers;

    field('pokemon').value =
      config.capture.pokemon;

    field('dropNames').value =
      config.drops.names;

    field('dropMinQuantity').value =
      String(
        config.drops.minQuantity
      );

    // === NUEVO: Llenando el formulario de stock ===
    field('stockEnabled').checked = 
      config.stock.enabled;

    field('potionsStockEnabled').checked =
      config.stock.potionsEnabled;

    field('hideButton').checked =
      config.ui.hideButton;

    field('buttonSize').value =
      String(config.ui.buttonSize);

    field('buttonPosition').value =
      config.ui.position;

    field('shortcut').value =
      config.ui.shortcut;

    updateItemsCatalogCheckboxes();
    refreshStockConfigurationUI(true);
    syncTierAndPokemonUI();
  }

  function updateButtonState() {
    const button =
      document.querySelector(
        '#pokegrid-telegram-button'
      );

    if (!button) {
      return;
    }

    button.classList.toggle(
      'is-ready',
      hasCredentials()
    );

    button.title =
      hasCredentials()
        ? `Telegram conectado · Atajo: ${config.ui.shortcut}`
        : 'Configurar alertas Telegram';
  }

  function togglePanel() {
    panel.hidden = !panel.hidden;

    if (!panel.hidden) {
      loadConfig(true);

      setStatus(
        hasCredentials()
          ? 'Listo para enviar alertas.'
          : 'Configura el bot y un chat_id.'
      );
    }
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (
        !config.ui.shortcut ||
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA'
      ) {
        if (
          e.target.dataset.tgField !==
          'shortcut'
        ) {
          return;
        }
      }

      const reqCtrl =
        config.ui.shortcut
          .includes('Ctrl');

      const reqAlt =
        config.ui.shortcut
          .includes('Alt');

      const reqShift =
        config.ui.shortcut
          .includes('Shift');

      const reqMeta =
        config.ui.shortcut
          .includes('Meta');

      const reqKey =
        config.ui.shortcut
          .split('+')
          .pop();

      if (
        e.ctrlKey === reqCtrl &&
        e.altKey === reqAlt &&
        e.shiftKey === reqShift &&
        e.metaKey === reqMeta
      ) {
        const keyName =
          e.key.length === 1
            ? e.key.toUpperCase()
            : e.key;

        if (keyName === reqKey) {
          e.preventDefault();
          togglePanel();
        }
      }
    }
  );

  // ============================================================
  // INTERFAZ
  // ============================================================

  function createInterface() {
    if (
      document.querySelector(
        '#pokegrid-telegram-button'
      )
    ) {
      return;
    }

    GM.addStyle(`
      #pokegrid-telegram-button {
        position: fixed;
        right: 58px;
        bottom: 12px;
        z-index: 2147483638;
        width: 38px;
        height: 38px;
        border: 1px solid #377d9e;
        border-radius: 9px;
        background: #102e3d;
        color: #91dfff;
        font: 800 11px/1 system-ui;
        box-shadow: 0 5px 18px #0009;
        cursor: pointer;
        transition: .16s ease;
      }

      #pokegrid-telegram-button:hover {
        background: #176084;
        transform: translateY(-1px);
      }

      #pokegrid-telegram-button:active {
        transform:
          translateY(1px)
          scale(.97);
      }

      #pokegrid-telegram-button.is-ready {
        border-color: #35d99a;
        color: #5cf0b5;
      }

      #pokegrid-telegram-panel {
        position: fixed;
        right: 10px;
        top: 10px;
        z-index: 2147483640;
        width: min(
          560px,
          calc(100vw - 20px)
        );
        max-height:
          calc(100vh - 20px);
        overflow: hidden;
        box-sizing: border-box;
        padding: 0;
        border: 1px solid #266581;
        border-radius: 14px;
        background: #06141e;
        color: #d9edf6;
        box-shadow:
          0 18px 55px #000c;
        font:
          12px/1.35
          system-ui,
          sans-serif;
      }

      #pokegrid-telegram-panel[hidden] {
        display: none !important;
      }

      #pokegrid-telegram-panel * {
        box-sizing: border-box;
      }

      .pgtg-head {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content:
          space-between;
        gap: 8px;
        padding:
          13px 14px 0;
        background: #081d2a;
      }

      .pgtg-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .pgtg-brand-icon {
        width: 34px;
        height: 34px;
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: #168dcc;
      }

      .pgtg-brand-icon svg {
        width: 20px;
        height: 20px;
        fill: #fff;
      }

      .pgtg-head b {
        display: block;
        color: #eef9fd;
        font-size: 15px;
        letter-spacing: .04em;
      }

      .pgtg-head small {
        display: block;
        margin-top: 2px;
        color: #7195a7;
      }

      .pgtg-close {
        flex: 0 0 auto;
        width: 31px;
        height: 31px;
        margin-bottom: 12px;
        border: 1px solid #315466;
        border-radius: 7px;
        background: #102735;
        color: #b8d2dc;
        cursor: pointer;
        font-size: 18px;
      }

      .pgtg-tabs {
        display: flex;
        gap: 4px;
        padding: 12px 14px 0;
        border-bottom:
          1px solid #184158;
        background: #081d2a;
        overflow-x: auto;
        scrollbar-width: thin;
        scrollbar-color:
          #2588b2 #081d2a;
      }

      .pgtg-tab {
        flex: 0 0 auto;
        padding: 8px 9px;
        background: transparent;
        color: #7195a7;
        border: none;
        border-bottom:
          2px solid transparent;
        cursor: pointer;
        font-weight: bold;
        font-size: 11px;
        letter-spacing: .05em;
        transition: .2s;
      }

      .pgtg-tab:hover {
        color: #a4ccdc;
      }

      .pgtg-tab.is-active {
        color: #eef9fd;
        border-bottom-color:
          #35d99a;
      }

      .pgtg-tab-content {
        display: none;
      }

      .pgtg-tab-content.is-active {
        display: block;
      }

      .pgtg-scroll {
        max-height:
          calc(100vh - 156px);
        padding: 12px 14px 4px;
        overflow: auto;
        scrollbar-width: thin;
        scrollbar-color:
          #2588b2 #071925;
      }

      .pgtg-section {
        margin: 0 0 10px;
        padding: 11px;
        border:
          1px solid #17384a;
        border-radius: 10px;
        background: #081b27;
      }

      .pgtg-section > strong {
        display: block;
        margin: 0 0 2px;
        color: #65cfee;
        font-size: 10px;
        letter-spacing: .11em;
        text-transform: uppercase;
      }

      .pgtg-section-intro {
        margin: 0 0 9px;
        color: #668797;
        font-size: 9px;
      }

      .pgtg-step {
        display: inline-grid;
        width: 18px;
        height: 18px;
        margin-right: 6px;
        place-items: center;
        border:
          1px solid #2a789a;
        border-radius: 50%;
        color: #7edcff;
        font-size: 8px;
      }

      .pgtg-label {
        display: block;
        margin: 6px 0 3px;
        color: #8fb7c5;
        font-size: 9px;
        font-weight: 700;
      }

      .pgtg-input,
      .pgtg-textarea,
      select.pgtg-input {
        width: 100%;
        min-height: 36px;
        border:
          1px solid #245068;
        border-radius: 7px;
        outline: none;
        background: #061722;
        color: #eefaff;
        padding: 7px 8px;
        font: 11px system-ui;
      }

      .pgtg-input:focus,
      .pgtg-textarea:focus,
      select.pgtg-input:focus {
        border-color: #42b9e7;
      }

      .pgtg-textarea {
        min-height: 62px;
        resize: vertical;
      }

      .pgtg-grid {
        display: grid;
        grid-template-columns:
          1fr 1fr;
        gap: 7px;
      }

      .pgtg-checks {
        display: grid;
        grid-template-columns:
          repeat(
            2,
            minmax(0, 1fr)
          );
        gap: 7px;
      }

      .pgtg-check {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: 5px;
        min-height: 49px;
        padding: 8px 9px;
        border:
          1px solid #1b4053;
        border-radius: 8px;
        background: #071722;
        color: #c5dce5;
        cursor: pointer;
      }

      .pgtg-check:hover {
        border-color: #2d7593;
        background: #09202e;
      }

      .pgtg-check input {
        margin-top: 2px;
        flex: 0 0 auto;
        accent-color: #2fcf9a;
      }

      .pgtg-check-copy {
        min-width: 0;
        display: block;
      }

      .pgtg-check-copy b {
        display: block;
        color: #d8eaf1;
        font-size: 10px;
      }

      .pgtg-check-copy small {
        display: block;
        margin-top: 2px;
        color: #5f8190;
        font-size: 8px;
        line-height: 1.3;
      }

      .pgtg-help {
        margin: 5px 0 0;
        color: #668b99;
        font-size: 9px;
      }

      .pgtg-market-command-card {
        display: grid;
        grid-template-columns: minmax(105px, auto) minmax(0, 1fr);
        gap: 6px 10px;
        align-items: center;
        padding: 10px;
        border: 1px solid #24556b;
        border-radius: 8px;
        background: #071722;
      }

      .pgtg-market-command-card > b {
        grid-column: 1 / -1;
        color: #6fdcf3;
        font-size: 10px;
      }

      .pgtg-market-command-card code {
        padding: 5px 7px;
        border: 1px solid #2a6e88;
        border-radius: 5px;
        background: #0b2a39;
        color: #7ce7ff;
        font: 800 9px/1.2 Consolas, monospace;
      }

      .pgtg-market-command-card small {
        color: #86a7b5;
        font-size: 8px;
        line-height: 1.35;
      }

      .pgtg-filter-card {
        border-color: #1e5368;
      }

      .pgtg-filter-card.is-enabled {
        border-color: #278c78;
        box-shadow:
          inset 3px 0 0 #35c99a;
      }

      .pgtg-filter-note {
        margin: 8px 0 0;
        padding: 7px 8px;
        border-radius: 6px;
        background: #0b2634;
        color: #79a3b4;
        font-size: 8px;
      }

      .pgtg-token-wrap {
        position: relative;
      }

      .pgtg-token-wrap .pgtg-input {
        padding-right: 68px;
      }

      .pgtg-reveal {
        position: absolute;
        top: 4px;
        right: 4px;
        height: 28px;
        padding: 0 9px;
        border: 0;
        border-radius: 5px;
        background: #12364a;
        color: #8cc9df;
        font:
          800 8px system-ui;
        cursor: pointer;
      }

      .pgtg-recipient-row {
        display: grid;
        grid-template-columns:
          1fr 1.2fr 28px;
        gap: 6px;
        margin-bottom: 6px;
        align-items: center;
      }

      .pgtg-row-del {
        width: 28px;
        height: 36px;
        border:
          1px solid #5a2c34;
        border-radius: 6px;
        background: #331217;
        color: #ff8a9d;
        cursor: pointer;
        font-size: 16px;
        font-weight: bold;
      }

      .pgtg-row-del:hover {
        background: #521c24;
      }

      .pgtg-add-btn {
        width: 100%;
        padding: 7px;
        margin-top: 4px;
        border:
          1px dashed #2d6b88;
        border-radius: 7px;
        background: #0a2230;
        color: #73c9ef;
        font-weight: bold;
        font-size: 10px;
        cursor: pointer;
      }

      .pgtg-add-btn:hover {
        background: #11364a;
      }

      .pgtg-items-box {
        border:
          1px solid #245068;
        border-radius: 8px;
        background: #061722;
        padding: 6px;
        margin-top: 4px;
      }

      .pgtg-items-search {
        margin-bottom: 6px;
      }

      .pgtg-items-tools {
        display: flex;
        gap: 6px;
        margin: 0 0 6px;
      }

      .pgtg-items-tool {
        flex: 1;
        min-height: 30px;
        border:
          1px solid #4d3f86;
        border-radius: 6px;
        background: #171733;
        color: #d7c9ff;
        font:
          800 9px system-ui;
        cursor: pointer;
      }

      .pgtg-items-tool:hover {
        background: #24204d;
        border-color: #7562c6;
      }

      .pgtg-items-tool:disabled {
        opacity: .45;
        cursor: not-allowed;
      }

      .pgtg-items-list {
        max-height: 140px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 3px;
        scrollbar-width: thin;
        scrollbar-color:
          #2588b2 #061722;
      }

      .pgtg-list-message {
        padding: 10px;
        color: #668b99;
        text-align: center;
        font-size: 10px;
      }

      .pgtg-list-message.is-error {
        color: #ff8a9d;
      }

      .pgtg-selection-count {
        margin: 6px 2px 1px;
        color: #79a3b4;
        font-size: 9px;
      }

      .pgtg-stock-rule {
        display: grid;
        grid-template-columns: 18px 18px minmax(0, 1fr) 82px;
        align-items: center;
        gap: 6px;
        padding: 6px;
        border-radius: 6px;
        background: #091e2a;
      }

      .pgtg-stock-rule:hover {
        background: #113244;
      }

      .pgtg-stock-rule > input[type="checkbox"] {
        margin: 0;
        accent-color: #2fcf9a;
      }

      .pgtg-stock-copy {
        min-width: 0;
      }

      .pgtg-stock-copy b,
      .pgtg-stock-copy small {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pgtg-stock-copy b {
        color: #d8eaf1;
        font-size: 10px;
      }

      .pgtg-stock-copy small {
        color: #5ce2ad;
        font-size: 8px;
      }

      .pgtg-stock-copy small.is-missing {
        color: #718c99;
      }

      .pgtg-stock-limit span {
        display: block;
        margin-bottom: 2px;
        color: #7195a7;
        font-size: 7px;
        text-align: center;
      }

      .pgtg-stock-limit input {
        width: 100%;
        height: 27px;
        border: 1px solid #245068;
        border-radius: 5px;
        outline: none;
        background: #061722;
        color: #eefaff;
        padding: 3px 5px;
        font: 10px system-ui;
        text-align: center;
      }

      .pgtg-stock-divider {
        height: 1px;
        margin: 13px 0;
        background: #1b4053;
      }

      .pgtg-item-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 5px;
        background: #091e2a;
        cursor: pointer;
        user-select: none;
      }

      .pgtg-item-row:hover {
        background: #113244;
      }

      .pgtg-item-row input {
        accent-color: #2fcf9a;
        margin: 0;
      }

      .pgtg-item-icon {
        width: 16px;
        height: 16px;
        object-fit: contain;
        flex: 0 0 auto;
      }

      .pgtg-item-icon-ph {
        width: 16px;
        height: 16px;
        display: grid;
        place-items: center;
        font-size: 10px;
        flex: 0 0 auto;
      }

      .pgtg-item-name {
        color: #d8eaf1;
        font-size: 10px;
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .pgtg-tiers-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 4px;
      }

      .pgtg-tier-chip {
        padding: 5px 10px;
        border-radius: 6px;
        border:
          1px solid
          var(
            --tier-color,
            #245068
          );
        background: #061722;
        color:
          var(
            --tier-color,
            #8fb7c5
          );
        font-size: 10px;
        font-weight: bold;
        cursor: pointer;
        user-select: none;
        transition:
          all .15s ease;
        opacity: .5;
      }

      .pgtg-tier-chip:hover {
        opacity: .8;
        transform:
          translateY(-1px);
      }

      .pgtg-tier-chip.is-active {
        background:
          var(
            --tier-color,
            #245068
          );
        color: #061722;
        opacity: 1;
        box-shadow:
          0 0 10px
          var(
            --tier-color,
            #245068
          ) 66;
        font-weight: 900;
      }

      .pgtg-actions {
        position: sticky;
        bottom: 0;
        z-index: 2;
        display: grid;
        grid-template-columns:
          repeat(3, 1fr);
        gap: 7px;
        margin: 0;
        padding: 10px 14px;
        border-top:
          1px solid #184158;
        background: #081d2af5;
      }

      .pgtg-action {
        min-height: 37px;
        border:
          1px solid #2b6e8d;
        border-radius: 8px;
        padding: 8px;
        background: #113b50;
        color: #dff7ff;
        font:
          800 10px system-ui;
        cursor: pointer;
      }

      .pgtg-action:hover {
        background: #185b79;
      }

      .pgtg-action.is-primary {
        border-color: #239c73;
        background: #126247;
        color: #dffff3;
      }

      .pgtg-action:disabled {
        opacity: .5;
        cursor: wait;
      }

      .pgtg-status {
        min-height: 16px;
        margin: 0;
        padding: 8px 14px 10px;
        background: #081d2a;
        color: #86adbb;
        font-size: 9px;
      }

      .pgtg-status[data-kind="ok"] {
        color: #57e9ae;
      }

      .pgtg-status[data-kind="error"] {
        color: #ff8a9d;
      }

      #pokegrid-telegram-button {
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: #168dcc;
      }

      #pokegrid-telegram-button svg {
        width: 50%;
        height: 50%;
        display: block;
        fill: #fff;
      }

      #pokegrid-telegram-button.is-ready {
        border-color: #66e3bc;
        background: #168dcc;
        box-shadow:
          0 0 0 3px #35d99a24,
          0 6px 20px #0009;
      }
    `);

    const button =
      document.createElement('button');

    button.id =
      'pokegrid-telegram-button';

    button.type = 'button';

    button.setAttribute(
      'aria-label',
      'Configurar alertas de Telegram'
    );

    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 2.4 2.9 9.6c-1.28.51-1.27 1.23-.23 1.55l4.8 1.5 1.84 5.75c.23.64.12.9.78.9.51 0 .74-.23 1.02-.5l2.31-2.25 4.8 3.55c.88.49 1.52.24 1.74-.82L23.1 4.45c.32-1.3-.5-1.89-1.5-2.05ZM9.16 12.3l9.38-5.92c.47-.29.9-.14.55.17l-7.74 6.98-.3 3.16-1.89-4.39Z"/></svg>';

    document.documentElement
      .appendChild(button);

    panel =
      document.createElement('section');

    panel.id =
      'pokegrid-telegram-panel';

    panel.hidden = true;

    // === NUEVO: Se agregó el panel de alertas de stock debajo de filtros de drops ===
    panel.innerHTML = `
      <div class="pgtg-head">
        <div class="pgtg-brand">
          <span
            class="pgtg-brand-icon"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24">
              <path d="M21.6 2.4 2.9 9.6c-1.28.51-1.27 1.23-.23 1.55l4.8 1.5 1.84 5.75c.23.64.12.9.78.9.51 0 .74-.23 1.02-.5l2.31-2.25 4.8 3.55c.88.49 1.52.24 1.74-.82L23.1 4.45c.32-1.3-.5-1.89-1.5-2.05ZM9.16 12.3l9.38-5.92c.47-.29.9-.14.55.17l-7.74 6.98-.3 3.16-1.89-4.39Z"/>
            </svg>
          </span>

          <div>
            <b>Telegram Alerts</b>
            <small>
              ${escapeHtml(accountLabel)}
              · configuración persistente
            </small>
          </div>
        </div>

        <button
          class="pgtg-close"
          type="button"
          aria-label="Cerrar"
        >
          &times;
        </button>
      </div>

      <div class="pgtg-tabs">
        <button
          class="pgtg-tab is-active"
          data-target="tab-connection"
        >
          CONEXIÓN DEL BOT
        </button>

        <button
          class="pgtg-tab"
          data-target="tab-market-bot"
        >
          MARKET EN TELEGRAM
        </button>

        <button
          class="pgtg-tab"
          data-target="tab-alerts"
        >
          ALERTAS
        </button>

        <button
          class="pgtg-tab"
          data-target="tab-capture-filters"
        >
          FILTROS DE CAPTURA
        </button>

        <button
          class="pgtg-tab"
          data-target="tab-drop-filters"
        >
          FILTROS DE DROPS
        </button>

        <button
          class="pgtg-tab"
          data-target="tab-stock"
        >
          ALERTAS DE STOCK
        </button>

        <button
          class="pgtg-tab"
          data-target="tab-ui"
        >
          INTERFAZ
        </button>
      </div>

      <div class="pgtg-scroll">

        <div
          id="tab-connection"
          class="pgtg-tab-content is-active"
        >
          <div class="pgtg-section">
            <strong>
              <span class="pgtg-step">1</span>
              Conexión del bot
            </strong>

            <p class="pgtg-section-intro">
              Conecta el bot creado en BotFather y elige dónde recibirás las alertas.
            </p>

            <label class="pgtg-label">
              TOKEN DE BOTFATHER
            </label>

            <div class="pgtg-token-wrap">
              <input
                class="pgtg-input"
                data-tg-field="token"
                type="password"
                autocomplete="off"
                placeholder="123456789:AA..."
              >

              <button
                class="pgtg-reveal"
                data-tg-action="reveal"
                type="button"
              >
                MOSTRAR
              </button>
            </div>

            <label class="pgtg-label">
              NOMBRE DE LA CUENTA / JUGADOR
            </label>

            <input
              class="pgtg-input"
              data-tg-field="accountName"
              placeholder="Ej: Diego Andres"
            >

            <label
              class="pgtg-label"
              style="margin-top: 10px;"
            >
              DESTINATARIOS (NOMBRE Y CHAT ID)
            </label>

            <div
              id="pgtg-recipients-container"
            ></div>

            <button
              class="pgtg-add-btn"
              id="pgtg-add-recipient"
              type="button"
            >
              + Añadir otro destinatario
            </button>

            <p class="pgtg-help">
              Usa "Detectar chats" abajo si interactuaste con el bot recientemente.
            </p>
          </div>

        </div>

        <div
          id="tab-market-bot"
          class="pgtg-tab-content"
        >
          <div class="pgtg-section">
            <strong>
              <span class="pgtg-step">M</span>
              Consultas del Market desde Telegram
            </strong>

            <p class="pgtg-section-intro">
              El bot consulta el Market únicamente cuando envías un comando o pulsas un botón. No necesitas abrir el Mercado Global y no se mantienen lecturas periódicas de precios.
            </p>

            <div class="pgtg-market-command-card">
              <b>🤖 Comandos disponibles</b>
              <code>/market</code>
              <small>Abre el menú interactivo con búsqueda y categorías.</small>
              <code>/precio Water Stone</code>
              <small>Consulta directamente un objeto por su nombre.</small>
              <code>/favoritos</code>
              <small>Abre tus objetos guardados para consultarlos con un toque.</small>
              <code>/ayuda</code>
              <small>Muestra nuevamente las funciones disponibles.</small>
            </div>

            <p class="pgtg-help">
              Por seguridad, el bot solo responde a los Chat ID guardados como destinatarios. La instancia principal del launcher procesa los comandos para evitar respuestas duplicadas.
            </p>
          </div>
        </div>

        <div
          id="tab-alerts"
          class="pgtg-tab-content"
        >

          <div class="pgtg-section">
            <strong>
              <span class="pgtg-step">2</span>
              Alertas que deseas recibir
            </strong>

            <p class="pgtg-section-intro">
              Activa solo los eventos importantes para evitar mensajes innecesarios.
            </p>

            <div class="pgtg-checks">

              <label class="pgtg-check">
                <input
                  data-tg-field="filteredCaptures"
                  type="checkbox"
                >

                <span class="pgtg-check-copy">
                  <b>Capturas con filtro</b>
                  <small>
                    Solo Pokémon que cumplan todos los valores del paso 3.
                  </small>
                </span>
              </label>

              <label class="pgtg-check">
                <input
                  data-tg-field="legendaryCaptures"
                  type="checkbox"
                >

                <span class="pgtg-check-copy">
                  <b>Legendarios</b>
                  <small>
                    Capturas con quality de 1.7 a 2.0 (Legendario).
                  </small>
                </span>
              </label>

              <label class="pgtg-check">
                <input
                  data-tg-field="shinyCaptures"
                  type="checkbox"
                >

                <span class="pgtg-check-copy">
                  <b>Shiny capturados</b>
                  <small>
                    Cuando una captura shiny tiene éxito.
                  </small>
                </span>
              </label>

              <label class="pgtg-check">
                <input
                  data-tg-field="shinyDefeats"
                  type="checkbox"
                >

                <span class="pgtg-check-copy">
                  <b>Shiny derrotados</b>
                  <small>
                    Cuando un shiny es derrotado sin capturarlo.
                  </small>
                </span>
              </label>

              <label class="pgtg-check">
                <input
                  data-tg-field="drops"
                  type="checkbox"
                >

                <span class="pgtg-check-copy">
                  <b>Drops obtenidos</b>
                  <small>
                    Objetos que cumplan el filtro de drops.
                  </small>
                </span>
              </label>

            </div>
          </div>

        </div>

        <div
          id="tab-capture-filters"
          class="pgtg-tab-content"
        >

          <div
            class="pgtg-section pgtg-filter-card"
          >
            <strong>
              <span class="pgtg-step">3</span>
              Filtros de captura
            </strong>

            <p class="pgtg-section-intro">
              Los límites son inclusivos: IV 150 también acepta una captura con IV exactamente 150.
            </p>

            <div class="pgtg-grid">
              <div>
                <label class="pgtg-label">
                  IV TOTAL MÍNIMO
                </label>

                <input
                  class="pgtg-input"
                  data-tg-field="minIv"
                  type="number"
                  min="0"
                  max="192"
                >
              </div>

              <div>
                <label class="pgtg-label">
                  NIVEL MÍNIMO
                </label>

                <input
                  class="pgtg-input"
                  data-tg-field="minLevel"
                  type="number"
                  min="0"
                  max="9999"
                >
              </div>
            </div>

            <label
              class="pgtg-label"
              style="margin-top: 8px;"
            >
              TIERS PERMITIDOS (HAZ CLIC PARA ACTIVAR)
            </label>

            <div
              class="pgtg-tiers-chips"
              id="pgtg-tiers-container"
            >
              ${AVAILABLE_TIERS.map(
                (t) => `
                  <div
                    class="pgtg-tier-chip"
                    data-tier-id="${t.id}"
                    style="--tier-color: ${t.color};"
                  >
                    ${t.label}
                  </div>
                `
              ).join('')}
            </div>

            <input
              type="hidden"
              data-tg-field="tiers"
            >

            <label
              class="pgtg-label"
              style="margin-top: 10px;"
            >
              POKÉMON PERMITIDOS (CATÁLOGO)
            </label>

            <div class="pgtg-items-box">
              <input
                class="pgtg-input pgtg-items-search"
                id="pgtg-pokemon-search"
                type="text"
                placeholder="🔍 Buscar Pokémon..."
              >

              <div
                class="pgtg-items-list"
                id="pgtg-pokemon-select-list"
              ></div>
            </div>

            <input
              type="hidden"
              data-tg-field="pokemon"
            >

            <p class="pgtg-filter-note">
              Se deben cumplir todos los campos configurados. Deja un campo vacío o en 0 para no limitarlo.
            </p>
          </div>

        </div>

        <div
          id="tab-drop-filters"
          class="pgtg-tab-content"
        >

          <div class="pgtg-section">
            <strong>
              <span class="pgtg-step">4</span>
              Filtros de drops
            </strong>

            <p class="pgtg-section-intro">
              Selecciona ítems del catálogo oficial del juego o escríbelos abajo.
            </p>

            <label class="pgtg-label">
              CATÁLOGO DE ÍTEMS DE POKE IDLE WORLD
            </label>

            <div class="pgtg-items-box">
              <input
                class="pgtg-input pgtg-items-search"
                id="pgtg-items-search"
                type="text"
                placeholder="🔍 Buscar ítem en el juego..."
              >

              <div class="pgtg-items-tools">
                <button
                  class="pgtg-items-tool"
                  id="pgtg-select-shiny-cards"
                  type="button"
                >
                  ✨ Seleccionar todas las Shiny Cards
                </button>
              </div>

              <div
                class="pgtg-items-list"
                id="pgtg-items-select-list"
              ></div>
            </div>

            <label
              class="pgtg-label"
              style="margin-top: 8px;"
            >
              OBJETOS SELECCIONADOS (TEXTO)
            </label>

            <input
              class="pgtg-input"
              data-tg-field="dropNames"
              placeholder="Leaves, Seed, Stone"
            >

            <div style="margin-top: 6px;">
              <label class="pgtg-label">
                CANTIDAD MÍNIMA
              </label>

              <input
                class="pgtg-input"
                data-tg-field="dropMinQuantity"
                type="number"
                min="1"
              >
            </div>
          </div>

        </div>

        <div
          id="tab-stock"
          class="pgtg-tab-content"
        >

          <div class="pgtg-section">
            <strong>
              <span class="pgtg-step">5</span>
              Alertas de Stock
            </strong>

            <p class="pgtg-section-intro">
              Las cantidades se leen continuamente desde la mochila del jugador, sin depender de Auto Helper. Activa cada objeto y asigna su propio límite.
            </p>

            <label class="pgtg-check" style="margin-bottom: 8px;">
              <input data-tg-field="stockEnabled" type="checkbox">
              <span class="pgtg-check-copy">
                <b>Alertas de Poké Balls</b>
                <small>Lee nombre, icono y cantidad desde <code>.inv-slot.inv-ball</code>.</small>
              </span>
            </label>

            <label class="pgtg-label">POKÉ BALLS A MONITOREAR</label>

            <div class="pgtg-items-box">
              <div class="pgtg-items-tools">
                <button
                  class="pgtg-items-tool"
                  id="pgtg-select-all-balls"
                  type="button"
                >
                  SELECCIONAR TODAS
                </button>

                <button
                  class="pgtg-items-tool"
                  id="pgtg-clear-balls"
                  type="button"
                >
                  LIMPIAR SELECCIÓN
                </button>
              </div>

              <div
                class="pgtg-items-list"
                id="pgtg-balls-select-list"
              ></div>
            </div>

            <div class="pgtg-stock-divider"></div>

            <label class="pgtg-check" style="margin-bottom: 8px;">
              <input data-tg-field="potionsStockEnabled" type="checkbox">
              <span class="pgtg-check-copy">
                <b>Alertas de pociones</b>
                <small>Lee los objetos <code>.inv-slot.inv-usable</code> cuyo nombre contiene “Potion”.</small>
              </span>
            </label>

            <label class="pgtg-label">POCIONES A MONITOREAR</label>

            <div class="pgtg-items-box">
              <div class="pgtg-items-tools">
                <button
                  class="pgtg-items-tool"
                  id="pgtg-select-all-potions"
                  type="button"
                >
                  SELECCIONAR TODAS
                </button>

                <button
                  class="pgtg-items-tool"
                  id="pgtg-clear-potions"
                  type="button"
                >
                  LIMPIAR SELECCIÓN
                </button>
              </div>

              <div
                class="pgtg-items-list"
                id="pgtg-potions-select-list"
              ></div>
            </div>
          </div>

        </div>

        <div
          id="tab-ui"
          class="pgtg-tab-content"
        >
          <div class="pgtg-section">
            <strong>
              OPCIONES DEL PANEL
            </strong>

            <p class="pgtg-section-intro">
              Personaliza la forma de acceder al menú del bot en la pantalla.
            </p>

            <label
              class="pgtg-check"
              style="margin-bottom: 8px;"
            >
              <input
                data-tg-field="hideButton"
                type="checkbox"
              >

              <span class="pgtg-check-copy">
                <b>
                  Ocultar botón flotante
                </b>

                <small>
                  El botón redondo no será visible. Puedes usar el atajo de teclado para abrir el panel.
                </small>
              </span>
            </label>

            <div class="pgtg-grid">
              <div>
                <label class="pgtg-label">
                  TAMAÑO (PX)
                </label>

                <input
                  class="pgtg-input"
                  data-tg-field="buttonSize"
                  type="number"
                  min="20"
                  max="100"
                  placeholder="38"
                >
              </div>

              <div>
                <label class="pgtg-label">
                  POSICIÓN
                </label>

                <select
                  class="pgtg-input"
                  data-tg-field="buttonPosition"
                  style="padding: 6px;"
                >
                  <option value="bottom-right">
                    Abajo Derecha
                  </option>

                  <option value="bottom-left">
                    Abajo Izquierda
                  </option>

                  <option value="top-right">
                    Arriba Derecha
                  </option>

                  <option value="top-left">
                    Arriba Izquierda
                  </option>
                </select>
              </div>
            </div>

            <div style="margin-top: 10px;">
              <label class="pgtg-label">
                ATAJO DE TECLADO
              </label>

              <input
                class="pgtg-input"
                data-tg-field="shortcut"
                placeholder="Ej: Alt+T"
                readonly
                style="cursor: pointer;"
                title="Haz clic y presiona las teclas"
              >

              <p class="pgtg-help">
                Haz clic en este recuadro y presiona la combinación de teclas que quieres usar para abrir este panel de forma rápida.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="pgtg-actions">
        <button
          class="pgtg-action is-primary"
          data-tg-action="save"
          type="button"
        >
          ✓ GUARDAR
        </button>

        <button
          class="pgtg-action"
          data-tg-action="chats"
          type="button"
        >
          ⌕ DETECTAR CHATS
        </button>

        <button
          class="pgtg-action"
          data-tg-action="test"
          type="button"
        >
          ▷ PROBAR BOT
        </button>
      </div>

      <p
        class="pgtg-status"
        role="status"
      ></p>
    `;

    document.documentElement
      .appendChild(panel);

    statusElement =
      panel.querySelector(
        '.pgtg-status'
      );

    // El botón debe funcionar aunque falle un catálogo o lector secundario.
    button.addEventListener(
      'click',
      togglePanel
    );

    try {
      writeConfigToForm();
    } catch (error) {
      console.error(
        '[PokeGrid Telegram] No se pudo rellenar el formulario completo.',
        error
      );
      setStatus(
        'El panel abrió, pero una sección no pudo cargarse. Revisa la consola.',
        'error'
      );
    }
    updateButtonState();
    populateItemsCatalogUI();
    populateStockBallsCatalogUI();
    populatePokemonCatalogUI();

    panel.querySelector(
      '#pgtg-add-recipient'
    ).addEventListener(
      'click',
      () => addRowRecipient()
    );

    panel.querySelectorAll(
      '.pgtg-tier-chip'
    ).forEach((chip) => {
      chip.addEventListener(
        'click',
        () => {
          chip.classList.toggle(
            'is-active'
          );

          const activeTiers = [];

          panel.querySelectorAll(
            '.pgtg-tier-chip.is-active'
          ).forEach(
            (c) =>
              activeTiers.push(
                c.dataset.tierId
              )
          );

          field('tiers').value =
            activeTiers.join(', ');

          syncTierAndPokemonUI();
        }
      );
    });

    field('dropNames')
      .addEventListener(
        'input',
        updateItemsCatalogCheckboxes
      );

    panel.querySelector('#pgtg-select-all-balls')
      .addEventListener(
        'click',
        () => setAllStockRules('ball', true)
      );

    panel.querySelector('#pgtg-clear-balls')
      .addEventListener(
        'click',
        () => setAllStockRules('ball', false)
      );

    panel.querySelector('#pgtg-select-all-potions')
      .addEventListener(
        'click',
        () => setAllStockRules('potion', true)
      );

    panel.querySelector('#pgtg-clear-potions')
      .addEventListener(
        'click',
        () => setAllStockRules('potion', false)
      );

    field('pokemon')
      .addEventListener(
        'input',
        updatePokemonCatalogCheckboxes
      );

    panel.querySelectorAll(
      '.pgtg-tab'
    ).forEach((tab) => {
      tab.addEventListener(
        'click',
        (e) => {
          panel.querySelectorAll(
            '.pgtg-tab'
          ).forEach(
            (t) =>
              t.classList.remove(
                'is-active'
              )
          );

          panel.querySelectorAll(
            '.pgtg-tab-content'
          ).forEach(
            (c) =>
              c.classList.remove(
                'is-active'
              )
          );

          e.currentTarget.classList.add(
            'is-active'
          );

          const targetId =
            e.currentTarget.dataset.target;

          panel.querySelector(
            `#${targetId}`
          ).classList.add(
            'is-active'
          );

          if (targetId === 'tab-stock') {
            populateStockBallsCatalogUI();
          }
        }
      );
    });

    panel.querySelector(
      '.pgtg-close'
    ).addEventListener(
      'click',
      () => {
        panel.hidden = true;
      }
    );

    panel.querySelector(
      '[data-tg-action="save"]'
    ).addEventListener(
      'click',
      saveConfigFromForm
    );

    panel.querySelector(
      '[data-tg-action="chats"]'
    ).addEventListener(
      'click',
      discoverChatsFromPanel
    );

    panel.querySelector(
      '[data-tg-action="test"]'
    ).addEventListener(
      'click',
      testBotFromPanel
    );

    panel.querySelector(
      '[data-tg-action="reveal"]'
    ).addEventListener(
      'click',
      (event) => {
        const token =
          field('token');

        const visible =
          token.type === 'text';

        token.type =
          visible
            ? 'password'
            : 'text';

        event.currentTarget.textContent =
          visible
            ? 'MOSTRAR'
            : 'OCULTAR';
      }
    );

    field('shortcut')
      .addEventListener(
        'keydown',
        (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (
            e.key === 'Shift' ||
            e.key === 'Control' ||
            e.key === 'Alt' ||
            e.key === 'Meta'
          ) {
            return;
          }

          let keys = [];

          if (e.ctrlKey) {
            keys.push('Ctrl');
          }

          if (e.altKey) {
            keys.push('Alt');
          }

          if (e.shiftKey) {
            keys.push('Shift');
          }

          if (e.metaKey) {
            keys.push('Meta');
          }

          const keyName =
            e.key.length === 1
              ? e.key.toUpperCase()
              : e.key;

          keys.push(keyName);

          field('shortcut').value =
            keys.join('+');
        }
      );

    [
      'minIv',
      'minLevel',
      'tiers',
      'pokemon'
    ].forEach((name) => {
      field(name)
        .addEventListener(
          'input',
          syncTierAndPokemonUI
        );
    });

    syncTierAndPokemonUI();
    applyUIConfig();
  }

  // ============================================================
  // TELEGRAM
  // ============================================================

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function requestJson(
    url,
    payload = null
  ) {
    const response =
      await GM.xmlHttpRequest({
        method:
          payload === null
            ? 'GET'
            : 'POST',

        url,

        headers:
          payload === null
            ? {}
            : {
                'content-type':
                  'application/json'
              },

        data:
          payload === null
            ? undefined
            : JSON.stringify(payload)
      });

    let body = null;

    try {
      body =
        JSON.parse(
          response.responseText ||
          '{}'
        );
    } catch {}

    if (
      response.status < 200 ||
      response.status >= 300 ||
      body?.ok === false
    ) {
      throw new Error(
        body?.description ||
        `HTTP ${response.status}`
      );
    }

    return body;
  }

  async function requestMultipart(
    url,
    fields
  ) {
    const response =
      await GM.xmlHttpRequest({
        method: 'POST',
        url,
        multipart: fields
      });

    let body = null;

    try {
      body =
        JSON.parse(
          response.responseText ||
          '{}'
        );
    } catch {}

    if (
      response.status < 200 ||
      response.status >= 300 ||
      body?.ok === false
    ) {
      throw new Error(
        body?.description ||
        `HTTP ${response.status}`
      );
    }

    return body;
  }

  function getAccountName() {
    const custom =
      clean(config.accountName);

    if (custom) {
      return custom;
    }

    return accountLabel;
  }

  async function testBotFromPanel() {
    const testButton =
      panel.querySelector(
        '[data-tg-action="test"]'
      );

    testButton.disabled = true;

    try {
      if (
        !(await saveConfigFromForm()) ||
        !hasCredentials()
      ) {
        if (!hasCredentials()) {
          setStatus(
            'Guarda un token y al menos un chat_id válido antes de probar.',
            'error'
          );
        }

        return;
      }

      setStatus(
        'Verificando bot y enviando prueba…'
      );

      const identity =
        await requestJson(
          `https://api.telegram.org/bot${config.token}/getMe`
        );

      const image =
        await resolvePokemonImage(
          'Pikachu',
          false,
          25
        );

      const accountName =
        getAccountName();

      await deliver({
        photo: image,

        caption: [
          '✅ <b>PokeGrid conectado</b>',

          `🤖 Bot: <b>${escapeHtml(
            identity?.result?.username ||
            identity?.result?.first_name ||
            'Telegram'
          )}</b>`,

          `👤 Cuenta: <b>${escapeHtml(
            accountName
          )}</b>`,

          'Las alertas visuales están listas.'
        ].join('\n')
      });

      setStatus(
        'Prueba enviada correctamente a todos los destinatarios.',
        'ok'
      );
    } catch (error) {
      setStatus(
        `Telegram rechazó la prueba: ${error.message}`,
        'error'
      );
    } finally {
      testButton.disabled = false;
    }
  }

  async function discoverChatsFromPanel() {
    const button =
      panel.querySelector(
        '[data-tg-action="chats"]'
      );

    const token =
      field('token').value.trim();

    if (
      !/^\d+:[A-Za-z0-9_-]{20,}$/
        .test(token)
    ) {
      setStatus(
        'Pega primero el token entregado por BotFather.',
        'error'
      );

      return;
    }

    button.disabled = true;

    try {
      setStatus(
        'Buscando conversaciones recientes del bot…'
      );

      const updates =
        await requestJson(
          `https://api.telegram.org/bot${token}/getUpdates`
        );

      const chats =
        new Map();

      for (
        const update
        of updates?.result || []
      ) {
        const candidates = [
          update.message?.chat,
          update.edited_message?.chat,
          update.channel_post?.chat,
          update.edited_channel_post?.chat,
          update.my_chat_member?.chat,
          update.chat_member?.chat
        ].filter(Boolean);

        for (
          const chat
          of candidates
        ) {
          const id =
            String(chat.id ?? '');

          if (
            !/^-?\d{4,25}$/.test(id)
          ) {
            continue;
          }

          const label = clean(
            chat.title ||
            (
              chat.username &&
              `@${chat.username}`
            ) ||
            [
              chat.first_name,
              chat.last_name
            ]
              .filter(Boolean)
              .join(' ') ||
            `${chat.type || 'Chat'} ${id}`
          );

          chats.set(id, {
            label:
              label || id,
            chatId: id
          });
        }
      }

      if (!chats.size) {
        setStatus(
          'No hay chats recientes. Envía /start al bot y vuelve a detectar.',
          'error'
        );

        return;
      }

      renderRecipientsList(
        [...chats.values()]
      );

      setStatus(
        `${chats.size} chat(s) detectado(s) y rellenados. Guarda para mantener la configuración.`,
        'ok'
      );
    } catch (error) {
      setStatus(
        `No se pudieron detectar chats: ${error.message}`,
        'error'
      );
    } finally {
      button.disabled = false;
    }
  }

  // ============================================================
  // IMÁGENES DEL JUEGO
  // ============================================================

  function basePokemonName(name) {
    let value =
      normalized(name)
        .replace(/['’.:]/g, '')
        .replace(/[♀♂]/g, ' ')
        .replace(
          /[^a-z0-9 -]/g,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim();

    const prefixes = [
      'shiny',
      'brave',
      'furious',
      'ancient',
      'taekwondo',
      'tribal',
      'war',
      'enigmatic',
      'charged',
      'magnetic',
      'evil',
      'freezing',
      'psy',
      'heavy',
      'milch',
      'roll',
      'hard',
      'brute',
      'enraged',
      'dark',
      'trickmaster',
      'banshee'
    ];

    let changed = true;

    while (changed) {
      changed = false;

      for (const prefix of prefixes) {
        if (
          value.startsWith(
            `${prefix} `
          )
        ) {
          value =
            value.slice(
              prefix.length + 1
            ).trim();

          changed = true;
        }
      }
    }

    return value
      .replace(
        /\s+\d+(?:\s*(?:a|o|st|nd|rd|th))?.*$/i,
        ''
      )
      .trim();
  }

  async function creatureCatalog() {
    if (!creatureCatalogPromise) {
      creatureCatalogPromise =
        requestJson(
          `${GAME_ORIGIN}/game/creatures.json`
        )
          .then(
            (body) =>
              Array.isArray(
                body?.creatures
              )
                ? body.creatures
                : []
          )
          .catch(() => []);
    }

    return creatureCatalogPromise;
  }

  async function resolveLooktype(
    name,
    speciesId = null,
    explicitLooktype = null
  ) {
    const direct =
      Number(explicitLooktype);

    if (
      Number.isInteger(direct) &&
      direct > 0
    ) {
      return direct;
    }

    const id =
      Number(speciesId);

    const exactName =
      normalized(name);

    const baseName =
      basePokemonName(name);

    const cacheKey =
      `${Number.isFinite(id) ? id : ''}:${exactName}`;

    if (
      looktypeCache.has(cacheKey)
    ) {
      return looktypeCache.get(
        cacheKey
      );
    }

    const rows =
      await creatureCatalog();

    const match =
      rows.find(
        (row) =>
          normalized(row.name) ===
          exactName
      ) ||
      (
        Number.isFinite(id) &&
        id > 0
          ? rows.find(
              (row) =>
                Number(row.pokeId) ===
                id
            )
          : null
      ) ||
      rows.find(
        (row) =>
          normalized(row.name) ===
          baseName
      );

    const looktype =
      Math.max(
        0,
        Number(match?.looktype) || 0
      );

    looktypeCache.set(
      cacheKey,
      looktype
    );

    return looktype;
  }

  async function outfitIndex() {
    if (!outfitIndexPromise) {
      outfitIndexPromise =
        requestJson(
          `${GAME_ASSET_ROOT}/outfits-index.json?v=2`
        )
          .then(
            (body) =>
              body?.outfits || {}
          )
          .catch(() => ({}));
    }

    return outfitIndexPromise;
  }

  function loadImage(url) {
    return new Promise(
      (resolve, reject) => {
        const image =
          new Image();

        image.crossOrigin =
          'anonymous';

        image.onload =
          () => resolve(image);

        image.onerror =
          () =>
            reject(
              new Error(
                'No se pudo cargar el atlas del juego.'
              )
            );

        image.src = url;
      }
    );
  }

  async function renderGamePokemonSprite(
    looktype
  ) {
    if (
      typeof window.__pokeGridTelegramRenderPokemonSprite ===
      'function'
    ) {
      return window
        .__pokeGridTelegramRenderPokemonSprite(
          looktype
        );
    }

    const index =
      await outfitIndex();

    const outfit =
      index[String(looktype)];

    if (!outfit?.manifest) {
      return '';
    }

    const manifestUrl =
      new URL(
        String(outfit.manifest)
          .replace(
            /^\/assets-packs/,
            '/game/asset-packs'
          ),
        GAME_ORIGIN
      ).href;

    const manifest =
      await requestJson(
        manifestUrl
      );

    const category =
      manifest?.categories?.[
        outfit.category
      ] ||
      Object.values(
        manifest?.categories || {}
      )[0];

    const assetEntries =
      Object.entries(
        manifest?.assets || {}
      );

    const selected =
      assetEntries.find(
        ([path]) =>
          /\/1_1_1_3\.png$/i
            .test(path)
      ) ||
      assetEntries[0];

    const frame =
      selected?.[1]
        ?.frames?.[0];

    const page =
      category?.pages?.find(
        (candidate) =>
          Number(candidate.index) ===
          Number(frame?.page)
      ) ||
      category?.pages?.[0];

    if (
      !frame ||
      !page?.image
    ) {
      return '';
    }

    const atlasUrl =
      new URL(
        String(page.image)
          .replace(
            /^\/assets-packs/,
            '/game/asset-packs'
          ),
        GAME_ORIGIN
      ).href;

    const atlas =
      await loadImage(atlasUrl);

    const canvas =
      document.createElement(
        'canvas'
      );

    canvas.width = 256;
    canvas.height = 256;

    const context =
      canvas.getContext('2d');

    context.imageSmoothingEnabled =
      false;

    const scale =
      Math.min(
        224 / frame.w,
        224 / frame.h
      );

    const width =
      Math.max(
        1,
        Math.round(
          frame.w * scale
        )
      );

    const height =
      Math.max(
        1,
        Math.round(
          frame.h * scale
        )
      );

    context.drawImage(
      atlas,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      Math.round(
        (256 - width) / 2
      ),
      Math.round(
        (256 - height) / 2
      ),
      width,
      height
    );

    const dataUrl =
      canvas.toDataURL(
        'image/png'
      );

    return {
      base64:
        dataUrl.slice(
          dataUrl.indexOf(',') + 1
        ),

      mimeType:
        'image/png',

      filename:
        `pokegrid-${looktype}.png`
    };
  }

  async function resolvePokemonImage(
    name,
    _shiny = false,
    speciesId = null,
    explicitLooktype = null
  ) {
    const looktype =
      await resolveLooktype(
        name,
        speciesId,
        explicitLooktype
      );

    if (!looktype) {
      return '';
    }

    const cacheKey =
      `game:${looktype}`;

    if (
      !imageCache.has(cacheKey)
    ) {
      imageCache.set(
        cacheKey,
        renderGamePokemonSprite(
          looktype
        ).catch(() => '')
      );
    }

    return imageCache.get(
      cacheKey
    );
  }

  async function itemCatalog() {
    if (!itemCatalogPromise) {
      itemCatalogPromise =
        requestJson(
          `${GAME_ORIGIN}/game/items.json`
        )
          .then(
            (body) =>
              Array.isArray(
                body?.items
              )
                ? body.items
                : []
          )
          .catch(() => []);
    }

    return itemCatalogPromise;
  }

  async function resolveDropImage(drop) {
    const direct =
      clean(drop?.icon);

    if (
      /^https:\/\//i.test(direct)
    ) {
      return direct;
    }

    const rows =
      await itemCatalog();

    const id =
      Number(drop?.itemId);

    const name =
      normalized(drop?.name);

    const item =
      (
        Number.isFinite(id) &&
        id > 0
          ? rows.find(
              (row) =>
                Number(
                  row.id ??
                  row.itemId
                ) === id
            )
          : null
      ) ||
      rows.find(
        (row) =>
          normalized(row.name) ===
          name
      );

    const icon =
      clean(
        item?.iconUrl ||
        item?.icon ||
        item?.image
      );

    if (!icon) {
      return '';
    }

    try {
      return new URL(
        icon,
        GAME_ORIGIN
      ).href;
    } catch {
      return '';
    }
  }

  // ============================================================
  // MARKET BAJO DEMANDA DESDE TELEGRAM
  // ============================================================

  function gameSessionTokens() {
    try {
      return JSON.parse(
        sessionStorage.getItem('pokeweb:tokens') ||
        'null'
      );
    } catch {
      return null;
    }
  }

  async function refreshGameAccessToken() {
    const tokens = gameSessionTokens();
    if (!tokens?.refreshToken) return '';

    const response = await fetch(
      '/api/auth/refresh',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          refreshToken: tokens.refreshToken
        })
      }
    );

    if (!response.ok) return '';
    const refreshed = await response
      .json()
      .catch(() => ({}));

    if (!refreshed?.accessToken) return '';
    sessionStorage.setItem(
      'pokeweb:tokens',
      JSON.stringify(refreshed)
    );
    return refreshed.accessToken;
  }

  async function gameApiGet(path) {
    const send = (token) => fetch(
      path,
      {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: token
          ? { Authorization: `Bearer ${token}` }
          : {}
      }
    );

    let response = await send(
      gameSessionTokens()?.accessToken
    );

    if (response.status === 401) {
      const token = await refreshGameAccessToken();
      if (token) response = await send(token);
    }

    const body = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        body?.message ||
        body?.error ||
        `HTTP ${response.status}`
      );
    }

    return body;
  }

  function marketListingsFromPayload(
    payload,
    depth = 0,
    visited = new WeakSet()
  ) {
    if (Array.isArray(payload)) return payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      depth > 6 ||
      visited.has(payload)
    ) return [];

    visited.add(payload);
    for (const key of [
      'listings',
      'items',
      'results',
      'offers',
      'data'
    ]) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
      const nested = marketListingsFromPayload(
        payload[key],
        depth + 1,
        visited
      );
      if (nested.length) return nested;
    }
    return [];
  }

  function marketListingRefId(entry) {
    const ref = entry?.item || entry?.product || {};
    return entry?.refId ??
      entry?.itemId ??
      entry?.ballId ??
      ref.refId ??
      ref.id ??
      ref.itemId ??
      null;
  }

  function marketListingCurrency(entry) {
    const ref = entry?.item || entry?.product || {};
    const value = clean(
      entry?.currency ||
      entry?.currencyType ||
      ref.currency ||
      ref.currencyType ||
      'GOLD'
    ).toUpperCase();
    return /DIAM|^DD$/.test(value)
      ? 'DIAMONDS'
      : 'GOLD';
  }

  function marketListingPrice(entry) {
    return Number(
      entry?.price ??
      entry?.unitPrice ??
      entry?.totalPrice ??
      entry?.value ??
      0
    );
  }

  function marketListingQuantity(entry) {
    const quantity = Number(
      entry?.quantity ??
      entry?.qty ??
      entry?.amount ??
      entry?.stock ??
      1
    );
    return Number.isFinite(quantity) && quantity > 0
      ? Math.floor(quantity)
      : 1;
  }

  function isActiveMarketItemListing(entry) {
    const ref = entry?.item || entry?.product || {};
    const kind = clean(
      entry?.kind ||
      entry?.itemKind ||
      ref.kind
    ).toLowerCase();
    const pokemon = Boolean(
      entry?.pokemon ||
      entry?.pokemonId != null ||
      entry?.speciesId != null ||
      /pokemon|pokémon|creature/.test(kind)
    );
    const inactive = Boolean(
      entry?.bought ||
      entry?.sold ||
      entry?.cancelled ||
      entry?.canceled ||
      entry?.active === false ||
      entry?.offerOnly
    );
    return !pokemon &&
      !inactive &&
      marketListingPrice(entry) > 0;
  }

  function marketPriceSummary(listings, currency) {
    const rows = listings.filter(
      (entry) =>
        marketListingCurrency(entry) === currency
    );
    if (!rows.length) return null;

    const lowest = Math.min(
      ...rows.map(marketListingPrice)
    );
    const atLowest = rows.filter(
      (entry) =>
        marketListingPrice(entry) === lowest
    );
    return {
      price: lowest,
      quantity: atLowest.reduce(
        (sum, entry) =>
          sum + marketListingQuantity(entry),
        0
      ),
      listings: atLowest.length,
      totalQuantity: rows.reduce(
        (sum, entry) =>
          sum + marketListingQuantity(entry),
        0
      )
    };
  }

  function telegramMarketNumber(value) {
    return Math.max(0, Number(value) || 0)
      .toLocaleString('es-ES');
  }

  function telegramMarketCallback(action) {
    return `pgtg:m:${action}`;
  }

  function normalizeTelegramMarketFavorites(value) {
    let rows = value;
    if (typeof rows === 'string') {
      try { rows = JSON.parse(rows); }
      catch { rows = []; }
    }
    return [...new Set(
      (Array.isArray(rows) ? rows : [])
        .map(Number)
        .filter((id) =>
          Number.isFinite(id) && id > 0
        )
    )].slice(0, 60);
  }

  async function getTelegramMarketFavorites() {
    if (telegramMarketFavorites) {
      return [...telegramMarketFavorites];
    }
    if (!telegramMarketFavoritesPromise) {
      telegramMarketFavoritesPromise = (async () => {
        let stored = null;
        try {
          if (typeof GM_getValue !== 'undefined') {
            stored = await GM_getValue(
              TELEGRAM_MARKET_FAVORITES_KEY,
              null
            );
          } else if (typeof GM !== 'undefined' && GM.getValue) {
            stored = await GM.getValue(
              TELEGRAM_MARKET_FAVORITES_KEY,
              null
            );
          }
        } catch {}
        if (stored == null) {
          stored = localStorage.getItem(
            TELEGRAM_MARKET_FAVORITES_KEY
          );
        }
        telegramMarketFavorites = normalizeTelegramMarketFavorites(stored);
        return telegramMarketFavorites;
      })().finally(() => {
        telegramMarketFavoritesPromise = null;
      });
    }
    return [...(await telegramMarketFavoritesPromise)];
  }

  async function saveTelegramMarketFavorites(ids) {
    telegramMarketFavorites = normalizeTelegramMarketFavorites(ids);
    localStorage.setItem(
      TELEGRAM_MARKET_FAVORITES_KEY,
      JSON.stringify(telegramMarketFavorites)
    );
    try {
      if (typeof GM_setValue !== 'undefined') {
        await GM_setValue(
          TELEGRAM_MARKET_FAVORITES_KEY,
          telegramMarketFavorites
        );
      } else if (typeof GM !== 'undefined' && GM.setValue) {
        await GM.setValue(
          TELEGRAM_MARKET_FAVORITES_KEY,
          telegramMarketFavorites
        );
      }
    } catch {}
    return [...telegramMarketFavorites];
  }

  async function telegramMarketItemIsFavorite(itemId) {
    return (await getTelegramMarketFavorites())
      .includes(Number(itemId));
  }

  async function toggleTelegramMarketFavorite(itemId) {
    const id = Number(itemId);
    const favorites = await getTelegramMarketFavorites();
    const enabled = !favorites.includes(id);
    const next = enabled
      ? [id, ...favorites]
      : favorites.filter((value) => value !== id);
    await saveTelegramMarketFavorites(next);
    return enabled;
  }

  function telegramMarketHomeKeyboard() {
    return {
      inline_keyboard: [
        [{
          text: '⭐ Favoritos',
          callback_data: telegramMarketCallback('favorites:0')
        }],
        [{
          text: '🔎 Buscar objeto',
          callback_data: telegramMarketCallback('search')
        }],
        [
          { text: '🪨 Stones', callback_data: telegramMarketCallback('cat:stone:0') },
          { text: '🫐 Berries', callback_data: telegramMarketCallback('cat:berry:0') }
        ],
        [
          { text: '💿 TMs', callback_data: telegramMarketCallback('cat:tm:0') },
          { text: '🧪 Curas', callback_data: telegramMarketCallback('cat:heal:0') }
        ],
        [
          { text: '🎴 Cards', callback_data: telegramMarketCallback('cat:card:0') },
          { text: '📦 Drops / Misc', callback_data: telegramMarketCallback('cat:loot:0') }
        ]
      ]
    };
  }

  async function telegramBotCall(method, payload = {}) {
    if (!config.token) {
      throw new Error('El bot no está configurado.');
    }
    const response = await requestJson(
      `https://api.telegram.org/bot${config.token}/${method}`,
      payload
    );
    return response?.result;
  }

  async function sendTelegramMarketMessage(
    chatId,
    {
      text,
      photo = '',
      replyMarkup = null
    }
  ) {
    const common = {
      chat_id: String(chatId),
      parse_mode: 'HTML',
      reply_markup: replyMarkup || undefined
    };

    if (photo) {
      try {
        const animated = /\.gif(?:\?|$)/i.test(photo);
        return await telegramBotCall(
          animated ? 'sendAnimation' : 'sendPhoto',
          {
            ...common,
            [animated ? 'animation' : 'photo']: photo,
            caption: String(text || '').slice(0, 1000)
          }
        );
      } catch (error) {
        console.debug(
          '[PokeGrid Telegram] El sprite del objeto no pudo enviarse; se usará texto.',
          error?.message || error
        );
      }
    }

    return telegramBotCall(
      'sendMessage',
      {
        ...common,
        text: String(text || '').slice(0, 3900),
        disable_web_page_preview: true
      }
    );
  }

  function authorizedTelegramChat(chatId) {
    const id = String(chatId ?? '');
    return parseRecipients().some(
      (recipient) =>
        String(recipient.chatId) === id
    );
  }

  function marketCategoryKey(item) {
    const category = normalized(item?.category);
    const name = normalized(item?.name);
    if (category === 'stone') return 'stone';
    if (category === 'berry') return 'berry';
    if (category === 'tm') return 'tm';
    if (
      category === 'heal' ||
      category === 'revive' ||
      /potion|revive|medicine|cura/.test(name)
    ) return 'heal';
    if (category === 'card') return 'card';
    return 'loot';
  }

  async function findMarketCatalogItems(query) {
    const wanted = normalized(query);
    if (!wanted) return [];
    const rows = await itemCatalog();
    return rows
      .map((item) => {
        const name = normalized(item?.name);
        const exact = name === wanted;
        const starts = name.startsWith(wanted);
        const contains = name.includes(wanted);
        const tokenMatch = wanted
          .split(/\s+/)
          .filter(Boolean)
          .every((token) => name.includes(token));
        return {
          item,
          score: exact ? 0 : starts ? 1 : contains ? 2 : tokenMatch ? 3 : 99
        };
      })
      .filter((row) => row.score < 99)
      .sort((a, b) =>
        a.score - b.score ||
        clean(a.item.name).length - clean(b.item.name).length ||
        clean(a.item.name).localeCompare(clean(b.item.name))
      )
      .map((row) => row.item);
  }

  function marketItemChoiceKeyboard(items, footer = true) {
    const rows = items.slice(0, 10).map(
      (item) => [{
        text: `📦 ${clean(item.name)}`.slice(0, 58),
        callback_data: telegramMarketCallback(`item:${Number(item.id ?? item.itemId)}`)
      }]
    );
    if (footer) {
      rows.push([
        { text: '🔎 Buscar', callback_data: telegramMarketCallback('search') },
        { text: '🏪 Menú', callback_data: telegramMarketCallback('home') }
      ]);
    }
    return { inline_keyboard: rows };
  }

  async function showTelegramMarketHome(chatId) {
    telegramPendingMarketSearch.delete(String(chatId));
    return sendTelegramMarketMessage(
      chatId,
      {
        text: [
          '🏪 <b>Market de Poke Idle World</b>',
          '',
          'Busca un objeto por nombre o explora una categoría. El precio se leerá únicamente cuando selecciones el objeto.',
          '',
          'También puedes usar:',
          '<code>/precio Water Stone</code>'
        ].join('\n'),
        replyMarkup: telegramMarketHomeKeyboard()
      }
    );
  }

  async function promptTelegramMarketSearch(chatId) {
    telegramPendingMarketSearch.add(String(chatId));
    return sendTelegramMarketMessage(
      chatId,
      {
        text: [
          '🔎 <b>Buscar en el Market</b>',
          '',
          'Escribe ahora el nombre del objeto que quieres consultar.',
          'Ejemplo: <code>Water Stone</code>'
        ].join('\n'),
        replyMarkup: {
          inline_keyboard: [[
            { text: '✖ Cancelar', callback_data: telegramMarketCallback('cancel') },
            { text: '🏪 Menú', callback_data: telegramMarketCallback('home') }
          ]]
        }
      }
    );
  }

  async function showTelegramMarketCategory(
    chatId,
    category,
    requestedPage = 0
  ) {
    const labels = {
      stone: '🪨 Stones',
      berry: '🫐 Berries',
      tm: '💿 TMs',
      heal: '🧪 Curas',
      card: '🎴 Cards',
      loot: '📦 Drops / Misc'
    };
    const catalog = (await itemCatalog())
      .filter((item) =>
        marketCategoryKey(item) === category
      )
      .sort((a, b) =>
        clean(a.name).localeCompare(clean(b.name))
      );
    const pageSize = 8;
    const pageCount = Math.max(
      1,
      Math.ceil(catalog.length / pageSize)
    );
    const page = Math.max(
      0,
      Math.min(pageCount - 1, Number(requestedPage) || 0)
    );
    const items = catalog.slice(
      page * pageSize,
      page * pageSize + pageSize
    );
    const keyboard = marketItemChoiceKeyboard(
      items,
      false
    ).inline_keyboard;
    const navigation = [];
    if (page > 0) {
      navigation.push({
        text: '◀ Anterior',
        callback_data: telegramMarketCallback(`cat:${category}:${page - 1}`)
      });
    }
    navigation.push({
      text: `${page + 1}/${pageCount}`,
      callback_data: telegramMarketCallback('noop')
    });
    if (page + 1 < pageCount) {
      navigation.push({
        text: 'Siguiente ▶',
        callback_data: telegramMarketCallback(`cat:${category}:${page + 1}`)
      });
    }
    keyboard.push(navigation);
    keyboard.push([
      { text: '🔎 Buscar', callback_data: telegramMarketCallback('search') },
      { text: '🏪 Menú', callback_data: telegramMarketCallback('home') }
    ]);

    return sendTelegramMarketMessage(
      chatId,
      {
        text: `<b>${labels[category] || 'Objetos'}</b>\nSelecciona un objeto para consultar su precio actual.`,
        replyMarkup: { inline_keyboard: keyboard }
      }
    );
  }

  async function showTelegramMarketFavorites(
    chatId,
    requestedPage = 0
  ) {
    const favoriteIds = await getTelegramMarketFavorites();
    const catalog = await itemCatalog();
    const byId = new Map(
      catalog.map((item) => [
        Number(item?.id ?? item?.itemId),
        item
      ])
    );
    const favorites = favoriteIds
      .map((id) => byId.get(Number(id)))
      .filter(Boolean);

    if (favorites.length !== favoriteIds.length) {
      await saveTelegramMarketFavorites(
        favorites.map((item) =>
          Number(item?.id ?? item?.itemId)
        )
      );
    }

    if (!favorites.length) {
      return sendTelegramMarketMessage(
        chatId,
        {
          text: [
            '⭐ <b>Favoritos del Market</b>',
            '',
            'Todavía no has guardado objetos.',
            'Consulta uno y pulsa <b>Agregar a favoritos</b> para crear un acceso rápido.'
          ].join('\n'),
          replyMarkup: {
            inline_keyboard: [[
              { text: '🔎 Buscar objeto', callback_data: telegramMarketCallback('search') },
              { text: '🏪 Menú', callback_data: telegramMarketCallback('home') }
            ]]
          }
        }
      );
    }

    const pageSize = 8;
    const pageCount = Math.max(
      1,
      Math.ceil(favorites.length / pageSize)
    );
    const page = Math.max(
      0,
      Math.min(pageCount - 1, Number(requestedPage) || 0)
    );
    const visible = favorites.slice(
      page * pageSize,
      page * pageSize + pageSize
    );
    const keyboard = visible.map((item) => [{
      text: `⭐ ${clean(item.name)}`.slice(0, 58),
      callback_data: telegramMarketCallback(`item:${Number(item.id ?? item.itemId)}`)
    }]);
    const navigation = [];
    if (page > 0) {
      navigation.push({
        text: '◀ Anterior',
        callback_data: telegramMarketCallback(`favorites:${page - 1}`)
      });
    }
    navigation.push({
      text: `${page + 1}/${pageCount}`,
      callback_data: telegramMarketCallback('noop')
    });
    if (page + 1 < pageCount) {
      navigation.push({
        text: 'Siguiente ▶',
        callback_data: telegramMarketCallback(`favorites:${page + 1}`)
      });
    }
    keyboard.push(navigation);
    keyboard.push([
      { text: '🔎 Buscar', callback_data: telegramMarketCallback('search') },
      { text: '🏪 Menú', callback_data: telegramMarketCallback('home') }
    ]);

    return sendTelegramMarketMessage(
      chatId,
      {
        text: `⭐ <b>Favoritos del Market</b>\n${favorites.length} acceso(s) rápido(s) guardado(s).`,
        replyMarkup: { inline_keyboard: keyboard }
      }
    );
  }

  function telegramMarketResultKeyboard(
    itemId,
    isFavorite
  ) {
    return {
      inline_keyboard: [
        [{
          text: '🔄 Actualizar precio',
          callback_data: telegramMarketCallback(`item:${itemId}`)
        }],
        [{
          text: isFavorite ? '★ Quitar de favoritos' : '☆ Agregar a favoritos',
          callback_data: telegramMarketCallback(`favorite:${itemId}`)
        }],
        [
          { text: '⭐ Favoritos', callback_data: telegramMarketCallback('favorites:0') },
          { text: '🔎 Otro objeto', callback_data: telegramMarketCallback('search') }
        ],
        [{ text: '🏪 Menú del Market', callback_data: telegramMarketCallback('home') }]
      ]
    };
  }

  async function sendTelegramMarketItemResult(
    chatId,
    item
  ) {
    const itemId = Number(item?.id ?? item?.itemId);
    if (!Number.isFinite(itemId)) {
      throw new Error('El objeto no tiene un ID válido.');
    }

    // Esta es la única lectura del Market: se ejecuta por comando o callback.
    const payload = await gameApiGet(GAME_MARKET_URL);
    const listings = marketListingsFromPayload(payload)
      .filter(isActiveMarketItemListing)
      .filter((entry) =>
        Number(marketListingRefId(entry)) === itemId
      );
    const gold = marketPriceSummary(listings, 'GOLD');
    const diamonds = marketPriceSummary(listings, 'DIAMONDS');
    const timestamp = new Intl.DateTimeFormat(
      'es-ES',
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }
    ).format(new Date());
    const currencyLine = (icon, label, data) =>
      data
        ? `${icon} <b>${label}:</b> ${telegramMarketNumber(data.price)} c/u\n   📦 <b>${telegramMarketNumber(data.quantity)}</b> unidades al precio mínimo · ${data.listings} anuncio(s)`
        : `${icon} <b>${label}:</b> Sin anuncios activos`;
    const text = [
      '🏷️ <b>Consulta del Market</b>',
      '',
      `📦 <b>${escapeHtml(clean(item.name) || `Item #${itemId}`)}</b>`,
      `🆔 ID: <code>${itemId}</code>`,
      '',
      currencyLine('💲', 'Pokédolares', gold),
      '',
      currencyLine('💎', 'Diamantes', diamonds),
      '',
      listings.length
        ? `📊 Total listado: <b>${telegramMarketNumber(listings.reduce((sum, entry) => sum + marketListingQuantity(entry), 0))}</b> unidades`
        : 'ℹ️ Este objeto no está listado actualmente.',
      `🕒 Consultado a las ${timestamp}`
    ].join('\n');
    const photo = absoluteStockIcon(
      item.iconUrl ||
      item.icon ||
      item.image ||
      item.sprite
    );
    const isFavorite = await telegramMarketItemIsFavorite(itemId);

    return sendTelegramMarketMessage(
      chatId,
      {
        text,
        photo,
        replyMarkup: telegramMarketResultKeyboard(
          itemId,
          isFavorite
        )
      }
    );
  }

  async function resolveAndSendTelegramMarketItem(
    chatId,
    query
  ) {
    telegramPendingMarketSearch.delete(String(chatId));
    const matches = await findMarketCatalogItems(query);

    if (!matches.length) {
      return sendTelegramMarketMessage(
        chatId,
        {
          text: `❌ No encontré ningún objeto llamado <b>${escapeHtml(clean(query))}</b>.\nPrueba con otra parte del nombre.`,
          replyMarkup: {
            inline_keyboard: [[
              { text: '🔎 Intentar de nuevo', callback_data: telegramMarketCallback('search') },
              { text: '🏪 Menú', callback_data: telegramMarketCallback('home') }
            ]]
          }
        }
      );
    }

    const exact = matches.find(
      (item) =>
        normalized(item.name) === normalized(query)
    );
    if (exact || matches.length === 1) {
      return sendTelegramMarketItemResult(
        chatId,
        exact || matches[0]
      );
    }

    return sendTelegramMarketMessage(
      chatId,
      {
        text: `🔎 Encontré varios resultados para <b>${escapeHtml(clean(query))}</b>. Elige el objeto correcto:`,
        replyMarkup: marketItemChoiceKeyboard(matches)
      }
    );
  }

  async function telegramItemById(itemId) {
    const catalog = await itemCatalog();
    return catalog.find(
      (item) =>
        Number(item?.id ?? item?.itemId) === Number(itemId)
    ) || null;
  }

  async function handleTelegramMarketCallback(query) {
    const chatId = String(query?.message?.chat?.id ?? '');
    if (!authorizedTelegramChat(chatId)) {
      await telegramBotCall(
        'answerCallbackQuery',
        {
          callback_query_id: query.id,
          text: 'Chat no autorizado.',
          show_alert: true
        }
      ).catch(() => null);
      return;
    }

    const action = clean(query.data).slice('pgtg:m:'.length);
    if (action === 'noop') {
      await telegramBotCall('answerCallbackQuery', {
        callback_query_id: query.id
      }).catch(() => null);
      return;
    }

    if (action.startsWith('favorite:')) {
      const itemId = Number(action.slice('favorite:'.length));
      const item = await telegramItemById(itemId);
      if (!item) {
        throw new Error('El objeto seleccionado ya no existe en el catálogo.');
      }
      const enabled = await toggleTelegramMarketFavorite(itemId);
      await telegramBotCall(
        'answerCallbackQuery',
        {
          callback_query_id: query.id,
          text: enabled
            ? `${clean(item.name)} agregado a favoritos.`
            : `${clean(item.name)} quitado de favoritos.`
        }
      ).catch(() => null);
      await telegramBotCall(
        'editMessageReplyMarkup',
        {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: telegramMarketResultKeyboard(
            itemId,
            enabled
          )
        }
      ).catch(() => null);
      return;
    }

    await telegramBotCall(
      'answerCallbackQuery',
      {
        callback_query_id: query.id,
        text: action.startsWith('item:')
          ? 'Consultando el Market…'
          : 'Abriendo…'
      }
    ).catch(() => null);

    if (action === 'home') return showTelegramMarketHome(chatId);
    if (action === 'search') return promptTelegramMarketSearch(chatId);
    if (action.startsWith('favorites:')) {
      return showTelegramMarketFavorites(
        chatId,
        Number(action.split(':')[1]) || 0
      );
    }
    if (action === 'cancel') {
      telegramPendingMarketSearch.delete(chatId);
      return showTelegramMarketHome(chatId);
    }
    if (action.startsWith('cat:')) {
      const [, category, page] = action.split(':');
      return showTelegramMarketCategory(
        chatId,
        category,
        Number(page) || 0
      );
    }
    if (action.startsWith('item:')) {
      const item = await telegramItemById(
        Number(action.slice(5))
      );
      if (!item) {
        throw new Error('El objeto seleccionado ya no existe en el catálogo.');
      }
      return sendTelegramMarketItemResult(chatId, item);
    }
  }

  async function sendTelegramBotHelp(chatId) {
    return sendTelegramMarketMessage(
      chatId,
      {
        text: [
          '🤖 <b>PokeGrid Telegram Alerts</b>',
          '',
          '<b>Market bajo demanda</b>',
          '• <code>/market</code> — menú interactivo',
          '• <code>/precio nombre</code> — precio directo',
          '• <code>/favoritos</code> — accesos rápidos guardados',
          '• <code>/cancelar</code> — cancelar búsqueda',
          '',
          'Los precios solo se consultan cuando solicitas un objeto.'
        ].join('\n'),
        replyMarkup: telegramMarketHomeKeyboard()
      }
    );
  }

  async function handleTelegramCommandMessage(message) {
    const chatId = String(message?.chat?.id ?? '');
    if (!authorizedTelegramChat(chatId)) return;
    const text = clean(message?.text);
    if (!text) return;

    const command = text.match(
      /^\/([a-záéíóúñ]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i
    );
    if (!command) {
      if (telegramPendingMarketSearch.has(chatId)) {
        await resolveAndSendTelegramMarketItem(
          chatId,
          text
        );
      }
      return;
    }

    const name = normalized(command[1]);
    const argument = clean(command[2]);
    if (name === 'start' || name === 'ayuda' || name === 'help') {
      await sendTelegramBotHelp(chatId);
      return;
    }
    if (name === 'cancelar' || name === 'cancel') {
      telegramPendingMarketSearch.delete(chatId);
      await showTelegramMarketHome(chatId);
      return;
    }
    if (name === 'market' || name === 'mercado') {
      if (argument) {
        await resolveAndSendTelegramMarketItem(chatId, argument);
      } else {
        await showTelegramMarketHome(chatId);
      }
      return;
    }
    if (name === 'favoritos' || name === 'favorites') {
      await showTelegramMarketFavorites(chatId, 0);
      return;
    }
    if (name === 'precio' || name === 'price') {
      if (argument) {
        await resolveAndSendTelegramMarketItem(chatId, argument);
      } else {
        await promptTelegramMarketSearch(chatId);
      }
    }
  }

  function telegramCommandOffsetKey() {
    const botId = clean(config.token).split(':')[0] || 'none';
    return `${TELEGRAM_COMMAND_OFFSET_PREFIX}${botId}`;
  }

  function isTelegramCommandPrimaryAccount() {
    const index = Number(account?.index);
    return !Number.isFinite(index) || index <= 0;
  }

  function claimTelegramCommandLease() {
    if (!isTelegramCommandPrimaryAccount()) return false;
    const now = Date.now();
    try {
      const lease = JSON.parse(
        localStorage.getItem(TELEGRAM_COMMAND_LEASE_KEY) ||
        'null'
      );
      if (
        lease?.owner &&
        lease.owner !== telegramCommandInstanceId &&
        Number(lease.until) > now
      ) return false;

      localStorage.setItem(
        TELEGRAM_COMMAND_LEASE_KEY,
        JSON.stringify({
          owner: telegramCommandInstanceId,
          until: now + TELEGRAM_COMMAND_LEASE_MS
        })
      );
      const confirmed = JSON.parse(
        localStorage.getItem(TELEGRAM_COMMAND_LEASE_KEY) ||
        'null'
      );
      return confirmed?.owner === telegramCommandInstanceId;
    } catch {
      return true;
    }
  }

  async function registerTelegramBotCommands() {
    if (
      !hasCredentials() ||
      telegramCommandsRegisteredFor === config.token
    ) return;

    await telegramBotCall(
      'setMyCommands',
      {
        commands: [
          { command: 'market', description: 'Abrir el Market interactivo' },
          { command: 'precio', description: 'Consultar precio de un objeto' },
          { command: 'favoritos', description: 'Abrir favoritos del Market' },
          { command: 'ayuda', description: 'Ver comandos de PokeGrid' },
          { command: 'cancelar', description: 'Cancelar la búsqueda actual' }
        ]
      }
    );
    telegramCommandsRegisteredFor = config.token;
  }

  async function pollTelegramBotCommands() {
    if (
      telegramCommandPollBusy ||
      !hasCredentials() ||
      !claimTelegramCommandLease()
    ) return;

    telegramCommandPollBusy = true;
    try {
      if (telegramCommandToken !== config.token) {
        telegramCommandToken = config.token;
        const stored = localStorage.getItem(
          telegramCommandOffsetKey()
        );
        telegramCommandOffset = stored === null
          ? -1
          : Math.max(0, Number(stored) || 0);
      }

      await registerTelegramBotCommands()
        .catch((error) =>
          console.debug(
            '[PokeGrid Telegram] No se pudieron registrar los comandos todavía.',
            error?.message || error
          )
        );

      const updates = await telegramBotCall(
        'getUpdates',
        {
          offset: telegramCommandOffset,
          limit: 25,
          timeout: 20,
          allowed_updates: [
            'message',
            'callback_query'
          ]
        }
      );

      for (const update of [...(updates || [])]
        .sort((a, b) =>
          Number(a.update_id) - Number(b.update_id)
        )) {
        try {
          if (
            update.callback_query?.data
              ?.startsWith('pgtg:m:')
          ) {
            await handleTelegramMarketCallback(
              update.callback_query
            );
          } else if (update.message) {
            await handleTelegramCommandMessage(
              update.message
            );
          }
        } catch (error) {
          const chatId = String(
            update.callback_query?.message?.chat?.id ??
            update.message?.chat?.id ??
            ''
          );
          if (authorizedTelegramChat(chatId)) {
            await sendTelegramMarketMessage(
              chatId,
              {
                text: `⚠️ <b>No se pudo completar la consulta</b>\n${escapeHtml(error?.message || 'Error desconocido')}`,
                replyMarkup: telegramMarketHomeKeyboard()
              }
            ).catch(() => null);
          }
          console.warn(
            '[PokeGrid Telegram] Error procesando el comando.',
            error
          );
        } finally {
          telegramCommandOffset = Math.max(
            telegramCommandOffset,
            Number(update.update_id || 0) + 1
          );
        }
      }

      if (telegramCommandOffset >= 0) {
        localStorage.setItem(
          telegramCommandOffsetKey(),
          String(telegramCommandOffset)
        );
      }
    } catch (error) {
      console.debug(
        '[PokeGrid Telegram] Receptor de comandos aplazado.',
        error?.message || error
      );
    } finally {
      telegramCommandPollBusy = false;
    }
  }

  // ============================================================
  // DEDUPLICACIÓN
  // ============================================================

  function eventIsFresh(
    key,
    ttl = 60_000
  ) {
    const now = Date.now();

    for (
      const [oldKey, timestamp]
      of seenEvents
    ) {
      if (
        now - timestamp >
        SEEN_MAX_AGE
      ) {
        seenEvents.delete(oldKey);
      }
    }

    if (
      seenEvents.has(key) &&
      now - seenEvents.get(key) <
        ttl
    ) {
      return false;
    }

    seenEvents.set(
      key,
      now
    );

    saveSeenEvents();

    return true;
  }

  function captureRouteSignature(
    capture
  ) {
    const stableId =
      directCaptureNumber(capture) ||
      clean(capture?.key);

    if (stableId) {
      return `id:${stableId}`;
    }

    return [
      canonicalPokemonName(
        capture?.name
      ),

      firstNumber(
        capture?.iv ??
        capture?.meta
      ) ?? '',

      firstNumber(
        capture?.level
      ) ?? ''
    ].join('|');
  }

  function isCrossRouteCaptureDuplicate(
    capture
  ) {
    const source =
      clean(capture?.source) ||
      'unknown';

    const signature =
      captureRouteSignature(
        capture
      );

    const now =
      Date.now();

    for (
      const [key, value]
      of recentCaptureRoutes
    ) {
      if (
        now - value.at >
        30_000
      ) {
        recentCaptureRoutes.delete(
          key
        );
      }
    }

    const previous =
      recentCaptureRoutes.get(
        signature
      );

    const differentRouteDuplicate =
      previous &&
      previous.source !== source &&
      now - previous.at < 5_000;

    const sameRouteDuplicate =
      previous &&
      previous.source === source &&
      now - previous.at < 1_500;

    if (
      differentRouteDuplicate ||
      sameRouteDuplicate
    ) {
      return true;
    }

    recentCaptureRoutes.set(
      signature,
      {
        source,
        at: now
      }
    );

    return false;
  }

  function isCrossRouteDropDuplicate(
    drop,
    context = {}
  ) {
    const source =
      clean(context.source) ||
      'unknown';

    const signature = [
      normalized(drop?.name),
      Number(drop?.quantity || 0)
    ].join('|');

    const now =
      Date.now();

    for (
      const [key, value]
      of recentDropRoutes
    ) {
      if (
        now - value.at >
        30_000
      ) {
        recentDropRoutes.delete(
          key
        );
      }
    }

    const previous =
      recentDropRoutes.get(
        signature
      );

    if (
      previous &&
      previous.source !== source &&
      now - previous.at < 5_000
    ) {
      return true;
    }

    recentDropRoutes.set(
      signature,
      {
        source,
        at: now
      }
    );

    return false;
  }

  // ============================================================
  // FILTROS DE CAPTURA
  // ============================================================

  function captureMatchesFilters(capture) {
    const iv =
      firstNumber(
        capture.iv ??
        capture.meta
      );

    const level =
      firstNumber(capture.level);

    const tiers =
      listFrom(
        config.capture.tiers
      ).map(canonicalTier);

    const pokemon =
      listFrom(
        config.capture.pokemon
      ).map(
        canonicalPokemonName
      );

    const tier =
      canonicalTier(
        `${capture.tier || ''} ${capture.meta || ''} ${capture.quality || ''}`
      );

    const name =
      canonicalPokemonName(
        capture.name
      );

    if (
      iv !== null &&
      iv < config.capture.minIv
    ) {
      return false;
    }

    if (
      iv === null &&
      config.capture.minIv > 0
    ) {
      return false;
    }

    if (
      level !== null &&
      level <
        config.capture.minLevel
    ) {
      return false;
    }

    if (
      level === null &&
      config.capture.minLevel > 0
    ) {
      return false;
    }

    if (
      tiers.length &&
      !tiers.includes(tier)
    ) {
      return false;
    }

    if (
      pokemon.length &&
      !pokemon.some(
        (value) =>
          (` ${name} `)
            .includes(
              ` ${value} `
            )
      )
    ) {
      return false;
    }

    return true;
  }

  async function isLegendaryCapture(
    capture
  ) {
    const qVal =
      extractCaptureQuality(
        capture
      );

    if (qVal !== null) {
      return (
        qVal >= 1.7 &&
        qVal < 2.0
      );
    }

    const resolved =
      await resolveCaptureTier(
        capture
      );

    return (
      resolved === 'legendary'
    );
  }

  // ============================================================
  // ENVÍO
  // ============================================================

  function queueAlert(alert) {
    const task =
      deliveryQueue
        .then(
          () => deliver(alert)
        );

    deliveryQueue = task
      .catch((error) => {
          setStatus(
            `No se pudo enviar una alerta: ${error.message}`,
            'error'
          );

          console.warn(
            '[PokeGrid Telegram]',
            error
          );
        });

    return task;
  }

  async function deliver({
    photo = '',
    caption
  }) {
    if (!hasCredentials()) {
      return false;
    }

    const recipients =
      parseRecipients();

    for (
      const recipient
      of recipients
    ) {
      const safeCaption =
        String(caption || '')
          .slice(0, 1000);

      const base =
        `https://api.telegram.org/bot${config.token}`;

      if (photo) {
        try {
          if (
            photo &&
            typeof photo === 'object' &&
            photo.base64
          ) {
            await requestMultipart(
              `${base}/sendPhoto`,
              [
                {
                  name: 'chat_id',
                  value:
                    recipient.chatId
                },

                {
                  name: 'caption',
                  value:
                    safeCaption
                },

                {
                  name: 'parse_mode',
                  value: 'HTML'
                },

                {
                  name: 'photo',
                  base64:
                    photo.base64,
                  mimeType:
                    photo.mimeType ||
                    'image/png',
                  filename:
                    photo.filename ||
                    'pokegrid.png'
                }
              ]
            );
          } else {
            await requestJson(
              `${base}/sendPhoto`,
              {
                chat_id:
                  recipient.chatId,

                photo,

                caption:
                  safeCaption,

                parse_mode:
                  'HTML'
              }
            );
          }

          continue;
        } catch (error) {
          console.warn(
            `[PokeGrid Telegram] sendPhoto falló para ${recipient.label}; usando texto.`,
            error
          );
        }
      }

      await requestJson(
        `${base}/sendMessage`,
        {
          chat_id:
            recipient.chatId,

          text:
            safeCaption,

          parse_mode:
            'HTML',

          disable_web_page_preview:
            true
        }
      );
    }

    return true;
  }

  // ============================================================
  // STOCK DE POKÉ BALLS Y POCIONES
  // ============================================================

  async function processStockRules(
    type,
    enabled,
    rules,
    stockMap
  ) {
    if (!enabled) return;

    for (const rule of rules) {
      const key = normalized(rule.name);
      const item = stockMap.get(key);

      if (!item) continue;

      const threshold = clampNumber(
        rule.threshold,
        0,
        999999,
        10
      );
      const cacheKey =
        `stock:${accountLabel}:${type}:${key}`;

      if (item.quantity > threshold) {
        lowStockNotified.delete(cacheKey);
        lowStockPending.delete(cacheKey);
        continue;
      }

      if (
        lowStockNotified.has(cacheKey) ||
        lowStockPending.has(cacheKey)
      ) {
        continue;
      }

      lowStockPending.add(cacheKey);

      const typeLabel = type === 'ball'
        ? 'POKÉ BALL'
        : 'POCIÓN';

      try {
        const delivered = await queueAlert({
          caption: [
            `<b>⚠️ STOCK BAJO DE ${typeLabel}</b>`,
            `👤 Cuenta: <b>${escapeHtml(getAccountName())}</b>`,
            `${type === 'ball' ? '⚪' : '🧪'} Objeto: <b>${escapeHtml(item.name)}</b>`,
            `📦 Cantidad actual: <b>${item.quantity}</b>`,
            `🔔 Límite configurado: <b>${threshold}</b>`,
            '<i>La alerta se reactivará cuando el stock vuelva a superar el límite.</i>'
          ].join('\n')
        });

        if (delivered === true) {
          lowStockNotified.set(
            cacheKey,
            Date.now()
          );
        }
      } catch {
        // Se reintentará en la próxima lectura de inventario.
      } finally {
        lowStockPending.delete(cacheKey);
      }
    }
  }

  async function checkConsumableStock(
    _scheduleScan = true
  ) {
    requestSocketStock();
    refreshStockConfigurationUI(false);

    if (!hasCredentials()) return;

    await processStockRules(
      'ball',
      config.stock.enabled,
      config.stock.ballRules,
      currentStock.balls
    );
    await processStockRules(
      'potion',
      config.stock.potionsEnabled,
      config.stock.potionRules,
      currentStock.potions
    );
  }

  function watchConsumableStockDOM() {
    const root = document.body || document.documentElement;

    if (!root || window.__pokeGridStockObserver) {
      return;
    }

    let scheduled = false;
    const observer = new MutationObserver(
      (mutations) => {
        const relevant = mutations.some((mutation) => {
          const element = mutation.target.nodeType === 1
            ? mutation.target
            : mutation.target.parentElement;

          return element?.closest?.(
            '.inv-slot.inv-ball, .inv-slot.inv-usable'
          );
        });

        if (!relevant || scheduled) return;

        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          checkConsumableStock();
        });
      }
    );

    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-quantity',
        'data-count',
        'data-stock',
        'value',
        'selected'
      ]
    });

    window.__pokeGridStockObserver = observer;
  }


  // ============================================================
  // CAPTURAS
  // ============================================================

  async function handleCapture(capture) {
    if (!capture?.name) {
      return;
    }

    const eventTime =
      Number(
        capture.detectedAt ||
        capture.timestamp ||
        0
      );

    if (
      eventTime > 0 &&
      eventTime <
        SCRIPT_BOOT_TIME - 5000
    ) {
      return;
    }

    if (
      capture.when &&
      Date.now() -
        SCRIPT_BOOT_TIME >
        10000 &&
      Date.parse(capture.when) &&
      Date.parse(capture.when) <
        SCRIPT_BOOT_TIME - 15000
    ) {
      return;
    }

    await loadConfig(false);

    if (!hasCredentials()) {
      return;
    }

    const resolvedTier =
      await resolveCaptureTier(
        capture
      );

    if (
      resolvedTier &&
      !knownTier(capture.tier)
    ) {
      capture = {
        ...capture,

        tier:
          displayTier(
            resolvedTier
          ),

        resolvedTier
      };
    }

    const qVal =
      extractCaptureQuality(
        capture
      );

    if (
      qVal !== null &&
      !resolvedTier
    ) {
      const tKey =
        tierFromQuality(qVal);

      if (tKey) {
        capture.tier =
          displayTier(tKey);
      }
    }

    const shiny =
      capture.isShiny === true ||
      /\bshiny\b/i.test(
        `${capture.name} ${capture.meta || ''}`
      );

    const legendary =
      await isLegendaryCapture(
        capture
      );

    const filtered =
      config.alerts
        .filteredCaptures &&
      captureMatchesFilters(
        capture
      );

    if (
      !(
        (
          shiny &&
          config.alerts
            .shinyCaptures
        ) ||
        (
          legendary &&
          config.alerts
            .legendaryCaptures
        ) ||
        filtered
      )
    ) {
      return;
    }

    // IMPORTANTE:
    // reservar la captura antes de las
    // operaciones async evita duplicados
    // entre queue, bridge y DOM.
    if (
      isCrossRouteCaptureDuplicate(
        capture
      )
    ) {
      return;
    }

    const captureNumber =
      await resolveCaptureNumber(
        capture
      );

    if (captureNumber) {
      capture.captureNumber =
        captureNumber;
    }

    const resolvedBall =
      await resolveCaptureBall(
        capture
      );

    if (resolvedBall) {
      capture.ball =
        resolvedBall;
    }

    const stableKey =
      capture.captureNumber ||
      capture.key ||
      capture.id;

    if (
      stableKey &&
      !eventIsFresh(
        `capture-id:${accountLabel}:${stableKey}`,
        SEEN_MAX_AGE
      )
    ) {
      return;
    }

    const semanticKey =
      `capture-semantic:${accountLabel}:${
        [
          normalized(
            capture.name
          ),

          capture.level ?? '',

          firstNumber(
            capture.iv ??
            capture.meta
          ) ?? '',

          shiny
            ? 'shiny'
            : 'normal'
        ].join('|')
      }`;

    if (
      !stableKey &&
      !eventIsFresh(
        semanticKey,
        4_000
      )
    ) {
      return;
    }

    const captureIv =
      firstNumber(
        capture.iv ??
        capture.meta
      );

    const iv =
      captureIv !== null
        ? `${captureIv}/${firstNumber(capture.ivMax) || 192}`
        : 'No disponible';

    const title =
      shiny && legendary
        ? '✨🏆 SHINY LEGENDARIO CAPTURADO'
        : shiny
          ? '✨ SHINY CAPTURADO'
          : legendary
            ? '🏆 LEGENDARIO CAPTURADO'
            : '🎯 CAPTURA OBJETIVO';

    const photo =
      await resolvePokemonImage(
        capture.name,
        shiny,
        capture.speciesId ||
        capture.pokemonId,
        capture.looktype ||
        capture.lookType
      );

    const accountName =
      getAccountName();

    const formattedTime =
      formatTime12h(
        capture.when
      );

    const ballLabel =
      clean(capture.ball) ||
      'No disponible';

    queueAlert({
      photo:
        photo ||
        clean(capture.sprite),

      caption: [
        `<b>${title}</b>`,

        capture.captureNumber
          ? `#️⃣ Captura: <b>#${escapeHtml(capture.captureNumber)}</b>`
          : '#️⃣ Captura: <b>No disponible</b>',

        `👤 Cuenta: <b>${escapeHtml(accountName)}</b>`,

        `🐾 Pokémon: <b>${escapeHtml(capture.name)}</b>`,

        `🏷 Tier: <b>${escapeHtml(
          capture.tier ||
          capture.quality ||
          'Sin tier'
        )}</b>`,

        `🧬 IV: <b>${escapeHtml(iv)}</b>`,

        `📈 Nivel: <b>${escapeHtml(
          capture.level ??
          'No disponible'
        )}</b>`,

        `⚪ Poké Ball: <b>${escapeHtml(ballLabel)}</b>`,

        `🕒 ${escapeHtml(formattedTime)}`
      ].join('\n')
    });
  }

  // ============================================================
  // SHINY DERROTADO
  // ============================================================

  async function handleDefeat(defeat) {
    if (
      !config.alerts.shinyDefeats ||
      !defeat?.name ||
      !hasCredentials()
    ) {
      return;
    }

    const eventTime =
      Number(
        defeat.detectedAt ||
        0
      );

    if (
      eventTime > 0 &&
      eventTime <
        SCRIPT_BOOT_TIME - 5000
    ) {
      return;
    }

    if (
      invalidPokemonName(
        defeat.name
      )
    ) {
      return;
    }

    if (
      !(
        defeat.isShiny === true ||
        /\bshiny\b/i.test(
          `${defeat.name} ${defeat.tier || ''}`
        )
      )
    ) {
      return;
    }

    const key =
      `defeat:${accountLabel}:${
        defeat.key ||
        [
          defeat.name,
          defeat.level,
          Math.floor(
            Number(
              defeat.detectedAt ||
              Date.now()
            ) / 3000
          )
        ].join('|')
      }`;

    const semanticKey =
      `defeat-semantic:${accountLabel}:${normalized(defeat.name)}:${defeat.level || ''}`;

    if (
      !eventIsFresh(
        semanticKey,
        60_000
      )
    ) {
      return;
    }

    if (
      !eventIsFresh(
        key,
        SEEN_MAX_AGE
      )
    ) {
      return;
    }

    const defeatTierKey =
      knownTier(
        `${defeat.tier || ''} ${defeat.quality || ''}`
      ) ||
      tierFromQuality(
        defeat.qualityValue ??
        defeat.qualityMultiplier ??
        defeat.qualityMult ??
        defeat.rarityMultiplier ??
        defeat.multiplier
      );

    const defeatTier =
      defeatTierKey
        ? displayTier(
            defeatTierKey
          )
        : '';

    const photo =
      await resolvePokemonImage(
        defeat.name,
        true,
        defeat.speciesId,
        defeat.looktype ||
        defeat.lookType
      );

    const accountName =
      getAccountName();

    const formattedTime =
      formatTime12h(
        defeat.detectedAt ||
        Date.now()
      );

    queueAlert({
      photo:
        photo ||
        clean(defeat.sprite),

      caption: [
        '<b>⚔️✨ SHINY DERROTADO</b>',

        `👤 Cuenta: <b>${escapeHtml(accountName)}</b>`,

        `🐾 Pokémon: <b>${escapeHtml(defeat.name)}</b>`,

        `🏷 Tier: <b>${escapeHtml(
          defeatTier ||
          defeat.tier ||
          defeat.quality ||
          'Sin tier'
        )}</b>`,

        `📈 Nivel: <b>${escapeHtml(
          defeat.level ??
          'No disponible'
        )}</b>`,

        `⭐ XP: <b>${escapeHtml(
          defeat.xp ??
          'No disponible'
        )}</b>`,

        `🕒 ${escapeHtml(formattedTime)}`
      ].join('\n')
    });
  }

  // ============================================================
  // QUEUES DEL LAUNCHER
  // ============================================================

  function attachQueue(
    name,
    handler
  ) {
    const queue =
      window[name];

    if (!Array.isArray(queue)) {
      return false;
    }

    const marker =
      `__pokeGridTelegram_${name}`;

    if (queue[marker]) {
      return true;
    }

    const originalPush =
      queue.push;

    Object.defineProperty(
      queue,
      marker,
      {
        value: true,
        configurable: false
      }
    );

    queue.push =
      function (...rows) {
        const result =
          originalPush.apply(
            this,
            rows
          );

        rows.forEach((row) =>
          Promise.resolve()
            .then(() => {
              const enriched =
                row &&
                typeof row ===
                  'object' &&
                !Array.isArray(row)
                  ? {
                      ...row,

                      source:
                        clean(
                          row.source
                        ) ||
                        name
                    }
                  : row;

              return handler(
                enriched
              );
            })
            .catch((error) => {
              console.warn(
                `[PokeGrid Telegram] ${name}`,
                error
              );
            })
        );

        return result;
      };

    return true;
  }

  // ============================================================
  // CAPTURE LOG DOM
  // ============================================================

  function watchCaptureDOM() {
    const rows = [
      ...document.querySelectorAll(
        '.clog-row'
      )
    ];

    for (const row of rows) {
      if (
        row.dataset.tgProcessed ===
        'true'
      ) {
        continue;
      }

      row.dataset.tgProcessed =
        'true';

      const name =
        clean(
          row.querySelector(
            '.clog-name'
          )?.textContent ||
          row.textContent
        );

      const meta =
        clean(
          row.querySelector(
            '.clog-meta'
          )?.textContent ||
          row.textContent
        );

      const level =
        firstNumber(
          row.querySelector(
            '.clog-lvl'
          )?.textContent
        );

      const iv =
        firstNumber(
          meta.match(
            /iv[^0-9]*([0-9]+)/i
          )?.[1]
        );

      const qualityVal =
        captureRowQuality(row);

      const shiny =
        /\bshiny\b/i.test(meta) ||
        row.classList.contains(
          'shiny'
        );

      if (name) {
        handleCapture({
          name,

          level,

          iv,

          quality:
            qualityVal !== null
              ? `x${qualityVal}`
              : '',

          isShiny:
            shiny,

          captureNumber:
            captureNumberFromRow(
              row
            ),

          _captureRow:
            row,

          source:
            'capture-log-dom',

          when:
            new Date()
              .toISOString()
        });
      }
    }
  }

  // ============================================================
  // DROPS
  // ============================================================

  function extractPokemonName(payload) {
    return clean(
      payload?.pokemonName ||
      payload?.pokeName ||
      payload?.speciesName ||
      payload?.pokemon?.name ||
      payload?.species?.name ||
      (
        typeof payload?.pokemon ===
          'string'
          ? payload.pokemon
          : ''
      ) ||
      payload?.displayName ||
      payload?.name
    );
  }

  function extractDrops(payload) {
    const results =
      new Map();

    const seen =
      new WeakSet();

    const add = (
      name,
      quantity,
      icon = '',
      itemId = null
    ) => {
      const cleanName =
        clean(name);

      const count =
        Number(
          String(
            quantity ?? 1
          ).replace(
            /[^0-9.-]/g,
            ''
          )
        ) || 1;

      if (
        !cleanName ||
        count <= 0
      ) {
        return;
      }

      const key =
        normalized(cleanName);

      const previous =
        results.get(key);

      results.set(
        key,
        {
          name:
            previous?.name ||
            cleanName,

          quantity:
            (
              previous?.quantity ||
              0
            ) + count,

          icon:
            previous?.icon ||
            clean(icon),

          itemId:
            previous?.itemId ||
            Number(itemId) ||
            null
        }
      );
    };

    const visit = (
      value,
      path = '',
      depth = 0
    ) => {
      if (
        value == null ||
        depth > 8
      ) {
        return;
      }

      const relevant =
        /drop|loot|item|reward|premio|objeto/i
          .test(path);

      if (Array.isArray(value)) {
        value
          .slice(0, 100)
          .forEach(
            (entry, index) =>
              visit(
                entry,
                `${path}.${index}`,
                depth + 1
              )
          );

        return;
      }

      if (
        typeof value !== 'object'
      ) {
        if (
          relevant &&
          typeof value === 'number'
        ) {
          const name =
            path
              .split('.')
              .at(-1);

          if (
            name &&
            !/id|quantity|amount|count|qty|price|value|gold|money|xp|experience|chance/i
              .test(name)
          ) {
            add(name, value);
          }
        }

        return;
      }

      if (seen.has(value)) {
        return;
      }

      seen.add(value);

      const item =
        value.item &&
        typeof value.item ===
          'object'
          ? value.item
          : {};

      const name =
        clean(
          value.itemName ||
          value.dropName ||
          value.lootName ||
          item.name ||
          (
            relevant
              ? (
                  value.name ||
                  value.label ||
                  value.title
                )
              : ''
          )
        );

      const quantity =
        value.quantity ??
        value.amount ??
        value.count ??
        value.qty ??
        value.total ??
        item.quantity ??
        1;

      const addedCurrent =
        relevant &&
        name &&
        !/pokemon|pokémon|experience|gold|money|xp/i
          .test(name);

      if (addedCurrent) {
        add(
          name,

          quantity,

          value.icon ||
          value.image ||
          value.sprite ||
          item.icon ||
          item.image,

          value.itemId ||
          value.id ||
          item.id ||
          item.itemId
        );
      }

      Object.entries(value)
        .slice(0, 100)
        .forEach(
          ([key, child]) => {
            if (
              addedCurrent &&
              key === 'item'
            ) {
              return;
            }

            if (
              [
                'pokemon',
                'species'
              ].includes(key) &&
              !/drop|loot/i.test(
                path
              )
            ) {
              return;
            }

            visit(
              child,

              path
                ? `${path}.${key}`
                : key,

              depth + 1
            );
          }
        );
    };

    visit(payload);

    return [
      ...results.values()
    ];
  }

  function dropMatches(drop) {
    const names =
      listFrom(
        config.drops.names
      );

    if (
      Number(
        drop.quantity || 0
      ) <
      config.drops.minQuantity
    ) {
      return false;
    }

    if (!names.length) {
      return true;
    }

    const name =
      normalized(drop.name);

    return names.some(
      (allowed) =>
        name === allowed ||
        name.includes(allowed)
    );
  }

  async function handleDrops(
    drops,
    context = {}
  ) {
    if (
      !config.alerts.drops ||
      !hasCredentials()
    ) {
      return;
    }

    const filtered =
      drops.filter(
        dropMatches
      );

    if (!filtered.length) {
      return;
    }

    const pokemonName =
      clean(
        context.pokemonName ||
        currentOpponentName()
      );

    const accountName =
      getAccountName();

    const formattedTime =
      formatTime12h(
        Date.now()
      );

    const source =
      clean(context.source) ||
      'unknown';

    for (
      const drop
      of filtered
    ) {
      if (
        isCrossRouteDropDuplicate(
          drop,
          {
            ...context,
            pokemonName,
            source
          }
        )
      ) {
        continue;
      }

      const dropKey =
        context.killId
          ? `drop:${accountLabel}:${source}:${context.killId}:${normalized(drop.name)}:${drop.quantity}`
          : `drop:${accountLabel}:${source}:${pokemonName}:${normalized(drop.name)}:${drop.quantity}:${Math.floor(Date.now() / 3000)}`;

      if (
        !eventIsFresh(
          dropKey,

          context.killId
            ? SEEN_MAX_AGE
            : 5_000
        )
      ) {
        continue;
      }

      const photo =
        await resolveDropImage(
          drop
        );

      queueAlert({
        photo,

        caption: [
          '<b>🎁 DROP OBTENIDO</b>',

          `👤 Cuenta: <b>${escapeHtml(accountName)}</b>`,

          pokemonName
            ? `🐾 Derrotado: <b>${escapeHtml(pokemonName)}</b>`
            : '',

          `📦 <b>${escapeHtml(drop.name)}</b> × ${escapeHtml(drop.quantity)}`,

          `🕒 ${escapeHtml(formattedTime)}`
        ]
          .filter(Boolean)
          .join('\n')
      });
    }
  }

  function currentOpponentName() {
    const selectors = [
      '.battle-enemy-name',
      '.battle-opponent-name',
      '.field-pokemon-name',
      '.pokemon-enemy .name',
      '[data-pokemon-name]'
    ];

    for (
      const selector
      of selectors
    ) {
      const element =
        document.querySelector(
          selector
        );

      const value =
        clean(
          element?.dataset
            ?.pokemonName ||
          element?.textContent
        );

      if (value) {
        return value;
      }
    }

    return '';
  }

  function absoluteStockIcon(value) {
    const icon = clean(value);

    if (!icon) return '';
    if (/^(?:https?:|data:)/i.test(icon)) {
      return icon;
    }
    if (icon.startsWith('/')) {
      return `${GAME_ORIGIN}${icon}`;
    }

    return `${GAME_ORIGIN}/assets/items/${icon}`;
  }

  function handleBallsStockPayload(payload) {
    const catalog = Array.isArray(payload?.catalog)
      ? payload.catalog
      : [];
    const counts =
      payload?.counts &&
      typeof payload.counts === 'object'
        ? payload.counts
        : {};
    const next = new Map();

    catalog.forEach((ball) => {
      const name = clean(ball?.name);
      const quantity = stockQuantity(
        counts[String(ball?.id)] ??
        counts[ball?.id] ??
        0
      );

      if (!name || quantity === null) return;

      next.set(normalized(name), {
        name,
        quantity,
        icon: absoluteStockIcon(
          ball.iconUrl || ball.icon
        )
      });
    });

    if (next.size) {
      socketStock.balls = next;
      checkConsumableStock(false);
    }
  }

  async function handleInventoryStockPayload(payload) {
    const rows = Array.isArray(payload?.items)
      ? payload.items
      : [];
    const quantities = new Map();

    rows.forEach((row) => {
      const id = Number(
        row?.itemId ?? row?.id
      );
      const quantity = stockQuantity(
        row?.quantity ??
        row?.qty ??
        row?.count ??
        0
      );

      if (
        Number.isFinite(id) &&
        id > 0 &&
        quantity !== null
      ) {
        quantities.set(id, quantity);
      }
    });

    let catalog = [];

    try {
      catalog = await itemCatalog();
    } catch {}

    const next = new Map();

    catalog
      .filter((item) =>
        normalized(item?.name).includes('potion')
      )
      .forEach((item) => {
        const id = Number(
          item?.id ?? item?.itemId
        );
        const name = clean(item?.name);

        if (!name || !Number.isFinite(id)) return;

        next.set(normalized(name), {
          name,
          quantity: quantities.get(id) ?? 0,
          icon: absoluteStockIcon(
            item.iconUrl ||
            item.icon ||
            item.image
          )
        });
      });

    if (next.size) {
      socketStock.potions = next;
      checkConsumableStock(false);
    }
  }

  function attachStockSocket(socketContext) {
    if (
      window.__pokeGridTelegramStockUnsubscribe ||
      !socketContext ||
      typeof socketContext.subscribe !== 'function' ||
      typeof socketContext.send !== 'function'
    ) {
      return Boolean(
        window.__pokeGridTelegramStockUnsubscribe
      );
    }

    try {
      const unsubscribeInventory =
        socketContext.subscribe(
          'inventory',
          handleInventoryStockPayload
        );
      const unsubscribeBalls =
        socketContext.subscribe(
          'balls',
          handleBallsStockPayload
        );

      window.__pokeGridTelegramStockUnsubscribe =
        () => {
          if (typeof unsubscribeInventory === 'function') {
            unsubscribeInventory();
          }
          if (typeof unsubscribeBalls === 'function') {
            unsubscribeBalls();
          }
        };

      window.__pokeGridTelegramStockRefresh =
        () => {
          stockSocketRequestAt = Date.now();
          socketContext.send({ type: 'inv-get' });
          socketContext.send({ type: 'balls-get' });
        };

      window.__pokeGridTelegramStockRefresh();
      return true;
    } catch (error) {
      console.warn(
        '[PokeGrid Telegram] No se pudo suscribir al inventario del juego.',
        error
      );
      return false;
    }
  }

  function requestSocketStock() {
    if (
      typeof window.__pokeGridTelegramStockRefresh ===
        'function' &&
      Date.now() - stockSocketRequestAt >= 10_000
    ) {
      try {
        window.__pokeGridTelegramStockRefresh();
      } catch {}
    }
  }

  function subscribeToFieldKills() {
    const root =
      document.querySelector(
        '.game-root'
      ) ||
      document.querySelector(
        '#root'
      );

    if (!root) {
      return false;
    }

    let socketContext = null;

    const seen =
      new WeakSet();

    let inspected = 0;

    const inspect = (
      value,
      depth = 0
    ) => {
      if (
        socketContext ||
        !value ||
        typeof value !== 'object' ||
        value instanceof Node ||
        seen.has(value) ||
        depth > 7 ||
        inspected > 40_000
      ) {
        return;
      }

      seen.add(value);
      inspected += 1;

      if (
        typeof value.subscribe ===
        'function' &&
        (
          typeof value.requestPokes ===
            'function' ||
          typeof value.send ===
            'function'
        )
      ) {
        socketContext = value;
        return;
      }

      if (Array.isArray(value)) {
        value
          .slice(0, 120)
          .forEach(
            (child) =>
              inspect(
                child,
                depth + 1
              )
          );

        return;
      }

      Object.entries(value)
        .slice(0, 70)
        .forEach(
          ([key, child]) => {
            if (
              /^(return|child|sibling|stateNode|alternate|_owner|queue|nextEffect)$/i
                .test(key)
            ) {
              return;
            }

            inspect(
              child,
              depth + 1
            );
          }
        );
    };

    [
      root,
      ...root.querySelectorAll('*')
    ]
      .slice(0, 5000)
      .forEach((element) => {
        if (socketContext) {
          return;
        }

        Object.keys(element)
          .filter(
            (key) =>
              /^__react(?:Fiber|Container|Props)/
                .test(key)
          )
          .forEach((key) => {
            if (
              key.startsWith(
                '__reactProps'
              )
            ) {
              inspect(
                element[key],
                0
              );
            }

            let fiber =
              element[key];

            if (fiber?.current) {
              fiber =
                fiber.current;
            }

            for (
              let depth = 0;
              fiber &&
              depth < 45 &&
              !socketContext;
              depth += 1,
              fiber = fiber.return
            ) {
              inspect(
                fiber.memoizedProps,
                0
              );

              inspect(
                fiber.memoizedState,
                0
              );

              inspect(
                fiber.dependencies
                  ?.firstContext
                  ?.context
                  ?._currentValue,
                0
              );

              inspect(
                fiber.dependencies
                  ?.firstContext
                  ?.context
                  ?._currentValue2,
                0
              );
            }
          });
      });

    if (!socketContext) {
      return false;
    }

    attachStockSocket(socketContext);

    try {
      const unsubscribe =
        socketContext.subscribe(
          'field-kill',
          (payload) => {
            const drops =
              extractDrops(
                payload
              );

            if (drops.length) {
              handleDrops(
                drops,
                {
                  killId:
                    clean(
                      payload?.killId ||
                      payload?.id
                    ),

                  pokemonName:
                    extractPokemonName(
                      payload
                    ),

                  speciesId:
                    Number(
                      payload?.speciesId ||
                      payload?.pokemon
                        ?.speciesId
                    ) ||
                    null,

                  isShiny:
                    payload?.shiny ===
                      true ||
                    payload?.isShiny ===
                      true,

                  source:
                    'field-kill'
                }
              );
            }
          }
        );

      if (
        typeof unsubscribe !==
        'function'
      ) {
        return false;
      }

      window
        .__pokeGridTelegramFieldKillUnsubscribe =
        unsubscribe;

      return true;
    } catch {
      return false;
    }
  }

  function scanHuntDrops() {
    const rows = [
      ...document.querySelectorAll(
        '.ha-drop'
      )
    ];

    for (const row of rows) {
      const name =
        clean(
          row.querySelector(
            '.ha-drop-name'
          )?.textContent
        );

      const quantityText =
        clean(
          row.querySelector(
            '.ha-drop-qty'
          )?.textContent
        );

      const quantity =
        Number(
          quantityText.replace(
            /[^0-9.-]/g,
            ''
          )
        );

      if (
        !name ||
        !Number.isFinite(
          quantity
        )
      ) {
        continue;
      }

      const key =
        normalized(name);

      if (
        !huntDropTotals.has(key)
      ) {
        huntDropTotals.set(
          key,
          quantity
        );

        continue;
      }

      const previous =
        huntDropTotals.get(key);

      huntDropTotals.set(
        key,
        quantity
      );

      if (
        quantity > previous
      ) {
        handleDrops(
          [
            {
              name,
              quantity:
                quantity -
                previous
            }
          ],
          {
            pokemonName:
              currentOpponentName(),

            killId:
              `hunt:${key}:${quantity}`,

            source:
              'hunt-analyzer'
          }
        );
      }
    }
  }

  // ============================================================
  // INICIALIZACIÓN
  // ============================================================

  async function initialize() {
    await loadConfig();

    createInterface();

    window
      .__pokeGridTelegramCaptureBridgeQueue ||=
      [];

    if (
      Array.isArray(
        window.__pokeGridCaptureQueue
      )
    ) {
      window
        .__pokeGridCaptureQueue
        .length = 0;
    }

    if (
      Array.isArray(
        window.__pokeGridDefeatQueue
      )
    ) {
      window
        .__pokeGridDefeatQueue
        .length = 0;
    }

    if (
      Array.isArray(
        window
          .__pokeGridTelegramCaptureBridgeQueue
      )
    ) {
      window
        .__pokeGridTelegramCaptureBridgeQueue
        .length = 0;
    }

    const queueRetry =
      window.setInterval(
        () => {
          const capturesReady =
            attachQueue(
              '__pokeGridCaptureQueue',
              handleCapture
            );

          const defeatsReady =
            attachQueue(
              '__pokeGridDefeatQueue',
              handleDefeat
            );

          const bridgeReady =
            attachQueue(
              '__pokeGridTelegramCaptureBridgeQueue',
              handleCapture
            );

          if (
            capturesReady &&
            defeatsReady &&
            bridgeReady
          ) {
            window.clearInterval(
              queueRetry
            );
          }
        },
        500
      );

    window.setTimeout(
      () =>
        window.clearInterval(
          queueRetry
        ),
      120_000
    );

    let fieldKillsReady = false;

    try {
      fieldKillsReady =
        subscribeToFieldKills();
    } catch (error) {
      console.warn(
        '[PokeGrid Telegram] La suscripción de drops no estuvo disponible durante el arranque.',
        error
      );
    }

    if (!fieldKillsReady) {
      const socketRetry =
        window.setInterval(
          () => {
            let subscribed = false;

            try {
              subscribed =
                subscribeToFieldKills();
            } catch {}

            if (subscribed) {
              window.clearInterval(
                socketRetry
              );
            }
          },
          2500
        );

      window.setTimeout(
        () =>
          window.clearInterval(
            socketRetry
          ),
        120_000
      );
    }

    window.setInterval(
      scanHuntDrops,
      DROP_SCAN_MS
    );

    window.setInterval(
      watchCaptureDOM,
      1000
    );

    window.setInterval(
      () =>
        loadConfig(false),
      CONFIG_REFRESH_MS
    );

    // Solo consulta actualizaciones del bot. Los precios del Market
    // se solicitan exclusivamente al recibir un comando o callback.
    pollTelegramBotCommands();
    window.setInterval(
      pollTelegramBotCommands,
      TELEGRAM_COMMAND_POLL_MS
    );

    // Lectura continua de Poké Balls y pociones.
    watchConsumableStockDOM();
    checkConsumableStock();

    window.setInterval(
      checkConsumableStock,
      1_000
    );

    window.__pokeGridTelegramAlerts =
      Object.freeze({
        account: {
          ...account,
          label: accountLabel
        },

        reload:
          () =>
            loadConfig(true),

        test:
          () =>
            testBotFromPanel(),

        pollCommands:
          () =>
            pollTelegramBotCommands(),

        findMarketItem:
          async (query) => {
            const matches = await findMarketCatalogItems(query);
            return matches[0] || null;
          },

        previewPokemonImage:
          (
            name,
            speciesId,
            looktype
          ) =>
            resolvePokemonImage(
              name,
              false,
              speciesId,
              looktype
            ),

        previewDropImage:
          (value) =>
            resolveDropImage(
              value
            ),

        readStock:
          () => ({
            balls: [
              ...readBallStock().values()
            ],
            potions: [
              ...readPotionStock().values()
            ]
          }),

        checkStock:
          () => checkConsumableStock(),

        matchesCaptureFilter:
          (value) =>
            captureMatchesFilters(
              value
            ),

        tierForQuality:
          (value) =>
            tierFromQuality(
              value
            ),

        simulateCapture:
          (value) =>
            handleCapture(
              value
            ),

        simulateDefeat:
          (value) =>
            handleDefeat(
              value
            ),

        simulateDrops:
          (
            value,
            context
          ) =>
            handleDrops(
              value,
              context
            )
      });
  }

  initialize()
    .catch((error) =>
      console.error(
        '[PokeGrid Telegram] No se pudo iniciar.',
        error
      )
    );

})();
