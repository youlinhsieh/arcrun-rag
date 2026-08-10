package main

import (
	"strings"
	"testing"
	"time"

	"arcrun-rag/collector/supervisor"
)

// t192/#17：正在跑就要**看得出來在跑**。
// leo：「按『立刻同步』後很快就回到『看守中』，看起來好像就做完了，
//        這時使用者一看沒做完啊，就覺得是 bug」。
func TestMainWindowStatusShowsSyncing(t *testing.T) {
	cases := []struct {
		name  string
		state supervisor.State
		want  string
	}{
		{"同步中要講在做什麼", supervisor.StateSyncing, "同步中"},
		{"看守中", supervisor.StateWatching, "看守中"},
		{"啟動中", supervisor.StateStarting, "啟動中"},
		{"出錯要說會自動重試", supervisor.StateError, "重試"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := mainWindowStatusText(supervisor.Status{State: c.state})
			if !strings.Contains(got, c.want) {
				t.Errorf("state=%s → %q，應含 %q", c.state, got, c.want)
			}
		})
	}
}

// 同步中的文案必須說明「正在做什麼」，不能只寫兩個字讓人乾等。
func TestSyncingTextExplainsWhatItIsDoing(t *testing.T) {
	got := mainWindowStatusText(supervisor.Status{State: supervisor.StateSyncing})
	if !strings.Contains(got, "讀檔") && !strings.Contains(got, "知識卡") {
		t.Errorf("同步中應說明正在做什麼，got %q", got)
	}
}

// 副標：有錯誤時**優先顯示錯誤**（不能被「上次同步 12:34」蓋掉）。
func TestSubTextPrioritisesError(t *testing.T) {
	got := mainWindowSubText(
		supervisor.Status{LastRoundAt: time.Now()},
		traySyncStatus{ExtractorOK: false, ExtractorError: "還沒連上知識庫"},
	)
	if !strings.Contains(got, "還沒連上知識庫") {
		t.Errorf("有錯誤時應優先顯示，got %q", got)
	}
}

// 副標：正常時要看得到「上次同步時間」與「已整理幾份」。
func TestSubTextShowsProgress(t *testing.T) {
	got := mainWindowSubText(
		supervisor.Status{LastRoundAt: time.Date(2026, 8, 4, 21, 5, 0, 0, time.Local)},
		traySyncStatus{ExtractorOK: true, ExtractedOK: 3, ExtractFailed: 1},
	)
	for _, want := range []string{"21:05", "已整理 3", "1 份失敗"} {
		if !strings.Contains(got, want) {
			t.Errorf("副標應含 %q，got %q", want, got)
		}
	}
}

// 沒同步過時不能顯示空白（空白＝用戶不知道是壞了還是還沒開始）。
func TestSubTextNeverEmpty(t *testing.T) {
	got := mainWindowSubText(supervisor.Status{}, traySyncStatus{ExtractorOK: true})
	if strings.TrimSpace(got) == "" {
		t.Error("副標不可空白——用戶會分不清是壞了還是還沒開始")
	}
}

// t192/#18：資料夾清單攤平——帳號一列標題，其下每個資料夾各一列。
// 用扁平清單才能吃 widget.List 的虛擬捲動（leo：「幾十個，根本塞不下」）。
func TestRebuildRowsFlattensAccountsAndFolders(t *testing.T) {
	m := &mainWindow{cfg: &directConfig{Accounts: []accountCfg{
		{InstanceName: "geek6688", CypherURL: "https://a.workers.dev", WatchFolders: []string{"/p/one", "/p/two"}},
		{InstanceName: "youlin", CypherURL: "https://b.workers.dev", WatchFolders: []string{"/p/three"}},
	}}}
	m.rebuildRows()

	if len(m.rows) != 5 { // 2 標題 + 3 資料夾
		t.Fatalf("應攤平成 5 列，got %d：%+v", len(m.rows), m.rows)
	}
	if !m.rows[0].isHeader || m.rows[0].title != "geek6688" {
		t.Errorf("第 0 列應是帳號標題 geek6688，got %+v", m.rows[0])
	}
	if m.rows[1].isHeader || m.rows[1].title != "/p/one" {
		t.Errorf("第 1 列應是資料夾 /p/one，got %+v", m.rows[1])
	}
	// 刪除要作用在正確帳號上（t101 踩過：刪錯帳號的資料夾）
	if m.rows[4].accIdx != 1 {
		t.Errorf("第 4 列（youlin 的資料夾）accIdx 應為 1，got %d", m.rows[4].accIdx)
	}
}

// 幾十個資料夾也要能攤平（不是為了效能，是確保沒有隱藏上限）。
func TestRebuildRowsHandlesManyFolders(t *testing.T) {
	folders := make([]string, 60)
	for i := range folders {
		folders[i] = "/gitea/project-" + string(rune('a'+i%26))
	}
	m := &mainWindow{cfg: &directConfig{Accounts: []accountCfg{
		{InstanceName: "leo", CypherURL: "https://x.workers.dev", WatchFolders: folders},
	}}}
	m.rebuildRows()
	if len(m.rows) != 61 {
		t.Errorf("60 個資料夾＋1 標題應為 61 列，got %d", len(m.rows))
	}
}

// 沒有任何帳號時清單是空的（走 onboarding，不是顯示壞掉的空面板）。
func TestRebuildRowsEmptyWhenNoAccount(t *testing.T) {
	m := &mainWindow{cfg: &directConfig{}}
	m.rebuildRows()
	if len(m.rows) != 0 {
		t.Errorf("無帳號時應為空清單，got %d 列", len(m.rows))
	}
}
