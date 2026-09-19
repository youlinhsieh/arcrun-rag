#!/usr/bin/env node
/**
 * compile-migrations.mjs — 打包期把 Arcrun kbdb 的**全部** D1 migration 預切成
 * 「單語句陣列」→ installer/src/migrations.json。
 *
 * 🔴 2026-08-25（leo 的正式實例當場登不進去，inkstone/Arcrun#159）：
 *   這裡原本是一行寫死的清單 `const files = ['0001_base.sql', '0002_credentials.sql']`。
 *   它從 0002 那天起就沒再動過 ⇒ **0003～0007 從來沒有被打進任何一次出貨**
 *   ⇒ 每一個用一鍵安裝的人，資料層永遠停在 0002 的世界；
 *     而 worker 一路更新到最新，讀的是 v7 才有的 `src_id`／`rel_id`／`dst_id`
 *     ⇒ `no such column` ⇒ 整個知識庫 500，而 `/health` 照回 `ok: true`。
 *   leo 原話：「任何人安裝了下一版都要有前一版的遷移，這是非常大的失誤，一定不止我」。
 *
 *   ⇒ **不准再有任何寫死的清單。** 目錄裡有幾支就收幾支，依檔名排序（migration 的順序
 *     就是檔名的順序）。少收一支就當場中止，不安靜跳過——安靜跳過正是這次的病。
 *
 * 為何要預切：安裝器 worker 走自己的 D1 binding（TEST_D1）跑 migration（設計指定的唯一
 *   「安裝器直碰 D1」例外＝建表）。D1 binding 的 prepare().run() 一次一句，不吃註解/多語句檔；
 *   故此處剝 `--` 註解、依 `;` 切句，worker 端逐句 run（全 IF NOT EXISTS / INSERT OR IGNORE → 冪等）。
 *
 * 🔴 2026-09-19（inkstone/Arcrun#223 c10032，出貨擋點）：
 *   原本「照分號切句」在 0010 這支帶 `CREATE TRIGGER ... BEGIN ... END;` 的 migration 上會
 *   把觸發器身體攔腰切斷（trigger 內部本來就有分號）⇒ 用戶按「更新」→ 打出殘缺 SQL → 失敗。
 *   查過 `git log --all -- installer/scripts/compile-migrations.mjs`：這個檔只修過「清單
 *   寫死」那次（cdc0f1b），trigger 切句從沒被修過——不是重複勞動。
 *   改用 BEGIN/END 深度計數（與 kbdb/tests/search-fts-cutoff-safety.test.ts 的 splitSql 同一種
 *   演算法，Arcrun repo PR #227 已驗證過）：只在深度 0 時的 `;` 才算句界；`stripLineComment`
 *   順帶改成尊重字串常值（原本逐行 `--.*$` 剝註解不管有沒有在引號內，字串常值裡的 `--`
 *   會被誤剝——本檔案 migrations 目前沒有這種常值，但 assertSafeToSplit 仍留著防未來新增）。
 *
 * 來源：ARCRUN_REPO_ROOT/kbdb/migrations/*.sql（與 deploy.ts applyD1Migration 同源，不重寫 schema）。
 * 用法：ARCRUN_REPO_ROOT=/path/to/Arcrun node installer/scripts/compile-migrations.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 🔴 2026-08-25：這裡原本寫到 `installer/src/migrations.json`，**而 worker.js import 的是
//   `installer/oauth-prototype/migrations.json`** ⇒ 編譯出來的東西寫到一個沒人讀的檔，
//   真正上線的是一份 2026-08-05 手抄的舊副本（16 句 vs 應有的 41 句）。
//   兩份同名檔並存 ⇒ 必然漂移，而且漂移時**完全沒有症狀**。
//   ⇒ 只留 worker 真的 import 的那一份，並在下面機械複驗它確實被 import。
const outPath = join(here, '..', 'oauth-prototype', 'migrations.json');

function findArcrunRoot() {
  if (process.env.ARCRUN_REPO_ROOT) return process.env.ARCRUN_REPO_ROOT;
  // 常見相對位置：arcrun-rag 與 Arcrun 並列
  for (const c of [join(here, '..', '..', '..', 'Arcrun'), join(here, '..', '..', '..', '..', 'Arcrun')]) {
    if (existsSync(join(c, 'kbdb', 'migrations'))) return c;
  }
  throw new Error('找不到 Arcrun repo；請設 ARCRUN_REPO_ROOT');
}

/** 剝行尾/整行 -- 註解，尊重單引號字串常值（常值裡的 -- 不算註解起點）。 */
function stripLineComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "'") inQuote = !inQuote;
    else if (!inQuote && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i);
  }
  return line;
}

