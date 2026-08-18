/**
 * deploy-all-strip.test.mjs — `stripOfficialOnlyBindings` 的回歸守門（Arcrun#106）。
 *
 * 跑法：node --test installer/scripts/deploy-all-strip.test.mjs
 *
 * 🔴 為什麼有這支：`[ai]` 被剝掉這個 bug **犯了兩次**，而兩次都沒有測試擋著。
 *   - 08-07：安裝器無條件剝 `[ai]` ⇒ 雲端萃取 `/portal/daemon/extract` 501。
 *     當時的修法是 opt-in 開關（`KEEP_AI=true`），**預設仍然剝**，而且
 *     commit 訊息寫的「雙向驗證」是**手動跑一次**，沒有落成測試。
 *   - 08-17：同一個根因從另一份實作（`arcrun/cli/src/lib/deploy.ts`）再犯，
 *     這次死的是免金鑰 AI 問答（recipe `workers_ai_chat`）。
 *
 * ⇒ 這支測的不是「函式會不會動」，是**那條判準有沒有被守住**：
 *   剝除清單只准放「這個帳號結構上不可能有」的東西（zone、綁卡資源），
 *   不准放「預設用不到」的東西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOfficialOnlyBindings } from './deploy-all.mjs';

/**
 * 逼近 cypher-executor/wrangler.toml 的真實形狀：官方 route ＋ `[ai]` ＋ 一個不相干的綁定。
 * （刻意不放 D1 區塊——這裡要驗的是 route/ai/r2 的取捨，
 *   而 `arcrun-kbdb` 的 D1 綁定另有鐵律管，不該在測試夾具裡多生一份。）
 */
const CYPHER_TOML = `name = "arcrun-cypher-executor"
main = "src/index.ts"
workers_dev = true

[[routes]]
pattern = "cypher.arcrun.dev/*"
zone_name = "arcrun.dev"

[[kv_namespaces]]
binding = "WEBHOOKS"
id = "81cefb0d87d64f6d96b1175f7ad6c011"

[ai]
binding = "AI"

[[services]]
binding = "SVC_SWITCH"
service = "arcrun-switch"
`;

test('[ai] 一律保留——免金鑰 AI 問答靠它（Arcrun#106 回歸守門）', () => {
  const { toml, stripped } = stripOfficialOnlyBindings(CYPHER_TOML);
  assert.match(toml, /^\[ai\]$/m, '[ai] 被剝掉 ⇒ workers_ai_chat 會死（Arcrun#106）');
  assert.match(toml, /binding = "AI"/, 'binding = "AI" 須跟著 [ai] 一起留下');
  assert.ok(!stripped.some((s) => s === '[ai]'), `[ai] 不該出現在 stripped 摘要：${JSON.stringify(stripped)}`);
});

test('環境變數 KEEP_AI 已無作用——正解是預設值，不是藏在旗標後面', () => {
  // 08-07 的修法把正解放在 KEEP_AI=true 後面，於是「忘了帶」就等於 bug 還在。
  // 現在不管 KEEP_AI 設成什麼，[ai] 都要留著。
  for (const v of ['true', 'false', '', undefined]) {
    const prev = process.env.KEEP_AI;
    if (v === undefined) delete process.env.KEEP_AI; else process.env.KEEP_AI = v;
    const { toml } = stripOfficialOnlyBindings(CYPHER_TOML);
    assert.match(toml, /^\[ai\]$/m, `KEEP_AI=${JSON.stringify(v)} 時 [ai] 仍須保留`);
    if (prev === undefined) delete process.env.KEEP_AI; else process.env.KEEP_AI = prev;
  }
});

test('該剝的還是有剝——不准用「整個不剝」來讓上面兩條變綠', () => {
  const { toml, stripped } = stripOfficialOnlyBindings(CYPHER_TOML);
  assert.ok(!/\[\[routes\]\]|zone_name|cypher\.arcrun\.dev/.test(toml),
    `官方 route 仍應被剝除（fork 沒有 arcrun.dev zone）：\n${toml}`);
  assert.ok(stripped.includes('[[routes]]'), 'stripped 摘要應記錄 [[routes]]');
  // 沒被點名的區塊一個都不准動。
  assert.match(toml, /workers_dev = true/, 'workers_dev 須保留（self-hosted 靠它對外）');
  assert.match(toml, /binding = "WEBHOOKS"/, 'KV 綁定須保留');
  assert.match(toml, /binding = "SVC_SWITCH"/, '服務綁定須保留');
});

test('[[r2_buckets]] 仍被剝除（綁卡資源，自架帳號結構上不該要求）', () => {
  const withR2 = `name = "x"\n\n[[r2_buckets]]\nbinding = "WASM_BUCKET"\nbucket_name = "wasm"\n\n[vars]\nA = "1"\n`;
  const { toml } = stripOfficialOnlyBindings(withR2);
  assert.ok(!/r2_buckets|WASM_BUCKET/.test(toml), `R2 應被剝除：\n${toml}`);
  assert.match(toml, /A = "1"/, '後面的 [vars] 不該被連帶吃掉');
});

test('kbdb 的註解態 [ai] 不受影響——那由 kbdb_embed 決定，不是由 strip 決定', () => {
  const kbdb = `name = "arcrun-kbdb"\n\n# [[vectorize]]\n# binding = "VECTORIZE"\n#\n# [ai]\n# binding = "AI"\n\n[vars]\nENVIRONMENT = "production"\n`;
  const { toml } = stripOfficialOnlyBindings(kbdb);
  assert.match(toml, /^# \[ai\]$/m, 'kbdb 的 [ai] 本來就是註解掉的，strip 不該改變它');
  assert.ok(!/^\[ai\]$/m.test(toml), 'strip 不得順手取消註解（那是 kbdb_embed 的職責）');
});
