// c14669（③ 總編輯）：三選一——create_hub／propose_split／noop。
// 不是靠人工判定，靠上一步 decide 已經算好的 cluster_member_count 對比
// cluster_criteria 的 hub_threshold／chapter_budget（decide.js 讀法，沒設就 4／10）。
//
// 🔴 這輪實測抓到的真 bug：check_hub_exists 原本想沿用 c14569 那個 by-source 路由
// （GET /records/by-source/:template?field=&value=）查「這個 cluster_id 有沒有
// cluster_hub 記錄」，但那個路由**只認白名單內的 template**（PR #225 是為了 triplet
// 加的）——打 cluster_hub 會在路由層直接 404（連驗證都沒跑到，故意帶錯 token 一樣
// 404 而不是 401，證實是路由沒認得這個 template，不是認證的問題）。而 http_request
// 零件把非 2xx 一律當節點失敗，check_hub_exists 沒有 ON_FAIL 邊接住 ⇒ 整條「該不該
// 升格」的判斷從第一步就悄悄斷了，且現行引擎（Arcrun#254 部署前）不會讓這種斷點
// 波及外層 success，於是「查得到分群結果、但從沒升格出 hub」這件事完全不會報錯，
// 很容易被忽略（這輪一開始就撞到：連續兩批測試資料分群都對，hub 卻始終沒出現）。
// 修法：改用跟 read_criteria／read_membership 一致、已驗證能用的 by-template
// 路由（`__CYPHER_BASE__/kbdb/records/by-template/cluster_hub?limit=200`），
// 在這裡自己依 cluster_id 過濾，不依賴 by-source 這個窄路由。
function parse(b) { if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } } return b; }

var hubResp = parse(input.hub_check_body);
var hubRecs = (hubResp && Array.isArray(hubResp.records)) ? hubResp.records : [];
var myClusterId = String(input.cluster_id || '');
var matchedHub = null;
for (var hi = 0; hi < hubRecs.length; hi++) {
  var hv = hubRecs[hi].values || hubRecs[hi];
  if (hv.cluster_id === myClusterId) { matchedHub = hubRecs[hi]; break; }
}
var hasHub = !!matchedHub;
var hubIds = matchedHub ? [matchedHub.record_id] : [];

var memberCount = parseInt(input.cluster_member_count, 10) || 0;
var hubThreshold = parseInt(input.hub_threshold, 10) || 4;
var chapterBudget = parseInt(input.chapter_budget, 10) || 10;

// c14825（③ 總編輯，merge 提案）：票本文「章節預算超額必觸發 merge／split」——
// decide.js 已經算出「跟哪個既有群重疊度最高」（群 vs 群，只跟夠格當章節的群比較）。
// 🔴 已知限制（跟 hub_threshold／chapter_budget 同一個病，c14669 已誠實列過）：
// MERGE_SIM_THRESHOLD 目前也是寫死常數，不是 cluster_criteria 能覆寫的——這格
// 一樣不在 cluster_criteria 這個 template 宣告的 slots 清單裡，寫進去會被 KBDB
// 靜默丟掉（同一個 bug，不重複修，這裡先誠實沿用同款預設值處理法）。
var MERGE_SIM_THRESHOLD = 0.5;
var mergeCandidateClusterId = String(input.merge_candidate_cluster_id || '');
var mergeCandidateSimRaw = input.merge_candidate_sim;
var mergeCandidateSim = (mergeCandidateSimRaw === undefined || mergeCandidateSimRaw === null || mergeCandidateSimRaw === '')
  ? NaN : parseFloat(mergeCandidateSimRaw);

