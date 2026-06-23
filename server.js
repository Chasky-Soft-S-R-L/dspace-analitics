'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = 4000;

// ─── Rutas de archivos ─────────────────────────────────────────────────────
const HTML_PATH = path.join(__dirname, 'index.html');
const REPO_PATH = path.join(__dirname, 'repositorio.json');
const META_PATH = path.join(__dirname, 'metadata.json');

// ─── DSpace 7 API ──────────────────────────────────────────────────────────
const DSPACE_BASE = 'https://repositorio.unas.edu.pe/server/api';
const SEARCH_URL  = `${DSPACE_BASE}/discover/search/objects`;
const ITEMS_URL   = `${DSPACE_BASE}/core/items`;
const PAGE_SIZE   = 100;

// ─── Agentes HTTP con Keep-Alive (reutiliza conexiones TCP) ───────────────
const httpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, timeout: 20000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, timeout: 20000 });

function agentFor(url) {
  return url.startsWith('https') ? httpsAgent : httpAgent;
}

// ─── Parámetros de concurrencia ────────────────────────────────────────────
const FETCH_TIMEOUT       = 20000;  // ms por request
const PAGES_CONCURRENCY   = 8;      // páginas DSpace en paralelo
const ITEMS_CONCURRENCY   = 30;     // items mapeados en paralelo
const RETRY_ATTEMPTS      = 3;
const RETRY_BASE_DELAY_MS = 600;

// ─── Estado en memoria ─────────────────────────────────────────────────────
let syncAbortFlag = false;

// ─── Cache de comunidades/colecciones (en memoria, persiste entre syncs) ──
const collectionCache = new Map();

// ─── Cache del repositorio en RAM ─────────────────────────────────────────
let repoCache = null;
function getRepo()     { if (!repoCache) repoCache = readJSON(REPO_PATH, []); return repoCache; }
function setRepo(data) { repoCache = data; writeJSON(REPO_PATH, data); }

// ─── Mapeo de tipos DSpace ─────────────────────────────────────────────────
const TYPE_MAP = {
  'info:eu-repo/semantics/bachelorThesis':   'Tesis de Pregrado',
  'info:eu-repo/semantics/masterThesis':     'Tesis de Maestría',
  'info:eu-repo/semantics/doctoralThesis':   'Tesis Doctoral',
  'info:eu-repo/semantics/article':          'Artículo Científico',
  'info:eu-repo/semantics/conferenceObject': 'Conferencia',
  'info:eu-repo/semantics/report':           'Informe',
  'info:eu-repo/semantics/book':             'Libro',
  'info:eu-repo/semantics/bookPart':         'Capítulo de Libro',
  'info:eu-repo/semantics/workingPaper':     'Documento de Trabajo',
  'info:eu-repo/semantics/other':            'Otro',
};
function normalizeType(raw) {
  if (!raw) return '';
  if (TYPE_MAP[raw]) return TYPE_MAP[raw];
  const parts = raw.split('/');
  const last  = parts[parts.length - 1] || raw;
  return last.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

// ─── Helpers de persistencia ───────────────────────────────────────────────
function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return fallback; }
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8'); // sin indent = más rápido
}

// ─── Helper: fetch con reintentos y keep-alive ─────────────────────────────
async function fetchWithRetry(url, opts = {}) {
  const options = {
    timeout: FETCH_TIMEOUT,
    agent:   agentFor(url),
    headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate', ...(opts.headers || {}) },
    ...opts,
  };
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, options);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      } else throw e;
    }
  }
}

// ─── Helpers de metadata ───────────────────────────────────────────────────
function getMeta(metaObj, ...keys) {
  for (const key of keys) {
    const arr = metaObj[key];
    if (Array.isArray(arr) && arr.length > 0)
      return arr.map(e => (e.value || '').trim()).filter(Boolean).join('; ');
  }
  return '';
}
function getMetaFirst(metaObj, ...keys) {
  for (const key of keys) {
    const arr = metaObj[key];
    if (Array.isArray(arr) && arr.length > 0) return (arr[0].value || '').trim();
  }
  return '';
}

// ─── Comunidad/colección con caché ────────────────────────────────────────
const collectionInflight = new Map();

