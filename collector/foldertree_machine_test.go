package collector

// foldertree_machine_test.go — 資料夾樹要說得出「**是哪一台機器報上來的**」
//（`inkstone/Arcrun#180`）。
//
// 這張票的現象是 leo 2026-08-28 的原話：
//
//	「youlin 從桌面同步 4 個資料夾，雲端顯示 16 個，**這是把別的帳號同步的資料夾外洩了？**」
//
// 實查後不是外洩（那 17 個庫全是他自己歷史上同步過的），但**畫面說不出來**：
// 雲端的庫清單是「總庫 → 機器 → 資料夾」三層，而樹的上行酬載裡沒有機器身分
// ⇒ 每一個庫都只能掛在「未知來源」底下 ⇒ 看起來就像別人的東西。
//
// 🔴 本檔守的是「**送出去的東西身上有沒有這一格**」，不是畫面長怎樣（那在 matrix/arcrun）。
// 三個檢查點，各對應一種會靜默壞掉的方式：
//
//	① 酬載欄名要與卡片那條路一字不差 —— 收端不必為了樹另認一組欄位
//	② 改名要算成「內容變了」        —— 否則冪等閘會讓新名字永遠送不出去
//	③ 真的跑一輪，兩邊都要有         —— 有人在別處新增 BuildFolderTree 呼叫卻忘了蓋章時，這條會紅

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ① 酬載欄名：與 folderindex.go／inventory.go／sourcerepair.go 送卡片時完全相同。
func TestSyncFolderTree酬載帶得出機器身分(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	tree := buildTreeFromDisk(t, root).StampMachine(MachineIdentity{
		ID:    "youlinhsieh@Leo-MBA",
		Label: "教育部 Leo 的 Mac",
	})

	cfg := &DirectConfig{CypherURL: srv.URL, APIKey: "demo"}
	m := &Manifest{Root: root, Entries: map[string]*ManifestEntry{}}
	res := syncFolderTree(cfg, root, m, tree, false, time.Unix(1786900000, 0))
	if res == nil || res.Status != "ingested" {
		t.Fatalf("應送達：%+v", res)
	}

	// 🔴 欄名寫死在這裡是刻意的：收端（cypher-executor 的 /portal/daemon/folder-tree）
	// 認的就是這兩個字串。改欄名＝改協定，這條測試就是那道閘。
	if got["machine"] != "youlinhsieh@Leo-MBA" {
		t.Errorf("酬載的 machine（比對鍵）不對：%v", got["machine"])
	}
	if got["machine_label"] != "教育部 Leo 的 Mac" {
		t.Errorf("酬載的 machine_label（顯示名）不對：%v", got["machine_label"])
	}
	// 比對鍵與顯示名**必須是兩格**：只送一格的話，使用者改名就等於雲端多出一台機器。
	if got["machine"] == got["machine_label"] {
		t.Error("改過名的機器，比對鍵與顯示名不該相同——有一格被另一格頂替了")
	}
}

// ② 改名要算成「內容變了」。
//
// 這是本檔最容易被忽略的一格：`Hash()` 是冪等閘的唯一判準，機器身分若沒進雜湊，
// 使用者在 config.json 改了 `machine_label` 之後，樹的內容沒動 ⇒ 永遠不再送
// ⇒ **雲端會一直顯示舊名字，而且沒有任何機制會發現**。
func TestFolderTreeHash把機器改名算成內容變了(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "note.md"), "# note")
	base := buildTreeFromDisk(t, root)

	before := base.StampMachine(MachineIdentity{ID: "youlinhsieh@Leo-MBA", Label: "youlinhsieh@Leo-MBA"})
	after := base.StampMachine(MachineIdentity{ID: "youlinhsieh@Leo-MBA", Label: "教育部 Leo 的 Mac"})

	if before.Hash() == after.Hash() {
		t.Error("改了顯示名雜湊卻沒變——冪等閘會讓新名字永遠送不上去")
	}
	// 沒蓋章的樹與蓋了章的樹也必須不同，否則升級到本版的機器不會補送一次。
	if base.Hash() == before.Hash() {
		t.Error("蓋上機器身分之後雜湊沒變——舊機器升級後不會補送，雲端永遠是「未知來源」")
	}
	// 但時間仍然不進雜湊（既有慣例，不准被這次改動弄壞）。
	later := before
	later.GeneratedAt = before.GeneratedAt + 999
	if later.Hash() != before.Hash() {
		t.Error("時間跑進雜湊了——那等於沒有冪等，每輪都會重送整棵樹")
	}
}

