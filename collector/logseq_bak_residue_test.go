package collector

// logseq_bak_residue_test.go — `inkstone/arcrun-rag#104` comment 6309（leo 2026-09-05「bak 是不要的」）。
//
// 病：Logseq 每次編輯都往 `logseq/bak/` 留一份備份，daemon 把每一份都當新知識收進 `kb`
// ——leo21c 的 KB 4,193 份文件裡 3,620 份是這種殘影，而且雲端的資料夾卡也跟著長出
// 「資料夾：KB/logseq/bak/pages/…」上千張。08-13 早判過是垃圾，D82 重灌後回歸。
//
// 三個環，缺一個殘影都清不掉：
//   ① 不再收：`logseq/` 是 Logseq 自己的資料夾，整棵跳過，理由看得見
//   ② 已收的要下架：策略不再收的檔照發 removed，**不受**大量刪除防呆管（86% 會被擋一輩子）
//   ③ 資料夾卡也要撤：資料夾從樹上消失＝那張卡排進待撤清單

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// makeLogseqGraph 造一個有佐證的 Logseq graph：pages／journals 是筆記本體，
// logseq/ 底下是設定與備份。回傳根與 bak 檔的相對路徑。
func makeLogseqGraph(t *testing.T, withConfig bool) (root string, bakFiles []string) {
	t.Helper()
	root = t.TempDir()
	writeFile(t, root, "pages/index.md", "- n8n 本機安裝指南\n", baseTime)
	writeFile(t, root, "pages/擋風防雨車.md", "- Adiva D1 價格 20 萬\n", baseTime)
	writeFile(t, root, "journals/2026_09_04.md", "- 今天評估 Adiva D1\n", baseTime)
	if withConfig {
		writeFile(t, root, "logseq/config.edn", "{:meta/version 1}\n", baseTime)
	}
	for _, rel := range []string{
		"logseq/bak/pages/index/2026-09-01T12_08_05.467Z.Desktop.md",
		"logseq/bak/pages/index/2026-09-01T13_07_56.194Z.Desktop.md",
		"logseq/bak/pages/擋風防雨車/2026-09-04T01_00_00.000Z.Desktop.md",
		"logseq/bak/journals/2026_09_04/2026-09-04T02_00_00.000Z.Desktop.md",
		"logseq/version-files/base/pages/index.md",
	} {
		writeFile(t, root, rel, "- 舊版殘影 "+rel+"\n", baseTime)
		bakFiles = append(bakFiles, rel)
	}
	return root, bakFiles
}

// ① Logseq graph 底下的 logseq/ 整棵不收，而且理由要講得出來。
func TestPlanIngest_Logseq自己的bak資料夾不收且理由看得見(t *testing.T) {
	root, bakFiles := makeLogseqGraph(t, true)
	payload, plan := scanWithPlan(t, root)

	if plan.Mode != IngestAll {
		t.Fatalf("筆記庫應該是 all 模式，實得 %s", plan.Mode)
	}
	got := eventPaths(payload)
	for _, p := range got {
		if strings.HasPrefix(p, "logseq/") {
			t.Fatalf("收到了 Logseq 自己的檔：%s（全部：%v）", p, got)
		}
	}
	if len(got) != 3 {
		t.Fatalf("筆記本體應該收 3 份（pages×2＋journals×1），實得 %d：%v", len(got), got)
	}
	var why string
	for _, d := range payload.AllExcludedDirs {
		if d.Path == "logseq" {
			why = d.Reason
		}
	}
	if why == "" {
		t.Fatalf("logseq/ 被跳過了，卻沒有列在排除清單裡——使用者會以為東西不見了：%+v", payload.AllExcludedDirs)
	}
	if !strings.Contains(why, "Logseq") || !strings.Contains(why, "bak") {
		t.Fatalf("理由要講得出這是 Logseq 的備份：%q", why)
	}
	// 樹上不該有 logseq/bak 這一層的節點——它整棵沒走進去，不是「走進去但不收」。
	for rel := range payload.DirStats {
		if strings.HasPrefix(rel, "logseq") {
			t.Fatalf("logseq/ 底下不該生出節點：%s", rel)
		}
	}
	_ = bakFiles
}

// ①' 一個碰巧叫 logseq 的普通資料夾（旁邊沒有 pages／journals／config.edn）照收——
// 漏判只是多收一個資料夾，誤判是把使用者的東西弄不見。
func TestPlanIngest_碰巧叫logseq的普通資料夾照收(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "筆記.md", "- 一般筆記\n", baseTime)
	writeFile(t, root, "logseq/匯出/教學.md", "- 從 Logseq 匯出的教學\n", baseTime)
	payload, _ := scanWithPlan(t, root)
	got := eventPaths(payload)
	if len(got) != 2 || got[0] != "logseq/匯出/教學.md" {
		t.Fatalf("沒有佐證的 logseq 資料夾應該照收，實得 %v", got)
	}
}

