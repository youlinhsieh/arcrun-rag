package collector

// sourcerepair_live_test.go — 對**真實實例**跑一次既有資料修復（`inkstone/Arcrun#167`）。
//
// 🔴 為什麼留在 repo 裡而不是用完就丟（同 probe_real_manual_test.go 的理由）：
// 這一票的驗收條件是「**MCP client 問『原文在哪』拿到的答案能不能走到那個檔**」——
// 那不是 fixture 答得出來的。下一個人要重跑存量修復（換機器、換庫、雲端重裝過）
// 就跑這一支，不必再從頭想一次怎麼推。
//
// 預設 skip，不進 CI。它會**真的寫進知識庫**，所以要明講打的是哪個實例：
//
//	LIVE_REPAIR=1 \
//	LIVE_CYPHER=https://arcrun-cypher-executor.youlin-hsieh-dev.workers.dev \
//	LIVE_NS=<namespace> \
//	LIVE_ROOTS="/Users/x/Desktop/youlinhsieh-test1" \
//	# 加 LIVE_FORCE=1 ＝不看本機是不是已經新形，一律重推（雲端被清空、或上一輪中斷過時用）
//	go test -run TestLiveRepairSourceBlocks -v ./
//
// 🔴 紅線：LIVE_CYPHER 只准指測試實例。本測試不讀 config.json（那份含多個帳號，
// 誤跑會打到不該打的實例）——實例位址一律由呼叫者當場指名。

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestLiveRepairSourceBlocks(t *testing.T) {
	if os.Getenv("LIVE_REPAIR") == "" {
		t.Skip("設 LIVE_REPAIR=1 才跑（會真的寫進知識庫）")
	}
	cypher := strings.TrimSpace(os.Getenv("LIVE_CYPHER"))
	ns := strings.TrimSpace(os.Getenv("LIVE_NS"))
	roots := strings.Split(os.Getenv("LIVE_ROOTS"), ",")
	if cypher == "" || ns == "" || len(roots) == 0 {
		t.Fatal("需要 LIVE_CYPHER / LIVE_NS / LIVE_ROOTS")
	}
	if strings.Contains(cypher, "leo21c") {
		t.Fatal("紅線：不准打 leo21c")
	}
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		cfg := &DirectConfig{
			CypherURL: strings.TrimSuffix(cypher, "/"), Namespace: ns, APIKey: ns,
			CardIngestWF: "rag_ingest_card",
			MachineLabel: os.Getenv("LIVE_MACHINE_LABEL"),
			Manifest:     os.Getenv("LIVE_MANIFEST"), // 空＝機器身分不落檔，只在記憶體鑄
		}
		// 用一份**丟棄式**的 Manifest：修復的蓋章不寫進正在跑的 daemon 的帳本，
		// 免得跟它搶同一個檔（daemon 之後自己會再跑一次，重推是取代不是疊加）。
		m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
		res := repairCardSourceBlocks(cfg, root, m, false, os.Getenv("LIVE_FORCE") != "", time.Now())
		if res == nil {
			t.Logf("%s：沒有需要修的卡", root)
			continue
		}
		t.Logf("%s：掃 %d 份、本機重畫 %d 份、重推 %d 份、err=%q",
			root, res.Scanned, res.Rewrote, res.Repushed, res.Err)
		if res.Err != "" {
			t.Errorf("%s 有失敗：%s", root, res.Err)
		}
	}
}
