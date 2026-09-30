const express = require('express');
const { detectMode, currentMode } = require('../connectivity');
const chatService = require('../services/chat');
const { streamChat } = require('../services/stream-chat');
const memory = require('../services/memory');
const config = require('../config');

const router = express.Router();

// Liveness + full status
router.get('/health', async (req, res) => {
  const conn = await detectMode();
  res.json({
    ok: true,
    uptime: process.uptime(),
    mode: conn.online ? 'ONLINE' : 'OFFLINE',
    connectivity: currentMode(),
    openrouter: { configured: Boolean(config.openrouter.apiKey), model: config.openrouter.model },
    local: {
      runtime: config.local.runtime,
      model: config.local.model,
      url: config.local.url,
    },
    memory: memory.status(),
  });
});

// Quick status poll for the UI badge
router.get('/status', async (req, res) => {
  const conn = await detectMode();
  res.json({ online: conn.online, mode: conn.online ? 'ONLINE' : 'OFFLINE', reason: conn.reason });
});

// Streaming chat (Server-Sent Events): meta -> delta* -> done | error
router.post('/api/chat/stream', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const cleaned = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'no valid user/assistant messages' });
    }
    await streamChat(cleaned, res);
  } catch (e) {
    console.error('[api/chat/stream]', e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.end();
    }
  }
});

router.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const cleaned = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'no valid user/assistant messages' });
    }
    const result = await chatService.chat(cleaned);
    res.json(result);
  } catch (e) {
    console.error('[api/chat]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/memory/remember', async (req, res) => {
  const { text, category, importance, future_usefulness, sensitivity, priority_score, temporary } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  res.json(
    await memory.remember(text, {
      category,
      importance,
      future_usefulness,
      sensitivity,
      priority_score,
      temporary,
    })
  );
});

router.get('/api/memory/recall', async (req, res) => {
  const q = String(req.query.q || '');
  if (!q) return res.status(400).json({ error: 'q query param required' });
  res.json({ results: await memory.recall(q) });
});

// ---- memory browser ----
router.get('/api/memory/list', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json(memory.listPoints(limit, offset));
});

router.delete('/api/memory/points/:id', async (req, res) => {
  try {
    res.json(await memory.deletePoint(req.params.id));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/memory/clear', async (req, res) => {
  try {
    res.json(await memory.clearAll());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/memory/sync', async (req, res) => {
  res.json(await memory.syncPending());
});

// ---- memory decision engine ----
const pipeline = require('../memory-engine/pipeline');

// Analyze a message through the full pipeline without storing anything extra
// (the pipeline still executes its decision — useful for tests/debugging).
router.post('/api/memory/analyze', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message string required' });
    }
    res.json(await pipeline.processMessage(message, { source: 'api-analyze' }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- sync queue / activity / conflicts ----
const syncQueue = require('../services/sync-queue');
const conflictsMod = require('../memory-engine/conflicts');

// Aggregated Edge Memory status for the UI popover (read-only).
// `?deep=1` additionally pings Qdrant (collectionExists) for a live cloud check;
// the cheap poll path relies on cached connectivity + last known push errors.
router.get('/api/memory/edge-status', async (req, res) => {
  try {
    const conn = await detectMode();
    const qCounts = syncQueue.counts();
    const mem = memory.status();
    let reachable = null; // null = unknown (shallow poll)
    if (req.query.deep === '1') {
      try {
        if (!conn.online || !mem.configured) throw new Error('offline or not configured');
        await memory.ensureCollection();
        reachable = true;
      } catch {
        reachable = false;
      }
    }
    // Last successful cloud sync from the activity log (newest at the end).
    let lastSyncAt = null;
    try {
      const events = syncQueue.readActivity(500);
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].event === syncQueue.EVENT.SYNCED) {
          lastSyncAt = events[i].ts;
          break;
        }
      }
    } catch {}
    res.json({
      ok: true,
      online: Boolean(conn.online),
      mode: conn.online ? 'ONLINE' : 'OFFLINE',
      localMemory: {
        active: true,
        count: mem.local.count,
        pending: mem.local.pending,
      },
      queue: qCounts,
      pendingSync: (qCounts.PENDING || 0) + (qCounts.SYNCING || 0),
      cloud: {
        configured: mem.configured,
        connected: Boolean(conn.online && mem.configured && (reachable === true || (reachable === null && !mem.disabledReason))),
        reachable,
        reason: mem.disabledReason || null,
      },
      openConflicts: conflictsMod.list({ status: 'REQUIRES_REVIEW' }).length,
      lastSyncAt,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/sync/queue', (req, res) => {
  res.json({ counts: syncQueue.counts(), items: syncQueue.all() });
});

router.post('/api/sync/now', async (req, res) => {
  res.json(await memory.syncPending());
});

router.get('/api/activity', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  res.json({ events: syncQueue.readActivity(limit).reverse() });
});

router.get('/api/conflicts', (req, res) => {
  res.json({ conflicts: conflictsMod.list({ status: req.query.status }) });
});

router.post('/api/conflicts/:id/resolve', async (req, res) => {
  try {
    const { resolution } = req.body || {};
    if (!['KEEP_LOCAL', 'KEEP_CLOUD', 'KEEP_BOTH'].includes(resolution)) {
      return res.status(400).json({ error: 'resolution must be KEEP_LOCAL, KEEP_CLOUD or KEEP_BOTH' });
    }
    const c = conflictsMod.list().find((x) => x.conflict_id === req.params.id);
    if (!c) return res.status(404).json({ error: 'conflict not found' });
    const memory = require('../services/memory');
    if (resolution === 'KEEP_LOCAL') {
      await memory.syncPending(); // pushes the local version again
    } else if (resolution === 'KEEP_CLOUD') {
      // fetch cloud payload and overwrite local
      const { QdrantClient } = require('@qdrant/js-client-rest');
      const config = require('../config');
      const client = new QdrantClient({ url: config.qdrant.url, apiKey: config.qdrant.apiKey, checkCompatibility: false });
      const r = await client.retrieve(config.qdrant.collection, { ids: [c.memory_id], with_payload: true });
      const cloudPayload = Array.isArray(r) ? r[0]?.payload : null;
      if (cloudPayload) {
        const { embed } = require('../services/embeddings');
        const vec = await embed(cloudPayload.text);
        localStoreRequire().add(c.memory_id, vec, cloudPayload, true);
      }
    }
    conflictsMod.setStatus(req.params.id, `RESOLVED_${resolution}`, 'USER');
    syncQueue.remove(c.memory_id);
    res.json({ ok: true, resolution });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function localStoreRequire() {
  return require('../services/local-store');
}

router.get('/api/memory/decisions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  try {
    const fs = require('fs');
    if (!fs.existsSync(pipeline.DECISIONS_FILE)) return res.json({ decisions: [] });
    const lines = fs.readFileSync(pipeline.DECISIONS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const decisions = lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return { unparsable: l.slice(0, 100) }; }
    });
    res.json({ decisions: decisions.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
