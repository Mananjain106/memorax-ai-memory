// Lightweight performance instrumentation (PHASE 1).
// Usage: const perf = require('./perf'); const t = perf.stage();
//   t.lap('routing')        -> [PERF] routing: 8ms
//   t.total('total')        -> [PERF] total: 2910ms
// Everything is best-effort: logging must never break a request.
let enabled = true;
try {
  if (String(process.env.PERF_LOG || '').toLowerCase() === 'off') enabled = false;
  if (String(process.env.PERF_LOG || '').toLowerCase() === 'quiet') enabled = false;
} catch {}

function stage() {
  const t0 = Date.now();
  let last = t0;
  return {
    lap(label) {
      if (!enabled) return 0;
      const now = Date.now();
      const ms = now - last;
      last = now;
      try { console.log(`[PERF] ${label}: ${ms}ms`); } catch {}
      return ms;
    },
    total(label = 'total') {
      const ms = Date.now() - t0;
      if (enabled) {
        try { console.log(`[PERF] ${label}: ${ms}ms`); } catch {}
      }
      return ms;
    },
    totalMs() {
      return Date.now() - t0;
    },
  };
}

module.exports = { stage };
