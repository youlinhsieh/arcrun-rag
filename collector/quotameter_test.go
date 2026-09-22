// quotameter_test.go — 常駐用量表的算式（`inkstone/arcrun-rag#209`）。
//
// 這支檔守的是票上那幾條**紅線**，不是「函式有沒有回東西」：
//
//	① 「每卡幾列」不准寫死在 daemon 裡（`inkstone/InkStoneCo#143`）
//	   ⇒ 測法：把雲端報的數字換掉，天數必須跟著變；雲端不報，就說算不出來。
//	② 讀取與寫入不准混成一個數字
//	   ⇒ 測法：寫入撞頂時，讀取那一格不准跟著變紅。
//	③ 那個天數每天要會動（第 2 天顯示 2/5，不是一直停在 1/5）
//	   ⇒ 測法：待送卡數照一天的量往下減，BatchDayNo 必須往前走。
//	④ 一份檔不等於一張卡（檔數 ＋ 目錄數 ＋ 1）
package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var meterNow = time.Date(2026, 9, 21, 3, 0, 0, 0, time.UTC)

// gen12 ＝資料層第 12 代雲端會報的那一組（`kbdb/src/actions/schema-generation.ts`，
// 由 `kbdb/tests/card-rows-written-gate.test.ts` 現場量出 732／現場對帳）。
func gen12() *WriteCost {
	return &WriteCost{RowsPerCard: 732, FreeDailyRows: 100_000, Generation: 12, MeasuredBy: "gate"}
}

// gen11 ＝同一張卡在第 11 代的價錢。**同一個月內它從 1,156 變成 732**——
// 這正是「不准寫死」的理由，所以測試裡兩代都要在。
func gen11() *WriteCost {
	return &WriteCost{RowsPerCard: 1156, FreeDailyRows: 100_000, Generation: 11, MeasuredBy: "gate"}
}

// ── ① 每卡幾列不是寫死的：換一組雲端回報，天數要跟著變 ──────────────────────
func TestMeterDaysFollowCloudReportedCost(t *testing.T) {
	// 1,100 張卡（≈1,000 檔的資料夾，見 CardCount 註解）。
	total := CardCount{Files: 1000, Folders: 99, Roots: 1}
	in := meterInput{Cost: gen12(), Pending: total, Total: total, Now: meterNow}

	newGen := buildQuotaMeter(in)
	in.Cost = gen11()
	oldGen := buildQuotaMeter(in)

	if !newGen.BatchKnown || !oldGen.BatchKnown {
		t.Fatalf("兩邊都該算得出來：new=%v old=%v", newGen.BatchKnown, oldGen.BatchKnown)
	}
	// 100000/732 = 136 張／天 ⇒ ceil(1100/136) = 9 天
	if newGen.BatchTotalDays != 9 {
		t.Errorf("第 12 代：1100 張卡應為 9 天，得 %d（一天 %d 張）", newGen.BatchTotalDays, newGen.BatchCardsPerDay)
	}
	// 100000/1156 = 86 張／天 ⇒ ceil(1100/86) = 13 天
	if oldGen.BatchTotalDays != 13 {
		t.Errorf("第 11 代：1100 張卡應為 13 天，得 %d（一天 %d 張）", oldGen.BatchTotalDays, oldGen.BatchCardsPerDay)
	}
	if newGen.BatchTotalDays == oldGen.BatchTotalDays {
		t.Fatal("兩代算出同樣的天數＝那個數字根本沒跟著雲端走，紅線①破了")
	}
}

// ── ① 的另一半：雲端沒報就說算不出來，不編一個數字 ───────────────────────────
func TestMeterSaysUnknownWhenCloudDidNotReport(t *testing.T) {
	total := CardCount{Files: 500, Folders: 30, Roots: 1}
	for name, cost := range map[string]*WriteCost{
		"舊版雲端沒有這一格": nil,
		"報了但值是 0":   {RowsPerCard: 0, FreeDailyRows: 100_000},
		"報了但上限是 0":  {RowsPerCard: 732, FreeDailyRows: 0},
	} {
		m := buildQuotaMeter(meterInput{Cost: cost, Pending: total, Total: total, Now: meterNow})
		if m.WriteKnown {
			t.Errorf("%s：不該宣稱算得出來", name)
		}
		if m.BatchKnown || m.BatchTotalDays != 0 {
			t.Errorf("%s：不該給天數，得 known=%v days=%d", name, m.BatchKnown, m.BatchTotalDays)
		}
		if m.WriteNote == "" || m.BatchNote == "" {
			t.Errorf("%s：算不出來就要講為什麼（write=%q batch=%q）", name, m.WriteNote, m.BatchNote)
		}
		if m.WriteUsageLine() != "" || m.BatchProgressLine() != "" {
			t.Errorf("%s：算不出來卻印出了數字：%q／%q", name, m.WriteUsageLine(), m.BatchProgressLine())
		}
	}
}

