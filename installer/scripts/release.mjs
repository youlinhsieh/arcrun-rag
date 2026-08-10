/**
 * release.mjs — 版本號的單一真相源＋自動計算（leo 2026-08-02：「做成自動化，不依賴你記得去更新」）
 *
 * ── 為什麼有這支 ──────────────────────────────────────────────────────────
 * 舊機制壞在兩件事（2026-08-02 實測，見 wiki/install-update-chain.md §五）：
 *   ① `manifest.built`／`source` 只有全量重建的 build-bundles.mjs 會寫，
 *      而 portal 出貨走 build-ui-bundle.mjs（完全不碰 manifest）
 *      ⇒ 四代釘點 ui sha 都變了、日期卻永遠凍在 2026-07-31。
 *   ② 版本字串另外被手抄進 landing/wrangler.toml，換釘子時沒人記得改 ⇒ 落後兩代。
 * 結論：**靠「記得改 N 個地方」的機制一定會漏**。所以這支的設計原則是——
 *   版本號**由內容算出來**，不是由人（或 AI）宣告。呼叫者只要 build，版本自己會對。
 *
 * ── 版本語意（leo 2026-08-02 選定 semver）──────────────────────────────
 *   MAJOR.MINOR ← 人決定（`RELEASE_LINE` 檔，大改版才動，平常不碰）
 *   PATCH       ← **機器決定**：內容指紋一變就 +1，沒變就不動（重跑不會虛增）
 * ⇒ 出貨幾次、patch 就是幾，`1.4.7` 讀作「1.4 線的第 7 次內容變更」。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   import { syncManifest } from './release.mjs';
 *   syncManifest(bundlesDir);   // 重算全部 sha + built + release，回傳 { release, changed }
 * 任何產 bundle 的腳本結尾呼叫它即可；漏呼叫由 verify-manifest.mjs（機械閘）擋下。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { notesFromChangelog, checkNotes } from './daemon-notes.mjs';

/** MAJOR.MINOR 放這裡——唯一需要人動的一行，且只在大改版時動。 */
export const RELEASE_LINE_FILE = 'RELEASE_LINE';
const DEFAULT_LINE = '1.4';

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 讀 MAJOR.MINOR。檔案不存在就用預設值（不擋出貨，缺檔不是致命錯）。 */
export function readLine(repoRoot) {
  const p = join(repoRoot, RELEASE_LINE_FILE);
  if (!existsSync(p)) return DEFAULT_LINE;
  const v = readFileSync(p, 'utf8').trim();
  if (!/^\d+\.\d+$/.test(v)) throw new Error(`${RELEASE_LINE_FILE} 必須是 MAJOR.MINOR（例 1.4），現在是 ${JSON.stringify(v)}`);
  return v;
}

/**
 * 內容指紋＝manifest.core[] 每顆的 name+sha256 串起來再 hash。
 * 只認「真正會送到用戶機器上的東西」，不含 built/release/source 自己
 * （否則指紋會因為自己變動而變動，永遠停不下來）。
 */
export function contentFingerprint(core) {
  const flat = [...core]
    .map((c) => `${c.name}:${c.sha256}`)
    .sort()
    .join('|');
  return createHash('sha256').update(flat).digest('hex');
}

/**
 * 掃 bundles 目錄，用磁碟實檔重算每顆的 sha256。
 * ⚠️ 這是修「build-ui-bundle 改了檔案卻沒更新 manifest」的關鍵：
 *    sha 一律以**磁碟為準**，不信任 manifest 裡的舊值。
 */
export function recomputeShas(bundlesDir, core) {
  const missing = [];
  const next = core.map((c) => {
    const f = join(bundlesDir, c.main_file);
    if (!existsSync(f)) { missing.push(c.main_file); return c; }
    const out = { ...c, sha256: sha256(f), bytes: statSync(f).size };
    if (Array.isArray(c.modules) && c.modules.length) {
      out.modules = c.modules.map((m) => {
        const mf = join(bundlesDir, m.file);
        return existsSync(mf) ? { ...m, sha256: sha256(mf) } : m;
      });
    }
    return out;
  });
  if (missing.length) {
    throw new Error(`manifest 宣告了磁碟上不存在的檔案（bundle 不完整，拒絕出貨）：\n  ${missing.join('\n  ')}`);
  }
  return next;
}

/** 比較新舊 patch。內容沒變就沿用舊 release（重跑 build 不會虛增版本）。 */
export function nextRelease(line, prevRelease, prevFingerprint, nextFingerprint) {
  const prevOk = typeof prevRelease === 'string' && /^\d+\.\d+\.\d+$/.test(prevRelease);
  const [pMajor, pMinor, pPatch] = prevOk ? prevRelease.split('.') : [];
  const sameLine = prevOk && `${pMajor}.${pMinor}` === line;

  if (sameLine && prevFingerprint === nextFingerprint) return prevRelease; // 內容沒變 ⇒ 不動
  if (!sameLine) return `${line}.0`;                                       // 人改了 MAJOR.MINOR ⇒ patch 歸零
  return `${line}.${Number(pPatch) + 1}`;                                  // 內容變了 ⇒ patch +1
}

