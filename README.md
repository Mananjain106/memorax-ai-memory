# MemoraX 🧠

**Your AI. Your Memory. Anywhere.**

MemoraX is an offline-first AI memory assistant. It chats with you through a web UI, extracts long-term memories from what you say (like ChatGPT memory), and keeps them in a local vector store that syncs to Qdrant Cloud when a connection is available — your memory works **anywhere**, online or offline.

> 📐 **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md) · 🤖 **Models:** [MODEL.md](MODEL.md)

## How it works

```
┌─────────────┐   ONLINE  ──►  OpenRouter (Qwen + fallback chain)
│ connectivity│
│  detector   │   OFFLINE ──►  Local LLM (transformers.js, ONNX)
└─────────────┘
        │
        ▼
 Decision Engine ──► atomic memory extraction ──► 384-dim embeddings
        │                                             │
        ▼                                             ▼
  memory-decisions audit                    Qdrant (cloud ⇄ local store)
```

- **Strict routing**: `ONLINE → OpenRouter` only, `OFFLINE → Local LLM` only. The local model is **never** a fallback while online; a provider failure surfaces as a typed, retryable error instead.
- **Memory with judgment**: a Decision Engine scores every message (importance, future usefulness, sensitivity, …), extracts *atomic, standalone* facts, discards small talk, and is the only writer to memory. Relevant memories are injected back into future prompts.
- **Edge ⇄ cloud sync**: local-first writes, queued catch-up sync, conflict records, and a memory browser UI.

## Features

- 💬 Streaming chat (SSE) with Markdown + code blocks
- 🧠 Automatic long-term memory extraction & recall (semantic, top-K, relevance-floored)
- 📴 Real offline inference — no cached answers, a real local ONNX model
- 🔄 Cloud sync with catch-up queue, conflict tracking, and device identity
- 🛡️ Typed provider errors: daily quota, shared rate limit, per-model busy — each with the right retry semantics (no retry storms, one provider request per user message)
- 🧹 Server-side output sanitizer: model tool-call markup (e.g. `<|tool_call_start|>…<|tool_call_end|>`, stray special tokens, bare `query(...)` payloads) never reaches the UI
- 🔎 Memory browser: list, search, inspect, delete

## Quickstart

```bash
npm install
cp .env.example .env   # fill in OPENROUTER_API_KEY + QDRANT_* (see below)
npm run prefetch       # one-time local model download (~1 GB, cached in ./models)
npm start              # http://localhost:3000
```

Sanity check:

```bash
curl -s localhost:3000/health   # expect ok:true, mode ONLINE, memory.vectorSize 384
curl -s localhost:3000/status   # connectivity probe reason
```

No internet? It still works — chat answers via local ONNX inference and memory recall uses the local vector store (first offline reply takes ~20–30 s to load the model, then ~1 s).

## Prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| Node.js | 20 (tested on 24) | `node -v` |
| npm | 10+ | ships with Node |
| RAM | 8 GB (16 GB comfortable) | local LLM peak ~1.5–2 GB |
| Disk | ~1.5 GB | `models/` cache ≈ 1 GB, `node_modules/` ≈ 300 MB |
| Network | only for first model download + ONLINE mode | after `prefetch`, offline is fully self-contained |

## Configuration (`.env`)

| Var | Example | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | `sk-or-v1-…` | OpenRouter auth (required for ONLINE) |
| `QDRANT_URL` | `https://xxxx.cloud.qdrant.io` | Qdrant Cloud endpoint |
| `QDRANT_API_KEY` | JWT | Qdrant Cloud auth |
| `QDRANT_COLLECTION` | `ai_memory` | created automatically if missing |
| `OPENROUTER_MODEL` | `qwen/qwen3.8-27b:free` | primary online model |
| `OPENROUTER_FALLBACK_MODELS` | comma-separated | tried in order (per-model busy limits skip to the next) |
| `LOCAL_LLM_RUNTIME` | `transformers` | or `ollama` |
| `LOCAL_LLM_MODEL` | `Xenova/LaMini-Flan-T5-783M` | local inference model |
| `LOCAL_LLM_MAX_TOKENS` | `256` | generation cap |
| `LOCAL_LLM_URL` | `http://localhost:11434` | Ollama only |
| `PORT` | `3000` | HTTP port |
| `FORCE_OFFLINE` | `1` | force OFFLINE routing (tests; inference stays real) |
| `QUOTA_BREAKER_MS` | `60000` | quota-breaker window after a daily-quota 429 (capped 24 h) |

