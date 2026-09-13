/**
 * installer-line.mjs — **安裝器自己那條版本線**（inkstone/arcrun-rag#169，2026-09-01）
 *
 * ── 為什麼有這支 ────────────────────────────────────────────────────────────
 * 2026-08-31 實撞（`inkstone/Arcrun#190`）：工人把安裝器改掉 1640 行
 * （自己幫乾淨帳號開 workers.dev 子網域、錯誤訊息改成說真話、靜默降級可見化），
 * 而 leo 會看的每一個畫面上，**版本號一動也沒動**。
 *
 * 真因不是「忘了升號」，是**安裝器在出貨線上是「產出物」，不是「版本線」**：
 *   · `1.4.x` 的內容指紋只認 `manifest.core[]`（＝使用者 Cloudflare 帳號上那幾十顆 worker）
 *     ⇒ 安裝器的 worker.js 根本不在指紋的定義域裡，改它版本必然不動
 *   · `INSTALLER_PATCH` 是**手填字串**，而且顯示在摺疊的「技術細節」裡
 *     ⇒ 它既不是機器算的，也不在 leo 會看的地方
 *   · `installer_sha` 是內容雜湊，不是版本號——它治的是「該不該重部署」，不是「這是第幾版」
 *
 * ⇒ 所以**安裝器要有自己的號碼**，而且它要跟 `1.4.x`／`0.18.x` 同一個形狀：
 *   由內容算出來（不是人宣告）、寫在 `/api/latest`、畫面上看得到、出貨線有閘管它。
 *
 * ── 三條線各是什麼、什麼時候動哪一條（本票驗收條件之一）──────────────────────
 * ```
 * 1.4.x   零件包      使用者**自己的 Cloudflare 帳號上跑的那些 worker**
 *                     動的時機：Arcrun 編出來的零件內容變了（manifest.core[] 指紋）
 * 0.18.x  桌面小幫手  使用者**電腦上那支 App**
 *                     動的時機：collector/ 打出新的執行檔
 * 1.0.x   安裝器      **install.arcrun.dev 那個網站自己**（按下「開始安裝／更新」的那頁）
 *                     動的時機：installer/oauth-prototype/ 底下的行為碼變了
 * ```
 * 🔴 **不准兩條同時是真相**：三條線各有各的定義域，互不重疊——
 *   改安裝器**不會**讓 `1.4.x` 跳號（那會讓每一台既有實例被誤報「有新版」，
 *   使用者被騙去重裝一次內容一模一樣的東西）；
 *   換零件包**不會**讓安裝器跳號（安裝器一行沒改，說它是新版就是說謊）。
 *
 * ── 演算法照抄 `release.mjs`，刻意不另發明一套 ──────────────────────────────
 *   MAJOR.MINOR ← 人決定（`installer/INSTALLER_LINE`，大改版才動）
 *   PATCH       ← 機器決定：安裝器原始碼指紋一變就 +1，沒變就不動（重跑不虛增）
 * 「上一版是什麼」跟零件包共用同一個檔（`installer/release-state.json`）的
 * `installer` 區塊——只認內容指紋，不認是 stage 還是 prod，
 * 所以**同一份原始碼在兩個環境必然算出同一個號碼**（同 release.mjs 的 sharedState）。
 *
 * ── 指紋的定義域（比舊的 `installerSourceHash` 大，這是刻意的）────────────────
 * 舊版只雜湊 `worker.js` ＋ `migrations.json`。但安裝器的行為早就不只住在那兩個檔裡
 * （`shared/resource-rule/rule.mjs` 決定資源沿用、`version-stamp.mjs` 決定烙什麼印記、
 * `workflows.json`／`skills.json` 決定種什麼進去）——改它們，舊指紋一動也不動。
 * ⇒ 那正是本票要治的病的另一種長法：**改了安裝器，而沒有任何數字會變**。
 * 現在的定義域＝`installer/oauth-prototype/` 底下所有 `.js`／`.mjs`／`.json`，扣掉：
 *   · `*.test.mjs` 與任何 `tests/` 目錄底下的東西  測試不是使用者拿到的（改測試不該跳號）
 *   · `version.mjs`                          它是**這支算出來的結果**，算進去會追自己的尾巴
 *   · `worker.js` 裡的釘子兩行                pin 站每趟出貨都改寫它們（理由同上）
 * `wrangler.toml` 不在定義域裡（副檔名就不收）——它是每個目標各自的部署參數，
 * 收進來會讓 stage 與 prod 算出不同號碼。
 *
 * ── 指紋為什麼**跟版本號一起烙進 version.mjs**（2026-09-01 第二輪，comment 5959）──────
 * 第一輪把號碼做對了，但「線上跑的是哪一份原始碼」那一格（`/api/latest` 的
 * `installer_sha`）留在 `wrangler.toml` 的 `INSTALLER_SRC_SHA` 裡，由出貨線的 pin 站寫。
 * 實測結果：**它答錯**——prod 跑 1.0.3、uncle6 staging 跑 1.0.4，兩條線回同一串
 * `5ada702b…`，而且兩個都對不上 main 的 `bc899878…`。
 *
 * 🔴 病根不是「沒人維護」，是**它靠人記得**：
 *   · `ship.targets.json` 只有 `selftest／stage／prod`，**沒有 `youlin-stage`**
 *     ⇒ 那條線結構上只能手填，而手填的東西一定會過期
 *   · 手部署（`npx wrangler deploy --env …`）整條路**不經過 pin 站**
 *     ⇒ 部署一次、那一格就變成舊的，一次都不用做錯
 *   · 它跟版本號**分住兩個檔**，所以可以只動一個 ⇒ 兩個都像答案，其中一個是假的
 *
 * ⇒ 現在這支把**指紋與號碼寫在同一個產物裡**（`version.mjs`），worker 直接 import
 *   ⇒ **部署動作只有一種：把這棵樹推上去。** 推上去的那份必然自帶自己的指紋，
 *     沒有第二個地方要記得改，也沒有「哪條線不在登錄簿裡」這種破口。
 *   `verifyInstallerVersion()` 多一條：version.mjs 烙的指紋 ≠ 現在這棵樹 ⇒ 當場擋下
 *   ⇒ 「值對不上就吵」由閘負責，不是靠人拿兩串 sha 用眼睛比。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { RELEASE_STATE_FILE, readReleaseState, writeReleaseState } from './release.mjs';

/** MAJOR.MINOR 放這裡——唯一需要人動的一行，且只在大改版時動。 */
export const INSTALLER_LINE_REL = 'installer/INSTALLER_LINE';
/** 安裝器的更新說明（使用者語言）。出貨線兩道閘都會問它。 */
export const INSTALLER_CHANGELOG_REL = 'installer/CHANGELOG.md';
/** 版本號的落地位置：worker.js import 它、`/api/latest` 吐它、畫面顯示它。 */
export const INSTALLER_VERSION_REL = 'installer/oauth-prototype/version.mjs';
/** 安裝器原始碼的家。 */
export const INSTALLER_SRC_REL = 'installer/oauth-prototype';

