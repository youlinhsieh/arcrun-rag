// credentialcause.go — 「取不到內部金鑰」有兩種原因，而雲端的錯誤訊息分不出來
// （`inkstone/arcrun-rag#179` comment 6867／6871）。
//
// 🔴 為什麼有這支檔（2026-09-10 實錄，不是推測）：
// 收卡失敗時雲端回的那句是
//
//	Node list_old_blocks failed: credential resolve 失敗: 缺少 credential: kbdb_internal_token。
//	修復: 編輯 credentials.yaml 後執行 acr creds …
//
// 這句話**指名了一個修法**，而那個修法對使用者、對我們都不成立。更糟的是它在
// 兩種完全不同的原因下都會原樣出現——證據在 Arcrun 核心那三行：
//
//	cypher-executor/src/routes/credentials.ts:251-254
//	  getCredentialDirectory()：KBDB 不可達 → `return []`（註解自稱「誠實回空」）
//	cypher-executor/src/actions/auth-dispatcher.ts:73
//	  refs 為空 → 整組走 fallback（註解自己寫著「目錄空 / KBDB 不可達」）
//	registry/components/auth_static_key/main.go:248
//	  最後在 WASM 裡寫死那句「缺少 credential: X。修復: 編輯 credentials.yaml…」
//
// ⇒ 「目錄裡沒有這一把」與「目錄現在讀不到」在第一行就被壓成同一個值，
// 之後任何人都不可能再把它們分開。總管 2026-09-10 就是被這句話帶著跑了一整天，
// 並且據此在票上寫了兩則錯的結論。
//
// ── 這支檔做什麼、不做什麼 ──────────────────────────────────────────────
// 那三行住在 Leo/Arcrun，**不在本 repo**（CLAUDE.md：非改核心不可＝停手回報，
// 不在這裡複製一份改）。所以這裡不去修訊息的產地，做的是另一件事：
//
//	**我們自己去問一次，然後只說我們問得出來的那件事。**
//
// 問法是實例本來就有的治理端點 `GET /credentials`（列目錄，只回 metadata、不回值）。
// 它與收卡走的是同一條資料路（cypher → KBDB → D1），所以：
//
//	它回 5xx        ⇒ 資料層現在讀不到 ⇒ **不是金鑰不見**，稍後會自己好
//	它回 200 沒這把 ⇒ 目錄讀得到，就是沒種進去 ⇒ 我們的安裝沒到位，重試無用
//	它回 200 有這把 ⇒ 目錄有它，取值那一段才是壞的
//	問不出來        ⇒ **就說不知道**，不編一個原因出來
//
// 🔴 三條自我約束（與 triggeroutcome.go 同源）：
//   - **只在失敗那一刻問**：不輪詢、不預熱、成功的路一次都不打（守「禁排程輪詢」）。
//   - **一輪只問一次**：同一個實例 60 秒內共用同一份答案，不然 3,620 份檔就是 3,620 發。
//   - **問不到不快取**：一次網路抖動不該讓整輪都變成「不知道」。
package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// credDirStatus＝「金鑰目錄現在是什麼狀況」。
type credDirStatus int

const (
	// credDirUnknown＝問不到（探針自己連不上／回了看不懂的東西／這個實例沒有那條路由）。
	// 🔴 它**不等於**「目錄是空的」——那正是本檔要治的那個混淆，不可再犯一次。
	credDirUnknown credDirStatus = iota
	// credDirUnreachable＝目錄讀不到：資料層（KBDB／D1）回錯。
	credDirUnreachable
	// credDirReadable＝目錄讀得到，Names 才有意義。
	credDirReadable
)

// credDirReport＝探針的回答。Detail 是給檢修孔看的原文，**不進使用者文案**。
type credDirReport struct {
	Status credDirStatus
	Names  map[string]bool
	Detail string
}

// has 回「目錄裡有沒有這一把」。只有 Readable 時問得有意義（呼叫端自己先判 Status）。
func (r credDirReport) has(name string) bool { return r.Names[name] }

// credentialProbe＝呼叫端提供的「去問一次」。nil＝這條路上問不到（例如沒有連線設定）。
type credentialProbe func() credDirReport

type credDirCacheEntry struct {
	rep credDirReport
	at  time.Time
}

// credDirTTL 對齊 cypher 自己那層目錄快取的 60 秒（credentials.ts DIR_CACHE_TTL_MS），
// 免得我們問到的與工作流當下用到的是兩個世代。
const credDirTTL = 60 * time.Second

var (
	credDirMu    sync.Mutex
	credDirCache = map[string]credDirCacheEntry{}
	// credDirNow 讓測試推時間，正式路徑一律 time.Now。
	credDirNow = time.Now
)

