/**
 * daemon-freshness.test.mjs — 這道閘的單獨演練。
 *
 * 跑法：node --test installer/scripts/daemon-freshness.test.mjs
 *
 * 🔴 **兩個方向都要驗**（inkstone/arcrun-rag#88 明文）：
 *   ① 它**不再擋自己**——「宣告新版本」這個動作本身（改 collector/CHANGELOG.md）
 *     不可以害它判 stale。這是 2026-08-18 那個死結的形狀。
 *   ② 它**仍然擋得住原本要擋的**——戳了版卻沒重打包（源碼在打包後又動過）照樣停。
 *
 * 判決是純函式（`judgeSourceState`），所以上面兩個方向都能用「量到的事實」直接餵進去，
 * 不必造一個假的 git repo 去模擬歷史——而**不必模擬歷史，正是這輪改動的重點**：
 * 舊版靠 `git log` 當代理，才會被「宣告本身也算改動」這件事反咬。
 *
 * 另外用一個真的暫存 repo 端到端跑一次 `readSourceState`（呼叫真正的 daemon-version.py），
 * 證明「出貨線 ↔ 源碼樹」這條路真的接得起來、而且是**唯讀**的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSourceState, judgeSourceState, formatDaemonFreshnessProblem,
  appendGateLog, localStamp, requireFreshDaemonSource,
  SOURCE_STATE_SCRIPT_REL, GATE_LOG_REL,
} from './daemon-freshness.mjs';

const CHANGELOG_REL = join('collector', 'CHANGELOG.md');
const HERE = import.meta.dirname;
const REAL_REPO = join(HERE, '..', '..');

/** 一份「量到的事實」——預設是健康的那種，測試各自改一兩個欄位。 */
function fact(repo, over = {}) {
  return {
    algo: 4,
    collector_dir: join(repo, 'collector'),
    changelog: join(repo, CHANGELOG_REL),
    version: '0.18.30',
    has_unreleased: false,
    current_fingerprint: 'aaaaaaaaaaaaaaaa',
    ledger_algo: 4,
    recorded_fingerprint: 'aaaaaaaaaaaaaaaa',
    file_count: 228,
    files_ledger_version: '0.18.30',
    files_ledger_algo: 4,
    comparable_per_file: true,
    changed: [], added: [], removed: [],
    artifacts: ['Arcrun-0.18.30.dmg', 'Arcrun-win-0.18.30.exe'],
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 方向①：不准擋自己
// ═══════════════════════════════════════════════════════════════════════════

test('①「宣告新版本」之後立刻問 ⇒ 放行（指紋在戳版當下就把改過的 changelog 算進去了）', () => {
  const repo = '/fake/repo';
  // 這正是死結的形狀：戳版動作改的是 collector/CHANGELOG.md，而 changelog 就住在
  // 被監看的那棵樹底下。指紋是**戳版當下**記的 ⇒ 兩邊必然相等。
  const r = judgeSourceState({ repo, state: fact(repo), changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'ok', JSON.stringify(r, null, 2));
  assert.equal(r.version, '0.18.30');
  assert.equal(r.changed.length + r.added.length + r.removed.length, 0);
});

test('①-b 只改宣告、程式一行都沒動的 commit ⇒ 仍然放行（舊版就是被這種 commit 反咬的）', () => {
  const repo = '/fake/repo';
  // 舊判法：`git log <宣告那顆>..HEAD -- collector` 只要有東西就 stale
  // ⇒ 一顆只動 collector/CHANGELOG.md 的 commit（dcd0132 就是）也會被算進去。
  // 新判法看的是內容指紋，而那顆 commit 的內容早已包含在戳版當下的指紋裡。
  const r = judgeSourceState({ repo, state: fact(repo, { has_unreleased: false }), changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'ok');
});

test('① 有「下一版（未發佈）」草稿也照樣放行——草稿不影響「這一版配不配得上源碼」', () => {
  const repo = '/fake/repo';
  // 草稿本身會改到 changelog ⇒ 指紋會變 ⇒ 這一版就會被判 stale。這是對的：
  // 寫了草稿代表源碼真的動了。這裡測的是「草稿存在但指紋沒變」（例如草稿寫在戳版前）。
  const r = judgeSourceState({ repo, state: fact(repo, { has_unreleased: true }), changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'ok');
  assert.equal(r.hasDraft, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 方向②：原本要擋的一個都不准放過
// ═══════════════════════════════════════════════════════════════════════════

test('②「戳了版卻沒重打包」照樣擋——而且指名是哪幾個檔（2026-08-15 那天的形狀）', () => {
  const repo = '/fake/repo';
  const r = judgeSourceState({
    repo,
    state: fact(repo, {
      current_fingerprint: 'bbbbbbbbbbbbbbbb',
      changed: ['cmd/arcrun-app/main.go', 'cmd/arcrun-app/supervise.go'],
      added: ['cmd/arcrun-app/wiki.go'],
      removed: ['cmd/arcrun-app/dead.go'],
    }),
    changelogRel: CHANGELOG_REL,
  });
  assert.equal(r.status, 'stale');
  const msg = formatDaemonFreshnessProblem({ repo, result: r });
  assert.match(msg, /0\.18\.30/);
  assert.match(msg, /main\.go/);
  assert.match(msg, /wiki\.go/);
  assert.match(msg, /dead\.go/);
  assert.match(msg, /不會自動幫你戳版／打包/, '紅線：不准自動打包就放行');
});

test('② 指紋不同、但逐檔帳本停在別版 ⇒ 照樣擋，且誠實說「講不出是哪幾個檔」', () => {
  const repo = '/fake/repo';
  const r = judgeSourceState({
    repo,
    state: fact(repo, {
      current_fingerprint: 'bbbbbbbbbbbbbbbb',
      files_ledger_version: '0.18.29', comparable_per_file: false,
    }),
    changelogRel: CHANGELOG_REL,
  });
  assert.equal(r.status, 'stale');
  const msg = formatDaemonFreshnessProblem({ repo, result: r });
  assert.match(msg, /講不出是哪幾個檔/, '說不出來就要說「說不出來」，不准含糊放行');
});

// ═══════════════════════════════════════════════════════════════════════════
// 問不出來一律停
// ═══════════════════════════════════════════════════════════════════════════

test('🔴 拿不到事實 ⇒ unknown（不是放行）', () => {
  const r = judgeSourceState({ repo: '/fake/repo', state: null, changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'unknown');
});

test('🔴 changelog 沒有任何已發佈版本段 ⇒ unknown', () => {
  const repo = '/fake/repo';
  const r = judgeSourceState({ repo, state: fact(repo, { version: null }), changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /沒有任何已發佈/);
});

test('🔴 指紋帳本是舊演算法記的 ⇒ unknown（不同單位量出來的數字不准拿來比）', () => {
  const repo = '/fake/repo';
  const r = judgeSourceState({ repo, state: fact(repo, { ledger_algo: 3, recorded_fingerprint: null }), changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /演算法/);
});

test('🔴 帳本沒有這一版的紀錄 ⇒ unknown（沒走過打包路徑，無從證明）', () => {
  const repo = '/fake/repo';
  const r = judgeSourceState({ repo, state: fact(repo, { recorded_fingerprint: null }), changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /沒有 0\.18\.30 這一版的紀錄/);
});

test('🔴 算不出現在的指紋（collector/ 不在 git 裡）⇒ unknown', () => {
  const repo = '/fake/repo';
  const r = judgeSourceState({ repo, state: fact(repo, { current_fingerprint: null }), changelogRel: CHANGELOG_REL });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /算不出/);
});

test('🔴 出貨線與源碼樹對「changelog 住哪」有分歧 ⇒ unknown（D95 第二輪那個病的機械閘）', () => {
  const repo = '/fake/repo';
  const r = judgeSourceState({
    repo,
    state: fact(repo, { changelog: '/fake/repo/docs-site/src/content/docs/help/changelog.md' }),
    changelogRel: CHANGELOG_REL,
  });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /分歧/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 留痕（InkStoneCo#48）＋逃生門
// ═══════════════════════════════════════════════════════════════════════════

test('🔴 擋下與放行**都**要留痕，而且逃生門放行要標成「明知故犯」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-log-'));
  try {
    const logPath = join(dir, 'gate-log.md');
    const repo = '/fake/repo';
    const ok = judgeSourceState({ repo, state: fact(repo), changelogRel: CHANGELOG_REL });
    const bad = judgeSourceState({
      repo, state: fact(repo, { current_fingerprint: 'bbbbbbbbbbbbbbbb', changed: ['cmd/x.go'] }), changelogRel: CHANGELOG_REL,
    });
    appendGateLog(logPath, { ts: localStamp(new Date(2026, 7, 18, 16, 5)), targetName: 'stage', result: ok });
    appendGateLog(logPath, { ts: localStamp(new Date(2026, 7, 18, 16, 6)), targetName: 'stage', result: bad });
    appendGateLog(logPath, { ts: localStamp(new Date(2026, 7, 18, 16, 7)), targetName: 'selftest', result: bad, allowed: true });

    const text = readFileSync(logPath, 'utf8');
    assert.match(text, /\| 時間 \| 目標 \| 版本 \|/, '第一次寫要自帶表頭');
    assert.match(text, /2026-08-18 16:05 \| stage \| 0\.18\.30 \|.*✅ 放行/);
    assert.match(text, /2026-08-18 16:06 \| stage \|.*⛔ 擋下.*1 個檔/);
    assert.match(text, /2026-08-18 16:07 \| selftest \|.*⚠️ 明知故犯放行/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 端到端：真的去呼叫源碼樹那支腳本（**唯讀**）
// ═══════════════════════════════════════════════════════════════════════════

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** 造一個「只有 collector/ 那一半」的臨時 repo，裝上真正的 daemon-version.py。 */
function fakeCollectorRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-e2e-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const appDir = join(dir, 'collector', 'cmd', 'arcrun-app');
  mkdirSync(appDir, { recursive: true });
  cpSync(join(REAL_REPO, SOURCE_STATE_SCRIPT_REL), join(appDir, 'daemon-version.py'));
  writeFileSync(join(appDir, 'main.go'), 'package main\n');
  writeFileSync(join(dir, 'collector', 'DAEMON_LINE'), '0.18\n');
  // 一段已發佈（產生器要有東西可以往上加）＋一段待發佈草稿（＝「要出新版」的訊號）。
  writeFileSync(join(dir, CHANGELOG_REL),
    '# Arcrun 桌面版（daemon）版本說明\n\n## 下一版（未發佈）\n\n- 這一版改了什麼\n\n## v0.17.9（2026-01-01）\n\n- 上一版\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  return dir;
}

test('端到端：戳版 → 閘放行；改一行 code → 閘擋下並指名那個檔', () => {
  const dir = fakeCollectorRepo();
  try {
    const appDir = join(dir, 'collector', 'cmd', 'arcrun-app');
    // 戳版（＝打包路徑會做的事）。這一步會改 changelog，也會寫兩本帳。
    const stamped = execFileSync('python3', [join(appDir, 'daemon-version.py'), '--stamp'],
      { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    assert.equal(stamped, '0.18.0',
      '換線第一版從 .0 起算，且**是裸號**（leo 2026-08-17「對外號就是三個數字」，#88 第二輪落到產生端）');
    assert.ok(existsSync(join(appDir, '.version-source-files.json')), '逐檔帳本要被寫出來');

    // 唯讀確認的取樣點：問之前先把兩本帳原封不動記下來。
    const ledgersBefore = ['.version-source.json', '.version-source-files.json']
      .map((f) => readFileSync(join(appDir, f), 'utf8'));

    // 🔴 方向①：戳完版**立刻**問，而且刻意不 commit ——舊版在這裡會判 dirty／unknown 而擋自己。
    const a = readSourceState({ repo: dir });
    assert.equal(a.ok, true, JSON.stringify(a));
    const ra = judgeSourceState({ repo: dir, state: a.state, changelogRel: CHANGELOG_REL });
    assert.equal(ra.status, 'ok', JSON.stringify(ra, null, 2));
    assert.equal(ra.version, '0.18.0');

    // 🔴 方向②：改一行 code（沒重打包）⇒ 一定要擋，而且講得出是哪個檔。
    writeFileSync(join(appDir, 'main.go'), 'package main\n// 戳完版之後才改的\n');
    const b = readSourceState({ repo: dir });
    const rb = judgeSourceState({ repo: dir, state: b.state, changelogRel: CHANGELOG_REL });
    assert.equal(rb.status, 'stale', JSON.stringify(rb, null, 2));
    assert.deepEqual(rb.changed, ['cmd/arcrun-app/main.go']);

    // 🔴 唯讀確認：問了兩次 `--source-state` 之後，兩本帳**一個位元都沒被動過**。
    //   （閘一定會在「會 push、會部署」的管線裡跑，它不可以順手改任何東西。）
    const ledgersAfter = ['.version-source.json', '.version-source-files.json']
      .map((f) => readFileSync(join(appDir, f), 'utf8'));
    assert.deepEqual(ledgersAfter, ledgersBefore, '--source-state 是唯讀的，不准寫帳本');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端：requireFreshDaemonSource 對不上就丟例外；DAEMON_SOURCE_ALLOW_STALE=1 放行但照樣留痕', () => {
  const dir = fakeCollectorRepo();
  const prev = process.env.DAEMON_SOURCE_ALLOW_STALE;
  const realWarn = console.warn;
  const warned = [];
  try {
    const appDir = join(dir, 'collector', 'cmd', 'arcrun-app');
    execFileSync('python3', [join(appDir, 'daemon-version.py'), '--stamp'],
      { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    writeFileSync(join(appDir, 'main.go'), 'package main\n// 沒重打包\n');
    const args = { repo: dir, changelogRel: CHANGELOG_REL, targetName: 'stage' };

    delete process.env.DAEMON_SOURCE_ALLOW_STALE;
    assert.throws(() => requireFreshDaemonSource(args), /(?<!v)0\.18\.0/);

    process.env.DAEMON_SOURCE_ALLOW_STALE = '1';
    console.warn = (...a) => warned.push(a.join(' '));
    const r = requireFreshDaemonSource(args);
    assert.equal(r.status, 'stale', '放行不等於變綠——判決照樣是「對不上」');
    assert.match(warned.join('\n'), /main\.go/, '明知故犯也要看得見差在哪');

    const log = readFileSync(join(dir, GATE_LOG_REL), 'utf8');
    assert.match(log, /⛔ 擋下/, '擋下的那次要留痕');
    assert.match(log, /⚠️ 明知故犯放行/, '放行的那次也要留痕');
  } finally {
    console.warn = realWarn;
    if (prev === undefined) delete process.env.DAEMON_SOURCE_ALLOW_STALE; else process.env.DAEMON_SOURCE_ALLOW_STALE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 腳本不見 ⇒ readSourceState 回 ok:false，呼叫端判 unknown 而停（不是安靜通過）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-noscript-'));
  try {
    const read = readSourceState({ repo: dir });
    assert.equal(read.ok, false);
    assert.match(read.error, /找不到版本產生器/);
    assert.throws(() => requireFreshDaemonSource({ repo: dir, targetName: 'stage' }), /無法判定|拿不到/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
