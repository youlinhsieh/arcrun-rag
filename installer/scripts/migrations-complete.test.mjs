/**
 * migrations-complete.test.mjs — **安裝器帶出去的 migration 必須是全部**。
 *
 * 跑法：node --test installer/scripts/migrations-complete.test.mjs
 *
 * ── 為什麼有這支（2026-08-25 實錄，inkstone/Arcrun#159）────────────────────
 * leo 在自己的正式實例登不進去，錯誤是 `GET /records/… → 500`，
 * 而 `/health` 照回 `ok: true` ⇒ **表面上服務活得好好的**。
 *
 * 根因：`compile-migrations.mjs` 裡一行寫死的清單
 *   `const files = ['0001_base.sql', '0002_credentials.sql'];`
 * 它從 0002 那天起沒再動過 ⇒ **0003～0007 從來沒有被打進任何一次出貨**
 * ⇒ 每個用一鍵安裝的人，資料層永遠停在 0002；worker 卻一路更新到最新，
 *   讀的是 v7 才有的 `src_id`／`rel_id`／`dst_id` ⇒ `no such column` ⇒ 整庫 500。
 *
 * leo 原話：「**任何人安裝了下一版都要有前一版的遷移，這是非常大的失誤，一定不止我**」
 *          「**更新沒有政策？根本亂搞**」
 *          「**migration 應該要每一版都帶著，這不是正常的？如何確定？如何以後不犯？**」
 *
 * 🔴 **這支就是「如何以後不犯」的那一格。** 三層閘（動態收檔／輸出位置／指紋含它）
 *   都可能被下一個人改回去；只有一支會紅的測試，才會在改回去的當下說話。
 *
 * ── 它守什麼 ──────────────────────────────────────────────────────────
 *  ① 安裝器帶的 `source` ＝ `kbdb/migrations/` 底下**全部** `NNNN_*.sql`（不多不少）
 *  ② 編號連續（缺號＝某個世代永遠補不上，正是本次事故的形狀）
 *  ③ `worker.js` 真的 import 我們寫的那一份（2026-08-25 的第二層：
 *     編譯輸出寫到 `installer/src/migrations.json`，而 worker 讀
 *     `oauth-prototype/migrations.json` 的手抄舊副本 ⇒ 兩份並存必然漂移、且零症狀）
 *  ④ 最後一支 migration 的**特徵語句**真的在 statements 裡
 *     ——只比檔名不夠：`source` 對了但 `statements` 是舊的照樣會出事
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const installerDir = join(here, '..', 'oauth-prototype');

function findArcrunRoot() {
  if (process.env.ARCRUN_REPO_ROOT) return process.env.ARCRUN_REPO_ROOT;
  for (const c of [
    join(here, '..', '..', '..', '..', 'matrix', 'arcrun'),
    join(here, '..', '..', '..', 'Arcrun'),
    join(here, '..', '..', '..', '..', 'Arcrun'),
  ]) {
    if (existsSync(join(c, 'kbdb', 'migrations'))) return c;
  }
  return null;
}

const root = findArcrunRoot();
const shipped = JSON.parse(readFileSync(join(installerDir, 'migrations.json'), 'utf8'));

test('③ worker.js 真的 import 我們寫的那一份 migrations.json', () => {
  const src = readFileSync(join(installerDir, 'worker.js'), 'utf8');
  assert.match(
    src,
    /import\s+MIGRATIONS\s+from\s+'\.\/migrations\.json'/,
    'worker.js 沒有從同目錄 import migrations.json——編譯輸出與它實際讀的位置對不上，' +
      '那正是 2026-08-25 漂掉的方式（一份手抄舊副本上線了幾個月沒人發現）',
  );
});

test('② 安裝器帶的 migration 編號連續', () => {
  const nums = (shipped.source ?? []).map((f) => Number(f.slice(0, 4)));
  assert.ok(nums.length > 0, 'migrations.json 的 source 是空的');
  nums.forEach((n, i) => {
    assert.equal(n, i + 1, `編號不連續：第 ${i + 1} 支是 ${shipped.source[i]}——缺號代表某個世代永遠補不上`);
  });
});

test('① 安裝器帶的 ＝ migrations/ 底下全部（少一支就是這次的事故重演）', (t) => {
  if (!root) return t.skip('找不到 Arcrun repo（設 ARCRUN_REPO_ROOT 可跑這一題）');
  const onDisk = readdirSync(join(root, 'kbdb', 'migrations'))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const missing = onDisk.filter((f) => !(shipped.source ?? []).includes(f));
  const extra = (shipped.source ?? []).filter((f) => !onDisk.includes(f));
  assert.deepEqual(
    missing,
    [],
    `安裝器少帶了 ${missing.length} 支：${missing.join('、')}——` +
      '用戶的資料層會停在舊世代，而 worker 是新的（inkstone/Arcrun#159）',
  );
  assert.deepEqual(extra, [], `安裝器帶了目錄裡沒有的：${extra.join('、')}`);
});

test('④ 最新那支的特徵語句真的在 statements 裡（只比檔名不夠）', (t) => {
  if (!root) return t.skip('找不到 Arcrun repo');
  const onDisk = readdirSync(join(root, 'kbdb', 'migrations'))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const last = onDisk[onDisk.length - 1];
  const lastSql = readFileSync(join(root, 'kbdb', 'migrations', last), 'utf8');
  // 取那支 migration 裡第一個 CREATE/ALTER 的目標當特徵——它一定會出現在切好的句子裡
  const m = lastSql.match(/^\s*(ALTER TABLE \w+ ADD COLUMN \w+|CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? \w+)/mi);
  assert.ok(m, `${last} 裡找不到可當特徵的 ALTER／CREATE INDEX——請更新本測試的取樣方式`);
  const needle = m[1].replace(/\s+/g, ' ').trim();
  const hit = (shipped.statements ?? []).some((s) => s.replace(/\s+/g, ' ').includes(needle));
  assert.ok(
    hit,
    `${last} 的「${needle}」不在 statements 裡——` +
      'source 對了但內容是舊的，照樣會讓用戶的資料層停在舊世代',
  );
});

test('切句法的前提仍成立：字串常值裡沒有 ; 或 --', (t) => {
  if (!root) return t.skip('找不到 Arcrun repo');
  const dir = join(root, 'kbdb', 'migrations');
  for (const f of readdirSync(dir).filter((x) => /^\d{4}_.+\.sql$/.test(x))) {
    for (const lit of readFileSync(join(dir, f), 'utf8').match(/'[^']*'/g) ?? []) {
      assert.ok(
        !lit.includes(';') && !lit.includes('--'),
        `${f} 的字串常值 ${lit.slice(0, 40)} 含 ; 或 --，compile-migrations 的切句法會切錯`,
      );
    }
  }
});
