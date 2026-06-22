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

// ─── Optimización: concurrencia máxima ────────────────────────────────────
const ITEMS_CONCURRENCY  = 12;   // items en paralelo por batch
const PAGES_CONCURRENCY  = 4;    // páginas descargadas en paralelo
const PAGES_PREFETCH     = 3;    // páginas pre-cargadas por adelantado

// ─── Estado en memoria ─────────────────────────────────────────────────────
let syncAbortFlag = false;

// ─── Cache de comunidades/colecciones ─────────────────────────────────────
const collectionCache = new Map();

// ─── Cache de repositorio en RAM ──────────────────────────────────────────
let repoCache = null;
function getRepo()       { if (!repoCache) repoCache = readJSON(REPO_PATH, []); return repoCache; }
function setRepo(data)   { repoCache = data; writeJSON(REPO_PATH, data); }

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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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
async function fetchCommunityCollection(owningCollectionHref) {
  if (!owningCollectionHref) return { collection: '', community: '' };
  if (collectionCache.has(owningCollectionHref)) return collectionCache.get(owningCollectionHref);
  try {
    const r = await fetch(`${owningCollectionHref}?embed=parentCommunity`, { timeout: FETCH_TIMEOUT });
    if (!r.ok) return { collection: '', community: '' };
    const d = await r.json();
    const result = { collection: (d.name || '').trim(), community: d._embedded?.parentCommunity?.name?.trim() || '' };
    collectionCache.set(owningCollectionHref, result);
    return result;
  } catch (_) { return { collection: '', community: '' }; }
}

