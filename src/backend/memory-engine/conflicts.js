// Conflict records for cloud↔local memory divergence.
// A conflict is NEVER silently overwritten: either a deterministic rule
// resolves it safely, or it is marked REQUIRES_REVIEW for the user.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('./decision-engine');
const { logActivity, EVENT } = require('../services/sync-queue');

const FILE = path.join(process.cwd(), 'data', 'conflicts.json');

let records = null;

function init() {
  if (records) return records;
  try {
    if (fs.existsSync(FILE)) records = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    records = { items: [] };
  }
  if (!records || !Array.isArray(records.items)) records = { items: [] };
  return records;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records));
    fs.renameSync(tmp, FILE);
  } catch {}
}

// Create (or update) a conflict record. Returns the record.
function create({ memoryId, localRecord, cloudRecord, reason }) {
  init();
  const record = {
    conflict_id: crypto.randomUUID(),
    memory_id: memoryId,
    versions: {
      local: localRecord?.version ?? null,
      cloud: cloudRecord?.version ?? null,
    },
    timestamps: {
      local_updated_at: localRecord?.updated_at ?? null,
      cloud_updated_at: cloudRecord?.updated_at ?? null,
      detected_at: Date.now(),
    },
    device_ids: {
      local: localRecord?.device_id ?? null,
      cloud: cloudRecord?.device_id ?? null,
    },
    content: {
      local: localRecord?.text ?? null,
      cloud: cloudRecord?.text ?? null,
    },
    status: 'REQUIRES_REVIEW',
    rule: null,
    reason: String(reason || '').slice(0, 300),
    ts: Date.now(),
  };
  const idx = records.items.findIndex(
    (r) => r.memory_id === memoryId && r.status === 'REQUIRES_REVIEW'
  );
  if (idx >= 0) records.items[idx] = record;
  else records.items.push(record);
  persist();
  logActivity(EVENT.CONFLICT, {
    memory_id: memoryId,
    conflict_id: record.conflict_id,
    status: record.status,
  });
  return record;
}

function setStatus(conflictId, status, rule) {
  init();
  const r = records.items.find((x) => x.conflict_id === conflictId);
  if (r) {
    r.status = status;
    r.rule = rule;
    persist();
  }
  return r;
}

function list({ status } = {}) {
  init();
  return status ? records.items.filter((r) => r.status === status) : [...records.items];
}

function byMemory(memoryId) {
  init();
  return records.items.filter((r) => r.memory_id === memoryId);
}

// Deterministic resolution rules, tried in order. Returns:
//   { resolution: 'LOCAL_NEWER' | 'CLOUD_NEWER' | 'MERGED' | 'IDENTICAL' }
//   or { resolution: 'REQUIRES_REVIEW' }
function resolve(localRecord, cloudRecord) {
  if (!localRecord || !cloudRecord) return { resolution: 'REQUIRES_REVIEW' };

  // Rule 0 — identical content: nothing to resolve.
  if (localRecord.content_hash === cloudRecord.content_hash) {
    return { resolution: 'IDENTICAL' };
  }

  // Rule 1 — merge-compatible (no semantic contradiction): deterministic merge.
  // Supersets/paraphrases are mergeable; "repaired" vs "still damaged" is not.
  const lt = localRecord.text || '';
  const ct = cloudRecord.text || '';
  if (!engine.isConflicting(ct, lt)) {
    return { resolution: 'MERGED', mergedText: engine.mergeText(ct, lt) };
  }

  // Rule 2 — true contradiction: last-write-wins by updated_at, but ONLY with
  // a clear margin (5s) so clock skew cannot silently drop an edit.
  const MARGIN = 5000;
  if (localRecord.updated_at - cloudRecord.updated_at > MARGIN) {
    return { resolution: 'LOCAL_NEWER' };
  }
  if (cloudRecord.updated_at - localRecord.updated_at > MARGIN) {
    return { resolution: 'CLOUD_NEWER' };
  }

  // Ambiguous: same window, opposite facts, different devices -> human review.
  return { resolution: 'REQUIRES_REVIEW' };
}

module.exports = { create, setStatus, list, byMemory, resolve, FILE };
