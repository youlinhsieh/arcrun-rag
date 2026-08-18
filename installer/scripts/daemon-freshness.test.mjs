/**
 * daemon-freshness.test.mjs — 證明「changelog 宣告的版本，源碼已經動過」真的會**停**，
 * 而且指名道姓；也證明「daemon 真的沒動過」時完全安靜。
 *
 * 跑法：node --test installer/scripts/daemon-freshness.test.mjs
 * （零依賴、全程用臨時 git repo，不碰真的 arcrun-rag repo）
 *
 * 案例照 2026-08-15 夜間那天的真實形狀寫：
 *   · changelog 已發佈段戳完 v0.18.27 之後，collector/ 又被 commit 三次 ⇒ 必須擋
 *   · 只改 changelog（無關目錄）⇒ 不誤報
 *   · 「有下一版（未發佈）草稿」不能讓它安靜過關——草稿不是打包
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  topReleasedVersion, hasUnreleasedDraft, findVersionAnnounceCommit,
  checkDaemonFreshness, formatDaemonFreshnessProblem, requireFreshDaemonSource,
} from './daemon-freshness.mjs';

// daemon 那條線的 changelog（＝ ship.mjs 傳進來的 DAEMON_CHANGELOG_REL）。
// 本測試在暫存目錄裡造假 repo，路徑只要與正式的一致就好。
const CHANGELOG_REL = join('collector', 'CHANGELOG.md');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(repo, msg) {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** 造一個長得像 arcrun-rag 的臨時 repo：collector/ 源碼 ＋ changelog（已有一段已發佈版本）。 */
function fakeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-freshness-'));
  git(dir, ['init', '-q', '-b', 'main']);
  mkdirSync(join(dir, 'collector', 'cmd', 'arcrun-app'), { recursive: true });
  writeFileSync(join(dir, 'collector', 'cmd', 'arcrun-app', 'main.go'), 'package main\n');
  writeFileSync(join(dir, CHANGELOG_REL),
    '# Arcrun 桌面版（daemon）版本說明\n\n## v0.18.27（2026-08-13）\n\n- 第一版\n');
  commit(dir, '第一版源碼＋已發佈 changelog');
  // 戳版號那一刻，通常會另外 commit（同 62560e4 的形狀：只動版本鎖檔，不動 collector 的內容邏輯）。
  writeFileSync(join(dir, 'version-lock.json'), '{"v0.18.27":"abc"}\n');
  const announceSha = commit(dir, 'chore(desktop): 戳版號 v0.18.27');
  return { dir, announceSha };
}

