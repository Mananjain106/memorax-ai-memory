// Deterministic decision engine. The LLM only scores/extracts — this module
// alone decides what is stored, where, and how. Pure functions, no I/O.
const crypto = require('crypto');

const WEIGHTS = {
  importance: 0.3,
  future_usefulness: 0.2,
  cross_device_value: 0.2,
  frequency: 0.15,
  recency: 0.15,
};

const DECISIONS = {
  DISCARD: 'DISCARD',
  TEMPORARY_LOCAL: 'TEMPORARY_LOCAL',
  LOCAL_ONLY: 'LOCAL_ONLY',
  LOCAL_AND_CLOUD: 'LOCAL_AND_CLOUD',
  MERGE: 'MERGE',
  CONFLICT: 'CONFLICT',
};

const CATEGORIES = [
  'identity',
  'preference',
  'project',
  'task',
  'fact',
  'credential',
  'greeting',
  'other',
];

// High-precision patterns only — the engine must never hallucinate a secret.
// Each is tuned to real token formats rather than generic words.
const SECRET_PATTERNS = [
  { name: 'openrouter_key', re: /\bsk-or-[a-z0-9-]{16,}/i },
  { name: 'api_key_generic', re: /\b(sk|pk|rk)_[A-Za-z0-9]{12,}\b/ },
  { name: 'bearer_token', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'jwt', re: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/ },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'password_field', re: /\b(my\s+)?(password|passphrase)\s*(is|:|=)\s*\S+/i },
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'connection_string', re: /\b(postgres|postgresql|mongodb(\+srv)?|mysql|redis):\/\/[^\s]+:[^\s@]+@/i },
  { name: 'secret_kv', re: /\b(secret|token|api[-_]?key)\s*(is|:|=)\s*\S{8,}/i },
];

function containsSecret(text) {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return null;
}

// Deterministic pseudo-random jitter from content hash — same message always
// gets the same nudge, keeping decisions reproducible for tests.
function hashJitter(text) {
  const h = crypto.createHash('sha256').update(String(text).toLowerCase().trim()).digest();
  return (h[0] % 9) - 4; // -4..+4
}

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

// priority = .30*importance + .20*future_usefulness + .20*cross_device_value
//          + .15*frequency + .15*recency
function computePriority(scores) {
  let p = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    p += w * clamp(Number(scores[k]) || 0);
  }
  return clamp(p);
}

function decidePriorityBand(priority) {
  if (priority < 25) return DECISIONS.DISCARD;
  if (priority < 50) return DECISIONS.TEMPORARY_LOCAL;
  if (priority < 75) return DECISIONS.LOCAL_ONLY;
  return DECISIONS.LOCAL_AND_CLOUD;
}

function decide(scores, candidate, duplicates = []) {
  const priority = computePriority(scores);
  const reasonParts = [];

  // Rule 1 — never store secrets, regardless of anything else.
  const secret = containsSecret(candidate.text || '');
  if (secret) {
    return {
      decision: DECISIONS.LOCAL_ONLY,
      priority,
      reason: `security override: matched secret pattern "${secret}" — stored locally only, never synced`,
      securityOverride: true,
      secretType: secret,
    };
  }

  // Rule 2 — sensitivity >= 80 forces LOCAL_ONLY.
  if (clamp(scores.sensitivity) >= 80) {
    return {
      decision: DECISIONS.LOCAL_ONLY,
      priority,
      reason: `security override: sensitivity ${clamp(scores.sensitivity)} >= 80 — local only`,
      securityOverride: true,
    };
  }

  // Rule 3 — duplicate: merge into the existing memory, unless the new text
  // contradicts it, in which case flag a conflict (never silently overwrite).
  // Accept both recall shapes: {id, score, text} and {payload: {text}}.
  const dup = duplicates[0];
  if (dup) {
    const dupText = dup.payload?.text ?? dup.text ?? '';
    if (candidate.conflict || isConflicting(dupText, candidate.text)) {
      return {
        duplicateOf: dup.id,
        decision: DECISIONS.CONFLICT,
        priority,
        reason: `conflicts with existing memory (similarity ${dup.score.toFixed(2)}) — flagged, not overwritten`,
      };
    }
    return {
      duplicateOf: dup.id,
      decision: DECISIONS.MERGE,
      priority,
      mergedText: mergeText(dupText, candidate.text),
      reason: `duplicate of existing memory (similarity ${dup.score.toFixed(2)}) — merged`,
    };
  }

  // Rule 3b — contradiction found during dedup even though nothing qualified
  // as a duplicate. Must never fall through to the priority bands (that would
  // silently store the contradicting statement as a new memory).
  if (candidate.conflict) {
    return {
      duplicateOf: candidate.conflict.id,
      decision: DECISIONS.CONFLICT,
      priority,
      reason: `conflicts with existing memory (similarity ${candidate.conflict.score.toFixed(2)}) — flagged, not overwritten`,
    };
  }

  // Rule 5 — priority bands.
  if (priority < 25) {
    return {
      decision: DECISIONS.DISCARD,
      priority,
      reason: `priority ${priority} < 25 — not worth remembering`,
    };
  }
  if (priority < 50) {
    reasonParts.push(`priority ${priority} in 25-49 band`);
    return {
      decision: DECISIONS.TEMPORARY_LOCAL,
      priority,
      reason: reasonParts.join('; '),
    };
  }
  if (priority < 75) {
    return {
      decision: DECISIONS.LOCAL_ONLY,
      priority,
      reason: `priority ${priority} in 50-74 band — local memory only`,
    };
  }
  return {
    decision: DECISIONS.LOCAL_AND_CLOUD,
    priority,
    reason: `priority ${priority} >= 75 — local + cloud memory`,
  };
}

