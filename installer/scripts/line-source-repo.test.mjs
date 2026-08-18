/**
 * line-source-repo.test.mjs — 演練「每條版本線發到自己的 repo」這件事會不會安靜地失敗。
 *
 * 跑法：node --test installer/scripts/line-source-repo.test.mjs
 *
 * 🔴 本輪要證明的核心是**變異測試**：把新 repo 的位置寫錯（或寫成不存在的），
 *   出貨線必須**當場斷並說清楚**，而不是安靜退回去發到 arcrun-rag。
 *   「安靜地退而求其次」是這個 repo 反覆犯的病——而它每次都是綠的。
 *
 * 該擋：
 *   ① 完全沒宣告 lineRepos            → 丟（不退回 repoSlug）
 *   ② 宣告了但少一條線                → 丟，且訊息指名是哪條
 *   ③ 宣告了 sourceDir 卻缺 remote／workDir → 登錄簿驗證階段就報
 *   ④ 宣告了不存在的版本線（死宣告）   → 報
 *   ⑤ repo 不存在（404）              → repoExists 回 false，呼叫端據此中止
 *   ⑥ 工作區的 origin 跟宣告對不上     → 丟（打錯 repo 的同步比同步失敗更難發現）
 *   ⑦ 同步到 0 個檔案                 → 丟（「檢查了 0 條卻通過」）
 *   ⑩ 目的 repo 忽略的建置產物        → 不搬，且要報出來（43 MB 的化石）
 *   ⑪b destOwned 的檔案不見了         → 停（先前某次同步把閘蓋掉了）
 * 不該擋：
 *   ⑧ 宣告齊全                        → 過
 *   ⑨ 內容沒變                        → 不建 commit、不 push，回現有 HEAD
 *   ⑪ 目的 repo 的門面檔（README／.gitignore）→ 不覆蓋、不刪除
 *   ⑫ 目的 repo 已追蹤的源碼           → 不因忽略規則被誤刪（git 自己的語意）
 *
 * 🔴 ⑩⑪⑫ 是 2026-08-18「第一次真的同步」炸出來的，不是想像的——
 *   實災見 inkstone/arcrun-collector 的 a35421e（產物閘被蓋掉、源碼被誤刪）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  repoForLine, livesInOwnRepo, declarationProblems, syncSourceRepo, repoExists, normRemote, expandHome,
  copyTrackedFiles, destIgnored,
} from './line-source-repo.mjs';

/** 真的跑 git（⑩ 那組要的是真行為，不是假的 runner——漏洞就出在真實的 git 語意上）。 */
const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
import { LINES } from './release-lines.mjs';
import { loadTargets } from './release-line-gate.mjs';

const GOOD = {
  host: 'gitea',
  repoSlug: 'inkstone/arcrun-rag',
  lineRepos: {
    bundle: { repoSlug: 'inkstone/arcrun-rag' },
    daemon: {
      repoSlug: 'inkstone/arcrun-collector',
      sourceDir: 'collector',
      remote: 'https://git.uncle6.me/inkstone/arcrun-collector.git',
      workDir: '~/.arcrun-ship/arcrun-collector',
    },
  },
};

// ── 該擋 ────────────────────────────────────────────────────────────────────

test('① 完全沒宣告 lineRepos ⇒ 丟，而且**不退回 repoSlug**', () => {
  assert.throws(() => repoForLine('daemon', { host: 'gitea', repoSlug: 'inkstone/arcrun-rag' }),
    /lineRepos/);
  // 退回的話這裡會安靜回 inkstone/arcrun-rag ⇒ 桌面小幫手又被疊進雲端的歷史，而且全綠。
});

test('② 宣告了但少一條線 ⇒ 丟，訊息指名是哪一條', () => {
  const half = { host: 'gitea', repoSlug: 'inkstone/arcrun-rag', lineRepos: { bundle: { repoSlug: 'inkstone/arcrun-rag' } } };
  assert.throws(() => repoForLine('daemon', half), /daemon/);
  const problems = declarationProblems(LINES, half);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /daemon/);
});

test('③ 宣告了 sourceDir 卻缺 remote／workDir ⇒ 登錄簿驗證階段就報（不等到第 21 站）', () => {
  const broken = JSON.parse(JSON.stringify(GOOD));
  delete broken.lineRepos.daemon.remote;
  delete broken.lineRepos.daemon.workDir;
  const problems = declarationProblems(LINES, broken);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /remote/);
  assert.match(problems.join('\n'), /workDir/);
});

test('④ 宣告了不存在的版本線（死宣告）⇒ 報', () => {
  const extra = JSON.parse(JSON.stringify(GOOD));
  extra.lineRepos.mcp = { repoSlug: 'inkstone/whatever' };
  assert.match(declarationProblems(LINES, extra).join('\n'), /不存在的版本線：mcp/);
});

