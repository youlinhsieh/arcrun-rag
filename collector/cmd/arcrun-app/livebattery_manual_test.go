package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

// 手動工具：用這台機器真的 config（只讀）逐帳號問雲端 /portal/daemon/battery，
// 印出雲端原文，以及小幫手 RefreshUsage 之後 GetState 畫給側欄的結果，供逐一對照。
//
//	ARCRUN_LIVE_BATTERY=1 go test -run TestLiveBatteryManual -v .
func TestLiveBatteryManual(t *testing.T) {
	if os.Getenv("ARCRUN_LIVE_BATTERY") == "" {
		t.Skip("手動工具")
	}
	cfg, _ := loadCfg()
	for _, acc := range cfg.Accounts {
		req, _ := http.NewRequest("GET", apiBaseOf(acc)+"/portal/daemon/battery", nil)
		req.Header.Set("X-Arcrun-API-Key", acc.APIKey)
		res, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
		raw := ""
		if err != nil {
			raw = err.Error()
		} else {
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			raw = string(b)
		}
		fmt.Printf("【%s】雲端原文：%s\n", accountName(acc), raw)
	}
	(&App{}).RefreshUsage(-1)
	s := (&App{}).GetState()
	for _, a := range s.Accounts {
		b, _ := json.Marshal(a.Battery)
		fmt.Printf("【%s】小幫手側欄：%s\n", a.Name, b)
	}
}
