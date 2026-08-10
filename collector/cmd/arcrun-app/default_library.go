package main

// default_library.go — 全新安裝的「可刪除預設庫」（leo 2026-08-08 拍板）
//
// leo 原話：「地端更新後，要裝一個 local 的 default 庫，他可以刪除。」
// 具體化自更早的構想：「給他裝一個 Demo 同步文件夾在 Documents，裡面有幾個檔案
// 說明 Arcrun 的豐功偉業……如果那個檔案被產出 wiki、可以 embed、可以搜，基本就
// 整條通了，用戶連串一個資料夾都省了……不過，只有第一次安裝，然後他刪除，只要
// 有掛用戶自己的資料夾，就不再出現。」
//
// 四條紅線：
//  1. 可刪——用戶刪掉就真的消失，不自己長回來
//  2. 只有第一次——一旦掛過自己的資料夾（＝這台機器已經連過任何知識庫帳號），
//     這個預設庫不再出現
//  3. 不污染——只在自己的資料夾裡寫檔，乾淨拿走、不留殘骸
//  4. 不產生幽靈資料——資料夾被刪掉後，config 裡的殘留引用也要清掉，
//     不留「查得到但畫面永遠空」的紀錄
//
// 機制：
//   - marker 檔（default-library-seeded.json）是「只種一次」的唯一開關——
//     一旦寫入就永遠不再重種，即使之後資料夾被刪、watch_folders 引用被清掉。
//   - seedDefaultLibraryIfFirstEver 只在 Connect() 新增「這台機器第一個帳號」時呼叫。
//   - pruneMissingDefaultLibrary 在 GetState()（前端每秒輪詢的入口）裡自我修復：
//     發現預設庫的實體資料夾已經不在了，就把 watch_folders 裡的殘留路徑拿掉。
import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func defaultLibraryMarkerPath() string {
	return filepath.Join(appDir(), "default-library-seeded.json")
}

type defaultLibraryMarker struct {
	Path     string `json:"path"`
	SeededAt string `json:"seeded_at"`
}

// defaultLibraryDirName 刻意把「可刪除」寫進資料夾名字本身——
// 使用者不用讀任何說明文件，光看資料夾名稱就知道這是我們鋪的示範內容、可以放心刪。
const defaultLibraryDirName = "Arcrun 範例庫（可刪除）"

func defaultLibraryPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Documents", defaultLibraryDirName)
}

// defaultLibraryFiles＝種進預設庫的示範內容（.md，collector 一定讀得懂）。
// 內容本身不重要，重要的是「丟檔案進去 → AI 整理成知識卡 → 搜得到」這條路走得通。
var defaultLibraryFiles = map[string]string{
	"01-關於這個資料夾.md": `# 這個資料夾是什麼

這是 Arcrun 第一次安裝時自動幫你準備的示範資料夾，裡面幾份筆記已經在被整理成知識卡。

- 打開 Arcrun，應該很快就能在你的知識庫裡搜到「Arcrun」「知識卡」這些字。
- 這個資料夾**可以直接刪掉**，刪掉就真的沒了，不會自己跑回來。
- 如果你已經加了自己的資料夾，這個示範資料夾之後也不會再自動出現。
- 想長期使用也可以——把你想存的檔案直接丟進來就行，跟其他資料夾一樣會被自動整理。
`,
	"02-Arcrun-是什麼.md": `# Arcrun 是什麼

Arcrun 是一個跑在背景的小幫手：你把筆記、文件丟進你指定的資料夾，
它會自動讀出內容、用 AI 整理成一張張「知識卡」，送進你自己的知識庫，
之後不管在哪台裝置，打開知識庫網站就能直接搜到。

常見用法：
- 開會筆記、專案文件放進同一個資料夾，事後用關鍵字就找得回來。
- 支援 Markdown、純文字、Word、PowerPoint、PDF、CSV、Excel。
- 掃描版 PDF（沒有文字層的圖片檔）目前還讀不了，其餘格式會自動處理。
`,
	"03-怎麼使用.md": `# 怎麼使用

1. 把檔案拖進被監看的資料夾（就是這個資料夾，或是你之後自己加的資料夾）。
2. Arcrun 會在背景發現變化、用 AI 整理成知識卡、上傳到你的知識庫，不用手動按什麼。
3. 想馬上看到結果，也可以在 App 裡按「立刻同步」。
4. 到你的知識庫網站搜尋，就能找到剛剛整理出來的內容。

如果額度用完或某個檔案讀不了，App 首頁會用白話告訴你發生什麼事、要不要動手——
不會安靜地失敗、也不會丟裸露的錯誤碼給你看。
`,
}

