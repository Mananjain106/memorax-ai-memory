// Persistent sync queue: the bridge between local memory and Qdrant Cloud.
// OFFLINE: eligible memories are enqueued (PENDING). ONLINE: a worker drains
// the queue with exponential backoff. Sensitive (LOCAL_ONLY) memories are
// NEVER enqueued — enforced here, one gate before anything touches the cloud.
//
// Queue record fields (required): queue_id, memory_id, operation, status,
// retry_count, created_at, last_attempt, last_error.
// Statuses: PENDING -> SYNCING -> SYNCED | FAILED -> PENDING... | CONFLICT
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'sync-queue.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.jsonl');

const STATUS = {
  PENDING: 'PENDING',
  SYNCING: 'SYNCING',
  SYNCED: 'SYNCED',
  FAILED: 'FAILED',
  CONFLICT: 'CONFLICT',
};

const EVENT = {
  MEMORY_CREATED: 'MEMORY_CREATED',
  MEMORY_UPDATED: 'MEMORY_UPDATED',
  MEMORY_DISCARDED: 'MEMORY_DISCARDED',
  QUEUED: 'QUEUED',
  SYNC_STARTED: 'SYNC_STARTED',
  SYNCED: 'SYNCED',
  SYNC_FAILED: 'SYNC_FAILED',
  DUPLICATE: 'DUPLICATE',
  CONFLICT: 'CONFLICT',
};

let queue = null;

// ---- activity log (append-only JSONL) ----
function logActivity(event, details = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      ACTIVITY_FILE,
      JSON.stringify({ ts: Date.now(), at: new Date().toISOString(), event, ...details }) + '\n'
    );
  } catch {}
}

function init() {
  if (queue) return queue;
  try {
    if (fs.existsSync(FILE)) queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.warn('[sync-queue] corrupt queue file, starting fresh:', e.message);
  }
  if (!queue || typeof queue !== 'object' || !Array.isArray(queue.items)) {
    queue = { items: [] };
  }
  // crash recovery: anything stuck in SYNCING goes back to PENDING
  let recovered = 0;
  for (const item of queue.items) {
    if (item.status === STATUS.SYNCING) {
      item.status = STATUS.PENDING;
      recovered++;
    }
  }
  if (recovered) {
    console.log(`[sync-queue] recovered ${recovered} stuck SYNCING item(s)`);
    persist();
  }
  return queue;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(queue));
    fs.renameSync(tmp, FILE);
  } catch {}
}

const MAX_RETRY_CAP = 8;

// Exponential backoff: 2^retry * 5s, capped ~21 minutes.
function backoffMs(retryCount) {
  return Math.min(Math.pow(2, Math.min(retryCount, MAX_RETRY_CAP)) * 5000, 21 * 60 * 1000);
}

function isSensitivePayload(payload) {
  if (!payload) return false;
  if (payload.sensitivity >= 80) return true;
  if (payload.securityOverride === true) return true;
  const text = String(payload.text || '');
  const { containsSecret } = require('../memory-engine/decision-engine');
  return Boolean(containsSecret(text));
}

// Enqueue a memory for cloud sync. Sensitive memories are refused at the gate.
function enqueue(memoryId, operation = 'UPSERT', { payload, priority } = {}) {
  init();
  if (isSensitivePayload(payload)) {
    logActivity(EVENT.SYNC_FAILED, {
      memory_id: memoryId,
      error: 'rejected: sensitive LOCAL_ONLY memory must never enter the cloud sync queue',
    });
    return { ok: false, reason: 'SENSITIVE' };
  }
  // ONE queue slot per memory_id (§4/§14): re-enqueueing a SYNCED memory
  // REUSES its slot (back to PENDING) instead of creating a second record —
  // duplicate slots would linger PENDING forever because markSynced/markFailed
  // resolve the first item for a memory_id.
  const existing = queue.items.find((i) => i.memory_id === memoryId);
  if (existing) {
    // same memory already tracked: refresh op/payload, keep retry history
    existing.operation = operation;
    if (payload) existing.payload = payload;
    existing.status = STATUS.PENDING; // SYNCED/FAILED/CONFLICT -> fresh attempt
    existing.retry_count = 0;
    existing.next_attempt_after = null;
    existing.last_error = null;
    persist();
    return { ok: true, dedup: true, queue_id: existing.queue_id };
  }

  const item = {
    queue_id: crypto.randomUUID(),
    memory_id: memoryId,
    operation,
    status: STATUS.PENDING,
    retry_count: 0,
    created_at: Date.now(),
    last_attempt: null,
    last_error: null,
    payload: payload || null,
    priority: priority || 0,
  };
  queue.items.push(item);
  persist();
  logActivity(EVENT.QUEUED, { memory_id: memoryId, queue_id: item.queue_id, operation });
  return { ok: true, queue_id: item.queue_id };
}

