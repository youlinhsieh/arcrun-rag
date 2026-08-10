// collector — hash 差異偵測 collector（SDD ingest-hash-trigger，Go 版）。
//
// 用法：
//
//	collector scan   --root <知識資料夾> --manifest <manifest.json 路徑> \
//	    [--max-removed-ratio 0.4] [--dry-run]
//	collector upload --root <知識資料夾> --manifest <manifest.json 路徑> \
//	    [--max-removed-ratio 0.4] [--dry-run]
//	collector sync   --root <知識資料夾> --manifest <manifest.json 路徑> \
//	    [--max-removed-ratio 0.4] [--dry-run]
//
// scan：走訪 root、對照 manifest、把事件（符合 schemas/collector-trigger.v1.schema.json）
// 以 JSON 輸出到 stdout，並更新 manifest（--dry-run 不寫）。
//
// upload（task 3）＝scan＋把 added/modified 的原稿上傳 R2（content-addressed，
// key=raw/<sha256hex>，design §4）。設定走環境變數 CF_ACCOUNT_ID / CF_API_TOKEN /
// R2_BUCKET（絕不落 repo）；--dry-run 只列出會上傳的 key（planned），不碰網路不寫 manifest。
// 任一上傳失敗＝exit 1（manifest 照存：content_hash 反映現況、ingested_hash 不動＝可重試）。
//
// sync（task 4）＝scan＋upload＋把整輪 payload POST 到 ARCRUN_TRIGGER_URL（arcrun
// named-webhook 觸發 ingest cypher workflow）。HTTP 2xx 才對本輪送出的 added/modified/
// renamed 事件回寫 Manifest.MarkIngested；失敗不回寫（下輪自然重試）。上傳失敗的事件
// 不隨 payload 送出（r2_key 語意＝原稿已在 R2）。防呆警告輪照送 warnings、不含下架事件。
//
// daemon 常駐（launchd）＝之後的 task（產品化段 task 11）。
package collector

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type runMode struct {
	withUpload  bool
	withTrigger bool
}

// 版本資訊（t150，2026-07-29 leo：「我的和下載下來的會是同一個嗎？」）。
//
// 為什麼 collector 也要：先前**只有 tray 注入版本**（build-mac.sh L34），
// collector 是另一支獨立編譯的執行檔、完全沒有版本號（L22 不帶 LDFLAGS_VER）。
// ⇒ 托盤選單顯示的是 tray 的版本，**實際幹活的 collector 可能是任何版本**——
// 選單說 v0.14.1 也證明不了 collector 有沒有含某個修復（如 t149 多帳號同步）。
// 兩支必須注入**同一個版本值**，「顯示的」才等於「跑的」。
var (
	version   = "dev"
	buildTime = ""
)

func versionString() string {
	if buildTime == "" {
		return version
	}
	return version + " (build " + buildTime + ")"
}

// Run 是 collector 的命令列入口，回傳 exit code。
//
// 🔴 2026-08-06：這裡以前叫 main()。改成匯出函式，是為了讓桌面 App **直接呼叫**，
// 而不是「把第二支 .exe 內嵌起來、執行時攤到磁碟再跑」。
// 後者是 Windows Defender 眼中的 dropper 特徵——leo 的封測者實撞：
// 「因為檔案包含病毒或潛在的垃圾軟體，所以作業未順利完成」，檔案當場被刪。
// leo 08-06 裁決：「不要兩支，寫成一支檔案」⇒ 同一個執行檔靠參數切換身分，
// 磁碟上永遠只有一個 exe，沒有任何東西被攤出來。
func Run(args []string) int {
	if len(args) < 1 {
		usage()
		return 2
	}
	switch args[0] {
	case "--version", "-v", "version":
		fmt.Println(versionString())
		return 0
	case "scan":
		return run(args[1:], runMode{})
	case "upload":
		return run(args[1:], runMode{withUpload: true})
	case "sync":
		return run(args[1:], runMode{withUpload: true, withTrigger: true})
	case "direct":
		return runDirect(args[1:])
	case "lint":
		return runLint(args[1:])
	case "template-install":
		return runTemplateInstall(args[1:])
	default:
		usage()
		return 2
	}
}

// newFlagSet 是子命令共用的 flag.FlagSet 建構子（ExitOnError＝解析失敗直接退出）。
func newFlagSet() *flag.FlagSet {
	return flag.NewFlagSet("collector", flag.ExitOnError)
}

func usage() {
	fmt.Fprintln(os.Stderr, `用法:
  collector scan   --root <dir> --manifest <file> [--max-removed-ratio 0.4] [--dry-run]
  collector upload --root <dir> --manifest <file> [--max-removed-ratio 0.4] [--dry-run]
  collector sync   --root <dir> --manifest <file> [--max-removed-ratio 0.4] [--dry-run]
  collector direct --config <config.json> [--once] [--dry-run]
upload 需環境變數: CF_ACCOUNT_ID / CF_API_TOKEN / R2_BUCKET
sync   另需:      ARCRUN_TRIGGER_URL（named-webhook 觸發完整 URL）
direct（無 R2）:  監看資料夾 → 讀檔內容直送實例 rag_ingest_direct workflow；設定走 --config JSON`)
}

