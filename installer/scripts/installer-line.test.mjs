/**
 * installer-line.test.mjs — 安裝器那條版本線的演練（inkstone/arcrun-rag#169）
 *
 * 跑法：node --test installer/scripts/installer-line.test.mjs
 *
 * 這份測試要證的不是「函式會跑」，是**這道閘該擋的擋得住、不該擋的不會亂叫**：
 *   ① 改安裝器的行為碼 ⇒ 號碼一定跳（本票要治的病）
 *   ② 改測試／改釘子／改版本檔本身 ⇒ 號碼不動（不然每趟出貨都在虛增）
 *   ③ 手動改回舊號碼 ⇒ 當場擋下（「故意不升號」）
 *   ④ 寫 changelog／寫版本檔**不會改變指紋** ⇒ 結構上不可能長出 9962525 那種自鎖
 *   ⑤ 沒寫 changelog ⇒ 當場擋下（「故意不寫更新說明」）
 *   ⑥ 真實 repo 的三條線互不重疊（撞號會讓 changelog 撈到別條線的段落）
 *
 * 🔴 2026-09-01 第二輪（comment 5959）多守一件事：**「線上跑的是哪一份」那個識別值**。
 *   實測抓到的病是它**答錯**——prod（1.0.3）與 uncle6 staging（1.0.4）回同一串 sha，
 *   兩個都對不上原始碼，因為它住在 `wrangler.toml` 的 vars 裡、靠部署的人記得填。
 *   ⇒ ⑫⑬⑭⑮ 四支就是票上那條「有測試守住『值對不上就吵』，而不是靠人比對」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installerSourceFiles, isSourceFile, installerFingerprint, normalizeSource,
  nextInstallerVersion, syncInstallerVersion, verifyInstallerVersion,
  readInstallerVersion, readInstallerSrcSha, readInstallerLine, installerChangelogSection,
  INSTALLER_LINE_REL, INSTALLER_CHANGELOG_REL, INSTALLER_VERSION_REL, INSTALLER_SRC_REL,
} from './installer-line.mjs';
import { readReleaseState, writeReleaseState } from './release.mjs';
import { LINES, publishesRelease, publishesToUsers, releaseVisibility, lineCollisionProblems } from './release-lines.mjs';
import { readDaemonLine } from '../../collector/cmd/arcrun-app/daemon-notes.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** 造一個最小的假 repo：一條線、一份 changelog、一顆有兩個檔的安裝器。 */
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'installer-line-'));
  const src = join(root, INSTALLER_SRC_REL);
  mkdirSync(src, { recursive: true });
  mkdirSync(join(src, 'shared'), { recursive: true });
  mkdirSync(join(root, 'installer'), { recursive: true });
  writeFileSync(join(root, INSTALLER_LINE_REL), '1.0\n');
  writeFileSync(join(src, 'worker.js'), [
    "const DEFAULT_BUNDLE_BASE = 'https://cdn/x@aaaaaaa';",
    "const BUNDLE_BUILT = '2026-08-29';",
    "export default { fetch() { return new Response('hi'); } };",
  ].join('\n'));
  writeFileSync(join(src, 'shared', 'rule.mjs'), 'export const RULE = 1;\n');
  writeFileSync(join(src, 'worker.test.mjs'), 'test stub v1\n');
  writeFileSync(join(root, INSTALLER_CHANGELOG_REL), '# 安裝器更新說明\n\n## 1.0.0（2026-09-01）\n\n- 第一版\n');
  return { root, src };
}
const changelogAppend = (root, version, text) =>
  writeFileSync(join(root, INSTALLER_CHANGELOG_REL),
    readFileSync(join(root, INSTALLER_CHANGELOG_REL), 'utf8') + `\n## ${version}（2026-09-02）\n\n- ${text}\n`);

