// trigger.go — 把一輪掃描的 collector-trigger.v1 payload POST 到 arcrun named-webhook
// （SDD ingest-hash-trigger task 4：觸發鏈從 Gitea push webhook 改為 collector 直打）。
//
// 目標端點＝arcrun 原生 named-webhook 觸發機制（design 鐵律段明言保留）：
//
//	POST {cypher}/webhooks/named/{ns}/rag_ingest/trigger
//
// 完整 URL 走環境變數 ARCRUN_TRIGGER_URL（絕不落 repo）。語意：
//   - HTTP 2xx ＝本輪觸發成功 → 對「實際送出」的 added/modified/renamed 事件回寫
//     Manifest.MarkIngested（design §2 的回寫鉤子，至此才第一次被呼叫）。
//   - 非 2xx／網路錯 ＝不回寫（ingested_hash 不動）→ 下輪掃描自然重發＝重試，
//     R2 端靠存在檢查 no-op、ingest 端靠 source_hash 冪等（design §5），無腦重試安全。
//   - 上傳失敗的 added/modified 事件「不」隨 payload 送出（schema 約定 r2_key＝原稿已在
//     R2；沒上去就送＝消費端 fetch 必 404）——下輪重試補送。renamed/removed 不依賴 R2，照送。
//   - 防呆警告輪（mass_delete_guard）：removed 事件已被 collector 壓下，但 payload 連同
//     warnings 照送（消費端／執行紀錄看得到警告，不執行下架）。
package collector

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// LoadTriggerURLFromEnv 讀 ARCRUN_TRIGGER_URL（sync 模式必填）。
func LoadTriggerURLFromEnv() (string, error) {
	u := os.Getenv("ARCRUN_TRIGGER_URL")
	if u == "" {
		return "", fmt.Errorf("sync 缺環境變數：ARCRUN_TRIGGER_URL（named-webhook 觸發完整 URL，設定只走環境變數，絕不寫進 repo/code）")
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return "", fmt.Errorf("ARCRUN_TRIGGER_URL 必須是完整 URL（http/https），得到：%s", u)
	}
	return u, nil
}

// TriggerResult 是本輪觸發的結果，隨 sync 輸出 stdout。
type TriggerResult struct {
	Status       string   `json:"status"` // sent | skipped_no_changes | failed | planned（--dry-run）
	HTTPStatus   int      `json:"http_status,omitempty"`
	Error        string   `json:"error,omitempty"`
	MarkedCount  int      `json:"marked_count"`            // 本輪成功回寫 ingested_hash 的檔數
	DroppedPaths []string `json:"dropped_paths,omitempty"` // 因上傳失敗被擋下、未隨 payload 送出的事件路徑
}

// BuildSendablePayload 依上傳結果過濾掃描 payload：
// added/modified 只有上傳成功（uploaded/skipped_exists）才隨 payload 送出——
// schema 的 r2_key 語意＝「原稿已在 R2」，上傳失敗還送＝叫消費端去 404。
// renamed/removed 不依賴 R2 物件，一律保留；warnings 原樣保留（防呆輪照送）。
// 回傳（可送出的 payload 副本, 被擋下的路徑清單）。
func BuildSendablePayload(p *TriggerPayload, uploads []UploadResult) (*TriggerPayload, []string) {
	okPaths := map[string]bool{}
	for _, u := range uploads {
		if u.Status == "uploaded" || u.Status == "skipped_exists" {
			okPaths[u.Path] = true
		}
	}
	sendable := *p
	sendable.Events = []Event{}
	var dropped []string
	for _, ev := range p.Events {
		if ev.Type == "added" || ev.Type == "modified" {
			if !okPaths[ev.Path] {
				dropped = append(dropped, ev.Path)
				continue
			}
		}
		sendable.Events = append(sendable.Events, ev)
	}
	return &sendable, dropped
}

// SendTrigger 把 payload POST 到 named-webhook。回傳 HTTP 狀態碼；非 2xx 視為錯誤。
// timeout 放寬到 300s：named-webhook 觸發的 ingest workflow 可能同步跑（demo 實測 20-30s+）。
func SendTrigger(url string, p *TriggerPayload, hc *http.Client) (int, error) {
	if hc == nil {
		hc = &http.Client{Timeout: 300 * time.Second}
	}
	body, err := json.Marshal(p)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return 0, fmt.Errorf("觸發 POST 失敗（不回寫 manifest，下輪自然重試）：%w", err)
	}
	defer resp.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("觸發回 HTTP %d（不回寫 manifest，下輪自然重試）：%s",
			resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return resp.StatusCode, nil
}

// MarkIngestedEvents 在觸發成功（2xx）後，對「實際送出」的 added/modified/renamed 事件
// 回寫 ingested_hash。droppedPaths＝本輪因上傳失敗被擋下的路徑——同路徑若另有 renamed
// 事件（改名＋內容從未成功 ingest 的檔會同輪補發 added），該 renamed 也不得回寫，
// 否則原稿永遠上不了 R2 卻被標成已 ingest。回傳成功回寫的檔數。
func MarkIngestedEvents(m *Manifest, sentEvents []Event, droppedPaths []string, at int64) int {
	droppedSet := map[string]bool{}
	for _, p := range droppedPaths {
		droppedSet[p] = true
	}
	n := 0
	for _, ev := range sentEvents {
		switch ev.Type {
		case "added", "modified", "renamed":
			if droppedSet[ev.Path] {
				continue
			}
			if m.MarkIngested(ev.Path, ev.SourceHash, at) {
				n++
			}
		}
	}
	return n
}
