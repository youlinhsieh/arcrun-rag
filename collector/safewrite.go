// safewrite.go — 落卡寫檔前的保護（arcrun-rag#60 第二條：不得無條件覆蓋既有檔案）。
//
// 修前：extract_workersai.go / extract_gemma.go 都是無條件 os.WriteFile——不看目標
// 存不存在、不備份、不詢問。這次沒出事只是檔名剛好沒撞上，不代表安全。
package collector

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// safeWriteCard 把卡片內容寫到 dest，寫之前先檢查目標是否已存在：
//   - 不存在 → 直接寫（首次落卡，行為不變）。
//   - 存在且內容相同 → 不動它（冪等：同一份卡片重複萃取不該產生垃圾備份）。
//   - 存在但內容不同 → 先把既有內容備份成 `<dest>.bak-<unixnano>`，備份成功才覆寫；
//     備份失敗就整個中止，寧可這次萃取失敗，也不要無聲蓋掉使用者機器上已經有的東西。
func safeWriteCard(dest string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return fmt.Errorf("建立卡片目錄失敗：%w", err)
	}
	existing, err := os.ReadFile(dest)
	switch {
	case err == nil:
		if bytes.Equal(existing, content) {
			return nil // 內容沒變，不必重寫也不必備份
		}
		backup := fmt.Sprintf("%s.bak-%d", dest, time.Now().UnixNano())
		if werr := os.WriteFile(backup, existing, 0o644); werr != nil {
			return fmt.Errorf("寫卡前備份既有檔失敗，中止避免覆蓋（%s）：%w", dest, werr)
		}
	case os.IsNotExist(err):
		// 目標不存在，正常首次落卡，不必備份。
	default:
		return fmt.Errorf("檢查既有卡片失敗（%s）：%w", dest, err)
	}
	return os.WriteFile(dest, content, 0o644)
}
