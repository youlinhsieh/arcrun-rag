#!/usr/bin/env node
/**
 * ship.mjs — 出貨管線（**會執行**，不是印待辦）
 *
 * ── 這支為什麼被整個重寫（leo 2026-08-08）────────────────────────────────
 * leo 原話：
 *   「每次做一樣的事，結果會打錯實例，就是你的出貨閘是錯的。
 *     **寫對的應該每次都機械式的做同一件事，寫錯位置也會被它修正。**」
 *   「這個出貨閘門就是廢的，它應該要像 GitHub Actions 一樣 CI/CD。」
 *   「如果你修改過，系統應該要自動換版本，如果沒換，就有問題。」
 *
 * 舊版壞在四件事（每一件當天都真的害到人）：
 *   ① **只印待辦、不執行**——做沒做、做對沒做對，沒有任何機械檢查。
 *   ② 待辦第一條是**過期指示**（叫人改 worker.js 常數，真身是 wrangler.toml [vars]）
 *      ⇒ 08-07 照它做，白部署一次。
 *   ③ **目標用手打**（`--bundles <path>`）⇒ 打錯 repo／打錯實例沒有任何東西攔。
 *   ④ **不重打 bundle**⇒ 改了 portal 文案、版本仍 1.4.22 ⇒ 改動永遠送不出去，
 *      而安裝器判「同版整批跳過」⇒ **重裝也修不好**。
 *
 * ── 這版的三個不變式（對應 leo 的三句話）─────────────────────────────────
 *   Ⅰ **同一份輸入永遠得到同一組動作**：步驟表寫死在下面，順序固定、無分支；
 *      每一步只有「執行」或「跳過（附機械理由）」兩種結果，不因誰跑、跑第幾次而不同。
 *   Ⅱ **打錯目標打不進去**：目標只能從 `installer/ship.targets.json` 選（`--target`），
 *      不接受任何手打路徑／網址／帳號；且本機 clone 的 origin、CF 帳號都要與登錄簿相符，
 *      不符當場擋下。
 *   Ⅲ **沒送達就不算成功**：最後一步走**使用者真的會走的那條路**（安裝器 /api/latest、
 *      真的把 daemon 下載下來算 sha256、抓釘點產物驗內容），任一項不符 ⇒ 非零退出。
 *
 * 另外：**版本號由內容算出來**（release.mjs 的指紋機制），而本管線對「重打」目標
 * **每次都重打 bundle** ⇒ 「改了東西版本沒動」在結構上不可能發生；反之版本一樣就保證內容一樣。
 *
 * ── 不變式 Ⅳ（2026-08-11 三次改版）：**對稱**——每個目標都重打，不「提升」──────
 * 這條在 2026-08-08 曾經是「發佈目標提升，不重打」（`promoteFrom` 機制），
 * **已在 2026-08-11 拆掉**（D65 三次補述，arcrun-rag#73 缺③）。leo 訂正了原本的模型：
 *   「10 次原始碼重建完全不是問題……你要改的只有內外不同的參數」
 *   「我根本搞不清楚什麼是提升……就是這個設計造成了問題」
 * 「提升」（複製 stage 已打包的檔案）是實作方發明的詞，不是 leo 要的——他要的是
 * **對稱**：每個目標走同一條重打路徑，值不同（帳號、URL）但形狀完全一樣；
 * README 沒改，兩邊都不動；README 改了，兩邊都換。「提升」反而把 prod 的檢查表剪短了
 * （`docs-changelog` 步驟第一行曾經是 `if (T.promoteFrom) return skip`——整條管線
 * 唯一一道「說明文件寫了沒」的閘，prod 由設計跳過）。
 *
 * 現在「兩個理貨員拿同一張訂單」（leo 的比喻）改由三件事一起保證，取代「複製＋核對指紋」：
 *   ① **來源 commit 釘子**（`source-pin.mjs`）——真的 git 分支，只在 Arcrun repo 本機移動
 *      （不推遠端）。目標成功跑完 `--confirm`（含 verify 全過）就把分支移到那顆 commit；
 *      下游宣告 `requireSourceBranch` 的目標出貨前核對「這次要打的 == 分支釘住的」，
 *      不符當場拒絕。這是 leo 說的「先打 stage 分支，無誤，就打 main 分支」的字面實作。
 *   ② **版本號共用狀態**（`release.mjs` 的 `sharedState`）——stage／prod 兩個獨立的 bundle
 *      repo，各自重打卻讀同一份 `installer/release-state.json` 決定版本號：同一份內容
 *      指紋，不管哪個目標先算到，都得到同一個號碼；不是各自累計 patch。
 *   ③ **出貨報告硬斷言**（`ship-report.mjs` 的 `assertSourceParity`）——belt-and-suspenders，
 *      就算①②哪裡有漏，記錄下來的來源 commit 不一致還是會被攔下來，不放行（arcrun-rag#73 缺②）。
 *
 * ── 不變式 Ⅴ（2026-08-09 加，arcrun-rag#27）：出貨包含**說明**，不只包含程式 ────
 * leo 推完 1.4.29 prod 後問：「你推完 prod 以後有去檢查上架的東西是否正確嗎？這是第一次用，
 * 應該要看有沒有漏，比如說**版本有沒有版本說明？有沒有上 docs？**」
 * 一查漏了兩件，而且是同一種病——**規約寫在註解裡，沒有任何一步在執行它**：
 *   ① `prod.docsSite` 是 null ⇒ 文件站從沒進過出貨鏈（一直靠人手動 wrangler deploy），
 *      `rag.arcrun.dev/docs/help/changelog/` 停在 v0.18.24，封測者拿到的是 v0.18.25。
 *   ② `wrangler.toml` 註解寫著「BUNDLE_BUILT＝釘點 manifest.built（D37 單一真相源）」，
 *      但 manifest 的 built 是 `m.built || 今天`＝**有值就不動** ⇒ prod 的建置日黏在 08-07。
 * ⇒ 三道機械閘取代那兩段註解：
 *   · 有 `installer` 的目標**必須**宣告 `docsSite`，漏填在任何步驟開跑前就 exit 2
 *   · docs 步驟部署完要**去線上那一頁把 release 與 daemon 版本找出來**（200 不算驗過）
 *   · built 跟 release／fingerprint 一樣**繼承來源**，且 verify 斷言
 *     「線上宣告的建置日 == 這次 manifest 的建置日」（也就是 pin 有沒有真的送達）
 *
 * ── 不變式 Ⅷ（2026-08-12 加，arcrun-rag#79）：**每一站都要兩邊都走** ──────────
 * 前一條治的是「站根本不在清單上」；這一條治的是**站在清單上、但只有一邊會執行**。
 *   `purge`（送達收斂）站的條件本來是 `verify.fullChain`，而 fullChain 只有 prod 宣告
 *   ⇒ stage 每次印「本目標不走 jsDelivr（登錄簿宣告）」跳過
 *   ⇒ 這一站的每個壞法都只能在 prod 現形。2026-08-11 它史上第一次真的被觸發，
 *     一次現形兩個：`runWorkflow` 沒被 import、工作流內建 FOREACH 撞 subrequest 上限。
 *   🔴 而它在 D65 的左右對照表上**看起來是合法的**——stage 那欄是「登錄簿宣告沒這東西」。
 *     ⇒ **只在單邊執行的站，是測試與 stage 的共同盲區。**
 * ⇒ 治法：有 `installer` 的目標**必須**宣告 `delivery`（它的「會移動的指標」是什麼、
 *   怎麼踢它），漏填在任何步驟開跑前就 exit 2；「本目標沒這東西」不再是一句可以自己講的話。
 *   ＋ `--delivery-only`：這一站終於可以被單獨演練（同 --verify-only 的理由）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node installer/scripts/ship.mjs --target stage              # 預演（建＋算版本，不推不部署）
 *   node installer/scripts/ship.mjs --target stage --confirm    # 真的走完
 *   node installer/scripts/ship.mjs --target prod  --confirm    # 需 leo 先開 D20 閘
 *   node installer/scripts/ship.mjs --list                      # 有哪些目標
 *   node installer/scripts/ship.mjs --target prod --verify-only # 只驗收線上現況，什麼都不改
 *   node installer/scripts/ship.mjs --target stage --delivery-only          # 只查「新版送到了嗎」
 *   SHIP_DELIVERY_DRILL=1 node installer/scripts/ship.mjs --target stage --delivery-only
 *                                                             # 反向演練：期望值不可能達成，
 *                                                             # 這一站**應該**判失敗（不失敗才是壞了）
 *   node installer/scripts/ship.mjs --target stage --release-record-only
 *                                                             # 只跑「留一筆版本發佈」那一站
 * 旗標：--quick（驗收略過真下載，只驗中繼資料）／--allow-deletions（bundle 有刪檔時放行）
 *       --verify-only（只跑最後那步驗收；不建/不推/不部署/不蓋章，判定與 --confirm 一樣嚴）
 *       --delivery-only（只跑送達收斂那一站；禁用在 publish 目標）
 *       --release-record-only（只跑發佈紀錄那一站；禁用在 publish 目標 ⇒ 碰不到 GitHub）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { syncManifest, verifyManifest } from './release.mjs';
// CHANGELOG_REL＝雲端引擎（`1.4.x`）那條線；DAEMON_CHANGELOG_REL＝桌面版（`v0.18.x`）那條。
// 🔴 兩條線 2026-08-18（D95 第一輪）拆開之後**不可以再混用**：daemon 的三站問的是後者，
//   問錯那份檔案的症狀不是報錯，是「找不到已發佈版本段 ⇒ 安靜跳過」（見 daemon-in-bundle-gate.mjs 檔頭）。
import { notesFromChangelog, checkNotes, changelogRelFor, CHANGELOG_REL, DAEMON_CHANGELOG_REL, daemonReleasedReFor, ANY_RELEASED_RE, DAEMON_LINE_REL } from './daemon-notes.mjs';
import { requireDaemonInBundle } from './daemon-in-bundle-gate.mjs';
import { checkArmed, logGithubContact } from './d20-guard.mjs';
// 🔴 推 main 的人閘，長在真的在推的那一行身上（InkStoneCo#56）。
//   d20-guard 解的是「殼層 hook 看不見 node 子行程」的**GitHub 接觸**那一半；
//   這一支解同一個形狀的另一半：**推 main**。2026-08-18 出貨線就是這樣把
//   inkstone/arcrun-collector 的 main 推壞的，而一個閘都沒響。
import { assertPushAllowed, unarmed as unarmedDestinations, claimGrants as claimMainPushGrants, armCommand, normRemote as normRemoteId } from './main-push-guard.mjs';
import { resolveBundlePlan, diffAgainstPlan, readArtifactManifest } from './bundle-components.mjs';
import { requireNoLocalBuild } from './no-local-build-gate.mjs';
import { requireFreshArtifacts } from './artifact-freshness.mjs';
import { requireFreshDaemonSource } from './daemon-freshness.mjs';
import { branchTip, setBranchTip, checkSourcePin } from './source-pin.mjs';
import { checkDaemonDownload } from './verify-download.mjs';
import { resolveDaemonDist } from './daemon-dist.mjs';
import { checkDocsLive } from './verify-docs.mjs';
import { checkMailRelayLive } from './verify-mail-relay.mjs';
import { renderBundlesReadme } from './render-bundles-readme.mjs';
import {
  releaseSectionFor, releaseExists, createRelease,
  uploadReleaseAsset as ghUploadAsset, listReleaseAssets as ghListAssets,
  listReleases as ghListReleases,
} from './github-release.mjs';
import {
  giteaWriteCredentialsFromRemote, redactToken,
  releaseExists as giteaReleaseExists, createRelease as giteaCreateRelease, commitExists as giteaCommitExists,
  uploadReleaseAsset as giteaUploadAsset, listReleaseAssets as giteaListAssets, listReleases as giteaListReleases,
} from './gitea-release.mjs';
import { requireStations, arcrunWorkflows, STATIONS_REL } from './ship-stations.mjs';
import { assertWorkflowsExist, checkLive, describeChecks, runWorkflow } from './ship-arcrun.mjs';
import { machineId } from './ship-machine.mjs';
import { deliveryInvariantProblems, deliveryPlan, confirmDelivery, notConvergedError, DRILL_ENV } from './ship-delivery.mjs';
import { runGate as runResourceRuleGate } from './resource-rule-gate.mjs';
// 版本印記閘（Arcrun#106 另一半）：凡烙版號的部署路徑，必須一起烙 commit。
import { runGate as runVersionStampGate } from './version-stamp-gate.mjs';
import { LINES, linesFrom, assetsFor } from './release-lines.mjs';
// D95：每條版本線發到**自己的 repo**（桌面小幫手不再疊進雲端引擎的歷史）。
import {
  declarationProblems, repoForLine, livesInOwnRepo, syncSourceRepo, repoExists,
} from './line-source-repo.mjs';
import {
  formatInternalVersion, nextSequence, shortCodeFor, dateStamp,
  mappingSection, withMappingSection,
} from './internal-version.mjs';
import {
  runGate as runReleaseLineGate, appendGateLog as appendReleaseLineGateLog, localStamp as releaseLineGateStamp,
  fetchPublishedTags, GATE_LOG_REL as RELEASE_LINE_GATE_LOG_REL, destinationsOf as releaseDestinations,
} from './release-line-gate.mjs';
import { fill as fillCredentials, describeSources, missingCredentialError } from './credential-store.mjs';

const REPO_ROOT = resolve(join(import.meta.dirname, '..', '..'));
const TARGETS_FILE = join(REPO_ROOT, 'installer', 'ship.targets.json');
// InkStoneCo 頂層（.github-armed／github-contact-log.md 的真身都住在這裡，見 d20-guard.mjs 檔頭）
const INKSTONE_ROOT = resolve(REPO_ROOT, '..', '..');
// 桌面 App（daemon）打包產物落地處——`daemon-sync` 從這裡取，見該步驟檔頭。
const DAEMON_DIST_REL = join('collector', 'cmd', 'arcrun-app', 'dist');

// ── 參數 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const cfg = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
const TARGET_NAMES = Object.keys(cfg.targets);

if (flag('--list')) {
  console.log('可用目標（--target <名字>）：');
  for (const [k, t] of Object.entries(cfg.targets)) {
    console.log(`   ${k.padEnd(9)} ${t.label}${t.publish ? '  🔫 需 leo 開閘' : ''}`);
  }
  process.exit(0);
}

// 🔴 不變式 Ⅱ：目標不准用手打。舊旗標一律硬擋，不做「好心的相容」——
//    相容就等於那條會打錯的路還活著（08-08 的病根）。
for (const dead of ['--bundles', '--dry-run', '--purge']) {
  if (flag(dead)) {
    console.error(`❌ \`${dead}\` 已移除。出貨目標只能從登錄簿選，不能用手打：`);
    console.error(`   node installer/scripts/ship.mjs --target <${TARGET_NAMES.join('|')}> [--confirm]`);
    console.error(`   登錄簿：installer/ship.targets.json（改它＝改出貨會打到哪裡）`);
    process.exit(2);
  }
}

const TARGET_NAME = opt('--target');
if (!TARGET_NAME || !cfg.targets[TARGET_NAME]) {
  console.error(`❌ --target 必須是登錄簿裡的目標之一：${TARGET_NAMES.join(' / ')}`);
  console.error(`   （給了：${TARGET_NAME === null ? '(沒給)' : JSON.stringify(TARGET_NAME)}）`);
  process.exit(2);
}
const T = cfg.targets[TARGET_NAME];

// 🔴 不變式 Ⅴ：**有安裝器的目標，一定要有文件站**（2026-08-09，arcrun-rag#27）
//   leo 推完 1.4.29 prod 後問：「有沒有上 docs？版本有沒有版本說明？」
//   ——沒有。`prod.docsSite` 是 null，出貨時那一步印「本目標沒有文件站」安靜跳過，
//   於是 `rag.arcrun.dev/docs/help/changelog/` 停在 v0.18.24，而封測者拿到 v0.18.25。
//   「宣告 null 就跳過」對 selftest 是對的（它不面對任何人），
//   對**有使用者的目標**卻等於「漏了不會有人知道」⇒ 這裡把它變成宣告錯誤，
//   在任何步驟開跑之前就擋下：登錄簿漏填，不是出貨時的一行警告，是根本不准開跑。
//   （檢查全部目標，不是只檢查這次要出的那個——漏填要在最早的時刻被看見。）
for (const [name, t] of Object.entries(cfg.targets)) {
  if (t.installer && !t.docsSite) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 有安裝器（會有人拿到東西），卻沒宣告 docsSite。`);
    console.error(`   使用者更新完想知道「這版改了什麼」只有文件站可查——沒接上就是出了貨沒有說明。`);
    console.error(`   → 在 installer/ship.targets.json 的 \`${name}\` 補 docsSite（cwd／config／wranglerEnv／accountId／verifyUrl）`);
    process.exit(2);
  }
}

// 🔴 不變式 Ⅵ：**會有人拿到東西的目標，一定要有發佈紀錄（releaseRecord）**
//   （2026-08-10 立，2026-08-16 從「只管 prod／只認 GitHub」擴到兩個目標，arcrun-rag#88）
//
//   ── 原始病史（2026-08-10，總管實測發現）──────────────────────────────────
//   leo：「你的出貨沒有限制你一定要在 github 產生 release？」「那為什麼不改掉？」
//   `docs-site/.../help/changelog.md` 對用戶承諾「完整發佈紀錄在 GitHub 版本發佈」，
//   但 `youlinhsieh/arcrun-rag` 的 releases 一個都沒有、公開鏡像停在數週前——
//   出貨管線從沒有任何一步碰過它。`docs-changelog` 那道閘擋得住「沒寫說明」，
//   「GitHub 上有沒有這一版」卻完全沒有對應的閘 ⇒ 一個承諾有牙齒、一個沒有。
//
//   ── 2026-08-16 為什麼要擴（同一個病的下一層，arcrun-rag#88）──────────────
//   leo 看著 Gitea 的版本發佈頁問：「**你為什麼沒有發 Gitea 內部版本？**」
//   實查：`gitea-release.mjs` 本身是能用的（三天前 #88 的演練在那頁上留下
//   `demo-88-v1.4.44`／`demo-88-v0.1.1` 兩筆），但登錄簿的欄位叫 `githubRelease`、
//   這裡的條件寫 `t.publish` ⇒ **stage 兩個條件都不成立** ⇒ 那一站對 stage
//   永遠印「本目標沒有 githubRelease（非發佈目標屬正常）」跳過。
//   🔴 這正是不變式 Ⅷ 已經寫過的形狀：**只在單邊執行的站，是測試與 stage 的共同盲區**，
//     而且它在出貨報告的左右對照表上「看起來是合法的」（那一格的理由是「登錄簿宣告沒這東西」）。
//     ⇒ 能力做好了一半，而那一半不是會被人用到的那半。
//   leo 同日的裁決把「該長在哪」也講死了：「changelog 直接看 github，**如果在 stage
//   直接看 gitea**，不要花力氣維護兩個地方」「**兩邊動作相同，不用這裡一套那裡一套。**」
//
//   ⇒ 兩處改動，**都只會變嚴、不會放寬**：
//     ① 欄位 `githubRelease` → `releaseRecord`（多一個 `host`，決定送到哪個主機）
//     ② 條件 `publish` → `installer || publish`
//        （prod 兩者皆真，原本擋得住的現在照樣擋；stage 有 installer ⇒ 新被納入；
//          selftest 兩者皆無 ⇒ 照舊免除，它不 push、不部署，不面對任何人）
const RELEASE_HOSTS = {
  gitea: ['repoSlug'],
  github: ['repoSlug', 'mirrorDir', 'mirrorRemote'],
};
for (const [name, t] of Object.entries(cfg.targets)) {
  if (!(t.installer || t.publish)) continue;
  if (!t.releaseRecord) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 會有人拿到東西，卻沒宣告 releaseRecord。`);
    console.error(`   使用者想知道「這版改了什麼」，去這個環境對應的 repo 就要找得到；`);
    console.error(`   沒有這一步，那句話就只是文件上的承諾，沒有任何東西在保證它。`);
    console.error(`   → 在 installer/ship.targets.json 的 \`${name}\` 補 releaseRecord`);
    console.error(`     （host：${Object.keys(RELEASE_HOSTS).join('／')}｜repoSlug｜host=github 另需 mirrorDir／mirrorRemote）`);
    process.exit(2);
  }
  const host = String(t.releaseRecord.host || '');
  if (!RELEASE_HOSTS[host]) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 的 releaseRecord.host 不認得（現在寫的是：${host || '(空白)'}）。`);
    console.error(`   只准填：${Object.keys(RELEASE_HOSTS).join('／')}——「送到哪」是登錄簿唯一該決定的事，不准用手打。`);
    process.exit(2);
  }
  const lack = RELEASE_HOSTS[host].filter((k) => !t.releaseRecord[k]);
  if (lack.length) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 的 releaseRecord（host=${host}）缺欄位：${lack.join('、')}`);
    process.exit(2);
  }
  // 🔴 不變式 Ⅵ.b：**每一條版本線都要宣告自己的 repo**（D95，2026-08-18，InkStoneCo#40）
  //   leo 指著 inkstone/arcrun-rag 的版本發布頁：「**我強調了不要扭曲，這就是扭曲，
  //   把一個差很多的東西塞進去別人的歷史裡。**」——桌面小幫手（0.18.x）與雲端引擎（1.4.x）
  //   兩個產品的 release 疊在同一條歷史上，而且出貨線每跑一次就多疊一筆。
  //   病根與上一輪同源：a3934c6 修好了「**發幾筆**」（一線一筆），這一輪修「**發到哪**」。
  //   ⇒ 宣告缺一條就在這裡 exit 2；**沒有退回 `repoSlug` 這條路**——退回會變綠，
  //     而綠的東西沒有人會去查（daemon 斷更四版就是這樣過了四次全綠）。
  const declProblems = declarationProblems(LINES, t.releaseRecord);
  if (declProblems.length) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 的 releaseRecord.lineRepos 有問題：`);
    for (const p of declProblems) console.error(`   - ${p}`);
    console.error(`   版本線清單來自 installer/scripts/release-lines.mjs 的 LINES（目前 ${LINES.length} 條：${LINES.map((l) => l.id).join('、')}）。`);
    process.exit(2);
  }
}

// 🔴 不變式 Ⅶ：**有安裝器的目標，一定要有郵差（mailRelay）**（2026-08-11，arcrun-rag#38／#69／#25）
//   同一種病、同一種解法，這次咬在「忘記密碼」上：D62 代寄機制的兩半——用戶自己的
//   cypher（寫連結）與 `landing/worker.js`（真的寄信）——只有前者被這支腳本盯著，
//   landing 從沒出現在 STEPS 或登錄簿裡（`grep -niE "landing" installer/scripts/ship.mjs`
//   曾是零命中）。結果：stage 手動部署過（有 D62 路由），**prod 從沒推過**——
//   2026-08-11 實測 `arcrun-landing.uncle6-me.workers.dev/api/health`→200（活著）但
//   `/api/send-password-reset`→404（那支路由不存在，還在跑 D62 之前的舊碼）。
//   出貨報告全綠，因為它根本不在被檢查的清單上——leo（D65）：「不在清單上的東西會現形，
//   因為它連一列都沒有」。跟 docsSite／githubRelease 同一治法：漏填在任何步驟開跑前就擋下。
for (const [name, t] of Object.entries(cfg.targets)) {
  if (t.installer && !t.mailRelay) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 有安裝器（會有人拿到東西），卻沒宣告 mailRelay。`);
    console.error(`   使用者按「忘記密碼」要靠郵差 worker 代寄——沒接上這一步，郵差就只能靠人手動部署，會漏。`);
    console.error(`   → 在 installer/ship.targets.json 的 \`${name}\` 補 mailRelay（cwd／config／wranglerEnv／accountId／verifyUrl）`);
    process.exit(2);
  }
}

// 🔴 不變式 Ⅷ：**有安裝器的目標，一定要宣告 delivery（送達收斂）**（2026-08-12，arcrun-rag#79）
//   同 docsSite／githubRelease／mailRelay 的第四次——但這次咬的是**已經存在的那一站**：
//   `purge` 站的條件本來是 `verify.fullChain`，而 fullChain 只有 prod 有
//   ⇒ stage 每次印「本目標不走 jsDelivr（登錄簿宣告）」跳過
//   ⇒ **這一站壞掉永遠只能在 prod 第一次發現**。2026-08-11 它史上第一次真的被執行，
//     一次就炸兩個（runWorkflow 沒 import／工作流 FOREACH 撞 subrequest 上限）。
//   leo：「演習視同作戰」⇒ 每個會有人拿到東西的目標，都要自己宣告「新版怎麼算送到了」。
//   （判斷邏輯在 ship-delivery.mjs：那支測得動，這裡這道閘測不動。）
{
  const problems = deliveryInvariantProblems(cfg.targets);
  if (problems.length) {
    console.error(`❌ 登錄簿不完整（不變式 Ⅷ：送達收斂）：`);
    for (const p of problems) console.error(`   ${p}`);
    process.exit(2);
  }
}

const CONFIRM = flag('--confirm');
const QUICK = flag('--quick');
const ALLOW_DELETIONS = flag('--allow-deletions');

// 🔴 --verify-only（2026-08-09，arcrun-rag#27）：**只跑最後那一步驗收，什麼都不改**。
//   為什麼要有：verify 這道閘 08-09 在 prod 誤報一次（見 verify-download.mjs 檔頭），
//   而當時**沒有任何辦法單獨重跑它來確認修好了**——要驗它就得跑完整條會 push 會 deploy
//   的管線（prod 還要 leo 開 D20 保險）。一道無法單獨演練的閘，修了也不知道修好沒有。
//   安全性：只跑 `mutates:false` 的 verify 步驟，不 build、不 push、不 deploy、不蓋驗證章；
//   而且**判定與 --confirm 同樣嚴格**（不像預演會把差距降級成「正常」），
//   ⇒ 它不可能被誤當成出貨，也不可能靠它放水。
const VERIFY_ONLY = flag('--verify-only');
if (VERIFY_ONLY && CONFIRM) {
  console.error('❌ --verify-only 與 --confirm 不能一起用：前者只驗不出貨，後者是真的出貨。');
  process.exit(2);
}

// 🔴 --delivery-only（2026-08-12，arcrun-rag#79）：**只跑送達收斂那一站**。
//   理由跟 `--verify-only` 一字不差（見上一段）：「一道無法單獨演練的閘，修了也不知道
//   修好沒有」。而這一站比 verify 更嚴重——它連**跑都沒跑過**：從搬去 Arcrun 到
//   2026-08-11 第一次被觸發之間，沒有任何人執行過它一次。要它不再是盲區，就得有一個
//   便宜到可以隨時跑的演練方式，否則「讓 stage 也跑」會退化成「每次出貨才順便跑」。
//
//   期望值取自**磁碟上那份 bundle manifest**（同 --verify-only 的作法）——那正是上次
//   出貨送出去的內容，不是另一個手抄的數字。
//   安全性：不 build、不 push、不 deploy、不蓋章；且**不准用在會發佈給用戶的目標**
//   （prod 的送貨管道是真的 CDN 作廢端點，演練不在正式環境上做）。
const DELIVERY_ONLY = flag('--delivery-only');
if (DELIVERY_ONLY && (CONFIRM || VERIFY_ONLY)) {
  console.error('❌ --delivery-only 不能跟 --confirm／--verify-only 一起用：它只跑送達收斂那一站。');
  process.exit(2);
}
if (DELIVERY_ONLY && T.publish) {
  console.error(`❌ --delivery-only 不准用在會發佈給用戶的目標（${TARGET_NAME}）。`);
  console.error(`   它會真的去打那個目標的作廢端點——演習視同作戰，但演習不在正式環境上做。`);
  process.exit(2);
}

// 🔴 --release-record-only（2026-08-16，arcrun-rag#88）：**只跑發佈紀錄那一站**。
//   理由與 `--verify-only`／`--delivery-only` 一字不差：「一道無法單獨演練的閘，
//   修了也不知道修好沒有」。而這一站的病史正是那句話的極端版本——它從接上管線的那天起
//   **在 stage 一次都沒被執行過**（條件寫死只認 prod），沒有人有辦法便宜地跑它一次。
//   期望值同樣取自**磁碟上那份 bundle manifest**（`ensureExpectationsFromDisk`），
//   問的是「上次送出去的那一版，發佈紀錄留了嗎」，不是拿一個手抄的數字去對。
//   安全性：不建、不推 bundle、不部署、不蓋章；且**不准用在會發佈給用戶的目標**
//   ——這一條同時是 D20 的結構性保證：這個模式**碰不到 GitHub**，
//   唯一到得了的 host 是 Gitea（內部開發環境，D73），開閘儀式一步都沒被繞過。
const RELEASE_RECORD_ONLY = flag('--release-record-only');
if (RELEASE_RECORD_ONLY && (CONFIRM || VERIFY_ONLY || DELIVERY_ONLY)) {
  console.error('❌ --release-record-only 不能跟 --confirm／--verify-only／--delivery-only 一起用：它只跑發佈紀錄那一站。');
  process.exit(2);
}
if (RELEASE_RECORD_ONLY && T.publish) {
  console.error(`❌ --release-record-only 不准用在會發佈給用戶的目標（${TARGET_NAME}）。`);
  console.error(`   那一半是對外發佈、受 D20 人閘管制——演習視同作戰，但演習不在正式環境上做，`);
  console.error(`   也不從一個「不需要解保險」的旗標繞進去。`);
  process.exit(2);
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const sh = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env }).trim();

function shLive(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, {
    cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env,
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失敗（exit ${r.status}）`);
}

/**
 * 推出貨分支到 Gitea，且**不把權杖印出來**（D36：值不落地、不外洩）。
 *
 * 為什麼要專門寫一支而不是直接用 `sh('git', ['push', ...])`：
 * `gitea` remote 的網址**內嵌帳密**（credentials-map.md 記載的既有做法），而 git 會把
 * 解析後的完整網址回聲到 stderr——2026-08-16 實測，一句 LFS locking 的好心提示就把
 * `https://<帳號>:<token>@git.uncle6.me/...` 整條印在出貨輸出裡。
 * 而出貨輸出正是會被貼進票、貼進報告、留在終端記錄裡的東西 ⇒ 那把鑰匙就跟著散出去。
 * ⇒ 成功時什麼都不印；失敗時才把訊息帶出來，且先把 `//帳號:權杖@` 遮掉再丟。
 */
