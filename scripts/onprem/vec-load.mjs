// JSONL（vec-export.mjs 產的）→ sqlite-vec 向量檔。用法：node vec-load.mjs <vectors.jsonl> <vectors.sqlite> <kbdb/sidecar/vector-store.mjs>
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
const [inp, out, storeMod] = process.argv.slice(2);
const { openVectorStore } = await import(pathToFileURL(storeMod).href);
const store = openVectorStore({ path: out, dim: 1024 });
let batch = [], n = 0;
for await (const line of createInterface({ input: createReadStream(inp) })) {
  if (!line) continue;
  batch.push(JSON.parse(line));
  if (batch.length >= 500) { await store.upsert(batch); n += batch.length; batch = []; }
}
if (batch.length) { await store.upsert(batch); n += batch.length; }
console.log('loaded', n);
