package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseGlyphs(t *testing.T) {
	if g := parseGlyphs([]byte(`{"glyphs":{"note":"<path d=\"M1 1\"/>"}}`)); g["note"] == "" {
		t.Fatalf("應解出 note，得到 %v", g)
	}
	for _, bad := range []string{``, `{}`, `{"glyphs":{}}`, `{"glyphs":"x"}`, `not json`} {
		if g := parseGlyphs([]byte(bad)); g != nil {
			t.Fatalf("%q 應回 nil，得到 %v", bad, g)
		}
	}
}

func TestFetchGlyphsFallsBackToNilOnOldInstance(t *testing.T) {
	old := httptest.NewServer(http.NotFoundHandler())
	defer old.Close()
	if g := fetchGlyphs(accountCfg{CypherURL: old.URL, APIKey: "k"}); g != nil {
		t.Fatalf("舊實例（404）應回 nil，得到 %v", g)
	}
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apps/glyphs" || r.Header.Get("X-Arcrun-API-Key") != "k" {
			http.Error(w, "no", 403)
			return
		}
		w.Write([]byte(`{"glyphs":{"note":"<path d=\"M1 1\"/>"}}`))
	}))
	defer ok.Close()
	if g := fetchGlyphs(accountCfg{CypherURL: ok.URL, APIKey: "k"}); g["note"] == "" {
		t.Fatalf("新實例應拿到字形，得到 %v", g)
	}
}