function pushGiteaQuietly(branch) {
  // 🔴 人閘（InkStoneCo#56）：`branch` 是變數——它可以是 main。
  //   推出貨分支時這一行不會有任何感覺（目標不是 main ⇒ 直接放行並留痕）；
  //   哪天它變成 main，就需要一枚總管的戳記。
  assertPushAllowed({
    args: ['push', 'gitea', `HEAD:refs/heads/${branch}`],
    cwd: REPO_ROOT, who: 'ship.mjs／推出貨分支到 Gitea', grants: ctx.mainPushGrants,
  });
  const r = spawnSync('git', ['push', 'gitea', `HEAD:refs/heads/${branch}`], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  if (r.status !== 0) {
    const msg = `${r.stdout || ''}\n${r.stderr || ''}`.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
    throw new Error(`把出貨分支推上 Gitea 失敗（exit ${r.status}）：\n     `
      + msg.trim().split('\n').filter(Boolean).slice(-6).join('\n     '));
  }
}

/**
 * 🔴 這一趟出貨會覆寫哪幾個 repo 的 `main`（InkStoneCo#56 的 preflight 用）。
 *
 * 全部**讀登錄簿**，不猜名字：產物倉庫（`bundles`）、GitHub 公開鏡像（`mirrorRemote`）、
 * 以及每條「源碼住自己 repo」的版本線（`lineRepos.<線>.remote`）。
 * 目標分支不是 main／master 的不算；`local-selftest` 不碰遠端，也不算。
 */
function mainPushDestinations() {
  const out = [];
  const add = (remote, branch) => {
    if (!remote || !branch || String(remote) === 'local-selftest') return;
    if (branch !== 'main' && branch !== 'master') return;
    const id = normRemoteId(remote);
    if (id && !out.includes(id)) out.push(id);
  };
  if (T.bundles) add(T.bundles.remote, T.bundles.branch);
  const R = T.releaseRecord;
  if (R) {
    if (R.mirrorRemote) add(R.mirrorRemote, 'main');
    for (const line of LINES) {
      let entry = null;
      try { entry = repoForLine(line.id, R); } catch { continue; }  // 宣告缺了自有 (a3) 去報
      if (entry && livesInOwnRepo(entry)) add(entry.remote, entry.branch || 'main');
    }
  }
  return out;
}

/** git remote 正規化：去掉協定、帳密、.git 結尾 ⇒ 只比「這是哪個 repo」。 */
const normRemote = (u) => String(u || '')
  .replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]*@/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();

const cb = () => `cb=${Date.now()}${Math.floor(Math.random() * 1e6)}`;
async function getJson(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

// ── 管線狀態（步驟之間唯一的共享處，方便追「這個值哪來的」）────────────────
// 登錄簿裡的路徑允許用 `~/` 開頭（2026-08-11，arcrun-rag#77）。
// 🔴 為什麼不寫死絕對路徑：`installer/` 會被推上 GitHub 公開鏡像
//   （`scripts/github-publish-exclude.txt` 沒排除它）⇒ 寫死 `/Users/<誰>/…`
//   等於把使用者名稱公開，而且換一台機器就不成立。
const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const ctx = {
  target: TARGET_NAME, T,
  bundlesDir: expandHome(T.bundles.dir),
  arcrunRepo: resolve(REPO_ROOT, cfg.source.arcrunRepo),
  release: null, releaseBefore: null, daemonVersion: null,
  built: null,   // manifest.built＝使用者在 /api/latest 看到的建置日（見 version／pin／verify）
  headSha: null, pinUrl: null,
  installerSrcHash: null, // 安裝器原始碼指紋（arcrun-rag#95）——見 pin／deploy／verify 三站
  liveBefore: null,
  pinChanged: false, pushed: false,
  armMission: null, // D20 保險的任務描述（見 preflight），push 步驟留痕要用
  mainPushGrants: null, // 推 main 的授權（preflight 一次領走，每次推 main 用掉一格，InkStoneCo#56）
  sourceCommit: null, // "Arcrun@<sha>"——出貨報告用來比對「兩個理貨員拿的是不是同一張訂單」（D65 二次補述）
  arcrunHeadSha: null, // 來源 repo 的完整 40 碼 HEAD（見 preflight／source-pin）——釘子分支比對用全碼，不用前綴
};

// 🔴 「提升」（promoteFrom）已拆掉，改成 git 分支模型（2026-08-11，D65 三次補述，
//   arcrun-rag#73 缺③）——理由與細節見 `source-pin.mjs` 檔頭 ＋ `installer/ship.targets.json`
//   的 `requireSourceBranch` 說明。leo 原話：「10 次原始碼重建完全不是問題……
//   你要改的只有內外不同的參數」「我根本搞不清楚什麼是提升」「就是這個設計造成了問題」。
//   ⇒ 現在**每個目標都重打**（build／daemon-sync／version 三步不再依 `T.promoteFrom` 分岔），
//   「兩個理貨員拿同一張訂單」改由三件事一起保證：
//     ① 來源 commit 釘子（source-pin.mjs）——prod 只准出貨 stage 已驗證過的那顆 commit
//     ② 版本號共用狀態（release.mjs 的 `sharedState`）——同一份內容跨 bundle repo 得到同一個號碼
//     ③ 出貨報告的硬斷言（ship-report.mjs 的 `assertSourceParity`）——belt-and-suspenders，
//       就算①②哪裡有漏，記錄下來的來源 commit 不一致還是會被攔下來，不會安靜放行。

/**
 * 期望值（這次該送出去的 release／daemon）從**磁碟上那份 bundle manifest** 補齊。
 *
 * 只驗收的模式（`--verify-only`／`--delivery-only`）沒跑 build／version 兩步，
 * ctx 裡是 null。磁碟上那份 manifest **就是上次出貨送出去的內容**——用它當期望值，
 * 問的正是「那一次到底有沒有送達」，而不是拿一個手抄的數字去對。
 * 回傳一行說明（沒補就回 null），讓呼叫端決定要不要印。
 */
function ensureExpectationsFromDisk() {
  if (ctx.release !== null && ctx.daemonVersion !== null) return null;
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) {
    throw new Error(
      `這個模式的期望值取自磁碟上那份 bundle，但找不到它：${mPath}\n` +
      `     ⇒ 這台機器還沒為 ${TARGET_NAME} 建過 bundle（或工作區被清掉了）。\n` +
      `     → 先跑一次完整的 \`--target ${TARGET_NAME}\`（預演就會建），再回來只驗那一站。`);
  }
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  ctx.release = ctx.release || m.release;
  ctx.daemonVersion = ctx.daemonVersion || (m.daemon && m.daemon.version);
  return `期望值取自磁碟 bundle：release ${ctx.release}｜daemon ${ctx.daemonVersion}`;
}

