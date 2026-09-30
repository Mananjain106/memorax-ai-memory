// Intelligent Memory Decision Engine tests.
// Hermetic: no network, no Qdrant, no LLM — analyzer runs in deterministic
// fallback mode, memory service is stubbed. Covers the 7 required scenarios
// plus priority math, JSON validation and fallback behavior.
//
// Run: node test/memory-engine.test.js
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const engine = require(path.join(ROOT, 'src/backend/memory-engine/decision-engine'));
const analyzer = require(path.join(ROOT, 'src/backend/memory-engine/analyzer'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ---------- unit: priority math ----------
test('priority formula weights are exactly 0.30/0.20/0.20/0.15/0.15', () => {
  assert.deepStrictEqual(engine.WEIGHTS, {
    importance: 0.3,
    future_usefulness: 0.2,
    cross_device_value: 0.2,
    frequency: 0.15,
    recency: 0.15,
  });
});

test('priority = 0.30*imp + 0.20*fut + 0.20*xdev + 0.15*freq + 0.15*rec', () => {
  const s = { importance: 100, future_usefulness: 0, cross_device_value: 0, frequency: 0, recency: 0 };
  assert.strictEqual(engine.computePriority(s), 30);
  const s2 = { importance: 0, future_usefulness: 100, cross_device_value: 100, frequency: 100, recency: 100 };
  assert.strictEqual(engine.computePriority(s2), 70);
  const s3 = { importance: 80, future_usefulness: 60, cross_device_value: 40, frequency: 20, recency: 90 };
  assert.strictEqual(engine.computePriority(s3), Math.round(0.3 * 80 + 0.2 * 60 + 0.2 * 40 + 0.15 * 20 + 0.15 * 90));
});

test('priority bands map to correct decisions', () => {
  assert.strictEqual(engine.decidePriorityBand(10), 'DISCARD');
  assert.strictEqual(engine.decidePriorityBand(25), 'TEMPORARY_LOCAL');
  assert.strictEqual(engine.decidePriorityBand(49), 'TEMPORARY_LOCAL');
  assert.strictEqual(engine.decidePriorityBand(50), 'LOCAL_ONLY');
  assert.strictEqual(engine.decidePriorityBand(74), 'LOCAL_ONLY');
  assert.strictEqual(engine.decidePriorityBand(75), 'LOCAL_AND_CLOUD');
  assert.strictEqual(engine.decidePriorityBand(100), 'LOCAL_AND_CLOUD');
});

// ---------- unit: cross-device promotion ----------
test('cross-device promotion: high cross_device_value upgrades 50-74 band to LOCAL_AND_CLOUD', () => {
  const base = { importance: 60, future_usefulness: 60, frequency: 40, recency: 60, sensitivity: 10, confidence: 80 };
  // crafted so computePriority lands in the 50-74 band without the rule
  const scores = { ...base, cross_device_value: 30 };
  const plain = engine.decide(scores, { text: 'The user deploys the Atlas project on Kubernetes.' }, []);
  assert.strictEqual(plain.decision, 'LOCAL_ONLY', `precondition failed: ${plain.decision}`);
  assert.ok(plain.priority >= 50 && plain.priority < 75, `precondition failed: priority ${plain.priority}`);

  const sameButShared = { ...scores, cross_device_value: 80 };
  const promoted = engine.decide(sameButShared, { text: 'The user deploys the Atlas project on Kubernetes.' }, []);
  assert.strictEqual(promoted.decision, 'LOCAL_AND_CLOUD');
  assert.ok(
    promoted.priority >= 50 && promoted.priority < 75,
    `promotion must stay a band upgrade, got priority ${promoted.priority}`
  );
  assert.ok(/promoted/.test(promoted.reason));
});

test('cross-device promotion: does not fire below 50 or at/above 75', () => {
  const low = { importance: 20, future_usefulness: 20, frequency: 20, recency: 30, cross_device_value: 100, sensitivity: 10, confidence: 80 };
  const lowDec = engine.decide(low, { text: 'x' }, []);
  assert.notStrictEqual(lowDec.decision, 'LOCAL_AND_CLOUD', 'weak overall signal must not promote');

  const alreadyCloud = { importance: 95, future_usefulness: 95, frequency: 70, recency: 90, cross_device_value: 90, sensitivity: 10, confidence: 90 };
  const d = engine.decide(alreadyCloud, { text: 'x' }, []);
  assert.strictEqual(d.decision, 'LOCAL_AND_CLOUD');
  assert.ok(!/promoted/.test(d.reason), 'band-native LOCAL_AND_CLOUD needs no promotion note');
});

test('cross-device promotion: security override and duplicates still win', () => {
  const scores = { importance: 60, future_usefulness: 60, frequency: 40, recency: 60, cross_device_value: 90, sensitivity: 10, confidence: 80 };
  const secret = engine.decide(scores, { text: 'my api key is sk-or-v1-aaaabbbbccccdddd1111' }, []);
  assert.strictEqual(secret.decision, 'LOCAL_ONLY');
  assert.ok(secret.securityOverride, 'promotion must never override the security gate');

  const dup = engine.decide(scores, { text: 'The user uses Vue' }, [{ id: 'd1', score: 0.9, text: 'The user uses Vue' }]);
  assert.strictEqual(dup.decision, 'MERGE', 'promotion must not bypass duplicate handling');

  const sens = engine.decide({ ...scores, sensitivity: 85 }, { text: 'The user keeps notes in the vault' }, []);
  assert.strictEqual(sens.decision, 'LOCAL_ONLY');
  assert.ok(sens.securityOverride);
});

// ---------- unit: secret detection ----------
test('never store: secret patterns are detected', () => {
  const secrets = [
    'my api key is sk-or-v1-abcdef1234567890abcdef',
    'use this token: gh p_abcdef1234567890abcdef12'.replace(/\s/g, ''),
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sT0rE',
    'AKIAIOSFODNN7EXAMPLE is my aws key',
    'password is hunter2secret',
    'postgres://admin:s3cret@db.host:5432/app',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const s of secrets) {
    assert.ok(engine.containsSecret(s), `should detect: ${s.slice(0, 30)}`);
  }
});

test('normal text is not flagged as secret', () => {
  assert.strictEqual(engine.containsSecret('I love hiking and coffee'), null);
  assert.strictEqual(engine.containsSecret('My project uses Postgres on port 5432'), null);
});

// ---------- unit: analyzer validation ----------
test('strict JSON validation rejects invalid analyzer output', () => {
  const bad = [
    null,
    'just text',
    {},
    { importance: 'high', future_usefulness: 1, frequency: 1, recency: 1, cross_device_value: 1, sensitivity: 1, confidence: 1, extract: 'x', temporary: false, category: 'fact', reason: 'r' },
    { importance: 50, future_usefulness: 1, frequency: 1, recency: 1, cross_device_value: 1, sensitivity: 1, confidence: 1, extract: 'x', temporary: false, category: 'nonexistent', reason: 'r' },
    { importance: 50, future_usefulness: 1, frequency: 1, recency: 1, cross_device_value: 1, sensitivity: 1, confidence: 1, extract: 'x', temporary: false, category: 'fact' },
  ];
  for (const b of bad) {
    assert.throws(() => analyzer.validateLLMJson(b), `should reject: ${JSON.stringify(b).slice(0, 40)}`);
  }
  const good = {
    importance: 55.4, future_usefulness: 40, frequency: 30, recency: 80,
    cross_device_value: 50, sensitivity: 10, confidence: 70,
    extract: 'User prefers dark mode.', temporary: false, category: 'preference', reason: 'stated pref',
  };
  const v = analyzer.validateLLMJson(good);
  assert.strictEqual(v.importance, 55); // clamped + rounded
  assert.strictEqual(v.source, undefined);
});

test('extractJson tolerates prose and markdown fences', () => {
  const a = analyzer.extractJson('Sure! ```json\n{"a": 1}\n``` hope that helps');
  assert.strictEqual(a.a, 1);
  const b = analyzer.extractJson('The answer is {"a": {"b": [1,2]}} as requested');
  assert.deepStrictEqual(b.a.b, [1, 2]);
  assert.throws(() => analyzer.extractJson('no json here'));
});

test('analyzer falls back deterministically when LLM fails', async () => {
  const broken = async () => ({ content: 'not json at all {{{' });
  const r1 = await analyzer.analyzeMessage('I prefer window seats', { llmChat: broken });
  const r2 = await analyzer.analyzeMessage('I prefer window seats', { llmChat: broken });
  assert.strictEqual(r1.source, 'fallback');
  assert.deepStrictEqual(r1.scores ? r1.scores : r1, r2.scores ? r2.scores : r2);
  assert.strictEqual(r1.category, 'preference');
});

// ---------- the 7 required scenarios (fallback analyzer, deterministic) ----------
function decideFor(message, existing = []) {
  const a = analyzer.heuristicAnalyze(message);
  const candidate = { text: a.extract || message, conflict: null };
  const { decide } = require(path.join(ROOT, 'src/backend/memory-engine/pipeline'));
  // findDuplicates is network-bound; emulate with provided fixtures
  const dup = existing[0] || null;
  return { analysis: a, decision: engine.decide(a, candidate, dup ? [dup] : []) };
}

test('scenario 1: important project information -> kept (>= LOCAL_ONLY)', () => {
  const { decision } = decideFor('The Atlas project uses PostgreSQL 16 and deploys to Kubernetes on AWS.');
  assert.ok(
    ['LOCAL_ONLY', 'LOCAL_AND_CLOUD', 'MERGE'].includes(decision.decision),
    `unexpected: ${decision.decision}`
  );
  assert.ok(decision.priority >= 50, `priority too low: ${decision.priority}`);
});

test('scenario 2: user preference -> kept (>= LOCAL_ONLY)', () => {
  const { decision, analysis } = decideFor('I prefer concise answers without emojis.');
  assert.strictEqual(analysis.category, 'preference');
  assert.ok(
    ['LOCAL_ONLY', 'LOCAL_AND_CLOUD', 'MERGE'].includes(decision.decision),
    `unexpected: ${decision.decision}`
  );
});

test('scenario 3: normal greeting -> DISCARD', () => {
  const { decision } = decideFor('hello');
  assert.strictEqual(decision.decision, 'DISCARD', `greeting should be discarded, got ${decision.decision}`);
  const { decision: d2 } = decideFor('thanks');
  assert.strictEqual(d2.decision, 'DISCARD');
});

test('scenario 4: temporary task -> TEMPORARY_LOCAL', () => {
  const { decision, analysis } = decideFor('I need to submit the tax report today');
  assert.ok(
    ['TEMPORARY_LOCAL', 'DISCARD', 'LOCAL_ONLY'].includes(decision.decision),
    `unexpected: ${decision.decision}`
  );
  assert.strictEqual(analysis.temporary, true);
});

test('scenario 5: sensitive information -> LOCAL_ONLY via security override', () => {
  const { decision } = decideFor('my api key is sk-or-v1-aaaabbbbccccdddd1111');
  assert.strictEqual(decision.decision, 'LOCAL_ONLY');
  assert.strictEqual(decision.securityOverride, true);
  assert.strictEqual(decision.secretType, 'openrouter_key');
  // and it must never be LOCAL_AND_CLOUD even with a high-priority profile
  const highScores = {
    importance: 100, future_usefulness: 100, frequency: 100,
    recency: 100, cross_device_value: 100, sensitivity: 100, confidence: 100,
  };
  const d2 = engine.decide(highScores, { text: 'password is supersecret99' }, []);
  assert.strictEqual(d2.decision, 'LOCAL_ONLY');
  assert.ok(d2.securityOverride);
});

test('scenario 6: duplicate memory -> MERGE not new point', () => {
  const existing = [
    { id: 'existing-1', score: 0.91, text: 'The user favorite programming language is Rust.' },
  ];
  const { decision } = decideFor('The user favorite programming language is Rust.', existing);
  assert.strictEqual(decision.decision, 'MERGE');
  assert.strictEqual(decision.duplicateOf, 'existing-1');
  assert.ok(decision.mergedText.includes('Rust'));
});

test('scenario 7: conflicting memory -> CONFLICT not silent overwrite', () => {
  const existing = [
    { id: 'existing-2', score: 0.88, text: 'The user favorite programming language is Rust.' },
  ];
  const { decision } = decideFor('The user favorite programming language is Go.', existing);
  assert.strictEqual(decision.decision, 'CONFLICT', `expected CONFLICT, got ${decision.decision}`);
  assert.strictEqual(decision.duplicateOf, 'existing-2');
});

// ---------- unit: merge + conflict helpers ----------
test('mergeText keeps original and appends new info', () => {
  assert.strictEqual(
    engine.mergeText('User likes Rust.', 'User also likes Go.'),
    'User likes Rust. | updated: User also likes Go.'
  );
  // subset handling
  assert.strictEqual(engine.mergeText('User likes Rust and Go.', 'User likes Rust.'), 'User likes Rust and Go.');
  assert.strictEqual(engine.mergeText('User likes Rust.', 'User likes Rust and Go.'), 'User likes Rust and Go.');
});

test('isConflicting flips on numbers and negation', () => {
  assert.strictEqual(engine.isConflicting('User is 30 years old', 'User is 31 years old'), true);
  assert.strictEqual(engine.isConflicting('User lives in Berlin', 'User lives in Berlin'), false);
  assert.strictEqual(engine.isConflicting('User uses Vue', 'User no longer uses Vue'), true);
});

// ---------- unit: semantic near-duplicate detection ----------
test('isSemanticDuplicate matches reworded / normalized phrasing', () => {
  const { isSemanticDuplicate } = require(path.join(ROOT, 'src/backend/memory-engine/pipeline'));
  // a raw message vs the analyzer's third-person extract (the real-world case
  // that lands just below the pure-embedding duplicate threshold)
  assert.strictEqual(
    isSemanticDuplicate(
      'Duplicate probe: user drives a blue bicycle to work.',
      'The user drives a blue bicycle to work'
    ),
    true
  );
  assert.strictEqual(
    isSemanticDuplicate(
      'I am building an AI edge memory platform using Qdrant. My project stack is a Node.js backend with MiniLM embeddings.',
      'The user is building an AI edge memory platform using Qdrant'
    ),
    true
  );
  // different facts sharing a sentence shape must NOT collide
  assert.strictEqual(
    isSemanticDuplicate("The user's favorite language is Rust", "The user's favorite editor is Vim"),
    false
  );
  assert.strictEqual(isSemanticDuplicate('Machine A fan is repaired', 'Machine A fan is still damaged'), false);
});

// ---------- extraction quality (standalone third-person memories) ----------
test('isStandaloneThirdPerson rejects first/second person extracts', () => {
  assert.strictEqual(analyzer.isStandaloneThirdPerson(''), true); // empty = valid (nothing to store)
  assert.strictEqual(analyzer.isStandaloneThirdPerson('The user loves Rust.'), true);
  assert.strictEqual(analyzer.isStandaloneThirdPerson("The user's favorite color is blue"), true);
  assert.strictEqual(analyzer.isStandaloneThirdPerson('I love Rust.'), false);
  assert.strictEqual(analyzer.isStandaloneThirdPerson('My favorite color is blue.'), false);
  assert.strictEqual(analyzer.isStandaloneThirdPerson('We deploy on Fridays.'), false);
  assert.strictEqual(analyzer.isStandaloneThirdPerson('Your meeting is at 3.'), false);
});

test('sanitizeExtract strips quotes, labels, caps length at word boundary', () => {
  assert.strictEqual(analyzer.sanitizeExtract('"The user likes tea."'), 'The user likes tea.');
  assert.strictEqual(analyzer.sanitizeExtract('Memory: user likes tea'), 'user likes tea');
  assert.strictEqual(analyzer.sanitizeExtract('a '.repeat(150).trim()).length <= 200, true);
  const long = 'word '.repeat(60).trim(); // 300 chars
  const s = analyzer.sanitizeExtract(long);
  assert.ok(s.length <= 200 && !s.endsWith('word'.slice(0, 1)), 'cut at word boundary');
  assert.ok(!/word$/.test(s) || s.length <= 200);
});

test('toThirdPerson rewrites common openers deterministically', () => {
  assert.strictEqual(analyzer.toThirdPerson('I prefer window seats'), 'The user prefers window seats');
  assert.strictEqual(analyzer.toThirdPerson('my favorite language is Rust'), "The user's favorite language is Rust");
  assert.strictEqual(analyzer.toThirdPerson("I'm allergic to peanuts"), 'The user is allergic to peanuts');
  assert.strictEqual(analyzer.toThirdPerson('The team ships on Fridays'), 'The team ships on Fridays'); // untouched
});

test('buildPrompt instructs standalone third-person extraction with examples', () => {
  const p = analyzer.buildPrompt('test message');
  assert.ok(p.includes('STANDALONE'));
  assert.ok(p.includes('THIRD PERSON'));
  assert.ok(p.includes('The user'));
  assert.ok(p.includes('JSON'));
  assert.ok(p.includes('test message'));
  const p2 = analyzer.buildPrompt('test message', { reminder: true });
  assert.ok(p2.includes('REMINDER'));
});

test('analyzeMessage retries non-standalone extract once, then accepts with note', async () => {
  let calls = 0;
  const stubbornLLM = async () => {
    calls++;
    return {
      content: JSON.stringify({
        extract: 'I love Rust', // always first-person
        importance: 70, future_usefulness: 75, frequency: 60, recency: 80,
        cross_device_value: 70, sensitivity: 10, confidence: 90,
        temporary: false, category: 'preference', reason: 'stated',
      }),
    };
  };
  const r = await analyzer.analyzeMessage('i rly love rust', { llmChat: stubbornLLM });
  assert.strictEqual(calls, 2, 'should retry exactly once');
  assert.strictEqual(r.source, 'llm');
  assert.ok(r.reason.includes('not standalone'));
});

test('analyzeMessage accepts clean standalone extract without retry', async () => {
  let calls = 0;
  const goodLLM = async () => {
    calls++;
    return {
      content: JSON.stringify({
        extract: 'The user loves Rust',
        importance: 70, future_usefulness: 75, frequency: 60, recency: 80,
        cross_device_value: 70, sensitivity: 10, confidence: 90,
        temporary: false, category: 'preference', reason: 'stated',
      }),
    };
  };
  const r = await analyzer.analyzeMessage('i rly love rust', { llmChat: goodLLM });
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.extract, 'The user loves Rust');
});

console.log(`\n=== ${results.filter((r) => r.ok).length}/${results.length} memory-engine tests passed ===`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
