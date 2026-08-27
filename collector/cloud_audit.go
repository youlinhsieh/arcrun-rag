// cloud_audit.go — 本機帳本 ↔ 雲端索引對帳（`inkstone/arcrun-rag#140`）。
//
// 病（`inkstone/Arcrun#165` 斷點一，2026-08-26 實測）：
//
//	本機 manifest 蓋的「已送成功」章**永遠不會過期**。雲端在 2026-08-14 被重裝／清空之後，
//	那些檔案的 content_hash 沒變 ⇒ Scan() 不產生事件 ⇒ **永遠不會重送**，
//	而且**沒有任何地方會說話**。使用者看到的是「檔案明明在資料夾裡，AI 卻查不到」。
//	實據：youlinhsieh-test1 的 8 個檔 ingested_at 落在 07-29~08-06、零 fail_count，
//	雲端 D1 的 MIN(created_at) 卻是 08-14 20:27 ⇒ 分界線乾淨得可怕。
//
// 解的形狀（**不是把兩邊砍掉重來**，那是紅線）：
//
//	章不再是「我送過了」，而是「我送過了**而且雲端現在還有**」。
//	後半句本機答不出來，只能去問雲端 ⇒ 這支檔就是那個問句。
//
// 為什麼問得起（不必等雲端先改）：cypher-executor 早就有 `/kbdb/entries` proxy，
// 認證用的正是 daemon 本來就帶著的 `X-Arcrun-API-Key`（routes/kbdb-proxy.ts，
// owner_id 由 server 端強制注入，租戶跨不過去）。⇒ **零雲端改動、零新憑證。**
//
// 三條自我約束（對應票上的紅線）：
//   - **不刪任何東西**：對帳只會把本機的章拔掉（讓它重走既有的送件路），
//     不碰雲端 entry、不碰 .wiki 卡、不碰使用者的檔。
//   - **不做全量重送**：一次只問 cloudAuditBatch 個檔，且同一個檔
//     cloudAuditRecheckInterval 內只問一次；問到「雲端沒有」才拔章。
//   - **不會重送兩次**：拔過章的檔在 cloudAuditRepairGrace 內不再被拔第二次
//     （雲端 ingest 是非同步的，剛送出去那幾秒查不到是正常的——
//     沒有這道閘，它會變成一個每輪重送、把額度燒光的迴圈，
//     那就是「把一個 bug 換成另一個」）。
package collector

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// cloudAuditRecheckInterval＝同一個檔多久重新對一次帳。
// 24 小時的理由：這是「雲端被清空」這種罕見事故的偵測延遲上限，
// 而使用者按「立刻同步」（ForceSync）時本輪一律重對，不必等它。
const cloudAuditRecheckInterval = 24 * time.Hour

// cloudAuditRepairGrace＝同一個檔拔過章之後，多久內不准再拔第二次。
//
// 🔴 這是「重跑第二次不可以又全部重送一遍」（#140 驗收條件 5）的那道閘。
// 雲端 rag_ingest_card 是觸發式的，卡片不會在 POST 回來的那一瞬間就查得到；
// 沒有這個窗口，對帳會在下一輪又判它「不在」⇒ 重送 ⇒ 無限迴圈 ⇒ 燒光額度。
const cloudAuditRepairGrace = 24 * time.Hour

// cloudAuditBatch＝單輪最多問幾個檔。
// 與 DefaultMaxEventsPerRun 同一個精神：巨量積壓（實據 27,164 檔）不該一輪湧完。
const cloudAuditBatch = 20

// cloudAuditFolderInterval＝同一個資料夾兩次對帳批次的最小間隔。
// daemon 預設 5 秒一輪，沒有這道節流就是每 5 秒 20 個請求。
const cloudAuditFolderInterval = 60 * time.Second

