/**
 * bundle-sync.test.mjs — inkstone/arcrun-rag#363 第 2 處：本機 bundle clone 落後遠端時，preflight 先 fast-forward。
 * 用真的臨時 git repo（一個「遠端」＋一個 clone）演練，不用假 git。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBundleClone } from './bundle-sync.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: ENV }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bundle-sync-'));
  const remote = join(root, 'remote.git'); const work = join(root, 'work'); const clone = join(root, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work], { env: ENV, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'main');
  g(work, 'commit', '-q', '--allow-empty', '-m', 'c0'); g(work, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, clone], { env: ENV, stdio: 'ignore' });
  const pushMore = (n) => { for (let i = 0; i < n; i++) g(work, 'commit', '-q', '--allow-empty', '-m', `r${i}`); g(work, 'push', '-q', 'origin', 'main'); };
  return { clone, work, pushMore, remote };
}

test('落後遠端（1.4.247 的情形）：fast-forward 追上，之後 push 不會 non-fast-forward', () => {
  const { clone, pushMore, remote } = setup();
  pushMore(36);
  const r = syncBundleClone({ dir: clone, branch: 'main' });
  assert.equal(r.status, 'fast-forwarded'); assert.equal(r.behind, 36);
  assert.equal(g(clone, 'rev-parse', 'HEAD'), g(clone, 'rev-parse', 'origin/main'));
  g(clone, 'commit', '-q', '--allow-empty', '-m', 'ship');
  g(clone, 'push', '-q', 'origin', 'main'); // 追上之後這一步不再被擋
  assert.equal(g(remote, 'rev-parse', 'main'), g(clone, 'rev-parse', 'HEAD'));
});

test('已同步／只有本機領先：不動', () => {
  const { clone } = setup();
  assert.equal(syncBundleClone({ dir: clone, branch: 'main' }).status, 'current');
  g(clone, 'commit', '-q', '--allow-empty', '-m', 'local');
  const before = g(clone, 'rev-parse', 'HEAD');
  const r = syncBundleClone({ dir: clone, branch: 'main' });
  assert.equal(r.status, 'ahead'); assert.equal(g(clone, 'rev-parse', 'HEAD'), before);
});

test('分叉（本機有沒推的、遠端也有新的）：擋下並講清楚，絕不改寫本機歷史', () => {
  const { clone, pushMore } = setup();
  g(clone, 'commit', '-q', '--allow-empty', '-m', 'local-only');
  const before = g(clone, 'rev-parse', 'HEAD');
  pushMore(2);
  assert.throws(() => syncBundleClone({ dir: clone, branch: 'main' }), /分叉.*1 筆沒推出.*2 筆本機沒有/s);
  assert.equal(g(clone, 'rev-parse', 'HEAD'), before, '本機 commit 一個都不能被動到');
});

test('fetch 不到遠端：不擋、明講沒追上', () => {
  const { clone } = setup();
  g(clone, 'remote', 'set-url', 'origin', '/nonexistent/none.git');
  const r = syncBundleClone({ dir: clone, branch: 'main' });
  assert.equal(r.status, 'fetch-failed'); assert.match(r.message, /沒法先追上遠端/);
});

test('接線：ship.mjs 的 preflight 真的呼叫它（拿掉這行這支測試就紅）', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ship.mjs'), 'utf8');
  assert.match(src, /import \{ syncBundleClone \} from '\.\/bundle-sync\.mjs'/);
  assert.match(src, /syncBundleClone\(\{ dir: ctx\.bundlesDir, branch: T\.bundles\.branch \}\)/);
  // 且必須在「驗 origin 與登錄簿相符」之後、「(c2) 記下動手之前的版本」之前
  const iOrigin = src.indexOf('bundle repo 指到**別的地方**'); const iSync = src.indexOf('syncBundleClone({ dir'); const iC2 = src.indexOf('(c2) 記下');
  assert.ok(iOrigin < iSync && iSync < iC2, 'syncBundleClone 的位置要在 origin 核對之後、(c2) 之前');
});
