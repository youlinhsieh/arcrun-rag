package collector

// 萃取路替身（inkstone/arcrun-rag#58）。
//
// 直呼 Gemini 的路已拔除；daemon 唯一的萃取路是打自己雲端實例的
// /portal/daemon/extract（workersAIHTTP）。端到端測試（RunDirectOnce）的 cypher 替身伺服器
// 通常與萃取共用同一個 URL，所以這裡不另起伺服器，而是把 workersAIHTTP 的 Transport
// 換成替身——只有萃取請求會走到它（收卡／探測走別的 client，照常打 cypher 替身）。
//
// 為了不重寫既有十幾支測試的 fixture，替身 handler 可以沿用「模型回覆長在
// candidates[].content.parts[].text」這個**容器形狀**（只是裝模型文字的盒子，與供應商無關）；
// 本替身把它拆開、包成雲端真正的回應信封 {"success":true,"output":<模型原文>}。
// handler 直接回 {"success":..,"output":..} 信封也行，原樣放行。

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

type extractStubTransport struct{ h http.HandlerFunc }

func (s extractStubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	s.h(rec, req)
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		body = wrapModelReply(body)
	}
	res.Body = io.NopCloser(bytes.NewReader(body))
	res.ContentLength = int64(len(body))
	res.Request = req
	return res, nil
}

// wrapModelReply：把「模型回覆容器」包成雲端信封；已是信封或別種形狀就原樣回。
func wrapModelReply(body []byte) []byte {
	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Thought bool   `json:"thought"`
					Text    string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if json.Unmarshal(body, &parsed) != nil || len(parsed.Candidates) == 0 {
		return body
	}
	parts := parsed.Candidates[0].Content.Parts
	for i := len(parts) - 1; i >= 0; i-- {
		if !parts[i].Thought && parts[i].Text != "" {
			out, _ := json.Marshal(map[string]any{"success": true, "output": parts[i].Text})
			return out
		}
	}
	out, _ := json.Marshal(map[string]any{"success": false, "error": "模型沒有回傳可用文字"})
	return out
}

// probeReadyStub：把每輪開頭的「雲端 AI 通了嗎」探測（probeWorkersAI）換成回 200，
// 回傳還原函式。探測與萃取打同一條 route；端到端測試不想讓探測真的打到 cypher 替身
// （會多算一次請求、或打到不存在的主機而記進路由退避）。
// 專測探測本身的測試（cloudcheck_test.go）不要用它。
func probeReadyStub(t *testing.T) func() {
	t.Helper()
	old := probeHTTP
	probeHTTP = &http.Client{
		Transport: extractStubTransport{func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"success":false}`))
		}},
		Timeout: old.Timeout,
	}
	return func() { probeHTTP = old }
}

// extractStub 安裝替身（萃取＋探測），回傳還原函式（用法：`defer extractStub(t, h)()`）。
func extractStub(t *testing.T, handler http.HandlerFunc) func() {
	t.Helper()
	old := workersAIHTTP
	workersAIHTTP = &http.Client{Transport: extractStubTransport{handler}, Timeout: old.Timeout}
	undoProbe := probeReadyStub(t)
	return func() { workersAIHTTP = old; undoProbe() }
}

// extractCardStub：萃取替身固定回一份模型 JSON。
func extractCardStub(t *testing.T, modelOutput string) func() {
	t.Helper()
	return extractStub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": modelOutput})
	})
}
