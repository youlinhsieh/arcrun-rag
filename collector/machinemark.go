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

// IsMachineOwnedRel 回答「這個相對路徑是不是我們寫的東西」——**規約的完整判準**，
// 迴歸網（vault_footprint_test.go／vault_subdir_test.go）用的就是這一支。
//
// 兩條路，第二條是規約唯一認可的例外：
//
//	① basename 帶 MachineMark ⇒ 走在使用者的檔案之間也一眼分得出（規約主體）
//	② 路徑上**任何一層**是 `.arcrun-rag/` ⇒ **那個目錄名自己就是標記**，且它是隱藏目錄
//
// ②「任何一層」而不是「開頭」：呼叫端給的相對起點不一定是監看根——迴歸網比對整個
// 筆記庫時，同一個檔的相對路徑是 `docs/.arcrun-rag/…`（監看根是 vault 底下的 docs/）。
// 判「誰擁有這個檔」不該受呼叫端從哪裡起算影響。
//
// 🔴 為什麼需要 ②（arcrun-rag#105）：我們得在使用者的 repo 裡放一份 `.gitignore`
// （讓整個工作區對 git 隱形，他跑一輪 `git status` 才會是乾淨的）。那個檔名是
// **git 定的，我們改不得**——叫 `arcrun-.gitignore` 的話 git 根本不認，功能等於沒做。
//
// 這不是替規約開後門：規約的目的是「打開資料夾一眼分得出哪些是機器寫的」，
// 而 `.arcrun-rag/` 這個目錄名把整叢東西一次講完，比逐檔前綴**更強**。
//
// 🔴 例外 ③ `.wiki/`（InkStoneCo#44 第④環，2026-08-15）：《llm-wiki-作業規範》定案
// 「wiki 是文件的摘要，摘要只准寫進 `<節點>/.wiki/`」，且卡片檔名＝H1（差距表 #7
// 明列「檔名加 arcrun- 前綴」是要修掉的現狀——卡名就是 [[連結]] 的錨點，帶前綴
// 會讓連結與頁名對不上）。與例外 ② 同一個理由成立：點開頭的隱藏目錄名自身就是標記，
// 筆記軟體與我們自己的 Scan() 都不會掃進去。
// ⚠️ 例外只有這兩個目錄。監看根底下**其他任何位置**的新檔，一律得帶前綴——
// 想在別處寫一個「名字不能改」的檔時，先想清楚那個檔為什麼不能住進這兩個目錄。
func IsMachineOwnedRel(relSlash string) bool {
	return IsMarked(pathBase(relSlash)) || InMachineOwnedDir(relSlash)
}

// InMachineOwnedDir 只回答上面那兩條路的**第二條**：這個路徑上有沒有一層是
// `.arcrun-rag/` 或 `.wiki/`。
//
// 🔴 為什麼要把它單獨切出來（inkstone/Arcrun#180 ↔ #134，2026-08-28）：
// 兩條路的**證據強度不一樣**，而收檔判準需要分得開它們——
//
//	目錄（本函式）＝**位置**證明它是產物。`.wiki/` 是這一版寫卡的唯一落點，
//	                任何時候走到那裡的東西都是我們此刻正在維護的產物 ⇒ 鐵證。
//	前綴（IsMarked）＝**歷史**說某一版的 daemon 寫過它。它不保證「現在還是產物」：
//	                leo 的 `youlinhsieh-test1` 底下那 9 張 `cards/arcrun-*.md`
//	                是 8/4 舊版寫的，而他 08-14 明講「這些庫都早就萃好了⋯⋯直接 ingest」
//	                ——對他而言那就是他的知識。
//
// ⇒ 要「絕不把產物當原稿」時用本函式；要「連歷史產物都不碰」時才用 IsMachineOwnedRel。
// 規約本身（每個新檔都要帶標記）沒有變，vault_footprint_test.go 仍然用完整判準。
func InMachineOwnedDir(relSlash string) bool {
	for _, seg := range strings.Split(relSlash, "/") {
		if seg == workspaceRelDir || seg == wikiRelDir {
			return true
		}
	}
	return false
}

// pathBase 取斜線路徑的最後一段（不用 filepath.Base：這裡的輸入一律是斜線分隔的
// 相對路徑，不該受執行平台的分隔符影響）。
func pathBase(relSlash string) string {
	if i := strings.LastIndex(relSlash, "/"); i >= 0 {
		return relSlash[i+1:]
	}
	return relSlash
}
