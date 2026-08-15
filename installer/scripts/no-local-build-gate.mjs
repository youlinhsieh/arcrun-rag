/**
 * no-local-build-gate.mjs — **這個 bundle 裡的每一個位元組，都要說得出是 Arcrun 哪一顆 commit 編的。**
 *
 * ── D91（leo 2026-08-14）─────────────────────────────────────────────────────
 * > 「今天開始出貨一律不准在 arcrun rag 或任何別的地方 build，**這就是 arcrun 的專屬工作**。
 * >   你告訴我要把 cypher 搬到 arcrun，我說好，**結果搞到現在還用違反的方式**。」
 *
 * 重點在後半句：**規則早就講定、他也同意了，而實作至今仍在違反**——
 * 因為沒有任何東西在檢查。同 D54／D64／D90 的形狀：規則寫在那裡，卻沒有機制驗證有沒有照做。
 *
 * ── 這道閘怎麼擋，為什麼這樣擋抓得住 ─────────────────────────────────────────
 * **不是**去掃「有沒有人呼叫 esbuild」。理由：
 *   · 那種掃描抓不到「不用 bundler、直接用字串拼出一顆 worker」的做法——
 *     而 2026-08-15 之前這條線上**唯一**的違規（portal 前端）正是那種做法。
 *   · 而且它是「找禁止的寫法」：寫法有無限多種，漏掉一種就等於沒擋。
 *
 * **改成驗來源**：bundle 裡每一顆的位元組，都必須逐位元等於 Arcrun `.worker-builds/`
 * 裡那一顆官方成品。這句話**不管你用什麼方法產生它**都成立：
 *   · 自己 esbuild ⇒ 位元組對不上（同一份原始碼在不同機器編出不同位元組，見 D49／1.4.33）
 *   · 自己拼字串   ⇒ 位元組對不上
 *   · 手改一個字   ⇒ 位元組對不上
 *   · **真的照抄官方成品 ⇒ 通過**——而那正是唯一被允許的做法。
 * ⇒ 這道閘沒有「禁止清單」，所以不會因為誰想出新寫法就失效。
 *
 * **誤傷風險**：唯一會誤判的情況是「bundle 裡有一顆東西本來就不該由 Arcrun 產生」。
 * 所以本閘的範圍寫死成「零件包」——`manifest.core` 與 `manifest.library` 這兩份名單，
 * 也就是**會被裝到使用者實例上的 worker**。桌面小幫手（本機簽章打包）、安裝器自己、
 * 說明文件站**不在範圍內**：它們是 arcrun-rag 自己的產品，Arcrun 沒有、也不該有一份。
 * D91 講的是「零件」——把它擴張到那三樣會讓這條鐵律變成一句不可能遵守的話。
 *
 * ── 第二道網（便宜、抓得早）─────────────────────────────────────────────────
 * 出貨腳本自己**不准 import 打包器**。位元組閘是在產物出來後才驗；這道在原始碼層
 * 就把「有人又開始在這裡編東西」擋掉，而且訊息會直接告訴他該去哪裡編。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 會被裝到使用者實例上的 worker——本閘的範圍。 */
export function shippedEntries(manifest) {
  const seen = new Map();
  for (const list of [manifest.library, manifest.core]) {
    for (const e of list || []) {
      if (e && e.name && e.main_file) seen.set(e.name, e);
    }
  }
  return [...seen.values()];
}

/**
 * 驗每一顆的位元組來源。
 *
 * @param {{ bundlesDir: string, manifest: object, artifactManifest: object, arcrunRepo: string }} opts
 * @returns {{ ok: boolean, checked: number, problems: Array<{name:string, why:string}> }}
 */
