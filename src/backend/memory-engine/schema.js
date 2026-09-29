// Memory schema: every stored memory carries the full required field set.
// Also owns device identity and EMBEDDING DIMENSION DETECTION.
// The dimension is always measured from the real embedding model output —
// never guessed, never hardcoded.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEVICE_FILE = path.join(process.cwd(), 'data', 'device-id');

let cachedDeviceId = null;

function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    if (fs.existsSync(DEVICE_FILE)) {
      const id = fs.readFileSync(DEVICE_FILE, 'utf8').trim();
      if (id) {
        cachedDeviceId = id;
        return id;
      }
    }
    const id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true });
    fs.writeFileSync(DEVICE_FILE, id);
    cachedDeviceId = id;
    return id;
  } catch {
    // read-only FS fallback: ephemeral id, still schema-complete
    cachedDeviceId = cachedDeviceId || `ephemeral-${crypto.randomUUID()}`;
    return cachedDeviceId;
  }
}

// Exact embedding dimension, measured from the real model. Cached forever per
// process (the model cannot change under our feet mid-process).
let measuredDim = null;

async function getEmbeddingDim() {
  if (measuredDim) return measuredDim;
  const { embed } = require('../services/embeddings'); // lazy: avoid cycles
  const probe = await embed('dimension probe');
  if (!Array.isArray(probe) || typeof probe.length !== 'number' || probe.length === 0) {
    throw new Error('embedding model returned invalid vector — cannot determine dimension');
  }
  measuredDim = probe.length;
  console.log(`[schema] embedding dimension measured from model: ${measuredDim}`);
  return measuredDim;
}

function getCachedDim() {
  return measuredDim;
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text).trim().toLowerCase()).digest('hex');
}

// memory_id — deterministic when a text is given (dedup-friendly), random otherwise.
function newId(text) {
  return text ? crypto.randomUUID() : crypto.randomUUID();
}

// Build a complete, validated memory record (all 12 required fields).
// Extra metadata fields (source, reason, temporary, ...) are preserved.
function buildRecord(text, metadata = {}) {
  const { category, importance, future_usefulness, sensitivity, priority_score, temporary, ...extra } = metadata;
  const now = Date.now();
  return {
    memory_id: crypto.randomUUID(), // the 12 required fields
    text: String(text),
    category: category || 'other',
    importance: Number(importance) || 0,
    future_usefulness: Number(future_usefulness) || 0,
    sensitivity: Number(sensitivity) || 0,
    priority_score: Number(priority_score) || 0,
    created_at: now,
    updated_at: now,
    version: 1,
    device_id: getDeviceId(),
    content_hash: contentHash(text),
    // extension fields (not in the required list, used by the app)
    temporary: temporary === true,
    ...extra,
  };
}

// Apply an update: bumps version + updated_at, recomputes content_hash,
// preserves created_at, memory_id and device identity.
function applyUpdate(record, { text, category, importance, future_usefulness, sensitivity, priority_score } = {}) {
  const next = { ...record };
  if (typeof text === 'string' && text.trim() && text !== record.text) {
    next.text = text.trim();
    next.content_hash = contentHash(next.text);
  }
  if (category !== undefined) next.category = category;
  if (importance !== undefined) next.importance = Number(importance) || record.importance;
  if (future_usefulness !== undefined) next.future_usefulness = Number(future_usefulness) || record.future_usefulness;
  if (sensitivity !== undefined) next.sensitivity = Number(sensitivity) || record.sensitivity;
  if (priority_score !== undefined) next.priority_score = Number(priority_score) || record.priority_score;
  next.updated_at = Date.now();
  next.version = (record.version || 1) + 1;
  return next;
}

module.exports = {
  getDeviceId,
  getEmbeddingDim,
  getCachedDim,
  contentHash,
  buildRecord,
  applyUpdate,
};