// ② 已經收過的殘影：規則補上之後要下架，而且不受大量刪除防呆管。
//
// 情境照 leo21c 的形狀：先用「看不出是 Logseq graph」的狀態把 bak 收進去（模擬舊版 daemon），
// 再補上 config.edn（佐證齊了）——3,620/4,193＝86% 的檔在同一輪從現況消失。
func TestScan_策略不再收的檔照下架且不觸發大量刪除防呆(t *testing.T) {
	root, bakFiles := makeLogseqGraph(t, false)
	// pages/journals 在，logseq/ 沒有 config.edn ⇒ 佐證仍成立（journals/ 或 pages/ 存在就算）。
	// 所以要模擬「舊版把 bak 收進去」得直接造 manifest，不能靠舊判準。
	m := newTestManifest()
	first := mustScan(t, root, m)
	for _, rel := range bakFiles {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		h, err := hashFile(abs)
		if err != nil {
			t.Fatal(err)
		}
		m.Entries[rel] = &ManifestEntry{ContentHash: h, Size: 1, Mtime: baseTime.Unix()}
	}
	markIngested(m)
	if n := len(m.Entries); n != 3+len(bakFiles) {
		t.Fatalf("前置：manifest 應有 %d 份，實得 %d（第一輪事件 %d）", 3+len(bakFiles), n, len(first.Events))
	}

	p := mustScan(t, root, m)

	removed := eventsOfType(p, "removed")
	if len(removed) != len(bakFiles) {
		t.Fatalf("殘影 %d 份都要下架，實得 removed %d：%+v", len(bakFiles), len(removed), removed)
	}
	for _, ev := range removed {
		if !strings.HasPrefix(ev.Path, "logseq/") {
			t.Fatalf("下架的不該是筆記本體：%s", ev.Path)
		}
	}
	for _, w := range p.Warnings {
		if w.Code == "mass_delete_guard" {
			t.Fatalf("這不是資料夾未掛載，是我們自己不收了——防呆不該響：%+v", w)
		}
	}
	var retired *Warning
	for i := range p.Warnings {
		if p.Warnings[i].Code == "plan_retired" {
			retired = &p.Warnings[i]
		}
	}
	if retired == nil {
		t.Fatalf("下架了 %d 份卻沒告訴使用者為什麼（票上的紅線：不要讓用戶猜）：%+v", len(removed), p.Warnings)
	}
	if retired.RemovedCount != len(bakFiles) || !strings.Contains(retired.Message, "Logseq") {
		t.Fatalf("警告要說出份數與理由：%+v", *retired)
	}
	for _, rel := range bakFiles {
		if _, still := m.Entries[rel]; still {
			t.Fatalf("殘影 %s 不該還留在 manifest（下架成功後 direct.go 才刪；Scan 這一層先拿掉）", rel)
		}
	}
	if len(m.Entries) != 3 {
		t.Fatalf("筆記本體 3 份要留著，實得 %d", len(m.Entries))
	}
	// 殘影的內容雜湊不准跟新檔配成 renamed——那會讓殘影換個名字留在雲端。
	writeFile(t, root, "pages/新頁.md", "- 舊版殘影 "+bakFiles[0]+"\n", baseTime)
	p2 := mustScan(t, root, m)
	if n := len(eventsOfType(p2, "renamed")); n != 0 {
		t.Fatalf("殘影不該被當成搬走的檔：%+v", p2.Events)
	}
}

