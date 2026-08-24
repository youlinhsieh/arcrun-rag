/**
 * line-source-repo.mjs — 「**這條版本線的原始碼住在哪個 repo，版本就發到哪個 repo**」。
 *
 * ── 為什麼有這支（D95，leo 2026-08-17／08-18）────────────────────────────────
 * leo 原話：「`arcrun rag/collector` 改成 `arcrun-collector` 獨立 repo，
 * **原始碼和產出物放在一起**⋯⋯bundle 也是屬於 arcrun 的 bundle，不是 RAG⋯⋯
 * 身為管理者，你要從頭到尾**不要有很多扭曲**，因為你根本不記得你做的這些扭曲，每次都要查。」
 *
 * 2026-08-18 他再指一次，並把層級講明：
 * 「**我強調了不要扭曲，這就是扭曲，把一個差很多的東西塞進去別人的歷史裡。**」
 *
 * 指的是這個（總管實測 `inkstone/arcrun-rag` 的版本發布頁）：
 * ```
 * 桌面小幫手（0.x）  0.18.33、0.18.30      ← 兩個產品的版本疊在同一條歷史上
 * 雲端引擎（1.x）    1.4.49、1.4.48、v1.4.46
 * ```
 * 而且出貨線**每跑一次就多疊一筆**——因為 `release-record` 站把
 * `releaseRecord.repoSlug`（一個目標一個 repo）當成「所有版本線的家」。
 *
 * ⇒ 病根：**「版本發到哪個 repo」被當成「這個出貨目標」的屬性，
 *   而它其實是「這條版本線」的屬性。** 這與 `release-lines.mjs` 檔頭記的
 *   「發佈以版本線為單位，不以這趟出貨為單位」是同一個病的下一層——
 *   上一輪修好了「發幾筆」，這一輪修「發到哪」。
 *
 * ── 這支負責的那一半：讓那顆 commit 在**它自己的 repo** 上看得到 ───────────────
 * 一筆 release 要指到一顆 commit。桌面小幫手的 release 要發在 `inkstone/arcrun-collector`，
 * 就必須有一顆**那個 repo 看得到的** commit 可以指——`arcrun-rag` 的 HEAD sha 在那裡不存在，
 * 拿它當 target 只會建出一個指向虛空的 tag。
 * ⇒ 本模組把「這條線的源碼目錄」同步進它自己的 repo，回傳**那個 repo 裡**的 sha。
 *
 * 這不是新發明的搬法：`ship.targets.json` 的 `source.arcrunRepo`（`../../matrix/arcrun`）
 * 早就是「出貨線從一個 sibling repo 取源碼」的既有形狀，本模組只是把同一個方向反過來寫。
 *
 * ── 三條設計判準 ─────────────────────────────────────────────────────────────
 * ① **不准安靜退回**。找不到宣告、clone 不到、推不上去——一律丟例外中止出貨。
 *    🔴「安靜地退而求其次」是這個 repo 反覆犯的病（daemon 斷更四版、landing 從沒出貨過、
 *      docsSite=null 被印成「本目標沒有文件站」）。**退而求其次會變綠，而綠的東西沒有人會去查。**
 * ② **只搬版控裡有的東西**（`git ls-files`），**再扣掉目的 repo 自己忽略的那些**。
 *    照目錄整包複製會把本機建置產物（`dist/` 的 dmg、編譯出來的 `arcrun-app`）
 *    一起搬進去——那正是「20 MB 帶進版控」那次的形狀，而且它每次出貨都會再發生一次。
 *    🔴 但「版控裡有的」還不夠：`collector/` 版控裡就躺著 4 個共 43 MB 的建置產物化石
 *    （2026-08-18 實測，見 `copyTrackedFiles` 檔頭）。第二層判準**問目的 repo 自己的
 *    `.gitignore`**，不是我們另列一張會漂的清單；被擋下的檔案**要報出來**，不准安靜消失。
 * ③ **純函式 ＋ 可注入**：所有 git 動作都經過 `runner`，測試餵假的 runner 就能演練
 *    「宣告缺了」「clone 失敗」「沒有變更」「有變更」四種路徑，不必真的碰網路。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
// 🔴 這支模組的 push 推的是**目的 repo 的 main**——2026-08-18 就是這一行把
//   `inkstone/arcrun-collector` 的 main 推壞的（刪掉 main.go、把 22 行的 .gitignore 洗成 1 行），
//   而殼層的 PreToolUse hook 看不見 node 子行程 ⇒ 當時沒有任何閘反應（InkStoneCo#56）。
import { assertPushAllowed } from './main-push-guard.mjs';

/** `~/x` → `$HOME/x`。與 ship.mjs 的 expandHome 同一個理由：不准寫死 `/Users/<誰>/`。 */
export function expandHome(p) {
  return p && p.startsWith('~/') ? join(process.env.HOME || '', p.slice(2)) : p;
}

