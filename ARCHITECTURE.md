# MemoraX — Architecture

*Your AI. Your Memory. Anywhere.*

MemoraX is an offline-first AI memory assistant: it chats through a web UI, extracts long-term memories from what you say (a ChatGPT-memory-style Decision Engine), and keeps them in a local vector store that syncs to Qdrant Cloud when connectivity allows.

```
                        ┌──────────────────────────┐
                        │        Web UI            │
                        │  public/app.js (SSE)     │
                        └────────────┬─────────────┘
                                     │ /api/chat/stream (SSE)
                        ┌────────────▼─────────────┐
                        │     Express (server.js)  │
                        └──┬───────────┬───────────┘
                 detectMode│           │chat / stream
              ┌────────────▼───┐   ┌───▼────────────────────────┐
   ONLINE ──► │ OpenRouter     │   │ Memory subsystem           │
             │ (Qwen + chain) │   │ memory.js · pipeline.js    │
             └──────┬─────────┘   │ analyzer · embed · sync    │
                    │             └───┬───────────┬────────────┘
                    ▼                 │           │
             typed errors       local store   Qdrant Cloud
             (429 taxonomy)     (atomic fs)   (catch-up sync)
```

## 1. Strict provider routing

Connectivity is probed (OpenRouter → qdrant.tech, 4 s timeout ×2, 15 s cache) and **chooses the provider once per request**:

| Mode | Chat engine | Memory recall | LLM analyzer |
|---|---|---|---|
| ONLINE | OpenRouter (`chat/completions`, streaming SSE) | Qdrant-backed recall, raced vs 2.5 s cap | OpenRouter (heuristic fallback on failure) |
| OFFLINE | Local LLM (transformers.js ONNX) | Local vector store | Local heuristic analyzer |

**Rules that never change:**

- ONLINE + provider failure → **typed error to the user**, never a local-LLM substitution.
- OFFLINE → zero cloud calls anywhere (chat, recall, analyzer, sync).
- UNKNOWN connectivity → resolve with the lightweight probe; never silently pick a provider.

`FORCE_OFFLINE=1` forces OFFLINE routing (inference stays real — used by tests).

## 2. Request lifecycle (streaming)

1. `POST /api/chat/stream` → SSE headers.
2. `detectMode()` → `ONLINE` / `OFFLINE` (probe on UNKNOWN).
3. Memory recall (`recallLocalOnly`, top-5, relevance floor 0.15) raced against 2.5 s.
4. `meta` event: engine, model, recalled memories.
5. Token deltas streamed (`delta` events), sanitized per-delta (see §6).
6. `done` event; the memory pipeline then processes the user message fire-and-forget.

Non-streaming `/api/chat` mirrors this without SSE.

## 3. Memory subsystem

### Decision Engine (the only writer to memory)

Every user message (fire-and-forget, never delays an answer):

```
extract/score → dedup → decision → write (local always; cloud if eligible)
```

- **Extract/score**: the LLM analyzer (OpenRouter when online, heuristic when offline) returns a 12-field schema: `extract, importance, future_usefulness, frequency, recency, cross_device_value, sensitivity, confidence, temporary, category, reason, priority_score`.
- **Dedup**: `content_hash` equality, embedding similarity ≥ 0.82, semantic near-dup ≥ 0.74.
- **Decisions**: `DISCARD / TEMPORARY_LOCAL / LOCAL_ONLY / LOCAL_AND_CLOUD / MERGE / CONFLICT`.
- **Cloud eligibility**: priority ≥ 75 → LOCAL_AND_CLOUD; 50–74 band promotes when `cross_device_value ≥ 75`. Security overrides and duplicate/conflict handling always win.
- **Secrets never leave the device**: sensitivity ≥ 80 or a secret-pattern match → LOCAL_ONLY, never enqueued.
- Every decision is appended to `data/memory-decisions.jsonl` (audit trail).

### Storage

- **Local vector store** (`data/local-memory.json`): full 384-dim payloads, synchronous + atomic writes (tmp + rename) — a hard kill never loses a memory.
- **Qdrant Cloud**: cloud-eligible points; embeddings `Xenova/all-MiniLM-L6-v2` (384-dim, measured at runtime, never hardcoded).

### Edge ⇄ cloud sync

- Cloud-eligible memories enqueue automatically when the cloud is unreachable; a 30 s background worker drains the queue when connectivity returns.
- Queue is persistent (`data/sync-queue.json`): survives restarts/crashes (stuck `SYNCING` → `PENDING`), exponential backoff `2^n·5 s` capped ~21 min, max 8 retries, version-clash conflict records.
- The queue **never** holds sensitive LOCAL_ONLY memories (enforced on both the queue and direct-push paths).

