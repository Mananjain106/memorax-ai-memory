// Dual-backend vector memory:
//   1. Local on-disk store (data/local-memory.json) — ALWAYS written first,
//      keeping memory fully functional offline.
//   2. Qdrant Cloud — mirrored on every write when reachable.
// Points that fail to reach Qdrant are marked pending and pushed by catch-up
// sync when connectivity returns. Read path prefers Qdrant while online
// (bigger corpus), falls back to local brute-force cosine search offline.
const { QdrantClient } = require('@qdrant/js-client-rest');
const crypto = require('crypto');
const config = require('../config');
const { embed } = require('./embeddings');
const { detectMode } = require('../connectivity');
const localStore = require('./local-store');
const syncQueue = require('./sync-queue');
const schema = require('../memory-engine/schema');
const vectorSearch = require('../memory-engine/vector-search');
const { EVENT } = require('./sync-queue');

let client = null;
let memoryDisabledReason = null;
let vectorSize = null;
let vectorName = null; // null = unnamed vectors, "name" = named vectors
let dimEnsured = null;
let syncing = false;

function ensureDim() {
  if (!dimEnsured) {
    dimEnsured = ensureCollection().catch((e) => {
      dimEnsured = null; // allow retry
      throw e;
    });
  }
  return dimEnsured;
}

function getClient() {
  if (!client) {
    if (!config.qdrant.url) throw new Error('QDRANT_URL not configured');
    client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey || undefined,
      checkCompatibility: false,
    });
  }
  return client;
}

// Read {size, name} from a collection vectors config. Handles:
//   number                          -> unnamed vectors
//   { size, distance }              -> unnamed vectors (plain config object)
//   { "": {...size}, ... }          -> default named entry (treated as unnamed)
//   { name: {...size}, ... }        -> named vectors
function readVectorConfig(vectors) {
  if (typeof vectors === 'number') return { size: vectors, name: null };
  if (vectors && typeof vectors === 'object') {
    if (Number.isFinite(vectors.size)) return { size: vectors.size, name: null };
    const entry = Object.entries(vectors).find(
      ([, v]) => v && typeof v === 'object' && Number.isFinite(v.size)
    );
    if (entry) {
      const name = entry[0] === '' ? null : entry[0];
      return { size: entry[1].size, name };
    }
  }
  return null;
}

async function ensureCollection() {
  const q = getClient();
  try {
    const exists = await q.collectionExists(config.qdrant.collection);
    if (exists?.exists) {
      const info = await q.getCollection(config.qdrant.collection);
      const cfg = readVectorConfig(info?.config?.params?.vectors);
      if (cfg) {
        vectorSize = cfg.size;
        vectorName = cfg.name;
        console.log(
          `[memory] using existing collection "${config.qdrant.collection}" (dim=${cfg.size}${cfg.name ? `, named="${cfg.name}"` : ', unnamed'})`
        );
        return { created: false, vectorSize };
      }
      throw new Error('collection exists but vector config unreadable');
    }
  } catch (e) {
    if (!/not found/i.test(e.message || '') && !/does not exist/i.test(e.message || '')) {
      throw e;
    }
  }
  // Create using the REAL dimension of our embedding model output
  const probeVec = await embed('dimension probe');
  vectorSize = probeVec.length;
  vectorName = null;
  await q.createCollection(config.qdrant.collection, {
    vectors: { size: vectorSize, distance: 'Cosine' },
  });
  console.log(`[memory] created collection "${config.qdrant.collection}" dim=${vectorSize}`);
  return { created: true, vectorSize };
}

async function fitToCollectionDim(vec) {
  await ensureDim();
  if (vec.length === vectorSize) return vec;
  if (vec.length > vectorSize) {
    throw new Error(`embedding dim ${vec.length} exceeds collection dim ${vectorSize}`);
  }
  // Pad with zeros: cos(pad(a), pad(b)) === cos(a, b) exactly, so recall
  // quality is unchanged. Never guess dimensions — fit to reality.
  const padded = vec.slice();
  padded.length = vectorSize;
  return padded.fill(0, vec.length);
}

// Push one point to Qdrant (best-effort). Marks the local copy synced on success.
async function pushPoint(id, vecNative, payload) {
  try {
    const vector = await fitToCollectionDim(vecNative);
    const vectorArg = vectorName ? { [vectorName]: vector } : vector;
    await getClient().upsert(config.qdrant.collection, {
      points: [{ id, vector: vectorArg, payload }],
      wait: true,
    });
    localStore.markSynced(id);
    return { ok: true };
  } catch (e) {
    memoryDisabledReason = e.message;
    return { ok: false, error: e.message };
  }
}

