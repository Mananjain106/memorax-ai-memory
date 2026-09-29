// Test suite: health/status, ONLINE chat, OFFLINE chat (network blocked),
// streaming (both modes) and Qdrant memory round-trip.
// Usage: npm test
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || 3111;
const BASE = `http://localhost:${PORT}`;
const results = [];

function log(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  // wait for listen + first connectivity probe to resolve (mode not DETECTING)
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

// POST /api/chat/stream and collect SSE events
async function sseChat(messages) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`stream HTTP ${res.status}: ${await res.text()}`);
  const text = await res.text(); // wait for full stream
  const events = [];
  for (const block of text.split('\n\n')) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {}
    }
  }
  return events;
}

async function testOnline() {
  console.log('\n--- ONLINE tests ---');
  const proc = await startServer({});

  try {
    const h = await (await fetch(`${BASE}/health`)).json();
    log('health ok', h.ok === true && h.mode === 'ONLINE', `mode=${h.mode}`);
    log('memory configured', h.memory?.configured === true, `dim=${h.memory?.vectorSize}`);

    const s = await (await fetch(`${BASE}/status`)).json();
    log('status online', s.online === true && s.mode === 'ONLINE', s.reason);

    const c = await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'What is the capital of France? One short sentence.' }],
        }),
      })
    ).json();
    log(
      'online chat via OpenRouter',
      c.engine === 'openrouter' && c.content && c.mode === 'ONLINE',
      `model=${c.model} answer="${String(c.content).slice(0, 60)}"`
    );

    // --- streaming (online) ---
    const events = await sseChat([{ role: 'user', content: 'Count from 1 to 5, digits only.' }]);
    const meta = events.find((e) => e.event === 'meta');
    const deltas = events.filter((e) => e.event === 'delta');
    const done = events.find((e) => e.event === 'done');
    log(
      'stream: meta+deltas+done (online)',
      Boolean(meta) && deltas.length >= 3 && Boolean(done) && meta.data.engine === 'openrouter',
      `deltas=${deltas.length} model=${meta?.data?.model}`
    );
    const answer = deltas.map((d) => d.data.text).join('');
    log('stream: answer non-trivial', answer.trim().length > 3, `answer="${answer.slice(0, 50)}"`);

    // --- memory round-trip via API ---
    const marker = `test-marker-${Date.now()}`;
    const store = await (
      await fetch(`${BASE}/api/memory/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `The secret project codename is ${marker}.` }),
      })
    ).json();
    log('memory: remember ok', store.ok === true, store.error || '');

    await sleep(1000); // Qdrant indexing grace
    const rec = await (
      await fetch(`${BASE}/api/memory/recall?q=${encodeURIComponent('What is the secret project codename?')}`)
    ).json();
    const hit = (rec.results || []).some((r) => String(r.text).includes(marker));
    log('memory: recall finds stored text', hit, `${(rec.results || []).length} results`);

    // --- catch-up sync: push locally-pending points to Qdrant ---
    const sync = await (await fetch(`${BASE}/api/memory/sync`, { method: 'POST' })).json();
    log(
      'memory: catch-up sync runs',
      typeof sync.synced === 'number' && typeof sync.failed === 'number',
      `synced=${sync.synced} failed=${sync.failed}`
    );
  } finally {
    await stopServer(proc);
  }
}

async function testOffline() {
  console.log('\n--- OFFLINE tests (all fetch() fails) ---');
  const proc = await startServer({
    NODE_OPTIONS: '--require ./test/offline-net-block.js',
    FORCE_OFFLINE: '1',
  });

  try {
    const s = await (await fetch(`${BASE}/status`)).json();
    log('status offline', s.online === false && s.mode === 'OFFLINE', s.reason);

    const t0 = Date.now();
    const c = await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'What is the capital of France?' }],
        }),
      })
    ).json();
    const dt = Date.now() - t0;

    log(
      'offline chat = REAL local inference',
      c.engine === 'local' && c.mode === 'OFFLINE' && Boolean(c.content),
      `model=${c.model} in ${dt}ms answer="${String(c.content).slice(0, 60)}"`
    );

    // --- streaming (offline): real local inference delivered progressively ---
    const t1 = Date.now();
    const events = await sseChat([{ role: 'user', content: 'Say hello.' }]);
    const dtStream = Date.now() - t1;
    const meta = events.find((e) => e.event === 'meta');
    const deltas = events.filter((e) => e.event === 'delta');
    const done = events.find((e) => e.event === 'done');
    const answer = deltas.map((d) => d.data.text).join('').trim();
    log(
      'offline stream = REAL local inference',
      meta?.data?.engine === 'local' && deltas.length >= 1 && done?.data?.mode === 'OFFLINE' && answer.length > 0,
      `deltas=${deltas.length} in ${dtStream}ms answer="${answer.slice(0, 40)}"`
    );

    const h = await (await fetch(`${BASE}/health`)).json();
    log('health reports OFFLINE', h.mode === 'OFFLINE', `memory disabled gracefully=${Boolean(h.memory)}`);

    // --- OFFLINE memory round-trip: recall must work with zero network ---
    const offMarker = `offline-marker-${Date.now()}`;
    const offStore = await (
      await fetch(`${BASE}/api/memory/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Offline test fact: the vault code is ${offMarker}.` }),
      })
    ).json();
    log('offline memory: remember ok (local store)', offStore.ok === true, offStore.error || '');

    await sleep(300);
    const offRec = await (
      await fetch(`${BASE}/api/memory/recall?q=${encodeURIComponent('What is the vault code?')}`)
    ).json();
    const offHit = (offRec.results || []).some((r) => String(r.text).includes(offMarker));
    const offSrc = (offRec.results || [])[0]?.source;
    log(
      'offline memory: recall works with zero network',
      offHit && offSrc === 'local',
      `source=${offSrc} results=${(offRec.results || []).length}`
    );

    // Offline exchange must also land in local memory via chat
    const c2 = await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Tell me a one-word fact.' }] }),
      })
    ).json();
    log(
      'offline chat stores exchange in local memory',
      c2.engine === 'local' && Array.isArray(c2.memories),
      `memories=${c2.memories.length}`
    );

    // Memory browser API works offline
    const list = await (await fetch(`${BASE}/api/memory/list?limit=10`)).json();
    log(
      'memory browser: list offline',
      list.total >= 2 && Array.isArray(list.points),
      `total=${list.total} pending=${list.pending}`
    );
    const firstId = list.points[0]?.id;
    const del = await (await fetch(`${BASE}/api/memory/points/${firstId}`, { method: 'DELETE' })).json();
    log('memory browser: delete point (offline = local only)', del.ok === true, `local=${del.local}`);
  } finally {
    await stopServer(proc);
  }
}

(async () => {
  let failed = false;
  try {
    await testOnline();
    await testOffline();
  } catch (e) {
    console.error('FATAL:', e.message);
    failed = true;
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} tests passed ===`);
  process.exit(failed || passed !== results.length ? 1 : 0);
})();
