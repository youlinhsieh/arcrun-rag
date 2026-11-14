// Package channel 是小幫手「我是正式版還是 Stage 版」的唯一一份答案
// （inkstone/arcrun-rag#135，leo 2026-11-12）。
//
// leo 原話：「現在的小幫手是沒有 stage 的，所以就拿我的 prod 來測試⋯⋯stage 直接串到 youlin 帳號，
// 也不能都拿 prod 來測試」。
//
// 做法：**同一份原始碼，打包時一個參數決定身分**——
//
//	go build -ldflags "-X arcrun-rag/collector/channel.name=stage"   # Arcrun Stage
//	go build                                                          # 不帶＝正式版（今天的 Arcrun，行為零改變）
//
// 只差「身分」，不差行為（wiki 卡〈stage與prod只准差什麼〉）：App 名稱、bundle id、單一實例鎖、
// 資料目錄、檢查更新的來源、雲端版本比對、安裝頁、首次連線預填，全部收在下面這張表，
// App 與 collector 引同一份。**不准在別處再寫一個「if stage」——要加差異就加這張表的一欄。**
//
// 為什麼獨立成一個葉子套件：supervisor／collector／App 三處都要讀它，
// 放在其中任何一個裡面都會造成 import 循環。
//
// stage 的座標必須與 `installer/ship.targets.json` 的 `targets.stage` 對得上
// （channel_test.go 與 installer/scripts/channel-coordinates.test.mjs 各比對一次）：
// 出貨線把 DMG 放到哪、小幫手就去哪裡找更新，兩邊不一致＝stage 版永遠更新不到。
package channel

import "strings"

// name 由 -ldflags 注入；空字串＝正式版。
var name = ""

// Info 是一個頻道的全部身分。零值不可用，一律經 Current()／For()。
type Info struct {
	Name string // "prod" | "stage"

	// ── 外觀（用戶一眼分辨）──
	AppName    string // .app／視窗標題／選單列提示的名字
	BundleName string // wails.json 的 name（決定 bundle id ＝ com.wails.<BundleName>）
	Tag        string // 畫面上的短標記；正式版空
	DmgVolume  string // DMG 掛載後的磁碟名

	// ── 不互相踩（兩個 App 並存的條件）──
	InstanceLock string // 單一實例鎖 id
	DataDirName  string // 家目錄底下的資料目錄名（設定、log、機器身分、更新暫存）
	LibraryDir   string // 預設範例庫資料夾名（放在 ~/Documents）

	// ── 更新與安裝來源 ──
	ManifestURL    string // 小幫手「檢查更新」讀的 bundle manifest
	DownloadBase   string // manifest 裡 daemon.<平台>.file 接在這後面成為下載網址（結尾有 /）
	LatestURL      string // 雲端引擎「最新版」查詢（install 端點 /api/latest）
	InstallURL     string // 安裝頁
	DefaultConnect string // 首次連線預填的知識庫網址；空＝不預填
}

var prod = Info{
	Name:       "prod",
	AppName:    "Arcrun",
	BundleName: "arcrun-app",
	Tag:        "",
	DmgVolume:  "Arcrun",

	InstanceLock: "dev.arcrun.rag.daemon",
	DataDirName:  ".arcrun-rag",
	LibraryDir:   "Arcrun 範例庫（可刪除）",

	ManifestURL:    "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/manifest.json",
	DownloadBase:   "https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/main/",
	LatestURL:      "https://install.arcrun.dev/api/latest",
	InstallURL:     "https://install.arcrun.dev/",
	DefaultConnect: "",
}

// stage 座標＝installer/ship.targets.json targets.stage（dist.publicBase／installer 的 stage 安裝器／youlin 實例）。
const (
	stageInstallerBase = "https://arcrun-installer-youlin-stage.arcrun-yuga3bse.workers.dev"
	stageCypherURL     = "https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev"
)

var stage = Info{
	Name:       "stage",
	AppName:    "Arcrun Stage",
	BundleName: "arcrun-app-stage",
	Tag:        "Stage",
	DmgVolume:  "Arcrun Stage",

	InstanceLock: "dev.arcrun.rag.daemon.stage",
	DataDirName:  ".arcrun-rag-stage",
	LibraryDir:   "Arcrun Stage 範例庫（可刪除）",

	ManifestURL:    stageInstallerBase + "/dist/manifest.json",
	DownloadBase:   stageInstallerBase + "/dist/",
	LatestURL:      stageInstallerBase + "/api/latest",
	InstallURL:     stageInstallerBase + "/",
	DefaultConnect: stageCypherURL,
}

// For 回傳指定頻道的身分；不認得的名字當正式版（寧可是今天的行為，不要猜出第三種身分）。
func For(n string) Info {
	if strings.EqualFold(strings.TrimSpace(n), "stage") {
		return stage
	}
	return prod
}

// Current 是這支執行檔的身分（由打包時注入）。
func Current() Info { return For(name) }

// IsStage 方便前端／選單判斷。
func (i Info) IsStage() bool { return i.Name == "stage" }

// FileURL 把 manifest 裡的相對檔名（例 `daemon/Arcrun-0.18.30.dmg`）接成下載網址。
func (i Info) FileURL(rel string) string {
	return i.DownloadBase + strings.TrimLeft(rel, "/")
}
