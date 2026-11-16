/**
 * github-push-probe.test.mjs — inkstone/arcrun-rag#344
 * 出貨線開跑前的 GitHub 推送權探測：proxy 拒絕要分類對、補法要指到 add_repo、
 * 推得動要放行，而且 dry-run 不能真的改到遠端。
 *
 * 跑法：node --test installer/scripts/github-push-probe.test.mjs
 * （用本機 bare repo，不碰任何真的 GitHub repo）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  githubSlugOf, httpsUrlOf, classifyPushFailure, probeGithubPush, pushProbeError, PROBE_REF,
} from './github-push-probe.mjs';

// 2026-11-15 1.4.208 第 15 站的原文（inkstone/InkStoneCo#308 c1794753635832183）
const PROXY_DENIED = 'remote: access denied by the git proxy: youlinhsieh/arcrun-rag-bundles is not in this '
  + "session's authorized repository set, so the proxy will not inject a credential for it. To fix, add the "
  + "repository to the session's sources.\nfatal: unable to access 'https://github.com/youlinhsieh/arcrun-rag-bundles/': The requested URL returned error: 403";

test('githubSlugOf：登錄簿的三種寫法都認得，非 GitHub 回 null', () => {
  assert.equal(githubSlugOf('github.com/youlinhsieh/arcrun-rag-bundles'), 'youlinhsieh/arcrun-rag-bundles');
  assert.equal(githubSlugOf('https://github.com/youlinhsieh/arcrun-rag.git'), 'youlinhsieh/arcrun-rag');
  assert.equal(githubSlugOf('https://x:tok@github.com/o/r'), 'o/r');
  assert.equal(githubSlugOf('https://51a01bfa.artifacts.cloudflare.net/git/InkStoneCo/arcrun-rag-bundles-stage.git'), null);
  assert.equal(githubSlugOf('local-selftest'), null);
  assert.equal(httpsUrlOf('github.com/o/r'), 'https://github.com/o/r');
  assert.equal(httpsUrlOf('https://github.com/o/r.git'), 'https://github.com/o/r.git');
});

test('proxy 拒絕（1.4.208 原文）→ proxy-unauthorized，補法是 add_repo，明講不是要 leo 准許', () => {
  const c = classifyPushFailure(PROXY_DENIED, 'youlinhsieh/arcrun-rag-bundles');
  assert.equal(c.kind, 'proxy-unauthorized');
  const text = c.remedy.join('\n');
  assert.match(text, /add_repo/);
  assert.match(text, /owner="youlinhsieh", repo="arcrun-rag-bundles", access="push"/);
  assert.match(text, /不是要 leo 准許/);
  assert.match(text, /不要拿環境變數裡的 GitHub token/);
});

test('其他失敗各自分類', () => {
  assert.equal(classifyPushFailure('fatal: Authentication failed for', 'o/r').kind, 'auth');
  assert.equal(classifyPushFailure('remote: Repository not found.', 'o/r').kind, 'not-found');
  assert.equal(classifyPushFailure('Could not resolve host: github.com', 'o/r').kind, 'network');
  assert.equal(classifyPushFailure('something odd', 'o/r').kind, 'other');
});

test('probeGithubPush：送 dry-run、遮掉輸出裡的帳密與標頭', () => {
  let seen = null;
  const r = probeGithubPush({
    remote: 'origin', slug: 'o/r', cwd: '/x', env: {},
    run: (args) => { seen = args; return { status: 128, stdout: '', stderr: 'Authorization: Basic c2VjcmV0 https://u:tok123@github.com/o/r\n' + PROXY_DENIED }; },
  });
  assert.deepEqual(seen.slice(0, 3), ['push', '--dry-run', '--porcelain']);
  assert.equal(seen[4], `HEAD:${PROBE_REF}`);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'proxy-unauthorized');
  const all = r.detail.join('\n') + pushProbeError([r]).message;
  assert.doesNotMatch(all, /tok123|c2VjcmV0/);
  assert.match(pushProbeError([r]).message, /第一站就擋/);
});

test('真的 git：推得動就放行，而且 dry-run 不在遠端留下任何 ref', () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-push-probe-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', bare);
  const ok = probeGithubPush({ remote: 'origin', slug: 'o/r', cwd: work });
  assert.equal(ok.ok, true);
  assert.equal(git(bare, 'for-each-ref').trim(), '', 'dry-run 不可以在遠端建出任何 ref');

  const bad = probeGithubPush({ remote: join(root, 'nope.git'), slug: 'o/r', cwd: work });
  assert.equal(bad.ok, false);
});
