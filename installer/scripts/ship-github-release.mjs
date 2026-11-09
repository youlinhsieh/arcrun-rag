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
