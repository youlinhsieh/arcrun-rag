// ship-github-release.mjs ＋ workflows/ship_github_release.json 的測試（inkstone/arcrun-rag#298）
// 工作流裡的 code 節點是純函式（吃 input、回物件）⇒ 直接從 JSON 取出來在這裡跑，不必連實例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  armEvidenceFrom, createReleaseViaArcrun, uploadAssetViaArcrun, WORKFLOW_NAME,
} from './ship-github-release.mjs';

const WF = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workflows', 'ship_github_release.json'), 'utf8'));
const node = (id) => WF.graph.nodes.find((n) => n.id === id);
const runCode = (id, input) => new Function('input', node(id).data.code)(input);

const ARM = { by: 'Leo', version: '1.4.141', ref: 'ahub://ns/inkstone/Arcrun/issues/345#issuecomment-1794223856450939' };
const SHA = 'a'.repeat(40);
const create = (o = {}) => ({
  op: 'create_release', ship_version: '1.4.141', arm: ARM, repo_slug: 'youlinhsieh/arcrun-rag',
  tag: '1.4.141', name: 'Arcrun RAG 1.4.141', body: '## 1.4.141\n內文含 "引號" 與 {大括號}', target_commitish: SHA, ...o,
});

test('工作流定義：沒有任何 token 真身，金鑰只寫名字（D36）', () => {
  const s = JSON.stringify(WF);
  assert.match(s, /\{\{credential\.github_release_token\}\}/);
  assert.doesNotMatch(s, /ghp_|github_pat_|gho_/);
  assert.equal(WF.name, WORKFLOW_NAME);
});

test('工作流定義：ARM 閘在 http_request 之前，且 false 路不碰 GitHub', () => {
  const e = WF.graph.edges;
  assert.ok(e.some((x) => x.from === 'gate' && x.to === 'armed'));
  assert.ok(e.some((x) => x.from === 'armed' && x.to === 'send' && x.type === 'ON_TRUE'));
  assert.ok(e.some((x) => x.from === 'armed' && x.to === 'refused' && x.type === 'ON_FALSE'));
  assert.ok(!e.some((x) => x.to === 'send' && x.from !== 'armed'), 'send 只能從 armed 的 true 路進來');
});

test('gate：證據齊全 → go=yes，建 release 的請求只打 api.github.com 的 youlinhsieh repo', () => {
  const g = runCode('gate', create());
  assert.equal(g.go, 'yes'); assert.deepEqual(g.errors, []);
  assert.equal(g.url, 'https://api.github.com/repos/youlinhsieh/arcrun-rag/releases');
  assert.deepEqual(JSON.parse(g.body), { tag_name: '1.4.141', name: 'Arcrun RAG 1.4.141', body: '## 1.4.141\n內文含 "引號" 與 {大括號}', target_commitish: SHA });
});

test('gate：沒有 ARM／不是 Leo／版本對不上／沒有出處 ⇒ 一律 go=no，不產出請求', () => {
  for (const [label, o] of [
    ['沒有 arm', { arm: undefined }],
    ['不是 Leo', { arm: { ...ARM, by: 'claude-ai' } }],
    ['版本對不上', { arm: { ...ARM, version: '1.4.140' } }],
    ['沒有出處', { arm: { ...ARM, ref: 'ahub://x/issues/1' } }],
    ['ship_version 空', { ship_version: '' }],
  ]) {
    const g = runCode('gate', create(o));
    assert.equal(g.go, 'no', label); assert.ok(g.errors.length, label);
    assert.equal(g.url, '', label); assert.equal(g.body, '', label);
  }
});

test('gate：版本號前導 v 不影響比對；其他 repo／op／壞 tag／壞 sha 都擋', () => {
  assert.equal(runCode('gate', create({ ship_version: 'v1.4.141' })).go, 'yes');
  for (const o of [
    { repo_slug: 'evil/arcrun-rag' }, { repo_slug: 'youlinhsieh/a/../b' }, { op: 'delete_release' },
    { tag: 'a b' }, { target_commitish: 'main' }, { name: '' },
  ]) assert.equal(runCode('gate', create(o)).go, 'no', JSON.stringify(o));
});

test('gate：掛成品只收文字、只打 uploads.github.com、檔名被編碼', () => {
  const up = (o = {}) => ({ op: 'upload_asset', ship_version: '1.4.141', arm: ARM, repo_slug: 'youlinhsieh/arcrun-rag',
    release_id: '123', asset_name: 'manifest.json', asset_content_type: 'application/json', asset_text: '{"a":1}', ...o });
  const g = runCode('gate', up());
  assert.equal(g.go, 'yes');
  assert.equal(g.url, 'https://uploads.github.com/repos/youlinhsieh/arcrun-rag/releases/123/assets?name=manifest.json');
  assert.equal(g.body, '{"a":1}'); assert.equal(g.content_type, 'application/json');
  for (const o of [{ asset_content_type: 'application/octet-stream' }, { release_id: '12/../3' }, { asset_name: 'a b.json' },
    { asset_text: '' }, { asset_text: 'x'.repeat(1500001) }, { arm: undefined }]) {
    assert.equal(runCode('gate', up(o)).go, 'no', JSON.stringify(o).slice(0, 60));
  }
});

test('gate：沒帶的欄位（引擎留下的 {{…}} 字面）當作空白，不當成值', () => {
  const g = runCode('gate', create({ tag: '{{input.tag}}' }));
  assert.equal(g.go, 'no');
});

