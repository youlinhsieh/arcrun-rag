package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// ── 使用者手動「強制收錄」的逃生口（inkstone/arcrun-rag#136 驗收 5／6／7）────────
//
// leo 的原話（c5097，2026-08-28）：
//
//	「只是想知道哪些資料夾裡有檔，如果有檔案沒掃，可以強制加入，
//	 例如看到程式碼就是要萃，這是他的自由。」
//
// 本票原本只做到「看得到」（哪些資料夾被跳過、為什麼）；這裡補的是「做得到」——
// 使用者站在畫面上一個被跳過的資料夾，自己就能把它收進來，而且：
//   - 記得住（驗收 6）：這份決定寫在檔案裡，下一輪掃描照樣生效，不是只在記憶體。
//   - 收得回（驗收 7）：他改變主意時，把那筆拿掉即可。
//
// 🔴 紅線（c5097）：**不改預設判準**。預設仍然是「開發專案只讀文件區」，
//    這份清單只是**由使用者自己開的例外**——空的時候整套邏輯與從前一模一樣。
// 🔴 紅線（c5097）：**不做成要編設定檔才會的功能**。使用者不碰這個檔，
//    寫入者只有 App（按鈕），這裡只提供讀寫的原語。與 RetiringFolders 同一套
//    「一個寫入者」的道理（見 AccountConfig.RetiringFolders）。
//
// 為什麼另立一個檔、不塞進 config.json：config.json 由 collector 與 App 兩個行程
// 各自用不同的 struct 讀寫，多一個欄位就多一處會靜默漂移的地方（見 app.go accountCfg
// 檔頭那條 t108 教訓）。這份清單只有 App 寫、collector 讀，獨立一個檔最不會互相蓋掉。

// ForceIncludeStoreName＝逃生口清單的檔名，與 config.json／folder-trees.json 同住工作區目錄。
const ForceIncludeStoreName = "folder-includes.json"

// ForceIncludeStore＝監看根（絕對路徑）→ 使用者強制要收的子資料夾（相對 slash 路徑）清單。
//
// key 一律經過 normalizeIncludeRoot（filepath.Clean + ToSlash），value 裡的每一筆
// 也一律 ToSlash 且去掉頭尾斜線——與 IngestPlan.forceIncluded 比對時才對得起來。
type ForceIncludeStore struct {
	Roots map[string][]string `json:"roots"`
	mu    sync.Mutex
}

// ForceIncludeStorePath 回傳逃生口清單檔的完整路徑——與 manifest／folder-trees.json
// 同住工作區目錄。刻意與 FolderTreeStorePath 同樣「吃 manifest 路徑」的簽名，App 與
// collector 兩個行程才會用同一句話算出同一個檔（實務上都是 ~/.arcrun-rag/）。
func ForceIncludeStorePath(manifestPath string) string {
	return filepath.Join(filepath.Dir(manifestPath), ForceIncludeStoreName)
}

func normalizeIncludeRoot(absRoot string) string {
	return filepath.ToSlash(filepath.Clean(absRoot))
}

func normalizeIncludeRel(rel string) string {
	rel = filepath.ToSlash(rel)
	rel = strings.Trim(rel, "/")
	if rel == "" || rel == "." {
		return ""
	}
	return filepath.Clean(rel)
}

// LoadForceIncludeStore 讀出逃生口清單。檔案不存在＝空清單（不是錯誤——
// 絕大多數使用者從來不會開任何例外，那是正常狀態，不該讓呼叫端每次都處理 error）。
func LoadForceIncludeStore(path string) *ForceIncludeStore {
	s := &ForceIncludeStore{Roots: map[string][]string{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	// 壞掉的檔（手動亂改／寫到一半斷電）當成空的，不讓它把整輪掃描帶下水。
	_ = json.Unmarshal(b, s)
	if s.Roots == nil {
		s.Roots = map[string][]string{}
	}
	return s
}

// For 回傳這個監看根底下、使用者強制要收的子資料夾清單（相對 slash 路徑）。
func (s *ForceIncludeStore) For(absRoot string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.Roots[normalizeIncludeRoot(absRoot)]...)
}

// Add 把一個子資料夾加進強制收錄清單，回報有沒有真的變動（已經在清單裡＝沒變）。
func (s *ForceIncludeStore) Add(absRoot, rel string) bool {
	rel = normalizeIncludeRel(rel)
	if rel == "" {
		return false // 收整個根不需要逃生口——那本來就會被走訪／收檔
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	root := normalizeIncludeRoot(absRoot)
	for _, existing := range s.Roots[root] {
		if existing == rel {
			return false
		}
	}
	s.Roots[root] = append(s.Roots[root], rel)
	sort.Strings(s.Roots[root])
	return true
}

// Remove 把一個子資料夾從強制收錄清單拿掉（驗收 7 的收回）。
// 回報有沒有真的變動。清空後的根會從 map 裡刪掉，檔案不留空殼。
func (s *ForceIncludeStore) Remove(absRoot, rel string) bool {
	rel = normalizeIncludeRel(rel)
	s.mu.Lock()
	defer s.mu.Unlock()
	root := normalizeIncludeRoot(absRoot)
	cur := s.Roots[root]
	out := cur[:0:0]
	changed := false
	for _, existing := range cur {
		if existing == rel {
			changed = true
			continue
		}
		out = append(out, existing)
	}
	if !changed {
		return false
	}
	if len(out) == 0 {
		delete(s.Roots, root)
	} else {
		s.Roots[root] = out
	}
	return changed
}

// Save 把清單寫回磁碟（0o600，與 config.json 同權限——它記的是使用者的選擇，不是機敏值，
// 但沒有理由比 config 寬）。空清單也照寫，讓「我全部收回了」這件事落地。
func (s *ForceIncludeStore) Save(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Roots == nil {
		s.Roots = map[string][]string{}
	}
	out, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o600)
}
