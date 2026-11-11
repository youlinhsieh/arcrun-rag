// cloudcallerr.go — 打雲端的傳輸錯誤，要講成它「真正是什麼」（inkstone/arcrun-rag#330）。
//
// 病（leo 2026-11-11 Portal 橫幅：「同步小幫手：差 2 件：網路連不上雲端，已連續 9 輪沒有減少」）：
// 萃取（/portal/daemon/extract）與讀圖（/portal/daemon/read-image）這兩條路，**任何**傳輸錯誤都包成
// 「連不上你的知識庫：…」——包括「等不到回應（逾時）」與「連線在中途被切斷（EOF／reset）」。
// 一份 240 頁、一堆圖頁的大 PDF，AI 那一發又慢又長，被切斷或逾時是常態；而下游
// （StallReason／ledgerReasonKind）把「連不上你的知識庫」一律歸成 network ⇒ 畫面對用戶說
// 「網路連不上雲端」。同一台電腦其他檔都送得上去，那句話是錯的，而且用戶完全沒辦法處理。
//
// 現在照真正的原因分三種講，字串裡仍留著底層原文（舊的字串比對照樣認得）：
//
//	· 這台電腦真的沒連上（DNS 查不到／網路不通／連線被拒）→「連不上你的知識庫：…」（只有這一種才是 network）
//	· 等不到回應（逾時）                                   →「知識庫回得太慢，等不到回應（…）」
//	· 連線在中途被切斷（EOF／reset／斷線）                  →「連線在中途被切斷（…）」＋自癒：丟掉連線池
package collector

import "fmt"

// cloudCallErr 把 http.Client.Do 的錯誤講成它真正是什麼。回 nil 的輸入回 nil。
func cloudCallErr(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case isLocalNetworkErr(err):
		return fmt.Errorf("連不上你的知識庫：%w", err)
	case isStallError(err):
		return fmt.Errorf("知識庫回得太慢，等不到回應（%w）", err)
	}
	// 自癒（不必問用戶、不必等下一輪）：連線被對方在中途切斷，最常見的是連線池裡躺著一條
	// 早就死掉的連線（電腦睡眠醒來、換 Wi-Fi、對方閒置回收）。丟掉它，下一發就會重新建立連線。
	directHTTP.CloseIdleConnections()
	workersAIHTTP.CloseIdleConnections()
	imageReadHTTP.CloseIdleConnections()
	return fmt.Errorf("連線在中途被切斷（%w）", err)
}

// CloudCallErr＝cloudCallErr 的公開版：小幫手畫面那一側自己打雲端時（例如手動實測）也講同一套話。
func CloudCallErr(err error) error { return cloudCallErr(err) }
