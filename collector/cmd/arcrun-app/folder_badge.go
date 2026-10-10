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
// 資料夾有**兩個獨立的維度**，各自一個符號、同時顯示（#240 c18410，leo 2026-10-09）：
//
//	① 同步：進行中（已送上/可送的總數）或 已完成 ✓。出錯的檔案不擋其他檔案——
//	   「已完成」＝除了出錯的以外都送完了。
//	② 出錯：有幾份出錯（放棄重試的＋正在失敗重試的），沒有就不顯示。
//
// leo：「你的設計如果有錯誤就只秀錯誤，沒錯誤就顯示同步中，實際上這是兩件事⋯
// 出錯檔案外，其他的也能同步。」以前把兩者合成一個狀態（partial／trouble），
// 一出錯進度就消失；現在環只管同步，出錯只是旁邊的數字。
package main

import (
	"fmt"

	collector "arcrun-rag/collector"
)

// 同步維度的機器代碼。前端只認這幾個字串；出錯數字另外給（folderErrors），不進這個代碼。
const (
	folderSyncOK      = "ok"      // 可同步的檔每一份都送上去了（出錯的不算）
	folderSyncWorking = "working" // 還有可同步的檔在送
	// folderSyncUnknown＝還不知道，或沒有可同步的檔（空資料夾／全部都在出錯）。
	// **不能落到 ok**——打勾要對應「東西真的在知識庫裡」。
	folderSyncUnknown = "unknown"
)

// folderErrors＝這個資料夾裡出錯的份數：已放棄重試的（Stuck）加正在失敗重試的（Failing）。
func folderErrors(p collector.SyncProgress) int { return p.Errors() }

// folderBadge 回同步維度的代碼與一句短提示（tooltip）。出錯與否不影響它。
func folderBadge(p collector.SyncProgress, known bool) (state, tip string) {
	if !known {
		return folderSyncUnknown, "還在確認這個資料夾"
	}
	e := folderErrors(p)
	syncable := p.Total - e
	switch {
	case syncable <= 0:
		if p.Total == 0 {
			return folderSyncUnknown, "還沒有可整理的檔案"
		}
		return folderSyncUnknown, "沒有可同步的檔案"
	case p.Done >= syncable:
		return folderSyncOK, fmt.Sprintf("已同步 · %d 份", p.Done)
	default:
		return folderSyncWorking, fmt.Sprintf("同步中 · 還有 %d 份", syncable-p.Done)
	}
}