/**
 * 主入口：重算 sha → 算指紋 → 決定 release → 寫回 manifest.json。
 * 冪等：同樣的磁碟內容重跑幾次，release 都不會變。
 */
export function syncManifest(bundlesDir, { repoRoot = process.cwd(), quiet = false } = {}) {
  const mPath = join(bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) throw new Error(`找不到 ${mPath}`);
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  if (!Array.isArray(m.core)) throw new Error('manifest.core 不是陣列，schema 不對');

  const line = readLine(repoRoot);
  const prevRelease = m.release;
  const prevFingerprint = m.fingerprint;

  const core = recomputeShas(bundlesDir, m.core);
  const fingerprint = contentFingerprint(core);
  const release = nextRelease(line, prevRelease, prevFingerprint, fingerprint);
  const changed = release !== prevRelease;

  // 🔴 2026-08-02 迴歸修復：原本這裡「列舉六個欄位重建 manifest」，
  // 於是**任何不在名單上的欄位每跑一次就被靜默丟掉**。
  // 實際受害：`daemon`（daemon 自更新讀它判斷有沒有新版，selfupdate.go:97）
  // 從 8e83589 存在 → 1.4.0（8be88c8）跑完就消失 ⇒ 所有人的「檢查更新」壞掉
  // 且錯誤訊息是「manifest 沒有 daemon 版本欄位」，沒人會聯想到是打包腳本吃掉的。
  // ⇒ 改成 **展開既有 m 再覆蓋我們負責的欄位**：我們只擁有 release/fingerprint/built/core，
  // 其餘（daemon、將來任何人加的欄位）一律原樣保留。
  const out = {
    ...m,                                           // ← 先保留既有一切（daemon 等）
    schema: m.schema || 'arcrun-rag-bundles/v1',
    release,                                        // ← 用戶看到的那個號碼（唯一真相源）
    fingerprint,                                    // ← 下次比對用，決定要不要 bump
    built: new Date().toISOString().slice(0, 10),   // ← 真的每次重算（舊機制凍結在此）
    source: m.source,
    core,
  };
  writeFileSync(mPath, JSON.stringify(out, null, 1) + '\n');

  if (!quiet) {
    console.log(changed
      ? `📦 版本 ${prevRelease || '(無)'} → ${release}（內容有變，patch +1）`
      : `📦 版本 ${release}（內容未變，不動）`);
  }
  return { release, changed, fingerprint, previous: prevRelease };
}

/**
 * 機械閘：驗 manifest 與磁碟一致、且 release 有跟上內容。
 * 給 verify-manifest.mjs／pre-commit 用。回傳問題清單（空陣列＝通過）。
 */
