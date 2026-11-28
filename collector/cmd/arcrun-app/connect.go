package main

// connect.go — 連線精靈的後端（t193）
//
// ⚠️ 本檔的 normalizePortalURL / fetchConfigByLogin / instanceChanged
// **逐字取自 arcrun-tray/main.go**，不是重寫。理由：
//   - 那些是踩過坑才長出來的（例：instanceChanged 是 t86 個資外洩事故的防線——
//     leo 2026-07-28 實測發現 youlin 時代的資料夾被同步進 geek6688 新實例）
//   - 今天已經犯過一次「重寫別人修好的東西還修得更差」，不再犯第二次
// 兩邊哪天要改，**兩邊一起改**（與 trayMinCloud* 常數同一套規矩）。
import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	neturl "net/url"
	"regexp"
	"strings"
	"time"
)

type daemonConfig struct {
	CypherURL    string `json:"cypher_url"`
	Namespace    string `json:"namespace"`
	Library      string `json:"library"`
	Email        string `json:"email"`
	InstanceName string `json:"instance_name"`
	// KbdbKey＝打雲端的 Bearer 憑證（#334）。舊版雲端沒有這欄＝空字串，照舊只帶租戶名。
	KbdbKey string `json:"kbdb_key"`
}

type daemonConfigResp struct {
	Success bool         `json:"success"`
	Config  daemonConfig `json:"config"`
	Error   string       `json:"error"`
	// reached＝這次實際連得通的 API 位址（不是伺服器自己說的）。inkstone/arcrun-rag#389：
	// 伺服器若把自己的對外網址存成 127.0.0.1（地端精靈填錯），回給小幫手的 cypher_url 也是 127.0.0.1，
	// 小幫手就會連到「同仁自己的電腦」。有了這欄就能用「剛剛連得通的那個位址」把它換回來。
	reached string
}

// normalizePortalURL 把用戶貼的東西變成可打的 origin。
// portal（GUI）與 cypher（API）是不同子域：用戶手上的是 portal，這裡換算成 API 位址。
func normalizePortalURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("請貼上你的知識庫網址")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := neturl.Parse(s)
	if err != nil || u.Host == "" {
		return "", errors.New("網址看起來不太對，請從信裡或瀏覽器網址列複製整段")
	}
	host := u.Host
	if strings.HasPrefix(host, "arcrun-rag-ui.") {
		host = "arcrun-cypher-executor." + strings.TrimPrefix(host, "arcrun-rag-ui.")
	}
	// 企業私有雲（inkstone/arcrun-rag#335）：公司內網常常是 http://主機:埠，且位址是管理員自己訂的，
	// 不是 CF 的 workers.dev。用戶**明確打了 http://** 就照用（不替他改成 https 然後連不上）；
	// 沒打協定一律補 https（現實世界的網址全是 https，不必逼用戶記得打）。
	scheme := "https"
	if strings.EqualFold(u.Scheme, "http") {
		scheme = "http"
	}
	return scheme + "://" + host, nil
}

// fetchConfigByLogin：帳密換連線設定。
//
// 企業私有雲（inkstone/arcrun-rag#335）：網頁（portal）與 API 常常是不同位址（例：內網 :8080 與 :8081），
// 用戶手上通常是網頁網址。打過去不是設定回應時，讀 portal 自己附的 `/config.js`（`apiBase`）找到 API 再打一次。
// 只在「對方不像 API」（非 JSON／404／405）時才找——帳密錯、被鎖定這類真的回應不重打，避免帳密被多送一次。
func fetchConfigByLogin(portalURL, email, password string) (*daemonConfigResp, error) {
	base, err := normalizePortalURL(portalURL)
	if err != nil {
		return nil, err
	}
	out, status, err := postDaemonConfig(base, email, password)
	if err != nil {
		return nil, err
	}
	reached := base
	if out == nil && (status == 0 || status == http.StatusNotFound || status == http.StatusMethodNotAllowed || status == http.StatusOK) {
		if api := discoverAPIBase(base); api != "" && api != base {
			out, status, err = postDaemonConfig(api, email, password)
			if err != nil {
				return nil, err
			}
			reached = api
		}
	}
	if out == nil {
		return nil, errors.New("這個網址不像是 Arcrun RAG 知識庫，請再確認一次")
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, errors.New("帳號或密碼不對——用你在知識庫網站設定的那組")
	}
	if !out.Success {
		if out.Error != "" {
			return nil, errors.New(out.Error)
		}
		return nil, errors.New("連線失敗，請稍後再試一次")
	}
	out.reached = reached
	out.Config.CypherURL = fixLoopbackURL(out.Config.CypherURL, reached)
	return out, nil
}

// postDaemonConfig 打一次 /portal/daemon/config。回應不是 JSON 設定格式時 out=nil（status 仍回，給呼叫端判斷要不要找 API）。
func postDaemonConfig(base, email, password string) (*daemonConfigResp, int, error) {
	body, _ := json.Marshal(map[string]string{"email": strings.TrimSpace(email), "password": password})
	req, err := http.NewRequest(http.MethodPost, base+"/portal/daemon/config", bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, 0, errors.New("連不上這個網址——請確認網址正確、網路正常")
	}
	defer res.Body.Close()
	var out daemonConfigResp
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, res.StatusCode, nil
	}
	return &out, res.StatusCode, nil
}

