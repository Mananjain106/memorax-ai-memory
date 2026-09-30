// Online LLM via OpenRouter. Only used when connectivity says ONLINE.
// Tries the primary model, then any configured fallbacks (e.g. on 429).
const config = require('../config');

// Circuit breaker for the shared daily free-tier quota: once OpenRouter says
// "free-models-per-day" exhausted, EVERY free model is dead, so retrying the
// 3-model chain twice per chat message just burns seconds. Skip all calls
// until a short cool-down elapses (cheap single probe afterwards).
let quotaBreakerUntil = 0;

function quotaExhausted(e) {
  return /free-models-per-day/i.test(String(e && e.message));
}

function breakerOpen() {
  return Date.now() < quotaBreakerUntil;
}

async function chatOnce(model, messages, { signal } = {}) {
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'AI Memory Assistant',
    },
    body: JSON.stringify({ model, messages }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenRouter returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { content, model: data.model || model, provider: 'openrouter' };
}

async function chat(messages, { signal } = {}) {
  if (breakerOpen()) {
    const err = new Error('OpenRouter free-tier quota exhausted (circuit breaker open)');
    err.status = 429;
    err.quotaBreaker = true;
    throw err;
  }
  const models = [config.openrouter.model, ...config.openrouter.fallbackModels];
  let lastErr = null;
  for (const model of models) {
    try {
      return await chatOnce(model, messages, { signal });
    } catch (e) {
      lastErr = e;
      // Auth errors fail for every model — bail out immediately.
      if (e.status === 401 || e.status === 403) throw e;
      // Daily free-tier quota is a shared pool: the next free model is dead
      // too, so trying the fallbacks just wastes ~30s before giving up.
      if (quotaExhausted(e)) {
        quotaBreakerUntil = Date.now() + 60_000; // probe again after 60s
        throw e;
      }
      console.warn(`[openrouter] model "${model}" failed (${e.message.slice(0, 120)}); trying next`);
    }
  }
  throw lastErr;
}

module.exports = { chat };