/**
 * 這條版本線的版本要發到哪個 repo。
 *
 * 🔴 **沒有預設值、沒有退回 `releaseRecord.repoSlug`。** 宣告缺了就丟。
 * 退回的話，「桌面小幫手又被發進 arcrun-rag」這件事會**安靜地重演**，
 * 而 release-check 會照樣變綠（它查的是同一個退回來的 repo）——
 * 那就是本輪要拔掉的那個形狀本身。
 *
 * @param {string} lineId `release-lines.mjs` 的 LINES[].id
 * @param {object} releaseRecord `ship.targets.json` 裡該目標的 releaseRecord
 * @returns {{repoSlug:string, sourceDir?:string, remote?:string, workDir?:string}}
 */
export function repoForLine(lineId, releaseRecord) {
  const map = releaseRecord && releaseRecord.lineRepos;
  if (!map || typeof map !== 'object') {
    throw new Error(
      `releaseRecord 沒有 lineRepos——「這條版本線發到哪個 repo」沒有人宣告。\n` +
      `     不退回 releaseRecord.repoSlug：那正是桌面小幫手的版本被疊進 arcrun-rag 歷史的原因（D95）。\n` +
      `     → 在 installer/ship.targets.json 的該目標補 releaseRecord.lineRepos。`);
  }
  const entry = map[lineId];
  if (!entry || !entry.repoSlug) {
    throw new Error(
      `版本線 \`${lineId}\` 沒有宣告要發到哪個 repo（releaseRecord.lineRepos.${lineId}.repoSlug）。\n` +
      `     已宣告的線：${Object.keys(map).join('、') || '(一條都沒有)'}\n` +
      `     → 補上它，或把這條線從 release-lines.mjs 的 LINES 拿掉。**不准讓它去借別條線的 repo。**`);
  }
  return entry;
}

/**
 * 這條線的源碼是不是**住在別的 repo**（＝需要先同步過去才有 commit 可以指）。
 * 判準是「有沒有宣告 sourceDir」，不是猜名字。
 */
export function livesInOwnRepo(entry) {
  return Boolean(entry && entry.sourceDir);
}

/**
 * 宣告完整性檢查——**在任何東西被改動之前**跑（ship.mjs 的登錄簿驗證階段）。
 *
 * 為什麼要單獨一支：`repoForLine` 是在 `release-record` 站（最後一站）才會被呼叫的，
 * 那時候 bundle 已經推出去、worker 已經部署完了。宣告寫錯要在**第一秒**就炸，
 * 不是走到第 21 站才炸——「部分成功」是這條管線明文不接受的狀態。
 *
 * @param {object[]} lines release-lines.mjs 的 LINES
 * @param {object} releaseRecord
 * @returns {string[]} 問題清單（空陣列＝過）
 */
