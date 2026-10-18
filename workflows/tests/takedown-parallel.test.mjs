// takedown-parallel.test.mjs — inkstone/arcrun-rag#270：下架兩段刪除必須並行，
// 否則 100 條三元組＋10 block 要 317 秒（stage 實測），超過小幫手 300 秒上限。
import fs from 'node:fs';
let pass = 0, fail = 0;
const t = (label, cond) => { cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label), fail++); };

const y = fs.readFileSync(new URL('../rag-takedown-direct.local.yaml', import.meta.url).pathname, 'utf8');
const flow = [...y.matchAll(/^ {2}- "(.*)"$/gm)].map((m) => m[1]);
for (const [src, it, dst] of [['build_deprecations', 'dead_entry', 'deprecate_entry'], ['pick_dead_triplets', 'dead_record', 'deprecate_triplet']]) {
  t(`${dst} 並行 6`, flow.includes(`${src} >> 對每個 ${it} 並行 6 >> ${dst}`));
}
t('flow 裡沒有沒並行的 FOREACH', flow.filter((x) => /對每個/.test(x) && !/並行 \d+/.test(x)).length === 0);

const wf = JSON.parse(fs.readFileSync(new URL('../../installer/src/workflows.json', import.meta.url).pathname, 'utf8'));
const w = (Array.isArray(wf) ? wf : Object.values(wf)).find((x) => x && x.name === 'rag_takedown_direct');
const s = JSON.stringify(w);
t('已編譯的 workflows.json 帶 concurrency:6 兩處', (s.match(/"concurrency":6/g) || []).length === 2);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
