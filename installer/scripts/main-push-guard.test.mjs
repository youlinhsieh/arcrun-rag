/**
 * main-push-guard.test.mjs — 演練「出貨線在 node 子行程裡推 main」會不會被擋。
 *
 * 跑法：node --test installer/scripts/main-push-guard.test.mjs
 *
 * 🔴 這一組守的是 **inkstone/InkStoneCo#56 的假陰性那一半**：
 *   `.claude/hooks/main-and-prod-push-guard.sh` 掛在 `PreToolUse:Bash` 上，只看得到
 *   **Claude Code 的 Bash 工具呼叫本身的指令字串**。出貨線的 push 是
 *   `spawnSync('git', ['push', …])` 開的子行程 ⇒ 那道閘從頭到尾沒有機會判斷。
 *   實害（2026-08-18）：同步步驟把 `a35421e` 直接推上 `inkstone/arcrun-collector`
 *   的 `main`，刪掉 `cmd/collector/main.go`、把 22 行的 `.gitignore` 洗成 1 行，
 *   **沒有任何閘反應**。
 *
 * 該擋：
 *   ① 推 main／master，沒有戳記        → 丟，且訊息說得出「要補什麼」
 *   ② 戳記過期（>15 分鐘）             → 丟（過期的舊保險不放行，同 d20-guard 的教訓）
 *   ③ 戳記綁的是別的目的地             → 丟（08-11 那次穿透就是「不綁 repo」）
 *   ④ 同一枚戳記用第二次               → 丟（單次用完即丟）
 *   ⑤ `--mirror`／`--all`（會一次覆寫所有分支，含 main）→ 丟
 *   ⑥ 沒給 refspec 而當前分支就是 main → 丟
 *   ⑦ 端到端：`syncSourceRepo` 真的推一個本機 bare remote 的 main，沒戳記時
 *      **遠端一個 commit 都不准動**（這一格才是 8/18 那個形狀本身）
 *
 * 不該擋（誤攔比漏攔更容易殺死一道閘）：
 *   ⑧ 推自己的 feature 分支
 *   ⑨ 推 tag（`refs/tags/*`）
 *   ⑩ `--dry-run`
 *   ⑪ 分支名裡剛好含 main 的字（`fix/custom-domain`／`maintenance`）
 *   ⑫ 根本不是 push 的 git 指令（status／fetch／commit -m "…git push origin main…"）
 *   ⑬ 有戳記、對得上 ⇒ 放行，且把戳記用掉
 *
 * 留痕（InkStoneCo#48：36 支閘只有 2 支記錄自己做了什麼）：
 *   ⑭ 擋下與放行**都**要各留一行，否則分母未知
 *   ⑮ 擋下時要留一份請求檔給總管（原始資料，不是散文轉述）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  parsePush, targetsProtectedBranch, normRemote, identitiesOf,
  assertPushAllowed, MainPushBlocked, armCommand, STAMP_PATH, unarmed, claimGrants,
} from './main-push-guard.mjs';
import { syncSourceRepo } from './line-source-repo.mjs';

/** 每個測試自己的沙盒：戳記／留痕／請求檔全部導到暫存目錄，不碰真的 /tmp/.main-push-ok。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mpg-'));
  return {
    dir,
    stampPath: join(dir, 'stamp'),
    logPath: join(dir, 'log.md'),
    pendingDir: join(dir, 'pending'),
    /** 寫一枚（預設新鮮的）戳記。`ago` 秒數往前調時間 ⇒ 演過期。 */
    arm(id, { ago = 0 } = {}) {
      writeFileSync(this.stampPath, `${id}\n`, 'utf8');
      if (ago) {
        const t = new Date(Date.now() - ago * 1000);
        utimesSync(this.stampPath, t, t);
      }
    },
    log() { return existsSync(this.logPath) ? readFileSync(this.logPath, 'utf8') : ''; },
    pending() { return existsSync(this.pendingDir) ? readdirSync(this.pendingDir) : []; },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** 出貨線那三個 callsite 的形狀，統一從這裡發動（cwd 用沙盒目錄即可，判定看 remote）。 */
