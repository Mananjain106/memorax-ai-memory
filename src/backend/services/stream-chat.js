// Streaming orchestrator: same routing rules as chat.js, but emits deltas.
const { detectMode } = require('../connectivity');
const config = require('../config');
const memory = require('./memory');
const pipeline = require('../memory-engine/pipeline');
const { sse, openRouterStream, localStream } = require('./stream');
const openrouter = require('./openrouter');
const { ERROR_TYPES } = require('./openrouter');
const perf = require('./perf');

// Fire-and-forget memory pipeline run (never delays or breaks the stream).
// STRICT ROUTING: when offline, the pipeline must not call OpenRouter either —
// it runs the local heuristic analyzer instead of the LLM scorer. skipLLM does
// the same after a provider failure (429 etc.) so one user message never
// generates extra OpenRouter requests for memory analysis.
function runMemoryPipeline(userMessage, source, { offline = false, skipLLM = false } = {}) {
  pipeline
    .processMessage(userMessage, { source, offline, skipLLM })
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
  const p = perf.stage();
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

  // STRICT ROUTING: while ONLINE, an OpenRouter failure is surfaced to the
  // client as an error/retry state. There is deliberately NO local-LLM
  // fallback — the provider is chosen by connectivity, never by which
  // provider happens to fail (routing spec §§3,13,16).
  //
  // 429 handling: a daily free-tier quota exhaustion is terminal for this
  // day — the error is shown to the user and NOTHING is retried in the
  // background. The Retry action in the UI is a NEW user-initiated request.
  function emitProviderError(message, { retryable = true, lastUser = null, error_type = 'PROVIDER_ERROR' } = {}) {
    console.log(`[OPENROUTER] error_type=${error_type} automatic_retry=false`);
    sse(res, 'error', { message, retryable, provider: 'OPENROUTER', error_type });
    // Memory extraction still runs on the user's message even when the
    // provider errored — but with the LOCAL analyzer (skipLLM): the provider
    // just failed, and one user message must not trigger further requests.
    if (lastUser) {
      runMemoryPipeline(lastUser.content, 'stream-provider-error', { skipLLM: true }); // async, never awaited
    }
    p.total('total');
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=ONLINE_PROVIDER_ERROR (stream)`);
    res.end();
  }

  try {
    let conn = await detectMode();
    // UNKNOWN: resolve with the lightweight reachability probe (never an AI
    // request) before selecting a provider. No silent selection on UNKNOWN.
    if (conn.online === null) conn = await detectMode(true);
    const state = conn.online === true ? 'ONLINE' : conn.online === false ? 'OFFLINE' : 'UNKNOWN';
    t.mark('ROUTER');
    p.lap('routing');
    console.log(`[ROUTER] state=${state}`);
    console.log(`[ROUTER] provider=${state === 'OFFLINE' ? 'LOCAL_LLM' : 'OPENROUTER'}`);
    console.log(`[ROUTER] local_llm=${state === 'OFFLINE' ? 'true' : 'false'}`);
    console.log(`[ROUTER] openrouter=${state === 'OFFLINE' ? 'false' : 'true'}`);
    if (state === 'UNKNOWN') {
      emitProviderError('connectivity unknown — provider not selected', { retryable: true });
      return;
    }

    if (!conn.online) {
      // OFFLINE: local embeddings -> local vector search -> memories injected
      // into the local LLM prompt -> real local inference. No cloud anywhere.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const tM = Date.now();
      const recalled = lastUser
        ? await memory.recallLocalOnly(lastUser.content, 5, { minRelevance: 0.15 })
        : [];
      console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms (local)`);
      p.lap('memory search');
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
      p.lap('LLM total');
      if (lastUser && answer.trim()) {
        // Decision Engine is the only writer (see chat.js) — no raw Q&A dumps.
        runMemoryPipeline(lastUser.content, 'stream-offline', { offline: true }); // async, never awaited
      }
      console.log(`[CHAT] TOTAL ${t.total()}ms mode=OFFLINE (stream)`);
      sse(res, 'done', { engine: 'local', model: config.local.model, mode: 'OFFLINE' });
      return res.end();
    }

    // ONLINE: recall memories first, surface them in meta.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const tM = Date.now();
    const recalled = lastUser
      ? await memory.recallLocalOnly(lastUser.content, 5, { minRelevance: 0.15 })
      : [];
    console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms`);
    p.lap('memory search');

    p.lap('prompt construction');
    // Quota breaker open (shared free-tier pool): OpenRouter is known-dead for
    // the next window. STRICT: report the typed provider error, never use the
    // local LLM as a substitute while ONLINE. Zero OpenRouter requests are
    // made while the breaker is open.
    if (openrouter.breakerOpen()) {
      console.log('[ROUTER] OPENROUTER_FAILED state=ONLINE error="quota circuit breaker open"');
      emitProviderError(
        'OpenRouter is temporarily unavailable because the daily free-model quota has been reached. Please try again later.',
        { lastUser, error_type: ERROR_TYPES.DAILY_QUOTA_EXHAUSTED }
      );
      return;
    }
    console.log(`[PROVIDER] OPENROUTER (stream)`);
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
        p.lap('LLM total');
        if (!anyDelta) throw new Error('empty stream from provider');
        if (lastUser) {
          runMemoryPipeline(lastUser.content, 'stream-online'); // async, never awaited
        }
        p.total('total');
        console.log(`[CHAT] TOTAL ${t.total()}ms mode=ONLINE (stream)`);
        sse(res, 'done', { engine: 'openrouter', model, mode: 'ONLINE' });
        return res.end();
      } catch (e) {
        const typed = openrouter.classifyError(e);
        lastErr = typed;
        if (typed.error_type === ERROR_TYPES.DAILY_QUOTA_EXHAUSTED) {
          // Daily free-tier quota is a shared pool: every other free model is
          // dead too. Open the breaker, STOP the chain, tell the user. No
          // automatic retry — the window comes from Retry-After when present.
          openrouter.noteQuotaExhausted({ windowMs: e.retryAfterSec ? e.retryAfterSec * 1000 : Number(process.env.QUOTA_BREAKER_MS) || 60_000 });
          break;
        }
        if (typed.error_type === ERROR_TYPES.RATE_LIMITED) {
          // Short-term limit: retrying the remaining models right now would
          // only multiply 429s for a single user message. Stop here; the user
          // may retry manually after the server-provided Retry-After.
          break;
        }
        if (typed.error_type === 'AUTH_ERROR') break; // auth fails for every model
        if (anyDelta) {
          // Mid-stream failure: model already partially answered, cannot restart.
          sse(res, 'error', { message: `stream interrupted: ${e.message.slice(0, 150)}` });
          return res.end();
        }
        console.warn(`[stream] model "${model}" failed pre-stream (${e.message.slice(0, 120)}); trying next`);
      }
    }

    // All OpenRouter models failed pre-stream while ONLINE: strict typed
    // error, no local substitution, no background retry.
    console.log(`[ROUTER] OPENROUTER_FAILED state=ONLINE error=${JSON.stringify(String(lastErr?.message || 'unknown').slice(0, 140))}`);
    if (lastErr && lastErr.error_type === ERROR_TYPES.DAILY_QUOTA_EXHAUSTED) {
      emitProviderError(
        'OpenRouter is temporarily unavailable because the daily free-model quota has been reached. Please try again later.',
        { lastUser, error_type: ERROR_TYPES.DAILY_QUOTA_EXHAUSTED }
      );
    } else if (lastErr && lastErr.error_type === ERROR_TYPES.RATE_LIMITED) {
      const wait = lastErr.retryAfterSec ? ` Try again in ~${lastErr.retryAfterSec}s.` : ' Please try again shortly.';
      emitProviderError(`OpenRouter is rate-limited right now.${wait}`, {
        lastUser,
        error_type: ERROR_TYPES.RATE_LIMITED,
      });
    } else {
      emitProviderError(
        `OpenRouter is temporarily unavailable: ${lastErr ? String(lastErr.message).slice(0, 150) : 'unknown error'}.`,
        { lastUser, error_type: lastErr?.error_type || 'PROVIDER_ERROR' }
      );
    }
  } catch (e) {
    console.error('[stream] error:', e.message.slice(0, 150));
    // If deltas already went out we must not re-run the model (would duplicate
    // text on screen); surface the error and close.
    if (deltasEmitted) {
      sse(res, 'error', { message: `stream interrupted: ${e.message.slice(0, 150)}` });
      return res.end();
    }
    emitProviderError(`OpenRouter request failed: ${String(e.message).slice(0, 180)}`);
  }
}

module.exports = { streamChat };
