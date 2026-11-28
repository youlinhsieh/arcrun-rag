// remove_account_401_test.go — inkstone/arcrun-rag#401：能在小幫手裡移除一個知識庫帳號。
package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// 寫一份「有三個帳號、每個帳號都帶 struct 沒宣告的欄位（libraries）、頂層帶未宣告欄位」的 config。
func writeThreeAccountCfg(t *testing.T, retiringOnMiddle bool) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	mid := map[string]any{
		"cypher_url": "https://b.example.workers.dev", "namespace": "nsb", "api_key": "kb",
		"kbdb_key": "KBDB-B", "portal_session": "PS-B", "portal_session_exp": 123,
		"watch_folders": []string{"/kb/b"}, "libraries": map[string]string{"/kb/b": "libb"},
	}
	if retiringOnMiddle {
		mid["retiring_folders"] = []string{"/kb/old"}
	}
	raw := map[string]any{
		"manifest": "/tmp/m.json", "poll_interval_sec": 77, "extractor": "workers-ai",
		"accounts": []any{
			map[string]any{"cypher_url": "https://a.example.workers.dev", "namespace": "nsa", "email": "a@x",
				"watch_folders": []string{"/kb/a"}, "libraries": map[string]string{"/kb/a": "liba"}},
			mid,
			map[string]any{"cypher_url": "https://c.example.workers.dev", "namespace": "nsc", "kbdb_key": "KBDB-C",
				"libraries": map[string]string{"x": "y"}},
		},
	}
	b, _ := json.MarshalIndent(raw, "", "  ")
	_ = os.MkdirAll(appDir(), 0o755)
	if err := os.WriteFile(configPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readRawCfg(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile(configPath())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// 驗收 2：config 少那一筆，其餘帳號與頂層欄位一個不少（含 struct 沒宣告的 libraries）。
func TestRemoveAccountDropsOnlyThatOneAndKeepsEveryOtherField(t *testing.T) {
	writeThreeAccountCfg(t, false)
	if err := (&App{}).RemoveAccount(1); err != nil {
		t.Fatalf("移除失敗：%v", err)
	}
	m := readRawCfg(t)
	accs := m["accounts"].([]any)
	if len(accs) != 2 {
		t.Fatalf("該剩 2 個帳號，實際 %d", len(accs))
	}
	a0, a1 := accs[0].(map[string]any), accs[1].(map[string]any)
	if a0["namespace"] != "nsa" || a1["namespace"] != "nsc" {
		t.Fatalf("刪錯了：%v / %v", a0["namespace"], a1["namespace"])
	}
	if a0["libraries"] == nil || a1["libraries"] == nil || a1["kbdb_key"] != "KBDB-C" || a0["email"] != "a@x" {
		t.Fatalf("🔴 t108 同款：其他帳號的欄位被重新序列化弄丟了：%v %v", a0, a1)
	}
	if m["poll_interval_sec"] != float64(77) || m["manifest"] != "/tmp/m.json" {
		t.Fatalf("頂層欄位被動到：%v", m)
	}
	if strings.Contains(string(mustRead(t)), "nsb") || strings.Contains(string(mustRead(t)), "KBDB-B") {
		t.Fatal("被移除的帳號（含它的憑證）不該留在檔案裡")
	}
}

func mustRead(t *testing.T) []byte {
	b, _ := os.ReadFile(configPath())
	return b
}

// 驗收 3：收回中的資料夾不准默默丟掉。
func TestRemoveAccountRefusesWhileRetiring(t *testing.T) {
	writeThreeAccountCfg(t, true)
	before := mustRead(t)
	err := (&App{}).RemoveAccount(1)
	if err == nil || !strings.Contains(err.Error(), "收回") {
		t.Fatalf("該拒絕並講收回中，實際 err=%v", err)
	}
	if string(before) != string(mustRead(t)) {
		t.Fatal("拒絕時 config 不可被改動")
	}
	p, _ := (&App{}).PlanAccountRemoval(1)
	if p.Retiring != 1 {
		t.Fatalf("plan 要回報收回中 1 個：%+v", p)
	}
}

// 驗收 4：移除第一個後，原第二個成為第一個（問答取 Accounts[0]）。
func TestRemovePrimaryPromotesNext(t *testing.T) {
	writeThreeAccountCfg(t, false)
	p, _ := (&App{}).PlanAccountRemoval(0)
	if !p.Primary || p.Next == "" {
		t.Fatalf("plan 應說明主帳號與接手者：%+v", p)
	}
	if err := (&App{}).RemoveAccount(0); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadCfg()
	if err != nil || len(cfg.Accounts) != 2 || cfg.Accounts[0].Namespace != "nsb" {
		t.Fatalf("新的第一個該是原第二個：%v %+v", err, cfg.Accounts)
	}
}

func TestRemoveAccountBadIndexAndLastAccount(t *testing.T) {
	writeThreeAccountCfg(t, false)
	if err := (&App{}).RemoveAccount(9); err == nil {
		t.Fatal("越界要報錯")
	}
	for i := 0; i < 3; i++ {
		if err := (&App{}).RemoveAccount(0); err != nil {
			t.Fatal(err)
		}
	}
	cfg, _ := loadCfg()
	if len(cfg.Accounts) != 0 || !cfg.noAccounts() {
		t.Fatalf("三個都移除後應為零帳號：%+v", cfg.Accounts)
	}
	if readRawCfg(t)["manifest"] == nil {
		t.Fatal("manifest 等必填欄位不可消失")
	}
}

// 舊制單帳號 config（頂層 cypher_url、沒有 accounts）不能被誤判成「沒帳號」而停掉引擎。
func TestNoAccountsIgnoresLegacyTopLevelConfig(t *testing.T) {
	c := &directConfig{raw: map[string]any{"cypher_url": "https://old.example"}}
	if c.noAccounts() {
		t.Fatal("舊制單帳號不是沒帳號")
	}
}