var apiBaseInConfigJS = regexp.MustCompile(`["']?apiBase["']?\s*:\s*["']([^"']+)["']`)

// fixLoopbackURL：伺服器回的位址是 localhost／127.0.0.1／0.0.0.0，而我們連得通的位址不是 ⇒ 伺服器存錯了對外網址
// （大前試裝 7b：精靈在 server 本機開，網址存成 127.0.0.1），同仁電腦上的 127.0.0.1 是他自己，永遠連不到。
// 把主機換成「剛剛連得通的那個」，埠與協定沿用伺服器說的（網頁 :8080／API :8081 這類不同埠才不會弄混）。
// 兩邊都不是回送位址、或我們連的本來就是回送位址（同一台機器上試）＝原樣不動。
func fixLoopbackURL(got, reached string) string {
	g, err1 := neturl.Parse(strings.TrimSpace(got))
	r, err2 := neturl.Parse(strings.TrimSpace(reached))
	if err1 != nil || err2 != nil || g.Host == "" || r.Host == "" || !isLoopbackHost(g.Hostname()) || isLoopbackHost(r.Hostname()) {
		return got
	}
	host := r.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if p := g.Port(); p != "" {
		host += ":" + p
	}
	g.Host = host
	return strings.TrimRight(g.String(), "/")
}

func isLoopbackHost(h string) bool {
	h = strings.ToLower(strings.Trim(h, "[]"))
	return h == "localhost" || h == "::1" || h == "::" || h == "0.0.0.0" || strings.HasPrefix(h, "127.")
}

// discoverAPIBase 讀 portal 的 `/config.js`（安裝器／私有雲映像檔注入的 `apiBase`）。找不到回 ""。
func discoverAPIBase(base string) string {
	res, err := (&http.Client{Timeout: 10 * time.Second}).Get(base + "/config.js")
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<10))
	m := apiBaseInConfigJS.FindSubmatch(raw)
	if m == nil {
		return ""
	}
	api, err := normalizePortalURL(string(m[1]))
	if err != nil {
		return ""
	}
	// 網頁的 /config.js 若寫著 127.0.0.1（伺服器存錯），換成我們打進來的那台主機（#389）
	return fixLoopbackURL(api, base)
}

// Connect 是前端「連線」按鈕的入口：帳密換設定 → append 成新帳號（或更新既有同實例帳號）。
//
// 🔴 密碼零落地（刻意的安全設計）：只在這一刻用來換設定，**不寫進 config.json**。
func (a *App) Connect(portalURL, email, password string) error {
	r, err := fetchConfigByLogin(portalURL, email, password)
	if err != nil {
		return err
	}
	cfg, _ := loadCfg()
	// 用戶貼的是網頁網址、而實際連到的 API 是另一個位址（私有雲網頁與 API 不同埠）⇒ 記下網頁網址，
	// 「開啟知識庫網頁」才開得對（inkstone/arcrun-rag#389）。貼的就是 API 位址時不知道網頁在哪，留空。
	webURL := ""
	if typed, err := normalizePortalURL(portalURL); err == nil && typed != r.reached {
		webURL = typed
	}

	newHost := hostOf(r.Config.CypherURL)
	for i := range cfg.Accounts {
		if hostOf(cfg.Accounts[i].CypherURL) == newHost {
			// 同一個實例＝更新連線資訊，**保留既有 watch_folders**（改密碼不該清掉資料夾）
			cfg.Accounts[i].CypherURL = r.Config.CypherURL
			if webURL != "" {
				cfg.Accounts[i].PortalURL = webURL
			}
			cfg.Accounts[i].Namespace = r.Config.Namespace
			cfg.Accounts[i].APIKey = r.Config.Namespace
			if r.Config.KbdbKey != "" { // 舊雲端不回這欄：不要把已存的憑證洗成空
				cfg.Accounts[i].KbdbKey = r.Config.KbdbKey
			}
			cfg.Accounts[i].Email = r.Config.Email
			cfg.Accounts[i].InstanceName = r.Config.InstanceName
			return saveCfg(cfg)
		}
	}
	// 不同實例＝新增一個帳號。**不覆蓋舊帳號**——t86 事故的教訓：
	// 舊實例的資料夾若被帶進新實例，等於把別人的檔案同步到另一個知識庫（個資外洩）。
	wasFirstEver := len(cfg.Accounts) == 0 // 這台機器至今從沒連過任何知識庫帳號
	cfg.Accounts = append(cfg.Accounts, accountCfg{
		InstanceName: r.Config.InstanceName,
		Email:        r.Config.Email,
		CypherURL:    r.Config.CypherURL,
		PortalURL:    webURL,
		Namespace:    r.Config.Namespace,
		APIKey:       r.Config.Namespace,
		KbdbKey:      r.Config.KbdbKey,
	})
	if wasFirstEver {
		// leo 2026-08-08：全新安裝自動裝一個「可刪除的預設庫」，讓使用者不必
		// 自己選資料夾也能立刻看到「丟檔 → 知識卡 → 搜得到」整條路（見 default_library.go）。
		seedDefaultLibraryIfFirstEver(cfg, len(cfg.Accounts)-1)
	}
	return saveCfg(cfg)
}

func hostOf(s string) string {
	u, err := neturl.Parse(strings.TrimSpace(s))
	if err != nil || u.Host == "" {
		return strings.TrimSpace(s)
	}
	return u.Host
}
