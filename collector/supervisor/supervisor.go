// Package supervisor 看守 `collector direct` 常駐行程，供托盤殼（fyne）呼叫。
//
// 為什麼子行程而非 in-process（誠實界定，leo 2026-07-21 偏好 in-process）：
//
//	collector 現為 `package main`，真正 in-process 複用需把核心抽成 library 套件
//	（重構動到已由 leo 實機驗過的引擎，有回歸風險）。本版先以「子行程＋讀 stdout JSON 狀態」
//	達成看守（collector 零改、崩潰隔離、純 stdlib 可單元測），in-process 抽取列為可選後續。
//	對用戶行為完全相同（都是「背景看守資料夾」）。
//
// 純 stdlib、無 fyne 依賴 → 可在 CI/sandbox `go test` 驗證（托盤 GUI 需真機建置）。
package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// State 是看守狀態機。
type State string

const (
	StateStopped  State = "stopped"  // 未啟動或已停止
	StateStarting State = "starting" // 行程剛拉起、尚無第一輪
	StateWatching State = "watching" // 正常看守中（已有掃描輪）
	// 🔴 t191（leo 08-04，issue #17）：「按『立刻同步』後很快就回到『看守中』，
	//    看起來好像就做完了⋯⋯使用者一看沒做完啊，就覺得是 bug」。
	//    collector 開工前會印 phase:"start"、跑完印 phase:"done"
	//    ⇒ 這中間就是本狀態，讓托盤顯示「同步中…」，工作時間不再對用戶隱形。
	StateSyncing State = "syncing" // 正在掃描／萃取（收到 start、還沒收到 done）
	StateError   State = "error"   // 行程非預期退出、等待重起
)

// Status 是托盤要顯示的即時狀態（值型別、複製安全）。
type Status struct {
	State       State
	Since       time.Time // 進入目前 State 的時間
	LastRoundAt time.Time // 最近一輪掃描完成時間（collector stdout 的 at）
	Rounds      int       // 累計掃描輪數
	Restarts    int       // 累計重起次數
	LastError   string    // 最近一次錯誤（stderr 末行 / 退出原因）
	// Waiting＝正在等某一發雲端回覆的白話說明（`inkstone/arcrun-rag#153`）。
	// 空＝沒有人在等。它不是錯誤——所以不寫進 LastError（那一格會被診斷檔
	// 當成「出事了」帶出去，見 diagnostics_export.go 的 engineLastErrorFor）。
	Waiting string
}

// round 對應 collector direct 每輪印到 stdout 的 JSON（見 direct.go runOne）。
type round struct {
	At    string `json:"at"`
	Phase string `json:"phase"` // t191："start"（開工）／"done"（跑完）；舊版沒有此欄＝空
	// `inkstone/arcrun-rag#153`："waiting"＝這一發等太久了，還沒跑完。
	// 🔴 它**不是**一輪的結束：下面的 decode 迴圈把任何非 start 的值都當成
	// 「跑完了」，不特別認得它的話，托盤會在同步途中跳回「看守中」——
	// 正是 t191 修掉的那個病（「看起來好像就做完了」）。
	Account   string `json:"account,omitempty"`    // 哪個知識庫帳號
	Step      string `json:"step,omitempty"`       // 哪件事（白話）
	WaitedSec int    `json:"waited_sec,omitempty"` // 等了幾秒

	Folder  string            `json:"folder"`
	Results []json.RawMessage `json:"results"`
}

// DefaultLogMaxBytes 是 collector.log 的輪替上限（超過即改名 .old 重開）。
const DefaultLogMaxBytes = 5 << 20 // 5MB

// defaultLogPath 回傳預設 log 檔位置：~/.arcrun-rag/collector.log（與 config/manifest 同窩）。
func defaultLogPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "" // 找不到家目錄＝不落 log（best-effort，不擋看守）
	}
	return filepath.Join(home, ".arcrun-rag", "collector.log")
}

// rotatingLog 是 append-only 的 log 檔 writer，帶簡單輪替：
// 寫入前若檔案將超過 max，就把現檔改名 <path>.old（覆蓋舊 .old）後重開新檔。
// 所有錯誤一律吞掉（log 是診斷輔助，絕不因落 log 失敗擋掉看守本體）。
type rotatingLog struct {
	mu   sync.Mutex
	path string
	max  int64
}

