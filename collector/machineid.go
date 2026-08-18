// machineid.go — 這台機器是誰（`inkstone/mira#6`，leo 2026-08-18 拍板）。
//
// 🔴 它解的缺口只有一格：
//
//	雲端每一則知識都答得出「原稿在哪個資料夾、哪個檔、第幾段」
//	（`kb://RFP/design.md#0`），**唯獨答不出「在哪一台機器上」**。
//	leo 原話：「公用庫有多個人在維護，原稿要跟不同的人拿⋯⋯掛上資料夾至少先給一個 ID，
//	例如 `youlinhsieh@Leo-MBA`，他再自己去改『教育部 Leo 的 Mac』。」
//	⇒ 這個值的用途**不是技術識別，是「知道該去找誰拿原稿」**。
//
// 三層，由強到弱（leo 定的最低要求：「預編的辨識資料就看能抓到什麼，
// 如果什麼都抓不到，**至少知道 A 電腦和 B 電腦不同**」）：
//
//	① 抓得到 ⇒ 用真實可讀的名字：`<使用者>@<主機名>`（＝leo 舉的那個例子本身）
//	② 使用者要改 ⇒ config.json 的 `machine_label` 覆蓋顯示名（ID 不動）
//	③ 什麼都抓不到 ⇒ `unknown@<隨機 8 hex>`，**保證兩台不會被當成同一台**
//
// 🔴 為什麼 ID 一鑄就不再重算（`machine.json`）：
//
//	`user@host` 是**會變**的東西——leo 在 macOS 改一次電腦名稱，重算就會得到新 ID，
//	那台機器上的舊知識會突然掛到一個「新機器」底下，樹上憑空多一支。
//	所以第一次算完就寫進 `<設定目錄>/machine.json`，之後**只讀不算**。
//	要改的是顯示名（第②層），那條路不碰 ID。
//
// 🔴 為什麼 ID／顯示名分兩個檔案位置：
//
//	`machine.json`＝機器自己鑄的身分（使用者不必知道它存在）；
//	`config.json` 的 `machine_label`＝**使用者設定**，而使用者設定在本專案一律住 config
//	（direct.go：「設定只走檔案/環境，不落 code」）。一種設定一個家，不開第二條路。
//
// 與 `library` 是同一個形狀（照既有寫法走，不新增第二種做法）：
// `library` 是「這份原稿在哪個**資料夾**」，`machine` 是「這份原稿在哪台**機器**」——
// 兩者都逐筆隨 payload 送上雲、都寫進 metadata_json／三元組 slot、
// 都在下架比對時當「兩邊都有值才收緊」的那一維（arcrun-rag#46 立的規則）。
package collector

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

// MachineIdentity 是這台機器對雲端的自我介紹。
//
// ID 進資料（比對鍵，永不變）；Label 給人看（可改，只影響顯示）。
type MachineIdentity struct {
	// ID＝鑄好就不變的機器識別。這是**比對鍵**：同一份相對路徑來自兩台機器時，
	// 只有它分得開（見 rag_ingest_card 的 pick_stale／rag_takedown_direct 的 build_deprecations）。
	ID string `json:"id"`
	// Label＝人看得懂的稱呼。預設等於 ID；使用者在 config.json 設 `machine_label` 後以它為準。
	Label string `json:"label"`
	// Host／User＝鑄 ID 當時**實際抓到**什麼（抓不到就是空字串）。
	// 留著是為了誠實：日後要判斷「這個 ID 是真的認出來的、還是隨機湊的」，看這兩格。
	Host string `json:"host,omitempty"`
	User string `json:"user,omitempty"`
	// Minted＝這一次呼叫是否**現鑄**（true）還是讀既有的（false）。不落檔，只給呼叫端記錄用。
	Minted bool `json:"-"`
}

// machineFileName 是身分檔的檔名（住在 config/manifest 同一個目錄）。
const machineFileName = "machine.json"

// unknownMachinePrefix＝三層裡的第③層（什麼都抓不到）。前綴保留可讀性：
// 使用者在 portal 看到 `unknown@3f2a1b9c` 也知道「這台沒認出來」，而不是看到一串亂碼。
const unknownMachinePrefix = "unknown@"

