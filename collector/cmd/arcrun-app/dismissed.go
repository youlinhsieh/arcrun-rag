package main

// dismissed.go — 警示的「關閉」要記住，重開 App 仍不亮（inkstone/arcrun-rag#240 c18340／c18341）
//
// 產品原則（wiki 說明文字代表設計不良 同卡）：每個亮起來的警示都附一個用戶做得到的動作——
// 處理／回報／關閉，至少一個；用戶做不了任何事的狀況不亮紅點。
// 關閉或回報之後，同一原因不再亮，直到出現新的狀況（份數變多不算新狀況）。
//
// 做法：每則警示有一把穩定的鍵（原因，不含份數）。關閉＝把鍵記進 dismissed.json；
// GetState 在整形前把已關閉的警示拿掉。額度用完的鍵含恢復日期（隔天再爆＝新狀況）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

func dismissedPath() string { return filepath.Join(appDir(), "dismissed.json") }

var dismissMu sync.Mutex

func loadDismissed() map[string]string {
	out := map[string]string{}
	if b, err := os.ReadFile(dismissedPath()); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func isDismissed(key string) bool {
	if key == "" {
		return false
	}
	dismissMu.Lock()
	defer dismissMu.Unlock()
	_, ok := loadDismissed()[key]
	return ok
}

// Dismiss 是前端「×」的唯一入口：記下這把鍵。
func (a *App) Dismiss(key string) error {
	if key == "" {
		return nil
	}
	dismissMu.Lock()
	defer dismissMu.Unlock()
	m := loadDismissed()
	m[key] = time.Now().Format(time.RFC3339)
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := os.MkdirAll(appDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dismissedPath(), b, 0o600)
}

// applyDismissals 把已關閉（或已回報）的警示從要送給前端的狀態裡拿掉。
// 每則留下來的警示都帶 DismissKey，前端的「×」就拿它呼叫 Dismiss。
func applyDismissals(st *UIState) {
	// 停工：已回報＝已處理（不再亮）；已關閉同理
	var stalls []UIStall
	for _, s := range st.Stalls {
		s.DismissKey = "stall:" + s.Fingerprint
		if s.Reported || isDismissed(s.DismissKey) {
			continue
		}
		stalls = append(stalls, s)
	}
	st.Stalls = stalls
	if q := st.Quota; q != nil {
		c := *q
		day := ""
		if len(c.ResumeAt) >= 10 {
			day = c.ResumeAt[:10]
		}
		c.DismissKey = "quota:" + c.Kind + ":" + c.Account + ":" + day
		if isDismissed(c.DismissKey) {
			st.Quota = nil
		} else {
			st.Quota = &c
		}
	}
	for i := range st.Accounts {
		a := &st.Accounts[i]
		if b := a.Battery; b != nil && b.Warning != "" {
			lv := b.Level
			if b.Percent <= 0 {
				lv = "empty"
			}
			b.DismissKey = "battery:" + a.Host + ":" + lv
			if isDismissed(b.DismissKey) {
				b.Warning = ""
			}
		}
	}
	if k := st.Skipped; k != nil {
		k.DismissKey = "skipped"
		if isDismissed(k.DismissKey) {
			st.Skipped = nil
		}
	}
}
