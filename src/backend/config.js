require('dotenv').config();

function req(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

// Qdrant Cloud URLs are often provided without a protocol; the client then
// defaults to http://:80 and gets ECONNREFUSED. Qdrant Cloud is always HTTPS.
function normalizeQdrantUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url.replace(/\/+$/, '');
  return `https://${url.replace(/\/+$/, '')}`;
}

const config = {
  port: Number(req('PORT', 3000)),

  // Online providers
  openrouter: {
    apiKey: req('OPENROUTER_API_KEY', ''),
    model: req('OPENROUTER_MODEL', 'respan/span-01-lite:free'),
    fallbackModels: req('OPENROUTER_FALLBACK_MODELS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    baseUrl: req('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  },

  // Offline local LLM
  local: {
    runtime: req('LOCAL_LLM_RUNTIME', 'transformers'), // "transformers" | "ollama"
    model: req('LOCAL_LLM_MODEL', 'Xenova/LaMini-Flan-T5-783M'),
    maxTokens: Number(req('LOCAL_LLM_MAX_TOKENS', 256)),
    url: req('LOCAL_LLM_URL', 'http://localhost:11434'),
  },

  // Vector memory
  qdrant: {
    url: normalizeQdrantUrl(req('QDRANT_URL', '')),
    apiKey: req('QDRANT_API_KEY', ''),
    collection: req('QDRANT_COLLECTION', 'ai_memory'),
  },

  // Offline embedding model for local memory (cached in ./models)
  localEmbeddingModel: req('LOCAL_EMBEDDING_MODEL', 'Xenova/all-MiniLM-L6-v2'),
};

module.exports = config;
