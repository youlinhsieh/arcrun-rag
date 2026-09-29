function parse(b) { if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } } return b; }
// 🔴 實測抓到的真限制：呼叫方沒帶某個 input 欄位時，模板引擎**不是**回傳 undefined／空字串，
// 而是把 `{{input.x}}` 這串字面文字原封不動塞進來——所以「用 `input.x ? ... : 預設值` 判斷
// 有沒有傳」對這類可選欄位一律誤判成「有傳」。這支 helper 把「看起來像沒被代入的模板字串」
// 一併當成沒傳，之後任何新增的可選 input 欄位都要透過它，不要再裸用 `input.x ? ...`。
function opt(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && /^\{\{[\s\S]*\}\}$/.test(v.trim())) return undefined;
  return v;
}
// c14501 B①：把單一 use_type（'ticket'）寫死的版本泛化成可服務多種用途，同一支邏輯、
// 同一個 workflow，不是為每個用途各建一份——呼叫端傳 input.use_type 決定要讀哪筆
// cluster_criteria、寫進哪個 membership 桶；不傳就退回舊行為（'ticket'），保證原本
// 已驗過的開票路徑一個位元組都不用改。
var CRITERIA_USE_TYPE = opt(input.use_type) ? String(opt(input.use_type)) : 'ticket';
// membership 的 use_type 桶名：'ticket' 沿用歷史值 'ticket_auto'（已有真資料在裡面，
// 不改名破壞既有讀回），其他用途（'wiki'／'mistakes'）直接用原名，不加後綴。
var USE_TYPE_BASE = (CRITERIA_USE_TYPE === 'ticket') ? 'ticket_auto' : CRITERIA_USE_TYPE;
// c15294（leo 09-28 裁決「目錄/hub 只改子庫，上一層不動」）：分群／持久群索引／hub／
// 目錄全部要以「子庫」（KBDB 的 library）為邊界，只對 wiki 用途生效（ticket／mistakes
// 沒有子庫概念，不傳 library 就完全退回舊行為）。這條公式必須跟
// rag_cluster_auto_resolve_use_type_node.js 裡同名那段逐字一致——那邊算出來的
// group_use_type 已經在 read_group／check_hub_exists 這兩個 http_request 節點的
// URL 當伺服端過濾值用了（c15236），這裡再算一次只是給 write_membership／
// write_group／hub_editor 這些下游節點用，兩邊算出來的值本該永遠相同。
var optLibrary = opt(input.library);
var libraryScope = optLibrary ? String(optLibrary) : '';
var USE_TYPE = (CRITERIA_USE_TYPE === 'wiki' && libraryScope) ? (USE_TYPE_BASE + '__' + libraryScope) : USE_TYPE_BASE;

// 讀 cluster_criteria（append-only：同 use_type 若有多筆，最後一筆＝目前生效值，
// 對齊 cluster_membership 的 append-only／supersede 慣例，見 c14360 A 項——
// 「改 KBDB 那筆就改行為，不必重推工作流」：這裡的「改」是「補一筆新的」，不是真的
// mutate 舊 record，跟 membership 的寫法一致）。找不到就退回 proposal 原定初值 0.22／8。
// input.criteria_raw 是 http_request GET 節點的 .data.body，這是一個 JSON **字串**
// （不是已剝殼的物件——`{{node.data.body}}` 綁的是字串本身），要整個 parse 一次
// 才拿得到 { success, records }，之前一版直接綁 `.data.body.records` 對字串取欄位
// 一律是 undefined，這是這輪 c14360 A 實測抓到的真 bug（見票留言）。
var criteriaResp = parse(input.criteria_raw);
var criteriaRecs = (criteriaResp && Array.isArray(criteriaResp.records)) ? criteriaResp.records : [];
// 實測發現：by-template 讀回是「新到舊」排序（最新寫入的排在陣列第一筆），不是插入序
// 由舊到新——這是 c14360 A 這輪另一個抓到的真 bug（原本假設「陣列越後面越新」，反了）。
// 取第一筆命中 use_type 的 record 即為目前生效值。
// c15236：read_criteria 現在也用 KBDB by-template 的欄位過濾只讀這個 use_type
// （見 rag_cluster_auto_resolve_use_type_node.js）——這個迴圈原本就是「找第一筆
// 命中」不是「篩全部」，伺服端過濾後照樣正確，不用改邏輯，這裡只是留註記說明。
var myCriteria = null;
for (var ci = 0; ci < criteriaRecs.length; ci++) {
  var cv = criteriaRecs[ci].values || criteriaRecs[ci];
  if (cv.use_type === CRITERIA_USE_TYPE) { myCriteria = cv; break; }
}
var simThreshold = myCriteria && myCriteria.sim_threshold !== undefined ? parseFloat(myCriteria.sim_threshold) : 0.22;
var sizeCap = myCriteria && myCriteria.size_cap !== undefined ? parseInt(myCriteria.size_cap, 10) : 8;
if (!(simThreshold >= 0)) simThreshold = 0.22;
if (!(sizeCap > 0)) sizeCap = 8;
// c14669（③ 總編輯）：同一筆 cluster_criteria 記錄再多讀兩格門檻——群長到 hub_threshold
// 就該自動升格出 hub 卡；hub 掛出來以後群還繼續長，長過 chapter_budget 就該提出
// split 提案（不是自動搬動，只是提案）。沒設就給小一點的預設值方便驗收（4／10）。
// 🔴 已知限制（誠實列，這輪實測撞到、還沒解）：cluster_criteria 這個 KBDB template
// 目前宣告的 slots 只有 use_type/criteria_text/sim_threshold/size_cap/trigger/
// source_ticket——hub_threshold／chapter_budget **不在**這份 slots 清單裡。實測發現
// KBDB 對「values 裡有 template 沒宣告的欄位」是**靜默丟掉**，不是報錯（同
// rag-ingest-card.local.yaml 的 `machine` slot 那個已知模式），所以現在不管建幾筆
// cluster_criteria 想覆寫這兩個門檻，寫進去的值都會被無聲吃掉，實際生效的永遠是
// 這裡的預設值 4／10。查過 KBDB 沒有「幫既有 template 加 slot」的 API（PATCH/PUT
// 都 404，重複 POST 同名字會 500），要讓這兩格真的可覆寫，需要先补一支「改 template
// slots」的 KBDB 端點（不在這張票的範圍內）。sim_threshold／size_cap 之所以能覆寫，
// 是因為它們從建立 cluster_criteria 這個 template 時就在 slots 清單裡。
var hubThreshold = myCriteria && myCriteria.hub_threshold !== undefined ? parseInt(myCriteria.hub_threshold, 10) : 4;
var chapterBudget = myCriteria && myCriteria.chapter_budget !== undefined ? parseInt(myCriteria.chapter_budget, 10) : 10;
if (!(hubThreshold > 0)) hubThreshold = 4;
if (!(chapterBudget > hubThreshold)) chapterBudget = hubThreshold + 6;

