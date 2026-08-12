// machinemark.go — daemon 寫進使用者資料夾的每一個檔案，檔名都帶同一個標記
// （arcrun-rag#60 第二輪，2026-08-12 leo 實撞）。
//
// 🔴 為什麼上一輪不夠：
//
//	第一輪（1e36bb1）只改了「卡片**落在哪個目錄**」——vault 就改落隱藏的
//	`.arcrun-rag/wiki/cards/`。但 Logseq/Obsidian 的**頁名是從 basename 來的**，
//	而卡片的 basename 一直是「原稿的 basename」：使用者的 `journals/2026_08_10.md`
//	萃出來的卡就叫 `2026_08_10.md`，跟他自己的日誌頁**同名**。
//	⇒ 只要那個目錄有任何一刻被看見（他自己翻資料夾、備份工具攤平、之後改成非隱藏、
//	  或是**非 vault 的一般資料夾**——那裡卡片本來就是可見的），撞名就回來了。
//	leo 原話：「不只是加上 journal，**可能所有的檔案都加一個前後綴，比如「wiki」**。」
//
// 🔴 規約（本檔是唯一真相源，不准有第二種標記）：
//
//	**daemon 在使用者的監看根底下產生的每一個檔案，basename 一律以 MachineMark 開頭。**
//
//	一種就是一種——「一部分加一部分不加」比全不加更難分辨（leo 的紅線）。
//	所以任何新的寫檔點都必須經過 MarkName()，不得自己拼檔名。
//	迴歸網＝vault_footprint_test.go：它 walk 整個監看根，只要有任何新檔沒帶標記就紅，
//	**與寫檔點的數量無關**——這正是上一輪缺的那張網（上一輪只點測了一個常數）。
//
// 為什麼是「前綴」不是「後綴」：`ls`／Finder／Logseq 的頁面清單都是按名字排序的，
// 前綴會讓機器寫的東西**全部聚成一叢**，一眼就掃得完；後綴則散落在他自己的檔案之間，
// 等於還是要一個一個看。leo 要的是「打開資料夾一眼分得出」，那就是前綴。
//
// 為什麼標記字串是 `arcrun-` 而不是 leo 舉例的 `wiki`：`wiki` 是他自己筆記裡會用的
// 普通詞（`wiki-整理術.md` 是他的、不是我們的），拿它當標記等於製造新的誤認；
// `arcrun-` 直接說出「這是 Arcrun 寫的」，且與既有的 `.arcrun-rag/` 目錄同一組字。
// 這是一行常數，leo 覺得該用別的字就改這裡一個地方（連舊產物一起 tidy 重跑即可）。
package collector

import "strings"

// MachineMark 是 daemon 產物的**唯一**標記。改這裡＝改全部（含 tidy 的認人判準）。
const MachineMark = "arcrun-"

// MarkName 把一個 basename 加上標記。冪等：已經帶標記的原樣回傳，
// 不會疊成 `arcrun-arcrun-x.md`（tidy 重跑、daemon 重跑都會走到這條）。
func MarkName(base string) string {
	if IsMarked(base) {
		return base
	}
	return MachineMark + base
}

// IsMarked 回答「這個 basename 是不是機器寫的」。
// ⚠️ 只吃 basename，不吃路徑——路徑中間的目錄名不算數（目錄是不是機器的，
// 由 cardsRelDirFor 那組常數決定，不由這裡猜）。
func IsMarked(base string) bool {
	return strings.HasPrefix(base, MachineMark)
}

// UnmarkName 去掉標記，回傳原本的名字。tidy 拿來對照「這張卡對應哪一份原稿」。
func UnmarkName(base string) string {
	return strings.TrimPrefix(base, MachineMark)
}