// ══════════════════════════════════════════════════════════════════════════
// 步驟表 —— 固定順序、無分支。每一步回傳 { status:'done'|'skip', detail }
//           丟例外＝這一步斷了，**後面全部不跑**（不變式：失敗即停）。
// ══════════════════════════════════════════════════════════════════════════
const STEPS = [

// ── 1. preflight：在動任何東西之前，確認「我要打的是不是我以為的那個目標」──
{ id: 'preflight', title: '對齊目標（打錯目標打不進去）', mutates: false, async run() {
  const lines = [];

  // (a) publish 目標＝會讓封測者拿到東西 ⇒ 必須 leo 親手開閘。AI 不得自造 .github-armed。
  //     🔴 2026-08-09（arcrun-rag#27）：舊版只查檔案存不存在，**不查過不過期**——
  //     一份三天前的舊保險檔一樣會放行（8/8 23:16 那份至今還在，就是這樣被發現的）。
  //     checkArmed()（d20-guard.mjs）補上過期檢查，並把 mission 帶出來給 push 步驟留痕用。
  //
  // 🔴 D65 二次補述（leo 2026-08-11）：「arm 是開炮，不是開始工作」「計劃時間應該多於
  //   執行時間⋯⋯arm 的閘應該是 100% 有信心後發炮」「你檢查 stage 不用限制在 arm 的時間」。
  //   08-10 實錄：leo 23:31 解保險，出貨在 23:33／23:38 各失敗一次，23:41 才成功——
  //   兩次失敗都事前可發現（其中一次純粹是缺 GITHUB_MIRROR_TOKEN 這種環境前置）。
  //   病根是**這裡原本不分 CONFIRM，一律要求先有 `.github-armed`**——連「只是想預演看看
  //   prod 現在會不會過」都被擋在 arm 之前，逼人必須先解保險才能發現問題，等於用
  //   「延長 arm 窗口」在換取檢查時間（leo 明講不准這樣解）。
  //   ⇒ 改成：**只有真的 `--confirm`（真的要開炮）才需要保險已解**；純預演（不管
  //   `--target` 是不是 prod）不查 `.github-armed`，讓「解保險之前就能把所有不需要
  //   保險的事跑完並確認會過」在結構上成立，不必等 leo 開閘才能看到問題。
  //   真正的防呆沒有變弱：所有 `mutates:true` 的步驟本來就只在 `CONFIRM` 才執行
  //   （見下面主迴圈），所以拿掉的只是「連看都要先解保險」，不是「連做都不用解保險」。
  if (T.requiresArm) {
    if (CONFIRM) {
      const { mission, expiresAt } = checkArmed(INKSTONE_ROOT);
      ctx.armMission = mission;
      lines.push(`保險已解（未過期，還剩 ${Math.max(0, Math.round((expiresAt - Date.now() / 1000) / 60))} 分鐘）：任務＝${mission}`);
    } else {
      lines.push(`目標會發佈（publish=true）——這是預演，不必先解保險就能檢查到這裡（arm 只在真的 --confirm 時才需要）`);
    }
  } else {
    lines.push(`目標不發佈（publish=false）⇒ 不需要 leo 開閘`);
  }

  // (a2) 發佈目標要用到的環境前置（憑證存不存在，不使用、不外洩值）——**不管有沒有
  //   --confirm 都先查**，這樣「解保險之前」就能看到會不會因為缺前置環境而失敗，
  //   不必等真的打到 github-release 那一步才發現（08-10 那兩次失敗其中一次正是這樣）。
  //
  // 🔴 2026-08-16：這一段是 **#88 與 #102 兩件事的交會處**，合併時兩邊都必須活著。
  //   · #88（發佈紀錄兩邊動作相同）：條件從 `T.githubRelease` 改成看 `T.releaseRecord.host`
  //     ⇒ stage 與 prod **各印一行「發佈紀錄目的地」**。在此之前 stage 連「我這一版的說明
  //     要發到哪、憑證在不在」都不會印一個字 ⇒「stage 根本沒有發佈紀錄」在預演輸出上看不出來。
  //   · #102（不再要人先 export 金鑰）：GitHub 那條路的憑證**由管線自己去 `.env` 取**，
  //     不是丟一句「請你查憑證地圖、回 shell export」。leo：「每次出貨必有這個問題，
  //     為什麼不把它編入流程必備？」
  //
  //   ⚠️ **合併時最容易出的事就在這裡**：#88 那一半的原始寫法保留了舊的手動 throw，
  //   直接採用它會讓剛關掉的 #102 **靜默復發**——而且沒有任何測試會講一聲
  //   （出貨線的憑證前置沒有測試守著，它只在真的跑出貨時才現形）。
  //   ⇒ 解衝突時刻意把 #102 的自動取得放回 GitHub 那條路。
  //
  //   ⚠️ #102 的三條刻意不變，合併後照樣成立：
  //     ① 斷點沒有往後挪——拿不到照樣在 preflight 斷，訊息還多講了「查過哪幾份 .env」
  //     ② 操作者在 shell 明確給的值**永遠贏**，自動來源不覆蓋（見 credential-store.fill）
  //     ③ D36：只取被點名的鍵、值不落地不列印；push 出去的只有名字、來源檔與遮蔽後的權杖
  {
    const R = T.releaseRecord;
    // 🔴 2026-08-18 補（inkstone/InkStoneCo#40 順手修）：`R` 可能是 undefined。
    //   上面那道登錄簿驗證（不變式 Ⅵ）自己就寫著「**selftest 兩者皆無 ⇒ 照舊免除**」，
    //   而這裡卻無條件讀 `R.host` ⇒ `--target selftest` 一開跑就
    //   `Cannot read properties of undefined (reading 'host')`，22 站一站都跑不到。
    //   ⇒ **selftest 這個唯一不碰外界的演練目標整個是壞的**（a3934c6 起，實測確認）。
    //   演練目標壞掉最貴的地方不是它自己，是「任何閘都只能在真的要出貨時才驗得到」。
    //   判準與上面那道驗證一致（`installer || publish` 才需要 releaseRecord），不放寬任何東西。
    if (!R) {
      lines.push(`本目標沒有 installer／不發佈 ⇒ 依不變式 Ⅵ 免除發佈紀錄（與登錄簿驗證同一條判準）`);
    } else if (R.host === 'github') {
      //   GITHUB_ACCOUNT_NAME 一起帶（release-record／publish-github.sh 組 Basic auth 要用，
      //   缺了會退回字面 'git'）——它不是硬前置，所以不進 missing 判定，拿得到就用。
      const cred = fillCredentials(['GITHUB_MIRROR_TOKEN', 'GITHUB_ACCOUNT_NAME'], { startDir: REPO_ROOT });
      if (!process.env.GITHUB_MIRROR_TOKEN) {
        throw missingCredentialError(
          { ...cred, missing: ['GITHUB_MIRROR_TOKEN'] },
          { need: 'release-record 步驟會需要它，現在就能發現，不必等解保險、打到那一步才失敗' });
      }
      for (const l of describeSources(cred)) lines.push(l);
      lines.push(`發佈紀錄目的地：GitHub ${R.repoSlug}`);
    } else {
      // Gitea 寫入權杖＝本機 `gitea` remote 網址內嵌的帳密（credentials-map.md 白紙黑字寫著
      // 「Gitea 寫入 token：各 repo 的 git remote 網址內嵌」）。**不另開一條路**——
      // `GITEA_TOKEN` 環境變數只有 read:repository，開 release 會 403，不是替代品。
      const cred = giteaWriteCredentialsFromRemote(REPO_ROOT);
      if (!cred) {
        throw new Error(
          `讀不到 Gitea 寫入權杖——release-record 步驟會需要它，現在就能發現，不必打到那一步才失敗。\n` +
          `     來源＝本機 \`gitea\` remote 網址內嵌的帳密（system-dev/wiki/credentials-map.md）。\n` +
          `     這個 clone 的 gitea remote 不存在，或網址沒有帶帳密。`);
      }
      lines.push(`發佈紀錄目的地：Gitea ${R.repoSlug}（寫入權杖已就位：${redactToken(cred)}）`);
    }

    // (a3) 🔴 **每條版本線宣告的 repo，此刻真的存在嗎**（D95，2026-08-18，InkStoneCo#40）
    //
    //   為什麼要在 preflight 問、而不是等 release-record 站去撞：
    //   宣告寫錯（打錯字、repo 還沒建、org 搞混）的症狀會出現在**第 21 站**，
    //   而那時候 bundle 已經推出去、worker 已經部署完了 ⇒ 「部分成功」，
    //   而這條管線的站表第一行就寫著「一次出貨是一個版本，不接受部分成功」。
    //
    //   🔴 更要緊的是**它不准安靜地退而求其次**。這個 repo 反覆犯的病就是那個形狀：
    //     daemon 斷更四版（發在沒人看的 bundles repo）、landing 從沒出貨過、
    //     docsSite=null 被印成「本目標沒有文件站」——**每一次都是綠的**。
    //   ⇒ 位置寫錯 ⇒ 當場斷，訊息直接說是哪一條線、哪個 repo、去哪裡改。
    //
    //   讀取一律匿名／唯讀（D20 2026-08-10：讀放行、不計次）；Gitea 私有 repo 才帶權杖。
    if (R) {
      const cred = R.host === 'gitea' ? giteaWriteCredentialsFromRemote(REPO_ROOT) : null;
      for (const line of LINES) {
        const entry = repoForLine(line.id, R);
        let ok;
        try {
          ok = await repoExists(R.host, entry.repoSlug, { token: cred && cred.token, baseUrl: R.baseUrl });
        } catch (e) {
          // 🔴 分清楚兩件事：**「這個 repo 不存在」與「我連不到那台主機」不是同一個結論。**
          //   2026-08-18 實測撞到一次 `UND_ERR_CONNECT_TIMEOUT`（同一個指令重跑兩次都過），
          //   而當時的訊息只寫「fetch failed」⇒ 看起來像宣告寫錯，其實是網路抖了一下。
          //   照樣中止（不猜是這條線的規矩），但要讓人一眼知道該去改宣告還是該重跑。
          const code = e.cause && e.cause.code;
          throw new Error(
            `查不到版本線 \`${line.id}\`（${line.product}）宣告的 repo \`${entry.repoSlug}\` 是否存在：${e.message}`
            + `${code ? `（${code}）` : ''}\n` +
            `     不猜、不跳過——查不到就不知道等一下那筆 release 會發到哪裡去。\n` +
            `     ${code ? '看起來是連不到主機（不是宣告錯）⇒ 重跑同一個指令即可，管線是冪等的。'
              : '若確定主機是通的，就是宣告寫錯了 ⇒ 改 installer/ship.targets.json。'}`);
        }
        if (!ok) {
          throw new Error(
            `版本線 \`${line.id}\`（${line.product}）宣告要發到 \`${entry.repoSlug}\`，但${R.host}上**沒有這個 repo**。\n` +
            `     宣告在 installer/ship.targets.json → targets.${TARGET_NAME}.releaseRecord.lineRepos.${line.id}.repoSlug\n` +
            `     🔴 **不會自動退回 ${R.repoSlug}**：那樣做會把「${line.product}」的版本又疊進別人的歷史裡，\n` +
            `        而且是安靜地疊——那正是 D95 leo 指出的那個扭曲（「把一個差很多的東西塞進去別人的歷史裡」）。\n` +
            `     → 要嘛把這個 repo 建起來（GitHub 側屬 D20 管制寫入，需 leo 開閘），要嘛改宣告。`);
        }
        lines.push(`版本線 ${line.id}（${line.product}）→ ${entry.repoSlug}`
          + (livesInOwnRepo(entry) ? `（源碼住那邊：本 repo 的 ${entry.sourceDir}/ 每次出貨同步過去）` : ''));
      }
    }
  }

  // (a4) 🔴 **這一趟會覆寫哪幾個 repo 的 main**（InkStoneCo#56）
  //
  //   推 main 的人閘住在**真的在推的那一行**身上（main-push-guard.mjs），而那些行分散在
  //   第 5 站（產物倉庫）、第 21 站（GitHub 鏡像）與各版本線的同步裡。等撞到才問人，
  //   一趟出貨會停三次；而且會停在**中段**——bundle 已經推出去了，那就是「部分成功」。
  //   ⇒ 開跑前把目的地一次列完；真的 `--confirm` 就在這裡把授權領走（形狀同 D20 的
  //     `checkArmed()`：人的決定在 preflight 確認一次，之後由管線帶著走）。
  {
    const dests = mainPushDestinations();
    if (!dests.length) {
      lines.push('這一趟不會覆寫任何 repo 的 main');
    } else if (!CONFIRM) {
      lines.push(`這一趟會覆寫 main 的目的地（${dests.length}）：${dests.join('、')}`);
      lines.push(`（預演不必先按閘。真的 --confirm 之前，總管逐筆看過那些 commit 再貼：${armCommand(dests)}）`);
    } else {
      const missing = unarmedDestinations(dests);
      if (missing.length) {
        throw new Error(
          `這一趟會覆寫 ${dests.length} 個 repo 的 main，其中 ${missing.length} 個還沒有「總管決定了」的戳記：\n` +
          missing.map((d) => `       - ${d}`).join('\n') + '\n' +
          `     🔴 2026-08-18 出貨線就是在沒有任何閘的情況下推壞了 inkstone/arcrun-collector 的 main\n` +
          `        （刪掉 cmd/collector/main.go、把 22 行的 .gitignore 洗成 1 行）——殼層那道 hook\n` +
          `        看不見 node 子行程，所以閘搬進了管線自己身上（InkStoneCo#56）。\n` +
          `     → 逐筆看過那些 commit，確定它們該進 main，再整行貼（一次把這趟要的都寫進去）：\n\n` +
          `         ${armCommand(dests)}\n\n` +
          `     戳記綁目的地、單次用完即丟、15 分鐘失效。**subagent 不要自己造它**，交回總管。`);
      }
      // 領走：之後每一次推 main 用掉一格（見 main-push-guard.mjs 的 claimGrants）
      ctx.mainPushGrants = claimMainPushGrants(dests);
      lines.push(`推 main 的授權已領（${[...ctx.mainPushGrants.keys()].join('、')}）——每個目的地一次，用完即丟`);
    }
  }

  // (b) 產物來源：**每個目標都從 Arcrun 原始碼重打**（2026-08-11，D65 三次補述訂正，
  //     arcrun-rag#73 缺③：leo「10 次原始碼重建完全不是問題……你要改的只有內外不同
  //     的參數」——prod 不再是「提升」既有 bundle，是跟 stage 走**同一條重打路徑**，
  //     同一套邏輯只換參數（帳號、URL），不是兩套邏輯各自維護。
  if (!existsSync(ctx.arcrunRepo)) throw new Error(`來源 repo 不存在：${ctx.arcrunRepo}`);
  // ── ARCRUN_SOURCE_WORKTREE（2026-08-10 加）────────────────────────────────
  // 病：`matrix/arcrun` 只有**一份工作區**，卻同時有好幾個 agent 在上面幹活。
  //     只要有人手上有未提交的改動（那天是 `kbdb/src/actions/entry-crud.ts`，而 kbdb
  //     **正是 bundle 裡的一顆**），下面那道 dirty 閘就會擋住所有出貨——
  //     而看起來唯一的「解法」是去 commit 或丟棄別人的半成品，那是比擋住更糟的事。
  //
  // 這個逃生門**不放寬任何判準**，只是換一個乾淨的取景窗：
  //   ① 必須是**同一個 repo 的 git worktree**（比對 `--git-common-dir`）
  //      ⇒ 擋不掉「打錯 repo」這件事，不變式 Ⅱ 完好
  //   ② 它自己**一樣要乾淨**，dirty 照樣擋
  //      ⇒「這版來自哪個 commit」照樣是真的（這才是那道閘真正在保的東西）
  // 用法：git worktree add /tmp/arcrun-ship HEAD && ARCRUN_SOURCE_WORKTREE=/tmp/arcrun-ship …
  const wt = process.env.ARCRUN_SOURCE_WORKTREE;
  if (wt) {
    const wtPath = resolve(wt);
    if (!existsSync(wtPath)) throw new Error(`ARCRUN_SOURCE_WORKTREE 不存在：${wtPath}`);
    const commonOf = (p) => resolve(p, sh('git', ['rev-parse', '--git-common-dir'], p));
    if (commonOf(wtPath) !== commonOf(ctx.arcrunRepo)) {
      throw new Error(
        `ARCRUN_SOURCE_WORKTREE 不是登錄簿宣告那個 repo 的 worktree（拒絕從別的 repo 出貨）：\n` +
        `       宣告：${ctx.arcrunRepo}\n       給的：${wtPath}`);
    }
    ctx.arcrunRepo = wtPath;
    lines.push(`來源改讀 worktree：${wtPath}（同一個 repo；乾淨度照驗，不放寬）`);
  }
  const srcDirty = sh('git', ['status', '--porcelain'], ctx.arcrunRepo);
  const srcSha = sh('git', ['rev-parse', '--short', 'HEAD'], ctx.arcrunRepo);
  const srcShaFull = sh('git', ['rev-parse', 'HEAD'], ctx.arcrunRepo);
  if (srcDirty && !T.allowDirtySource) {
    throw new Error(
      `來源 repo 有未提交變更，發佈目標拒絕出貨（不然「這版來自哪個 commit」是假的）：\n` +
      srcDirty.split('\n').slice(0, 8).map((l) => `       ${l}`).join('\n') +
      `\n     → 先 commit，或用 --target selftest 做本機驗證`);
  }
  lines.push(`來源：Arcrun@${srcSha}${srcDirty ? ' ⚠️(工作區不乾淨，本目標允許)' : ''}`);
  ctx.arcrunHeadSha = srcShaFull;

  // (b2) 釘子分支：**取代 promoteFrom**（2026-08-11，D65 三次補述，arcrun-rag#73 缺③，
  //   見 `source-pin.mjs` 檔頭）。leo：「我要的就是跟 github 一樣，先打到 stage 分支，
  //   無誤，就打到 main 分支，上架」——這裡就是那個「先打 stage、驗過才准動 main」的
  //   git 分支：分支只在 Arcrun repo 本機移動（不推遠端），由成功跑完 `--confirm`
  //   （含 verify 全過）的目標自己在檔尾移動（見檔尾），不是人手 touch。
  //   有宣告 `requireSourceBranch` 的目標（目前只有 prod）＝只准出貨這顆分支釘住的
  //   commit；沒宣告的目標（stage／selftest）不受這道閘管，可以打任何乾淨的 HEAD。
  if (T.requireSourceBranch) {
    const pin = checkSourcePin({ repo: ctx.arcrunRepo, branch: T.requireSourceBranch, currentSha: srcShaFull, currentShaShort: srcSha });
    if (!pin.ok) throw new Error(pin.message);
    lines.push(pin.message);
  }

  // (b3) 成品新鮮度：**送出去的執行檔是不是還算數**（Leo/Arcrun#93，2026-08-12）─────
  //
  // 上面 (b) 問的是「來源乾不乾淨」、(b2) 問的是「這顆 commit 驗過了沒」——
  // 兩道都會過，卻**都答不出「這批要被部署的位元組是不是這顆 commit 編的」**。
  // 08-12 實況：併完 Arcrun#85／#88 沒重編，cypher-executor 的成品還記著 797e7f7
  // 而源碼已經是 525faaf、kbdb 是 a7e23ba vs 3eb8b31 ⇒ **要送出去的是舊執行檔，
  // 而測試全綠、出貨管線也全綠**，是人工逐顆比對才發現的。
  //
  // 擺在 preflight（mutates:false）而不是 build 站的理由有兩個：
  //   ① **預演就看得到**——不必解保險、不必真的出貨，就知道自己少做了重編
  //   ② build 站之前還有 `daemon-sync`（mutates:true）會先動 bundle repo，
  //      擋在這裡才是「任何會把東西送出去的動作之前就停」
  // build-bundles.mjs 那一側也有同一道閘（同一支模組）——它會被別的路徑單獨呼叫，
  // 兩邊都要擋，不是重複而是各自守各自的入口。
  const artifactManifestPath = join(ctx.arcrunRepo, '.worker-builds', 'manifest.json');
  if (!existsSync(artifactManifestPath)) {
    throw new Error(
      `來源 repo 沒有官方成品 manifest：${artifactManifestPath}\n` +
      `     出貨真正拿去部署的執行檔就是 .worker-builds/ 裡那批；沒有它就沒有「這一版從哪來」。\n` +
      `     → 在 ${ctx.arcrunRepo} 跑 \`node scripts/build-worker-artifacts.mjs\` 並把成品 commit 進去`);
  }
  const artifactManifest = JSON.parse(readFileSync(artifactManifestPath, 'utf8'));
  const freshness = requireFreshArtifacts({
    repo: ctx.arcrunRepo,
    manifest: artifactManifest,
    // 公庫的**每一顆**都要驗新鮮度，不只首裝那幾顆——懶載那些同樣會被裝到使用者機器上，
    // 只是晚一點。舊的懶載零件不會有人發現，因為它裝下去的那一刻沒有人在看。
    components: (artifactManifest.workers || []).map((w) => ({ name: w.name })),
    // selftest（不推、不部署、沒有任何人會拿到東西）才允許工作區髒；
    // 「已經 commit 了卻沒重編」不受這個旗標影響，一律擋。
    allowDirty: !!T.allowDirtySource,
  });
  lines.push(
    freshness.ok
      ? `成品新鮮度：${freshness.results.length} 顆的 source_commit 都還等於它源碼目錄的現況 ✓`
      : `⚠️ 成品新鮮度：${freshness.blocking.length} 顆對不上（ARTIFACT_ALLOW_STALE=1 放行中）`);

  // (b4) 資源規則閘（`Leo/Arcrun#97`，2026-08-12）────────────────────────────
  //
  // 擋的是「**同一個能力被做成兩份實作**」——安裝器自己照名字 ensure 資源，
  // 而 `acr` 那條走共用規則 ⇒ 使用者按更新，工作流和登入 session 全不見。
  // 接上共用規則只解掉這一次；這道閘是為了讓**下次有人再抄一份會被擋住**。
  //
  // 為什麼在 preflight 而不是 deploy 站：deploy 站有「線上已是這版就跳過」的快路徑，
  // 擺在那裡會出現「跳過部署＝也跳過檢查」的洞（而且預演就該看得到，不必解保險）。
  // 檢查內容與怎麼被演練，見 installer/scripts/resource-rule-gate.mjs 檔頭。
  const gate = runResourceRuleGate(REPO_ROOT);
  if (!gate.ok) {
    throw new Error(
      '資源規則閘不過（Leo/Arcrun#97：同一個能力有兩份實作）：\n' +
      gate.sections.filter((s) => !s.ok).map((s) => `     ✗ ${s.name}\n${s.problems.map((p) => `       - ${p}`).join('\n')}`).join('\n'));
  }
  lines.push(`資源規則閘：${gate.sections.length} 項全過（鏡射指紋／沒人自己建 CF 資源／真的接上／三種情境測試）`);

  // (b4.5) 版本印記閘（Arcrun#106 另一半，2026-08-16）───────────────────────
  //
  // 擋的是「**部署路徑烙了版號卻沒烙 commit**」——版號是部署時貼上去的標籤，
  // 只剩它就查不出「這台跑的是哪一份碼」，而且會把別條路烙的 commit 洗掉
  // （08-16 實測：三台實例同報 1.4.46，commit 欄位全消失）。
  // 位置理由同 (b4)：擺在 preflight，deploy 站的「已是這版就跳過」快路徑蓋不到它。
  const stampGate = runVersionStampGate(REPO_ROOT);
  if (!stampGate.ok) {
    throw new Error(
      '版本印記閘不過（Arcrun#106：烙了版號卻沒烙 commit ⇒ 查不出實例跑哪份碼）：\n' +
      stampGate.sections.filter((s) => !s.ok).map((s) => `     ✗ ${s.name}\n${s.problems.map((p) => `       - ${p}`).join('\n')}`).join('\n'));
  }
  lines.push(`版本印記閘：${stampGate.sections.length} 項全過（每條部署路徑版號與 commit 成對／印記產地真的吐兩個）`);

  // (b5) 文案契約閘（順手接上，2026-08-12）──────────────────────────────────
  // `installer/oauth-prototype/copy-contract.test.mjs` 自己的檔頭寫著
  // 「deploy-web.sh 在部署前跑本檔，任一違反＝拒絕部署」——而 `deploy-web.sh` 早就不存在，
  // 全 repo grep 只剩它自己那一行 ⇒ **它從來沒擋過任何東西**（同 arcrun-rag#27 那種
  // 「規約寫在註解裡，沒有一步在執行它」）。這裡把它接上，順便讓它跟資源規則閘同一個位置停。
  // 現況實測是綠的（禁句 10 項全 0、必句 3 項全在），接上不會改變本次出貨的結果。
  const copyContract = spawnSync(process.execPath, [join('installer', 'oauth-prototype', 'copy-contract.test.mjs')],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  if (copyContract.status !== 0) {
    throw new Error(`文案契約閘不過：\n${(copyContract.stdout || '') + (copyContract.stderr || '')}`);
  }
  lines.push('文案契約閘：通過（leo 拍板拿掉的句子沒有回來）');

  // (c) bundle repo：不存在就照登錄簿長出來（selftest）；存在就驗 origin 與登錄簿相符。
  //     🔴 這一條就是「打錯位置也會被它修正」的實體：本機那個資料夾指到別的 repo ⇒ 當場擋。
  const seedFrom = expandHome(T.bundles.seedFrom);
  if (!existsSync(join(ctx.bundlesDir, '.git'))) {
    if (seedFrom && existsSync(seedFrom)) {
      mkdirSync(ctx.bundlesDir, { recursive: true });
      cpSync(seedFrom, ctx.bundlesDir, { recursive: true, filter: (s) => !s.includes('/.git') });
      rmSync(join(ctx.bundlesDir, '.git'), { recursive: true, force: true });
      sh('git', ['init', '-q', '-b', T.bundles.branch], ctx.bundlesDir);
      sh('git', ['add', '-A'], ctx.bundlesDir);
      sh('git', ['-c', 'user.email=ship@local', '-c', 'user.name=ship', 'commit', '-q', '-m', 'seed'], ctx.bundlesDir);
      lines.push(`bundle repo 不存在 ⇒ 依登錄簿由 ${seedFrom} 播種`);
    } else {
      throw new Error(`bundle repo 不存在：${ctx.bundlesDir}\n     → clone ${T.bundles.remote} 到這個路徑（路徑由登錄簿決定，別自己挑）`);
    }
  }
  if (T.bundles.remote !== 'local-selftest') {
    let origin = '';
    try { origin = sh('git', ['remote', 'get-url', 'origin'], ctx.bundlesDir); } catch { /* 無 origin */ }
    if (normRemote(origin) !== normRemote(T.bundles.remote)) {
      throw new Error(
        `bundle repo 指到**別的地方**，拒絕出貨（這正是「打錯實例」的入口）：\n` +
        `       目錄   ${ctx.bundlesDir}\n` +
        `       origin ${normRemote(origin) || '(沒有 origin)'}\n` +
        `       應為   ${normRemote(T.bundles.remote)}   ← installer/ship.targets.json`);
    }
    lines.push(`bundle repo：${ctx.bundlesDir} → ${normRemote(origin)} ✓`);
  } else {
    lines.push(`bundle repo：${ctx.bundlesDir}（本機 selftest，不推遠端）`);
  }

  // (c2) 記下「動手之前」的版本——步驟 3 要靠它誠實報告這次有沒有 bump。
  try {
    ctx.releaseBefore = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).release;
    lines.push(`動手前版本：${ctx.releaseBefore}`);
  } catch { ctx.releaseBefore = null; }

  // (d) 先記下線上現況——之後 deploy 要靠它判斷「是不是已經是這一版」（冪等的依據）。
  //
  // 🔴 D70（leo 2026-08-11，arcrun-rag#77）：**這一段的活派給 Arcrun 工作流做**。
  //   「去一個使用者會看的網址看一眼、回報它現在宣告什麼」正是工作流天生的形狀，
  //   而 leo 打開工作流頁就看得到出貨線在用它（`ship_check_live`）。
  //   ⚠️ 值直接取工作流回的 `actual`——**不要再自己 fetch 一次**。
  //     那樣 Arcrun 就只是裝飾（真正做事的還是本機），是腹語術的反面版本，一樣違反 D70。
  //   讀不到不算斷——這一步只是留個底給 deploy 當冪等依據，真正的驗收在 verify 那站。
  if (T.verify) {
    try {
      const live = await checkLive({
        url: `${T.verify.installerBase}/api/latest?${cb()}`,
        // installer_sha：見 arcrun-rag#95——deploy 站要靠它發現「安裝器原始碼變了
        // 但 release／pin 沒動」這種以前完全隱形的情況，不能只問 release／pin。
        checks: [{ label: 'release', path: 'release' }, { label: 'pin', path: 'pin' }, { label: 'installer_sha', path: 'installer_sha' }],
      });
      if (!live.fetch_ok) throw new Error(live.fetch_error || '抓不到');
      const val = (l) => (live.results.find((r) => r.label === l) || {}).actual;
      ctx.liveBefore = { release: val('release'), pin: val('pin'), installerSrcHash: val('installer_sha') };
      lines.push(`線上現況（Arcrun ship_check_live 去看的）：release ${ctx.liveBefore.release}｜pin ${ctx.liveBefore.pin}｜installer_sha ${String(ctx.liveBefore.installerSrcHash || '(無)').slice(0, 12)}`);
    } catch (e) { lines.push(`線上現況：讀不到（${e.message}）`); }
  }
  return { status: 'done', detail: lines };
}},

// ── 1.2 public-docs：對外說明文字也要掃——「這一版的東西還成不成立」，不是內容有沒有變 ──
//
// 🔴 D65（leo 2026-08-11）：「readme 也應該在出貨範圍內對吧，每次按下出貨，它就要掃所有的
//   東西，因為這個出貨很複雜」「前一次和這一次的出貨你都沒有記錄」。執行票 arcrun-rag#73。
//
// 病：17 關驗得很兇，卻沒有任何一關讀過 README 在講什麼。README 每次出貨都被
// `github-release` 步驟整棵公開樹 push 上 GitHub——但那一步**只有 prod 且要 --confirm**
// 才會跑。`stage`／`selftest` 從沒被掃過，於是「README 教的路已經不是產品現在的入口」
// 這件事一路綠燈：回溯查公開鏡像每一次快照，`install.arcrun.dev`（現在唯一的一鍵安裝
// 入口）從 2026-07-18 到 1.4.33（68160cd）全部是 0——README 從沒提過它，教的一直是
// 「git clone＋貼給 AI」那條已經退居 `<details>` 進階區的舊路。
//
// 解法不是另建一套平行判準（那會製造第二份會漂移的清單，同 bundle-components.mjs 檔頭
// 記的那次病）：改成**提早呼叫**既有的公開樹守門機制——`scripts/publish-github.sh` 第 3.5
// 步本來就會掃「整棵會被推上公開鏡像的樹」（github-publish-sanitize.py），只是這次也
// 補上「README 必須提到 install.arcrun.dev」的**要求存在**檢查（相對於它原本只有的
// 「禁止存在」檢查——同不變式 Ⅴ 的形狀：缺了要斷，不是印警告）。
//
// 🔴 D65 補述（leo 2026-08-11 二次拍板，同票留言）：一張清單兩個目標都要跑滿，
//   這一步刻意**不看 T.promoteFrom**——不管重打還是提升，都是同一顆「公開樹乾不乾淨」
//   要問，差異只准是打哪個帳號/網址，不准是這一項有沒有被問過。
//
// mutates:false：只建本機 `.github-public/`（.gitignore 排除，不影響外界），不 push、
// 不動 bundlesDir、不需要任何 GitHub 憑證——預演（不加 --confirm）也會跑，讓漏洞在
// **最早**的時刻被看見，不必等到真的走完整條出貨鏈。
{ id: 'public-docs', title: '掃公開樹：說明這一版的東西還成不成立（README／安裝手冊／Portal 導覽…）', mutates: false, async run() {
  try {
    shLive('bash', [join(REPO_ROOT, 'scripts', 'publish-github.sh')], REPO_ROOT);
  } catch (e) {
    throw new Error(
      `公開樹守門不過（scripts/publish-github.sh 的 sanitize 步驟，訊息見上面的即時輸出）：${e.message}\n` +
      `     → 這關掃的是「對外解釋這個產品怎麼用的文字」還成不成立，不是這次改了什麼程式碼。\n` +
      `       修**源頭正稿**（README／docs/manual／docs/demo…），不要在 sanitize.py 裡加豁免\n` +
      `       （leo 2026-07-21：「正稿的網址從源頭就寫對，不靠發佈時改寫」）。`);
  }
  return { status: 'done', detail: ['scripts/publish-github.sh（含 sanitize 守門）全過 ⇒ 公開樹此刻乾淨、README 教的路是現在的入口'] };
}},

// ── 1.4 daemon-sync：**把 daemon 真的搬進 bundle**（下面那道 check 才有東西可過）──
//
// 🔴 leo 2026-08-09（arcrun-rag#27）：「你推 Stage 機制會複製到推 Prod 機制，
//   所以你 stage 沒帶上 daemon 這個問題如何解決？」
//
// 08-09 第一輪只加了下面的 `daemon-check`——它**擋得住**「daemon 沒跟上」，
// 但擋下來之後要人**手動**把 dmg/exe/msix 搬進 bundle、手算 sha256、手改 manifest。
// 那就是把一道機械閘變成一張待辦事項：出貨鏈照樣停在那裡，而且「怎麼搬」這件事
// 只活在人的記憶裡——正是 leo 說的「演習視同作戰」要根治的東西。
// （實錄：daemon v0.18.25 的 dmg/exe/msix 08-09 17:36 就打好躺在 dist/，
//   stage bundle 裡卻還是 v0.18.24，因為**沒有任何一步負責搬它**。）
//
// ⇒ 這一步補上那個「沒有任何一步負責」的動作。
//
// 🔴 2026-08-11（D65 三次補述，arcrun-rag#73 缺③）：拆掉「提升」之後，**兩個目標
//   現在走同一條路徑**——都從 `collector/cmd/arcrun-app/dist/` 取 changelog 最上面
//   那個**已發佈**版本的產物，sha256 由**磁碟實檔**算。這比舊的「prod 照抄 stage」
//   更對稱：兩邊用同一套規則、同一份本機 dist/，天生就會拿到位元相同的檔案，
//   不必再靠「複製」這個額外機制去保證一致——跟 build 步驟現在的形狀一樣
//   （leo：「內外要一樣，不是內外要修改」，見 decisions-summary.md D65 三次補述）。
//
// 只加不刪：舊版本的安裝檔留在 bundle 裡（prod 就留著 20 個），要不要回收是人的決定。
{ id: 'daemon-sync', title: '把本機最新已發佈的 daemon 產物搬進 bundle', mutates: true, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  // 🔴 2026-08-18（D95 第二輪，inkstone/InkStoneCo#40）：這裡本來是
  //   `return { status:'skip', detail:['manifest.json 還不存在（首次播種前）'] }`。
  //   但 preflight (c) 段已經負責把 bundle repo clone／播種出來——走到這一站還沒有
  //   manifest ＝ **那一步沒做成**，不是「首次播種前的正常狀態」。用 skip 表達它，
  //   等於把一個斷掉的前置條件寫成「沒事可做」。
  if (!existsSync(mPath)) {
    throw new Error(
      `bundle 目錄裡沒有 manifest.json：${mPath}\n` +
      `     preflight 已經負責把 bundle repo clone／播種出來（ship.mjs (c) 段），所以走到這一站\n` +
      `     還沒有 manifest ＝ 那一步沒做成。搬 daemon 沒有落腳處 ⇒ 不准繼續。`);
  }
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  const dstDir = join(ctx.bundlesDir, 'daemon');

  // 🔴 2026-08-18（D95 第二輪）：這三行以前讀的是 `CHANGELOG_REL`＝docs-site 那份。
  //   D95 第一輪把桌面版那條線搬進 `collector/CHANGELOG.md` 之後，docs-site 只剩雲端
  //   引擎（`1.4.x`，**沒有 `v` 前綴**）⇒ 下面那個正則永遠不中 ⇒ 整站每次都 skip
  //   ⇒ 出貨線照印 ✅、新 daemon 從不進 bundle。**改路徑只治這一次，所以連 skip 一起拿掉。**
  const clPath = join(REPO_ROOT, DAEMON_CHANGELOG_REL);
  if (!existsSync(clPath)) {
    throw new Error(
      `找不到 daemon 的版本說明檔：${DAEMON_CHANGELOG_REL}\n` +
      `     ⇒ 出貨線與 daemon 源碼樹對「這份檔案住哪」有分歧。以前這種情況是安靜跳過，\n` +
      `       而安靜跳過的下場就是 arcrun-rag#88 的「斷更四版」。\n` +
      `     → 唯一真相源＝installer/scripts/daemon-notes.mjs 的 DAEMON_CHANGELOG_REL。`);
  }
  // 判斷式來自 daemon-notes.mjs（唯一一份），且**由 collector/DAEMON_LINE 產生**。
  //
  // 🔴 2026-08-18 第二輪（#88）：原本這裡認的是 `^## v\d+\.\d+\.\d+（`——那個 `v`
  //   兼任版本線判別器。leo 要的裸號一落到產生端，它就**靜默**跳過新版、比對到更舊的
  //   `## v0.18.29（`，打包出新版執行檔卻讓 manifest 宣稱是舊版——版本號說謊，21 站全綠。
  //   現在改問「這一段在不在 DAEMON_LINE 宣告的那條線上」：裸號與舊的帶 v 都認得，
  //   雲端那條 `1.4.x` 一樣進不來，而且 DAEMON_LINE 讀不出來時**這一站直接斷**。
  const clText = readFileSync(clPath, 'utf8');
  const top = clText.match(daemonReleasedReFor(REPO_ROOT));
  if (!top) {
    const any = clText.match(ANY_RELEASED_RE);
    throw new Error(
      `${DAEMON_CHANGELOG_REL} 裡沒有任何屬於 daemon 版本線的已發佈版本段。\n` +
      (any
        ? `     量到的事實：最上面那一段是 \`## ${any[1]}（…）\`，不在 ${DAEMON_LINE_REL} 宣告的那條線上。\n` +
          `     → 要嘛路徑指錯了（雲端引擎 \`1.4.x\` 住在 repo 根的 CHANGELOG.md），\n` +
          `       要嘛 ${DAEMON_LINE_REL} 換線了卻還沒戳出新線的第一版。\n`
        : '') +
      `     ⇒ 這次出貨問不出「該送哪一版 daemon」——而問不出來不等於沒事，\n` +
      `       它等於「這次出貨不知道自己在送什麼」。\n` +
      `     → 還沒戳版就跑 collector/cmd/arcrun-app/daemon-version.py --stamp。`);
  }
  const want = top[1];
  if (m.daemon && m.daemon.version === want) {
    // 版號一樣**不代表內容一樣**（wiki 2026-08-17：msix 停在上一版卻報全綠，
    // 就是因為這裡只比版號就整站跳過）。所以這裡回 skip 是安全的——真正的判定
    // 交給下一站 `daemon-check` 的事實閘（比檔案存不存在、比 sha256），它沒有 skip。
    return { status: 'skip', detail: [`bundle 已委任 ${want}；內容是否真的到位由下一站 daemon-check 逐檔查證`] };
  }

  // 檔名規則與 collector 的打包腳本一致；缺 mac／win 就是還沒打完，不准含糊出貨。
  const wanted = [
    { key: 'mac', file: `Arcrun-${want}.dmg`, required: true },
    { key: 'win', file: `Arcrun-win-${want}.exe`, required: true },
    { key: 'msix', file: `Arcrun-${want}.msix`, required: false },
  ];
  // dist/ 是 gitignored 的本機建置產物，每個 git worktree 各自一份——打包與出貨若
  // 發生在不同 worktree（本 repo 常規做法：每個修法開一個獨立 worktree），只看
  // `REPO_ROOT`（自己所在那個 worktree）會找不到別的 worktree 打好的檔案，誤判成
  // 「沒有新版可搬」而安靜跳過（2026-08-13 實撞，daemon-dist.mjs 檔頭有完整背景）。
  // ⇒ 用 git 的 worktree 中繼資料掃過本 repo 所有 worktree，不是新開一個共用目錄。
  const requiredFiles = wanted.filter((w) => w.required).map((w) => w.file);
  const resolved = resolveDaemonDist({ repoRoot: REPO_ROOT, distRel: DAEMON_DIST_REL, requiredFiles });
  if (!resolved.dir) {
    throw new Error(
      `changelog 說 ${want} 已發佈，但下列位置（本 repo 目前所有 worktree 的 ${DAEMON_DIST_REL}）都找不到完整產物：\n` +
      resolved.tried.map((d) => `       • ${d}`).join('\n') + '\n' +
      `     → 先把 ${want} 的桌面 App 打包出來（Mac 與 Windows 都要，在本 repo 任一個 worktree 皆可），再出貨；\n` +
      `     → 若這版本來就不該出，把 changelog 最上面那段改回「下一版（未發佈）」草稿。`);
  }
  const distDir = resolved.dir;
  const fromOtherWorktree = resolved.worktree !== REPO_ROOT;

  mkdirSync(dstDir, { recursive: true });
  const before = m.daemon && m.daemon.version;
  const daemon = { ...(m.daemon || {}), version: want };
  const copied = [];
  for (const w of wanted) {
    const from = join(distDir, w.file);
    if (!existsSync(from)) continue;
    cpSync(from, join(dstDir, w.file));
    // sha256 由**磁碟實檔**算——安裝器就是拿這個值驗下載完整性，抄錯等於全體裝不起來。
    const sha = createHash('sha256').update(readFileSync(join(dstDir, w.file))).digest('hex');
    daemon[w.key] = { file: `daemon/${w.file}`, sha256: sha };
    copied.push(`${w.key}→${w.file}`);
  }
  // `built` 也由產物推導（取 mac 產物的 mtime），不由人當場填。
  const stamp = statSync(join(dstDir, `Arcrun-${want}.dmg`)).mtime;
  const p2 = (n) => String(n).padStart(2, '0');
  daemon.built = `${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}`;
  m.daemon = daemon;
  writeFileSync(mPath, JSON.stringify(m, null, 1) + '\n');
  return { status: 'done', detail: [
    `daemon ${before || '(無)'} → ${want}（來源 ${distDir}${fromOtherWorktree ? '　⚠️ 取自另一個 worktree，不是這次執行 ship.mjs 的這個' : ''}）`,
    `複製 ${copied.length} 個安裝檔並重算 sha256：${copied.join('、')}`,
    `built=${daemon.built}（由產物 mtime 推導）`,
  ] };
}},

