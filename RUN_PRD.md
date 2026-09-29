# RUN PRD — Offline-First AI Memory Assistant

Product Requirements Document for **running** the system locally: prerequisites, configuration, run modes, verification, and operational behavior.

- Product: `ai-memory-assistant` v0.2.0
- Stack: Node.js (CommonJS) + Express + transformers.js (ONNX, CPU) + Qdrant Cloud
- Platforms: Windows, macOS, Linux (bash shells supported)

---

## Quickstart

```bash
npm install
cp .env.example .env   # fill in OPENROUTER_API_KEY + QDRANT_* (see §3)
npm run prefetch       # one-time model download (~1 GB, cached in ./models)
npm start              # http://localhost:3000
```

Open http://localhost:3000 and chat. Sanity check:

```bash
curl -s localhost:3000/health   # expect mode ONLINE, memory.vectorSize 384
```

No internet? It still works — chat answers via local ONNX inference and memory recall uses the local vector store (first offline reply takes ~20–30 s to load the model, then ~1 s). Details: §2 Prerequisites, §3 Configuration, §4 Run modes, §5 Verification.

---

## 1. Goals

1. One-command startup (`npm start`) producing a fully working chat + memory assistant.
2. **Online mode**: OpenRouter chat completions + Qdrant Cloud vector memory, token-by-token streaming.
3. **Offline mode**: with zero network, chat must still work via real local ONNX inference and memory recall must still work via the local vector store. Never fake offline answers with cached text.
4. Every stored memory passes through the deterministic Decision Engine (the only writer to memory).
5. Graceful degradation everywhere: provider down → local fallback; cloud unreachable → queue and sync later.

Non-goals: multi-user auth, horizontal scaling, mobile apps.

---

## 2. Prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| Node.js | 20 (tested on 24) | `node -v` |
| npm | 10+ | ships with Node |
| RAM | 8 GB (16 GB comfortable) | local LLM peak ~1.5–2 GB |
| Disk | ~1.5 GB | `models/` cache ≈ 1 GB, `node_modules/` ≈ 300 MB |
| Network | only for first model download + ONLINE mode | after `prefetch`, offline is fully self-contained |

First run on a machine:

```bash
npm install       # once
npm run prefetch  # caches LLM + embedding models into ./models (gitignored)
```

`prefetch` is idempotent; skip it if `models/` already exists.

---

## 3. Configuration (`.env`)

Copy `.env.example` → `.env` and fill in the online credentials. `.env` is gitignored; never commit it.

### Required for ONLINE mode

| Var | Example | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | `sk-or-v1-…` | OpenRouter auth |
| `QDRANT_URL` | `https://xxxx.cloud.qdrant.io` | auto-normalized to `https://` |
| `QDRANT_API_KEY` | JWT | Qdrant Cloud auth |
| `QDRANT_COLLECTION` | `ai_memory` | created automatically if missing |

### Model selection

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_MODEL` | — | primary online model (must support `chat/completions`, not a "decisions" model) |
| `OPENROUTER_FALLBACK_MODELS` | — | comma-separated fallbacks, tried in order |
| `LOCAL_LLM_RUNTIME` | `transformers` | `transformers` (built-in ONNX) or `ollama` |
| `LOCAL_LLM_MODEL` | `Xenova/LaMini-Flan-T5-783M` | local inference model |
| `LOCAL_LLM_MAX_TOKENS` | `256` | generation cap |
| `LOCAL_LLM_URL` | `http://localhost:11434` | Ollama only |

### Optional

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `FORCE_OFFLINE` | unset | `1` forces OFFLINE routing (tests; inference stays real) |

Embedding model is fixed (`Xenova/all-MiniLM-L6-v2`, 384-dim, measured at runtime — never hardcoded).

---

## 4. Run modes

### 4.1 Production-ish start

```bash
npm start          # node server.js
```

- Serves UI + API on `http://localhost:3000`.
- Startup order: connectivity probe → Qdrant collection check/creation → pending-sync drain → memory pipeline LLM hookup → 30s background sync loop.
- `SIGINT` (Ctrl+C) stops the sync loop and exits cleanly.

### 4.2 Development

```bash
npm run dev        # node --watch server.js (auto-restart on change)
```

### 4.3 Deliberate offline run

Start the server with no internet access, or:

```bash
FORCE_OFFLINE=1 npm start
```

