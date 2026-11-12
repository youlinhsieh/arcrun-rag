package main

// cards.go — 小幫手的「看卡」：依帳號、庫、目錄瀏覽知識卡（inkstone/arcrun-rag#333）
//
// 薄殼：庫清單、目錄、整張卡全是雲端既有三支（Arcrun cypher-executor
// `GET /portal/data/map`、`/portal/data/library-cards`、`/portal/data/card`，Portal 看卡同一組）。
// 本檔只替每個帳號用它自己已存的 portal session 問一次、整理成畫面要的形狀。
// 不另存卡、不快取到磁碟、不輪詢（只有點進去才打網路）、不存密碼。
//
// 沒有做的（雲端還沒有對應能力，寫在票上，不在這裡假裝）：
//   - 「被問過幾次」：雲端沒有被問次數的計數（屬 inkstone/Arcrun#343／#344 那條線）。
//   - 對卡片回覆「補充／內容不對」並由 LLM 回話：雲端沒有收異議的端點（inkstone/Arcrun#344）。
import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// UILibrary＝帳號下的一個庫。
type UILibrary struct {
	Name    string `json:"name"`
	Entries int    `json:"entries"` // 庫裡的內容數（雲端的 entry_count；-1＝雲端還沒算）
}

type UICardsLibs struct {
	AccIdx    int         `json:"accIdx"`
	Libraries []UILibrary `json:"libraries"`
	Note      string      `json:"note,omitempty"` // 雲端對「空」的說明（沒授權／還沒有內容…）
	// NeedsLogin＝這台電腦沒有（或已過期）這個帳號的 portal session，畫面長登入框。
	NeedsLogin bool   `json:"needsLogin"`
	Error      string `json:"error"`
}

type UICardRow struct {
	PageName string `json:"pageName"`
	Gloss    string `json:"gloss"`
	Source   string `json:"source"`
	Blocks   int    `json:"blocks"`
	Updated  int64  `json:"updated"` // unix 秒
}

type UICardsCatalog struct {
	AccIdx     int         `json:"accIdx"`
	Library    string      `json:"library"`
	Cards      []UICardRow `json:"cards"`
	Total      int         `json:"total"` // 庫裡實際有幾張（超過 Cards 長度就是被截斷）
	NeedsLogin bool        `json:"needsLogin"`
	Error      string      `json:"error"`
}

type UICardView struct {
	AccIdx   int      `json:"accIdx"`
	Library  string   `json:"library"`
	PageName string   `json:"pageName"`
	Blocks   []string `json:"blocks"` // 這張卡的每一段（照原稿順序）
	// Origin＝原文在哪（設備／庫／路徑），雲端答不出就空字串，不編。
	Origin     string `json:"origin"`
	NeedsLogin bool   `json:"needsLogin"`
	Error      string `json:"error"`
}

// cardsCall：用帳號 idx 自己的 session 打一次 GET。回 (status, body, needsLogin, errMsg)。
// errMsg 非空＝畫面要顯示的白話錯誤；needsLogin＝要登入框而不是紅字。
func cardsCall(accIdx int, path string, q url.Values) (int, []byte, bool, string) {
	cfg, _ := loadCfg()
	acc, err := accountAt(cfg, accIdx)
	if err != nil {
		return 0, nil, false, err.Error()
	}
	name := accountName(acc)
	base := apiBaseOf(acc)
	if base == "" {
		return 0, nil, false, "「" + name + "」沒有網址，請重新連線一次"
	}
	if !sessionValid(acc) {
		return 0, nil, true, loginExpiredMsg(name)
	}
	full := path
	if len(q) > 0 {
		full += "?" + q.Encode()
	}
	status, raw, err := chatBearer(base, http.MethodGet, full, acc.PortalSession, nil, appReadTimeout)
	if err != nil {
		return 0, nil, false, err.Error()
	}
	if status == http.StatusUnauthorized {
		clearSession(accIdx)
		return status, raw, true, loginExpiredMsg(name)
	}
	return status, raw, false, ""
}

// ListCardLibraries：這個帳號有哪些庫（只回這個帳號有權限的庫，雲端已過濾）。
func (a *App) ListCardLibraries(accIdx int) UICardsLibs {
	out := UICardsLibs{AccIdx: accIdx, Libraries: []UILibrary{}}
	status, raw, needs, msg := cardsCall(accIdx, "/portal/data/map", nil)
	if msg != "" {
		out.NeedsLogin, out.Error = needs, msg
		return out
	}
	if status != http.StatusOK {
		out.Error = cardsErrMessage(status, raw)
		return out
	}
	var b struct {
		Libraries []struct {
			Library    string `json:"library"`
			EntryCount *int   `json:"entry_count"`
		} `json:"libraries"`
		Note string `json:"note"`
	}
	if json.Unmarshal(raw, &b) != nil {
		out.Error = "知識庫回的庫清單看不懂"
		return out
	}
	for _, l := range b.Libraries {
		n := -1
		if l.EntryCount != nil {
			n = *l.EntryCount
		}
		out.Libraries = append(out.Libraries, UILibrary{Name: l.Library, Entries: n})
	}
	sort.SliceStable(out.Libraries, func(i, j int) bool { return out.Libraries[i].Name < out.Libraries[j].Name })
	out.Note = b.Note
	return out
}