// Deterministic text merge for duplicates: keep the older framing, append new
// info, dedupe whitespace. Never drops the original phrasing entirely.
function coreOf(s) {
  return String(s).toLowerCase().replace(/[.!?]+$/, '').trim();
}

function mergeText(oldText, newText) {
  const t = (s) => String(s).replace(/\s+/g, ' ').trim();
  const o = t(oldText);
  const n = t(newText);
  if (!o) return n;
  if (!n) return o;
  if (coreOf(n) === coreOf(o)) return o;
  if (coreOf(o).includes(coreOf(n))) return o; // new is a subset
  if (coreOf(n).includes(coreOf(o))) return n; // old is a subset
  return `${o} | updated: ${n}`;
}

// Content words only — stopwords carry no topic signal, so a raw message and
// its normalized third-person extract ("The user ...") compare as the same
// fact instead of "conflicting" over function words. Negation words are NOT
// stopwords: they carry the contradiction signal.
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

// Conflict detection: same topic, contradicting content. Deterministic and
// cheap: number mismatch, negation flip, or high word overlap with differing
// key terms ("...is Rust" vs "...is Go"). Supersets are NOT conflicts.
function isConflicting(oldText, newText) {
  const a = significantTokens(oldText);
  const b = significantTokens(newText);
  if (!a.length || !b.length) return false;
  const setA = new Set(a);
  const setB = new Set(b);

  const num = (arr) => arr.filter((w) => /^\d+(\.\d+)?$/.test(w)).join(',');
  if (num(a) && num(b) && num(a) !== num(b)) return true; // different numbers, same topic

  const NEG = ['not', 'never', 'no', 'longer', 'stopped', 'removed', 'switched'];
  const hasNeg = (arr) => arr.some((w) => NEG.includes(w));
  if (hasNeg(a) !== hasNeg(b)) return true; // negation flip

  // subset/extension -> merge material, not a conflict
  const aInB = a.every((w) => setB.has(w));
  const bInA = b.every((w) => setA.has(w));
  if (aInB || bInA) return false;

  // high overlap + differing key words + similar length -> contradiction
  const common = a.filter((w) => setB.has(w)).length;
  const overlap = common / Math.max(a.length, b.length);
  const diffA = a.filter((w) => !setB.has(w)).length;
  const diffB = b.filter((w) => !setA.has(w)).length;
  if (overlap >= 0.5 && diffA >= 1 && diffB >= 1 && Math.abs(a.length - b.length) <= 2) {
    return true;
  }
  return false;
}

module.exports = {
  WEIGHTS,
  DECISIONS,
  CATEGORIES,
  SECRET_PATTERNS,
  containsSecret,
  computePriority,
  decide,
  decidePriorityBand,
  mergeText,
  isConflicting,
  significantTokens,
  hashJitter,
  clamp,
};