export function checkProvenance({ bundlesDir, manifest, artifactManifest, arcrunRepo }) {
  const artifacts = new Map((artifactManifest?.workers || []).map((w) => [w.name, w]));
  const problems = [];
  const entries = shippedEntries(manifest || {});

  for (const e of entries) {
    const artifact = artifacts.get(e.name);
    if (!artifact) {
      problems.push({
        name: e.name,
        why: `Arcrun 的官方成品裡沒有這一顆 ⇒ 它的位元組是在別的地方產生的（D91 禁止）。`
          + `\n         → 去 ${arcrunRepo} 跑 scripts/build-worker-artifacts.mjs 讓它成為官方成品，`
          + `\n           或把它從 bundle 拿掉。**不要在這裡把它做出來。**`,
      });
      continue;
    }
    const file = join(bundlesDir, e.main_file);
    if (!existsSync(file)) {
      problems.push({ name: e.name, why: `manifest 說它在 ${e.main_file}，但那個檔案不存在。` });
      continue;
    }
    const actual = sha256(readFileSync(file));
    if (actual !== artifact.content_sha256) {
      problems.push({
        name: e.name,
        why: `位元組與 Arcrun 官方成品不同 ⇒ 這一顆是在這裡被產生／被改過的（D91 禁止）。`
          + `\n         bundle 裡：${actual.slice(0, 16)}`
          + `\n         官方成品  ：${String(artifact.content_sha256).slice(0, 16)}（Arcrun@${String(artifact.source_commit || '').slice(0, 8)}）`,
      });
      continue;
    }
    for (const m of e.modules || []) {
      const am = (artifact.modules || []).find((x) => x.name === m.name);
      const mf = join(bundlesDir, m.file);
      if (!am) { problems.push({ name: e.name, why: `官方成品沒有 wasm part ${m.name}` }); continue; }
      if (!existsSync(mf)) { problems.push({ name: e.name, why: `缺 wasm part 檔案 ${m.file}` }); continue; }
      if (sha256(readFileSync(mf)) !== am.sha256) {
        problems.push({ name: e.name, why: `wasm part ${m.name} 與官方成品不同` });
      }
    }
  }
  return { ok: problems.length === 0, checked: entries.length, problems };
}

/** 打包器的痕跡。列的是「工具」而不是「寫法」——工具數量有限，寫法沒有。 */
const BUNDLER_HINTS = [
  /from\s+['"]esbuild['"]/,
  /require\(\s*['"]esbuild['"]\s*\)/,
  /import\(\s*['"]esbuild['"]\s*\)/,
  /from\s+['"](rollup|webpack|vite|@swc\/core)['"]/,
  /\bnpx\s+(esbuild|rollup|webpack|swc|tsc)\b/,
  /\bwrangler\b[^\n]*\bbuild\b/,
];

/**
 * 出貨腳本自己有沒有在編東西。
 *
 * 只掃 `installer/scripts/`——出貨線的活都在那裡。掃更大範圍會開始誤傷
 * （`docs-site` 用 astro 編靜態站、`collector` 用 wails 編桌面 App，
 * 那兩樣**不是零件**，Arcrun 沒有它們的原始碼，禁止它們等於禁止它們存在）。
 *
 * 豁免：該行尾加 `build-elsewhere-ok` 並在 commit 說明理由（沿用本 repo 既有的豁免慣例）。
 */
export function checkNoBundlerInShipScripts(scriptsDir) {
  const hits = [];
  if (!existsSync(scriptsDir)) return { ok: true, hits };
  for (const name of readdirSync(scriptsDir).sort()) {
    const p = join(scriptsDir, name);
    if (!statSync(p).isFile() || !/\.mjs$/.test(name)) continue;
    if (p === join(scriptsDir, 'no-local-build-gate.mjs')) continue;      // 本檔自己列著那些字樣
    if (/\.test\.mjs$/.test(name)) continue;                              // 測試會刻意造反例
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes('build-elsewhere-ok')) return;
      // 註解行不算——本 repo 的註解大量在講「以前這裡跑過 esbuild」這段病史，
      // 那是**要留著**的紀錄，不是違規。
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (BUNDLER_HINTS.some((re) => re.test(line))) hits.push({ file: p, line: i + 1, text: line.trim() });
    });
  }
  return { ok: hits.length === 0, hits };
}

/** 呼叫端入口：有問題就丟例外，訊息是人話。 */
export function requireNoLocalBuild({ bundlesDir, manifest, artifactManifest, arcrunRepo, scriptsDir }) {
  const src = checkNoBundlerInShipScripts(scriptsDir);
  if (!src.ok) {
    throw new Error(
      `出貨腳本自己在編東西——D91 說成品只有一個產地（Arcrun），拒絕出貨：\n` +
      src.hits.map((h) => `       ${h.file}:${h.line}  ${h.text}`).join('\n') +
      `\n\n       → 要編就去 ${arcrunRepo} 的 scripts/build-worker-artifacts.mjs 編，成品 commit 進 .worker-builds/。\n` +
      `       → 真有例外：該行尾加 build-elsewhere-ok，並在 commit 說明理由。`);
  }

  const prov = checkProvenance({ bundlesDir, manifest, artifactManifest, arcrunRepo });
  if (!prov.ok) {
    throw new Error(
      `bundle 裡有 ${prov.problems.length} 顆說不出來源（共驗了 ${prov.checked} 顆），拒絕出貨：\n` +
      prov.problems.map((p) => `       · ${p.name}\n         ${p.why}`).join('\n') +
      `\n\n       D91：「出貨一律不准在 arcrun rag 或任何別的地方 build，這就是 arcrun 的專屬工作。」`);
  }
  return prov;
}
