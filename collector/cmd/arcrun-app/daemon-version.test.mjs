/**
 * daemon-version.test.mjs — 證明**產生端**吐的是裸號（inkstone/arcrun-rag#88）
 *
 * leo 2026-08-17：「對外號就是三個數字，不要 v」。隔天他問「剛剛不是說不要 v？」，
 * 因為 `install.arcrun.dev/api/latest` 照舊回 `daemon.version = "v0.18.28"`。
 * 那個 `v` 的產地就是本目錄的 `daemon-version.py`。
 *
 * ── 這支測試的來歷：它曾經釘的是「還沒做到」──────────────────────────────
 * 2026-08-18 第一次改裸號當場翻車：**那個 `v` 身兼「哪一條版本線」的判別器**，
 * 出貨線那幾道閘靠它認出「這份 changelog 是不是 daemon 的」。一改裸號它們
 * **不報錯**，而是往下比對到更舊的 `## v0.18.29（…）`
 * ⇒ 打包出 0.18.30 的執行檔、manifest 卻宣稱是 v0.18.29。靜默，21 站全綠。
 * 於是當時把 ①②③ 的期望值釘成「仍吐 v」，並把「為什麼還不能改」寫成兩支會說話的測試。
 *
 * 第二輪（本次）先換掉判別的承載——改用 `collector/DAEMON_LINE` 宣告的那條線
 * （`daemon-notes.mjs` 的 `daemonReleasedRe`）——**判別器換好之後，`v` 才拿得掉**。
 * ⇒ ①②③ 現在釘的是裸號（驗收）；⑤⑥⑦⑧ 從「為什麼還不能改」改寫成
 *   **「拿掉 v 之後，判別還成不成立」的閘**，每一支都附一組**反向對照**：
 *   同一份輸入餵給舊的嚴格判斷式會靜默讀到**更舊的一版**——
 *   那幾行證明這支測試真的在鑑別，不是把實作抄一遍的回音
 *   （`system-dev/wiki/mistakes.md`：「測試複製了實作邏輯就不再是閘，是回音」）。
 *
 * 為什麼住在 `collector/` 而不是 `installer/scripts/`：
 * 被測的 `daemon-version.py` 是 collector 自己的版本產生器（D95 第一輪把它的三個輸入
 * 全搬進 collector/，就是為了讓 collector/ 搬得成獨立 repo）。測試跟著被測物走，
 * 拆 repo 時不會留下一支指向別人家的孤兒測試。
 *
 * 跑法：node --test collector/cmd/arcrun-app/daemon-version.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'daemon-version.py');

/**
 * 造一個**只有版本產生器需要的三樣東西**的假 collector 樹，然後真的跑那支腳本。
 * 刻意不是 git repo：`source_fingerprint()` 的 `git ls-files` 會失敗 → 回空字串 → 指紋閘不參與，
 * 這裡要量的是「版本號長什麼樣」，不是指紋機制（它有自己的病史，不要攪在一起）。
 */
