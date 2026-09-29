// Embeddings: local MiniLM (offline, cached in ./models) by default.
const config = require('../config');

let localEmbedderPromise = null;

async function getLocalEmbedder() {
  if (!localEmbedderPromise) {
    localEmbedderPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = './models';
      env.allowLocalModels = true;
      console.log(`[embeddings] loading "${config.localEmbeddingModel}"...`);
      const embedder = await pipeline('feature-extraction', config.localEmbeddingModel);
      console.log('[embeddings] ready');
      return embedder;
    })();
    localEmbedderPromise.catch(() => {
      localEmbedderPromise = null;
    });
  }
  return localEmbedderPromise;
}

// Local MiniLM-L6-v2 → 384-dim mean-pooled normalized embedding
async function embedLocal(text) {
  const embedder = await getLocalEmbedder();
  const out = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

async function embed(text) {
  return embedLocal(text);
}

module.exports = { embed, embedLocal };