export function verifyManifest(bundlesDir, { repoRoot = process.cwd() } = {}) {
  const problems = [];
  const mPath = join(bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return [`找不到 ${mPath}`];
  const m = JSON.parse(readFileSync(mPath, 'utf8'));

  if (!m.release) problems.push('manifest 沒有 release 欄——沒跑過 syncManifest？');
  let core;
  try { core = recomputeShas(bundlesDir, m.core || []); }
  catch (e) { return [String(e.message)]; }

  for (const [i, c] of core.entries()) {
    const declared = (m.core[i] || {}).sha256;
    if (declared !== c.sha256) {
      problems.push(`${c.name}：manifest 寫 ${String(declared).slice(0, 12)}…，磁碟實檔是 ${c.sha256.slice(0, 12)}…（漏跑 syncManifest）`);
    }
  }
  const fp = contentFingerprint(core);
  if (m.fingerprint && m.fingerprint !== fp) {
    problems.push(`指紋不符：內容變了但 release 沒 bump（manifest release=${m.release}）`);
  }

  // 🔴 2026-08-02 加閘：manifest 少了「用戶端會讀的欄位」也要紅。
  // 由來＝1.4.0 把 `daemon` 欄靜默吃掉，daemon 的「檢查更新」全體壞掉整整一天，
  // 而當時機械閘全綠——因為它只驗 sha 與指紋，不驗「該有的東西還在不在」。
  // 判準：只要 bundles repo 裡有 daemon/ 產物，manifest 就必須有對應的 daemon 版本欄。
  // 🔴 2026-08-06 加閘：UI 那顆**必須自報版本**（`/__version` 路由）才准出貨。
  // 由來＝這條路由在 1.4.2 實測有效，但它只活在 `fix/cis-round3-install` 分支上的
  // build-ui-bundle.mjs；那條分支被刪掉後路由整條蒸發，而 main 那份從來沒有過它。
  // 之後每一版打出來的 UI 都沒有版本端點，沒有任何閘發現——因為既有的閘只驗
  // 「sha 對不對」「版本有沒有 bump」，不驗「該有的能力還在不在」。
  // 少了它的後果：安裝器的 UI 探測永遠解析不到 JSON ⇒ 每次安裝都全量重推 24 顆；
  // 而只要哪天 UI 長回一條會回 JSON 卻不帶版本號的路由，就會反向誤判成「已是最新、
  // 永遠不重推」＝t168/t170 事故原形。
  const uiEntry = (m.core || []).find((c) => c && c.name === 'arcrun-rag-ui');
  if (uiEntry && uiEntry.main_file) {
    const uiPath = join(bundlesDir, uiEntry.main_file);
    if (existsSync(uiPath)) {
      const uiSrc = readFileSync(uiPath, 'utf8');
      if (!uiSrc.includes("p === '/__version'")) {
        problems.push('arcrun-rag-ui 產物沒有 /__version 路由——安裝器將無法判斷前端新舊（既有實例的 UI 會每次全量重推，或反向誤判成最新而永遠不更新）。用 installer/scripts/build-ui-bundle.mjs 重打包。');
      }
      if (!uiSrc.includes('ARCRUN_BUNDLE_VERSION')) {
        problems.push('arcrun-rag-ui 產物沒有讀 ARCRUN_BUNDLE_VERSION——/__version 會回空版本號，安裝器的版本比對形同虛設。');
      }
    }
  }

  if (existsSync(join(bundlesDir, 'daemon'))) {
    const d = m.daemon;
    if (!d || !String(d.version || '').trim()) {
      problems.push('有 daemon/ 產物卻沒有 manifest.daemon.version——daemon 的「檢查更新」會回「manifest 沒有 daemon 版本欄位」而全體失效');
    } else {
      // 🔴 2026-08-06 加第三條規則：**宣告的版本必須等於產物真正的版本**。
      // 由來（leo 08-06 封測）：manifest 宣告 daemon v0.18.5，但線上 Windows zip
      // 拆開，exe 內嵌版本是 **v0.18.4**——0.18.5／0.18.6 兩次只重打了 Mac DMG，
      // Windows 的產物一個字都沒重打，而 manifest 的版本號是**手寫**的。
      // 當時這道 verifyManifest **全綠放行**，因為它只驗兩件事：
      //   ① version 欄在不在（在，寫著 v0.18.5）
      //   ② file 指的檔存不存在（存在，`...-v0.18.4.zip` 真的在那）
      // ⇒ 那個病剛好從兩條規則中間的縫穿過去。缺的正是「兩者要一致」。
      const declared = String(d.version || '').trim();
      for (const os of ['mac', 'win']) {
        const f = d[os] && d[os].file;
        if (!f) continue;
        const p = join(bundlesDir, f);
        if (!existsSync(p)) {
          problems.push(`manifest.daemon.${os}.file 指向 ${f}，但檔案不存在`);
          continue;
        }
        // (a) 檔名要帶宣告的版本。**光這一條就足以擋下 08-06 那次**
        //     （宣告 v0.18.5、檔名卻是 -v0.18.4.zip）。
        if (!f.includes(declared)) {
          problems.push(
            `manifest.daemon.version 宣告 ${declared}，但 ${os} 的檔名是 ${f}` +
            `——版本與產物對不上（多半是只重打了另一個平台，這一邊沒重打）`);
          continue;
        }
        // (c) 🔴 2026-08-08 加第四條：**使用者會讀到的那一行**也要過閘。
        //     由來（leo 真機看 v0.18.24 更新畫面）：「不要這麼長的散文，簡短講改了什麼，
        //     細節去 docs 讀。」他看到一整面文字牆，`**粗體**` 還原樣露出來——
        //     因為那個欄位是純文字（main.js:215 `esc(u.notes)`，`.d` 不保留換行），
        //     而 notes 當時是出貨當下臨時手工折出來的，**沒有任何閘看過它**。
        //     ⇒ 這一行必須等於 changelog 的機械投影，手改一律擋下。
        //     （注意：這段只驗一次，放在平台迴圈外側——見迴圈後。）
        // (b) 未壓縮的執行檔再驗一層：版本字串要真的在二進位裡面。
        //     檔名可以手改，但內嵌版本是 build 時 -ldflags 打進去的，改不了。
        if (/\.exe$/i.test(f)) {
          if (!readFileSync(p).includes(Buffer.from(declared, 'utf8'))) {
            problems.push(
              `${f} 的二進位裡找不到版本字串 ${declared}` +
              `——檔名對了但內容是別版（重打包時漏了？）`);
          }
        }
      }
      // (c) 更新畫面那一行：必須存在、可讀、且**等於 changelog 的機械投影**。
      for (const p of checkNotes(d.notes)) problems.push(p);
      const expect = notesFromChangelog(repoRoot, declared);
      if (!expect) {
        problems.push(
          `changelog 沒有 ${declared} 這一版——使用者按「檢查更新」看不到這版改了什麼。` +
          `先在 docs-site/src/content/docs/help/changelog.md 補一段再出貨。`);
      } else if (String(d.notes || '').trim() !== expect) {
        problems.push(
          `manifest.daemon.notes 與 changelog 對不上（有人手改了投影）。\n` +
          `       現在是：${JSON.stringify(String(d.notes || '').slice(0, 70))}\n` +
          `       應該是：${JSON.stringify(expect)}\n` +
          `       → 跑 ship.mjs 的 notes 步驟會自動改對；要改內容請改 changelog，不要改這裡`);
      }
    }
  }
  return problems;
}
