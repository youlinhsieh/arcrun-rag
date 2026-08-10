package main

import (
	"encoding/json"
	"strings"
	"testing"

	"arcrun-rag/collector/supervisor"
)

// t26：暱稱 > email > 未設定（leo 07-24 拍板：CF 全程隱形，這條邏輯不該提到 cypher/CF）。
func TestConnectionStatusLabel(t *testing.T) {
	cases := []struct {
		name         string
		instanceName string
		email        string
		want         string
	}{
		{"暱稱優先於email", "我的書房", "leo21c@gmail.com", "連線中：我的書房"},
		{"無暱稱退回email", "", "leo21c@gmail.com", "連線中：leo21c@gmail.com"},
		{"兩者皆空顯示未設定", "", "", "連線中：未設定"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := connectionStatusLabel(c.instanceName, c.email)
			if got != c.want {
				t.Errorf("connectionStatusLabel(%q, %q) = %q, want %q", c.instanceName, c.email, got, c.want)
			}
		})
	}
}

func TestShortCypherHost(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"完整URL取host", "https://arcrun-cypher-executor.someacct.workers.dev/path", "arcrun-cypher-executor.someacct.workers.dev"},
		{"空字串回空字串", "", ""},
		{"無法解析出host則原樣回傳", "not-a-url", "not-a-url"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := shortCypherHost(c.in)
			if got != c.want {
				t.Errorf("shortCypherHost(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// config 序列化含新欄（email／instance_name）——t26 施工面一驗收項。
func TestDirectConfigJSONRoundTrip(t *testing.T) {
	c := &directConfig{
		CypherURL:    "https://example.workers.dev",
		Namespace:    "demo",
		Email:        "leo21c@gmail.com",
		InstanceName: "我的書房",
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal 失敗：%v", err)
	}
	s := string(data)
	if !strings.Contains(s, `"email":"leo21c@gmail.com"`) {
		t.Errorf("序列化結果缺 email 欄：%s", s)
	}
	if !strings.Contains(s, `"instance_name":"我的書房"`) {
		t.Errorf("序列化結果缺 instance_name 欄：%s", s)
	}

	var back directConfig
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal 失敗：%v", err)
	}
	if back.Email != c.Email || back.InstanceName != c.InstanceName {
		t.Errorf("round-trip 不一致：got email=%q instance_name=%q", back.Email, back.InstanceName)
	}
}

// 暱稱空時 config JSON 不應寫出 instance_name 欄（omitempty；對齊面二 installer 端「空就不寫欄位」的約定）。
func TestDirectConfigJSONOmitsEmptyInstanceName(t *testing.T) {
	c := &directConfig{
		CypherURL: "https://example.workers.dev",
		Namespace: "demo",
		Email:     "leo21c@gmail.com",
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal 失敗：%v", err)
	}
	if strings.Contains(string(data), "instance_name") {
		t.Errorf("暱稱空時不該序列化出 instance_name 欄：%s", data)
	}
}

// ── t86：instanceChanged ─────────────────────────────────────────────────────

func TestInstanceChanged(t *testing.T) {
	cases := []struct {
		name   string
		oldURL string
		newURL string
		want   bool
	}{
		{
			"同 host 同實例改密碼不觸發清空",
			"https://arcrun-cypher-executor.youlin.workers.dev",
			"https://arcrun-cypher-executor.youlin.workers.dev",
			false,
		},
		{
			"不同 host 換實例觸發清空",
			"https://arcrun-cypher-executor.youlin.workers.dev",
			"https://arcrun-cypher-executor.geek6688.workers.dev",
			true,
		},
		{
			"舊 URL 空（首次設定）不觸發清空",
			"",
			"https://arcrun-cypher-executor.geek6688.workers.dev",
			false,
		},
		{
			"新 URL 空（異常值）不觸發清空",
			"https://arcrun-cypher-executor.youlin.workers.dev",
			"",
			false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := instanceChanged(c.oldURL, c.newURL)
			if got != c.want {
				t.Errorf("instanceChanged(%q, %q) = %v, want %v", c.oldURL, c.newURL, got, c.want)
			}
		})
	}
}

// t86：換實例後 applyRemoteConfig 清空資料夾清單
func TestApplyRemoteConfigClearsFoldersOnInstanceSwitch(t *testing.T) {
	cfg := &directConfig{
		CypherURL:    "https://arcrun-cypher-executor.youlin.workers.dev",
		Namespace:    "youlin",
		WatchFolder:  "/Users/youlin/KnowledgeBase",
		WatchFolders: []string{"/Users/youlin/KnowledgeBase", "/Users/youlin/Finance"},
	}
	r := &daemonConfigResp{}
	r.Config.CypherURL = "https://arcrun-cypher-executor.geek6688.workers.dev"
	r.Config.Namespace = "geek6688"

	switched := applyRemoteConfig(cfg, r)

	if !switched {
		t.Error("換了不同 host 應回傳 switched=true")
	}
	if cfg.WatchFolder != "" {
		t.Errorf("換實例後 WatchFolder 應清空，got %q", cfg.WatchFolder)
	}
	if len(cfg.WatchFolders) != 0 {
		t.Errorf("換實例後 WatchFolders 應清空，got %v", cfg.WatchFolders)
	}
}

// t86：同實例改密碼不清空資料夾清單
func TestApplyRemoteConfigKeepsFoldersOnSameInstance(t *testing.T) {
	cfg := &directConfig{
		CypherURL:    "https://arcrun-cypher-executor.youlin.workers.dev",
		Namespace:    "youlin",
		WatchFolder:  "/Users/youlin/KnowledgeBase",
		WatchFolders: []string{"/Users/youlin/KnowledgeBase"},
	}
	r := &daemonConfigResp{}
	r.Config.CypherURL = "https://arcrun-cypher-executor.youlin.workers.dev"
	r.Config.Namespace = "youlin"

	switched := applyRemoteConfig(cfg, r)

	if switched {
		t.Error("同 host 不應回傳 switched=true")
	}
	if cfg.WatchFolder == "" || len(cfg.WatchFolders) == 0 {
		t.Error("同實例不應清空資料夾清單")
	}
}

// ── t91/t92：buildStatusLabel 與 syncStatusLabel 邏輯 ──────────────────────

// TestBuildStatusLabelNormal：看守中（無 extractor 設定）→ 正常「看守中」文案。
func TestBuildStatusLabelNormal(t *testing.T) {
	s := supervisor.Status{State: supervisor.StateWatching}
	got := buildStatusLabel(s, traySyncStatus{ExtractorOK: true}, "")
	if !strings.HasPrefix(got, "看守中") {
		t.Errorf("got=%q，應以「看守中」開頭", got)
	}
	if strings.Contains(got, "萃取") {
		t.Errorf("無 extractor 時不應有萃取字眼，got=%q", got)
	}
}

// TestBuildStatusLabelExtractorFail：extractor 預檢失敗 → 換成「⚠ 萃取引擎未就緒：」。
func TestBuildStatusLabelExtractorFail(t *testing.T) {
	s := supervisor.Status{State: supervisor.StateWatching}
	sync := traySyncStatus{ExtractorOK: false, ExtractorError: "找不到 Claude 指令"}
	got := buildStatusLabel(s, sync, "claude")
	if !strings.HasPrefix(got, "⚠ 萃取引擎未就緒：") {
		t.Errorf("extractor 失敗時應顯示警告，got=%q", got)
	}
	if !strings.Contains(got, "找不到 Claude 指令") {
		t.Errorf("應包含錯誤原因，got=%q", got)
	}
}

// TestBuildStatusLabelExtractorOKWithCount：extractor 就緒且有萃取成功數 → 追加「已萃 N 檔」。
func TestBuildStatusLabelExtractorOKWithCount(t *testing.T) {
	s := supervisor.Status{State: supervisor.StateWatching}
	sync := traySyncStatus{ExtractorOK: true, ExtractedOK: 5}
	got := buildStatusLabel(s, sync, "claude")
	if !strings.Contains(got, "已萃 5 檔") {
		t.Errorf("should show 已萃 5 檔，got=%q", got)
	}
}

// TestSyncNowSignalPath：syncNowSignalPath 回傳以 sync-now 結尾的路徑（t98）。
// tray 寫這個路徑，collector 從 manifest 同目錄讀——路徑語意必須一致。
func TestSyncNowSignalPath(t *testing.T) {
	p := syncNowSignalPath()
	if !strings.HasSuffix(p, "sync-now") {
		t.Errorf("syncNowSignalPath()=%q，應以 'sync-now' 結尾", p)
	}
	// 應該住在 appDir() 底下
	if !strings.HasPrefix(p, appDir()) {
		t.Errorf("syncNowSignalPath()=%q 應在 appDir()=%q 底下", p, appDir())
	}
}

// ── t101：removeWatchFolder 刪除邏輯 ─────────────────────────────────────────

// TestRemoveWatchFolder_removesEntry：移除後 WatchFolders 不含該路徑，WatchFolder 同步更新。
func TestRemoveWatchFolder_removesEntry(t *testing.T) {
	cfg := &directConfig{
		WatchFolder:  "/a",
		WatchFolders: []string{"/a", "/b", "/c"},
	}
	removeWatchFolder(cfg, "/b")
	for _, f := range cfg.WatchFolders {
		if f == "/b" {
			t.Errorf("移除後 WatchFolders 仍含 /b：%v", cfg.WatchFolders)
		}
	}
	if cfg.WatchFolder == "/b" {
		t.Errorf("移除後 WatchFolder 不應是 /b")
	}
	// 移除中間項不影響剩餘項
	if len(cfg.WatchFolders) != 2 {
		t.Errorf("移除一項後應剩 2 項，got %d：%v", len(cfg.WatchFolders), cfg.WatchFolders)
	}
}

// TestRemoveWatchFolder_idempotent：對不在清單中的路徑呼叫，清單保持不變（冪等）。
func TestRemoveWatchFolder_idempotent(t *testing.T) {
	cfg := &directConfig{
		WatchFolder:  "/a",
		WatchFolders: []string{"/a", "/b"},
	}
	removeWatchFolder(cfg, "/nonexistent")
	if len(cfg.WatchFolders) != 2 {
		t.Errorf("重複刪除不存在路徑後清單應不變，got %v", cfg.WatchFolders)
	}
	if cfg.WatchFolder != "/a" {
		t.Errorf("WatchFolder 不應改變，got %q", cfg.WatchFolder)
	}
}

// TestDirectConfigPreservesClaudeBin：config JSON round-trip 保留 claude_bin 欄位（t92 回寫驗收）。
func TestDirectConfigPreservesClaudeBin(t *testing.T) {
	c := &directConfig{
		CypherURL: "https://example.workers.dev",
		Namespace: "demo",
		ClaudeBin: "/opt/homebrew/bin/claude",
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal 失敗：%v", err)
	}
	if !strings.Contains(string(data), `"claude_bin":"/opt/homebrew/bin/claude"`) {
		t.Errorf("序列化結果缺 claude_bin 欄：%s", data)
	}
	var back directConfig
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal 失敗：%v", err)
	}
	if back.ClaudeBin != c.ClaudeBin {
		t.Errorf("round-trip 不一致：got %q, want %q", back.ClaudeBin, c.ClaudeBin)
	}
}

