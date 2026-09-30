// Chat orchestrator: detects connectivity and routes to the right engine.
// ONLINE  -> OpenRouter (cloud)
// OFFLINE -> local LLM (real inference, never cached answers)
const { detectMode } = require('../connectivity');
const openrouter = require('./openrouter');
const { chatLocal, localRuntimeLabel } = require('./local-llm');
const memory = require('./memory');
const pipeline = require('../memory-engine/pipeline');

// Fire-and-forget memory pipeline run. MUST never delay or break the answer.
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
  console.log('[CHAT] request started');
  const conn = await detectMode();
  t.mark('ROUTER');

  if (!conn.online) {
    // OFFLINE: local embeddings -> local vector search -> memories injected
    // into the local LLM prompt -> real local inference. No cloud anywhere.
    const lastUser = [...userMessages].reverse().find((m) => m.role === 'user');
    const tM = Date.now();
    const recalled = lastUser ? await memory.recall(lastUser.content, 5) : [];
    console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms (local)`);
    const augmented = [...userMessages];
    if (lastUser && recalled.length) {
      const memCtx = recalled.map((r) => `- ${r.text}`).join('\n');
      const idx = augmented.map((m) => m.role).lastIndexOf('user');
      augmented[idx] = {
        role: 'user',
        content: `${lastUser.content}\n\n(Things you remember about the user:\n${memCtx}\nUse them if relevant.)`,
      };
    }
    const tL = Date.now();
    const content = await chatLocal(augmented);
    console.log(`[CHAT] LLM ${Date.now() - tL}ms (local)`);
    if (lastUser) {
      // The Decision Engine is the ONLY writer to memory. Unconditional
      // conversation dumps are gone: the engine extracts atomic facts and
      // discards questions/small talk, so raw Q&A logs never pollute recall.
      runMemoryPipeline(lastUser.content, 'chat-offline'); // async, never awaited
    }
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=OFFLINE`);
    return {
      content,
      engine: 'local',
      model: localRuntimeLabel(),
      memories: recalled,
      mode: 'OFFLINE',
    };
  }

  // ONLINE: recall memories from Qdrant, then ask OpenRouter
  const lastUser = [...userMessages].reverse().find((m) => m.role === 'user');
  const tM = Date.now();
  const recalled = lastUser ? await memory.recall(lastUser.content) : [];
  console.log(`[CHAT] MEMORY SEARCH ${Date.now() - tM}ms`);

  try {
    const tL = Date.now();
    const result = await openrouter.chat([
      { role: 'system', content: buildSystemPrompt(recalled) },
      ...userMessages,
    ]);
    console.log(`[CHAT] LLM ${Date.now() - tL}ms (openrouter)`);
    // Run the intelligent memory pipeline (best-effort, fire-and-forget).
    if (lastUser) {
      runMemoryPipeline(lastUser.content, 'chat-online'); // async, never awaited
    }
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=ONLINE`);
    return {
      content: result.content,
      engine: 'openrouter',
      model: result.model,
      memories: recalled,
      mode: 'ONLINE',
    };
  } catch (e) {
    // OpenRouter failed even though the net is up (rate limit, model down, etc.)
    // Fall back to the local model — still real inference, never cached text.
    console.error(`[chat] OpenRouter failed (${e.message}); falling back to local model`);
    const tL = Date.now();
    const content = await chatLocal(userMessages);
    console.log(`[CHAT] LLM ${Date.now() - tL}ms (local fallback)`);
    if (lastUser) {
      runMemoryPipeline(lastUser.content, 'chat-degraded'); // async, never awaited
    }
    console.log(`[CHAT] TOTAL ${t.total()}ms mode=ONLINE_DEGRADED`);
    return {
      content,
      engine: 'local-fallback',
      model: localRuntimeLabel(),
      memories: recalled,
      mode: 'ONLINE_DEGRADED',
      note: `OpenRouter error: ${e.message.slice(0, 150)}`,
    };
  }
}

module.exports = { chat };
