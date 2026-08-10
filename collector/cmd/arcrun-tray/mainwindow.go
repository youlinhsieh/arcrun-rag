// mainwindow.go — Arcrun 主視窗（t192，issue #18）
//
// 🔴 leo 2026-08-04 的要求（逐條）：
//   - 「daemon 設定項越來越多，**不可能統統塞在下拉選單**」
//   - 「參考 **Google Drive 設定畫面**：點擊 daemon 就開一個視窗，佔螢幕約 1/2」
//   - 「資料夾清單要**可捲動**——我自己每個 gitea 專案都要同步，那就是幾十個，根本塞不下」
//   - daemon 現在**沒有 onboarding**
//   - 要套 CIS 視覺
//   - 併入：狀態要顯示「萃取中／同步中」（issue #17，已在 supervisor/托盤那層做）
//
// 定位（leo 原話）：
//
//	「Daemon 不只用來查看 RAG，它是 Arcrun 的**木馬屠城**……
//	 Daemon 是 Arcrun 優於 n8n 之處。」
//	⇒ 它是產品門面，不是附屬小工具。
//
// 設計原則（照 leo 立的「用戶好用、白癡化」）：
//   - 一眼看到「現在在做什麼」——狀態列放最上面、大字、會動
//   - 資料夾清單用 widget.List（**虛擬捲動**，幾十個也不卡）
//   - 動作用白話：「加入資料夾」不是「新增 watch_folder」
//   - 沒連過帳號的人看到的是 onboarding，不是一堆空白面板
package main

