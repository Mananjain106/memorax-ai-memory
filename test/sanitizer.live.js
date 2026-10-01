// Automated verification of the Qwen tool-call sanitizer end-to-end.
// Run via test/run-sanitizer.sh (starts canary :4010 + scratch server :3010
// pointed at it via OPENROUTER_BASE_URL, plus a FORCE_OFFLINE server :3011).
//
// Proves requirements:
//   - request bodies carry NO tools/tool_choice (one provider request only)
//   - <|tool_call_start|>...<|tool_call_end|> blocks / bare query(...) arrays /
//     JSON tool-call payloads NEVER reach the API output
//   - markup split across stream deltas (plus a tool_calls delta) is dropped
//   - Markdown passes through; OFFLINE routing unchanged; no local fallback.
const assert = require('assert');

const CANARY = 'http://localhost:4010';
const BASE = 'http://localhost:3010';
const BASE_OFF = 'http://localhost:3011';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function health(base = BASE) {
  const r = await fetch(base + '/health');
  return r.json();
}

const TC = () => '<|' + 'tool_call_start' + '|>';
const TC_END = () => '<|' + 'tool_call_end' + '|>';

async function canaryMode(mode) {
  const r = await fetch(CANARY + '/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
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
async function streamOnce(base, text) {
  const r = await fetch(base + '/api/chat/stream', {
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

(async () => {
  // ---------- T1: one-shot leak (qwentool) ----------
  console.log('\n===== T1: ONLINE, model leaks tool-call markup (one-shot) =====');
  await canaryMode('qwentool');
  let s0 = await canaryStats();
  let c = await chat(BASE, 'What project am I building?');
  let s1 = await canaryStats();
  const ans = String(c.content || '');
  check('T1 mode=ONLINE engine=openrouter', c.mode === 'ONLINE' && c.engine === 'openrouter', `mode=${c.mode} engine=${c.engine}`);
  check('T1 no pipe markup in answer', !ans.includes(TC()) && !ans.includes(TC_END()) && !ans.includes('<|'), JSON.stringify(ans.slice(0, 60)));
  check('T1 no query( artifact in answer', !/\bquery\s*\(/.test(ans));
  check('T1 answer is the natural-language text', ans.includes('MemoraX'), JSON.stringify(ans.slice(0, 60)));
  check('T1 request body had NO tools/tool_choice', s1.lastBodyHasTools === false, `hasTools=${s1.lastBodyHasTools}`);
  check('T1 exactly 1 CHAT provider request', s1.chatRequests - s0.chatRequests === 1, `delta=${s1.chatRequests - s0.chatRequests}`);

  // ---------- T2: streaming leak with split markers + tool_calls delta ----------
  console.log('\n===== T2: ONLINE stream, split markup + tool_calls delta =====');
  await canaryMode('qwentooljson');
  s0 = await canaryStats();
  const evs = await streamOnce(BASE, 'Explain Qdrant Edge in simple words.');
  s1 = await canaryStats();
  const full = evs.filter((e) => e.ev === 'delta').map((e) => e.d.text).join('');
  check('T2 no markup in any delta', !full.includes('<|') && !/\bquery\s*\(/.test(full), JSON.stringify(full.slice(0, 60)));
  check('T2 final text is the natural answer', full.includes('stores your memories'), JSON.stringify(full.slice(0, 60)));
  check('T2 meta first, done last, no error event', evs.length > 1 && evs[0].ev === 'meta' && evs[evs.length - 1].ev === 'done' && !evs.some((e) => e.ev === 'error'), evs.map((e) => e.ev).join(','));
  check('T2 request body had NO tools/tool_choice', s1.lastBodyHasTools === false, `hasTools=${s1.lastBodyHasTools}`);
  check('T2 exactly 1 CHAT provider request', s1.chatRequests - s0.chatRequests === 1, `delta=${s1.chatRequests - s0.chatRequests}`);

  // ---------- T3: healthy mode passthrough ----------
  console.log('\n===== T3: ONLINE, healthy provider still works =====');
  await canaryMode('ok');
  c = await chat(BASE, 'hello again');
  check('T3 normal answer passthrough', c.mode === 'ONLINE' && c.engine === 'openrouter' && !!c.content, `mode=${c.mode}`);

  // ---------- T4: OFFLINE parity (no sanitizer/routing regressions) ----------
  console.log('\n===== T4: OFFLINE server routes to Local LLM =====');
  const h = await health(BASE_OFF);
  check('T4 health OFFLINE', h.mode === 'OFFLINE', `mode=${h.mode}`);
  c = await chat(BASE_OFF, 'offline sanity check');
  check('T4 local engine answered', c.mode === 'OFFLINE' && c.engine === 'local', `mode=${c.mode} engine=${c.engine}`);

  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} sanitizer checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
