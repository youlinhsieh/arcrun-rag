#!/usr/bin/env node
/**
 * version-stamp-gate.mjs — 「凡是會部署 worker 的路，烙版本就必須一起烙 commit」。
 *
 * ── 這道閘為什麼存在（Arcrun#106 另一半，2026-08-16）──────────────────────────
 * `bundle_version` 是**部署時貼上去的標籤**，不是內容的函數。誰跑了部署，誰的號就蓋上去。
 * 所以「兩台版號一樣」只證明「最後貼標籤的是同一條路」，**不證明它們跑同一份碼**。
 * 真正能拆穿標籤的是 `bundle_commit`——而 2026-08-16 實測發現：
 *
 * ```
 *                    更新前                    更新後（跑過 prod 安裝器）
 *   youlin            1.4.47 + commit d7a98f53  1.4.46 + commit 欄位消失
 *   geek6688          1.4.47 + commit d7a98f53  1.4.46 + commit 欄位消失
 *   leo21c（沒更新過） 1.4.46 + 從來就沒有 commit
 * ```
 *
 * ⇒ `acr` 那條烙了兩個印記，安裝器這條只烙版號 ⇒ **跑一次安裝器就把唯一能查的欄位洗掉**
 * ⇒ 沒有任何方法查出三台是不是同一份碼。leo：「這太可怕了。」
 *
 * 這次把三條部署路徑都補上 commit。但**補完不算完成**——
 * 這是 2026-08-16 當天第五次同款形狀：**能力／欄位存在，但不在會被執行的那條路上**。
 * 下次有人新增第四條部署路徑、或把 commit 那行拿掉，沒有閘就會安靜地回到今天的狀態。
 * ⇒ 所以留一道會擋的閘。
 *
 * ── 三條判準（照 resource-rule-gate.mjs 的形狀）───────────────────────────────
 * ① **會擋，不是只提醒**：任一項不過就 exit 1，`ship.mjs` 的 preflight 直接拒絕出貨。
 * ② **判準看「有沒有在做那件事」，不是「字串有沒有出現」**：
 *    offender ＝「**這個檔真的會把 worker 部上去**（打 CF script API 或跑 wrangler deploy），
 *    而且它自己寫版本標籤，卻沒寫 commit 標籤」。
 *    ⇒ 掃描前先剝掉註解（避免「在註解裡提一下 ARCRUN_BUNDLE_COMMIT」就矇混過關）；
 *    ⇒ 只讀不寫的（`env.ARCRUN_BUNDLE_VERSION`）、拿字串當檢查條件的
 *      （`release.mjs` 的 `uiSrc.includes('ARCRUN_BUNDLE_VERSION')`）、
 *      模擬「已部署 worker 身上長什麼樣」的假資料（`resource-plan-dryrun.mjs`）
 *      **都不會被誤殺**——它們沒有部署動作。
 * ③ **閘自己要能被演練**：全部純函式＋路徑注入，`version-stamp-gate.test.mjs`
 *    餵它「本 repo（要全過）」「把 commit 那行拿掉的 worker.js（要擋）」
 *    「只在註解裡提 commit（要擋）」「掃到 0 個檔（要擋）」四種輸入。
 *
 * 用法：
 *   node installer/scripts/version-stamp-gate.mjs       # 不過就 exit 1
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { versionStampVars } from '../oauth-prototype/version-stamp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');

/** 掃描範圍：安裝器這一整包（worker 本體＋出貨腳本）。 */
export const SCAN_DIR = join('installer');
/** 共用規則的逐位元組鏡射——它是別人的東西，由 resource-rule-gate 守，不在本閘管轄。 */
export const MIRROR_REL = join('installer', 'oauth-prototype', 'shared', 'resource-rule');

/**
 * 「這個檔真的會把 worker 部上去」的訊號。
 * 只認**動作**，不認檔名：叫什麼名字、放在哪個資料夾都不影響判斷。
 */
