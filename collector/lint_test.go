// lint_test.go — B2 品質檢查驗收（施工順序步驟 4：拿草案 §1 列的真樣本跑一遍，
// 通過/不過與草案標註一致）。分級依 §6 裁決 T4-C：H1/H2/H5 硬、H3/H4/H6 軟。
package collector

import (
	"strings"
	"testing"
)

// 草案 §1 H1/H2/H3/H4 通過真例：琥珀計時沙漏卡（四段齊、定義一行、要點 4 條、關聯端點閉合）。
const amberCard = `# 琥珀計時沙漏說明
## 一句話定義
琥珀計時沙漏是托盤真機驗收用的計時道具，翻轉一次計時 7 分 24 秒，內含蜂蜜結晶作沙粒。
## 要點
- 翻轉一次計時 7 分 24 秒
- 內含蜂蜜結晶作為沙粒
- 專用於托盤真機驗收流程
- 外殼為琥珀色樹脂
## 關鍵實體
- **琥珀計時沙漏** — 驗收用計時道具
- **托盤真機驗收** — 使用此道具的場景
## 關聯
- 琥珀計時沙漏 >> 用於 >> 托盤真機驗收
- 托盤真機驗收 >> 使用 >> 琥珀計時沙漏
- 琥珀計時沙漏 >> 屬於 >> 托盤真機驗收
`

func hasCode(fs []LintFinding, code string) bool {
	for _, f := range fs {
		if f.Code == code {
			return true
		}
	}
	return false
}

// H1/H2/H3/H4/H5 全過的好卡（無原稿＝跳過 H6）＝零 finding。
func TestLintAmberCardClean(t *testing.T) {
	r := LintCard(amberCard, LintOptions{})
	if len(r.Hard) != 0 || len(r.Soft) != 0 {
		t.Fatalf("琥珀卡應零 finding，得 hard=%v soft=%v", r.HardMessages(), r.SoftMessages())
	}
	if r.Blocks(false) || r.Blocks(true) {
		t.Fatal("好卡不該被擋（strict 亦然）")
	}
}

// 草案 §H3 機檢天花板（真）：ZZ-T7 結構全過但內容無意義——形檢應「放行」（擋形不擋神）。
func TestLintMachineCeilingPassesShape(t *testing.T) {
	card := `# ZZ-T7驗收請忽略
## 一句話定義
這是一張純為驗收而生的無意義測試卡。
## 要點
- 無意義要點甲
- 無意義要點乙
- 無意義要點丙
## 關鍵實體
- **甲** — 無意義實體一
- **乙** — 無意義實體二
## 關聯
- 甲 >> 關聯 >> 乙
- 乙 >> 對應 >> 甲
- 甲 >> 涵蓋 >> 乙
`
	r := LintCard(card, LintOptions{})
	if r.Blocks(false) {
		t.Fatalf("結構完整的卡即使無意義，形檢也應放行；得 hard=%v", r.HardMessages())
	}
}

// 草案 §H1 不過（構造）：缺後兩段 → 硬缺 H1。
func TestLintH1MissingSectionsHard(t *testing.T) {
	card := `# x
## 一句話定義
只有兩段。
## 要點
- 一
- 二
- 三
`
	r := LintCard(card, LintOptions{})
	if !hasCode(r.Hard, "H1") {
		t.Fatalf("缺段名應硬缺 H1，得 hard=%v", r.HardMessages())
	}
	if !r.Blocks(false) {
		t.Fatal("H1 硬缺應擋（非 strict 亦擋）")
	}
}

// H1 段名順序錯（關聯排到要點前）→ 硬缺 H1。
func TestLintH1WrongOrderHard(t *testing.T) {
	card := `# x
## 一句話定義
定義一行。
## 關聯
- 甲 >> 關聯 >> 乙
- 乙 >> 對應 >> 甲
- 甲 >> 涵蓋 >> 乙
## 要點
- 一
- 二
- 三
## 關鍵實體
- **甲** — 說明
- **乙** — 說明
`
	r := LintCard(card, LintOptions{})
	if !hasCode(r.Hard, "H1") {
		t.Fatalf("段名順序錯應硬缺 H1，得 hard=%v", r.HardMessages())
	}
}

// 草案 §H2 不過（構造）：定義三行含背景故事 → 硬缺 H2（那是摘要不是定義）。
func TestLintH2MultiLineHard(t *testing.T) {
	card := `# x
## 一句話定義
第一行背景故事。
第二行還在鋪陳。
第三行才講到重點。
## 要點
- 一
- 二
- 三
## 關鍵實體
- **甲** — 說明
- **乙** — 說明
## 關聯
- 甲 >> 關聯 >> 乙
- 乙 >> 對應 >> 甲
- 甲 >> 涵蓋 >> 乙
`
	r := LintCard(card, LintOptions{})
	if !hasCode(r.Hard, "H2") {
		t.Fatalf("定義多行應硬缺 H2，得 hard=%v", r.HardMessages())
	}
}

