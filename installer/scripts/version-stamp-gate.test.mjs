/**
 * version-stamp-gate.test.mjs — **閘自己要能被演練**。
 *
 * 跑法：node --test installer/scripts/version-stamp-gate.test.mjs
 *
 * 一道沒被演練過的閘等於沒有閘。所以這裡真的餵四種輸入：
 *   ① 本 repo（修完之後）→ 要全過
 *   ② 把 commit 那半拿掉的部署路徑（＝2026-08-16 之前 worker.js 真的長的樣子）→ 要擋
 *   ③ 只在**註解**裡提 ARCRUN_BUNDLE_COMMIT → 要擋（不能靠寫註解矇過）
 *   ④ 掃到 0 個檔 → 要擋（「檢查了 0 個卻通過」是假綠的經典形狀）
 * 外加不該誤殺的三種：只讀不寫、拿字串當比對條件、模擬既有實例狀態的假資料。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REPO_ROOT, SCAN_DIR,
  stripComments, deployActionsIn, stampWritesIn, filesToScan,
  checkStampPairing, checkProducer, runGate,
} from './version-stamp-gate.mjs';

/**
 * 🔴 offender fixture ＝ `installer/oauth-prototype/worker.js` 在 2026-08-16 之前
 *    真的長這樣的那段程式碼（一字不改，只補上讓它成為「部署路徑」的那行 PUT）。
 *    這道閘存在的唯一理由就是「下次有人再貼一次這種東西要被擋下來」，
 *    所以拿它本人當測資，而不是另外編一個像 offender 的假東西。
 */
const THE_OFFENDER = `
async function deployBundledWorker(env, token, accountId, entry, resources, inject) {
  const bindings = [];
  if (entry.name && (entry.name.includes('cypher') || entry.name === 'arcrun-rag-ui')) {
    const bundleCommit = bundleCommitOf(env);
    const versionText = inject.bundleRelease
      ? String(inject.bundleRelease)
      : (inject.bundleBuilt ? String(inject.bundleBuilt) : '') + '+' + bundleCommit;
    bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', text: versionText });
  }
  await cfFetch(token, \`/accounts/\${accountId}/workers/scripts/\${entry.name}\`, { method: 'PUT', body: form });
}
`;

/** 修好之後的樣子（兩個印記都寫）——同一個形狀要能過。 */
const THE_FIX = THE_OFFENDER.replace(
  "bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', text: versionText });",
  "bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', text: versionText });\n"
  + "    bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_COMMIT', text: sourceCommit });");

/** 在暫存目錄長出一棵只有 `installer/` 的假樹，回 root 路徑。 */
function treeWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'stamp-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 本 repo 要全過（修完之後）
// ═══════════════════════════════════════════════════════════════════════════

test('①本 repo：三條部署路徑都烙了 commit ⇒ 閘全過', () => {
  const r = runGate(REPO_ROOT);
  assert.equal(r.ok, true, r.sections.filter((s) => !s.ok).map((s) => s.problems.join('\n')).join('\n'));
});

