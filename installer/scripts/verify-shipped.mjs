#!/usr/bin/env node
/**
 * verify-shipped.mjs — 出貨後驗收閘：**用戶那一端真的拿到新版了嗎？**
 *
 * ── 這支解什麼病（leo 2026-08-03）─────────────────────────────────────────
 * leo：「你應該像 CI/CD 那樣，**每次修正會一一檢查更新，而不是你記得**。」
 *
 * 實際事故（08-03，本檔的由來）：
 *   bundles 推了、jsDelivr purge 了、CDN 也驗到 1.4.5 了——**我就宣稱出貨完成**。
 *   但 `install.arcrun.dev/api/latest` 還是 **1.4.4**，因為安裝器有個 commit-sha 釘子
 *   （`oauth-prototype/worker.js` 的 `DEFAULT_BUNDLE_BASE`）沒換、worker 也沒重部署。
 *   ⇒ **新用戶裝到的仍是舊版**。是 leo 自己去看才發現的。
 *
 * 病根不是「這次忘了」，是**驗收方式依賴人的記憶**：
 *   ship.mjs 只「印待辦」給人看，做沒做、做完對不對，沒有任何機械檢查。
 *   ⇒ 本檔把「出貨鏈的每一站」變成可執行的斷言：**打線上網址、比對實際回應**。
 *   任一站落後就 exit 1 並指出「哪一站落後、該跑什麼指令補」。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node installer/scripts/verify-shipped.mjs                 # 以 bundles @main 的版本為期望值
 *   node installer/scripts/verify-shipped.mjs --expect 1.4.5  # 明確指定期望版本
 * 出貨流程結尾必跑；也可單獨跑來回答「現在線上到底是哪一版」。
 */
const GH = 'youlinhsieh/arcrun-rag-bundles';
const args = process.argv.slice(2);
const optIdx = args.indexOf('--expect');
const EXPECT_ARG = optIdx >= 0 ? args[optIdx + 1] : null;

const cb = () => `cb=${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function getText(url) {
  try {
    const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

// ── 期望值：真相源＝bundles repo 的 manifest（raw，不吃 CDN 快取）────────────
const truth = await getJson(`https://raw.githubusercontent.com/${GH}/main/manifest.json?${cb()}`);
if (!truth) {
  console.error('❌ 讀不到 bundles 的 manifest（raw.githubusercontent）——無法判斷期望版本');
  process.exit(2);
}
const EXPECT = EXPECT_ARG || truth.release;
const EXPECT_DAEMON = truth.daemon?.version;

console.log('━━━ 出貨驗收（用戶端視角）━━━\n');
console.log(`期望：release ${EXPECT}｜daemon ${EXPECT_DAEMON}\n`);

const checks = [];

// ① daemon 自更新走的路徑（jsDelivr @main，會吃 CDN 邊緣快取 ⇒ 推完必 purge）
{
  const m = await getJson(`https://cdn.jsdelivr.net/gh/${GH}@main/manifest.json?${cb()}`);
  checks.push({
    name: 'daemon 自更新（cdn.jsdelivr @main）',
    got: m ? `${m.release}／daemon ${m.daemon?.version}` : '(讀不到)',
    ok: !!m && m.release === EXPECT && m.daemon?.version === EXPECT_DAEMON,
    fix: 'node installer/scripts/ship.mjs --bundles <dir> --purge（purge jsDelivr 並驗到收斂）',
  });
}

// ② 安裝器釘子——新用戶裝到哪一版由它決定（08-03 就是漏這站）
{
  const d = await getJson(`https://install.arcrun.dev/api/latest?${cb()}`);
  checks.push({
    name: '安裝器 /api/latest（新用戶裝到的版本）',
    got: d ? `${d.release}｜pin ${d.pin}` : '(讀不到)',
    ok: !!d && d.release === EXPECT,
    fix: "改 installer/oauth-prototype/worker.js 的 DEFAULT_BUNDLE_BASE 為 @<bundles HEAD 完整 sha>，"
       + '再 cd installer/oauth-prototype && npx wrangler deploy --config wrangler.toml',
  });
}

// ③ landing 版本卡（現行實作向 /api/latest 取號，故它落後通常代表 ② 沒做或快取未過）
{
  const html = await getText(`https://rag.arcrun.dev/?${cb()}`);
  const m = html && html.match(/版本：([0-9][0-9.]*)/);
  checks.push({
    name: 'landing 版本顯示（rag.arcrun.dev）',
    got: m ? m[1] : '(找不到版本字樣)',
    ok: !!m && m[1] === EXPECT,
    fix: '先確認 ② 已生效；仍落後才 cd landing && npx wrangler deploy',
  });
}

