/**
 * ship-github-release.mjs — release-record 站怎麼把「GitHub 版本發佈寫入」交給 Arcrun 工作流
 *
 * ── 為什麼（inkstone/arcrun-rag#298，leo 2026-11-09 裁定選 B）─────────────────────
 * 雲端 session 的出口代理對 `POST /repos/<owner>/<repo>/releases` 一律 403（平台政策，與 token 無關；
 * 同一把 token 讀 releases 回 200）。leo：「要讓雲端可以發佈 release，**你出示 arm 同意就可以發佈**。」
 * ⇒ 寫入搬到容器外的 Arcrun 工作流 `ship_github_release`（workflows/ship_github_release.json），
 *   與 `ship_check_live`／`ship_refresh_cdn` 同形狀；**進場條件＝出貨線出示 leo 對這一版的 AHub ARM**。
 *
 * 兩道閘各守一側，不互相取代：
 *   · 這支（呼叫端）：沒有 ARM 證據就**不呼叫**（fail-closed，連網路都不打）
 *   · 工作流 gate 節點：證據不齊就**拒絕**（簽核人要是 Leo、ARM 版本＝這趟出貨版本、出處要指到那則留言）
 * ARM 證據本身來自 ship.mjs 的 version 站（`checkArmedViaTicket` → AHub 簽核看板），這裡只負責帶著走。
 *
 * 金鑰：這支與工作流定義裡都沒有 token（D36）——`{{credential.github_release_token}}` 由 credential 中心回填。
 */

/** 工作流 contract 版本；不符＝實例上還是舊版／沒部署，直接叫人重新部署，不當成網路問題。 */
export const WORKFLOW_NAME = 'ship_github_release';
export const WORKFLOW_CONTRACT = 'v1';
export const MAX_TEXT_ASSET_BYTES = 1_500_000;

const TEXT_TYPES = { '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown' };

/**
 * 從 `checkArmedViaTicket` 的回傳整理出「要出示的 ARM 證據」。
 * 沒有簽核留言（例如走備援簽核、comment 是 null）⇒ 回 null，呼叫端據此拒絕——工作流要求能指到那則留言。
 */
export function armEvidenceFrom(result, shipVersion) {
  if (!result || !result.armed || !result.comment || !result.comment.id) return null;
  const by = result.comment.user && result.comment.user.login;
  if (!by) return null;
  return { by: String(by), version: String(shipVersion), ref: `${result.ticketUrl}#issuecomment-${result.comment.id}` };
}

function requireArm(arm, what) {
  if (!arm || !arm.by || !arm.version || !arm.ref) {
    throw new Error(
      `${what}需要 leo 對這一版的 ARM 簽核證據，現在沒有（版本／簽核人／出處缺一）。\n` +
      `     🔴 沒有 ARM 就不建、不掛——這是 leo 2026-11-09 在 inkstone/arcrun-rag#298 定的進場條件。\n` +
      `     → 照 AHub 的簽核 guide 為這一版請簽核（出貨票底下），簽完重跑同一個指令（管線冪等）。`);
  }
}

function unwrap(out, what) {
  if (!out || typeof out !== 'object') throw new Error(`${what}：工作流 ${WORKFLOW_NAME} 回的東西看不懂：${JSON.stringify(out).slice(0, 200)}`);
  if (out.contract !== WORKFLOW_CONTRACT) {
    throw new Error(
      `${what}：實例上的 ${WORKFLOW_NAME} 不是 contract ${WORKFLOW_CONTRACT}（讀到：${out.contract === undefined ? '(沒有)' : out.contract}）。\n` +
      `     ⇒ 實例上還是舊版或沒部署：把 workflows/${WORKFLOW_NAME}.json 部署到出貨線打的那台實例（ship.targets.json 的 workflowHost）。`);
  }
  if (out.refused) throw new Error(`${what}：工作流拒絕動作（ARM 證據不齊）：\n       • ${(out.errors || []).join('\n       • ')}`);
  if (!out.ok) {
    throw new Error(`${what}：GitHub 沒有接受（${out.http_error || '原因不明'}）${out.response_body ? `｜${out.response_body}` : ''}`);
  }
  return out;
}

/** 建 release。回 `{ id, html_url, upload_url, tag_name }`。 */
export async function createReleaseViaArcrun({ runWorkflow, repoSlug, tag, name, body, targetCommitish, shipVersion, arm }) {
  const what = `建立 release ${tag}（${repoSlug}）`;
  requireArm(arm, what);
  const out = unwrap(await runWorkflow(WORKFLOW_NAME, {
    op: 'create_release', ship_version: shipVersion, arm, repo_slug: repoSlug,
    tag, name, body, target_commitish: targetCommitish,
  }, { timeoutMs: 120000 }), what);
  if (!out.release || !out.release.id) throw new Error(`${what}：工作流說成功，卻沒有 release id（不放行）`);
  return out.release;
}

