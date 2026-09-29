// inkstone/arcrun-rag#13 c15411（總管實測抓到：目錄那一列點下去是死連結）：
// hub 之前只有一筆 `cluster_hub` 記帳用的虛擬表記錄，KBDB `entries`（真正的知識卡）
// 裡從沒有一張叫這個名字的卡——`kbdb_get_card(庫, hub 標題)` 因此回 `card_not_found`。
// leo c15294 原話「建立川菜 hub 卡，介紹川菜、與三個食譜卡建立雙向連結……由川菜卡
// 指向：麻婆豆腐、魚香肉絲、麻辣鍋」講的是一張**真的卡**，不是一筆記帳資料。
//
// 這支只組內容字串（不打網路，code 零件沒有 fetch），給下一個 http_request 節點
// 直接當 `content` 寫進 `POST __KBDB_BASE__/entries`。成員連結用
// `[[page_name]]`——跟這輪 00-INDEX 行、post_hub_link_fwd/back 三元組用的同一套
// 命名，三邊的 page_name 逐字一致，才「點得過去」（c15411 明講的驗收條件）。
function parse(b) { if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } } return b; }

var hubTitle = String(input.hub_title == null ? '' : input.hub_title);
var hubSummary = String(input.hub_summary == null ? '' : input.hub_summary);
var raw = parse(input.member_ids_json);
var ids = Array.isArray(raw) ? raw : [];

var lines = [];
var seen = {};
for (var i = 0; i < ids.length; i++) {
  var id = String(ids[i] == null ? '' : ids[i]);
  if (!id) continue;
  var pageName = id.indexOf('kb://') === 0 ? id.slice(5) : id;
  if (seen[pageName]) continue;
  seen[pageName] = true;
  lines.push('- [[' + pageName + ']]');
}

var content = '# ' + hubTitle + '\n\n' + hubSummary + '\n\n## 相關\n' + lines.join('\n');

return { success: true, hub_card_content: content };
