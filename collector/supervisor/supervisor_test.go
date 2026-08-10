package supervisor

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeCollector 寫一個假的 collector 執行檔（shell 腳本）：忽略參數、印 n 輪 JSON。
// stayAlive=true → 印完 sleep（模擬常駐 daemon，狀態維持 watching）；false → 印完即退出（觸發重起）。
func fakeCollector(t *testing.T, rounds int, stayAlive bool) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake collector script 走 POSIX shell；Windows 測略過（supervisor 邏輯與平台無關）")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "fake-collector.sh")
	body := "#!/bin/sh\n"
	for i := 0; i < rounds; i++ {
		body += "printf '{\"at\":\"2026-07-21T00:00:0" + itoa(i) + "Z\",\"folder\":\"/tmp/kb\",\"results\":[]}\\n'\n"
	}
	if stayAlive {
		body += "sleep 2\n"
	}
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func itoa(i int) string { return string(rune('0' + i)) }

func waitFor(t *testing.T, d time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for: %s", msg)
}

func TestSupervisorParsesRoundsAndWatches(t *testing.T) {
	bin := fakeCollector(t, 2, true)
	s := New(bin, "cfg.json")
	s.Backoff = 20 * time.Millisecond
	s.Start()
	defer s.Stop()

	waitFor(t, 2*time.Second, func() bool { return s.Status().Rounds >= 2 }, "2 rounds parsed")
	st := s.Status()
	if st.State != StateWatching {
		t.Fatalf("expected watching, got %q", st.State)
	}
	if st.LastRoundAt.IsZero() {
		t.Fatal("LastRoundAt should be parsed from stdout 'at'")
	}
	if st.LastRoundAt.Year() != 2026 {
		t.Fatalf("LastRoundAt parse wrong: %v", st.LastRoundAt)
	}
}

func TestSupervisorRestartsOnExit(t *testing.T) {
	bin := fakeCollector(t, 1, false)
	s := New(bin, "cfg.json")
	s.Backoff = 20 * time.Millisecond
	s.Start()
	defer s.Stop()

	// 假 collector 印一輪就退出 → supervisor 視為非預期退出 → 重起
	waitFor(t, 2*time.Second, func() bool { return s.Status().Restarts >= 2 }, "restarts accumulate")
}

func TestSupervisorStop(t *testing.T) {
	bin := fakeCollector(t, 1, false)
	s := New(bin, "cfg.json")
	s.Backoff = 20 * time.Millisecond
	s.Start()
	waitFor(t, 2*time.Second, func() bool { return s.Status().Restarts >= 1 }, "running")
	s.Stop()
	waitFor(t, 2*time.Second, func() bool { return s.Status().State == StateStopped }, "stopped after Stop()")
	// Stop 後不應再累加重起
	r := s.Status().Restarts
	time.Sleep(120 * time.Millisecond)
	if s.Status().Restarts != r {
		t.Fatalf("restarts kept growing after Stop: %d → %d", r, s.Status().Restarts)
	}
}

// 換資料夾＝Stop 緊接 Start；舊 loop 的 setState(stopped) 不可覆寫新 loop 的狀態。
func TestSupervisorStopThenStartNotLeftStopped(t *testing.T) {
	bin := fakeCollector(t, 2, true) // stayAlive → 新 loop 進 watching
	s := New(bin, "cfg.json")
	s.Backoff = 20 * time.Millisecond
	s.Start()
	waitFor(t, 2*time.Second, func() bool { return s.Status().State == StateWatching }, "first watching")
	s.Stop()  // 同步等舊 loop 收掉
	s.Start() // 立刻重起（模擬換資料夾）
	defer s.Stop()
	waitFor(t, 2*time.Second, func() bool { return s.Status().State == StateWatching }, "watching again after Stop→Start")
	// 稍等，確認不會被舊 loop 尾巴改回 stopped
	time.Sleep(100 * time.Millisecond)
	if got := s.Status().State; got != StateWatching {
		t.Fatalf("Stop→Start left state=%q (舊 loop 覆寫了新狀態)", got)
	}
}

// t14：子行程 stdout（JSON 輪）與 stderr 都要落進 log 檔。
func TestSupervisorWritesChildOutputToLog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake collector script 走 POSIX shell")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-collector.sh")
	body := "#!/bin/sh\n" +
		"printf '{\"at\":\"2026-07-24T00:00:00Z\",\"folder\":\"/tmp/kb\",\"results\":[]}\\n'\n" +
		"echo 'boom-stderr-line' 1>&2\n" +
		"sleep 2\n"
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(t.TempDir(), "collector.log")
	s := New(bin, "cfg.json")
	s.LogPath = logPath
	s.Backoff = 20 * time.Millisecond
	s.Start()
	defer s.Stop()

	waitFor(t, 2*time.Second, func() bool {
		data, _ := os.ReadFile(logPath)
		return strings.Contains(string(data), "2026-07-24T00:00:00Z") &&
			strings.Contains(string(data), "[stderr] boom-stderr-line")
	}, "stdout JSON 與 stderr 行都寫進 log 檔")
}

// t14：log 檔超過上限 → 改名 .old 重開（簡單兩代輪替）。
func TestSupervisorLogRotation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake collector script 走 POSIX shell")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-collector.sh")
	// 一輪印 ~120 bytes × 20 輪 ＞ 上限 400 bytes → 必觸發輪替
	body := "#!/bin/sh\ni=0\nwhile [ $i -lt 20 ]; do\n" +
		"printf '{\"at\":\"2026-07-24T00:00:00Z\",\"folder\":\"/tmp/kb-padding-padding-padding-padding-padding\",\"results\":[]}\\n'\n" +
		"i=$((i+1))\ndone\nsleep 2\n"
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(t.TempDir(), "collector.log")
	s := New(bin, "cfg.json")
	s.LogPath = logPath
	s.LogMaxBytes = 400
	s.Backoff = 20 * time.Millisecond
	s.Start()
	defer s.Stop()

	waitFor(t, 2*time.Second, func() bool {
		_, err := os.Stat(logPath + ".old")
		return err == nil
	}, "輪替後 .old 檔存在")
	// 現役檔已重開＝大小不會無限長（上限 + 單次寫入緩衝的餘裕）
	waitFor(t, 2*time.Second, func() bool { return s.Status().Rounds >= 20 }, "20 rounds parsed")
	fi, err := os.Stat(logPath)
	if err != nil {
		t.Fatalf("現役 log 檔應存在：%v", err)
	}
	if fi.Size() > 2*400+4096 {
		t.Fatalf("現役 log 檔未受控：size=%d", fi.Size())
	}
}

func TestSupervisorOnChangeFires(t *testing.T) {
	bin := fakeCollector(t, 2, true)
	s := New(bin, "cfg.json")
	s.Backoff = 20 * time.Millisecond
	var calls int32
	s.SetOnChange(func(Status) { atomic.AddInt32(&calls, 1) })
	s.Start()
	defer s.Stop()
	waitFor(t, 2*time.Second, func() bool { return atomic.LoadInt32(&calls) > 0 }, "onChange fired")
}
