// Test canary: a mock OpenRouter /chat/completions server for verifying 429
// classification and strict routing without consuming real quota.
//
// Runtime control:
//   POST /mode  {"mode":"ok"} | {"mode":"daily"} | {"mode":"recover","afterSec":2}
//     ok      -> every chat request returns 200
//     daily   -> fallback models 429 free-models-per-day (daily quota)
//     recover -> short-term 429 (Retry-After: 1) until afterSec elapses, then 200
//   GET /stats  -> { requests, fourTwentyNines, oks, mode }
//
// Logs one line per request so upstream request counts per user message can be
// asserted exactly (no hidden retry loops).
const http = require('http');

const state = { mode: 'ok', modeSetAt: Date.now(), afterSec: 0, requests: 0, fourTwentyNines: 0, oks: 0 };

const body = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '1' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/mode')) {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const m = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        state.mode = m.mode || 'ok';
        state.afterSec = Number(m.afterSec) || 0;
        state.modeSetAt = Date.now();
        console.log(`[canary] mode -> ${state.mode}${state.afterSec ? ` (recovers after ${state.afterSec}s)` : ''}`);
        return body(res, 200, { ok: true, mode: state.mode });
      } catch {
        return body(res, 400, { ok: false });
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url.includes('/stats')) {
    return body(res, 200, { ...state });
  }
  if (!req.url.includes('/chat/completions')) {
    return body(res, 404, { error: 'not found' });
  }

  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    state.requests++;
    const reqModel = (Buffer.concat(chunks).toString('utf8').match(/"model":"([^"]+)"/) || [])[1] || '?';
    const recovering = state.mode === 'recover' && state.afterSec && Date.now() - state.modeSetAt > state.afterSec * 1000;
    const wantOk = state.mode === 'ok' || recovering;

    if (wantOk) {
      state.oks++;
      console.log(`[canary] request #${state.requests} model=${reqModel} -> 200`);
      // Valid analyzer-JSON so the memory pipeline accepts it in one request
      // (mirrors a real model answering the extraction prompt correctly).
      return body(res, 200, {
        model: reqModel,
        choices: [{ message: { role: 'assistant', content: '{"extract":"","importance":10,"future_usefulness":10,"frequency":10,"recency":10,"cross_device_value":10,"sensitivity":10,"confidence":95,"temporary":true,"category":"greeting","reason":"canary: no memory candidate"}' } }],
      });
    }

    state.fourTwentyNines++;
    if (state.mode === 'daily') {
      // Daily free-tier quota is a shared pool: EVERY free model is dead.
      console.log(`[canary] request #${state.requests} model=${reqModel} -> 429 free-models-per-day (DAILY)`);
      return body(res, 429, {
        error: { code: 429, message: 'Rate limit exceeded: free-models-per-day limit reached. Try again tomorrow.' },
      });
    }
    console.log(`[canary] request #${state.requests} model=${reqModel} -> 429 rate limit (short-term, Retry-After: 1)`);
    return body(res, 429, { error: { code: 429, message: 'Rate limit exceeded: shared pool capacity. Try again soon.' } });
  });
});

server.listen(Number(process.env.MOCK_PORT || 4010), () => {
  console.log(`[canary] mock OpenRouter on :${process.env.MOCK_PORT || 4010} (mode=ok)`);
});
