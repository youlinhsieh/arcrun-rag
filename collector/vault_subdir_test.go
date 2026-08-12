// vault_subdir_test.go — arcrun-rag#60 第三輪（2026-08-12）。
//
// ══════════════════════════════════════════════════════════════════════════
// 前兩輪的驗法為什麼沒抓到這一個（票上第 6 條驗收，必答）
// ══════════════════════════════════════════════════════════════════════════
//
// 第二輪已經做對了一件很重要的事：把驗法從「點測某個函式回傳什麼」換成
// **足跡測試**（跑之前 walk 一次、跑之後 walk 一次，比對多出什麼、動到什麼）。
// 那張網對「寫檔點的數量」免疫——第三輪這個洞不是它漏抓，是**它看不到**。
//
// 漏的是另外兩件事，兩件都不是「網目太粗」，是**網架錯了地方**：
//
//	① 觀測窗 == 監看根。snapshotTree(root) 只 walk 監看根底下。
//	   而這一輪的災情發生在**監看根的外面、vault 的裡面**：監看根是
//	   `KB/docs` 時，卡片落在 `KB/docs/system-dev/wiki/cards/`——在監看根裡面沒錯，
//	   但它同時也在 `KB` 這個 Logseq graph 裡面，而 Logseq 是**遞迴索引整個 graph** 的。
//	   要看見「使用者的筆記庫多了幾頁」，快照的邊界必須是**筆記庫**，不是監看根。
//	   ⇒ 本檔的 fixture 一律回傳 vault 根，快照也一律拍 vault 根。
//
//	② fixture 只有一種擺法。前兩輪每一支測試都是 `root := vault`（監看根就是庫根），
//	   而那正好是唯一不會出事的擺法。判準函式只看一層，fixture 也只擺一層——
//	   **測試與被測程式犯了同一個假設**，所以它永遠是綠的。
//	   ⇒ 本檔把「監看根與庫根的關係」升格成測試維度，四種都擺：
//	      庫在上面／庫在下面／庫就是它／完全沒有庫；每種再乘 Logseq 與 Obsidian。
//
// 一句話：**第二輪問「daemon 多寫了什麼」，第三輪問「使用者的筆記庫多了什麼」。**
// 後者才是 leo 打開 Logseq 時真正看到的東西。
package collector

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────────
// 判準層：DetectVaultContext / VaultDirUnder
// ─────────────────────────────────────────────────────────────────────────────

// makeLogseqVault 造一個像樣的 Logseq graph（有 logseq/config.edn + journals/ + pages/）。
func makeLogseqVault(t *testing.T, dir string) {
	t.Helper()
	mustMkdir(t, filepath.Join(dir, "logseq"))
	mustMkdir(t, filepath.Join(dir, "journals"))
	mustMkdir(t, filepath.Join(dir, "pages"))
	if err := os.WriteFile(filepath.Join(dir, "logseq", "config.edn"),
		[]byte("{:default-home {:page \"contents\"}}"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func makeObsidianVault(t *testing.T, dir string) {
	t.Helper()
	mustMkdir(t, filepath.Join(dir, ".obsidian"))
	if err := os.WriteFile(filepath.Join(dir, ".obsidian", "app.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 監看根就是庫根＝前兩輪處理好的那條路，不能被這次改動弄壞。
func TestDetectVaultContext_SelfIsVault(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(*testing.T, string)
		want VaultType
	}{
		{"logseq", makeLogseqVault, VaultLogseq},
		{"obsidian", makeObsidianVault, VaultObsidian},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			tc.make(t, root)
			ctx := DetectVaultContext(root)
			if ctx.Type != tc.want || !ctx.Self || ctx.Root != root {
				t.Fatalf("ctx=%+v，want Type=%q Self=true Root=%q", ctx, tc.want, root)
			}
		})
	}
}

// 🔴 第三輪的核心：庫在**上面**，監看根是它底下的子資料夾。
func TestDetectVaultContext_RootInsideVault(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(*testing.T, string)
		want VaultType
	}{
		{"logseq", makeLogseqVault, VaultLogseq},
		{"obsidian", makeObsidianVault, VaultObsidian},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := t.TempDir()
			vault := filepath.Join(base, "KB")
			mustMkdir(t, vault)
			tc.make(t, vault)

			// 一層、兩層都要認得——使用者可能監看 `KB/docs`，也可能監看 `KB/專案/A`。
			for _, sub := range []string{"docs", filepath.Join("專案", "A")} {
				watch := filepath.Join(vault, sub)
				mustMkdir(t, watch)
				ctx := DetectVaultContext(watch)
				if ctx.Type != tc.want {
					t.Fatalf("%s：ctx.Type=%q，want %q（監看根在 vault 裡卻沒被認出來）", sub, ctx.Type, tc.want)
				}
				if ctx.Self {
					t.Fatalf("%s：Self 應為 false（庫根是上層的 %s）", sub, vault)
				}
				if ctx.Root != vault {
					t.Fatalf("%s：ctx.Root=%q，want %q", sub, ctx.Root, vault)
				}
				if got := cardsRelDirFor(watch); got != vaultCardsRelDir {
					t.Fatalf("%s：卡片會落在 %q——那是可見目錄，筆記軟體會把它當成頁面", sub, got)
				}
			}
		})
	}
}