Expect: `/status` → `mode: "OFFLINE"`; chat answers via local ONNX inference (first inference ~20–30 s model load, then ~1 s); memory recall from the local store; cloud sync paused with backoff.

### 4.4 Background start (bash on Windows)

`nohup` form so the shell can exit:

```bash
(nohup node server.js > server.log 2>&1 & echo $! > server.pid)
```

Stop: `taskkill //F //PID $(cat server.pid)` (Windows) or `kill $(cat server.pid)`.

---

## 5. Verification (acceptance checks after start)

```bash
curl -s localhost:3000/health   # ok:true, mode ONLINE|OFFLINE, memory.vectorSize=384
curl -s localhost:3000/status   # online flag + probe reason
```

Then exercise the product loop:

1. **Chat online** — `POST /api/chat` `{"messages":[{"role":"user","content":"Hi"}]}` → reply with `mode:"ONLINE"`.
2. **Streaming** — `POST /api/chat/stream` → SSE `meta` → `delta*` → `done`.
3. **Memory store** — `POST /api/memory/remember` with `text/category/importance/...` → `ok:true`.
4. **Memory recall** — `GET /api/memory/recall?q=…` → semantically relevant hits.
5. **Offline drill** — kill network (or `FORCE_OFFLINE=1`), repeat 1 → reply `mode:"OFFLINE"`, `engine:"local"`; repeat 4 → hits from `source:"local"`.
6. **Sync queue** — a memory created offline appears in `/api/sync/queue` as `PENDING`, then `SYNCED` after reconnect (automatic; `/api/sync/now` forces a drain).

Full suites: `npm test` (18), `node test/memory-engine.test.js` (24), `node test/offline-retrieval.test.js` (5), `node test/lifecycle.test.js` (19).

---

## 6. Runtime behavior contract

- **Mode detection**: probes OpenRouter then qdrant.tech, 4 s timeout ×2 attempts, 15 s cache. Mode badge in UI reflects it.
- **Memory pipeline** (every chat turn, fire-and-forget, never delays an answer):
  extract/score (LLM or deterministic fallback) → dedup (`content_hash`, embedding ≥0.82, semantic near-dup ≥0.74) → deterministic decision → DISCARD / TEMPORARY_LOCAL / LOCAL_ONLY / LOCAL_AND_CLOUD / MERGE / CONFLICT.
- **Secrets never leave the device**: sensitivity ≥80 or secret-pattern match → LOCAL_ONLY, never enqueued.
- **Schema**: every memory carries all 12 required fields; embedding dim is measured from the model (384) and must match the Qdrant collection.
- **Sync queue**: persistent (`data/sync-queue.json`), exponential backoff `2^n·5 s` capped ~21 min, max 8 retries, crash-recovery from SYNCING→PENDING, conflict records for version clashes.
- **Durability**: local store writes are synchronous + atomic (tmp + rename). A hard kill never loses a memory.
- **Degradation ladder**: OpenRouter down → local fallback (`ONLINE_DEGRADED`); network down → OFFLINE (real local inference); Qdrant down → local memory + queue.

## 7. Data & logs

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

## 8. Failure runbook

| Symptom | Cause | Action |
|---|---|---|
| `429 free-models-per-day` | OpenRouter free tier exhausted | app degrades to `ONLINE_DEGRADED`; wait for reset or switch key |
| HTTP 400 on chat | model doesn't support `chat/completions` | pick a chat model for `OPENROUTER_MODEL` |
| `ECONNREFUSED http://:80` | malformed `QDRANT_URL` (missing `https://`) | fix URL; app normalizes but keep it valid |
| `embedding dim … exceeds collection dim` | embedding model swapped for a larger one | recreate collection (`node scripts/recreate-collection.js` pattern) |
| First offline answer slow | model load on CPU | expected (~20–30 s once per process); subsequent turns ~1 s |
| Zombie dev server holds :3000 | previous unclean exit | `taskkill //F //PID <pid>` |

## 9. Operational scripts

| Command | Effect |
|---|---|
| `npm run prefetch` | download/cache both models into `./models` |
| `node scripts/recreate-collection.js` | rebuild Qdrant collection at native 384-dim, preserving points (writes JSON backup first) |
| `npm test` | full API + offline suite |
| `node test/lifecycle.test.js` | 12-step Edge↔Cloud lifecycle (12 required scenarios) |
