const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./src/backend/config');
const routes = require('./src/backend/routes');
const pipeline = require('./src/backend/memory-engine/pipeline');
const openrouter = require('./src/backend/services/openrouter');
const cloudSync = require('./src/backend/services/cloud-sync');
const { detectMode } = require('./src/backend/connectivity');
const memory = require('./src/backend/services/memory');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);

// 404 for unknown API routes
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.port, async () => {
  console.log(`MemoraX running at http://localhost:${config.port}`);
  detectMode().then((c) => console.log(`[connectivity] ${c.online ? 'ONLINE' : 'OFFLINE'} (${c.reason})`));
  memory.ensureCollection().catch((e) => console.warn(`[memory] qdrant unavailable: ${e.message}`));
  // Push locally-stored memories that never reached Qdrant (offline catch-up).
  memory.syncPending().catch((e) => console.warn(`[memory] catch-up sync failed: ${e.message}`));
  // Opportunistic cleanup of expired temporary memories.
  const purged = memory.purgeExpiredTemporary();
  if (purged) console.log(`[memory] purged ${purged} expired temporary memories`);
  // Wire the memory engine's analyzer to the OpenRouter chat function.
  // A 12s cap per model keeps memory analysis from stacking multi-model
  // retries — past that, the deterministic heuristic fallback takes over.
  pipeline.setLLMChat((messages) => openrouter.chat(messages, { signal: AbortSignal.timeout(12000) }));
  // Automatic cloud synchronization: startup drain + 30s background loop.
  memory.syncPending().catch((e) => console.warn(`[memory] startup sync failed: ${e.message}`));
  cloudSync.start(30000);
});

process.on('SIGINT', () => {
  cloudSync.stop();
  process.exit(0);
});