## 4. Providers

### OpenRouter (ONLINE chat)

- Model chain: `OPENROUTER_MODEL` + `OPENROUTER_FALLBACK_MODELS`, tried in order.
- Request bodies carry **no `tools` / `tool_choice`** and no tools are defined anywhere — responses are parsed from the normal assistant `content` field.
- 429 taxonomy (see §7): shared-pool limits stop the chain and surface typed errors; per-model limits continue the chain.
- Circuit breaker: a daily-quota exhaustion blocks further requests for the Retry-After window (default 60 s, `QUOTA_BREAKER_MS` configurable, capped 24 h) with zero network calls while open.
- API keys are never logged.

### Local LLM (OFFLINE chat)

- Runtime `transformers` (built-in ONNX, default `Xenova/LaMini-Flan-T5-783M`, `LOCAL_LLM_MAX_TOKENS=256`) or `ollama` (`LOCAL_LLM_URL`).
- First inference after a cold start loads the model (~20–30 s CPU); subsequent turns ~1 s.
- Streaming is paced word-by-word from the completed generation.

## 5. Connectivity detection

- Probe order: OpenRouter API → qdrant.tech; 4 s timeout, 2 attempts, 15 s result cache.
- UNKNOWN → the chat path runs the lightweight probe (never an AI request) before choosing a provider.
- UI status pill reflects the mode automatically (5 s poll); there is no manual mode switch.

## 6. Output sanitizer

Qwen-family chat templates occasionally emit tool-call markup although MemoraX sends no tools. `src/backend/services/sanitize.js` filters it in **both** paths:

- `<|tool_call_start|>…<|tool_call_end|>` blocks (incl. markers split across SSE deltas)
- alternate `<tool_call>…</tool_call>` wrappers
- stray `<|…|>` special tokens
- whole-message bare `query(...)` arrays / JSON tool-call payloads
- streamed `delta.tool_calls` are ignored, never yielded

Markdown, code fences and normal prose pass through untouched. If nothing natural remains, a typed retryable provider error is shown — raw payloads never reach the UI. Verify: `bash test/run-sanitizer.sh`.

## 7. Error taxonomy & retry semantics

| Condition | Classification | Behavior |
|---|---|---|
| 429 `free-models-per-day` | `DAILY_QUOTA_EXHAUSTED` | Breaker opens; no retry, no fallback-model chain, no local substitution |
| 429 other (shared pool) | `RATE_LIMITED` | Chain stops; user-initiated Retry after Retry-After |
| 429 `<model> is temporarily rate-limited upstream` | `MODEL_RATE_LIMITED` | **Chain continues** to the next model (no breaker) |
| 401/403 | `AUTH_ERROR` | Chain stops immediately |
| 5xx / timeout | `PROVIDER_ERROR` | Chain continues (retryable) |

If every model in the chain is busy, the user sees "All OpenRouter models in your chain are busy right now." with a user-initiated Retry.

## 8. Data & logs

| Path | Contents |
|---|---|
| `data/local-memory.json` | local vector store (384-dim, full payloads) |
| `data/sync-queue.json` | persistent sync queue |
| `data/activity.jsonl` | append-only lifecycle event log |
| `data/conflicts.json` | memory conflict records |
| `data/memory-decisions.jsonl` | per-decision audit trail |
| `data/device-id` | stable device identity |
| `models/` | cached ONNX models (gitignored) |
| `server.log` / `server.pid` | background-run artifacts |

## 9. Testing strategy

| Suite | Checks | Focus |
|---|---|---|
| `npm test` | 29 | API, sanitizer units, ONLINE/OFFLINE chat, memory round-trip |
| `test/memory-engine.test.js` | 27 | Decision Engine, dedup, schema |
| `test/lifecycle.test.js` | 19 | Edge⇄cloud lifecycle, queue, conflicts |
| `test/offline-retrieval.test.js` | 5 | Zero-network recall |
| `test/optimization.test.js` | 11 | Perf phases (needs a live server) |
| `bash test/run-strict-routing.sh` | 27 | Routing + 429 semantics vs. a mock OpenRouter canary |
| `bash test/run-sanitizer.sh` | 14 | Tool-call markup filtering E2E |

Canary suites run against `test/mock-openrouter.js` (modes `ok`, `daily`, `recover`, `qwentool`, `qwentooljson`, `permodel`) — no real quota consumed. Note: lifecycle/offline-retrieval suites wipe the live Qdrant collection via `/api/memory/clear`.