async function remember(text, metadata = {}, { cloudAllowed = true, record: providedRecord } = {}) {
  try {
    // Explicitly measure the dimension from the real model before storing.
    const dim = await schema.getEmbeddingDim();
    const vec = await embed(text); // native model dim (=== dim, guaranteed)
    if (vec.length !== dim) {
      throw new Error(`embedding dim ${vec.length} != measured model dim ${dim}`);
    }
    // Full required schema: memory_id, text, category, importance,
    // future_usefulness, sensitivity, priority_score, created_at, updated_at,
    // version, device_id, content_hash.
    const record = providedRecord || schema.buildRecord(text, metadata);
    const payload = { ...record, ts: record.created_at };
    const id = record.memory_id;
    // 1. Always local first — offline-safe source of truth.
    localStore.init();
    localStore.add(id, vec, payload, false);
    syncQueue.logActivity(EVENT.MEMORY_CREATED, { memory_id: id, category: payload.category });

    // 2. Cloud path: direct push when online, else (or if push fails) the
    //    persistent queue holds it for automatic catch-up with backoff.
    //    Sensitive memories never enqueue — the queue itself enforces this.
    if (!cloudAllowed) {
      return { ok: true, id, record, dims: vec.length, qdrant: { ok: true, skipped: true, queued: false } };
    }
    const qdrant = await pushPoint(id, vec, payload);
    if (!qdrant.ok) {
      const q = syncQueue.enqueue(id, 'UPSERT', { payload, priority: payload.priority_score });
      return { ok: true, id, record, dims: vec.length, qdrant: { ok: false, queued: q.ok, reason: q.reason }, queued: q.ok };
    }
    return { ok: true, id, record, dims: vec.length, qdrant, queued: false };
  } catch (e) {
    memoryDisabledReason = e.message;
    return { ok: false, error: e.message };
  }
}