export function declarationProblems(lines, releaseRecord) {
  const problems = [];
  const map = (releaseRecord && releaseRecord.lineRepos) || null;
  if (!map) {
    problems.push('releaseRecord 缺 lineRepos（每條版本線各自的 repo）。');
    return problems;
  }
  for (const line of lines) {
    const entry = map[line.id];
    if (!entry || !entry.repoSlug) {
      problems.push(`版本線 \`${line.id}\`（${line.product}）沒宣告 lineRepos.${line.id}.repoSlug。`);
      continue;
    }
    if (livesInOwnRepo(entry)) {
      for (const k of ['remote', 'workDir']) {
        if (!entry[k]) {
          problems.push(
            `版本線 \`${line.id}\` 宣告了 sourceDir=${entry.sourceDir}（源碼住在自己的 repo），但缺 ${k}。\n` +
            `           缺了它就沒辦法把源碼同步過去 ⇒ release 會指到一顆那個 repo 看不到的 commit。`);
        }
      }
    }
  }
  // `_` 開頭是這份登錄簿一路以來的註解鍵（`ship.targets.json` 到處都是），不是版本線。
  const extra = Object.keys(map).filter((k) => !k.startsWith('_') && !lines.some((l) => l.id === k));
  if (extra.length) {
    problems.push(
      `lineRepos 宣告了不存在的版本線：${extra.join('、')}。\n` +
      `           死宣告＝錯誤方向的信號（看起來有人在管，其實沒有任何一站會讀它）。`);
  }
  return problems;
}

/** 預設的 git 執行器。分出來只為了讓測試注入假的。 */
export function defaultRunner(args, cwd, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0 && !allowFail) {
    // D36：git 會把內嵌帳密的網址回聲出來（2026-08-16 實撞）⇒ 遮掉再往外丟。
    const msg = `${r.stdout || ''}\n${r.stderr || ''}`.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
    throw new Error(`git ${args.filter((a) => !/:.*@/.test(a)).join(' ')} 失敗（exit ${r.status}）：\n     `
      + msg.trim().split('\n').filter(Boolean).slice(-6).join('\n     '));
  }
  return { status: r.status, out: (r.stdout || '').trim() };
}

/**
 * 把 `srcRoot/<sourceDir>` 底下**版控裡有的檔案**，同步成 `workDir` 這個 repo 的一次 commit。
 *
 * 回傳那個 repo 裡的 sha ⇒ 呼叫端拿它當 release 的 target。
 *
 * 冪等：內容沒變就不建 commit（回傳現有 HEAD、`changed:false`）。
 * 同一版重跑不該在對方 repo 疊出一串空 commit——那會把「這一版是哪顆」變得沒辦法回答。
 *
 * @param {object} o
 * @param {string} o.srcRoot     來源 repo 的根（arcrun-rag）
 * @param {string} o.sourceDir   來源 repo 裡的哪個目錄（`collector`）
 * @param {string} o.workDir     目的 repo 的本機工作區（`~/.arcrun-ship/arcrun-collector`）
 * @param {string} o.remoteUrl   目的 repo 的 push 網址（**含權杖，不落地、不印出**）
 * @param {string} o.branch      目的分支（預設 main）
 * @param {string} o.message     有變更時的 commit 訊息
 * @param {Function} [o.runner]  git 執行器（測試注入）
 * @param {Function} [o.copyTracked] 檔案搬運（測試注入）
 * @returns {{sha:string, changed:boolean, files:number}}
 */
