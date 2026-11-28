package main

// chat_stage_manual_test.go — 對 youlin stage 的真實後端實問一題（inkstone/arcrun-rag#297）。
// 只在設了 ARCRUN_CHAT_STAGE_URL 時跑（預設不跑，不打網路）。帳密來自環境變數，不落檔、不印。
import (
	"encoding/json"
	"os"
	"testing"
)

func TestAskStageManual(t *testing.T) {
	base := os.Getenv("ARCRUN_CHAT_STAGE_URL")
	if base == "" {
		t.Skip("未設 ARCRUN_CHAT_STAGE_URL")
	}
	dc, err := fetchConfigByLogin(base, os.Getenv("ARCRUN_CHAT_EMAIL"), os.Getenv("ARCRUN_CHAT_PW"))
	if err != nil {
		t.Fatalf("連線（領同步憑證）: %v", err)
	}
	cfg := &directConfig{Accounts: []accountCfg{{InstanceName: "youlin stage", CypherURL: base,
		KbdbKey: dc.Config.KbdbKey}}}
	q := os.Getenv("ARCRUN_CHAT_Q")
	if q == "" {
		q = "這個知識庫裡有哪些內容？"
	}
	r := askCore(cfg, q, nil)
	b, _ := json.MarshalIndent(r, "", " ")
	t.Logf("\n%s", b)
	if r.Error != "" {
		t.Fatalf("後端回錯: %s", r.Error)
	}
}
