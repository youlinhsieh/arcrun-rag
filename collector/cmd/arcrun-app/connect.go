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
	"net/http"
	neturl "net/url"
	"strings"
	"time"
)

type daemonConfig struct {
	CypherURL    string `json:"cypher_url"`
	Namespace    string `json:"namespace"`
	Library      string `json:"library"`
	Email        string `json:"email"`
	InstanceName string `json:"instance_name"`
}

type daemonConfigResp struct {
	Success bool         `json:"success"`
	Config  daemonConfig `json:"config"`
	Error   string       `json:"error"`
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
	return "https://" + host, nil
}

func fetchConfigByLogin(portalURL, email, password string) (*daemonConfigResp, error) {
	base, err := normalizePortalURL(portalURL)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{"email": strings.TrimSpace(email), "password": password})
	req, err := http.NewRequest(http.MethodPost, base+"/portal/daemon/config", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, errors.New("連不上這個網址——請確認網址正確、網路正常")
	}
	defer res.Body.Close()
	var out daemonConfigResp
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, errors.New("這個網址不像是 Arcrun RAG 知識庫，請再確認一次")
	}
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return nil, errors.New("帳號或密碼不對——用你在知識庫網站設定的那組")
	}
	if !out.Success {
		if out.Error != "" {
			return nil, errors.New(out.Error)
		}
		return nil, errors.New("連線失敗，請稍後再試一次")
	}
	return &out, nil
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

	newHost := hostOf(r.Config.CypherURL)
	for i := range cfg.Accounts {
		if hostOf(cfg.Accounts[i].CypherURL) == newHost {
			// 同一個實例＝更新連線資訊，**保留既有 watch_folders**（改密碼不該清掉資料夾）
			cfg.Accounts[i].CypherURL = r.Config.CypherURL
			cfg.Accounts[i].Namespace = r.Config.Namespace
			cfg.Accounts[i].APIKey = r.Config.Namespace
			cfg.Accounts[i].Email = r.Config.Email
			cfg.Accounts[i].InstanceName = r.Config.InstanceName
			// arcrun-rag#137：密碼**此刻**還在手上，順手換一張 portal session，
			// 之後 App 啟動器要看詳情／按動作就不必再問一次密碼。
			// 換不到不算連線失敗（同步這條主線用不到它），見 apps.go。
			tryStoreSessionFromLogin(cfg, i, r.Config.Email, password)
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
		Namespace:    r.Config.Namespace,
		APIKey:       r.Config.Namespace,
	})
	// arcrun-rag#137：同上，順手換一張 portal session 給 App 啟動器用。
	tryStoreSessionFromLogin(cfg, len(cfg.Accounts)-1, r.Config.Email, password)
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