function runProducer({ changelog, line = '0.18', stamp = false }) {
  const root = mkdtempSync(join(tmpdir(), 'daemon-version-'));
  const appDir = join(root, 'cmd', 'arcrun-app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  writeFileSync(join(root, 'DAEMON_LINE'), `${line}\n`);
  copyFileSync(SCRIPT, join(appDir, 'daemon-version.py'));
  try {
    const stdout = execFileSync('python3', [
      join(appDir, 'daemon-version.py'), ...(stamp ? ['--stamp'] : []),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { version: stdout.trim(), changelogAfter: readFileSync(join(root, 'CHANGELOG.md'), 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const UNRELEASED = '## 下一版（未發佈）\n\n- 修了一件事\n\n';
const OLD_V = '## v0.18.28（2026-08-16）\n\n- 舊的那一版\n';

test('① 升版：吐**裸號**（leo 2026-08-17「對外號就是三個數字，不要 v」）', () => {
  const { version } = runProducer({ changelog: UNRELEASED + OLD_V });
  assert.equal(version, '0.18.29');
});

test('② 升版並戳章：寫進 changelog 的標題也是裸號（兩邊一致，不會自我矛盾）', () => {
  const { version, changelogAfter } = runProducer({ changelog: UNRELEASED + OLD_V, stamp: true });
  assert.equal(version, '0.18.29');
  assert.match(changelogAfter, /^## 0\.18\.29（\d{4}-\d{2}-\d{2}）$/m);
});

test('③ 換版本線：新線第一版（同樣是裸號）', () => {
  const { version } = runProducer({ changelog: UNRELEASED + OLD_V, line: '0.19' });
  assert.equal(version, '0.19.0');
});

test('④ 重打同一版：冪等，不虛增，而且**沿用那一版當初的寫法**', () => {
  // 🔴 舊版一輩子維持 `v0.18.28`。這不是漏改：`selfupdate.go` 的 newerThanCurrent()
  //   用「字串不等於」判斷有沒有新版 ⇒ 重打時改寫法，每一台已安裝的機器都會看到一個
  //   內容一模一樣、卻宣稱是新版的**假更新**。
  assert.equal(runProducer({ changelog: OLD_V }).version, 'v0.18.28');
  // 而已經是裸號的那一版，重打也維持裸號（同一條規則，不必記例外）。
  assert.equal(runProducer({ changelog: '## 0.18.30（2026-08-18）\n\n- 裸號那一版\n' }).version, '0.18.30');
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 判別器：拿掉 `v` 之後，「這段 changelog 是誰的」靠什麼分辨
//
// 這一組就是本輪的核心。第一次改裸號會翻車，正是因為判別的承載是「有沒有 v」；
// 現在承載換成 `DAEMON_LINE` 宣告的那條線。下面每一支都附**反向對照**：
// 同一份輸入餵給舊做法會發生什麼——沒有那一半，這些測試就只是把實作抄一遍。
// ═══════════════════════════════════════════════════════════════════════════

const CLOUD = '## 1.4.47（2026-08-15）\n\n- 雲端那條線\n';
/** 舊的判別式（釘死 v）。只在測試裡出現，用來證明「新的真的比較強」。 */
const OLD_STRICT = /^## (v\d+\.\d+\.\d+)（/m;

test('⑤ 🔴 故意製造判別錯誤：產生端吐裸號時，舊判別式會**靜默讀到更舊的一版**', async () => {
  const { daemonReleasedRe } = await import('./daemon-notes.mjs');
  // 真的跑一次產生端，拿它戳出來的 changelog（不是手捏一份「像那樣」的字串）。
  const { version, changelogAfter } = runProducer({ changelog: UNRELEASED + OLD_V, stamp: true });
  assert.equal(version, '0.18.29', '前提：產生端吐裸號');

  // ── 反向對照：舊做法在這份輸入上做了什麼 ──
  const stale = changelogAfter.match(OLD_STRICT);
  assert.equal(stale[1], 'v0.18.28',
    '舊判別式不報錯，而是往下比對到**更舊的一版** ⇒ 打包出 0.18.29、manifest 卻宣稱 v0.18.28');
  assert.notEqual(stale[1], version, '⇒ 這就是「版本號說謊」，而且靜默：全站會亮綠');

  // ── 新做法：讀回來的就是剛剛戳出去的那一版 ──
  assert.equal(changelogAfter.match(daemonReleasedRe('0.18'))[1], version);
});

test('⑥ 🔴 新判別器認得兩種寫法，但**認不出別條線**（一鬆一緊，兩邊都要）', async () => {
  const { daemonReleasedRe } = await import('./daemon-notes.mjs');
  const re = () => daemonReleasedRe('0.18');

  // 鬆：過渡期兩種寫法並存（leo：既有 tag／檔名不回頭改）⇒ 都算數
  assert.equal('## 0.18.31（2026-08-19）'.match(re())[1], '0.18.31');
  assert.equal('## v0.18.30（2026-08-18）'.match(re())[1], 'v0.18.30');

  // 緊：雲端那條線進不來——**這是第一輪把判別式放寬成 `v?` 時炸掉的那一項**
  assert.equal(CLOUD.match(re()), null, '雲端 1.4.47 不在 0.18 這條線上');
  assert.equal(CLOUD.match(/^## (v?\d+\.\d+\.\d+)（/m)[1], '1.4.47',
    '反向對照：單純放寬成 v? 會把雲端版號當成 daemon 的撈走');

  // 緊：草稿不算（只認已發佈段）
  assert.equal('## 下一版（未發佈）'.match(re()), null);

  // 緊：換線之後，舊線的版本段**不再算數**——這是舊做法（只看 v）做不到的一格
  assert.equal('## v0.18.30（2026-08-18）'.match(daemonReleasedRe('0.19')), null);
  assert.equal('## v0.18.30（2026-08-18）'.match(OLD_STRICT)[1], 'v0.18.30',
    '反向對照：舊做法照樣把 0.18 的版本當成「daemon 的最新版」，看不出線換了');
});

test('⑦ 沒有版本線就沒有判別器：讀不出 DAEMON_LINE 一律丟例外，不給預設值', async () => {
  const { daemonReleasedRe, readDaemonLine } = await import('./daemon-notes.mjs');
  for (const bad of [undefined, null, '', '0.18.3', 'v0.18', '亂寫']) {
    assert.throws(() => daemonReleasedRe(bad), /需要一條版本線/,
      `${JSON.stringify(bad)} 不是一條線，不准被當成線`);
  }
  // 檔案不存在 ⇒ null（呼叫端要把 null 當成斷，不是當成「用預設值」）
  assert.equal(readDaemonLine('/nonexistent/DAEMON_LINE'), null);
});

test('⑧ 產生端與判別器對得上（兩份實作靠測試對齊，不靠註解）', async () => {
  const { daemonReleasedRe } = await import('./daemon-notes.mjs');
  for (const line of ['0.18', '0.19']) {
    const { version, changelogAfter } = runProducer({ changelog: UNRELEASED + OLD_V, line, stamp: true });
    assert.equal(changelogAfter.match(daemonReleasedRe(line))[1], version,
      `產生端在 ${line} 這條線戳出來的標題，必須被出貨線那道閘讀回同一個版本`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 指紋帳本：戳版的**順序**（inkstone/arcrun-rag#88，2026-08-18）
//
// 上面那些案例刻意避開指紋機制（假樹不是 git repo ⇒ 指紋回空字串）。
// 下面三支相反：**一定要是 git repo**，因為要驗的就是指紋帳本本身。
// ═══════════════════════════════════════════════════════════════════════════

/** 造一個像真的一樣的 collector 樹：是 git repo，dist/ 被 gitignore（與真 repo 一致）。 */
function realishTree({ changelog, line = '0.18' }) {
  const root = mkdtempSync(join(tmpdir(), 'daemon-version-git-'));
  const appDir = join(root, 'collector', 'cmd', 'arcrun-app');
  mkdirSync(appDir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'collector', 'CHANGELOG.md'), changelog);
  writeFileSync(join(root, 'collector', 'DAEMON_LINE'), `${line}\n`);
  writeFileSync(join(appDir, 'main.go'), 'package main\n');
  writeFileSync(join(appDir, '.gitignore'), 'dist/\nbuild/bin\n');
  copyFileSync(SCRIPT, join(appDir, 'daemon-version.py'));
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const stampIt = () => execFileSync('python3', [join(appDir, 'daemon-version.py'), '--stamp'],
    { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { root, appDir, stampIt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('⑨ 🔴 同一輪打三個平台不准被自己的閘擋下（指紋要記「戳版之後」那棵樹）', () => {
  // 病（2026-08-18 A/B 重現）：原本是「先記指紋、再把宣告寫進 changelog」，而 changelog
  // 就住在指紋涵蓋的樹底下（D95 第一輪搬進 collector/）⇒ 帳本記的是**還沒戳版**那一刻。
  // build-mac.sh 打完 dmg，同一輪的 build-win.sh 走「重打同一版」路徑，
  // 現在的指紋 ≠ 帳本裡那個 ⇒ 判「版號已對應另一份原始碼」⇒ **第二個平台永遠打不出來**。
  // 而 ship.mjs 的 daemon-sync 兩個平台都要，缺一不准出貨。
  const t = realishTree({ changelog: UNRELEASED + OLD_V });
  try {
    assert.equal(t.stampIt(), '0.18.29', '① mac');
    mkdirSync(join(t.appDir, 'dist'), { recursive: true });
    writeFileSync(join(t.appDir, 'dist', 'Arcrun-0.18.29.dmg'), 'x');
    assert.equal(t.stampIt(), '0.18.29', '② win（同一輪第二支打包線）');
    writeFileSync(join(t.appDir, 'dist', 'Arcrun-win-0.18.29.exe'), 'x');
    assert.equal(t.stampIt(), '0.18.29', '③ msix（同一輪第三支）');
  } finally { t.cleanup(); }
});

test('⑩ 🔴 但「戳完版之後真的改了 code」照樣要被擋（別把閘修成永遠放行）', () => {
  const t = realishTree({ changelog: UNRELEASED + OLD_V });
  try {
    assert.equal(t.stampIt(), '0.18.29');
    mkdirSync(join(t.appDir, 'dist'), { recursive: true });
    writeFileSync(join(t.appDir, 'dist', 'Arcrun-0.18.29.dmg'), 'x');
    writeFileSync(join(t.appDir, 'main.go'), 'package main\n// 戳完版才改的\n');
    assert.throws(() => t.stampIt(), /已經對應過另一份原始碼/);
  } finally { t.cleanup(); }
});

test('⑪ --source-state 是唯讀的，而且答得出「這一版配不配得上現在這棵樹」', () => {
  const t = realishTree({ changelog: UNRELEASED + OLD_V });
  try {
    t.stampIt();
    const ask = () => JSON.parse(execFileSync('python3',
      [join(t.appDir, 'daemon-version.py'), '--source-state'],
      { cwd: t.appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const before = readFileSync(join(t.appDir, '.version-source.json'), 'utf8');

    const ok = ask();
    assert.equal(ok.version, '0.18.29');
    assert.equal(ok.recorded_fingerprint, ok.current_fingerprint, '剛戳完版就該對得上');
    assert.deepEqual(ok.changed, []);

    writeFileSync(join(t.appDir, 'main.go'), 'package main\n// 沒重打包\n');
    const bad = ask();
    assert.notEqual(bad.recorded_fingerprint, bad.current_fingerprint);
    assert.deepEqual(bad.changed, ['cmd/arcrun-app/main.go'], '要講得出是哪個檔');

    assert.equal(readFileSync(join(t.appDir, '.version-source.json'), 'utf8'), before,
      '--source-state 問了兩次，帳本一個位元都不准動');
  } finally { t.cleanup(); }
});