// 回歸：沒有任何庫的普通資料夾，行為一個字都不能變。
func TestDetectVaultContext_PlainFolder_Unchanged(t *testing.T) {
	base := t.TempDir()
	watch := filepath.Join(base, "報告", "2026")
	mustMkdir(t, watch)
	if ctx := DetectVaultContext(watch); ctx.InVault() {
		t.Fatalf("普通資料夾被誤判成在 vault 裡：%+v", ctx)
	}
	if got := cardsRelDirFor(watch); got != cardsRelDir {
		t.Fatalf("cardsRelDirFor=%q，want %q（一般資料夾行為必須零改變）", got, cardsRelDir)
	}
}

// 往上找要有佐證：光有一個叫 logseq 的資料夾不算數。
//
// 為什麼這條重要：`~/logseq`、專案裡放匯出檔的 `logseq/` 都很常見。沒有這條，
// 那些人底下**每一個**監看根都會突然改變行為（卡片全部變隱藏）。
func TestDetectVaultContext_BareLogseqDirUpstairs_NeedsCorroboration(t *testing.T) {
	base := t.TempDir()
	fake := filepath.Join(base, "某個專案")
	mustMkdir(t, filepath.Join(fake, "logseq")) // 只有名字，沒有 config.edn/journals/pages
	watch := filepath.Join(fake, "sub")
	mustMkdir(t, watch)
	if ctx := DetectVaultContext(watch); ctx.InVault() {
		t.Fatalf("只有一個叫 logseq 的空資料夾就被判成筆記庫：%+v", ctx)
	}

	// 補上 config.edn 之後就該認得了（真的 graph 一定有）。
	if err := os.WriteFile(filepath.Join(fake, "logseq", "config.edn"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ctx := DetectVaultContext(watch); ctx.Type != VaultLogseq {
		t.Fatalf("有 config.edn 了還是沒認出來：%+v", ctx)
	}
}

// 監看根**自己**這一層仍走 install.sh 的寬鬆判準（兩邊必須同一個答案，vault.go 開頭的鐵律）。
func TestDetectVaultContext_SelfKeepsInstallShRule(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "logseq")) // 只有 logseq/，沒有佐證
	if got := DetectVaultType(root); got != VaultLogseq {
		t.Fatalf("DetectVaultType=%q，want logseq（這一層的判準要與 install.sh 逐字一致）", got)
	}
	if ctx := DetectVaultContext(root); ctx.Type != VaultLogseq || !ctx.Self {
		t.Fatalf("ctx=%+v，want logseq/Self（自己這一層不該套往上找的嚴格判準）", ctx)
	}
}

// VaultDirUnder＝往下擋：目標路徑中途踩進子筆記庫要被認出來。
func TestVaultDirUnder(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "KB")
	makeLogseqVault(t, sub)

	if dir, vt := VaultDirUnder(root, filepath.Join(sub, "pages", "x.md")); vt != VaultLogseq || dir != sub {
		t.Fatalf("VaultDirUnder=(%q,%q)，want (%q,logseq)", dir, vt, sub)
	}
	// 正常落卡路徑（錨在監看根）不該命中。
	safe := filepath.Join(root, filepath.FromSlash(cardsRelDir), "arcrun-x.md")
	if dir, vt := VaultDirUnder(root, safe); vt != VaultNone {
		t.Fatalf("正常落卡路徑被誤擋：(%q,%q)", dir, vt)
	}
}

