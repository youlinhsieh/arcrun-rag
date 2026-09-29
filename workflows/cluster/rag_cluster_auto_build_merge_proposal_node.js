// c14825（③ 總編輯，承接 c14824「還沒通的」第 1 條）：跟 build_split_proposal 同一個
// 精神——只產「提案」，不直接搬動任何既有卡或 hub（紅線）。純機械組字，不呼叫 LLM：
// 這一步只是把「這群超額多少、偵測到跟哪個既有章節高度重疊、重疊到什麼程度」講清楚，
// 實際要不要真的合併、怎麼合併，留給人或之後的總編輯輪讀（同 build_split_proposal
// 的 detail 一貫做法：機械描述現況，不做決定）。
function parse(b) { if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } } return b; }
var memberCount = parseInt(input.member_count, 10) || 0;
var budget = parseInt(input.chapter_budget, 10) || 10;
var over = memberCount - budget;
var targetClusterId = String(input.merge_candidate_cluster_id || '');
var targetHubTitle = String(input.merge_target_hub_title || '');
var simRaw = input.merge_candidate_sim;
var simText = (simRaw === undefined || simRaw === null || simRaw === '') ? '未知' : String(simRaw);

var detail = '群 ' + String(input.cluster_id || '') + ' 目前有 ' + memberCount + ' 個成員，' +
  '超過章節預算 ' + budget + '（超額 ' + over + '）。偵測到與既有章節 ' + targetClusterId +
  '（hub 標題：「' + (targetHubTitle || '（無標題）') + '」）高度重疊，相似度約 ' + simText + '。' +
  '建議合併（merge）到該章節，而非另外拆分。' +
  '此為提案，狀態 pending，未直接搬動任何既有卡或 hub，兩邊 hub 與成員維持原狀，' +
  '待人工或之後的總編輯輪確認後再實際執行合併。';

return {
  success: true,
  proposed_action: 'merge',
  detail: detail,
  created_at: String(Math.floor(Date.now() / 1000))
};
