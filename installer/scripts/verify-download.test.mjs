/**
 * verify-download.test.mjs — 把「這道閘到底抓不抓得到」變成可重跑的客觀證據。
 *
 * 跑法：node --test installer/scripts/verify-download.test.mjs
 * （零依賴，node:test 內建；全程離線，fetch 用注入的替身）
 *
 * 為什麼需要（arcrun-rag#27）：這道閘 08-08 立的時候只在 stage 實跑過一次，
 * 而 stage 的釘點宿主（Gitea raw）什麼檔都送 ⇒ **prod 才會發作的那條路從沒被走過**，
 * 到 1.4.29 推 prod 才炸。原因不是寫的人不小心，是那時候**沒有辦法演練它**：
 * 要驗這道閘就得跑完整條會 push 會 deploy 的管線。⇒ 邏輯拆成純函式後就能反覆演練。
 *
 * 這裡要證明三件事（對應 issue 的驗收要求）：
 *   ① 正常情況（prod 真實形狀）→ 全過
 *   ② **故意把下載檔換成錯的 → 一定抓到**（閘沒有被改成擺設）
 *   ③ 「檢查器拿不到證據」與「證據顯示壞了」→ 輸出上分得出來，且前者不冒充後者
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkDaemonDownload, pinArtifactUrl } from './verify-download.mjs';

// ── 假資料：照 1.4.29 prod 的真實形狀（釘點是 jsDelivr @sha40，下載宿主是 raw.githubusercontent）
const SHA40 = '9135a3fa8f6398cc9be9d42a7e948678528c21d0';
const PIN = `https://cdn.jsdelivr.net/gh/youlinhsieh/arcrun-rag-bundles@${SHA40}`;
const FILE = 'daemon/Arcrun-win-v0.18.25.exe';
const VER = 'v0.18.25';
const GOOD = Buffer.from('這是 v0.18.25 的 exe 位元組');
const BAD = Buffer.from('這是別版／被掉包的 exe 位元組');
const shaOf = (b) => createHash('sha256').update(b).digest('hex');
const RAW = `https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/${SHA40}/${FILE}`;

/** 造一個假 fetch：routes = { <url 片段>: 200 的 Buffer | {status} }，比對用「開頭相符」。 */
function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const v = key === undefined ? { status: 404 } : routes[key];
    if (Buffer.isBuffer(v)) {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => v,
        headers: { get: () => `attachment; filename="Arcrun-win-${VER}.exe"` },
      };
    }
    return { ok: false, status: v.status, headers: { get: () => '' } };
  };
}

const baseArgs = {
  os: 'win', file: FILE, declaredSha256: shaOf(GOOD), daemonVersion: VER,
  pinUrl: PIN, downloadEndpoint: 'https://install.arcrun.dev/download/win', advertisedUrl: RAW,
};

test('釘點產物網址：prod 的 jsDelivr @sha 要換宿主到 raw.githubusercontent（jsDelivr 擋 .exe）', () => {
  assert.equal(pinArtifactUrl(PIN, FILE), RAW);
});

test('釘點產物網址：stage 的 Gitea raw root 直接用 base，不誤指去 prod 的 GitHub', () => {
  const stagePin = 'https://git.uncle6.me/Leo/arcrun-rag-bundles-staging/raw/commit/ab4ef01';
  assert.equal(pinArtifactUrl(stagePin, FILE), `${stagePin}/${FILE}`);
});

test('① 正常：下載到的＝宣告的＝釘點上的 ⇒ 全過，無 fail 無 warn', async () => {
  const r = await checkDaemonDownload({
    ...baseArgs,
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': GOOD, [RAW]: GOOD }),
  });
  assert.deepEqual(r.fails, []);
  assert.deepEqual(r.warns, []);
  assert.equal(r.corroboration, 'ok');
  assert.ok(r.lines.some((l) => l.includes('逐位元相同')), r.lines.join('\n'));
});

