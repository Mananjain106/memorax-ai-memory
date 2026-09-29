// Local semantic similarity search over the on-disk vector store.
// This IS the "Qdrant Edge/local" layer: full cosine search with the same
// ai_memory-compatible payloads, zero network, zero external dependencies.
const { getEmbeddingDim } = require('./schema');

// Rank memories by semantic score, boosted slightly by stored priority so
// equally-relevant memories surface in a stable, useful order.
function rank(hits, { semanticWeight = 0.85, priorityWeight = 0.15 } = {}) {
  return hits
    .map((h) => {
      const priority = Number(h.payload?.priority_score) || 0;
      return { ...h, rankScore: semanticWeight * h.score + priorityWeight * (priority / 100) };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}

// Query the local store. Returns ranked hits in recall-compatible shape.
async function searchLocal(queryVec, { limit = 5, minScore = 0.05, priorityBoost = 0.15 } = {}) {
  const localStore = require('../services/local-store');
  const dim = await getEmbeddingDim();

  if (!Array.isArray(queryVec) || queryVec.length !== dim) {
    throw new Error(`query vector dim ${queryVec?.length} != embedding model dim ${dim}`);
  }

  const raw = localStore.search(queryVec, Math.max(limit * 4, 20));
  return rank(raw, { priorityWeight: priorityBoost })
    .filter((h) => h.score >= minScore)
    .slice(0, limit)
    .map((h) => ({
      memory_id: h.id,
      score: Number(h.score.toFixed(4)),
      rankScore: Number(h.rankScore.toFixed(4)),
      text: h.text,
      payload: h.payload || {},
      source: 'local',
    }));
}

// Broad query used by the duplicate/conflict detector (no priority boost).
async function searchForDedup(queryVec, { limit = 5 } = {}) {
  const localStore = require('../services/local-store');
  const raw = localStore.search(queryVec, Math.max(limit * 4, 20));
  return raw.map((h) => ({
    memory_id: h.id,
    score: Number(h.score.toFixed(4)),
    text: h.text,
    payload: h.payload || {},
  }));
}

module.exports = { searchLocal, searchForDedup, rank };