// ── t104：多帳號同時看守 ──────────────────────────────────────────────────────────

// TestAddOrUpdateAccount_NewAccount：空 accounts → 加入新帳號。
func TestAddOrUpdateAccount_NewAccount(t *testing.T) {
	cfg := &directConfig{}
	r := &daemonConfigResp{}
	r.Config.CypherURL = "https://instance1.workers.dev"
	r.Config.Namespace = "ns1"
	r.Config.Email = "user@a.com"
	r.Config.InstanceName = "Work"

	isNew := addOrUpdateAccount(cfg, r)
	if !isNew {
		t.Error("新帳號應回 true")
	}
	if len(cfg.Accounts) != 1 {
		t.Fatalf("應新增 1 個帳號，got %d", len(cfg.Accounts))
	}
	if cfg.Accounts[0].Email != "user@a.com" {
		t.Errorf("email 錯：%s", cfg.Accounts[0].Email)
	}
	if cfg.Accounts[0].InstanceName != "Work" {
		t.Errorf("instance_name 錯：%s", cfg.Accounts[0].InstanceName)
	}
}

// TestAddOrUpdateAccount_SameHostUpdates：同 host → 更新連線資訊，WatchFolders 不清空。
func TestAddOrUpdateAccount_SameHostUpdates(t *testing.T) {
	cfg := &directConfig{
		Accounts: []accountCfg{{
			CypherURL:    "https://instance1.workers.dev",
			Namespace:    "ns1",
			Email:        "old@a.com",
			WatchFolders: []string{"/path/to/folder"},
		}},
	}
	r := &daemonConfigResp{}
	r.Config.CypherURL = "https://instance1.workers.dev"
	r.Config.Namespace = "ns1"
	r.Config.Email = "new@a.com"

	isNew := addOrUpdateAccount(cfg, r)
	if isNew {
		t.Error("同 host 應回 false（更新，非新增）")
	}
	if len(cfg.Accounts) != 1 {
		t.Fatalf("不應新增帳號，got %d", len(cfg.Accounts))
	}
	if cfg.Accounts[0].Email != "new@a.com" {
		t.Errorf("email 未更新：%s", cfg.Accounts[0].Email)
	}
	if len(cfg.Accounts[0].WatchFolders) == 0 {
		t.Error("同 host 更新不應清空資料夾（t86 退役）")
	}
}

