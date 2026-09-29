// Intelligent Memory Decision Engine pipeline:
//   USER MESSAGE
//     -> memory candidate extraction (LLM, strict JSON, safe fallback)
//     -> importance/usefulness/sensitivity scoring
//     -> semantic duplicate search
//     -> deterministic decision engine (LLM never controls storage)
//     -> store / update / discard
// Every decision is appended to data/memory-decisions.jsonl for audit.
const fs = require('fs');
const path = require('path');
const analyzer = require('./analyzer');
const engine = require('./decision-engine');

const DECISIONS_FILE = path.join(process.cwd(), 'data', 'memory-decisions.jsonl');

let llmChatFn = null; // injected lazily to avoid circular imports

function setLLMChat(fn) {
  llmChatFn = fn;
}

function audit(record) {
  try {
    fs.mkdirSync(path.dirname(DECISIONS_FILE), { recursive: true });
    fs.appendFileSync(DECISIONS_FILE, JSON.stringify(record) + '\n');
  } catch {}
}

// Content words only — stopwords carry no topic signal, so excluding them lets
// a raw message and its normalized third-person extract still compare equal.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'and', 'or',
  'in', 'on', 'at', 'for', 'with', 'that', 'this', 'it', 'its', 'as', 'by', 'from',
  'user', 'users', 'my', 'i', 'their', 'his', 'her', 'has', 'have', 'had', 'do', 'does', 'did',
]);