// ── 1.5 daemon-check：bundle 裡的 daemon 版本，是不是本機（changelog）最新那版 ──
// （上一步 daemon-sync 已負責「搬」；本步是它的**後置條件驗證**——搬完仍不符就是搬錯了。）
// 🔴 leo 2026-08-09（arcrun-rag#27 C0，最優先）：
//   「你寫了 CI/CD 腳本推到 Stage，這個『演習視同作戰』，你推 Stage 機制會複製到
//     推 Prod 機制，所以你 stage 沒帶上 daemon 這個問題如何解決？」
//
// 實錄：總管打好 daemon v0.18.25，跑 ship.mjs --target stage --confirm，
// 腳本印「✅ 出貨完成｜daemon v0.18.24」——新 daemon 根本沒被搬上去，腳本卻說完成了。
//
// 根因（讀碼確認，歷史紀錄——當時的 BUILD_MANAGED 清單已於 2026-08-11 拆 promoteFrom 時
// 移除，見 ship.mjs 檔頭「不變式 Ⅳ」）：那份清單沒有 daemon 這一項——不管是「重打」（stage）
// 還是「提升」（prod）路徑，都不碰 bundlesDir/daemon/；manifest.daemon 只是**原樣留著**
// （release.mjs `syncManifest` 的 `...m` 保留邏輯，本來是為了不要把 daemon 欄位吃掉，
// 但副作用是它也絕不會自己變新）。verifyManifest（release.mjs）驗得很細——宣告版本
// ＝檔名＝二進位內版本——但驗的是「bundle 內部自洽」：舊的自己跟自己相符，一樣綠燈。
// 它從來沒有問過「這是不是我現在能打出來的最新版」。
//
// ⇒ 這裡補上唯一真正缺的比對：changelog（daemon-version.py 的單一真相源，見該檔
// 檔頭）最上面那個屬於 **DAEMON_LINE 宣告那條線**的版本段（`## 0.18.31（…）`，
// 舊的 `## v0.18.30（…）` 同樣認得）vs 這個 bundle 現在委任的 manifest.daemon.version。
// 不符＝新打的 daemon 沒被送進來，出貨中止，不准印「✅ 出貨完成」。
//
// 為什麼不用 daemon-version.py（不 --stamp）當比對源：那支在 changelog 有「下一版
// （未發佈）」草稿段時會印**預覽的下一版號**（還沒真的出），拿來比對會誤傷「只是先
// 寫草稿、還沒打包」的正常情況。這裡改成直接讀「最上面那個已經是正式版號的段落」
// （與 daemon-version.py 的 RELEASED_RE 同一個判斷式），只認**已經真的出過的版本**。
//
// mutates:false（純讀比對，不改任何東西）⇒ 預演與 --confirm 都會跑，且跑在 build
// 之前——build 完全不碰 daemon，所以提早在這裡擋，省得白跑一輪 build 才發現。
//
// ── 🔴 2026-08-18 改寫（D95 第二輪，inkstone/InkStoneCo#40）：從「比字串」變成「查事實」──
//
// 舊版有兩個病，路徑改對只治得了第一個：
//   ① **問錯檔案**：D95 第一輪把桌面版那條線搬進 `collector/CHANGELOG.md` 之後，
//      這裡讀的 `CHANGELOG_REL`（docs-site）只剩雲端引擎 `1.4.x`（沒有 `v` 前綴）
//      ⇒ 正則不中 ⇒ 整站 `status:'skip'`。
//   ② **只比版號字串**：兩邊版號一樣就放行——而 `wiki/trees/2026-08-17-today.md:44` 記著
//      「`ship.mjs:797` 只比版號字串就跳過整站，**msix 停在上一版卻報全綠**」。
//      版號相同**不代表內容相同**：manifest 的平台欄位是「只加不刪」地保留下來的，
//      舊版那顆 msix 的檔名與 sha256 會原樣活著。字串比對永遠看不到這件事。
//
// ⇒ 改成問**磁碟上量得到的量**（`daemon-in-bundle-gate.mjs`）：
//      檔案在不在／sha256 真的算一次／大小是不是 0／檔名帶不帶這一版的版號／必要平台齊不齊。
//   `installer/scripts/daemon-in-bundle-gate.test.mjs` 逐項演練（該擋 8 種、不該擋 3 種）。
//   閘**擋下與放行都留痕**到 `installer/daemon-in-bundle-gate-log.md`（InkStoneCo#48）。
//
// 🔴 **這一站沒有 `skip` 這個結果**。問不出來就是斷——那正是 ① 的病灶：
//   「我找不到東西」被寫成「沒事可做」，於是任何一次結構調整都會讓整站無聲失效。
{ id: 'daemon-check', title: '查證這一版的 daemon 真的在成品裡（逐檔算 sha256，不是比版號字串）', mutates: false, async run() {
  const r = requireDaemonInBundle({
    repoRoot: REPO_ROOT,
    bundlesDir: ctx.bundlesDir,
    changelogRel: DAEMON_CHANGELOG_REL,
    targetName: TARGET_NAME,
  });
  return { status: 'done', detail: [
    `daemon ${r.version} 真的在成品裡（源碼樹／bundle 版本一致）`,
    ...r.checks.map((c) => `✅ ${c.name}　—　${c.fact}`),
  ] };
}},

// ── 1.6 daemon-source-check：**changelog 宣告的那一版，源碼是不是還算數**（2026-08-15 夜間）──
//
// `daemon-sync`／`daemon-check` 兩站比的是 bundle vs changelog；這一站補上那條鏈缺的另一段：
// changelog **最上面已發佈**那個版本 vs `collector/`（daemon 源碼）現況。
//
// 08-15 夜間實況：e7c715f／d4d79f1／91f6171 三顆 commit 全動了 `collector/`，changelog 最上面
// 已發佈段卻還是 08-13 打包時戳的 v0.18.27——沒人戳新版、沒人重打包。而 daemon-sync／
// daemon-check 比的兩個值（bundle.daemon.version、changelog 頂端版號）從頭到尾沒人要求跟
// 源碼現況對過帳，於是兩邊同時落後於現實、永遠對得上：`--target stage --confirm` 印出
// 「⏭ 跳過：bundle 已是 changelog 最新已發佈版：v0.18.27」，而使用者按「檢查更新」拿到的
// 還是 08-13 那顆執行檔。詳細背景與判法見 daemon-freshness.mjs 檔頭。
//
// 擺在這裡（daemon-check 之後、fetch-artifacts 之前）而不是只靠 daemon-check 的理由：
// daemon-check 比對的是**這個 bundle 現在委任的版本**，只要今天沒人動過 bundle 就不會被
// 觸發；本站直接比對**源碼本身**，不管 bundle 現況如何，任何一次預演都能看到「源碼動了」。
//
// mutates:false ⇒ 預演（不加 --confirm）也會跑，且跑在任何會送出東西的動作之前。
//
// ── 🔴 2026-08-18 改判法（inkstone/arcrun-rag#88）：從「查 git 歷史」改成「量指紋」──
//
// 舊判法是 `git log <宣告那顆>..HEAD -- collector` 非空就擋。D95 第一輪把
// `CHANGELOG.md` 搬進 `collector/`（為了讓 collector/ 自足）之後，**「宣告新版本」
// 這個動作本身就是在改 `collector/`** ⇒ 一顆只改宣告的 commit 也被算成「源碼又動過」
// ⇒ **這一站擋自己**，push／deploy／verify／release-record 四站一次都沒跑過。
// 兩件事都對，疊起來變成死結——衝突在**範圍重疊**，不在任何一方做錯。
//
// ⇒ 改問同一件事實：`daemon-version.py` 每次戳版都會把「當下的原始碼指紋」記進帳本。
//   帳本裡這一版的指紋 == 現在算出來的 ⇒ 成品確實是照這份源碼打的。
//   宣告那一步改到的檔案，戳版當下就已經算進指紋 ⇒ **結構上不可能擋自己**。
//   判法與由來全文見 daemon-freshness.mjs 檔頭。
{ id: 'daemon-source-check', title: '核對 changelog 宣告的那一版，成品就是照這份源碼打的（比指紋，不查歷史）', mutates: false, async run() {
  const r = requireFreshDaemonSource({
    repo: REPO_ROOT,
    // 🔴 2026-08-18（D95 第二輪）：這裡本來是 `CHANGELOG_REL`（docs-site，雲端引擎那條線）。
    //   D95 第一輪搬家之後那份檔案裡再也沒有版本段 ⇒ 這一站雖然**會擋**（unknown 一律停，
    //   這點是對的），但擋下來的理由是錯的（會叫人去戳一個根本不在那份檔裡的版號）。
    //   訊息指錯地方比不指還糟——改讀 daemon 自己那份。
    //   現在這個值還多一個作用：與源碼樹自己認定的路徑**對帳**，不一致就判 unknown。
    changelogRel: DAEMON_CHANGELOG_REL,
    // 留痕要看得出是哪個目標觸發的（InkStoneCo#48）。
    targetName: TARGET_NAME,
    // selftest（不推、不部署、沒有任何人會拿到東西）才允許指紋對不上仍跑完——
    // 而且照樣把差異印出來、照樣留痕（標「明知故犯放行」）。理由見 daemon-freshness.mjs。
    allowDirty: !!T.allowDirtySource,
  });
  return { status: 'done', detail: [
    `${r.version} 的成品就是照現在這份源碼打的 ✓` +
    (r.hasDraft ? '（changelog 另有「下一版（未發佈）」草稿，尚未戳版，不影響本項判定）' : ''),
    ...r.checks.map((c) => `✅ ${c.name}　—　${c.fact}`),
  ] };
}},

// ── 2. fetch-artifacts：**向 Arcrun 取貨**（這一站不編任何東西）────────────────
//
// 🔴 2026-08-15 改名（leo：「install 會抓到同意 build 的東西」「刪掉出貨的 build 流程」）：
//   這一站的 id 以前叫 `build`，而它**早就不 build 了**——檔頭、站表、輸出訊息都這樣寫，
//   只有名字還留在原地。那正是今晚一路咬人的病：**名字說一件事，實際做另一件**。
//   下一個人（或 AI）看到 `id: build` 就會以為出貨線還在編東西，然後照那個誤解做決策
//   ——2026-08-14 的災情就是有人照著一段描述不存在機制的註解做決策。
//   ⇒ 名字改成它真正在做的事：**取貨**。要編請去 Arcrun（唯一產地，D91）。
//
// 舊的 `build` 這個 id 在 `installer/ship-report.json` 的歷史紀錄裡照舊留著——
// 那是**當時真的叫什麼**，改它才是竄改歷史。報告工具靠逐筆比對 id，不靠寫死名字。
//
// （2026-08-11，D65 三次補述訂正，arcrun-rag#73 缺③：拆掉「提升」，每個目標都重新取貨、
//   版本號由內容算不由人宣告——見 (b) 的 preflight 註解與 source-pin.mjs。）
{ id: 'fetch-artifacts', title: '向 Arcrun 取用編好的零件（這一站不編任何東西）', mutates: true, async run() {
  shLive('node', [join(import.meta.dirname, 'build-bundles.mjs'), '--out', ctx.bundlesDir],
    // ARTIFACT_ALLOW_DIRTY_SOURCE：把登錄簿的 `allowDirtySource` 一路傳到 build-bundles 的
    // 新鮮度閘（Arcrun#93）。不傳的話 selftest（唯一允許髒工作區的目標）會在 preflight
    // 過關、卻在這裡被自己人擋下——同一份判準在兩支腳本各有一套，正是漂移的起點。
    REPO_ROOT, { ARCRUN_REPO_ROOT: ctx.arcrunRepo, ARTIFACT_ALLOW_DIRTY_SOURCE: T.allowDirtySource ? '1' : '' });
  // 🔴 2026-08-15（D91）：這裡以前還跑一支 `build-ui-bundle.mjs`——它讀 Arcrun 的
  //   console-ui/public，**在這台機器上把 portal 前端拼裝成一顆 worker**。
  //   那是這條線上最後一個「在 arcrun-rag 產生成品」的地方，已經搬回 Arcrun
  //   （`scripts/build-ui-worker.mjs`），現在 portal 前端跟其他零件走同一條複製路徑。
  //   順帶解掉一個舊坑：以前「只跑 build-bundles 的話 UI 永遠送不出去」（2026-08-07 實撞）。
  return { status: 'done', detail: ['公庫已全部從 Arcrun 官方成品複製過來（含 portal 前端）'] };
}},

// ── 2.1 no-local-build：**每一個位元組都要說得出是 Arcrun 哪一顆 commit 編的**（D91）──
//
// leo 2026-08-14：「今天開始出貨一律不准在 arcrun rag 或任何別的地方 build，
//   這就是 arcrun 的專屬工作。你告訴我要把 cypher 搬到 arcrun，我說好，
//   **結果搞到現在還用違反的方式**。」
//
// 重點是後半句：規則早就講定，而實作至今仍在違反——**因為沒有任何東西在檢查**。
// 這一站就是那個檢查。它驗來源（位元組 vs Arcrun 官方成品）而不是驗寫法，
// 所以不管誰用什麼新方法在這裡產生零件，都會被同一句話擋下。範圍與誤傷邊界見
// no-local-build-gate.mjs 檔頭。mutates:false ⇒ 預演也會跑。
{ id: 'no-local-build', title: '確認這些零件不是我們自己編的（D91：成品只有一個產地）', mutates: false, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return { status: 'skip', detail: ['manifest.json 還不存在'] };
  const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
  const artifactManifest = readArtifactManifest(ctx.arcrunRepo);
  const r = requireNoLocalBuild({
    bundlesDir: ctx.bundlesDir,
    manifest,
    artifactManifest,
    arcrunRepo: ctx.arcrunRepo,
    scriptsDir: import.meta.dirname,
  });
  return {
    status: 'done',
    detail: [`${r.checked} 顆逐位元等於 Arcrun 官方成品（Arcrun@${String(artifactManifest.repo_head || '').slice(0, 8)}）`],
  };
}},

// ── 2.2 parity：**這個 bundle 有哪幾顆，必須恰好等於唯一真相源**───────────────
//
// 🔴 leo 2026-08-09（arcrun-rag#27），這一步就是為了他那句話存在的：
//   「我的現實是 prod 已經有人在用了，在你還沒進行任何修改前，stage = prod，
//     至少一一對應。結果你重做，那你重做過程可能有問題，就造成 prod 新問題。」
//   「如果都相同，我測試一次安裝，就發現 5 顆變 24 顆。**如果是複製，為什麼不一致？**」
//
// 08-09 實測：prod core = 5 顆、stage core = 24 顆，而 prod 宣告自己複製自
// stage@ab4ef01——那個 commit 當時就是 24 顆。兩邊各有一份人維護的清單
// （本檔 BUILD_MANAGED ／ build-bundles.mjs CORE），只有 prod 那條會被套用，
// 於是「提升＝複製」是假的，而 leo 在 stage 驗的東西不是封測者會拿到的東西。
//
// ⇒ 兩條路徑現在共用 `bundle-components.mjs`，這一步再用**同一份清單**夾住結果：
//   `manifest.core` 的名字集合必須恰好等於它——多一顆（棘輪殘留）、少一顆（打包失敗
//   被靜默吞掉）都當場失敗。**一一對應從此不靠人記得，而是每次出貨都被機械重新證明一次。**
//
// mutates:false ⇒ 預演也會跑，不必真的出貨就能看出兩邊對不對得上。
{ id: 'parity', title: '核對 bundle 內容＝唯一真相源（stage 與 prod 因此必然一一對應）', mutates: false, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return { status: 'skip', detail: ['manifest.json 還不存在'] };
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  // 2026-08-15（Arcrun#125）：現在夾兩份名單，因為它們壞掉的樣子不同——
  //   `core`（首裝）少一顆 ⇒ 裝完不能用；多一顆 ⇒ 使用者白付 worker 成本
  //   `library`（公庫）少一顆 ⇒ 那顆永遠載不到（懶載變空話）；多一顆 ⇒ 棘輪殘留
  const plan = resolveBundlePlan({ arcrunRepo: ctx.arcrunRepo, repoRoot: REPO_ROOT });
  const d = diffAgainstPlan(m, plan);
  if (!d.ok) {
    throw new Error(
      `bundle 內容與這一版算出來的計畫對不上，拒絕出貨：\n` +
      (d.coreMissing.length ? `       首裝少了 ${d.coreMissing.length} 顆：${d.coreMissing.join('、')}\n` +
        `         → 裝出來的實例會缺零件。2026-08-14 就是少了解憑證那顆 ⇒ 每支工作流 500\n` : '') +
      (d.coreExtra.length ? `       首裝多了 ${d.coreExtra.length} 顆：${d.coreExtra.join('、')}\n` +
        `         → 每個使用者要為它付 worker 成本，而沒有任何工作流證明它非裝不可\n` : '') +
      (d.libMissing.length ? `       公庫少了 ${d.libMissing.length} 顆：${d.libMissing.join('、')}\n` +
        `         → 「用到才下載」對這幾顆是空話：bundle 裡根本沒有貨\n` : '') +
      (d.libExtra.length ? `       公庫多了 ${d.libExtra.length} 顆：${d.libExtra.join('、')}\n` +
        `         → 清單外的東西混進 bundle。這正是 stage 變成 24 顆的病（棘輪只加不減）\n` : '') +
      `     → 兩份名單都是算出來的：公庫＝Arcrun 這一版編了什麼；首裝＝工作流證明需要什麼。\n` +
      `       要改，去改那兩個來源，不要在這裡放行例外。`);
  }
  // 每顆的產物都要真的在磁碟上：manifest 說有、檔案卻不在＝安裝時 404。
  const ghosts = (m.library || []).filter((c) => c && c.main_file && !existsSync(join(ctx.bundlesDir, c.main_file)));
  if (ghosts.length) {
    throw new Error(
      `manifest 宣告有這幾顆，但產物檔案不存在（安裝器會抓到 404）：\n` +
      ghosts.map((c) => `       • ${c.name}（${c.main_file}）`).join('\n'));
  }
  for (const w of plan.warnings) console.log(`     ⚠️ ${w}`);
  return { status: 'done', detail: [
    `公庫 ${plan.library.length} 顆、首裝 ${plan.firstInstall.length} 顆、懶載 ${plan.lazy.length} 顆，逐項相符`,
    `首裝：${plan.firstInstall.join('、')}`,
    `（兩份名單都由同一份算式夾住 ⇒ stage 與 prod 結構上不可能再分岔）`,
  ] };
}},

// ── 2.5 notes：使用者更新畫面上那一行，由 changelog 導出，不由人當場捏 ────────
{ id: 'notes', title: '產生更新畫面那一行（來源＝changelog）', mutates: true, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  if (!m.daemon || !m.daemon.version) return { status: 'skip', detail: ['這個 bundle 沒有 daemon'] };
  const line = notesFromChangelog(REPO_ROOT, m.daemon.version);
  if (!line) {
    throw new Error(
      // 指錯地方比不指還糟：changelogRelFor 用**版本線**分（DAEMON_LINE），不是用有沒有 `v`。
      `changelog 沒有 ${m.daemon.version} 這一版（該補在 ${changelogRelFor(REPO_ROOT, m.daemon.version)}）。\n` +
      `     使用者按「檢查更新」會看不到這版改了什麼 ⇒ 先寫 changelog 再出貨。`);
  }
  const problems = checkNotes(line);
  if (problems.length) throw new Error('更新畫面那一行過不了閘：\n' + problems.map((p) => `       • ${p}`).join('\n'));
  if (m.daemon.notes === line) return { status: 'skip', detail: [`已是最新：${line}`] };
  const before = m.daemon.notes;
  m.daemon = { ...m.daemon, notes: line };
  writeFileSync(mPath, JSON.stringify(m, null, 1) + '\n');
  return { status: 'done', detail: [
    `舊：${before ? before.slice(0, 60) + (before.length > 60 ? `…（共 ${before.length} 字）` : '') : '(無)'}`,
    `新：${line}（${line.length} 字）`,
  ] };
}},