// ─── Obtener URL del PDF principal ────────────────────────────────────────
async function fetchPdfUrl(uuid) {
  try {
    const br = await fetch(`${ITEMS_URL}/${uuid}/bundles?size=20`, { timeout: 10000 });
    if (!br.ok) return null;
    const bd = await br.json();
    const bundles  = bd?._embedded?.bundles || [];
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

// ─── Mapeo principal de un objeto DSpace ──────────────────────────────────
async function mapRecord(dspaceItem) {
  let meta     = dspaceItem.metadata || {};
  const uuid   = dspaceItem.uuid || dspaceItem.id || '';
  const handle = dspaceItem.handle || '';

  let titleRaw = getMetaFirst(meta, 'dc.title');
  if (!titleRaw && uuid) {
    try {
      const r = await fetch(`${ITEMS_URL}/${uuid}`, { timeout: FETCH_TIMEOUT });
      if (r.ok) { const d = await r.json(); if (d?.metadata) { meta = d.metadata; titleRaw = getMetaFirst(meta, 'dc.title'); } }
    } catch (_) {}
  }

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

  const colHref = dspaceItem._links?.owningCollection?.href;
  const [ccResult, pdfData] = await Promise.all([
    colHref ? fetchCommunityCollection(colHref) : Promise.resolve({ collection: '', community: '' }),
    uuid    ? fetchPdfUrl(uuid).catch(() => null) : Promise.resolve(null),
  ]);

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

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/',        (_req, res) => res.sendFile(HTML_PATH));
app.get('/health',  (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/metadata',(_req, res) => res.json(readJSON(META_PATH, {})));
app.get('/data',    (req,  res) => {
  const repo   = getRepo();
  const fields = req.query.fields ? req.query.fields.split(',').map(f => f.trim()) : null;
  if (fields && fields.length > 0)
    return res.json(repo.map(r => { const o={}; fields.forEach(f => { if(r[f]!==undefined) o[f]=r[f]; }); return o; }));
  res.json(repo);
});

// ─── GET /thumb/:uuid ──────────────────────────────────────────────────────
app.get('/thumb/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) return res.status(400).json({ error: 'UUID inválido' });
  try {
    const r = await fetch(`${ITEMS_URL}/${uuid}/thumbnail`, { timeout: 10000 });
    if (r.status === 204 || !r.ok) return res.status(404).json({ error: 'Sin miniatura' });
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
// ─── POST /sync/start  (SSE streaming)  ───────────────────────────────────
//
//  Body params:
//    mode      : 'all' | 'new' | 'date'
//    fromDate  : 'YYYY-MM-DD'   (solo mode='date')
//    toDate    : 'YYYY-MM-DD'   (solo mode='date', opcional)
//
//  metadata.json por modo:
//    all  → lastSync, total, newRecords, updatedRecords, syncState
//    new  → lastSyncNew, totalNew, syncState
//    date → lastSyncDate, dateFrom, dateTo, totalDate, syncState
// ═══════════════════════════════════════════════════════════════════════════
app.post('/sync/start', async (req, res) => {
  const mode     = req.body?.mode     || 'all';
  const fromDate = req.body?.fromDate || null;
  const toDate   = req.body?.toDate   || null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  function send(obj) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} }

  // ── Leer / inicializar metadata ────────────────────────────────────────
  let meta = readJSON(META_PATH, {
    lastSync: null, total: 0, newRecords: 0, updatedRecords: 0,
    syncState: { status: 'idle', currentPage: 0, totalPages: 0, processed: 0 },
  });

  // Reanudar solo en modo 'all' si estaba pausado
  const isPaused  = (mode === 'all') && meta.syncState?.status === 'paused';
  const startPage = isPaused ? (meta.syncState?.currentPage || 0) : 0;

  syncAbortFlag = false;

  // syncState compartido para todos los modos
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
    all:  isPaused ? 'Reanudando sincronización completa…' : 'Iniciando sincronización completa…',
    new:  'Buscando registros nuevos en DSpace…',
    date: `Sincronizando registros desde ${fromDate}${toDate ? ' hasta ' + toDate : ''}…`,
  };
  send({ type: 'start', message: startLabels[mode] || 'Iniciando sincronización…' });

  // ── Helper: fetch de una página con reintentos ─────────────────────────
  async function fetchPage(p) {
    const url = `${SEARCH_URL}?scope=&query=&page=${p}&size=${PAGE_SIZE}&sort=score%2CDESC`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { timeout: FETCH_TIMEOUT });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (attempt < 2) await sleep(1200 * (attempt + 1));
        else { send({ type: 'warn', message: `Página ${p + 1} omitida: ${e.message}` }); return null; }
      }
    }
    return null;
  }

  // ── Helper: filtrar items según modo ──────────────────────────────────
  function shouldProcess(item) {
    if (mode === 'new') {
      // Solo UUIDs que NO existen aún en el repositorio local
      return !repoMap.has(item.uuid);
    }
    if (mode === 'date' && fromDate) {
      // Solo items cuya fecha de publicación está dentro del rango
      const m2  = item.metadata || {};
      const val = (m2['dc.date.issued']?.[0]?.value ||
                   m2['dc.date.available']?.[0]?.value ||
                   m2['dc.date.accessioned']?.[0]?.value || '').slice(0, 10);
      if (!val) return false;
      const afterFrom = val >= fromDate;
      const beforeTo  = toDate ? val <= toDate : true;
      return afterFrom && beforeTo;
    }
    // mode='all': procesar todo
    return true;
  }

  // ── Helper: procesar batch de items en paralelo ────────────────────────
  async function processItems(items) {
    const filtered = items.filter(item => item?.uuid && shouldProcess(item));
    for (let i = 0; i < filtered.length; i += ITEMS_CONCURRENCY) {
      if (syncAbortFlag) break;
      const batch   = filtered.slice(i, i + ITEMS_CONCURRENCY);
      const records = await Promise.all(batch.map(item => mapRecord(item).catch(() => null)));
      for (const record of records) {
        if (!record?.uuid) continue;
        if (repoMap.has(record.uuid)) { repoMap.set(record.uuid, record); updCount++; }
        else                          { repoMap.set(record.uuid, record); newCount++; }
      }
    }
  }

  // ── Helper: guardar estado intermedio y notificar progreso ────────────
  function saveAndNotify(p, totalPages, totalElements) {
    repo = Array.from(repoMap.values());
    meta.syncState.currentPage = p + 1;
    meta.syncState.processed   = (meta.syncState.processed || 0);
    meta.total = repo.length;

    // Actualizar campos específicos del modo en metadata.json
    if (mode === 'all') {
      meta.newRecords     = newCount;
      meta.updatedRecords = updCount;
    } else if (mode === 'new') {
      meta.totalNew = newCount;
    } else if (mode === 'date') {
      meta.totalDate = newCount + updCount;
    }

    setRepo(repo);
    writeJSON(META_PATH, meta);

    const pct = totalPages > 0 ? Math.round(((p + 1) / totalPages) * 100) : 0;
    send({
      type: 'progress', page: p + 1, totalPages,
      processed: meta.syncState.processed,
      totalElements, newCount, updCount, pct,
      message: `Página ${p + 1} de ${totalPages} · ${(newCount + updCount).toLocaleString()} registros procesados`,
    });
  }

  try {
    // ── Obtener primera página ─────────────────────────────────────────
    const firstData = await fetchPage(startPage);
    if (!firstData) throw new Error('No se pudo conectar con DSpace. Verifica la red.');

    const { totalPages, totalElements } = getTotalPages(firstData);
    meta.syncState.totalPages = totalPages;
    writeJSON(META_PATH, meta);

    send({ type: 'info', message: `DSpace: ${totalElements.toLocaleString()} registros en ${totalPages} páginas` });

    // Procesar primera página
    const firstItems = extractItemsFromSearch(firstData);
    meta.syncState.processed += firstItems.length;
    await processItems(firstItems);
    saveAndNotify(startPage, totalPages, totalElements);

    if (syncAbortFlag) {
      meta.syncState.status = 'paused';
      writeJSON(META_PATH, meta);
      send({ type: 'paused', processed: meta.syncState.processed, message: 'Sincronización pausada.' });
      res.end(); return;
    }

    // ── Páginas restantes: descarga en paralelo (PAGES_CONCURRENCY) ────
    for (let p = startPage + 1; p < totalPages; p += PAGES_CONCURRENCY) {
      if (syncAbortFlag) break;

      // Lanzar PAGES_CONCURRENCY páginas en paralelo
      const pageNums  = [];
      for (let k = p; k < Math.min(p + PAGES_CONCURRENCY, totalPages); k++) pageNums.push(k);

      const pageDatas = await Promise.all(pageNums.map(n => fetchPage(n)));

      for (let k = 0; k < pageNums.length; k++) {
        if (syncAbortFlag) break;
        const pageData = pageDatas[k];
        if (!pageData) continue;

        const items = extractItemsFromSearch(pageData);
        meta.syncState.processed += items.length;
        await processItems(items);
        saveAndNotify(pageNums[k], totalPages, totalElements);
      }
    }

    if (syncAbortFlag) {
      meta.syncState.status = 'paused';
      writeJSON(META_PATH, meta);
      send({ type: 'paused', processed: meta.syncState.processed, message: 'Sincronización pausada por el usuario.' });
    } else {
      // ── Finalizar: campos específicos por modo en metadata.json ──────
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
        // total global también se actualiza
        meta.total = Array.from(repoMap.values()).length;
      } else if (mode === 'date') {
        meta.lastSyncDate = now;
        meta.dateFrom     = fromDate;
        meta.dateTo       = toDate || null;
        meta.totalDate    = newCount + updCount;
      }

      setRepo(Array.from(repoMap.values()));
      writeJSON(META_PATH, meta);

      const doneLabels = {
        all:  `✅ Sincronización completa · ${repo.length.toLocaleString()} registros · ${newCount} nuevos · ${updCount} actualizados`,
        new:  `✅ Registros nuevos añadidos: ${newCount} · Total en repositorio: ${Array.from(repoMap.values()).length.toLocaleString()}`,
        date: `✅ Sincronización por fecha completa · ${(newCount + updCount)} registros procesados (${fromDate}${toDate ? ' → ' + toDate : ''})`,
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
});