function push(sb, args, extra = {}) {
  return assertPushAllowed({
    args,
    cwd: sb.dir,
    remoteUrl: extra.remoteUrl ?? 'https://git.uncle6.me/inkstone/arcrun-collector.git',
    stampPath: sb.stampPath,
    logPath: sb.logPath,
    pendingDir: sb.pendingDir,
    who: extra.who ?? 'ship.mjs',
    ...extra,
  });
}

// ── 判斷本身：認得動作，不是認字面 ────────────────────────────────────────
test('⓪ parsePush：認得出貨線那三種寫法的真正目的地（判 argv，不判文字）', () => {
  assert.deepEqual(parsePush(['push', 'origin', 'main']).branches, ['main']);
  assert.deepEqual(parsePush(['push', 'https://x/y.git', 'HEAD:refs/heads/main']).branches, ['main']);
  assert.deepEqual(parsePush(['-c', 'http.postBuffer=157286400', 'push', 'origin', 'main']).branches, ['main']);
  assert.deepEqual(parsePush(['push', 'gitea', 'HEAD:refs/heads/ship/1.4.50']).branches, ['ship/1.4.50']);
  assert.deepEqual(parsePush(['push', 'origin', '+main']).branches, ['main']);   // 強推也是推 main
  assert.deepEqual(parsePush(['push', 'origin', ':main']).branches, ['main']);   // 刪掉 main 更嚴重
  assert.equal(parsePush(['push', 'origin', 'refs/tags/v0.18.34']).branches.length, 0);
  assert.equal(parsePush(['status', '--porcelain']).isPush, false);
  assert.equal(parsePush(['commit', '-m', 'docs: 別再 git push origin main']).isPush, false);
});

test('⓪b targetsProtectedBranch：main/master 算，含 main 的字不算', () => {
  assert.equal(targetsProtectedBranch(['main']), true);
  assert.equal(targetsProtectedBranch(['master']), true);
  assert.equal(targetsProtectedBranch(['fix/custom-domain']), false);
  assert.equal(targetsProtectedBranch(['maintenance']), false);
  assert.equal(targetsProtectedBranch(['feat/main-push-guard']), false);
});

test('⓪c normRemote／identitiesOf：戳記綁的是「哪個 repo 的 main」，帳密不算身分', () => {
  assert.equal(normRemote('https://alice:secret@git.uncle6.me/inkstone/arcrun-collector.git'),
    'git.uncle6.me/inkstone/arcrun-collector');
  assert.equal(normRemote('github.com/youlinhsieh/arcrun-rag-bundles'),
    'github.com/youlinhsieh/arcrun-rag-bundles');
  assert.ok(identitiesOf({ remoteUrl: 'https://github.com/youlinhsieh/arcrun-rag.git', cwd: '/tmp' })
    .includes('github.com/youlinhsieh/arcrun-rag'));
});

// ── 該擋 ──────────────────────────────────────────────────────────────────
test('① 出貨線推 main、沒有戳記 ⇒ 擋，且訊息說得出缺什麼', () => {
  const sb = sandbox();
  try {
    let e = null;
    try {
      push(sb, ['push', 'https://git.uncle6.me/inkstone/arcrun-collector.git', 'HEAD:refs/heads/main']);
    } catch (err) { e = err; }
    assert.ok(e instanceof MainPushBlocked, '沒戳記推 main 必須丟 MainPushBlocked');
    assert.match(e.message, /git\.uncle6\.me\/inkstone\/arcrun-collector/);
    assert.ok(e.message.includes(sb.stampPath), '要補什麼，訊息裡要有那個戳記檔的路徑');
    assert.match(e.message, /2026-08-18/);             // 為什麼有這道閘
  } finally { sb.cleanup(); }
});

