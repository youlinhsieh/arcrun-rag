/**
 * migrations-source.mjs — migration 完整性閘「讀哪一份 Arcrun」的唯一決定處。
 *
 * 2026-10-09（inkstone/Arcrun#293 c18325）：出 1.4.88 時設了 ARCRUN_SOURCE_WORKTREE
 * 指向帶 0014 的 worktree，取貨（fetch-artifacts）讀 worktree，
 * 但 migration 閘讀 ARCRUN_REPO_ROOT／並列位置的 Arcrun main（沒有 0014）
 * ⇒ 閘照綠、安裝器漏帶 0014 ⇒ 實例資料層落後一代。
 * 一邊讀 worktree、一邊讀 main，就是兩個來源。
 *
 * 規則：出貨的來源只有 ctx.arcrunRepo（已套 ARCRUN_SOURCE_WORKTREE），閘與取貨共用它。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 閘該讀的 Arcrun 根。有 shipRoot（本趟取貨實際用的）就只准用它。 */
export function resolveMigrationSourceRoot({ shipRoot, env = process.env, fallbacks = [] } = {}) {
  if (shipRoot) {
    const envRoot = env.ARCRUN_REPO_ROOT;
    const note = envRoot && resolve(envRoot) !== resolve(shipRoot)
      ? `（忽略 ARCRUN_REPO_ROOT=${envRoot}：閘必須和取貨讀同一份來源）` : '';
    return { root: shipRoot, note };
  }
  const root = env.ARCRUN_REPO_ROOT
    || fallbacks.find((c) => existsSync(join(c, 'kbdb', 'migrations'))) || '';
  return { root, note: '' };
}

export function assertMigrationsComplete(installerCwd, arcrunRoot) {
  const migDir = join(arcrunRoot, 'kbdb', 'migrations');
  if (!existsSync(migDir)) return ['找不到 Arcrun kbdb/migrations（跳過複驗）'];
  const onDisk = readdirSync(migDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const shipped = JSON.parse(readFileSync(join(installerCwd, 'migrations.json'), 'utf8'));
  const missing = onDisk.filter((f) => !(shipped.source || []).includes(f));
  if (missing.length) {
    throw new Error(
      `安裝器帶出去的 migration 少了 ${missing.length} 支：${missing.join('、')}\n` +
        `         → 跑一次 \`ARCRUN_REPO_ROOT=<Arcrun> node installer/scripts/compile-migrations.mjs\` 再出貨。\n` +
        `         🔴 少一支＝用戶的資料層停在舊世代，而 worker 是新的——` +
        `那正是 2026-08-25 讓 leo 登不進自己知識庫的病（inkstone/Arcrun#159）。`,
    );
  }
  return [`安裝器帶了全部 ${onDisk.length} 支 migration（${onDisk[0]} … ${onDisk[onDisk.length - 1]}）`];
}

/** 從 GENERATION_CHECKS（worker.js）或 GENERATIONS（Arcrun schema-generation.ts）的原始碼文字，
 *  抽出「世代 n → 檢查指紋清單」。兩邊寫法不同但都含 `n: N` 與 `{ kind: 'x', name|id: 'y' }`。 */
export function extractGenerationChecks(text) {
  const marks = [...text.matchAll(/(?<![\w])n:\s*(\d+)\s*,/g)];
  const out = new Map();
  marks.forEach((m, i) => {
    const seg = text.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : text.length);
    const checks = [...seg.matchAll(/kind:\s*'(\w+)'\s*,\s*(?:name|id):\s*'([^']+)'/g)].map((c) => `${c[1]}:${c[2]}`).sort();
    out.set(Number(m[1]), checks);
  });
  return out;
}

/** 安裝器的世代探針表必須和 Arcrun 來源的世代表一致（少一代／指紋不同都擋）。
 *  inkstone/Arcrun#293 c18365：1.4.88 加了第 14 代，安裝器表停在 13 ⇒ 世代探針與實例對不上。 */
export function assertGenerationChecksInSync(installerCwd, arcrunRoot) {
  const ts = join(arcrunRoot, 'kbdb', 'src', 'actions', 'schema-generation.ts');
  if (!existsSync(ts)) return ['找不到 Arcrun schema-generation.ts（跳過世代表複驗）'];
  const up = extractGenerationChecks(readFileSync(ts, 'utf8'));
  const mine = extractGenerationChecks(readFileSync(join(installerCwd, 'worker.js'), 'utf8').split('const GENERATION_CHECKS = [')[1] || '');
  const diffs = [];
  for (const [n, checks] of up) {
    if (!mine.has(n)) { diffs.push(`第 ${n} 代：安裝器的 GENERATION_CHECKS 沒有`); continue; }
    if (JSON.stringify(mine.get(n)) !== JSON.stringify(checks)) diffs.push(`第 ${n} 代：指紋不同（Arcrun ${checks.join(',')} ／ 安裝器 ${mine.get(n).join(',')}）`);
  }
  if (diffs.length) {
    throw new Error(
      `安裝器的世代探針表（worker.js GENERATION_CHECKS）和 Arcrun 來源不同步：\n         ` + diffs.join('\n         ') +
        '\n         → 照 kbdb/src/actions/schema-generation.ts 補齊，再出貨。🔴 對不上＝安裝器判斷資料層世代會錯（Arcrun#293 c18365）。',
    );
  }
  return [`安裝器世代探針表與 Arcrun 一致（共 ${up.size} 代）`];
}
