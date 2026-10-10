package collector

import (
	"fmt"
	"errors"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNumberDiff(t *testing.T) {
	if d := numberDiff("頻段 12.7–14 GHz 共 1,250 列", "頻段 12.7–14 GHz 共 1250 列"); len(d) != 0 {
		t.Errorf("千分位不同不算不一致：%v", d)
	}
	if d := numberDiff("14 – 14.2 GHz", "14 – 14.5 GHz"); len(d) != 2 {
		t.Errorf("數字不同要抓到：%v", d)
	}
	if d := numberDiff("註 1", "註 2"); len(d) != 0 {
		t.Errorf("單一位數不當噪音：%v", d)
	}
}

func fakeReader(a, b string, calls *[]string) ImageReader {
	return func(r ImageReadRequest) (string, error) {
		*calls = append(*calls, r.Pass)
		if len(r.PNG) < 100 || string(r.PNG[1:4]) != "PNG" {
			panic("送出的不是 PNG")
		}
		if r.Pass == ImagePassPrimary {
			return a, nil
		}
		return b, nil
	}
}

func TestReadPDFImages_一致與不一致(t *testing.T) {
	data, err := os.ReadFile(nriPDF)
	if err != nil {
		t.Skip("無 NRI 樣本")
	}
	rep := &PDFReadReport{ImagePageNums: []int{38}, ImageTables: []PDFImageTable{{Caption: "表 1 美國衛星固定通訊頻段", Page: 38}}}

	var calls []string
	res, err := readPDFImages(data, rep, "nri", fakeReader("| 12.7–14 | 聯邦 |", "| 12.7–14 | 聯邦 |", &calls))
	if err != nil || len(res.Reads) != 1 || res.Reads[0].Flagged {
		t.Fatalf("一致應直接入庫：%v %+v", err, res)
	}
	if len(calls) != 2 || calls[0] != "primary" || calls[1] != "check" {
		t.Errorf("每頁應讀兩次（primary、check）：%v", calls)
	}
	if !strings.Contains(res.Text(), "〔PDF 第 38 頁・圖片辨識〕") {
		t.Errorf("缺頁界：%s", res.Text())
	}
	after := rep.afterRead(res)
	if len(after.ImageTables) != 0 {
		t.Error("已讀的表不該再說讀不到")
	}

	calls = nil
	res, _ = readPDFImages(data, rep, "nri", fakeReader("| 14 | 14.2 |", "| 14 | 14.5 |", &calls))
	if !res.Reads[0].Flagged || !strings.Contains(res.Text(), "需人工確認") {
		t.Fatalf("數字不一致必須標需人工確認：%s", res.Text())
	}
	notes := strings.Join(rep.afterRead(res).Notes(), "\n")
	if !strings.Contains(notes, "需人工確認") || !strings.Contains(notes, "第 38 頁") {
		t.Errorf("文件卡說明缺需人工確認：%s", notes)
	}
}

func TestReadPDFImages_舊雲端404退回(t *testing.T) {
	data, err := os.ReadFile(nriPDF)
	if err != nil {
		t.Skip("無 NRI 樣本")
	}
	rep := &PDFReadReport{ImagePageNums: []int{38}, ImageTables: []PDFImageTable{{Caption: "表 1", Page: 38}}}
	_, err = readPDFImages(data, rep, "nri", func(ImageReadRequest) (string, error) { return "", ErrImageReadUnsupported })
	if err != ErrImageReadUnsupported {
		t.Errorf("舊雲端應回 ErrImageReadUnsupported：%v", err)
	}
}

func TestReadPDFImages_超過上限明說(t *testing.T) {
	data, err := os.ReadFile(nriPDF)
	if err != nil {
		t.Skip("無 NRI 樣本")
	}
	var nums []int
	for i := 1; i <= maxImageReadPages+3; i++ {
		nums = append(nums, i)
	}
	res, err := readPDFImages(data, &PDFReadReport{ImagePageNums: nums}, "nri",
		func(ImageReadRequest) (string, error) { return "", nil })
	if err != nil || len(res.Skipped) != 3 {
		t.Fatalf("應有 3 頁超過上限：%v %v", err, res)
	}
	if !strings.Contains(strings.Join(res.Notes(), ""), "尚未讀") {
		t.Error("超過上限要在說明講")
	}
}

// 端到端（假雲端）：真實掃描 PDF 丟進資料夾 → 讀圖 → 萃取收到的原稿含〔圖片辨識〕＋卡片落地。
func TestExtractWithWorkersAI_掃描PDF走讀圖(t *testing.T) {
	scan, err := os.ReadFile(os.ExpandEnv("$HOME/Documents/KB/assets/20230922_095745_1-1.pdf"))
	if err != nil {
		t.Skip("無掃描樣本")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "scan.pdf"), scan, 0o644); err != nil {
		t.Fatal(err)
	}
	var extractedText string
	var reads int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch {
		case strings.HasSuffix(r.URL.Path, "/portal/daemon/read-image"):
			reads++
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": "第一頁內容：金額 12500 元"})
		default:
			extractedText, _ = req["text"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "output": cardFixture("掃描檔", "金額")})
		}
	}))
	defer srv.Close()
	oldRead := imageReadHTTP
	imageReadHTTP = srv.Client()
	defer func() { imageReadHTTP = oldRead }()
	defer extractStub2(t, srv)()

	cards, err := ExtractWithWorkersAI(srv.URL, "k", root, "scan.pdf", testOrigin())
	if err != nil {
		t.Fatalf("掃描檔有讀圖應能萃取：%v", err)
	}
	if len(cards) == 0 || reads < 2 {
		t.Fatalf("cards=%v reads=%d", cards, reads)
	}
	if !strings.Contains(extractedText, "〔PDF 第 1 頁・圖片辨識〕") || !strings.Contains(extractedText, "12500") {
		t.Errorf("萃取收到的原稿缺讀圖文字：%.300s", extractedText)
	}
}

