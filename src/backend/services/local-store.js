// Zero-dependency on-disk vector store: keeps memory working fully offline.
// Vectors are stored at native embedding dim (384) and are normalized, so
// cosine similarity == dot product. `synced` flags points that reached Qdrant.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'local-memory.json');

let data = null;

function init() {
  if (data) return data;
  try {
    if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.warn('[local-store] corrupt store, starting fresh:', e.message);
  }
  if (!data || typeof data !== 'object' || !data.points) data = { points: {} };
  return data;
}

// Synchronous write on every mutation: the store is small (vectors + text),
// and durability beats latency here — a hard kill must never lose memories.
function flush() {
  if (!data) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE); // atomic on same volume
  } catch {}
}

function add(id, vec, payload, synced) {
  init();
  data.points[id] = {
    vec,
    payload,
    synced: Boolean(synced),
    created: payload?.ts || Date.now(),
  };
  flush();
}

function get(id) {
  return init().points[id] || null;
}

function remove(id) {
  const had = Boolean(init().points[id]);
  if (had) {
    delete data.points[id];
    flush();
  }
  return had;
}

function markSynced(id) {
  const p = init().points[id];
  if (p && !p.synced) {
    p.synced = true;
    flush();
  }
}

function clear() {
  init();
  data.points = {};
  flush();
}

function count() {
  return Object.keys(init().points).length;
}

function pending() {
  return Object.entries(init().points)
    .filter(([, p]) => !p.synced)
    .map(([id, p]) => ({ id, vec: p.vec, payload: p.payload }));
}

function pendingCount() {
  return pending().length;
}

function all() {
  return Object.entries(init().points).map(([id, p]) => ({
    id,
    vec: p.vec,
    payload: p.payload,
    synced: p.synced,
  }));
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Brute-force cosine search (normalized vectors). Fine for thousands of points.
// Returns the full payload so consumers get the complete memory schema.
function search(queryVec, topK = 3) {
  init();
  const scored = [];
  for (const [id, p] of Object.entries(data.points)) {
    let score = -1;
    if (Array.isArray(p.vec) && p.vec.length === queryVec.length) {
      score = dot(queryVec, p.vec);
    }
    scored.push({ id, score, text: p.payload?.text, ts: p.payload?.ts, payload: p.payload });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter((s) => s.score > 0.05);
}

module.exports = {
  init,
  add,
  get,
  remove,
  markSynced,
  clear,
  count,
  pending,
  pendingCount,
  all,
  search,
  FILE,
};
