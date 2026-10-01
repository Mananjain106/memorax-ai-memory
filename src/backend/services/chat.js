// Chat orchestrator: detects connectivity and routes to the right engine.
// ONLINE  -> OpenRouter (cloud)
// OFFLINE -> local LLM (real inference, never cached answers)
const { detectMode } = require('../connectivity');
const openrouter = require('./openrouter');
const { chatLocal, localRuntimeLabel } = require('./local-llm');
const memory = require('./memory');
const pipeline = require('../memory-engine/pipeline');
const perf = require('./perf');

// Fire-and-forget memory pipeline run. MUST never delay or break the answer.
// STRICT ROUTING: when offline, the pipeline uses the local heuristic analyzer
// and never calls OpenRouter.
function runMemoryPipeline(userMessage, source, { offline = false } = {}) {
  pipeline
    .processMessage(userMessage, { source, offline })
    .then((r) => {
      if (r.decision !== 'DISCARD' && r.decision !== 'ERROR') {
        console.log(`[memory-engine] ${r.decision} (priority ${r.priority}) <- "${String(userMessage).slice(0, 60)}"`);
      }
    })
    .catch((e) => {
      console.error(`MEMORY_ERROR stage=pipeline-dispatch source=${source} error=${JSON.stringify(String(e.message).slice(0, 160))}`);
    });
}

