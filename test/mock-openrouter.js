// Test canary: a mock OpenRouter /chat/completions server for verifying 429
// classification and strict routing without consuming real quota.
//
// Runtime control:
//   POST /mode  {"mode":"ok"} | {"mode":"daily"} | {"mode":"recover","afterSec":N}
//               | {"mode":"qwentool"} | {"mode":"qwentooljson"}
//     ok          -> every chat request returns 200
//     daily       -> fallback models 429 free-models-per-day (daily quota)
//     recover     -> short-term 429 (Retry-After: 1) until afterSec elapses, then 200
//     qwentool    -> 200 but content leaks Qwen-style tool-call markup
//                    (<|tool_call_start|>[query(prompt='...',note='...')]<|tool_call_end|>)
//     qwentooljson-> 200 but delta carries tool_calls + markup split across deltas
//   GET /stats  -> { requests, chatRequests, analyzerRequests, fourTwentyNines, oks, mode }
//
// Logs one line per request so upstream request counts per user message can be
// asserted exactly (no hidden retry loops).
const http = require('http');

const state = { mode: 'ok', modeSetAt: Date.now(), afterSec: 0, requests: 0, chatRequests: 0, analyzerRequests: 0, fourTwentyNines: 0, oks: 0, lastBodyHasTools: null };

const body = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '1' });
  res.end(JSON.stringify(obj));
};

// Build Qwen-style leak payloads at runtime so this source never contains a
// literal special-token sequence.
const TC = (inner) => '<|' + 'tool_call_start' + '|>' + inner + '<|' + 'tool_call_end' + '|>';
const QUERY_CALL = "[query(prompt='What project am I building?', note='track user projects')]";

// Analyzer-safe JSON body (same as "ok" mode) — the memory pipeline accepts it.
const ANALYZER_OK = '{"extract":"","importance":10,"future_usefulness":10,"frequency":10,"recency":10,"cross_device_value":10,"sensitivity":10,"confidence":95,"temporary":true,"category":"greeting","reason":"canary: no memory candidate"}';

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
    const raw = Buffer.concat(chunks).toString('utf8');
    const reqModel = (raw.match(/"model":"([^"]+)"/) || [])[1] || '?';
    // Audit: does the request body carry a tools/tool_choice config? MemoraX
    // must never send one for normal chat.
    try {
      const parsed = JSON.parse(raw);
      state.lastBodyHasTools = !!(parsed.tools || parsed.tool_choice);
    } catch {
      state.lastBodyHasTools = null;
    }
    const recovering = state.mode === 'recover' && state.afterSec && Date.now() - state.modeSetAt > state.afterSec * 1000;
    const wantOk = ['ok', 'qwentool', 'qwentooljson', 'permodel'].includes(state.mode) || recovering;
    // The memory pipeline's analyzer asks for "ONLY a JSON object"; a real
    // Qwen answers it with JSON (not tool markup), so honor that: in the
    // leak modes, analyzer-shaped prompts always get the plain JSON answer.
    // Keeps request-count assertions exact (1 per user message).
    const isAnalyzerPrompt = raw.includes('ONLY a JSON object');
    if (isAnalyzerPrompt) state.analyzerRequests++;
    else state.chatRequests++;
    // permodel: the PRIMARY model is "temporarily rate-limited upstream"
    // (per-model limit) but every OTHER model answers normally — proves the
    // chain continues on MODEL_RATE_LIMITED instead of erroring the user.
    if (state.mode === 'permodel' && !isAnalyzerPrompt) {
      const fallbackHit = /fallback|gemma|liquid/i.test(reqModel);
      if (!fallbackHit) {
        state.fourTwentyNines++;
        console.log(`[canary] request #${state.requests} model=${reqModel} -> 429 temporarily rate-limited upstream (permodel)`);
        return body(res, 429, {
          error: { code: 429, message: `Provider returned error: ${reqModel} is temporarily rate-limited upstream. Please try again later.` },
        });
      }
    }
    const leakMode = state.mode === 'qwentool' || (state.mode === 'qwentooljson' && !isAnalyzerPrompt);
    if (wantOk && leakMode) {
      // Qwen tool-call leak simulation. The visible answer either starts with
      // raw markup (qwentool, one-shot) or has the markup split across stream
      // deltas with a tool_calls delta injected (qwentooljson). A correct
      // client shows ONLY the final natural-language sentence.
      state.oks++;
      console.log(`[canary] request #${state.requests} model=${reqModel} -> 200 (${state.mode} leak)`);
      if (state.mode === 'qwentool') {
        return body(res, 200, {
          model: reqModel,
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  TC(QUERY_CALL) +
                  ' You are building MemoraX, an offline-first AI memory assistant.',
              },
            },
          ],
        });
      }
      // qwentooljson: SSE body, markup split into 3 deltas + a tool_calls delta.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      const mk = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
      res.write(mk({ choices: [{ delta: { tool_calls: [{ function: { name: 'query', arguments: '{"prompt":"...' } }] } }] }));
      res.write(mk({ choices: [{ delta: { content: '<|' } }] }));
      res.write(mk({ choices: [{ delta: { content: 'tool_call_start' + '|>' } }] }));
      res.write(mk({ choices: [{ delta: { content: QUERY_CALL.slice(0, 20) } }] }));
      res.write(mk({ choices: [{ delta: { content: QUERY_CALL.slice(20) + '<|' } }] }));
      res.write(mk({ choices: [{ delta: { content: 'tool_call_end' + '|>' } }] }));
      res.write(mk({ choices: [{ delta: { content: ' MemoraX stores your memories locally and syncs them to the cloud.' } }] }));
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (wantOk) {
      state.oks++;
      console.log(`[canary] request #${state.requests} model=${reqModel} -> 200`);
      // Valid analyzer-JSON so the memory pipeline accepts it in one request
      // (mirrors a real model answering the extraction prompt correctly).
      return body(res, 200, {
        model: reqModel,
        choices: [{ message: { role: 'assistant', content: ANALYZER_OK } }],
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
