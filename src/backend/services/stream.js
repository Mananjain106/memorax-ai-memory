// SSE event protocol used by /api/chat/stream:
//   meta  {engine, model, mode, memories?}  -> sent first, once the engine is chosen
//   delta {text}                            -> incremental answer tokens
//   done  {model, engine, mode}             -> final event, closes the stream
//   error {message}                         -> terminal failure
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Parse OpenRouter's SSE response body into {delta} chunks.
async function* sseLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop(); // keep the incomplete tail
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
}

async function* openRouterStream(model, messages, { signal } = {}) {
  const config = require('../config');
  console.log(`[OPENROUTER] request started model=${model} (stream)`);
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'AI Memory Assistant',
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.log(`[OPENROUTER] HTTP ${res.status} model=${model} (stream) ${JSON.stringify(text.slice(0, 120))}`);
    const err = new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    const retryAfterSec = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      err.retryAfterSec = retryAfterSec; // server-provided: never invent a delay
    }
    throw err;
  }
  for await (const data of sseLines(res.body)) {
    if (data === '[DONE]') return;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {
      // ignore keep-alive / comment fragments
    }
  }
}

// Ollama streams NDJSON lines: {"message":{"content":"..."},"done":false}
async function* ollamaStream(model, messages) {
  const config = require('../config');
  const res = await fetch(`${config.local.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.message?.content) yield json.message.content;
      } catch {}
    }
  }
}

// transformers.js pipelines generate the full text in one call (no token
// callback for T5 in this version), so we emit REAL inference output in
// word-sized chunks — genuine model output, delivered progressively.
async function* localStream(messages) {
  const { chatLocal } = require('./local-llm');
  const text = await chatLocal(messages);
  const chunks = text.match(/\S+\s*/g) || [text];
  for (const chunk of chunks) {
    yield chunk;
    await new Promise((r) => setTimeout(r, 10)); // light pacing, must not dominate latency
  }
}

module.exports = { sse, openRouterStream, ollamaStream, localStream };