// TestAddOrUpdateAccount_DifferentHostAdds：不同 host → 兩個帳號並存。
func TestAddOrUpdateAccount_DifferentHostAdds(t *testing.T) {
	cfg := &directConfig{
		Accounts: []accountCfg{{
			CypherURL: "https://instance1.workers.dev",
			Namespace: "ns1",
		}},
	}
	r := &daemonConfigResp{}
	r.Config.CypherURL = "https://instance2.workers.dev"
	r.Config.Namespace = "ns2"

	isNew := addOrUpdateAccount(cfg, r)
	if !isNew {
		t.Error("不同 host 應回 true（新增）")
	}
	if len(cfg.Accounts) != 2 {
		t.Fatalf("應有 2 個帳號，got %d", len(cfg.Accounts))
	}
}

// TestRemoveAccountWatchFolder_CorrectAccount：刪帳號 A 的資料夾不影響帳號 B（t104+t101）。
func TestRemoveAccountWatchFolder_CorrectAccount(t *testing.T) {
	cfg := &directConfig{
		Accounts: []accountCfg{
			{CypherURL: "https://a.workers.dev", WatchFolders: []string{"/folder1", "/folder2"}},
			{CypherURL: "https://b.workers.dev", WatchFolders: []string{"/folder3"}},
		},
	}
	removeAccountWatchFolder(cfg, 0, "/folder1")
	if len(cfg.Accounts[0].WatchFolders) != 1 {
		t.Fatalf("account[0] 應剩 1 個資料夾，got %v", cfg.Accounts[0].WatchFolders)
	}
	if cfg.Accounts[0].WatchFolders[0] != "/folder2" {
		t.Errorf("account[0] 剩餘應是 /folder2，got %s", cfg.Accounts[0].WatchFolders[0])
	}
	if len(cfg.Accounts[1].WatchFolders) != 1 || cfg.Accounts[1].WatchFolders[0] != "/folder3" {
		t.Errorf("account[1] 資料夾不應改變，got %v", cfg.Accounts[1].WatchFolders)
	}
}

