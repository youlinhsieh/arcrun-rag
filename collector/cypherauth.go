// cypherauth.go — 打雲端（cypher）時帶上合法憑證（inkstone/arcrun-rag#334，母票 inkstone/Arcrun#399）。
//
// 背景：cypher 在相容期（CYPHER_AUTH_COMPAT_UNTIL，暫定 2026-12-15）之後，只認
// 「租戶名＋Bearer 憑證」；只有租戶名（`X-Arcrun-API-Key: <namespace>`）一律 401。
//
// 憑證格式只有一套（Arcrun#399 c1794480503109218）：
//
//	X-Arcrun-API-Key: <租戶名>
//	Authorization:    Bearer <key>
//	key ＝ HMAC-SHA256(金鑰＝實例的 KBDB_INTERNAL_TOKEN, 訊息＝"kbdb-proxy-v1\n"+租戶名) 的小寫 hex
//
// 小幫手不會自己算（它沒有 KBDB_INTERNAL_TOKEN）：連線精靈 `POST /portal/daemon/config`
// 回的 `config.kbdb_key` 就是它，存進 config.json 的 `kbdb_key`。**不是使用者要自己設的金鑰**。
//
// 🔴 inkstone/arcrun-rag#402：**小幫手只有這一把憑證**（不過期）。同步、問答、App、跨帳號互連全用它，
// 雲端 Portal 端點也直接認它（Arcrun#580）。曾經另有一把會 7 天過期的 portal_session，已整條拿掉。
//
// 為什麼是「登記簿」而不是每個呼叫點各傳一個參數：打雲端的呼叫點有十幾處，
// 大多只拿到 apiKey 字串。key 與租戶一對一（key 由租戶名算出），所以以 apiKey 為鍵登記一次，
// 所有呼叫點改用 SetCypherAuth(req, apiKey) 一行就同時帶上兩個 header——
// 漏接一處＝那條路在相容期後 401，所以集中在一個函式比散落十幾處可靠。
package collector

import (
	"net/http"
	"strings"
	"sync"
)

var cypherKeys sync.Map // 租戶名（X-Arcrun-API-Key 的值，trim 後）→ kbdb_key

// RegisterCypherKey 登記一個租戶的憑證。key 為空＝不動（保留既有登記，舊 config 沒這欄不會把它清掉）。
func RegisterCypherKey(tenant, key string) {
	tenant, key = strings.TrimSpace(tenant), strings.TrimSpace(key)
	if tenant == "" || key == "" {
		return
	}
	cypherKeys.Store(tenant, key)
}

// CypherKeyFor 回該租戶登記的憑證；沒有＝空字串（舊版 config、還沒重新連線過）。
func CypherKeyFor(tenant string) string {
	if v, ok := cypherKeys.Load(strings.TrimSpace(tenant)); ok {
		return v.(string)
	}
	return ""
}

// SetCypherAuth 在打 cypher 的請求上放 `X-Arcrun-API-Key`，有登記憑證就再放 `Authorization: Bearer`。
// 沒登記＝只帶租戶名（相容期內舊行為，雲端會回 X-Arcrun-Auth-Deprecated；相容期後 401）。
// 已有 Authorization 的請求不動（呼叫端自己選了別種憑證，例如 portal session）。
func SetCypherAuth(req *http.Request, apiKey string) {
	req.Header.Set("X-Arcrun-API-Key", apiKey)
	if req.Header.Get("Authorization") != "" {
		return
	}
	if k := CypherKeyFor(apiKey); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
}

// registerAccountKeys 把設定檔裡每個帳號（與舊制頂層）的 kbdb_key 登記起來。
func registerAccountKeys(c *DirectConfig) {
	for _, a := range c.Accounts {
		t := a.APIKey
		if strings.TrimSpace(t) == "" {
			t = a.Namespace
		}
		RegisterCypherKey(t, a.KbdbKey)
	}
	t := c.APIKey
	if strings.TrimSpace(t) == "" {
		t = c.Namespace
	}
	RegisterCypherKey(t, c.KbdbKey)
}

// CypherAuthDeprecated 回應若帶 `X-Arcrun-Auth-Deprecated`（相容期內放行了只帶租戶名的請求），
// 回那一行說明；沒有＝空字串。呼叫端可據此提示「請重新連線以更新」。
func CypherAuthDeprecated(resp *http.Response) string {
	if resp == nil {
		return ""
	}
	return resp.Header.Get("X-Arcrun-Auth-Deprecated")
}