test('shape：成功／失敗／回應不是 JSON 都轉成 contract v1 的 ok 判定', () => {
  const ok = runCode('shape_ok', { op: 'create_release', send: { success: true, data: { body: JSON.stringify({ id: 9, html_url: 'https://github.com/x/y/releases/tag/1', upload_url: 'u', tag_name: '1' }) } } });
  assert.equal(ok.contract, 'v1'); assert.equal(ok.ok, true); assert.equal(ok.release.id, 9);
  const bad = runCode('shape_fail', { op: 'create_release', send: { success: false, error: 'HTTP 422', data: { body: '{"message":"Validation Failed"}' } } });
  assert.equal(bad.ok, false); assert.match(bad.http_error, /422/);
  assert.equal(runCode('shape_fail', { op: 'create_release', send: undefined }).ok, false);
  assert.equal(runCode('shape_ok', { op: 'create_release', send: { success: true, data: { body: '<html>' } } }).ok, false);
  const noId = runCode('shape_ok', { op: 'upload_asset', send: { success: true, data: { body: '{"name":"a"}' } } });
  assert.equal(noId.ok, false);
});

test('refused：回 ok=false、refused=true 並帶出原因', () => {
  const r = runCode('refused', { errors: ['x'] });
  assert.deepEqual(r, { contract: 'v1', ok: false, refused: true, errors: ['x'] });
});

// ── 呼叫端 ───────────────────────────────────────────────────────────────
const fakeRun = (reply, calls = []) => async (name, input) => { calls.push({ name, input }); return reply; };

test('armEvidenceFrom：只有真的指得到簽核留言才有證據；備援簽核（無留言）＝null', () => {
  const r = { armed: true, ticketUrl: 'ahub://ns/inkstone/Arcrun/issues/345', comment: { id: 77, user: { login: 'Leo' } } };
  assert.deepEqual(armEvidenceFrom(r, '1.4.141'), { by: 'Leo', version: '1.4.141', ref: 'ahub://ns/inkstone/Arcrun/issues/345#issuecomment-77' });
  assert.equal(armEvidenceFrom({ armed: true, comment: null }, '1'), null);
  assert.equal(armEvidenceFrom(null, '1'), null);
});

test('createReleaseViaArcrun：沒有 ARM 證據 ⇒ 連工作流都不呼叫', async () => {
  const calls = [];
  await assert.rejects(() => createReleaseViaArcrun({ runWorkflow: fakeRun({}, calls), repoSlug: 'youlinhsieh/arcrun-rag', tag: '1', name: 'n', body: 'b', targetCommitish: SHA, shipVersion: '1', arm: null }), /ARM/);
  assert.equal(calls.length, 0);
});

test('createReleaseViaArcrun：帶著 ARM 呼叫；成功回 release；拒絕／GitHub 拒收／舊 contract 各有清楚訊息', async () => {
  const calls = [];
  const rel = await createReleaseViaArcrun({ runWorkflow: fakeRun({ contract: 'v1', ok: true, release: { id: 5, html_url: 'h' } }, calls), repoSlug: 'youlinhsieh/arcrun-rag', tag: '1.4.141', name: 'n', body: 'b', targetCommitish: SHA, shipVersion: '1.4.141', arm: ARM });
  assert.equal(rel.id, 5);
  assert.equal(calls[0].name, 'ship_github_release'); assert.deepEqual(calls[0].input.arm, ARM); assert.equal(calls[0].input.op, 'create_release');
  const go = (reply) => createReleaseViaArcrun({ runWorkflow: fakeRun(reply), repoSlug: 'youlinhsieh/arcrun-rag', tag: '1', name: 'n', body: 'b', targetCommitish: SHA, shipVersion: '1.4.141', arm: ARM });
  await assert.rejects(() => go({ contract: 'v1', ok: false, refused: true, errors: ['版本對不上'] }), /拒絕.*版本對不上/s);
  await assert.rejects(() => go({ contract: 'v1', ok: false, http_error: 'HTTP 422' }), /GitHub 沒有接受.*422/);
  await assert.rejects(() => go({ ok: true, release: { id: 1 } }), /不是 contract v1.*部署/s);
  await assert.rejects(() => go({ contract: 'v1', ok: true }), /沒有 release id/);
});

test('uploadAssetViaArcrun：文字檔走工作流；二進位／大檔／非 UTF-8 一律擋並說去哪補', async () => {
  const calls = [];
  const a = await uploadAssetViaArcrun({ runWorkflow: fakeRun({ contract: 'v1', ok: true, asset: { id: 3, name: 'manifest.json' } }, calls), repoSlug: 'youlinhsieh/arcrun-rag', releaseId: 5, name: 'manifest.json', data: Buffer.from('{"a":1}'), shipVersion: '1.4.141', arm: ARM });
  assert.equal(a.id, 3); assert.equal(calls[0].input.release_id, '5'); assert.equal(calls[0].input.asset_text, '{"a":1}');
  const bad = (name, data) => uploadAssetViaArcrun({ runWorkflow: fakeRun({}), repoSlug: 'youlinhsieh/arcrun-port', releaseId: 5, name, data, shipVersion: '1', arm: ARM });
  await assert.rejects(() => bad('Arcrun-0.18.1.dmg', Buffer.from('x')), /不能經工作流掛/);
  await assert.rejects(() => bad('manifest.json', Buffer.from([0xff, 0xfe, 0x00])), /不能經工作流掛/);
  await assert.rejects(() => bad('manifest.json', Buffer.alloc(1_600_000, 97)), /不能經工作流掛/);
});