// TestAccountDisplayName：暱稱 > email > host（t26 延伸）。
func TestAccountDisplayName(t *testing.T) {
	cases := []struct {
		acc  accountCfg
		want string
	}{
		{accountCfg{InstanceName: "書房", Email: "a@b.com", CypherURL: "https://c.dev"}, "書房"},
		{accountCfg{Email: "a@b.com", CypherURL: "https://c.dev"}, "a@b.com"},
		{accountCfg{CypherURL: "https://arcrun-cypher-executor.acct.workers.dev"}, "arcrun-cypher-executor.acct.workers.dev"},
	}
	for _, c := range cases {
		got := accountDisplayName(c.acc)
		if got != c.want {
			t.Errorf("accountDisplayName(%+v) = %q, want %q", c.acc, got, c.want)
		}
	}
}

// TestDirectConfigFolders_MultiAccount：多帳號 Folders() 彙整所有帳號資料夾。
func TestDirectConfigFolders_MultiAccount(t *testing.T) {
	cfg := &directConfig{
		Accounts: []accountCfg{
			{WatchFolders: []string{"/a", "/b"}},
			{WatchFolders: []string{"/c"}},
		},
	}
	got := cfg.Folders()
	want := []string{"/a", "/b", "/c"}
	if len(got) != len(want) {
		t.Fatalf("Folders() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Folders()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// t108：directConfig JSON round-trip 必須保留 GeminiAPIKey/LLMModel/CardIngestWF——
// 這三欄是 t104 前缺失的；若托盤 loadConfig→saveConfig 吃掉它們，collector 讀到空值就走直送路。
func TestDirectConfigGeminiFieldsPreserved(t *testing.T) {
	original := &directConfig{
		Extractor:    "gemma",
		GeminiAPIKey: "AIzaSy-test-key",
		LLMModel:     "gemma-4-31b-it",
		CardIngestWF: "rag_ingest_card",
	}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal 失敗：%v", err)
	}
	var back directConfig
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal 失敗：%v", err)
	}
	if back.GeminiAPIKey != original.GeminiAPIKey {
		t.Errorf("GeminiAPIKey 消失：got %q", back.GeminiAPIKey)
	}
	if back.LLMModel != original.LLMModel {
		t.Errorf("LLMModel 消失：got %q", back.LLMModel)
	}
	if back.CardIngestWF != original.CardIngestWF {
		t.Errorf("CardIngestWF 消失：got %q", back.CardIngestWF)
	}
}

// t108：addOrUpdateAccount 後機器層 GeminiAPIKey 仍存在（遷移/新增帳號不吃掉機器層欄位）。
func TestAddOrUpdateAccountPreservesMachineLayer(t *testing.T) {
	cfg := &directConfig{
		Extractor:    "gemma",
		GeminiAPIKey: "AIzaSy-existing-key",
		LLMModel:     "gemma-4-31b-it",
		CardIngestWF: "rag_ingest_card",
	}
	resp := &daemonConfigResp{Success: true}
	resp.Config.CypherURL = "https://new.workers.dev"
	resp.Config.Namespace = "newns"

	addOrUpdateAccount(cfg, resp)
	if cfg.GeminiAPIKey != "AIzaSy-existing-key" {
		t.Errorf("GeminiAPIKey 被清空：got %q", cfg.GeminiAPIKey)
	}
	if cfg.LLMModel != "gemma-4-31b-it" {
		t.Errorf("LLMModel 被清空：got %q", cfg.LLMModel)
	}
	if cfg.CardIngestWF != "rag_ingest_card" {
		t.Errorf("CardIngestWF 被清空：got %q", cfg.CardIngestWF)
	}
}

// ── t126：每帳號獨立引擎設定 ──────────────────────────────────────────────────

// t126①→t182 改版：accountEngineLabel 的判準是 **explicit（使用者主動選過沒有）**，
// 不是 config 裡殘留什麼字串。
//
// 為什麼改（leo 08-04 實撞）：更新到 v0.15.5 後托盤**兩個帳號都還顯示 Gemini**，
// 因為他 config 的帳號層留著 extractor="gemma"、而 explicit 沒設。
// t178 只把 `claude` 這一個殘留值導向 Gemini，殘留 `gemma` 一樣脫鉤 ⇒ t182 改成通則：
// **沒主動選過就一律念「雲端 AI」（空字串），與 direct.go 的預設邏輯同一條判準。**
func TestAccountEngineLabel(t *testing.T) {
	cases := []struct {
		name      string
		acc       accountCfg
		defaultEx string
		explicit  bool
		want      string
	}{
		// ── 沒主動選過（explicit=false）：不管殘留什麼，一律不顯示（＝走 workers-ai）──
		// 這一組就是 leo 實撞的情境：config 殘留 gemma/claude，但他從沒去「AI 設定…」選過。
		{"殘留gemma但沒選過→不顯示", accountCfg{Extractor: "gemma"}, "", false, ""},
		{"殘留claude但沒選過→不顯示", accountCfg{Extractor: "claude"}, "", false, ""},
		{"default殘留gemma但沒選過→不顯示", accountCfg{}, "gemma", false, ""},
		{"兩者皆空＝新用戶→不顯示", accountCfg{}, "", false, ""},

		// ── 主動選過（explicit=true）：照實顯示 ──
		// Gemini 是選配（leo：「客戶說他要用 Gemini，但現在變成選配」）⇒ 選了就要標出來。
		{"主動選gemma→顯示 Gemini", accountCfg{Extractor: "gemma"}, "", true, " · Gemini"},
		// t178 保留：claude 也念 Gemini——direct.go 早把 claude 正規化成 gemma（t176）。
		// 若這則變回「· Claude」，代表標籤又和萃取實際走的路脫鉤了。
		{"主動選過但殘留claude→仍顯示 Gemini", accountCfg{Extractor: "claude"}, "", true, " · Gemini"},
		{"帳號空退回default-gemma", accountCfg{}, "gemma", true, " · Gemini"},
		{"帳號層優先於default", accountCfg{Extractor: "gemma"}, "claude", true, " · Gemini"},
		// t181：明確選 workers-ai 也不顯示（leo：「用 workers AI 就不顯示」）
		{"主動選 workers-ai→不顯示", accountCfg{Extractor: "workers-ai"}, "", true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := accountEngineLabel(c.acc, c.defaultEx, c.explicit)
			if got != c.want {
				t.Errorf("accountEngineLabel(%+v, %q, explicit=%v) = %q, want %q",
					c.acc, c.defaultEx, c.explicit, got, c.want)
			}
		})
	}
}