/** 掛文字成品（例如零件包線的 manifest.json）。二進位／大檔不走這條路——丟清楚的例外。 */
export async function uploadAssetViaArcrun({ runWorkflow, repoSlug, releaseId, name, data, shipVersion, arm }) {
  const what = `掛成品 ${name} → ${repoSlug} release ${releaseId}`;
  requireArm(arm, what);
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const contentType = TEXT_TYPES[ext];
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const text = buf.toString('utf8');
  if (!contentType || Buffer.from(text, 'utf8').compare(buf) !== 0 || buf.length > MAX_TEXT_ASSET_BYTES) {
    throw new Error(
      `${what}：這個檔不能經工作流掛（只收 ≤${MAX_TEXT_ASSET_BYTES / 1e6} MB 的 .json／.txt／.md 文字檔；` +
      `${name} ${buf.length} bytes）。\n     → 二進位成品（dmg／exe／msix）的 GitHub release 由有寫入權限的環境補（地端），` +
      `或先把安裝檔改放 R2、release 內文列下載網址（attachAssets:false，stage 已這樣做）。`);
  }
  const out = unwrap(await runWorkflow(WORKFLOW_NAME, {
    op: 'upload_asset', ship_version: shipVersion, arm, repo_slug: repoSlug,
    release_id: String(releaseId), asset_name: name, asset_content_type: contentType, asset_text: text,
  }, { timeoutMs: 120000 }), what);
  if (!out.asset || !out.asset.id) throw new Error(`${what}：工作流說成功，卻沒有 asset id（不放行）`);
  return out.asset;
}

/**
 * 一個成品能不能經工作流掛上 GitHub release（只收 ≤1.5MB 的 .json／.txt／.md 文字檔）。
 * 與 uploadAssetViaArcrun 的判準同一份——兩處各寫一次會漂，所以它直接用這支。
 */
export function attachableViaWorkflow(name, data) {
  const ext = (String(name).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!TEXT_TYPES[ext]) return false;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > MAX_TEXT_ASSET_BYTES) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').compare(buf) === 0;
}

/** 二進位成品（dmg／exe／msix）的下載網址：bundle repo 釘在這一版 commit 的 raw 網址（桌面 App 自己更新時讀的也是這條）。 */
export function rawAssetUrl(bundleSlug, sha, rel) {
  return `https://raw.githubusercontent.com/${bundleSlug}/${sha}/${String(rel).replace(/^\/+/, '')}`;
}

/**
 * prod（via arcrun）掛成品的計畫（inkstone/arcrun-rag#363 第 1 處）：
 *   · 工作流掛得上的（小文字檔）→ attach，照舊走 uploadAssetViaArcrun
 *   · 掛不上的（dmg／exe／msix，幾十 MB 的二進位）→ listed：**不上傳、不丟例外**，
 *     版本頁內文改列 bundle repo 的下載網址（那裡本來就是 prod 安裝檔的家，verify 站逐位元比對的也是它）。
 * 以前這裡一律硬上傳，遇到二進位就在第 23 站丟例外，每次 prod 都要人手動 `gh release upload`。
 * @param {{rel:string,name:string,abs?:string}[]} assets
 * @param {(a:object)=>Buffer} read   讀成品內容（測試注入）
 * @returns {{attach:object[], listed:object[], section:string}}
 */
export function planAssetUpload({ assets, bundleSlug, sha, read }) {
  const attach = []; const listed = [];
  for (const a of assets) (attachableViaWorkflow(a.name, read(a)) ? attach : listed).push(a);
  if (listed.length && (!bundleSlug || !/^[0-9a-f]{40}$/.test(String(sha || '')))) {
    throw new Error(`${listed.map((a) => a.name).join('、')} 掛不上 release（二進位／太大），要改列下載網址，但缺 bundle repo 或它的 40 碼 commit（slug=${bundleSlug || '(空)'}，sha=${sha || '(空)'}）——不發一個點下去沒東西的版本頁。`);
  }
  const section = listed.length
    ? `\n\n## 下載\n\n安裝檔放在 bundle repo（${bundleSlug}），不掛在這個頁面上（檔案太大，GitHub release 寫入走的工作流只收小文字檔）：\n\n${listed.map((a) => `- ${a.name}：${rawAssetUrl(bundleSlug, sha, a.rel)}`).join('\n')}\n`
    : '';
  return { attach, listed, section };
}