// merge 候選是否「也已經有 hub」——只跟已經升格過的章節合併才有意義（否則應該是
// 那個候選群自己先長到 hub_threshold 再說，不該讓一個還沒升格的群平白多一次
// 「被合併」的動作）。沿用同一份 check_hub_exists 讀回結果，不多打一次 API。
var mergeCandidateHub = null;
if (mergeCandidateClusterId) {
  for (var mi = 0; mi < hubRecs.length; mi++) {
    var mv = hubRecs[mi].values || hubRecs[mi];
    if (mv.cluster_id === mergeCandidateClusterId) { mergeCandidateHub = hubRecs[mi]; break; }
  }
}
var mergeCandidateHubTitle = mergeCandidateHub ? (mergeCandidateHub.values || mergeCandidateHub).title || '' : '';
var canMerge = !!mergeCandidateHub && !isNaN(mergeCandidateSim) && mergeCandidateSim >= MERGE_SIM_THRESHOLD;

var action = 'noop';
if (!hasHub && memberCount >= hubThreshold) action = 'create_hub';
else if (hasHub && memberCount > chapterBudget) action = canMerge ? 'propose_merge' : 'propose_split';

var titles = [];
try { titles = JSON.parse(input.member_titles_json) || []; } catch (e) { titles = []; }
var titleList = titles.map(function (t, i) { return (i + 1) + '. ' + String(t); }).join('\n');

// 給 workers_ai_chat 的 prompt——只有真的要 create_hub 時才會被用到（build_hub_card
// 只在 gate_create_hub 的 ON_TRUE 分支才會被呼叫），但這裡先組好，避免多一個節點。
//
// 🔴 c15417（總管實測抓到：LLM 摘要編了一道不存在的菜「惡魔雞」，真實成員「麻辣鍋」
// 反而沒列出）：目錄是拿來找東西的，列出不存在的成員比不列還糟。修法分兩層——
// ① 這裡明確禁止 LLM 自己列舉/提到任何具體成員名稱（下面 prompt 新增那句），
// ② finalize_hub_card_node.js 在 LLM 回應之後，用這裡傳過去的 titles（真實資料，
// 不是 LLM 猜的）機械附加一句「實際成員：...」，逐字對照 100% 準確，不依賴 LLM
// 有沒有聽話——雙重保險，就算 LLM 沒完全遵守 prompt，最終寫進 KBDB 的摘要文字
// 仍然是正確的。
var hubPrompt = '請根據以下 ' + memberCount + ' 篇同一群資料的標題，寫一張精簡的「群組摘要卡」' +
  '（正體中文）。直接輸出卡片本身，格式如下，不要任何前言、說明或英文草稿：\n' +
  '# <一個能代表這群主題的標題，10-20 字>\n## 摘要\n（2-4 句話，說明這群東西共同在講什麼、彼此的關聯、' +
  '有什麼共同價值或主題——不要條列或提到任何一個具體的標題/菜名/項目名稱，那份清單會由另一個機制' +
  '機械附加，你寫錯或漏列都會造成目錄指向不存在的東西）\n\n' +
  '這群的資料標題：\n' + titleList;

// 🔴 KBDB 的 /kbdb/records 寫入要求 values 全部是字串（"values must be an object of
// {slot: string}"，實測撞到——member_count/threshold/budget 這幾格原本是 JS number，
// 沒轉字串直接被模板塞進 post_toc_entry／post_split_proposal 的 body_json 就被 KBDB 拒寫）。
// 這裡一律 String() 過，跟 decide.js 既有欄位（sim/decided_at 等）的做法一致。
return {
  success: true,
  action: action,
  has_hub: hasHub,
  hub_record_id: hasHub ? hubIds[0] : '',
  member_count: String(memberCount),
  hub_threshold: String(hubThreshold),
  chapter_budget: String(chapterBudget),
  cluster_id: String(input.cluster_id || ''),
  use_type: String(input.use_type || ''),
  hub_prompt: hubPrompt,
  member_titles_json: input.member_titles_json,
  member_ids_json: input.member_ids_json,
  // c14825（③ 總編輯，merge 提案）新增欄位，給 build_merge_proposal 節點用：
  merge_candidate_cluster_id: mergeCandidateClusterId,
  merge_candidate_sim: isNaN(mergeCandidateSim) ? '' : String(mergeCandidateSim),
  merge_target_hub_title: mergeCandidateHubTitle
};