// t176（翻轉自 t126②）：新帳號也一樣——只收連線欄位，雲端下發的 LLM 設定一律不落地。
// 帳號層留白時，讀取端會繼承機器層（＝使用者在「AI 設定…」填的那把）。
func TestAddOrUpdateAccount_NewAccountIgnoresRemoteLLMSettings(t *testing.T) {
	cfg := &directConfig{
		Extractor:    "gemma",      // 機器層＝使用者自己填的
		GeminiAPIKey: "machine-key",
	}
	resp := &daemonConfigResp{Success: true}
	resp.Config.CypherURL = "https://new.workers.dev"
	resp.Config.Namespace = "ns1"
	resp.Config.Extractor = "claude"           // 雲端想下發 claude
	resp.Config.GeminiAPIKey = "cloud-key"     // 以及別把金鑰
	resp.Config.LLMModel = "some-cloud-model"  //

	if isNew := addOrUpdateAccount(cfg, resp); !isNew {
		t.Error("應為新帳號")
	}
	if len(cfg.Accounts) == 0 {
		t.Fatal("應新增帳號")
	}
	// 連線欄位要寫進去（這條路徑本來的職責）
	if cfg.Accounts[0].Namespace != "ns1" || cfg.Accounts[0].CypherURL != "https://new.workers.dev" {
		t.Errorf("連線欄位應寫入，got ns=%q url=%q", cfg.Accounts[0].Namespace, cfg.Accounts[0].CypherURL)
	}
	// LLM 欄位一律留白＝不吃雲端的
	if cfg.Accounts[0].Extractor != "" {
		t.Errorf("不該吃雲端下發的 extractor，got %q", cfg.Accounts[0].Extractor)
	}
	if cfg.Accounts[0].GeminiAPIKey != "" {
		t.Errorf("不該吃雲端下發的金鑰，got %q", cfg.Accounts[0].GeminiAPIKey)
	}
	if cfg.Accounts[0].LLMModel != "" {
		t.Errorf("不該吃雲端下發的模型，got %q", cfg.Accounts[0].LLMModel)
	}
	// 機器層（使用者自己填的）不受影響
	if cfg.Extractor != "gemma" || cfg.GeminiAPIKey != "machine-key" {
		t.Errorf("機器層不該被雲端動到，got extractor=%q key=%q", cfg.Extractor, cfg.GeminiAPIKey)
	}
}

