/**
 * credential-store.mjs — 出貨管線自己去把鑰匙拿出來（只碰名字，不碰真身）
 *
 * ── 為什麼有這支（leo 2026-08-16，arcrun-rag#102）──────────────────────────
 * leo 原話：「**每次出貨必有這個問題，為什麼不把它編入流程必備？**」
 *
 * 病：`ship.mjs` 的 preflight 早就會在最前面斷「缺 GITHUB_MIRROR_TOKEN」，訊息也
 * 寫得很清楚（去查 credentials-map.md、在 shell 裡 export）——**但那條訊息交代的
 * 是一件人要做的事**。於是每一次出貨的第一步都固定是：人打開憑證地圖、找到那把
 * 鑰匙住在哪個 `.env`、把值抄進 shell。抄完管線才肯往下走。
 *
 * 🔴 那三步管線自己全都做得到：
 *   ① 它知道自己要哪些**名字**（就寫在 preflight 的檢查裡）
 *   ② 系統裡本來就有一張表記著每把鑰匙住哪個 `.env`（頂層 `wiki/credentials-map.md`）
 *   ③ `.env` 就在 repo 往上找得到的地方
 * ⇒ 人在中間只是搬運工。**同款的病 2026-08-06 已經治過一次**：
 *   `collector/cmd/arcrun-app/build-msix.sh` 的 Store Identity 三值本來也是每次問人，
 *   後來改成腳本自己去頂層 `.env` 讀（見該檔 45-56 行，leo：「每次都問一次..」）。
 *   這支就是把同一個做法從那支腳本推廣成管線共用的一站。
 *
 * ── D36 金鑰鐵律怎麼守（這支的每一行都在守它）────────────────────────────
 * 「**只碰名字，不碰真身**」——這支**取得**值交給 `process.env` 讓下游用，但：
 *   · 回傳值、log、錯誤訊息裡**只出現名字與來源檔路徑**，永遠沒有值
 *     （`describeSources()` 只吐名字＋路徑；`missingCredentialError()` 同）
 *   · **只取被點名的那幾個鍵**，不把整包 `.env` 灌進環境
 *     （其他都是這條管線不該碰的金鑰——同 build-msix.sh 的作法）
 *   · **不寫檔、不進版控、不進指令行**——只放進本行程的 `process.env`，行程結束就沒了
 *   · **不建立第二套傳遞法**：沒有佔位符替換、沒有硬編碼、沒有寫進設定檔；
 *     真相源仍然只有 `.env` 一個家，這支只是「自己走去那個家拿」
 *
 * ── 操作者永遠贏過自動來源 ────────────────────────────────────────────────
 * shell 裡已經 export 過的值**一律不覆蓋**（`fill()` 只填空的）。理由：人明確給的
 * 值是意圖（換一把鑰匙、臨時試別的帳號），自動取得的是預設。預設不得蓋過意圖。
 *
 * ── 為什麼不寫死相對路徑 ──────────────────────────────────────────────────
 * 這個 repo 不保證永遠躺在 `InkStoneCo/products/arcrun-rag`：它會被 clone 到別的地方，
 * 也會以 git worktree 的形式出現在**更深**的層級（`.claude/worktrees/<名字>/`）——
 * 寫死 `../../.env` 在那些情況全部落空，而且是安靜落空。
 * ⇒ 改成**從起點往上逐層找 `.env`**（近的優先），找到幾份就照順序查名字。
 *   同一個機制在任何層級、任何 clone 位置都成立，不必有人記得改常數。
 *
 * 這支刻意做成純函式＋所有路徑可注入，方便不碰任何真的 `.env` 就能單元測試。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 逃生門：明確指定要查哪幾份 `.env`（`:` 分隔，順序即優先序）。
 * 給「憑證不在往上找得到的地方」的機器用（CI、別人的 clone），
 * 一樣只是**換一個取景窗**，不放寬任何判準——照樣只取被點名的鍵、照樣不印值。
 */
export const ENV_FILES_OVERRIDE = 'ARCRUN_CREDENTIAL_ENV_FILES';

/** `KEY=value` / `export KEY=value`（值有沒有引號都行）。 */
const ASSIGN_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * 從 `startDir` 一路往上，收集每一層的 `.env`（**近的排前面**）。
 *
 * - `stopAt`：走到這一層就停（含這一層），預設家目錄——避免無謂地往上摸到 `/`。
 *   起點不在 `stopAt` 底下時（例如 CI 把 repo 放在 `/opt`）走到檔案系統根為止。
 * - 回傳的都是實際存在、且是**檔案**的絕對路徑（目錄叫 `.env` 不算）。
 */
