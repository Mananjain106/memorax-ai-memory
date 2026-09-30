// Live strict-routing / 429 verification (scratch server on :3010 + canary).
// Run: node test/strict-routing.live.js   (after test/run-strict-routing.sh)
//
// Scenarios (OPENROUTER_BASE_URL -> http://localhost:4010, no real quota used):
//   TEST 1: provider healthy -> ONLINE -> OpenRouter answers, no local fallback
//   TEST 2: daily quota 429  -> typed DAILY_QUOTA_EXHAUSTED, NO retry, NO local
//   TEST 3: message after the 429 -> instant breaker error, NO new provider calls
//   TEST 3b: streaming path parity (SSE typed error, no meta/delta, no local)
//   TEST 4: OFFLINE (separate FORCE_OFFLINE=1 server on :3011) -> Local LLM only
//   TEST 5: short-term 429 recovers -> user-initiated retry succeeds
const assert = require('assert');

const CANARY = 'http://localhost:4010';
const BASE = 'http://localhost:3010';
const BASE_OFF = 'http://localhost:3011';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(base = BASE) {
  const r = await fetch(base + '/health');
  return r.json();
}
async function canaryMode(mode, afterSec = 0) {
  const r = await fetch(CANARY + '/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, afterSec }),
  });
  return r.json();
}
async function canaryStats() {
  const r = await fetch(CANARY + '/stats');
  return r.json();
}
async function chat(base, text) {
  const r = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
  });
  return r.json();
}
async function streamOnce(text) {
  const r = await fetch(BASE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
  });
  const raw = await r.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    let ev = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) { try { events.push({ ev, d: JSON.parse(data) }); } catch {} }
  }
  return events;
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  // ---------- TEST 1: healthy provider ----------
  console.log('\n===== TEST 1: ONLINE + OpenRouter healthy =====');
  await canaryMode('ok');
  let h = await health();
  check('T1 health ONLINE', h.mode === 'ONLINE', `mode=${h.mode}`);
  const s0 = await canaryStats();
  let c = await chat(BASE, 'hello canary one');
  const s1 = await canaryStats();
  check('T1 OpenRouter answered (no local fallback)', c.mode === 'ONLINE' && c.engine === 'openrouter' && Boolean(c.content), `mode=${c.mode} engine=${c.engine} answer="${String(c.content).slice(0, 30)}"`);
  check('T1 exactly 1 provider request for 1 user message', s1.requests - s0.requests === 1, `requests=${s1.requests - s0.requests}`);

  // ---------- TEST 2: daily quota 429 ----------
  console.log('\n===== TEST 2: ONLINE + OpenRouter daily quota 429 =====');
  await canaryMode('daily');
  h = await health();
  check('T2 still ONLINE (quota != offline)', h.mode === 'ONLINE', `mode=${h.mode}`);
  const s2 = await canaryStats();
  c = await chat(BASE, 'hello canary two');
  const s3 = await canaryStats();
  check('T2 typed provider error, not an answer', c.mode === 'ONLINE_PROVIDER_ERROR' && !c.content, `mode=${c.mode} error="${String(c.error).slice(0, 70)}"`);
  check('T2 classified DAILY_QUOTA_EXHAUSTED', c.error_type === 'DAILY_QUOTA_EXHAUSTED', `error_type=${c.error_type}`);
  check('T2 not retryable (no auto retry)', c.retryable === false, `retryable=${c.retryable}`);
  check('T2 friendly message', /quota has been reached/i.test(String(c.error)), `msg="${String(c.error).slice(0, 80)}"`);
  check('T2 engine stayed openrouter (no local fallback)', c.engine === 'openrouter', `engine=${c.engine}`);
  check('T2 no fallback-model chain (primary request only)', s3.requests - s2.requests === 1, `provider requests=${s3.requests - s2.requests}`);

  // ---------- TEST 3: second message after the 429 ----------
  console.log('\n===== TEST 3: request after 429 makes NO new provider calls =====');
  const s4 = await canaryStats();
  const t0 = Date.now();
  c = await chat(BASE, 'hello canary three');
  const elapsed = Date.now() - t0;
  const s5 = await canaryStats();
  check('T3 fast breaker rejection (<500ms, no network loop)', elapsed < 500, `${elapsed}ms`);
  check('T3 ZERO new provider requests (breaker)', s5.requests === s4.requests, `delta=${s5.requests - s4.requests}`);
  check('T3 typed quota error again', c.mode === 'ONLINE_PROVIDER_ERROR' && c.error_type === 'DAILY_QUOTA_EXHAUSTED', `mode=${c.mode} error_type=${c.error_type}`);

  // ---------- TEST 3b: streaming path parity ----------
  console.log('\n===== TEST 3b: streaming path (SSE) =====');
  const s6 = await canaryStats();
  const evs = await streamOnce('hello canary stream');
  const s7 = await canaryStats();
  const errEv = evs.find((x) => x.ev === 'error');
  const metaEv = evs.find((x) => x.ev === 'meta');
  check('T3b SSE error emitted, no deltas', Boolean(errEv) && !evs.some((x) => x.ev === 'delta'), `events=${evs.map((x) => x.ev).join(',') || '(none)'}`);
  check('T3b typed quota error in SSE', Boolean(errEv) && errEv.d && errEv.d.error_type === 'DAILY_QUOTA_EXHAUSTED', `error_type=${errEv && errEv.d ? errEv.d.error_type : 'none'}`);
  check('T3b no local fallback in stream', !metaEv || metaEv.d.engine !== 'local', `meta=${metaEv ? JSON.stringify(metaEv.d).slice(0, 60) : 'none'}`);
  check('T3b ZERO new provider requests (breaker)', s7.requests === s6.requests, `delta=${s7.requests - s6.requests}`);

  // ---------- TEST 4: offline (separate server with FORCE_OFFLINE=1) ----------
  console.log('\n===== TEST 4: OFFLINE -> Local LLM only =====');
  h = await health(BASE_OFF);
  check('T4 offline server reports OFFLINE', h.mode === 'OFFLINE', `mode=${h.mode}`);
  const s8 = await canaryStats();
  const t4 = Date.now();
  c = await chat(BASE_OFF, 'What is the capital of France?');
  const s9 = await canaryStats();
  check('T4 local LLM answered', c.mode === 'OFFLINE' && c.engine === 'local' && Boolean(c.content), `mode=${c.mode} engine=${c.engine} in ${Date.now() - t4}ms answer="${String(c.content).slice(0, 40)}"`);
  check('T4 ZERO provider requests while offline', s9.requests === s8.requests, `delta=${s9.requests - s8.requests}`);

  // ---------- TEST 5: short-term 429 recovers via user Retry ----------
  console.log('\n===== TEST 5: short-term 429 + Retry-After -> user retry works =====');
  await canaryMode('recover', 2); // short-term 429 w/ Retry-After:1, recovers in 2s
  c = await chat(BASE, 'hello canary short-term'); // expect RATE_LIMITED error
  check('T5a short-term 429 classified RATE_LIMITED', c.mode === 'ONLINE_PROVIDER_ERROR' && c.error_type === 'RATE_LIMITED', `mode=${c.mode} error_type=${c.error_type || 'none'}`);
  check('T5a Retry-After surfaced', /again in ~1s|try again shortly/i.test(String(c.error)), `msg="${String(c.error).slice(0, 80)}"`);
  await sleep(2300); // user waits out the Retry-After window, then presses Retry
  c = await chat(BASE, 'hello canary retry'); // the UI "Retry" button = a new request
  check('T5b user retry after recovery succeeds', c.mode === 'ONLINE' && c.engine === 'openrouter' && Boolean(c.content), `mode=${c.mode} answer="${String(c.content).slice(0, 40)}"`);

  // ---------- summary ----------
  const fails = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - fails.length}/${results.length} strict-routing checks passed ===`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('RUNNER ERROR:', e.message);
  process.exit(1);
});
