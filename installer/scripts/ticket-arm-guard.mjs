/**
 * ticket-arm-guard.mjs — leo 在載體票留一行 `ARM: <版本號>`，出貨線就認得出來
 *
 * ── 為什麼需要這支（inkstone/ISEP#30 comment 10739，2026-09-22，總管交辦）───────
 * 舊機制（`d20-guard.mjs` 的 `checkArmed()` + `.github-armed`）要 leo：
 *   ① 等總管跑 `scripts/gitea-arm-request.sh` 貼出一組一次性代碼
 *   ② 在票上回覆那組代碼
 *   ③ 等總管跑 `scripts/gitea-arm-check.sh --consume` 核對、寫出 `.github-armed`
 * 三段來回，而且 `.github-armed` 只在**這台機器**上有意義——leo 得等總管在場才能解鎖。
 *
 * 這支要達成的是單一動作：leo 直接在「該版本所在里程碑的 InkStoneCo 載體票」留一行
 *   ARM: 1.4.73
 * 出貨線自己把這一版**實際要出的版本號**（從它自己重打出來的 manifest 讀出，不接受
 * 呼叫端傳入——見 ship.mjs 的 `version` 站，`ctx.release` 就是這裡指的「實際要出的版本」）
 * 拿去跟票上的留言核對，核對過了才放行 GitHub 那一側的寫入動作。
 *
 * ── 放行的四個條件，缺一不可 ─────────────────────────────────────────────────
 *   ① 留言作者的 login **精確等於** `Leo`（不是 id、不是顯示名——那些會變，
 *      同一份判準複用 `scripts/lib/gitea-arm-common.sh` 的 `GITEA_ARM_APPROVER_LOGIN`）。
 *      總管／`claude-code` 帳號寫出一模一樣的文字**不算數**——這正是紅線
 *      「不准 AI 產生任何放行憑證」的機械版：AI 帳號寫的 `ARM:` 字面上再像，判定都是擋。
 *   ② 留言內文含**獨立一行** `ARM: <版本號>`（前後可有空白，行內其餘文字不影響），
 *      不接受「這句話提到 ARM 三個字」這種寬鬆比對（同 main-push-guard 的「封的是動作，
 *      不是字面」哲學倒過來用：這裡反而要**收緊**成一整行，因為這裡要放行的是動作）。
 *   ③ 那一行的版本號等於呼叫端傳進來的 `version`（正規化：去掉單一前導 `v`/`V`，
 *      其餘逐字比對）——leo 簽的是 1.4.72、這次實際要出 1.4.73 ⇒ 不算數，必須擋。
 *   ④ OWNER（`inkstone`）寫死、不接受任何覆蓋——與 `gitea-arm-common.sh` 同一條安全邊界，
 *      理由見該檔 2026-08-13 的攻擊測試記錄：bot 只要還在 `inkstone` org 底下，
 *      就沒有 admin 權限造出第二個 login 剛好叫 `Leo` 的帳號。
 *
 * ── 與舊機制的關鍵差異：不是一次性 nonce，是「版本號本身就是範圍」──────────────
 * 舊 `gitea-arm-check.sh` 的核准用一次就消耗掉（防重放）。這支**刻意不消耗**：
 * 「中途失敗重跑照樣認那則留言」是這次的驗收條件之一。之所以安全：
 *   · 版本號由**內容指紋**算出來（`release.mjs`），同一份內容永遠得到同一個版本號，
 *     重跑同一版本不會把不一樣的東西送出去；
 *   · 建 release 本身已經冪等（`releaseExists()` 先查再建，見 github-release.mjs／
 *     gitea-release.mjs），重跑不會建出重複的 release；
 *   · 一旦內容真的變了，版本號就會跳號，舊的 `ARM: 1.4.73` 對新算出來的 1.4.74
 *     不再匹配（判準③），leo 必須為新版本再留一行——**不會發生「簽一次、之後永遠有效」**。
 *
 * ── 設計 ─────────────────────────────────────────────────────────────────────
 * 純函式＋可注入 fetch（預設走 `fetch-retry.mjs` 的有界重試版，撐過 c10724 那種連線層
 * 掉包），理由與 `d20-guard.mjs`／`github-release.mjs` 一致：呼叫端才是真正碰網路、
 * 真正寫入的那個，這支只負責「讀＋判定」，本身不做任何寫入、不產生任何放行憑證檔案。
 */
