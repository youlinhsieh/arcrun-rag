/**
 * unmerged-fix-gate.test.mjs — 切版前「已交回卻沒進版」閘的演練
 *
 * 跑法：node --test installer/scripts/unmerged-fix-gate.test.mjs
 *
 * 用真的暫存 git repo（一個 bare 當遠端 + 一個工作 clone），重演 Arcrun#310 的形狀：
 *   fix/310-* 在遠端、交回了、票是緊急的、來源 main 沒有它 ⇒ 必須被點名、被擋；
 *   併進去（或等價 commit 進去）之後，同一個呼叫放行。
 * 票用假的 reader 餵（不碰網路）；兩個方向都驗：擋得住、也不亂擋。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFixHeads, parseSkipArgs, loadIgnore, judgeTicket, requireNoUnmergedFixes, GATE_LOG_REL, IGNORE_REL,
} from './unmerged-fix-gate.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'umfix-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'src');
  const rag = join(root, 'rag');
  mkdirSync(rag, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' });
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'a.txt'), 'base\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', 'origin', 'main');
  const mkBranch = (name, file, body) => {
    g(work, 'checkout', '-q', '-b', name, 'main');
    writeFileSync(join(work, file), body); g(work, 'add', '.'); g(work, 'commit', '-qm', `fix ${name}`);
    g(work, 'push', '-q', 'origin', name); g(work, 'checkout', '-q', 'main');
    return g(work, 'rev-parse', name);
  };
  return { root, work, rag, mkBranch, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const URGENT_OPEN = (sha7, name = 'fix/310-x') => ({
  issue: { state: 'open', labels: [{ name: 's/doing' }], body: 'leo：客戶已受影響，緊急修復' },
  comments: [{ id: 1, body: `🏃 棒子交回\n分支 ${name}（${sha7}）併入下個候選` }],
});

test('parseFixHeads：名字帶得出票號的分支都算（不只 fix/），收納用命名空間與無票號的不算', () => {
  const h = (n) => `${'a'.repeat(40)}\trefs/heads/${n}`;
  const out = parseFixHeads([
    'fix/310-mcp-401', 'arcrun-hand/310-solo', 'hand/139-x', 'claude/143-quota', 'feat/222-log', 'hotfix/12',
    'ms81-286-recipe', 'issue-30-pdf', 'spike/workerd-274',
    'archive/fix/236-x', 'integrate/rag-139-sweep', 'chore/1.4.64-bundle', 'fix/notanumber', 'main',
  ].map(h).join('\n'));
  assert.deepEqual(out.map((x) => [x.name, x.issue]), [
    ['fix/310-mcp-401', 310], ['arcrun-hand/310-solo', 310], ['hand/139-x', 139], ['claude/143-quota', 143],
    ['feat/222-log', 222], ['hotfix/12', 12], ['ms81-286-recipe', 286], ['issue-30-pdf', 30], ['spike/workerd-274', 274],
  ]);
});

test('parseSkipArgs 理由必填、可重複', () => {
  const m = parseSkipArgs(['--x', '--skip-unmerged-fix', 'fix/1-a=因為 A', '--skip-unmerged-fix', 'fix/2-b=因為=B']);
  assert.equal(m.get('fix/1-a'), '因為 A');
  assert.equal(m.get('fix/2-b'), '因為=B');
  assert.throws(() => parseSkipArgs(['--skip-unmerged-fix', 'fix/1-a']), /理由必填/);
  assert.throws(() => parseSkipArgs(['--skip-unmerged-fix', 'fix/1-a=  ']), /理由必填/);
});

test('judgeTicket：提到分支名或頂端 sha 且寫交回才算已交回', () => {
  const br = { name: 'fix/310-x', sha: 'abcdef1234567890'.padEnd(40, '0') };
  const mk = (body) => ({ issue: { state: 'open', labels: [] }, comments: [{ id: 5, body }] });
  assert.equal(judgeTicket(mk('棒子交回 fix/310-x'), br).handedBack, true);
  assert.equal(judgeTicket(mk('交回 abcdef1'), br).handedBack, true);
  assert.equal(judgeTicket(mk('交回 fix/999-other'), br).handedBack, false);
  assert.equal(judgeTicket(mk('我在看 fix/310-x'), br).handedBack, false);
  assert.equal(judgeTicket({ issue: { state: 'open', labels: [{ name: '緊急' }] }, comments: [] }, br).urgent, true);
  assert.equal(judgeTicket({ issue: { state: 'open', labels: [{ name: 'p/high' }] }, comments: [] }, br).urgent, true);
  assert.equal(judgeTicket({ issue: { state: 'open', labels: [{ name: 'p/low' }, { name: 's/doing' }] }, comments: [] }, br).urgent, false);
});

test('重演 #310：交回＋緊急＋沒進版 ⇒ 被點名且被擋；併進去之後同一個呼叫放行', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    const reader = async () => URGENT_OPEN(sha.slice(0, 7));
    const call = (extra = {}) => requireNoUnmergedFixes({
      repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', targetName: 'stage', readTicket: reader, ...extra,
    });
    await assert.rejects(call(), (e) => /fix\/310-x/.test(e.message) && /Arcrun#310/.test(e.message) && /切不了版/.test(e.message));
    assert.match(readFileSync(join(f.rag, GATE_LOG_REL), 'utf8'), /⛔ 擋下 \| fix\/310-x/);
    // 併進來源
    g(f.work, 'merge', '-q', '--no-edit', '--no-ff', 'fix/310-x');
    const ok = await call();
    assert.equal(ok.report.blocking.length, 0);
    assert.equal(ok.report.merged.length, 1);
  } finally { f.cleanup(); }
});

test('等價 commit 已用 cherry-pick 進 main（sha 不同）⇒ 不再點名', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    g(f.work, 'cherry-pick', sha);
    const r = await requireNoUnmergedFixes({
      repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: async () => URGENT_OPEN(sha.slice(0, 7)),
    });
    assert.equal(r.report.merged.length, 1);
    assert.equal(r.report.blocking.length, 0);
  } finally { f.cleanup(); }
});

test('--skip-unmerged-fix：帶理由放行，並留痕在流水帳與報告', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    const r = await requireNoUnmergedFixes({
      repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', targetName: 'stage',
      argv: ['--skip-unmerged-fix', 'fix/310-x=等 stage 驗收，下一版再帶'],
      readTicket: async () => URGENT_OPEN(sha.slice(0, 7)),
    });
    assert.equal(r.report.waived.length, 1);
    assert.ok(r.lines.some((l) => /這次不帶/.test(l) && /等 stage 驗收/.test(l)));
    assert.match(readFileSync(join(f.rag, GATE_LOG_REL), 'utf8'), /這次不帶.*fix\/310-x.*理由：等 stage 驗收/);
  } finally { f.cleanup(); }
});

test('不亂擋：不緊急只點名、還沒交回只知會、票已關只知會', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    const run = (t) => requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: async () => t });
    const calm = { issue: { state: 'open', labels: [], body: '小問題' }, comments: [{ id: 1, body: `交回 fix/310-x` }] };
    let r = await run(calm);
    assert.equal(r.report.warn.length, 1); assert.equal(r.report.blocking.length, 0);
    r = await run({ issue: { state: 'open', labels: [], body: '緊急' }, comments: [] });
    assert.equal(r.report.info.length, 1); assert.equal(r.report.blocking.length, 0);
    r = await run({ ...URGENT_OPEN(sha.slice(0, 7)), issue: { state: 'closed', labels: [], body: '緊急' } });
    assert.equal(r.report.info.length, 1); assert.equal(r.report.blocking.length, 0);
  } finally { f.cleanup(); }
});

test('標掉舊分支：綁頂端 sha，分支再動就失效', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    mkdirSync(join(f.rag, 'installer'), { recursive: true });
    writeFileSync(join(f.rag, IGNORE_REL), JSON.stringify({ 'fix/310-x': { tip: sha.slice(0, 7), reason: '已被 B 案取代' } }));
    const call = () => requireNoUnmergedFixes({
      repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: async () => URGENT_OPEN(sha.slice(0, 7)),
    });
    const r = await call();
    assert.equal(r.report.ignored.length, 1);
    // 分支又動了
    g(f.work, 'checkout', '-q', 'fix/310-x'); writeFileSync(join(f.work, 'c.txt'), 'more\n');
    g(f.work, 'add', '.'); g(f.work, 'commit', '-qm', 'more'); g(f.work, 'push', '-q', 'origin', 'fix/310-x'); g(f.work, 'checkout', '-q', 'main');
    await assert.rejects(call(), /fix\/310-x/);
  } finally { f.cleanup(); }
});

test('讀不到票 ⇒ fail-closed 擋下（判不出緊急與否）；沒有候選分支就根本不讀票', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const reader = async () => { reads++; throw new Error('HTTP 401'); };
    const none = await requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: reader });
    assert.equal(reads, 0); assert.equal(none.report.listed, 0);
    f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    await assert.rejects(requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: reader }), /讀不到票.*HTTP 401/s);
  } finally { f.cleanup(); }
});

test('票號查無此票（404 且有 token）⇒ 只知會，不擋；沒 token 的 404 與其他錯照舊 fail-closed', async () => {
  const f = fixture();
  try {
    f.mkBranch('fix/207-x', 'b.txt', 'fix\n');
    const missing = async () => { const e = new Error('HTTP 404'); e.missing = true; throw e; };
    const r = await requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: missing });
    assert.equal(r.report.blocking.length, 0);
    assert.match(r.lines.join('\n'), /查無此票/);
    const noTok = async () => { throw new Error('HTTP 404'); };
    await assert.rejects(requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: noTok }), /讀不到票/);
  } finally { f.cleanup(); }
});

test('不靠緊急標籤：已交回、票開著、放超過門檻天數 ⇒ 擋；交回不久 ⇒ 只點名（#310 就是這樣漏的）', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('arcrun-hand/310-solo', 'b.txt', 'fix\n');
    const mk = (daysAgo) => async () => ({
      issue: { state: 'open', labels: [{ name: 's/doing' }], body: '票面沒有任何記號' },
      comments: [{ id: 9, created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(), body: `棒子交回 arcrun-hand/310-solo ${sha.slice(0, 7)}` }],
    });
    const call = (days) => requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: mk(days) });
    await assert.rejects(call(9), (e) => /arcrun-hand\/310-solo/.test(e.message) && /\d+ 天沒進版/.test(e.message));
    const fresh = await call(1);
    assert.equal(fresh.report.blocking.length, 0);
    assert.equal(fresh.report.warn.length, 1);
    assert.match(fresh.lines.join('\n'), /arcrun-hand\/310-solo/);
  } finally { f.cleanup(); }
});

test('遠端不叫 origin（雲端 clone 叫 art）也找得到', async () => {
  const f = fixture();
  try {
    f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    g(f.work, 'remote', 'rename', 'origin', 'art');
    const r = await requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: async () => ({ issue: { state: 'open', labels: [] }, comments: [] }) });
    assert.equal(r.report.listed, 1);
  } finally { f.cleanup(); }
});

test('有 listOpen：票已關／不存在的分支只知會（不讀留言），開著的票才讀留言判斷', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('arcrun-hand/310-solo', 'b.txt', 'fix\n');
    f.mkBranch('feat/99-old', 'c.txt', 'old\n');
    const reads = [];
    const reader = async () => { throw new Error('不該走逐張讀'); };
    reader.listOpen = async () => new Map([[310, { number: 310, state: 'open', labels: [{ name: 'p/high' }], body: '' }]]);
    reader.comments = async ({ issue }) => { reads.push(issue); return [{ id: 1, body: `交回 arcrun-hand/310-solo ${sha.slice(0, 7)}` }]; };
    await assert.rejects(
      requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: reader }),
      (e) => /arcrun-hand\/310-solo/.test(e.message) && /feat\/99-old/.test(e.message) && /票已關或不存在/.test(e.message));
    assert.deepEqual(reads, [310]);
  } finally { f.cleanup(); }
});

test('squash 合併（sha、patch-id 都不同）但改到的檔案內容與 HEAD 相同 ⇒ 視為已進版；HEAD 上檔案不同則仍點名', async () => {
  const f = fixture();
  try {
    const sha = f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    // 在 main 上用「不同的 commit 內容切分」帶進同一份檔案（另外多改一個檔，使 patch-id 對不上）
    writeFileSync(join(f.work, 'b.txt'), 'fix\n'); writeFileSync(join(f.work, 'extra.txt'), 'x\n');
    g(f.work, 'add', '.'); g(f.work, 'commit', '-qm', 'squash of fix/310-x');
    const reader = async () => URGENT_OPEN(sha.slice(0, 7));
    const ok = await requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: reader });
    assert.equal(ok.report.merged.length, 1);
    // HEAD 之後把那個檔又改掉 ⇒ 內容不同 ⇒ 不能算已進版
    writeFileSync(join(f.work, 'b.txt'), 'changed later\n'); g(f.work, 'commit', '-qam', 'later');
    await assert.rejects(requireNoUnmergedFixes({ repo: f.work, repoRoot: f.rag, ticketRepo: 'Arcrun', readTicket: reader }), /fix\/310-x/);
  } finally { f.cleanup(); }
});

test('來源是淺 clone ⇒ 先補齊歷史再判（不然所有分支都會被誤判成沒進版）', async () => {
  const f = fixture();
  try {
    f.mkBranch('fix/310-x', 'b.txt', 'fix\n');
    g(f.work, 'merge', '-q', '--no-edit', '--no-ff', 'fix/310-x'); g(f.work, 'push', '-q', 'origin', 'main');
    const shallow = join(f.root, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${join(f.root, 'remote.git')}`, shallow], { stdio: 'ignore' });
    assert.equal(g(shallow, 'rev-parse', '--is-shallow-repository'), 'true');
    const r = await requireNoUnmergedFixes({
      repo: shallow, repoRoot: f.rag, ticketRepo: 'Arcrun',
      readTicket: async () => URGENT_OPEN('0000000'),
    });
    assert.equal(r.report.unshallowed, true);
    assert.equal(r.report.merged.length, 1);
    assert.equal(r.report.blocking.length, 0);
  } finally { f.cleanup(); }
});

test('loadIgnore：壞檔、缺欄位都丟例外，不安靜當空', () => {
  const root = mkdtempSync(join(tmpdir(), 'umfix-ig-'));
  try {
    mkdirSync(join(root, 'installer'));
    writeFileSync(join(root, IGNORE_REL), '{bad');
    assert.throws(() => loadIgnore(root), /不是合法 JSON/);
    writeFileSync(join(root, IGNORE_REL), JSON.stringify({ 'fix/1-a': { tip: 'abc1234' } }));
    assert.throws(() => loadIgnore(root), /reason/);
    assert.ok(!existsSync(join(root, GATE_LOG_REL)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
