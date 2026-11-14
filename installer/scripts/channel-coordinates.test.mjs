/**
 * channel-coordinates.test.mjs — 小幫手裡的 stage 座標，與出貨線登錄簿 `targets.stage` 必須是同一組
 * （inkstone/arcrun-rag#135，總管派工要求「最好有測試比對兩邊」）。
 *
 * 為什麼要比：出貨線把 DMG 與 manifest 放到哪裡，Arcrun Stage 就去哪裡找更新；
 * 兩邊任何一個網址漂開，stage 版就「檢查更新永遠查無新版」或「更新回 prod」，而且畫面上不會報錯。
 * Go 那一側的同款檢查在 collector/channel/channel_test.go（collector 單獨 checkout 時跳過，所以這裡在 repo 內也比一次）。
 *
 * 跑法：node --test installer/scripts/channel-coordinates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const reg = JSON.parse(read('../ship.targets.json'));
const src = read('../../collector/channel/channel.go');
const st = reg.targets.stage;
const trim = (u) => String(u).replace(/\/+$/, '');

// 取 channel.go 的 `stageInstallerBase`／`stageCypherURL` 兩個常數值
const konst = (name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
  assert.ok(m, `channel.go 找不到常數 ${name}`);
  return m[1];
};

test('stage 安裝器網址：小幫手 ＝ 登錄簿 dist.publicBase 的根 ＝ verify.installerBase', () => {
  const base = konst('stageInstallerBase');
  assert.equal(trim(base), trim(st.verify.installerBase));
  assert.equal(`${trim(base)}/dist`, trim(st.dist.publicBase));
});

test('stage 最新版 API ＝ 登錄簿 instanceUpdate.releaseApi', () => {
  assert.equal(`${trim(konst('stageInstallerBase'))}/api/latest`, st.instanceUpdate.releaseApi);
});

test('stage 預填連線 ＝ youlin 實例（instanceUpdate.cypherUrl 與 stageQueue.liveHealthUrl）', () => {
  const c = konst('stageCypherURL');
  assert.equal(trim(c), trim(st.instanceUpdate.cypherUrl));
  assert.equal(trim(c), trim(st.stageQueue.liveHealthUrl));
});

test('stage 的更新來源不准是 prod 的座標', () => {
  const stageBlock = src.slice(src.indexOf('var stage = Info{'));
  assert.ok(!/raw\.githubusercontent\.com|install\.arcrun\.dev/.test(stageBlock), 'stage 區塊出現 prod 座標');
});

test('登錄簿宣告 stage 與 prod 的 daemon 產物目錄不同（build 的 CHANNEL 產出 dist-stage）', () => {
  assert.equal(st.daemonDist, 'dist-stage');
  assert.equal(reg.targets.prod.daemonDist, 'dist');
  const build = read('../../collector/cmd/arcrun-app/build-dmg.sh');
  assert.match(build, /dist-stage/, 'build-dmg.sh 沒有 dist-stage 產出目錄');
});
