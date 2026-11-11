// selfheal.go — 送不上去時：先自己判斷、自己修；修不了才問用戶要不要通報（inkstone/arcrun-rag#330）。
//
// leo 2026-11-11 原話：「小幫手出問題告訴用戶沒用」「我是用戶，你跟我講有問題我也沒辦法，但我找出問題
// 無法修復說我要通報問題你同意寄出，用戶會覺得被服務了」。
//
// 每個沒送達的原因分類（ledger kind）只會落在四種處理之一，**畫面與雲端看到的是同一個答案**：
//
//	self_heal    小幫手自己在修／等它自己好（退避重試、換新連線、等額度重置、等這台電腦連上網路）。不打擾用戶。
//	user_action  只有用戶動手才解得開（目前只有「這個網路要先登入」）。才跳提醒，而且寫出那個動作。
//	asked        自己修不了（連續失敗、續試也用完了），已在小幫手畫面問用戶「要不要通報給開發團隊」。
//	reported     用戶按了同意、已寄出，帶 AHub 票號。之後只顯示「已通報、處理中」。
//
// 用戶按「不用了」＝回到 self_heal，同一個原因 7 天內不再問（原因變了就是另一個原因，會再問）。
// 🔴 不准背著用戶送：進 reported 的唯一路徑是 App 端用戶按「同意通報」（cmd/arcrun-app/stalls.go），
// 這裡只負責「算」與「記」。
package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// 處理方式（ledger_summary.reasons[].handling）——名稱是協定，與 inkstone/Arcrun#378 對齊。
const (
	HandlingSelfHeal   = "self_heal"
	HandlingUserAction = "user_action"
	HandlingAsked      = "asked"
	HandlingReported   = "reported"
)

// 用戶要動手的動作（ledger_summary.reasons[].user_action）。
const UserActionLoginNetwork = "login_network"

// 記在 help-state.json 的用戶決定。
const (
	HelpStateReported = "reported"
	HelpStateDeclined = "declined"
)

const (
	helpDeclinedTTL = 7 * 24 * time.Hour  // 說「不用了」之後，同一個原因多久內不再問
	helpReportedTTL = 30 * 24 * time.Hour // 已通報的記錄留多久（之後同樣原因再卡住會再問；事件鍵會併進同一張票）
)

// HelpEntry＝用戶對「某知識庫＋某原因」的決定。
type HelpEntry struct {
	State  string `json:"state"` // reported｜declined
	At     string `json:"at"`    // RFC3339
	Ticket string `json:"ticket,omitempty"`
	// 畫面「已修好」那一張卡要寫是哪個知識庫的哪件事：問題沒了之後，原本的分組就算不出來了，所以當下記一份。
	Account string `json:"account,omitempty"`
	Label   string `json:"label,omitempty"`
}

// HelpStore＝~/.arcrun-rag/help-state.json。小幫手畫面（App）寫、collector 讀——
// 兩個行程，所以走檔案；原子寫入。
type HelpStore struct {
	Items map[string]HelpEntry `json:"items"`
}

// HelpStatePath＝跟 manifest 放同一個狀態目錄（同 StatusFilePath 的做法）。
func HelpStatePath(manifestBase string) string {
	return filepath.Join(filepath.Dir(manifestBase), "help-state.json")
}

// HelpKey＝（知識庫 host, 原因分類）。
func HelpKey(host, kind string) string { return host + "|" + kind }

// LoadHelpStore 讀不到／壞掉＝空的（不擋任何事）。
func LoadHelpStore(path string) *HelpStore {
	s := &HelpStore{Items: map[string]HelpEntry{}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, s)
	}
	if s.Items == nil {
		s.Items = map[string]HelpEntry{}
	}
	return s
}

// Save 原子寫入。
func (s *HelpStore) Save(path string) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".help-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, path)
}

// Lookup 回這個（host, kind）還有效的決定。過期的當作沒有。
func (s *HelpStore) Lookup(host, kind string, now time.Time) (HelpEntry, bool) {
	if s == nil {
		return HelpEntry{}, false
	}
	e, ok := s.Items[HelpKey(host, kind)]
	if !ok {
		return HelpEntry{}, false
	}
	at, err := time.Parse(time.RFC3339, e.At)
	if err != nil {
		return HelpEntry{}, false
	}
	ttl := helpDeclinedTTL
	if e.State == HelpStateReported {
		ttl = helpReportedTTL
	}
	if now.Sub(at) > ttl {
		return HelpEntry{}, false
	}
	return e, true
}

// Set 記下用戶的決定（呼叫端負責 Save）。
func (s *HelpStore) Set(host, kind string, e HelpEntry) {
	if s.Items == nil {
		s.Items = map[string]HelpEntry{}
	}
	s.Items[HelpKey(host, kind)] = e
}

// Diagnosis＝一個原因分類現在該怎麼處理（不含用戶已做的決定）。
type Diagnosis struct {
	Handling   string // self_heal｜user_action｜asked（asked＝該問用戶，用戶還沒回答）
	UserAction string // 只在 user_action
}

// Diagnose 判斷一個原因分類現在該怎麼處理。
//
//	askable＝這個分類裡「自己修不了」的檔數：連續失敗滿門檻，而且自動續試也用完了（stalledEntry），
//	         又不是「不支援的格式」那種告訴用戶就好的事。
//
// 分類的處置（每一條都是在回答「這件事，用戶能做什麼？」）：
//
//	login_required   用戶要先登入那個網路 → user_action（唯一一個）
//	network          這台電腦沒連上網路：用戶沒什麼能做的，連上就自動續送 → self_heal
//	quota            額度用完：等隔天重置，用戶沒有可做的事 → self_heal
//	connection_cut／cloud_slow／unreadable／other
//	                 小幫手自己退避重試；續試也用完還是不過＝只有開發團隊能修 → asked
func Diagnose(kind string, askable int) Diagnosis {
	switch kind {
	case LedgerKindLoginRequired:
		return Diagnosis{Handling: HandlingUserAction, UserAction: UserActionLoginNetwork}
	case LedgerKindNetwork, LedgerKindQuota:
		return Diagnosis{Handling: HandlingSelfHeal}
	}
	if askable > 0 {
		return Diagnosis{Handling: HandlingAsked}
	}
	return Diagnosis{Handling: HandlingSelfHeal}
}

// resolveHandling＝Diagnose ＋ 用戶已做的決定 → 最後寫進 ledger_summary 的那個答案。
func resolveHandling(host, kind string, askable int, store *HelpStore, now time.Time) (LedgerReason, bool) {
	d := Diagnose(kind, askable)
	var r LedgerReason
	r.Handling, r.UserAction = d.Handling, d.UserAction
	if e, ok := store.Lookup(host, kind, now); ok && d.Handling != HandlingUserAction {
		switch e.State {
		case HelpStateReported:
			r.Handling, r.UserAction = HandlingReported, ""
			r.Ticket, r.ReportedAt = e.Ticket, e.At
		case HelpStateDeclined:
			r.Handling, r.UserAction = HandlingSelfHeal, ""
		}
	}
	return r, true
}