// ②' 同一輪裡「策略不收」與「真的不見」要各管各的：前者照下架，後者仍受防呆管。
func TestScan_策略不再收與真的不見同時發生時各管各的(t *testing.T) {
	root, bakFiles := makeLogseqGraph(t, false)
	m := newTestManifest()
	mustScan(t, root, m)
	for _, rel := range bakFiles {
		h, err := hashFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		m.Entries[rel] = &ManifestEntry{ContentHash: h, Size: 1, Mtime: baseTime.Unix()}
	}
	markIngested(m)
	// 筆記本體 3 份全部消失（像資料夾沒掛載）。防呆的分母是整份 manifest（3＋5＝8），
	// 3/8＝37.5%——刻意把門檻設在 30%，讓「真的不見的那 3 份」單獨就超過門檻，
	// 而殘影那 5 份不管多少都不該被算進去。
	for _, rel := range []string{"pages/index.md", "pages/擋風防雨車.md", "journals/2026_09_04.md"} {
		if err := os.Remove(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			t.Fatal(err)
		}
	}
	p, err := Scan(root, m, ScanOptions{MaxRemovedRatio: 0.3})
	if err != nil {
		t.Fatal(err)
	}

	removed := eventsOfType(p, "removed")
	if len(removed) != len(bakFiles) {
		t.Fatalf("只有殘影該下架（%d），真的不見的 3 份要被防呆壓住；實得 %+v", len(bakFiles), removed)
	}
	codes := map[string]bool{}
	for _, w := range p.Warnings {
		codes[w.Code] = true
	}
	if !codes["mass_delete_guard"] || !codes["plan_retired"] {
		t.Fatalf("兩種警告都要有：%+v", p.Warnings)
	}
	for _, rel := range []string{"pages/index.md", "pages/擋風防雨車.md", "journals/2026_09_04.md"} {
		if _, kept := m.Entries[rel]; !kept {
			t.Fatalf("防呆觸發時真的不見的 %s 要留在 manifest 等下輪重評", rel)
		}
	}
}

// ③ 資料夾從樹上消失 ⇒ 雲端那張資料夾卡排進待撤清單（以前只刪本機記帳，雲端永遠留著）。
func TestFolderCard_消失的資料夾卡要排進待撤清單(t *testing.T) {
	root := "/x/KB"
	lib := "kb"
	stale := "logseq/bak/pages/index"
	m := &Manifest{
		Entries: ent("journals/2026_09_04.md"),
		FolderCardHashes: map[string]string{
			"journals": "sha256:old",
			stale:      "sha256:old",
		},
	}
	cfg := &DirectConfig{Library: lib}
	syncFolderCards(cfg, root, m, true, true /*dryRun*/, time.Now())

	wantPath := folderCardPath(lib, stale)
	page, queued := m.PendingTakedowns[wantPath]
	if !queued {
		t.Fatalf("消失的資料夾卡沒排進待撤清單：%+v", m.PendingTakedowns)
	}
	if page != "資料夾：KB/"+stale {
		t.Fatalf("撤的頁名要跟當初送上去的一樣：%q", page)
	}
	if _, still := m.FolderCardHashes[stale]; still {
		t.Fatal("本機記帳也要清掉")
	}
	if _, wrong := m.PendingTakedowns[folderCardPath(lib, "journals")]; wrong {
		t.Fatal("還在的資料夾不該被撤")
	}

	// 整棵樹都不收了（一張卡都沒有）更要撤——這一段不能被「沒卡就提早返回」擋住。
	m2 := &Manifest{
		Entries:          map[string]*ManifestEntry{},
		FolderCardHashes: map[string]string{stale: "sha256:old"},
	}
	syncFolderCards(cfg, root, m2, true, true, time.Now())
	if _, queued := m2.PendingTakedowns[wantPath]; !queued {
		t.Fatalf("樹空了也要撤：%+v", m2.PendingTakedowns)
	}
}

// ③' 待撤清單套單輪上限：上千張資料夾卡不能一輪撤完（會撞單輪等待上限），沒撤到的下輪接著撤。
func TestDrainPendingTakedowns_套單輪上限且順序固定(t *testing.T) {
	m := &Manifest{PendingTakedowns: map[string]string{}}
	for _, k := range []string{"c", "a", "b", "d", "e"} {
		m.QueueTakedown(k+".md", k)
	}
	cfg := &DirectConfig{}
	res, _ := drainPendingTakedowns(cfg, m, "/x", "renamed_takedown", "", func() {}, true, func() {}, 2)
	var planned []string
	var info string
	for _, r := range res {
		if r.Status == "planned" {
			planned = append(planned, r.Path)
		}
		if r.Type == "info" {
			info = r.Error
		}
	}
	if len(planned) != 2 || planned[0] != "a.md" || planned[1] != "b.md" {
		t.Fatalf("上限 2 且要照固定順序：%v", planned)
	}
	if !strings.Contains(info, "3") {
		t.Fatalf("要告訴使用者還剩幾筆：%q", info)
	}
	if len(m.PendingTakedowns) != 5 {
		t.Fatal("dry-run 不該動清單")
	}
	// 0＝不限（移除資料夾那條路維持原行為）。
	res0, _ := drainPendingTakedowns(cfg, m, "/x", "folder_takedown", "", func() {}, true, func() {}, 0)
	if len(res0) != 5 {
		t.Fatalf("0 應該不限，實得 %d", len(res0))
	}
}
