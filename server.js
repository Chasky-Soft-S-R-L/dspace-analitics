'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 4000;

// ─── Rutas de archivos ─────────────────────────────────────────────────────
const HTML_PATH = path.join(__dirname, 'index.html');
const REPO_PATH = path.join(__dirname, 'repositorio.json');
const META_PATH = path.join(__dirname, 'metadata.json');

// ─── DSpace 7 API ──────────────────────────────────────────────────────────
const DSPACE_BASE   = 'https://repositorio.unas.edu.pe/server/api';
const SEARCH_URL    = `${DSPACE_BASE}/discover/search/objects`;
const ITEMS_URL     = `${DSPACE_BASE}/core/items`;
const PAGE_SIZE     = 100;
const FETCH_TIMEOUT = 30000;

// ─── Optimización: concurrencia ────────────────────────────────────────────
const ITEMS_CONCURRENCY = 8;   // items procesados en paralelo por página
const PAGES_PREFETCH    = 2;   // páginas pre-cargadas por adelantado

// ─── Estado en memoria ─────────────────────────────────────────────────────
let syncAbortFlag = false;

// ─── Cache de comunidades/colecciones (evita fetches repetidos) ────────────
const collectionCache = new Map();

// ─── Cache de repositorio en RAM (evita leer disco en cada /data) ──────────
let repoCache = null;   // null = no cargado aún

function getRepo() {
  if (!repoCache) repoCache = readJSON(REPO_PATH, []);
  return repoCache;
}
function setRepo(data) {
  repoCache = data;
  writeJSON(REPO_PATH, data);
}

// ─── Mapeo de tipos DSpace URI → etiqueta legible ─────────────────────────
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Extracción robusta de metadatos DSpace 7 ──────────────────────────────
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
    if (Array.isArray(arr) && arr.length > 0)
      return (arr[0].value || '').trim();
  }
  return '';
}

// ─── Obtener comunidad y colección (con caché en memoria) ─────────────────
async function fetchCommunityCollection(owningCollectionHref) {
  if (!owningCollectionHref) return { collection: '', community: '' };
  // Retornar del caché si ya fue consultado
  if (collectionCache.has(owningCollectionHref))
    return collectionCache.get(owningCollectionHref);
  try {
    const r = await fetch(`${owningCollectionHref}?embed=parentCommunity`, { timeout: FETCH_TIMEOUT });
    if (!r.ok) return { collection: '', community: '' };
    const d = await r.json();
    const result = {
      collection: (d.name || '').trim(),
      community:  d._embedded?.parentCommunity?.name?.trim() || '',
    };
    collectionCache.set(owningCollectionHref, result);  // guardar en caché
    return result;
  } catch (_) {
    return { collection: '', community: '' };
  }
}