// Stage timing for the chat request lifecycle. Grep-able [CHAT] prefix:
//   [CHAT] request started / ROUTER 5ms / MEMORY SEARCH 120ms / LLM 2400ms / TOTAL 3100ms
function chatTimer() {
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

async function chat(userMessages) {
  const t = chatTimer();
  const p = perf.stage();
  console.log('[CHAT] request started');
  let conn = await detectMode();
  // UNKNOWN -> run the lightweight reachability probe (never an AI request)
  // before selecting a provider. Never silently pick one on UNKNOWN.
  if (conn.online === null) conn = await detectMode(true);
  const state = conn.online === true ? 'ONLINE' : conn.online === false ? 'OFFLINE' : 'UNKNOWN';
  t.mark('ROUTER');
  p.lap('routing');
  // Strict provider routing (see routing spec §16).
  console.log(`[ROUTER] state=${state}`);
  console.log(`[ROUTER] provider=${state === 'OFFLINE' ? 'LOCAL_LLM' : 'OPENROUTER'}`);
  console.log(`[ROUTER] local_llm=${state === 'OFFLINE' ? 'true' : 'false'}`);
  console.log(`[ROUTER] openrouter=${state === 'OFFLINE' ? 'false' : 'true'}`);
  if (state === 'UNKNOWN') {
    // No silent provider selection on UNKNOWN.
    return {
      error: 'connectivity unknown — provider not selected',
      mode: 'UNKNOWN',
      note: 'run the connectivity check and retry',
    };
  }

  if (!conn.online) {
    // OFFLINE: local embeddings -> local vector search -> memories injected
    // into the local LLM prompt -> real local inference. No cloud anywhere.
    const lastUser = [...userMessages].reverse().find((m) => m.role === 'user');
    const tM = Date.now();
    // PHASE 2/4: memory recall runs CONCURRENTLY with a bounded wait — a slow
    // embedding or unreachable backend must never stretch the answer path.
    // Recall is capped (top-K + relevance floor in memory.recall) so weakly
    // related memories never pollute the prompt.
    const recallP = lastUser
      ? memory.recallLocalOnly(lastUser.content, 5, { minRelevance: 0.15 })
      : Promise.resolve([]);
    const recalled = await Promise.race([recallP, new Promise((r) => setTimeout(() => r([]), 2500))]);
    console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms (local)`);
    p.lap('memory search');
    const augmented = [...userMessages];
    if (lastUser && recalled.length) {
      const memCtx = recalled.map((r) => `- ${r.text}`).join('\n');
      const idx = augmented.map((m) => m.role).lastIndexOf('user');
      augmented[idx] = {
        role: 'user',
        content: `${lastUser.content}\n\n(Things you remember about the user:\n${memCtx}\nUse them if relevant.)`,
      };
    }
    p.lap('prompt construction');
    const tL = Date.now();
    const content = await chatLocal(augmented);
    console.log(`[CHAT] LLM ${Date.now() - tL}ms (local)`);
    p.lap('LLM total');
    if (lastUser) {
      // The Decision Engine is the ONLY writer to memory. Unconditional
      // conversation dumps are gone: the engine extracts atomic facts and
      // discards questions/small talk, so raw Q&A logs never pollute recall.
      runMemoryPipeline(lastUser.content, 'chat-offline', { offline: true }); // async, never awaited
    }
    p.total('total');
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=OFFLINE`);
    return {
      content,
      engine: 'local',
      model: localRuntimeLabel(),
      memories: recalled,
      mode: 'OFFLINE',
    };
  }

  // ONLINE: recall memories, then ask OpenRouter. Recall is raced against a
  // bounded wait (PHASE 2): a slow Qdrant Cloud round-trip must never block
  // the answer; cloud sync never even enters this path.
  const lastUser = [...userMessages].reverse().find((m) => m.role === 'user');
  const tM = Date.now();
  const recallP = lastUser
    ? memory.recallLocalOnly(lastUser.content, 5, { minRelevance: 0.15 })
    : Promise.resolve([]);
  const recalled = await Promise.race([recallP, new Promise((r) => setTimeout(() => r([]), 2500))]);
  console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms`);
  p.lap('memory search');

  try {
    const sysPrompt = buildSystemPrompt(recalled);
    p.lap('prompt construction');
    const tL = Date.now();
    const result = await openrouter.chat([
      { role: 'system', content: sysPrompt },
      ...userMessages,
    ]);
    console.log(`[CHAT] LLM ${Date.now() - tL}ms (openrouter)`);
    p.lap('LLM total');
    // Run the intelligent memory pipeline (best-effort, fire-and-forget).
    if (lastUser) {
      runMemoryPipeline(lastUser.content, 'chat-online'); // async, never awaited
    }
    p.total('total');
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=ONLINE`);
    return {
      content: result.content,
      engine: 'openrouter',
      model: result.model,
      memories: recalled,
      mode: 'ONLINE',
    };
  } catch (e) {
    // STRICT ROUTING: while ONLINE, OpenRouter failing (rate limit, model down,
    // auth, outage) must surface as a typed error/retry state — NOT a silent
    // local LLM fallback. The provider is chosen by connectivity, not failures.
    // Daily-quota 429s are terminal: nothing retries automatically, the UI
    // shows the reason and the user decides when to try again.
    const typed = openrouter.classifyError(e);
    console.error(`[ROUTER] OPENROUTER_FAILED state=ONLINE error=${JSON.stringify(String(e.message || e).slice(0, 160))}`);
    console.log(`[OPENROUTER] error_type=${typed.error_type} automatic_retry=false`);
    // Memory extraction is about the USER's message, not the provider's reply —
    // it still runs even when the provider errored (never blocking the response).
    if (lastUser) {
      runMemoryPipeline(lastUser.content, 'chat-provider-error', { skipLLM: true }); // async, never awaited
    }
    p.total('total');
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=ONLINE_PROVIDER_ERROR`);
    const msg = String(e.message || e);
    const friendly =
      typed.error_type === 'DAILY_QUOTA_EXHAUSTED'
        ? 'OpenRouter is temporarily unavailable because the daily free-model quota has been reached. Please try again later.'
        : typed.error_type === 'RATE_LIMITED'
          ? `OpenRouter is rate-limited right now.${e.retryAfterSec ? ` Try again in ~${e.retryAfterSec}s.` : ' Please try again shortly.'}`
          : typed.error_type === 'MODEL_RATE_LIMITED'
            ? 'All OpenRouter models in your chain are busy right now. Please try again in a moment.'
            : `OpenRouter is temporarily unavailable: ${msg.slice(0, 180)}.`;
    return {
      error: friendly,
      engine: 'openrouter',
      mode: 'ONLINE_PROVIDER_ERROR',
      error_type: typed.error_type,
      retryable: typed.retryable,
      memories: recalled,
    };
  }
}

module.exports = { chat };
