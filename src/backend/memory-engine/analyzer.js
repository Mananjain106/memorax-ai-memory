// Message analyzer: asks the LLM to score/extract a memory candidate, then
// STRICTLY validates the JSON. Any failure (bad JSON, missing/invalid fields,
// LLM down, no key) falls back to a deterministic heuristic scorer so the
// pipeline never breaks. The LLM never decides storage — it only proposes.
//
// Extraction quality rules (tuned): the "extract" field must be a standalone
// third-person sentence that makes sense with zero conversation context.
const { clamp, containsSecret } = require('./decision-engine');

const REQUIRED_SCORE_KEYS = [
  'importance',
  'future_usefulness',
  'frequency',
  'recency',
  'cross_device_value',
  'sensitivity',
  'confidence',
];

const VALID_CATEGORIES = [
  'identity',
  'preference',
  'project',
  'task',
  'fact',
  'credential',
  'greeting',
  'other',
];

function buildPrompt(message, { reminder = false } = {}) {
  const lines = [
    'You maintain the user\'s long-term memory, like ChatGPT memory does.',
    'Analyze the message below and reply with ONLY a JSON object — no prose, no markdown fences.',
    '',
    'The "extract" field is the memory candidate. It MUST obey ALL of these rules:',
    '1. STANDALONE: a complete sentence that makes sense with zero conversation context.',
    '2. THIRD PERSON: never use I, me, my, we, our, you, your — write "The user" / "The user\'s".',
    '3. ATOMIC: exactly one fact. Never merge unrelated facts into one memory.',
    '4. CONCRETE: keep names, numbers, versions, places, product/stack names exactly.',
    '5. DEREFFED: resolve pronouns to what they refer to; if you cannot, drop that part.',
    '6. SHORT: at most 160 characters.',
    '7. LANGUAGE: same language as the message.',
    '8. Greetings, thanks, small talk, questions to the assistant, and requests about the',
    '   conversation itself are NOT memories: use "" and low scores.',
    '',
    'EXAMPLES (message -> JSON):',
    'Message: "i rly love rust btw it\'s my fav lang"',
    '{"extract":"The user\'s favorite programming language is Rust","importance":70,"future_usefulness":75,"frequency":60,"recency":80,"cross_device_value":70,"sensitivity":10,"confidence":90,"temporary":false,"category":"preference","reason":"stated favorite language"}',
    'Message: "we deploy atlas on k8s at aws, postgres 16 behind it"',
    '{"extract":"The user deploys the Atlas project on Kubernetes at AWS with PostgreSQL 16","importance":75,"future_usefulness":80,"frequency":55,"recency":75,"cross_device_value":75,"sensitivity":20,"confidence":88,"temporary":false,"category":"project","reason":"project infrastructure facts"}',
    'Message: "i gotta submit the tax report today ugh"',
    '{"extract":"The user needs to submit the tax report today","importance":55,"future_usefulness":35,"frequency":30,"recency":90,"cross_device_value":40,"sensitivity":30,"confidence":80,"temporary":true,"category":"task","reason":"time-bound task"}',
    'Message: "hey there!"',
    '{"extract":"","importance":5,"future_usefulness":2,"frequency":10,"recency":50,"cross_device_value":2,"sensitivity":5,"confidence":95,"temporary":true,"category":"greeting","reason":"greeting, no long-term value"}',
    '',
  ];
  if (reminder) {
    lines.push(
      'REMINDER: your previous "extract" used first-person pronouns or was not standalone.',
      'Rewrite it as a third-person standalone sentence ("The user ...").',
      ''
    );
  }
  lines.push('Message:', JSON.stringify(message));
  return lines.join('\n');
}

// Strict validation: every field present, right type, right range.
// Returns normalized object or throws (caller applies fallback).
function validateLLMJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('not an object');
  }
  const out = {};
  for (const k of REQUIRED_SCORE_KEYS) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`missing/invalid ${k}`);
    out[k] = clamp(v);
  }
  if (typeof obj.extract !== 'string') throw new Error('missing extract');
  out.extract = obj.extract.trim().slice(0, 500);
  out.temporary = obj.temporary === true;
  if (!VALID_CATEGORIES.includes(obj.category)) throw new Error(`invalid category: ${obj.category}`);
  out.category = obj.category;
  if (typeof obj.reason !== 'string' || !obj.reason.trim()) throw new Error('missing reason');
  out.reason = obj.reason.trim().slice(0, 300);
  return out;
}

