package main

// diagnostics_export_test.go — t213 phase 2：mergeDiagnostics 純函式測試（無網路／無磁碟），
// 涵蓋 leo 08-08 三條規則：①同首頁數字 ②分類名稱只認 ClassifyFailure（本檔不自己判斷）
// ③失敗檔名 basename-only。
import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	collector "arcrun-rag/collector"
)

func TestMergeDiagnostics_SameNumbersAsHomeScreen(t *testing.T) {
	// leo 規則①：Progress／FailureBreakdown 必須原樣接住 status.json 裡 t210 已算好的值，
	// 不是本檔重新掃 manifest 算出來的——這裡直接餵一組跟首頁會看到的一模一樣的 syncStatus，
	// 斷言輸出的 local.progress／local.failure_breakdown 逐欄位相等。
	sync := syncStatus{
		Progress: collector.SyncProgress{Total: 9000, Done: 8879, Pending: 101, Stuck: 15, Unreadable: 5},
		FailureBreakdown: collector.FailureBreakdown{
			Total: 20,
			Groups: []collector.FailureGroup{
				{Category: collector.FailQuotaExhausted, Count: 12},
				{Category: collector.FailNoTextInFile, Count: 5},
				{Category: collector.FailOther, Count: 3},
			},
		},
	}
	out := mergeDiagnostics(sync, nil, "0.18.23", UpdateInfo{Current: "0.18.23"}, engineDiagnostics{}, nil)

	if out.Local.Progress != sync.Progress {
		t.Fatalf("progress 沒有原樣接住：got %+v want %+v", out.Local.Progress, sync.Progress)
	}
	if out.Local.FailureBreakdown.Total != 20 {
		t.Fatalf("failure_breakdown.total = %d, want 20", out.Local.FailureBreakdown.Total)
	}
	if len(out.Local.FailureBreakdown.Groups) != 3 {
		t.Fatalf("failure_breakdown.groups 數量跑掉：got %d want 3", len(out.Local.FailureBreakdown.Groups))
	}
	// 分母（Q2：9000 檔 vs 雲端 101 張卡）就是 Progress.Total，必須是真的總量，不是本輪計數。
	if out.Local.Progress.Total != 9000 {
		t.Fatalf("Q2 的分母跑掉：Total = %d, want 9000", out.Local.Progress.Total)
	}
}

func TestMergeDiagnostics_CategoryNamesPassThroughVerbatim(t *testing.T) {
	// leo 規則②：分類名稱字串只准住在 collector/progress.go 的 ClassifyFailure。
	// 這裡故意餵一個「本檔完全沒見過」的假分類名，驗證 mergeDiagnostics 原樣照抄、
	// 不會因為認不得而過濾掉或改寫——它不准對分類名稱做任何判斷。
	sync := syncStatus{
		FailureBreakdown: collector.FailureBreakdown{
			Total:  1,
			Groups: []collector.FailureGroup{{Category: "未來才會新增的假分類", Count: 1}},
		},
	}
	out := mergeDiagnostics(sync, nil, "dev", UpdateInfo{}, engineDiagnostics{}, nil)
	if len(out.Local.FailureBreakdown.Groups) != 1 || out.Local.FailureBreakdown.Groups[0].Category != "未來才會新增的假分類" {
		t.Fatalf("分類名稱沒有原樣照抄：%+v", out.Local.FailureBreakdown.Groups)
	}
}