// Replace a point's text/payload, re-embedding once. Cloud copy is updated
// only if the existing point was already cloud-synced (respects LOCAL_ONLY).
// Version bumps and hash recomputation go through the schema helper.
async function updatePoint(id, { text, ...fieldUpdates } = {}) {
  try {
    const existing = localStore.get(id);
    if (!existing) return { ok: false, error: 'point not found' };
    if (!existing.payload?.content_hash) {
      // Legacy point from before the schema existed — migrate on first touch.
      existing.payload = { ...schema.buildRecord(existing.payload?.text || text || '', existing.payload), memory_id: id, version: 1 };
    }
    const updated = schema.applyUpdate(existing.payload, { text, ...fieldUpdates });
    const vec = await embed(updated.text);
    localStore.add(id, vec, updated, false); // overwrite in place, mark unsynced
    syncQueue.logActivity(EVENT.MEMORY_UPDATED, { memory_id: id, version: updated.version });
    // Keep the cloud copy in sync when the point is already cloud-synced.
    let cloud = { ok: true, skipped: true };
    if (existing.synced) {
      cloud = await pushPoint(id, vec, updated);
      if (!cloud.ok) syncQueue.enqueue(id, 'UPSERT', { payload: updated, priority: updated.priority_score });
    } else if (!syncQueue.isSensitivePayload(updated)) {
      syncQueue.enqueue(id, 'UPSERT', { payload: updated, priority: updated.priority_score });
    }
    return { ok: true, id, record: updated, cloud };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Attach conflict metadata to an existing point without overwriting its text.
async function flagConflict(id, conflictingText, reason) {
  try {
    const existing = localStore.get(id);
    if (!existing) return { ok: false, error: 'point not found' };
    const payload = {
      ...existing.payload,
      conflict: {
        text: String(conflictingText).slice(0, 300),
        reason: String(reason).slice(0, 200),
        ts: Date.now(),
      },
    };
    localStore.add(id, existing.vec, payload, existing.synced);
    let cloud = { ok: true, skipped: true };
    if (existing.synced) {
      cloud = await pushPoint(id, existing.vec, payload);
    }
    return { ok: true, id, cloud };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Remove temporary memories whose TTL has expired. Called opportunistically.
function purgeExpiredTemporary(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  let removed = 0;
  for (const p of localStore.all()) {
    if (p.payload?.temporary && now - (p.payload?.ts || 0) > maxAgeMs) {
      localStore.remove(p.id);
      removed++;
    }
  }
  return removed;
}

async function recall(query, limit = 3) {
  const qv = await embed(query);
  const conn = await detectMode().catch(() => ({ online: false }));
  const merged = new Map(); // id -> result (cloud and local share ids)

  if (conn.online) {
    try {
      const vector = await fitToCollectionDim(qv);
      const queryParams = { limit, with_payload: true };
      if (vectorName) queryParams.using = vectorName;
      const res = await getClient().query(config.qdrant.collection, {
        query: vector,
        ...queryParams,
      });
      for (const p of res.points || []) {
        merged.set(String(p.id), {
          id: p.id,
          score: p.score,
          text: p.payload?.text,
          ts: p.payload?.ts,
          source: 'qdrant',
        });
      }
    } catch (e) {
      memoryDisabledReason = e.message;
    }
  }

  // ALWAYS also search the local store: it holds LOCAL_ONLY memories that are
  // deliberately absent from the cloud, plus pending offline writes.
  // Deep candidate pool + priority-boosted ranking: a high-priority memory
  // must outrank incidental word-overlap noise.
  let localHits;
  try {
    localHits = await vectorSearch.searchLocal(qv, { limit: limit * 2 });
  } catch {
    localHits = localStore.search(qv, limit).map((r) => ({
      memory_id: r.id,
      score: r.score,
      text: r.text,
      payload: localStore.get(r.id)?.payload,
    }));
  }
  for (const r of localHits) {
    const key = String(r.memory_id);
    if (!merged.has(key) || merged.get(key).score < r.score) {
      merged.set(key, {
        id: r.memory_id,
        score: r.score,
        text: r.text,
        ts: r.payload?.created_at,
        payload: r.payload,
        source: 'local',
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((r) => r.score > 0.05);
}

// Synchronize: delegate to the cloud-sync worker, which drains the persistent
// queue (with backoff + conflict handling). Also enqueues any legacy local
// points that predate the queue and are cloud-eligible.
async function syncPending() {
  const cloudSync = require('./cloud-sync');
  // legacy catch-up: local points never synced and not in the queue yet
  const legacy = localStore.pending();
  for (const p of legacy) {
    const payload = p.payload || {};
    if (!syncQueue.get(p.id) && !syncQueue.isSensitivePayload(payload)) {
      syncQueue.enqueue(p.id, 'UPSERT', { payload, priority: payload.priority_score });
    }
  }
  const summary = await cloudSync.syncNow();
  if (!summary.skipped && !summary.offline) {
    console.log(
      `[memory] sync: ${summary.synced} synced, ${summary.deduped} deduped, ${summary.conflicts} conflicts, ${summary.failed} failed`
    );
  }
  return summary;
}

// ---- memory browser API ----
function listPoints(limit = 50, offset = 0) {
  const items = localStore
    .all()
    .sort((a, b) => (b.payload?.ts || 0) - (a.payload?.ts || 0));
  return {
    total: items.length,
    pending: localStore.pendingCount(),
    points: items.slice(offset, offset + limit).map(({ vec, ...rest }) => ({
      ...rest,
      dims: Array.isArray(vec) ? vec.length : 0,
    })),
  };
}

async function deletePoint(id) {
  const local = localStore.remove(id);
  let qdrant = { ok: true, skipped: true };
  try {
    const conn = await detectMode();
    if (conn.online) {
      await getClient().delete(config.qdrant.collection, { points: [id], wait: true });
      qdrant = { ok: true };
    }
  } catch (e) {
    qdrant = { ok: false, error: e.message };
  }
  return { ok: local || qdrant.ok, local, qdrant };
}

async function clearAll() {
  localStore.clear();
  let qdrant = { ok: true, skipped: true };
  try {
    const conn = await detectMode();
    if (conn.online) {
      // Empty filter matches every point -> wipe all payloads, keep collection.
      await getClient().delete(config.qdrant.collection, { filter: {}, wait: true });
      qdrant = { ok: true };
    }
  } catch (e) {
    qdrant = { ok: false, error: e.message };
  }
  return { ok: true, qdrant };
}

function status() {
  return {
    configured: Boolean(config.qdrant.url && config.qdrant.collection),
    collection: config.qdrant.collection,
    vectorSize,
    vectorName,
    local: {
      file: localStore.FILE,
      count: localStore.count(),
      pending: localStore.pendingCount(),
    },
    disabledReason: memoryDisabledReason,
  };
}

module.exports = {
  ensureCollection,
  remember,
  recall,
  updatePoint,
  flagConflict,
  purgeExpiredTemporary,
  syncPending,
  pushPoint,
  fitToCollectionDim,
  listPoints,
  deletePoint,
  clearAll,
  status,
};