// Tolerant JSON extraction: models often wrap JSON in prose or fences.
function extractJson(text) {
  if (!text) throw new Error('empty LLM output');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(body.slice(start, end + 1));
}

// Does the sentence read as a standalone third-person memory?
// Empty extract is always valid ("nothing worth remembering").
const FIRST_OR_SECOND_PERSON = /\b(i|i'm|im|me|my|mine|we|our|ours|you|your|yours)\b/i;

function isStandaloneThirdPerson(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (FIRST_OR_SECOND_PERSON.test(t)) return false;
  return true;
}

// Deterministic cleanups: strip wrapping quotes / "Memory:" prefixes,
// collapse whitespace, cap length at a word boundary.
function sanitizeExtract(text) {
  let t = String(text || '').trim();
  t = t.replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019]+$/g, ''); // wrapping quotes
  t = t.replace(/^(memory|note|fact)\s*[:\-]\s*/i, ''); // label prefixes
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 200) {
    const cut = t.slice(0, 200);
    t = cut.slice(0, cut.lastIndexOf(' ')).trim() || cut.trim();
  }
  return t;
}

// Deterministic third-person rewriter for the heuristic fallback path.
// Conservative: only rewrites common openers, leaves anything else as-is.
function toThirdPerson(text) {
  let t = String(text || '').trim();
  const subs = [
    [/^my favorite\s+(\w[\w-]*)\s+is\b/i, "The user's favorite $1 is"],
    [/^my fav\s+(\w[\w-]*)\s+is\b/i, "The user's favorite $1 is"],
    [/^i\s+prefer\b/i, 'The user prefers'],
    [/^i\s+like\b/i, 'The user likes'],
    [/^i\s+love\b/i, 'The user loves'],
    [/^i\s+hate\b/i, 'The user hates'],
    [/^i\s+favor\b/i, 'The user favors'],
    [/^i(?:'m| am)\s+allergic\b/i, 'The user is allergic'],
    [/^my name is\b/i, "The user's name is"],
    [/^my\s+(\w+)\s+is\b/i, "The user's $1 is"],
    [/^i\s+work\b/i, 'The user works'],
    [/^i\s+live\b/i, 'The user lives'],
    [/^i\s+use\b/i, 'The user uses'],
    [/^i(?:'m| am)\s+using\b/i, 'The user is using'],
    [/^i(?:'m| am)\b/i, 'The user is'],
  ];
  for (const [re, rep] of subs) {
    if (re.test(t)) return t.replace(re, rep);
  }
  return t;
}

// Deterministic fallback scorer — used when the LLM is unavailable or invalid.
function heuristicAnalyze(message) {
  const m = String(message);
  const lower = m.toLowerCase();
  const secret = containsSecret(m);

  const scores = {
    importance: 30,
    future_usefulness: 25,
    frequency: 25,
    recency: 70,
    cross_device_value: 30,
    sensitivity: secret ? 95 : 20,
    confidence: 55,
  };

  const pref = /\b(i (?:prefer|like|love|hate|favor|always|usually)|my favorite|call me|i'?m allergic)\b/i.test(m);
  const identity = /\b(my name is|i am \d+ years old|i work (?:as|at|on)|i live in)\b/i.test(m);
  const project = /\b(project|codebase|repo|api|database|deploy|server|architecture|building|working on|developing|platform|using)\b/i.test(lower);
  const task = /\b(today|tomorrow|tonight|later|remind me|need to|going to|will)\b/i.test(lower);
  const greeting = /^(hi|hello|hey|yo|good (morning|evening|afternoon)|thanks|thank you|ok(?:ay)?|sup)\b[\s!.?]*$/i.test(lower.trim());
  // Social small talk ("Hello, how are you?", "how's it going?") is a question
  // to the assistant, not a fact about the user — never a memory. Deliberately
  // checked AFTER pref/identity/project so "hey, I'm building X" still stores.
  const smallTalk =
    /\b(how are you|how are things|how's it going|hows it going|what's up|whats up|nice to meet|pleasure to meet|good to see|talk to (?:you|soon)|see you later|goodbye)\b/i.test(m) ||
    /^(hi|hello|hey|yo|sup|thanks|thank you|good (morning|afternoon|evening))\b(\s+(there|everyone|all|again|team))?\b[,!.\s]*$/i.test(m.trim());
  // "hello, I prefer Vim" -> "I prefer Vim" (strip the social opener)
  const stripGreet = (s) => s.replace(/^\s*(hi|hello|hey|yo|sup|good\s*(?:morning|afternoon|evening))\b[,!\s]*/i, '').trim() || s.trim();
  // A question to the assistant ("What project am I building?") requests an
  // answer from memory; it is not itself a fact about the user. Checked before
  // topic matching so "what project ..." never matches the project branch.
  const question =
    /\?\s*$/.test(m.trim()) &&
    /^(what|who|whom|whose|where|when|why|how|which|is|are|am|do|does|did|can|could|should|would|will|shall|may|have|has)\b/i.test(m.trim());

  let category = 'other';
  let extract = '';
  let temporary = false;
  let reason = 'heuristic fallback: ';

  if (greeting) {
    category = 'greeting';
    reason += 'social greeting, no long-term value';
    scores.importance = 5;
    scores.future_usefulness = 2;
    scores.cross_device_value = 2;
  } else if (question) {
    category = 'other';
    reason += 'question to the assistant, not a user fact';
    scores.importance = 5;
    scores.future_usefulness = 2;
    scores.cross_device_value = 2;
  } else if (pref) {
    category = 'preference';
    extract = toThirdPerson(stripGreet(m.trim()));
    scores.importance = 70;
    scores.future_usefulness = 75;
    scores.cross_device_value = 70;
    reason += 'stated user preference';
  } else if (identity) {
    category = 'identity';
    extract = toThirdPerson(stripGreet(m.trim()));
    scores.importance = 80;
    scores.future_usefulness = 80;
    scores.cross_device_value = 85;
    reason += 'identity information';
  } else if (project) {
    category = 'project';
    extract = toThirdPerson(stripGreet(m.trim()));
    scores.importance = 65;
    scores.future_usefulness = 70;
    scores.cross_device_value = 60;
    reason += 'project-related detail';
  } else if (smallTalk) {
    category = 'greeting';
    reason += 'social small talk, no long-term value';
    scores.importance = 5;
    scores.future_usefulness = 2;
    scores.cross_device_value = 2;
  } else if (task) {
    category = 'task';
    extract = toThirdPerson(m.trim());
    scores.importance = 45;
    scores.future_usefulness = 40;
    scores.cross_device_value = 35;
    scores.recency = 85;
    temporary = true;
    reason += 'time-bound task, temporary';
  } else {
    reason += 'general statement';
  }

  if (secret) {
    scores.sensitivity = 95;
    category = 'credential';
    reason += '; credential-like content detected';
  }

  return { ...scores, extract: sanitizeExtract(extract), temporary, category, reason, source: 'fallback' };
}// Analyze with quality gate: if the LLM returns a non-standalone extract
// (first/second person), retry ONCE with a reminder before accepting.
// HTTP/network errors (429s, timeouts) fall back IMMEDIATELY — retrying a
// rate-limited provider just burns a minute before the heuristic kicks in.
async function analyzeMessage(message, { llmChat, maxAttempts = 2 } = {}) {
  if (typeof llmChat !== 'function') {
    return heuristicAnalyze(message);
  }

  const isTransportError = (e) =>
    /HTTP \d|fetch failed|timeout|abort|ECONN|ENOTFOUND|EAI_AGAIN|429|rate.?limit|circuit breaker/i.test(
      String(e.message || e)
    );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { content } = await llmChat([
        { role: 'user', content: buildPrompt(message, { reminder: attempt > 1 }) },
      ]);
      const validated = validateLLMJson(extractJson(content));

      if (validated.extract && !isStandaloneThirdPerson(validated.extract)) {
        if (attempt < maxAttempts) continue; // one retry with the reminder
        // Accept but note the quality issue — scores are still usable.
        validated.reason = `${validated.reason} (extract not standalone after retry)`;
      }
      validated.extract = sanitizeExtract(validated.extract);
      return { ...validated, source: 'llm' };
    } catch (e) {
      if (isTransportError(e) || attempt >= maxAttempts) {
        const fb = heuristicAnalyze(message);
        fb.reason = `${fb.reason} (LLM analysis failed: ${String(e.message).slice(0, 80)})`;
        return fb;
      }
      // malformed JSON / bad fields: retry once with the reminder prompt
    }
  }
  // unreachable, but keep the type checker honest
  return heuristicAnalyze(message);
}

module.exports = {
  buildPrompt,
  validateLLMJson,
  extractJson,
  isStandaloneThirdPerson,
  sanitizeExtract,
  toThirdPerson,
  heuristicAnalyze,
  analyzeMessage,
  REQUIRED_SCORE_KEYS,
  VALID_CATEGORIES,
};