// ── ② 讀取與寫入不准混 ──────────────────────────────────────────────────
func TestMeterKeepsReadAndWriteApart(t *testing.T) {
	total := CardCount{Files: 200, Folders: 10, Roots: 1}
	// 寫入爆了、讀取沒事：讀取那一格不准跟著變紅。
	m := buildQuotaMeter(meterInput{
		Cost: gen12(), CardsToday: 130, Pending: total, Total: total,
		WriteExhausted: true, Now: meterNow,
	})
	if !m.WriteExhausted {
		t.Fatal("寫入該是爆的")
	}
	if m.ReadExhausted {
		t.Fatal("寫入爆了不代表讀取爆了——這正是 leo 要用戶看到的那件事")
	}
	if m.ReadLimitRows != d1FreeRowsReadPerDay {
		t.Errorf("讀取上限要照 Cloudflare 公開值，得 %d", m.ReadLimitRows)
	}
	if m.ReadLimitRows == m.WriteLimitRows {
		t.Fatal("讀寫上限被混成同一個數字了")
	}
	// 反過來：讀取爆了不該讓寫入那一格變成滿的。
	m2 := buildQuotaMeter(meterInput{
		Cost: gen12(), CardsToday: 10, Pending: total, Total: total,
		ReadExhausted: true, Now: meterNow,
	})
	if m2.WriteExhausted {
		t.Fatal("讀取爆了不代表寫入爆了")
	}
	if m2.WriteUsedRows != 10*732 {
		t.Errorf("寫入已用該是自己數的 10 張卡，得 %d", m2.WriteUsedRows)
	}
}

// 雲端說寫入爆了，但本機只數到一點點卡——以雲端為準，不要顯示「才用了 7%」。
// （雲端自己也會寫東西：背景補索引、藏書地圖計數。）
func TestMeterTrustsCloudWhenItSaysWriteIsExhausted(t *testing.T) {
	total := CardCount{Files: 50, Folders: 5, Roots: 1}
	m := buildQuotaMeter(meterInput{
		Cost: gen12(), CardsToday: 10, Pending: total, Total: total,
		WriteExhausted: true, Now: meterNow,
	})
	if m.WriteUsedRows != m.WriteLimitRows {
		t.Errorf("雲端說爆了，畫面就該是滿的，得 %d/%d", m.WriteUsedRows, m.WriteLimitRows)
	}
	if m.WriteNote == "" {
		t.Error("把數字推到滿的同時要講出為什麼，不然那個數字是假的")
	}
}

// 本機數到的卡比上限還多時也要夾住——進度條不准超過 100%。
func TestMeterClampsUsageToLimit(t *testing.T) {
	m := buildQuotaMeter(meterInput{Cost: gen12(), CardsToday: 9999, Now: meterNow})
	if m.WriteUsedRows != m.WriteLimitRows {
		t.Errorf("已用不該超過上限，得 %d/%d", m.WriteUsedRows, m.WriteLimitRows)
	}
}

// ── ③ 那個天數每天要會動 ────────────────────────────────────────────────
func TestMeterProgressAdvancesEachDay(t *testing.T) {
	total := CardCount{Files: 500, Folders: 49, Roots: 1} // 550 張
	perDay := gen12().cardsPerDay()                       // 136
	var got []string
	pending := total
	for day := 0; day < 5 && pending.Total() > 0; day++ {
		m := buildQuotaMeter(meterInput{Cost: gen12(), Pending: pending, Total: total, Now: meterNow})
		if !m.BatchKnown {
			t.Fatalf("第 %d 天算不出來", day+1)
		}
		got = append(got, m.BatchProgressLine())
		// 過一天＝送掉一天的量
		pending.Files -= perDay
		if pending.Files < 0 {
			pending.Folders += pending.Files
			pending.Files = 0
		}
		if pending.Folders < 0 {
			pending.Folders = 0
		}
	}
	want := []string{"1/5", "2/5", "3/5", "4/5", "5/5"}
	if len(got) != len(want) {
		t.Fatalf("該走完 %d 天，得 %v", len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 天應顯示 %s，得 %s（全部：%v）", i+1, want[i], got[i], got)
		}
	}
}

