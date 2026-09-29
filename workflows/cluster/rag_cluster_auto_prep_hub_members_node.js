// inkstone/arcrun-rag#13 c15294/c15323 第 4 點（leo 09-28 例句：「建立川菜 hub 卡，
// 與三個食譜卡建立雙向連結」）：hub 產生時，hub 卡本身要跟它的每個成員互相連結，
// 不能只有卡跟卡之間的「相關」（那是第 1 點做的，attach 時新舊卡互連）。
//
// 這裡把 hub_editor.data.member_ids_json（字串 JSON 陣列）解析成物件陣列，
// 讓後面的 `對每個 member` FOREACH 邊可以逐一取 `{{member.id}}`——跟
// rag-ingest-card.local.yaml 的 `parse_card >> 對每個 rel >> post_triplet`
// 同一個慣例（陣列欄位取複數名「members」，FOREACH 關鍵字取單數「member」）。
//
// 不做相似度計算、不叫 LLM、不打任何網路——純解析，理由同 build_split_proposal
// 系列：code 節點沒有 fetch，這步只準備資料給後面的 http_request 節點用。
function parse(b) { if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } } return b; }

// 🔴 這輪實測抓到的真限制（c15323 驗收時撞到）：FOREACH 迴圈裡的每個 `{{member.x}}`
// 參照解析得到，但迴圈以外的具名節點參照（例如 `{{finalize_hub_card.data.hub_title}}`）
// 在 FOREACH 分支裡**解析不到**，會原封不動印出字面 `{{finalize_hub_card.data.hub_title}}`
// 寫進 KBDB——跟這支引擎其他地方「未代入的模板字面文字」同一種病，只是這次是
// FOREACH 分支專屬的新變體（先前踩過的都是「呼叫端沒帶欄位」，這次是「迴圈外的
// 具名參照在迴圈內失效」）。修法：不要指望迴圈裡能讀到迴圈外的具名節點，把
// hub_title 一起塞進每個 member 物件（透過這支 code 節點的 input，本節點自己是
// finalize_hub_card 的直接下游，這一跳的具名參照沒有問題），下游的
// post_hub_link_fwd/post_hub_link_back 一律用 `{{member.hub_title}}`，不要再用
// `{{finalize_hub_card.data.hub_title}}`。
var hubTitle = String(input.hub_title == null ? '' : input.hub_title);
var raw = parse(input.member_ids_json);
var ids = Array.isArray(raw) ? raw : [];

// c15345（總管裁決：目錄真身是 00-INDEX 卡）：hub 成型時，這個庫的 00-INDEX 卡裡
// 原本每個成員各自一列（第 1/2/3 點寫入的那些行），要收斂成 1 列 hub——不是靠打包
// metadata_json（總管明講違反 D91/D93 紅線），是找到每個成員自己那一列的 entry id，
// 之後 per-member 迴圈裡各自 DELETE 掉，換一列新的 hub 摘要行取代。
// index_lines_raw 是 get_index_lines（GET .../entries?page_name=00-INDEX&library=...）
// 的 .data.body，同其他 http_request 節點的既有慣例，是 JSON **字串**要整個 parse。
var indexResp = parse(input.index_lines_raw);
var indexEntries = (indexResp && Array.isArray(indexResp.entries)) ? indexResp.entries : [];

var members = [];
var seen = {};
for (var i = 0; i < ids.length; i++) {
  var id = String(ids[i] == null ? '' : ids[i]);
  if (!id || seen[id]) continue;
  seen[id] = true;
  var pageName = id.indexOf('kb://') === 0 ? id.slice(5) : id;
  var needle = '[[' + pageName + ']]';
  var indexLineId = '';
  for (var j = 0; j < indexEntries.length; j++) {
    var content = String(indexEntries[j].content || '');
    if (content.indexOf(needle) !== -1) { indexLineId = String(indexEntries[j].id || ''); break; }
  }
  members.push({ id: id, hub_title: hubTitle, page_name: pageName, index_line_id: indexLineId });
}

return { success: true, members: members, member_count: members.length };
