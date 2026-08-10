package collector

import "testing"

// TestConnectedDetectionUsesAccounts 釘住 leo 2026-08-06 Windows 實測的假警報：
//
//	畫面說「還沒連上知識庫」，但側邊欄有帳號、庫目錄管理也看得到它的庫。
//	真兇＝只看**根層** cypher_url/api_key，而多帳號設定（現在的常態）根層是空的。
//	開發機不會撞到，因為它的 config 帶著單帳號時代留下的根層欄位。
//
// 這支測試刻意用「**只有 accounts、根層全空**」的設定——也就是全新使用者的形狀。
func TestConnectedDetectionUsesAccounts(t *testing.T) {
	cfg := &DirectConfig{
		Extractor: "workers-ai",
		Accounts: []AccountConfig{{
			CypherURL: "https://example.workers.dev",
			Namespace: "abc123",
			APIKey:    "abc123",
		}},
		// 根層 CypherURL / APIKey 刻意留空
	}
	if !accountsConnected(cfg) {
		t.Fatal("有帳號卻判成沒連線 ⇒ 畫面會誤報「還沒連上知識庫」（leo 撞到的那個）")
	}

	empty := &DirectConfig{Extractor: "workers-ai"}
	if accountsConnected(empty) {
		t.Fatal("完全沒帳號也沒根層設定時，應該判成沒連線")
	}
}