// ResolveMachine 回答「我是哪一台」。
//
// stateDir＝身分檔要住的目錄（實務上＝config.json／manifest 所在的 ~/.arcrun-rag）。
// labelOverride＝config.json 的 machine_label（空字串＝使用者沒設）。
//
// 永不回錯誤：認不出來就走第③層（隨機但唯一），**寧可誠實地給一個「不知道是誰」的唯一 ID，
// 也不要讓兩台機器共用一個空值**——空值會讓雲端把兩台的東西併成一份，那正是本題要防的。
// 寫檔失敗也不擋（唯讀目錄／權限問題）：這一輪照跑，只是下一輪會重鑄 ID。
// stateDir 給空字串＝**不落檔**（只在記憶體裡鑄一個）。這是給「還沒有狀態目錄」的
// 呼叫端（測試、--dry-run 的臨時 config）用的：與其把 machine.json 亂寫進當下的工作目錄，
// 不如不寫——身分檔的家只有一個，就是 daemon 的狀態目錄。
func ResolveMachine(stateDir, labelOverride string) MachineIdentity {
	persist := strings.TrimSpace(stateDir) != ""
	path := filepath.Join(stateDir, machineFileName)
	id := MachineIdentity{}

	// 既有身分優先——ID 一鑄就不再重算（改機器名不該產生第二台機器）。
	if b, err := os.ReadFile(path); err == nil && persist {
		var saved MachineIdentity
		if json.Unmarshal(b, &saved) == nil && strings.TrimSpace(saved.ID) != "" {
			id = saved
		}
	}

	if strings.TrimSpace(id.ID) == "" {
		id = mintMachineIdentity()
		id.Minted = true
		// 寫回：值本身沒有機敏性（一個使用者名＋主機名），但它必須跨重啟保持一致。
		if b, err := json.MarshalIndent(id, "", "  "); err == nil && persist {
			_ = os.MkdirAll(stateDir, 0o755)
			_ = os.WriteFile(path, append(b, '\n'), 0o600)
		}
	}

	// 顯示名：使用者設定 > 鑄的時候存下的 > ID 本身。
	if l := strings.TrimSpace(labelOverride); l != "" {
		id.Label = sanitizeMachinePart(l)
	}
	if strings.TrimSpace(id.Label) == "" {
		id.Label = id.ID
	}
	return id
}

// mintMachineIdentity 鑄一個新身分（只在沒有既有身分時走這裡）。
func mintMachineIdentity() MachineIdentity {
	host := sanitizeMachinePart(shortHostname())
	who := sanitizeMachinePart(currentUserName())

	switch {
	case who != "" && host != "":
		// 第①層：leo 舉的那個形狀。
		return MachineIdentity{ID: who + "@" + host, Label: who + "@" + host, Host: host, User: who}
	case host != "":
		return MachineIdentity{ID: "unknown@" + host, Label: "unknown@" + host, Host: host}
	case who != "":
		// 有人沒機器名：仍要保證兩台不同 ⇒ 補隨機尾碼（同一個使用者名可能出現在多台機器上）。
		id := who + "@" + randomMachineSuffix()
		return MachineIdentity{ID: id, Label: id, User: who}
	default:
		// 第③層：什麼都抓不到。唯一性是唯一還撐得住的保證。
		id := unknownMachinePrefix + randomMachineSuffix()
		return MachineIdentity{ID: id, Label: id}
	}
}

// shortHostname 取主機名的第一段：`Leo-MBA.local` → `Leo-MBA`。
// macOS 的 os.Hostname() 常帶 `.local`／`.lan`，那是網路後綴不是機器名，
// 留著會讓 leo 在畫面上看到 `youlinhsieh@Leo-MBA.local`——比他要的難讀。
func shortHostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	h = strings.TrimSpace(h)
	if i := strings.Index(h, "."); i > 0 {
		h = h[:i]
	}
	// 認不出來的預設值不算「抓到了」——`localhost` 每台都一樣，用它當 ID 等於把所有機器
	// 合成一台，正是本題要防的事。
	if strings.EqualFold(h, "localhost") {
		return ""
	}
	return h
}

// currentUserName 取登入帳號（不是全名）。Windows 上 os/user 會回 `DOMAIN\user`，取後半。
func currentUserName() string {
	u, err := user.Current()
	if err != nil || u == nil {
		return ""
	}
	name := strings.TrimSpace(u.Username)
	if i := strings.LastIndexAny(name, `\/`); i >= 0 {
		name = name[i+1:]
	}
	return name
}

// randomMachineSuffix 產生 8 個 hex 字元。取不到亂數時退回 os.Getpid()＋時間也不夠穩，
// 所以直接讓它空——呼叫端會得到空字串，那時 ID 只剩前綴，**這種情況要看得出來**，
// 不要用一個看起來正常的假值蓋過去。
func randomMachineSuffix() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

// sanitizeMachinePart 清掉會讓值在 JSON／URL／畫面上出事的字元，並限長。
//
// 保留 CJK（leo 要打「教育部 Leo 的 Mac」），只砍控制字元、引號、斜線與換行——
// 這個值會進 metadata_json 字串與三元組 slot，不該有能提前結束字串的字元。
func sanitizeMachinePart(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f: // 控制字元
			continue
		case r == '"' || r == '\\' || r == '/':
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	// 限長：機器名不該是一篇文章。以 rune 計，避免把 UTF-8 切壞。
	rs := []rune(out)
	if len(rs) > 64 {
		out = strings.TrimSpace(string(rs[:64]))
	}
	return out
}
