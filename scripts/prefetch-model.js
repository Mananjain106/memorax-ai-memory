// Downloads the local models into ./models so offline inference never needs the network.
// Run once while online: npm run prefetch
const config = require('../src/backend/config'); // paths differ: run from project root

async function main() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = './models';
  env.allowLocalModels = true;

  console.log(`[prefetch] LLM: ${config.local.model}`);
  const llm = await pipeline('text2text-generation', config.local.model, { dtype: 'fp32' });
  console.log('[prefetch] LLM cached OK');

  console.log(`[prefetch] embeddings: ${config.localEmbeddingModel}`);
  const emb = await pipeline('feature-extraction', config.localEmbeddingModel);
  const probe = await emb('warmup', { pooling: 'mean', normalize: true });
  console.log(`[prefetch] embeddings cached OK, dim=${probe.data.length}`);
}

main()
  .then(() => {
    console.log('[prefetch] done — fully offline-capable now');
    process.exit(0);
  })
  .catch((e) => {
    console.error('[prefetch] FAILED:', e.message);
    process.exit(1);
  });