// ④ 用戶下載的 daemon 檔——sha 必須與 manifest 宣稱一致（防「打包早於修正」，t174 同款病）
for (const os of ['mac', 'win']) {
  const meta = truth.daemon?.[os];
  if (!meta) continue;
  let ok = false, got = '(下載失敗)';
  try {
    const r = await fetch(`https://cdn.jsdelivr.net/gh/${GH}@main/${meta.file}?${cb()}`);
    if (r.ok) {
      const buf = new Uint8Array(await r.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      got = `${hex.slice(0, 16)}…`;
      ok = hex === meta.sha256;
    }
  } catch { /* got 維持下載失敗 */ }
  checks.push({
    name: `daemon ${os} zip sha256 與 manifest 相符`,
    got,
    ok,
    fix: '重打包該平台並更新 manifest.daemon（注意 build-mac.sh 只產 .app 不產 zip，zip 要自己 ditto）',
  });
}

// ⑥ 真實實例現裝版本——**出貨到倉庫 ≠ 送到用戶**
// 🔴 2026-08-03 leo 抓到（本站的由來）：①〜⑤ 全綠時我就宣稱出貨完成，
//    但 leo 的 portal 打開來 **Claude 勾選框還在**、`/health` 還是 1.4.4。
//    因為 portal／cypher 是裝在**用戶自己 CF 帳號**的實例，出貨只是把新版放進倉庫，
//    **用戶要自己按 portal 的「立即更新」重裝一次**才會拿到（像 app 更新）。
//    ⇒ 這站不是「出貨有沒有做完」，是「**有沒有人真的拿到**」，兩者必須分開報。
// 用法：--instances <cypher網址,cypher網址…>（不給就跳過，但會提醒沒驗）
{
  const iIdx = args.indexOf('--instances');
  const list = iIdx >= 0 ? (args[iIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!list.length) {
    console.log('ℹ️  未指定 --instances，略過「實例是否已更新」檢查');
    console.log('     ⚠️ 提醒：①〜⑤ 全綠只代表**倉庫有新版**，不代表任何用戶拿到了。');
    console.log('     用戶要自己在 portal 按「立即更新」重裝，才會拿到新 portal／新 cypher。\n');
  }
  for (const base of list) {
    const h = await getJson(`${base.replace(/\/+$/, '')}/health?${cb()}`);
    const got = h?.bundle_version || '(讀不到)';
    checks.push({
      name: `實例已更新：${base.replace(/^https?:\/\//, '').split('.')[0]}`,
      got,
      ok: got === EXPECT,
      fix: `該實例還在 ${got}——**用戶要自己在 portal 按「立即更新」重裝一次**`
         + '（portal/cypher 裝在用戶自己的 CF 帳號，出貨不會自動推給他）',
    });
  }
}

// ⑦ portal 內容回歸——**版本號對，不代表內容對**
// 🔴 2026-08-03 leo 抓到（本站的由來）：我用 `main` 建 UI bundle，
//    但 CIS 新視覺在 `fix/cis-round3-portal` 分支、main 上沒有
//    ⇒ 出貨的 portal **視覺被打回 CIS 之前**（底色/字體/logo 全退版），
//    而版本號、sha、實例版本**全都是對的** ⇒ 前六站一站都不會紅。
//    ⇒ 內容回歸只能靠「該出現的字串在不在」來抓，不能靠版本號。
{
  const ui = await getText(`https://cdn.jsdelivr.net/gh/${GH}@main/tier2/ui/index.js?${cb()}`);
  const must = [
    ['CIS 底色 #FDFCFB', 'FDFCFB'],
    ['CIS 字體 IBM Plex Sans', 'IBM Plex Sans'],
    ['CIS favicon', 'apple-touch-icon'],
    ['t176 新 AI 文案', '這裡不需要任何設定'],
  ];
  const mustNot = [['t176 已刪的 Claude 勾選框', 'st-ai-use-claude']];
  const missing = ui ? must.filter(([, s]) => !ui.includes(s)).map(([n]) => n) : ['(讀不到 bundle)'];
  const leftover = ui ? mustNot.filter(([, s]) => ui.includes(s)).map(([n]) => n) : [];
  checks.push({
    name: 'portal bundle 內容（CIS 視覺＋t176 都在）',
    got: missing.length || leftover.length
      ? `缺：${missing.join('／') || '無'}｜殘留：${leftover.join('／') || '無'}`
      : '四項特徵齊全、無殘留',
    ok: !!ui && !missing.length && !leftover.length,
    fix: '用**正確分支**重建 UI bundle：portal 真身在 matrix/arcrun 的 `fix/cis-round3-portal`'
       + '（不是 main！main 沒有 CIS）；建完檔數應為 9（含 favicon 三件套），只有 6 就是漏了 CIS 資產',
  });
}

// ── 報表 ────────────────────────────────────────────────────────────────
let bad = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.name}`);
  console.log(`     實際：${c.got}`);
  if (!c.ok) { console.log(`     → 補救：${c.fix}`); bad++; }
}

console.log('');
if (bad) {
  console.log(`❌ ${bad} 站落後——**用戶此刻拿不到新版**，不准宣稱出貨完成。`);
  process.exit(1);
}
console.log('✅ 全鏈到位：用戶端各路徑都已是最新版。');
