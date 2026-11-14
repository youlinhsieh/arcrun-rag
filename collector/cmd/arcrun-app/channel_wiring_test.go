package main

// channel_wiring_test.go — 頻道身分真的接到了小幫手每一個「會踩到 prod」的地方（inkstone/arcrun-rag#135）。
//
// 重點兩條：
//  1. 正式版（沒注入頻道）的每個值與 #135 之前逐字相同——prod 使用者行為零改變。
//  2. Stage 版的資料目錄、更新來源、下載來源、托盤標記，沒有任何一個落在 prod 的座標上。

import (
	"bytes"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"arcrun-rag/collector/channel"
)

func TestProdUpdateSourceUnchanged(t *testing.T) {
	p := channel.For("prod")
	if got := strings.SplitN(manifestURLFor(p), "?", 2)[0]; got != "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/manifest.json" {
		t.Fatalf("正式版 manifest 來源變了：%s", got)
	}
	rel := &daemonRelease{Version: "0.18.30"}
	rel.Mac.File, rel.Win.File = "daemon/Arcrun-0.18.30.dmg", "daemon/Arcrun-win-0.18.30.exe"
	if got := strings.SplitN(downloadURLWith(p, false, rel), "?", 2)[0]; got != "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/daemon/Arcrun-0.18.30.dmg" {
		t.Fatalf("正式版 Mac 下載網址變了：%s", got)
	}
	if got := strings.SplitN(downloadURLWith(p, true, rel), "?", 2)[0]; got != "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/daemon/Arcrun-win-0.18.30.exe" {
		t.Fatalf("正式版 Windows 下載網址變了：%s", got)
	}
}

func TestStageUpdateSourceIsYoulinNotProd(t *testing.T) {
	s := channel.For("stage")
	rel := &daemonRelease{Version: "0.18.30"}
	rel.Mac.File, rel.Win.File = "daemon/Arcrun-0.18.30.dmg", "daemon/Arcrun-win-0.18.30.exe"
	m := strings.SplitN(manifestURLFor(s), "?", 2)[0]
	d := strings.SplitN(downloadURLWith(s, false, rel), "?", 2)[0]
	w := strings.SplitN(downloadURLWith(s, true, rel), "?", 2)[0]
	base := "https://arcrun-installer-youlin-stage.arcrun-yuga3bse.workers.dev/dist/"
	if m != base+"manifest.json" || d != base+"daemon/Arcrun-0.18.30.dmg" || w != base+"daemon/Arcrun-win-0.18.30.exe" {
		t.Fatalf("stage 更新來源不對：\n manifest=%s\n mac=%s\n win=%s", m, d, w)
	}
	for _, u := range []string{m, d, w} {
		if strings.Contains(u, "githubusercontent") || strings.Contains(u, "install.arcrun.dev") {
			t.Fatalf("stage 更新來源落在 prod：%s", u)
		}
	}
}

// 讀 manifest 走的是頻道的網址（打到本機假伺服器，證明請求真的發到頻道指定的位置，不是寫死的 prod）。
func TestStageManifestRequestGoesToChannelURL(t *testing.T) {
	var hit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = r.URL.Path
		_, _ = w.Write([]byte(`{"daemon":{"version":"0.18.30"}}`))
	}))
	defer srv.Close()
	ch := channel.For("stage")
	ch.ManifestURL = srv.URL + "/dist/manifest.json"
	resp, err := http.Get(manifestURLFor(ch))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if hit != "/dist/manifest.json" {
		t.Fatalf("請求沒有打到頻道指定的路徑：%q", hit)
	}
}

func TestDataDirsAreSeparate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	p, s := appDirFor(channel.For("prod")), appDirFor(channel.For("stage"))
	if p != filepath.Join(home, ".arcrun-rag") {
		t.Fatalf("正式版資料目錄變了：%s", p)
	}
	if s != filepath.Join(home, ".arcrun-rag-stage") || s == p {
		t.Fatalf("stage 資料目錄不對或與 prod 相同：%s", s)
	}
	// 預設（沒注入）＝正式版：appDir() 與 prod 相同。
	if appDir() != p {
		t.Fatalf("沒注入頻道時 appDir 應為正式版：%s", appDir())
	}
}

func TestTrayLabelOnlyForStage(t *testing.T) {
	if got := trayLabel(channel.For("prod")); got != "" {
		t.Fatalf("正式版選單列不該有文字：%q", got)
	}
	if got := trayLabel(channel.For("stage")); got != " Stage" {
		t.Fatalf("stage 選單列文字：%q", got)
	}
}

func TestStageTrayBadgeChangesCornerPixelsOnly(t *testing.T) {
	src, err := os.ReadFile("build/trayicon.png")
	if err != nil {
		t.Fatal(err)
	}
	out := badgePNG(src, stageBadgeColor)
	a, _ := png.Decode(bytes.NewReader(src))
	b, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("帶標記的圖解不開：%v", err)
	}
	if a.Bounds() != b.Bounds() {
		t.Fatalf("尺寸變了")
	}
	bd := b.Bounds()
	// 右下角中心必須是橘色；左上角（原圖內容）不變。
	r := bd.Dx() * 3 / 10
	cx, cy := bd.Max.X-r-1, bd.Max.Y-r-1
	cr, cg, cb, ca := b.At(cx, cy).RGBA()
	if cr>>8 != 0xF5 || cg>>8 != 0x7C || cb>>8 != 0x00 || ca>>8 != 0xFF {
		t.Fatalf("右下角不是橘點：%v", b.At(cx, cy))
	}
	if a.At(2, 2) != b.At(2, 2) {
		t.Fatalf("標記不該動到左上角像素")
	}
	// ICO 包裝：標頭 type=1、1 張、資料偏移 22、尾巴就是原 PNG。
	ico := icoFromPNG(out)
	if len(ico) != 22+len(out) || ico[2] != 1 || ico[4] != 1 || !bytes.Equal(ico[22:], out) {
		t.Fatalf("ICO 包裝不對（len=%d）", len(ico))
	}
	var _ image.Image = b
}

func TestGetChannelDefaultsToProd(t *testing.T) {
	c := (&App{}).GetChannel()
	if c.Name != "prod" || c.IsStage || c.Tag != "" || c.DefaultConnect != "" || c.AppName != "Arcrun" {
		t.Fatalf("沒注入頻道時前端拿到的必須是正式版：%+v", c)
	}
}
