// Online LLM via OpenRouter. Only used when connectivity says ONLINE.
// STRICT ROUTING: an OpenRouter failure (429/401/403/500) is an OpenRouter
// availability problem, never an offline signal — the caller surfaces an error
// and the user decides. The local LLM is NEVER a fallback while online.
const config = require('../config');

// Circuit breaker for the shared daily free-tier quota: once OpenRouter says
// "free-models-per-day" exhausted, EVERY free model is dead. All further
// requests short-circuit to an instant DAILY_QUOTA_EXHAUSTED error — zero
// network calls, no retry loops — until the Retry-After window (or the default
// cool-down) elapses and the next call acts as the single probe.
const QUOTA_BREAKER_MS = Number(process.env.QUOTA_BREAKER_MS) || 60_000;
let quotaBreakerUntil = 0;

// Classification of OpenRouter failures (surfaced to chat.js / stream-chat.js
// and the UI). Daily free-tier quota ≠ short-term rate limit: the first must
// never be retried automatically; the second may allow a limited, user-prompted
// retry after Retry-After.
const ERROR_TYPES = {
  DAILY_QUOTA_EXHAUSTED: 'DAILY_QUOTA_EXHAUSTED',
  RATE_LIMITED: 'RATE_LIMITED',
};

function quotaExhausted(e) {
  return /free-models-per-day|daily quota|quota exhausted/i.test(String(e && e.message));
}

function breakerOpen() {
  return Date.now() < quotaBreakerUntil;
}

function msUntilBreakerCloses() {
  return Math.max(0, quotaBreakerUntil - Date.now());
}

// Record a quota exhaustion from any call path (streaming included) so the
// breaker protects every route, not just chat(). windowMs may come from the
// server's Retry-After header; capped so it can never hide a reset for hours.
function noteQuotaExhausted({ windowMs = QUOTA_BREAKER_MS } = {}) {
  quotaBreakerUntil = Math.max(quotaBreakerUntil, Date.now() + Math.min(windowMs, 24 * 3600_000));
}

// Build a typed Error from any OpenRouter failure. Never includes the API key.
function classifyError(e) {
  const err = e instanceof Error ? e : new Error(String(e || 'unknown error'));
  const status = err.status || 0;
  const msg = String(err.message || '');
  let error_type;
  let retryable;
  if (status === 429 && quotaExhausted(err)) {
    error_type = ERROR_TYPES.DAILY_QUOTA_EXHAUSTED;
    retryable = false; // automatic retry is meaningless until the daily reset
  } else if (status === 429) {
    error_type = ERROR_TYPES.RATE_LIMITED;
    retryable = true; // short-term limit: a user-prompted retry is allowed
  } else if (status === 401 || status === 403) {
    error_type = 'AUTH_ERROR';
    retryable = false;
  } else {
    error_type = 'PROVIDER_ERROR';
    // 5xx/timeouts are transient; auth-like errors inside the message stay non-retryable.
    retryable = !/401|403|not configured/i.test(msg);
  }
  err.error_type = error_type;
  err.retryable = retryable;
  return err;
}

function logRequestStarted(model) {
  console.log(`[OPENROUTER] request started model=${model}`);
}

function logHttp(status, model, detail = '') {
  console.log(`[OPENROUTER] HTTP ${status} model=${model}${detail ? ' ' + detail : ''}`);
}

async function chatOnce(model, messages, { signal } = {}) {
  logRequestStarted(model);
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
    logHttp(res.status, model, JSON.stringify(text.slice(0, 120)));
    const err = new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    const retryAfterSec = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      err.retryAfterSec = retryAfterSec; // server-provided: we never invent one
    }
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
  // Breaker open: instant typed failure. NO network call, NO retry, NO probe
  // storm. When the window elapses the next call goes through — that call IS
  // the probe, and one user message can only ever start one request.
  if (breakerOpen()) {
    const err = new Error(
      `OpenRouter free-tier quota exhausted (circuit breaker open, probe allowed in ${Math.ceil(msUntilBreakerCloses() / 1000)}s)`
    );
    err.status = 429;
    err.quotaBreaker = true;
    throw classifyError(err);
  }

  const models = [config.openrouter.model, ...config.openrouter.fallbackModels];
  let lastErr = null;
  for (const model of models) {
    try {
      return await chatOnce(model, messages, { signal });
    } catch (e) {
      lastErr = classifyError(e);
      logHttp(
        e.status || 'ERR',
        model,
        `error_type=${lastErr.error_type} automatic_retry=false`
      );
      // Auth errors fail for every model — bail out immediately.
      if (e.status === 401 || e.status === 403) throw lastErr;
      // Daily free-tier quota is a shared pool: every other free model is dead
      // too. Classify, open the breaker (respecting Retry-After if provided),
      // and STOP — no fallback-model chain, no retry, no local substitution.
      if (lastErr.error_type === ERROR_TYPES.DAILY_QUOTA_EXHAUSTED) {
        noteQuotaExhausted({ windowMs: e.retryAfterSec ? e.retryAfterSec * 1000 : QUOTA_BREAKER_MS });
        throw lastErr;
      }
      // Short-term 429: stop the chain too — fallbacks would just multiply
      // rate-limited requests for one user message.
      if (lastErr.error_type === ERROR_TYPES.RATE_LIMITED) throw lastErr;
      console.warn(`[openrouter] model "${model}" failed (${String(e.message).slice(0, 120)}); trying next`);
    }
  }
  throw lastErr ? classifyError(lastErr) : new Error('OpenRouter request failed');
}

module.exports = {
  chat,
  breakerOpen,
  noteQuotaExhausted,
  quotaExhausted,
  classifyError,
  ERROR_TYPES,
};