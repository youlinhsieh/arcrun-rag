package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// stableHashLib 重現 libraryFor 對純中文資料夾的穩定雜湊鍵（t89 驗收用）。
func stableHashLib(absPath string) string {
	sum := sha256.Sum256([]byte(absPath))
	return "lib_" + hex.EncodeToString(sum[:3])
}

func TestLibraryPerFolder(t *testing.T) {
	cfg := &DirectConfig{Library: "kb"}
	cases := map[string]string{
		"/Users/x/Desktop/finance":  "finance",
		"/Users/x/Desktop/HR Docs": "hr_docs",
		// t89：純中文資料夾名不再退 kb，改生穩定唯一鍵
		"/Users/x/Desktop/官方總圖": stableHashLib("/Users/x/Desktop/官方總圖"),
		"/Users/x/Desktop/test 01": "test_01",
	}
	for in, want := range cases {
		if got := cfg.libraryFor(in); got != want {
			t.Errorf("libraryFor(%q) = %q, want %q", in, got, want)
		}
	}
	cfg.Libraries = map[string]string{"/Users/x/Desktop/官方總圖": "official"}
	if got := cfg.libraryFor("/Users/x/Desktop/官方總圖"); got != "official" {
		t.Errorf("明列對映應優先，got %q", got)
	}
}

// ── t89 五條驗收測試 ────────────────────────────────────────────────────────

// ①純中文資料夾 → lib_+6hex，非 "kb"
func TestT89ChineseFolderNotKb(t *testing.T) {
	cfg := &DirectConfig{Library: "kb"}
	got := cfg.libraryFor("/Users/x/Desktop/官方總圖")
	if got == "kb" {
		t.Errorf("純中文資料夾不應退到 'kb'，got %q", got)
	}
	if len(got) != len("lib_")+6 || got[:4] != "lib_" {
		t.Errorf("預期格式 lib_<6hex>，got %q", got)
	}
}

// ②兩個不同純中文資料夾 → 不同鍵（不混庫）
func TestT89TwoChineseFoldersDifferentKeys(t *testing.T) {
	cfg := &DirectConfig{Library: "kb"}
	k1 := cfg.libraryFor("/Users/x/Desktop/官方總圖")
	k2 := cfg.libraryFor("/Users/x/Desktop/人事資料")
	if k1 == k2 {
		t.Errorf("不同純中文資料夾必須對映不同鍵，got k1=%q k2=%q", k1, k2)
	}
}

// ③同一路徑重跑 → 鍵穩定（冪等）
func TestT89SameFolderStableKey(t *testing.T) {
	cfg := &DirectConfig{Library: "kb"}
	k1 := cfg.libraryFor("/Users/x/Desktop/官方總圖")
	k2 := cfg.libraryFor("/Users/x/Desktop/官方總圖")
	if k1 != k2 {
		t.Errorf("同路徑重跑必須回傳同一鍵，got %q vs %q", k1, k2)
	}
}

// ④ASCII 資料夾行為不變（test 01 → test_01）
func TestT89ASCIIFolderUnchanged(t *testing.T) {
	cfg := &DirectConfig{Library: "kb"}
	cases := map[string]string{
		"/Users/x/Desktop/finance":  "finance",
		"/Users/x/Desktop/test 01":  "test_01",
		"/Users/x/Desktop/HR Docs":  "hr_docs",
	}
	for in, want := range cases {
		if got := cfg.libraryFor(in); got != want {
			t.Errorf("libraryFor(%q) = %q, want %q", in, got, want)
		}
	}
}

// ⑤明列 Libraries 對映仍最優先（即使是純中文資料夾）
func TestT89ExplicitMappingWins(t *testing.T) {
	cfg := &DirectConfig{
		Library: "kb",
		Libraries: map[string]string{
			"/Users/x/Desktop/官方總圖": "official",
		},
	}
	if got := cfg.libraryFor("/Users/x/Desktop/官方總圖"); got != "official" {
		t.Errorf("明列對映應優先，got %q", got)
	}
}