test('② 戳記過期（>15 分鐘）⇒ 擋（過期的舊保險不放行）', () => {
  const sb = sandbox();
  try {
    sb.arm('git.uncle6.me/inkstone/arcrun-collector', { ago: 16 * 60 });
    assert.throws(() => push(sb, ['push', 'origin', 'main']), MainPushBlocked);
  } finally { sb.cleanup(); }
});

test('③ 戳記綁的是別的目的地 ⇒ 擋（替 A 開的門，B 不准走）', () => {
  const sb = sandbox();
  try {
    sb.arm('github.com/youlinhsieh/arcrun-rag-bundles');
    assert.throws(() => push(sb, ['push', 'origin', 'main']), MainPushBlocked);
  } finally { sb.cleanup(); }
});

test('④ 同一枚戳記用第二次 ⇒ 擋（單次用完即丟）', () => {
  const sb = sandbox();
  try {
    sb.arm('git.uncle6.me/inkstone/arcrun-collector');
    assert.equal(push(sb, ['push', 'origin', 'main']).allowed, true);
    assert.throws(() => push(sb, ['push', 'origin', 'main']), MainPushBlocked);
  } finally { sb.cleanup(); }
});

test('⑤ --mirror／--all 會一次覆寫所有分支（含 main）⇒ 擋', () => {
  const sb = sandbox();
  try {
    assert.throws(() => push(sb, ['push', '--mirror', 'origin']), MainPushBlocked);
    assert.throws(() => push(sb, ['push', '--all', 'origin']), MainPushBlocked);
  } finally { sb.cleanup(); }
});

test('⑥ 沒給 refspec、當前分支就是 main ⇒ 擋', () => {
  const sb = sandbox();
  try {
    assert.throws(() => push(sb, ['push', 'origin'], { currentBranch: 'main' }), MainPushBlocked);
  } finally { sb.cleanup(); }
});

// ── 不該擋 ────────────────────────────────────────────────────────────────
test('⑧ 推自己的 feature 分支 ⇒ 放行，不必戳記', () => {
  const sb = sandbox();
  try {
    assert.equal(push(sb, ['push', '-u', 'origin', 'fix/main-push-in-process-gate']).allowed, true);
  } finally { sb.cleanup(); }
});

test('⑨ 推 tag ⇒ 放行', () => {
  const sb = sandbox();
  try {
    assert.equal(push(sb, ['push', 'origin', 'refs/tags/v0.18.34']).allowed, true);
  } finally { sb.cleanup(); }
});

test('⑩ --dry-run ⇒ 放行（演練不會改到任何東西）', () => {
  const sb = sandbox();
  try {
    assert.equal(push(sb, ['push', '--dry-run', 'origin', 'main']).allowed, true);
  } finally { sb.cleanup(); }
});

test('⑪ 分支名裡剛好含 main 的字 ⇒ 放行（fix/custom-domain 曾被字面比對誤擋）', () => {
  const sb = sandbox();
  try {
    assert.equal(push(sb, ['push', 'origin', 'fix/custom-domain']).allowed, true);
    assert.equal(push(sb, ['push', 'origin', 'maintenance']).allowed, true);
  } finally { sb.cleanup(); }
});

test('⑫ 不是 push 的 git 指令 ⇒ 這道閘不管它（連留痕都不記，避免灌水）', () => {
  const sb = sandbox();
  try {
    assert.equal(push(sb, ['status', '--porcelain']).allowed, true);
    assert.equal(push(sb, ['commit', '-m', '講一句 git push origin main 不等於在推']).allowed, true);
    assert.equal(sb.log(), '');
  } finally { sb.cleanup(); }
});