// cloudAuditProbePace＝批次內每個請求之間的間隔。
// 比 directPaceInterval（700ms）短很多是因為這是 D1 的單筆 COUNT，不是 LLM——
// 20 個請求約 2 秒跑完，不會讓一輪掃描明顯變慢。
const cloudAuditProbePace = 100 * time.Millisecond

// cloudAuditHTTP：對帳是唯讀查詢，逾時要短——問不到就當「這輪沒查」，
// 絕不能因為雲端慢就把整輪同步拖住（同 cloud_version.go 的判準）。
var cloudAuditHTTP = &http.Client{Timeout: 20 * time.Second}

// probeCloudCard 可在測試中替換，避免真實網路呼叫。
var probeCloudCard = cloudCardPresent

// cloudCardPresent 問雲端「這個庫裡還有沒有這個檔的卡」。
//
// 判準＝`metadata_json.source == kb://<相對路徑>#0`。為什麼是 `#0` 而不是頁名：
//   - 頁名是 basename 去副檔名（pageNameOf），**兩個資料夾裡的同名檔會撞在一起**；
//   - `source` 是 rag_ingest_card parse_card 寫死的 `kb://<path>#<第幾塊>`，
//     而第 0 塊必然存在（卡片至少一塊）⇒ 它就是「這張卡在不在」的存在性鍵，
//     也正是 rag_takedown_direct 用來比對的同一個鍵（兩邊用同一把尺）。
//
// `offset` 故意帶一個大數：回應只要 `total`，不要 entries 本身——
// 卡片內文動輒數 KB，20 個檔就是幾百 KB 的白搭流量。
//
// 回傳的 ok=false＝**這次沒查成**（連不上、非 2xx、回應不是 JSON）。
// 呼叫端必須把它當「不知道」，**不准當成「雲端沒有」**——
// 那會讓一次網路抖動變成一次全量重送。
func cloudCardPresent(cfg *DirectConfig, library, relPath string) (present bool, ok bool, err error) {
	base := strings.TrimSuffix(cfg.CypherURL, "/")
	if base == "" || strings.TrimSpace(cfg.APIKey) == "" {
		return false, false, fmt.Errorf("沒有雲端連線資訊（cypher_url／api_key 是空的）")
	}
	q := url.Values{}
	q.Set("source", "kb://"+relPath+"#0")
	q.Set("entry_type", "block")
	q.Set("limit", "1")
	q.Set("offset", "1000000") // 只要 total，不要把卡片內文整包拉下來
	if strings.TrimSpace(library) != "" {
		q.Set("library", library)
	}
	// #153：對帳一輪可能連打 cloudAuditBatch（20）發。「一發卡住」的代價在這裡
	// 會被乘上批次大小 ⇒ 20 秒的 client 逾時最壞就是 400 秒，而這期間畫面一個字
	// 都不會說。掛上等待閘：等到超時就記帳，同一個帳號連續等不到就整輪不再問。
	gate := cfg.openGate(stepCloudAudit)
	defer gate.release()
	if note := gate.blocked(); note != "" {
		return false, false, errors.New(note)
	}
	req, err := http.NewRequestWithContext(gate.ctx, http.MethodGet, base+"/kbdb/entries?"+q.Encode(), nil)
	if err != nil {
		return false, false, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Arcrun-API-Key", cfg.APIKey)
	resp, err := cloudAuditHTTP.Do(req)
	if err != nil {
		return false, false, gate.record(err)
	}
	gate.ok()
	defer resp.Body.Close()
	body, rerr := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, false, fmt.Errorf("HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if rerr != nil {
		return false, false, rerr
	}
	var payload struct {
		Success *bool `json:"success"`
		Total   *int  `json:"total"`
	}
	if jerr := json.Unmarshal(body, &payload); jerr != nil {
		return false, false, fmt.Errorf("雲端回應不是 JSON：%s", strings.TrimSpace(string(body)))
	}
	// 🔴 total 缺席時回 ok=false 而不是「total=0」。少一個欄位可能是端點換了形狀，
	//    把它讀成「雲端沒有這個檔」就會全部重送——寧可什麼都不做。
	if payload.Total == nil || (payload.Success != nil && !*payload.Success) {
		return false, false, fmt.Errorf("雲端回應少了 total 欄位：%s", strings.TrimSpace(string(body)))
	}
	return *payload.Total > 0, true, nil
}

// auditCandidates 挑出這一輪要問的檔：蓋過章、且太久沒對過帳的，最久沒對的排前面。
//
// 三種**不問**（每一種都對應一個會咬人的情境）：
//   - 沒蓋過章（IngestedHash 空）：雲端本來就不該有它，Scan() 自己會重送。
//   - NoCloudCard：萃取判定「無可萃取概念」⇒ 本來就沒送過卡上雲。
//     不排除它的話，對帳每次都會說「雲端沒有」⇒ 每天重萃一次，永遠停不下來。
//   - 剛拔過章還在 grace 內：見 cloudAuditRepairGrace。
func auditCandidates(m *Manifest, now int64, force bool) []string {
	recheck := int64(cloudAuditRecheckInterval.Seconds())
	grace := int64(cloudAuditRepairGrace.Seconds())
	var out []string
	for p, e := range m.Entries {
		if e == nil || strings.TrimSpace(e.IngestedHash) == "" || e.NoCloudCard {
			continue
		}
		if e.CloudMissingAt > 0 && now-e.CloudMissingAt < grace {
			continue
		}
		if !force && e.CloudCheckedAt > 0 && now-e.CloudCheckedAt < recheck {
			continue
		}
		out = append(out, p)
	}
	// 最久沒對帳的先問（0＝從沒問過，天然排最前）；同分時按路徑排序，讓同一份輸入
	// 永遠得到同一個輸出（可測）。
	sort.Slice(out, func(i, j int) bool {
		ai, aj := m.Entries[out[i]].CloudCheckedAt, m.Entries[out[j]].CloudCheckedAt
		if ai != aj {
			return ai < aj
		}
		return out[i] < out[j]
	})
	if len(out) > cloudAuditBatch {
		out = out[:cloudAuditBatch]
	}
	return out
}

// auditResult＝一輪對帳的結果，給呼叫端組人話與記帳用。
type auditResult struct {
	Checked int    // 這輪真的問了幾個檔
	Voided  int    // 其中幾個雲端查不到、章被拔掉（＝已排進重送佇列）
	Err     string // 對帳本身失敗的真因（原文，不改寫——leo 2026-08-06 原則）
}

// auditCloudLedger 對一個監看根跑一輪對帳。回 nil＝這輪不必對（節流中／沒有候選）。
//
// 🔴 它**只做一件事**：把「雲端已經沒有了」的章拔掉。
// 拔完之後，接下來的 Scan() 會因為 `orig[p].IngestedHash == ""` 自然補一發 added
// （scan.go 步驟 4「上輪偵測過但 ingest 未成功 → 重試」），
// 於是重送走的是**既有的**萃取路：既有的單輪上限、既有的失敗退避、既有的額度冷卻
// 全部照舊生效。⇒ 沒有第二條送件路，也沒有第二套節流要維護。
func auditCloudLedger(cfg *DirectConfig, absRoot string, m *Manifest, dryRun bool, now time.Time) *auditResult {
	if dryRun {
		return nil
	}
	nowUnix := now.Unix()
	if !cfg.ForceSync && m.CloudAuditAt > 0 &&
		nowUnix-m.CloudAuditAt < int64(cloudAuditFolderInterval.Seconds()) {
		return nil // 節流：同一個資料夾一分鐘內不重問
	}
	cands := auditCandidates(m, nowUnix, cfg.ForceSync)
	if len(cands) == 0 {
		// 沒有候選也要記時間，否則每輪都要重走一次上面那個迴圈。
		m.CloudAuditAt = nowUnix
		return nil
	}
	lib := cfg.libraryFor(absRoot)
	res := &auditResult{}
	for _, p := range cands {
		e := m.Entries[p]
		if e == nil {
			continue
		}
		present, ok, err := probeCloudCard(cfg, lib, p)
		if !ok {
			// 問不到就整批停手：連不上時繼續問剩下的 19 個只是重複同一個錯誤。
			// **絕不把「沒查成」當成「雲端沒有」**（那會讓一次網路抖動變成全量重送）。
			if err != nil {
				res.Err = err.Error()
			}
			break
		}
		res.Checked++
		e.CloudCheckedAt = nowUnix
		if present {
			continue
		}
		// 雲端真的沒有 ⇒ 這個章是假的，拔掉。**不動使用者的任何東西。**
		e.IngestedHash = ""
		e.CloudMissingAt = nowUnix
		// 失敗退避是「這個檔壞掉」的病歷，跟「雲端被清空」無關——留著會讓補送
		// 卡在上一次的退避階梯裡（實測那 8 個檔 fail_count 全是 0，但別的資料夾不一定）。
		e.FailCount, e.LastFailAt, e.NextRetry = 0, 0, 0
		res.Voided++
		pace2(cloudAuditProbePace)
	}
	m.CloudAuditAt = nowUnix
	if res.Checked == 0 && res.Err == "" {
		return nil
	}
	return res
}

// ResyncSummary 從 manifest 現況算出「補送」這件事現在講到哪裡」。
//
// 為什麼是**從 manifest 重算**而不是記一個計數器：計數器是「本輪做了幾件事」，
// 沒事做的那輪就會歸零——2026-08-05 leo 實撞的「明明做完了畫面卻永遠寫等待中」
// 就是那個形狀。這裡算的是**現況**（還有幾份沒補回來），補完自然歸零、不必有人去清。
func ResyncSummary(m *Manifest, now time.Time) (pending, repaired int) {
	nowUnix := now.Unix()
	fresh := int64(cloudAuditRepairGrace.Seconds())
	for _, e := range m.Entries {
		if e == nil || e.CloudMissingAt == 0 {
			continue
		}
		if strings.TrimSpace(e.IngestedHash) == "" {
			pending++ // 章拔掉了、還沒補送成功
		} else if e.IngestedAt >= e.CloudMissingAt && nowUnix-e.IngestedAt < fresh {
			repaired++ // 剛補送成功（只講最近一天的，不然這行會永遠掛在畫面上）
		}
	}
	return pending, repaired
}

// resyncNote 把上面兩個數字翻成使用者看得懂的一句話。
//
// leo 2026-08-06 的原則（「別人的錯誤一律要顯示給用戶看，不然就會變成我的錯誤」）
// 在這裡的形狀是：**不能靜悄悄地重送**。使用者只要看到「有 8 份在補送」，
// 就知道畫面上的數字為什麼會動、也知道不是自己弄壞的。
func resyncNote(pending, repaired int, lastErr string) string {
	switch {
	case pending > 0 && repaired > 0:
		return fmt.Sprintf("雲端上找不到先前送過的檔案（知識庫可能重裝過），正在自動補送：已補回 %d 份，還有 %d 份排隊中。", repaired, pending)
	case pending > 0:
		return fmt.Sprintf("雲端上找不到 %d 份先前送過的檔案（知識庫可能重裝過），已排進佇列自動補送，你不必做任何事。", pending)
	case repaired > 0:
		return fmt.Sprintf("已把雲端上遺失的 %d 份檔案補送回知識庫。", repaired)
	case lastErr != "":
		return "暫時無法跟雲端核對哪些檔案還在（不影響同步，稍後自動再試）。"
	}
	return ""
}

// pace2＝可指定長度的節流（directPaceInterval 那支是萃取路專用的固定 700ms）。
// 拉成獨立函式是為了讓測試能把它調成 0。
var pace2 = func(d time.Duration) {
	if d > 0 {
		time.Sleep(d)
	}
}
