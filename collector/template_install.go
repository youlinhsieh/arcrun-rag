// template_install.go — daemon 代裝 system-dev-template（daemon-beta task 2）。
//
// leo 四步定稿第 1 步：「幫你在指定資料夾安裝我們現有的 template，這個測過很多次，
// 但要讓 daemon 可用」——即**不走 git clone**：template 快照（templatefs/，vendored）
// 打包進二進位，daemon 直接鋪檔。
//
// 冪等鐵律：**已存在的檔案一律不覆寫**（用戶的 status.md/wiki 是他的資產；
// 升級 template 版本＝另案 update 流程，不在本函式）。
package collector

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// templateFS 是 system-dev-template 的 vendored 快照（版本見 templatefs/system-dev/VERSION）。
//
//go:embed all:templatefs
var templateFS embed.FS

const templateFSRoot = "templatefs"

// TemplateInstallResult 是一次代裝的結果帳目。
type TemplateInstallResult struct {
	Installed []string `json:"installed"` // 本次新鋪的檔（相對路徑）
	Skipped   []string `json:"skipped"`   // 已存在故跳過的檔
	Version   string   `json:"version"`   // 快照版本（templatefs/system-dev/VERSION）
}

// TemplateVersion 讀出內嵌快照的版本號。
func TemplateVersion() string {
	data, err := templateFS.ReadFile(templateFSRoot + "/system-dev/VERSION")
	if err != nil {
		return "unknown"
	}
	v := string(data)
	for len(v) > 0 && (v[len(v)-1] == '\n' || v[len(v)-1] == '\r') {
		v = v[:len(v)-1]
	}
	return v
}

// templateOwnedPaths 回傳「這份 template 擁有的相對路徑」集合（斜線分隔）。
//
// 🔴 leo 2026-08-06：「**它也不能只看隱藏檔內，因為 template 在我所有的 repo 裡不是隱藏的**」
//
//	⇒ 判準必須是**路徑身分**（這些路徑本來就是 template 的），不是「有沒有以點開頭」。
//	  用途：掃描時把它們排除在知識之外——不管它是 daemon 舊版鋪的、
//	  還是使用者自己的開發 repo 本來就有的，那都不是他想搜尋的內容。
func templateOwnedPaths() map[string]bool {
	owned := map[string]bool{}
	_ = fs.WalkDir(templateFS, templateFSRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if rel, rerr := filepath.Rel(templateFSRoot, p); rerr == nil {
			owned[filepath.ToSlash(rel)] = true
		}
		return nil
	})
	return owned
}

// TemplateOwns 回答「這個相對路徑是不是 template 的東西」。
// 也認**目錄前綴**：template 的 `system-dev/` 底下使用者後來自己加的檔
// （例如他寫的 wiki）同樣是開發用的，不該進知識庫。
func TemplateOwns(rel string) bool {
	rel = filepath.ToSlash(rel)
	if templateOwnedCache[rel] {
		return true
	}
	for _, prefix := range templateOwnedDirs {
		if strings.HasPrefix(rel, prefix) {
			return true
		}
	}
	return false
}

var (
	templateOwnedCache = templateOwnedPaths()
	// 這些目錄整棵都是開發用的（template 鋪的、或使用者自己長出來的都一樣）。
	templateOwnedDirs = []string{"system-dev/", "scripts/"}
)

// InstallTemplate 把內嵌 template 鋪進 root。冪等：既有檔案跳過不覆寫。
func InstallTemplate(root string) (*TemplateInstallResult, error) {
	res := &TemplateInstallResult{Version: TemplateVersion()}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absRoot, 0o755); err != nil {
		return nil, fmt.Errorf("建目標資料夾失敗：%w", err)
	}
	err = fs.WalkDir(templateFS, templateFSRoot, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if d.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(templateFSRoot, p)
		if rerr != nil {
			return rerr
		}
		dest := filepath.Join(absRoot, rel)
		if _, serr := os.Stat(dest); serr == nil {
			res.Skipped = append(res.Skipped, rel)
			return nil // 冪等：不覆寫用戶既有檔
		}
		if merr := os.MkdirAll(filepath.Dir(dest), 0o755); merr != nil {
			return merr
		}
		data, derr := templateFS.ReadFile(p)
		if derr != nil {
			return derr
		}
		if werr2 := os.WriteFile(dest, data, 0o644); werr2 != nil {
			return werr2
		}
		res.Installed = append(res.Installed, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// TemplateInstalled 判斷 root 是否已鋪過（以 wiki 標記檔存在為準）。
func TemplateInstalled(root string) bool {
	_, err := os.Stat(filepath.Join(root, "system-dev", "wiki", "status.md"))
	return err == nil
}

// runTemplateInstall 是 `collector template-install` 子命令主體。
func runTemplateInstall(args []string) int {
	fs2 := newFlagSet()
	folder := fs2.String("folder", "", "要鋪 template 的資料夾（必填）")
	if err := fs2.Parse(args); err != nil {
		return 2
	}
	if *folder == "" {
		fmt.Fprintln(os.Stderr, "錯誤：--folder 為必填")
		return 2
	}
	res, err := InstallTemplate(*folder)
	if err != nil {
		fmt.Fprintln(os.Stderr, "collector template-install:", err)
		return 1
	}
	fmt.Printf("template v%s：新鋪 %d 檔、跳過既有 %d 檔 → %s\n",
		res.Version, len(res.Installed), len(res.Skipped), *folder)
	return 0
}
