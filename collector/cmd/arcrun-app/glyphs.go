package main

// glyphs.go — App 圖示的字形，向實例拿（inkstone/arcrun-rag#240 c18275）
//
// leo：「筆記 icon 在小幫手和在 portal 不同？應從同一個地方拉」。
// 小幫手不存任何一顆字形，也不自己對照 emoji：Portal 與小幫手都向實例要同一份，
// Portal 改了，小幫手不用動就跟著變。
//
// 契約（需要實例提供，見 #240 的需求留言）：
//
//	GET /apps/glyphs（X-Arcrun-API-Key）或 /portal/data/apps/glyphs（Bearer session）
//	→ {"glyphs": {"note": "<path d=\"…\"/>…", …}}     值＝24×24 描邊式 SVG 的內層標記
//	且 App 清單每筆多一欄 `glyph`（實例挑好的代號）。
//
// 拿不到（舊實例 404、連不上、格式不對）⇒ 回 nil，畫面用通用圖示；不當成錯誤。
import (
	"encoding/json"
	"net/http"
	"strings"
)

func fetchGlyphs(acc accountCfg) map[string]string {
	base := apiBaseOf(acc)
	if base == "" {
		return nil
	}
	var req *http.Request
	switch {
	case sessionValid(acc):
		req, _ = http.NewRequest(http.MethodGet, base+"/portal/data/apps/glyphs", nil)
		req.Header.Set("Authorization", "Bearer "+acc.PortalSession)
	case strings.TrimSpace(acc.APIKey) != "":
		req, _ = http.NewRequest(http.MethodGet, base+"/apps/glyphs", nil)
		req.Header.Set("X-Arcrun-API-Key", acc.APIKey)
	default:
		return nil
	}
	status, raw, err := appDo(req, appReadTimeout)
	if err != nil || status != http.StatusOK {
		return nil
	}
	return parseGlyphs(raw)
}

// parseGlyphs 純函式（單測用）：只收 {"glyphs": {代號: 字串}}，其餘一律丟掉。
func parseGlyphs(raw []byte) map[string]string {
	var body struct {
		Glyphs map[string]string `json:"glyphs"`
	}
	if json.Unmarshal(raw, &body) != nil || len(body.Glyphs) == 0 {
		return nil
	}
	return body.Glyphs
}
