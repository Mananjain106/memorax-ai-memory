// Required end-to-end test:
//   Store "I am building an AI edge memory platform using Qdrant."
//   -> disconnect internet (all fetch fails, no test hooks)
//   -> ask "What project am I building?"
//   -> local semantic search must retrieve the memory and the local LLM must
//      generate a real answer grounded in it.
//
// Run: node test/offline-retrieval.test.js
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3133;
const BASE = `http://localhost:${PORT}`;
const results = [];
function log(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(envExtra) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logBuf = '';
  proc.stdout.on('data', (d) => (logBuf += d));
  proc.stderr.on('data', (d) => (logBuf += d));
  proc.log = () => logBuf;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/status`);
      if (r.ok) {
        const s = await r.json();
        if (s.online !== null) return proc;
      }
    } catch {}
    await sleep(500);
  }
  proc.kill();
  throw new Error('server did not start. Log:\n' + logBuf);
}
async function stopServer(proc) {
  return new Promise((resolve) => {
    proc.on('exit', resolve);
    proc.kill();
    setTimeout(resolve, 3000);
  });
}

(async () => {
  try {
    // ---------- Phase 1: ONLINE — store the memory through the real pipeline ----------
    console.log('\n--- Phase 1: store memory (online) ---');
    const onlineProc = await startServer({});
    // Clean room: earlier runs/tests may have left noise memories. The goal is
    // to verify the exact store -> offline -> retrieve -> answer flow.
    await fetch(`${BASE}/api/memory/clear`, { method: 'POST' });
    const stored = await (
      await fetch(`${BASE}/api/memory/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'I am building an AI edge memory platform using Qdrant.',
          category: 'project',
          importance: 85,
          future_usefulness: 90,
          sensitivity: 10,
          priority_score: 80,
        }),
      })
    ).json();
    log('store: memory accepted', stored.ok === true, stored.error || stored.id);
    await stopServer(onlineProc);

    // ---------- Phase 2: OFFLINE — zero network, retrieval + local inference ----------
    console.log('\n--- Phase 2: offline retrieval + local LLM ---');
    const offProc = await startServer({
      NODE_OPTIONS: '--require ./test/offline-net-block.js',
      FORCE_OFFLINE: '1',
    });

    // direct retrieval check through the decision pipeline's dedup search
    const rec = await (
      await fetch(`${BASE}/api/memory/recall?q=${encodeURIComponent('What project am I building?')}`)
    ).json();
    const hit = (rec.results || []).find((r) => /edge memory platform/i.test(String(r.text)));
    log(
      'semantic search retrieves stored memory offline',
      Boolean(hit),
      hit ? `score=${hit.score} source=${hit.source}` : `got ${(rec.results || []).length} irrelevant`
    );

    // the full chat path: local search -> injected context -> local LLM
    const chat = await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'What project am I building?' }] }),
      })
    ).json();

    const answer = String(chat.content || '');
    const grounded = /edge|memory|platform|qdrant|project/i.test(answer) && chat.memories.length > 0;
    log(
      'local LLM answers grounded in retrieved memory',
      chat.engine === 'local' && chat.mode === 'OFFLINE' && answer.length > 0 && grounded,
      `engine=${chat.engine} memories=${chat.memories.length} answer="${answer.slice(0, 80)}"`
    );
    log(
      'answer mentions the edge memory platform',
      /edge/i.test(answer) || /memory platform/i.test(answer) || /qdrant/i.test(answer),
      `answer="${answer.slice(0, 100)}"`
    );

    // schema completeness on the recalled memory
    if (hit) {
      const p = hit.payload || {};
      const required = ['memory_id', 'text', 'category', 'importance', 'future_usefulness', 'sensitivity', 'priority_score', 'created_at', 'updated_at', 'version', 'device_id', 'content_hash'];
      const missing = required.filter((k) => p[k] === undefined);
      log('memory carries full 12-field schema', missing.length === 0, missing.length ? `missing: ${missing.join(',')}` : 'all fields present');
    } else {
      log('memory carries full 12-field schema', false, 'no hit to inspect');
    }

    await stopServer(offProc);
  } catch (e) {
    console.error('FATAL:', e.message);
    results.push({ name: 'suite', ok: false });
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} offline-retrieval tests passed ===`);
  process.exit(passed === results.length ? 0 : 1);
})();
