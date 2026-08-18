#!/usr/bin/env node
/**
 * daemon-in-bundle-gate.mjs — 「**這個版本的 daemon，到底在不在成品裡**」
 *
 * ── 這道閘治什麼（inkstone/InkStoneCo#40，D95 第二輪）────────────────────────
 *
 * D95 第一輪把 daemon 的版本說明從 `docs-site/src/content/docs/help/changelog.md`
 * 搬進 `collector/CHANGELOG.md`（daemon 自己的樹），讓 `collector/` 自足。
 * **但出貨線還停在舊假設上**——`ship.mjs` 的兩站照舊去 docs-site 找 `^## vX.Y.Z（`：
 *
 *     ship.mjs:797  daemon-sync   找不到 → status:'skip'
 *     ship.mjs:889  daemon-check  找不到 → status:'skip'
 *
 * 而 docs-site 現在只剩雲端引擎那條線（`1.4.x`，**沒有 `v` 前綴**）⇒ 正則永遠不中
 * ⇒ 兩站**每次都跳過**⇒ 出貨線照印 ✅、新 daemon 不進 bundle、使用者按「檢查更新」
 * 永遠拿舊的。**那正是 `inkstone/arcrun-rag#88` 那個「斷更四版」的形狀，換個入口重演。**
 *
 * 🔴 病根不是「路徑寫錯了」，是**這兩站把「我找不到東西」當成「沒事可做」**。
 *   路徑改對只治這一次；`skip` 這個出口留著，下次任何一個結構調整都會再演一遍。
 *   ⇒ 本檔的第一原則：**沒有 `skip`。** 問不出來就是斷。
 *
 * ── 三條設計判準（照 `release-line-gate.mjs` 的形狀，那支是同一票的前案）────────
 *
 * ① **會擋，不是只提醒**：任一項不過就丟例外／exit 1，`ship.mjs` 當場中止出貨。
 *
 * ② **看事實，不看字串**（InkStoneCo#55 紅線：文字層的閘當天 8 次誤攔、0 次正確攔截）。
 *    本閘問的每一項都是**磁碟上量得到的量**，不是「某個字串長什麼樣」：
 *      · 那個檔案**在不在**（`existsSync`）
 *      · 它的 **sha256 是多少**（真的把位元讀進來算，不是抄 manifest 的數字）
 *      · 它有**多少位元組**
 *      · manifest 宣告的版本**是不是**源碼那棵樹宣告的版本
 *    唯一一次「比對文字」是版本號字面（`v0.18.29`）——而那是**識別碼**，
 *    不是「命令列裡有沒有出現某個關鍵字」那種啟發式猜測。
 *
 * ③ **閘自己要能被演練**：`collectFacts()`（碰磁碟）與 `judge()`（純函式）分開，
 *    `daemon-in-bundle-gate.test.mjs` 直接餵事實物件，該擋與不該擋各數種。
 *
 * ── 留痕（InkStoneCo#48：36 支閘只有 2 支會記錄自己擋了什麼）─────────────────
 * 每一次執行——**擋下與放行都記**——附一行到 `installer/daemon-in-bundle-gate-log.md`。
 * 只記擋下的話分母是未知的，回答不了「這道閘到底有沒有在運作」。
 *
 * ── 為什麼「找不到 changelog」要當成最嚴重的一項 ────────────────────────────
 * leo 2026-08-17（D95）：「**不要有很多扭曲**，因為你根本不記得你做的這些扭曲，
 * 每次都要查，很直接，源碼、產出物，從 stage 到 prod。」
 * daemon 的說明檔搬家 ＝ 這條鏈的頭被移動了。頭移動時，**鏈條要斷得很大聲**，
 * 不是安靜地接到空氣上。所以 `changelog-found` 不過時，訊息直接指名
 * 「出貨線與 daemon 源碼樹對這份檔案的位置有分歧」，而不是含糊的「跳過核對」。
 *
 * 用法：
 *   node installer/scripts/daemon-in-bundle-gate.mjs --target stage   # 不過就 exit 1
 *   node installer/scripts/daemon-in-bundle-gate.mjs --bundles <dir>  # 直接指一個 bundle 目錄演練
 */
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');
export const GATE_LOG_REL = join('installer', 'daemon-in-bundle-gate-log.md');

