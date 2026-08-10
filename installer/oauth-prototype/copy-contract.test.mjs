// copy-contract.test.mjs — 文案契約：leo 拍板拿掉的東西，禁止再出現（機制防迴歸）
// 2026-07-28 立。deploy-web.sh 在部署前跑本檔，任一違反＝拒絕部署。
// 新增禁句：leo 說「拿掉 X」時，在 FORBIDDEN 加一行＋註明日期，那句就永遠回不來。
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
// 只驗會送到瀏覽器的內容：去掉 // 註解行（註解裡允許引用原句說明歷史）
const body = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const FORBIDDEN = [
  ['一分鐘',            't81 2026-07-28 leo：時間承諾不準＝謊言文案，全部拿掉'],
  ['正在分批安裝',        't81 2026-07-28 leo：對小白無意義'],
  ['你需要準備',          't76b 2026-07-28 leo：前置條件清單是在趕人'],
  ['免費方案就夠用',       't76c 2026-07-28 leo：自動會做不用寫'],
  ['還沒有辨識碼？',        't76c 2026-07-28 leo：常駐的「趕人」提示；錯誤訊息版（還沒有辨識碼的話…）核准保留'],
  ['填 Email 就會寄給你',    't76c 同上，常駐版獨有字樣'],
  ['下載 config.json',   't75③ 2026-07-28 leo：t54 已改帳密自取'],
  ['建立你的帳號',         't79 2026-07-28 leo：完成頁只給網址，帳號在 portal 建'],
  ['下載同步小幫手',        't79 2026-07-28 leo：同上，在 portal 下載'],
  ['接下來可以做什麼',      't79 2026-07-28 leo：同上'],
];
const REQUIRED = [
  ['開始安裝／更新',        't75 主按鈕含更新語意'],
  ['已經裝過了？想更新到最新版','t75 更新入口卡'],
  ['@',                  'BUNDLE_BASE 必須釘 commit（含 @ 即可，粗檢）'],
];

let fail = 0;
for (const [str, why] of FORBIDDEN) {
  const n = body.split(str).length - 1;
  if (n > 0) { console.error(`❌ 禁句出現 ${n} 次：「${str}」（${why}）`); fail++; }
}
for (const [str, why] of REQUIRED) {
  if (!body.includes(str)) { console.error(`❌ 必句缺失：「${str}」（${why}）`); fail++; }
}
if (fail) { console.error(`\n${fail} 項違反文案契約——拒絕部署。`); process.exit(1); }
console.log(`✅ 文案契約通過（禁句 ${FORBIDDEN.length} 項全 0、必句 ${REQUIRED.length} 項全在）`);

// ── workflows.json 編譯漂移閘（t112 2026-07-28）──────────────────────────
// rag_ingest_card 的 blocks.map 與 post_block.metadata_json 必須含 library，
// 否則新裝實例的分庫章天生失效（總管探針已實證）。compile-workflows.mjs 重編後同步更新。
const wf = JSON.parse(fs.readFileSync(new URL('./workflows.json', import.meta.url), 'utf8'));
const card = wf.find(w => w.name === 'rag_ingest_card');
if (!card) { console.error('❌ workflows.json 缺 rag_ingest_card'); process.exit(1); }
const parseCode = card.config?.parse_card?.code || '';
const postMeta = JSON.stringify(card.config?.post_block?.body_json || '');
let wfFail = 0;
if (!parseCode.includes('library: lib')) {
  console.error('❌ rag_ingest_card parse_card.code 的 blocks.map 缺 library: lib（分庫章失效）'); wfFail++;
}
// metadata_json 是字串欄位，stringify 後引號變 \" —— 比對鬆一階（library 這個詞在就好）
if (!postMeta.includes('library')) {
  console.error('❌ rag_ingest_card post_block.body_json 缺 library 欄位（分庫章失效）'); wfFail++;
}
if (wfFail) { console.error(`\n${wfFail} 項 workflows.json 結構違反——拒絕部署。`); process.exit(1); }
console.log('✅ workflows.json 結構閘通過（rag_ingest_card library 欄位在 blocks 與 post_block 均存在）');