export function envChain(startDir, { stopAt = homedir(), override = process.env[ENV_FILES_OVERRIDE] } = {}) {
  if (override) {
    return override.split(':').map((p) => p.trim()).filter(Boolean)
      .map((p) => resolve(p)).filter(isFile);
  }
  const out = [];
  const stop = stopAt ? resolve(stopAt) : null;
  let dir = resolve(startDir);
  for (;;) {
    const f = join(dir, '.env');
    if (isFile(f)) out.push(f);
    const parent = dirname(dir);
    if (parent === dir) break;          // 檔案系統的根
    if (stop && dir === stop) break;    // 走到界線（含這一層）
    dir = parent;
  }
  return out;
}

function isFile(p) {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}

/**
 * 從一份 `.env` 裡**只取被點名的那幾個鍵**。
 *
 * 沒被點名的鍵**連讀都不讀進回傳值**——這支拿到的東西越少越好。
 */
export function readNames(file, names) {
  const want = new Set(names);
  const found = new Map();
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return found; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = s.match(ASSIGN_LINE);
    if (!m) continue;
    const [, key, rest] = m;
    if (!want.has(key) || found.has(key)) continue; // 同一份檔案裡先出現的贏
    let v = rest.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)
      || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    if (v) found.set(key, v);
  }
  return found;
}

/**
 * 把點名的鑰匙填進 `env`（預設 `process.env`），**只填空的**。
 *
 * @returns {{
 *   resolved: Array<{ name: string, source: string }>,  // source＝'shell' 或 .env 的絕對路徑
 *   missing: string[],
 *   searched: string[],
 * }}
 * 🔴 回傳值裡**沒有任何金鑰的真身**——這是刻意的，呼叫端想印什麼都印不出值。
 */
export function fill(names, { startDir, env = process.env, stopAt, override } = {}) {
  const searched = envChain(startDir, { stopAt, override });
  const resolved = [];
  const stillMissing = [];

  for (const name of names) {
    if (env[name]) {                       // ① 操作者明確給的，永遠贏
      resolved.push({ name, source: 'shell' });
      continue;
    }
    let hit = null;
    for (const file of searched) {         // ② 近的 .env 優先
      const got = readNames(file, [name]);
      if (got.has(name)) { hit = { file, value: got.get(name) }; break; }
    }
    if (hit) {
      env[name] = hit.value;
      resolved.push({ name, source: hit.file });
    } else {
      stillMissing.push(name);
    }
  }
  return { resolved, missing: stillMissing, searched };
}

/** 人看的一行行說明——**只有名字與來源檔**，沒有值。 */
export function describeSources(result) {
  return result.resolved.map(({ name, source }) => (
    source === 'shell'
      ? `${name}：操作者已在 shell 給了（不覆蓋）`
      : `${name}：管線自己從 ${source} 取得（只取這個名字，值不落地、不列印）`
  ));
}

/**
 * 缺鑰匙時的訊息——**一眼知道差什麼、去哪拿**（斷點不變，仍在最前面）。
 * 一樣只出現名字與查過的路徑。
 */
export function missingCredentialError(result, { need = '', mapHint = 'system-dev/wiki/credentials-map.md' } = {}) {
  const names = result.missing.join('、');
  const looked = result.searched.length
    ? result.searched.map((p) => `       · ${p}`).join('\n')
    : '       ·（往上一層層找，一份 .env 都沒找到）';
  return new Error(
    `缺 ${names}${need ? `——${need}` : ''}。\n` +
    `     管線已經自己找過下面這幾份 .env（近的優先），裡面都沒有這個名字：\n` +
    `${looked}\n` +
    `     → 這把鑰匙該住哪，查 ${mapHint}；把它補進上面任何一份 .env，\n` +
    `       之後每次出貨管線就會自己拿，不必再有人 export。\n` +
    `       （臨時要指定別份：${ENV_FILES_OVERRIDE}=/路徑/.env:/另一份/.env）\n` +
    `     D36 金鑰鐵律：管線只讀名字、值不落地不列印——這條訊息裡也不會有值。`);
}
