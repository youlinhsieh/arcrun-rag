#!/usr/bin/env node
/**
 * verify-instance-ai.mjs — 驗「這個實例的 AI 問答**真的免金鑰**」（t188）
 *
 * ── 為什麼要有這支（leo 2026-08-04 抓到的假綠）────────────────────────────
 * t180 宣稱「AI 問答改用 Workers AI」，我當時的「驗證」是看源碼與 diff，
 * **從沒打過真實例**。leo 刪掉 youlin 的 gemini 金鑰後真相才出來：
 *   刪除前：火星奧林帕斯山的高度約 21.9 公里 [3]   ← 有答案
 *   刪除後：缺少 credential: gemini_api_key       ← 一直靠那把金鑰
 * ⇒ youlin 從頭到尾在跑 Gemini，只因為它剛好有金鑰，所以「看起來是好的」。
 *
 * ⚠️ **不可用 description 判斷**：實例上的 description 仍寫「Gemma」但節點
 *    其實是 workers_ai_chat（我就是這樣誤判過一次）。description 是文案，不是行為。
 *
 * ── 唯一可信的判準 ────────────────────────────────────────────────────
 *   「**這個實例沒有 gemini_api_key，而 AI 問答仍答得出來**」
 *   ＝ 它真的走 Workers AI。其他都是推測。
 *
 * 用法：
 *   node installer/scripts/verify-instance-ai.mjs <cypher_base> <api_key> [問題]
 */
const [, , base, key, q = '這個知識庫裡有什麼'] = process.argv;
if (!base || !key) {
  console.error('用法：node verify-instance-ai.mjs <cypher_base> <api_key> [問題]');
  process.exit(2);
}
const U = base.replace(/\/+$/, '');
const j = async (u, o) => { const r = await fetch(u, o); return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }; };

console.log('━━━ 實例 AI 問答免金鑰驗收 ━━━\n');

// ① 這個實例有沒有 gemini 金鑰
const creds = await j(`${U}/credentials`, { headers: { 'X-Arcrun-API-Key': key } });
const names = (creds.body?.credentials ?? []).map((c) => c.name);
const hasGemini = names.includes('gemini_api_key');
console.log(`① 憑證庫：${names.join(', ') || '(空)'}`);
console.log(`   有 gemini_api_key：${hasGemini ? '是 ⚠️' : '否'}`);

// ② 問一題（走用戶真的會走的那條路）
const ans = await j(`${U}/q/${encodeURIComponent(key)}/rag_chat?question=${encodeURIComponent(q)}`);
const text = ans.body?.data?.answer ?? '';
const err = ans.body?.data?.error ?? ans.body?.error ?? '';
console.log(`\n② 問「${q}」→ HTTP ${ans.status}`);
console.log(`   ${text ? '答案：' + text.slice(0, 90) : '錯誤：' + String(err).slice(0, 140)}`);

// ③ 判定
console.log('\n③ 判定');
if (/gemini_api_key/.test(String(err))) {
  console.log('   ❌ 這個實例的 rag_chat **還在跑 Gemini**（舊 workflow）');
  console.log('      → 用戶要重跑一次安裝器才會換成 Workers AI 版');
  process.exit(1);
}
if (!text) {
  console.log('   ❌ 問不到答案（非金鑰問題，看上面的錯誤）');
  process.exit(1);
}
if (hasGemini) {
  console.log('   ◐ 答得出來，但**這個實例有 gemini 金鑰** ⇒ 無法證明它免金鑰。');
  console.log('      真要證實：暫時刪掉該金鑰再跑一次（值可從 .env 復原）。');
  process.exit(0);
}
console.log('   ✅ 沒有 gemini 金鑰卻答得出來 ⇒ **確實走 Workers AI，真的免金鑰**');