// 草案 §H3 不過（構造）：要點只有 2 條 → 軟項 H3（不擋、標 quality:low）。
func TestLintH3TooFewSoft(t *testing.T) {
	card := `# x
## 一句話定義
定義一行。
## 要點
- 只有兩條
- 第二條
## 關鍵實體
- **甲** — 說明
- **乙** — 說明
## 關聯
- 甲 >> 關聯 >> 乙
- 乙 >> 對應 >> 甲
- 甲 >> 涵蓋 >> 乙
`
	r := LintCard(card, LintOptions{})
	if len(r.Hard) != 0 {
		t.Fatalf("要點條數越界應為軟項不硬缺，得 hard=%v", r.HardMessages())
	}
	if !hasCode(r.Soft, "H3") {
		t.Fatalf("要點 2 條應軟項 H3，得 soft=%v", r.SoftMessages())
	}
	if r.Blocks(false) {
		t.Fatal("軟項非 strict 不該擋")
	}
	if !r.Blocks(true) {
		t.Fatal("軟項在 strict 應擋")
	}
}

// 草案 §H4 不過（真，同一張琥珀卡）：`琥珀計時沙漏 >> 每次計時 >> 7 分 24 秒`——
// 受詞不在關鍵實體 → 端點漂移＝軟項 H4（會長孤兒節點）。
func TestLintH4EndpointDriftSoft(t *testing.T) {
	card := `# 琥珀計時沙漏說明
## 一句話定義
琥珀計時沙漏是托盤真機驗收用的計時道具。
## 要點
- 翻轉一次計時 7 分 24 秒
- 內含蜂蜜結晶作為沙粒
- 專用於托盤真機驗收流程
## 關鍵實體
- **琥珀計時沙漏** — 驗收用計時道具
- **托盤真機驗收** — 使用此道具的場景
## 關聯
- 琥珀計時沙漏 >> 用於 >> 托盤真機驗收
- 琥珀計時沙漏 >> 每次計時 >> 7 分 24 秒
- 托盤真機驗收 >> 使用 >> 琥珀計時沙漏
`
	r := LintCard(card, LintOptions{})
	if len(r.Hard) != 0 {
		t.Fatalf("端點漂移應軟項不硬缺，得 hard=%v", r.HardMessages())
	}
	if !hasCode(r.Soft, "H4") {
		t.Fatalf("端點漂移應軟項 H4，得 soft=%v", r.SoftMessages())
	}
	// 訊息須指出漂移的字面值
	if !strings.Contains(strings.Join(r.SoftMessages(), " "), "7 分 24 秒") {
		t.Fatalf("H4 訊息應點名漂移端點，得 %v", r.SoftMessages())
	}
}

// 草案 §H5 不過（構造）：要點含 api_key 賦值 → 硬缺 H5（不得照抄機敏值）。
func TestLintH5SecretHard(t *testing.T) {
	card := `# x
## 一句話定義
定義一行。
## 要點
- 設定範例 api_key: sk-ant-api03-abcdef1234567890
- 第二條要點
- 第三條要點
## 關鍵實體
- **甲** — 說明
- **乙** — 說明
## 關聯
- 甲 >> 關聯 >> 乙
- 乙 >> 對應 >> 甲
- 甲 >> 涵蓋 >> 乙
`
	r := LintCard(card, LintOptions{})
	if !hasCode(r.Hard, "H5") {
		t.Fatalf("含機敏賦值應硬缺 H5，得 hard=%v", r.HardMessages())
	}
	if !r.Blocks(false) {
		t.Fatal("H5 硬缺應擋")
	}
}

// H5 行內豁免：wiki-secret-ok 標記行不觸發（示範格式）。
func TestLintH5ExemptionSkipped(t *testing.T) {
	card := `# x
## 一句話定義
定義一行。
## 要點
- 密碼欄位示範 password: hunter2000000  # wiki-secret-ok
- 第二條要點
- 第三條要點
## 關鍵實體
- **甲** — 說明
- **乙** — 說明
## 關聯
- 甲 >> 關聯 >> 乙
- 乙 >> 對應 >> 甲
- 甲 >> 涵蓋 >> 乙
`
	r := LintCard(card, LintOptions{})
	if hasCode(r.Hard, "H5") {
		t.Fatalf("標記 wiki-secret-ok 的行應豁免，得 hard=%v", r.HardMessages())
	}
}