const DEFAULT_LINE = '1.0';

/** 指紋收哪些副檔名。`.toml`／`.md` 刻意不收（部署參數與文件不是行為）。 */
const SOURCE_EXT = /\.(js|mjs|json)$/;

/** 這些**不算**安裝器的行為碼——理由逐條寫在檔頭「指紋的定義域」。 */
export function isSourceFile(relPath) {
  const p = relPath.split(sep).join('/');
  if (!SOURCE_EXT.test(p)) return false;
  if (p.endsWith('.test.mjs')) return false;
  if (p.split('/').includes('tests')) return false;
  if (p === 'version.mjs') return false;
  return true;
}

/** 遞迴列出定義域內的檔案（相對 `dir`，已排序 ⇒ 指紋與檔案系統的列舉順序無關）。 */
export function installerSourceFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(abs, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(dir, full);
      if (isSourceFile(rel)) out.push(rel.split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * 讀一個檔並抹掉「出貨線自己會改寫的值」。
 * 不抹的話，pin 站每趟出貨寫進去的釘子會讓指紋跟著變 ⇒ 版本號每趟都 +1，
 * 而安裝器一行邏輯都沒改（同 release.mjs 排除 built/release/source 自己的理由）。
 */
export function normalizeSource(rel, text) {
  if (rel !== 'worker.js') return text;
  return text
    .replace(/const DEFAULT_BUNDLE_BASE = '[^']*'/, "const DEFAULT_BUNDLE_BASE = ''")
    .replace(/const BUNDLE_BUILT = '[^']*'/, "const BUNDLE_BUILT = ''");
}

/**
 * 安裝器原始碼的內容指紋。**檔名也進雜湊**——只雜湊內容的話，
 * 把一個檔改名（等於換掉一條 import 路徑）指紋不會變。
 * @param {string} dir `installer/oauth-prototype` 的絕對路徑
 */
export function installerFingerprint(dir) {
  const h = createHash('sha256');
  for (const rel of installerSourceFiles(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(normalizeSource(rel, readFileSync(join(dir, rel), 'utf8')));
    h.update('\0');
  }
  return h.digest('hex');
}

/** 讀 MAJOR.MINOR。檔案不存在就用預設值（缺檔不致命，但格式錯一定吵）。 */
export function readInstallerLine(repoRoot) {
  const p = join(repoRoot, INSTALLER_LINE_REL);
  if (!existsSync(p)) return DEFAULT_LINE;
  const v = readFileSync(p, 'utf8').trim();
  if (!/^\d+\.\d+$/.test(v)) {
    throw new Error(`${INSTALLER_LINE_REL} 必須是 MAJOR.MINOR（例 1.0），現在是 ${JSON.stringify(v)}`);
  }
  return v;
}

/** 從 `version.mjs` 讀出現在寫著的號碼（讀不到回 null——呼叫端當成「還沒有」）。 */
export function readInstallerVersion(repoRoot) {
  const p = join(repoRoot, INSTALLER_VERSION_REL);
  if (!existsSync(p)) return null;
  const m = readFileSync(p, 'utf8').match(/export const INSTALLER_VERSION = '([^']*)'/);
  return m && m[1] ? m[1] : null;
}

/**
 * 從 `version.mjs` 讀出烙在裡面的原始碼指紋（讀不到回 null）。
 * `/api/latest` 的 `installer_sha` 就是這一格——**線上回什麼，就真的是線上那份碼**。
 */
export function readInstallerSrcSha(repoRoot) {
  const p = join(repoRoot, INSTALLER_VERSION_REL);
  if (!existsSync(p)) return null;
  const m = readFileSync(p, 'utf8').match(/export const INSTALLER_SRC_SHA = '([^']*)'/);
  return m && m[1] ? m[1] : null;
}

/** 寫回 `version.mjs`。內容整份重產——這個檔是機器的產物，不接受人手改的殘留。 */
export function writeInstallerVersion(repoRoot, version, fingerprint) {
  const p = join(repoRoot, INSTALLER_VERSION_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, renderVersionModule(version, fingerprint));
  return p;
}

export function renderVersionModule(version, fingerprint) {
  return `/**
 * 安裝器自己的版本號與原始碼指紋——**這個檔是機器產生的，不要手改**。
 *
 * 產地＝\`installer/scripts/installer-line.mjs\`（出貨線的 version 站會呼叫它）：
 * 安裝器原始碼的內容指紋一變，這個號碼就 +1；沒變就不動。
 * 手改它會被 \`--check\` 當場擋下（指紋對不上宣告的號碼 ⇒ 出貨中止）。
 *
 * 它跟 \`1.4.x\`（零件包）、\`0.18.x\`（桌面小幫手）是**三條互不重疊的線**，
 * 理由與判準寫在 installer-line.mjs 的檔頭。
 *
 * 🔴 \`INSTALLER_SRC_SHA\` 為什麼住在這裡、不住在 \`wrangler.toml\`：
 *   住在部署參數裡的話，它靠「部署的人記得改」——而手部署與不在
 *   \`ship.targets.json\` 裡的線（例如 youlin-stage）根本不經過會改它的那一站
 *   ⇒ 2026-09-01 實測：兩條跑著不同版本的線回同一串 sha，兩個都對不上原始碼。
 *   烙在這個檔裡＝**它跟原始碼一起被部署**，部署動作只有一種，沒有第二處要記得。
 */
export const INSTALLER_VERSION = '${version}';
export const INSTALLER_SRC_SHA = '${fingerprint}';
`;
}

/**
 * 下一個號碼。與 `release.mjs` 的 `nextRelease` 同一套規矩（刻意重複一次而不是共用：
 * 那支的參數順序綁著零件包的語意，共用會讓兩條線的規則被同一次修改牽動）。
 */
export function nextInstallerVersion(line, prevVersion, prevFingerprint, nextFingerprint) {
  const ok = typeof prevVersion === 'string' && /^\d+\.\d+\.\d+$/.test(prevVersion);
  const [pMajor, pMinor, pPatch] = ok ? prevVersion.split('.') : [];
  const sameLine = ok && `${pMajor}.${pMinor}` === line;
  if (sameLine && prevFingerprint === nextFingerprint) return prevVersion;
  if (!sameLine) return `${line}.0`;
  return `${line}.${Number(pPatch) + 1}`;
}

/** 共用版本狀態裡屬於安裝器的那一格。 */
export function readInstallerState(repoRoot) {
  const s = readReleaseState(repoRoot);
  return s && s.installer && typeof s.installer === 'object' ? s.installer : null;
}

/**
 * 主入口：算指紋 → 決定號碼 → 寫回 `version.mjs` 與共用狀態。
 * 冪等：同樣的原始碼重跑幾次，號碼都不會變。
 */
export function syncInstallerVersion(repoRoot, { quiet = false } = {}) {
  const dir = join(repoRoot, INSTALLER_SRC_REL);
  if (!existsSync(dir)) throw new Error(`找不到安裝器原始碼目錄：${dir}`);
  const line = readInstallerLine(repoRoot);
  const fingerprint = installerFingerprint(dir);
  const state = readInstallerState(repoRoot);
  // 第一次呼叫（狀態還沒有這一格）從**磁碟上那份 version.mjs** 接手，不歸零成 `${line}.0`
  // ——同 release.mjs：這是已經真的在線上跑的東西，接手才不會讓號碼無故倒退。
  const previous = state ? state.version : readInstallerVersion(repoRoot);
  const prevFingerprint = state ? state.fingerprint : null;
  const version = nextInstallerVersion(line, previous, prevFingerprint, fingerprint);
  const changed = version !== previous;

  writeInstallerVersion(repoRoot, version, fingerprint);
  writeReleaseState(repoRoot, { installer: { fingerprint, version } });

  if (!quiet) {
    console.log(!previous
      ? `🧰 安裝器版本 ${version}（這條線第一次有號碼）`
      : changed
        ? `🧰 安裝器版本 ${previous} → ${version}（原始碼有變，patch +1）`
        : `🧰 安裝器版本 ${version}（原始碼未變，不動）`);
  }
  return {
    version, changed, fingerprint, previous,
    // 指紋動了 ⇒ 線上那份碼跟這棵樹不一樣了 ⇒ deploy 站不准跳過。
    // 與 `changed` 不同：號碼可能因為「這條線第一次有號碼」而動，指紋卻沒動。
    fingerprintChanged: Boolean(prevFingerprint) && prevFingerprint !== fingerprint,
  };
}

/**
 * 機械閘：**現在磁碟上的原始碼，配不配得上 `version.mjs` 宣告的那個號碼？**
 * 回傳問題清單（空＝通過）。這是「故意不升號」被擋下的那一道。
 * @param {string} repoRoot
 * @param {{changelog?: boolean}} o changelog:true 時一併要求該版有使用者看得懂的更新說明
 */
export function verifyInstallerVersion(repoRoot, { changelog = true } = {}) {
  const problems = [];
  const dir = join(repoRoot, INSTALLER_SRC_REL);
  const declared = readInstallerVersion(repoRoot);
  if (!declared) {
    problems.push(`${INSTALLER_VERSION_REL} 讀不到 INSTALLER_VERSION——安裝器沒有版本號，`
      + `使用者與 leo 都無從判斷線上那頁是哪一版（跑 \`node installer/scripts/installer-line.mjs --write\` 產生）。`);
    return problems;
  }
  const line = readInstallerLine(repoRoot);
  if (!declared.startsWith(`${line}.`)) {
    problems.push(`${INSTALLER_VERSION_REL} 宣告 ${declared}，但 ${INSTALLER_LINE_REL} 說這條線是 ${line}。`);
  }
  const fingerprint = installerFingerprint(dir);
  const state = readInstallerState(repoRoot);
  if (!state) {
    problems.push(`${RELEASE_STATE_FILE} 裡沒有 installer 這一格 ⇒ 沒有「上一版是什麼」的比較基準，`
      + `無法判斷 ${declared} 是不是跟得上現在的原始碼（跑 \`--write\` 建起來）。`);
  } else if (state.fingerprint !== fingerprint) {
    problems.push(
      `安裝器原始碼改了，但版本號沒跟上：${INSTALLER_VERSION_REL} 還寫著 ${declared}。\n`
      + `       指紋 ${String(state.fingerprint).slice(0, 12)}… → ${fingerprint.slice(0, 12)}…\n`
      + `       ⇒ 這一版送上去，leo 從他會看的任何一個畫面都看不出安裝器變了（inkstone/arcrun-rag#169 就是這個病）。\n`
      + `       → 跑 \`node installer/scripts/installer-line.mjs --write\` 讓號碼跟上，再把這一版寫進 ${INSTALLER_CHANGELOG_REL}。`);
  } else if (state.version !== declared) {
    problems.push(`${INSTALLER_VERSION_REL} 寫 ${declared}，但 ${RELEASE_STATE_FILE} 記的是 ${state.version}`
      + `——兩份對不上時不猜哪一份對，跑 \`--write\` 重算。`);
  }
  // 🔴 這一條治的是 comment 5959 量到的病：**識別值答錯**。
  //   `/api/latest` 的 `installer_sha` 就是這一格 ⇒ 它對不上這棵樹，
  //   線上就會回一個「看起來像答案、實際是別份碼」的 sha，而那比沒有更貴。
  const declaredSha = readInstallerSrcSha(repoRoot);
  if (!declaredSha) {
    problems.push(`${INSTALLER_VERSION_REL} 讀不到 INSTALLER_SRC_SHA ⇒ \`/api/latest\` 的 `
      + `installer_sha 會回 null，「線上跑的是哪一份原始碼」從外面問不出來`
      + `（跑 \`node installer/scripts/installer-line.mjs --write\` 烙上去）。`);
  } else if (declaredSha !== fingerprint) {
    problems.push(
      `${INSTALLER_VERSION_REL} 烙的原始碼指紋對不上現在這棵樹：\n`
      + `       烙的 ${declaredSha.slice(0, 12)}… ／ 這棵樹 ${fingerprint.slice(0, 12)}…\n`
      + `       ⇒ 這一版部上去，\`/api/latest\` 會回一串屬於別份碼的 sha（inkstone/arcrun-rag#169 comment 5959 量到的就是這個）。\n`
      + `       → 跑 \`node installer/scripts/installer-line.mjs --write\` 重烙。`);
  }
  if (changelog && !installerChangelogHas(repoRoot, declared)) {
    problems.push(
      `${INSTALLER_CHANGELOG_REL} 裡沒有 ${declared} 這一版。\n`
      + `       ⇒ 安裝器改了、號碼也動了，但使用者查不到「這版改了什麼」。\n`
      + `       → 補一段 \`## ${declared}（${new Date().toISOString().slice(0, 10)}）\`，用一兩句使用者看得懂的話寫。`);
  }
  return problems;
}

/** 這一版在安裝器 changelog 裡有沒有一段內文（空段落不算有）。 */
export function installerChangelogHas(repoRoot, version) {
  return Boolean(installerChangelogSection(repoRoot, version));
}

/**
 * 抓 `## <version>` 到下一個 `## ` 之間的內文。找不到／整段空白回 null。
 * （與 github-release.mjs 的 `sectionIn` 同一種切法；那支是私有函式，這裡不去動它。）
 */
export function installerChangelogSection(repoRoot, version) {
  const p = join(repoRoot, INSTALLER_CHANGELOG_REL);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split('\n');
  const esc = String(version).replace(/[.\\]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${esc}(\\D|$)`).test(l.trim()));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.length ? body.join('\n') : null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// `--write`  算一次並寫回（出貨線的 version 站做的就是這件事）
// `--check`  只檢查，不寫。不過就 exit 1 ⇒ 可以掛在 pre-commit／CI 上。
// 不帶參數   印現況（號碼、指紋、定義域裡有幾個檔）
if (process.argv[1] && process.argv[1].endsWith('installer-line.mjs')) {
  const repoRoot = join(import.meta.dirname, '..', '..');
  const args = new Set(process.argv.slice(2));
  const dir = join(repoRoot, INSTALLER_SRC_REL);
  if (args.has('--write')) {
    syncInstallerVersion(repoRoot);
    const probs = verifyInstallerVersion(repoRoot);
    if (probs.length) { probs.forEach((p) => console.error('❌ ' + p)); process.exit(1); }
    console.log('✅ 版本號與原始碼一致，且 changelog 有這一版');
  } else if (args.has('--check')) {
    const probs = verifyInstallerVersion(repoRoot);
    if (probs.length) {
      console.error('❌ 安裝器版本線機械閘不過：');
      probs.forEach((p) => console.error('   • ' + p));
      process.exit(1);
    }
    console.log(`✅ 安裝器 ${readInstallerVersion(repoRoot)}：版本號跟得上原始碼，changelog 也有這一版`);
  } else {
    const files = installerSourceFiles(dir);
    console.log(`安裝器版本線 ${readInstallerLine(repoRoot)}｜現在是 ${readInstallerVersion(repoRoot) || '(無)'}`);
    console.log(`指紋 ${installerFingerprint(dir)}`);
    console.log(`定義域 ${files.length} 個檔：${files.join('、')}`);
  }
}
