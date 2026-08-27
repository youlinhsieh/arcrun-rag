// templateuntouched.go — 「範本空殼」與「真內容」怎麼分辨
// （inkstone/Arcrun#180 驗收條件 2 與 3，leo 2026-08-28）。
//
// ── 題目 ─────────────────────────────────────────────────────────────────────
//
// leo 原話：「**cards 在 system-dev 下，wiki 就在裡面，所以不允許跳過它**」
//
// 實據（`~/Desktop/youlinhsieh-test1`，同一棵 `system-dev/` 底下兩種東西並存）：
//
//	system-dev/wiki/status.md      ← 安裝器鋪的空殼，內容是「（初始化後填入）」
//	system-dev/wiki/cards/*.md     ← 9 張真的卡（火星座標／Leo-Hsieh-填答／小果被AFTEE詐貸…）
//
// 舊判準是**路徑前綴**（`TemplateOwns`：`system-dev/` 與 `scripts/` 整棵不是知識），
// 它分不出這兩層——把空殼和真內容一起丟掉。
//
// 🔴 而修法不准是「把 system-dev 放行」（票上紅線①）：那會讓所有裝過 template 的 repo
// 開始收一堆一模一樣的空殼，變成另一個方向的錯。**要的是分辨。**
//
// ── 判準 ─────────────────────────────────────────────────────────────────────
//
// daemon **自己就是那個安裝器**（template_install.go 的 `//go:embed all:templatefs`
// 把整份範本快照打進二進位）⇒ 原版就在手上，可以逐字比對，不必猜：
//
//	快照裡有同名檔，**且 sha256 逐字相同**  ⇒ 空殼：安裝器鋪的，他一個字都沒動 ⇒ 不收
//	快照裡沒有，或內容不一樣                ⇒ 他寫的／他放的            ⇒ 照常判斷
//
// **為什麼它不會再誤殺一份現成的 wiki**：範本的 `status.md` 寫的是「（初始化後填入）」，
// **使用者只要寫過一個字，雜湊就對不上，判斷立刻翻面**。
// 判準不看名字、不看深度、不看模式 ⇒ 換個資料夾名、換個安裝位置，答案都一樣
// （這也是紅線：不准用白名單，「下一個叫別的名字的資料夾照樣中」）。
//
// ⚠️ 這支只回答「是不是原封不動的範本」。**其餘的收檔判斷一條都沒有動**
// （副檔名白名單、`.gitignore`、模式範圍、隱藏檔）——它只取代 `TemplateOwns`
// 在掃描時的那一格。tidy.go 仍然用 `TemplateOwns`：它問的是另一題
// （「哪些是範本殘留、該搬進收容處」），不是「這是不是知識」。
package collector

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// templateSnapshotHashes：內嵌範本快照裡每個檔的 sha256（key＝斜線相對路徑）。
// 只算一次——快照是編譯期就固定的東西，執行期不會變。
var templateSnapshotHashes = sync.OnceValue(func() map[string]string {
	out := map[string]string{}
	_ = fs.WalkDir(templateFS, templateFSRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(templateFSRoot, p)
		if rerr != nil {
			return nil
		}
		data, rerr := templateFS.ReadFile(p)
		if rerr != nil {
			return nil
		}
		sum := sha256.Sum256(data)
		out[filepath.ToSlash(rel)] = hex.EncodeToString(sum[:])
		return nil
	})
	return out
})

// TemplateUntouched 回答「這個檔是不是安裝器鋪下去、而且使用者一個字都沒動過的空殼」。
//
// relSlash＝相對監看根的路徑（斜線分隔）；absPath＝那個檔在磁碟上的位置。
//
// 🔴 讀不到檔一律回 false——**認不出來就不要排除**。誤留一份空殼只是雜訊，
// 誤丟一份使用者的知識是資料遺失，兩邊的代價不對等（同 cleanup.go 的規矩②）。
func TemplateUntouched(relSlash, absPath string) bool {
	want, ok := templateSnapshotHashes()[filepath.ToSlash(relSlash)]
	if !ok {
		return false // 快照裡沒有這個路徑 ⇒ 不是安裝器鋪的
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) == want
}