// c14949（承接 c14946「還沒通的」第 1 條）：「讀取仍是最新 N 筆、不分用途」的正解——
// 不再讀 cluster_membership（append-only、隨每一次決策線性成長，這正是 c14824/c14926
// 那次 unreachable SEV 的病灶：規格 §2「不變量：任何階段不讀全量 index」被違反）。
// 改讀 cluster_group（規格 §3.3 早就預留、c14669 那輪已建好 template 但從沒接上的
// 持久群索引，一群一筆，用 PATCH 真的原地更新——不是 append 出第二筆）：
//   · 筆數＝現有群數 m（不隨事件數 n 成長，n 是「發生過幾次決策」，m 是「現在有幾群」）
//   · 找這個 use_type 的候選群，只需要讀「現有全部群」，天然就不會被別的 use_type
//     的流量擠出視窗（cluster_membership 的 limit=25 止血法就是被這個擠掉的問題）
// input.group_raw 同 criteria_raw／membership_raw 一樣是 http_request 節點的
// .data.body，是 JSON 字串，要整個 parse 一次。
var groupResp = parse(input.group_raw);
var groupRecs = (groupResp && Array.isArray(groupResp.records)) ? groupResp.records : [];
// c15236：read_group 現在已經用 KBDB by-template 的欄位過濾（inkstone/Arcrun#260）
// 只讀這個 use_type（見 rag_cluster_auto_resolve_use_type_node.js），這裡不再是
// 「讀全部用途才篩」——保留這行純粹當防禦性二次檢查（伺服端過濾若失效，本地仍
// 不會把別的 use_type 的群錯配進來），正常情況下是個 no-op。
groupRecs = groupRecs.filter(function (r) { var v = r.values || r; return v.use_type === USE_TYPE; });
// by-template 一樣是新到舊排序（同 criteria 那個已驗證過的真限制）——同一個 cluster_id
// 理論上只會被 PATCH 原地更新、不會有第二筆，但防禦性地仍取「第一筆命中」＝最新那筆，
// 萬一某次寫入意外 fallback 成 POST（見下方 group_write_method）留下重複也不會讀錯。
var groupByCluster = {};
groupRecs.forEach(function (r) {
  var v = r.values || r;
  var cid = v.cluster_id;
  if (!cid || groupByCluster[cid]) return;
  var centroid = parse(v.centroid_json) || {};
  var repLabelsParsed = parse(v.rep_labels_json);
  var memberEntriesParsed = parse(v.member_ids_json);
  groupByCluster[cid] = {
    cluster_id: cid,
    record_id: r.record_id,
    centroid: centroid,
    size: parseInt(v.size, 10) || 0,
    rep_labels: Array.isArray(repLabelsParsed) ? repLabelsParsed : [],
    member_entries: Array.isArray(memberEntriesParsed) ? memberEntriesParsed : [],
  };
});
var existingClusters = Object.keys(groupByCluster).map(function (cid) {
  var g = groupByCluster[cid];
  var titles = [], ids = [];
  g.member_entries.forEach(function (e) {
    if (e && typeof e === 'object') {
      if (e.title) titles.push(String(e.title));
      if (e.id) ids.push(String(e.id));
    } else if (typeof e === 'string' && e) {
      ids.push(e); // 相容舊格式（純字串 id，沒有 title）
    }
  });
  return { cluster_id: cid, record_id: g.record_id, centroid: g.centroid, size: g.size, rep_labels: g.rep_labels, titles: titles, ids: ids };
});

