// c14669（③ 總編輯）：章節（hub）超過 chapter_budget 時只產「提案」，不直接搬動
// 任何既有卡（紅線）。純機械組字，不呼叫 LLM——這一步只是把「超額多少、最近新加入
// 哪幾個成員」講清楚，實際要怎麼拆／要不要跟別的群合併，留給人或之後的總編輯輪讀。
function parse(b) { if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } } return b; }
var memberCount = parseInt(input.member_count, 10) || 0;
var budget = parseInt(input.chapter_budget, 10) || 10;
var titles = [];
try { titles = JSON.parse(input.member_titles_json) || []; } catch (e) { titles = []; }
var recent = titles.slice(-5);
var over = memberCount - budget;

var detail = '群 ' + String(input.cluster_id || '') + ' 目前有 ' + memberCount + ' 個成員，' +
  '超過章節預算 ' + budget + '（超額 ' + over + '）。最近加入的成員：' +
  (recent.length ? recent.join('／') : '（無標題資料）') + '。' +
  '建議：依主題把跟既有 hub 摘要偏離較大的成員另外拆成子群（split）；' +
  '若這群整體跟另一個既有群高度重疊，也可考慮改為 merge 到那一群。' +
  '此為提案，狀態 pending，未直接搬動任何既有卡或 hub。';

return {
  success: true,
  proposed_action: 'split',
  detail: detail,
  created_at: String(Math.floor(Date.now() / 1000))
};