// seedDefaultLibraryIfFirstEver 只在「這台機器第一次連上任何知識庫帳號」時跑一次
// （呼叫端 Connect() 已保證：這是 cfg.Accounts 從空變成非空的那一次新增）。
// marker 檔一旦寫入就是永久開關——不管之後資料夾或 watch_folders 引用發生什麼事，
// 都不會再種第二次。
func seedDefaultLibraryIfFirstEver(cfg *directConfig, accIdx int) {
	if _, err := os.Stat(defaultLibraryMarkerPath()); err == nil {
		return // 已經種過一次，不管現在還在不在，永遠不再種第二次
	}
	path := defaultLibraryPath()
	if err := writeDefaultLibraryContents(path); err != nil {
		appLog("預設庫建立失敗（不影響本次連線）：%v", err)
		return
	}
	if accIdx >= 0 && accIdx < len(cfg.Accounts) {
		already := false
		for _, f := range cfg.Accounts[accIdx].WatchFolders {
			if f == path {
				already = true
				break
			}
		}
		if !already {
			cfg.Accounts[accIdx].WatchFolders = append(cfg.Accounts[accIdx].WatchFolders, path)
			sort.Strings(cfg.Accounts[accIdx].WatchFolders)
		}
	}
	marker := defaultLibraryMarker{Path: path, SeededAt: time.Now().Format(time.RFC3339)}
	if b, err := json.MarshalIndent(marker, "", "  "); err == nil {
		if err := os.MkdirAll(appDir(), 0o755); err == nil {
			_ = os.WriteFile(defaultLibraryMarkerPath(), b, 0o644)
		}
	}
}

// writeDefaultLibraryContents 建資料夾＋寫入示範檔案。已存在的檔案不覆寫
// （理論上不會發生——marker 擋住重複呼叫——但求安全，不要覆蓋使用者可能已經改過的內容）。
func writeDefaultLibraryContents(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for name, body := range defaultLibraryFiles {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			continue
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// pruneMissingDefaultLibrary：預設庫的實體資料夾若已經被使用者刪掉，
// 把 config 裡殘留的 watch_folders 路徑也一起清掉——不留「查得到但資料夾早就不在」
// 的幽靈引用，也不會讓 collector 每輪都對著一個不存在的資料夾報錯。
// 資料夾「會不會長回來」由 seedDefaultLibraryIfFirstEver 的 marker 檔擋住，
// 這裡只負責把 config 清乾淨，不寫回任何實體檔案內容。
// 回傳 changed＝cfg 是否被修改（呼叫端據此決定要不要 saveCfg）。
func pruneMissingDefaultLibrary(cfg *directConfig) bool {
	b, err := os.ReadFile(defaultLibraryMarkerPath())
	if err != nil {
		return false // 從沒種過，沒東西可清
	}
	var marker defaultLibraryMarker
	if jerr := json.Unmarshal(b, &marker); jerr != nil || marker.Path == "" {
		return false
	}
	if _, err := os.Stat(marker.Path); err == nil {
		return false // 資料夾還在，不用清
	}
	changed := false
	for i := range cfg.Accounts {
		keep := cfg.Accounts[i].WatchFolders[:0]
		for _, f := range cfg.Accounts[i].WatchFolders {
			if f == marker.Path {
				changed = true
				continue
			}
			keep = append(keep, f)
		}
		cfg.Accounts[i].WatchFolders = keep
	}
	return changed
}
