package collector

import (
	"strings"
	"testing"
)

func TestFailureWithUpstreamKeepsRawReason(t *testing.T) {
	got := failureWithUpstream(headRejected+"，稍後會自動再試。", "{\"error\":\n\"boom X\"}")
	if !strings.Contains(got, "上游原因：") || !strings.Contains(got, "boom X") || strings.Contains(got, "\n") {
		t.Fatalf("got %q", got)
	}
	if failureWithUpstream("a", "") != "a" {
		t.Fatal("無原文時不變")
	}
}