// ── 3. version：**每個目標都算版本＋過機械閘**（2026-08-11，D65 三次補述訂正，
//   arcrun-rag#73 缺③；拆掉「核對指紋、繼承版本」的提升分支）。
//   內容變了版本一定變；沒變就一定不變；有出入＝當場失敗，不印警告繼續——這點沒變。
//
// 🔴 唯一的關鍵差異：`sharedState: true`（見 release.mjs 檔頭「跨目標共用版本狀態」）。
//   stage／prod 各自重打、各自是獨立的 bundle repo，若各自比自己的版本史算 patch，
//   **同一份內容在兩邊會算出不同號碼**（leo：「如果是複製，為什麼不一致？」——
//   現在不是複製了，但「同一份內容要有同一個號碼」這句話沒有變）。
//   sharedState 把「前一版是什麼」的比較基準搬到主 repo 的 `release-state.json`，
//   只認內容指紋，不認是哪個 bundle repo——這樣才會拿到跟 build 步驟一樣的對稱。
{ id: 'version', title: '算版本並過機械閘（內容一變版本一定變；跨目標共用同一個號碼）', mutates: true, async run() {
  const shared = T.bundles.remote !== 'local-selftest'; // selftest 本機臨時目標，不進共用版本狀態
  const { release } = syncManifest(ctx.bundlesDir, { repoRoot: REPO_ROOT, quiet: true, sharedState: shared });
  const problems = verifyManifest(ctx.bundlesDir, { repoRoot: REPO_ROOT });
  if (problems.length) throw new Error('manifest 機械閘不過：\n' + problems.map((p) => `       • ${p}`).join('\n'));
  const m = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8'));
  ctx.release = release;
  ctx.daemonVersion = m.daemon && m.daemon.version;
  ctx.built = m.built;   // 使用者在 /api/latest 看到的建置日；verify 會拿它跟線上對
  ctx.sourceCommit = m.source; // D65 二次補述：出貨報告要能比對「兩個理貨員拿的是不是同一張訂單」
  const bumped = ctx.releaseBefore && ctx.releaseBefore !== release;
  return { status: 'done', detail: [
    bumped ? `版本 ${ctx.releaseBefore} → ${release}（內容有變 ⇒ patch +1，${shared ? '跨目標共用狀態' : '本機獨立計數'}）`
           : `版本 ${release}（內容與上一版一致 ⇒ 不動）`,
    `${m.core.length} 顆｜built ${m.built}｜source ${m.source}｜daemon ${ctx.daemonVersion}`,
  ] };
}},

// ── 3.5 docs-changelog：這一版的更新說明必須已經寫進 docs，不然就中止 ─────────
// 🔴 leo 2026-08-09（總管轉交）：「佈建腳本還要包含文件，新版推出要有文件寫到 docs
//   說明這一版的更新，你不列入就沒寫，兩邊脫鉤。」「刻意不寫更新說明時，佈建要
//   中止或明確報出來，不能安靜跳過。」
// 沿用既有的 daemon changelog 機制（`headlinesFor`／`notesFromChangelog`，
// daemon-notes.mjs）——那支本來就是「用版本號當 key 去 changelog.md 找一段」，
// 換成拿 bundle 的 release 版本號去問一樣的問題，不必另建一套格式或另一個檔案。
//
// 🔴 D65 補述（leo 2026-08-11，arcrun-rag#73 二次拍板，訂正前一版註解）：
//   這裡原本寫「提升目標（prod）不重算版本、沿用 stage 已過的版本，不必也不能重跑」，
//   而 leo 直接點出這正是「兩個理貨員拿的不是同一張清單」——
//   「Stage 先擠一次確定都是對的，再叫 prod 來再擠一次⋯⋯拿着都是 10 件的清單」
//   「整條管線唯一一道『說明文件寫了沒』的閘，prod 由設計跳過」。
//   即使版本號是繼承來的，**這一項本身也要被問一次**：changelog 這個檔在 stage
//   蓋章之後、prod 提升之前仍可能被改動（例如那一段被誤刪），「stage 驗過」不等於
//   「prod 出貨這一刻它還在」。所以拿掉 promoteFrom 的提早 return——兩個目標
//   跑一模一樣的檢查，差異只在於 ctx.release 從哪來（重打自己算 vs 提升繼承），
//   不在於「這一項有沒有被問」。
{ id: 'docs-changelog', title: '確認這版已經寫進說明文件（缺了就中止，不安靜跳過）', mutates: false, async run() {
  const line = notesFromChangelog(REPO_ROOT, ctx.release);
  if (!line) {
    throw new Error(
      `說明文件裡沒有 ${ctx.release} 這一版（${CHANGELOG_REL}）。\n` +
      `     這版內容已經打包完成，但文件沒有跟上——先在 changelog 加一段\n` +
      `     \`## ${ctx.release}（${new Date().toISOString().slice(0, 10)}）\`，` +
      `用一兩句使用者看得懂的話描述這版改了什麼，再重跑本指令。\n` +
      `     （leo 2026-08-09：「你不列入就沒寫，兩邊脫鉤」——這道閘就是不准兩邊脫鉤）`);
  }
  return { status: 'done', detail: [`${CHANGELOG_REL} 有 ${ctx.release} 這一版：${line}`] };
}},

// ── 3.7 readme：bundle repo 的 README 由零件清單算出來，不留會過期的手寫數字 ──
//
// 🔴 leo 2026-08-10（總管實測發現）：`youlinhsieh/arcrun-rag-bundles` 的 README
//   還寫著「25 workers: tier1 components + tier2 engines」，而**同一個 repo 的
//   manifest.json** 老實宣告 5 顆（release 1.4.30）。兩份數字互相矛盾，而且已經
//   矛盾超過一版都沒人發現——因為出貨管線從沒有任何一步碰過 README.md，
//   它是很久以前手打的、之後再也沒有機制核對它還準不準。
//
//   這跟 `bundle-components.mjs` 檔頭記的那次「兩份人維護的零件清單」是同一種病，
//   差別是這次沒有任何機械閘夾住它，連「漂移了」這件事本身都不會被發現。
//   ⇒ 解法跟那次一樣：README 由這一版真的算出來的名單產生，
//     出貨管線每次都重寫這份檔案——內容跟零件清單不同步，在結構上不再可能發生。
{ id: 'readme', title: 'bundle repo 的 README 由零件清單算出來（不留會過期的手寫數字）', mutates: true, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return { status: 'skip', detail: ['manifest.json 還不存在（首次播種前）'] };
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  const text = renderBundlesReadme({
    release: m.release, source: m.source, built: m.built,
    hasDaemon: !!(m.daemon && m.daemon.version),
    library: (m.library || []).map((c) => c.name),
    firstInstall: (m.core || []).map((c) => c.name),
  });
  const rPath = join(ctx.bundlesDir, 'README.md');
  const before = existsSync(rPath) ? readFileSync(rPath, 'utf8') : null;
  if (before === text) return { status: 'skip', detail: ['README 已是最新（零件清單與版本都沒變）'] };
  writeFileSync(rPath, text);
  return { status: 'done', detail: [
    `README 重寫：公庫 ${(m.library || []).length} 顆／首裝 ${(m.core || []).length} 顆｜release ${m.release}`,
    before === null ? '（這個 bundle repo 原本沒有 README，首次產生）' : '（取代舊版手寫內容）',
  ] };
}},

// ── 4. commit ────────────────────────────────────────────────────────────
{ id: 'commit', title: '把產物寫進 bundle repo 的版控', mutates: true, async run() {
  // 🔴 2026-08-15：**在寫進版控的那一刻再驗一次來源**（leo①「install 會抓到同意 build 的東西」）。
  //   為什麼「no-local-build 站驗過就夠了」不成立：那一站與這一站之間還隔著
  //   notes／version／readme／daemon-sync 四站，它們都會寫進 bundle 工作區。
  //   今天它們不碰零件檔，但**「今天不碰」是觀察，不是機制**——而使用者拿到的是這裡
  //   commit 進去的那一份，不是那一站當時看到的那一份。
  //   ⇒ 閘要貼著「真的送出去的東西」，不是貼著中途某個快照。
  //   成本＝重算 23 顆的雜湊（毫秒級），換掉一整類「中途被動過而沒人知道」。
  {
    const manifest = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8'));
    const r = requireNoLocalBuild({
      bundlesDir: ctx.bundlesDir,
      manifest,
      artifactManifest: readArtifactManifest(ctx.arcrunRepo),
      arcrunRepo: ctx.arcrunRepo,
      scriptsDir: import.meta.dirname,
    });
    console.log(`     ✔ 入庫前複驗：${r.checked} 顆仍逐位元等於 Arcrun 官方成品`);
  }
  if (!sh('git', ['status', '--porcelain'], ctx.bundlesDir)) {
    return { status: 'skip', detail: ['工作區乾淨——這一版的產物已經在版控裡了'] };
  }
  sh('git', ['add', '-A'], ctx.bundlesDir);
  // 🔴 08-07 實撞：整包蓋掉 prod bundle repo，把 prod 才有的 daemon/（20 個安裝檔）
  //    與 README 砍光，封測者下載不到 daemon。刪檔要人明確放行。
  const deleted = sh('git', ['diff', '--cached', '--diff-filter=D', '--name-only'], ctx.bundlesDir);
  if (deleted && !ALLOW_DELETIONS) {
    throw new Error(
      `這次會**刪掉** bundle repo 裡的檔案，拒絕出貨（08-07 就是這樣砍掉 prod 的 daemon/）：\n` +
      deleted.split('\n').slice(0, 15).map((l) => `       - ${l}`).join('\n') +
      `\n     → 真的要刪就加 --allow-deletions，並在 commit 說明理由`);
  }
  sh('git', ['-c', 'user.email=ship@local', '-c', 'user.name=ship', 'commit', '-q', '-m',
    `ship ${ctx.release}：${JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).source || 'unknown source'}`],
    ctx.bundlesDir);
  return { status: 'done', detail: [`commit ${sh('git', ['rev-parse', '--short', 'HEAD'], ctx.bundlesDir)}`] };
}},

// ── 5. push ──────────────────────────────────────────────────────────────
{ id: 'push', title: '推上 bundle repo', mutates: true, async run() {
  ctx.headSha = sh('git', ['rev-parse', 'HEAD'], ctx.bundlesDir);
  if (T.bundles.remote === 'local-selftest') {
    return { status: 'skip', detail: ['selftest 目標不推遠端（登錄簿宣告）'] };
  }
  const ahead = sh('git', ['rev-list', '--count', `origin/${T.bundles.branch}..HEAD`], ctx.bundlesDir);
  if (Number(ahead) === 0) return { status: 'skip', detail: ['已與遠端同步，沒有要推的'] };
  // 🔴 人閘（InkStoneCo#56）：產物倉庫的分支就是 `main`（登錄簿寫死）⇒ 這一行每次出貨
  //   都在推 main，而殼層那道閘看不見它。這裡不做例外——**declared 的目的地也是目的地**，
  //   總管照樣要為「這一次覆寫哪個 repo 的 main」按一次閘（preflight 會先把清單列出來）。
  assertPushAllowed({
    args: ['push', 'origin', T.bundles.branch], cwd: ctx.bundlesDir,
    remoteUrl: T.bundles.remote, who: `ship.mjs／推產物倉庫（${TARGET_NAME}）`,
    grants: ctx.mainPushGrants,
  });
  // 大 zip 推 GitHub 會 remote hung up（wiki agent-memory:805）⇒ 一律帶 postBuffer
  sh('git', ['-c', 'http.postBuffer=157286400', 'push', 'origin', T.bundles.branch], ctx.bundlesDir);
  ctx.pushed = true;
  const detail = [`推了 ${ahead} 個 commit → ${normRemote(T.bundles.remote)}（HEAD ${ctx.headSha.slice(0, 7)}）`];

  // 🔴 2026-08-09（arcrun-rag#27）留痕：這一行 `git push` 是 execFileSync 開的子行程，
  //   Claude Code 的 github-contact-guard.sh 只看得到「Bash 工具呼叫本身的指令字串」
  //   （這次是 `node ship.mjs --target prod --confirm`），完全看不到這個子行程——
  //   所以 hook 那份 log 永遠不會有這一筆，不管 hook 的正則怎麼改都一樣。
  //   只有在**真的碰 GitHub 的這一行自己**留痕，才補得起來。
  if (T.bundles.remote && /github\.com/i.test(T.bundles.remote)) {
    try {
      logGithubContact(INKSTONE_ROOT, ctx.armMission || '(mission 未知)',
        `git push origin ${T.bundles.branch}（${ctx.bundlesDir} → ${normRemote(T.bundles.remote)}）` +
        `推了 ${ahead} 個 commit，HEAD→${ctx.headSha.slice(0, 7)}`);
      detail.push('✅ 已寫入 github-contact-log.md（ship.mjs 自己留痕）');
    } catch (e) {
      // push 已經發生、不可逆——留痕失敗不回頭撤銷，但要吵到讓人看見，不能安靜吞掉。
      console.error(`❌❌❌ push 成功了，但寫入 github-contact-log.md 失敗：${e.message}`);
      detail.push(`❌ 留痕失敗（push 已發生，稽核缺口仍在）：${e.message}`);
    }
  }
  return { status: 'done', detail };
}},

