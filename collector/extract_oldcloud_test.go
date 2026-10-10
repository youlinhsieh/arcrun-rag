package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 舊雲端（#299 之前的 1.4.95）：忽略 prompt_table；沒有 prompt 就回 legacy card，有 prompt 才回 output。
func TestCallWorkersAIExtract_舊雲端改送prompt且記住(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		bodies = append(bodies, m)
		if p, _ := m["prompt"].(string); p != "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("文件", "概念")})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "card": "# 舊格式卡"})
	}))
	defer srv.Close()
	url := srv.URL + "/portal/daemon/extract"
	oldCloudURLs.Delete(url)

	out, card, err := callWorkersAIExtract(srv.Client(), url, "k", "p", "內容", extractRequestFor("內容"), false)
	if err != nil || out == "" || card != "" {
		t.Fatalf("應拿到新格式 output：out=%q card=%q err=%v", out, card, err)
	}
	if len(bodies) != 2 || bodies[0]["prompt_table"] == nil || bodies[0]["prompt"] != nil || !strings.Contains(bodies[1]["prompt"].(string), "知識整理員") {
		t.Fatalf("第一發送表、第二發改送 prompt：%v", bodies)
	}
	// 記住了：下一次直接送 prompt，一發
	bodies = nil
	if out, _, err := callWorkersAIExtract(srv.Client(), url, "k", "p", "內容", extractRequestFor("內容"), false); err != nil || out == "" || len(bodies) != 1 || bodies[0]["prompt"] == nil {
		t.Fatalf("第二次應一發直送 prompt：%d %v", len(bodies), err)
	}
}

func TestCallWorkersAIExtract_新雲端一發就好(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("文件", "概念")})
	}))
	defer srv.Close()
	url := srv.URL + "/portal/daemon/extract"
	oldCloudURLs.Delete(url)
	if out, _, err := callWorkersAIExtract(srv.Client(), url, "k", "p", "內容", extractRequestFor("內容"), false); err != nil || out == "" || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if _, old := oldCloudURLs.Load(url); old {
		t.Error("新雲端不該被記成舊的")
	}
}