// resetCredDirCache 只給測試用。
func resetCredDirCache() {
	credDirMu.Lock()
	defer credDirMu.Unlock()
	credDirCache = map[string]credDirCacheEntry{}
}

// credentialDirectoryProbe 組出「問這個帳號的目錄」的探針。
//
// 用的 header 與觸發收卡的那一發**完全相同**（X-Arcrun-API-Key: c.APIKey）——
// 這很重要：credential 目錄是按 api_key 分租戶的，換一把 key 問到的是別人的目錄。
// 而工作流既然已經跑起來（是在節點裡失敗的，不是被擋在門口），就證明這把 key
// 正是那趟執行的租戶身分 ⇒ 兩邊問的是同一份目錄。
func (c *DirectConfig) credentialDirectoryProbe() credentialProbe {
	base := strings.TrimSuffix(c.CypherURL, "/")
	key := c.APIKey
	if base == "" || key == "" {
		return nil // 沒有連線設定 ⇒ 問不到 ⇒ 誠實回 nil，讓文案走「不知道」那格
	}
	return func() credDirReport { return probeCredentialDirectory(base, key) }
}

func probeCredentialDirectory(base, apiKey string) credDirReport {
	ck := base + "\x00" + apiKey
	now := credDirNow()

	credDirMu.Lock()
	if e, ok := credDirCache[ck]; ok && now.Sub(e.at) < credDirTTL {
		credDirMu.Unlock()
		return e.rep
	}
	credDirMu.Unlock()

	rep := fetchCredentialDirectory(base, apiKey)
	if rep.Status != credDirUnknown {
		credDirMu.Lock()
		credDirCache[ck] = credDirCacheEntry{rep: rep, at: now}
		credDirMu.Unlock()
	}
	return rep
}

func fetchCredentialDirectory(base, apiKey string) credDirReport {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/credentials", nil)
	if err != nil {
		return credDirReport{Status: credDirUnknown, Detail: "組不出目錄查詢：" + err.Error()}
	}
	req.Header.Set("X-Arcrun-API-Key", apiKey)
	resp, err := directHTTP.Do(req)
	if err != nil {
		return credDirReport{Status: credDirUnknown, Detail: "目錄查詢連不上：" + err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return readCredentialDirectory(resp.StatusCode, body)
}

// readCredentialDirectory 是純函式，好讓測試把三種回應原樣餵進來。
func readCredentialDirectory(status int, body []byte) credDirReport {
	snippet := strings.TrimSpace(string(body))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	detail := fmt.Sprintf("GET /credentials → HTTP %d：%s", status, snippet)

	// 5xx＝cypher 自己說它問不到目錄（實作對 KBDB 不可達回 502
	// 「credential 目錄查詢失敗」，見 credentials.ts 的 listCredentialRows）。
	// 這一格就是我們唯一能拿來把「讀不到」跟「沒有」分開的證據。
	if status >= 500 {
		return credDirReport{Status: credDirUnreachable, Detail: detail}
	}
	// 401/403/404 ⇒ **是我們問錯了**（key 不對、或這個世代的實例沒有這條路由），
	// 不是資料層壞了。不准借它去說任何一種原因。
	if status != http.StatusOK {
		return credDirReport{Status: credDirUnknown, Detail: detail}
	}
	var parsed struct {
		Success     *bool  `json:"success"`
		Error       string `json:"error"`
		Credentials []struct {
			Name string `json:"name"`
		} `json:"credentials"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return credDirReport{Status: credDirUnknown, Detail: detail}
	}
	if parsed.Success != nil && !*parsed.Success {
		// 200 卻自稱失敗：它講的仍然是「目錄這一趟查不出來」。
		return credDirReport{Status: credDirUnreachable, Detail: detail}
	}
	if parsed.Success == nil {
		// 連 success 欄位都沒有 ⇒ 這不是我們認得的回應 ⇒ 不當成「目錄是空的」。
		return credDirReport{Status: credDirUnknown, Detail: detail}
	}
	names := map[string]bool{}
	for _, c := range parsed.Credentials {
		if c.Name != "" {
			names[c.Name] = true
		}
	}
	return credDirReport{Status: credDirReadable, Names: names, Detail: detail}
}

// credentialNameIn 從上游那句挖出金鑰名字（「缺少 credential: kbdb_internal_token。修復…」）。
// 挖不到就回空字串——**沒挖到不猜**，文案會走「不知道」那一格。
func credentialNameIn(raw string) string {
	const marker = "credential: "
	i := strings.Index(raw, marker)
	if i < 0 {
		return ""
	}
	rest := raw[i+len(marker):]
	end := strings.IndexFunc(rest, func(r rune) bool {
		return !(r == '_' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'))
	})
	if end < 0 {
		return rest
	}
	return rest[:end]
}
