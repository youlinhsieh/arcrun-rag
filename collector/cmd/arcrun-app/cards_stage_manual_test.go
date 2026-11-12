package main

// cards_stage_manual_test.go — 對 youlin stage 真實後端走一遍：庫 → 目錄 → 整張卡 → 代查（inkstone/arcrun-rag#333）。
// 只在設了 ARCRUN_CHAT_STAGE_URL 時跑；帳密來自環境變數，不落檔、不印。
// ARCRUN_CARDS_DUMP=<路徑> 會把三步的回傳 JSON 寫到該檔（給畫面驗收當真資料）。
import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestCardsStageManual(t *testing.T) {
	base := os.Getenv("ARCRUN_CHAT_STAGE_URL")
	if base == "" {
		t.Skip("未設 ARCRUN_CHAT_STAGE_URL")
	}
	tempHome(t)
	tok, exp, err := portalLogin(base, os.Getenv("ARCRUN_CHAT_EMAIL"), os.Getenv("ARCRUN_CHAT_PW"))
	if err != nil {
		t.Fatalf("登入: %v", err)
	}
	if err := saveCfg(&directConfig{Accounts: []accountCfg{{InstanceName: "youlin stage", CypherURL: base,
		PortalSession: tok, PortalSessionExp: time.Now().Unix() + exp}}}); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	libs := app.ListCardLibraries(0)
	b, _ := json.MarshalIndent(libs, "", " ")
	t.Logf("庫清單:\n%s", b)
	if libs.Error != "" || len(libs.Libraries) == 0 {
		t.Fatalf("要有庫: %+v", libs)
	}
	cat := app.ListLibraryCards(0, libs.Libraries[0].Name)
	b, _ = json.MarshalIndent(cat, "", " ")
	t.Logf("目錄（前 3 張）:\n%.1500s", b)
	if cat.Error != "" || len(cat.Cards) == 0 {
		t.Fatalf("要有卡: %+v", cat)
	}
	card := app.GetLibraryCard(0, cat.Library, cat.Cards[0].PageName)
	b, _ = json.MarshalIndent(card, "", " ")
	t.Logf("整張卡:\n%.1500s", b)
	if card.Error != "" || len(card.Blocks) == 0 {
		t.Fatalf("要有內容: %+v", card)
	}
	if p := os.Getenv("ARCRUN_CARDS_DUMP"); p != "" {
		all, _ := json.Marshal(map[string]any{"libs": libs, "cat": cat, "card": card})
		_ = os.WriteFile(p, all, 0o600)
	}
}
