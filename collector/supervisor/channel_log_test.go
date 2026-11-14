package supervisor

import (
	"path/filepath"
	"testing"

	"arcrun-rag/collector/channel"
)

// inkstone/arcrun-rag#135：兩個 App 並存時 collector.log 各寫各的；正式版維持 ~/.arcrun-rag/collector.log。
func TestLogPathFollowsChannel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if got, want := logPathFor(channel.For("prod")), filepath.Join(home, ".arcrun-rag", "collector.log"); got != want {
		t.Fatalf("prod log = %s, want %s", got, want)
	}
	if got, want := logPathFor(channel.For("stage")), filepath.Join(home, ".arcrun-rag-stage", "collector.log"); got != want {
		t.Fatalf("stage log = %s, want %s", got, want)
	}
	if defaultLogPath() != logPathFor(channel.For("prod")) {
		t.Fatalf("沒注入頻道時 defaultLogPath 應為正式版")
	}
}
