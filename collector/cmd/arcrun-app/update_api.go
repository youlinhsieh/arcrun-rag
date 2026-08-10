package main

// update_api.go — 「版本與更新」頁的後端（t193）
//
// 🔴 leo 2026-08-04：「檢查更新連到 docs 的檢查更新，**不正確**，
//    是**直接在這裡進行檢查更新**，應該是跳到一個頁面顯示**現在版本與最新版本**，
//    然後**下載可以進行安裝**」
//
// ⇒ 三段式，全部在 App 內完成，不把人丟去網頁：
//   ① CheckUpdate  查最新版 → 前端顯示「現在版本 vs 最新版本」
//   ② DownloadUpdate 下載＋sha256 校驗 → 備妥
//   ③ ApplyUpdate  覆蓋正在跑的 .app 並重啟
import (
	"os"
	"runtime"
	"strings"
)

// UpdateInfo 是「版本與更新」頁要顯示的一切。
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	Notes     string `json:"notes,omitempty"`
	Staged    bool   `json:"staged"`        // 已下載備妥、等重啟套用
	Err       string `json:"err,omitempty"` // 誠實回報，不假裝成功
}

func (a *App) CheckUpdate() UpdateInfo {
	info := UpdateInfo{Current: version}
	rel, err := fetchLatestRelease()
	if err != nil {
		info.Err = "暫時連不上更新伺服器：" + err.Error()
		return info
	}
	info.Latest = rel.Version
	info.Notes = rel.Notes
	info.Available = newerThanCurrent(rel.Version)
	// 🔴 2026-08-08（leo 真機實測）：手動裝好新版後按「檢查更新」，
	//    仍顯示「新版已下載完成，重新啟動就會套用」——因為背景/上次曾自動下載備妥過
	//    同一版，使用者卻是自己手動裝的，staged.json 沒人清，殘留狀態一直騙下去。
	//    判準要是「當前版本 vs 最新版本」，不是「有沒有下載過」——見 stagedDecision。
	if s := loadStaged(); s.Ready {
		report, clear := stagedDecision(info.Available, s.Version, rel.Version)
		if clear {
			clearStaleStaged()
		}
		info.Staged = report
	}
	return info
}

// stagedDecision 決定「已備妥」的殘留旗標該回報成「已就緒，可重啟套用」還是該被清掉。
// 抽成純函式（無 IO）方便單元測試涵蓋 08-08 那個真機撞到的殘留旗標病，不必真的碰磁碟/網路。
//
//	available＝目前版本是否落後 latest（newerThanCurrent 的結果）
//	stagedVersion／latestVersion＝已備妥的版本 vs 這次查到的最新版本
//
// 只有「目前版本落後、且備妥的正是這次的最新版」才回報 Staged=true；
// 其餘情況（已經追上／備妥的是舊版）都是殘留，要清掉不能再誤導使用者。
func stagedDecision(available bool, stagedVersion, latestVersion string) (report bool, clear bool) {
	if !available || stagedVersion != latestVersion {
		return false, true
	}
	return true, false
}

// clearStaleStaged 清掉「已備妥但已經不需要套用」的殘留（暫存檔＋標記），
// 不只是記憶體裡的 currentStaged——否則下次啟動 loadStaged() 又會撿回同一個誤導。
func clearStaleStaged() {
	s := loadStaged()
	if s.ZipPath != "" {
		_ = os.Remove(s.ZipPath)
	}
	_ = os.Remove(stagedMarkerPath())
	currentStaged = stagedUpdate{}
}

func (a *App) DownloadUpdate() UpdateInfo {
	info := UpdateInfo{Current: version}
	rel, err := fetchLatestRelease()
	if err != nil {
		info.Err = "暫時連不上更新伺服器：" + err.Error()
		return info
	}
	info.Latest, info.Notes = rel.Version, rel.Notes
	info.Available = newerThanCurrent(rel.Version)

	zip, err := downloadUpdate(rel)
	if err != nil {
		// 誠實：下載/校驗失敗就說失敗，不留下半個檔假裝好了
		info.Err = "下載失敗：" + err.Error()
		return info
	}
	currentStaged = stagedUpdate{Version: rel.Version, ZipPath: zip, Ready: true}
	saveStaged(currentStaged)
	info.Staged = true
	return info
}

func (a *App) ApplyUpdate() error {
	if err := applyStagedAndRestart(); err != nil {
		return err
	}
	return nil
}

// isWindows 供 selfupdate.go 使用（原本在 arcrun-tray 的 main.go）。
func isWindows() bool { return strings.EqualFold(runtime.GOOS, "windows") }