test('⑬ 戳記對得上 ⇒ 放行，且戳記被用掉', () => {
  const sb = sandbox();
  try {
    sb.arm('git.uncle6.me/inkstone/arcrun-collector');
    const r = push(sb, ['push', 'origin', 'HEAD:refs/heads/main']);
    assert.equal(r.allowed, true);
    assert.equal(r.stampId, 'git.uncle6.me/inkstone/arcrun-collector');
    assert.equal(existsSync(sb.stampPath), false, '用掉的戳記不准留在原地');
  } finally { sb.cleanup(); }
});

// ── 留痕 ──────────────────────────────────────────────────────────────────
test('⑭ 擋下與放行都留一行（只記擋下的話分母是未知的）', () => {
  const sb = sandbox();
  try {
    assert.throws(() => push(sb, ['push', 'origin', 'main']), MainPushBlocked);
    push(sb, ['push', 'origin', 'fix/x']);
    sb.arm('git.uncle6.me/inkstone/arcrun-collector');
    push(sb, ['push', 'origin', 'main']);
    const log = sb.log();
    assert.match(log, /⛔ 擋下/);
    assert.match(log, /✅ 放行/);
    assert.equal(log.split('\n').filter((l) => l.startsWith('| 2')).length, 3);
  } finally { sb.cleanup(); }
});

test('⑮ 擋下時留一份請求檔給總管（repo／分支／指令的原始資料）', () => {
  const sb = sandbox();
  try {
    assert.throws(() => push(sb, ['push', 'origin', 'main'], { who: 'ship.mjs' }), MainPushBlocked);
    const files = sb.pending();
    assert.equal(files.length, 1);
    const body = readFileSync(join(sb.pendingDir, files[0]), 'utf8');
    assert.match(body, /git\.uncle6\.me\/inkstone\/arcrun-collector/);
    assert.match(body, /main/);
    assert.match(body, /ship\.mjs/);
  } finally { sb.cleanup(); }
});

test('⑯ armCommand：閘自己給得出總管要貼的那一行（不必去翻文件）', () => {
  const cmd = armCommand(['git.uncle6.me/inkstone/arcrun-collector', 'github.com/youlinhsieh/arcrun-rag-bundles'], '/tmp/.main-push-ok');
  assert.ok(cmd.includes('git.uncle6.me/inkstone/arcrun-collector'));
  assert.ok(cmd.includes('github.com/youlinhsieh/arcrun-rag-bundles'));
  assert.ok(cmd.includes('/tmp/.main-push-ok'));
  // 預設就是殼層那道閘用的同一個檔——兩邊是同一道人閘，不是兩套規矩
  assert.equal(STAMP_PATH, '/tmp/.main-push-ok');
});

// ── preflight 的兩個原語（ship.mjs 開跑前一次問完、一次領走，靠的就是這兩支）──
test('⑰ unarmed：preflight 問「這趟的目的地哪些還沒按閘」——不消耗戳記', () => {
  const sb = sandbox();
  try {
    const dests = ['git.uncle6.me/leo/arcrun-rag-bundles-staging', 'git.uncle6.me/inkstone/arcrun-collector'];
    assert.deepEqual(unarmed(dests, { stampPath: sb.stampPath }), dests, '沒戳記 ⇒ 兩個都缺');
    sb.arm('git.uncle6.me/inkstone/arcrun-collector');
    assert.deepEqual(unarmed(dests, { stampPath: sb.stampPath }), [dests[0]], '按了一個 ⇒ 只剩另一個缺');
    assert.deepEqual(unarmed(dests, { stampPath: sb.stampPath }), [dests[0]], '問過不會把戳記吃掉');
    // 過期的戳記不算按過（與 assertPushAllowed 同一套判準）
    sb.arm('git.uncle6.me/inkstone/arcrun-collector', { ago: 16 * 60 });
    assert.deepEqual(unarmed(dests, { stampPath: sb.stampPath }), dests);
  } finally { sb.cleanup(); }
});