// t176（翻轉自 t126③）：**雲端下發的 LLM 設定一律被忽略**。
// leo 08-03：「地端要用什麼模型就在 daemon 上輸入 API Key 設置，而不是雲端設置後控制地端」。
// 這條是回歸守衛——雲端 extractor_config 是全租戶共用一把 KV，任一處設了 claude
// 會讓所有沒裝 Claude Code 的機器萃取全滅（awindhon 08-03 實證：零張卡）。
func TestAddOrUpdateAccount_IgnoresRemoteLLMSettings(t *testing.T) {
	cfg := &directConfig{
		Extractor:    "gemma",       // 機器層＝使用者自己在「AI 設定…」填的
		GeminiAPIKey: "my-own-key",  //
		Accounts: []accountCfg{{
			CypherURL:    "https://inst.workers.dev",
			Namespace:    "ns1",
			Extractor:    "gemma",
			GeminiAPIKey: "my-own-key",
		}},
	}
	// 雲端試圖下發 claude ＋ 別把金鑰——全部都不該生效
	resp := &daemonConfigResp{Success: true}
	resp.Config.CypherURL = "https://inst.workers.dev"
	resp.Config.Namespace = "ns1"
	resp.Config.Extractor = "claude"
	resp.Config.GeminiAPIKey = "cloud-pushed-key"

	if isNew := addOrUpdateAccount(cfg, resp); isNew {
		t.Error("同 host 應為更新（回 false）")
	}
	if cfg.Accounts[0].Extractor != "gemma" {
		t.Errorf("雲端下發的 extractor 不該覆蓋本地設定，got %q", cfg.Accounts[0].Extractor)
	}
	if cfg.Accounts[0].GeminiAPIKey != "my-own-key" {
		t.Errorf("雲端下發的金鑰不該覆蓋本地金鑰，got %q", cfg.Accounts[0].GeminiAPIKey)
	}
	if cfg.Extractor != "gemma" || cfg.GeminiAPIKey != "my-own-key" {
		t.Errorf("機器層不該被雲端動到，got extractor=%q key=%q", cfg.Extractor, cfg.GeminiAPIKey)
	}
	// 連線欄位仍要更新（這條路徑本來的職責）
	if cfg.Accounts[0].Namespace != "ns1" {
		t.Errorf("連線欄位仍應更新，got namespace=%q", cfg.Accounts[0].Namespace)
	}
}

// 🔴 t177／08-02 迴歸守衛：版本比較不可退回字串比較（wiki 事故 D）。
// 這個 bug 有**兩份**（本函式＋collector/cloud_version.go）——
//    改動版本號格式時，**兩份測試都要綠**。
func TestTrayCloudVersionStale(t *testing.T) {
	cases := []struct {
		name      string
		version   string
		checkOK   bool
		wantStale bool
	}{
		{"semver 最新版不該被判過舊", "1.4.1", true, false},
		{"semver 剛好達標", "1.4.0", true, false},
		{"semver 過舊要提示", "1.3.9", true, true},
		{"semver 1.10.0 比 1.9.0 新（防字串比較）", "1.10.0", true, false},
		{"舊格式過舊仍要判過舊（相容）", "2026-07-01+deadbee", true, true},
		{"舊格式達標", "2026-07-28+abc1234", true, false},
		{"空版本（老實例）", "", true, true},
		{"health 不可達→不判定（呼叫端另顯示查不到）", "", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := trayCloudVersionStale(tc.version, tc.checkOK); got != tc.wantStale {
				t.Errorf("trayCloudVersionStale(%q, %v) = %v，want %v", tc.version, tc.checkOK, got, tc.wantStale)
			}
		})
	}
}
