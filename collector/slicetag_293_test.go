package collector

import (
	"errors"
	"strings"
	"testing"
)

func TestSliceTagged_293(t *testing.T) {
	base := errors.New("boom")
	if got := sliceTagged(base, 1, 1, cardSlice{}); got != base {
		t.Fatal("單發不加標記")
	}
	e := sliceTagged(base, 2, 4, cardSlice{Offset: 25, Scope: "s1"})
	if !errors.Is(e, base) || !strings.HasPrefix(e.Error(), "boom｜") || !strings.Contains(e.Error(), "第 2／4 發") {
		t.Fatalf("標記錯：%v", e)
	}
}
