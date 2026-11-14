/**
 * daemon-channel.test.mjs — stage 與 prod 各認自己通道發過的小幫手版號（inkstone/arcrun-rag#341）。
 *
 * 跑法：node --test installer/scripts/daemon-channel.test.mjs
 *
 * 真實發生過的狀態（2026-11-14）：stage 通道 11-12 發了 0.18.119，正式站（leo 決定）留在 0.18.118。
 * 舊的閘只會問「changelog 最上面那個已發佈版」，兩個目標得到同一個答案，
 * 於是要嘛 stage 斷（認 0.18.118 而 stage 實跑 0.18.119）、要嘛 prod 誤帶 0.18.119。
 * 當時是改 changelog 標題讓 prod 過、stage 因此斷——本檔演練的是不靠改標題的做法：
 * 標題寫明「僅 stage」，兩個通道各讀各的。
 *
 * 該擋／該分開的：
 *   ① 同一份 changelog，stage 讀到 0.18.119、prod 讀到 0.18.118
 *   ② 通道沒指名 ＝ prod（最嚴），不會誤帶 stage 專屬版
 *   ③ 不認得的通道名要丟錯，不是默默當成某一邊
 *   ④ in-bundle 閘：stage bundle 委任 0.18.119 → stage 通過、prod 擋；prod bundle 委任 0.18.118 → prod 通過、stage 擋
 *   ⑤ 兩邊都已發佈時（標題沒有「僅 stage」），兩個通道讀到同一版——不平白分岔
 *   ⑥ daemon-version.py --source-state --channel 與 JS 判別器答案一致（兩份實作靠測試對齊）
 *   ⑦ 登錄簿：stage 宣告 stage、prod 宣告 prod
 *   ⑧ 真實的 collector/CHANGELOG.md：stage→0.18.119、prod→0.18.118，且下一次戳版不會撞 0.18.119
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { collectFacts, judge, requireDaemonInBundle, daemonReleasedRe } from './daemon-in-bundle-gate.mjs';
import { daemonReleasedReFor, STAGE_ONLY_MARK } from './daemon-notes.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CL = 'collector/CHANGELOG.md';

const STAGE_ONLY_LOG = [
  '# 版本與更新', '',
  '## 下一版（未發佈）', '', '- **草稿**：還沒出。', '',
  `## 0.18.119（2026-11-12・${STAGE_ONLY_MARK}）`, '', '- **只在 stage 發過**：說明。', '',
  '## 0.18.118（2026-11-01）', '', '- **正式站那一版**：說明。', '',
].join('\n');

const BOTH_LOG = STAGE_ONLY_LOG.replace('・' + STAGE_ONLY_MARK, '');

const top = (text, ch) => (text.match(daemonReleasedRe('0.18', ch)) || [])[1] || null;

test('① 同一份 changelog：stage 讀到 0.18.119、prod 讀到 0.18.118', () => {
  assert.equal(top(STAGE_ONLY_LOG, 'stage'), '0.18.119');
  assert.equal(top(STAGE_ONLY_LOG, 'prod'), '0.18.118');
});

test('② 沒指名通道＝prod（最嚴）', () => {
  assert.equal((STAGE_ONLY_LOG.match(daemonReleasedRe('0.18')) || [])[1], '0.18.118');
});

test('③ 不認得的通道要丟錯', () => {
  assert.throws(() => daemonReleasedRe('0.18', 'staging'), /不認得通道/);
  assert.throws(() => daemonReleasedRe('0.18', ''), /不認得通道/);
});

test('⑤ 兩邊都發過（標題沒有「僅 stage」）：兩個通道讀到同一版', () => {
  assert.equal(top(BOTH_LOG, 'stage'), '0.18.119');
  assert.equal(top(BOTH_LOG, 'prod'), '0.18.119');
});

test('「僅 stage」只認標題括號內，不被內文裡出現同樣字樣騙到', () => {
  const log = BOTH_LOG.replace('- **只在 stage 發過**：說明。', `- **內文提到 ${STAGE_ONLY_MARK}**：說明。`);
  assert.equal(top(log, 'prod'), '0.18.119');
});

/** 搭 repo＋bundle 臨時場景，bundle 真的放 dmg／exe 並算真 sha256。 */
function scene(version) {
  const root = mkdtempSync(join(tmpdir(), 'dchan-'));
  const repo = join(root, 'repo');
  const bundles = join(root, 'bundles');
  mkdirSync(join(repo, 'collector'), { recursive: true });
  mkdirSync(join(bundles, 'daemon'), { recursive: true });
  writeFileSync(join(repo, CL), STAGE_ONLY_LOG);
  writeFileSync(join(repo, 'collector/DAEMON_LINE'), '0.18\n');
  const daemon = { version };
  const files = { mac: `Arcrun-${version}.dmg`, win: `Arcrun-win-${version}.exe` };
  for (const [k, f] of Object.entries(files)) {
    const buf = Buffer.from(`${k}-${version}`);
    writeFileSync(join(bundles, 'daemon', f), buf);
    daemon[k] = { file: `daemon/${f}`, sha256: createHash('sha256').update(buf).digest('hex') };
  }
  writeFileSync(join(bundles, 'manifest.json'), JSON.stringify({ release: '1.4.192', daemon }));
  return { repo, bundles };
}

