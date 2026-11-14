package main

import (
	"os"
	"testing"
)

// 手動實測（inkstone/arcrun-rag#335）：對一台真的企業私有雲配對。
//
//	ARCRUN_PRIVATE_CLOUD_URL=http://127.0.0.1:8080 ARCRUN_PRIVATE_CLOUD_EMAIL=… ARCRUN_PRIVATE_CLOUD_PASSWORD=… \
//	  go test -run PrivateCloudLive -v ./cmd/arcrun-app
//
// 用暫存家目錄，配對完把設定檔路徑印出來，給後面 `collector direct --config` 接著用。
func TestPrivateCloudLivePair(t *testing.T) {
	url := os.Getenv("ARCRUN_PRIVATE_CLOUD_URL")
	if url == "" {
		t.Skip("未設 ARCRUN_PRIVATE_CLOUD_URL，略過（手動實測）")
	}
	home := os.Getenv("ARCRUN_LIVE_HOME")
	if home == "" {
		home = t.TempDir()
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	app := &App{}
	if err := app.Connect(url, os.Getenv("ARCRUN_PRIVATE_CLOUD_EMAIL"), os.Getenv("ARCRUN_PRIVATE_CLOUD_PASSWORD")); err != nil {
		t.Fatalf("配對失敗：%v", err)
	}
	cfg, err := loadCfg()
	if err != nil || len(cfg.Accounts) == 0 {
		t.Fatalf("配對後設定檔沒有帳號：%v", err)
	}
	a := cfg.Accounts[len(cfg.Accounts)-1]
	t.Logf("配對成功：cypher_url=%s namespace=%s instance=%q kbdb_key有=%v 家目錄=%s", a.CypherURL, a.Namespace, a.InstanceName, a.KbdbKey != "", home)
}