/**
 * 必要平台。缺任何一個 ＝ 有一群使用者這一版拿不到東西，不准含糊出貨
 * （與 `ship.mjs` daemon-sync 的 `required:true` 同一份清單，值一致才不會兩邊漂）。
 * `msix` 刻意不在內：它是 MS Store 的選配，缺了不影響任何人自己下載安裝。
 */
export const REQUIRED_PLATFORMS = ['mac', 'win'];

// 只認「已發佈」段落，忽略「## 下一版（未發佈）」草稿。
//
// 🔴 2026-08-18 第一輪（#88）：本來這裡自己有一份 regex 拷貝，註解寫著「與 daemon-freshness／
//    daemon-version.py 同一個判斷式」——知道該一致卻靠人記得改四個地方。收成了同一份。
//
// 🔴 2026-08-18 第二輪（#88，就是本次）：那份共用的判斷式**釘死 `v` 前綴**，
//    而那個 `v` 兼任「哪一條版本線」的判別器。leo 要的裸號一落到產生端，它就會
//    **安靜地**略過新版、比對到更舊的一版 ⇒ manifest 說謊而全站亮綠。
//    ⇒ 判別的承載換成 `collector/DAEMON_LINE` 宣告的那條線（見 daemon-notes.mjs）。
//    ⇒ 判斷式因此要**先讀那個檔**才生得出來，不再是一個常數 ⇒ 這裡改成 re-export 產生器。
export { daemonReleasedRe, readDaemonLine, ANY_RELEASED_RE, DAEMON_LINE_REL } from './daemon-notes.mjs';
import { daemonReleasedRe, readDaemonLine, ANY_RELEASED_RE, DAEMON_LINE_REL } from './daemon-notes.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// 1. 取事實 —— 這一段碰磁碟，而且**只碰磁碟**（不碰網路、不跑任何指令）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把「這次出貨的 daemon 到底是什麼狀態」量成一個純資料物件。
 *
 * 🔴 這裡刻意**不做任何判斷**——量到什麼就記什麼（包含「量不到」）。
 *   判斷全部留給 `judge()`，這樣測試才餵得進來，而閘的規則才只有一份。
 *
 * @param {object} o
 * @param {string} o.repoRoot        arcrun-rag repo 根
 * @param {string} o.bundlesDir      這個目標的 bundle 工作目錄（成品在這裡）
 * @param {string} o.changelogRel    daemon 版本說明檔相對路徑（單一真相源＝
 *                                   `installer/scripts/daemon-notes.mjs` 的 `DAEMON_CHANGELOG_REL`）
 * @param {string[]} [o.requiredPlatforms]
 */
