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

// Structured pipeline logs. Every stage prints a grep-able MEMORY_* tag with
// its duration; failures print MEMORY_ERROR with the stage name. Never throws.
function slog(tag, data = {}) {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.slice(0, 90)) : v}`)
    .join(' ');
  console.log(`MEMORY_${tag}${parts ? ' ' + parts : ''}`);
}

function memError(stage, e, extra = {}) {
  const msg = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160);
  console.error(`MEMORY_ERROR stage=${stage} error=${JSON.stringify(msg)}${extra.memory_id ? ` memory_id=${extra.memory_id}` : ''}`);
}

// Content-word tokenizer is shared with the decision engine (stopwords +
// light stemming) so dedup and conflict checks compare the same concepts.
const { significantTokens } = require('./decision-engine');

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
async function findDuplicates(
  text,
  { threshold = 0.82, conflictThreshold = 0.6, nearThreshold = 0.75, boostThreshold = 0.6 } = {}
) {
  try {
    const memory = require('../services/memory'); // lazy: avoid cycles
    const { contentHash } = require('./schema');
    const hash = contentHash(text);
    const hits = await memory.recall(text, 5);
    const dups = [];
    const conflicts = [];
    for (const h of hits) {
      const hitText = h.payload?.text ?? h.text ?? '';
      const contradicting = engine.isConflicting(hitText, text);
      if (h.payload?.content_hash === hash || h.score >= threshold) {
        dups.push(h); // decide() still routes contradicting "duplicates" to CONFLICT
      } else if (h.score >= nearThreshold && !contradicting) {
        // Semantic band: the embedding is the signal — a reworded restatement
        // (e.g. "uses Qdrant Edge for local memory" vs "using Qdrant Edge to
        // store my memories") must MERGE, not spawn a duplicate. Genuine
        // contradictions are excluded here and handled below.
        dups.push(h);
      } else if (
        h.score >= boostThreshold &&
        isSemanticDuplicate(hitText, text) &&
        !contradicting
      ) {
        // Borderline embeddings need lexical agreement (shared content words
        // after stemming) to qualify as duplicates.
        dups.push(h);
      } else if (h.score >= conflictThreshold && contradicting) {
        conflicts.push(h);
      }
    }
    const conflict = conflicts[0] ? { id: conflicts[0].id, score: conflicts[0].score } : null;
    return { duplicates: dups, conflict };
  } catch (e) {
    console.error(`MEMORY_ERROR stage=duplicate-search error=${JSON.stringify(String(e.message || e).slice(0, 120))}`);
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
      // Cloud targeting: LOCAL_ONLY stays on the device (security override),
      // but TEMPORARY_LOCAL is cloud-eligible — it is time-bound, not secret.
      // The security override (sensitivity >= 80 / secret patterns) always
      // produces LOCAL_ONLY, so it can never reach the queue through here.
      const cloudAllowed =
        decision.decision === engine.DECISIONS.LOCAL_AND_CLOUD ||
        decision.decision === engine.DECISIONS.TEMPORARY_LOCAL;
      const r = await memory.remember(candidate.text, payload, { cloudAllowed });
      // Never claim a store that did not happen — surface the failure instead.
      if (!r.ok) return { action: 'store-failed', error: r.error };
      return {
        action: 'stored',
        id: r.id,
        dims: r.dims, // real embedding length, measured at store time
        cloud: cloudAllowed && r.qdrant?.ok ? 'synced' : cloudAllowed ? 'pending' : 'local-only',
        queued: Boolean(r.queued),
        temporary: payload.temporary,
      };
    }

    case engine.DECISIONS.MERGE: {
      const dup = duplicates[0];
      const r = await memory.updatePoint(dup.id, { text: decision.mergedText });
      if (!r.ok) {
        // Duplicate lives only in the cloud (local store reset since): there is
        // no local point to merge into, and creating a new one would duplicate
        // the content. Report it honestly instead of pretending to merge.
        if (/point not found/i.test(r.error || '')) {
          return { action: 'merge-skipped', id: dup.id, reason: 'duplicate exists only in cloud; local store untouched' };
        }
        return { action: 'store-failed', error: r.error };
      }
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
// Fully instrumented; every failure surfaces as MEMORY_ERROR, never silence.
async function processMessage(userMessage, { source = 'chat' } = {}) {
  const t0 = Date.now();
  slog('PIPELINE_START', { source });
  try {
    // ---- 1. candidate extraction + scoring (LLM or deterministic fallback) ----
    let analysis;
    try {
      const tA = Date.now();
      analysis = await analyzer.analyzeMessage(userMessage, { llmChat: llmChatFn });
      slog(analysis.extract ? 'CANDIDATE_FOUND' : 'NO_CANDIDATE', {
        analyzer: analysis.source,
        ms: Date.now() - tA,
        extract: analysis.extract || '(none)',
      });
    } catch (e) {
      memError('analyzer', e);
      analysis = analyzer.heuristicAnalyze(userMessage);
      analysis.reason += ' (analyzer threw; deterministic fallback)';
    }

    // Empty extract: the analyzer found nothing worth remembering. Social
    // noise (greetings, small talk, questions to the assistant — importance
    // <= 10) is discarded outright. But an unclassified "general statement"
    // (fallback analyzer, importance ~30) keeps the raw message as the
    // candidate so the dedup/conflict machinery still applies to it — e.g.
    // "Machine A fan is still damaged." must CONFLICT with "...is repaired."
    const noise =
      !analysis.extract &&
      (analysis.category === 'greeting' ||
        analysis.importance <= 10 ||
        /question to the assistant|greeting|small talk/i.test(analysis.reason || ''));
    if (!analysis.extract && noise) {
      const record = {
        ts: Date.now(),
        at: new Date().toISOString(),
        source,
        message: String(userMessage).slice(0, 300),
        extract: '',
        scores: { sensitivity: analysis.sensitivity },
        analyzer: analysis.source,
        decision: 'DISCARD',
        priority: 0,
        reason: analysis.reason || 'no memory candidate',
        outcome: { action: 'discarded' },
        durationMs: Date.now() - t0,
      };
      audit(record);
      slog('DISCARDED', { reason: record.reason });
      slog('PIPELINE_DONE', { decision: 'DISCARD', action: 'discarded', total_ms: record.durationMs });
      return record;
    }

    const candidate = {
      text: analysis.extract || userMessage,
      conflict: null,
    };

    // ---- 2. semantic duplicate search ----
    // Checked against BOTH the normalized extract and the raw message: the
    // stored memories may be in either form, and paraphrase embeddings can sit
    // just above/below the gate depending on wording ("I am using X" 0.75 vs
    // its third-person extract 0.73 for the same stored fact).
    let duplicates = [];
    let conflict = null;
    try {
      const tD = Date.now();
      let found = await findDuplicates(candidate.text);
      if (!found.duplicates.length && !found.conflict && candidate.text !== userMessage) {
        const rawFound = await findDuplicates(userMessage);
        if (rawFound.duplicates.length || rawFound.conflict) found = rawFound;
      }
      duplicates = found.duplicates;
      conflict = found.conflict;
      slog('DUPLICATE_CHECK', { ms: Date.now() - tD, duplicates: duplicates.length, conflict: conflict ? 1 : 0 });
    } catch (e) {
      memError('duplicate-check', e);
    }
    candidate.conflict = conflict;

    // ---- 3. deterministic decision ----
    const decision = engine.decide(analysis, candidate, duplicates);
    slog('DECISION', { decision: decision.decision, priority: decision.priority, ms: Date.now() - t0 });
    if (decision.decision === engine.DECISIONS.MERGE && duplicates[0]) {
      slog('DUPLICATE_DETECTED', { action: 'MERGE_OR_UPDATE', duplicate_of: duplicates[0].id });
    }

    // ---- 4. execute (store / merge / flag / discard) ----
    let outcome;
    try {
      const tE = Date.now();
      outcome = await executeDecision(analysis, decision, candidate, duplicates);

      if (outcome.action === 'stored') {
        slog('STORED_LOCAL', { memory_id: outcome.id, dims: outcome.dims, cloud: outcome.cloud, ms: Date.now() - tE });
        if (outcome.queued) slog('QUEUED_FOR_SYNC', { memory_id: outcome.id });
        if (outcome.cloud === 'synced') slog('SYNCED', { memory_id: outcome.id, target: 'qdrant-cloud' });
      } else if (outcome.action === 'merged') {
        slog('MERGED', { memory_id: outcome.id, ms: Date.now() - tE });
      } else if (outcome.action === 'merge-skipped') {
        slog('MERGE_SKIPPED', { memory_id: outcome.id, reason: outcome.reason });
      } else if (outcome.action === 'conflict-flagged') {
        slog('CONFLICT_FLAGGED', { conflict_id: outcome.conflict_id, status: outcome.status });
      } else if (outcome.action === 'discarded') {
        slog('DISCARDED', { reason: decision.reason });
      } else if (outcome.action === 'store-failed') {
        memError('store', new Error(outcome.error), { memory_id: '(unassigned)' });
      }
    } catch (e) {
      outcome = { action: 'store-failed', error: String(e.message || e) };
      memError('execute', e);
    }

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
    slog('PIPELINE_DONE', { decision: decision.decision, action: outcome.action, total_ms: record.durationMs });
    return record;
  } catch (e) {
    // Last-resort guard: a memory pipeline failure must never escape as an
    // unhandled rejection, and never disappear silently.
    memError('pipeline', e);
    return { decision: 'ERROR', error: String(e.message || e), durationMs: Date.now() - t0 };
  }
}

module.exports = { processMessage, setLLMChat, findDuplicates, isSemanticDuplicate, DECISIONS_FILE };
