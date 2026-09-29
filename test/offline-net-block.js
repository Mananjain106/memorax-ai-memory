// Simulates a disconnected NIC for the app's network layer: every fetch fails
// immediately, exactly like DNS/network being down. Local ONNX inference never
// touches fetch, so this faithfully tests the OFFLINE code path.
// Usage: NODE_OPTIONS="--require ./test/offline-net-block.js" node server.js
global.fetch = async () => {
  const e = new Error('getaddrinfo EAI_AGAIN (network disabled by offline test harness)');
  e.cause = new Error('EAI_AGAIN');
  throw e;
};
console.log('[test-harness] network disabled: all fetch() calls will fail');