func TestMergeDiagnostics_SkippedNamesAreBasenameOnly(t *testing.T) {
	// leo 08-08 補的紅線：失敗檔名只出 basename，不出完整路徑。
	// buildSkipped() 本來就只輸出 filepath.Base()+白話標籤（見 app.go），這裡驗證
	// mergeDiagnostics 原樣帶出這個既有保證、且序列化後的 JSON 真的看不到路徑分隔符/使用者名稱。
	skipped := &UISkipped{
		Files: []string{"教材授權書-Leov2.pages（Pages）", "舊版報告.doc（舊版 Word）"},
		More:  2,
	}
	out := mergeDiagnostics(syncStatus{}, skipped, "dev", UpdateInfo{}, engineDiagnostics{}, nil)

	if len(out.Local.SkippedSample) != 2 {
		t.Fatalf("skipped_sample 數量跑掉：%v", out.Local.SkippedSample)
	}
	for _, name := range out.Local.SkippedSample {
		if strings.ContainsAny(name, "/\\") {
			t.Fatalf("skipped_sample 洩漏了路徑分隔符（疑似夾帶完整路徑）：%q", name)
		}
	}
	if out.Local.SkippedMore != 2 {
		t.Fatalf("skipped_more = %d, want 2", out.Local.SkippedMore)
	}

	// 序列化後再檢查一次（防禦：就算欄位邏輯對，JSON tag 打錯字也可能悄悄漏東西進去）。
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "/Users/") || strings.Contains(string(raw), `C:\`) {
		t.Fatalf("整份 JSON 不該出現絕對路徑：%s", raw)
	}
}

func TestMergeDiagnostics_NoSkipped_OmitsSampleFields(t *testing.T) {
	// 沒有任何檔案被略過（skipped == nil，同 buildSkipped() 的既有語意）→ 不該生出空陣列佔畫面。
	out := mergeDiagnostics(syncStatus{}, nil, "dev", UpdateInfo{}, engineDiagnostics{}, nil)
	if out.Local.SkippedSample != nil {
		t.Fatalf("沒有略過任何檔案時 SkippedSample 應為 nil，得到 %v", out.Local.SkippedSample)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "skipped_sample") {
		t.Fatalf("omitempty 沒生效，空狀態不該出現 skipped_sample 欄位：%s", raw)
	}
}

func TestMergeDiagnostics_AccountsCarryCloudOrError(t *testing.T) {
	// 帳號層：雲端查得到 → cloud 有值；查不到（如目前線上 404，見 t213 部署備註）→ cloud_error
	// 誠實帶出原因，兩者互斥，且都要附上是哪個帳號/實例（不然多帳號時分不出是誰的狀態）。
	accounts := []accountDiagnostics{
		{InstanceName: "youlin.hsieh.dev", Host: "arcrun-cypher-executor.youlin-hsieh-dev.workers.dev",
			Cloud: map[string]any{"library_count": float64(3), "triplet_count": float64(191)}},
		{InstanceName: "geek6688", Host: "arcrun-cypher-executor.arcrun-fc9490d5.workers.dev",
			CloudError: "你的知識庫還是舊版（沒有雲端診斷功能）⇒ 請到 portal 按「立即更新」重裝一次"},
	}
	out := mergeDiagnostics(syncStatus{}, nil, "dev", UpdateInfo{}, engineDiagnostics{}, accounts)
	if len(out.Accounts) != 2 {
		t.Fatalf("accounts 數量跑掉：%d", len(out.Accounts))
	}
	if out.Accounts[0].Cloud == nil || out.Accounts[0].CloudError != "" {
		t.Fatalf("第一個帳號應該只有 cloud、沒有 cloud_error：%+v", out.Accounts[0])
	}
	if out.Accounts[1].Cloud != nil || out.Accounts[1].CloudError == "" {
		t.Fatalf("第二個帳號應該只有 cloud_error、沒有 cloud：%+v", out.Accounts[1])
	}
}

// ── t213 phase 3：engine（Q2 缺口——「還在不在跑」）─────────────────────────

func TestMergeDiagnostics_EngineCarriesLiveStateVerbatim(t *testing.T) {
	// engine 的 Alive/Syncing/CrashLooping/Restarts/LastError/Headline/Detail 是呼叫端
	// 現查現答傳進來的（見 buildDiagnosticsPayload），mergeDiagnostics 不准對它們做任何
	// 判斷或改寫——同 leo 規則②「本函式不認得任何一個分類字串」的精神，換到 engine 身上。
	engine := engineDiagnostics{
		Alive: false, Syncing: false, CrashLooping: true, Restarts: 5,
		LastError: "exit status 1", Headline: "同步引擎一直啟動失敗", Detail: "已自動重試 5 次都失敗",
	}
	out := mergeDiagnostics(syncStatus{}, nil, "dev", UpdateInfo{}, engine, nil)
	got := out.Local.Engine
	if got.Alive != false || got.CrashLooping != true || got.Restarts != 5 ||
		got.LastError != "exit status 1" || got.Headline != "同步引擎一直啟動失敗" || got.Detail != "已自動重試 5 次都失敗" {
		t.Fatalf("engine 現查現答欄位沒有原樣接住：%+v", got)
	}
}

func TestEngineLastErrorFor_OnlyShownWhenItMeansSomething(t *testing.T) {
	// supervisor 的 LastError 是「最近一行 stderr」，健康行程的開機橫幅也會被記進去
	// （見 diagnostics_engine_e2e_test.go 情境一實測：alive=true 卻帶著一句啟動訊息）。
	// 這支測試釘住閘門本身：alive 且沒有一直失敗 ⇒ 就算 lastErr 非空也要被吞掉，
	// 不然診斷檔會讓人誤以為健康的引擎在報錯。
	cases := []struct {
		name             string
		alive, looping   bool
		lastErr, wantOut string
	}{
		{"健康行程的雜訊 stderr 被吞掉", true, false, "collector direct daemon 啟動：…", ""},
		{"沒有在跑時原樣帶出死因", false, false, "exit status 2", "exit status 2"},
		{"一直啟動失敗時原樣帶出死因", true /* 短暫 Starting 也算 alive */, true, "config JSON 解析失敗", "config JSON 解析失敗"},
		{"健康且沒有任何 stderr", true, false, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := engineLastErrorFor(c.alive, c.looping, c.lastErr)
			if got != c.wantOut {
				t.Fatalf("engineLastErrorFor(%v,%v,%q) = %q，want %q", c.alive, c.looping, c.lastErr, got, c.wantOut)
			}
		})
	}
}

func TestMergeDiagnostics_EngineTimestampsFromSyncStatus(t *testing.T) {
	// LastSync／LastActivityAt 要原樣接住 status.json 裡的值（同 Progress 的規矩），
	// 不是本函式另外現查——這兩個欄位是 t91/t205 既有機制，不重新發明。
	sync := syncStatus{LastSync: "2026-08-08T05:00:00Z", LastActivityAt: "2026-08-08T04:30:00Z"}
	out := mergeDiagnostics(sync, nil, "dev", UpdateInfo{}, engineDiagnostics{}, nil)
	if out.Local.Engine.LastSync != sync.LastSync {
		t.Fatalf("last_sync 沒有原樣接住：got %q want %q", out.Local.Engine.LastSync, sync.LastSync)
	}
	if out.Local.Engine.LastActivityAt != sync.LastActivityAt {
		t.Fatalf("last_activity_at 沒有原樣接住：got %q want %q", out.Local.Engine.LastActivityAt, sync.LastActivityAt)
	}
}

func TestMergeDiagnostics_SecondsSinceLastSync_StaleHeartbeatIsVisible(t *testing.T) {
	// 核心情境（考卷 Q2）：pending=0，但 last_sync 停在很久以前——這份 JSON 必須讓人
	// 看得出來「不是做完了，是心跳停了」，不必額外問任何人。
	stale := time.Now().UTC().Add(-45 * time.Minute).Format(time.RFC3339)
	sync := syncStatus{
		LastSync: stale,
		Progress: collector.SyncProgress{Total: 9000, Done: 8980, Pending: 0, Stuck: 0, Unreadable: 20},
	}
	out := mergeDiagnostics(sync, nil, "dev", UpdateInfo{}, engineDiagnostics{Alive: false, Headline: "同步引擎沒有在跑"}, nil)

	if out.Local.Progress.Pending != 0 {
		t.Fatalf("測試前提跑掉：pending 應為 0，得到 %d", out.Local.Progress.Pending)
	}
	if out.Local.Engine.SecondsSinceLastSync == nil {
		t.Fatal("seconds_since_last_sync 不該是空的——有 last_sync 就該算得出落後秒數")
	}
	got := *out.Local.Engine.SecondsSinceLastSync
	if got < 44*60 || got > 46*60 {
		t.Fatalf("seconds_since_last_sync 算錯：got %ds，應接近 2700s（45 分鐘）", got)
	}
	if out.Local.Engine.Alive {
		t.Fatal("測試前提跑掉：這個情境應該是 alive=false（同步引擎沒有在跑）")
	}
}

func TestMergeDiagnostics_NoLastSync_OmitsSecondsSinceLastSync(t *testing.T) {
	// 從沒同步過（全新安裝、還沒連知識庫）：last_sync 是空字串，不該假裝算得出落後秒數。
	out := mergeDiagnostics(syncStatus{}, nil, "dev", UpdateInfo{}, engineDiagnostics{}, nil)
	if out.Local.Engine.SecondsSinceLastSync != nil {
		t.Fatalf("沒有 last_sync 時 seconds_since_last_sync 應為 nil，得到 %v", *out.Local.Engine.SecondsSinceLastSync)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "seconds_since_last_sync") {
		t.Fatalf("omitempty 沒生效：%s", raw)
	}
}

// ── t213 phase 4（leo 08-08 追加規則④）：engine.detail／engine.last_error 不准帶絕對路徑 ──

// containsAbsPath 是這批測試共用的「還有沒有絕對路徑」判準：不是只查 `/Users/`
// （那只是巧合常見的 macOS 家目錄），是查任何看起來像「本機路徑起手式」的樣子——
// Unix 開頭的 `/`（前面是邊界字元或字串開頭）、Windows 磁碟代號 `X:\`；
// 跟 redactLocalPaths 一樣先放行 http(s) URL（`https://host/path` 的 `/` 不算本機路徑），
// 用同一組邊界原語（urlSpanAt／absPathPrefixLen）掃，不是重寫第二套判準。
func containsAbsPath(s string) bool {
	r := []rune(s)
	for i := 0; i < len(r); {
		if j, ok := urlSpanAt(r, i); ok {
			i = j // 整段 URL 跳過，不是只跳一個字元——URL 內部的 `/` 不算路徑起點
			continue
		}
		if absPathPrefixLen(r, i) > 0 {
			return true
		}
		i++
	}
	return false
}

func TestRedactLocalPaths_StartupBannerHidesWatchedFolder(t *testing.T) {
	// 這是真實會撞到的那句話（direct.go RunDirect 的開機橫幅），也是這輪要修的洞。
	in := `collector direct daemon 啟動：監看 /Users/leo/Desktop/知識庫 → https://arcrun-cypher-executor.youlin-hsieh-dev.workers.dev/webhooks/named/ns/rag_ingest/trigger（每 5s 掃一輪）`
	got := redactLocalPaths(in)

	if containsAbsPath(got) {
		t.Fatalf("redactLocalPaths 沒有把絕對路徑遮掉：%q", got)
	}
	// 遮蔽不能把資訊遮成啞巴——資料夾最後一截、目的地 URL、輪詢間隔都還要讀得出來。
	for _, want := range []string{"知識庫", "webhooks/named/ns/rag_ingest/trigger", "每 5s 掃一輪", "監看"} {
		if !strings.Contains(got, want) {
			t.Fatalf("redactLocalPaths 把資訊遮成啞巴了，找不到 %q：%q", want, got)
		}
	}
}

func TestRedactLocalPaths_MultipleFoldersAllHidden(t *testing.T) {
	in := `監看 /Users/leo/kb1、/Users/leo/kb2 → https://x.dev/a、https://x.dev/b（每 5s 掃一輪）`
	got := redactLocalPaths(in)
	if containsAbsPath(got) {
		t.Fatalf("多資料夾時仍有絕對路徑殘留：%q", got)
	}
	if !strings.Contains(got, "…/kb1") || !strings.Contains(got, "…/kb2") {
		t.Fatalf("每個資料夾的最後一截應保留（只是加上佔位前綴）：%q", got)
	}
}

func TestRedactLocalPaths_WindowsDrivePath(t *testing.T) {
	in := `collector direct: config JSON 解析失敗：C:\Users\Leo\AppData\Roaming\arcrun-rag\config.json: unexpected end of JSON input`
	got := redactLocalPaths(in)
	if containsAbsPath(got) {
		t.Fatalf("Windows 路徑沒有被遮掉：%q", got)
	}
	if !strings.Contains(got, "config.json") {
		t.Fatalf("檔名本身應保留：%q", got)
	}
	if !strings.Contains(got, "unexpected end of JSON input") {
		t.Fatalf("錯誤原因不該被路徑遮蔽波及：%q", got)
	}
}

func TestRedactLocalPaths_OSPathError(t *testing.T) {
	// os.PathError 的標準形狀：「<動作> <路徑>: <原因>」。
	in := `status 寫入失敗（不擋看守）：open /Users/leo/.arcrun-rag/status.json: permission denied`
	got := redactLocalPaths(in)
	if containsAbsPath(got) {
		t.Fatalf("os.PathError 形狀的訊息沒有被遮掉：%q", got)
	}
	if !strings.Contains(got, "status.json") || !strings.Contains(got, "permission denied") {
		t.Fatalf("檔名與原因應保留：%q", got)
	}
}

func TestRedactLocalPaths_NoPathPassthroughUnchanged(t *testing.T) {
	for _, in := range []string{"", "exit status 1", "config JSON 解析失敗", "已自動重試 3 次都失敗，所以重新開啟也沒有用。"} {
		if got := redactLocalPaths(in); got != in {
			t.Fatalf("沒有路徑的字串不該被改動：in=%q got=%q", in, got)
		}
	}
}

func TestRedactLocalPaths_URLNotMistakenForLocalPath(t *testing.T) {
	in := `連不上你的知識庫：Get "https://arcrun-cypher-executor.example.workers.dev/webhooks/named/ns/trigger": dial tcp: no such host`
	got := redactLocalPaths(in)
	if got != in {
		t.Fatalf("純 URL（無本機路徑）不該被改動：got %q want %q", got, in)
	}
}

func TestMergeDiagnostics_EngineDoesNotRedact(t *testing.T) {
	// 對照組：redactLocalPaths 是 buildDiagnosticsPayload 的事，mergeDiagnostics 本身
	// 仍要「原樣接住」呼叫端已經處理好的字串（同 TestMergeDiagnostics_EngineCarriesLiveStateVerbatim
	// 的精神）——已經遮過的字串進來，出去也要一字不改。
	engine := engineDiagnostics{Alive: false, LastError: "…/kb（已遮蔽）", Detail: "原因：…/kb（已遮蔽）"}
	out := mergeDiagnostics(syncStatus{}, nil, "dev", UpdateInfo{}, engine, nil)
	if out.Local.Engine.LastError != engine.LastError || out.Local.Engine.Detail != engine.Detail {
		t.Fatalf("mergeDiagnostics 不該再動已經處理好的 engine 字串：%+v", out.Local.Engine)
	}
}