// 排隊清空之後不再畫進度條（沒事就別佔版面，同 buildSkipped 的慣例）。
func TestMeterHidesBatchWhenNothingPending(t *testing.T) {
	m := buildQuotaMeter(meterInput{
		Cost: gen12(), CardsToday: 12,
		Total: CardCount{Files: 12, Roots: 1}, Pending: CardCount{}, Now: meterNow,
	})
	if m.BatchKnown {
		t.Error("沒有排隊中的東西就不該有進度條")
	}
	if !m.WriteKnown {
		t.Error("用量那一半照樣要看得到——它是常駐的，不是只有排隊時才出現")
	}
	if m.WriteUsageLine() != "8784/100000" {
		t.Errorf("用量那一行的形狀要照 leo 指名的 `90332/100000`，得 %q", m.WriteUsageLine())
	}
}

// ── ④ 一份檔不等於一張卡 ────────────────────────────────────────────────
func TestCardCountIsFilesPlusFoldersPlusOne(t *testing.T) {
	// `inkstone/InkStoneCo#143` 工人端到端實測：1 資料夾 ＋ 3 檔 ⇒ 4 張卡。
	c := CardCount{Files: 3, Folders: 0, Roots: 1}
	if c.Total() != 4 {
		t.Errorf("1 資料夾＋3 檔應為 4 張卡，得 %d", c.Total())
	}
	// 拿檔數當卡數會低估天數——這一格就是把那個低估釘死。
	files := CardCount{Files: 1000, Roots: 0}
	withFolders := CardCount{Files: 1000, Folders: 99, Roots: 1}
	byFiles := buildQuotaMeter(meterInput{Cost: gen12(), Pending: files, Total: files, Now: meterNow})
	byCards := buildQuotaMeter(meterInput{Cost: gen12(), Pending: withFolders, Total: withFolders, Now: meterNow})
	if byCards.BatchTotalDays <= byFiles.BatchTotalDays {
		t.Errorf("算進資料夾卡之後天數應該更長：檔 %d 天 vs 卡 %d 天",
			byFiles.BatchTotalDays, byCards.BatchTotalDays)
	}
}

// ── 從 /health 收下雲端報的數字 ─────────────────────────────────────────
func TestWriteCostFromHealth(t *testing.T) {
	good := []byte(`{"ok":true,"bundle_version":"1.4.73","data_layer":{"ok":true,
	  "actual_generation":12,"write_cost":{"rows_per_card":732,"free_daily_rows":100000,
	  "generation":12,"measured_by":"kbdb/tests/card-rows-written-gate.test.ts"}}}`)
	c := writeCostFromHealth(good)
	if c == nil || c.RowsPerCard != 732 || c.FreeDailyRows != 100_000 || c.Generation != 12 {
		t.Fatalf("該收得到雲端報的那一組，得 %+v", c)
	}

	// 認不出來的一律回 nil——**不編故事**（同 d1QuotaFromHealth 的自我約束）。
	for name, body := range map[string]string{
		"舊版雲端（沒有 data_layer）": `{"ok":true,"bundle_version":"1.4.46"}`,
		"有 data_layer 但沒這一格":  `{"data_layer":{"ok":true,"actual_generation":10}}`,
		"那一代沒人量過（值是 0）":       `{"data_layer":{"write_cost":{"rows_per_card":0,"free_daily_rows":100000}}}`,
		"根本不是 JSON":           `<html>502</html>`,
		"空的":                  ``,
	} {
		if got := writeCostFromHealth([]byte(body)); got != nil {
			t.Errorf("%s：該回 nil，得 %+v", name, got)
		}
	}
}

// 連不上的那一輪不准把上一次問到的答案清掉——「一張卡幾列」是那台資料層的性質，
// 不會因為這次沒連上就變了（同 cloud_version.go 對版本號的處理）。
func TestKnownWriteCostSurvivesAMissedRound(t *testing.T) {
	resetWriteCost()
	defer resetWriteCost()
	const url = "https://arcrun-cypher-executor.example.workers.dev"

	if knownWriteCost(url) != nil {
		t.Fatal("一開始不該有東西")
	}
	noteWriteCost(url, gen12())
	noteWriteCost(url, nil) // 這一輪沒問到
	got := knownWriteCost(url)
	if got == nil || got.RowsPerCard != 732 {
		t.Fatalf("上一次問到的答案該留著，得 %+v", got)
	}
	// 真的換了（升級／降級）下一次連上就蓋掉。
	noteWriteCost(url, gen11())
	if got = knownWriteCost(url); got == nil || got.RowsPerCard != 1156 {
		t.Fatalf("雲端報了新的就該換掉，得 %+v", got)
	}
}

