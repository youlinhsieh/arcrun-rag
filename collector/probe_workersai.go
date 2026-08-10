// probe_workersai.go — 探測「這個帳號的雲端知識庫，Workers AI 萃取通了沒」（t182）。
//
// 🔴 為什麼要探測（leo 2026-08-04 兩句話定的設計）：
//
//	① 「順序不可反這件事**門檻太高**了，用戶一定**先看到 daemon 有更新**，
//	    不會想到更新網頁」
//	② 「你可以設計如果它先做了地端就要求去做雲端，**會去掃一次看雲端是否裝好**，
//	    **沒裝好就顯示 workers AI 還沒通，一旦通了就顯示可用**」
//
// 背景：Workers AI 萃取要**兩端都新**——daemon 有新版（會打 /portal/daemon/extract）
// 且雲端實例也有新版（有這條 route）。daemon 會自動更新、雲端實例要用戶自己重跑安裝器
// ⇒ 中間必然存在一段「daemon 新、雲端舊」的空窗期。
//
// 舊設計把這段空窗丟給用戶自己想通（「你順序做錯了」），那是**我們的設計沒容錯**。
// 新設計：daemon 主動掃、把狀態講出來——
//
//	雲端還沒更新 → 托盤直接顯示「雲端 AI 還沒通 ⇒ 去 portal 按『立即更新』」
//	雲端已更新   → 顯示「雲端 AI 可用」，什麼都不必做
//
// ⚠️ 這是**被動探測**，不是輪詢：只在同步時（RunDirectOnce 每輪一次）順手打一次
// HEAD-ish 的探測請求，且結果快取在 status.json 給托盤讀。不掛任何排程。
package collector

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// probeHTTP 探測用短逾時：只是要知道 route 在不在，不等 LLM 生成。
var probeHTTP = &http.Client{Timeout: 20 * time.Second}

// CloudAIState 是「某個雲端實例的 Workers AI 萃取能力」探測結果。
type CloudAIState struct {
	Ready bool   `json:"ready"`           // true＝那端有 /portal/daemon/extract（雲端 AI 可用）
	Note  string `json:"note,omitempty"`  // 給用戶看的白話（Ready=false 時說「還沒通、該做什麼」）
}

// ProbeWorkersAI 探測指定實例是否支援雲端萃取。
//
// 手法：送一個**刻意留空 text** 的請求。
//   - 舊版實例沒有這條 route ⇒ 404 ⇒ 還沒通。
//   - 新版實例有 route，會因為 text 是空的回 400（參數錯）——但 400 正好證明**route 存在**
//     ⇒ 算通。這樣探測不會真的燒 LLM 額度，也不會產生垃圾卡片。
//   - 401 代表 route 在、只是金鑰不對 ⇒ route 存在，同樣算「雲端有這功能」，
//     金鑰問題由既有的連線流程去報，不混在這裡講。
func ProbeWorkersAI(cypherURL, apiKey string) CloudAIState {
	base := strings.TrimSuffix(strings.TrimSpace(cypherURL), "/")
	if base == "" {
		return CloudAIState{Ready: false, Note: "還沒連上知識庫"}
	}

	body, _ := json.Marshal(map[string]string{"page_name": "", "text": ""})
	req, err := http.NewRequest(http.MethodPost, base+"/portal/daemon/extract", bytes.NewReader(body))
	if err != nil {
		return CloudAIState{Ready: false, Note: "雲端 AI 狀態查不到"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Arcrun-API-Key", strings.TrimSpace(apiKey))

	resp, err := probeHTTP.Do(req)
	if err != nil {
		// 連不上（離線／網路問題）≠ 雲端沒裝。講「查不到」而不是「還沒通」，
		// 免得把網路問題誤報成「你沒更新」讓用戶白跑一趟。
		return CloudAIState{Ready: false, Note: "連不上你的知識庫，雲端 AI 狀態查不到"}
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return CloudAIState{
			Ready: false,
			Note:  "雲端 AI 還沒通 ⇒ 你的知識庫是舊版，請到 portal 按「立即更新」重裝一次",
		}
	case resp.StatusCode < 500:
		// 200/400/401… 都代表這條 route 存在＝雲端有這個功能。
		return CloudAIState{Ready: true}
	default:
		return CloudAIState{
			Ready: false,
			Note:  fmt.Sprintf("雲端 AI 暫時有狀況（HTTP %d），稍後會自動再試", resp.StatusCode),
		}
	}
}
