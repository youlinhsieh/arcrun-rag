package collector

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// #240 c18413：各帳號各自前進。一個帳號慢（或卡住）不拖累其他帳號。
// 證法：兩個帳號的「開跑」互相等對方——順序跑會等到逾時（一個等不到另一個開跑），同時跑才過。
func TestRunDirectOnceAccountsRunConcurrently(t *testing.T) {
	base := t.TempDir()
	mk := func(name string) string {
		d := filepath.Join(base, name)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "a.md"), []byte("# "+name), 0o644); err != nil {
			t.Fatal(err)
		}
		return d
	}
	rootA, rootB := mk("A"), mk("B")
	defer probeReadyStub(t)()

	var mu sync.Mutex
	started := map[string]chan struct{}{}
	hostA, hostB := instanceHostOf("https://a.example"), instanceHostOf("https://b.example")
	started[hostA], started[hostB] = make(chan struct{}), make(chan struct{})
	timedOut := false
	accountRunHook = func(host string) {
		mu.Lock()
		close(started[host])
		other := hostA
		if host == hostA {
			other = hostB
		}
		ch := started[other]
		mu.Unlock()
		select {
		case <-ch: // 對方也開跑了＝同時進行
		case <-time.After(5 * time.Second):
			mu.Lock()
			timedOut = true
			mu.Unlock()
		}
	}
	defer func() { accountRunHook = nil }()

	cfg := &DirectConfig{
		Manifest: filepath.Join(base, "manifest.json"),
		Accounts: []AccountConfig{
			{InstanceName: "A", CypherURL: "https://a.example", Namespace: "a", WatchFolders: []string{rootA}},
			{InstanceName: "B", CypherURL: "https://b.example", Namespace: "b", WatchFolders: []string{rootB}},
		},
		MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, _, _ := RunDirectOnce(cfg, true)
	mu.Lock()
	defer mu.Unlock()
	if timedOut {
		t.Fatal("兩個帳號沒有同時開跑：一個帳號慢會拖住另一個（順序執行）")
	}
	// 結果仍按帳號原本的順序併回：A 的事件全在 B 之前
	seenB := false
	for _, r := range results {
		if r.Account == hostB {
			seenB = true
		} else if r.Account == hostA && seenB {
			t.Fatal("結果順序被打亂：應按帳號原本順序併回")
		}
	}
}
