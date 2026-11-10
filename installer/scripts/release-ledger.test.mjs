/**
 * release-ledger.test.mjs（inkstone/arcrun-rag#302）
 * 跑法：node --test installer/scripts/release-ledger.test.mjs
 *
 * 核心情境（票上的驗收）：先出 A 版並開簽核 → 別條線再出 B 版上 stage → 對 A 跑 prod ⇒ 選中的必須是 A 的 commit 與內容。
 * 全程用臨時 git repo／臨時 bundle 目錄，不碰任何真的出貨目標。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, recordShipment, resolveSignedVersion, ensureSourceAt, checkSignedBuild, LEDGER_FILE } from './release-ledger.mjs';
import { syncManifest, readReleaseState } from './release.mjs';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
let n = 0;
function commit(dir, msg) {
  writeFileSync(join(dir, `f${n++}.txt`), String(n));
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}
/** 假的 Arcrun repo：A（被簽的）→ B（別條線後來又出 stage 的）。HEAD 停在 B。 */
function arcrunFixture() {
  const dir = tmp('ledger-arcrun-');
  git(dir, ['init', '-q', '-b', 'main']);
  const base = commit(dir, 'base');
  const A = commit(dir, 'feat A (inkstone/Arcrun#1)');
  const B = commit(dir, 'feat B (inkstone/Arcrun#2)');
  return { dir, base, A, B };
}
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

test('recordShipment：第一次記、同版再記只補目標時間、commit 與指紋以第一次為準', () => {
  const root = tmp('ledger-root-');
  const r1 = recordShipment(root, { release: '1.4.145', fingerprint: FP_A, commit: 'A1', target: 'stage', at: 't1' });
  assert.ok(r1.ok && r1.changed);
  const r2 = recordShipment(root, { release: '1.4.145', fingerprint: FP_A, commit: 'A-other', target: 'prod', at: 't2' });
  assert.ok(r2.ok && r2.changed);
  const e = readLedger(root).releases['1.4.145'];
  assert.equal(e.commit, 'A1', 'prod 重打不能改寫 stage 當初的 commit');
  assert.deepEqual(e.shipped, { stage: 't1', prod: 't2' });
  const r3 = recordShipment(root, { release: '1.4.145', fingerprint: FP_A, commit: 'A1', target: 'prod', at: 't3' });
  assert.equal(r3.changed, false, '同目標重記不變');
  assert.ok(existsSync(join(root, LEDGER_FILE)));
});

test('recordShipment：同一個版號帶不同內容指紋＝擋（不寫）', () => {
  const root = tmp('ledger-root-');
  recordShipment(root, { release: '1.4.145', fingerprint: FP_A, commit: 'A1', target: 'stage' });
  const r = recordShipment(root, { release: '1.4.145', fingerprint: FP_B, commit: 'B1', target: 'stage' });
  assert.equal(r.ok, false);
  assert.match(r.conflict, /兩份不同的內容/);
  assert.equal(readLedger(root).releases['1.4.145'].fingerprint, FP_A);
});

test('resolveSignedVersion：找不到＝人話（列出帳上有哪些、說該怎麼辦）；沒上過 stage＝擋；格式不對＝擋', () => {
  const ledger = { releases: { '1.4.145': { commit: 'c', fingerprint: FP_A, shipped: { stage: 't' } }, '1.4.150': { commit: 'c', fingerprint: FP_B, shipped: { prod: 't' } } } };
  const miss = resolveSignedVersion({ ledger, version: '1.4.999' });
  assert.equal(miss.ok, false);
  assert.match(miss.message, /1\.4\.999/); assert.match(miss.message, /1\.4\.145、1\.4\.150/); assert.match(miss.message, /重出 stage/);
  const nostage = resolveSignedVersion({ ledger, version: '1.4.150' });
  assert.equal(nostage.ok, false); assert.match(nostage.message, /沒有「上過 stage」/);
  assert.equal(resolveSignedVersion({ ledger, version: 'latest' }).ok, false);
  const ok = resolveSignedVersion({ ledger, version: '1.4.145' });
  assert.ok(ok.ok); assert.equal(ok.entry.commit, 'c');
});

test('ensureSourceAt：HEAD 在 B、被簽的是 A ⇒ 另開 worktree 在 A，不動原工作區', () => {
  const f = arcrunFixture();
  const wtDir = join(tmp('ledger-wt-'), 'signed-src', '1.4.145');
  const r = ensureSourceAt({ repo: f.dir, commit: f.A, worktreeDir: wtDir });
  assert.ok(r.ok, r.message);
  assert.equal(git(r.repo, ['rev-parse', 'HEAD']), f.A, 'worktree 在 A');
  assert.equal(git(f.dir, ['rev-parse', 'HEAD']), f.B, '原工作區仍在 B（沒被動）');
  // 重跑：沿用
  const again = ensureSourceAt({ repo: f.dir, commit: f.A, worktreeDir: wtDir });
  assert.ok(again.ok); assert.match(again.message, /沿用/);
  // 帳上寫短 sha 也行
  const short = ensureSourceAt({ repo: f.dir, commit: f.A.slice(0, 12), worktreeDir: wtDir });
  assert.ok(short.ok);
});