test('✅ 版本宣告之後 daemon 完全沒動過 ⇒ 放行、完全安靜', () => {
  const { dir } = fakeRepo();
  try {
    const r = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL });
    assert.equal(r.status, 'ok', JSON.stringify(r, null, 2));
    assert.equal(r.behind.length, 0);
    assert.equal(r.version, 'v0.18.27');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 2026-08-15 那天的形狀：宣告 v0.18.27 之後 collector/ 又被 commit 三次 ⇒ 擋，指名幾顆、哪一版', () => {
  const { dir } = fakeRepo();
  try {
    writeFileSync(join(dir, 'collector', 'cmd', 'arcrun-app', 'main.go'), 'package main\n// 免金鑰路自帶提示詞\n');
    const c1 = commit(dir, 'feat(collector): 免金鑰路自帶提示詞（Arcrun#134）');
    writeFileSync(join(dir, 'collector', 'cmd', 'arcrun-app', 'wiki.go'), 'package main\n');
    const c2 = commit(dir, 'feat(collector): 規範形 wiki 卡');
    writeFileSync(join(dir, 'collector', 'cmd', 'arcrun-app', 'struct.go'), 'package main\n');
    const c3 = commit(dir, 'feat(collector): 結構先行');

    // 舊的兩道閘（daemon-sync／daemon-check）比的是 bundle vs changelog，兩邊都沒動 ⇒ 沒話可說：
    // 本測試不重造那兩道閘，只證明「changelog vs 源碼」這一段本檔補得上。
    const r = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL });
    assert.equal(r.status, 'stale');
    assert.equal(r.version, 'v0.18.27');
    assert.equal(r.behind.length, 3);

    const msg = formatDaemonFreshnessProblem({ repo: dir, result: r });
    assert.match(msg, /v0\.18\.27/);
    assert.match(msg, new RegExp(c1.slice(0, 7)));
    assert.match(msg, new RegExp(c2.slice(0, 7)));
    assert.match(msg, new RegExp(c3.slice(0, 7)));
    assert.match(msg, /不會自動幫你戳版／打包/, '紅線：不准自動打包就放行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 有「下一版（未發佈）」草稿也救不了——草稿不是打包', () => {
  const { dir } = fakeRepo();
  try {
    writeFileSync(join(dir, 'collector', 'cmd', 'arcrun-app', 'wiki.go'), 'package main\n');
    commit(dir, 'feat(collector): 規範形 wiki 卡');
    // 有人已經手動補了草稿段（同 2026-08-15 status.md 那筆記錄的真實情況）：
    const cl = join(dir, CHANGELOG_REL);
    const text = readFileSync(cl, 'utf8');
    writeFileSync(cl, text.replace('## v0.18.27', '## 下一版（未發佈）\n\n- 規範形 wiki 卡\n\n## v0.18.27'));
    commit(dir, 'docs(changelog): 補下一版草稿');

    const r = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL });
    assert.equal(r.status, 'stale', '草稿只代表先寫，不代表已經戳版打包，不能讓它安靜過關');
    assert.equal(r.hasDraft, true);
    const msg = formatDaemonFreshnessProblem({ repo: dir, result: r });
    assert.match(msg, /已經有「下一版（未發佈）」草稿/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 只動別的目錄（不是 collector）⇒ 不誤報', () => {
  const { dir } = fakeRepo();
  try {
    mkdirSync(join(dir, 'docs-site', 'other'), { recursive: true });
    writeFileSync(join(dir, 'docs-site', 'other', 'note.md'), '不相干的文件改動\n');
    commit(dir, 'docs: 改一份跟 daemon 無關的文件');
    const r = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL });
    assert.equal(r.status, 'ok', '不該把不相干目錄的改動算進 daemon 落後');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 源碼改了但還沒 commit ⇒ 擋；allowDirty 才降級放行（stale 不受影響）', () => {
  const { dir } = fakeRepo();
  try {
    writeFileSync(join(dir, 'collector', 'cmd', 'arcrun-app', 'main.go'), 'package main\n// 未提交\n');
    const strict = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL });
    assert.equal(strict.status, 'dirty');
    const lenient = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL, allowDirty: true });
    assert.equal(lenient.status, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 問不出來一律停：changelog 沒有任何已發佈版本段 ⇒ unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-freshness-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    mkdirSync(join(dir, 'collector'), { recursive: true });
    writeFileSync(join(dir, 'collector', 'x.go'), 'package main\n');
    mkdirSync(join(dir, 'docs-site', 'src', 'content', 'docs', 'help'), { recursive: true });
    writeFileSync(join(dir, CHANGELOG_REL), '# Arcrun 桌面版（daemon）版本說明\n\n## 下一版（未發佈）\n\n- 還沒出過任何版本\n');
    commit(dir, '只有草稿，從沒發佈過');
    const r = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /沒有任何已發佈/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 問不出來一律停：changelog 不存在 ⇒ unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-freshness-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'README.md'), 'x\n');
    commit(dir, 'init');
    const r = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /找不到 changelog/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 問不出來一律停：源碼目錄沒被 git 追蹤 ⇒ unknown，不准當成「同步」', () => {
  const { dir } = fakeRepo();
  try {
    const r = checkDaemonFreshness({ repo: dir, changelogRel: CHANGELOG_REL, sourceDirs: ['nonexistent-dir'] });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /沒有被 git 追蹤/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('版本標題比對：只認已發佈段，忽略下一版草稿', () => {
  const text = '## 下一版（未發佈）\n\n- x\n\n## v0.18.27（2026-08-13）\n\n- y\n';
  assert.equal(topReleasedVersion(text), 'v0.18.27');
  assert.equal(hasUnreleasedDraft(text), true);
  assert.equal(hasUnreleasedDraft('## v0.18.27（2026-08-13）\n'), false);
});

test('findVersionAnnounceCommit：找不到就回 null，不是丟例外', () => {
  const { dir } = fakeRepo();
  try {
    assert.equal(findVersionAnnounceCommit(dir, CHANGELOG_REL, 'v9.9.9'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('requireFreshDaemonSource：對不上就丟例外；DAEMON_SOURCE_ALLOW_STALE=1 才放行，且照樣印出差異', () => {
  const { dir } = fakeRepo();
  const prev = process.env.DAEMON_SOURCE_ALLOW_STALE;
  const warned = [];
  const realWarn = console.warn;
  try {
    writeFileSync(join(dir, 'collector', 'cmd', 'arcrun-app', 'main.go'), 'package main\n// 改過\n');
    commit(dir, 'feat(collector): 沒戳版就改');
    const args = { repo: dir, changelogRel: CHANGELOG_REL };

    delete process.env.DAEMON_SOURCE_ALLOW_STALE;
    assert.throws(() => requireFreshDaemonSource(args), /v0\.18\.27/);

    process.env.DAEMON_SOURCE_ALLOW_STALE = '1';
    console.warn = (...a) => warned.push(a.join(' '));
    const r = requireFreshDaemonSource(args);
    assert.equal(r.status, 'stale', '放行不等於變綠——結果照樣是「對不上」');
    assert.match(warned.join('\n'), /v0\.18\.27/, '明知故犯也要看得見少了哪一步');
  } finally {
    console.warn = realWarn;
    if (prev === undefined) delete process.env.DAEMON_SOURCE_ALLOW_STALE; else process.env.DAEMON_SOURCE_ALLOW_STALE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
