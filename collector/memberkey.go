// memberkey.go — 公司那台的同仁憑證與「這個庫不是你的」人話（inkstone/arcrun-rag#390）。
//
// 兩件事：
//
//  1. upgradeMemberKeys：#390 之前連上公司那台的一般同仁，config 裡存的 kbdb_key 是整台的租戶金鑰。
//     他存了 portal_session（連線時就存了），啟動時用它向 `GET /portal/daemon/key` 換「綁本人」的憑證
//     （dk1.…）換上並回寫 config——伺服器之後才分得出每次寫入是誰（庫歸屬、稽核）。
//     管理員／全庫帳號回 scope=tenant，原樣不動。換不到（網路、舊雲端 404、session 過期）一律不擋啟動，
//     下次啟動再試——它只是升級，不是前提。
//  2. memberACLSentence：雲端擋下寫入時（403 library_not_yours／library_required／admin_only）
//     換成使用者看得懂的一句話，不印 JSON 原文。
package collector

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const daemonUserKeyPrefix = "dk1."

var memberKeyHTTP = &http.Client{Timeout: 15 * time.Second}

// upgradeMemberKeys 回傳有沒有換過任何一個帳號的憑證（換過就已回寫 configPath）。
func upgradeMemberKeys(cfg *DirectConfig, configPath string) bool {
	changed := false
	for i := range cfg.Accounts {
		a := &cfg.Accounts[i]
		if strings.HasPrefix(a.KbdbKey, daemonUserKeyPrefix) || strings.TrimSpace(a.PortalSession) == "" {
			continue
		}
		if a.PortalSessionExp != 0 && a.PortalSessionExp <= time.Now().Unix() {
			continue
		}
		tenant := strings.TrimSpace(a.APIKey)
		if tenant == "" {
			tenant = strings.TrimSpace(a.Namespace)
		}
		key, scope := fetchDaemonKey(a.CypherURL, tenant, a.PortalSession)
		if key == "" || scope != "member" {
			continue
		}
		a.KbdbKey = key
		RegisterCypherKey(tenant, key)
		changed = true
	}
	if changed && configPath != "" {
		if err := saveDirectConfig(configPath, cfg); err != nil {
			fmt.Printf("⚠ 同仁憑證已換成綁本人的，但寫回 config 失敗（本次執行仍有效）：%v\n", err)
		}
	}
	return changed
}

func fetchDaemonKey(cypherURL, tenant, session string) (key, scope string) {
	base := strings.TrimSuffix(strings.TrimSpace(cypherURL), "/")
	if base == "" || tenant == "" {
		return "", ""
	}
	req, err := http.NewRequest(http.MethodGet, base+"/portal/daemon/key", nil)
	if err != nil {
		return "", ""
	}
	req.Header.Set("X-Arcrun-API-Key", tenant)
	req.Header.Set("Authorization", "Bearer "+session)
	resp, err := memberKeyHTTP.Do(req)
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", ""
	}
	var out struct {
		KbdbKey string `json:"kbdb_key"`
		Scope   string `json:"scope"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out) != nil {
		return "", ""
	}
	return out.KbdbKey, out.Scope
}

// memberACLSentence：雲端因庫歸屬／權限擋下寫入時的人話。認不出來回空字串（呼叫端走原本的錯誤字串）。
func memberACLSentence(status int, body string) string {
	if status != http.StatusForbidden {
		return ""
	}
	var out struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(body)), &out) != nil {
		return ""
	}
	switch out.Code {
	case "library_not_yours":
		if out.Error != "" {
			return out.Error // 雲端那句已經是人話（說明是誰送的、怎麼辦）
		}
		return "這個庫不是你的，你沒有寫入權限。要送自己的資料夾，請換一個資料夾名稱，或請管理員協助。"
	case "library_required":
		return "這個動作要指明送進哪個庫。請更新同步小幫手後再試。"
	case "admin_only":
		return "這個動作只有管理員能做，你的帳號沒有這個權限。"
	}
	return ""
}