export function syncSourceRepo({
  srcRoot, sourceDir, workDir, remoteUrl, branch = 'main', message, destOwned = [],
  runner = defaultRunner, copyTracked = copyTrackedFiles,
  guard = assertPushAllowed, guardOpts = {},
}) {
  const dir = expandHome(workDir);

  // ① 準備工作區。沒有就 clone；有就先確認它真的是我們要的那個 repo，再拉到最新。
  //    🔴 不「有目錄就當它對」：一個殘留的舊工作區會讓同步安靜地推去別的地方。
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    runner(['clone', remoteUrl, dir], dirname(dir));
  } else {
    const cur = runner(['remote', 'get-url', 'origin'], dir).out;
    if (normRemote(cur) !== normRemote(remoteUrl)) {
      throw new Error(
        `工作區 ${dir} 的 origin 是 ${normRemote(cur)}，登錄簿宣告的是 ${normRemote(remoteUrl)}。\n` +
        `     不自動改寫、也不繼續——打錯 repo 的同步比同步失敗更難發現。`);
    }
    runner(['fetch', 'origin'], dir);
  }

  // ② 把分支對到 origin 的現況（空 repo 沒有遠端分支 ⇒ 建一個孤兒分支，不當成錯誤）。
  const hasRemoteBranch = runner(['rev-parse', '--verify', `origin/${branch}`], dir, { allowFail: true }).status === 0;
  if (hasRemoteBranch) {
    runner(['checkout', '-B', branch, `origin/${branch}`], dir);
  } else {
    runner(['checkout', '--orphan', branch], dir, { allowFail: true });
  }

  // ②.5 🔴 目的 repo 的門面檔**現在還在嗎**（`destOwned`）。
  //   這一項是 2026-08-18 第一次真的同步炸掉之後補的，而它炸的正是這道閘自己：
  //   `arcrun-collector` 的 `.gitignore` 是拆分時**專門寫來擋建置產物**的 21 行清單
  //   （它的內文就寫著「這一份清單是『不要再長回來』的那道閘」），
  //   而 `arcrun-rag` 的 `collector/.gitignore` 只有一行 `node_modules/`
  //   ⇒ 盲目鏡射**把那道閘覆蓋掉了** ⇒ 下一趟同步就會把 43 MB 產物搬進去。
  //   ⇒ 「兩邊都有、但內容本來就該不一樣」的檔案，鏡射處理不了，只能宣告成目的 repo 的。
  //   缺了就停：不自動補（我們手上沒有正確版本），但要讓人一眼看到閘不見了。
  for (const rel of destOwned) {
    if (!existsSync(join(dir, rel))) {
      throw new Error(
        `目的 repo 少了它自己的 \`${rel}\`（宣告在登錄簿的 lineRepos.<線>.destOwned）。\n` +
        `     這些檔案由目的 repo 自己維護、同步不覆蓋也不刪除；不見了通常表示**先前某次同步把它蓋掉了**。\n` +
        `     🔴 特別是 \`.gitignore\`：它是擋建置產物的那道閘，沒有它下一趟就會把產物搬進去。\n` +
        `     → 先去 ${dir} 把它還原（git log 找得回來），再重跑。`);
    }
  }

  // ③ 只搬版控裡有的檔案（判準②）。回傳搬了幾個——0 個一定是宣告錯了，不是「剛好沒東西」。
  const { copied: files, skipped } = copyTracked({ srcRoot, sourceDir, destDir: dir, destOwned, runner });
  if (files === 0) {
    throw new Error(
      `${sourceDir}/ 在 ${srcRoot} 的版控裡一個檔案都沒有——同步 0 個檔案不是「剛好沒東西」，是宣告錯了。\n` +
      `     「檢查了 0 條卻通過」是假綠的經典形狀 ⇒ 不放行。`);
  }

  // ④ 有變更才 commit。沒有就回現有 HEAD。
  runner(['add', '-A'], dir);
  const dirty = runner(['status', '--porcelain'], dir).out;
  if (!dirty) {
    return { sha: runner(['rev-parse', 'HEAD'], dir).out, changed: false, files, skipped };
  }
  runner(['commit', '-m', message], dir);
  // 🔴 人閘（InkStoneCo#56）：這一行推的是**別人 repo 的 main**。
  //   2026-08-18 它推過一筆會刪檔的 commit 上去，而殼層那道 `PreToolUse:Bash` hook
  //   看不見 node 子行程 ⇒ 一個閘都沒響。判斷搬到真的在推的這一行自己身上，
  //   放行的憑證與殼層閘同一枚戳記（綁目的地、單次、15 分鐘失效）。
  //   commit 先建好沒關係：**被擋下時遠端一個 commit 都不會動**，本機這一筆下次重跑照用。
  const pushArgs = ['push', remoteUrl, `HEAD:refs/heads/${branch}`];
  guard({ args: pushArgs, cwd: dir, remoteUrl, who: 'ship 出貨線／line-source-repo 同步', ...guardOpts });
  runner(pushArgs, dir);
  return { sha: runner(['rev-parse', 'HEAD'], dir).out, changed: true, files, skipped };
}