// ── 多帳號：挑最吃緊的那一台，不是把兩台加起來 ───────────────────────────────
func TestPickQuotaMeterPrefersTheAccountThatIsStuck(t *testing.T) {
	writeBlown := QuotaNotice{Kind: QuotaKindD1Write, ResumeAt: meterNow.Add(time.Hour).Format(time.RFC3339)}
	details := map[string]AccountSyncStatus{
		"aaa.workers.dev": {WriteCost: gen12(), CardsSentCount: 5},
		"zzz.workers.dev": {WriteCost: gen12(), CardsSentCount: 130, QuotaMessage: &writeBlown},
	}
	total := CardCount{Files: 500, Folders: 20, Roots: 2}
	m := pickQuotaMeter(details, total, total, meterNow)
	if m == nil {
		t.Fatal("該挑得出一台")
	}
	if m.Account != "zzz.workers.dev" {
		t.Errorf("該挑撞頂的那一台（使用者卡住的就是它），得 %q", m.Account)
	}
	if !m.WriteExhausted {
		t.Error("挑到撞頂的那台，畫面就要講它撞頂了")
	}
	// 一台都沒設定好 ⇒ 不畫這張卡。
	if pickQuotaMeter(map[string]AccountSyncStatus{}, total, total, meterNow) != nil {
		t.Error("沒有帳號時不該畫卡")
	}
}

// 兩台都正常時，挑法要是**確定的**——同一份輸入永遠同一個輸出，畫面才不會自己跳動。
func TestPickQuotaMeterIsDeterministic(t *testing.T) {
	details := map[string]AccountSyncStatus{
		"aaa.workers.dev": {WriteCost: gen12(), CardsSentCount: 40},
		"bbb.workers.dev": {WriteCost: gen12(), CardsSentCount: 7},
		"ccc.workers.dev": {WriteCost: gen12(), CardsSentCount: 40},
	}
	total := CardCount{Files: 100, Roots: 3}
	first := pickQuotaMeter(details, total, total, meterNow)
	for i := 0; i < 30; i++ {
		got := pickQuotaMeter(details, total, total, meterNow)
		if got.Account != first.Account {
			t.Fatalf("挑法會跳：第一次 %q、第 %d 次 %q", first.Account, i, got.Account)
		}
	}
}

// 🔴 跨 repo 的契約：這份治具**不是手打的**，是從 `inkstone/Arcrun` 那半真的跑出來的。
//
// 產生方式：在 `Arcrun/kbdb` 套完全部 migration、呼叫 `/health`，把回應的 `data_layer`
// 原封套進 cypher-executor 的外殼（`cypher-executor/src/routes/health.ts` 就是這樣端出去的，
// 它不重組那個區塊，所以 kbdb 多報的欄位會原樣穿過去）。
//
// 為什麼要有這一格：那半在別的 repo、別的語言、別的測試框架裡。
// 兩邊各自綠、合起來對不上，是這條線上出過最多次的病——
// 而它的樣子是**沒有任何錯誤訊息**，只是小幫手上那張卡永遠寫「算不出用量」。
func TestWriteCostParsesTheRealCloudResponse(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "cypher-health-gen12.json"))
	if err != nil {
		t.Fatalf("讀不到治具：%v", err)
	}
	c := writeCostFromHealth(body)
	if c == nil {
		t.Fatal("雲端真的送了 write_cost，這邊卻讀不出來——兩邊的欄位名對不上")
	}
	if c.RowsPerCard != 732 || c.FreeDailyRows != 100_000 || c.Generation != 12 {
		t.Fatalf("解出來的值跟雲端送的不一樣：%+v", c)
	}
	if c.MeasuredBy == "" {
		t.Error("出處那一格掉了——拿到這個數字的人要追得回去它是誰量的")
	}
	// 同一份回應照舊拿得到版本號（`fetchBundleVersion` 用的是同一份 body，
	// 不准為了新增這一格而弄壞既有那一格）。
	var payload struct {
		BundleVersion string `json:"bundle_version"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.BundleVersion != "1.4.73" {
		t.Errorf("同一份回應該照舊讀得到 bundle_version，得 %q（err=%v）", payload.BundleVersion, err)
	}
	// 接上算式：這一組進去，天數要算得出來。
	total := CardCount{Files: 500, Folders: 49, Roots: 1}
	m := buildQuotaMeter(meterInput{Cost: c, Pending: total, Total: total, Now: meterNow})
	if !m.BatchKnown || m.BatchTotalDays != 5 {
		t.Errorf("550 張卡、一天 136 張 ⇒ 該是 5 天，得 known=%v days=%d", m.BatchKnown, m.BatchTotalDays)
	}
}