function tokenize(text) {
  text = String(text || '').replace(/[`*_#>\[\]\(\)\{\}\|]/g, ' ').replace(/https?:\/\/\S+/g, ' ').toLowerCase();
  var tokens = [];
  var ascii = text.match(/[a-z0-9][a-z0-9\-_/#]{1,}/g) || [];
  for (var i = 0; i < ascii.length; i++) tokens.push(ascii[i]);
  var cjkRuns = text.match(/[一-鿿]+/g) || [];
  cjkRuns.forEach(function (run) {
    if (run.length === 1) tokens.push(run);
    for (var j = 0; j < run.length - 1; j++) tokens.push(run.slice(j, j + 2));
  });
  return tokens;
}
function tfVector(text) {
  var toks = tokenize(text);
  var v = {};
  toks.forEach(function (t) { v[t] = (v[t] || 0) + 1; });
  var norm = 0;
  Object.keys(v).forEach(function (t) { norm += v[t] * v[t]; });
  norm = Math.sqrt(norm) || 1;
  Object.keys(v).forEach(function (t) { v[t] = v[t] / norm; });
  return v;
}
function labelBonus(la, lb) {
  if (!la || !lb || !la.length || !lb.length) return 0;
  var setB = {};
  lb.forEach(function (x) { setB[x] = true; });
  var inter = la.filter(function (x) { return setB[x]; });
  if (!inter.length) return 0;
  var meaningful = inter.filter(function (l) { return String(l).indexOf('s/') !== 0; });
  return meaningful.length ? 0.15 : 0;
}

// 泛化的識別欄位：呼叫端可以直接傳 item_id/item_title/item_labels（wiki／mistakes 用途
// 沒有 repo/number 這種形狀），沒傳才退回舊的 repo#number／title／labels 組法（ticket 用途）。
// 一律經過 opt() 過濾「沒代入的字面模板字串」，理由同上面 CRITERIA_USE_TYPE。
var optItemId = opt(input.item_id);
var newItemId = optItemId ? String(optItemId) : (String(opt(input.repo) || '') + '#' + String(opt(input.number) || ''));
// 🔴 c15011（總管 stage 實跑抓到）：第二道防線——呼叫端（例如 prep_cluster_wiki）
// 理論上該擋掉未代入的樣板字串，但不能只信任呼叫端一定會擋乾淨。當
// `item_id`／`repo`／`number` 全部沒傳或全部沒代入時，上面那行會組出
// `'' + '#' + '' === '#'` 這種看起來像真資料、其實完全沒有識別力的字串——
// stage 上撞到的真實案例：wiki 卡沒帶 page_name（本該被 prep_cluster_wiki
// 擋下，但那邊當時用 `return {success:false}` 而不是 `throw`，沒有真的擋住，
// 見 rag-ingest-card.local.yaml 對應節點的註解）就是這樣寫進
// `cluster_membership.item_id = "#"`。這裡加一道獨立於呼叫端的檢查：
// newItemId 是空字串、或剛好等於 '#'（repo 與 number 都缺的典型退化形狀），
// 一律視為無效輸入，直接 throw——**不是 return {success:false}**：本檔案
// 是 `code` 零件，沙箱把正常 return 的值包成 `{success:true, data:<值>}`，
// 只有 throw 才會讓外層信封真的變成 `{success:false,...}`，才會被
// graph-executor 的 isFailure() 認得（同一個道理，見下方 assertAllStrings
// 那段的呼叫方式也已經改成 throw，不要再犯 c14992/c15011 這兩輪撞過的
// 「return 失敗物件以為會被擋住」這個誤解）。
if (!newItemId || newItemId === '#') {
  throw new Error('item_id 無法識別（收到 item_id=' + JSON.stringify(optItemId) +
    '、repo=' + JSON.stringify(opt(input.repo)) + '、number=' + JSON.stringify(opt(input.number)) +
    '，組出來是 ' + JSON.stringify(newItemId) + '），拒收，不寫入分群');
}
var optItemTitle = opt(input.item_title);
var newTitle = (optItemTitle !== undefined && optItemTitle !== '') ? String(optItemTitle) : String(opt(input.title) || '');
// c15294 第 3 點（總管 c15323 退回：「一列一卡＋摘要」只有 title，沒有摘要）：
// item_summary 是純粹給目錄卡層級列顯示用的欄位，不進 TF-IDF（newTitle／vec 完全
// 不受影響，維持既有分群精度不變）。沒有呼叫端沒傳就用 newTitle 本身截斷當退回值，
// 保證這格永遠有內容可顯示，不會是空字串。
var optItemSummary = opt(input.item_summary);
var newSummary = (optItemSummary !== undefined && optItemSummary !== '') ? String(optItemSummary) : newTitle.slice(0, 200);
var optItemLabels = opt(input.item_labels);
var rawLabels = Array.isArray(optItemLabels) ? optItemLabels : (Array.isArray(opt(input.labels)) ? opt(input.labels) : []);
var newLabels = rawLabels.map(function (l) { return (l && l.name) ? l.name : l; });
var text = newTitle + ' ' + newLabels.join(' ');
var vec = tfVector(text);

var bestSim = -1, bestCluster = null;
existingClusters.forEach(function (c) {
  if ((c.size || 0) >= sizeCap) return;
  var s = 0;
  Object.keys(vec).forEach(function (t) { if (c.centroid[t] !== undefined) s += vec[t] * c.centroid[t]; });
  var sumsq = 0;
  Object.keys(c.centroid).forEach(function (t) { sumsq += c.centroid[t] * c.centroid[t]; });
  var centroidNorm = (Math.sqrt(sumsq) / (c.size || 1)) || 1;
  var sim = (s / (c.size || 1) / centroidNorm) + labelBonus(newLabels, c.rep_labels);
  if (sim > bestSim) { bestSim = sim; bestCluster = c; }
});

var action, clusterId, sim, memberTitlesSoFar, memberIdsSoFar;
if (bestCluster && bestSim >= simThreshold) {
  action = 'attach'; clusterId = bestCluster.cluster_id; sim = bestSim;
  memberTitlesSoFar = (bestCluster.titles || []).slice();
  memberIdsSoFar = (bestCluster.ids || []).slice();
} else {
  action = 'new';
  clusterId = USE_TYPE + '-' + newItemId.replace(/[^a-zA-Z0-9]/g, '') + '-' + Date.now();
  sim = null;
  memberTitlesSoFar = [];
  memberIdsSoFar = [];
}

// c15294 第 1 點（leo 09-28 裁決）：「新卡寫入時找相關卡（已有的分群 attach／相似度
// 就是現成訊號）；有關就在新舊兩張卡上都記下對方」——這裡的「現成訊號」就是上面
// 剛判出來的 attach：它已經證明了新項目跟 bestCluster 這群夠像。要連去哪一張具體
// 的舊卡，取這群現存範例（memberIdsSoFar／memberTitlesSoFar，來自 cluster_group
// 持久化的最近幾個成員範例）裡最新的一個——不是重新對每個舊成員逐一算相似度
// （那需要重讀全量成員向量，正是 c14926 那次 unreachable SEV 的病灶，規格 §2 的
// 不變量不許再犯）。只有真的 attach、且這群留有至少一個成員範例時才連結。
var relatedItemId = '', relatedItemTitle = '';
if (action === 'attach' && memberIdsSoFar.length) {
  relatedItemId = String(memberIdsSoFar[memberIdsSoFar.length - 1]);
  relatedItemTitle = memberTitlesSoFar.length ? String(memberTitlesSoFar[memberTitlesSoFar.length - 1]) : '';
}
var shouldLink = !!relatedItemId;
// c15294 第 2/3 點：目錄「一子庫一列一卡＋摘要」只對 wiki 用途有意義（票／教訓
// 沒有「章」的概念，這條不動它們既有行為）——用 USE_TYPE_BASE 判斷（不是已經
// 疊上 library 後綴的 USE_TYPE），這樣不管有沒有帶 library 都能正確辨識。
var tocShouldWrite = (USE_TYPE_BASE === 'wiki');

// c14669：write_membership／write_group 這筆還沒真的寫進去（decide 只是決策，寫入在
// 下一步），所以這裡的 memberCount 要手動 +1 才是「寫完之後」的真實成員數，供③總編輯的
// 結構信號（hub_threshold／chapter_budget）判斷用。
//
// 🔴 c15007（總管 stage 實跑抓到，main `f2dfaa5` 同一行就有、不是這個分支才有的
// 計數 bug）：這裡原本寫 `(bestCluster ? bestCluster.size : 0) + 1`——但
// `bestCluster` 只代表「上面迴圈裡 sim 最高的那個候選」，**不代表 attach 到它**。
// 當 action 判成 'new' 時（sim 沒過門檻），`bestCluster` 仍然指著「最像但沒過門檻」
// 的那個既有群（可能是別的、跟這個新項目其實不相關的老群），於是新群一開場就
// 繼承了那個老群的 size，而不是從 1 開始。實害：新群可能一出生就 ≥ hub_threshold
// 被誤升格成 hub，或誤觸 split／merge 提案；這個分支還會把這個錯的數字寫進
// `cluster_group.size`，之後每次 attach 都在錯的基礎上疊加，錯誤只會越滾越大。
// 修法：memberCount 要不要 +既有 size，看的是 **action 是不是真的 attach**，
// 不是「有沒有算出一個 bestCluster」——沒 attach 就是全新的一群，從 1 開始。
var memberTitlesForHub = memberTitlesSoFar.concat([newTitle]).slice(-20);
var memberIdsForHub = memberIdsSoFar.concat([newItemId]).slice(-20);
var memberCountAfterWrite = (action === 'attach' && bestCluster ? bestCluster.size : 0) + 1;
// c14949：cluster_group 的 member_ids_json 這格改存 {id,title} 物件陣列（不是純 id
// 字串陣列）——因為 hub_editor／build_hub_card 需要**標題**才寫得出摘要卡，而
// cluster_group 這個 template 目前宣告的 slots 沒有另一格「member_titles_json」
// 可加（同上面 hub_threshold／chapter_budget 那個「無法幫既有 template 加 slot」的
// 已知限制），member_ids_json 本身只是一個字串欄位，格式由我們自己定，不受限制。
// cluster_group 目前 0 筆真資料（這輪才第一次真的接上），無相容性負擔。
//
// 🔴 c14960（總管審 c14959 退回）：這裡原本直接沿用 memberIdsForHub／
// memberTitlesForHub（最多 20 筆、標題不截斷——wiki 的 item_title 是
// page_name＋內文前 300 字，見 prep_cluster_wiki），寫進 cluster_group 後
// 每筆 group record 可能就有好幾 KB，read_group 一次讀回多筆群就會撞回
// 64KB——跟 read_membership 撞頂是「同一個病換個地方」，不是真的解掉。
// 這裡另外算一份**專門給 cluster_group 持久化用**、有硬上限的精簡版，
// 跟上面給 hub_editor 這次直接用的 memberTitlesForHub／memberIdsForHub
// （不截斷，因為那是這次執行內的暫態值，只在這次 decide→hub_editor 的
// 單次呼叫內傳遞，不會被重複讀回，不佔 read_group 的成本）分開——
// 兩者用途不同：後者要給 LLM 寫摘要卡，標題越完整摘要品質越好；前者是
// 未來每次 decide 都要重新讀回的持久索引，必須有跟群大小/成員數無關的
// 固定上限。
var GROUP_MEMBER_ENTRIES_MAX = 3;   // 最多留幾個成員範例（只給提案文字當「最近加入」舉例用，不求完整）
var GROUP_MEMBER_TITLE_MAX_LEN = 12; // 每個範例標題截斷到幾個字元（CJK 一字算一個字元）
function truncateTitle(t) {
  t = String(t || '');
  return t.length > GROUP_MEMBER_TITLE_MAX_LEN ? (t.slice(0, GROUP_MEMBER_TITLE_MAX_LEN) + '…') : t;
}
var memberEntriesForGroupRaw = memberIdsForHub.slice(-GROUP_MEMBER_ENTRIES_MAX);
var memberTitlesForGroupRaw = memberTitlesForHub.slice(-GROUP_MEMBER_ENTRIES_MAX);
var memberEntriesForGroup = [];
for (var mi2 = 0; mi2 < memberEntriesForGroupRaw.length; mi2++) {
  memberEntriesForGroup.push({ id: memberEntriesForGroupRaw[mi2], title: truncateTitle(memberTitlesForGroupRaw[mi2]) });
}

// c14825（③ 總編輯，merge 提案）：票本文「章節預算超額必觸發 merge／split」——
// c14669 那輪只做了「單一群過大 → split」，這裡補「兩群高度重疊 → merge」需要的
// 「群 vs 群」比較（不是「新項目 vs 既有群」，那是上面 bestSim 在做的事）。
// 做法：算出這個項目寫入後、它所屬那一群的最終 centroid（attach＝既有 centroid＋
// 這次的 vec；new＝只有這次的 vec），拿它跟**其他**群（排除自己）逐一比較，找出
// 重疊度最高的對象，交給 hub_editor 判斷「這兩群像不像同一件事」。只在「其他群」
// 規模已達 hub_threshold（夠格當一個章節）時才納入比較，避免拿一個單筆的雜訊群
// 硬湊成 merge 候選。
function centroidNormVec(centroid, size) {
  var v = {};
  var s = size || 1;
  Object.keys(centroid).forEach(function (t) { v[t] = centroid[t] / s; });
  return v;
}
function dot(a, b) {
  var s = 0;
  Object.keys(a).forEach(function (t) { if (b[t] !== undefined) s += a[t] * b[t]; });
  return s;
}
function vecNorm(a) {
  var s = 0;
  Object.keys(a).forEach(function (t) { s += a[t] * a[t]; });
  return Math.sqrt(s) || 1;
}
function cosine(a, b) {
  return dot(a, b) / (vecNorm(a) * vecNorm(b));
}

var finalCentroid = {};
if (action === 'attach' && bestCluster) {
  Object.keys(bestCluster.centroid).forEach(function (t) { finalCentroid[t] = bestCluster.centroid[t]; });
}
Object.keys(vec).forEach(function (t) { finalCentroid[t] = (finalCentroid[t] || 0) + vec[t]; });
var finalNormVec = centroidNormVec(finalCentroid, memberCountAfterWrite);

var mergeCandidateId = '', mergeCandidateSim = -1, mergeCandidateSize = 0, mergeCandidateTitles = [];
existingClusters.forEach(function (c) {
  if (c.cluster_id === clusterId) return; // 排除自己
  if ((c.size || 0) < hubThreshold) return; // 只跟「夠格當章節」的群比較
  var otherNormVec = centroidNormVec(c.centroid, c.size);
  var s = cosine(finalNormVec, otherNormVec);
  if (s > mergeCandidateSim) {
    mergeCandidateSim = s;
    mergeCandidateId = c.cluster_id;
    mergeCandidateSize = c.size;
    mergeCandidateTitles = c.titles || [];
  }
});

// c14949：cluster_group 用**真的原地更新**（PATCH），不是 append-only 補一筆新的——
// 這是跟 cluster_membership／cluster_criteria 刻意不同的地方：那兩張表選 append-only
// 是因為「歷史本身有價值」（決策軌跡／門檻沿革要能回溯），但 cluster_group 只是一份
// 「現在」的快照索引，append 只會讓它跟 membership 犯同一種病（筆數隨事件數 n 線性
// 成長，读回時還是要挑「最新一筆」）。查過 cypher-executor 有 PATCH /kbdb/records/:id
// （kbdb-proxy.ts 208 行，mira-dissolve T2.1 就是為了這個用途補的），故：
//   · attach 且找得到既有 group record_id → PATCH 那一筆（真的原地更新，表本身
//     筆數永遠等於現有群數 m，不隨 n 成長）
//   · new，或防禦性地找不到 record_id（理論上不該發生，但別讓一個異常擋死整條鏈）
//     → POST 開一筆新的
// method／url 都是 decide 算出來、由 write_group 節點的 {{decide.data.xxx}} 動態代入
// （同 ship_check_live.json 已驗證過的「method 本身可以模板化」寫法，見 c14949 票留言）。
var cypherBase = String(opt(input.cypher_base) || '').replace(/\/$/, '');
var existingGroupRecordId = (action === 'attach' && bestCluster) ? String(bestCluster.record_id || '') : '';
var groupWriteMethod = existingGroupRecordId ? 'PATCH' : 'POST';
var groupWriteUrl = existingGroupRecordId
  ? (cypherBase + '/kbdb/records/' + encodeURIComponent(existingGroupRecordId))
  : (cypherBase + '/kbdb/records');

// 🔴 c14960（總管審 c14959 退回，第二次抓到「用另一種方式撞回 64KB」）：
// `finalCentroid`（上面算好、給 merge 候選比較用的完整累加向量）本身**沒有上限**——
// 群累積的成員越多，出現過的相異 token 就越多，`centroid_json` 會隨群的年紀
// 無限長大。read_group 一次讀回 N 個群的 centroid，即使 N 不大，只要群夠老、
// 內容夠雜，單筆就可能好幾 KB，跟 `read_membership` 撞頂是**同一個病換了個
// 存放位置**，不是真的解掉（總管原話：「會用另一種方式撞回 64KB」）。
//
// 修法：**只持久化 top-K 權重最高的 token**——TF 向量本身已經正規化過，
// 權重高的 token 就是這段文字裡出現頻率相對高、最具代表性的字/詞，捨棄權重低的
// 長尾 token 對 cosine 相似度的影響有限（多數長尾 token 彼此點積貢獻趨近 0）。
// 這是「只看局部」必然要付的代價（同 cluster_step_node.js 已知的 tf-only 取捨），
// 不是精確解——但比起「不設界、賭它不會長太大」誠實得多。**這裡截斷的只是
// 要持久化寫回 cluster_group 的版本**，上面 mergeCandidate 迴圈用的仍是這次
// decide 當下算出的完整 `finalCentroid`（最準確的一次），下一輪決策讀回的
// 就會是這裡截斷後的版本——這代表精度會隨著輪數緩慢下降到「穩定在 top-K」，
// 不是每次都用最新最完整的版本，這點誠實列在票留言。
//
// 🔴 c14972（總管審 ea2d182 第二次退回）：K=8 不夠——`tokenize` 對中文切
// 雙字（bigram），InkStoneCo 票幾乎都是 User Story 句型（「身為／我要／我才」），
// 這類樣板雙字在**每個成員都出現**，累加後權重天然偏高（出現頻率高的 token
// 累加權重自然大），K 太小時「top-K」選出來的反而是樣板字，不是真正有鑑別度
// 的主題詞——這跟 top-K 挑選的初衷（保留最具代表性的字/詞）正好相反：對單篇
// 文件而言高權重詞代表性沒錯，但對**累加多篇的群 centroid**而言，出現在最多
// 成員裡的往往就是樣板字，而非鑑別力強的內容詞。
//
// 拿 youlin stage 上真實的歷史資料重播驗證過這個風險（`inkstone/e2e-sandbox#13`
// ～`#18`，六張真票，全部「身為○○，我要○○，我才○○」句型但主題各自不同：
// WiFi 密碼通知 vs 印表機卡紙通知 vs 設備維修派工）：
//   K=8 時，累積 centroid 的 top-8 幾乎全是「身為／我要／訪客／辦公室」這類
//   樣板／高頻字，導致：① 一個明顯不同主題的探針（「分群止血機制」）sim 逼近
//   門檻 0.22（幾乎誤判成同群）；② 一個明顯同主題延伸的探針（另一件印表機
//   缺紙通知）sim 掉到 0.21、**低於門檻變成 new（真的判錯，跟拿完整 centroid
//   算出來的 0.61、以及 K=15/20/30 算出來的 0.26/0.34/0.55 都不一致）**。
// K 提高到 15 之後，兩個探針的判定都跟「完整不截斷的 centroid」一致（新主題
// 判 new、同主題判 attach），K=20/30 更貼近完整版但邊際改善有限。這裡選 15：
// 已足夠修正 K=8 觀察到的誤判，且單筆 record 的位元組成本仍遠低於 64KB
// （見下方 read_group 的視窗換算）。完整重播腳本與數字見票留言 c14972 回覆。
var CENTROID_TOP_K = 15;
function topKCentroid(centroid, k) {
  var entries = Object.keys(centroid).map(function (t) { return [t, centroid[t]]; });
  entries.sort(function (a, b) { return b[1] - a[1]; }); // 權重由大到小
  var out = {};
  entries.slice(0, k).forEach(function (e) { out[e[0]] = e[1]; });
  return out;
}
var finalCentroidForStorage = topKCentroid(finalCentroid, CENTROID_TOP_K);

// 同一個病也發生在 rep_labels_json——標籤數量理論上沒有上限（一張票可以掛
// 十幾個 label），這裡也給硬上限（K=5，通常一張票/一張卡的「有意義標籤」
// 不會超過這個量級，超過的部分對 labelBonus 判斷的邊際貢獻也很小）。
var REP_LABELS_MAX = 5;
var repLabelsForStorage = ((bestCluster && bestCluster.rep_labels && bestCluster.rep_labels.length) ? bestCluster.rep_labels : newLabels).slice(0, REP_LABELS_MAX);

var result = {
  success: true,
  use_type: USE_TYPE,
  item_id: newItemId,
  item_title: newTitle,
  item_labels_json: JSON.stringify(newLabels),
  action: action,
  cluster_id: clusterId,
  cluster_id_enc: encodeURIComponent(clusterId),
  vec_json: JSON.stringify(vec),
  sim: sim === null ? '' : String(sim),
  decided_at: String(Math.floor(Date.now() / 1000)),
  existing_cluster_count: existingClusters.length,
  applied_sim_threshold: simThreshold,
  applied_size_cap: sizeCap,
  criteria_source: myCriteria ? 'kbdb_cluster_criteria' : 'fallback_default',
  // c15294 第 1 點新增欄位，給 write_link_forward／write_link_backward 節點用：
  library: libraryScope,
  should_link: shouldLink ? 'true' : 'false',
  related_item_id: relatedItemId,
  related_item_title: relatedItemTitle,
  // c15294 第 2/3 點新增欄位，給 post_card_toc_entry 節點用：
  toc_should_write: tocShouldWrite ? 'true' : 'false',
  item_summary: newSummary,
  // c15345（總管裁決：目錄真身是 00-INDEX 卡，走跟其他卡同一條 /entries 寫入路徑，
  // 不是另建虛擬表）：00-INDEX 每一列用 `[[page_name]]` 雙括號連結格式（同
  // kbdb_index.ts 讀整張卡時認得的既有慣例），這裡把 item_id 的 `kb://` 字首剝掉，
  // 剩下的就是 page_name。
  item_page_name: newItemId.indexOf('kb://') === 0 ? newItemId.slice(5) : newItemId,
  // c14669（③ 總編輯）新增欄位，給 hub_editor 節點用：
  // 🔴 c14992（總管 stage 實跑抓到的真 bug）：這格原本是裸 JS number，
  // write_group 直接把它綁進 KBDB 寫入的 `values.size`（"{{decide.data.
  // cluster_member_count}}"）——KBDB 的 /kbdb/records 要求 values 全部是
  // 字串（"values must be an object of {slot: string}"，跟 c14669 抓過的
  // bug 3、hub_editor.js 檔頭那句「這裡一律 String() 過」是同一類病，只是
  // 這次是新欄位、沒有沿用既有的 String() 慣例）。這裡本身被 hub_editor 用
  // `parseInt(input.cluster_member_count, 10)` 消費，對字串或數字都能正確
  // parse，改成字串對它零影響；但對 write_group 是必要的修正。
  cluster_member_count: String(memberCountAfterWrite),
  cluster_member_titles_json: JSON.stringify(memberTitlesForHub),
  cluster_member_ids_json: JSON.stringify(memberIdsForHub),
  hub_threshold: hubThreshold,
  chapter_budget: chapterBudget,
  // c14825（③ 總編輯，merge 提案）新增欄位，給 hub_editor 節點用：
  merge_candidate_cluster_id: mergeCandidateId,
  merge_candidate_sim: mergeCandidateId ? String(mergeCandidateSim) : '',
  merge_candidate_size: String(mergeCandidateSize),
  merge_candidate_titles_json: JSON.stringify((mergeCandidateTitles || []).slice(-20)),
  // c14949（持久群索引 cluster_group，取代重讀全量 cluster_membership）新增欄位，
  // 給 write_group 節點用：
  final_centroid_json: JSON.stringify(finalCentroidForStorage),
  group_rep_labels_json: JSON.stringify(repLabelsForStorage),
  group_member_ids_json: JSON.stringify(memberEntriesForGroup),
  group_write_method: groupWriteMethod,
  group_write_url: groupWriteUrl
};

// 🔴 c14992：總管 stage 實跑抓到「write_group 被 KBDB 拒寫（values must be
// an object of {slot: string}）」——本機 node 重播完全測不到這個，因為重播
// 不會真的打 KBDB API 驗證型別，這正是「本機測試能攔到什麼、攔不到什麼」的
// 真實邊界。這裡補一道**自我檢查**：把 write_membership／write_group 兩個
// KBDB 寫入節點實際會用到的欄位子集列出來，逐一斷言型別是字串——decide 本身
// 就知道哪些欄位會被哪個節點的 body_json.values 引用（見
// rag_cluster_auto.deployed.json 對應節點），與其等 KBDB 400 才發現，不如
// 在資料離開這支函式之前就攔下來，而且以後改 body_json 引用了新的 decide
// 欄位，也不用回來手動同步這份清單以外的地方——**但這份清單本身仍要跟
// deployed.json 手動保持一致，不是自動比對**（KBDB 的 slot 型別要求是外部
// API 的合約，decide.js 這支 code 節點沒有能力反查它綁定的 workflow 定義），
// 這點誠實列為本檢查的已知限制。
//
// 🔴 c15011（總管 stage 實跑抓到，這段本身上一輪就寫錯了）：這裡原本在型別
// 檢查失敗時 `return { success:false, error: typeError }`——跟
// `prep_cluster_wiki` 那次同一個誤解（見 rag-ingest-card.local.yaml 對應
// 節點的註解）：`code` 零件的沙箱把 user code 正常 return 的值一律包成
// `{success:true, data:<值>}`，外層信封的 `success` 永遠是 true，
// `{success:false}` 只是 `.data` 底下的普通資料，graph-executor 的
// `isFailure()` 完全看不到——這代表**這道自我檢查上一輪其實從沒真的擋住過
// 任何東西**，`write_membership`／`write_group` 還是會照樣往下跑（只是吃到
// `decide.data.use_type` 等於 undefined 的資料，八成會在 KBDB 那層用另一種
// 方式炸開，不是被這裡攔住）。改成 `throw`——`decide` 節點目前沒有掛
// `ON_FAIL` 出邊，圖執行到這裡失敗時就是整條鏈路直接停在這一步，
// `write_membership`／`write_group` 都不會被觸發，這才是「自我檢查」真正
// 該有的效果。
function assertAllStrings(obj, fieldNames, label) {
  var bad = fieldNames.filter(function (k) { return typeof obj[k] !== 'string'; });
  if (bad.length) {
    return label + ' 裡這些欄位不是字串（KBDB 寫入會被 400 拒收）：' +
      bad.map(function (k) { return k + '=' + typeof obj[k]; }).join('、');
  }
  return null;
}
var WRITE_MEMBERSHIP_FIELDS = ['use_type', 'item_id', 'item_title', 'item_labels_json', 'action', 'cluster_id', 'vec_json', 'sim', 'decided_at'];
var WRITE_GROUP_FIELDS = ['use_type', 'cluster_id', 'final_centroid_json', 'cluster_member_count', 'group_rep_labels_json', 'group_member_ids_json', 'decided_at'];
// c15294：write_link_forward／write_link_backward（triplet）與 post_card_toc_entry
// （wiki_toc_item）會引用到的欄位，同一套自我檢查邏輯，同一個理由（KBDB 400 早攔早知道）。
var WRITE_LINK_FIELDS = ['item_id', 'related_item_id'];
// c15345：post_card_toc_entry 改寫 00-INDEX 卡的一列（/entries，跟其他卡同一條路），
// 不再是 wiki_toc_item 虛擬表——欄位換成 item_page_name／library。
var WRITE_INDEX_LINE_FIELDS = ['library', 'item_page_name', 'item_summary', 'decided_at'];
var typeError = assertAllStrings(result, WRITE_MEMBERSHIP_FIELDS, 'write_membership') ||
  assertAllStrings(result, WRITE_GROUP_FIELDS, 'write_group') ||
  (shouldLink ? assertAllStrings(result, WRITE_LINK_FIELDS, 'write_link') : null) ||
  (tocShouldWrite ? assertAllStrings(result, WRITE_INDEX_LINE_FIELDS, 'post_card_toc_entry') : null);
if (typeError) {
  throw new Error(typeError);
}

return result;
