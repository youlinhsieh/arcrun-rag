// quota_meter_links_test.go — 「今天的用量」那張卡上的兩顆按鈕，按下去要真的有東西
// （`inkstone/arcrun-rag#209` 驗收條件：「付費那條路**點得下去**，不是一句『可以升級』」）。
//
// 🔴 為什麼這支測試存在：那兩顆按鈕連到的是 `rag.arcrun.dev/docs/use/quota/`，
// 而其中一顆還帶了**錨點**（`#怎麼升級四步` 的百分比編碼）。錨點失效的方式是
// **無聲的**——使用者按下去，頁面開了，只是停在最上面，而沒有任何人會發現。
// 這跟 `#104` 那個「蓋了已送達的章、雲端其實沒有」是同一個形狀：
// **成功的樣子與失敗的樣子長得一模一樣。**
//
// 所以這裡把「按鈕指的東西」與「文件裡真的有的東西」綁在一起：
// 有人改了那份 md 的標題、或把那一頁刪掉、或改了網址，這支測試當場紅。
//
// 它**不連網**（連了也沒用：那一頁要部署之後才存在）。它比對的是這個 repo 裡的原始檔。
package main

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// quotaDocPath＝那一頁的原始檔（docs-site 用 Starlight，網址由檔案路徑決定：
// `src/content/docs/use/quota.md` → `/docs/use/quota/`）。
const quotaDocPath = "../../../docs-site/src/content/docs/use/quota.md"

// slugify 照 github-slugger 的規則把標題轉成 Starlight 產的 id。
//
// 🔴 這裡只實作**實際用到的那一小段規則**（去掉標點、空白換連字號、轉小寫），
// 不是重寫一份 slugger。**它的正確性不是靠這段程式碼保證的**——編碼後的值當初是從
// `docs-site npm run build` 真的建出來的 `dist/use/quota/index.html` 抓下來的。
// 這段只負責「標題還在不在、還是不是同一串」。
func slugify(heading string) string {
	s := strings.ToLower(strings.TrimSpace(heading))
	s = regexp.MustCompile(`[^\p{L}\p{N}\p{M}\- ]`).ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, " ", "-")
	return s
}

// mainJS 讀前端原始檔（按鈕的網址寫在那裡，不是在 Go 這邊）。
func mainJS(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("frontend", "src", "main.js"))
	if err != nil {
		t.Fatalf("讀不到前端原始檔：%v", err)
	}
	return string(b)
}

func TestQuotaMeterButtonsPointAtSomethingReal(t *testing.T) {
	js := mainJS(t)

	// ① 兩顆按鈕都要在（少一顆＝票上「付費那條路點得下去」那一格沒兌現）。
	for _, label := range []string{"怎麼升級付費", "額度怎麼算"} {
		if !strings.Contains(js, label) {
			t.Fatalf("「今天的用量」那張卡少了「%s」那顆按鈕", label)
		}
	}

	// ② 把卡上所有 quota 文件連結挖出來。
	re := regexp.MustCompile(`data-openurl="(https://rag\.arcrun\.dev/docs/use/quota/[^"]*)"`)
	found := re.FindAllStringSubmatch(js, -1)
	if len(found) != 2 {
		t.Fatalf("該有兩條指向額度說明頁的連結，找到 %d 條", len(found))
	}

	doc, err := os.ReadFile(quotaDocPath)
	if err != nil {
		t.Fatalf("額度說明頁的原始檔不見了（%s）——那兩顆按鈕會按到 404：%v", quotaDocPath, err)
	}
	// 標題 → slug，做成一張表。
	headings := map[string]string{}
	for _, line := range strings.Split(string(doc), "\n") {
		if m := regexp.MustCompile(`^#{2,6}\s+(.+?)\s*$`).FindStringSubmatch(line); m != nil {
			headings[slugify(m[1])] = m[1]
		}
	}
	if len(headings) == 0 {
		t.Fatal("那一頁一個標題都沒有——錨點必然失效")
	}

	var anchored int
	for _, m := range found {
		u, perr := url.Parse(m[1])
		if perr != nil {
			t.Fatalf("按鈕上的網址解不開：%q（%v）", m[1], perr)
		}
		if u.Fragment == "" {
			continue // 「額度怎麼算」那顆指整頁，沒有錨點是對的
		}
		anchored++
		// url.Parse 會把 %E6%80%8E… 解回中文，正好拿來跟原始標題比。
		if _, ok := headings[u.Fragment]; !ok {
			have := make([]string, 0, len(headings))
			for slug := range headings {
				have = append(have, slug)
			}
			t.Fatalf("「怎麼升級付費」指向的錨點 #%s 在那一頁找不到——"+
				"按下去只會停在頁首，而且不會有任何錯誤。那一頁現在的標題是：%v",
				u.Fragment, have)
		}
	}
	if anchored != 1 {
		t.Fatalf("該剛好有一顆按鈕帶錨點（直接跳到升級步驟），得 %d 顆", anchored)
	}
}

// 升級步驟那一段要真的是**步驟**，不是一句「可以升級」——票面紅線的字面意思。
func TestQuotaDocActuallyTellsYouHowToUpgrade(t *testing.T) {
	doc, err := os.ReadFile(quotaDocPath)
	if err != nil {
		t.Fatalf("讀不到額度說明頁：%v", err)
	}
	body := string(doc)
	for _, want := range []string{
		"dash.cloudflare.com", // 後台入口（點得下去的那條路）
		"Workers & Pages",     // 到了後台之後往哪裡點
		"Workers Paid",        // 要選哪個方案
	} {
		if !strings.Contains(body, want) {
			t.Errorf("升級步驟裡少了「%s」——少了它使用者到了後台還是不知道要點哪裡", want)
		}
	}
	// 🔴 **不准把 Cloudflare 的超量費率抄一份進來**：抄過來的版本遲早過期，
	// 而過期的價目表比沒有更糟（它看起來像事實）。底價 5 美元有查證過，可以寫。
	if !strings.Contains(body, "5 美元") {
		t.Error("底價那個數字（查證過的）不見了")
	}
}