// ③ 真的跑一輪：本機快照與上雲酬載**是同一份身分**。
//
// 🔴 這條守的是「有人忘了蓋章」。`StampMachine` 蓋在 direct.go 的 BuildFolderTree
// 呼叫點上；日後若有人在別處另起一個呼叫、或把蓋章那一行刪掉，
// 前兩條測試（各自手動蓋章）照樣會綠，只有這條會紅。
func TestRunDirectOnce的樹一路帶著機器身分(t *testing.T) {
	var treeBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/portal/daemon/folder-tree") {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &treeBody)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	base := t.TempDir()
	root := filepath.Join(base, "我的知識庫")
	mustWrite(t, filepath.Join(root, "報銷規則.md"), "# 報銷規則\n內容")

	orig := fetchCloudVersion
	fetchCloudVersion = func(string) (string, bool) { return "stub", true }
	defer func() { fetchCloudVersion = orig }()

	manifest := filepath.Join(base, "manifest.json")
	cfg := &DirectConfig{
		Manifest:          manifest,
		MachineLabel:      "教育部 Leo 的 Mac", // 使用者改過名 ⇒ 比對鍵與顯示名不同，兩格才分得出來
		Accounts:          []AccountConfig{{CypherURL: srv.URL, Namespace: "ns", WatchFolders: []string{root}}},
		MaxRemoved:        DefaultMaxRemovedRatio,
		ExtractorExplicit: true, // 隔離變因：本測驗的是身分有沒有一路帶著，不是萃取
	}
	if _, exit, _ := RunDirectOnce(cfg, false); exit != 0 {
		t.Fatalf("同步應成功，exit=%d", exit)
	}

	// 這一輪實際解析出來的身分（machine.json 就鑄在 manifest 旁邊）。
	want := cfg.machineIdentity()
	if want.ID == "" {
		t.Fatal("這台機器連身分都沒鑄出來——machineid.go 那條線先壞了")
	}

	// 本機快照（桌面小幫手讀的那份）
	store, err := LoadFolderTreeStore(FolderTreeStorePath(manifest))
	if err != nil {
		t.Fatalf("跑完一輪應該有快照可讀：%v", err)
	}
	tree, ok := store.Trees[root]
	if !ok {
		t.Fatalf("快照裡沒有這個看守根：%+v", store.Trees)
	}
	if tree.Machine != want.ID || tree.MachineLabel != want.Label {
		t.Errorf("本機快照沒蓋機器身分：machine=%q label=%q（應為 %q／%q）",
			tree.Machine, tree.MachineLabel, want.ID, want.Label)
	}

	// 上雲酬載
	if treeBody == nil {
		t.Fatal("這一輪沒有把樹送上去——沒東西可驗")
	}
	if treeBody["machine"] != want.ID || treeBody["machine_label"] != want.Label {
		t.Errorf("上雲酬載沒帶機器身分：%v／%v（應為 %q／%q）",
			treeBody["machine"], treeBody["machine_label"], want.ID, want.Label)
	}
	// 🔴 兩邊必須是同一份，不是各算各的（本 repo 對「第二份實作」的一貫紅線）。
	if treeBody["machine"] != tree.Machine || treeBody["machine_label"] != tree.MachineLabel {
		t.Error("本機快照與上雲酬載的機器身分不一致——有一邊自己另算了一份")
	}
	// 使用者改過名 ⇒ 顯示名該是他設的那個，比對鍵不該跟著變。
	if want.Label != "教育部 Leo 的 Mac" {
		t.Errorf("config 的 machine_label 沒被採用：%q", want.Label)
	}
	if want.ID == want.Label {
		t.Error("改名把比對鍵也改掉了——那會讓雲端以為多出一台機器")
	}
}
