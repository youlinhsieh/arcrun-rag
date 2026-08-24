// cleanup_cli.go — `collector cleanup` 子命令（arcrun-rag#138）。
//
// 為什麼 App 之外還要有一支 CLI：#138 的驗收條件是「使用者要能在動手前看到將要刪掉
// 哪些東西」。畫面上那份清單與這支印出來的是**同一個 PlanCleanup**——
// 一份判斷邏輯兩個出口，不會出現「畫面說會刪 A、實際刪了 B」。
// 而且出事時（畫面按鈕壞掉、使用者不信任 GUI）他仍然有一條看得見全部細節的路。
package collector

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// multiFlag 讓 --keep 可以重複給（其他還在看守的資料夾）。
type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func runCleanup(args []string) int {
	fs2 := newFlagSet()
	folder := fs2.String("folder", "", "要斷連的資料夾（必填）")
	apply := fs2.Bool("apply", false, "真的刪（不加＝只列清單，什麼都不動）")
	asJSON := fs2.Bool("json", false, "輸出 JSON（給程式讀）")
	var keep multiFlag
	fs2.Var(&keep, "keep", "其他還在看守的資料夾（可重複給）——它們底下的東西一律不碰")
	if err := fs2.Parse(args); err != nil {
		return 2
	}
	if *folder == "" {
		fmt.Fprintln(os.Stderr, "錯誤：--folder 為必填")
		return 2
	}

	var plan *CleanupPlan
	var res *CleanupResult
	var err error
	if *apply {
		plan, res, err = ApplyCleanup(*folder, keep)
	} else {
		plan, err = PlanCleanup(*folder, keep)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "collector cleanup:", err)
		return 1
	}

	if *asJSON {
		out := struct {
			Plan   *CleanupPlan   `json:"plan"`
			Result *CleanupResult `json:"result,omitempty"`
		}{plan, res}
		data, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(data))
		if res != nil && len(res.Failed) > 0 {
			return 1
		}
		return 0
	}

	fmt.Println(plan.Root)
	if len(plan.Remove) == 0 {
		fmt.Println("沒有找到任何 Arcrun RAG 建立的東西——這個資料夾不需要清理。")
	} else {
		if !*apply {
			fmt.Println("※ 這只是清單，什麼都還沒刪。確認沒問題後，同一行指令加上 --apply 才會真的刪。")
		}
		fmt.Printf("會刪掉 %d 項（共 %d 個檔）：\n", len(plan.Remove), plan.Files)
		for _, it := range plan.Remove {
			mark := "檔"
			if it.IsDir {
				mark = "目錄"
			}
			fmt.Printf("  刪 %s  %s（%d 個檔）\n      依據：%s\n", mark, it.Rel, it.Files, it.Evidence)
		}
	}
	if len(plan.Keep) > 0 {
		fmt.Printf("留著不動 %d 項：\n", len(plan.Keep))
		for _, k := range plan.Keep {
			fmt.Printf("  留 %s\n      原因：%s\n", k.Rel, k.Reason)
		}
	}
	if res != nil {
		fmt.Printf("實際刪掉 %d 項 / %d 個檔。\n", len(res.Removed), res.Files)
		for _, f := range res.Failed {
			fmt.Printf("  ✗ 刪不掉 %s（%s）\n", f.Rel, f.Error)
		}
		if len(res.Failed) > 0 {
			return 1
		}
	}
	return 0
}
