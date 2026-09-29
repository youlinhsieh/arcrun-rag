// inkstone/arcrun-rag#13 c15236：讓 read_criteria／read_group 能用 KBDB 的
// by-template 欄位過濾（inkstone/Arcrun#260 已交付：
// GET .../kbdb/records/by-template/<template>?field=use_type&value=X 只回該
// use_type），不再讀全部用途、進 decide 才在記憶體裡篩。
//
// 🔴 為什麼不能直接在 URL 裡寫 `{{input.use_type}}`：graph-executor 的
// interpolateString 對「呼叫端沒帶這個欄位」的模板**不是**回傳空字串，是把
// `{{input.use_type}}` 這串字面文字原封不動塞進查詢字串（跟 decide.js 的
// opt() 註解、c14949／c15011 撞到的坑同一個機制）。Gitea webhook 觸發的開票
// 路徑本來就不帶 use_type（decide 目前才在 JS 裡預設成 'ticket'）——如果
// read_group 的 URL 直接綁 `{{input.use_type}}`，開票路徑會查
// `value={{input.use_type}}` 這個不存在的字面值，一筆都撈不到，每張票都被
// decide 誤判成 new。
//
// 這個節點把「有沒有帶 use_type、沒帶要退回什麼預設值」這個判斷提到 read
// 之前，讓 read_criteria／read_group 的 URL 只代入一個保證解析過的字串，
// 不會再讓字面模板漏進查詢參數。判斷邏輯（opt() 與預設值）必須跟
// rag_cluster_auto_decide_node.js 裡同名的那份逐字一致——decide.js 仍然會
// 用同一套公式再算一次（給 write_membership／write_group 標記用），兩邊算出
// 來的值本該永遠相同；這裡不去 import decide.js，是因為兩個 code 節點各自
// 沙箱執行、彼此看不到對方的變數，只能各自維護一份，改一邊記得改另一邊。
function opt(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && /^\{\{[\s\S]*\}\}$/.test(v.trim())) return undefined;
  return v;
}

// criteria bucket 用的原始 use_type（cluster_criteria 記錄裡存的就是這個值，
// 例如 'ticket'／'wiki'／'mistakes'）。沒帶 → 退回舊行為 'ticket'。
var criteriaUseType = opt(input.use_type) ? String(opt(input.use_type)) : 'ticket';

// membership／group bucket 的 use_type：'ticket' 沿用歷史桶名 'ticket_auto'
// （裡面已經有真資料，不能改名破壞既有讀回），其他用途直接用原名。
var groupUseTypeBase = (criteriaUseType === 'ticket') ? 'ticket_auto' : criteriaUseType;

// inkstone/arcrun-rag#13 c15294（leo 09-28 裁決）：分群/hub/目錄要以「子庫」
// （KBDB 的 library）為邊界，只對 wiki 用途生效——這條公式必須跟
// rag_cluster_auto_decide_node.js 裡同名那段逐字一致（見該檔同段註解：
// 兩個 code 節點各自沙箱執行，只能各自維護一份）。這裡多算這一格是因為
// c15236 把 read_group／check_hub_exists 的伺服端過濾值改成讀
// resolve_use_type 算出來的 group_use_type——沒有子庫後綴的話，伺服端就只會
// 過濾出沒有子庫邊界的舊 'wiki' 桶，decide 看不到自己子庫的既有群，每張卡
// 都會被誤判成新群（跟 library 完全沒接上是同一種壞法，只是換一個位置）。
var libraryScope = opt(input.library) ? String(opt(input.library)) : '';
var groupUseType = (criteriaUseType === 'wiki' && libraryScope) ? (groupUseTypeBase + '__' + libraryScope) : groupUseTypeBase;

return {
  success: true,
  criteria_use_type: criteriaUseType,
  group_use_type: groupUseType
};