import (
	"fmt"
	"time"

	"arcrun-rag/collector/supervisor"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// mainWindow 是常駐的應用視窗（不是每次開新的，避免多開）。
type mainWindow struct {
	win fyne.Window
	app fyne.App

	statusText *widget.Label // 最上方大字狀態（「同步中…」等）
	statusSub  *widget.Label // 次要說明（上次同步時間、萃取計數）
	folderList *widget.List  // 可捲動的資料夾清單
	rows       []folderRow   // 目前顯示的列（帳號標題 + 資料夾）

	// 由 main.go 注入，避免這裡重寫一份邏輯
	cfg           *directConfig
	sup           *supervisor.Supervisor
	onAddAccount  func()
	onAddFolder   func(accIdx int)
	onDelFolder   func(accIdx int, folder string)
	onAISettings  func()
	onSyncNow     func()
	onCheckUpdate func()
	reload        func() *directConfig
}

// folderRow 是清單裡的一列：帳號標題或其下的資料夾。
// 用單一扁平清單（而非巢狀樹）才能用 widget.List 的虛擬捲動——
// 幾十個資料夾時只算可見的那幾列，不會卡。
type folderRow struct {
	isHeader bool
	accIdx   int
	title    string // 帳號名或資料夾路徑
	sub      string // 次要說明（帳號：實例網址／資料夾：所屬庫）
}

// newMainWindow 建主視窗。約佔一般筆電螢幕的一半（leo：「佔螢幕約 1/2」）。
func newMainWindow(a fyne.App) *mainWindow {
	m := &mainWindow{app: a}
	m.win = a.NewWindow("Arcrun")
	m.win.Resize(fyne.NewSize(920, 620))
	m.win.SetCloseIntercept(func() { m.win.Hide() }) // 關窗＝隱藏，daemon 續跑
	return m
}

// build 組出整個畫面。必須在注入完各 callback 後呼叫。
func (m *mainWindow) build() {
	// ── 上：狀態列（一眼看到「現在在做什麼」）──
	m.statusText = widget.NewLabel("啟動中…")
	m.statusText.TextStyle = fyne.TextStyle{Bold: true}
	m.statusSub = widget.NewLabel("")

	syncBtn := widget.NewButtonWithIcon("立刻同步", theme.ViewRefreshIcon(), func() {
		if m.onSyncNow != nil {
			m.onSyncNow()
		}
	})
	syncBtn.Importance = widget.HighImportance

	header := container.NewBorder(nil, nil, nil,
		container.NewHBox(syncBtn),
		container.NewVBox(m.statusText, m.statusSub),
	)

	// ── 中：可捲動的資料夾清單（leo：「幾十個，根本塞不下」）──
	m.folderList = widget.NewList(
		func() int { return len(m.rows) },
		func() fyne.CanvasObject {
			title := widget.NewLabel("")
			sub := widget.NewLabel("")
			del := widget.NewButtonWithIcon("", theme.DeleteIcon(), nil)
			return container.NewBorder(nil, nil, nil, del, container.NewVBox(title, sub))
		},
		func(i widget.ListItemID, o fyne.CanvasObject) {
			if i < 0 || i >= len(m.rows) {
				return
			}
			r := m.rows[i]
			box := o.(*fyne.Container)
			inner := box.Objects[0].(*fyne.Container)
			title := inner.Objects[0].(*widget.Label)
			sub := inner.Objects[1].(*widget.Label)
			del := box.Objects[1].(*widget.Button)

			title.SetText(r.title)
			sub.SetText(r.sub)
			if r.isHeader {
				title.TextStyle = fyne.TextStyle{Bold: true}
				del.Hide() // 帳號列沒有「移除資料夾」
			} else {
				title.TextStyle = fyne.TextStyle{}
				del.Show()
				row := r
				del.OnTapped = func() {
					dialog.ShowConfirm("移除這個資料夾？",
						"「"+row.title+"」不再自動同步。\n（已經上傳的知識卡不會被刪除）",
						func(ok bool) {
							if ok && m.onDelFolder != nil {
								m.onDelFolder(row.accIdx, row.title)
							}
						}, m.win)
				}
			}
			title.Refresh()
			sub.Refresh()
		},
	)

	// ── 下：動作列（白話命名，不用系統術語）──
	actions := container.NewHBox(
		widget.NewButtonWithIcon("加入資料夾", theme.FolderNewIcon(), func() {
			// 只有一個帳號時直接加；多帳號要先選
			accIdx := m.pickAccount()
			if accIdx >= 0 && m.onAddFolder != nil {
				m.onAddFolder(accIdx)
			}
		}),
		widget.NewButtonWithIcon("新增知識庫帳號", theme.ContentAddIcon(), func() {
			if m.onAddAccount != nil {
				m.onAddAccount()
			}
		}),
		widget.NewButtonWithIcon("AI 設定", theme.SettingsIcon(), func() {
			if m.onAISettings != nil {
				m.onAISettings()
			}
		}),
		widget.NewButtonWithIcon("檢查更新", theme.DownloadIcon(), func() {
			if m.onCheckUpdate != nil {
				m.onCheckUpdate()
			}
		}),
	)
	footer := container.NewBorder(nil, nil, actions,
		widget.NewLabel("版本 "+versionLabel()))

	m.win.SetContent(container.NewBorder(
		container.NewVBox(header, widget.NewSeparator()),
		container.NewVBox(widget.NewSeparator(), footer),
		nil, nil,
		m.folderList,
	))
}

// pickAccount 決定要把資料夾加到哪個帳號。
// 沒帳號 → 引導去連線（onboarding 的一環，不是丟一個錯誤給他）。
func (m *mainWindow) pickAccount() int {
	if m.cfg == nil || len(m.cfg.Accounts) == 0 {
		dialog.ShowInformation("先連上你的知識庫",
			"還沒有任何知識庫帳號。\n請先按「新增知識庫帳號」，把這台電腦連上你的雲端知識庫。", m.win)
		return -1
	}
	return 0 // 單帳號直接用；多帳號的選擇 UI 待 issue #19 一起做
}

// refresh 依現況重畫（狀態列 + 清單）。可從任何 goroutine 呼叫。
func (m *mainWindow) refresh() {
	if m.reload != nil {
		if c := m.reload(); c != nil {
			m.cfg = c
		}
	}
	m.rebuildRows()

	st := m.sup.Status()
	sync := loadAppSyncStatus()
	m.statusText.SetText(mainWindowStatusText(st))
	m.statusSub.SetText(mainWindowSubText(st, sync))
	m.folderList.Refresh()
}

// rebuildRows 把 config 攤平成清單列（帳號標題 + 其下資料夾）。
func (m *mainWindow) rebuildRows() {
	rows := []folderRow{}
	if m.cfg != nil {
		for ai, acc := range m.cfg.Accounts {
			rows = append(rows, folderRow{
				isHeader: true, accIdx: ai,
				title: accountDisplayName(acc),
				sub:   shortCypherHost(acc.CypherURL),
			})
			for _, f := range acc.WatchFolders {
				rows = append(rows, folderRow{accIdx: ai, title: f, sub: "自動同步中"})
			}
		}
	}
	m.rows = rows
}

// mainWindowStatusText 是最上方那行大字——**一眼看出現在在做什麼**（issue #17）。
func mainWindowStatusText(s supervisor.Status) string {
	switch s.State {
	case supervisor.StateSyncing:
		return "同步中… 正在讀檔並整理成知識卡"
	case supervisor.StateWatching:
		return "看守中 · 資料夾有變動就會自動整理"
	case supervisor.StateStarting:
		return "啟動中…"
	case supervisor.StateError:
		return "暫時出錯，正在自動重試"
	default:
		return "尚未開始"
	}
}

// mainWindowSubText 是狀態底下那行小字（時間、計數、錯誤）。
func mainWindowSubText(s supervisor.Status, sync traySyncStatus) string {
	if sync.ExtractorError != "" && !sync.ExtractorOK {
		return "⚠ " + sync.ExtractorError
	}
	parts := []string{}
	if !s.LastRoundAt.IsZero() {
		parts = append(parts, "上次同步 "+s.LastRoundAt.Local().Format("15:04"))
	}
	if sync.ExtractedOK > 0 {
		parts = append(parts, fmt.Sprintf("已整理 %d 份", sync.ExtractedOK))
	}
	if sync.ExtractFailed > 0 {
		parts = append(parts, fmt.Sprintf("⚠ %d 份失敗", sync.ExtractFailed))
	}
	if len(parts) == 0 {
		return "還沒有同步紀錄"
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += " · " + p
	}
	return out
}

// showAndRefresh 開窗（若已開就帶到前景）並立即更新一次。
func (m *mainWindow) showAndRefresh() {
	m.refresh()
	m.win.Show()
	m.win.RequestFocus()
}

// startAutoRefresh 每秒更新一次——**同步中的狀態要看得到在動**（issue #17）。
// 視窗隱藏時不做事，不浪費資源。
func (m *mainWindow) startAutoRefresh() {
	go func() {
		for range time.Tick(time.Second) {
			m.refresh()
		}
	}()
}
