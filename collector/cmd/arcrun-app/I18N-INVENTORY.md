# 小幫手 i18n 字串盤點（inkstone/arcrun-rag#246 c18651，0.18.83 基準）

> 掃描規則：非註解、非測試檔，含中日韓字元的字串字面值／HTML 文字與 title、aria-label、placeholder。
> 一行一筆（同一行多個字串只列出出現者）。**這是抽字典前的候選清單，不是翻譯清單**——
> 其中資料（帳號名、路徑、版本）本來就不翻；去重與歸類在抽字典時做。

## 分區摘要（共 381 筆）

| 檔案 | 筆數 | 類別 |
|---|---|---|
| frontend/index.html | 7 | 靜態畫面（側欄、首次啟動、對話框） |
| frontend/src/main.js | 133 | 畫面字串（含 title／aria-label＝mouseover 與無障礙文字、對話框、更新頁、求救頁、FAQ 連結文字） |
| frontend/src/usage.js | 9 | 用量儀表（本次新增，**只有 title／aria-label 有字**，其餘是圖示與數字） |
| activity_state.go | 12 | Go 側回給前端的字串／系統通知／托盤選單 |
| app.go | 65 | Go 側回給前端的字串／系統通知／托盤選單 |
| apps.go | 15 | Go 側回給前端的字串／系統通知／托盤選單 |
| connect.go | 6 | Go 側回給前端的字串／系統通知／托盤選單 |
| default_library.go | 5 | Go 側回給前端的字串／系統通知／托盤選單 |
| diagnostics_export.go | 13 | Go 側回給前端的字串／系統通知／托盤選單 |
| feedback.go | 9 | Go 側回給前端的字串／系統通知／托盤選單 |
| folder_badge.go | 5 | Go 側回給前端的字串／系統通知／托盤選單 |
| main.go | 1 | Go 側回給前端的字串／系統通知／托盤選單 |
| selfupdate.go | 20 | Go 側回給前端的字串／系統通知／托盤選單 |
| stalls.go | 13 | Go 側回給前端的字串／系統通知／托盤選單 |
| supervise.go | 4 | Go 側回給前端的字串／系統通知／托盤選單 |
| syncing_sub.go | 9 | Go 側回給前端的字串／系統通知／托盤選單 |
| textbudget.go | 18 | Go 側回給前端的字串／系統通知／托盤選單 |
| tray_darwin.go | 2 | Go 側回給前端的字串／系統通知／托盤選單 |
| tray_windows.go | 3 | Go 側回給前端的字串／系統通知／托盤選單 |
| update_api.go | 3 | Go 側回給前端的字串／系統通知／托盤選單 |
| usageui.go | 29 | Go 側回給前端的字串／系統通知／托盤選單 |

## 已免翻譯（圖示化，#246）

- 帳號頁五個頁籤（訊息／資料夾／九宮格／碼表／扳手）：名稱只剩 title／aria-label 各一個字串
- 用量分頁：計費項、三態、剎車、升級、歸零全是圖示＋數字；數字用 `toLocaleString('en-US')` 千分位（抽 i18n 時改成 locale 對應）

## 抽字典時要注意

1. **mouseover（title）與 aria-label 才是大宗**——常駐字已被字數預算壓到很少，翻譯量主要在 hover。
2. **Go 側 compactUI 組好的短句**（`textbudget.go`、`usageui.go`）要翻譯就必須帶參數（數字、時間），不能再用字串拼接：「超出 N」「每天 08:00 歸零」「已用 N」這類。
3. **錯誤分類名稱**（`progress.go` ClassifyFailure）是資料驅動的分類字串，翻譯要走分類 key。
4. **字數預算（`schemas/text-budget.json`）以中文字數計**，英文版需另訂（建議以像素寬或字元數×0.5 換算）。
5. 日期時間（08:00、11/01）已是無文字格式；`Asia/Taipei` 固定為歸零基準，翻譯不影響。

## frontend/index.html（7 筆）

- frontend/index.html:19  "回首頁"
- frontend/index.html:19  "Arcrun 首頁"
- frontend/index.html:28  "檢查小幫手版本與更新"
- frontend/index.html:29  版本與更新
- frontend/index.html:33  "淺色／深色"
- frontend/index.html:35  "需要協助？"
- frontend/index.html:35  "需要協助？打字回報、匯出診斷檔、或查看文件與常見問題"

## frontend/src/main.js（133 筆）