func TestExtractWithWorkersAI_掃描PDF舊雲端仍回ErrNoText(t *testing.T) {
	scan, err := os.ReadFile(os.ExpandEnv("$HOME/Documents/KB/assets/20230922_095745_1-1.pdf"))
	if err != nil {
		t.Skip("無掃描樣本")
	}
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "scan.pdf"), scan, 0o644)
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	oldRead := imageReadHTTP
	imageReadHTTP = srv.Client()
	defer func() { imageReadHTTP = oldRead }()
	_, err = ExtractWithWorkersAI(srv.URL, "k", root, "scan.pdf", testOrigin())
	if err == nil || !isNoTextText(err.Error()) {
		t.Fatalf("舊雲端應維持「讀不出字」：%v", err)
	}
}

// extractStub2：萃取走真的 httptest 伺服器，只把探測換成通。
func extractStub2(t *testing.T, srv *httptest.Server) func() {
	t.Helper()
	old := workersAIHTTP
	workersAIHTTP = srv.Client()
	undo := probeReadyStub(t)
	return func() { workersAIHTTP = old; undo() }
}

func TestShouldRetry_掃描檔病歷在退避窗口後重試(t *testing.T) {
	m := newRetryTestManifest("a.pdf")
	e := m.Entries["a.pdf"]
	e.FailCount, e.NextRetry, e.LastError, e.FailLintRev = MaxFailBeforeSkip, 2000, "本地萃取失敗：轉檔失敗（a.pdf）：檔案裡沒有可抽取的文字", lintGateRevision
	if m.ShouldRetry("a.pdf", 1000, false) {
		t.Fatal("窗口內不該重試")
	}
	if !m.ShouldRetry("a.pdf", 2001, false) {
		t.Fatal("雲端有了讀圖之後，掃描檔病歷要在窗口後自己再試")
	}
}

func TestTrimRepetition(t *testing.T) {
	loop := "1. 吸菸 " + strings.Repeat("吸 [ ] ", 200)
	got, hit := trimRepetition("前面正常\n" + loop)
	if !hit || len([]rune(got)) > 40 || !strings.Contains(got, "前面正常") {
		t.Errorf("重複亂轉要截斷：%d %q", len([]rune(got)), got)
	}
	if got, hit := trimRepetition("正常一行\n| 1 | 2 |\n| - | - |"); hit || got == "" {
		t.Error("表格分隔線不能誤判")
	}
	if _, hit := trimRepetition("a ------------------- b"); !hit {
		// 長分隔線也算重複，但屬無害；只確認不 panic
		t.Log("分隔線未判為重複")
	}
}