export function collectFacts({ repoRoot, bundlesDir, changelogRel, requiredPlatforms = REQUIRED_PLATFORMS }) {
  // 🔴 版本線是**宣告出來的事實**，所以它自己就是一項要量的事實（#88 第二輪）。
  //   量不到就記 null——判不判得下去交給 judge()，這裡不代它決定，也不給預設值。
  const daemonLinePath = join(repoRoot, DAEMON_LINE_REL);
  const daemonLine = readDaemonLine(daemonLinePath);

  const changelogPath = join(repoRoot, changelogRel);
  const changelogFound = existsSync(changelogPath);
  let sourceVersion = null;
  let changelogTopAny = null;
  if (changelogFound) {
    const text = readFileSync(changelogPath, 'utf8');
    // ① 判斷用：只認**這條線**的版本段（裸號與舊的帶 v 都認）。
    if (daemonLine) {
      const m = text.match(daemonReleasedRe(daemonLine));
      sourceVersion = m ? m[1] : null;
    }
    // ② 診斷用：這份檔案最上面實際寫的是哪一版。**永遠不參與判斷**——
    //    它存在只為了讓「① 沒中」時的訊息說得出「你指到的是 1.4.47，那是雲端那條線」。
    const any = text.match(ANY_RELEASED_RE);
    changelogTopAny = any ? any[1] : null;
  }

  const manifestPath = join(bundlesDir, 'manifest.json');
  const manifestFound = existsSync(manifestPath);
  let manifest = null;
  let manifestReadError = null;
  if (manifestFound) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { manifestReadError = e.message; }
  }
  const daemon = (manifest && manifest.daemon) || null;

  // 宣告了哪些平台、每個平台指向哪個檔——然後**真的去把那個檔讀進來算雜湊**。
  const artifacts = [];
  if (daemon) {
    for (const key of Object.keys(daemon)) {
      const v = daemon[key];
      if (!v || typeof v !== 'object' || typeof v.file !== 'string') continue;   // version／notes／built 不是平台
      const path = join(bundlesDir, v.file);
      const found = existsSync(path);
      let actualSha = null;
      let sizeBytes = null;
      if (found) {
        const buf = readFileSync(path);
        actualSha = createHash('sha256').update(buf).digest('hex');
        sizeBytes = statSync(path).size;
      }
      artifacts.push({
        key, declaredFile: v.file, declaredSha: v.sha256 || null,
        path, found, actualSha, sizeBytes, fileName: basename(v.file),
      });
    }
  }

  return {
    daemonLineRel: DAEMON_LINE_REL, daemonLinePath, daemonLine,
    changelogRel, changelogPath, changelogFound,
    sourceVersion, changelogTopAny,
    manifestPath, manifestFound, manifestReadError,
    bundleVersion: (daemon && daemon.version) || null,
    bundleDeclaresDaemon: !!daemon,
    artifacts,
    requiredPlatforms,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 判斷 —— 純函式：事實進，判決出。**沒有 skip 這個出口。**
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} facts collectFacts() 的產物（測試可直接手捏）
 * @returns {{ok:boolean, version:string|null, checks:Array, blockers:string[]}}
 *   `checks` 每一項＝`{ id, name, ok, fact }`；`fact` 是**量到的那個值**，不是形容詞。
 */