// ── 6. pin：換釘子。**寫進所有真身**，不靠人記得改哪幾處 ────────────────────
// 🔴 08-13（arcrun-rag#95）：這裡順便寫一根「安裝器原始碼指紋」的釘子——
//   deploy 站的跳過判準原本只認這裡寫的 BUNDLE_BASE／BUNDLE_BUILT 有沒有動，
//   對「安裝器自己的邏輯改了，但沒動 bundle 釘子」完全瞎眼（連兩次跨 stage／prod
//   實撞：改了 worker.js → 併 main → 出貨 → deploy 站印「跳過」→ 線上原封不動）。
//   INSTALLER_SRC_SHA 一變，下面 `toml !== before` 就成立 ⇒ 沿用既有的
//   「toml 變了＝pinChanged＝deploy 站不准跳過」機制，不必另開一條比對路。
{ id: 'pin', title: '換安裝器釘子（真身是 wrangler.toml 的 vars；含安裝器原始碼指紋）', mutates: true, async run() {
  if (!T.pin || !T.installer) return { status: 'skip', detail: ['本目標沒有安裝器（登錄簿宣告）'] };
  ctx.headSha = ctx.headSha || sh('git', ['rev-parse', 'HEAD'], ctx.bundlesDir);
  const sha = T.pin.shaLen === 40 ? ctx.headSha : ctx.headSha.slice(0, T.pin.shaLen);
  ctx.pinUrl = T.pin.template.replace('{sha7}', ctx.headSha.slice(0, 7)).replace('{sha40}', ctx.headSha);
  const built = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).built;

  const jsPath = join(REPO_ROOT, T.installer.cwd, 'worker.js');
  // 🔴 先確認 migration 帶齊了才算指紋——少一支就當場中止（見 assertMigrationsComplete 檔頭）
  const arcrunRoot = process.env.ARCRUN_REPO_ROOT
    || [join(REPO_ROOT, '..', '..', 'matrix', 'arcrun'), join(REPO_ROOT, '..', 'Arcrun'), join(REPO_ROOT, '..', 'arcrun')]
         .find((c) => existsSync(join(c, 'kbdb', 'migrations'))) || '';
  const migLines = arcrunRoot
    ? assertMigrationsComplete(join(REPO_ROOT, T.installer.cwd), arcrunRoot)
    : ['⚠️ 找不到 Arcrun repo，這一趟沒能複驗 migration 帶齊了沒（設 ARCRUN_REPO_ROOT 可複驗）'];
  ctx.installerSrcHash = installerSourceHash(jsPath);

  const tomlPath = join(REPO_ROOT, T.installer.cwd, T.installer.config);
  let toml = readFileSync(tomlPath, 'utf8');
  const before = toml;
  toml = setTomlVar(toml, T.installer.varsSection, 'BUNDLE_BASE', ctx.pinUrl);
  toml = setTomlVar(toml, T.installer.varsSection, 'BUNDLE_BUILT', built);
  toml = setTomlVar(toml, T.installer.varsSection, 'INSTALLER_SRC_SHA', ctx.installerSrcHash);

  // 🔴 08-07 白部署一次的病：釘子有**兩份手抄本**（wrangler.toml [vars] 與 worker.js 常數），
  //    只改一份就是「改了但沒生效」。這裡兩份一起寫 ⇒ 結構上不可能只改一半。
  let js = readFileSync(jsPath, 'utf8');
  const jsBefore = js;
  if (T.installer.mirrorConstants) {
    js = js.replace(/(const DEFAULT_BUNDLE_BASE = ')[^']*(')/, `$1${ctx.pinUrl}$2`);
    js = js.replace(/(const BUNDLE_BUILT = ')[^']*(')/, `$1${built}$2`);
  }

  if (toml === before && js === jsBefore) {
    // 🔴 migration 覆蓋率那一行**跳過時也要印**：閘在上面已經跑過（帶不齊會 throw），
    //   但如果只在「有動」的那一趟才顯示，盤點的人會以為這一趟沒驗——
    //   而「只在單邊執行的站是共同盲區」正是 2026-08-25 這整件事的形狀之一。
    return { status: 'skip', detail: [`釘子與安裝器原始碼都沒動（built ${built}，src ${ctx.installerSrcHash.slice(0, 12)}）`, ...migLines] };
  }
  writeFileSync(tomlPath, toml);
  if (js !== jsBefore) writeFileSync(jsPath, js);
  ctx.pinChanged = true;
  return { status: 'done', detail: [
    `[${T.installer.varsSection}] BUNDLE_BASE = ${ctx.pinUrl}`,
    `[${T.installer.varsSection}] BUNDLE_BUILT = ${built}`,
    `[${T.installer.varsSection}] INSTALLER_SRC_SHA = ${ctx.installerSrcHash.slice(0, 12)}…`,
    T.installer.mirrorConstants ? 'worker.js 的兩個常數同步寫入（不留第二份手抄本）' : 'worker.js 常數不鏡射（本目標靠 vars 覆蓋）',
    ...migLines,
  ] };
}},

// ── 7. deploy：帳號來自登錄簿，不吃環境裡飄來的 CLOUDFLARE_ACCOUNT_ID ────────
// 🔴 08-13（arcrun-rag#95）：跳過判準以前只認 release／pin，對安裝器自己的原始碼瞎眼
//   ——連兩次跨 stage／prod 實撞：只改 worker.js、bundle 沒動，這裡照樣印「跳過」，
//   線上頁面原封不動。`ctx.pinChanged` 現在已經因為 pin 站寫入 INSTALLER_SRC_SHA
//   而涵蓋這種情況（belt）；這裡再多比一次線上實際回報的 installer_sha 當第二道
//   （suspenders）——就算哪天 pin 站的邏輯被改壞，這裡仍然攔得住。
{ id: 'deploy', title: '部署安裝器（帳號由登錄簿釘死）', mutates: true, async run() {
  if (!T.installer) return { status: 'skip', detail: ['本目標沒有安裝器（登錄簿宣告）'] };
  ctx.installerSrcHash = ctx.installerSrcHash
    || installerSourceHash(join(REPO_ROOT, T.installer.cwd, 'worker.js')); // --verify-only 等模式沒跑過 pin 站
  const srcOk = ctx.liveBefore && ctx.liveBefore.installerSrcHash === ctx.installerSrcHash;
  const liveOk = ctx.liveBefore
    && ctx.liveBefore.release === ctx.release
    && ctx.headSha && String(ctx.liveBefore.pin || '').startsWith(ctx.headSha.slice(0, 7))
    && srcOk;
  if (!ctx.pinChanged && liveOk) {
    return { status: 'skip', detail: [`線上已是 ${ctx.release}／pin ${ctx.liveBefore.pin}／安裝器原始碼 ${ctx.installerSrcHash.slice(0, 12)} 未變，且釘子沒動 ⇒ 不重複部署`] };
  }
  // 走到這裡＝要部署。兩種情況都會落到這裡：pin 站已經宣告釘子動了（ctx.pinChanged），
  // 或者 pin 站沒動但這裡比對出線上安裝器原始碼其實對不上（srcOk 為 false）
  // ——寧可多部署一次，也不要讓「該做的事沒做」悄悄過關。
  const args = ['wrangler', 'deploy', '--config', T.installer.config];
  if (T.installer.wranglerEnv) args.push('--env', T.installer.wranglerEnv);
  // 🔴 「打錯實例」的第二個入口：ambient CLOUDFLARE_ACCOUNT_ID。這裡一律用登錄簿的值覆蓋。
  shLive('npx', args, join(REPO_ROOT, T.installer.cwd), { CLOUDFLARE_ACCOUNT_ID: T.installer.accountId });
  return { status: 'done', detail: [`帳號 ${T.installer.accountId}（${T.installer.accountNote}）`,
    `env ${T.installer.wranglerEnv || '(prod 預設環境)'}`] };
}},

// ── 7.5 docsSite：文件站 stage 版（s2，2026-08-09）。目標沒宣告 docsSite 就跳過 ──
// 🔴 為什麼要收進這支腳本：docs-site 之前完全沒有自動化部署路徑（連 prod 都是人手動
// `wrangler deploy`），跟這支腳本本來要解決的病是同一種——「要記得手動做」＝會漏。
// 查過 `git log --all -- installer/scripts/ship.mjs` 與 `-S"docsSite"`：docs-site
// 從未被接進這支管線過，這是新增能力，不是重修一個已經被哪個分支修過的舊 bug。
//
// 🔴 2026-08-09（arcrun-rag#27）這一步被改嚴了三處，因為 08-09 的 prod 三處全中：
//   ① 它只有 stage 走得到（prod 的 docsSite 是 null ⇒ 安靜跳過）→ 已由不變式 Ⅴ 根治
//   ② 它只問 `GET /docs/ → 200`——**一個內容停在三天前的站也是 200**。
//      leo 當天看到的正是這個：版本說明最新 v0.18.24，封測者拿到的是 v0.18.25。
//   ③ 它假設每個目標都有 `--env`（prod 走預設環境，沒有 env 名）
{ id: 'docs', title: '建＋部署說明文件站（並驗它真的是這份原始碼建的）', mutates: true, async run() {
  // 走到這裡還沒有 docsSite 的，只剩沒有安裝器的目標（selftest）——不面對任何人。
  if (!T.docsSite) return { status: 'skip', detail: ['本目標沒有安裝器也沒有文件站（登錄簿宣告）'] };
  const D = T.docsSite;
  const cwd = join(REPO_ROOT, D.cwd);

  // ── ① 先問「這一版寫了嗎」，再花時間建站 ──────────────────────────────
  // 使用者手上有兩個號碼：portal 版本卡的 release、小幫手更新畫面的 daemon 版本。
  // 他拿哪一個來查都要查得到 ⇒ 兩個都要在 changelog 原稿裡有自己的一段。
  // （3.5 那道閘只擋非提升目標且只看 release；提升目標＝prod 完全不跑它，
  //   而 changelog 是本 repo 的可變檔案，stage 驗過之後還是可能被改。D65：這道閘不准跳。）
  //
  // 🔴 2026-08-17（leo「這個頁面刪除」，inkstone/arcrun-rag#41）：這一問**留著，但意思變了**。
  //   以前它問的是「文件站那一頁寫了沒」；那一頁刪掉之後，它問的是
  //   **「等一下 `release-record` 站要拿去當版本發佈內文的那一段，寫了沒」**。
  //   兩份原稿（repo 根的 `CHANGELOG.md`／`collector/CHANGELOG.md`）都還在，
  //   所以這道閘照舊有效——而且提早問：與其建完站、部署完才在 release-record 中止，
  //   不如在花時間之前就擋下。
  const want = [ctx.release, ctx.daemonVersion].filter(Boolean);
  const missingLocal = want.filter((v) => !notesFromChangelog(REPO_ROOT, v));
  if (missingLocal.length) {
    throw new Error(
      `說明文件裡沒有 ${missingLocal.map((v) => `${v}（該補在 ${changelogRelFor(REPO_ROOT, v)}）`).join('／')}，拒絕出貨。\n` +
      `     這版的東西已經打包好了，但使用者點「完整發佈紀錄」會看到空白。\n` +
      `     → 先補一段 \`## ${missingLocal[0]}（${new Date().toISOString().slice(0, 10)}）\`，` +
      `用使用者看得懂的話寫，再重跑本指令。`);
  }

  // ── ② 建 → 鏡射 → 部署 ────────────────────────────────────────────────
  shLive('npm', ['run', 'build'], cwd);
  // dist/ 是 astro 的建置輸出；wrangler.toml 的 [assets] directory 指 ./deploy（含 docs/
  // 子目錄，對齊 astro base:'/docs'）——用 rsync --delete 鏡射，不留舊檔殘骸。
  shLive('rsync', ['-a', '--delete', join(cwd, 'dist') + '/', join(cwd, 'deploy', 'docs') + '/'], cwd);
  const args = ['wrangler', 'deploy', '--config', D.config];
  if (D.wranglerEnv) args.push('--env', D.wranglerEnv);   // prod 走預設環境，沒有 env 名
  shLive('npx', args, cwd, { CLOUDFLARE_ACCOUNT_ID: D.accountId });

  // ── ③ 部署指令沒報錯 ≠ 線上那顆真的是這份原始碼 ⇒ 去線上抓一個只有這份碼會產生的東西 ──
  //
  // 🔴 2026-08-17（leo「這個頁面刪除」，inkstone/arcrun-rag#41）：這裡以前查的是
  //   **「版本說明頁上有沒有這兩個版號」**。那一頁已經刪掉了（改成一條轉去 GitHub
  //   版本發佈的轉址），所以查版號這件事在文件站上**沒有東西可查**。
  //
  //   ⚠️ **這是一次真的降級，不要當成沒事**：舊斷言抓得到「站的內容停在上一版」，
  //     新斷言只抓得到「站不是這份原始碼建的」。差額由 `release-record` 站承接
  //     ——每條版本線都要有一筆版本發佈、內文抽不到就中止——那一站有牙齒且更早跑。
  if (!D.verifyUrl) {
    throw new Error(
      `登錄簿的 ${TARGET_NAME}.docsSite 沒給 verifyUrl ⇒ 沒辦法證明這次部署真的發生了。\n` +
      `     「部署指令沒報錯」不是驗收（CRITICAL-PATH 使用規則 6）。`);
  }
  const r = await checkDocsLive({ docsBase: D.verifyUrl });
  if (r.fails.length) {
    throw new Error('文件站部署了，但線上那顆不是這份原始碼建的：\n'
      + r.fails.map((f) => `       • ${f}`).join('\n')
      + '\n' + r.lines.map((l) => `       ｜${l}`).join('\n')
      + '\n     照這個順序查：① `npm run build` 有沒有產出 `dist/help/changelog/index.html`\n'
      + '       ② rsync 有沒有把 dist/ 鏡射進 deploy/docs/　③ wrangler 是不是部署到這顆 worker\n'
      + `     ⚠️ **不要**為了讓這道閘變綠而把版本說明頁加回 docs-site——leo 2026-08-17：「這個頁面刪除。」`);
  }
  return { status: 'done', detail: [`帳號 ${D.accountId}｜env ${D.wranglerEnv || '(預設環境)'}`, ...r.lines] };
}},

// ── 7.6 mailRelay：郵差（D62「忘記密碼」代寄），2026-08-11 加（arcrun-rag#38／#69／#25）──
// 為什麼收進來：跟 docsSite 同一種病——landing 之前完全不在這支腳本裡，只能靠人手動
// `wrangler deploy`；2026-08-11 實測就是這樣漏的：stage 手動部署過，prod 從沒推過，
// health 是綠的（worker 活著）掩護了「沒有 D62 那支路由」（跑舊碼）沒被任何人發現。
// 這一步跟 landing worker 本身無關 bundle 版本（它不吃 pin），只吃它自己的原始碼——
// 所以**每次出貨都重推**（不比對 sha／不跳過），一致對齊「同一份輸入永遠得到同一組動作」。
{ id: 'mail-relay', title: '部署郵差（忘記密碼代寄），並驗證它真的接得起來', mutates: true, async run() {
  if (!T.mailRelay) return { status: 'skip', detail: ['本目標沒有安裝器也沒有郵差（登錄簿宣告）'] };
  const M = T.mailRelay;
  const cwd = join(REPO_ROOT, M.cwd);
  const args = ['wrangler', 'deploy', '--config', M.config];
  if (M.wranglerEnv) args.push('--env', M.wranglerEnv);   // prod 走預設環境，沒有 env 名
  shLive('npx', args, cwd, { CLOUDFLARE_ACCOUNT_ID: M.accountId });

  // 部署指令沒報錯不算驗過（CRITICAL-PATH 使用規則 6）——實測踩過「health 綠但代寄路由
  // 404」，只問 health 會誤判成通：見 verify-mail-relay.mjs 檔頭。
  if (!M.verifyUrl) {
    throw new Error(
      `登錄簿的 ${TARGET_NAME}.mailRelay 沒給 verifyUrl ⇒ 沒辦法證明郵差真的接得起來。`);
  }
  const r = await checkMailRelayLive({ base: M.verifyUrl });
  if (r.fails.length) {
    throw new Error('郵差部署了，但代寄路由不認得（用戶按「忘記密碼」會繼續斷）：\n'
      + r.fails.map((f) => `       • ${f}`).join('\n')
      + '\n' + r.lines.map((l) => `       ｜${l}`).join('\n'));
  }
  return { status: 'done', detail: [`帳號 ${M.accountId}｜env ${M.wranglerEnv || '(預設環境)'}`, ...r.lines] };
}},

// ── 8. purge：讓送貨管道拿到新版並確認它真的收斂了（stage 與 prod 都走）──────
//
// 🔴 站表 id 還是 `purge`（它得跟站表逐項對齊），但這一站問的其實是**送達收斂**：
//   「使用者／桌面小幫手真的會去讀的那個**會移動的指標**，現在指到這一版了嗎？」
//   prod 的指標是 jsDelivr `@main`（有作廢端點可以打），stage 是 Gitea `raw/branch/main`
//   （沒有作廢端點 ⇒ 帶 no-cache 強制重讀）。原本的標題「只有 prod 需要」是錯的——
//   那句話正是這一站只在單邊執行、因此壞了兩次都沒被發現的由來。
//
// 🔴 D70（leo 2026-08-11，arcrun-rag#77）：**整站交給 Arcrun 工作流 `ship_refresh_cdn`。**
//   這一站是全站表裡最乾淨的一個「天生就是工作流形狀」的例子——打幾個網址、等一下、
//   再讀一次比對，重試到收斂。沒有一個動作需要碰 leo 這台機器上的任何東西。
//   ⇒ 本機那支 `purge-jsdelivr.mjs` 從此不再是出貨路徑上的東西（留著當對照，
//     它檔頭記著 2026-08-02 那次「用戶按檢查更新像沒反應」的實撞，是這件事的來由）。
//
// 🔴 arcrun-rag#79（2026-08-11）：重試迴圈**不再放進工作流本體**。
//   查證：這一站自從搬去 Arcrun 之後，今天是它第一次真的被觸發（同批修的是
//   `runWorkflow` 沒被 import——見 commit 4ce1420），一跑就在最後一個節點撞
//   Cloudflare Worker 的「單次 invocation 子請求數上限」（HTTP 500）。
//   根因不是額度給太小（付費帳號不太可能撞這個），是舊版 `ship_refresh_cdn`
//   自己內部用 FOREACH 跑滿 4 圈 purge+wait+fetch+check——而 Arcrun 的 FOREACH
//   沒有「已收斂就提早停」這個能力（沒有 loop-until 邊），所以不管第一次
//   就收斂與否，四圈份的子請求（每圈 6 個節點×1~2 個子請求）都會被無條件燒完，
//   逼近上限。
//   修法：`ship_refresh_cdn` 工作流本體改成只做「一次」purge+wait+fetch+check
//   （見 workflows/ship_refresh_cdn.json 的檔頭說明），重試迴圈搬到這裡——
//   每次呼叫都是全新的 Worker invocation，子請求預算重新歸零，所以呼叫幾次
//   都不會再撞上限；「已收斂就別再打」這個判斷，本來就沒辦法留在工作流裡
//   （Arcrun 沒有 loop-until 原語），只能是呼叫端的事。實際打 jsDelivr／
//   等待／讀 manifest／比對三步仍 100% 在 Arcrun 做，沒有違反 D70。
// 🔴 arcrun-rag#79 第一個驗收條件（2026-08-12）：**stage 也要走這一站**。
//   舊條件 `if (!T.verify.fullChain) return skip` 就是「只有 prod 會執行」的開關本身：
//   fullChain 只有 prod 宣告 ⇒ stage 每次印「本目標不走 jsDelivr」跳過
//   ⇒ 這一站的每一個壞法都只能在 prod 現形（2026-08-11 一次現形兩個）。
//   現在條件改成「登錄簿有沒有宣告 delivery」，而不變式 Ⅷ 又規定**有安裝器就必須宣告**
//   ⇒ 「這個目標沒這東西」不再是一句可以自己講的話，它得先通過登錄簿那道閘。
//   判斷邏輯全在 `ship-delivery.mjs`（純函式，測得動所有分支）；這裡只負責接線。
{ id: 'purge', title: '讓送貨管道拿到新版並確認它真的收斂了', mutates: true, async run() {
  const plan = deliveryPlan(T, TARGET_NAME, { drill: !!process.env[DRILL_ENV] });
  // 走到這裡還沒有 delivery 的，只剩沒有安裝器的目標（selftest）——它不推任何地方，
  // 沒有「會移動的指標」指向它，也不面對任何人。
  if (!plan) return { status: 'skip', detail: ['本目標不推任何送貨管道（selftest：只建、只算版本，不推不部署）'] };

  // `--delivery-only`（與 `--verify-only` 同理）沒跑前面的 build/version 步驟
  // ⇒ 期望值改由**磁碟上那份 bundle** 提供：那正是上次出貨送出去的內容。
  ensureExpectationsFromDisk();

  const result = await confirmDelivery({
    plan, release: ctx.release, daemonVersion: ctx.daemonVersion, runWorkflow,
  });
  if (!result.converged) throw notConvergedError(plan, result);
  return { status: 'done', detail: [`Arcrun ship_refresh_cdn（contract v2）｜試了 ${result.attempts.length} 次`, ...result.lines] };
}},

// ── 9. verify：**走使用者真的會走的那條路**。沒送達就不算成功 ────────────────
{ id: 'verify', title: '驗收（用戶端視角，不是部署訊息）', mutates: false, async run() {
  if (!T.verify) return { status: 'skip', detail: ['本目標沒有對外端點可驗（登錄簿宣告）'] };
  const base = T.verify.installerBase;
  const lines = [];
  const fails = [];
  // `--verify-only` 沒跑前面的 build/version 步驟 ⇒ 期望值改由**磁碟上那份 bundle** 提供。
  // 那正是上次出貨送出去的內容，不是另一個手抄的數字。
  const fromDisk = ensureExpectationsFromDisk();
  if (fromDisk) lines.push(fromDisk);
  // built 同理：期望值一律取磁碟上那份 manifest——**pin 步驟寫進 BUNDLE_BUILT 的就是它**，
  // 所以「線上宣告的建置日 == 磁碟 manifest 的建置日」問的正是「這次的 pin 有沒有真的送達」。
  if (ctx.built === null) {
    ctx.built = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).built || null;
  }
  // 釘點網址要能獨立算出來——預演時 pin 步驟沒跑，不能靠它留下的值（會是 null）。
  ctx.headSha = ctx.headSha || sh('git', ['rev-parse', 'HEAD'], ctx.bundlesDir);
  ctx.pinUrl = ctx.pinUrl
    || T.pin.template.replace('{sha7}', ctx.headSha.slice(0, 7)).replace('{sha40}', ctx.headSha);
  // 同理：安裝器原始碼指紋（arcrun-rag#95）——`--verify-only` 沒跑過 pin 站也要能算。
  ctx.installerSrcHash = ctx.installerSrcHash
    || (T.installer && installerSourceHash(join(REPO_ROOT, T.installer.cwd, 'worker.js')));

  // ① 安裝器對外宣告的版本＝新用戶會裝到的版本
  //
  // 🔴 2026-08-08 實撞：deploy 回報成功後**立刻**讀 /api/latest，拿到的還是舊釘子
  //    （fc3c3ca，新的是 e0b3592），4 秒後再讀就對了 ⇒ 純粹是佈署傳播延遲。
  //    但這道閘當時判了 ❌ ⇒ **假陰性**。假陰性和假綠一樣糟：
  //    一道會亂叫的閘，人很快就會學會忽略它——那它就等於不存在了。
  //    ⇒ 這一項要**輪詢到收斂**，不是讀一次就定生死；真的沒收斂才算斷。
  // 🔴 D70（leo 2026-08-11，arcrun-rag#77）：**「去看一眼＋比對」這件事交給 Arcrun 工作流。**
  //   leo 的判準是「打開工作流頁看得到這件事嗎」——這一站是整條線最貴的一站
  //   （沒送達就不算成功），所以它更該看得到。
  //   分工是刻意的，不是偷懶：
  //     · **Arcrun 做**：去使用者會看的網址抓、逐項比對期望值、給每一項的判定
  //     · **ship.mjs 做**：輪詢到收斂（下面這個迴圈）＋把不合的收進 fails
  //   為什麼收斂輪詢留在這裡：它是**出貨流程的節奏**（部署傳播要等幾十秒），
  //   不是「查證這件事」本身；而且 08-08 為了假陰性寫的那段血淚就在這個迴圈上，
  //   把它搬走等於把那次教訓丟掉。
  const want = ctx.headSha ? ctx.headSha.slice(0, 7) : null;
  const liveChecks = [
    { label: 'release', path: 'release', expected: ctx.release },
    { label: 'daemon 版本', path: 'daemon.version' },
    { label: '釘子', path: 'pin' },
    { label: '建置日', path: 'built', expected: ctx.built },
    { label: '更新畫面那一行', path: 'daemon.notes' },
    // 🔴 下載網址一定要問到：verify 第 ④ 段拿它去走「使用者按下載鈕」那條路。
    //   2026-08-11 實撞：這一段改由 Arcrun 去看時，我漏了問這兩個值，
    //   下游就報「安裝器沒有對外宣告下載網址」——**東西好好的，是我沒問**。
    //   「換誰去看」最容易掉的就是這種：下游要的欄位沒被列進 checks，看起來像線上壞了。
    { label: 'mac 下載網址', path: 'daemon.downloads.mac' },
    { label: 'win 下載網址', path: 'daemon.downloads.win' },
    // arcrun-rag#95：驗收也要看得到「安裝器自己這次真的換過內容」，不是只看 bundle 那條線。
    { label: '安裝器原始碼指紋', path: 'installer_sha', expected: ctx.installerSrcHash },
  ];
  if (want) liveChecks.push({ label: '釘子指向本次 bundle HEAD', mode: 'contains', expected: want });

  let seen = null;
  const chk = (l) => (seen && (seen.results || []).find((r) => r.label === l)) || {};
  for (let n = 1; n <= 12; n++) {
    seen = await checkLive({ url: `${base}/api/latest?${cb()}`, checks: liveChecks }).catch(() => null);
    if (seen && seen.fetch_ok && chk('release').ok && (!want || chk('釘子指向本次 bundle HEAD').ok)) break;
    if (n === 1) lines.push(`/api/latest 還沒收斂（release ${chk('release').actual}｜pin ${chk('釘子').actual}）→ 等佈署傳播…`);
    if (n < 12) await new Promise((r) => setTimeout(r, 5000));
  }
  // 攤成 ship.mjs 後面各段仍在用的形狀（不改下游，只換「誰去看的」）
  const latest = seen && seen.fetch_ok
    ? { release: chk('release').actual, pin: chk('釘子').actual, built: chk('建置日').actual,
        daemon: {
          version: chk('daemon 版本').actual, notes: chk('更新畫面那一行').actual,
          downloads: { mac: chk('mac 下載網址').actual, win: chk('win 下載網址').actual },
        } }
    : null;
  if (!latest) { fails.push(`/api/latest 讀不到${seen && seen.fetch_error ? `（Arcrun 回報：${seen.fetch_error}）` : ''}`); }
  else {
    lines.push(`↑ 這一段由 Arcrun 工作流 ship_check_live 去看並比對（不是本機 curl）`);
    lines.push(`/api/latest → release ${latest.release}｜pin ${latest.pin}｜daemon ${latest.daemon && latest.daemon.version}`);
    if (latest.release !== ctx.release) fails.push(`安裝器宣告 ${latest.release}，本次是 ${ctx.release}（等了 60 秒仍沒收斂）`);
    if (want && !String(latest.pin || '').startsWith(want)) {
      fails.push(`安裝器釘子 ${latest.pin}，本次 bundle HEAD 是 ${want}（等了 60 秒仍沒收斂）`);
    }
    // 🔴 建置日也要送達（2026-08-09，arcrun-rag#27）
    //   08-09 實測：prod 出的是 08-09 打的內容，`/api/latest` 卻宣告 `built 2026-08-07`。
    //   那個值是 `wrangler.toml` 的 `BUNDLE_BUILT`，由 pin 步驟從 manifest 抄過去
    //   ⇒ 這一條同時夾住三件事：manifest 的 built 對不對、pin 有沒有寫進去、有沒有真的部署。
    //   （D37 單一真相源＝manifest；以前這條規約只寫在 wrangler.toml 的註解裡，沒有人在執行它。）
    lines.push(`/api/latest → built ${latest.built}（本次 manifest.built ${ctx.built}）`);
    if (ctx.built && latest.built !== ctx.built) {
      fails.push(`安裝器宣告建置日 ${latest.built}，本次內容的建置日是 ${ctx.built}`
        + `——使用者看到的日期不是他手上這一版的（BUNDLE_BUILT 沒跟著換，或沒部署）`);
    }
    // 使用者在「版本與更新」看到的那一行，也要真的送到了（不是只在本機 manifest 裡對）
    const shipped = latest.daemon && latest.daemon.notes;
    if (shipped) lines.push(`使用者會看到的那一行（${String(shipped).length} 字）：${shipped}`);

    // arcrun-rag#95：安裝器原始碼指紋要送達——這條專門攔「deploy 站判斷跳過，但
    // 其實安裝器邏輯已經改了」這種以前全綠放行的情況。
    const liveSrc = chk('安裝器原始碼指紋').actual;
    lines.push(`/api/latest → installer_sha ${String(liveSrc || '(無)').slice(0, 12)}（本次 ${String(ctx.installerSrcHash || '').slice(0, 12)}）`);
    if (ctx.installerSrcHash && liveSrc !== ctx.installerSrcHash) {
      fails.push(`安裝器宣告的原始碼指紋是 ${String(liveSrc).slice(0, 12)}，本次應該是 ${String(ctx.installerSrcHash).slice(0, 12)}`
        + `——安裝器的程式碼沒有真的部署到線上（deploy 站可能誤判成跳過）`);
    }
  }

  // ② 釘點上的產物真的是這一版（釘子對，不代表釘到的東西對）
  const pinned = await getJson(`${ctx.pinUrl}/manifest.json?${cb()}`);
  lines.push(`釘點 manifest → release ${pinned.release}｜built ${pinned.built}｜daemon ${pinned.daemon && pinned.daemon.version}`);
  if (pinned.release !== ctx.release) fails.push(`釘點內容是 ${pinned.release}，不是 ${ctx.release}`);
  if (ctx.built && pinned.built !== ctx.built) {
    fails.push(`釘點內容的建置日是 ${pinned.built}，本機 manifest 是 ${ctx.built}——推上去的不是這一份`);
  }

  // ③ portal 前端內容回歸——版本號對不代表內容對（08-03 實撞：CIS 視覺整個退版）
  const ui = await getText(`${ctx.pinUrl}/tier2/ui/index.js?${cb()}`);
  const uiMust = [["/__version 路由", "p === '/__version'"], ['版本注入', 'ARCRUN_BUNDLE_VERSION']];
  const uiMissing = uiMust.filter(([, s]) => !ui.includes(s)).map(([n]) => n);
  lines.push(`釘點 portal 前端 ${(ui.length / 1024).toFixed(0)}KB｜特徵 ${uiMissing.length ? '缺：' + uiMissing.join('／') : '齊全'}`);
  if (uiMissing.length) fails.push(`portal 前端少了：${uiMissing.join('／')}`);

  // ④ 真的把 daemon 下載下來算 sha256——**這是使用者按下載鈕走的那條路**
  //
  // 🔴 leo 2026-08-08：「**包括下載都在 stage 版**」——下載鈕不能混用另一條線的產物。
  //    由來：`daemonOf()` 曾無條件把 prod 的 GitHub raw 當下載宿主，staging 的 sha
  //    在 prod repo 根本不存在 ⇒ 封測者在 stage 按下載 100% 502。
  //
  // 🔴 2026-08-09（arcrun-rag#27）：這一段的判斷邏輯搬到 `verify-download.mjs`，原因見該檔頭。
  //    一句話：1.4.29 推 prod 時它報「win 下載鈕給的檔 ≠ 釘點上的檔」，但使用者拿到的檔
  //    **逐位元正確**——真兇是拿 jsDelivr 釘點去抓 `.exe`（jsDelivr 403 擋執行檔），
  //    抓不到就 `null !== hex` ⇒ 把「**我無法比對**」報成「**它們不一致**」。
  //    每次出貨都紅、久了就沒有人當真，那比沒有檢查更糟（leo 08-08 已為假陰性說過同一句話）。
  //    修法不是放寬：改成三條各自獨立的線（內容／來源／佐證），其中「來源」是**不需抓檔**的
  //    字串硬斷言，比舊的間接位元推論更強；只有第三條佐證才有「無法取證」這一態。
  const warns = [];
  if (QUICK) {
    lines.push('daemon 下載：--quick 略過（未驗證使用者真的下載得到）');
  } else {
    for (const os of ['mac', 'win']) {
      const meta = pinned.daemon && pinned.daemon[os];
      if (!meta) continue;
      const r = await checkDaemonDownload({
        os,
        file: meta.file,
        declaredSha256: meta.sha256,
        daemonVersion: ctx.daemonVersion,
        pinUrl: ctx.pinUrl,
        downloadEndpoint: `${base}/download/${os}?${cb()}`,
        // 安裝器**自己對外宣告**的下載網址（來自線上 env）——與我們由登錄簿＋本機 HEAD
        // 算出來的那個是兩個獨立來源，不相等就是釘子/宿主跑到別條線去了。
        advertisedUrl: latest && latest.daemon && latest.daemon.downloads && latest.daemon.downloads[os],
      });
      lines.push(...r.lines);
      fails.push(...r.fails);
      warns.push(...r.warns);
    }
  }
  if (warns.length) {
    lines.push('⚠️ 有項目「無法取證」（≠ 證據顯示壞了）：');
    for (const w of warns) lines.push(`   · ${w}`);
  }

  // ⑤ 說明文件站是活的、而且是這份原始碼建的
  //    （2026-08-09 arcrun-rag#27：leo「有沒有上 docs？版本有沒有版本說明？」）
  //    放在 verify 而不是只放在 docs 步驟裡，是為了讓 `--verify-only` 也問得到這一條：
  //    文件站會不會過期，跟「這次有沒有部署」是兩件事——它可能昨天就掉隊了。
  //
  //    🔴 2026-08-17（inkstone/arcrun-rag#41）：這一條以前是「站上有沒有這兩個版號」。
  //       版本說明頁刪掉之後，「使用者查得到這一版」由 `release-record` 站保證
  //       （GitHub／Gitea 上的版本發佈），這裡只剩「站本身是不是新的」。
  if (T.docsSite && T.docsSite.verifyUrl) {
    const d = await checkDocsLive({ docsBase: T.docsSite.verifyUrl });
    lines.push(...d.lines);
    fails.push(...d.fails);
  }

  if (fails.length) {
    // 預演時「線上還不是這一版」是**預期中的事實**，不是管線壞掉——如實報差距就好。
    // 真的出貨（--confirm）時同一件事就是斷：宣稱出貨卻沒送達，等同沒交付。
    // `--verify-only` 是「對著已經上線的東西問它到底通不通」⇒ 與 --confirm 同樣嚴格。
    if (!CONFIRM && !VERIFY_ONLY) {
      return { status: 'skip', detail: [
        ...lines,
        `⚠️ 線上還不是這一版（預演不出貨，這是正常的）：`,
        ...fails.map((f) => `   · ${f}`),
      ] };
    }
    throw new Error('驗收未過——**用戶此刻拿不到這一版**：\n' + fails.map((f) => `       • ${f}`).join('\n')
      + '\n' + lines.map((l) => `       ｜${l}`).join('\n'));
  }
  return { status: 'done', detail: lines };
}},

// ── 10. release-record：這個環境的使用者去哪讀「這版改了什麼」──────────────────
//
// 🔴 leo 2026-08-10：「你的出貨沒有限制你一定要在 github 產生 release？」「那為什麼不改掉？」
// 🔴 leo 2026-08-16：「**你為什麼沒有發 Gitea 內部版本？**」
//                    「changelog 直接看 github，**如果在 stage 直接看 gitea**，
//                      不要花力氣維護兩個地方。」「**兩邊動作相同，不用這裡一套那裡一套。**」
//
// ── 2026-08-16 這一站為什麼改名（arcrun-rag#88）─────────────────────────────
// 舊 id 是 `github-release`，而 leo 要的東西**跟 GitHub 沒有必然關係**——他要的是
// 「使用者想看某一版有什麼變化時，去那個環境對應的地方就看得到」。名字綁死主機的結果，
// 就是 stage 只能是「本目標沒有 githubRelease」，於是同一件事在兩個環境待遇完全不同。
// 這與 `build` → `fetch-artifacts`（2026-08-15）是同一種更名：**照本質動作命名**。
// `installer/ship-report.json` 的歷史照舊留著舊 id——那是當時真的叫什麼。
//
// 放在 verify **之後**（最後一步）：只有全部驗收通過、使用者真的拿得到這一版，
//   才留下那一筆紀錄——不然等於對使用者宣告一個沒送達的版本。
// 冪等：同一版重跑 --confirm 不該報錯或建出兩筆——先查 tag 是否已存在，存在就跳過。
// 兩個主機的形狀刻意一模一樣：① 先讓那顆 commit 在該主機上看得到 ② 再建 release。
//   ①**不是儀式**：指到一顆只有某台機器看得到的 commit，leo 要的
//   「票 → PR → commit → version 都有歷史可查」那條鏈就是斷的，而頁面看起來完全正常。
// D20：**只有 github 那一半受管制**（fetch/execFileSync 開出去的呼叫 Bash hook 看不到，
//   保險檢查與留痕跟 `push` 步驟一樣自己做）；Gitea 是內部開發環境（D73），寫入不需開閘。
// 🔴 2026-08-18（inkstone/arcrun-rag#88）：**發佈以「版本線」為單位，不以「這趟出貨」為單位。**
//   在此之前這一站寫死 `tag = v${ctx.release}`——`ctx.release` 是零件包版本（1.4.x）
//   ⇒ 一趟出貨永遠只產生一筆 release，不管它送了幾條線。桌面小幫手那條線（0.18.x）
//   有三站在管**內容**（daemon-sync／daemon-check／daemon-source-check），
//   **零站在管它有沒有被發佈** ⇒ v0.18.26／27／28／29 四版對外一筆都沒有。
//   實證（github-contact-log.md 同一個任務三行）：2026-08-16 18:53–18:55
//   「推 prod：**daemon v0.18.28**（三平台）＋對應零件包」→ 建出來的唯一一筆是 `v1.4.46`。
//
//   ⚠️ 這是這一站的**第三輪**，而前兩輪改的是別的軸，不是重做：
//     · c12ed60（08-10）「GitHub 上有沒有這一版」本來完全沒有閘 → 補出這一站
//     · 6d4de43（08-16）這一站只有 prod 走得到 → 擴成 stage 也走
//     兩輪都在問「**哪些環境**要留發佈」，從來沒有人問過「**一趟出貨送了幾條版本線**」。
//
//   ⇒ 現在改成照 `release-lines.mjs` 的 LINES 逐條發；下一條線加進那份清單就自動被涵蓋。
//   命名照 leo 2026-08-17：**tag 裸號不帶 v、標題＝產品名＋裸號**；
//   既有 10 個帶 `v` 的 tag 不回頭改 ⇒ 冪等檢查**兩種寫法都要查**，否則會重複建。
{ id: 'release-record', title: '在這個環境對應的 repo 留一份使用者點得到的版本發佈（每條版本線各一筆）', mutates: true, async run() {
  const R = T.releaseRecord;
  // `--release-record-only` 沒跑 fetch-artifacts／version 兩步 ⇒ ctx 是空的。
  // 期望值取自磁碟上那份 bundle manifest（＝上次真的送出去的內容），同 --verify-only。
  const fromDisk = RELEASE_RECORD_ONLY ? ensureExpectationsFromDisk() : null;

  // 這趟出貨送了哪幾條版本線——讀**真的要送出去的那份 bundle manifest**，不是憑 ctx 推。
  const manifestPath = join(ctx.bundlesDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const lines = linesFrom(manifest, 'manifest');
  if (lines.length === 0) {
    throw new Error(
      `${manifestPath} 裡讀不到任何版本線（release／daemon.version 都沒有）。\n` +
      `     「檢查了 0 條卻通過」是假綠的經典形狀 ⇒ 不放行。`);
  }
  // 冪等：既有 tag 帶 v、新的裸號，過渡期兩種並存（leo 2026-08-17 明說舊的不回頭改）
  // ⇒ 查的時候兩種都查，不然同一版會被建第二筆。
  const tagCandidates = (line) => [line.tag, `v${line.tag}`];

  // ── 這一版要掛哪些檔（inkstone/arcrun-rag#88，2026-08-18）────────────────────
  // 🔴 leo 2026-08-18 指著 release 頁問：「**assets 都寫 source code，這兩個附檔實際是什麼？
  //   是 dmg 還是 go？**」——實查是 Gitea／GitHub **自動產生的整包 repo 快照**，
  //   不是任何人裝得起來的東西（本輪演練實測：掛之前 attachment 數是 0）。
  //   ⇒ 沒有這一段，補發佈只會多出幾個「看起來能下載、點下去給錯東西」的頁面，
  //     而且 release-check 那道閘會照樣變綠 ⇒ 比沒有頁面更糟。
  const assetsOf = (line) => {
    const rels = assetsFor(line, manifest);
    if (rels.length === 0) {
      throw new Error(
        `${line.product} ${line.tag} 這條線在 manifest 裡找不到任何成品可以掛。\n` +
        `     不發一個沒有成品的版本頁——那正是「看起來能下載、點下去給錯東西」的長法。\n` +
        `     （宣告在 release-lines.mjs 的 assetKeys；daemon 線要 mac／win／msix 三個鍵。）`);
    }
    return rels.map((rel) => {
      const abs = join(ctx.bundlesDir, rel);
      if (!existsSync(abs)) {
        throw new Error(
          `manifest 說這一版有 ${rel}，但 ${ctx.bundlesDir} 裡沒有這個檔。\n` +
          `     manifest 與磁碟對不上時**不掛半套**——寧可擋下，也不要發一個附件缺一半的版本頁。`);
      }
      return { rel, abs, name: rel.split('/').pop() };
    });
  };

  // ── 內外版本號的對應（leo 2026-08-18：「對應關係記在該次發佈的 release note」）──
  // 在此之前這張表是**總管手寫**在 note 裡的 ⇒ 會漏、會寫錯、格式不一。
  // 序號從**該主機既有 release 的內文**算出來（不養一本會漂的帳，見 internal-version.mjs）。
  const headShaFull = sh('git', ['rev-parse', 'HEAD'], REPO_ROOT);
  const today = dateStamp();
  // 🔴 D95：序號**按 repo 各算各的**。以前只有一個 repo，一個計數器就夠；
  //   現在兩條線住在兩個 repo，共用一個計數器會讓兩邊的號碼互相跳號
  //   ——而內部號的用途正是「在那個 repo 裡指認這一次出貨」。
  const seqCounters = new Map();
  const seqOf = (repoSlug, shortCode, existingBodies) => {
    if (!seqCounters.has(repoSlug)) seqCounters.set(repoSlug, nextSequence(existingBodies, shortCode, today));
    const n = seqCounters.get(repoSlug);
    seqCounters.set(repoSlug, n + 1);
    return n;
  };
  /**
   * 把 changelog 段落 + 機器產生的內外對應，組成最終要送上去的內文。
   * 🔴 `repoName`／`commit` 指的是**這條線的源碼住在哪個 repo、哪一顆**——D95 之後
   *   桌面小幫手那條是 arcrun-collector 與它自己的 sha，不是 arcrun-rag 的。
   *   內部號要能在它所在的那個 repo 裡被查回去，指到別的 repo 的 sha 等於指到虛空。
   */
  const bodyWithMapping = (line, changelogBody, assets, existingBodies, home) => withMappingSection(
    changelogBody,
    mappingSection({
      product: line.product,
      external: line.tag,                       // 對外號＝裸號（leo 2026-08-17「不要 v」）
      internal: formatInternalVersion({
        repoName: home.repoName,
        commit: home.commit,
        sequence: seqOf(home.repoSlug, shortCodeFor(home.repoName), existingBodies),
        // 🔴 傳成品進去不是裝飾：formatInternalVersion 收到空陣列會丟例外
        //   ⇒ **算不出一個沒有成品的內部號**（leo：「內部每次就要出貨 bundle 的版本」）。
        artifacts: assets.map((a) => a.name),
      }),
      upstream: typeof manifest.source === 'string' ? manifest.source : undefined,
      artifacts: assets.map((a) => a.name),
    }),
  );

  /** `inkstone/arcrun-collector` → `arcrun-collector`（短碼表用的是 repo 名，不是 slug）。 */
  const repoNameOf = (slug) => String(slug).split('/').pop();

  // ── host=gitea（stage）：內部封測者要看的那一份 ────────────────────────────
  if (R.host === 'gitea') {
    const cred = giteaWriteCredentialsFromRemote(REPO_ROOT);
    if (!cred) throw new Error('讀不到 Gitea 寫入權杖（preflight 已經查過一次，走到這裡還沒有＝remote 在兩步之間被改動過）');
    const opts = { token: cred.token, baseUrl: R.baseUrl };

    // 內部號的序號要從「這個 repo 上已經有的 release」算 ⇒ 先撈一次（唯讀）。
    // 🔴 tag 與內文**都要餵**：2026-08-17 那兩筆內部號（`RAG-20260817-001/002-…`）
    //   是總管手動建的，號碼寫在 **tag_name** 上而不是內文裡。只掃內文的話今天會從 1 重編，
    //   撞號撞得無聲無息。判準照舊是「從看得到的事實算」，那就得把看得到的兩處都算進去。
    //
    // 🔴 D95（2026-08-18，InkStoneCo#40）：**逐條線各撈各的 repo。**
    //   以前這裡只撈 `R.repoSlug` 一個，因為「一個目標一個 repo」是寫死的前提。
    //   那個前提就是 leo 指出的扭曲本身：桌面小幫手的版本被疊進雲端引擎的歷史。
    const bodiesOf = new Map();
    const listBodies = async (slug) => {
      if (!bodiesOf.has(slug)) {
        bodiesOf.set(slug, (await giteaListReleases(slug, opts).catch(() => []))
          .map((r) => `${r.tag_name || ''}\n${r.body || ''}`));
      }
      return bodiesOf.get(slug);
    };

    // 逐條線先算好「這條要不要建、發到哪、內文是什麼、要掛哪些檔」——**全部算完才動手**，
    // 免得第一條建好、第二條才發現 changelog 缺段或成品不在，留下半套狀態。
    const todo = [];
    for (const line of lines) {
      const entry = repoForLine(line.id, R);   // 缺宣告就丟——不退回 R.repoSlug（見 line-source-repo.mjs）
      const slug = entry.repoSlug;
      let existing = null;
      for (const cand of tagCandidates(line)) {
        existing = await giteaReleaseExists(slug, cand, opts).catch((e) => {
          throw new Error(`查詢 ${slug} 是否已有 release ${cand} 失敗（不放行，寧可手動確認也不要建出重複的）：${e.message}`);
        });
        if (existing) break;
      }
      if (existing) { todo.push({ line, entry, slug, existing }); continue; }
      const changelogBody = releaseSectionFor(REPO_ROOT, line.version);
      if (!changelogBody) {
        throw new Error(
          `說明文件裡沒有 ${line.version}（${line.product}）這一版可以當作版本發佈的內容（該補在 ${changelogRelFor(REPO_ROOT, line.version)}）。\n` +
          `     這不是「先跳過、之後再補」——少了它，封測者點進版本發佈頁看到的是空白。\n` +
          `     🔴 而「先出貨、之後再補」正是 daemon 斷更四版的走法（#88）。`);
      }
      todo.push({ line, entry, slug, assets: assetsOf(line), changelogBody });
    }
    if (todo.every((t) => t.existing)) {
      return { status: 'skip', detail: todo.map((t) => `Gitea 已有 ${t.line.tag}（${t.line.product}）：${t.existing.html_url}`) };
    }

    const detail = fromDisk ? [fromDisk] : [];

    // ① 讓這一版的原始碼 commit **在它自己那個 repo 上**看得到（＝交貨，D73）。
    //   一筆 release 要指到一顆 commit；指到一顆那個 repo 看不到的 sha，
    //   「票→PR→commit→version」那條鏈就是斷的，而頁面看起來完全正常。
    //
    //   兩種形狀，靠**宣告**分（不是猜名字）：
    //     · 沒有 sourceDir ＝ 源碼就在本 repo ⇒ 沿用既有動作：推出貨分支，用 HEAD sha
    //     · 有   sourceDir ＝ 源碼住在它自己的 repo ⇒ 把那個目錄同步過去，用**那邊的** sha
    //       （leo D95：「原始碼和產出物放在一起」）
    const headSha = sh('git', ['rev-parse', 'HEAD'], REPO_ROOT);
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT);
    const targetOf = new Map();     // repoSlug → 這一版在那個 repo 裡的 target sha
    const homeOf = new Map();       // repoSlug → { repoName, repoSlug, commit }（內部號要用）

    for (const t of todo) {
      if (t.existing || targetOf.has(t.slug)) continue;
      if (livesInOwnRepo(t.entry)) {
        // 同步過去。**權杖只在這裡組進網址，不落地、不印出**（D36）——
        // remote 宣告在登錄簿是不帶帳密的乾淨網址，帳密從本機 gitea remote 取。
        const authed = t.entry.remote.replace(/^https:\/\//, `https://${cred.login}:${cred.token}@`);
        const sync = syncSourceRepo({
          srcRoot: REPO_ROOT,
          sourceDir: t.entry.sourceDir,
          workDir: t.entry.workDir,
          remoteUrl: authed,
          branch: t.entry.branch || 'main',
          destOwned: t.entry.destOwned || [],
      // preflight 領到的推 main 授權（InkStoneCo#56）——沒有它這一步會當場被閘擋下
      guardOpts: { grants: ctx.mainPushGrants },
          message: `sync: ${t.entry.sourceDir}/ 同步自 ${R.repoSlug}@${headSha.slice(0, 7)}（${t.line.product} ${t.line.tag}）`,
        });
        const onServer = await giteaCommitExists(t.slug, sync.sha, opts);
        if (!onServer) {
          throw new Error(
            `同步完了，但 ${t.slug} 還是查不到 commit ${sync.sha.slice(0, 7)}——不建指向看不到的 commit 的版本發佈。`);
        }
        targetOf.set(t.slug, sync.sha);
        homeOf.set(t.slug, { repoName: repoNameOf(t.slug), repoSlug: t.slug, commit: sync.sha });
        detail.push(sync.changed
          ? `已把 ${t.entry.sourceDir}/（${sync.files} 個版控檔）同步到 ${t.slug} → ${sync.sha.slice(0, 7)}`
          : `${t.slug} 內容已是最新（${sync.files} 個版控檔）→ ${sync.sha.slice(0, 7)}`);
        // 🔴 沒搬的要**說出來**：`git add` 本來就會擋下目的 repo 忽略的檔案，
        //   但那是碰巧擋住，報告上不會有任何一行講它——「安靜地做對」與「安靜地做錯」
        //   在紀錄上長得一模一樣。這幾個是 collector/ 裡的建置產物化石（實測 4 個共 43 MB）。
        if (sync.skipped && sync.skipped.length) {
          detail.push(`　└ ${t.slug} 的 .gitignore 擋下 ${sync.skipped.length} 個建置產物，沒搬：${sync.skipped.join('、')}`);
        }
        continue;
      }
      // 源碼就在本 repo：沿用 2026-08-16 起的既有動作，一字未改。
      //   🔴 絕不代推 main／master：那道閘（總管看過才併）是人的同意，
      //     不能因為「出貨腳本順手做了」就被繞過（InkStoneCo 頂層規則二之一）。
      let onServer = await giteaCommitExists(t.slug, headSha, opts);
      if (!onServer) {
        if (/^(main|master|HEAD)$/.test(branch)) {
          throw new Error(
            `這一版的原始碼 commit（${headSha.slice(0, 7)}）在 ${t.slug} 上找不到，而目前分支是 \`${branch}\`。\n` +
            `     出貨線**不代推 main**（那道閘是人的同意，不能被腳本繞過）⇒ 請先把它併上去再出貨。\n` +
            `     為什麼不放行：指到一顆別人看不到的 commit 的版本發佈，「票→PR→commit→version」那條鏈是斷的。`);
        }
        pushGiteaQuietly(branch);  // 不用 sh：git 會把內嵌帳密的網址回聲出來（D36）
        detail.push(`已把出貨分支交到 Gitea：${branch} → ${headSha.slice(0, 7)}`);
        onServer = await giteaCommitExists(t.slug, headSha, opts);
        if (!onServer) throw new Error(`推完了，但 ${t.slug} 還是查不到 commit ${headSha.slice(0, 7)}——不建指向看不到的 commit 的版本發佈。`);
      } else {
        detail.push(`出貨 commit 已在 Gitea 上：${branch} @ ${headSha.slice(0, 7)}（${t.slug}）`);
      }
      targetOf.set(t.slug, headSha);
      homeOf.set(t.slug, { repoName: repoNameOf(t.slug), repoSlug: t.slug, commit: headShaFull });
    }

    // ② 逐條線建 release（tag 裸號、標題＝產品名＋裸號）＋**把這一版的成品掛上去**
    const made = [];
    for (const t of todo) {
      if (t.existing) { made.push(`⏭ ${t.line.product} ${t.line.tag} 已存在：${t.existing.html_url}`); continue; }
      const body = bodyWithMapping(t.line, t.changelogBody, t.assets, await listBodies(t.slug), homeOf.get(t.slug));
      const rel = await giteaCreateRelease({
        repoSlug: t.slug, tag: t.line.tag, name: t.line.title, body,
        target: targetOf.get(t.slug), token: cred.token, baseUrl: R.baseUrl,
      });
      for (const a of t.assets) {
        await giteaUploadAsset({ repoSlug: t.slug, id: rel.id, name: a.name, data: readFileSync(a.abs), ...opts });
      }
      // 🔴 回頭查證，不聽上傳步驟說「我成功了」（同 release-check 站的形狀）。
      //   掛檔失敗而頁面已經建好，是本輪最該擋的狀態：那就是 leo 看到的那種
      //   「有版本頁、附檔卻是原始碼快照」——只是換成「附檔根本沒上去」。
      const onPage = await giteaListAssets(t.slug, rel.id, opts);
      const missing = t.assets.filter((a) => !onPage.some((p) => p.name === a.name));
      if (missing.length) {
        throw new Error(
          `${t.line.title} 的版本頁建好了，但成品沒掛上去：${missing.map((m) => m.name).join('、')}\n` +
          `     頁面已存在於 ${rel.html_url} ⇒ 請確認後補掛或刪除該筆，不要留一個點下去沒東西的版本頁。`);
      }
      made.push(`版本發佈｜${t.line.title} → ${t.slug}：${rel.html_url}（成品 ${onPage.length} 個：${onPage.map((p) => p.name).join('、')}）`);
    }
    detail.unshift(...made);
    return { status: 'done', detail };
  }

  // ── host=github（prod）：對外那一份（以下與 2026-08-10 版一字未改，只換了欄位名）──
  const G = R;

  // 逐條線先算好再動手（理由同 gitea 那半：不留半套狀態）。
  // 查詢是**匿名唯讀**——D20 2026-08-10 簡化：讀一律放行、沒有頻率閘。
  // tag 與內文都要餵——理由同 gitea 那半（內部號可能寫在 tag_name 上）。
  // 🔴 D95：這一半同樣改成**逐條線各發各的 repo**（形狀與 gitea 那半刻意一模一樣）。
  const ghBodiesOf = new Map();
  const ghListBodies = async (slug) => {
    if (!ghBodiesOf.has(slug)) {
      ghBodiesOf.set(slug, (await ghListReleases(slug).catch(() => []))
        .map((r) => `${r.tag_name || ''}\n${r.body || ''}`));
    }
    return ghBodiesOf.get(slug);
  };
  const todo = [];
  for (const line of lines) {
    const entry = repoForLine(line.id, G);   // 缺宣告就丟——不退回 G.repoSlug
    const slug = entry.repoSlug;
    let existing = null;
    for (const cand of tagCandidates(line)) {
      existing = await releaseExists(slug, cand).catch((e) => {
        throw new Error(`查詢 ${slug} 是否已有 release ${cand} 失敗（不放行，寧可手動確認也不要建出重複的）：${e.message}`);
      });
      if (existing) break;
    }
    if (existing) { todo.push({ line, entry, slug, existing }); continue; }
    const changelogBody = releaseSectionFor(REPO_ROOT, line.version);
    if (!changelogBody) {
      throw new Error(
        `說明文件裡沒有 ${line.version}（${line.product}）這一版可以當作 release 內容（該補在 ${changelogRelFor(REPO_ROOT, line.version)}）。\n` +
        `     這不是「先跳過、之後再補」——少了這一步，使用者點「完整發佈紀錄」永遠是空白。\n` +
        `     🔴 而「先出貨、之後再補」正是 daemon 斷更四版的走法（#88）。`);
    }
    todo.push({ line, entry, slug, assets: assetsOf(line), changelogBody });
  }
  if (todo.every((t) => t.existing)) {
    return { status: 'skip', detail: todo.map((t) => `GitHub 已有 ${t.line.tag}（${t.line.product}）：${t.existing.html_url}`) };
  }

  // ① 先把公開鏡像（.github-public/）更新到目前 HEAD——scripts/publish-github.sh 本來就有
  //   這個機制，只是出貨管線從沒呼叫過它，鏡像因此停在最後一次有人手動跑的那天。
  shLive('bash', [join(REPO_ROOT, 'scripts', 'publish-github.sh')], REPO_ROOT);
  const mirrorDir = join(REPO_ROOT, G.mirrorDir);
  const mirrorSha = sh('git', ['rev-parse', 'HEAD'], mirrorDir);

  // ② 保險（未過期）＋ push 鏡像＋自己留痕——與 `push` 步驟同一套規矩，理由同它的註解。
  const { mission } = checkArmed(INKSTONE_ROOT);
  const token = process.env.GITHUB_MIRROR_TOKEN || '';
  if (!token) {
    throw new Error(
      `缺 GITHUB_MIRROR_TOKEN（環境變數）。D36 金鑰鐵律：本步驟只讀名字，不落地、不印真身，\n` +
      `     真身要在啟動這支管線的 shell 裡先 export——查 system-dev/wiki/credentials-map.md 找這把鑰匙在哪。`);
  }
  const authB64 = Buffer.from(`${process.env.GITHUB_ACCOUNT_NAME || 'git'}:${token}`).toString('base64');
  // 🔴 人閘（InkStoneCo#56）：這一行的目標寫死就是 `main`。D20 的保險（leo 開的）
  //   管的是「可不可以碰 GitHub」，這一枚戳記管的是「可不可以覆寫這個 repo 的 main」
  //   ——兩件事，兩道閘，不互相取代。
  //   ⚠️ 交給閘的 argv 刻意**不帶** `-c …extraheader=…`：那串是權杖（D36 值不落地），
  //   而閘會把 argv 寫進請求檔與留痕。少了它不影響判斷（目的地與分支都還在）。
  assertPushAllowed({
    args: ['push', G.mirrorRemote, 'HEAD:refs/heads/main'], cwd: mirrorDir,
    remoteUrl: G.mirrorRemote, who: 'ship.mjs／推 GitHub 公開鏡像',
    grants: ctx.mainPushGrants,
  });
  sh('git', ['-c', `http.${G.mirrorRemote}.extraheader=Authorization: Basic ${authB64}`,
    'push', G.mirrorRemote, 'HEAD:refs/heads/main'], mirrorDir);
  try {
    logGithubContact(INKSTONE_ROOT, mission, `push 公開鏡像 → ${G.repoSlug}（HEAD ${mirrorSha.slice(0, 7)}）`);
  } catch (e) {
    console.error(`❌❌❌ push 成功了，但寫入 github-contact-log.md 失敗：${e.message}`);
  }

  // ②.5 🔴 D95：源碼住在自己 repo 的那些線，把源碼同步過去，並用**那邊的** sha 當 target。
  //   形狀與 gitea 那半一模一樣（刻意），只有認證方式不同：
  //   GitHub 這側用 GITHUB_MIRROR_TOKEN 組網址（D36：只在這裡組，不落地不印出）。
  //   D20：這是寫入 GitHub ⇒ 走上面同一次保險（checkArmed 已過），且逐筆留痕。
  const targetOf = new Map();
  const homeOf = new Map();
  for (const t of todo) {
    if (t.existing || targetOf.has(t.slug)) continue;
    if (!livesInOwnRepo(t.entry)) {
      targetOf.set(t.slug, mirrorSha);
      homeOf.set(t.slug, { repoName: repoNameOf(t.slug), repoSlug: t.slug, commit: headShaFull });
      continue;
    }
    const authed = t.entry.remote.replace(/^https:\/\//,
      `https://${process.env.GITHUB_ACCOUNT_NAME || 'git'}:${token}@`);
    const sync = syncSourceRepo({
      srcRoot: REPO_ROOT,
      sourceDir: t.entry.sourceDir,
      workDir: t.entry.workDir,
      remoteUrl: authed,
      branch: t.entry.branch || 'main',
      destOwned: t.entry.destOwned || [],
      // preflight 領到的推 main 授權（InkStoneCo#56）——沒有它這一步會當場被閘擋下
      guardOpts: { grants: ctx.mainPushGrants },
      message: `sync: ${t.entry.sourceDir}/ 同步自 ${G.repoSlug}@${headShaFull.slice(0, 7)}（${t.line.product} ${t.line.tag}）`,
    });
    try {
      logGithubContact(INKSTONE_ROOT, mission,
        `同步 ${t.entry.sourceDir}/ → ${t.slug}（${sync.changed ? '有變更' : '無變更'}，${sync.files} 個檔`
        + `${sync.skipped && sync.skipped.length ? `，${sync.skipped.length} 個建置產物被目的 repo 的 .gitignore 擋下` : ''}`
        + `，HEAD ${sync.sha.slice(0, 7)}）`);
    } catch (e) {
      console.error(`❌❌❌ 同步成功了，但寫入 github-contact-log.md 失敗：${e.message}`);
    }
    targetOf.set(t.slug, sync.sha);
    homeOf.set(t.slug, { repoName: repoNameOf(t.slug), repoSlug: t.slug, commit: sync.sha });
  }

  // ③ 逐條線建 release（target_commitish 指到剛推上去的那個 sha，tag 不存在時 GitHub 會自動建出來）
  const made = [];
  for (const t of todo) {
    if (t.existing) { made.push(`⏭ ${t.line.product} ${t.line.tag} 已存在：${t.existing.html_url}`); continue; }
    const body = bodyWithMapping(t.line, t.changelogBody, t.assets, await ghListBodies(t.slug), homeOf.get(t.slug));
    const rel = await createRelease({
      repoSlug: t.slug, tag: t.line.tag, name: t.line.title, body, targetCommitish: targetOf.get(t.slug), token,
    });
    try {
      logGithubContact(INKSTONE_ROOT, mission, `建立 release ${t.line.tag}（${t.line.product}） → ${rel.html_url}`);
    } catch (e) {
      console.error(`❌❌❌ release 建立成功了，但寫入 github-contact-log.md 失敗：${e.message}`);
    }
    // 把這一版的成品掛上去（理由與 gitea 那半一字不差：不留「點下去給錯東西」的版本頁）。
    // D20：這是寫入 GitHub ⇒ 與建 release 同一次保險（上面 checkArmed 已過）、同樣逐筆留痕。
    for (const a of t.assets) {
      await ghUploadAsset({ uploadUrl: rel.upload_url, name: a.name, data: readFileSync(a.abs), token });
      try {
        logGithubContact(INKSTONE_ROOT, mission, `掛成品 ${a.name} → release ${t.line.tag}`);
      } catch (e) {
        console.error(`❌❌❌ 附件掛上去了，但寫入 github-contact-log.md 失敗：${e.message}`);
      }
    }
    // 回頭查證（匿名唯讀），不聽上傳步驟說「我成功了」。
    const onPage = await ghListAssets(t.slug, rel.id);
    const missing = t.assets.filter((a) => !onPage.some((p) => p.name === a.name));
    if (missing.length) {
      throw new Error(
        `${t.line.title} 的 release 建好了，但成品沒掛上去：${missing.map((m) => m.name).join('、')}\n` +
        `     頁面已存在於 ${rel.html_url} ⇒ 請確認後補掛或刪除該筆，不要留一個點下去只有原始碼快照的版本頁。`);
    }
    made.push(`release｜${t.line.title} → ${t.slug}：${rel.html_url}（成品 ${onPage.length} 個：${onPage.map((p) => p.name).join('、')}）`);
  }

  return { status: 'done', detail: [...made, `鏡像 HEAD：${mirrorSha.slice(0, 7)}`] };
}},

// ── release-check：`release-record` 的**後置條件驗證**（inkstone/arcrun-rag#88，2026-08-18）──
//
// 與 `daemon-sync`→`daemon-check` 同一個形狀：上一站負責「做」，這一站負責
// **回頭去問那個真的會被人看的地方，東西在不在**。不聽上一站說「我建好了」，
// 重新向 host 查一次現況——這是 CP 判準「宣稱通了要貼實測輸出」的機械版。
//
// 🔴 為什麼光有 release-record 的逐條發還不夠：那一站只在「這趟出貨真的跑到它」時
//   才會動。而 daemon 斷更四版期間，出貨線**每一趟都跑到了它**，它只是發錯東西。
//   ⇒ 需要一個**不看上一站做了什麼、只看事實**的判準：
//     「使用者端讀得到的每一個版本號，在產品 repo 都找得到對應的版本發佈嗎？」
//
// 這一站同時擋第二種形狀——**發在沒人看的地方**（2026-08-09 的 v0.18.25 就是這樣消失的：
// 它發在 `arcrun-rag-bundles`，一個放編譯產物給 jsDelivr 取用的倉庫）。
// 只驗「有沒有發」的話，那筆是綠的。判準要包含「**發到對的地方**」。
//
// mutates:false ⇒ 預演（不加 --confirm）也會跑；但它查的是「已經發佈了沒」，
// 預演時 release-record 還沒動作，所以**預演時只跑不需要網路的兩項**（落點＋覆蓋），
// --confirm 才跑第三項。這不是放水：第三項在預演時必然為假，硬跑只會製造必然的紅燈。
{ id: 'release-check', title: '回頭查證：每條版本線在產品 repo 都真的有版本發佈（不聽上一站說）', mutates: false, async run() {
  const R = T.releaseRecord;
  const manifestPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(manifestPath)) return { status: 'skip', detail: ['manifest.json 還不存在（首次播種前）'] };
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // 交付面投影：只取使用者端真的會讀到的那兩個欄位（＝/api/latest 的形狀），
  // 不整份餵——manifest 裡的 `promoted_from.release` 是歷史帳，餵進去會被誤判成第三條線。
  const latestPayload = { release: m.release, daemon: m.daemon ? { version: m.daemon.version } : undefined };

  const publishedTags = CONFIRM ? await fetchPublishedTags(T, { root: REPO_ROOT }) : null;
  const result = runReleaseLineGate({ targetName: TARGET_NAME, target: T, latestPayload, publishedTags });

  // 留痕：擋下與放行都記（InkStoneCo#48——36 支閘只有 2 支會記錄自己擋了什麼，
  // 沒有成效紀錄就無法知道這道閘到底有沒有在運作）。
  try {
    appendReleaseLineGateLog(join(REPO_ROOT, RELEASE_LINE_GATE_LOG_REL), {
      ts: releaseLineGateStamp(), targetName: TARGET_NAME, result,
    });
  } catch (e) {
    console.error(`⚠️ 閘跑完了，但寫入 ${RELEASE_LINE_GATE_LOG_REL} 失敗：${e.message}`);
  }

  if (!result.ok) {
    throw new Error(
      `版本線與版本發佈對不上（${releaseDestinations(R).map(([id, s]) => `${id}→${s}`).join('、') || '未宣告落點'}）：\n`
      + result.sections.filter((s) => !s.ok).flatMap((s) => s.problems).map((p) => `     - ${p}`).join('\n'));
  }
  return { status: 'done', detail: result.sections.map((s) => `${s.skipped ? '⏭' : '✔'} ${s.name}：${s.detail}`) };
}},
];

// ── 安裝器原始碼的內容指紋（arcrun-rag#95）────────────────────────────────
// 排除 DEFAULT_BUNDLE_BASE／BUNDLE_BUILT 這兩個「本站自己會改寫」的常數——
// 不排除的話指紋會被自己這次要寫入的值影響，變成每次出貨都在追自己的尾巴
// （跟 release.mjs 排除 built/release/source 自己是同一個理由：見該檔檔頭）。
// 其餘所有邏輯／文案／流程改動都會反映在這裡，這正是**跳過判準少看的那一塊**。
function installerSourceHash(jsPath) {
  const src = readFileSync(jsPath, 'utf8')
    .replace(/const DEFAULT_BUNDLE_BASE = '[^']*'/, "const DEFAULT_BUNDLE_BASE = ''")
    .replace(/const BUNDLE_BUILT = '[^']*'/, "const BUNDLE_BUILT = ''");
  const h = createHash('sha256').update(src);
  // 🔴 2026-08-25（inkstone/Arcrun#159）：這裡原本**只雜湊 worker.js**。
  //   但安裝器實際執行的 D1 schema 來自它 import 的 `migrations.json`
  //   ⇒ migration 改了、指紋不變 ⇒ deploy 站判定「安裝器原始碼未變、不用重部」
  //   ⇒ **新的 migration 永遠上不了線**。把它一起算進指紋。
  const migPath = join(dirname(jsPath), 'migrations.json');
  if (existsSync(migPath)) h.update(readFileSync(migPath, 'utf8'));
  return h.digest('hex');
}

/**
 * 出貨前確認：安裝器帶出去的 migration ＝ Arcrun kbdb `migrations/` 底下的**全部**。
 *
 * 🔴 為什麼要有這一站（2026-08-25 實錄，leo 的正式實例當場登不進去）：
 *   `compile-migrations.mjs` 底下曾經寫死 `['0001_base.sql','0002_credentials.sql']`，
 *   而且它的輸出寫到 `installer/src/migrations.json`——**worker.js 讀的卻是
 *   `oauth-prototype/migrations.json`**，那是一份手抄的舊副本。
 *   ⇒ 0003～0007 從來沒有被打進任何一次出貨；每個用一鍵安裝的人，資料層都停在 0002。
 *   ⇒ worker 一路更新到最新，讀 v7 才有的 `src_id`／`rel_id`／`dst_id`
 *     ⇒ `no such column` ⇒ 整個知識庫 500，而 `/health` 照回 `ok: true`。
 *   leo 原話：「任何人安裝了下一版都要有前一版的遷移，這是非常大的失誤，一定不止我」
 *            「更新沒有政策？根本亂搞」
 *   ⇒ 三層都補了（動態收檔／輸出位置對上／指紋含它），這一站是第四層：**出貨前機械複驗**。
 */
function assertMigrationsComplete(installerCwd, arcrunRoot) {
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

// ── wrangler.toml 的分段變數寫入（只在指定的 section 內動，不誤傷別段）──────
function setTomlVar(toml, section, key, value) {
  const header = section === 'vars' ? '[vars]' : `[${section}]`;
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) throw new Error(`wrangler.toml 找不到 ${header} 段——登錄簿的 varsSection 與實際設定對不上`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = start + 1; i < end; i++) {
    if (re.test(lines[i])) { lines[i] = `${key} = "${value}"`; return lines.join('\n'); }
  }
  lines.splice(end, 0, `${key} = "${value}"`);
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// 執行：固定順序、失敗即停
// ══════════════════════════════════════════════════════════════════════════
// --verify-only：把步驟表濾成**只剩驗收那一步**（它本來就是 mutates:false）。
// 不動步驟表本身 ⇒ 出貨路徑的順序與內容完全沒被這個模式碰到。
// --delivery-only 同理，濾成只剩送達收斂那一站（arcrun-rag#79）。
const RUN_STEPS = VERIFY_ONLY ? STEPS.filter((s) => s.id === 'verify')
  : DELIVERY_ONLY ? STEPS.filter((s) => s.id === 'purge')
  : RELEASE_RECORD_ONLY ? STEPS.filter((s) => s.id === 'release-record')
  : STEPS;

// ── 站表閘：在任何東西被改動之前跑（Leo/arcrun-rag#77，leo 2026-08-11）─────────
// leo：「**站表是一份人看得懂的清單**；每一站實際做事的那段，要是 Arcrun 的零件／工作流。」
// D65 補②（leo 08-11 下午）：「**『有幾站』本身也該在那份檔裡**，不是散在程式碼。」
//
// 這道閘讓那份清單**不只是文件**：站表與步驟表對不上、產出物沒人處理、
// 或某一站宣告留在本機卻沒寫理由（D70 明文要求），一律 exit 2——**在 preflight 之前**，
// 所以連「線上現況」都還沒去讀，什麼都還沒動。
// 🔴 `--verify-only` 也要過這道閘：它濾掉的是要跑哪幾步，不是「站表可以不成立」。
const STATIONS = (() => {
  try {
    return requireStations(REPO_ROOT, STEPS.map((s) => s.id));
  } catch (e) {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(2);
  }
})();

console.log(VERIFY_ONLY ? '━━━ Arcrun RAG 出貨驗收（只驗，不出貨）━━━' : '━━━ Arcrun RAG 出貨管線 ━━━');
console.log(`目標　${TARGET_NAME}｜${T.label}`);
console.log(`站表　${STATIONS['站'].length} 站　✓ 與步驟表逐項相符（${STATIONS_REL}）｜機器 ${machineId()}`);
console.log(`　　　這條線宣告**單機走完**（stage 與 prod 同一台）——換機器接力會在出貨前被擋下`);
// 站表宣告的工作流**必須真的在 leo 那台實例上**——不然「用什麼: ship_check_live」
// 只是一句話，工作流被刪掉了管線照跑照綠（D70 要擋的正是宣告與現實脫節）。
const ARCRUN_WFS = arcrunWorkflows(STATIONS);
let arcrunNote = '（無）';
if (ARCRUN_WFS.length) {
  try {
    const { base, ns } = await assertWorkflowsExist(ARCRUN_WFS);
    arcrunNote = `${ARCRUN_WFS.join('、')}　✓ 都在 ${base}（namespace ${ns}）`;
  } catch (e) {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(2);
  }
}
console.log(`Arcrun　這次會派給工作流做的活：${arcrunNote}`);
console.log(`模式　${VERIFY_ONLY
  ? '🔬 只驗收（--verify-only）：不建、不推、不部署、不蓋章；判定與 --confirm 同樣嚴格'
  : DELIVERY_ONLY
    ? `📦 只查送達（--delivery-only）：只跑送達收斂那一站，不建、不推、不部署${process.env[DRILL_ENV] ? `｜🔬 ${DRILL_ENV} 反向演練：期望值不可能達成，這一站**應該**判失敗` : ''}`
    : RELEASE_RECORD_ONLY
      ? '🏷  只留發佈紀錄（--release-record-only）：只跑那一站，不建、不推 bundle、不部署、不蓋章'
      : CONFIRM ? '⚡ 執行（--confirm）' : '🔎 預演（只做不改變外界的步驟；要真的走完加 --confirm）'}`);
console.log(`步驟　${RUN_STEPS.map((s) => s.id).join(' → ')}\n`);

let failedAt = null;
const results = [];
for (const [i, step] of RUN_STEPS.entries()) {
  const n = `${i + 1}/${RUN_STEPS.length}`;
  if (failedAt) { results.push({ id: step.id, title: step.title, status: 'not-run' }); continue; }
  if (step.mutates && !CONFIRM) {
    // 預演：取貨／算版本會寫本機工作目錄，但不推不部署 ⇒ 允許；其餘改變外界的一律不做。
    // `--delivery-only` 的整個存在理由就是**單獨跑那一站**，所以那一站在這個模式下要真的跑
    //   （它不 push 不 deploy；會碰到的只有送貨管道的作廢／重讀，而這個模式禁用在 publish 目標）。
    //   `--release-record-only` 同理（arcrun-rag#88）：它的整個存在理由就是單獨跑那一站。
    //   它會寫外界（建一筆 Gitea release、可能推一次出貨分支），但那是**這個模式被要求做的事**，
    //   而且 publish 目標已經在參數檢查那裡擋死 ⇒ 它到得了的地方只有內部 Gitea。
    const localOnly = step.id === 'fetch-artifacts' || step.id === 'version'
      || (DELIVERY_ONLY && step.id === 'purge')
      || (RELEASE_RECORD_ONLY && step.id === 'release-record');
    if (!localOnly) {
      console.log(`⏸  ${n} ${step.id}｜${step.title}`);
      console.log(`     預演不執行（加 --confirm 才會做）`);
      results.push({ id: step.id, title: step.title, status: 'planned' });
      continue;
    }
  }
  console.log(`▶  ${n} ${step.id}｜${step.title}`);
  try {
    const r = await step.run();
    const mark = r.status === 'skip' ? '⏭ 跳過' : '✅ 完成';
    console.log(`   ${mark}`);
    for (const d of [].concat(r.detail || [])) console.log(`     ${d}`);
    // 🔴 跳過的**理由**要進帳本（2026-08-11，#77 複驗抓到）。
    //   由來：1.4.37 那次 stage 有 9 站 skip，報告上全是 `⬜`；1.4.36 那次其中 5 站是 `done`。
    //   **站數沒變（19→19，表頭還寫「無增減」），內容卻變空了。**
    //   `⬜` 同時代表「這次沒事可做」與「這次沒做到」⇒ 等於把差別藏起來，
    //   而 leo 的判準是「**不對稱會自己現形**」。
    //   ⚠️ 修法**不動符號**：b998df4 當初就是刻意把 `⏭ 不需要做` 換成裸的 `⬜`
    //   （ship-report.test.mjs 有一條測試寫死「不准用安撫用語代替空格」）——
    //   把格子變好看正是被否決過的方向。改成**把理由記下來、印在表外**。
    results.push({
      id: step.id, title: step.title, status: r.status,
      note: r.status === 'skip' ? String([].concat(r.detail || [])[0] || '').trim() || null : null,
    });
  } catch (e) {
    console.log(`   ❌ 斷在這一步`);
    console.log(String(e.message).split('\n').map((l) => `     ${l}`).join('\n'));
    results.push({ id: step.id, title: step.title, status: 'failed' });
    failedAt = step.id;
  }
  console.log('');
}

console.log('━━━ 結果 ━━━');
for (const r of results) {
  const icon = { done: '✅', skip: '⏭', planned: '⏸', failed: '❌', 'not-run': '⛔' }[r.status];
  const note = { planned: '（預演未執行）', 'not-run': '（前面斷了，沒跑）', skip: '（不需要做）' }[r.status] || '';
  console.log(`   ${icon} ${r.id}${note ? '　' + note : ''}`);
}

// ── 出貨報告：左右對照表，出貨當下自動產生（D65 二次補述，leo 2026-08-11）───────
// leo：「按照出貨單，每次完成出貨就會看到一張表，左邊是 stage 10 站打勾，右邊是
//   prod 10 站打勾，就是一個出貨報告是立刻有的。」「立刻有的」＝管線自己產生，
//   不是事後由 AI 手寫——手寫會挑好聽的講，機器產的表沒得挑。
// 只在真的 `--confirm`（這才是「出貨」）才記；預演／--verify-only 不算一次出貨，
// 不寫進 ledger（否則「上次幾站」會被預演污染，變得不可信）。
// 即使斷在某一步也要記——斷在哪、記到哪，這正是報告要讓人一眼看到的東西。
if (CONFIRM && !VERIFY_ONLY && ctx.release) {
  const { recordRun, renderComparisonTable, reportPath, releaseCountsVerdict } = await import('./ship-report.mjs');
  recordRun(REPO_ROOT, {
    release: ctx.release, target: TARGET_NAME, results,
    sourceCommit: ctx.sourceCommit || null,
    // 機器指紋：`#72` 揭露 build 不可跨機器重現、驗證章綁機器 ⇒ `#77` 宣告單機走完。
    // recordRun 內部會拿它跟同一版另一個目標比對，不同就丟例外、不寫入、不放行。
    machine: machineId(),
  });
  const table = renderComparisonTable(REPO_ROOT, ctx.release);
  console.log('\n' + table + '\n');
  writeFileSync(reportPath(REPO_ROOT), table + '\n');
  console.log(`📋 已寫入 installer/ship-report.md ＋ installer/ship-report.json（記得跟這次出貨一起 commit）`);

  // ── 兩欄件數：不只印出來，對不齊就讓這次出貨是紅的（leo 2026-08-11 #77 驗收條件）──
  // 「暫存站有的，上架也有」——只印一行字讓人自己看，跟沒有是一樣的
  //   （同 arcrun-rag#73 缺②的教訓：「只做到看得到，沒做到不一致就斷」）。
  // 只出過一邊不算對不齊（另一邊還沒跑），那是 countsVerdict 自己的判準。
  const cv = releaseCountsVerdict(REPO_ROOT, ctx.release);
  if (!cv.ok) {
    console.log(`\n❌ 出貨報告的兩欄件數對不齊：${cv.note}`);
    console.log(`   一次出貨是一個版本，兩個理貨員的清單長度不同 ⇒ 有一邊少走了一站，不放行。`);
    process.exit(1);
  }
}

if (failedAt) {
  if (DELIVERY_ONLY) {
    console.log(`\n❌ 送達收斂未過：**${TARGET_NAME} 的送貨管道此刻不是這一版**（沒有出貨、沒有改任何東西）。`);
    if (process.env[DRILL_ENV]) {
      console.log(`   🔬 這次是反向演練（${DRILL_ENV}）——**失敗就是預期結果**：`);
      console.log(`      期望值刻意設成不可能達成，看得到它判失敗＝這道閘真的會叫，不是裝飾。`);
    }
    process.exit(1);
  }
  if (VERIFY_ONLY) {
    console.log(`\n❌ 驗收未過：**${TARGET_NAME} 線上此刻不成立**（沒有出貨、沒有改任何東西）。`);
    process.exit(1);
  }
  console.log(`\n❌ 出貨中止：卡在 **${failedAt}**，後面的步驟一步都沒跑。`);
  console.log(`   修好上面那條，重跑同一個指令即可（管線是冪等的，已做完的會自動跳過）。`);
  process.exit(1);
}

if (DELIVERY_ONLY) {
  if (process.env[DRILL_ENV]) {
    console.log(`\n❌ 反向演練沒有失敗——這比失敗更糟：期望值是不可能達成的字串，它卻說收斂了。`);
    console.log(`   ⇒ 這道閘現在會放行任何東西，等於不存在。先修它，再談出貨。`);
    process.exit(1);
  }
  console.log(`\n✅ 送達收斂通過｜${TARGET_NAME} 的送貨管道此刻就是 release ${ctx.release}｜daemon ${ctx.daemonVersion}`);
  console.log(`   （只查證送達，沒有出貨、沒有改任何東西）`);
  process.exit(0);
}

if (RELEASE_RECORD_ONLY) {
  // 裸號（leo 2026-08-17「不要 v」）——這行印的是**出貨線自己對 leo 的回報**，
  // 帶著 v 就是在他的驗收介面上重新製造那個他剛要求拿掉的東西。
  console.log(`\n✅ 發佈紀錄就位｜${TARGET_NAME} 的 ${T.releaseRecord.host} ${T.releaseRecord.repoSlug} 上有 ${ctx.release} 這一版`);
  console.log(`   （只留紀錄，沒有出貨、沒有建 bundle、沒有部署任何東西）`);
  process.exit(0);
}

if (VERIFY_ONLY) {
  console.log(`\n✅ 驗收全過｜${TARGET_NAME} 線上是 release ${ctx.release}｜daemon ${ctx.daemonVersion}`);
  console.log(`   （只驗收，未出貨；要出貨是 --confirm，且 publish 目標需 leo 先開 D20 保險）`);
  process.exit(0);
}

if (!CONFIRM) {
  console.log(`\n🔎 預演結束｜這次會出的版本是 **${ctx.release}**`);
  console.log(`   真的要走完：node installer/scripts/ship.mjs --target ${TARGET_NAME} --confirm`);
  process.exit(0);
}

console.log(`\n✅ 出貨完成｜release ${ctx.release}｜daemon ${ctx.daemonVersion}`);
if (T.verify) {
  console.log(`   用戶端入口：${T.verify.installerBase}`);
  console.log(`   🔴 最後一關是機器驗不了的：**用瀏覽器真的載一次** portal／安裝頁，`);
  console.log(`      看有沒有紅色錯誤橫幅、console 有沒有紅字（curl | grep 不算，08-08 就是這樣漏掉的）。`);
}
// 驗過的憑據由**管線自己移動釘子分支**，不是人手 touch——手動移動的分支證明不了任何事
// （2026-08-11，取代 `/tmp/.stage-verified` 那張 JSON 驗證章，見 `source-pin.mjs` 檔頭；
// 拆 promoteFrom 的一部分，D65 三次補述，arcrun-rag#73 缺③）。
// 分支名固定是 `ship/verified-<這個目標>`：任何成功走完 --confirm（含 verify 全過）的
// 非 selftest 目標都移動自己的分支——不必事先知道會不會有別的目標拿它當 requireSourceBranch，
// 移動這個分支本身零成本、零副作用（只在 Arcrun repo 本機動，不推遠端）。
if (T.bundles.remote !== 'local-selftest') {
  const pinBranch = `ship/verified-${TARGET_NAME}`;
  const before = branchTip(ctx.arcrunRepo, pinBranch);
  setBranchTip(ctx.arcrunRepo, pinBranch, ctx.arcrunHeadSha);
  console.log(`   🎫 釘子分支 \`${pinBranch}\` → ${ctx.arcrunHeadSha.slice(0, 7)}` +
    (before && before !== ctx.arcrunHeadSha ? `（原本 ${before.slice(0, 7)}）` : before ? '（沒動，已經是這顆）' : '（新建）'));
}
