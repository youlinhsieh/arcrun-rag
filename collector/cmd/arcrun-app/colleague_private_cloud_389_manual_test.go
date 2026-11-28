package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// 手動實測（inkstone/arcrun-rag#389）：大前同仁用公司發的「一般帳號」在小幫手連上公司那台私有雲、
// 問答、逛知識卡、開出處看整張卡。
//
//	ARCRUN_PRIVATE_CLOUD_URL=http://<公司那台>:8080 ARCRUN_PRIVATE_CLOUD_EMAIL=… ARCRUN_PRIVATE_CLOUD_PASSWORD=… \
//	ARCRUN_389_QUESTIONS='145-0010 是什麼錯誤|140-0002 是什麼錯誤' ARCRUN_389_WANT_LIBS=error_codes \
//	  go test -run ColleagueLive -v ./cmd/arcrun-app
//
// 與 App 在畫面上按的是同一批方法（Connect → AskLibraries → ListCardLibraries → ListLibraryCards → GetLibraryCard），
// 只是不經視窗。ARCRUN_389_DUMP=<路徑> 會把每一步的回傳 JSON 寫出來當證據。
func TestColleagueLive(t *testing.T) {
	url := os.Getenv("ARCRUN_PRIVATE_CLOUD_URL")
	if url == "" {
		t.Skip("未設 ARCRUN_PRIVATE_CLOUD_URL，略過（手動實測）")
	}
	tempHome(t)
	app := &App{}
	if err := app.Connect(url, os.Getenv("ARCRUN_PRIVATE_CLOUD_EMAIL"), os.Getenv("ARCRUN_PRIVATE_CLOUD_PASSWORD")); err != nil {
		t.Fatalf("連線失敗：%v", err)
	}
	cfg, _ := loadCfg()
	a := cfg.Accounts[0]
	t.Logf("連線成功：cypher_url=%s 同步憑證有=%v", a.CypherURL, syncKey(a) != "")
	if syncKey(a) == "" {
		t.Fatalf("連線後沒有同步憑證（kbdb_key），問答與看卡都進不去")
	}
	dump := map[string]any{}
	libs := app.ListCardLibraries(0)
	dump["libs"] = libs
	names := []string{}
	for _, l := range libs.Libraries {
		names = append(names, l.Name)
	}
	t.Logf("這個帳號看得到的庫：%v（error=%q）", names, libs.Error)
	if want := os.Getenv("ARCRUN_389_WANT_LIBS"); want != "" {
		if strings.Join(names, ",") != want {
			t.Errorf("庫清單應為 %q，實際 %q", want, strings.Join(names, ","))
		}
	}
	for qi, q := range strings.Split(os.Getenv("ARCRUN_389_QUESTIONS"), "|") {
		if strings.TrimSpace(q) == "" {
			continue
		}
		r := app.AskLibraries(q, nil)
		dump["ask"+string(rune('0'+qi))] = r
		b, _ := json.MarshalIndent(r, "", " ")
		t.Logf("問「%s」：\n%.2500s", q, b)
		if len(r.Cards) > 0 {
			c := r.Cards[0]
			v := app.GetLibraryCard(c.AccIdx, c.Library, c.PageName)
			dump["card"+string(rune('0'+qi))] = v
			t.Logf("開出處 %s/%s：%d 段，錯誤=%q", c.Library, c.PageName, len(v.Blocks), v.Error)
		}
	}
	if p := os.Getenv("ARCRUN_389_DUMP"); p != "" {
		b, _ := json.MarshalIndent(dump, "", " ")
		_ = os.WriteFile(p, b, 0o600)
	}
}
