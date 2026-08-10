// upload.go — R2 content-addressed 原稿上傳（SDD ingest-hash-trigger design §4，task 3）。
//
// 走 Cloudflare REST API（非 S3 sigv4——token 模型跟產品其他部分一致，客戶本來就有 CF API token）：
//
//	GET/PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/buckets/{bucket}/objects/{key}
//	Authorization: Bearer <CF_API_TOKEN>
//
// key＝`raw/<sha256hex>`（不含 `sha256:` 前綴，對齊 schemas/collector-trigger.v1.schema.json 的 r2_key）。
// 冪等：先做存在檢查（GET＋Range 1 byte；端點不支援 HEAD，見 Exists 註解），
// 已存在＝no-op 跳過 PUT（content-addressed 天然去重，design §4）。
// 設定走環境變數 CF_ACCOUNT_ID / CF_API_TOKEN / R2_BUCKET，絕不落 repo。
package collector

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DefaultCFAPIBase 是 Cloudflare REST API 基底；測試用 CF_API_BASE 指到 httptest server。
const DefaultCFAPIBase = "https://api.cloudflare.com/client/v4"

type R2Config struct {
	AccountID string
	APIToken  string
	Bucket    string
	BaseURL   string // 空＝DefaultCFAPIBase
}

// LoadR2ConfigFromEnv 讀 CF_ACCOUNT_ID / CF_API_TOKEN / R2_BUCKET（必填）與 CF_API_BASE（選填，測試用）。
func LoadR2ConfigFromEnv() (R2Config, error) {
	cfg := R2Config{
		AccountID: os.Getenv("CF_ACCOUNT_ID"),
		APIToken:  os.Getenv("CF_API_TOKEN"),
		Bucket:    os.Getenv("R2_BUCKET"),
		BaseURL:   os.Getenv("CF_API_BASE"),
	}
	var missing []string
	if cfg.AccountID == "" {
		missing = append(missing, "CF_ACCOUNT_ID")
	}
	if cfg.APIToken == "" {
		missing = append(missing, "CF_API_TOKEN")
	}
	if cfg.Bucket == "" {
		missing = append(missing, "R2_BUCKET")
	}
	if len(missing) > 0 {
		return cfg, fmt.Errorf("R2 上傳缺環境變數：%s（設定只走環境變數，絕不寫進 repo/code）", strings.Join(missing, ", "))
	}
	return cfg, nil
}

type R2Client struct {
	cfg R2Config
	hc  *http.Client
}

func NewR2Client(cfg R2Config) *R2Client {
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultCFAPIBase
	}
	return &R2Client{cfg: cfg, hc: &http.Client{Timeout: 120 * time.Second}}
}

func (c *R2Client) objectURL(key string) string {
	segs := strings.Split(key, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return fmt.Sprintf("%s/accounts/%s/r2/buckets/%s/objects/%s",
		strings.TrimSuffix(c.cfg.BaseURL, "/"),
		url.PathEscape(c.cfg.AccountID),
		url.PathEscape(c.cfg.Bucket),
		strings.Join(segs, "/"))
}

func (c *R2Client) do(req *http.Request) (*http.Response, error) {
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIToken)
	return c.hc.Do(req)
}

// Exists 查同 key 是否已在 bucket（no-op 依據）。
// ⚠️ CF REST API 的 objects 端點不支援 HEAD（2026-07-19 live 實測回 405），
// 改用 GET＋`Range: bytes=0-0`：存在＝200/206（最多讀 1 byte 就丟）、404＝不存在、其他＝錯誤。
func (c *R2Client) Exists(key string) (bool, error) {
	req, err := http.NewRequest(http.MethodGet, c.objectURL(key), nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Range", "bytes=0-0")
	resp, err := c.do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1024)) // Range 若未被支援也只讀一小段就收
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("存在檢查 GET %s 非預期狀態 %d", key, resp.StatusCode)
	}
}

// Put 上傳物件。key 必為 raw/<sha256hex>（呼叫端保證 key＝內容 hash）。
func (c *R2Client) Put(key string, body io.Reader, size int64, contentType string) error {
	req, err := http.NewRequest(http.MethodPut, c.objectURL(key), body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("PUT %s 失敗（HTTP %d）：%s", key, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return nil
}

// UploadResult 是單一事件的上傳結果，隨 payload 一起輸出 stdout 給呼叫端/日誌。
type UploadResult struct {
	Path   string `json:"path"`
	R2Key  string `json:"r2_key"`
	Status string `json:"status"` // uploaded | skipped_exists | failed | planned（--dry-run）
	Error  string `json:"error,omitempty"`
}

// UploadChanged 把本輪 added/modified 事件的原稿上傳 R2（renamed/removed 內容未變/已留底，不上傳）。
//
//   - 冪等：每 key 先做存在檢查（Exists），存在＝skipped_exists 不 PUT。
//   - 上傳前重算 sha256 核對事件 hash——content-addressed 鐵律：key 與內容不符，寧可失敗也不上傳
//     （檔案在掃描後被改動＝本輪跳過，下輪重掃自然帶新 hash）。
//   - 失敗只記結果、不動 manifest：ingested_hash 是「整條 ingest 鏈成功」後才回寫的
//     （回寫鉤子＝Manifest.MarkIngested，由 task 4 觸發鏈呼叫；上傳成功 ≠ ingest 完成）。
func UploadChanged(root string, events []Event, c *R2Client) []UploadResult {
	results := []UploadResult{}
	for _, ev := range events {
		if ev.Type != "added" && ev.Type != "modified" {
			continue
		}
		res := UploadResult{Path: ev.Path, R2Key: ev.R2Key}
		full := filepath.Join(root, filepath.FromSlash(ev.Path))

		h, err := hashFile(full)
		if err != nil {
			res.Status, res.Error = "failed", "讀檔失敗："+err.Error()
			results = append(results, res)
			continue
		}
		if h != ev.SourceHash {
			res.Status = "failed"
			res.Error = "檔案在掃描後被改動（hash 不符 key），本輪不上傳；下輪重掃會帶新 hash"
			results = append(results, res)
			continue
		}

		exists, err := c.Exists(ev.R2Key)
		if err != nil {
			res.Status, res.Error = "failed", err.Error()
			results = append(results, res)
			continue
		}
		if exists {
			res.Status = "skipped_exists"
			results = append(results, res)
			continue
		}

		f, err := os.Open(full)
		if err != nil {
			res.Status, res.Error = "failed", "開檔失敗："+err.Error()
			results = append(results, res)
			continue
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			res.Status, res.Error = "failed", err.Error()
			results = append(results, res)
			continue
		}
		err = c.Put(ev.R2Key, f, info.Size(), mime.TypeByExtension(strings.ToLower(filepath.Ext(full))))
		f.Close()
		if err != nil {
			res.Status, res.Error = "failed", err.Error()
		} else {
			res.Status = "uploaded"
		}
		results = append(results, res)
	}
	return results
}
