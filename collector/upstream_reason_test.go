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

func TestFailedNodePrefixSurvivesTruncation(t *testing.T) {
	full := `{"success":false,"data":{},"error":"回應太大","trace":[` + strings.Repeat(`{"nodeId":"x"},`, 500) + `{}],"duration_ms":9,"failed_node":"post_block"}`
	if got := failedNodePrefix(full); got != "失敗節點 post_block｜" {
		t.Fatalf("got %q", got)
	}
	if failedNodePrefix(`{"success":false}`) != "" {
		t.Fatal("沒有 failed_node 時不加")
	}
}