// safeWriteCard 真的擋得住（機械閘，不是只有註解）。
func TestSafeWriteCard_RefusesToWriteIntoSubVault(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "KB")
	makeLogseqVault(t, sub)

	dest := filepath.Join(sub, "pages", "arcrun-偷渡.md")
	err := safeWriteCard(root, dest, []byte("# 偷渡"))
	if err == nil {
		t.Fatal("寫進子筆記庫竟然成功了——機械閘沒有作用")
	}
	if !strings.Contains(err.Error(), "筆記庫") {
		t.Fatalf("錯誤訊息看不出原因：%v", err)
	}
	if _, serr := os.Stat(dest); serr == nil {
		t.Fatal("擋下來了卻還是留下了檔案")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 足跡層：跑一輪真的同步，用**筆記庫**當觀測窗（不是監看根）
// ─────────────────────────────────────────────────────────────────────────────

// runSyncOnce 跑一輪 direct 同步（全程假伺服器，不出網、不碰任何真實筆記庫）。
func runSyncOnce(t *testing.T, watch string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()
	defer gemmaEchoStub(t)()

	cfg := &DirectConfig{
		WatchFolders: []string{watch},
		Manifest:     filepath.Join(t.TempDir(), "m.json"),
		CypherURL:    srv.URL, Namespace: "demo", APIKey: "demo",
		Library: "kb", Extractor: "gemma", ExtractorExplicit: true, GeminiAPIKey: "k-test",
		CardIngestWF: "rag_ingest_card", MaxRemoved: DefaultMaxRemovedRatio,
	}
	results, exit, _ := RunDirectOnce(cfg, false)
	if exit != 0 {
		t.Fatalf("同步失敗 exit=%d results=%+v", exit, results)
	}
}

// assertVaultUntouched 是本檔的共用判準，四條一起驗（缺一條這一票就還沒修好）：
//
//	① 使用者原本的檔案，一個位元、一個 mtime 都不能變，也不能消失
//	② 新出現的檔案，basename 一律帶 MachineMark（誰寫的，一眼看得出來）
//	③ 新出現的檔案，一律落在隱藏路徑（`/.` 開頭的段）——筆記軟體不會收編成頁面
//	④ 東西照樣要產出（沒產出＝把功能關掉，那是紅線不是修好）
func assertVaultUntouched(t *testing.T, vaultDir string, before, after map[string]footprintEntry) []string {
	t.Helper()

	for rel, want := range before {
		got, still := after[rel]
		if !still {
			t.Fatalf("使用者的檔案不見了：%s", rel)
		}
		if got.hash != want.hash || got.size != want.size {
			t.Fatalf("使用者的檔案被改了：%s（size %d→%d）", rel, want.size, got.size)
		}
		if got.mtime != want.mtime {
			t.Fatalf("使用者的檔案 mtime 被動過：%s", rel)
		}
	}

	var added []string
	for rel := range after {
		if _, existed := before[rel]; !existed {
			added = append(added, rel)
		}
	}
	sort.Strings(added)
	t.Logf("筆記庫裡新增的檔案（%d 個）：%v", len(added), added)

	for _, rel := range added {
		if !IsMarked(filepath.Base(rel)) {
			t.Fatalf("筆記庫裡多了一個沒帶 %q 標記的檔：%s", MachineMark, rel)
		}
		if !isHiddenRel(rel) {
			t.Fatalf("筆記庫裡多了一個**看得見**的機器產物：%s"+
				"（Logseq/Obsidian 會遞迴索引整個庫，這就是使用者看到的新頁面）", rel)
		}
	}
	return added
}

// isHiddenRel：路徑上任何一段以 . 開頭＝筆記軟體與 daemon 的 scan.go 都不會掃它。
func isHiddenRel(rel string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// 🔴 主戲：庫在上面（監看根是 vault 的子資料夾）。Logseq 與 Obsidian 各驗一次。
//
// 修之前這裡會落下 `docs/system-dev/wiki/cards/arcrun-*.md`——在使用者的 graph 裡、
// 而且看得見，Logseq 每一張都會變成一頁。
func TestVaultFootprint_WatchRootInsideVault(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(*testing.T, string)
	}{
		{"logseq", makeLogseqVault},
		{"obsidian", makeObsidianVault},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := t.TempDir()
			vault := filepath.Join(base, "我的筆記庫")
			watch := filepath.Join(vault, "docs")
			mustMkdir(t, watch)
			tc.make(t, vault)

			// 使用者自己的東西（含日期檔——那是最會撞名的一類）。
			writeFixture(t, vault, map[string]string{
				"journals/2026_08_12.md": "- 我自己寫的日記，不准被動到",
				"pages/讀書筆記.md":          "- 我自己的頁面",
				// 🔴 同名情境（票上驗收條件③）：故意在庫裡先擺一個「跟機器產物會撞名」的檔。
				// 機器萃 docs/會議記錄.md 會產出名為 `arcrun-會議記錄.md` 的卡，
				// 這裡先把那個名字佔走，看它會不會被覆蓋。
				"pages/arcrun-會議記錄.md": "- 這個檔名是我先取的，機器不准碰",
				"docs/會議記錄.md":         "# 要被萃取的原稿",
				"docs/2026_08_12.md":   "# 用日期當檔名的原稿",
			})

			before := snapshotTree(t, vault)
			logTree(t, tc.name+"・跑之前（整個筆記庫）", before)
			runSyncOnce(t, watch)
			after := snapshotTree(t, vault)
			logTree(t, tc.name+"・跑之後（整個筆記庫）", after)

			added := assertVaultUntouched(t, vault, before, after)
			if len(added) == 0 {
				t.Fatal("這一輪什麼都沒產出——紅線是「東西照樣產出、但不撞進使用者的命名空間」")
			}
			// 卡片確實落在 docs/.arcrun-rag/... 底下（在監看根裡，且是隱藏的）。
			wantPrefix := filepath.ToSlash(filepath.Join("docs", vaultCardsRelDir)) + "/"
			for _, rel := range added {
				if !strings.HasPrefix(rel, wantPrefix) {
					t.Fatalf("產物 %s 不在預期的隱藏卡片區 %s 底下", rel, wantPrefix)
				}
			}
		})
	}
}

