// Streaming orchestrator: same routing rules as chat.js, but emits deltas.
const { detectMode } = require('../connectivity');
const config = require('../config');
const memory = require('./memory');
const pipeline = require('../memory-engine/pipeline');
const { sse, openRouterStream, localStream } = require('./stream');

// Fire-and-forget memory pipeline run (never delays or breaks the stream).
function runMemoryPipeline(userMessage, source) {
  pipeline
    .processMessage(userMessage, { source })
    .then((r) => {
      if (r.decision !== 'DISCARD' && r.decision !== 'ERROR') {
        console.log(`[memory-engine] ${r.decision} (priority ${r.priority}) <- "${String(userMessage).slice(0, 60)}"`);
      }
    })
    .catch((e) => {
      console.error(`MEMORY_ERROR stage=pipeline-dispatch source=${source} error=${JSON.stringify(String(e.message).slice(0, 160))}`);
    });
}

// Stage timing for the streaming lifecycle (same tags as chat.js).
function streamTimer() {
  const t0 = Date.now();
  let last = t0;
  return {
    mark(stage) {
      const now = Date.now();
      const ms = now - last;
      last = now;
      console.log(`[CHAT] ${stage} ${ms}ms`);
    },
    total() {
      return Date.now() - t0;
    },
  };
}

function buildSystemPrompt(recalled) {
  let sys = 'You are a helpful AI assistant with long-term memory. Answer concisely.';
  if (recalled.length) {
    sys += '\n\nRelevant memories:\n' + recalled.map((r) => `- ${r.text}`).join('\n');
  }
  return sys;
}

async function streamChat(messages, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const t = streamTimer();
  console.log('[CHAT] request started (stream)');
  let engineSent = false;
  let deltasEmitted = false;
  let firstDeltaAt = 0;
  const emitMeta = (engine, model, extra = {}) => {
    if (!engineSent) {
      engineSent = true;
      sse(res, 'meta', { engine, model, ...extra });
    }
  };

  // Local fallback: real inference, never cached answers.
  async function streamLocalFallback(mode, note) {
    emitMeta('local-fallback', config.local.model, note ? { note } : {});
    const tL = Date.now();
    let answer = '';
    for await (const delta of localStream(messages)) {
      if (!firstDeltaAt) {
        firstDeltaAt = Date.now();
        console.log(`[CHAT] FIRST DELTA ${t.total()}ms after request`);
      }
      answer += delta;
      sse(res, 'delta', { text: delta });
    }
    console.log(`[CHAT] LLM ${Date.now() - tL}ms (local fallback stream)`);
    // Memory pipeline runs here too — the degraded path is still a real answer
    // and must still learn from it (this was silently skipped before).
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser && answer.trim()) {
      runMemoryPipeline(lastUser.content, 'stream-degraded'); // async, never awaited
    }
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=${mode} (stream)`);
    sse(res, 'done', {
      engine: 'local-fallback',
      model: config.local.model,
      mode,
      note: note || undefined,
    });
    res.end();
  }

  try {
    const conn = await detectMode();
    t.mark('ROUTER');

    if (!conn.online) {
      // OFFLINE: local embeddings -> local vector search -> memories injected
      // into the local LLM prompt -> real local inference. No cloud anywhere.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const tM = Date.now();
      const recalled = lastUser ? await memory.recall(lastUser.content, 5) : [];
      console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms (local)`);
      const augmented = [...messages];
      if (lastUser && recalled.length) {
        const memCtx = recalled.map((r) => `- ${r.text}`).join('\n');
        const idx = augmented.map((m) => m.role).lastIndexOf('user');
        augmented[idx] = {
          role: 'user',
          content: `${lastUser.content}\n\n(Things you remember about the user:\n${memCtx}\nUse them if relevant.)`,
        };
      }
      emitMeta('local', config.local.model, { memories: recalled });
      const tL = Date.now();
      let answer = '';
      for await (const delta of localStream(augmented)) {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          console.log(`[CHAT] FIRST DELTA ${t.total()}ms after request`);
        }
        deltasEmitted = true;
        answer += delta;
        sse(res, 'delta', { text: delta });
      }
      console.log(`[CHAT] LLM ${Date.now() - tL}ms (local)`);
      if (lastUser && answer.trim()) {
        // Decision Engine is the only writer (see chat.js) — no raw Q&A dumps.
        runMemoryPipeline(lastUser.content, 'stream-offline'); // async, never awaited
      }
      console.log(`[CHAT] TOTAL ${t.total()}ms mode=OFFLINE (stream)`);
      sse(res, 'done', { engine: 'local', model: config.local.model, mode: 'OFFLINE' });
      return res.end();
    }

    // ONLINE: recall memories first, surface them in meta.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const tM = Date.now();
    const recalled = lastUser ? await memory.recall(lastUser.content) : [];
    console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms`);

    const models = [config.openrouter.model, ...config.openrouter.fallbackModels];
    let lastErr = null;
    for (const model of models) {
      let anyDelta = false;
      let answer = '';
      try {
        const tL = Date.now();
        for await (const delta of openRouterStream(model, [
          { role: 'system', content: buildSystemPrompt(recalled) },
          ...messages,
        ])) {
          if (!anyDelta) {
            anyDelta = true;
            emitMeta('openrouter', model, { memories: recalled });
          }
          if (!firstDeltaAt) {
            firstDeltaAt = Date.now();
            console.log(`[CHAT] FIRST DELTA ${t.total()}ms after request`);
          }
          deltasEmitted = true;
          answer += delta;
          sse(res, 'delta', { text: delta });
        }
        console.log(`[CHAT] LLM ${Date.now() - tL}ms (openrouter stream)`);
        if (!anyDelta) throw new Error('empty stream from provider');
        if (lastUser) {
          runMemoryPipeline(lastUser.content, 'stream-online'); // async, never awaited
        }
        console.log(`[CHAT] TOTAL ${t.total()}ms mode=ONLINE (stream)`);
        sse(res, 'done', { engine: 'openrouter', model, mode: 'ONLINE' });
        return res.end();
      } catch (e) {
        lastErr = e;
        if (e.status === 401 || e.status === 403) break; // auth fails for every model
        if (anyDelta) {
          // Mid-stream failure: model already partially answered, cannot restart.
          sse(res, 'error', { message: `stream interrupted: ${e.message.slice(0, 150)}` });
          return res.end();
        }
        console.warn(`[stream] model "${model}" failed pre-stream (${e.message.slice(0, 120)}); trying next`);
      }
    }

    // All online models failed before emitting anything -> local fallback.
    console.log(`[CHAT] LLM openrouter chain failed after ${Date.now() - t0}ms; degrading to local`);
    await streamLocalFallback(
      'ONLINE_DEGRADED',
      `OpenRouter unavailable: ${lastErr ? lastErr.message.slice(0, 120) : 'unknown error'}`
    );
  } catch (e) {
    console.error('[stream] error:', e.message.slice(0, 150));
    // If deltas already went out we must not re-run the model (would duplicate
    // text on screen); surface the error and close.
    if (deltasEmitted) {
      sse(res, 'error', { message: `stream interrupted: ${e.message.slice(0, 150)}` });
      return res.end();
    }
    try {
      await streamLocalFallback('OFFLINE', e.message.slice(0, 120));
    } catch (e2) {
      sse(res, 'error', { message: String(e2.message).slice(0, 200) });
      res.end();
    }
  }
}

module.exports = { streamChat };