// ─── Obtener metadatos completos vía /core/items/{uuid} (fallback) ─────────
async function fetchItemDetail(uuid) {
  try {
    const r = await fetch(`${ITEMS_URL}/${uuid}`, { timeout: FETCH_TIMEOUT });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// ─── Mapeo principal de un objeto DSpace → esquema local ──────────────────
// OPTIMIZADO: fetchCommunityCollection y fetchPdfUrl corren en PARALELO
async function mapRecord(dspaceItem) {
  let meta     = dspaceItem.metadata || {};
  const uuid   = dspaceItem.uuid || dspaceItem.id || '';
  const handle = dspaceItem.handle || '';

  // Si faltan metadatos básicos, obtenerlos (poco frecuente con embed=metadata)
  let titleRaw = getMetaFirst(meta, 'dc.title');
  if (!titleRaw && uuid) {
    const detail = await fetchItemDetail(uuid);
    if (detail?.metadata) { meta = detail.metadata; titleRaw = getMetaFirst(meta, 'dc.title'); }
  }

  // Extraer todos los campos de metadatos (sin fetch, puro CPU)
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

  // ── Lanzar fetchCommunityCollection y fetchPdfUrl EN PARALELO ─────────
  const colHref = dspaceItem._links?.owningCollection?.href;
  const [ccResult, pdfData] = await Promise.all([
    colHref ? fetchCommunityCollection(colHref) : Promise.resolve({ collection: '', community: '' }),
    uuid    ? fetchPdfUrl(uuid).catch(() => null) : Promise.resolve(null),
  ]);

  const collection = ccResult.collection;
  const community  = ccResult.community;
  const pdfUrl     = pdfData?.bitstreamUuid
    ? `https://repositorio.unas.edu.pe/server/api/core/bitstreams/${pdfData.bitstreamUuid}/content`
    : '';

  return { uuid, title, authors, advisors, date, type, community, collection, abstract, language, topics, publisher, degree, degreeLevel, url, pdfUrl };
}

// ─── Extraer items de la respuesta de búsqueda DSpace 7 ───────────────────
function extractItemsFromSearch(data) {
  try {
    const objs = data._embedded.searchResult._embedded.objects;
    return objs.map(o => o._embedded?.indexableObject || null).filter(Boolean);
  } catch (_) {
    try {
      return data._embedded.objects.map(o => o._embedded?.indexableObject || o).filter(Boolean);
    } catch (__) { return []; }
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

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── GET / ─────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(HTML_PATH));

// ─── GET /health ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── GET /thumb/:uuid ──────────────────────────────────────────────────────
// Proxy → redirige 302 al bitstream JPEG de la miniatura del item
app.get('/thumb/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid))
    return res.status(400).json({ error: 'UUID inválido' });
  try {
    const r = await fetch(`${ITEMS_URL}/${uuid}/thumbnail`, { timeout: 10000 });
    if (r.status === 204 || !r.ok) return res.status(404).json({ error: 'Sin miniatura' });
    const d = await r.json();
    const contentUrl = d?._links?.content?.href;
    if (!contentUrl) return res.status(404).json({ error: 'Sin URL de contenido' });
    res.redirect(302, contentUrl);
  } catch (e) {
    res.status(503).json({ error: 'Error al obtener miniatura', detail: e.message });
  }
});

// ─── GET /pdf/:uuid ────────────────────────────────────────────────────────
// Resuelve el PDF principal: bundle ORIGINAL → primer bitstream .pdf
// Retorna JSON: { name, size, downloadUrl }
// ─── Resuelve la URL de descarga del PDF principal de un item ─────────────
// Reutilizada por mapRecord() (sync) y el endpoint /pdf/:uuid
async function fetchPdfUrl(uuid) {
  try {
    const br = await fetch(`${ITEMS_URL}/${uuid}/bundles?size=20`, { timeout: 10000 });
    if (!br.ok) return null;
    const bd = await br.json();
    const bundles = bd?._embedded?.bundles || [];
    const original = bundles.find(b => b.name === 'ORIGINAL');
    if (!original) return null;
    const bsHref = original?._links?.bitstreams?.href;
    if (!bsHref) return null;
    const bsr = await fetch(`${bsHref}?size=20`, { timeout: 10000 });
    if (!bsr.ok) return null;
    const bsd = await bsr.json();
    const bitstreams = bsd?._embedded?.bitstreams || [];
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

app.get('/pdf/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid))
    return res.status(400).json({ error: 'UUID inválido' });
  try {
    const pdf = await fetchPdfUrl(uuid);
    if (!pdf) return res.status(404).json({ error: 'Sin PDF disponible' });
    res.json(pdf);
  } catch (e) {
    res.status(503).json({ error: 'Error al obtener PDF', detail: e.message });
  }
});

// ─── GET /data ─────────────────────────────────────────────────────────────
app.get('/data', (req, res) => {
  const repo = getRepo();
  // ?fields=uuid,title,authors,date,type → respuesta reducida para carga inicial rápida
  const fields = req.query.fields ? req.query.fields.split(',').map(f => f.trim()) : null;
  if (fields && fields.length > 0) {
    return res.json(repo.map(r => {
      const obj = {};
      fields.forEach(f => { if (r[f] !== undefined) obj[f] = r[f]; });
      return obj;
    }));
  }
  res.json(repo);
});

// ─── GET /metadata ─────────────────────────────────────────────────────────
app.get('/metadata', (_req, res) => res.json(readJSON(META_PATH, {})));

// ─── POST /sync/stop ───────────────────────────────────────────────────────
app.post('/sync/stop', (_req, res) => {
  syncAbortFlag = true;
  const meta = readJSON(META_PATH, {});
  if (meta.syncState) meta.syncState.status = 'paused';
  writeJSON(META_PATH, meta);
  res.json({ ok: true, message: 'Sincronización pausada.' });
});

// ─── POST /sync/start  (SSE streaming) ────────────────────────────────────
app.post('/sync/start', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(obj) {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
  }

  const meta = readJSON(META_PATH, {
    lastSync: null, total: 0, newRecords: 0, updatedRecords: 0,
    syncState: { status: 'idle', currentPage: 0, totalPages: 0, processed: 0 },
  });

  const isPaused  = meta.syncState?.status === 'paused';
  const startPage = isPaused ? (meta.syncState?.currentPage || 0) : 0;

  syncAbortFlag = false;
  meta.syncState = {
    status:      'syncing',
    currentPage: startPage,
    totalPages:  meta.syncState?.totalPages || 0,
    processed:   isPaused ? (meta.syncState?.processed || 0) : 0,
  };
  if (!isPaused) { meta.newRecords = 0; meta.updatedRecords = 0; }
  writeJSON(META_PATH, meta);

  let repo     = getRepo();
  const repoMap = new Map(repo.map(r => [r.uuid, r]));
  let newCount  = 0, updCount = 0;

  send({ type: 'start', message: `${isPaused ? 'Reanudando' : 'Iniciando'} sincronización desde página ${startPage + 1}…` });

  // ── Helper: fetch de una página con reintentos ─────────────────────────
  async function fetchPage(p) {
    const url = `${SEARCH_URL}?scope=&query=&page=${p}&size=${PAGE_SIZE}&sort=score%2CDESC`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { timeout: FETCH_TIMEOUT });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (attempt < 2) await sleep(1500 * (attempt + 1));
        else { send({ type: 'warn', message: `Página ${p + 1} omitida: ${e.message}` }); return null; }
      }
    }
    return null;
  }

  // ── Helper: procesar items de una página en paralelo (N concurrentes) ──
  async function processItems(items) {
    const results = [];
    for (let i = 0; i < items.length; i += ITEMS_CONCURRENCY) {
      if (syncAbortFlag) break;
      const batch = items.slice(i, i + ITEMS_CONCURRENCY);
      const records = await Promise.all(batch.map(item => mapRecord(item).catch(() => null)));
      for (const record of records) {
        if (!record?.uuid) continue;
        if (repoMap.has(record.uuid)) { repoMap.set(record.uuid, record); updCount++; }
        else                          { repoMap.set(record.uuid, record); newCount++; }
        results.push(record);
      }
    }
    return results;
  }

  try {
    // ── Página inicial ────────────────────────────────────────────────────
    const firstData = await fetchPage(startPage);
    if (!firstData) throw new Error('No se pudo obtener la primera página de DSpace');

    const { totalPages, totalElements } = getTotalPages(firstData);
    meta.syncState.totalPages = totalPages;

    const firstItems = extractItemsFromSearch(firstData);
    await processItems(firstItems);

    meta.syncState.currentPage = startPage + 1;
    meta.syncState.processed   = (meta.syncState.processed || 0) + firstItems.length;
    repo = Array.from(repoMap.values());
    meta.total = repo.length;
    setRepo(repo);
    writeJSON(META_PATH, meta);

    send({
      type: 'progress', page: startPage + 1, totalPages,
      processed: meta.syncState.processed, totalElements, newCount, updCount,
      pct: totalPages > 0 ? Math.round(((startPage + 1) / totalPages) * 100) : 0,
      message: `Página ${startPage + 1} de ${totalPages} · ${meta.syncState.processed.toLocaleString()} registros procesados`,
    });

    if (syncAbortFlag) {
      meta.syncState.status = 'paused';
      writeJSON(META_PATH, meta);
      send({ type: 'paused', processed: meta.syncState.processed, message: 'Sincronización pausada.' });
      res.end(); return;
    }

    // ── Páginas restantes con pre-carga (prefetch) ────────────────────────
    for (let p = startPage + 1; p < totalPages; p++) {
      if (syncAbortFlag) break;

      // Pre-cargar la siguiente página MIENTRAS procesamos la actual
      const nextPagePromise = (p + 1 < totalPages)
        ? fetchPage(p + 1)
        : Promise.resolve(null);

      const pageData = await fetchPage(p);
      if (!pageData) {
        // Avanzar igual para no bloquear
        await nextPagePromise;
        continue;
      }

      const items = extractItemsFromSearch(pageData);

      // Procesar items de esta página EN PARALELO (ITEMS_CONCURRENCY a la vez)
      await processItems(items);

      meta.syncState.currentPage = p + 1;
      meta.syncState.processed   = (meta.syncState.processed || 0) + items.length;
      repo = Array.from(repoMap.values());
      meta.total = repo.length;
      setRepo(repo);
      writeJSON(META_PATH, meta);

      send({
        type: 'progress', page: p + 1, totalPages,
        processed: meta.syncState.processed, totalElements, newCount, updCount,
        pct: totalPages > 0 ? Math.round(((p + 1) / totalPages) * 100) : 0,
        message: `Página ${p + 1} de ${totalPages} · ${meta.syncState.processed.toLocaleString()} registros procesados`,
      });

      if (syncAbortFlag) break;
    }

    if (syncAbortFlag) {
      meta.syncState.status = 'paused';
      writeJSON(META_PATH, meta);
      send({ type: 'paused', processed: meta.syncState.processed, message: 'Sincronización pausada por el usuario.' });
    } else {
      meta.syncState.status = 'idle';
      meta.lastSync         = new Date().toISOString();
      meta.newRecords       = newCount;
      meta.updatedRecords   = updCount;
      meta.total            = repo.length;
      writeJSON(META_PATH, meta);
      send({ type: 'done', total: repo.length, newCount, updCount,
             message: `✅ Sincronización completa · ${repo.length.toLocaleString()} registros en total` });
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
});
