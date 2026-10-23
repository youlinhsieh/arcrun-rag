// license-contract.test.mjs — 授權變更（arcrun-rag#205）的驗收契約
// 對應任務書驗收（leo 2026-10-19 裁示後：不分層、授權人留空、發佈起生效）：
// LICENSE.md 由上游 SUL 逐字生成且 EE 層已移除、manifest 欄位、
// README 中英授權段、現行文件不得再把本產品說成 MIT／開源、下載頁與安裝器有摘要＋全文連結＋同意。
// 跑法：node --test installer/scripts/license-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(join(root, p), 'utf8');

// 上游 SUL 的 ".ee." 條文整段（leo 2026-10-19 ③ 不分層後要被刪掉的那一段）
const EE_BULLET =
  '- Source code files that contain ".ee." in their filename or ".ee" in their dirname are NOT licensed under\n' +
  '  the Sustainable Use License.\n' +
  '  To use source code files that contain ".ee." in their filename or ".ee" in their dirname you must hold a\n' +
  '\tvalid n8n Enterprise License specifically allowing you access to such source code files and as defined\n' +
  '\tin "LICENSE_EE.md".\n';

test('上游參考副本沒被動過（n8n Sustainable Use License，取自 n8n-io/n8n master）', () => {
  const sha = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex');
  assert.equal(sha('docs/licensing/upstream/n8n-LICENSE.md'), 'd2f621f59aa4c10eab79b6333e59d9d3d5b53307dcfd16dbd75e40e679e84965');
});

test('LICENSE.md 由上游 SUL 本文逐字生成（leo 2026-10-19：刪 .ee. 條文、授權人留空、預設分支 master→main）', () => {
  const upstream = rd('docs/licensing/upstream/n8n-LICENSE.md');
  assert.ok(upstream.includes(EE_BULLET), '上游 .ee. 條文整段要能被逐字認出來');
  const expected = upstream
    .replace(EE_BULLET, '')                        // ③ 不分層：刪所有 .ee. 條文
    .replace('(i.e. "master")', '(i.e. "main")')   // 本 repo 預設分支名
    .replace('the n8n Software', 'the Software');  // ① 授權人法律實體名稱先留空
  assert.equal(rd('LICENSE.md'), expected);
  const ours = rd('LICENSE.md');
  assert.ok(!/n8n/.test(ours), 'LICENSE.md 不得殘留 n8n 字樣');
  assert.ok(!/法律實體名稱待確認/.test(ours), '授權人留空，LICENSE.md 不應再有佔位字串');
  assert.ok(!/\.ee\.|LICENSE_EE/.test(ours), '不分層：LICENSE.md 不應再有 .ee./LICENSE_EE 參照');
});

test('EE 層已移除（leo 2026-10-19 ③：不分層、兩個一起換 SUL）', () => {
  assert.ok(!existsSync(join(root, 'LICENSE_EE.md')), 'LICENSE_EE.md 應已刪除');
  assert.ok(!existsSync(join(root, 'docs/licensing/upstream/n8n-LICENSE_EE.md')), '上游 EE 參考副本應已刪除');
  assert.ok(!/LICENSE_EE/.test(rd('README.md')), 'README 不應再參照 LICENSE_EE');
});

test('manifest license 欄位＝SEE LICENSE IN LICENSE.md', () => {
  for (const p of ['docs-site/package.json', 'collector/cmd/arcrun-app/frontend/package.json']) {
    assert.equal(JSON.parse(rd(p)).license, 'SEE LICENSE IN LICENSE.md', p);
  }
});

test('README 授權段中英各一，含歷史版本聲明與商標一句', () => {
  const r = rd('README.md');
  assert.match(r, /^## 授權$/m);
  assert.match(r, /^## License$/m);
  assert.match(r, /歷史版本聲明/);
  assert.match(r, /Prior versions/);
  assert.match(r, /商標/);
  assert.match(r, /Trademarks/);
});

test('現行文件不再把本產品描述為 MIT／開源（歷史聲明除外）', () => {
  const files = ['README.md', 'install.md', 'landing/worker.js', 'docs/manual/local-test-guide.md'];
  const bad = /開源|open[- ]?source|\bMIT\b|shields\.io\/.*license/i;
  for (const f of files) {
    for (const para of rd(f).split(/\n\s*\n/)) {
      if (/歷史版本聲明|Prior versions/.test(para)) continue;   // 歷史聲明整段本來就要提 MIT
      const hit = para.split('\n').find((l) => bad.test(l));
      assert.ok(!hit, `${f} 仍有 MIT／開源字樣：${(hit || '').slice(0, 80)}`);
    }
  }
});

test('CONTRIBUTING.md 的 CLA 是待律師提供的佔位，PR 模板有授權勾選項', () => {
  assert.match(rd('CONTRIBUTING.md'), /\[待律師提供\]/);
  const t = rd('.gitea/PULL_REQUEST_TEMPLATE.md');
  assert.match(t, /- \[ \].*CLA/);
  assert.match(t, /- \[ \].*LICENSE\.md/);
});

test('landing 的 license-text.js 與 LICENSE.md 一致（改了 LICENSE.md 要跑 landing/sync-license.mjs）', async () => {
  const { LICENSE_TEXT } = await import(join(root, 'landing/license-text.js'));
  assert.equal(LICENSE_TEXT, rd('LICENSE.md'));
});

test('landing：首頁有同意勾選＋摘要＋全文連結；/license 回全文', async () => {
  const w = (await import(join(root, 'landing/worker.js'))).default;
  const env = { SIGNUPS: { get: async () => null, put: async () => {} }, INSTALL_BASE: 'https://install.test', DOCS_BASE: 'https://docs.test' };
  const home = await w.fetch(new Request('https://rag.test/', { headers: { accept: 'text/html' } }), env, {});
  const html = await home.text();
  assert.match(html, /id="agree-license"[^>]*required/);
  assert.match(html, /Sustainable Use License/);
  assert.match(html, /href="\/license"/);
  assert.ok(!/開源/.test(html));
  const lic = await w.fetch(new Request('https://rag.test/license'), env, {});
  assert.equal(lic.status, 200);
  const body = await lic.text();
  assert.match(body, /Sustainable Use License/);
  assert.match(body, /Limitations/);
});