test('⑤ 【變異測試】repo 不存在 ⇒ repoExists 回 false（呼叫端據此在 preflight 中止）', async () => {
  const fake404 = async () => ({ status: 404, ok: false });
  assert.equal(await repoExists('gitea', 'inkstone/typo-collector', { fetchImpl: fake404 }), false);
  assert.equal(await repoExists('github', 'youlinhsieh/typo-collector', { fetchImpl: fake404 }), false);
});

test('⑤b 查詢本身失敗（500）⇒ 丟，不當成「不存在」也不當成「存在」', async () => {
  const fake500 = async () => ({ status: 500, ok: false });
  await assert.rejects(() => repoExists('gitea', 'inkstone/x', { fetchImpl: fake500 }), /HTTP 500/);
});

test('⑤c 不認得的 host ⇒ 丟（不猜）', async () => {
  await assert.rejects(() => repoExists('gitlab', 'a/b', { fetchImpl: async () => ({ ok: true }) }), /不認得的 host/);
});

test('⑥ 工作區的 origin 跟宣告對不上 ⇒ 丟（打錯 repo 的同步比同步失敗更難發現）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    mkdirSync(join(dir, 'work', '.git'), { recursive: true });
    const runner = (args) => {
      if (args[0] === 'remote') return { status: 0, out: 'https://git.uncle6.me/inkstone/SOMETHING-ELSE.git' };
      return { status: 0, out: '' };
    };
    assert.throws(() => syncSourceRepo({
      srcRoot: dir, sourceDir: 'collector', workDir: join(dir, 'work'),
      remoteUrl: 'https://git.uncle6.me/inkstone/arcrun-collector.git', message: 'x', runner,
    }), /origin 是/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⑦ 同步到 0 個檔案 ⇒ 丟（「檢查了 0 條卻通過」是假綠的經典形狀）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    mkdirSync(join(dir, 'work', '.git'), { recursive: true });
    const runner = (args) => {
      if (args[0] === 'remote') return { status: 0, out: 'https://git.uncle6.me/inkstone/arcrun-collector.git' };
      return { status: 0, out: '' };
    };
    assert.throws(() => syncSourceRepo({
      srcRoot: dir, sourceDir: 'collector', workDir: join(dir, 'work'),
      remoteUrl: 'https://git.uncle6.me/inkstone/arcrun-collector.git', message: 'x',
      runner, copyTracked: () => ({ copied: 0, skipped: [] }),
    }), /一個檔案都沒有/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 不該擋 ──────────────────────────────────────────────────────────────────

test('⑧ 宣告齊全 ⇒ 過，且 repoForLine 拿得到各自的 repo', () => {
  assert.deepEqual(declarationProblems(LINES, GOOD), []);
  assert.equal(repoForLine('bundle', GOOD).repoSlug, 'inkstone/arcrun-rag');
  assert.equal(repoForLine('daemon', GOOD).repoSlug, 'inkstone/arcrun-collector');
  assert.equal(livesInOwnRepo(repoForLine('bundle', GOOD)), false);
  assert.equal(livesInOwnRepo(repoForLine('daemon', GOOD)), true);
});

test('⑨ 內容沒變 ⇒ 不建 commit、不 push（同一版重跑不該在對方 repo 疊空 commit）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    mkdirSync(join(dir, 'work', '.git'), { recursive: true });
    const calls = [];
    const runner = (args) => {
      calls.push(args[0]);
      if (args[0] === 'remote') return { status: 0, out: 'https://git.uncle6.me/inkstone/arcrun-collector.git' };
      if (args[0] === 'status') return { status: 0, out: '' };          // 乾淨
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 0, out: 'abc' };
      if (args[0] === 'rev-parse') return { status: 0, out: 'deadbeefdeadbeef' };
      return { status: 0, out: '' };
    };
    const r = syncSourceRepo({
      srcRoot: dir, sourceDir: 'collector', workDir: join(dir, 'work'),
      remoteUrl: 'https://git.uncle6.me/inkstone/arcrun-collector.git', message: 'x',
      runner, copyTracked: () => ({ copied: 228, skipped: [] }),
    });
    assert.equal(r.changed, false);
    assert.equal(r.sha, 'deadbeefdeadbeef');
    assert.equal(r.files, 228);
    assert.ok(!calls.includes('commit'), '沒變更就不該 commit');
    assert.ok(!calls.includes('push'), '沒變更就不該 push');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⑨b 有變更 ⇒ commit ＋ push，回新的 sha', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    mkdirSync(join(dir, 'work', '.git'), { recursive: true });
    const calls = [];
    const runner = (args) => {
      calls.push(args[0]);
      if (args[0] === 'remote') return { status: 0, out: 'https://git.uncle6.me/inkstone/arcrun-collector.git' };
      if (args[0] === 'status') return { status: 0, out: ' M a.go' };   // 有變更
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 0, out: 'abc' };
      if (args[0] === 'rev-parse') return { status: 0, out: 'cafebabecafebabe' };
      return { status: 0, out: '' };
    };
    const r = syncSourceRepo({
      srcRoot: dir, sourceDir: 'collector', workDir: join(dir, 'work'),
      remoteUrl: 'https://git.uncle6.me/inkstone/arcrun-collector.git', message: 'sync: x',
      runner, copyTracked: () => ({ copied: 228, skipped: [] }),
    });
    assert.equal(r.changed, true);
    assert.equal(r.sha, 'cafebabecafebabe');
    assert.ok(calls.includes('commit'));
    assert.ok(calls.includes('push'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 建置產物不准跟著搬過去（2026-08-18 實測補上）────────────────────────────
//
// 🔴 這一組是**實測發現的漏洞**，不是假想：`collector/` 版控裡躺著 4 個建置產物
//   （`arcrun-app` 20.9 MB／`Arcrun-v0.18.3.dmg` 11.9 MB／`collector` 8.4 MB／
//   `MicrosoftEdgeWebview2Setup.exe` 1.8 MB，共 43 MB），而 `inkstone/arcrun-collector`
//   建立時正是把它們排除掉的（實測 232 vs 228 個檔）。
//   「只搬版控裡有的」這一條判準**擋不住它們**——它們就在版控裡。

test('⑩ 目的 repo 自己的 .gitignore 擋掉的檔案 ⇒ 不搬，而且**要報出來**', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(join(src, 'collector', 'cmd'), { recursive: true });
    mkdirSync(dest, { recursive: true });

    // 來源：一個真的 git repo，版控裡同時有源碼與一個建置產物（＝現實的形狀）
    run(['init', '-q'], src);
    run(['config', 'user.email', 't@t'], src);
    run(['config', 'user.name', 't'], src);
    writeFileSync(join(src, 'collector', 'main.go'), 'package main\n');
    writeFileSync(join(src, 'collector', 'cmd', 'arcrun-app'), 'BINARY');
    writeFileSync(join(src, 'collector', '.gitignore'), 'cmd/arcrun-app\n');
    run(['add', '-A', '-f'], src);          // -f：連被自己忽略的產物也追蹤（＝arcrun-rag 的現況）
    run(['commit', '-qm', 'init'], src);

    // 目的地：它自己宣告 `cmd/arcrun-app` 是建置產物
    run(['init', '-q'], dest);
    run(['config', 'user.email', 't@t'], dest);
    run(['config', 'user.name', 't'], dest);
    writeFileSync(join(dest, '.gitignore'), 'cmd/arcrun-app\n');

    const { copied, skipped } = copyTrackedFiles({ srcRoot: src, sourceDir: 'collector', destDir: dest });

    assert.deepEqual(skipped, ['cmd/arcrun-app'], '被目的 repo 忽略的產物要出現在 skipped 裡，不能安靜消失');
    assert.equal(copied, 2, 'main.go 與 .gitignore 兩個該搬');
    assert.equal(existsSync(join(dest, 'main.go')), true);
    assert.equal(existsSync(join(dest, 'cmd', 'arcrun-app')), false,
      '🔴 43 MB 的建置產物不該被寫進工作區——不是靠 git add 碰巧漏掉，是根本沒搬');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 🔴 這兩題是 2026-08-18「第一次真的同步」炸出來的，不是想像的 ──────────────
//   實際災情（inkstone/arcrun-collector 的 a35421e）：
//     .gitignore            21 行的產物閘 → 被 arcrun-rag 那份一行的蓋掉（**閘自己被拆了**）
//     README.md             介紹獨立 repo 的 → 被子目錄的 README 蓋掉
//     cmd/collector/main.go 正常源碼 → 被當成建置產物刪掉

test('⑪ destOwned：目的 repo 的門面檔不覆蓋、也不刪除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(join(src, 'collector'), { recursive: true });
    mkdirSync(dest, { recursive: true });

    run(['init', '-q'], src);
    run(['config', 'user.email', 't@t'], src);
    run(['config', 'user.name', 't'], src);
    writeFileSync(join(src, 'collector', 'main.go'), 'package main\n');
    writeFileSync(join(src, 'collector', '.gitignore'), 'node_modules/\n');   // ← 一行版（子目錄的）
    writeFileSync(join(src, 'collector', 'README.md'), '子目錄的 README\n');
    run(['add', '-A'], src);
    run(['commit', '-qm', 'init'], src);

    run(['init', '-q'], dest);
    run(['config', 'user.email', 't@t'], dest);
    run(['config', 'user.name', 't'], dest);
    writeFileSync(join(dest, '.gitignore'), 'node_modules/\nbuild-artifact\n');  // ← 目的 repo 的閘
    writeFileSync(join(dest, 'README.md'), '這個獨立 repo 的 README\n');
    run(['add', '-A'], dest);
    run(['commit', '-qm', 'seed'], dest);

    const r = copyTrackedFiles({
      srcRoot: src, sourceDir: 'collector', destDir: dest, destOwned: ['README.md', '.gitignore'],
    });

    assert.equal(readFileSync(join(dest, '.gitignore'), 'utf8'), 'node_modules/\nbuild-artifact\n',
      '🔴 產物閘不准被子目錄那份一行的蓋掉——蓋掉之後下一趟就會把 43 MB 搬進來');
    assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), '這個獨立 repo 的 README\n');
    assert.equal(readFileSync(join(dest, 'main.go'), 'utf8'), 'package main\n', '源碼照樣要同步');
    assert.deepEqual(r.kept.sort(), ['.gitignore', 'README.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⑪b destOwned 的檔案不見了 ⇒ 當場停（先前某次同步把閘蓋掉了）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    mkdirSync(join(dir, 'work', '.git'), { recursive: true });
    const runner = (args) => {
      if (args[0] === 'remote') return { status: 0, out: 'https://git.uncle6.me/inkstone/arcrun-collector.git' };
      return { status: 0, out: '' };
    };
    assert.throws(() => syncSourceRepo({
      srcRoot: dir, sourceDir: 'collector', workDir: join(dir, 'work'),
      remoteUrl: 'https://git.uncle6.me/inkstone/arcrun-collector.git', message: 'x',
      destOwned: ['.gitignore'], runner,
    }), /少了它自己的/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⑫ 目的 repo 已經追蹤的檔案，不因忽略規則被誤刪（git 自己的語意）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    run(['init', '-q'], dir);
    run(['config', 'user.email', 't@t'], dir);
    run(['config', 'user.name', 't'], dir);
    // 真實情況：`collector` 這行是指根目錄那顆執行檔，
    // 但無斜線樣式在任何層級都命中 ⇒ 也命中 cmd/collector/main.go
    writeFileSync(join(dir, '.gitignore'), 'collector\n');
    mkdirSync(join(dir, 'cmd', 'collector'), { recursive: true });
    writeFileSync(join(dir, 'cmd', 'collector', 'main.go'), 'package main\n');
    run(['add', '-A', '-f'], dir);
    run(['commit', '-qm', 'seed'], dir);

    const tracked = ['cmd/collector/main.go', '.gitignore'];
    const ig = destIgnored(['cmd/collector/main.go', 'collector'], dir, tracked);
    assert.deepEqual(ig, ['collector'],
      '🔴 已追蹤的 cmd/collector/main.go 不算被忽略；沒追蹤的 collector（執行檔）才算');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⑩b destIgnored：一個都沒命中不是錯誤（check-ignore 的 exit 1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsr-'));
  try {
    run(['init', '-q'], dir);
    assert.deepEqual(destIgnored(['a.go', 'b/c.go'], dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 小工具 ──────────────────────────────────────────────────────────────────

test('normRemote：只比「這是哪個 repo」（協定／帳密／.git 都不算）', () => {
  assert.equal(
    normRemote('https://Leo:tok@git.uncle6.me/inkstone/arcrun-collector.git'),
    normRemote('https://git.uncle6.me/inkstone/arcrun-collector'));
  assert.notEqual(
    normRemote('https://git.uncle6.me/inkstone/arcrun-collector'),
    normRemote('https://git.uncle6.me/inkstone/arcrun-rag'));
});

test('expandHome：不准寫死 /Users/<誰>/（installer/ 會被推上公開鏡像）', () => {
  const home = process.env.HOME || '';
  assert.equal(expandHome('~/.arcrun-ship/x'), join(home, '.arcrun-ship/x'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
});

// ── 真的登錄簿 ──────────────────────────────────────────────────────────────

test('真的 ship.targets.json：有 releaseRecord 的目標，宣告全部齊全', () => {
  const cfg = loadTargets();
  for (const [name, t] of Object.entries(cfg.targets)) {
    if (!t.releaseRecord) continue;
    assert.deepEqual(declarationProblems(LINES, t.releaseRecord), [], `${name} 的 lineRepos 宣告不完整`);
  }
});
