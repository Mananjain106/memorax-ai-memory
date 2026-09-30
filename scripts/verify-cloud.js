// Utility: scroll Qdrant Cloud and print points (optionally filtered by a
// search term). Usage: node scripts/verify-cloud.js [searchTerm]
require('dotenv').config();
const { QdrantClient } = require('@qdrant/js-client-rest');

const term = (process.argv[2] || '').toLowerCase();

(async () => {
  const client = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY || undefined,
    checkCompatibility: false,
  });
  const collection = process.env.QDRANT_COLLECTION || 'ai_memory';
  let offset = undefined;
  let shown = 0;
  for (let page = 0; page < 10; page++) {
    const res = await client.scroll(collection, {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });
    const pts = res.points || [];
    for (const p of pts) {
      const text = String(p.payload?.text || '');
      if (!term || text.toLowerCase().includes(term)) {
        shown++;
        console.log(
          `${p.id} | v${p.payload?.version} | ${new Date(p.payload?.ts || p.payload?.created_at || 0).toISOString()} | ${text.slice(0, 110)}`
        );
      }
    }
    if (!res.next_page_offset) break;
    offset = res.next_page_offset;
  }
  console.log(term ? `-- ${shown} point(s) matching "${term}"` : `-- ${shown} point(s) total`);
})().catch((e) => {
  console.error('verify-cloud failed:', e.message);
  process.exit(1);
});