test('①b 掃到的檔數 > 0，而且真的認出那三條部署路徑（防「檢查了 0 個卻通過」）', () => {
  const r = checkStampPairing(REPO_ROOT);
  assert.ok(r.scanned > 0, '掃到 0 個檔＝這道閘什麼都沒看');
  for (const must of [
    join('installer', 'oauth-prototype', 'worker.js'),
    join('installer', 'scripts', 'deploy-all.mjs'),
    join('installer', 'scripts', 'deploy-ui.mjs'),
  ]) {
    assert.ok(r.deployPaths.includes(must), `${must} 應該被認出是部署路徑`);
  }
  assert.ok(filesToScan(REPO_ROOT).length >= r.deployPaths.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 病灶本體：只烙版本、不烙 commit 的部署路徑要被擋
// ═══════════════════════════════════════════════════════════════════════════

test('②病灶重現：08-16 之前那段程式碼（只貼版號）⇒ 閘要擋', () => {
  const root = treeWith({ [join(SCAN_DIR, 'oauth-prototype', 'worker.js')]: THE_OFFENDER });
  try {
    const r = checkStampPairing(root);
    assert.equal(r.ok, false, '只貼版號卻沒貼 commit，這道閘必須擋下來');
    assert.match(r.problems.join('\n'), /沒有寫 ARCRUN_BUNDLE_COMMIT/);
    assert.match(r.problems.join('\n'), /Arcrun#106/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('②b 補上 commit 之後，同一段程式碼要過（證明閘擋的是缺 commit，不是別的東西）', () => {
  const root = treeWith({ [join(SCAN_DIR, 'oauth-prototype', 'worker.js')]: THE_FIX });
  try {
    assert.equal(checkStampPairing(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('②c toml 那型（deploy-all／deploy-ui 的形狀）漏了 commit 一樣要擋', () => {
  const onlyVersion = `
    const toml = base + \`ARCRUN_BUNDLE_VERSION = "\${ctx.bundleVersion}"\\n\`;
    execFileSync('npx', ['wrangler', 'deploy'], { cwd: work });
  `;
  const root = treeWith({ [join(SCAN_DIR, 'scripts', 'deploy-x.mjs')]: onlyVersion });
  try {
    assert.equal(checkStampPairing(root).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 註解裡提一下不算數
// ═══════════════════════════════════════════════════════════════════════════

test('③只在註解裡寫 ARCRUN_BUNDLE_COMMIT ⇒ 仍然要擋（規則寫在註解裡＝沒有一步在執行它）', () => {
  const commentOnly = THE_OFFENDER.replace(
    'const bindings = [];',
    'const bindings = []; // TODO: 之後補 ARCRUN_BUNDLE_COMMIT = "…"');
  const root = treeWith({ [join(SCAN_DIR, 'oauth-prototype', 'worker.js')]: commentOnly });
  try {
    assert.equal(checkStampPairing(root).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('③b stripComments 不會誤砍字串裡的斜線（`https://x` 不是註解）', () => {
  const code = `const u = 'https://a.example/b'; // 真註解\nconst v = \`x//y\`;`;
  const out = stripComments(code);
  assert.match(out, /https:\/\/a\.example\/b/);
  assert.match(out, /x\/\/y/);
  assert.doesNotMatch(out, /真註解/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 掃到 0 個檔要擋
// ═══════════════════════════════════════════════════════════════════════════

test('④掃到 0 個檔 ⇒ 擋（「檢查了 0 個卻通過」等於沒有閘）', () => {
  const root = mkdtempSync(join(tmpdir(), 'stamp-gate-empty-'));
  try {
    const r = checkStampPairing(root);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /掃到 0 個檔/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 不該誤殺的三種（判準是「有沒有在做那件事」，不是「字串有沒有出現」）
// ═══════════════════════════════════════════════════════════════════════════

test('⑤a 只讀不寫（env.ARCRUN_BUNDLE_VERSION）＋沒有部署動作 ⇒ 不算 offender', () => {
  const reader = `export function health(env) { return { bundle_version: env.ARCRUN_BUNDLE_VERSION || '' }; }`;
  const root = treeWith({ [join(SCAN_DIR, 'scripts', 'reader.mjs')]: reader });
  try {
    const r = checkStampPairing(root);
    assert.equal(r.ok, true);
    assert.deepEqual(r.deployPaths, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑤b 拿字串當比對條件（release.mjs 的 uiSrc.includes(…)）＋會部署 ⇒ 仍不算「寫標籤」', () => {
  const checker = `
    if (!uiSrc.includes('ARCRUN_BUNDLE_VERSION')) problems.push('產物沒讀版本');
    execFileSync('npx', ['wrangler', 'deploy']);
  `;
  const root = treeWith({ [join(SCAN_DIR, 'scripts', 'checker.mjs')]: checker });
  try {
    const r = checkStampPairing(root);
    assert.deepEqual(r.deployPaths, [join('installer', 'scripts', 'checker.mjs')]);
    assert.equal(r.ok, true, '它只是檢查字串在不在，沒有在烙標籤');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑤c 模擬「已部署 worker 身上長什麼樣」的假資料（resource-plan-dryrun）⇒ 沒有部署動作，不管它', () => {
  const fixture = `bindings.push({ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', text: '1.4.41' });`;
  const root = treeWith({ [join(SCAN_DIR, 'scripts', 'dryrun.mjs')]: fixture });
  try {
    assert.equal(checkStampPairing(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 產地行為（靜態掃描擋不到「那支函式其實只回一個欄位」）
// ═══════════════════════════════════════════════════════════════════════════

test('⑥versionStampVars 真的同時吐兩個；查不到 commit 時少一欄但版號照貼', () => {
  assert.equal(checkProducer().ok, true);
});

test('⑥b 輔助判斷函式本身：認得部署動作與三種寫法', () => {
  assert.deepEqual(deployActionsIn("cfFetch(t, '/accounts/x/workers/scripts/y', {})"), ['CF script API 上傳']);
  assert.deepEqual(deployActionsIn("execFileSync('npx', ['wrangler', 'deploy'])"), ['wrangler deploy']);
  assert.deepEqual(deployActionsIn('const a = 1;'), []);
  assert.equal(stampWritesIn("name: 'ARCRUN_BUNDLE_VERSION'").version.length, 1);
  assert.equal(stampWritesIn('ARCRUN_BUNDLE_COMMIT = "abc"').commit.length, 1);
  assert.equal(stampWritesIn('{ ARCRUN_BUNDLE_VERSION: v }').version.length, 1);
  assert.equal(stampWritesIn('env.ARCRUN_BUNDLE_VERSION').version.length, 0);
});
