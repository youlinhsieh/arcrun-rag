// captiveportal.go — 認得「這個網路要先登入」（公眾 Wi-Fi 的登入頁），並講成人話。
//
// 實錄（`inkstone/arcrun-collector#1`，2026-10-31）：leo 的 Mac 連著 TPE-Free 公眾 Wi-Fi，
// 小幫手送往知識庫的那一發被導去它的登入頁而失敗。畫面只說「這次沒送上去，稍後會自動再試」——
// 使用者不知道**該去做的事是打開瀏覽器登入那個 Wi-Fi**，而這句話與「雲端壞了」長得一樣。
//
// 三種長相（都不是雲端的錯，也不是哪個檔的錯）：
//  1. 憑證對不上／簽發者不認得：登入頁攔截 HTTPS 時拿自己的憑證頂替；
//  2. 回應被導去別的主機（POST 被 302 導向登入頁，client 跟過去）；
//  3. 回 511（Network Authentication Required，RFC 6585 就是為此而設）；
//  4. 2xx 卻是 HTML：知識庫的觸發端點只會回 JSON，回 HTML 的只可能是中途被攔的登入頁。
//     Cloudflare 自己的錯誤頁也是 HTML，但帶 CF-RAY 標頭、且是 5xx，不在這條判準裡。
//
// 🔴 這一類失敗**沒有離開這台電腦**（沒到雲端）⇒ 與 DNS／斷網同一類：
// 不記進逐檔病歷、不算斷路器的失敗（見 isLocalNetworkErr）。
package collector

import (
	"crypto/x509"
	"errors"
	"net/http"
	"strings"
)

// captivePortalSentence＝畫面上那一句。結尾「後重試」是 explainsWhySkipped 的識別字。
const captivePortalSentence = "這個網路需要先登入（像公眾 Wi-Fi 的登入頁）：請打開瀏覽器完成登入，登入後小幫手會自動接續，稍後重試"

// captivePortalError＝「這一發被網路的登入頁攔下了」。
type captivePortalError struct{ detail string }

func (e *captivePortalError) Error() string {
	if e.detail == "" {
		return captivePortalSentence
	}
	return captivePortalSentence + "｜" + e.detail
}

// isCaptivePortalErr 認出這類錯誤（含被包過一層的）。
func isCaptivePortalErr(err error) bool {
	var cp *captivePortalError
	return errors.As(err, &cp)
}

// captivePortalFromTransport：連線層的錯是不是登入頁攔截 HTTPS 的特徵（憑證不對）。
func captivePortalFromTransport(err error) *captivePortalError {
	if err == nil {
		return nil
	}
	var unknownAuth x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	if errors.As(err, &unknownAuth) || errors.As(err, &hostErr) {
		return &captivePortalError{detail: "憑證對不上這台知識庫"}
	}
	return nil
}

// captivePortalFromResponse：回應本身是不是登入頁。reqHost＝我們原本要打的主機。
func captivePortalFromResponse(reqHost string, resp *http.Response, body []byte) *captivePortalError {
	if resp == nil {
		return nil
	}
	if resp.Request != nil && resp.Request.URL != nil && reqHost != "" &&
		!strings.EqualFold(resp.Request.URL.Host, reqHost) {
		return &captivePortalError{detail: "被導去別的網址"}
	}
	if resp.StatusCode == http.StatusNetworkAuthenticationRequired {
		return &captivePortalError{detail: "網路回報需要登入"}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && resp.Header.Get("CF-RAY") == "" {
		t := strings.ToLower(strings.TrimSpace(string(body)))
		ct := strings.ToLower(resp.Header.Get("Content-Type"))
		if strings.Contains(ct, "text/html") || strings.HasPrefix(t, "<!doctype html") || strings.HasPrefix(t, "<html") {
			return &captivePortalError{detail: "收到的是網頁而不是知識庫的回應"}
		}
	}
	return nil
}