// 🔴 leo 派工單上的那條線索：庫在**下面**（監看根是普通資料夾，底下某一層是 vault）。
//
// 這一支的結論是「本來就沒破」——產物一律錨在監看根，不會落進子庫。
// 但它必須永久留在測試裡：那個「本來就沒破」目前**沒有任何機制保證**，
// 只要有人加一個「把卡寫在原稿旁邊」的寫檔點就會破，而那是很自然的想法。
// 這支測試 ＋ safeWriteCard 的機械閘是它的兩道保險。
func TestVaultFootprint_SubVaultBelowWatchRoot(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(*testing.T, string)
	}{
		{"logseq", makeLogseqVault},
		{"obsidian", makeObsidianVault},
	} {
		t.Run(tc.name, func(t *testing.T) {
			watch := t.TempDir()
			vault := filepath.Join(watch, "我的筆記庫")
			mustMkdir(t, vault)
			tc.make(t, vault)

			writeFixture(t, watch, map[string]string{
				"我的筆記庫/journals/2026_08_12.md": "- 我自己寫的日記，不准被動到",
				"我的筆記庫/pages/讀書筆記.md":          "- 我自己的頁面",
				// 同名情境：庫裡先擺一個會跟機器產物撞名的檔。
				"我的筆記庫/pages/arcrun-讀書筆記.md": "- 這個名字是我先取的",
				"我的筆記庫/會議記錄.md":              "# 庫裡的原稿",
				"外面的報告.md":                   "# 監看根上的原稿",
			})

			beforeVault := snapshotTree(t, vault)
			beforeAll := snapshotTree(t, watch)
			logTree(t, tc.name+"・跑之前（子筆記庫）", beforeVault)
			runSyncOnce(t, watch)
			afterVault := snapshotTree(t, vault)
			afterAll := snapshotTree(t, watch)
			logTree(t, tc.name+"・跑之後（子筆記庫）", afterVault)
			logTree(t, tc.name+"・跑之後（整個監看根）", afterAll)

			// 子庫裡：一個檔都不准多、一個檔都不准變。
			for rel, want := range beforeVault {
				got, still := afterVault[rel]
				if !still {
					t.Fatalf("子筆記庫裡的檔案不見了：%s", rel)
				}
				if got.hash != want.hash || got.mtime != want.mtime {
					t.Fatalf("子筆記庫裡的檔案被動過：%s", rel)
				}
			}
			for rel := range afterVault {
				if _, existed := beforeVault[rel]; !existed {
					t.Fatalf("子筆記庫裡多出了機器產物：%s（Logseq/Obsidian 會把它當成一頁）", rel)
				}
			}

			// 但東西照樣要產出——落在監看根上，不在子庫裡。
			produced := 0
			for rel := range afterAll {
				if _, existed := beforeAll[rel]; existed {
					continue
				}
				produced++
				if !IsMarked(filepath.Base(rel)) {
					t.Fatalf("監看根上多了一個沒帶標記的檔：%s", rel)
				}
			}
			if produced == 0 {
				t.Fatal("什麼都沒產出——那是把功能關掉，不是修好")
			}
		})
	}
}

