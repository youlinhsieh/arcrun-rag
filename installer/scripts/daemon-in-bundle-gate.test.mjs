/**
 * daemon-in-bundle-gate.test.mjs — **閘自己要能被演練**。
 *
 * 跑法：node --test installer/scripts/daemon-in-bundle-gate.test.mjs
 *
 * 一道沒被演練過的閘等於沒有閘。所以這裡餵的**該擋**的輸入，全部是真的發生過、
 * 或這次搬家真的造成的狀態（不另外編一個「像 offender 的假東西」）：
 *   ① 2026-08-18 D95 第一輪之後的實況：daemon changelog 搬去 collector/，
 *      出貨線還照舊指 docs-site ⇒ **檔案在、但那份檔案裡沒有 `v0.18.x`** → 要擋
 *      （這正是 `status:'skip'` 的來源，也是本閘存在的理由）
 *   ② 說明檔整份不見（第三輪 collector/ 搬出 repo 之後的形狀）→ 要擋
 *   ③ 2026-08-09 的實況：bundle 停在舊版（v0.18.24）而源碼樹說 v0.18.25 → 要擋
 *   ④ **版號沒變但內容變了**（sha256 對不上）→ 要擋
 *      ← `wiki/trees/2026-08-17-today.md` 給這條線的完工判準就是這一項
 *   ⑤ **msix 停在上一版**（檔名帶舊版號、manifest 卻宣告新版）→ 要擋
 *      ← 同上，wiki 原話「msix 停在上一版卻報全綠」
 *   ⑥ manifest 說有、磁碟上沒有那個檔 → 要擋
 *   ⑦ 缺一整個必要平台（win）→ 要擋
 *   ⑧ 檔案在但是 0 位元組 → 要擋
 * **不該擋**的也要演練，否則它會變成第二支「關鍵字誤攔七次」的閘（InkStoneCo#55）：
 *   ⑨ 一切一致（含真實的 sha256）→ 放行
 *   ⑩ msix 根本沒宣告（選配平台，缺了不影響任何人）→ 放行
 *   ⑪ manifest.daemon 裡的 version／notes／built 不是平台欄位 → 不可以被當成檔案去找
 * 外加：留痕真的寫得出來（**擋下與放行都要有一行**，InkStoneCo#48）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  collectFacts, judge, appendGateLog, localStamp, formatProblem,
  requireDaemonInBundle, REQUIRED_PLATFORMS, RELEASED_RE,
} from './daemon-in-bundle-gate.mjs';

const CHANGELOG_REL = 'collector/CHANGELOG.md';

/** 真的一份 daemon changelog（格式與 collector/CHANGELOG.md 一致）。 */
const CHANGELOG = [
  '# 版本與更新',
  '',
  '## v0.18.29（2026-08-16）',
  '',
  '- **修好一件事**：說明。',
  '',
  '## v0.18.28（2026-08-16）',
  '',
  '- **更早的一版**：說明。',
  '',
].join('\n');

/** docs-site 那份（雲端引擎 `1.4.x`，**沒有 `v` 前綴**）——①的真兇。 */
const CLOUD_CHANGELOG = [
  '---', 'title: 版本說明', '---', '',
  '## 1.4.47（2026-08-15）', '', '- **雲端那條線**：跟 daemon 無關。', '',
].join('\n');

/**
 * 搭一個「repo ＋ bundle」的臨時場景。
 * @param {object} o
 * @param {string|null} o.changelog       寫進 collector/CHANGELOG.md 的內容；null＝不建這個檔
 * @param {object|null} o.daemon          manifest.daemon 的內容；null＝manifest 沒有 daemon
 * @param {boolean} [o.manifest=true]     要不要建 manifest.json
 * @param {object} [o.files]              { 檔名: 內容字串 } —— 真的寫進 bundle/daemon/
 */