import { withRetry, fetchWithRetry as defaultFetchWithRetry } from './fetch-retry.mjs';

/** 安全邊界：只認這個帳號名，不接受任何覆蓋——理由同 `scripts/lib/gitea-arm-common.sh`。 */
export const APPROVER_LOGIN = 'Leo';
/** 安全邊界：只認這個 org，不接受任何覆蓋——理由同上。 */
export const OWNER = 'inkstone';

export const GITEA_API_BASE_DEFAULT = 'https://git.uncle6.me';

/** 版本號正規化：去掉單一前導 `v`/`V`、去頭尾空白。兩邊都用同一支比，才不會各自為政。 */
export function normVersion(v) {
  return String(v ?? '').trim().replace(/^[vV]/, '');
}

/**
 * 從一則留言內文抓「獨立一行 ARM: <版本號>」。
 * 刻意要求整行只有這個宣告（去頭尾空白後比對），不接受「這句話裡提到 ARM」——
 * 判準③的收緊：這裡要放行的是動作，寬鬆比對＝容易被無關文字誤觸發或誤拒。
 * @returns {string|null} 抓到的版本號原文（未正規化），或 null（這則留言沒有這種行）
 */
export function extractArmLine(body) {
  const lines = String(body || '').split('\n');
  for (const raw of lines) {
    const m = raw.trim().match(/^ARM:\s*(\S+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 純函式：在一批留言裡找「Leo 簽的、版本對得上」的那一則。
 * 不碰網路，方便單元測試餵各種留言組合。
 * @param {Array<object>} comments Gitea `issues/{n}/comments` API 回傳的陣列
 * @param {string} version 呼叫端「實際要出的」版本號
 * @returns {{ ok: true, comment: object, signedVersion: string }
 *          | { ok: false, reason: 'no-arm-by-leo' | 'version-mismatch', signedVersions: string[] }}
 */
export function findArmMatch(comments, version) {
  const want = normVersion(version);
  const byLeo = (comments || []).filter((c) => c && c.user && c.user.login === APPROVER_LOGIN);
  const signed = [];
  for (const c of byLeo) {
    const v = extractArmLine(c.body);
    if (v == null) continue;
    signed.push(v);
    if (normVersion(v) === want) return { ok: true, comment: c, signedVersion: v };
  }
  return signed.length
    ? { ok: false, reason: 'version-mismatch', signedVersions: signed }
    : { ok: false, reason: 'no-arm-by-leo', signedVersions: [] };
}

/**
 * 分頁抓一張票的全部留言（Gitea 預設一頁 50 則，載體票是長期累積的 hub 票，
 * 到本次撰寫時已有 138 則 ⇒ 不能只抓第一頁）。有界：最多 `maxPages` 頁，
 * 避免票異常肥大時無限迴圈——真的超過上限，判定為「查不完整」，fail-closed。
 */
async function fetchAllComments({ owner, repo, issue, token, baseUrl, fetchImpl, maxPages = 20, pageSize = 50 }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}/api/v1/repos/${owner}/${repo}/issues/${issue}/comments?limit=${pageSize}&page=${page}`;
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `token ${token}`;
    const r = await fetchImpl(url, { headers });
    if (!r.ok) {
      throw new Error(`讀 ${owner}/${repo}#${issue} 的留言失敗：HTTP ${r.status}（第 ${page} 頁）`);
    }
    const batch = await r.json();
    if (!Array.isArray(batch)) {
      throw new Error(`讀 ${owner}/${repo}#${issue} 的留言：回應不是陣列（第 ${page} 頁）`);
    }
    out.push(...batch);
    if (batch.length < pageSize) return out; // 這頁沒滿 ⇒ 已經是最後一頁
  }
  throw new Error(`讀 ${owner}/${repo}#${issue} 的留言超過 ${maxPages} 頁還沒讀完——票異常肥大，fail-closed 不放行。`);
}

/**
 * 核心檢查：這一版（`version`）在載體票上有沒有 Leo 簽的 `ARM: <同一版>`。
 * 過不了就丟例外（fail-closed，訊息說明原因），過了回傳可供留痕用的資訊。
 *
 * @param {object} o
 * @param {string} o.version   🔴 必填——呼叫端**自己重打出來的 manifest** 算出的版本號，
 *                              不是使用者/CLI 傳進來的字串。呼叫端（ship.mjs）的責任是
 *                              確保這裡傳進來的就是 `ctx.release`，不是任何可被外部操控的值。
 * @param {string} [o.repo]    載體票所在 repo（inkstone org 底下），預設 InkStoneCo
 * @param {number} o.issue     載體票號
 * @param {string} [o.token]   Gitea 讀權杖。🔴 2026-09-22 實測：`inkstone/InkStoneCo` 是
 *                              **私有** repo（不是公開讀），沒帶 token 會回 HTTP 404
 *                              （Gitea 對私有資源刻意回 404 而非 401/403，避免洩露存不存在）。
 *                              呼叫端（ship.mjs）用既有的 `giteaWriteCredentialsFromRemote()`
 *                              取，不必另開一條路。公開 repo（若載體票搬去那種 repo）不帶也行。
 * @param {string} [o.baseUrl]
 * @param {typeof fetch} [o.fetchImpl] 預設走有界重試版（c10724），測試可換成假的
 */
export async function checkTicketArmed({
  version, repo = 'InkStoneCo', issue, token,
  baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = defaultFetchWithRetry,
}) {
  if (!version || typeof version !== 'string') {
    throw new Error('checkTicketArmed 缺 version（呼叫端必須傳自己 manifest 算出的版本號，不接受空值）。');
  }
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(`checkTicketArmed 的 issue 必須是正整數（收到：${JSON.stringify(issue)}）——載體票號設定在 ship.targets.json 的 armTicket.issue。`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(String(repo))) {
    throw new Error(`checkTicketArmed 的 repo 名格式不合法（收到：${JSON.stringify(repo)}）。`);
  }

  const comments = await fetchAllComments({ owner: OWNER, repo, issue, token, baseUrl, fetchImpl });
  const m = findArmMatch(comments, version);
  const ticketUrl = `${baseUrl}/${OWNER}/${repo}/issues/${issue}`;

  if (!m.ok) {
    if (m.reason === 'no-arm-by-leo') {
      throw new Error(
        `需要 ${APPROVER_LOGIN} 在載體票留一行 \`ARM: ${version}\`，但 ${ticketUrl} 上沒有任何一則來自 ` +
        `${APPROVER_LOGIN} 帳號、內含這種宣告的留言。\n` +
        `     🔴 只認 login 精確等於 \`${APPROVER_LOGIN}\` 的留言——別的帳號（含總管／claude-code）\n` +
        `        寫出一模一樣的文字都不算數，這是紅線「不准 AI 產生任何放行憑證」的機械版。\n` +
        `     → 請 leo 在該票回一行（獨立一行，前後不要加別的字）：\n\n` +
        `         ARM: ${version}\n`);
    }
    throw new Error(
      `${ticketUrl} 上有 ${APPROVER_LOGIN} 簽過 ARM，但版本對不上：leo 簽的是 ` +
      `${m.signedVersions.map((v) => `\`${v}\``).join('、')}，這次實際要出的是 \`${version}\`。\n` +
      `     🔴 版本號由出貨線自己從 manifest 讀出（不接受呼叫端傳入），對不上就是對不上——\n` +
      `        不會因為「反正都是同一票」就放行差一個版本號的東西。\n` +
      `     → 若這確實是要出的下一版，請 leo 在該票補一行：\n\n` +
      `         ARM: ${version}\n`);
  }

  return {
    armed: true,
    mission: `ARM: ${version}（${APPROVER_LOGIN} 簽於 ${ticketUrl}#issuecomment-${m.comment.id}，${m.comment.created_at}）`,
    comment: m.comment,
    ticketUrl,
  };
}

/** 供其他模組（例如需要自訂重試次數）直接複用同一套有界重試策略。 */
export { withRetry };
