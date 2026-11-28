// memberkey.go — 「這個庫不是你的」人話（inkstone/arcrun-rag#390）。
//
// memberACLSentence：雲端擋下寫入時（403 library_not_yours／library_required／admin_only）
// 換成使用者看得懂的一句話，不印 JSON 原文。
//
// 🔴 inkstone/arcrun-rag#402：#390 當時有一支 upgradeMemberKeys，用連線時存的 portal_session
// 向 `GET /portal/daemon/key` 把同仁的整台租戶金鑰換成綁本人的 dk1 憑證。portal_session
// 整條拿掉之後它沒有東西可帶，連同拿掉；舊的租戶金鑰帳號由雲端 Portal 端點回 401 reconnect_required，
// 小幫手畫面請用戶重新連線一次（連線精靈本來就發 dk1，Arcrun#580）。
package collector

import (
	"encoding/json"
	"net/http"
	"strings"
)

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
