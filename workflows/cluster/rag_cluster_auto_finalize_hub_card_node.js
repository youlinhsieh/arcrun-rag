// c14669（③ 總編輯）：把 workers_ai_chat 的自由文字回應解析成 title/summary 兩格，
// 寫進既有的 cluster_hub template。workers_ai_chat 節點的輸出是 `{{node.text}}`
// （同 rag-chat.local.yaml 的 ask_llm 用法，不是 `.data.text`）。
// 解析失敗（LLM 沒照格式回）時給機械 fallback，不讓整條分支因為格式跑掉而失敗。
var raw = String(input.llm_text == null ? '' : input.llm_text).trim();
var lines = raw.split('\n');
var title = '';
var summaryLines = [];
var inSummary = false;
for (var i = 0; i < lines.length; i++) {
  var line = lines[i];
  if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, '').trim(); continue; }
  if (/^##\s*摘要/.test(line)) { inSummary = true; continue; }
  if (inSummary && line.trim()) summaryLines.push(line.trim());
}
if (!title) title = raw ? raw.split('\n')[0].slice(0, 40) : ('群組摘要（' + new Date().toISOString().slice(0, 10) + '）');
var summary = summaryLines.join(' ').trim();
if (!summary) summary = raw.slice(0, 500);

// 🔴 c15417（總管實測抓到：LLM 摘要編了一道不存在的菜「惡魔雞」，真實成員「麻辣鍋」
// 反而沒列出）：目錄是拿來找東西的，列出不存在的成員比不列還糟——這格不能信任 LLM
// 自己講對。hub_editor.js 的 prompt 已經改成叫 LLM 不要列舉具體成員名稱（第一層防線），
// 這裡是第二層、機械的防線：不管 LLM 有沒有聽話，都機械組一句「實際成員：...」附加在
// hub_summary 最後，保證最終寫進 KBDB 的摘要文字裡成員清單對應真實資料。
//
// 🔴 c15431（總管實測抓到 c15417 這輪的殘留 bug）：上一版拿 member_titles_json
// （decide.js 算出來、給 hub_editor 的 hub_prompt 組字用的那份）當人看的名字——
// 但那份是 cluster_group 為了控制儲存大小，經過 GROUP_MEMBER_TITLE_MAX_LEN=12
// 截斷過的版本（見 rag_cluster_auto_decide_node.js truncateTitle()），直接拿來
// 給人看就變成「c15417-yuxia…」這種讀不懂、也點不過去的殘缺字串，且只有最後一個
// （這次決策當下算出來的那個，沒被持久化截斷過）沒截，四個格式因此還不一致。
// 修法：改用 member_ids_json（`kb://<page_name>` 陣列，decide.js/hub_editor.js
// 全程沒有截斷過的真身，跟 build_hub_card_content_node.js 組「## 相關」清單用
// 的是**同一份資料、同一套剝字首邏輯**）剝掉 `kb://` 字首取得 page_name——
// 完整、不截斷、四個格式一致，而且逐字對應 kbdb_get_index 看得到的那張卡，
// 點得過去。
function parseIds(v) {
  if (typeof v !== 'string') return [];
  try { var arr = JSON.parse(v); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
}
var memberIds = parseIds(input.member_ids_json);
if (memberIds.length) {
  var memberList = [];
  var seenMember = {};
  for (var mi = 0; mi < memberIds.length; mi++) {
    var mid = String(memberIds[mi] == null ? '' : memberIds[mi]);
    if (!mid) continue;
    var mPageName = mid.indexOf('kb://') === 0 ? mid.slice(5) : mid;
    if (!mPageName || seenMember[mPageName]) continue;
    seenMember[mPageName] = true;
    memberList.push(mPageName);
  }
  if (memberList.length) {
    summary = (summary ? summary + ' ' : '') + '實際成員：' + memberList.join('、') + '。';
  }
}

return {
  success: true,
  hub_title: title.slice(0, 200),
  hub_summary: summary.slice(0, 2000),
  promoted_at: String(Math.floor(Date.now() / 1000))
};