// run 是 scan/upload/sync 共用主體。
func run(args []string, mode runMode) int {
	fs := flag.NewFlagSet("collector", flag.ExitOnError)
	root := fs.String("root", "", "知識資料夾根路徑（必填）")
	manifestPath := fs.String("manifest", "", "manifest JSON 檔路徑（必填；不存在會建新）")
	ratio := fs.Float64("max-removed-ratio", DefaultMaxRemovedRatio, "大量刪除防呆門檻（removed 數 > manifest 條目 × 本值 → 全部不下架、只發警告）")
	dryRun := fs.Bool("dry-run", false, "只輸出事件（upload/sync 模式另列 planned 清單），不更新 manifest、不碰網路")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *root == "" || *manifestPath == "" {
		fmt.Fprintln(os.Stderr, "錯誤：--root 與 --manifest 皆為必填")
		return 2
	}

	// 先驗設定（fail fast：缺 env 連掃都不掃，不留半套狀態）。
	var client *R2Client
	var triggerURL string
	if !*dryRun {
		if mode.withUpload {
			cfg, err := LoadR2ConfigFromEnv()
			if err != nil {
				fmt.Fprintln(os.Stderr, "collector:", err)
				return 2
			}
			client = NewR2Client(cfg)
		}
		if mode.withTrigger {
			u, err := LoadTriggerURLFromEnv()
			if err != nil {
				fmt.Fprintln(os.Stderr, "collector:", err)
				return 2
			}
			triggerURL = u
		}
	}

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		return fail(err)
	}
	absManifest, err := filepath.Abs(*manifestPath)
	if err != nil {
		return fail(err)
	}

	m, err := LoadManifest(absManifest, absRoot)
	if err != nil {
		return fail(err)
	}
	payload, err := Scan(absRoot, m, ScanOptions{
		MaxRemovedRatio: *ratio,
		SkipPaths:       map[string]bool{absManifest: true}, // manifest 若住在 root 底下，不掃自己
	})
	if err != nil {
		return fail(err)
	}

	exitCode := 0

	var uploads []UploadResult
	if mode.withUpload {
		if *dryRun {
			uploads = []UploadResult{}
			for _, ev := range payload.Events {
				if ev.Type == "added" || ev.Type == "modified" {
					uploads = append(uploads, UploadResult{Path: ev.Path, R2Key: ev.R2Key, Status: "planned"})
				}
			}
		} else {
			uploads = UploadChanged(absRoot, payload.Events, client)
			for _, r := range uploads {
				if r.Status == "failed" {
					exitCode = 1 // 有敗＝非零退出；ingested_hash 未動＝下輪自然重試
				}
			}
		}
	}

	// sync：POST 觸發 → 2xx 才回寫 MarkIngested（在 m.Save 之前，回寫才進得了檔）。
	outPayload := payload
	var dispatch *TriggerResult
	if mode.withTrigger {
		if *dryRun {
			dispatch = &TriggerResult{Status: "planned"}
		} else {
			sendable, dropped := BuildSendablePayload(payload, uploads)
			outPayload = sendable
			dispatch = &TriggerResult{DroppedPaths: dropped}
			if len(sendable.Events) == 0 && len(sendable.Warnings) == 0 {
				dispatch.Status = "skipped_no_changes" // 無變更輪不發送（schema 註明空發也合法，但沒必要）
			} else {
				status, terr := SendTrigger(triggerURL, sendable, nil)
				dispatch.HTTPStatus = status
				if terr != nil {
					dispatch.Status = "failed"
					dispatch.Error = terr.Error()
					exitCode = 1
				} else {
					dispatch.Status = "sent"
					dispatch.MarkedCount = MarkIngestedEvents(m, sendable.Events, dropped, time.Now().Unix())
				}
			}
		}
	}

	if !*dryRun {
		if err := m.Save(absManifest); err != nil {
			return fail(err)
		}
	}

	var out any = outPayload
	if mode.withTrigger {
		out = struct {
			Trigger  *TriggerPayload `json:"trigger"`
			Uploads  []UploadResult  `json:"uploads"`
			Dispatch *TriggerResult  `json:"dispatch"`
		}{outPayload, uploads, dispatch}
	} else if mode.withUpload {
		out = struct {
			Trigger *TriggerPayload `json:"trigger"`
			Uploads []UploadResult  `json:"uploads"`
		}{outPayload, uploads}
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fail(err)
	}
	fmt.Println(string(data))
	return exitCode
}

func fail(err error) int {
	fmt.Fprintln(os.Stderr, "collector:", err)
	return 1
}

// runLint 是 `collector lint <卡片.md>` 子命令：對一張卡跑 B2 品質檢查（H1–H6）。
// 印出分級 JSON；被擋（硬缺，或 --strict 下含軟項）＝exit 1，方便腳本/CI 銷帳（施工順序步驟 4）。
func runLint(args []string) int {
	fs := newFlagSet()
	strict := fs.Bool("strict", false, "軟項（H3/H4/H6）也算擋（測試/CI）")
	source := fs.String("source", "", "原稿檔路徑（H6 相似度需要；不給＝跳過 H6）")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "用法：collector lint <卡片.md> [--source <原稿>] [--strict]")
		return 2
	}
	card, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		return fail(err)
	}
	var src string
	if *source != "" {
		b, serr := os.ReadFile(*source)
		if serr != nil {
			return fail(serr)
		}
		src = string(b)
	}
	res := LintCard(string(card), LintOptions{Source: src})
	blocked := res.Blocks(*strict)
	out, _ := json.MarshalIndent(struct {
		Card    string     `json:"card"`
		Strict  bool       `json:"strict"`
		Blocked bool       `json:"blocked"`
		Result  LintResult `json:"result"`
	}{fs.Arg(0), *strict, blocked, res}, "", "  ")
	fmt.Println(string(out))
	if blocked {
		return 1
	}
	return 0
}