// ListLibraryCards：一個庫的目錄（每張卡一列）。
func (a *App) ListLibraryCards(accIdx int, library string) UICardsCatalog {
	out := UICardsCatalog{AccIdx: accIdx, Library: library, Cards: []UICardRow{}}
	status, raw, needs, msg := cardsCall(accIdx, "/portal/data/library-cards", url.Values{"library": {library}, "limit": {"200"}})
	if msg != "" {
		out.NeedsLogin, out.Error = needs, msg
		return out
	}
	if status == http.StatusNotFound {
		out.Error = "找不到這個庫（可能已被移除，或你沒有它的權限）"
		return out
	}
	if status != http.StatusOK {
		out.Error = cardsErrMessage(status, raw)
		return out
	}
	var b struct {
		Cards []struct {
			PageName   string  `json:"page_name"`
			BlockCount int     `json:"block_count"`
			Gloss      *string `json:"gloss"`
			SourcePath *string `json:"source_path"`
			UpdatedAt  int64   `json:"updated_at"`
		} `json:"cards"`
		Total int `json:"total"`
	}
	if json.Unmarshal(raw, &b) != nil {
		out.Error = "知識庫回的卡片目錄看不懂"
		return out
	}
	for _, c := range b.Cards {
		row := UICardRow{PageName: c.PageName, Blocks: c.BlockCount, Updated: c.UpdatedAt}
		if c.Gloss != nil {
			row.Gloss = *c.Gloss
		}
		if c.SourcePath != nil {
			row.Source = *c.SourcePath
		}
		out.Cards = append(out.Cards, row)
	}
	out.Total = b.Total
	if out.Total < len(out.Cards) {
		out.Total = len(out.Cards)
	}
	return out
}

var anchorRe = regexp.MustCompile(`#(\d+)$`)

// blockOrder：卡的每一段在原稿裡的第幾段（metadata_json.source 結尾的 #N）；沒有就排最後。
func blockOrder(meta string) int {
	var m struct {
		Source string `json:"source"`
	}
	if json.Unmarshal([]byte(meta), &m) == nil {
		if g := anchorRe.FindStringSubmatch(m.Source); g != nil {
			if n, err := strconv.Atoi(g[1]); err == nil {
				return n
			}
		}
	}
	return 1 << 30
}

// GetLibraryCard：整張卡（它的每一段）＋原文位置。
func (a *App) GetLibraryCard(accIdx int, library, pageName string) UICardView {
	out := UICardView{AccIdx: accIdx, Library: library, PageName: pageName, Blocks: []string{}}
	status, raw, needs, msg := cardsCall(accIdx, "/portal/data/card", url.Values{"library": {library}, "page_name": {pageName}})
	if msg != "" {
		out.NeedsLogin, out.Error = needs, msg
		return out
	}
	if status == http.StatusNotFound {
		out.Error = "找不到這張卡（可能已被下架，或你沒有這個庫的權限）"
		return out
	}
	if status != http.StatusOK {
		out.Error = cardsErrMessage(status, raw)
		return out
	}
	var b struct {
		Entries []struct {
			Content      string `json:"content"`
			MetadataJSON string `json:"metadata_json"`
		} `json:"entries"`
		Location *struct {
			Machine  string `json:"machine"`
			FullPath string `json:"full_path"`
			Source   string `json:"source_path"`
		} `json:"location"`
	}
	if json.Unmarshal(raw, &b) != nil {
		out.Error = "知識庫回的卡看不懂"
		return out
	}
	sort.SliceStable(b.Entries, func(i, j int) bool {
		return blockOrder(b.Entries[i].MetadataJSON) < blockOrder(b.Entries[j].MetadataJSON)
	})
	for _, e := range b.Entries {
		if s := strings.TrimSpace(e.Content); s != "" {
			out.Blocks = append(out.Blocks, s)
		}
	}
	if b.Location != nil {
		p := b.Location.FullPath
		if p == "" {
			p = b.Location.Source
		}
		if p != "" && b.Location.Machine != "" {
			out.Origin = b.Location.Machine + " › " + p
		} else {
			out.Origin = p
		}
	}
	return out
}

func cardsErrMessage(status int, raw []byte) string {
	if status == http.StatusNotFound {
		return "這個知識庫還沒有看卡功能（雲端版本較舊，更新後就會有）"
	}
	return appErrMessage(status, raw)
}