func (l *rotatingLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.path == "" {
		return len(p), nil
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
		return len(p), nil
	}
	if fi, err := os.Stat(l.path); err == nil && fi.Size()+int64(len(p)) > l.max {
		_ = os.Rename(l.path, l.path+".old") // 覆蓋既有 .old ＝最多留兩代
	}
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return len(p), nil
	}
	defer f.Close()
	_, _ = f.Write(p)
	return len(p), nil
}

// Supervisor 看守單一 collector direct 行程。
type Supervisor struct {
	BinPath string // collector 執行檔路徑（托盤 app bundle 內）
	// ArgPrefix 插在 "direct" 之前的參數。
	// 🔴 2026-08-06：桌面 App 不再內嵌第二支 .exe 再攤到磁碟（Defender 眼中的 dropper
	//    特徵），改成**同一支執行檔**用 `--collector` 換身分 ⇒ BinPath 指向自己、
	//    ArgPrefix = ["--collector"]。leo 裁決：「不要兩支，寫成一支檔案」。
	ArgPrefix   []string
	ConfigPath  string        // direct config.json 路徑
	Backoff     time.Duration // 非預期退出後的重起間隔（0＝預設 3s）
	LogPath     string        // 子行程輸出落地檔（空＝~/.arcrun-rag/collector.log；t14）
	LogMaxBytes int64         // log 輪替上限（0＝DefaultLogMaxBytes）

	mu       sync.Mutex
	status   Status
	cancel   context.CancelFunc
	done     chan struct{} // loop 結束時關閉（Stop 等它，避免 Stop→Start 舊 loop 覆寫狀態）
	running  bool
	onChange func(Status)
	nowFn    func() time.Time // 可注入時鐘（測試用；nil＝time.Now）
	logw     *rotatingLog     // 子行程輸出落地（lazy init，見 logWriter）
}

// New 建一個看守器。
func New(binPath, configPath string) *Supervisor {
	return &Supervisor{BinPath: binPath, ConfigPath: configPath}
}

// SetOnChange 註冊狀態變更回呼（托盤用來刷新選單/icon）。回呼在 supervisor 內部 goroutine 呼叫。
func (s *Supervisor) SetOnChange(fn func(Status)) {
	s.mu.Lock()
	s.onChange = fn
	s.mu.Unlock()
}

// logWriter 回傳（lazy 建立）子行程輸出的 log writer（t14）。
func (s *Supervisor) logWriter() *rotatingLog {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.logw == nil {
		p := s.LogPath
		if p == "" {
			p = defaultLogPath()
		}
		max := s.LogMaxBytes
		if max <= 0 {
			max = DefaultLogMaxBytes
		}
		s.logw = &rotatingLog{path: p, max: max}
	}
	return s.logw
}

func (s *Supervisor) now() time.Time {
	if s.nowFn != nil {
		return s.nowFn()
	}
	return time.Now()
}

// setState 原子更新狀態並觸發回呼（回呼在鎖外呼叫，避免死鎖）。
func (s *Supervisor) setState(mut func(*Status)) {
	s.mu.Lock()
	prev := s.status.State
	mut(&s.status)
	if s.status.State != prev {
		s.status.Since = s.now()
	}
	snap := s.status
	cb := s.onChange
	s.mu.Unlock()
	if cb != nil {
		cb(snap)
	}
}

// Status 回傳目前狀態快照。
func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Start 啟動看守（非阻塞）。已在跑則忽略。崩潰自動重起，直到 Stop。
func (s *Supervisor) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.cancel = cancel
	s.done = done
	s.running = true
	s.mu.Unlock()
	go func() {
		defer close(done)
		s.loop(ctx)
	}()
}

// Stop 停止看守，**等目前 loop 完全收掉才回**——這樣 Stop→Start（如換資料夾）不會被舊 loop
// 的 setState(stopped) 覆寫新狀態。冪等；未在跑時直接回。
func (s *Supervisor) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	cancel := s.cancel
	done := s.done
	s.running = false
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done // 等 loop goroutine 真的結束
	}
	s.setState(func(st *Status) { st.State = StateStopped })
}

func (s *Supervisor) backoff() time.Duration {
	if s.Backoff > 0 {
		return s.Backoff
	}
	return 3 * time.Second
}

