// Cloud sync worker: drains the persistent queue into Qdrant Cloud when online.
// Handles version/hash divergence via conflict records; retries with
// exponential backoff; marks queue items SYNCED only after cloud ack.
const config = require('../config');
const { detectMode } = require('../connectivity');
const localStore = require('./local-store');
const syncQueue = require('./sync-queue');
const conflicts = require('../memory-engine/conflicts');

let syncing = false;
let timer = null;

function getClient() {
  const { QdrantClient } = require('@qdrant/js-client-rest');
  return new QdrantClient({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey || undefined,
    checkCompatibility: false,
  });
}

function vectorArg(vector) {
  const name = vectorName();
  return name ? { [name]: vector } : vector;
}

// Vector name is resolved by memory.ensureCollection() at startup; read-only here.
function vectorName() {
  try {
    const memory = require('./memory');
    return memory.status().vectorName ?? null;
  } catch {
    return null;
  }
}

// Push one queue item. Never throws — returns {ok} or {ok:false, permanent}.
async function pushItem(item) {
  const memory = require('./memory');
  try {
    const local = localStore.get(item.memory_id);
    if (!local) {
      // memory was deleted locally after enqueueing -> drop the queue item
      syncQueue.remove(item.memory_id);
      return { ok: true, dropped: true };
    }
    const payload = local.payload;
    // §8 state machine: PENDING -> SYNCING before any cloud contact.
    syncQueue.markSyncing(item.memory_id);

    // ---- duplicate/version check: what does the cloud already have? ----
    // The Qdrant point id IS memory_id, so an exact retrieve is enough.
    let cloud = null;
    try {
      const res = await getClient().retrieve(config.qdrant.collection, {
        ids: [item.memory_id],
        with_payload: true,
      });
      cloud = Array.isArray(res) ? res[0] || null : null;
    } catch (e) {
      // §9: never hide errors — surface them, then treat as absent (the
      // verified push below will fail loudly if the cloud is truly broken).
      console.log(`[SYNC] pre-check retrieve failed memory=${item.memory_id} error=${JSON.stringify(String(e.message || e).slice(0, 120))}`);
      cloud = null;
    }

    if (cloud?.payload) {
      const cloudHash = cloud.payload.content_hash;
      const cloudVer = cloud.payload.version || 1;
      const localVer = payload.version || 1;
      if (cloudHash === payload.content_hash && cloudVer >= localVer) {
        // Cloud already has this exact content. §15: still verify the payload
        // fields before trusting it — the point WAS retrieved from the
        // expected collection, so this is a real cloud verification.
        const mismatch = cloudVer === localVer ? memory.payloadMismatch(payload, cloud.payload) : null;
        if (mismatch) {
          console.log(`[SYNC] dedup pre-check mismatch memory=${item.memory_id}: ${mismatch} — re-pushing`);
        } else {
          console.log(`[SYNC] QUEUE_STATUS=SYNCED memory=${item.memory_id} (dedup: cloud record verified identical)`);
          syncQueue.markSynced(item.memory_id);
          return { ok: true, dedup: true };
        }
      }
      if (cloudHash !== payload.content_hash && cloudVer >= localVer) {
        // divergence: cloud is same-or-newer with different content
        const c = conflicts.create({
          memoryId: item.memory_id,
          localRecord: payload,
          cloudRecord: cloud.payload,
          reason: `cloud version ${cloudVer} >= local ${localVer} with different content`,
        });
        syncQueue.markConflict(item.memory_id, c.reason);
        return { ok: false, conflict: true, conflict_id: c.conflict_id };
      }
      // cloud older + different content: deterministic resolution below
      const outcome = conflicts.resolve(payload, cloud.payload);
      if (outcome.resolution === 'REQUIRES_REVIEW') {
        const c = conflicts.create({
          memoryId: item.memory_id,
          localRecord: payload,
          cloudRecord: cloud.payload,
          reason: 'ambiguous divergence: same window, opposite content',
        });
        syncQueue.markConflict(item.memory_id, c.reason);
        return { ok: false, conflict: true, conflict_id: c.conflict_id };
      }
      // IDENTICAL / MERGED / LOCAL_NEWER all end with the local record winning
      // (MERGED uses the merged text already stored locally by the pipeline).
      if (outcome.resolution === 'MERGED' && outcome.mergedText) {
        const { embed } = require('./embeddings');
        const vec = await embed(outcome.mergedText);
        localStore.add(item.memory_id, vec, { ...payload, text: outcome.mergedText, version: (payload.version || 1) + 1, updated_at: Date.now() }, false);
      }
    }

    // ---- push local record to the cloud (pushPoint handles dim fit + naming) ----
    // §15: SYNCED only after pushPoint PROVES the write (response ok + point
    // retrieved back + payload fields matched). pushPoint returns verified=true
    // only then; anything else must be a failure, never a silent success.
    const memoryService = require('./memory');
    const up = await memoryService.pushPoint(item.memory_id, local.vec, payload);
    if (!up.ok || !up.verified) {
      const permanent =
        up.permanent || /exceeds collection dim|not configured|dimension mismatch/i.test(up.error || '');
      syncQueue.markFailed(item.memory_id, up.error || 'unverified push (no cloud confirmation)', { requeue: !permanent });
      return { ok: false, error: up.error || 'unverified push', permanent };
    }
    syncQueue.markSynced(item.memory_id);
    return { ok: true };
  } catch (e) {
    const msg = String(e.message || e);
    const permanent = /exceeds collection dim|not configured/i.test(msg);
    syncQueue.markFailed(item.memory_id, msg, { requeue: !permanent });
    return { ok: false, error: msg, permanent };
  }
}

// Drain all ready queue items. Returns a summary.
async function syncNow({ max = 50 } = {}) {
  if (syncing) return { skipped: true, reason: 'already syncing' };
  syncing = true;
  const summary = { attempted: 0, synced: 0, failed: 0, conflicts: 0, deduped: 0, dropped: 0 };
  try {
    const conn = await detectMode();
    if (!conn.online) {
      return { ...summary, offline: true };
    }
    const items = syncQueue.readyItems();
    if (items.length) syncQueue.logActivity(syncQueue.EVENT.SYNC_STARTED, { count: items.length });

    for (const item of items.slice(0, max)) {
      summary.attempted++;
      const r = await pushItem(item);
      if (r.ok) {
        if (r.dropped) {
          summary.dropped++; // memory deleted locally; queue item removed
        } else {
          summary.synced++;
          if (r.dedup) summary.deduped++;
        }
      } else if (r.conflict) {
        summary.conflicts++;
      } else {
        summary.failed++;
        if (r.permanent) break; // stop hammering a broken config
      }
    }
    return summary;
  } catch (e) {
    return { ...summary, error: String(e.message || e).slice(0, 200) };
  } finally {
    syncing = false;
  }
}

// Background loop: runs every 30s, drains when online and work is ready.
function start(intervalMs = 30000) {
  stop();
  timer = setInterval(() => {
    syncNow().catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { syncNow, start, stop, pushItem };