/** 剝註解後依「深度 0 的 `;`」切句，去空白句——`BEGIN…END` 之間（trigger／view 身體）
 * 深度 >0，內部的 `;` 不算句界，整段連 END 一起算同一句。
 * 前提：字串常值裡沒有 `;` 或 `--`。**這個前提每次打包都機械複驗**（見下方 assertSafeToSplit），
 * 不再靠「已確認」這種會過期的註解——新增 migration 的人不會來讀這一行。
 * 演算法與 Arcrun repo `kbdb/tests/search-fts-cutoff-safety.test.ts` 的 splitSql 同源
 * （inkstone/Arcrun#223 c10032，兩邊各自套自己 migration 的路都要用同一種切法）。 */
function splitStatements(sql) {
  const body = sql
    .split('\n')
    .map(stripLineComment)
    .filter((l) => l.trim() !== '')
    .join('\n');
  const stmts = [];
  let depth = 0;
  let start = 0;
  const boundary = /\bBEGIN\b|\bEND\b|;/gi;
  for (const m of body.matchAll(boundary)) {
    const tok = m[0].toUpperCase();
    if (tok === 'BEGIN') { depth++; continue; }
    if (tok === 'END') { if (depth > 0) depth--; continue; }
    if (depth === 0) {
      const piece = body.slice(start, m.index).trim();
      if (piece) stmts.push(piece);
      start = (m.index ?? 0) + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) stmts.push(tail);
  return stmts;
}

/** 切句法的前提：字串常值裡不能有 `;` 或 `--`。有就中止——寧可打不出來，不要打出壞的。 */
function assertSafeToSplit(file, sql) {
  for (const lit of sql.match(/'[^']*'/g) ?? []) {
    if (lit.includes(';') || lit.includes('--')) {
      throw new Error(
        `${file} 的字串常值裡有 ; 或 --（${lit.slice(0, 40)}）——` +
          `本腳本的切句法會切錯。請改用真正的 SQL parser，或把那個常值改寫。`,
      );
    }
  }
}

const root = findArcrunRoot();
const migDir = join(root, 'kbdb', 'migrations');

// 🔴 目錄裡有幾支就收幾支，依檔名排序。**不准寫死清單**（見檔頭 2026-08-25 那段）。
const files = readdirSync(migDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
if (files.length === 0) throw new Error(`${migDir} 底下找不到任何 NNNN_*.sql`);

// 編號要連續：缺號代表有人刪了或漏推，那會讓某個世代永遠補不上（本次事故的形狀）。
const nums = files.map((f) => Number(f.slice(0, 4)));
for (let i = 0; i < nums.length; i++) {
  if (nums[i] !== i + 1) {
    throw new Error(`migration 編號不連續：第 ${i + 1} 支應是 ${String(i + 1).padStart(4, '0')}_*，實際是 ${files[i]}`);
  }
}

const statements = [];
for (const f of files) {
  const p = join(migDir, f);
  const sql = readFileSync(p, 'utf8');
  assertSafeToSplit(f, sql);
  const stmts = splitStatements(sql);
  for (const s of stmts) statements.push(s);
  console.log(`  · ${f} → ${stmts.length} 句`);
}

// 機械複驗：worker.js 真的 import 我們寫的這一份嗎？（防止下一次又寫到沒人讀的地方）
const workerSrc = readFileSync(join(here, '..', 'oauth-prototype', 'worker.js'), 'utf8');
if (!/import\s+MIGRATIONS\s+from\s+'\.\/migrations\.json'/.test(workerSrc)) {
  throw new Error(
    "worker.js 沒有 `import MIGRATIONS from './migrations.json'`——" +
      '本腳本的輸出位置與它實際讀的位置對不上，改對了再打包（2026-08-25 就是這樣漂掉的）。',
  );
}

writeFileSync(outPath, JSON.stringify({ source: files, statements }, null, 2) + '\n', 'utf8');
console.log(`✓ 共 ${statements.length} 句 → ${outPath}`);
