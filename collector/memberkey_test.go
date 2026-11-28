package collector

import (
	"strings"
	"testing"
)

func TestMemberACLSentence(t *testing.T) {
	if s := memberACLSentence(403, `{"error":"庫「a」不是你的","code":"library_not_yours"}`); !strings.Contains(s, "不是你的") {
		t.Fatalf("got %q", s)
	}
	if memberACLSentence(403, `{"code":"admin_only"}`) == "" || memberACLSentence(403, `{"code":"library_required"}`) == "" {
		t.Fatal("admin_only／library_required 要有人話")
	}
	if memberACLSentence(500, `{"code":"admin_only"}`) != "" || memberACLSentence(403, `not json`) != "" || memberACLSentence(403, `{"code":"x"}`) != "" {
		t.Fatal("認不出來要回空字串")
	}
}