async function fetchCommunityCollection(owningCollectionHref) {
  if (!owningCollectionHref) return { collection: '', community: '' };
  if (collectionCache.has(owningCollectionHref)) return collectionCache.get(owningCollectionHref);
  if (collectionInflight.has(owningCollectionHref)) return collectionInflight.get(owningCollectionHref);

  const promise = (async () => {
    try {
      const r = await fetchWithRetry(`${owningCollectionHref}?embed=parentCommunity`);
      const d = await r.json();
      const result = {
        collection: (d.name || '').trim(),
        community:  d._embedded?.parentCommunity?.name?.trim() || '',
      };
      collectionCache.set(owningCollectionHref, result);
      return result;
    } catch (_) {
      return { collection: '', community: '' };
    } finally {
      collectionInflight.delete(owningCollectionHref);
    }
  })();

  collectionInflight.set(owningCollectionHref, promise);
  return promise;
}

// ─── Obtener URL del PDF principal ────────────────────────────────────────
async function fetchPdfUrl(uuid) {
  try {
    const r = await fetchWithRetry(
      `${ITEMS_URL}/${uuid}/bundles?size=10&embed=bitstreams`,
      { timeout: 12000 }
    );
    const bd = await r.json();
    const bundles  = bd?._embedded?.bundles || [];
    const original = bundles.find(b => b.name === 'ORIGINAL');
    if (!original) return null;

    let bitstreams = original?._embedded?.bitstreams?._embedded?.bitstreams || [];

    if (!bitstreams.length) {
      const bsHref = original?._links?.bitstreams?.href;
      if (!bsHref) return null;
      const bsr = await fetchWithRetry(`${bsHref}?size=10`, { timeout: 10000 });
      const bsd = await bsr.json();
      bitstreams = bsd?._embedded?.bitstreams || [];
    }

    const pdf = bitstreams.find(b => (b.name || '').toLowerCase().endsWith('.pdf')) || bitstreams[0];
    if (!pdf) return null;
    return {
      name:          pdf.name || 'documento.pdf',
      size:          pdf.sizeBytes || 0,
      downloadUrl:   `https://repositorio.unas.edu.pe/bitstreams/${pdf.uuid}/download`,
      bitstreamUuid: pdf.uuid || '',
      contentUrl:    `https://repositorio.unas.edu.pe/server/api/core/bitstreams/${pdf.uuid}/content`,
    };
  } catch (_) { return null; }
}

