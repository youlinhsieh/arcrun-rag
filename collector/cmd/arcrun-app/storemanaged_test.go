package main

// storemanaged_test.go — inkstone/arcrun-rag#352：msix（Store）身分下自我更新全關、非 msix 照舊。

import (
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

// asPackage 暫時把「套件身分」換成 on／off，並把更新相關的全域狀態指到暫存目錄。
func asPackage(t *testing.T, on bool) {
	t.Helper()
	old := packageIdentity
	packageIdentity = func() bool { return on }
	t.Cleanup(func() { packageIdentity = old })
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
}

// countingTransport 取代 http.DefaultTransport：不出網路，只數有幾個請求、並回一份假 manifest。
type countingTransport struct{ hits *int32 }

func (c countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	atomic.AddInt32(c.hits, 1)
	body := `{"daemon":{"version":"9.9.9","notes":"n","win":{"file":"x.exe","sha256":""},"mac":{"file":"x.dmg","sha256":""}}}`
	return &http.Response{
		StatusCode: 200, Status: "200 OK", Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   io.NopCloser(strings.NewReader(body)), Request: r,
	}, nil
}

func manifestServer(t *testing.T, hits *int32) {
	t.Helper()
	oldT := http.DefaultTransport
	http.DefaultTransport = countingTransport{hits: hits}
	t.Cleanup(func() { http.DefaultTransport = oldT })
	oldVer := version
	version = "0.18.1"
	t.Cleanup(func() { version = oldVer })
}

func TestStoreManaged_CheckUpdateDoesNotAskTheNetworkAndShowsNoNewVersion(t *testing.T) {
	asPackage(t, true)
	var hits int32
	manifestServer(t, &hits)

	info := (&App{}).CheckUpdate()
	if !info.StoreManaged {
		t.Fatalf("msix 身分下 StoreManaged 應為 true：%+v", info)
	}
	if info.Available || info.Staged || info.Latest != "" {
		t.Fatalf("msix 身分下不該顯示有新版：%+v", info)
	}
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("msix 身分下不該去查 manifest，實際打了 %d 次", got)
	}
}

func TestStoreManaged_DownloadAndApplyRefuse(t *testing.T) {
	asPackage(t, true)
	var hits int32
	manifestServer(t, &hits)

	if info := (&App{}).DownloadUpdate(); !info.StoreManaged || info.Staged {
		t.Fatalf("DownloadUpdate 在 msix 身分下必須拒絕：%+v", info)
	}
	if _, err := downloadUpdate(&daemonRelease{Version: "9.9.9"}); err != errStoreManaged {
		t.Fatalf("downloadUpdate 應回 errStoreManaged，實際 %v", err)
	}
	// 即使磁碟上有殘留的「已備妥」標記，也不准套用（套用會去改名蓋掉唯讀套件裡的 exe）
	saveStaged(stagedUpdate{Version: "9.9.9", ZipPath: "/nonexistent.exe", Ready: true})
	if err := applyStagedAndRestart(); err != errStoreManaged {
		t.Fatalf("applyStagedAndRestart 應回 errStoreManaged，實際 %v", err)
	}
	if err := (&App{}).ApplyUpdate(); err != errStoreManaged {
		t.Fatalf("ApplyUpdate 應回 errStoreManaged，實際 %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("msix 身分下任何入口都不該打網路，實際 %d 次", got)
	}
}

func TestStoreManaged_BackgroundWatcherAndPrepareAreOff(t *testing.T) {
	asPackage(t, true)
	var hits int32
	manifestServer(t, &hits)

	prepareUpdateInBackground() // 直接呼叫也不能動作
	startUpdateWatcher()        // 不應開 goroutine（開了會在一分鐘後去查）
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("背景更新在 msix 身分下必須全關，實際打了 %d 次", got)
	}
	if _, err := os.Stat(stagedMarkerPath()); err == nil {
		t.Fatalf("msix 身分下不該留下任何 staged 標記")
	}
}

func TestNotPackaged_SelfUpdateUnchanged(t *testing.T) {
	asPackage(t, false)
	var hits int32
	manifestServer(t, &hits)

	info := (&App{}).CheckUpdate()
	if info.StoreManaged {
		t.Fatalf("非 msix 不該被當成 Store 版：%+v", info)
	}
	if !info.Available || info.Latest != "9.9.9" {
		t.Fatalf("非 msix 要照舊查到新版 9.9.9：%+v", info)
	}
	if atomic.LoadInt32(&hits) == 0 {
		t.Fatalf("非 msix 要照舊去查 manifest")
	}
	if (&App{}).GetChannel().StoreManaged {
		t.Fatalf("非 msix 的 GetChannel().StoreManaged 應為 false")
	}
}

func TestGetChannel_ReportsStoreManagedForFrontend(t *testing.T) {
	asPackage(t, true)
	if !(&App{}).GetChannel().StoreManaged {
		t.Fatalf("msix 身分下 GetChannel().StoreManaged 應為 true（前端靠它藏掉更新按鈕）")
	}
}

func TestPathInsidePackageStore(t *testing.T) {
	yes := []string{
		`C:\Program Files\WindowsApps\Arcrun.App_0.18.120.0_x64__abc\Arcrun.exe`,
		`c:\program files\windowsapps\x\Arcrun.exe`,
		`C:/Program Files/WindowsApps/x/Arcrun.exe`,
	}
	no := []string{
		`C:\Users\me\Downloads\Arcrun-win-0.18.120.exe`,
		`C:\Users\me\AppData\Local\Programs\Arcrun\Arcrun.exe`,
		`/Applications/Arcrun.app/Contents/MacOS/arcrun-app`,
		`C:\WindowsAppsFake\Arcrun.exe`,
	}
	for _, p := range yes {
		if !pathInsidePackageStore(p) {
			t.Errorf("應判為套件內：%s", p)
		}
	}
	for _, p := range no {
		if pathInsidePackageStore(p) {
			t.Errorf("不該判為套件內：%s", p)
		}
	}
}

// 前端：msix 身分下「版本與更新」頁不放任何更新按鈕。
func TestFrontendHidesUpdateButtonsWhenStoreManaged(t *testing.T) {
	b, err := os.ReadFile("frontend/src/main.js")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	i := strings.Index(s, "function pageUpdate(")
	if i < 0 {
		t.Fatal("找不到 pageUpdate")
	}
	body := s[i : i+1200]
	if !strings.Contains(body, "channelInfo.storeManaged") || !strings.Contains(body, "action = ''") {
		t.Fatalf("pageUpdate 缺少 Store 版分支")
	}
}
