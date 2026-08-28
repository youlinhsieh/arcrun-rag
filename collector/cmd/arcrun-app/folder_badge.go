// folder_badge.go — 資料夾那一列的**同步狀態圖示**（`inkstone/arcrun-rag#159`）。
//
// leo 2026-08-28 原話：
//
//	「補送中是什麼意思？**不要發明奇怪狀態**⋯⋯他要知道的是『**我的資料夾是否同步了**』，
//	 **有同步打勾就好**」
//	「產生 GUI 就是要讓人減少讀字降低負擔，你在 GUI 寫這麼多字剛好違背它的原理」
//
// ── 這支檔存在的理由 ─────────────────────────────────────────────────────
// 在這之前，那一列的標籤是這樣算的（frontend/src/main.js:545）：
//
//	<span class="tag">${f.resyncNote ? '補送中' : '自動同步中'}</span>
//
// 也就是說它量的**不是同步狀態**，是「#140 那句補送說明是不是空字串」。
// 於是 2026-08-28 leo 的畫面上七列有六列寫「補送中」——連 `youlinhsieh-test1`
// （實測 `pending=0`、`repaired=2`，補送早就做完了）也照樣標補送中。
// ⇒ **標籤跟事實脫鉤**，而不是措辭不好聽。
//
// 現在改成從 `collector.SyncProgress` 算——那是 `(*Manifest).Progress()` 的原件，
// 與首頁大數字、診斷檔用的是同一個函式。**畫面上打的勾，跟首頁的數字同源。**
//
// ── 三種狀態，沒有第四種 ─────────────────────────────────────────────────
//
//	✅ ok       Done == Total     每一份我認得的檔都送進知識庫了，而且送上去之後沒再改過
//	🔄 working  還沒送完，但沒有出錯的跡象
//	⚠️ trouble  已經放棄自動重試（Stuck），或**一份都還沒成功而且每一份都失敗過**
//
// 🔴 第三種的第二個條件是 leo 那句「Geek6688 很久沒碰了也顯示補送中？」逼出來的。
// 實查他機器上的 manifest（2026-08-28）：`geek6688-test1` 的 14 份**每一份的
// fail_count 都大於 0**（7 與 3），錯誤是雲端回 `HTTP 500 Node post_block failed:
// Too many subrequests`，`done=0`。
// ⇒ 這不是「排隊中」，是「一直在撞牆」。標成同步中＝叫他等一件正在壞掉的事。
// ⇒ 但**單看「有檔案在重試」不夠**：`pms` 有 110 份待處理、其中只有 4 份在重試、
// 已經送成功 23 份——那是健康的積壓，標警告就變成新的噪音（實測 9 個資料夾裡
// 會有 7 個亮警告，等於回到 leo 抱怨的「滿畫面都是狀態」）。
// **所以第二個條件要求 `Done == 0`：一份都沒成功、而且全都在失敗，才叫撞牆。**
//
// 🔴 剛加進來、還沒開始送的資料夾（Failing == 0）落在 working，不會誤報警告。
package main

import (
	"fmt"

	collector "arcrun-rag/collector"
)

// 資料夾狀態的機器代碼。前端只認這三個字串，圖示與顏色由 CSS 決定
// ——狀態名不進畫面，畫面上只有一個圖示（GUI 的目的是讓人少讀字）。
const (
	folderSyncOK      = "ok"
	folderSyncWorking = "working"
	folderSyncTrouble = "trouble"
	// folderSyncUnknown＝collector 還沒回報過這個資料夾（剛加進來、第一輪還沒跑完）。
	// **不能落到 ok**——那會是「還沒查就打勾」，正是這張票的紅線。
	folderSyncUnknown = "unknown"
)

// folderBadge 把一個資料夾的同步現況翻成「一個狀態代碼＋一句短提示」。
//
// known＝status.json 裡有沒有這個資料夾的紀錄。沒有就是 unknown，不猜。
//
// 提示句刻意短：它住在 tooltip 裡，而 leo 的紅線是「**不要把長句子搬進 tooltip
// 裡繼續長**」。要看細節的人有診斷檔（疑難排解那張卡），不是靠這一行。
func folderBadge(p collector.SyncProgress, known bool) (state, tip string) {
	if !known {
		return folderSyncUnknown, "還在確認這個資料夾"
	}
	switch {
	case p.Total == 0:
		// 資料夾是空的、或裡面沒有我讀得了的檔。**不是「同步好了」**，
		// 所以不打勾——打勾要對應「東西真的在知識庫裡」。
		return folderSyncUnknown, "還沒有可整理的檔案"
	case p.Done == p.Total:
		return folderSyncOK, fmt.Sprintf("已同步 · %d 份", p.Done)
	case p.Stuck > 0:
		return folderSyncTrouble, fmt.Sprintf("%d 份一直送不上去", p.Stuck)
	case p.Done == 0 && p.Failing > 0:
		return folderSyncTrouble, fmt.Sprintf("%d 份都還沒送成功", p.Failing)
	default:
		return folderSyncWorking, fmt.Sprintf("同步中 · 還有 %d 份", p.Total-p.Done)
	}
}