`.env` is gitignored — never commit it. Embeddings use `Xenova/all-MiniLM-L6-v2` (384-dim).

## Running

```bash
npm start                # production-ish: UI + API on :3000
npm run dev              # node --watch (auto-restart on change)
FORCE_OFFLINE=1 npm start  # deliberate offline run (real local inference)
```

Background start (bash on Windows):

```bash
(nohup node server.js > server.log 2>&1 & echo $! > server.pid)
# stop: taskkill //F //PID $(cat server.pid)
```

Exercise the product loop:

1. **Chat online** — `POST /api/chat` `{"messages":[{"role":"user","content":"Hi"}]}` → `mode:"ONLINE"`.
2. **Streaming** — `POST /api/chat/stream` → SSE `meta` → `delta*` → `done`.
3. **Memory** — `POST /api/memory/remember` then `GET /api/memory/recall?q=…`.
4. **Offline drill** — `FORCE_OFFLINE=1`, repeat → `mode:"OFFLINE"`, `engine:"local"`, recall `source:"local"`.
5. **Sync queue** — a memory created offline shows `PENDING` in `/api/sync/queue`, then `SYNCED` after reconnect (automatic).

## Data & logs

| Path | Contents |
|---|---|
| `data/local-memory.json` | local vector store (384-dim, full payloads) |
| `data/sync-queue.json` | persistent sync queue (survives restarts) |
| `data/activity.jsonl` | append-only lifecycle event log |
| `data/conflicts.json` | memory conflict records |
| `data/memory-decisions.jsonl` | per-decision audit trail |
| `data/device-id` | stable device identity |
| `models/` | cached ONNX models (gitignored) |
| `server.log` / `server.pid` | background-run artifacts |

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `429 free-models-per-day` | daily free-tier quota exhausted | typed error + breaker; no auto retry, no local fallback while online; use the UI Retry after the window |
| `<model> is temporarily rate-limited upstream` | that one model is busy | automatic — the chain continues to the next model |
| raw tool-call markup in an answer | Qwen-family chat-template artifact | filtered server-side (both stream paths); verify with `bash test/run-sanitizer.sh` |
| HTTP 400 on chat | model lacks `chat/completions` | pick a chat model for `OPENROUTER_MODEL` |
| `ECONNREFUSED http://:80` | malformed `QDRANT_URL` | include `https://` |
| `embedding dim … exceeds collection dim` | embedding model swapped | rebuild collection (`node scripts/recreate-collection.js`) |
| First offline answer slow | model load on CPU | expected (~20–30 s once per process), then ~1 s |
| Zombie dev server holds :3000 | previous unclean exit | `taskkill //F //PID <pid>` |

## Testing

```bash
npm test                            # API + offline suite (29 checks)
node test/memory-engine.test.js     # decision engine (27)
node test/lifecycle.test.js         # edge⇄cloud lifecycle (19)
node test/offline-retrieval.test.js # zero-network recall (5)
node test/optimization.test.js      # perf phases (11; needs a live server)
bash test/run-strict-routing.sh     # routing/429 semantics vs. a mock canary (27)
bash test/run-sanitizer.sh          # tool-call markup filtering E2E (14)
```

The canary suites run against a mock OpenRouter server — no real quota consumed. Note: lifecycle/offline-retrieval suites wipe the live Qdrant collection via `/api/memory/clear`.

## Tech stack

Node.js · Express · SSE · `@huggingface/transformers` (ONNX: LaMini-Flan-T5-783M + all-MiniLM-L6-v2) · Qdrant (`@qdrant/js-client-rest`) · OpenRouter API · vanilla JS frontend

## Project layout

```
server.js                     Express app + endpoints
src/backend/services/         chat, stream, openrouter, memory, sanitize, connectivity…
src/backend/memory-engine/    decision engine, analyzer, embeddings, pipeline
public/                       UI (app.js, markdown.js, style.css)
test/                         unit + live suites + mock OpenRouter canary
scripts/                      prefetch, cloud verification, collection tools
```

Deep dives: [ARCHITECTURE.md](ARCHITECTURE.md) (modules, routing, memory pipeline, sync, error taxonomy) · [MODEL.md](MODEL.md) (model selection, local models, quotas, sanitizer).