function significantTokens(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

// Deterministic near-duplicate check for reworded / normalized phrasing — e.g.
// the stored raw message vs the analyzer's third-person extract, which land
// just below the pure-embedding duplicate threshold. Two sentences match when
// one's content words are a subset of the other's, or their Jaccard overlap is
// high. Precision-first: the conflict check runs before this in the caller.
function isSemanticDuplicate(a, b) {
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  if (!ta.length || !tb.length) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  if (ta.every((w) => sb.has(w)) || tb.every((w) => sa.has(w))) return true;
  const common = [...sa].filter((w) => sb.has(w)).length;
  const union = sa.size + sb.size - common;
  return union > 0 && common / union >= 0.6;
}

// Ask the existing memory service for semantically similar stored memories.
// Exact content_hash matches are duplicates regardless of score; near-miss
// embedding scores still count as duplicates when the wording overlaps.
async function findDuplicates(text, { threshold = 0.82, conflictThreshold = 0.6, nearThreshold = 0.74 } = {}) {
  try {
    const memory = require('../services/memory'); // lazy: avoid cycles
    const { contentHash } = require('./schema');
    const hash = contentHash(text);
    const hits = await memory.recall(text, 5);
    const dups = [];
    const conflicts = [];
    for (const h of hits) {
      const hitText = h.payload?.text ?? h.text ?? '';
      if (h.payload?.content_hash === hash || h.score >= threshold) {
        dups.push(h); // decide() still routes contradicting "duplicates" to CONFLICT
      } else if (
        h.score >= nearThreshold &&
        isSemanticDuplicate(hitText, text) &&
        !engine.isConflicting(hitText, text)
      ) {
        // Near-duplicates win over the conflict check: a reworded/normalized
        // restatement must MERGE into its original, never "conflict" with it.
        // Genuine contradictions never qualify (checked above).
        dups.push(h);
      } else if (h.score >= conflictThreshold && engine.isConflicting(hitText, text)) {
        conflicts.push(h);
      }
    }
    const conflict = conflicts[0] ? { id: conflicts[0].id, score: conflicts[0].score } : null;
    return { duplicates: dups, conflict };
  } catch {
    return { duplicates: [], conflict: null };
  }
}

// Execute a store/merge/flag decision. Returns the outcome summary.
async function executeDecision(analysis, decision, candidate, duplicates) {
  const memory = require('../services/memory');

  switch (decision.decision) {
    case engine.DECISIONS.DISCARD:
      return { action: 'discarded' };

    case engine.DECISIONS.TEMPORARY_LOCAL:
    case engine.DECISIONS.LOCAL_ONLY:
    case engine.DECISIONS.LOCAL_AND_CLOUD: {
      const payload = {
        text: candidate.text,
        category: analysis.category,
        temporary: decision.decision === engine.DECISIONS.TEMPORARY_LOCAL || analysis.temporary === true,
        importance: analysis.importance,
        future_usefulness: analysis.future_usefulness,
        sensitivity: analysis.sensitivity,
        priority_score: decision.priority,
        priority: decision.priority,
        source: analysis.source,
        reason: decision.reason,
      };
      // Cloud targeting: LOCAL_ONLY and TEMPORARY_LOCAL stay on the device.
      const cloudAllowed = decision.decision === engine.DECISIONS.LOCAL_AND_CLOUD;
      const r = await memory.remember(candidate.text, payload, { cloudAllowed });
      // Never claim a store that did not happen — surface the failure instead.
      if (!r.ok) return { action: 'store-failed', error: r.error };
      return {
        action: 'stored',
        id: r.id,
        cloud: cloudAllowed && r.qdrant?.ok ? 'synced' : cloudAllowed ? 'pending' : 'local-only',
        temporary: payload.temporary,
      };
    }

    case engine.DECISIONS.MERGE: {
      const dup = duplicates[0];
      const r = await memory.updatePoint(dup.id, { text: decision.mergedText });
      return { action: 'merged', id: dup.id, cloud: r.cloud || 'n/a' };
    }

    case engine.DECISIONS.CONFLICT: {
      // Flag only: attach conflict metadata to the existing point, store nothing new.
      // decide() reports the contradicting point via duplicateOf even when it did
      // not qualify as a duplicate, so prefer it and fall back to the dup list.
      const existingId = decision.duplicateOf || dupConflictId(duplicates);
      await memory.flagConflict(existingId, candidate.text, decision.reason);
      // Create a full conflict record for review (versions, devices, content).
      const existingPoint = require('../services/local-store').get(existingId);
      const conflicts = require('./conflicts');
      const conflictRecord = conflicts.create({
        memoryId: existingId,
        localRecord: existingPoint?.payload || null,
        cloudRecord: null,
        reason: decision.reason,
      });
      return { action: 'conflict-flagged', conflict_id: conflictRecord.conflict_id, status: conflictRecord.status };
    }

    default:
      return { action: 'unknown-decision' };
  }
}

function dupConflictId(duplicates) {
  return duplicates[0]?.id || null;
}

// Main entry: analyze -> dedup -> decide -> execute -> audit.
async function processMessage(userMessage, { source = 'chat' } = {}) {
  const t0 = Date.now();
  const analysis = await analyzer.analyzeMessage(userMessage, { llmChat: llmChatFn });

  const candidate = {
    text: analysis.extract || userMessage,
    conflict: null,
  };

  const { duplicates, conflict } = await findDuplicates(candidate.text);
  candidate.conflict = conflict;

  const decision = engine.decide(analysis, candidate, duplicates);
  const outcome = await executeDecision(analysis, decision, candidate, duplicates);

  const record = {
    ts: Date.now(),
    at: new Date().toISOString(),
    source,
    message: String(userMessage).slice(0, 300),
    extract: candidate.text, // what would be stored (sanitized sentence)
    scores: {
      importance: analysis.importance,
      future_usefulness: analysis.future_usefulness,
      frequency: analysis.frequency,
      recency: analysis.recency,
      cross_device_value: analysis.cross_device_value,
      sensitivity: analysis.sensitivity,
      confidence: analysis.confidence,
    },
    priority: decision.priority,
    decision: decision.decision,
    reason: decision.reason,
    analyzer: analysis.source,
    outcome,
    duplicateOf: decision.duplicateOf || null,
    durationMs: Date.now() - t0,
  };
  audit(record);
  return record;
}

module.exports = { processMessage, setLLMChat, findDuplicates, isSemanticDuplicate, DECISIONS_FILE };