test('④ in-bundle 閘：stage bundle（0.18.119）→ stage 過、prod 擋', () => {
  const { repo, bundles } = scene('0.18.119');
  const base = { repoRoot: repo, bundlesDir: bundles, changelogRel: CL };
  const st = judge(collectFacts({ ...base, channel: 'stage' }));
  assert.equal(st.ok, true, st.blockers.join('\n'));
  assert.equal(st.version, '0.18.119');
  const pr = judge(collectFacts({ ...base, channel: 'prod' }));
  assert.equal(pr.ok, false);
  assert.equal(pr.version, '0.18.118');
  assert.ok(pr.checks.find((c) => c.id === 'version-match' && !c.ok), '要斷在版本對不上，不是別的');
});

test('④ in-bundle 閘：prod bundle（0.18.118）→ prod 過、stage 擋（不會誤帶 0.18.119）', () => {
  const { repo, bundles } = scene('0.18.118');
  const base = { repoRoot: repo, bundlesDir: bundles, changelogRel: CL };
  const pr = judge(collectFacts({ ...base, channel: 'prod' }));
  assert.equal(pr.ok, true, pr.blockers.join('\n'));
  assert.equal(pr.version, '0.18.118');
  assert.equal(judge(collectFacts({ ...base, channel: 'stage' })).ok, false);
});

test('④ requireDaemonInBundle 預設通道＝prod：stage 專屬版的 bundle 會被擋下', () => {
  const { repo, bundles } = scene('0.18.119');
  const logPath = join(repo, 'gate-log.md');
  assert.throws(() => requireDaemonInBundle({ repoRoot: repo, bundlesDir: bundles, changelogRel: CL, targetName: 'prod', logPath }));
  const r = requireDaemonInBundle({ repoRoot: repo, bundlesDir: bundles, changelogRel: CL, targetName: 'stage', logPath, channel: 'stage' });
  assert.equal(r.version, '0.18.119');
});

test('installer 薄殼 daemonReleasedReFor 帶得進通道', () => {
  const { repo } = scene('0.18.119');
  const txt = readFileSync(join(repo, CL), 'utf8');
  assert.equal(txt.match(daemonReleasedReFor(repo, 'stage'))[1], '0.18.119');
  assert.equal(txt.match(daemonReleasedReFor(repo))[1], '0.18.118');
});

test('⑥ daemon-version.py --source-state --channel 與 JS 判別器答案一致', () => {
  const py = join(REPO, 'collector/cmd/arcrun-app/daemon-version.py');
  const ask = (ch) => JSON.parse(execFileSync('python3', [py, '--source-state', ...(ch ? ['--channel', ch] : [])],
    { cwd: REPO, encoding: 'utf8' }));
  const real = readFileSync(join(REPO, CL), 'utf8');
  assert.equal(ask('stage').version, real.match(daemonReleasedRe('0.18', 'stage'))[1]);
  assert.equal(ask('prod').version, real.match(daemonReleasedRe('0.18', 'prod'))[1]);
  assert.equal(ask(null).version, ask('prod').version, 'python 沒指名通道也要是 prod');
  assert.throws(() => execFileSync('python3', [py, '--source-state', '--channel', 'x'], { cwd: REPO, stdio: 'pipe' }));
  // 兩份實作的記號字串要同一個
  assert.ok(readFileSync(py, 'utf8').includes(`STAGE_ONLY_MARK = "${STAGE_ONLY_MARK}"`));
});

test('⑦ 登錄簿：stage 宣告 stage、prod 宣告 prod', () => {
  const reg = JSON.parse(readFileSync(join(REPO, 'installer/ship.targets.json'), 'utf8'));
  assert.equal(reg.targets.stage.daemonChannel, 'stage');
  assert.equal(reg.targets.prod.daemonChannel, 'prod');
});

test('⑧ 真實 collector/CHANGELOG.md：兩通道的版本只有「僅 stage」這一個差別，且不會讓戳版撞號', () => {
  const real = readFileSync(join(REPO, CL), 'utf8');
  const st = real.match(daemonReleasedRe('0.18', 'stage'));
  const pr = real.match(daemonReleasedRe('0.18', 'prod'));
  assert.ok(st && pr, '兩個通道都要讀得到已發佈版');
  if (st[1] !== pr[1]) {
    // 分岔時，stage 那一版的標題必須明寫「僅 stage」——不准用改標題格式之類的暗號分岔
    const heading = real.split('\n').find((l) => l.startsWith(`## ${st[1]}（`));
    assert.ok(heading.includes(STAGE_ONLY_MARK), `分岔卻沒有明寫記號：${heading}`);
  }
  // 下一次戳版（有草稿時）必須接在 stage 那一版之後，否則會把 stage 發過的版號再發一次
  const next = execFileSync('python3', [join(REPO, 'collector/cmd/arcrun-app/daemon-version.py')], { cwd: REPO, encoding: 'utf8' }).trim();
  const n = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [a, b] = [n(next), n(st[1])];
  assert.ok(a[2] >= b[2], `下一版 ${next} 不得小於 stage 已發的 ${st[1]}`);
});
