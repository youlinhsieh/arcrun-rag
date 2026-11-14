package channel

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// 沒注入＝正式版，且身分就是今天的 Arcrun（正式版行為零改變的地板）。
func TestDefaultIsProdUnchanged(t *testing.T) {
	c := Current()
	if c.Name != "prod" || c.IsStage() {
		t.Fatalf("沒注入 ldflags 必須是正式版，得到 %q", c.Name)
	}
	want := map[string]string{
		"AppName":      "Arcrun",
		"BundleName":   "arcrun-app",
		"InstanceLock": "dev.arcrun.rag.daemon",
		"DataDirName":  ".arcrun-rag",
		"LibraryDir":   "Arcrun 範例庫（可刪除）",
		"ManifestURL":  "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/manifest.json",
		"DownloadBase": "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/",
		"LatestURL":    "https://install.arcrun.dev/api/latest",
		"InstallURL":   "https://install.arcrun.dev/",
	}
	got := map[string]string{
		"AppName": c.AppName, "BundleName": c.BundleName, "InstanceLock": c.InstanceLock,
		"DataDirName": c.DataDirName, "LibraryDir": c.LibraryDir, "ManifestURL": c.ManifestURL,
		"DownloadBase": c.DownloadBase, "LatestURL": c.LatestURL, "InstallURL": c.InstallURL,
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("正式版 %s 變了：want %q got %q", k, w, got[k])
		}
	}
	if c.Tag != "" || c.DefaultConnect != "" {
		t.Errorf("正式版不該有標記或預填連線：tag=%q connect=%q", c.Tag, c.DefaultConnect)
	}
}

// 兩個 App 能並存的條件：每一個「會互踩」的身分欄位都不同。
func TestStageAndProdNeverCollide(t *testing.T) {
	p, s := For("prod"), For("stage")
	pairs := map[string][2]string{
		"AppName": {p.AppName, s.AppName}, "BundleName": {p.BundleName, s.BundleName},
		"InstanceLock": {p.InstanceLock, s.InstanceLock}, "DataDirName": {p.DataDirName, s.DataDirName},
		"LibraryDir": {p.LibraryDir, s.LibraryDir}, "ManifestURL": {p.ManifestURL, s.ManifestURL},
		"DownloadBase": {p.DownloadBase, s.DownloadBase}, "LatestURL": {p.LatestURL, s.LatestURL},
		"InstallURL": {p.InstallURL, s.InstallURL}, "DmgVolume": {p.DmgVolume, s.DmgVolume},
	}
	for k, v := range pairs {
		if v[0] == v[1] || v[1] == "" {
			t.Errorf("%s：stage 與 prod 相同或為空（%q）⇒ 兩個 App 會互踩", k, v[1])
		}
	}
	if !s.IsStage() || s.Tag == "" || s.DefaultConnect == "" {
		t.Errorf("stage 必須有標記與預填連線：%+v", s)
	}
	// stage 的任何來源都不准指向 prod 的座標（否則檢查更新又回到 prod）。
	for k, u := range map[string]string{"ManifestURL": s.ManifestURL, "DownloadBase": s.DownloadBase, "LatestURL": s.LatestURL, "InstallURL": s.InstallURL} {
		if strings.Contains(u, "raw.githubusercontent.com") || strings.Contains(u, "install.arcrun.dev") {
			t.Errorf("stage %s 指到 prod 座標：%s", k, u)
		}
	}
	// 資料目錄不准一個是另一個的前綴路徑（~/.arcrun-rag 與 ~/.arcrun-rag-stage 是兄弟，不是父子）。
	if strings.HasPrefix(s.DataDirName, p.DataDirName+"/") {
		t.Errorf("stage 資料目錄在 prod 底下：%s", s.DataDirName)
	}
}

func TestForUnknownFallsBackToProd(t *testing.T) {
	for _, n := range []string{"", "prod", "PROD", "staging-x", "beta"} {
		if For(n).Name != "prod" {
			t.Errorf("For(%q) 應該是正式版", n)
		}
	}
	for _, n := range []string{"stage", "Stage", " STAGE "} {
		if !For(n).IsStage() {
			t.Errorf("For(%q) 應該是 stage", n)
		}
	}
}

func TestFileURL(t *testing.T) {
	s := For("stage")
	if got, want := s.FileURL("daemon/Arcrun-0.18.30.dmg"), stageInstallerBase+"/dist/daemon/Arcrun-0.18.30.dmg"; got != want {
		t.Errorf("FileURL = %s, want %s", got, want)
	}
	if got := For("prod").FileURL("/daemon/x.dmg"); got != "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/daemon/x.dmg" {
		t.Errorf("prod FileURL = %s", got)
	}
}

// stage 座標與出貨線登錄簿 installer/ship.targets.json 的 targets.stage 對得上。
// 這份檔案只在 arcrun-rag 整個 repo 裡才有；collector 被同步成獨立 repo 時沒有它 ⇒ 跳過
// （installer/scripts/channel-coordinates.test.mjs 在 repo 內也比對同一件事）。
func TestStageCoordinatesMatchShipTargets(t *testing.T) {
	raw, err := os.ReadFile("../../installer/ship.targets.json")
	if err != nil {
		t.Skip("找不到 installer/ship.targets.json（collector 單獨 checkout），由 mjs 測試負責")
	}
	var reg struct {
		Targets struct {
			Stage struct {
				Dist struct {
					PublicBase string `json:"publicBase"`
				} `json:"dist"`
				Verify struct {
					InstallerBase string `json:"installerBase"`
				} `json:"verify"`
				InstanceUpdate struct {
					CypherURL  string `json:"cypherUrl"`
					ReleaseAPI string `json:"releaseApi"`
				} `json:"instanceUpdate"`
				DaemonDist string `json:"daemonDist"`
			} `json:"stage"`
		} `json:"targets"`
	}
	if err := json.Unmarshal(raw, &reg); err != nil {
		t.Fatal(err)
	}
	s, st := For("stage"), reg.Targets.Stage
	checks := []struct{ what, got, want string }{
		{"manifest 指標", s.ManifestURL, strings.TrimRight(st.Dist.PublicBase, "/") + "/manifest.json"},
		{"下載根", s.DownloadBase, strings.TrimRight(st.Dist.PublicBase, "/") + "/"},
		{"雲端最新版 API", s.LatestURL, st.InstanceUpdate.ReleaseAPI},
		{"安裝頁", strings.TrimRight(s.InstallURL, "/"), strings.TrimRight(st.Verify.InstallerBase, "/")},
		{"預填連線（youlin 實例）", s.DefaultConnect, st.InstanceUpdate.CypherURL},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s：小幫手寫 %q，登錄簿 targets.stage 是 %q", c.what, c.got, c.want)
		}
	}
	if st.DaemonDist != "dist-stage" {
		t.Errorf("targets.stage.daemonDist 應為 dist-stage，登錄簿是 %q", st.DaemonDist)
	}
}

// 打包旗標真的有注入進去：
//
//	CHANNEL_EXPECT=stage go test -ldflags "-X arcrun-rag/collector/channel.name=stage" ./channel -run Injected
//
// 沒設 CHANNEL_EXPECT 就跳過（平常 go test 不帶旗標）。打包腳本 channel-env.sh 的 CH_LDFLAGS 就是這串。
func TestLdflagsInjected(t *testing.T) {
	want := os.Getenv("CHANNEL_EXPECT")
	if want == "" {
		t.Skip("沒設 CHANNEL_EXPECT")
	}
	if got := Current().Name; got != want {
		t.Fatalf("ldflags 注入後 Current() = %q，預期 %q", got, want)
	}
}
