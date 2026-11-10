import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShipPushRemote, buildShipPush } from './ship-branch-push.mjs';

const ART = 'https://51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/InkStoneCo/arcrun-rag.git';
const OLD = 'https://git.uncle6.me/inkstone/arcrun-rag.git';
const of = (map) => (n) => map[n] || null;

test('新容器只有 origin（Artifacts）⇒ 不必手補 gitea remote', () => {
  assert.deepEqual(resolveShipPushRemote(of({ origin: ART }), {}), { remote: 'origin', url: ART });
});
test('舊容器手補的 gitea remote（Artifacts）仍相容', () => {
  assert.equal(resolveShipPushRemote(of({ origin: 'https://example.com/x.git', gitea: ART }), {}).remote, 'gitea');
});
test('SHIP_PUSH_REMOTE 指名優先', () => {
  assert.equal(resolveShipPushRemote(of({ origin: ART, mine: ART }), { SHIP_PUSH_REMOTE: 'mine' }).remote, 'mine');
});
test('remote 指到退役舊 Gitea ⇒ 丟錯，不寫入', () => {
  assert.throws(() => resolveShipPushRemote(of({ origin: OLD }), {}), /已退役/);
});
test('沒有任何 Artifacts remote ⇒ 丟錯並說明', () => {
  assert.throws(() => resolveShipPushRemote(of({}), {}), /找不到可以交出貨分支/);
});
test('buildShipPush：token 不進網址／argv、設 allowincompletepush', () => {
  const p = buildShipPush({ branch: 'feat/x', remote: 'origin', url: ART, srcRoot: '/r', env: { ARTIFACTS_CREDENTIAL_HELPER: '/h.sh', HOME: '/home/u' } });
  assert.deepEqual(p.args.slice(-3), ['push', 'origin', 'HEAD:refs/heads/feat/x']);
  assert.ok(p.args.includes('lfs.allowincompletepush=true'));
  assert.ok(p.args.some((a) => a === 'credential.helper='));
  assert.ok(!p.args.join(' ').includes('@'));
});