func TestReadPDFImages_重複亂轉標需人工確認(t *testing.T) {
	data, err := os.ReadFile(nriPDF)
	if err != nil {
		t.Skip("無 NRI 樣本")
	}
	loop := "表單\n" + strings.Repeat("吸 [ ] ", 300)
	var calls []string
	res, _ := readPDFImages(data, &PDFReadReport{ImagePageNums: []int{38}, ImageTables: []PDFImageTable{{Caption: "表 1", Page: 38}}}, "x", fakeReader(loop, loop, &calls))
	if !res.Reads[0].Flagged || strings.Count(res.Reads[0].Text, "吸") > 10 {
		t.Errorf("應截斷並標需人工確認：%+v", res.Reads[0])
	}
}

func TestReadPDFImages_文字差很多也標需人工確認(t *testing.T) {
	data, err := os.ReadFile(nriPDF)
	if err != nil {
		t.Skip("無 NRI 樣本")
	}
	var calls []string
	res, _ := readPDFImages(data, &PDFReadReport{ImagePageNums: []int{38}, ImageTables: []PDFImageTable{{Caption: "表 1", Page: 38}}}, "x",
		fakeReader("姓名 甲乙丙 性別 男 職稱 工程師 部門 研發", "姓名 丁戊己 性別 女 職稱 會計師 部門 財務", &calls))
	if !res.Reads[0].Flagged {
		t.Error("數字沒有、文字卻大不同，也要標需人工確認")
	}
	res, _ = readPDFImages(data, &PDFReadReport{ImagePageNums: []int{38}, ImageTables: []PDFImageTable{{Caption: "表 1", Page: 38}}}, "x",
		fakeReader("| 表 | 聯邦 | 12.7 |\n| a | 非聯邦 | 14 |", "| 表 | 聯邦 | 12.7 |\n| a | 非聯邦 | 14 |", &calls))
	if res.Reads[0].Flagged {
		t.Error("相同內容不該標")
	}
}

func TestCachedImageReader_同一張圖不重讀且失敗不存(t *testing.T) {
	dir := t.TempDir()
	n := 0
	fail := true
	inner := func(r ImageReadRequest) (string, error) {
		n++
		if fail {
			return "", errors.New("逾時")
		}
		return "讀到的字", nil
	}
	rd := cachedImageReader(dir, inner)
	req := ImageReadRequest{Pass: ImagePassPrimary, PNG: []byte("\x89PNG-same")}
	if _, err := rd(req); err == nil {
		t.Fatal("失敗要回錯")
	}
	fail = false
	if out, err := rd(req); err != nil || out != "讀到的字" {
		t.Fatalf("失敗不該被存：%q %v", out, err)
	}
	before := n
	if out, _ := rd(req); out != "讀到的字" || n != before {
		t.Errorf("第三次應命中快取不打雲端：n=%d before=%d", n, before)
	}
	req.Pass = ImagePassCheck
	rd(req)
	if n != before+1 {
		t.Error("pass 不同要分開存")
	}
}

func TestReadOnceMore_失敗重試一次(t *testing.T) {
	n := 0
	out, err := readOnceMore(func(ImageReadRequest) (string, error) {
		n++
		if n == 1 {
			return "", errors.New("逾時")
		}
		return "ok", nil
	}, ImageReadRequest{})
	if err != nil || out != "ok" || n != 2 {
		t.Errorf("n=%d out=%q err=%v", n, out, err)
	}
	n = 0
	_, err = readOnceMore(func(ImageReadRequest) (string, error) { n++; return "", ErrImageReadUnsupported }, ImageReadRequest{})
	if !errors.Is(err, ErrImageReadUnsupported) || n != 1 {
		t.Errorf("不支援不重試：n=%d", n)
	}
}

func TestReadPDFImages_圖表照片只讀一次_表讀兩次(t *testing.T) {
	data, err := os.ReadFile(nriPDF)
	if err != nil {
		t.Skip("無 NRI 樣本")
	}
	rep := &PDFReadReport{Pages: 240, ImagePageNums: []int{20, 38}, ImageTables: []PDFImageTable{{Caption: "表 1", Page: 38}}}
	var calls []string
	res, err := readPDFImages(data, rep, "nri", func(r ImageReadRequest) (string, error) {
		calls = append(calls, fmt.Sprintf("%d%s", r.Page, r.Pass))
		return "內容 123", nil
	})
	if err != nil || len(res.Reads) != 2 {
		t.Fatalf("%v %v", err, res)
	}
	if strings.Join(calls, ",") != "20primary,38primary,38check" {
		t.Errorf("圖表一次、表兩次：%v", calls)
	}
}
