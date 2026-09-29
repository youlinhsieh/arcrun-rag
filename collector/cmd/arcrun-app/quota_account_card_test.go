// quota_account_card_test.go — inkstone/arcrun-rag#207：前端那張「額度爆了」的卡
// 真的把 q.account 畫出來，而且只在看守超過一台知識庫時才講（單一帳號的人不用被多告訴一件事）。
//
// 這個 repo 的前端沒有 JS 測試框架（package.json 只有 vite build/dev/preview），
// 沿用 quota_meter_links_test.go 已經立下的做法：直接讀 main.js 原始檔做字串比對，
// 釘住「這行邏輯還在」而不是「畫面長什麼樣」。
package main

import (
	"strings"
	"testing"
)

func TestCardQuotaShowsWhichAccountWhenMultiAccount(t *testing.T) {
	js := mainJS(t)

	// ① 呼叫端要把 accounts 傳進去，不然 cardQuota 拿不到「看守幾台」的資訊。
	if !strings.Contains(js, "cardQuota(s.quota, s.progress, s.accounts)") {
		t.Fatal("pageHome 呼叫 cardQuota 時要多傳 s.accounts，不然函式裡判斷不了是不是多帳號")
	}

	// ② 函式簽章要收得到 accounts 參數。
	if !strings.Contains(js, "function cardQuota(q, p, accounts)") {
		t.Fatal("cardQuota 的簽章要加上 accounts 參數")
	}

	// ③ 只有多帳號才講「爆的是哪一台」——單帳號的人不該被多丟一句沒意義的話。
	if !strings.Contains(js, "accounts.length > 1") {
		t.Fatal("cardQuota 裡要有「是不是看守超過一台」的判斷，不然單帳號的人也會看到帳號那一行")
	}
	if !strings.Contains(js, "q.account") {
		t.Fatal("cardQuota 裡要讀後端給的 q.account，不然帳號識別根本沒被用到")
	}

	// ④ 兩個分支（D1 額度／舊制 Workers AI 額度）都要把這一行插進卡片，不能只顧一種——
	//    兩個分支的回傳樣板裡各自都要出現 ${account} 這個插槽。
	if got := strings.Count(js, "${account}"); got < 2 {
		t.Fatalf("cardQuota 兩個分支（d1_read/d1_write 與舊制）都要放帳號那一行，"+
			"只找到 %d 處 ${account}", got)
	}
}
