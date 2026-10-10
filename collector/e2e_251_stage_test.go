package collector

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 端到端（真雲端）：只在設了 ARCRUN_E2E_URL／ARCRUN_E2E_KEY／ARCRUN_E2E_PDF 時跑，平常 skip。
// inkstone/arcrun-rag#251 c18845：用真 stage 入口實跑，量 neurons、記請求形狀。
type recTransport struct {
	mu   sync.Mutex
	base http.RoundTripper
	log  []string
	neur float64
	n    map[string]int
}

func (r *recTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var keys []string
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		req.Body = io.NopCloser(bytes.NewReader(b))
		var m map[string]any
		if json.Unmarshal(b, &m) == nil {
			for k := range m {
				keys = append(keys, k)
			}
		}
	}
	resp, err := r.base.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body = io.NopCloser(bytes.NewReader(b))
	var m struct {
		Usage map[string]any `json:"usage"`
		Model string         `json:"model"`
	}
	_ = json.Unmarshal(b, &m)
	nv := 0.0
	if m.Usage != nil {
		if v, ok := m.Usage["neurons"].(float64); ok {
			nv = v
		}
	}
	r.mu.Lock()
	r.neur += nv
	if r.n == nil {
		r.n = map[string]int{}
	}
	r.n[req.URL.Path]++
	r.log = append(r.log, fmt.Sprintf("%s status=%d reqkeys=%v model=%s neurons=%.1f usage=%v", req.URL.Path, resp.StatusCode, keys, m.Model, nv, m.Usage))
	r.mu.Unlock()
	return resp, nil
}

func TestE2E_251_真Stage(t *testing.T) {
	url, key, pdf := os.Getenv("ARCRUN_E2E_URL"), os.Getenv("ARCRUN_E2E_KEY"), os.Getenv("ARCRUN_E2E_PDF")
	if url == "" || key == "" || pdf == "" {
		t.Skip("未設 ARCRUN_E2E_*")
	}
	data, err := os.ReadFile(pdf)
	if err != nil {
		t.Fatal(err)
	}
	root := os.Getenv("ARCRUN_E2E_ROOT")
	if root == "" {
		root = t.TempDir()
	}
	name := filepath.Base(pdf)
	_ = os.MkdirAll(root, 0o755)
	if err := os.WriteFile(filepath.Join(root, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
	rec := &recTransport{base: http.DefaultTransport}
	oa, oi := workersAIHTTP, imageReadHTTP
	workersAIHTTP = &http.Client{Transport: rec, Timeout: oa.Timeout}
	imageReadHTTP = &http.Client{Transport: rec, Timeout: 180 * time.Second}
	defer func() { workersAIHTTP, imageReadHTTP = oa, oi }()
	var all []string
	for i := 0; i < 12; i++ {
		cards, err := ExtractWithWorkersAI(url, key, root, name, testOrigin())
		t.Logf("invocation %d: cards=%d err=%v", i, len(cards), err)
		all = append(all, cards...)
		if err == nil && len(cards) > 0 {
			break
		}
		if err != nil && !strings.Contains(err.Error(), "接著讀") {
			break
		}
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	t.Logf("calls=%v total_neurons=%.1f", rec.n, rec.neur)
	for _, l := range rec.log {
		t.Log(l)
	}
	t.Logf("cards=%v", all)
}

// 傾印每頁讀到什麼（診斷用）。
func TestE2E_251_傾印讀圖(t *testing.T) {
	url, key, pdf := os.Getenv("ARCRUN_E2E_URL"), os.Getenv("ARCRUN_E2E_KEY"), os.Getenv("ARCRUN_E2E_PDF")
	if url == "" || key == "" || pdf == "" || os.Getenv("ARCRUN_E2E_DUMP") == "" {
		t.Skip("未設 ARCRUN_E2E_DUMP")
	}
	data, _ := os.ReadFile(pdf)
	_, rep, _ := ConvertToTextReport(filepath.Base(pdf), data)
	if ps := os.Getenv("ARCRUN_E2E_PAGES"); ps != "" {
		rep.ImagePageNums = nil
		for _, f := range strings.Split(ps, ",") {
			var n int
			fmt.Sscan(f, &n)
			rep.ImagePageNums = append(rep.ImagePageNums, n)
		}
	}
	rd := cloudImageReader(&http.Client{Timeout: 180 * time.Second}, workersAIReadImageURL(url), key)
	res, err := readPDFImages(data, rep, "dump", rd)
	if err != nil {
		t.Fatal(err)
	}
	for p, e := range res.Failed {
		t.Logf("FAILED p%d: %v", p, e)
	}
	for _, r := range res.Reads {
		t.Logf("--- p%d flagged=%v diff=%v len=%d\n%.600s", r.Page, r.Flagged, r.Diff, len(r.Text), r.Text)
	}
}
