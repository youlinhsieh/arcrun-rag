package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"arcrun-rag/collector"
)

// 手動工具（不跑在一般 go test）：用「真的 GetState」把 leo 現況（geek6688 出錯＋剩 18%、
// youlin 63%、leo21c 付費）的資料夾與 status.json 長相做成前端看得到的 JSON，
// 供 Claude Design 稿對照截圖（inkstone/arcrun-rag#240 c18254）。
//
//	ARCRUN_DUMP_STATE=/path/state.json go test -run TestDumpStateManual .
//
// 誠實邊界：引擎活著與否由 supervisor 決定，這裡沒有 supervisor，所以
// 「正在同步誰」改用同一支 accountStatus() 以 engineSyncing=true 重算；停工卡片的
// 來源是 manifest 逐份分類（stalls.go 另有測試），這裡直接放一筆形狀相同的資料。
func TestDumpStateManual(t *testing.T) {
	out := os.Getenv("ARCRUN_DUMP_STATE")
	if out == "" {
		t.Skip("手動工具：設 ARCRUN_DUMP_STATE=輸出路徑 才會跑")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	geek := "https://arcrun-cypher-executor.geek6688.workers.dev"
	you := "https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev"
	leo := "https://arcrun-cypher-executor.leo21c.workers.dev"
	geekF := []string{"/Users/demo/ken_cnc/error_codes", "/Users/demo/ken_cnc/pricing-course", "/Users/demo/ken_cnc/manuals", "/Users/demo/ken_cnc/todo", "/Users/demo/ken_cnc/notes"}
	cfg := map[string]any{
		"manifest": filepath.Join(home, ".arcrun-rag", "manifest.json"),
		"accounts": []accountCfg{
			{InstanceName: "geek6688", Email: "ken@geek.example", CypherURL: geek, Namespace: "ckxt8yr9", WatchFolders: geekF},
			{InstanceName: "youlin.hsieh.dev", Email: "youlin@example.com", CypherURL: you, Namespace: "yuga3bse", WatchFolders: []string{"/Users/demo/youlin/docs"}},
			{InstanceName: "leo21c", Email: "leo@example.com", CypherURL: leo, Namespace: "leo21c", WatchFolders: []string{"/Users/demo/leo/notes", "/Users/demo/leo/wiki"}},
		},
	}
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(cfg)
	if err := os.WriteFile(configPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	gh, yh, lh := shortHost(geek), shortHost(you), shortHost(leo)
	fp := func(total, done, pending, stuck int) collector.SyncProgress {
		return collector.SyncProgress{Total: total, Done: done, Pending: pending, Stuck: stuck}
	}
	pf := func(f float64) *float64 { return &f }
	st := syncStatus{
		LastActivityOK: 15, LastActivityAt: time.Now().Format(time.RFC3339),
		Progress: collector.SyncProgress{Total: 10342, Done: 1383, Pending: 8800, Stuck: 159},
		FolderProgress: map[string]collector.SyncProgress{
			geekF[0]: fp(8200, 300, 7741, 159), geekF[1]: fp(600, 100, 500, 0), geekF[2]: fp(300, 40, 260, 0),
			geekF[3]: fp(200, 20, 180, 0), geekF[4]: fp(131, 12, 119, 0),
			"/Users/demo/youlin/docs": fp(500, 500, 0, 0),
			"/Users/demo/leo/notes":   fp(300, 300, 0, 0), "/Users/demo/leo/wiki": fp(111, 111, 0, 0),
		},
		InRound: &collector.RoundProgress{Account: gh, Folder: geekF[0], Step: "請雲端讀一份文件", Ingested: 15},
		AccountDetails: map[string]collector.AccountSyncStatus{
			gh: {CloudVersion: "1.4.87", CloudCheckOK: true, CloudUpdateKnown: true, CloudLatest: "1.4.87",
				Battery: &collector.Battery{State: collector.BatteryWarn20, RemainingPercent: pf(18), Warn: true}},
			yh: {CloudVersion: "1.4.87", CloudCheckOK: true, CloudUpdateKnown: true, CloudLatest: "1.4.87",
				Battery: &collector.Battery{State: collector.BatteryNormal, RemainingPercent: pf(63)}},
			lh: {CloudVersion: "1.4.87", CloudCheckOK: true, CloudUpdateKnown: true, CloudLatest: "1.4.87",
				Battery: &collector.Battery{State: collector.BatteryNuclear}},
		},
	}
	// 長句版的真實通知：額度用完、送不上去、讀不了的檔（compactUI 要把它們收進字數預算）
	g := st.AccountDetails[gh]
	g.QuotaMessage = &collector.QuotaNotice{
		Kind: "d1_write", Headline: "你的雲端知識庫今天的免費寫入額度用完了",
		Usage:       "Cloudflare 免費方案的資料庫寫入上限是每天 10 萬列，今天已經用到上限（這不是小幫手或你的檔案壞掉）",
		Guarantee:   "台北時間明天早上 8:00 恢復，恢復後小幫手會自動接著傳，你不用做任何事",
		ExitOptions: "升級 Cloudflare Workers 付費方案（每月 5 美元起）就沒有每日上限",
		ResumeAt:    time.Now().Add(6 * time.Hour).UTC().Format(time.RFC3339), Account: gh,
	}
	st.AccountDetails[gh] = g
	st.Failures = []collector.ExtractFail{{Path: geekF[0] + "/a.md", Account: gh, Error: "雲端回了 HTTP 500：database is locked，請稍後再試，這是一段很長的原始錯誤訊息用來測字數預算"}}
	st.SkippedDocCount = 3
	st.SkippedDocs = []skippedDoc{{Path: "/Users/demo/舊版報告.doc", Ext: ".doc"}}
	sb, _ := json.Marshal(st)
	if err := os.WriteFile(statusPath(), sb, 0o644); err != nil {
		t.Fatal(err)
	}
	s := (&App{}).GetState()
	s.EngineTrouble = false
	s.StatusBig = "同步中…"
	for i := range s.Accounts {
		s.Accounts[i].Status = accountStatus(st, s.Accounts[i].Host, true, time.Now())
	}
	s.Stalls = []UIStall{
		{Fingerprint: "fp-geek-write", Account: "geek6688", Count: 32, Label: "雲端沒有把檔案寫進知識庫", Samples: []string{"230-023A_001.md", "280-0432_001.md"}},
		{Fingerprint: "fp-geek-read", Account: "geek6688", Count: 3, Label: "雲端讀不了這份文件", Samples: []string{"a.pdf"}},
		{Fingerprint: "fp-geek-big", Account: "geek6688", Count: 3, Label: "檔案太大", Samples: []string{"b.pdf"}},
	}
	applyDismissals(&s)
	compactUI(&s)
	js, _ := json.MarshalIndent(s, "", " ")
	if err := os.WriteFile(out, js, 0o644); err != nil {
		t.Fatal(err)
	}
}