// 草案 §H6 不過：卡片字數超過 min(4000, 原稿×60%) → 軟項 H6（整段照抄退化路）。
func TestLintH6LengthCapSoft(t *testing.T) {
	src := "很短的原稿"
	r := LintCard(amberCard, LintOptions{Source: src})
	if len(r.Hard) != 0 {
		t.Fatalf("H6 相似度應軟項不硬缺，得 hard=%v", r.HardMessages())
	}
	if !hasCode(r.Soft, "H6") {
		t.Fatalf("卡片遠大於原稿應軟項 H6，得 soft=%v", r.SoftMessages())
	}
}

// H6 8-gram 重疊：卡片要點逐字照抄原稿長句 → 軟項 H6。
func TestLintH6OverlapSoft(t *testing.T) {
	para := "本公司報銷制度規定所有費用申請必須檢附正本單據並於事實發生後三十日內完成核銷否則視同放棄請款權利"
	// 原稿夠長（避免只被長度上限攔到，聚焦 8-gram 重疊路徑）
	src := para + para + "另有各部門專屬補充規定與例外情形處理原則詳見附錄說明文件內容"
	card := "# x\n## 一句話定義\n報銷制度說明。\n## 要點\n- " + para + "\n- 第二條要點內容\n- 第三條要點內容\n" +
		"## 關鍵實體\n- **甲** — 說明\n- **乙** — 說明\n## 關聯\n- 甲 >> 關聯 >> 乙\n- 乙 >> 對應 >> 甲\n- 甲 >> 涵蓋 >> 乙\n"
	r := LintCard(card, LintOptions{Source: src})
	if !hasCode(r.Soft, "H6") {
		t.Fatalf("逐字照抄長句應軟項 H6，得 soft=%v", r.SoftMessages())
	}
}

// 草案 §H6 通過（真）：財富卡改寫＋引用一句，非整段照抄 → 不觸發 H6。
func TestLintH6RewritePasses(t *testing.T) {
	// 真實萃取情境：原稿（一篇 journal 段落）遠長於卡片；卡片是改寫濃縮而非整段照抄。
	src := "今天又想到財富這件事。在我看來，真正的財富從來不是靜止不動的存量數字，而是持續在系統之間流動、" +
		"被不斷創造出來的東西。很多人一輩子盯著帳戶餘額看，餘額多一點就開心、少一點就焦慮，卻完全錯過了" +
		"那些真正產生價值的流動過程。錢放著不動其實一直在貶值，只有讓它流動、投入到能再創造價值的地方，" +
		"才會透過複利慢慢滾大。我認識的那些真正有底氣的人，關注的從來不是我現在有多少，而是我的系統每個月" +
		"能穩定產生多少流動；存量只是流動的殘影，把因果搞反了就會一輩子為數字焦慮。這也是為什麼我一直提醒" +
		"自己，要去建造會生錢的系統，而不是死守一個會被通膨啃食的靜態數字。"
	card := "# 財富是流動非存量\n## 一句話定義\n財富的本質是持續流動與創造，而非帳面存量。\n" +
		"## 要點\n- 財富來自流動與再投資而非囤積\n- 盯著存量會錯過流動產生的複利\n- 價值在系統間流動時才被創造\n" +
		"## 關鍵實體\n- **財富** — 流動中創造的價值\n- **存量** — 靜止的帳面數字\n" +
		"## 關聯\n- 財富 >> 對比 >> 存量\n- 財富 >> 來自 >> 存量\n- 存量 >> 誤導 >> 財富\n"
	r := LintCard(card, LintOptions{Source: src})
	if hasCode(r.Soft, "H6") {
		t.Fatalf("改寫卡不該觸發 H6，得 soft=%v", r.SoftMessages())
	}
}

// scanSecrets 逐項：各類機敏特徵至少一命中，乾淨文字零命中。
func TestScanSecretsPatterns(t *testing.T) {
	cases := map[string]bool{
		"這是一段乾淨的正常內容沒有任何金鑰":                         false,
		"api_key = abcdef123456":                    true,
		"-----BEGIN RSA PRIVATE KEY-----":           true,
		"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345":      true,
		"AKIAABCDEFGHIJKLMNOP":                      true,
		"postgres://user:secretpass@db.example.com": true,
	}
	for text, want := range cases {
		got := len(scanSecrets(text)) > 0
		if got != want {
			t.Errorf("scanSecrets(%q)=%v，want %v（hits=%v）", text, got, want, scanSecrets(text))
		}
	}
}