test('② 把下載檔換成錯的 ⇒ 一定抓到，而且明說是「證據顯示不一致」', async () => {
  const r = await checkDaemonDownload({
    ...baseArgs,
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': BAD, [RAW]: GOOD }),
  });
  assert.equal(r.corroboration, 'mismatch');
  // 兩條硬斷言都該叫：內容不符（vs 宣告）＋ 證據顯示不一致（vs 釘點實檔）
  assert.ok(r.fails.some((f) => f.includes('sha256 不符')), r.fails.join('\n'));
  assert.ok(r.fails.some((f) => f.includes('證據顯示不一致')), r.fails.join('\n'));
});

test('② 之二：釘點與下載都被換成同一個錯檔，仍被「宣告的 sha256」抓到（閘不是擺設）', async () => {
  const r = await checkDaemonDownload({
    ...baseArgs,
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': BAD, [RAW]: BAD }),
  });
  assert.equal(r.corroboration, 'ok');           // 佐證那條「相符」——但那不代表東西是對的
  assert.ok(r.fails.some((f) => f.includes('sha256 不符')), r.fails.join('\n'));
});

test('③ 釘點宿主 403（jsDelivr 擋 .exe 的原形）⇒ 報「無法取證」，不是「不一致」，且不誤殺', async () => {
  const r = await checkDaemonDownload({
    ...baseArgs,
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': GOOD, [RAW]: { status: 403 } }),
  });
  assert.equal(r.corroboration, 'unavailable');
  assert.deepEqual(r.fails, []);                                   // ← 1.4.29 就是死在這裡，現在不再誤紅
  assert.equal(r.warns.length, 1);
  assert.ok(r.warns[0].includes('無法取得'), r.warns[0]);
  const out = r.lines.join('\n');
  assert.ok(out.includes('無法取證'), out);
  assert.ok(!out.includes('不同'), '「拿不到證據」的輸出不得出現「不同」這種指控性字眼');
});

test('③ 之二：無法取證時，若下載內容本身是錯的，照樣被①抓到（沒有留下缺口）', async () => {
  const r = await checkDaemonDownload({
    ...baseArgs,
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': BAD, [RAW]: { status: 403 } }),
  });
  assert.equal(r.corroboration, 'unavailable');
  assert.ok(r.fails.some((f) => f.includes('sha256 不符')), r.fails.join('\n'));
});

test('② 來源跑到別條線（stage 的安裝器宣告 prod 的下載網址）⇒ 不抓檔就抓到', async () => {
  const stagePin = 'https://git.uncle6.me/Leo/arcrun-rag-bundles-staging/raw/commit/ab4ef01';
  const r = await checkDaemonDownload({
    ...baseArgs,
    pinUrl: stagePin,
    advertisedUrl: RAW, // ← 這才是病：stage 的安裝器卻指向 prod 的 GitHub
    fetchImpl: fakeFetch({
      'https://install.arcrun.dev/download/win': GOOD,
      [`${stagePin}/${FILE}`]: GOOD,
    }),
  });
  assert.ok(r.fails.some((f) => f.includes('下載來源不是這一條線的釘點')), r.fails.join('\n'));
});

test('② 釘子落後（安裝器還釘在舊 sha）⇒ 抓到', async () => {
  const oldUrl = RAW.replace(SHA40, '0000000000000000000000000000000000000000');
  const r = await checkDaemonDownload({
    ...baseArgs,
    advertisedUrl: oldUrl,
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': GOOD, [RAW]: GOOD }),
  });
  assert.ok(r.fails.some((f) => f.includes('下載來源不是這一條線的釘點')), r.fails.join('\n'));
});

test('下載鈕本身 502 ⇒ 直接斷在「使用者裝不了」，不繼續往下推論', async () => {
  const r = await checkDaemonDownload({
    ...baseArgs,
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': { status: 502 } }),
  });
  assert.equal(r.corroboration, 'not-reached');
  assert.ok(r.fails[0].includes('使用者裝不了'), r.fails.join('\n'));
});

test('檔名沒帶版本號 ⇒ 抓到（防「只重打了另一個平台」）', async () => {
  const r = await checkDaemonDownload({
    ...baseArgs,
    daemonVersion: 'v0.18.26',
    fetchImpl: fakeFetch({ 'https://install.arcrun.dev/download/win': GOOD, [RAW]: GOOD }),
  });
  assert.ok(r.fails.some((f) => f.includes('下載檔名沒帶 v0.18.26')), r.fails.join('\n'));
});
