import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkDaemonDownload } from './verify-download.mjs';

const BYTES = Buffer.from('dmg-bytes');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const BASE = 'https://stage.example.workers.dev/dist';
const FILE = 'daemon/Arcrun-1.0.0.dmg';
const fetchOk = async () => new Response(BYTES, { status: 200, headers: { 'content-disposition': 'attachment; filename="Arcrun-1.0.0.dmg"' } });

const run = (over) => checkDaemonDownload({
  os: 'mac', file: FILE, declaredSha256: SHA, daemonVersion: '1.0.0',
  pinUrl: 'https://git.uncle6.me/inkstone/arcrun-rag-bundles-staging/raw/commit/abc1234',
  downloadEndpoint: 'https://stage.example.workers.dev/download/mac',
  advertisedUrl: `${BASE}/${FILE}`, distBase: BASE, fetchImpl: fetchOk, ...over,
});

test('#266 dist：安裝器宣告的網址＝R2 網址 ⇒ 來源對，無 fail', async () => {
  const r = await run();
  assert.deepEqual(r.fails, []);
  assert.ok(r.lines.some((l) => l.includes(`${BASE}/${FILE}`)));
});

test('#266 dist：安裝器還宣告 Gitea raw 的舊網址 ⇒ 來源不對，硬斷', async () => {
  const r = await run({ advertisedUrl: `https://git.uncle6.me/inkstone/arcrun-rag-bundles-staging/raw/commit/abc1234/${FILE}` });
  assert.ok(r.fails.some((f) => f.includes('下載來源不是這一條線的釘點')));
});

test('#266 沒有 distBase（prod）：行為不變，仍由釘點 commit 算期望網址', async () => {
  const pin = 'https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@aa763acd963d468a5da5ece746986ef61e26ba26';
  const r = await run({ distBase: undefined, pinUrl: pin,
    advertisedUrl: `https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/aa763acd963d468a5da5ece746986ef61e26ba26/${FILE}` });
  assert.deepEqual(r.fails, []);
});

test('#266 dist：下載到的位元組 ≠ manifest 宣告的 sha ⇒ 硬斷', async () => {
  const r = await run({ declaredSha256: 'f'.repeat(64) });
  assert.ok(r.fails.some((f) => f.includes('sha256 不符')));
});