/**
 * 把來源 repo 裡 `sourceDir/` 底下**被 git 追蹤的**檔案，鏡射到 `destDir`（含刪除）。
 * 用 `git archive` 取內容：它天生只吐版控裡有的東西，不必自己維護一張排除清單
 * ——**排除清單會漂，而漂掉的那一刻沒有人會發現**（多搬一個 20 MB 的產物不會讓任何測試變紅）。
 *
 * ── 🔴 為什麼還要再過一次「目的 repo 自己的 `.gitignore`」（2026-08-18 實測補上）──
 * 「版控裡有的」在這裡**不等於**「該搬過去的」。實測 `products/arcrun-rag`：
 * ```
 * collector/ 版控裡有 232 個檔    inkstone/arcrun-collector 有 228 個
 * 差的 4 個全是建置產物（共 43 MB）：
 *   collector/cmd/arcrun-app/arcrun-app                    20.9 MB  編譯出來的執行檔
 *   collector/cmd/arcrun-app/dist/Arcrun-v0.18.3.dmg       11.9 MB  站表點名的那顆「化石」
 *   collector/collector                                     8.4 MB  編譯出來的執行檔
 *   …/build/windows/installer/tmp/MicrosoftEdgeWebview2Setup.exe  1.8 MB
 * ```
 * 它們是 `6b44784`／`e09f866`／`c6d7b2c` 留下的舊帳（站表 release-check 段 ④ 有記）
 * ——**在 arcrun-rag 裡是既成事實，但沒有理由每次出貨再搬一次進新 repo**。
 *
 * 判準**不是我們自己列一張排除清單**（那正是上面說會漂的東西），
 * 而是**問目的 repo 自己的 `.gitignore`**：那四個檔在 `arcrun-collector` 的座標系底下
 * 全部命中它自己的忽略規則（2026-08-18 實測 `git check-ignore` 四個都是 YES）。
 * ⇒ 規則跟著目的 repo 走、由它自己維護，我們不持有第二份會漂的清單。
 *
 * 🔴 而且**要報出來，不能安靜地丟掉**：呼叫端把 `skipped` 印進出貨報告。
 *   `git add -A` 其實也會擋下它們（忽略的檔案不會被 add）——但那是**碰巧擋住**，
 *   不是**看得見的判斷**：報告上不會有任何一行說「這四個沒搬」，
 *   而「安靜地做對」跟「安靜地做錯」在紀錄上長得一模一樣。
 *
 * @returns {{copied:number, skipped:string[]}} 搬了幾個、以及被目的 repo 忽略而沒搬的那些
 */
export function copyTrackedFiles({ srcRoot, sourceDir, destDir, destOwned = [], runner = defaultRunner }) {
  const listed = runner(['ls-files', '-z', '--', sourceDir], srcRoot).out;
  const rels = listed.split('\0').filter(Boolean).map((p) => p.replace(new RegExp(`^${sourceDir}/`), ''));
  if (rels.length === 0) return { copied: 0, skipped: [], kept: [] };

  const tracked = runner(['ls-files', '-z'], destDir).out.split('\0').filter(Boolean);
  const owned = new Set(destOwned);
  const skipped = destIgnored(rels, destDir, tracked, runner);
  // 🔴 目的 repo 自己的門面檔（`destOwned`）**兩個方向都不碰**：不覆蓋、也不刪除。
  const keep = rels.filter((r) => !skipped.includes(r) && !owned.has(r));
  if (keep.length === 0) return { copied: 0, skipped, kept: [...owned] };

  // 先清掉目的地版控裡的舊檔（不碰 .git），再解壓——**同步要包含刪除**，
  // 否則來源刪掉的檔案會在對方 repo 裡永遠活著，兩邊從此對不起來。
  // 🔴 但 `destOwned` 不在清除範圍內（見上）。
  for (const rel of tracked) {
    if (owned.has(rel)) continue;
    rmSync(join(destDir, rel), { force: true });
  }

  // 只把 `keep` 交給 git archive ⇒ 那 43 MB 的產物**根本不會被讀出來**，
  // 不是先寫進工作區再靠 `git add` 漏掉（少寫 43 MB／趟，也少一次「靠碰巧」）。
  const tar = execFileSync('git',
    ['archive', '--format=tar', 'HEAD', '--', ...keep.map((r) => `${sourceDir}/${r}`)], {
      cwd: srcRoot, maxBuffer: 1024 * 1024 * 512, encoding: 'buffer',
    });
  const tmp = join(destDir, '.sync.tar');
  writeFileSync(tmp, tar);
  execFileSync('tar', ['-xf', tmp, '-C', destDir, '--strip-components=1', sourceDir], { cwd: destDir });
  rmSync(tmp, { force: true });
  return { copied: keep.length, skipped, kept: [...owned] };
}

