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

// safeWriteCard 把卡片內容寫到 dest，寫之前先過兩道：
//
// ① **不准踩進使用者的子筆記庫**（arcrun-rag#60 第三輪）——見下方 ensureWritable。
// ② 目標已存在時不無條件覆蓋：
//   - 不存在 → 直接寫（首次落卡，行為不變）。
//   - 存在且內容相同 → 不動它（冪等：同一份卡片重複萃取不該產生垃圾備份）。
//   - 存在但內容不同 → 先把既有內容備份成 `<dest>.bak-<unixnano>`，備份成功才覆寫；
//     備份失敗就整個中止，寧可這次萃取失敗，也不要無聲蓋掉使用者機器上已經有的東西。
func safeWriteCard(absRoot, dest string, content []byte) error {
	if err := ensureWritable(absRoot, dest); err != nil {
		return err
	}
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

// ensureWritable 是「不准把機器產物寫進使用者的子筆記庫」這條規約的機械閘。
//
// 監看根**自己**在不在 vault 裡，由 cardsRelDirFor 決定落點（隱藏目錄）已經處理掉；
// 這裡擋的是另一半：目標路徑中途經過某個**子**筆記庫。今天所有寫檔點的目標都錨在
// 監看根，所以這道閘不會觸發——它的價值在以後：任何人新增一個「寫在原稿旁邊」的
// 寫檔點，會在這裡當場失敗，而不是在陌生人的筆記庫裡被發現。
//
// 失敗而不是靜靜改寫到別處：票上的紅線是「寧可少寫一個檔，也不要多寫一個可能被誤認的檔」，
// 而且錯誤訊息會沿著 DirectResult 冒到使用者面前，比默默換位置更容易被修掉。
func ensureWritable(absRoot, dest string) error {
	if absRoot == "" {
		return nil // 呼叫端沒有監看根概念（例如單元測試直寫），不在本閘範圍
	}
	if vdir, vt := VaultDirUnder(absRoot, dest); vt != VaultNone {
		return fmt.Errorf("拒絕寫入 %s：這個位置在使用者的 %s 筆記庫裡（%s），"+
			"機器產物不得寫進筆記庫的命名空間（arcrun-rag#60）", dest, vt, vdir)
	}
	return nil
}