test('⑱ claimGrants：preflight 一次領走，之後每推一次 main 用掉一格', () => {
  const sb = sandbox();
  try {
    writeFileSync(sb.stampPath, 'git.uncle6.me/inkstone/arcrun-collector\ngithub.com/youlinhsieh/arcrun-rag-bundles\n', 'utf8');
    const grants = claimGrants(
      ['git.uncle6.me/inkstone/arcrun-collector', 'github.com/youlinhsieh/arcrun-rag-bundles', 'git.uncle6.me/leo/沒按過'],
      { stampPath: sb.stampPath });
    assert.equal(grants.get('git.uncle6.me/inkstone/arcrun-collector'), 1);
    assert.equal(grants.get('github.com/youlinhsieh/arcrun-rag-bundles'), 1);
    assert.equal(grants.has('git.uncle6.me/leo/沒按過'), false, '沒按過的不准自己長出來');
    assert.equal(existsSync(sb.stampPath), false, '領完戳記就用掉了');

    // 帶著授權推 main ⇒ 放行一次，第二次就沒了（單次用完即丟這條沒有鬆）
    assert.equal(push(sb, ['push', 'origin', 'main'], { grants }).allowed, true);
    assert.throws(() => push(sb, ['push', 'origin', 'main'], { grants }), MainPushBlocked);
  } finally { sb.cleanup(); }
});

// ── ⑦ 端到端：8/18 那個形狀本身 ────────────────────────────────────────────
//
// 🔴 這一格刻意跑**真的 git**，推的是一個本機 bare repo（不碰網路、不碰任何真的 main）。
//   要證明的不是「函式丟了例外」，是「**遠端真的沒有被改到**」——
//   8/18 的災難是遠端 main 上多了一筆會刪檔的 commit，那才是要擋住的東西。
test('⑦ 端到端：同步步驟推目的 repo 的 main——沒戳記 ⇒ 擋，且遠端一個 commit 都沒動', () => {
  const sb = sandbox();
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    // 假的「目的 repo」：本機 bare，先放一筆 main
    const bare = join(sb.dir, 'dest.git');
    const seed = join(sb.dir, 'seed');
    mkdirSync(bare); mkdirSync(seed);
    git(['init', '-q', '--bare', '-b', 'main'], bare);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'main.go'), 'package main\n');
    writeFileSync(join(seed, '.gitignore'), Array.from({ length: 22 }, (_, i) => `build-artifact-${i}/`).join('\n') + '\n');
    git(['add', '-A'], seed);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'], seed);
    git(['push', '-q', bare, 'HEAD:refs/heads/main'], seed);
    const before = git(['rev-parse', 'refs/heads/main'], bare);

    // 假的「來源 repo」：有東西可同步
    const src = join(sb.dir, 'src');
    mkdirSync(join(src, 'collector'), { recursive: true });
    git(['init', '-q', '-b', 'main'], src);
    writeFileSync(join(src, 'collector', 'a.go'), 'package a\n');
    git(['add', '-A'], src);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'src'], src);

    const call = () => syncSourceRepo({
      srcRoot: src, sourceDir: 'collector', workDir: join(sb.dir, 'work'),
      remoteUrl: bare, branch: 'main', message: 'sync: 演一次 8/18 那一筆',
      guardOpts: { stampPath: sb.stampPath, logPath: sb.logPath, pendingDir: sb.pendingDir },
    });

    assert.throws(call, MainPushBlocked, '沒戳記就推 main：必須被擋');
    assert.equal(git(['rev-parse', 'refs/heads/main'], bare), before, '被擋之後遠端 main 不准動一根寒毛');

    // 總管看過、按閘的指示補戳記 ⇒ 才推得進去
    sb.arm(normRemote(bare));
    const r = call();
    assert.equal(r.changed, true);
    assert.notEqual(git(['rev-parse', 'refs/heads/main'], bare), before, '補了戳記就該推得進去');
  } finally { sb.cleanup(); }
});