test('① 改安裝器的行為碼 ⇒ 號碼一定跳（這就是本票要治的病）', () => {
  const { root, src } = fakeRepo();
  try {
    const a = syncInstallerVersion(root, { quiet: true });
    assert.equal(a.version, '1.0.0');
    assert.equal(readInstallerVersion(root), '1.0.0');

    // 只改一個**不是 worker.js** 的行為檔——舊的 installerSourceHash 看不到它。
    writeFileSync(join(src, 'shared', 'rule.mjs'), 'export const RULE = 2;\n');
    changelogAppend(root, '1.0.1', '改了資源沿用規則');
    const b = syncInstallerVersion(root, { quiet: true });
    assert.equal(b.version, '1.0.1', 'shared/ 底下的行為改了，號碼必須跟著跳（舊指紋只認 worker.js）');
    assert.equal(b.changed, true);
    assert.deepEqual(verifyInstallerVersion(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('② 改測試／改釘子／重跑 ⇒ 號碼不動（閘不准虛增，不然它會被學會忽略）', () => {
  const { root, src } = fakeRepo();
  try {
    syncInstallerVersion(root, { quiet: true });

    writeFileSync(join(src, 'worker.test.mjs'), 'test stub v2（改測試不是改產品）\n');
    assert.equal(syncInstallerVersion(root, { quiet: true }).version, '1.0.0', '改測試不該讓使用者看到新版本');

    // pin 站每趟出貨都會改寫這兩行——它們不算「安裝器改了」。
    writeFileSync(join(src, 'worker.js'), readFileSync(join(src, 'worker.js'), 'utf8')
      .replace("@aaaaaaa", "@bbbbbbb").replace("'2026-08-29'", "'2026-09-01'"));
    assert.equal(syncInstallerVersion(root, { quiet: true }).version, '1.0.0', '換釘子不是改安裝器邏輯');

    // 冪等：什麼都不動重跑三次
    for (let i = 0; i < 3; i++) assert.equal(syncInstallerVersion(root, { quiet: true }).version, '1.0.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('③ 故意不升號（手改回舊號碼）⇒ 當場擋下，且訊息說得出指紋差在哪', () => {
  const { root, src } = fakeRepo();
  try {
    syncInstallerVersion(root, { quiet: true });
    writeFileSync(join(src, 'worker.js'), readFileSync(join(src, 'worker.js'), 'utf8') + '\n// 一個真的行為改動\n');
    const problems = verifyInstallerVersion(root);
    // 2026-09-01 起會吵**兩件**：號碼沒跟上，而且版本檔烙的識別值也停在舊那份碼。
    // 兩件同時為真，所以兩件都要說——只報一件會讓修的人以為改號碼就好（識別值仍在說謊）。
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0], /安裝器原始碼改了，但版本號沒跟上/);
    assert.match(problems[0], /指紋 [0-9a-f]{12}… → [0-9a-f]{12}…/, '不能只說「不一樣」，要說得出比對了什麼');
    assert.match(problems[1], /烙的原始碼指紋對不上現在這棵樹/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('④ 寫 changelog 與寫版本檔都不會改變指紋 ⇒ 不可能長出 9962525 那種自鎖', () => {
  const { root } = fakeRepo();
  try {
    const src = join(root, INSTALLER_SRC_REL);
    const before = installerFingerprint(src);
    changelogAppend(root, '9.9.9', '宣告本身不該改變指紋');
    writeFileSync(join(root, INSTALLER_VERSION_REL), "export const INSTALLER_VERSION = '7.7.7';\n");
    assert.equal(installerFingerprint(src), before,
      '「宣告新版本」這個動作本身如果落在指紋範圍內，閘就會擋自己——那正是 2026-08-18 出貨線鎖死的真因');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑤ 號碼跳了卻沒寫更新說明 ⇒ 當場擋下（不發版本頁換來的就是這道閘）', () => {
  const { root, src } = fakeRepo();
  try {
    syncInstallerVersion(root, { quiet: true });
    writeFileSync(join(src, 'shared', 'rule.mjs'), 'export const RULE = 3;\n');
    syncInstallerVersion(root, { quiet: true });          // 號碼跳到 1.0.1，但沒人寫 changelog
    assert.equal(readInstallerVersion(root), '1.0.1');
    const problems = verifyInstallerVersion(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /沒有 1\.0\.1 這一版/);
    // 補上就過——閘不能是永遠擋著的假警報
    changelogAppend(root, '1.0.1', '補上說明');
    assert.deepEqual(verifyInstallerVersion(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑥ 共用狀態不准互相抹掉：寫零件包那一格，安裝器那一格要還在', () => {
  const { root } = fakeRepo();
  try {
    syncInstallerVersion(root, { quiet: true });
    // 零件包那條線（release.mjs 的 syncManifest）會寫這三格——舊版是整份重寫，
    // 會把 installer 那一格靜默吃掉，下一趟就讀不到「上一版是什麼」。
    writeReleaseState(root, { fingerprint: 'abc', release: '1.4.99', built: '2026-09-01' });
    const st = readReleaseState(root);
    assert.equal(st.release, '1.4.99');
    assert.ok(st.installer && st.installer.version === '1.0.0',
      '安裝器那一格被零件包的寫入吃掉了 ⇒ 版本號會無聲倒退（同 manifest 吃掉 daemon 欄那次）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑦ 定義域：收行為碼、不收測試／版本檔／設定檔', () => {
  assert.equal(isSourceFile('worker.js'), true);
  assert.equal(isSourceFile('migrations.json'), true);
  assert.equal(isSourceFile('shared/resource-rule/rule.mjs'), true);
  assert.equal(isSourceFile('worker.test.mjs'), false);
  assert.equal(isSourceFile('shared/resource-rule/tests/demo.mjs'), false);
  assert.equal(isSourceFile('version.mjs'), false, '它是這支算出來的結果，收進去會追自己的尾巴');
  assert.equal(isSourceFile('wrangler.toml'), false, '每個目標各自的部署參數，收了 stage 與 prod 會算出不同號碼');
  assert.equal(isSourceFile('README.md'), false);
  // 正規化只動 worker.js 的那兩行釘子，別的檔一字不動
  assert.equal(normalizeSource('other.mjs', "const DEFAULT_BUNDLE_BASE = 'x'"), "const DEFAULT_BUNDLE_BASE = 'x'");
});

test('⑧ 換線（改 INSTALLER_LINE）⇒ patch 歸零；版號形狀不對 ⇒ 吵', () => {
  assert.equal(nextInstallerVersion('1.0', '1.0.3', 'aa', 'aa'), '1.0.3', '內容沒變不動');
  assert.equal(nextInstallerVersion('1.0', '1.0.3', 'aa', 'bb'), '1.0.4');
  assert.equal(nextInstallerVersion('1.1', '1.0.3', 'aa', 'aa'), '1.1.0', '人改了 MAJOR.MINOR ⇒ 歸零');
  assert.equal(nextInstallerVersion('1.0', null, null, 'bb'), '1.0.0');
  const { root } = fakeRepo();
  try {
    writeFileSync(join(root, INSTALLER_LINE_REL), '不是版本\n');
    assert.throws(() => readInstallerLine(root), /必須是 MAJOR\.MINOR/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑨ 真實 repo：三條線互不重疊，且安裝器這條真的被宣告成版本線', () => {
  const bundle = readFileSync(join(REPO_ROOT, 'RELEASE_LINE'), 'utf8').trim();
  const daemon = readDaemonLine(join(REPO_ROOT, 'collector', 'DAEMON_LINE'));
  const installer = readInstallerLine(REPO_ROOT);
  assert.deepEqual(lineCollisionProblems({ bundle, daemon, installer }), [],
    `三條線撞號（bundle=${bundle}／daemon=${daemon}／installer=${installer}）⇒ changelog 會撈到別條線的段落、tag 也會撞`);

  const line = LINES.find((l) => l.id === 'installer');
  assert.ok(line, '安裝器沒被宣告成版本線 ⇒ 它露在 /api/latest 的號碼會被 checkCoverage 判成「沒人負責」');
  assert.deepEqual(line.latestPath, ['installer', 'version']);
  // 🔴 2026-09-02 leo 裁決：這三行以前釘的是「安裝器不發版本頁」，而那條宣告是錯的。
  //   leo：「**你的宣告有誤**⋯⋯什麼東西改了不用聲明？**那是說不用告訴用戶。**」
  //   「不獨立發版本，但那是用戶，**我不能沒有版本，內部所有開發都要有版本**」
  //   ⇒ 現在釘的是：它**會**發版本物件（所以 leo 打得開），只是只發在內部那一側。
  assert.equal(releaseVisibility('installer'), 'internal',
    '安裝器又被改成不發版本物件了 ⇒ 那正是 2026-09-01「1.0.3 上了 prod，Gitea 上一筆都沒有」的成因');
  assert.equal(publishesRelease('installer'), true);
  assert.equal(publishesToUsers('installer'), false, '安裝器那一面是對內的（使用者不會去選版本）');
  assert.ok(line.whyInternal, '只發內部必須寫明理由——沒有理由的例外就是後門');
  assert.equal(line.tagPrefix, 'installer-',
    '沒有前綴，它與零件包的號碼會混在同一條歷史上（「最新版是哪一個」就沒有答案）');
  assert.deepEqual(line.assetKeys, [],
    '`[]` 是「明說沒有可掛的檔」；寫 null 會讓它去掛零件包的 manifest.json');
  assert.equal(releaseVisibility('bundle'), 'public', '零件包是使用者拿得到的東西，不准改成不對外');
  assert.equal(releaseVisibility('daemon'), 'public', '桌面小幫手是使用者下載得到的東西，不准改成不對外');
});

test('⑩ 真實 repo：現在磁碟上的碼配得上宣告的號碼，且那一版有更新說明', () => {
  assert.deepEqual(verifyInstallerVersion(REPO_ROOT), []);
  const v = readInstallerVersion(REPO_ROOT);
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.ok(installerChangelogSection(REPO_ROOT, v), `${INSTALLER_CHANGELOG_REL} 裡沒有 ${v} 這一版`);
});

test('⑪ 定義域真的涵蓋了那幾個「舊指紋看不到」的檔', () => {
  const files = installerSourceFiles(join(REPO_ROOT, INSTALLER_SRC_REL));
  for (const must of ['worker.js', 'migrations.json', 'version-stamp.mjs', 'workflows.json',
    'skills.json', 'shared/resource-rule/rule.mjs']) {
    assert.ok(files.includes(must), `${must} 不在指紋定義域裡 ⇒ 改它安裝器版本不會動`);
  }
  assert.ok(!files.some((f) => f.endsWith('.test.mjs')));
  assert.ok(!files.includes('version.mjs'));
});

// ── 2026-09-01 第二輪（comment 5959）：識別值 ─────────────────────────────────

test('⑫ 版本檔同時烙原始碼指紋，而且＝這棵樹算出來的那一串', () => {
  const { root, src } = fakeRepo();
  try {
    const a = syncInstallerVersion(root, { quiet: true });
    assert.equal(readInstallerSrcSha(root), a.fingerprint);
    assert.equal(readInstallerSrcSha(root), installerFingerprint(src));
    assert.deepEqual(verifyInstallerVersion(root), []);

    // 改行為碼 → 重跑 → 號碼與指紋兩格一起前進（不會只動一格）
    writeFileSync(join(src, 'shared', 'rule.mjs'), 'export const RULE = 2;\n');
    changelogAppend(root, '1.0.1', '改了一件事');
    const b = syncInstallerVersion(root, { quiet: true });
    assert.equal(b.version, '1.0.1');
    assert.notEqual(b.fingerprint, a.fingerprint);
    assert.equal(readInstallerSrcSha(root), b.fingerprint);
    assert.equal(b.fingerprintChanged, true, 'deploy 站的 belt 靠這一格才不會跳過部署');
    assert.deepEqual(verifyInstallerVersion(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑬ 識別值對不上這棵樹 ⇒ 當場擋下（不是靠人拿兩串 sha 用眼睛比）', () => {
  const { root } = fakeRepo();
  try {
    syncInstallerVersion(root, { quiet: true });
    // 這一行模擬的就是 comment 5959 量到的現場：識別值停在別份碼的值。
    // 舊機制下它住在 wrangler.toml，手部署一次就會變成這樣，而**沒有任何東西會吵**。
    const vp = join(root, INSTALLER_VERSION_REL);
    writeFileSync(vp, readFileSync(vp, 'utf8')
      .replace(/INSTALLER_SRC_SHA = '[^']*'/, "INSTALLER_SRC_SHA = '5ada702b0d3f3baed7f6141e129bdb270f15b5a2669a98a666bb74d35e3f951f'"));
    const problems = verifyInstallerVersion(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /烙的原始碼指紋對不上現在這棵樹/);
    assert.match(problems[0], /烙的 5ada702b0d3f… ／ 這棵樹 [0-9a-f]{12}…/,
      '不能只說「不一樣」，要說得出兩串各是什麼——否則修的人還是得自己去撈');
    // 重烙就過（閘不能是永遠擋著的假警報）
    syncInstallerVersion(root, { quiet: true });
    assert.deepEqual(verifyInstallerVersion(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⑭ 兩棵不同的樹 ⇒ 識別值不一樣（舊機制下它們回的是同一串）', () => {
  const a = fakeRepo();
  const b = fakeRepo();
  try {
    syncInstallerVersion(a.root, { quiet: true });
    writeFileSync(join(b.src, 'worker.js'),
      readFileSync(join(b.src, 'worker.js'), 'utf8') + '\n// 另一條線多了一個行為改動\n');
    syncInstallerVersion(b.root, { quiet: true });
    assert.notEqual(readInstallerSrcSha(a.root), readInstallerSrcSha(b.root),
      '兩份不同的原始碼回同一個識別值 ⇒ 這個欄位分辨不出線，也認不出版本（就是 5959 量到的）');
    // 反面同樣要成立：同一份原始碼在兩個地方必須算出同一串（不然它會變成「部署了幾次」的計數器）
    const c = fakeRepo();
    try {
      cpSync(a.src, c.src, { recursive: true });
      cpSync(join(a.root, INSTALLER_CHANGELOG_REL), join(c.root, INSTALLER_CHANGELOG_REL));
      syncInstallerVersion(c.root, { quiet: true });
      assert.equal(readInstallerSrcSha(c.root), readInstallerSrcSha(a.root));
    } finally { rmSync(c.root, { recursive: true, force: true }); }
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});

test('⑮ 版本檔只有號碼、沒有識別值（舊格式）⇒ 吵，不當成「這個環境沒有這東西」', () => {
  const { root } = fakeRepo();
  try {
    syncInstallerVersion(root, { quiet: true });
    writeFileSync(join(root, INSTALLER_VERSION_REL), "export const INSTALLER_VERSION = '1.0.0';\n");
    const problems = verifyInstallerVersion(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /讀不到 INSTALLER_SRC_SHA/);
    assert.match(problems[0], /installer_sha 會回 null/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
