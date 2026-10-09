package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"arcrun-rag/collector"
)

// 把「長句版」的真實狀態（額度用完／送不上／讀不了／用量吃緊）餵進 GetState 之後的整形，
// 證明：① 整形前確實超出預算（檢查抓得到舊額度卡）② 整形後全部在預算內。
func longSentenceState() UIState {
	resume := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)
	return UIState{
		StatusBig: "同步中… 正在處理某資料夾",
		Quota: &collector.QuotaNotice{
			Kind:        "d1_write",
			Headline:    "你的雲端知識庫今天的免費寫入額度用完了",
			Usage:       "Cloudflare 免費方案的資料庫寫入上限是每天 10 萬列，今天已經用到上限（這不是小幫手或你的檔案壞掉）",
			Guarantee:   "台北時間明天早上 8:00 恢復，恢復後小幫手會自動接著傳，你不用做任何事",
			ExitOptions: "升級 Cloudflare Workers 付費方案（每月 5 美元起）就沒有每日上限",
			ResumeAt:    resume,
			Account:     "geek6688",
		},
		Accounts: []UIAccount{{
			Name: "geek6688", Host: "h",
			Trouble: &UITrouble{Count: 4, Title: "這個知識庫有 4 份現在送不上去", Detail: "雲端回了 HTTP 500：" + string(make([]rune, 0)) + "database is locked, retry later, many words in this long raw error text that goes on and on and on"},
			Battery: &UIBattery{Percent: 4.1, Level: "crit", Saver: true, Line: "今日剩餘用量 4.1%・小幫手正在省著用",
				Warning: "今日用量只剩 4.1%：小幫手已改成省著用——每次少送一些、放慢節奏、先不做補送"},
		}},
		Skipped: &UISkipped{Title: "有 3 個檔案現在還讀不了", Note: "不用做什麼，之後會自動補上", Files: []string{"a.doc"}, More: 2},
		Stalls:  []UIStall{{Account: "geek6688", Count: 21, Label: "雲端沒有把檔案寫進知識庫", Samples: []string{"a.md"}}},
	}
}

func marshalAny(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func TestTextBudgetCatchesLongSentencesThenCompactPasses(t *testing.T) {
	st := longSentenceState()
	before := budgetViolations(marshalAny(t, st))
	if len(before) < 5 {
		t.Fatalf("預算檢查必須抓得到舊的長句（額度卡、停工、用量警告…），只抓到 %d 筆：%v", len(before), before)
	}
	for _, v := range before {
		t.Log("整形前違規：", v)
	}
	compactUI(&st)
	if after := budgetViolations(marshalAny(t, st)); len(after) != 0 {
		t.Fatalf("整形後仍超出字數預算：\n%v", after)
	}
	if got := st.Quota.Headline; got != "⏸ 寫入額度用完 · 08:00 恢復" {
		t.Fatalf("額度卡標題應為「主體 · 狀態」格式，得到 %q", got)
	}
}

// 真的 GetState（含 status.json 的長句）送出去的字串也必須在預算內：
// 新加任何一個字串欄位，只要超過 25 字或帶句號就會在這裡被擋下。
func TestGetStateStringsWithinBudget(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	s := (&App{}).GetState()
	if v := budgetViolations(marshalAny(t, s)); len(v) != 0 {
		t.Fatalf("GetState 回給前端的字串超出預算：\n%v", v)
	}
}

// 預算數值只有一份（schemas/text-budget.json，小幫手與安裝器的檢查共用）；Go 常數必須與它一致。
func TestTextBudgetMatchesSharedSpec(t *testing.T) {
	b, err := os.ReadFile("../../../schemas/text-budget.json")
	if err != nil {
		t.Fatalf("讀不到共用預算檔：%v", err)
	}
	var spec struct {
		Title, Hover, DetailLines, DetailLineChars int
	}
	var raw map[string]any
	_ = json.Unmarshal(b, &raw)
	spec.Title, spec.Hover = int(raw["title"].(float64)), int(raw["hover"].(float64))
	spec.DetailLines, spec.DetailLineChars = int(raw["detailLines"].(float64)), int(raw["detailLineChars"].(float64))
	if spec.Title != budgetTitle || spec.Hover != budgetHover || spec.DetailLines*spec.DetailLineChars != budgetDetail {
		t.Fatalf("Go 預算常數與 schemas/text-budget.json 不一致：%+v", spec)
	}
	if budgetCount("⏸ 額度用完 · 08:00 恢復 · 排隊 8717") != 18 {
		t.Fatal("計字規則應與共用規格的範例一致（18）")
	}
}