// ─── Mapeo principal de un objeto DSpace ──────────────────────────────────
async function mapRecord(dspaceItem) {
  let meta     = dspaceItem.metadata || {};
  const uuid   = dspaceItem.uuid || dspaceItem.id || '';
  const handle = dspaceItem.handle || '';

  let titleRaw = getMetaFirst(meta, 'dc.title');
  const needsExtraFetch = !titleRaw && !!uuid;
  const colHref = dspaceItem._links?.owningCollection?.href;

  const [ccResult, pdfData, extraMeta] = await Promise.all([
    colHref ? fetchCommunityCollection(colHref) : Promise.resolve({ collection: '', community: '' }),
    uuid    ? fetchPdfUrl(uuid).catch(() => null) : Promise.resolve(null),
    needsExtraFetch
      ? fetchWithRetry(`${ITEMS_URL}/${uuid}`, { timeout: FETCH_TIMEOUT })
          .then(r => r.json()).then(d => d?.metadata || null).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (extraMeta) { meta = extraMeta; titleRaw = getMetaFirst(meta, 'dc.title'); }

  const title       = titleRaw;
  const authors     = getMeta(meta, 'dc.contributor.author', 'dc.creator', 'dc.contributor');
  const advisors    = getMeta(meta, 'dc.contributor.advisor');
  const date        = getMetaFirst(meta, 'dc.date.issued', 'dc.date.available', 'dc.date.accessioned', 'dc.date');
  const typeRaw     = getMetaFirst(meta, 'dc.type', 'dc.description.uri', 'thesis.degree.level');
  const type        = normalizeType(typeRaw) || typeRaw;
  const abstract    = getMetaFirst(meta, 'dc.description.abstract', 'dc.description');
  const language    = getMetaFirst(meta, 'dc.language.iso', 'dc.language');
  const topics      = getMeta(meta, 'dc.subject');
  const publisher   = getMetaFirst(meta, 'dc.publisher');
  const degree      = getMetaFirst(meta, 'thesis.degree.name', 'thesis.degree.discipline');
  const degreeLevel = getMetaFirst(meta, 'thesis.degree.level');
  const url         = handle
    ? `https://repositorio.unas.edu.pe/handle/${handle}`
    : `https://repositorio.unas.edu.pe/server/api/core/items/${uuid}`;

  const pdfUrl = pdfData?.bitstreamUuid
    ? `https://repositorio.unas.edu.pe/server/api/core/bitstreams/${pdfData.bitstreamUuid}/content`
    : '';

  return { uuid, title, authors, advisors, date, type,
           community: ccResult.community, collection: ccResult.collection,
           abstract, language, topics, publisher, degree, degreeLevel, url, pdfUrl };
}

// ─── Extraer items de respuesta DSpace ────────────────────────────────────
function extractItemsFromSearch(data) {
  try {
    const objs = data._embedded.searchResult._embedded.objects;
    return objs.map(o => o._embedded?.indexableObject || null).filter(Boolean);
  } catch (_) {
    try { return data._embedded.objects.map(o => o._embedded?.indexableObject || o).filter(Boolean); }
    catch (__) { return []; }
  }
}
function getTotalPages(data) {
  try {
    const page = data._embedded?.searchResult?.page || data.page || {};
    const total = page.totalElements || page.totalPages * PAGE_SIZE || 0;
    return { totalPages: Math.ceil(total / PAGE_SIZE), totalElements: total };
  } catch (_) { return { totalPages: 1, totalElements: 0 }; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Pool de concurrencia genérico ────────────────────────────────────────
async function pLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await tasks[i](); }
      catch (e) { results[i] = null; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/',         (_req, res) => res.sendFile(HTML_PATH));
app.get('/health',   (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/metadata', (_req, res) => res.json(readJSON(META_PATH, {})));
app.get('/data', (req, res) => {
  const repo   = getRepo();
  const fields = req.query.fields ? req.query.fields.split(',').map(f => f.trim()) : null;

  let payload;
  if (fields && fields.length > 0) {
    payload = JSON.stringify(repo.map(r => {
      const o = {};
      fields.forEach(f => { if (r[f] !== undefined) o[f] = r[f]; });
      return o;
    }));
  } else {
    payload = JSON.stringify(repo);
  }

  // Enviar Content-Length para que el cliente pueda mostrar progreso real de descarga
  res.setHeader('Content-Type',   'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload, 'utf8'));
  res.end(payload);
});

// ─── GET /thumb/:uuid ──────────────────────────────────────────────────────
app.get('/thumb/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) return res.status(400).json({ error: 'UUID inválido' });
  try {
    const r = await fetchWithRetry(`${ITEMS_URL}/${uuid}/thumbnail`, { timeout: 10000 });
    if (r.status === 204) return res.status(404).json({ error: 'Sin miniatura' });
    const d = await r.json();
    const contentUrl = d?._links?.content?.href;
    if (!contentUrl) return res.status(404).json({ error: 'Sin URL de contenido' });
    res.redirect(302, contentUrl);
  } catch (e) { res.status(503).json({ error: 'Error al obtener miniatura', detail: e.message }); }
});

// ─── GET /pdf/:uuid ────────────────────────────────────────────────────────
app.get('/pdf/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) return res.status(400).json({ error: 'UUID inválido' });
  try {
    const pdf = await fetchPdfUrl(uuid);
    if (!pdf) return res.status(404).json({ error: 'Sin PDF disponible' });
    res.json(pdf);
  } catch (e) { res.status(503).json({ error: 'Error al obtener PDF', detail: e.message }); }
});

// ─── POST /sync/stop ───────────────────────────────────────────────────────
app.post('/sync/stop', (_req, res) => {
  syncAbortFlag = true;
  const meta = readJSON(META_PATH, {});
  if (meta.syncState) meta.syncState.status = 'paused';
  writeJSON(META_PATH, meta);
  res.json({ ok: true, message: 'Sincronización pausada.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── POST /sync/start  (SSE streaming — algoritmo optimizado v3)  ─────────
//
//  OPTIMIZACIONES MODO 'new' y 'date':
//  ─────────────────────────────────────────────────────────────────────────
//  MODO 'new':
//    • Ordena por dc.date.accessioned DESC → los items más recientes primero
//    • Para en cuanto encuentra STOP_AFTER_CONSECUTIVE_KNOWN UUIDs seguidos
//      ya presentes en repoMap (early-exit real, no recorre todo el repositorio)
//
//  MODO 'date':
//    • Usa filtro nativo de DSpace: f.dateIssued=[FROM_TO] en la URL
//    • DSpace devuelve SOLO los items del rango → 0 páginas innecesarias
//    • Ordena por dc.date.issued DESC para procesar los más recientes primero
//
//  MODO 'all':
//    • Sin cambios — pipeline solapado completo como antes
// ═══════════════════════════════════════════════════════════════════════════

// Cuántos UUIDs conocidos consecutivos detienen el modo 'new'
const STOP_AFTER_CONSECUTIVE_KNOWN = 3;

app.post('/sync/start', async (req, res) => {
  const mode     = req.body?.mode     || 'all';
  const fromDate = req.body?.fromDate || null;  // 'YYYY-MM-DD'
  const toDate   = req.body?.toDate   || null;  // 'YYYY-MM-DD'

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  function send(obj) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} }

  // ── Leer / inicializar metadata ────────────────────────────────────────
  let meta = readJSON(META_PATH, {
    lastSync: null, total: 0, newRecords: 0, updatedRecords: 0,
    syncState: { status: 'idle', currentPage: 0, totalPages: 0, processed: 0 },
  });

  const isPaused  = (mode === 'all') && meta.syncState?.status === 'paused';
  const startPage = isPaused ? (meta.syncState?.currentPage || 0) : 0;

  syncAbortFlag = false;

  meta.syncState = {
    status:      'syncing',
    currentPage: startPage,
    totalPages:  meta.syncState?.totalPages || 0,
    processed:   isPaused ? (meta.syncState?.processed || 0) : 0,
  };
  writeJSON(META_PATH, meta);

  let repo      = getRepo();
  const repoMap = new Map(repo.map(r => [r.uuid, r]));
  let newCount  = 0;
  let updCount  = 0;

  // ── Etiqueta de inicio ─────────────────────────────────────────────────
  const startLabels = {
    all:  isPaused ? 'Reanudando sincronización completa…' : 'Iniciando sincronización completa (modo turbo)…',
    new:  'Buscando registros nuevos (orden: más reciente primero, early-exit)…',
    date: `Sincronizando por rango de fechas ${fromDate}${toDate ? ' → ' + toDate : ''} (filtro DSpace nativo)…`,
  };
  send({ type: 'start', message: startLabels[mode] || 'Iniciando sincronización…' });

  // ══════════════════════════════════════════════════════════════════════
  //  CONSTRUCTOR DE URL DE BÚSQUEDA según modo
  // ══════════════════════════════════════════════════════════════════════
  function buildSearchUrl(page) {
    const base = `${SEARCH_URL}?scope=&query=&page=${page}&size=${PAGE_SIZE}`;

    if (mode === 'new') {
      // Más recientes primero → early-exit en cuanto aparezcan UUIDs conocidos
      return `${base}&sort=dc.date.accessioned%2CDESC`;
    }

    if (mode === 'date' && fromDate) {
      // ── Filtro nativo DSpace 7: f.dateIssued ──────────────────────────
      // Formato: [YYYY-MM-DD TO YYYY-MM-DD]  (corchetes = rango inclusivo)
      // DSpace acepta también [YYYY-01-01 TO 2099-12-31] para "desde"
      const from = fromDate;
      const to   = toDate || '2099-12-31';
      const filterVal = encodeURIComponent(`[${from} TO ${to}]`);
      return `${base}&f.dateIssued=${filterVal},equals&sort=dc.date.issued%2CDESC`;
    }

    // Modo 'all' — orden por score como antes
    return `${base}&sort=score%2CDESC`;
  }

  // ── Helper: fetch de una página DSpace ────────────────────────────────
  async function fetchPage(p) {
    const url = buildSearchUrl(p);
    try {
      const r = await fetchWithRetry(url);
      return await r.json();
    } catch (e) {
      send({ type: 'warn', message: `Página ${p + 1} omitida: ${e.message}` });
      return null;
    }
  }

  // ── Helper: guardar estado y notificar progreso ────────────────────────
  let lastSaveTs = 0;
  function saveAndNotify(p, totalPages, totalElements, force = false) {
    const now = Date.now();
    if (force || now - lastSaveTs > 3000) {
      repo = Array.from(repoMap.values());
      meta.syncState.currentPage = p + 1;
      meta.total = repo.length;
      if (mode === 'all')  { meta.newRecords = newCount; meta.updatedRecords = updCount; }
      else if (mode === 'new')  { meta.totalNew = newCount; }
      else if (mode === 'date') { meta.totalDate = newCount + updCount; }
      setRepo(repo);
      writeJSON(META_PATH, meta);
      lastSaveTs = now;
    }
    const pct = totalPages > 0 ? Math.round(((p + 1) / totalPages) * 100) : 0;
    send({
      type: 'progress', page: p + 1, totalPages,
      processed: meta.syncState.processed,
      totalElements, newCount, updCount, pct,
      message: `Página ${p + 1}/${totalPages} · ${(newCount + updCount).toLocaleString()} procesados`,
    });
  }

  // ── Núcleo: procesar un array de items (modo 'all' y 'date') ──────────
  async function processItems(items) {
    if (!items.length) return;

    const tasks = items.map(item => async () => {
      if (syncAbortFlag) return null;
      return mapRecord(item).catch(() => null);
    });

    const records = await pLimit(tasks, ITEMS_CONCURRENCY);

    for (const record of records) {
      if (!record?.uuid) continue;
      if (repoMap.has(record.uuid)) { repoMap.set(record.uuid, record); updCount++; }
      else                          { repoMap.set(record.uuid, record); newCount++; }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MODO 'new' — Early-exit: procesa página a página en orden DESC,
  //  para en cuanto encuentra STOP_AFTER_CONSECUTIVE_KNOWN UUIDs conocidos
  //  consecutivos (señal de que ya alcanzamos el límite de lo nuevo).
  // ══════════════════════════════════════════════════════════════════════
  async function runNewMode(firstData, totalPages, totalElements) {
    let consecutiveKnown = 0;
    let earlyExit        = false;

    async function processPageNew(items) {
      for (const item of items) {
        if (syncAbortFlag || earlyExit) break;
        if (!item?.uuid) continue;

        meta.syncState.processed++;

        if (repoMap.has(item.uuid)) {
          consecutiveKnown++;
          if (consecutiveKnown >= STOP_AFTER_CONSECUTIVE_KNOWN) {
            earlyExit = true;
            break;
          }
          continue; // ya lo tenemos, no mapear
        }

        // UUID nuevo → mapear y guardar
        consecutiveKnown = 0;
        const record = await mapRecord(item).catch(() => null);
        if (record?.uuid) {
          repoMap.set(record.uuid, record);
          newCount++;
        }
      }
    }

    // Primera página
    await processPageNew(extractItemsFromSearch(firstData));
    saveAndNotify(0, totalPages, totalElements);

    // Páginas siguientes (secuencial para respetar el early-exit)
    for (let p = 1; p < totalPages && !earlyExit && !syncAbortFlag; p++) {
      const data = await fetchPage(p);
      if (!data) continue;
      const items = extractItemsFromSearch(data);
      await processPageNew(items);
      saveAndNotify(p, totalPages, totalElements);
    }

    return earlyExit;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MODO 'date' — DSpace ya filtra por fecha en la query.
  //  Solo procesamos las páginas que devuelve DSpace (pueden ser pocas).
  //  Pipeline solapado igual que 'all' para máxima velocidad.
  // ══════════════════════════════════════════════════════════════════════
  async function runDateMode(firstData, totalPages, totalElements) {
    // Primera página
    const firstItems = extractItemsFromSearch(firstData);
    meta.syncState.processed += firstItems.length;
    await processItems(firstItems);
    saveAndNotify(0, totalPages, totalElements);

    // Resto — pipeline solapado
    for (let p = 1; p < totalPages; p += PAGES_CONCURRENCY) {
      if (syncAbortFlag) break;

      const pageNums = [];
      for (let k = p; k < Math.min(p + PAGES_CONCURRENCY, totalPages); k++) pageNums.push(k);

      const pageDatas = await Promise.all(pageNums.map(n => fetchPage(n)));

      const allItems = [];
      for (const pageData of pageDatas) {
        if (!pageData) continue;
        const items = extractItemsFromSearch(pageData);
        meta.syncState.processed += items.length;
        allItems.push(...items);
      }

      await processItems(allItems);
      saveAndNotify(pageNums[pageNums.length - 1], totalPages, totalElements);
    }
  }

  try {
    // ── 1. Obtener primera página ──────────────────────────────────────
    const firstData = await fetchPage(startPage);
    if (!firstData) throw new Error('No se pudo conectar con DSpace. Verifica la red.');

    const { totalPages, totalElements } = getTotalPages(firstData);
    meta.syncState.totalPages = totalPages;
    writeJSON(META_PATH, meta);

    send({
      type: 'info',
      message: `DSpace: ${totalElements.toLocaleString()} registros · ${totalPages} páginas`
        + (mode === 'date' ? ' (filtrado por DSpace — solo el rango solicitado)' : '')
        + (mode === 'new'  ? ' (orden: más reciente primero · early-exit activado)' : ''),
    });

    // ── 2. Ejecutar según modo ─────────────────────────────────────────
    let earlyExitTriggered = false;

    if (mode === 'new') {
      earlyExitTriggered = await runNewMode(firstData, totalPages, totalElements);

    } else if (mode === 'date') {
      await runDateMode(firstData, totalPages, totalElements);

    } else {
      // ── Modo 'all' — pipeline solapado completo ──────────────────────
      const firstItems = extractItemsFromSearch(firstData);
      meta.syncState.processed += firstItems.length;
      await processItems(firstItems);
      saveAndNotify(startPage, totalPages, totalElements);

      if (!syncAbortFlag) {
        for (let p = startPage + 1; p < totalPages; p += PAGES_CONCURRENCY) {
          if (syncAbortFlag) break;

          const pageNums = [];
          for (let k = p; k < Math.min(p + PAGES_CONCURRENCY, totalPages); k++) pageNums.push(k);

          const pageDatas = await Promise.all(pageNums.map(n => fetchPage(n)));

          const allItems = [];
          for (const pageData of pageDatas) {
            if (!pageData) continue;
            const items = extractItemsFromSearch(pageData);
            meta.syncState.processed += items.length;
            allItems.push(...items);
          }

          await processItems(allItems);
          saveAndNotify(pageNums[pageNums.length - 1], totalPages, totalElements);
        }
      }
    }

    // ── 3. Finalizar ──────────────────────────────────────────────────
    if (syncAbortFlag) {
      meta.syncState.status = 'paused';
      writeJSON(META_PATH, meta);
      send({ type: 'paused', processed: meta.syncState.processed, message: 'Sincronización pausada por el usuario.' });

    } else {
      meta.syncState.status = 'idle';
      meta.syncState.currentPage = totalPages;
      const now = new Date().toISOString();

      if (mode === 'all') {
        meta.lastSync       = now;
        meta.total          = Array.from(repoMap.values()).length;
        meta.newRecords     = newCount;
        meta.updatedRecords = updCount;
      } else if (mode === 'new') {
        meta.lastSyncNew = now;
        meta.totalNew    = newCount;
        meta.total       = Array.from(repoMap.values()).length;
      } else if (mode === 'date') {
        meta.lastSyncDate = now;
        meta.dateFrom     = fromDate;
        meta.dateTo       = toDate || null;
        meta.totalDate    = newCount + updCount;
      }

      setRepo(Array.from(repoMap.values()));
      writeJSON(META_PATH, meta);

      const earlyNote = earlyExitTriggered
        ? ` (early-exit: ${STOP_AFTER_CONSECUTIVE_KNOWN} UUIDs conocidos consecutivos)`
        : '';

      const doneLabels = {
        all:  `✅ Sincronización completa · ${Array.from(repoMap.values()).length.toLocaleString()} registros · ${newCount} nuevos · ${updCount} actualizados`,
        new:  `✅ Registros nuevos: ${newCount} · Total: ${Array.from(repoMap.values()).length.toLocaleString()}${earlyNote}`,
        date: `✅ Por fecha · ${(newCount + updCount)} procesados (${fromDate}${toDate ? ' → ' + toDate : ''})`,
      };
      send({ type: 'done', total: Array.from(repoMap.values()).length, newCount, updCount,
             message: doneLabels[mode] || `✅ Sincronización completa · ${repo.length.toLocaleString()} registros` });
    }

  } catch (err) {
    console.error('[sync] Error inesperado:', err);
    meta.syncState.status = 'idle';
    writeJSON(META_PATH, meta);
    send({ type: 'error', message: `Error inesperado: ${err.message}` });
  }

  res.end();
});

// ─── Arrancar servidor ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  DSpace Explorer escuchando en http://localhost:${PORT}`);
  console.log(`    Repositorio: ${REPO_PATH}`);
  console.log(`    Metadata:    ${META_PATH}`);
  console.log(`    Concurrencia: ${PAGES_CONCURRENCY} páginas × ${ITEMS_CONCURRENCY} items`);
});