// loop 是看守主迴圈：拉起行程→串流 stdout 更新狀態→退出即重起（除非取消）。
func (s *Supervisor) loop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		s.setState(func(st *Status) { st.State = StateStarting })
		err := s.runOnce(ctx)
		if ctx.Err() != nil { // 被 Stop 取消＝正常收工
			s.setState(func(st *Status) { st.State = StateStopped })
			return
		}
		// 非預期退出：記錯、重起計數、退避後再拉
		// 🔴 2026-08-06（leo Windows 實測）：這裡以前直接用 cmd.Wait() 的錯誤當訊息，
		//    於是「exit status 2」**蓋掉**了 stderr 剛剛寫進 LastError 的那句真話
		//    （例如「collector direct: config JSON 解析失敗：…」）。
		//    使用者與遠端的我拿到的都是最沒用的那一句——退化成猜謎。
		//    ⇒ 有 stderr 就以 stderr 為主、退出碼放括號裡當補充。
		msg := "行程結束"
		if err != nil {
			msg = err.Error()
		}
		s.mu.Lock()
		stderrLine := s.status.LastError
		s.mu.Unlock()
		if stderrLine != "" && stderrLine != msg {
			msg = stderrLine + "（" + msg + "）"
		}
		s.setState(func(st *Status) {
			st.State = StateError
			st.LastError = msg
			st.Restarts++
		})
		select {
		case <-ctx.Done():
			s.setState(func(st *Status) { st.State = StateStopped })
			return
		case <-time.After(s.backoff()):
		}
	}
}

// runOnce 跑一次 collector direct 行程，串流其 stdout JSON 更新狀態，回傳退出原因。
func (s *Supervisor) runOnce(ctx context.Context) error {
	// ArgPrefix 讓呼叫端把「同一支執行檔換個身分跑」的參數插在最前面
	// （桌面 App 用 `Arcrun.exe --collector direct --config …` 跑自己）。
	// 空的時候行為與過去完全一樣（獨立的 collector 執行檔）。
	args := append(append([]string{}, s.ArgPrefix...), "direct", "--config", s.ConfigPath)
	cmd := exec.CommandContext(ctx, s.BinPath, args...)
	// t75：Windows 上不要讓 collector 彈出 console 視窗（每輪閃一次，使用者會以為中毒）。
	// 非 Windows 平台為 no-op，見 hidewindow_*.go。
	hideChildWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	// t14：子行程輸出全部落地 ~/.arcrun-rag/collector.log（帶輪替），托盤跑掛不用猜。
	lw := s.logWriter()

	// stderr：落 log ＋ 留末行當錯誤脈絡
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			_, _ = lw.Write([]byte("[stderr] " + line + "\n"))
			s.mu.Lock()
			s.status.LastError = line
			s.mu.Unlock()
		}
	}()

	// stdout：tee 進 log 檔，同時用 json.Decoder 逐個 JSON 值解（容忍 MarshalIndent 的多行）
	tee := io.TeeReader(stdout, lw)
	dec := json.NewDecoder(tee)
	for {
		var r round
		if derr := dec.Decode(&r); derr != nil {
			if derr == io.EOF {
				break
			}
			// 非 JSON 雜訊：吞掉剩餘（仍經 tee 落 log）、跳出（行程仍由 Wait 收）
			io.Copy(io.Discard, tee)
			break
		}
		at := parseAt(r.At)
		if r.Phase == "start" {
			// t191：開工 → 顯示「同步中…」。不累加 Rounds（那是「完成幾輪」）。
			s.setState(func(st *Status) { st.State = StateSyncing; st.Waiting = "" })
			continue
		}
		if r.Phase == "waiting" {
			// #153：還在等某一發回覆 ⇒ 仍在同步中，**不算跑完一輪**。
			// 把「哪個帳號、哪件事、等了多久」留在狀態上，托盤才講得出來
			// ——不然使用者看到的就是「開著、沒有錯誤、什麼都不動」。
			note := fmt.Sprintf("正在等「%s」回覆「%s」，已經等了 %d 秒",
				r.Account, r.Step, r.WaitedSec)
			s.setState(func(st *Status) { st.State = StateSyncing; st.Waiting = note })
			continue
		}
		s.setState(func(st *Status) {
			st.State = StateWatching
			st.Waiting = "" // 跑完了＝沒有人在等，別讓上一輪的等待訊息留在畫面上
			st.Rounds++
			if !at.IsZero() {
				st.LastRoundAt = at
			}
		})
	}
	return cmd.Wait()
}

func parseAt(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return time.Time{}
}