// 回歸：監看根**本身**就是庫（前兩輪修好的那條路）不能被這次改動弄壞。
func TestVaultFootprint_WatchRootIsVault_StillProtected(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(*testing.T, string)
	}{
		{"logseq", makeLogseqVault},
		{"obsidian", makeObsidianVault},
	} {
		t.Run(tc.name, func(t *testing.T) {
			vault := t.TempDir()
			tc.make(t, vault)
			writeFixture(t, vault, map[string]string{
				"journals/2026_08_12.md": "- 我的日記",
				"會議記錄.md":                "# 原稿",
			})
			before := snapshotTree(t, vault)
			runSyncOnce(t, vault)
			after := snapshotTree(t, vault)
			logTree(t, tc.name+"・監看根就是庫・跑之後", after)
			if added := assertVaultUntouched(t, vault, before, after); len(added) == 0 {
				t.Fatal("什麼都沒產出")
			}
		})
	}
}

// writeFixture 依 rel→內容 造檔（rel 用斜線分隔）。
func writeFixture(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		mustMkdir(t, filepath.Dir(p))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 收拾層：已經寫進去的那一批（票上「額外要處理的」）
// ─────────────────────────────────────────────────────────────────────────────

// 舊版 daemon 在「vault 子資料夾」上留下的可見卡片，下一輪要能自己搬進隱藏目錄。
// 使用者什麼都不必做——紅線：「不准要使用者去設定什麼開關才能保護自己的筆記」。
func TestMigrateCardNames_RelocatesVisibleCardsInsideVault(t *testing.T) {
	base := t.TempDir()
	vault := filepath.Join(base, "KB")
	watch := filepath.Join(vault, "docs")
	mustMkdir(t, watch)
	makeLogseqVault(t, vault)

	// 舊版留下的兩種：帶標記但位置錯（第二輪的產物）、以及完全沒標記（第一輪的產物）。
	writeFixture(t, watch, map[string]string{
		"system-dev/wiki/cards/arcrun-會議記錄.md": "# 會議記錄",
		"system-dev/wiki/cards/2026_08_12.md":  "# 2026_08_12",
	})

	t.Logf("收拾前：%v", relList(t, watch))
	n := MigrateCardNames(watch)
	got := relList(t, watch)
	t.Logf("收拾後（搬了 %d 筆）：%v", n, got)

	if n != 2 {
		t.Fatalf("搬了 %d 筆，want 2", n)
	}
	for _, rel := range got {
		if !isHiddenRel(rel) {
			t.Fatalf("還有看得見的機器產物留在筆記庫裡：%s", rel)
		}
		if !IsMarked(filepath.Base(rel)) {
			t.Fatalf("還有沒帶標記的產物：%s", rel)
		}
	}

	// 冪等：再跑一次不該有任何動作。
	if again := MigrateCardNames(watch); again != 0 {
		t.Fatalf("第二次跑又搬了 %d 筆，應為 0（冪等）", again)
	}
}

// tidy 的預覽要說清楚是誰的庫，且**從不刪檔**、目標已存在就不覆蓋。
func TestTidy_ReportsVaultRootForSubdirWatch(t *testing.T) {
	base := t.TempDir()
	vault := filepath.Join(base, "KB")
	watch := filepath.Join(vault, "docs")
	mustMkdir(t, watch)
	makeLogseqVault(t, vault)
	writeFixture(t, watch, map[string]string{
		"system-dev/wiki/cards/arcrun-會議記錄.md": "# 會議記錄",
	})

	rep, err := Tidy(watch, false)
	if err != nil {
		t.Fatal(err)
	}
	if rep.VaultType != VaultLogseq || rep.VaultRoot != vault {
		t.Fatalf("報告沒認出上層筆記庫：VaultType=%q VaultRoot=%q（want logseq / %s）",
			rep.VaultType, rep.VaultRoot, vault)
	}
	if len(rep.Items) != 1 || rep.Items[0].Action != TidyActionWillMove {
		t.Fatalf("預覽內容不對：%+v", rep.Items)
	}
	t.Logf("tidy 預覽：%+v", rep.Items)
}

func relList(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	for rel := range snapshotTree(t, root) {
		out = append(out, rel)
	}
	sort.Strings(out)
	return out
}