export function judge(facts) {
  const checks = [];
  const add = (id, name, ok, fact, problem = null) => {
    checks.push({ id, name, ok, fact, problem });
    return ok;
  };

  // ── ⓪ daemon 宣告了自己走哪一條版本線嗎（#88 第二輪新增）───────────────
  //    這一項排在最前面，因為**沒有線就沒有判別器**：底下「哪一段 changelog 是
  //    daemon 的」全靠它。以前這件事由「版本號有沒有 `v` 前綴」暗中兼任，
  //    於是 leo 要的裸號一落到產生端，判別就無聲失效（往下比對到更舊的一版）。
  //    ⇒ 判別依據必須是**看得見、量得到、宣告出來**的東西，而且它缺席時要斷。
  if (!add('daemon-line-declared', 'daemon 宣告了自己的版本線（DAEMON_LINE）',
    !!facts.daemonLine, facts.daemonLine || `(讀不出 ${facts.daemonLineRel})`,
    `讀不出 daemon 的版本線：${facts.daemonLinePath}\n` +
    `         ⇒ 那個檔（內容例：\`0.18\`）是「哪一段 changelog 屬於桌面小幫手」的唯一判準。\n` +
    `           沒有它，出貨線分不出 daemon 的 \`0.18.x\` 與雲端引擎的 \`1.4.x\`。\n` +
    `         🔴 以前這件事是靠「版本號有沒有 \`v\`」暗中兼任的——那正是 arcrun-rag#88\n` +
    `           那個「打包出新版、manifest 卻宣稱舊版」的靜默病根。**判別依據不能是外觀。**\n` +
    `         → 補上 ${facts.daemonLineRel}，內容是 MAJOR.MINOR（daemon-version.py 也讀它）。`)) {
    return verdict(checks, facts);
  }

  // ── ① 源碼那棵樹的說明檔，在出貨線以為的位置嗎 ─────────────────────────
  //    不在 ＝ 出貨線與 daemon 源碼樹對「東西在哪」有分歧。這是 D95 那一類搬家
  //    造成的斷點，而它**以前的症狀是安靜跳過**，所以這裡話要講死。
  if (!add('changelog-found', 'daemon 的版本說明檔在出貨線宣告的位置找得到',
    facts.changelogFound, facts.changelogPath,
    `出貨線去 \`${facts.changelogRel}\` 找 daemon 的版本說明，那裡沒有東西。\n` +
    `         ⇒ **出貨線與 daemon 源碼樹對「這份檔案住哪」有分歧。**\n` +
    `           以前這種情況是 \`status:'skip'\`（安靜跳過）——腳本照印 ✅、新 daemon 不進 bundle、\n` +
    `           使用者按「檢查更新」永遠拿舊的。那就是 arcrun-rag#88「斷更四版」的形狀。\n` +
    `         → 唯一真相源是 \`installer/scripts/daemon-notes.mjs\` 的 \`DAEMON_CHANGELOG_REL\`。\n` +
    `           檔案搬了就改那一個常數，**不要在各站各自寫一次路徑**（那就是 D95 要拔掉的「扭曲」）。`)) {
    return verdict(checks, facts);
  }

  // ── ② 說明檔裡有一個「已發佈」的版本 ───────────────────────────────────
  const wrongLine = !facts.sourceVersion && facts.changelogTopAny;
  if (!add('source-version', `說明檔宣告了一個 ${facts.daemonLine} 這條線上的已發佈版本`,
    !!facts.sourceVersion,
    facts.sourceVersion || (wrongLine
      ? `最上面那一段是 ${facts.changelogTopAny}，不在 ${facts.daemonLine} 這條線上`
      : `(找不到 \`## ${facts.daemonLine}.Z（…）\` 段)`),
    `\`${facts.changelogRel}\` 裡沒有任何屬於 **${facts.daemonLine}** 這條線的已發佈版本段。\n` +
    (wrongLine
      ? `         量到的事實：這份檔案最上面的版本段是 \`## ${facts.changelogTopAny}（…）\`，\n` +
        `           而 ${facts.daemonLineRel} 宣告 daemon 走 \`${facts.daemonLine}\` 這條線 ⇒ **兩者不是同一條線**。\n` +
        `         → 常見成因①：路徑指錯了。雲端引擎那條（\`1.4.x\`）住在 repo 根的 \`CHANGELOG.md\`，\n` +
        `           daemon 那條住在 \`collector/CHANGELOG.md\`。\n` +
        `         → 常見成因②：${facts.daemonLineRel} 換線了（例 0.18 → 0.19）但還沒戳出新線的第一版\n` +
        `           ⇒ 跑 \`collector/cmd/arcrun-app/daemon-version.py --stamp\`。\n`
      : `         → 若確實還沒戳版：跑 \`collector/cmd/arcrun-app/daemon-version.py --stamp\`。\n`) +
    `         ⇒ 出貨線問不出「這次該送哪一版 daemon」，而問不出來**不等於沒事**——\n` +
    `           它等於「這次出貨不知道自己在送什麼」。\n` +
    `         🔴 這一項認得**兩種寫法**：新的裸號 \`0.18.31\` 與既有的 \`v0.18.30\`。\n` +
    `           （leo 2026-08-17「對外號就是三個數字」＋「既有 tag 不回頭改」⇒ 過渡期必然並存。）`)) {
    return verdict(checks, facts);
  }
  const want = facts.sourceVersion;

  // ── ③ 成品清單本身在不在 ───────────────────────────────────────────────
  if (!add('manifest-found', 'bundle 的 manifest.json 存在',
    facts.manifestFound && !facts.manifestReadError,
    facts.manifestPath + (facts.manifestReadError ? `（讀不動：${facts.manifestReadError}）` : ''),
    facts.manifestFound
      ? `bundle 的 manifest.json 讀不動：${facts.manifestReadError}`
      : `bundle 目錄裡沒有 manifest.json：${facts.manifestPath}\n` +
        `         ⇒ preflight 已經負責把 bundle repo clone／播種出來（見 ship.mjs (c) 段），\n` +
        `           走到這一站還沒有 manifest ＝ 那一步沒做成，不是「首次播種前的正常狀態」。`)) {
    return verdict(checks, facts);
  }

  // ── ④ 成品清單有沒有委任一個 daemon 版本 ───────────────────────────────
  if (!add('bundle-declares-daemon', 'bundle 委任了一個 daemon 版本',
    facts.bundleDeclaresDaemon && !!facts.bundleVersion,
    facts.bundleVersion || '(manifest 沒有 daemon 這一段)',
    `這個 bundle 的 manifest 沒有委任任何 daemon 版本，而源碼樹說已發佈的是 ${want}。\n` +
    `         ⇒ 使用者按「檢查更新」會**什麼都拿不到**。\n` +
    `         → 讓 daemon-sync 那一站把 ${want} 的產物搬進來（\`--confirm\` 才會真的搬）。`)) {
    return verdict(checks, facts);
  }

  // ── ⑤ 委任的版本＝源碼樹宣告的版本 ─────────────────────────────────────
  add('version-match', 'bundle 委任的版本＝源碼樹宣告的已發佈版本',
    facts.bundleVersion === want, `bundle=${facts.bundleVersion}｜源碼樹=${want}`,
    `daemon 版本對不上——源碼樹（${facts.changelogRel}）宣告 ${want}，這個 bundle 裡還是 ${facts.bundleVersion}。\n` +
    `         ⇒ 新打的 daemon 沒有被搬進 bundle。照舊出貨的話腳本會照常印「✅ 出貨完成」，\n` +
    `           但使用者按「檢查更新」永遠拿到 ${facts.bundleVersion}。\n` +
    `         → 把 ${want} 的 dmg／exe 搬進 bundle 的 daemon/ 並更新 manifest.daemon，再重跑。`);

  // ── ⑥ 必要平台都有 ─────────────────────────────────────────────────────
  const declaredKeys = facts.artifacts.map((a) => a.key);
  const missingPlatforms = facts.requiredPlatforms.filter((p) => !declaredKeys.includes(p));
  add('platforms-complete', `必要平台都委任了（${facts.requiredPlatforms.join('／')}）`,
    missingPlatforms.length === 0,
    declaredKeys.length ? `委任了 ${declaredKeys.join('、')}` : '一個平台都沒委任',
    `這個 bundle 缺這些平台的 daemon：${missingPlatforms.join('、')}。\n` +
    `         ⇒ 那個平台的使用者這一版**拿不到東西**，而其他平台照樣更新 ⇒ 沒有人會察覺。`);

  // ── ⑦⑧⑨ 每個委任的檔案：真的在、雜湊真的對、檔名真的是這一版 ───────────
  //    這三項是本閘「看事實不看字串」的核心：manifest 是**宣稱**，磁碟才是**事實**。
  const absent = facts.artifacts.filter((a) => !a.found);
  add('files-present', '每個委任的安裝檔都真的躺在 bundle 裡',
    absent.length === 0,
    `${facts.artifacts.length - absent.length}/${facts.artifacts.length} 個檔案存在`,
    `manifest 委任了這些檔案，但 bundle 裡**沒有**：\n` +
    absent.map((a) => `           • ${a.declaredFile}（找過 ${a.path}）`).join('\n') + '\n' +
    `         ⇒ manifest 說有、磁碟上沒有 ＝ 推出去之後使用者下載會 404。`);

  const badHash = facts.artifacts.filter((a) => a.found && a.declaredSha && a.actualSha !== a.declaredSha);
  add('hash-match', '每個安裝檔的 sha256＝manifest 宣告的值（真的把位元讀進來算）',
    badHash.length === 0,
    facts.artifacts.filter((a) => a.found).map((a) => `${a.key}:${(a.actualSha || '').slice(0, 12)}…`).join('、') || '(無)',
    `下列檔案的實際內容跟 manifest 宣告的 sha256 **對不上**：\n` +
    badHash.map((a) => `           • ${a.declaredFile}\n` +
      `             宣告 ${a.declaredSha}\n` +
      `             實際 ${a.actualSha}`).join('\n') + '\n' +
    `         ⇒ 安裝器就是拿 manifest 那個值驗下載完整性 ⇒ **全體使用者會裝不起來**。\n` +
    `           （這一項只有真的把檔案讀進來算才問得出來——抄 manifest 的數字永遠自洽。）`);

  const wrongName = facts.artifacts.filter((a) => a.found && !a.fileName.includes(want));
  add('filename-carries-version', '每個安裝檔的檔名帶著這一版的版本號',
    wrongName.length === 0,
    `版本號 ${want}`,
    `下列檔案的檔名沒有帶 ${want}——manifest 說這是 ${want}，檔案自己說不是：\n` +
    wrongName.map((a) => `           • ${a.declaredFile}`).join('\n') + '\n' +
    `         ⇒ 常見成因：搬檔的那一步從舊版的 dist/ 抓了東西。`);

  const empty = facts.artifacts.filter((a) => a.found && a.sizeBytes === 0);
  add('files-nonempty', '每個安裝檔都不是 0 位元組',
    empty.length === 0,
    facts.artifacts.filter((a) => a.found).map((a) => `${a.key}:${a.sizeBytes}B`).join('、') || '(無)',
    `下列檔案存在但是空的：\n` + empty.map((a) => `           • ${a.declaredFile}`).join('\n'));

  return verdict(checks, facts);
}