/**
 * 這些相對路徑，**目的 repo 自己的 `.gitignore` 排除了哪幾個**。
 *
 * `--no-index` 是刻意的：問的是「那個 repo 宣告的規則怎麼說」。
 * `check-ignore` 的離場碼：0＝有命中、1＝一個都沒命中（**不是錯誤**）、>1＝真的壞了。
 *
 * 🔴 **已經被目的 repo 追蹤的檔案不算被忽略**——這是 git 自己的語意
 * （忽略規則只管「要不要收新檔」，管不到已經在版控裡的東西），
 * 而漏掉這一條會**刪掉正常的源碼**：
 * `arcrun-collector` 的 `.gitignore` 有一行 `collector`（指 repo 根那顆編譯出來的執行檔），
 * 但 gitignore 的無斜線樣式**在任何層級都會命中** ⇒ 它同時命中了 `cmd/collector/` 這個目錄
 * ⇒ 2026-08-18 第一次真的同步時，`cmd/collector/main.go`（14 行的正常源碼）被當成
 * 建置產物刪掉了。加上這一條之後它回到 keep 裡。
 *
 * @param {string[]} rels 要判斷的相對路徑
 * @param {string} destDir 目的 repo
 * @param {string[]} tracked 目的 repo 目前追蹤的檔案（已追蹤者一律不算忽略）
 * @returns {string[]} 被忽略的相對路徑（相對於 destDir）
 */
export function destIgnored(rels, destDir, tracked = [], runner = defaultRunner) {
  if (rels.length === 0) return [];
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: destDir, input: rels.join('\n'), encoding: 'utf8',
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(
      `問 ${destDir} 的 .gitignore 失敗（exit ${r.status}）：${(r.stderr || '').trim().slice(0, 300)}\n` +
      `     不猜、不當成「都沒被忽略」——猜錯的後果是把建置產物搬進對方 repo。`);
  }
  const alreadyTracked = new Set(tracked);
  return (r.stdout || '').split('\n').map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !alreadyTracked.has(p));
}

/** git remote 正規化（去協定／帳密／`.git`）——只比「這是哪個 repo」。同 ship.mjs 的 normRemote。 */
export function normRemote(u) {
  return String(u || '')
    .replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]*@/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * 這個 repo 在該主機上**存在嗎**（唯讀查詢）。
 *
 * 為什麼要有：宣告一個不存在的 repo，症狀會出現在 `release-record`（第 21 站），
 * 而且長得像網路錯誤。這支讓它在 preflight 就炸，訊息直接說「這個 repo 不存在」。
 * 🔴 這也是本輪變異測試要看的那條路徑：**把新 repo 的位置寫錯，出貨線要當場斷並說清楚**，
 *   而不是安靜退回去發到 arcrun-rag。
 *
 * @returns {Promise<boolean>}
 */
export async function repoExists(host, repoSlug, { token, baseUrl, fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/json', 'user-agent': 'line-source-repo' };
  let url;
  if (host === 'gitea') {
    if (token) headers.authorization = `token ${token}`;
    url = `${(baseUrl || 'https://git.uncle6.me').replace(/\/$/, '')}/api/v1/repos/${repoSlug}`;
  } else if (host === 'github') {
    // D20 2026-08-10：讀一律匿名、放行、不計次。
    url = `https://api.github.com/repos/${repoSlug}`;
  } else {
    throw new Error(`不認得的 host：${host}`);
  }
  const r = await fetchImpl(url, { headers });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`查詢 ${repoSlug} 是否存在失敗：HTTP ${r.status}（不猜，直接停）`);
  return true;
}

/** 讀檔小工具（給呼叫端組 commit 訊息用，避免各處重寫）。 */
export function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
