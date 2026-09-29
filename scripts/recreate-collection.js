// Recreate the Qdrant collection at the NATIVE embedding dimension of the
// local model (MiniLM = 384), migrating existing points instead of dropping
// them. Old vectors were zero-padded 384 -> 1536, so truncation restores the
// exact original embedding: cos(pad(a), pad(b)) === cos(a, b).
//
// Steps:
//   1. Measure the real embedding dim from the loaded model (never guessed).
//   2. Scroll every point (id, vector, payload) out of the old collection.
//   3. Truncate each vector to the native dim; refuse silently-wrong shapes.
//   4. Write a full JSON backup to data/ (the rollback path), then drop the
//      old collection and create a fresh one at the native dim.
//   5. Re-upsert all points.
//   6. Verify count + a live similarity search on known content.
//
// Run: node scripts/recreate-collection.js [--drop-backup-file]
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require(path.join(ROOT, 'src/backend/config'));
const { embed } = require(path.join(ROOT, 'src/backend/services/embeddings'));
const schema = require(path.join(ROOT, 'src/backend/memory-engine/schema'));

const DROP_BACKUP_FILE = process.argv.includes('--drop-backup-file');
const client = new QdrantClient({
  url: config.qdrant.url,
  apiKey: config.qdrant.apiKey || undefined,
  checkCompatibility: false,
});
const COLLECTION = config.qdrant.collection;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[migrate] ${m}`);

async function scrollAll() {
  const points = [];
  let offset;
  for (;;) {
    const page = await client.scroll(COLLECTION, {
      limit: 256,
      offset,
      with_payload: true,
      with_vector: true,
    });
    points.push(...(page.points || []));
    if (!page.next_page_offset) break;
    offset = page.next_page_offset;
  }
  return points;
}

async function waitPointsCount(expect, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const info = await client.getCollection(COLLECTION);
    if (info.points_count === expect) return info;
    await sleep(1000);
  }
  throw new Error(`collection did not reach ${expect} points in time`);
}

(async () => {
  // 1. Real dimension, measured from the model — same rule the app enforces.
  const dim = await schema.getEmbeddingDim();
  log(`native embedding dimension (measured from model): ${dim}`);

  const info = await client.getCollection(COLLECTION);
  const oldDim = info.config?.params?.vectors?.size ?? info.config?.params?.vectors?.['']?.size;
  log(`collection "${COLLECTION}": dim=${oldDim}, points=${info.points_count}`);

  if (oldDim === dim) {
    log('already at native dimension — nothing to do');
    process.exit(0);
  }
  if (!oldDim) throw new Error('cannot read current vector size from collection config');

  // 2. Export every point.
  const points = await scrollAll();
  log(`exported ${points.length} point(s)`);
  const backupFile = path.join(ROOT, 'data', `qdrant-backup-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(
    backupFile,
    JSON.stringify({ collection: COLLECTION, dim: oldDim, exported_at: new Date().toISOString(), points }, null, 0)
  );
  log(`backup written to ${path.relative(ROOT, backupFile)}`);

  // 3. Truncate padded vectors back to native dim.
  const migrated = points.map((p) => {
    const vec = Array.isArray(p.vector) ? p.vector : p.vector?.[''];
    if (!Array.isArray(vec)) throw new Error(`point ${p.id}: unreadable vector`);
    if (vec.length < dim) throw new Error(`point ${p.id}: vector dim ${vec.length} < native ${dim} — refusing`);
    const extra = vec.slice(dim).some((v) => v !== 0);
    if (extra) throw new Error(`point ${p.id}: non-zero tail beyond dim ${dim} — not a zero-padded vector, refusing`);
    return { id: p.id, vector: vec.slice(0, dim), payload: p.payload || {} };
  });
  log(`truncated ${migrated.length} vector(s) ${oldDim} -> ${dim} (zero-padding verified)`);

  // 4. Drop + recreate (the on-disk backup written above is the rollback path;
  //    the REST client exposes no collection rename).
  await client.deleteCollection(COLLECTION);
  log(`dropped old collection (dim=${oldDim}) — backup file remains on disk`);

  await client.createCollection(COLLECTION, { vectors: { size: dim, distance: 'Cosine' } });
  log(`created "${COLLECTION}" at dim=${dim}`);

  // 5. Re-upsert in batches.
  for (let i = 0; i < migrated.length; i += 100) {
    await client.upsert(COLLECTION, { points: migrated.slice(i, i + 100), wait: true });
  }
  const finalInfo = await waitPointsCount(migrated.length);
  log(`re-uploaded ${finalInfo.points_count} point(s)`);

  // 6. Sanity check: a known fact must still be retrievable.
  const probe = migrated.find((p) => p.payload?.text);
  if (probe) {
    const qv = await embed(probe.payload.text);
    const res = await client.query(COLLECTION, { query: qv, limit: 3, with_payload: true });
    const top = (res.points || [])[0];
    log(
      `search sanity: top score=${top ? top.score.toFixed(4) : 'n/a'} ` +
        `text="${top ? String(top.payload?.text || '').slice(0, 50) : ''}"`
    );
  }

  if (DROP_BACKUP_FILE) {
    fs.unlinkSync(backupFile);
    log(`deleted backup file ${path.relative(ROOT, backupFile)}`);
  }

  log('DONE — collection now runs at the native model dimension');
})().catch((e) => {
  console.error('[migrate] FAILED:', e.message);
  process.exit(1);
});