function verdict(checks, facts) {
  return {
    ok: checks.every((c) => c.ok),
    // 判別器本身是判決的一部分：報告要說得出「這次是拿哪條線在分辨」，
    // 否則「版本讀錯了」這種事又會變成只能靠人回頭猜（#88 第二輪）。
    daemonLine: facts.daemonLine,
    version: facts.sourceVersion,
    bundleVersion: facts.bundleVersion,
    checks,
    blockers: checks.filter((c) => !c.ok).map((c) => c.problem).filter(Boolean),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 組裝 ＋ 留痕
// ═══════════════════════════════════════════════════════════════════════════

export const GATE_LOG_HEADER = [
  '# daemon-in-bundle-gate 執行紀錄',
  '',
  '> 「這個版本的 daemon 在不在成品裡」——每一次執行都記一行，**擋下與放行都記**。',
  '> 只記擋下的話分母是未知的，回答不了「這道閘到底有沒有在運作」',
  '> （InkStoneCo#48：36 支閘只有 2 支會記錄自己擋了什麼）。',
  '',
  '| 時間 | 目標 | 源碼樹說 | 成品說 | 結果 | 擋下什麼 |',
  '|---|---|---|---|---|---|',
  '',
].join('\n');

/** 本地時間戳——與 `release-line-gate.mjs`／`github-contact-log.md` 同一種寫法（不用 UTC）。 */
export function localStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 附一行到執行紀錄。時間與路徑都可注入 ⇒ 測得動。@returns {string} 寫進去的那一行 */
export function appendGateLog(logPath, { ts, targetName, result }) {
  const blocked = result.checks.filter((c) => !c.ok).map((c) => c.id).join('；') || '—';
  const row = `| ${ts} | ${targetName} | ${result.version || '(問不出來)'} | ${result.bundleVersion || '(無)'} | `
    + `${result.ok ? '✅ 放行' : '⛔ 擋下'} | ${blocked} |`;
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) appendFileSync(logPath, GATE_LOG_HEADER, 'utf8');
  appendFileSync(logPath, row + '\n', 'utf8');
  return row;
}

/** 把判決寫成人話（給 ship.mjs 的例外訊息用）。 */
export function formatProblem(result) {
  const lines = [];
  lines.push('daemon 沒有進到這次的成品裡（daemon-in-bundle-gate）\n');
  lines.push(`     daemon 宣告的版本線　　：${result.daemonLine || '(讀不出 DAEMON_LINE)'}`);
  lines.push(`     源碼樹宣告的已發佈版本：${result.version || '(問不出來)'}`);
  lines.push(`     這個 bundle 委任的版本　：${result.bundleVersion || '(無)'}`);
  lines.push('');
  for (const c of result.checks) {
    lines.push(`     ${c.ok ? '✅' : '⛔'} ${c.name}　—　${c.fact}`);
  }
  lines.push('');
  for (const p of result.blockers) lines.push(`     🔴 ${p}`);
  lines.push('');
  lines.push('     🔴 這道閘沒有「跳過」這個結果——問不出來就是斷。');
  lines.push('       由來：D95 第一輪把 daemon 的說明搬進 collector/ 之後，舊的兩站因為找不到檔案而');
  lines.push('       安靜 skip，出貨線照印 ✅ 而新 daemon 從不進 bundle（inkstone/InkStoneCo#40）。');
  return lines.join('\n');
}

/**
 * 呼叫端入口：取事實 → 判決 → **不管過不過都留痕** → 不過就丟例外。
 *
 * @returns {object} judge() 的結果（過了才會回到這裡）
 */
export function requireDaemonInBundle({
  repoRoot, bundlesDir, changelogRel, targetName,
  requiredPlatforms = REQUIRED_PLATFORMS, logPath = null, now = new Date(),
}) {
  const facts = collectFacts({ repoRoot, bundlesDir, changelogRel, requiredPlatforms });
  const result = judge(facts);
  // 🔴 留痕在丟例外**之前**——擋下的那些才是最需要被記錄的（InkStoneCo#48）。
  try {
    appendGateLog(logPath || join(repoRoot, GATE_LOG_REL), { ts: localStamp(now), targetName, result });
  } catch { /* 留痕失敗不該把出貨判成失敗，但也不該吞掉判決 */ }
  if (!result.ok) throw new Error(formatProblem(result));
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. CLI —— 閘要能被單獨演練，不必跑一次會 push 會部署的完整管線
// ═══════════════════════════════════════════════════════════════════════════
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const { DAEMON_CHANGELOG_REL } = await import('./daemon-notes.mjs');

  let bundlesDir = opt('--bundles');
  const targetName = opt('--target') || (bundlesDir ? '(手指定的目錄)' : null);
  if (!bundlesDir) {
    if (!targetName) {
      console.error('用法：daemon-in-bundle-gate.mjs --target <stage|prod|…> ｜ --bundles <bundle 目錄>');
      process.exit(2);
    }
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'ship.targets.json'), 'utf8'));
    const t = cfg.targets[targetName];
    if (!t) { console.error(`❌ 登錄簿裡沒有目標 \`${targetName}\``); process.exit(2); }
    const home = process.env.HOME || '';
    bundlesDir = String(t.bundles.dir).startsWith('~/') ? join(home, String(t.bundles.dir).slice(2)) : t.bundles.dir;
  }

  const facts = collectFacts({ repoRoot: REPO_ROOT, bundlesDir, changelogRel: DAEMON_CHANGELOG_REL });
  const result = judge(facts);
  const row = appendGateLog(join(REPO_ROOT, GATE_LOG_REL), { ts: localStamp(), targetName, result });
  console.log(`bundle　${bundlesDir}`);
  console.log(`版本線　${DAEMON_LINE_REL} → ${result.daemonLine || '(讀不出來)'}`);
  console.log(`源碼樹　${DAEMON_CHANGELOG_REL} → ${result.version || '(問不出來)'}`);
  for (const c of result.checks) console.log(`${c.ok ? '  ✅' : '  ⛔'} ${c.name}　—　${c.fact}`);
  if (!result.ok) {
    console.error('\n' + formatProblem(result));
    console.error(`\n📝 留痕：${GATE_LOG_REL}\n   ${row}`);
    process.exit(1);
  }
  console.log(`\n✅ 這一版的 daemon（${result.version}）真的在成品裡`);
  console.log(`📝 留痕：${GATE_LOG_REL}`);
}