test('ensureSourceAt：HEAD 本來就是那顆＝直接用；commit 找不到＝人話（失傳就不能出 prod）', () => {
  const f = arcrunFixture();
  const here = ensureSourceAt({ repo: f.dir, commit: f.B, worktreeDir: join(tmp('x-'), 'wt') });
  assert.ok(here.ok); assert.equal(here.repo, f.dir);
  const gone = ensureSourceAt({ repo: f.dir, commit: 'f'.repeat(40), worktreeDir: join(tmp('x-'), 'wt') });
  assert.equal(gone.ok, false);
  assert.match(gone.message, /找不到/); assert.match(gone.message, /重出 stage/);
});

test('checkSignedBuild：版號與指紋都要對上帳；任一不同＝擋，訊息講被簽的是哪一版', () => {
  const entry = { commit: 'a'.repeat(40), fingerprint: FP_A };
  assert.ok(checkSignedBuild({ version: '1.4.145', entry, builtRelease: '1.4.145', builtFingerprint: FP_A }).ok);
  const bad = checkSignedBuild({ version: '1.4.145', entry, builtRelease: '1.4.146', builtFingerprint: FP_B });
  assert.equal(bad.ok, false); assert.match(bad.message, /被簽：1\.4\.145/); assert.match(bad.message, /重打：1\.4\.146/);
  assert.equal(checkSignedBuild({ version: '1.4.145', entry, builtRelease: '1.4.145', builtFingerprint: FP_B }).ok, false);
});

// ── syncManifest 的 signed 模式 ──────────────────────────────────────────
function seedBundle(dir, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'comp.zip'), content);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, core: [{ name: 'comp', main_file: 'comp.zip', sha256: 'x', bytes: 0 }], source: 'Arcrun@x' }));
}

test('驗收情境：A 上 stage → B 上 stage（共用狀態前進）→ 對 A 出 prod：版號＝A 的、不動共用狀態、下一個 stage 不撞號', () => {
  const repoRoot = tmp('ledger-rag-');
  const stageDir = tmp('ledger-stage-'); const prodDir = tmp('ledger-prod-');
  // 起點：共用狀態停在 1.4.144
  seedBundle(stageDir, 'content-0');
  const base = syncManifest(stageDir, { repoRoot, sharedState: true, quiet: true });
  // 出 A（內容 A）→ stage
  seedBundle(stageDir, 'content-A');
  const a = syncManifest(stageDir, { repoRoot, sharedState: true, quiet: true });
  assert.notEqual(a.release, base.release);
  recordShipment(repoRoot, { release: a.release, fingerprint: a.fingerprint, commit: 'A-commit', built: '2026-11-10', target: 'stage' });
  // 別條線出 B → stage（共用狀態前進）
  seedBundle(stageDir, 'content-B');
  const b = syncManifest(stageDir, { repoRoot, sharedState: true, quiet: true });
  recordShipment(repoRoot, { release: b.release, fingerprint: b.fingerprint, commit: 'B-commit', target: 'stage' });
  const stateAfterB = readReleaseState(repoRoot);
  assert.equal(stateAfterB.release, b.release);

  // 不帶 signed 就重打 A 的內容：這正是舊 bug——會被當成新內容、算出第三個號碼（對不上簽核）
  seedBundle(prodDir, 'content-A');
  const naive = syncManifest(prodDir, { repoRoot, sharedState: true, quiet: true });
  assert.notEqual(naive.release, a.release, '舊行為：對 A 的內容算出別的號碼');
  // 還原共用狀態（naive 那次把它動了，這裡只為了證明舊 bug；下面用乾淨狀態再跑新路）
  const repoRoot2 = tmp('ledger-rag2-');
  syncManifest((() => { const d = tmp('s0-'); seedBundle(d, 'content-0'); return d; })(), { repoRoot: repoRoot2, sharedState: true, quiet: true });
  syncManifest((() => { const d = tmp('sa-'); seedBundle(d, 'content-A'); return d; })(), { repoRoot: repoRoot2, sharedState: true, quiet: true });
  const bDir = tmp('sb-'); seedBundle(bDir, 'content-B');
  const b2 = syncManifest(bDir, { repoRoot: repoRoot2, sharedState: true, quiet: true });
  const stateBefore = readReleaseState(repoRoot2);

  // 新路：帶 signed（取自帳）
  const prod2 = tmp('ledger-prod2-'); seedBundle(prod2, 'content-A');
  const signed = { release: a.release, fingerprint: a.fingerprint, built: '2026-11-10' };
  const r = syncManifest(prod2, { repoRoot: repoRoot2, sharedState: true, quiet: true, signed });
  assert.equal(r.release, a.release, '出的是被簽的 A 版號');
  assert.equal(r.fingerprint, a.fingerprint);
  assert.equal(JSON.parse(readFileSync(join(prod2, 'manifest.json'), 'utf8')).release, a.release);
  assert.deepEqual(readReleaseState(repoRoot2), stateBefore, '共用狀態（最新一版＝B）沒被倒寫');
  // 下一次 stage 照常往前、不撞 B 的號
  const cDir = tmp('sc-'); seedBundle(cDir, 'content-C');
  const c = syncManifest(cDir, { repoRoot: repoRoot2, sharedState: true, quiet: true });
  assert.notEqual(c.release, b2.release); assert.notEqual(c.release, a.release);
});

test('signed 模式：重打內容和帳上指紋不同 ⇒ 擋（不出沒被簽的內容）', () => {
  const repoRoot = tmp('ledger-rag-'); const d = tmp('ledger-p-');
  seedBundle(d, 'content-WRONG');
  assert.throws(() => syncManifest(d, { repoRoot, sharedState: true, quiet: true, signed: { release: '1.4.145', fingerprint: FP_A, built: '2026-11-10' } }), /不是被簽的 1\.4\.145/);
});