function get(memoryId) {
  init();
  return queue.items.find((i) => i.memory_id === memoryId) || null;
}

function all() {
  init();
  return [...queue.items];
}

function counts() {
  init();
  const c = {};
  for (const s of Object.values(STATUS)) c[s] = 0;
  for (const i of queue.items) c[i.status] = (c[i.status] || 0) + 1;
  return c;
}

function pendingCount() {
  init();
  return queue.items.filter((i) => i.status === STATUS.PENDING).length;
}

// Spec §8: explicit SYNCING stage. Set by the sync worker right before the
// cloud attempt; crash recovery (init) flips stranded SYNCING back to PENDING.
function markSyncing(memoryId) {
  init();
  // mark ALL slots for this memory (legacy files may hold duplicates)
  const items = queue.items.filter((i) => i.memory_id === memoryId);
  for (const item of items) {
    if (item.status !== STATUS.SYNCING) {
      item.status = STATUS.SYNCING;
      item.last_attempt = Date.now();
    }
  }
  if (items.length) persist();
  console.log(`[SYNC] QUEUE_STATUS=SYNCING memory=${memoryId}`);
  return items[0] || null;
}

function markSynced(memoryId) {
  init();
  const items = queue.items.filter((i) => i.memory_id === memoryId);
  for (const item of items) {
    item.status = STATUS.SYNCED;
    item.last_attempt = Date.now();
    item.last_error = null;
  }
  if (items.length) {
    persist();
    logActivity(EVENT.SYNCED, { memory_id: memoryId, queue_id: items[0].queue_id });
    console.log(`[SYNC] QUEUE_STATUS=SYNCED memory=${memoryId} (cloud write confirmed + verified)`);
  }
}

function markFailed(memoryId, error, { requeue = true } = {}) {
  init();
  const item = queue.items.find((i) => i.memory_id === memoryId);
  if (!item) return null;
  item.retry_count += 1;
  item.last_attempt = Date.now();
  item.last_error = String(error).slice(0, 300);
  // exponential backoff: flip to PENDING (retry later) until the cap, then FAILED
  if (requeue && item.retry_count <= MAX_RETRY_CAP) {
    item.status = STATUS.PENDING;
    item.next_attempt_after = item.last_attempt + backoffMs(item.retry_count);
  } else {
    item.status = STATUS.FAILED;
  }
  persist();
  logActivity(EVENT.SYNC_FAILED, {
    memory_id: memoryId,
    queue_id: item.queue_id,
    retry: item.retry_count,
    error: item.last_error,
  });
  console.log(
    `[SYNC] QUEUE_STATUS=${item.status} memory=${memoryId} error=${JSON.stringify(item.last_error)} (attempt ${item.retry_count})`
  );
  if (item.status === STATUS.PENDING) {
    console.log(`[SYNC] RETRY_SCHEDULED memory=${memoryId} in=${Math.round(backoffMs(item.retry_count) / 1000)}s`);
  }
  return item;
}

function markConflict(memoryId, error) {
  init();
  const item = queue.items.find((i) => i.memory_id === memoryId);
  if (item) {
    item.status = STATUS.CONFLICT;
    item.last_attempt = Date.now();
    item.last_error = String(error).slice(0, 300);
    persist();
    logActivity(EVENT.CONFLICT, { memory_id: memoryId, queue_id: item.queue_id });
  }
  return item;
}

function readyItems(now = Date.now()) {
  init();
  return queue.items.filter(
    (i) => i.status === STATUS.PENDING && (!i.next_attempt_after || now >= i.next_attempt_after)
  );
}

function remove(memoryId) {
  init();
  const before = queue.items.length;
  queue.items = queue.items.filter((i) => i.memory_id !== memoryId);
  const removed = before !== queue.items.length;
  if (removed) persist();
  return removed;
}

function clearSynced(olderThanMs = 24 * 60 * 60 * 1000) {
  init();
  const cutoff = Date.now() - olderThanMs;
  const before = queue.items.length;
  queue.items = queue.items.filter(
    (i) => !(i.status === STATUS.SYNCED && (i.last_attempt || 0) < cutoff)
  );
  if (before !== queue.items.length) persist();
  return before - queue.items.length;
}

function readActivity(limit = 100) {
  try {
    if (!fs.existsSync(ACTIVITY_FILE)) return [];
    const lines = fs.readFileSync(ACTIVITY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return { unparsable: l.slice(0, 100) }; }
    });
  } catch {
    return [];
  }
}

module.exports = {
  STATUS,
  EVENT,
  enqueue,
  get,
  all,
  counts,
  pendingCount,
  readyItems,
  markSyncing,
  markSynced,
  markFailed,
  markConflict,
  remove,
  clearSynced,
  backoffMs,
  isSensitivePayload,
  logActivity,
  readActivity,
  FILE,
  ACTIVITY_FILE,
};
