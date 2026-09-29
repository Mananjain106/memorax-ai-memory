const config = require('./config');

const PROBE_URLS = [
  'https://openrouter.ai/api/v1/models', // our online LLM provider
  'https://qdrant.tech',                 // secondary connectivity signal
];

let state = {
  online: null, // null = unknown yet
  lastCheck: 0,
  reason: 'not checked yet',
  lastError: null,
  checking: false,
};

async function probe() {
  const errors = [];
  for (const url of PROBE_URLS) {
    // Two quick attempts per URL: a single dropped packet or DNS hiccup
    // should not flip the app to OFFLINE mode.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, method: 'GET' });
        clearTimeout(t);
        if (res.ok || res.status === 401 || res.status === 403) {
          // any HTTP response means the network path works
          return { online: true, url };
        }
        errors.push(`${url} -> HTTP ${res.status}`);
        break; // got an answer; further attempts won't change it
      } catch (e) {
        clearTimeout(t);
        errors.push(`${url} -> ${e.name}: ${e.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  return { online: false, reason: errors.join('; ') };
}

async function detectMode(force = false) {
  // Test/dev hook: forces OFFLINE routing. Inference is still real — this only
  // skips the reachability probe, it never substitutes cached answers.
  if (process.env.FORCE_OFFLINE === '1') {
    state.online = false;
    state.lastCheck = Date.now();
    state.reason = 'forced offline (FORCE_OFFLINE=1)';
    return state;
  }
  if (state.checking) return state;
  if (!force && state.online !== null && Date.now() - state.lastCheck < 15000) {
    return state; // cached for 15s
  }
  state.checking = true;
  try {
    const result = await probe();
    state.online = result.online;
    state.lastCheck = Date.now();
    state.reason = result.online ? `reachable: ${result.url}` : `unreachable: ${result.reason}`;
  } catch (e) {
    state.online = false;
    state.lastCheck = Date.now();
    state.reason = `probe error: ${e.message}`;
  } finally {
    state.checking = false;
  }
  return state;
}

function currentMode() {
  return {
    online: state.online,
    mode: state.online === null ? 'DETECTING' : state.online ? 'ONLINE' : 'OFFLINE',
    reason: state.reason,
    lastCheck: state.lastCheck,
    openrouterModel: config.openrouter.model,
    localRuntime: config.local.runtime,
    localModel: config.local.model,
  };
}

module.exports = { detectMode, currentMode };