function scene({ changelog = CHANGELOG, daemon, manifest = true, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'dgate-'));
  const repo = join(root, 'repo');
  const bundles = join(root, 'bundles');
  mkdirSync(join(repo, 'collector'), { recursive: true });
  mkdirSync(join(bundles, 'daemon'), { recursive: true });
  if (changelog !== null) writeFileSync(join(repo, CHANGELOG_REL), changelog);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(bundles, 'daemon', name), content);
  if (manifest) writeFileSync(join(bundles, 'manifest.json'), JSON.stringify({ release: '1.4.47', daemon }, null, 1));
  return { root, repo, bundles, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');

/** 跑一次判決（真的碰磁碟——本閘的判準就是磁碟上的事實，不該用假 fs 繞過去）。 */
function run(s) {
  return judge(collectFacts({ repoRoot: s.repo, bundlesDir: s.bundles, changelogRel: CHANGELOG_REL }));
}
/** 這次擋下來，是不是**因為那一項**（不是碰巧因為別的擋到）。 */
function blockedBy(result, id) {
  assert.equal(result.ok, false, '應該要擋下來，但放行了');
  const c = result.checks.find((x) => x.id === id);
  assert.ok(c, `判決裡沒有 \`${id}\` 這一項`);
  assert.equal(c.ok, false, `\`${id}\` 應該不過，但它過了`);
}

// 一份「完全一致」的基準場景，各測項只從它身上改一個變因。
const MAC = 'MAC-BINARY-v0.18.29';
const WIN = 'WIN-BINARY-v0.18.29';
const MSIX = 'MSIX-BINARY-v0.18.29';
const GOOD = () => ({
  changelog: CHANGELOG,
  daemon: {
    version: 'v0.18.29',
    built: '20260816-2351',
    notes: '一句話摘要',
    mac: { file: 'daemon/Arcrun-v0.18.29.dmg', sha256: sha(MAC) },
    win: { file: 'daemon/Arcrun-win-v0.18.29.exe', sha256: sha(WIN) },
    msix: { file: 'daemon/Arcrun-v0.18.29.msix', sha256: sha(MSIX) },
  },
  files: {
    'Arcrun-v0.18.29.dmg': MAC,
    'Arcrun-win-v0.18.29.exe': WIN,
    'Arcrun-v0.18.29.msix': MSIX,
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 該擋的
// ═══════════════════════════════════════════════════════════════════════════

test('① 出貨線指到那份沒有 daemon 版本的 changelog（D95 搬家之後的真實症狀）→ 擋，不是跳過', () => {
  const s = scene({ ...GOOD(), changelog: CLOUD_CHANGELOG });
  try {
    const r = run(s);
    blockedBy(r, 'source-version');
    // 🔴 這一項就是本閘的存在理由：**以前這裡回 `status:'skip'`**。
    assert.match(formatProblem(r), /問不出來就是斷/);
  } finally { s.cleanup(); }
});

test('② daemon 的說明檔整份不在（collector/ 搬出 repo 之後的形狀）→ 擋', () => {
  const s = scene({ ...GOOD(), changelog: null });
  try {
    blockedBy(run(s), 'changelog-found');
  } finally { s.cleanup(); }
});

test('③ bundle 停在舊版（源碼樹 v0.18.29 vs bundle v0.18.28）→ 擋', () => {
  const g = GOOD();
  const s = scene({ ...g, daemon: { ...g.daemon, version: 'v0.18.28' } });
  try {
    blockedBy(run(s), 'version-match');
  } finally { s.cleanup(); }
});

test('④ 版號沒變但內容變了（sha256 對不上）→ 擋　← 這條線的完工判準', () => {
  const g = GOOD();
  // manifest 宣告的還是舊內容的雜湊，磁碟上那顆已經被換掉了。
  const s = scene({ ...g, files: { ...g.files, 'Arcrun-v0.18.29.dmg': 'MAC-BINARY-REBUILT' } });
  try {
    const r = run(s);
    blockedBy(r, 'hash-match');
    // 只比版號字串的舊做法在這裡是全綠的——確認新閘不是靠版號抓到它。
    assert.equal(r.checks.find((c) => c.id === 'version-match').ok, true);
  } finally { s.cleanup(); }
});

test('⑤ msix 停在上一版（檔名帶舊版號）→ 擋　← wiki 2026-08-17「報全綠」那件', () => {
  const g = GOOD();
  const s = scene({
    ...g,
    daemon: { ...g.daemon, msix: { file: 'daemon/Arcrun-v0.18.28.msix', sha256: sha(MSIX) } },
    files: { ...g.files, 'Arcrun-v0.18.28.msix': MSIX },
  });
  try {
    const r = run(s);
    blockedBy(r, 'filename-carries-version');
    // 版號、檔案存在、雜湊三項都是綠的——舊做法完全看不到這件事。
    for (const id of ['version-match', 'files-present', 'hash-match']) {
      assert.equal(r.checks.find((c) => c.id === id).ok, true, `${id} 在這個情境本來就該是綠的`);
    }
  } finally { s.cleanup(); }
});

test('⑥ manifest 說有、磁碟上沒有那個檔 → 擋', () => {
  const g = GOOD();
  const files = { ...g.files };
  delete files['Arcrun-win-v0.18.29.exe'];
  const s = scene({ ...g, files });
  try {
    blockedBy(run(s), 'files-present');
  } finally { s.cleanup(); }
});

test('⑦ 缺一整個必要平台（win 沒宣告）→ 擋', () => {
  const g = GOOD();
  const daemon = { ...g.daemon };
  delete daemon.win;
  const s = scene({ ...g, daemon });
  try {
    blockedBy(run(s), 'platforms-complete');
  } finally { s.cleanup(); }
});

test('⑧ 檔案在但是 0 位元組 → 擋', () => {
  const g = GOOD();
  const s = scene({
    ...g,
    daemon: { ...g.daemon, mac: { file: 'daemon/Arcrun-v0.18.29.dmg', sha256: sha('') } },
    files: { ...g.files, 'Arcrun-v0.18.29.dmg': '' },
  });
  try {
    blockedBy(run(s), 'files-nonempty');
  } finally { s.cleanup(); }
});

test('⑨ manifest.json 不存在 → 擋（preflight 已負責播種，走到這裡還沒有＝那一步沒做成）', () => {
  const s = scene({ ...GOOD(), manifest: false });
  try {
    blockedBy(run(s), 'manifest-found');
  } finally { s.cleanup(); }
});

test('⑩ manifest 沒有 daemon 這一段 → 擋（使用者按「檢查更新」什麼都拿不到）', () => {
  const s = scene({ ...GOOD(), daemon: null });
  try {
    blockedBy(run(s), 'bundle-declares-daemon');
  } finally { s.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// **不該擋**的（InkStoneCo#55：文字層的閘那天 8 次誤攔、0 次正確攔截）
// ═══════════════════════════════════════════════════════════════════════════

test('⑪ 一切一致（含真實 sha256）→ 放行', () => {
  const s = scene(GOOD());
  try {
    const r = run(s);
    assert.equal(r.ok, true, formatProblem(r));
    assert.equal(r.version, 'v0.18.29');
    assert.equal(r.bundleVersion, 'v0.18.29');
  } finally { s.cleanup(); }
});

test('⑫ msix 根本沒宣告（選配平台）→ 放行，不可以要求它', () => {
  const g = GOOD();
  const daemon = { ...g.daemon };
  delete daemon.msix;
  const files = { ...g.files };
  delete files['Arcrun-v0.18.29.msix'];
  const s = scene({ ...g, daemon, files });
  try {
    assert.equal(run(s).ok, true);
    assert.ok(!REQUIRED_PLATFORMS.includes('msix'), 'msix 不該被列為必要平台');
  } finally { s.cleanup(); }
});

test('⑬ version／notes／built 不是平台欄位，不可以被當成檔案去找', () => {
  const s = scene(GOOD());
  try {
    const facts = collectFacts({ repoRoot: s.repo, bundlesDir: s.bundles, changelogRel: CHANGELOG_REL });
    assert.deepEqual(facts.artifacts.map((a) => a.key).sort(), ['mac', 'msix', 'win']);
  } finally { s.cleanup(); }
});

test('⑭ changelog 有「下一版（未發佈）」草稿 → 不影響判定（只認已發佈段）', () => {
  const withDraft = '# 版本與更新\n\n## 下一版（未發佈）\n\n- 還沒打包\n\n' + CHANGELOG.split('\n').slice(2).join('\n');
  const s = scene({ ...GOOD(), changelog: withDraft });
  try {
    const r = run(s);
    assert.equal(r.ok, true, formatProblem(r));
    assert.equal(r.version, 'v0.18.29');
  } finally { s.cleanup(); }
});

test('⑮ 判斷式與 daemon-version.py／daemon-freshness 同一個（只認 `## vX.Y.Z（`）', () => {
  assert.equal('## v0.18.29（2026-08-16）'.match(RELEASED_RE)[1], 'v0.18.29');
  assert.equal('## 1.4.47（2026-08-15）'.match(RELEASED_RE), null);      // 雲端那條線不會被撈到
  assert.equal('## 下一版（未發佈）'.match(RELEASED_RE), null);           // 草稿不算
});

// ═══════════════════════════════════════════════════════════════════════════
// 留痕（InkStoneCo#48）：**擋下與放行都要有一行**
// ═══════════════════════════════════════════════════════════════════════════

test('⑯ 留痕：擋下與放行都記，而且記得出「擋下什麼」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dgate-log-'));
  const logPath = join(dir, 'installer', 'daemon-in-bundle-gate-log.md');
  try {
    const bad = scene({ ...GOOD(), changelog: CLOUD_CHANGELOG });
    const good = scene(GOOD());
    try {
      appendGateLog(logPath, { ts: '2026-08-18 14:00:00', targetName: 'stage', result: run(bad) });
      appendGateLog(logPath, { ts: '2026-08-18 14:01:00', targetName: 'stage', result: run(good) });
    } finally { bad.cleanup(); good.cleanup(); }
    const text = readFileSync(logPath, 'utf8');
    assert.match(text, /⛔ 擋下/);
    assert.match(text, /✅ 放行/);
    assert.match(text, /source-version/);        // 擋下的理由有寫進去，不是只寫「擋下」
    assert.equal(text.split('\n').filter((l) => l.startsWith('| 2026-')).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⑰ requireDaemonInBundle：不過就丟例外，而且**丟之前先留痕**', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dgate-req-'));
  const logPath = join(dir, 'log.md');
  const s = scene({ ...GOOD(), changelog: CLOUD_CHANGELOG });
  try {
    assert.throws(
      () => requireDaemonInBundle({
        repoRoot: s.repo, bundlesDir: s.bundles, changelogRel: CHANGELOG_REL,
        targetName: 'stage', logPath,
      }),
      /daemon 沒有進到這次的成品裡/);
    assert.match(readFileSync(logPath, 'utf8'), /⛔ 擋下/);   // 例外沒有把留痕吃掉
  } finally { s.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('⑱ localStamp 是本地時間不是 UTC（與 github-contact-log 同一條稽核鏈）', () => {
  const d = new Date(2026, 7, 18, 9, 5, 3);
  assert.equal(localStamp(d), '2026-08-18 09:05:03');
});