export const DEPLOY_ACTIONS = [
  { kind: 'CF script API 上傳', re: /workers\/scripts\// },
  { kind: 'wrangler deploy', re: /['"`]wrangler['"`]\s*,\s*['"`]deploy['"`]|\[\s*['"`]deploy['"`]\s*\]/ },
];

/**
 * 「寫一個版本印記」的三種形態（＝真的把值送出去，不是讀它、也不是拿它當字串比對）。
 *   · CF binding 字面：`{ type: 'plain_text', name: 'ARCRUN_BUNDLE_VERSION', … }`
 *   · toml 行：`ARCRUN_BUNDLE_VERSION = "…"`
 *   · JS 物件鍵：`{ ARCRUN_BUNDLE_VERSION: version }`（`version-stamp.mjs` 的產地就是這型）
 */
export const WRITE_FORMS = [
  { kind: 'CF plain_text binding', re: /name\s*:\s*['"`]ARCRUN_BUNDLE_(VERSION|COMMIT)['"`]/g },
  { kind: 'toml [vars] 行', re: /ARCRUN_BUNDLE_(VERSION|COMMIT)\s*=\s*['"`]/g },
  { kind: 'JS 物件鍵', re: /(?<![.\w'"`])ARCRUN_BUNDLE_(VERSION|COMMIT)\s*:/g },
];

/**
 * 剝掉註解（`//…` 與 `/*…*\/`），保留字串與程式碼。
 * 為什麼一定要剝：不剝的話「在註解裡寫一句 ARCRUN_BUNDLE_COMMIT」就能矇過這道閘
 * ——那正是本票要治的病（規則寫在註解裡，沒有一步在執行它）。
 * 逐字元掃，且**認得字串／樣板字串**，所以 `'https://x//y'` 不會被當成註解砍掉。
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 這段（已剝註解的）程式碼會不會真的部署 worker。回命中的動作種類清單。 */
export function deployActionsIn(code) {
  return DEPLOY_ACTIONS.filter((a) => a.re.test(code)).map((a) => a.kind);
}

/** 這段（已剝註解的）程式碼寫了哪些版本印記。回 `{ version: [...形態], commit: [...形態] }`。 */
export function stampWritesIn(code) {
  const found = { version: [], commit: [] };
  for (const form of WRITE_FORMS) {
    for (const m of code.matchAll(form.re)) {
      (m[1] === 'VERSION' ? found.version : found.commit).push(form.kind);
    }
  }
  return found;
}

/** 掃描對象：`installer/` 底下的 `.js`／`.mjs`，排除鏡射、node_modules 與測試檔。 */
export function filesToScan(root = REPO_ROOT) {
  const base = join(root, SCAN_DIR);
  const out = [];
  if (!existsSync(base)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (rel === MIRROR_REL || rel.startsWith(MIRROR_REL + sep)) continue;
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(name)) continue;
      if (/\.test\.mjs$/.test(name)) continue; // 測試不是部署路徑
      out.push(p);
    }
  };
  walk(base);
  return out;
}

/**
 * 主檢查：每一條**真的會部署**的路，若寫了版本標籤，就必須也寫 commit 標籤。
 * @returns {{ok:boolean, scanned:number, deployPaths:string[], problems:string[]}}
 */
export function checkStampPairing(root = REPO_ROOT) {
  const files = filesToScan(root);
  const problems = [];
  const deployPaths = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, 'utf8'));
    const actions = deployActionsIn(code);
    if (actions.length === 0) continue;               // 不是部署路徑，不歸本閘管
    const rel = relative(root, f);
    deployPaths.push(rel);
    const w = stampWritesIn(code);
    if (w.version.length === 0) continue;             // 這條路不烙版本標籤，沒有配對問題
    if (w.commit.length === 0) {
      problems.push(
        `${rel}：會部署 worker（${actions.join('、')}）且寫了 ARCRUN_BUNDLE_VERSION`
        + `（${[...new Set(w.version)].join('、')}），卻沒有寫 ARCRUN_BUNDLE_COMMIT。\n`
        + `         ⇒ 走這條路上去的實例查不出跑的是哪一份碼，而且會把別條路烙的 commit 洗掉（Arcrun#106）。\n`
        + `         → 用 installer/oauth-prototype/version-stamp.mjs 的 versionStampVars()，`
        + `或比照 deploy-all.mjs 一併注入 ARCRUN_BUNDLE_COMMIT（查不到就兩個都不貼，不要編一個）。`);
    }
  }
  if (files.length === 0) {
    problems.push(`掃到 0 個檔（${join(root, SCAN_DIR)} 不存在或空的）——檢查了 0 個卻通過，等於沒有閘。`);
  }
  return { ok: problems.length === 0, scanned: files.length, deployPaths, problems };
}

/**
 * 副檢查：印記的**產地**本身要真的同時吐兩個。
 * 上面那條是靜態掃描，這條是行為斷言——兩者都要，缺一就會出現
 * 「掃描過了、但那支函式其實只回一個欄位」的假綠。
 */
export function checkProducer() {
  const problems = [];
  const both = versionStampVars({ release: '1.4.46', sourceCommit: 'Arcrun@cacaa33f7d4e' });
  if (both.ARCRUN_BUNDLE_VERSION !== '1.4.46') problems.push(`versionStampVars 沒吐正確版號：${both.ARCRUN_BUNDLE_VERSION}`);
  if (both.ARCRUN_BUNDLE_COMMIT !== 'cacaa33f7d4e') problems.push(`versionStampVars 沒吐 commit：${both.ARCRUN_BUNDLE_COMMIT}`);
  const noCommit = versionStampVars({ release: '1.4.46' });
  if ('ARCRUN_BUNDLE_COMMIT' in noCommit) problems.push('查不到 commit 時不該吐這個欄位（寧可少一個標籤，不可貼假的）');
  if (noCommit.ARCRUN_BUNDLE_VERSION !== '1.4.46') problems.push('查不到 commit 時版號仍必須照貼（不可讓安裝失敗）');
  return { ok: problems.length === 0, problems };
}

export function runGate(root = REPO_ROOT) {
  const pairing = checkStampPairing(root);
  const producer = checkProducer();
  const sections = [
    { name: `部署路徑烙印配對（掃 ${pairing.scanned} 檔，其中 ${pairing.deployPaths.length} 條是部署路徑）`, ok: pairing.ok, problems: pairing.problems },
    { name: '印記產地真的同時吐版本與 commit', ok: producer.ok, problems: producer.problems },
  ];
  return { ok: sections.every((s) => s.ok), sections };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runGate();
  for (const s of r.sections) {
    console.log(`${s.ok ? '✔' : '✘'} ${s.name}`);
    for (const p of s.problems) console.log(`   - ${p}`);
  }
  process.exit(r.ok ? 0 : 1);
}
