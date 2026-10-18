package collector

import (
	"fmt"
	"strings"
	"testing"
)

func TestIdxGroupDigest_topicsOnUpperLevels(t *testing.T) {
	var es []idxEntry
	for i := 0; i < 130; i++ {
		msg := "Incorrect chamfer"
		if i%2 == 1 {
			msg = "Incorrect circular arc"
		}
		stem := fmt.Sprintf("145-%04X_001", i)
		es = append(es, idxEntry{Key: stem, Lines: "- [[" + stem + "]] — Error message：" + msg + "；Cause of error：x（原稿 `a.md`）\n  #tag\n"})
	}
	cards := buildIdxCards(es, idxOpts{RootName: "00-INDEX", NameJoiner: "-", Footer: "## 說明\nx"})
	root := cards[0].Content
	if !strings.Contains(root, "：Incorrect chamfer、Incorrect circular arc") && !strings.Contains(root, "：Incorrect circular arc、Incorrect chamfer") {
		t.Fatalf("分組行沒有主題摘要:\n%s", root)
	}
}

func TestIdxGroupDigest_noSourceText(t *testing.T) {
	if d := idxGroupDigest([]idxEntry{{Key: "a", Lines: "no arrow\n"}}); d != "" {
		t.Fatalf("got %q", d)
	}
}
