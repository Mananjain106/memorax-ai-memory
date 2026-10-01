# MemoraX — Models

*Your AI. Your Memory. Anywhere.*

MemoraX uses three models. Which ones serve a request is decided **strictly by connectivity**: ONLINE → OpenRouter (chat + analyzer), OFFLINE → local models only.

| Role | Online | Offline |
|---|---|---|
| Chat | OpenRouter chat model (e.g. `qwen/qwen3.8-27b:free`) + fallback chain | `Xenova/LaMini-Flan-T5-783M` (ONNX via transformers.js) |
| Memory analyzer | Same OpenRouter model (JSON-only prompt) | Deterministic heuristic analyzer |
| Embeddings | `Xenova/all-MiniLM-L6-v2` — 384-dim, always local | same |

## 1. Online chat models (OpenRouter)

### Selection

```env
OPENROUTER_MODEL=qwen/qwen3.8-27b:free
OPENROUTER_FALLBACK_MODELS=liquid/lfm-2.5-2.6b:free,google/gemma-4-26b-a4b-it:free
```

- The primary model is tried first; fallbacks follow in order.
- Requests are plain `{ model, messages[, stream] }` — **no `tools`, no `tool_choice`**, no tool is defined anywhere, and responses are parsed from the normal assistant `content` field.
- If the primary is "temporarily rate-limited upstream" (per-model limit), the chain continues automatically to the next model; the user only sees an error when the **entire** chain is busy.
- Daily free-tier quota (`free-models-per-day`) is a shared pool: the first such 429 opens a circuit breaker and blocks every further request for the Retry-After window (default 60 s, `QUOTA_BREAKER_MS` env, capped 24 h) with zero network calls.
- Model must support `chat/completions` (avoid "decisions"-style endpoints).

### Output sanitizer (Qwen tool-call leak)

Some chat templates emit tool-call markup unprompted, e.g. `<|tool_call_start|>[query(prompt='…', note='…')]<|tool_call_end|>`. It is stripped server-side in both streaming and non-streaming paths (including markers split across SSE deltas and streamed `delta.tool_calls`), so the UI only ever shows the final natural-language answer, with Markdown and code blocks intact. If nothing natural remains, a typed retryable provider error is shown instead.

### Free-tier rate limits (what to expect)

| Symptom | Meaning | What MemoraX does |
|---|---|---|
| `free-models-per-day limit reached` | daily shared quota exhausted | breaker + typed `DAILY_QUOTA_EXHAUSTED`, no auto retry |
| `temporarily rate-limited upstream` | that one model is busy | chain continues to the next model |
| other 429 | shared-pool short-term limit | chain stops, typed `RATE_LIMITED`, user Retry after Retry-After |
| 401/403 | bad key | typed `AUTH_ERROR`, chain stops |

## 2. Local chat model (OFFLINE)

| Setting | Default | Notes |
|---|---|---|
| `LOCAL_LLM_RUNTIME` | `transformers` | built-in ONNX; or `ollama` |
| `LOCAL_LLM_MODEL` | `Xenova/LaMini-Flan-T5-783M` | small instruction-tuned T5, CPU-friendly |
| `LOCAL_LLM_MAX_TOKENS` | `256` | generation cap |
| `LOCAL_LLM_URL` | `http://localhost:11434` | Ollama only |

- Runs fully on-device via `@huggingface/transformers` (ONNX, CPU); no cloud call in offline mode.
- First inference after a cold start loads the model (~20–30 s); later turns ~1 s.
- Quality is intentionally modest — it is a 783M model chosen for edge devices, not a frontier model.
- Streaming is word-paced from the completed generation; answers are real inference, never cached.

## 3. Embedding model

- `Xenova/all-MiniLM-L6-v2`, 384-dim, runs locally in both modes.
- The dimension is **measured at runtime** (never hardcoded) and must match the Qdrant collection (rebuild with `node scripts/recreate-collection.js` if you swap embedding models).
- Used for recall (top-K with relevance floor 0.15, raced vs 2.5 s) and for dedup (similarity ≥ 0.82 flags duplicates).

## 4. Caching & downloads

```bash
npm run prefetch   # caches both local models into ./models (~1 GB, idempotent)
```

- `models/` is gitignored; after prefetch, offline mode is fully self-contained.
- Without prefetch, models download on first use (requires network once).

## 5. Choosing a different online model

1. Pick a free chat model on [openrouter.ai/models](https://openrouter.ai/models) (supports `chat/completions`).
2. Set `OPENROUTER_MODEL` (and optionally `OPENROUTER_FALLBACK_MODELS`) in `.env`.
3. Restart; verify with `curl -s localhost:3000/health | grep openrouterModel`.

The sanitizer, error taxonomy, and fallback chain are model-agnostic — any chat model works, including ones that leak tool-call markup.
