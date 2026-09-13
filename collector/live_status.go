// live_status.go — 一輪還沒跑完，畫面也要知道做到哪（`inkstone/arcrun-rag#200`）。
//
// 🔴 病（2026-09-13 leo 截圖，小幫手 0.18.52）：
// 「同步中… 正在讀檔並整理成知識卡」，ISEP 每一層都是 0 / N，leo：「它沒有跑任何一個東西」。
// 實查同一時段：
//
//	status.json         最後修改 12:00（上一個版本收工那次），之後一次都沒寫
//	folder-trees.json   ISEP 那棵的 generated_at 是 23:38（**開始處理之前**），synced 全部 0
//	ISEP 的 manifest    23:53 已經記下 11 份送上雲端；AR-Mira 查得到 isep/README.md 的卡
//
// ⇒ 不是沒跑，是**跑了但一個字都沒回寫**。兩份給畫面看的檔都只在固定時點寫：
//
//	① status.json 只在整輪收工時寫——三個帳號、每發雲端 24〜57 秒，一輪是好幾個小時
//	② 樹只在「掃描完、開始送之前」寫一次（#153 第二輪搬的），那時分子必然還是 0；
//	   收工那次合併用的也是**同一棵開工前的樹**，所以就算整輪跑完，數字還是 0。
//
// 這支檔只做一件事：讓 roundGuard（本來就跟著整輪走、每個帳號每個資料夾共用的那一份）
// 在**事情發生的當下**把「做到哪」寫進 status.json。數字本身不另算：
// 資料夾進度是 (*Manifest).Progress() 的原件，樹是 BuildFolderTree 的原件——
// 與收工那次同一個函式，只是早一點寫。
package collector

import "time"

// folderSnapshot＝某個看守資料夾此刻的進度（寫進 status.json 的 folder_progress）。
type folderSnapshot struct {
	root     string
	progress SyncProgress
}

// beginRound 標記「一輪開始了」，並記住狀態檔在哪。statusPath 空＝不寫（dry-run／沒有 manifest）。
func (g *roundGuard) beginRound(statusPath string, now time.Time) {
	if g == nil || statusPath == "" {
		return
	}
	g.mu.Lock()
	g.statusPath = statusPath
	g.live = RoundProgress{StartedAt: now.Format(time.RFC3339)}
	g.mu.Unlock()
	g.persistLive(nil)
}

// enterFolder 標記「現在輪到哪個知識庫的哪個資料夾」。folder 空＝帳號層的事（探測雲端 AI 之類）。
func (g *roundGuard) enterFolder(account, folder string) {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.live.Account, g.live.Folder = account, folder
	g.live.Step, g.live.StepSince, g.live.Waiting = "", "", nil
	g.mu.Unlock()
	g.persistLive(nil)
}

// stepStarted 標記「開始做某件雲端呼叫」。由 openGate 呼叫——每一發雲端呼叫都經過那道閘，
// 所以不必在每個呼叫端各自記得寫（「忘了接」這個失敗模式不該存在）。
func (g *roundGuard) stepStarted(step callStep, at time.Time) {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.live.Step = step.Name
	g.live.StepSince = at.Format(time.RFC3339)
	g.live.Waiting = nil
	g.mu.Unlock()
	g.persistLive(nil)
}

// noteWaiting 標記「那件事已經等很久了」——這就是「卡在哪一步」。
func (g *roundGuard) noteWaiting(s StalledCall) {
	if g == nil {
		return
	}
	g.mu.Lock()
	w := s
	g.live.Waiting = &w
	g.mu.Unlock()
	g.persistLive(nil)
}

// stepDone 那件事回來了：如果畫面上正掛著「還在等它」，拿掉。
func (g *roundGuard) stepDone(step callStep) {
	if g == nil {
		return
	}
	g.mu.Lock()
	clear := g.live.Waiting != nil && g.live.Waiting.Step == step.Name
	if clear {
		g.live.Waiting = nil
	}
	g.mu.Unlock()
	if clear {
		g.persistLive(nil)
	}
}

// fileFinished 一份檔處理完了（outcome：ingested／failed／其他）。
// progress＝那個資料夾此刻的 (*Manifest).Progress()。
func (g *roundGuard) fileFinished(root, outcome string, progress SyncProgress) {
	if g == nil {
		return
	}
	g.mu.Lock()
	switch outcome {
	case "ingested":
		g.live.Ingested++
	case "failed":
		g.live.Failed++
	}
	g.live.Waiting = nil
	g.mu.Unlock()
	g.persistLive(&folderSnapshot{root: root, progress: progress})
}

// persistStalls 把「這一輪等太久的事」立刻寫進去（strike 呼叫）。
func (g *roundGuard) persistStalls() { g.persistLive(nil) }

// finishRound 封口：之後任何途中寫入都不再動 status.json。
//
// 🔴 一定要在收工那次 SaveSyncStatus **之前**呼叫。播報「還在等」的是另一條
// goroutine，它可能比收工晚一點點才寫——沒有封口的話，收工剛寫好的那份會被
// 一格過時的 in_round 蓋回去，畫面就永遠停在「同步中」。
// 封口的判斷做在 statusFileMu 裡（見 persistLive），所以不存在「檢查完才被封口」的縫。
func (g *roundGuard) finishRound() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
}

// persistLive 把此刻的「做到哪」寫進 status.json；fs 非 nil 時一併更新那個資料夾的進度。
// 寫不進去一律吞掉：這是給畫面看的，不能擋住同步本體。
func (g *roundGuard) persistLive(fs *folderSnapshot) {
	if g == nil {
		return
	}
	g.mu.Lock()
	path, closed := g.statusPath, g.closed
	g.mu.Unlock()
	if path == "" || closed {
		return
	}
	_ = updateSyncStatus(path, func(s *SyncStatus) bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.closed {
			return false
		}
		live := g.live
		live.UpdatedAt = time.Now().Format(time.RFC3339)
		if live.Waiting != nil {
			w := *live.Waiting
			live.Waiting = &w
		}
		s.InRound = &live
		// 這一輪到目前為止等太久的事（同 Stalls 的語意：只講這一輪，不帶上一輪的）。
		s.Stalls = append([]StalledCall(nil), g.stalls...)
		if fs != nil {
			if s.FolderProgress == nil {
				s.FolderProgress = map[string]SyncProgress{}
			}
			// 首頁那行總量＝各資料夾加總＋讀不了的檔。換掉這個資料夾的那一份，
			// 其他資料夾與 Unreadable 原樣保留——不另算一套總量。
			if old, ok := s.FolderProgress[fs.root]; ok {
				s.Progress = progressMinus(s.Progress, old)
			}
			s.FolderProgress[fs.root] = fs.progress
			s.Progress = s.Progress.Add(fs.progress)
		}
		return true
	})
}

// progressMinus＝SyncProgress.Add 的反向（只在換掉某個資料夾那一份時用）。
func progressMinus(p, o SyncProgress) SyncProgress {
	return SyncProgress{
		Total:      p.Total - o.Total,
		Done:       p.Done - o.Done,
		Pending:    p.Pending - o.Pending,
		Stuck:      p.Stuck - o.Stuck,
		Unreadable: p.Unreadable - o.Unreadable,
		Failing:    p.Failing - o.Failing,
	}
}