- frontend/src/main.js:111  '額度用完'
- frontend/src/main.js:116  '⏸ 額度用完'
- frontend/src/main.js:131  `<div class="sec">帳號</div>`
- frontend/src/main.js:134  `${needs.length} 則通知`
- frontend/src/main.js:134  '有新版可更新'
- frontend/src/main.js:137  '<b class="pip" aria-label="有事要看"></b>'
- frontend/src/main.js:138  '<b class="upd" aria-label="有新版可更新"></b>'
- frontend/src/main.js:142  "連結另一個帳號"
- frontend/src/main.js:142  "連結另一個帳號"
- frontend/src/main.js:217  `<button class="sp bad lnkpill" id="hLogs" title="同步引擎需要處理——按一下打開紀錄檔資料
- frontend/src/main.js:218  `<span class="sp" title="${ok} 個帳號正常" aria-label="${ok} 個帳號正常"><i></i>
- frontend/src/main.js:220  `<span class="sp bad" title="額度用完" aria-label="額度用完">⏸</span>`
- frontend/src/main.js:221  `<button class="sp bad lnkpill" id="notifToggle" aria-expanded="${noti
- frontend/src/main.js:222  `<span class="sp" title="${syncing.length} 個正在同步" aria-label="${syncin
- frontend/src/main.js:225  `<span class="sp quiet" title="自動重試中" aria-label="自動重試中: ${retry}">↻&t
- frontend/src/main.js:229  "到這個帳號看"
- frontend/src/main.js:231  "狀態列"
- frontend/src/main.js:234  `<span class="num" title="已整理的檔案數／全部檔案數">${p.done} / ${p.total}</span>
- frontend/src/main.js:268  "${esc(name)}（${esc(accs[idx].name)}）"
- frontend/src/main.js:268  "${esc(name)} · 寫入 ${esc(accs[idx].name)}"
- frontend/src/main.js:276  "我的 App"
- frontend/src/main.js:279  "從某個帳號加一個 App"
- frontend/src/main.js:279  "從某個帳號加一個 App 到首頁"
- frontend/src/main.js:304  '上次查到的版本（現在暫時連不上）'
- frontend/src/main.js:309  `<span class="kbv unknown" role="img" title="還沒查到這個知識庫的版本">○</span>`
- frontend/src/main.js:311  `<span class="kbv${dim}" title="${esc(tip || '暫時查不到最新版本，稍後自動再查')}">${e
- frontend/src/main.js:316  "前往安裝頁更新這個知識庫"
- frontend/src/main.js:316  "前往安裝頁更新這個知識庫"
- frontend/src/main.js:355  `<div class="card alertcard okflash" role="status"><div class="nt">✓ 已
- frontend/src/main.js:364  "關閉"
- frontend/src/main.js:364  "關閉"
- frontend/src/main.js:366  `<details class="more"><summary>⚠ 停住 ${total}</summary>${lines}</detai
- frontend/src/main.js:367  `<div class="nt" data-data="1" title="${esc(Array.from(list[0].label).
- frontend/src/main.js:396  ` · 排隊 ${p.pending}`
- frontend/src/main.js:399  "關閉"
- frontend/src/main.js:399  "關閉"
- frontend/src/main.js:402  "額度怎麼算"
- frontend/src/main.js:402  "額度怎麼算"
- frontend/src/main.js:438  `<li><span>${esc(g.category)}</span><span>${g.count} 份</span></li>`
- frontend/src/main.js:500  `<div class="pt">✓ 已回報</div>`
- frontend/src/main.js:501  `<div class="pt">${esc(o.why || '')}</div><button class="primary" data
- frontend/src/main.js:514  `<span class="fstat run" role="img" title="同步中" aria-label="同步中"><i cl
- frontend/src/main.js:517  `<span class="fstat ok" role="img" title="已全部送上" aria-label="已全部送上"><s
- frontend/src/main.js:524  `<span class="sp" title="還在確認">—</span>`
- frontend/src/main.js:579  ' 份格式還讀不了'
- frontend/src/main.js:580  ' 份不在收檔範圍（程式碼等）'
- frontend/src/main.js:581  ' 份處理中'
- frontend/src/main.js:585  '、'
- frontend/src/main.js:586  `等 ${s.inProgress.length} 份`
- frontend/src/main.js:587  `大檔分次讀：${shown}${more}`
- frontend/src/main.js:603  `<div class="ftmsg">讀取中…</div>`
- frontend/src/main.js:608  `<div class="ftmsg" title="還沒掃到，第一次同步跑完就會出現">—</div>`
- frontend/src/main.js:613  `<div class="ftmsg" title="這個資料夾目前是空的">∅</div>`
- frontend/src/main.js:633  ` aria-expanded="${open}" title="${open ? '收合' : '展開'}「${esc(n.name ||
- frontend/src/main.js:637  `<span class="nm">${esc(n.name || '（未命名）')}</span>`
- frontend/src/main.js:654  '已手動收進來'
- frontend/src/main.js:657  `${tree.reason}（${why}）`
- frontend/src/main.js:665  ` data-twhy="${esc(n.path)}" data-twroot="${esc(path)}" role="button" 
- frontend/src/main.js:677  `<button class="ftinc" data-tiroot="${esc(path)}" data-tinode="${esc(n
- frontend/src/main.js:679  `<button class="ftinc" data-tiroot="${esc(path)}" data-tinode="${esc(n
- frontend/src/main.js:704  `<div class="ftmsg" title="只顯示前 ${nodes.length} 個資料夾，實際有 ${tree.total_
- frontend/src/main.js:731  `<div class="err">讀不到這個資料夾的結構：${esc(String(e))}</div>`
- frontend/src/main.js:777  '收進來…'
- frontend/src/main.js:777  '收回…'
- frontend/src/main.js:782  '收進來'
- frontend/src/main.js:782  '取消收進來'
- frontend/src/main.js:784  '沒設定成功：'
- frontend/src/main.js:799  `<div class="err">讀不到這個資料夾的結構：${esc(String(e))}</div>`
- frontend/src/main.js:816  '查不到這個知識庫的剩餘用量（它的雲端版本較舊，更新後就會出現）'
- frontend/src/main.js:827  `<span class="inf" title="付費帳號：用完免費額度也不會停">∞</span>${b.billing ? '<spa
- frontend/src/main.js:843  '同步'
- frontend/src/main.js:843  '資料夾'
- frontend/src/main.js:843  '用量'
- frontend/src/main.js:843  '設定'
- frontend/src/main.js:878  `<span class="sp"><span class="kbv" title="有新版 ${esc(a.cloudVerLatest 
- frontend/src/main.js:879  `<span class="sp"><span class="kbv${a.cloudVerFresh ? '' : ' dim'}" ti
- frontend/src/main.js:882  '這個帳號的檔案'
- frontend/src/main.js:883  '已送上'
- frontend/src/main.js:884  '排隊中'
- frontend/src/main.js:885  `<span class="sp" title="還沒有檔案進度">—</span>`
- frontend/src/main.js:888  `<span class="sp" title="近一小時送上" aria-label="近一小時送上: ${a.sentHour}"><s
- frontend/src/main.js:890  `<span class="sp" title="同步中" aria-label="同步中"><i class="beat big"></i
- frontend/src/main.js:891  `<span class="sp" title="全部完成" aria-label="全部完成">${SYM.done}</span>`
- frontend/src/main.js:894  `<span class="sp bad" title="額度用完" aria-label="額度用完">⏸</span>`
- frontend/src/main.js:895  `<span class="sp quiet" title="自動重試中" aria-label="自動重試中: ${a.trouble.c
- frontend/src/main.js:896  `<section class="strip acc" aria-label="這個帳號的狀態列">${lead}${ver}${cells
- frontend/src/main.js:902  "這個帳號"
- frontend/src/main.js:941  '⚠ 收回'
- frontend/src/main.js:942  `收回中${f.retireRemaining ? `
- frontend/src/main.js:947  "展開這個資料夾"
- frontend/src/main.js:947  "展開或收合這個資料夾的內容"
- frontend/src/main.js:951  "移除這個資料夾"
- frontend/src/main.js:951  "移除這個資料夾並從知識庫收回"
- frontend/src/main.js:954  "這個知識庫還沒有資料夾"
- frontend/src/main.js:968  '看不到這個知識庫的 App'
- frontend/src/main.js:974  "已安裝的 App"
- frontend/src/main.js:982  '已釘'
- frontend/src/main.js:982  '釘選'
- frontend/src/main.js:985  "到知識庫網頁加裝 App"
- frontend/src/main.js:1005  `<div><div class="k">帳號</div><div class="mono">${esc(a.email)}</div></
- frontend/src/main.js:1016  "關閉"
- frontend/src/main.js:1016  "關閉"
- frontend/src/main.js:1025  '查詢中…'
- frontend/src/main.js:1026  `<button class="primary" id="uCheck">檢查更新</button>`
- frontend/src/main.js:1029  `<button class="primary" id="uApply">重啟更新</button>`
- frontend/src/main.js:1032  `<button class="primary" id="uDownload">更新</button>`
- frontend/src/main.js:1037  `<div class="d" title="你已經是最新版本">✓</div>`
- frontend/src/main.js:1074  "只有統計數字，不含你的任何文件內容"
- frontend/src/main.js:1103  '請先填寫'
- frontend/src/main.js:1108  '送出中…'
- frontend/src/main.js:1111  '已送出 ✓'
- frontend/src/main.js:1232  `<div class="appview">${head('', id, '')}<div class="card"><div class=
- frontend/src/main.js:1238  "要打開 App 的畫面或執行它的動作，需要在這個知識庫登入一次；之後這台電腦會記住一段時間，同步不受影響"
- frontend/src/main.js:1250  '打不開這個 App'
- frontend/src/main.js:1266  "這個 App 沒有自己的畫面，也沒有登記任何工作流"
- frontend/src/main.js:1426  '重試'
- frontend/src/main.js:1427  `<details class="more"><summary>⚠ 沒送出</summary><div class="d one raw">
- frontend/src/main.js:1445  '重試'
- frontend/src/main.js:1447  `<details class="more"><summary>⚠ 沒送出</summary><div class="d one raw">
- frontend/src/main.js:1544  '執行中…'
- frontend/src/main.js:1547  '完成：'
- frontend/src/main.js:1549  '失敗：'
- frontend/src/main.js:1653  "清掉 Arcrun 放在這個資料夾裡的檔案"
- frontend/src/main.js:1665  '看不到清單：'
- frontend/src/main.js:1685  `<b>刪 ${rm.length} 項（${plan.files} 個檔）</b><ul style="margin:4px 0 0 16
- frontend/src/main.js:1686  `<li>${esc(it.rel)}${it.is_dir ? '／' : ''}（${it.files} 個檔）</li>`
- frontend/src/main.js:1690  `<b style="display:block;margin-top:8px">留 ${keep.length} 項</b><ul sty
- frontend/src/main.js:1719  '查詢中…'
- frontend/src/main.js:1724  '下載中…請稍候'
- frontend/src/main.js:1736  '匯出中…'
- frontend/src/main.js:1739  `已存到：${path}`
- frontend/src/main.js:1739  '已取消'
- frontend/src/main.js:1741  '匯出失敗：'

## frontend/src/usage.js（9 筆）

- frontend/src/usage.js:93  `<div class="card udash unk"><div class="ulamp" title="查不到 Cloudflare 
- frontend/src/usage.js:98  '付費方案 超出才收費'
- frontend/src/usage.js:98  '地端 沒有帳單'
- frontend/src/usage.js:98  '免費方案 超出會暫停'
- frontend/src/usage.js:101  `<span class="ulamp warn" title="數字已過時 稍後更新" aria-label="數字已過時">${S.st
- frontend/src/usage.js:110  `<span class="urate" title="每分鐘增加">+${fmt(top.rate)}<small>/m</small><
- frontend/src/usage.js:119  `<span class="ucell upg na" title="地端沒有帳單" aria-label="地端沒有帳單">${S.upN
- frontend/src/usage.js:127  "用量來自你自己的 Cloudflare 帳號"
- frontend/src/usage.js:127  "用量來自你自己的 Cloudflare 帳號"

## activity_state.go（12 筆）

- activity_state.go:56  "額度用完"
- activity_state.go:58  "沒在跑"
- activity_state.go:60  "沒在動"
- activity_state.go:66  "新問題"
- activity_state.go:78  "【自動回報：小幫手沒在跑】用戶按了「回報」。\n\n"
- activity_state.go:79  "- 知識庫：%s（%s）\n"
- activity_state.go:81  "- 資料夾：%s\n"
- activity_state.go:83  "- 狀態：%s（%s）%d 份\n"
- activity_state.go:84  "- 進度：共 %d／已送上 %d／排隊 %d／卡住 %d\n"
- activity_state.go:86  "- 檔名樣本：%v\n"
- activity_state.go:89  "- 錯誤原文："
- activity_state.go:91  "- 小幫手版本：%s\n\n（此回報由小幫手自動產生，不含任何文件內容。）"

## app.go（65 筆）

- app.go:146  "舊版 Word"
- app.go:148  "舊版 Excel"
- app.go:150  "舊版 PowerPoint"
- app.go:164  "郵件檔"
- app.go:188  "設定檔裡殘留舊的 AI 金鑰欄位，已抹除（萃取改走雲端 AI，本機不再存金鑰）"
- app.go:198  "設定檔缺必填欄位，已自動補上 manifest=%v"
- app.go:399  "不限用量"
- app.go:403  "不限用量・免費額度今日剩 %s%%"
- app.go:412  "今日剩餘用量 %s%%"
- app.go:416  "今天的用量已經用完：這個知識庫暫時不收新資料，明天用量重新計算後會自動接著送。想現在就繼續，請到「管理」頁放行，或升級付費方案。"
- app.go:419  "今日用量只剩 %s%%：小幫手已改成省著用——每次少送一些、放慢節奏、先不做補送，把用量留給日常操作。想不受限制，請到「管理」頁放行，或升
- app.go:422  "今日用量剩 %s%%：快用完時小幫手會自動放慢；用完後雲端會暫時不收新資料。想不受限制，請到「管理」頁放行，或升級付費方案。"
- app.go:474  "同步中… "
- app.go:477  "看守中 · 目前沒有在處理這個知識庫"
- app.go:481  "看守中 · 資料夾有變動就會自動整理"
- app.go:503  "已暫停自動重試"
- app.go:514  "這個知識庫有 %d 份現在送不上去"
- app.go:668  "%s（%s）"
- app.go:674  "有 %d 個檔案現在還讀不了"
- app.go:676  "這些格式我們還沒支援，所以沒有進你的知識庫。等支援了會自動補上，你不用重丟。"
- app.go:677  "急著要的話，先用原本的軟體另存成 PDF 或 Word（.docx）放進同一個資料夾就行。"
- app.go:680  "另外有 %d 個不是文件的檔案（圖片、影片、壓縮檔之類）也沒有處理。"
- app.go:692  "有 %d 個檔案沒有被整理"
- app.go:693  "看起來不是文件（圖片、影片、壓縮檔之類），所以跳過了。這是正常的，你不用做什麼。"
- app.go:721  "看守資料夾"
- app.go:721  "有變動就自動開始"
- app.go:725  "發現變化"
- app.go:726  "用 AI 整理成知識卡"
- app.go:726  "進行中"
- app.go:727  "上傳到你的知識庫"
- app.go:738  "等待中"
- app.go:741  "上次 "
- app.go:743  "已處理"
- app.go:748  "上次 %d 份"
- app.go:750  "上傳到你的知識庫"
- app.go:752  "%s · ⚠ %d 份失敗"
- app.go:756  "發現變化"
- app.go:757  "用 AI 整理成知識卡"
- app.go:772  "清理已刪除的預設庫引用失敗：%v"
- app.go:784  "清理已收回的資料夾失敗：%v"
- app.go:944  "已自動重試 %d 次都失敗，所以重新開啟也沒有用。"
- app.go:946  "原因："
- app.go:948  "詳細訊息請看記錄檔 app.log。"
- app.go:950  "同步引擎一直啟動失敗"
- app.go:958  "正在啟動同步引擎，請稍候…"
- app.go:960  "還沒連上知識庫 ⇒ 按「新增知識庫帳號」就會開始"
- app.go:963  "原因：%s（已重試 %d 次）"
- app.go:965  "同步引擎沒有在跑"
- app.go:968  "同步中… 正在讀檔並整理成知識卡"
- app.go:971  "需要你處理一下"
- app.go:981  "上次檢查 "
- app.go:991  "%s已整理 %d 份"
- app.go:1000  "⚠ %d 份失敗"
- app.go:1005  "%d 個知識庫要處理（到該知識庫的頁面看原因）"
- app.go:1007  "看守中 · 資料夾有變動就會自動整理"
- app.go:1009  "還沒有同步紀錄"
- app.go:1071  "選一個要自動整理的資料夾"
- app.go:1084  "找不到這個知識庫帳號"
- app.go:1096  "這個資料夾正在從雲端收回資料，等它收完再加回來（可在畫面上看到進度）"
- app.go:1146  "找不到這個知識庫帳號"
- app.go:1179  "資料夾已經移除，但清理 Arcrun RAG 建立的檔案時出錯：%w"
- app.go:1181  "資料夾已經移除，但有 %d 個項目刪不掉（第一個：%s——%s）"
- app.go:1204  "找不到這個知識庫帳號"
- app.go:1355  "要收哪個資料夾？"
- app.go:1375  "要收回哪個資料夾？"

## apps.go（15 筆）

- apps.go:134  "找不到這個知識庫"
- apps.go:145  "連不上這個知識庫——請確認網路正常"
- apps.go:162  "這個知識庫還沒有 App 功能（實例版本較舊，更新後就會出現）"
- apps.go:164  "這個知識庫的登入已過期"
- apps.go:166  "知識庫回了 HTTP %d"
- apps.go:217  "找不到這個知識庫"
- apps.go:241  "清掉過期的知識庫登入失敗：%v"
- apps.go:254  "連線成功但沒換到知識庫的 App 登入（不影響同步）：%v"
- apps.go:292  "這個知識庫沒有網址，請重新連線一次"
- apps.go:320  "這台電腦還沒有這個知識庫的鑰匙，請重新連線一次"
- apps.go:416  "這個知識庫回的內容看不懂（版本可能不相容）"
- apps.go:444  "沒有指定要做什麼"
- apps.go:447  "這個知識庫的登入已過期，請在畫面上重新登入一次"
- apps.go:452  "送出的內容格式不對"
- apps.go:489  "這個知識庫沒有記錄帳號，請用「新增知識庫帳號」重新連一次"

## connect.go（6 筆）

- connect.go:40  "請貼上你的知識庫網址"
- connect.go:47  "網址看起來不太對，請從信裡或瀏覽器網址列複製整段"
- connect.go:69  "連不上這個網址——請確認網址正確、網路正常"
- connect.go:74  "這個網址不像是 Arcrun RAG 知識庫，請再確認一次"
- connect.go:77  "帳號或密碼不對——用你在知識庫網站設定的那組"
- connect.go:83  "連線失敗，請稍後再試一次"

## default_library.go（5 筆）

- default_library.go:44  "Arcrun 範例庫（可刪除）"
- default_library.go:54  "01-關於這個資料夾.md"
- default_library.go:63  "02-Arcrun-是什麼.md"
- default_library.go:74  "03-怎麼使用.md"
- default_library.go:96  "預設庫建立失敗（不影響本次連線）：%v"

## diagnostics_export.go（13 筆）

- diagnostics_export.go:116  "這個帳號還沒設定知識庫網址"
- diagnostics_export.go:119  "這個帳號還沒有連線金鑰"
- diagnostics_export.go:130  "連不上你的知識庫：%w"
- diagnostics_export.go:137  "你的知識庫還是舊版（沒有雲端診斷功能）⇒ 請到 portal 按「立即更新」重裝一次"
- diagnostics_export.go:140  "雲端診斷查詢失敗（HTTP %d）：%.300s"
- diagnostics_export.go:145  "雲端回應解析失敗：%w"
- diagnostics_export.go:324  '、'
- diagnostics_export.go:324  '（'
- diagnostics_export.go:324  '）'
- diagnostics_export.go:325  '，'
- diagnostics_export.go:325  '；'
- diagnostics_export.go:340  "本機路徑"
- diagnostics_export.go:397  "匯出診斷檔"

## feedback.go（9 筆）

- feedback.go:105  "（尚未連上知識庫）"
- feedback.go:123  "請先寫下你遇到的狀況再送出"
- feedback.go:127  "一小時內送了太多則回報，請稍後再試（你寫的內容還在，不會消失）"
- feedback.go:151  "組回報內容失敗：%w"
- feedback.go:155  "沒送出去，請再試一次（%v）"
- feedback.go:161  "沒送出去，請再試一次（網路錯誤：%v）"
- feedback.go:166  "沒送出去，請再試一次（回報服務暫時有問題，代碼 %d）"
- feedback.go:183  "工作流回報失敗"
- feedback.go:185  "沒送出去：%s"

## folder_badge.go（5 筆）

- folder_badge.go:71  "還在確認這個資料夾"
- folder_badge.go:78  "還沒有可整理的檔案"
- folder_badge.go:80  "沒有可同步的檔案"
- folder_badge.go:82  "已同步 · %d 份"
- folder_badge.go:84  "同步中 · 還有 %d 份"

## main.go（1 筆）

- main.go:204  "視窗依螢幕 %dx%d 設為 %dx%d（%.0f%%）"

## selfupdate.go（20 筆）

- selfupdate.go:121  "manifest 沒有 daemon 版本欄位"
- selfupdate.go:226  "下載 HTTP %d"
- selfupdate.go:244  "檔案校驗不符（可能下載不完整），已丟棄"
- selfupdate.go:262  "自動下載失敗："
- selfupdate.go:289  "沒有已備妥的更新"
- selfupdate.go:292  "更新檔不見了，請再檢查一次更新"
- selfupdate.go:321  "覆蓋失敗（可能需要權限）：%v %s"
- selfupdate.go:327  "重新啟動失敗：%v %s"
- selfupdate.go:344  "找不到自己的執行檔位置：%w"
- selfupdate.go:352  "這份 Arcrun RAG 不是從 .app 啟動的（%s）⇒ 請改用下載頁的 .app 版本再更新"
- selfupdate.go:372  "解壓失敗：%v %s"
- selfupdate.go:376  "更新檔內容不符（找不到 Arcrun.app）"
- selfupdate.go:380  "不認得的更新檔格式（%s）：非 .dmg 也非 .zip"
- selfupdate.go:392  "掛載 DMG 失敗：%v %s"
- selfupdate.go:397  "DMG 裡找不到 Arcrun.app"
- selfupdate.go:401  "從 DMG 複製失敗：%v %s"
- selfupdate.go:435  "找不到自己的執行檔位置：%w"
- selfupdate.go:443  "換掉正在跑的執行檔失敗（rename）：%w"
- selfupdate.go:448  "寫入新版執行檔失敗：%w"
- selfupdate.go:455  "重新啟動失敗：%v %s（新版已就緒於 %s，可手動雙擊開啟）"

## stalls.go（13 筆）

- stalls.go:119  "【自動回報：檔案停工】小幫手偵測到多份檔案因同一個原因停工，用戶按了「回報給 Arcrun」。\n\n"
- stalls.go:120  "- 知識庫：%s（%s）\n"
- stalls.go:121  "- 原因分類：%s（%s）\n"
- stalls.go:122  "- 停工份數：%d（每份已失敗 %d～%d 次）\n"
- stalls.go:123  "- 檔名樣本：%s\n"
- stalls.go:123  "、"
- stalls.go:124  "- 錯誤原文：%s\n"
- stalls.go:125  "- 小幫手版本：%s\n"
- stalls.go:126  "\n（此回報由小幫手自動產生，不含任何文件內容。）"
- stalls.go:135  "讀不到設定，沒送出去"
- stalls.go:146  "這個問題現在已經不在停工清單裡了（可能已經自己好了），不用回報"
- stalls.go:155  "記錄已回報失敗：%v"
- stalls.go:167  "讀不到設定"

## supervise.go（4 筆）

- supervise.go:58  "啟動同步引擎失敗：取不到自己的執行檔路徑"
- supervise.go:62  "尚未連上知識庫（沒有 %s），同步引擎先不啟動"
- supervise.go:82  "同步引擎異常結束（第 %d 次重試）：%s"
- supervise.go:85  "同步引擎已啟動：%s"

## syncing_sub.go（9 筆）

- syncing_sub.go:26  "請稍候，完成後會顯示整理了幾份"
- syncing_sub.go:41  "%s（%s）"
- syncing_sub.go:50  "卡在「%s」：%s"
- syncing_sub.go:52  "卡住了："
- syncing_sub.go:57  "正在處理 "
- syncing_sub.go:59  "："
- syncing_sub.go:64  "這一輪已送上 %d 份"
- syncing_sub.go:67  "%d 份沒送成功"
- syncing_sub.go:71  "已經 %d 分鐘沒有新進展"

## textbudget.go（18 筆）

- textbudget.go:65  "⚠ 送不上 %d"
- textbudget.go:80  "⊘ 讀不了 %d"
- textbudget.go:95  "搜尋另計額度"
- textbudget.go:97  "搜尋額度用完"
- textbudget.go:100  "尚無資料"
- textbudget.go:103  "尚無資料"
- textbudget.go:114  "∞ 剩 "
- textbudget.go:118  "剩 "
- textbudget.go:121  "⏸ 用量用完"
- textbudget.go:123  "⚠ 用量 "
- textbudget.go:123  "% · 放慢"
- textbudget.go:125  "⚠ 用量 "
- textbudget.go:132  "額度用完"
- textbudget.go:135  "讀取額度用完"
- textbudget.go:137  "寫入額度用完"
- textbudget.go:140  "⏸ %s · %s 恢復"
- textbudget.go:177  "。，；"
- textbudget.go:189  "%s（%d 字，上限 %d）：%s"

## tray_darwin.go（2 筆）

- tray_darwin.go:35  "Arcrun — 你的知識庫同步小幫手"
- tray_darwin.go:36  "結束 Arcrun"

## tray_windows.go（3 筆）

- tray_windows.go:53  "Arcrun — 你的知識庫同步小幫手"
- tray_windows.go:57  "結束 Arcrun"
- tray_windows.go:57  "結束 Arcrun（同步會停止）"

## update_api.go（3 筆）

- update_api.go:33  "暫時連不上更新伺服器："
- update_api.go:83  "暫時連不上更新伺服器："
- update_api.go:92  "下載失敗："

## usageui.go（29 筆）

- usageui.go:63  "AI 萃取 neurons"
- usageui.go:64  "向量儲存 維度"
- usageui.go:65  "向量查詢 維度"
- usageui.go:66  "資料庫寫入 列"
- usageui.go:67  "資料庫讀取 列"
- usageui.go:68  "運算時間 ms"
- usageui.go:69  "請求數"
- usageui.go:70  "磁碟"
- usageui.go:152  "每天 "
- usageui.go:152  " 歸零"
- usageui.go:155  "每月 "
- usageui.go:155  " 歸零"
- usageui.go:176  "本月約 "
- usageui.go:182  "超出 "
- usageui.go:184  "線 "
- usageui.go:187  "已用 "
- usageui.go:201  "最吃緊 %s %d%%"
- usageui.go:203  "最吃緊 %s %d%%"
- usageui.go:206  "沒有會爆的項目"
- usageui.go:213  "本月約 "
- usageui.go:214  "到 Cloudflare 看帳單"
- usageui.go:217  "建議升級 Cloudflare"
- usageui.go:219  "先不用 要時可升級"
- usageui.go:227  "地端不需要剎車"
- usageui.go:229  "查不到剎車狀態"
- usageui.go:231  "剎車已開 接近線自動放慢"
- usageui.go:233  "剎車已關 不會自動放慢"
- usageui.go:240  "來自 Cloudflare 約 %d 分鐘前"
- usageui.go:242  "本機自行計量"

## c18700 新增（0.18.87，inkstone/arcrun-rag#246）

> 這一批只有 title／aria-label（mouseover）與出錯檔那一列的短標籤；畫面上常駐的字沒有增加。

- frontend/src/main.js  "同步"（圖示按鈕 title／aria-label）
- frontend/src/main.js  "回首頁"（圖示按鈕）
- frontend/src/main.js  "開啟知識庫網頁"（雲圖示）
- frontend/src/main.js  "重整"（圖示按鈕）
- frontend/src/main.js  "加資料夾"（圖示按鈕）
- frontend/src/main.js  "現在計費"（$ 的 aria-label）
- frontend/src/main.js  "CF 帳號"／"Cloudflare 帳號"（側欄分區、設定頁標籤；title 是全名）
- frontend/src/main.js  "點一下看是哪幾份"（!N 的 title 後綴）
- frontend/src/main.js  "怎麼處理"（FAQ 鈕）／"回報給 Arcrun"（回報鈕）／"已回報"／"重試"
- frontend/src/main.js  "自動重試中，不用處理"／"我們還沒有這類問題的解法"（出錯檔 title）
- frontend/src/main.js  "把檔案拆小或壓縮後再放回資料夾"／"換成可複製文字的版本（掃描檔先做文字辨識）"／"改個不一樣的檔名"／"轉成 PDF 或 Markdown 再放回來"（解法，只放 mouseover）
- collector/foldertree.go  "新問題"／"重試中"（出錯檔短標籤，≤6 字；「檔案太大」等沿用 progress.go FixableKind）

## c18722 變動（0.18.88，inkstone/arcrun-rag#246）

- 移除字串：出錯檔解法提示「名稱撞名／改個不一樣的檔名」（`frontend/src/main.js` FIX_HINT）與標籤「名稱撞名」（`progress.go` FixableKind）——撞名改由機器消歧，不再出現在 !N。
- FAQ（docs-site/src/content/docs/help/faq.md）本來就沒有撞名條目，沒有要拿掉的；其餘條目逐條看過：均為用戶端才做得到的事（簽章按鈕、帳號切換）或「不用做任何事」的說明。

## c18734 變動（0.18.89，inkstone/arcrun-rag#246）

- collector/contenttwin.go  "內容和「…」一模一樣，已併成同一張卡（出處多寫一行）"（同內容的檔記錄在 manifest 結果列，不進 !N）
- collector/direct.go  "有一份內容一模一樣的檔正在整理，整理好後會併成同一張卡"（同輪同內容兩份，後到的先等；不算失敗）
- collector/direct.go  "更新合併卡的出處失敗：…"（雲端沒回時；照一般送出失敗退避，不是用戶要做的事）
